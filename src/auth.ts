/**
 * Credentials:
 *   - the pairing code (see pairing.ts) is exchanged at POST /v1/token for an access token plus a refresh token;
 *   - refresh tokens are 32 random bytes (base64url), kept server-side only as SHA-256 hashes, bound to one user, one
 *     game server (JobId), this session and the user's token version; they last 12 hours (or until the session ends);
 *   - access tokens are HS256 JWTs (jose), 5 minutes, bound to one user, one game server (JobId), this session and
 *     this branch, signed with a 256-bit key generated in memory at session start (never written or logged).
 * Claims are re-checked against the live session on every use, so `revoke` and `rotate` take effect immediately.
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

interface RefreshRecord {
	userId: number;
	job: string;
	sid: string;
	ver: number;
	/** Unix seconds. */
	expiresAt: number;
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

export class SessionAuth {
	readonly sessionId: string;
	readonly branch: string;
	private key: Uint8Array;
	private readonly users = new Map<number, UserState>();
	/** SHA-256(refresh token) → binding. The tokens themselves are never stored. */
	private readonly refresh = new Map<string, RefreshRecord>();

	constructor(options: { branch: string; users: number[]; sessionId?: string; signingKey?: Uint8Array }) {
		this.sessionId = options.sessionId ?? newSessionId();
		this.branch = options.branch;
		this.key = options.signingKey ?? newSigningKey();
		for (const id of options.users) this.users.set(id, { ver: 1, revoked: false });
	}

	get audience(): string {
		return `${ISSUER}/${this.sessionId}`;
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
		for (const [hash, record] of this.refresh) if (record.userId === userId) this.refresh.delete(hash);
		return true;
	}

	/** A new signing key and no refresh tokens: every token issued so far stops working. */
	rotate(): void {
		this.key = newSigningKey();
		this.refresh.clear();
	}

	/** A new refresh token for (user, job, this session, the user's current token version). */
	issueRefresh(userId: number, job: string): { token: string; expiresIn: number } {
		const state = this.users.get(userId);
		if (!state || state.revoked) throw new Error("user not allowed");
		const now = Math.floor(Date.now() / 1000);
		for (const [hash, record] of this.refresh) if (record.expiresAt <= now) this.refresh.delete(hash);
		const token = randomId(32);
		this.refresh.set(hashToken(token), { userId, job, sid: this.sessionId, ver: state.ver, expiresAt: now + REFRESH_TTL_SECONDS });
		return { token, expiresIn: REFRESH_TTL_SECONDS };
	}

	/** Seconds left on a refresh token that matches (user, job, session, current version), or undefined. */
	checkRefresh(token: string, userId: number, job: string): number | undefined {
		const record = this.refresh.get(hashToken(token));
		const now = Math.floor(Date.now() / 1000);
		if (!record) return undefined;
		if (record.expiresAt <= now) {
			this.refresh.delete(hashToken(token));
			return undefined;
		}
		const state = this.users.get(userId);
		if (!state || state.revoked || record.ver !== state.ver) return undefined;
		if (record.userId !== userId || record.job !== job || record.sid !== this.sessionId) return undefined;
		return record.expiresAt - now;
	}

	refreshTokenCount(): number {
		return this.refresh.size;
	}

	async issue(userId: number, job: string): Promise<{ token: string; jti: string; exp: number }> {
		const state = this.users.get(userId);
		if (!state || state.revoked) throw new Error("user not allowed");
		const iat = Math.floor(Date.now() / 1000);
		const jti = randomId();
		const exp = iat + TOKEN_TTL_SECONDS;
		const token = await new SignJWT({
			sid: this.sessionId,
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
		if (claims.sid !== this.sessionId) return { ok: false, status: 401, reason: "sid", jti };
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
