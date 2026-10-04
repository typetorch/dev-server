/**
 * Credentials:
 *   - the pairing code (see pairing.ts) is exchanged at POST /v1/token for an access token plus a refresh token;
 *   - refresh tokens are 32 random bytes (base64url), kept server-side only as SHA-256 hashes, bound to one user, one
 *     game server (JobId), this session, the tunnel URL they were issued through and the user's token version. They
 *     rotate on every use: a refresh grant returns a new refresh token and the old one stops working. Presenting an
 *     already-rotated token again (reuse) revokes the whole family, so a copied token dies the moment either copy is
 *     used after the other (security audit M5). A family lives at most 12 hours from pairing (or the code lifetime);
 *     rotation never extends it. A new pairing of the same (user, job) replaces the old family;
 *   - access tokens are HS256 JWTs (jose), 5 minutes, bound to one user, one game server (JobId), this session and
 *     this branch, signed with a 256-bit key generated in memory at session start (never written or logged).
 * Claims are re-checked against the live session on every use, so `revoke` and `rotate` take effect immediately.
 *
 * What "bound to a JobId" means: the dev server can't verify a game server's JobId on its own (Roblox doesn't sign or
 * attest outgoing HttpService requests). The job is fixed when the single-use code is redeemed, every refresh must
 * present the same job, the JWT carries it, and every request's X-TT-Job header must equal it. So a token works for
 * one job only, but whoever holds a valid refresh token can claim that job. Tokens never leave the game server's
 * memory, and rotation with reuse detection turns a copied token into a revoked pairing as soon as both copies are used.
 *
 * A tunnel restart (new URL) re-keys the session (`rekey`): a new session id and signing key, and every refresh token
 * dies, so each game server pairs again with the new code (whose fingerprint covers the new URL).
 */
import { createHash } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export const ISSUER = "typetorch-remote-claude";
export const TOKEN_TTL_SECONDS = 300;
export const REFRESH_TTL_SECONDS = 12 * 60 * 60;
export const SCOPES = ["prompt:create", "prompt:read", "prompt:cancel"] as const;
export type Scope = (typeof SCOPES)[number];

const REQUIRED_CLAIMS = ["sub", "sid", "job", "jti", "exp", "iat", "nbf", "branch", "scope", "ver"];

function randomId(bytes = 16): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

export function newSessionId(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

export function newSigningKey(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** One pairing: the chain of refresh tokens issued to (user, job) since the code was redeemed. */
interface RefreshFamily {
	id: string;
	userId: number;
	job: string;
	sid: string;
	/** The tunnel URL the pairing came through ("" without a tunnel). */
	url: string;
	ver: number;
	/** Unix seconds; fixed at pairing (rotation never extends it). */
	expiresAt: number;
	/** Hash of the one token that works now. */
	current: string;
	/** Hashes of every token rotated out (reuse detection). */
	used: Set<string>;
}

interface UserState {
	ver: number;
	revoked: boolean;
}

export interface Claims extends JWTPayload {
	sub: string;
	sid: string;
	job: string;
	branch: string;
	scope: string;
	ver: number;
	jti: string;
}

export type VerifyResult =
	| { ok: true; userId: number; claims: Claims }
	| { ok: false; status: 401 | 403; reason: string; userId?: number; jti?: string };

export type RefreshResult =
	| { ok: true; token: string; expiresIn: number }
	| { ok: false; reason: "unknown" | "expired" | "binding" | "reuse" | "limited"; userId?: number; job?: string };

export class SessionAuth {
	private sid: string;
	readonly branch: string;
	private key: Uint8Array;
	private url = "";
	private readonly users = new Map<number, UserState>();
	private readonly families = new Map<string, RefreshFamily>();
	/** SHA-256(refresh token, current or rotated out) → family id. The tokens themselves are never stored. */
	private readonly tokenIndex = new Map<string, string>();
	/** Refresh token lifetime: 12 h at most, and never longer than a pairing code lives (the server passes that in). */
	readonly refreshTtlSeconds: number;
	private readonly clock: () => number;

	constructor(options: { branch: string; users: number[]; sessionId?: string; signingKey?: Uint8Array; refreshTtlSeconds?: number; now?: () => number }) {
		this.refreshTtlSeconds = Math.min(REFRESH_TTL_SECONDS, Math.max(1, Math.floor(options.refreshTtlSeconds ?? REFRESH_TTL_SECONDS)));
		this.clock = options.now ?? Date.now;
		this.sid = options.sessionId ?? newSessionId();
		this.branch = options.branch;
		this.key = options.signingKey ?? newSigningKey();
		for (const id of options.users) this.users.set(id, { ver: 1, revoked: false });
	}

	/** Random 128-bit hex; changes when the tunnel URL changes (`rekey`). */
	get sessionId(): string {
		return this.sid;
	}

	get audience(): string {
		return `${ISSUER}/${this.sid}`;
	}

	/** The tunnel URL refresh tokens are bound to ("" before there is a tunnel). */
	get tunnelUrl(): string {
		return this.url;
	}

	/** The first tunnel URL (startup): binds the tokens issued from now on. Use `rekey` when it changes. */
	bindUrl(url: string): void {
		this.url = url;
	}

	/** Allowed and not revoked. */
	isAllowed(userId: number): boolean {
		const state = this.users.get(userId);
		return state !== undefined && !state.revoked;
	}

	allowedUsers(): number[] {
		return [...this.users].filter(([, s]) => !s.revoked).map(([id]) => id);
	}

	userTable(): { userId: number; ver: number; revoked: boolean }[] {
		return [...this.users].map(([userId, s]) => ({ userId, ver: s.ver, revoked: s.revoked }));
	}

	/** Removes the user for this session, bumps their token version and deletes their refresh tokens. */
	revoke(userId: number): boolean {
		const state = this.users.get(userId);
		if (!state) return false;
		state.revoked = true;
		state.ver += 1;
		for (const family of [...this.families.values()]) if (family.userId === userId) this.dropFamily(family);
		return true;
	}

	/** A new signing key and no refresh tokens: every token issued so far stops working. */
	rotate(): void {
		this.key = newSigningKey();
		this.families.clear();
		this.tokenIndex.clear();
	}

	/**
	 * The tunnel URL changed: a new session id and signing key, and no refresh tokens. Game servers see a new session
	 * and pair again (the old session id stays bound to the old URL there). Returns the previous session id.
	 */
	rekey(url: string): string {
		const previous = this.sid;
		this.sid = newSessionId();
		this.url = url;
		this.rotate();
		return previous;
	}

	/** A new refresh token family for (user, job, this session, this URL, the user's current token version). */
	issueRefresh(userId: number, job: string): { token: string; expiresIn: number } {
		const state = this.users.get(userId);
		if (!state || state.revoked) throw new Error("user not allowed");
		const now = Math.floor(this.clock() / 1000);
		for (const family of [...this.families.values()]) {
			// Expired families go; so does an earlier pairing of the same user on the same game server.
			if (family.expiresAt <= now || (family.userId === userId && family.job === job)) this.dropFamily(family);
		}
		const token = randomId(32);
		const family: RefreshFamily = {
			id: randomId(),
			userId,
			job,
			sid: this.sid,
			url: this.url,
			ver: state.ver,
			expiresAt: now + this.refreshTtlSeconds,
			current: hashToken(token),
			used: new Set(),
		};
		this.families.set(family.id, family);
		this.tokenIndex.set(family.current, family.id);
		return { token, expiresIn: this.refreshTtlSeconds };
	}

	/**
	 * Redeems a refresh token: on success it is rotated out and a new one returned (same family, same expiry). A token
	 * that was already rotated out revokes its family ("reuse").
	 */
	redeemRefresh(token: string, userId: number, job: string, admit: () => boolean = () => true): RefreshResult {
		const hash = hashToken(token);
		const familyId = this.tokenIndex.get(hash);
		const family = familyId !== undefined ? this.families.get(familyId) : undefined;
		if (!family) return { ok: false, reason: "unknown" };
		if (hash !== family.current) {
			this.dropFamily(family);
			return { ok: false, reason: "reuse", userId: family.userId, job: family.job };
		}
		const now = Math.floor(this.clock() / 1000);
		if (family.expiresAt <= now) {
			this.dropFamily(family);
			return { ok: false, reason: "expired" };
		}
		const state = this.users.get(userId);
		if (!state || state.revoked || family.ver !== state.ver) return { ok: false, reason: "binding" };
		if (family.userId !== userId || family.job !== job || family.sid !== this.sid || family.url !== this.url) return { ok: false, reason: "binding" };
		// Rate limits run here: after the checks (bad tokens can't use up a user's budget), before the rotation (a refused
		// request never leaves the game holding a token that was rotated out).
		if (!admit()) return { ok: false, reason: "limited" };
		const next = randomId(32);
		family.used.add(family.current);
		family.current = hashToken(next);
		this.tokenIndex.set(family.current, family.id);
		return { ok: true, token: next, expiresIn: family.expiresAt - now };
	}

	/** Live pairings (refresh token families). */
	refreshTokenCount(): number {
		return this.families.size;
	}

	private dropFamily(family: RefreshFamily): void {
		this.families.delete(family.id);
		this.tokenIndex.delete(family.current);
		for (const hash of family.used) this.tokenIndex.delete(hash);
	}

	async issue(userId: number, job: string): Promise<{ token: string; jti: string; exp: number }> {
		const state = this.users.get(userId);
		if (!state || state.revoked) throw new Error("user not allowed");
		const iat = Math.floor(Date.now() / 1000);
		const jti = randomId();
		const exp = iat + TOKEN_TTL_SECONDS;
		const token = await new SignJWT({
			sid: this.sid,
			job,
			branch: this.branch,
			scope: SCOPES.join(" "),
			ver: state.ver,
		})
			.setProtectedHeader({ alg: "HS256", typ: "JWT" })
			.setIssuer(ISSUER)
			.setAudience(this.audience)
			.setSubject(`roblox:${userId}`)
			.setIssuedAt(iat)
			.setNotBefore(iat)
			.setExpirationTime(exp)
			.setJti(jti)
			.sign(this.key);
		return { token, jti, exp };
	}

	/**
	 * Verifies a token and re-checks it against the live session. `job` is the X-TT-Job header ("" when absent);
	 * `scope` is the scope the endpoint needs.
	 */
	async verify(token: string, job: string, scope: Scope): Promise<VerifyResult> {
		let payload: JWTPayload;
		try {
			({ payload } = await jwtVerify(token, this.key, {
				algorithms: ["HS256"],
				typ: "JWT",
				issuer: ISSUER,
				audience: this.audience,
				clockTolerance: 30,
				maxTokenAge: "5m",
				requiredClaims: REQUIRED_CLAIMS,
			}));
		} catch (error) {
			return { ok: false, status: 401, reason: `jwt: ${(error as { code?: string }).code ?? "invalid"}` };
		}
		const claims = payload as Claims;
		const jti = typeof claims.jti === "string" ? claims.jti : undefined;
		if (
			typeof claims.sub !== "string" ||
			typeof claims.sid !== "string" ||
			typeof claims.job !== "string" ||
			typeof claims.branch !== "string" ||
			typeof claims.scope !== "string" ||
			typeof claims.ver !== "number" ||
			typeof claims.jti !== "string"
		) {
			return { ok: false, status: 401, reason: "claim types", jti };
		}
		if (claims.sid !== this.sid) return { ok: false, status: 401, reason: "sid", jti };
		const match = /^roblox:([1-9]\d{0,18})$/.exec(claims.sub);
		const userId = match ? Number(match[1]) : NaN;
		if (!Number.isSafeInteger(userId)) return { ok: false, status: 401, reason: "sub", jti };
		const state = this.users.get(userId);
		if (!state || state.revoked) return { ok: false, status: 401, reason: "user not allowed", userId, jti };
		if (claims.ver !== state.ver) return { ok: false, status: 401, reason: "token version", userId, jti };
		if (claims.job !== job) return { ok: false, status: 403, reason: "job mismatch", userId, jti };
		if (claims.branch !== this.branch) return { ok: false, status: 403, reason: "branch", userId, jti };
		if (!claims.scope.split(" ").includes(scope)) return { ok: false, status: 403, reason: "scope", userId, jti };
		return { ok: true, userId, claims };
	}
}
