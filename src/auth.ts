/**
 * Credentials (plans/11 §3):
 *   - the exchange secret (Roblox Secrets Store value) is accepted only by POST /v1/token, compared in constant time;
 *   - access tokens are HS256 JWTs (jose), 5 minutes, bound to one user, one game server (JobId), this session and
 *     this branch, signed with a 256-bit key generated in memory at session start (never written or logged).
 * Claims are re-checked against the live session on every use, so `revoke` and `rotate` take effect immediately.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export const ISSUER = "typetorch-remote-claude";
export const TOKEN_TTL_SECONDS = 300;
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

/** Constant-time comparison of a presented secret with the configured one (SHA-256 first, so lengths always match). */
export class ExchangeSecret {
	private readonly digest: Buffer;

	constructor(secret: string) {
		this.digest = createHash("sha256").update(secret, "utf8").digest();
	}

	matches(presented: string): boolean {
		const candidate = createHash("sha256").update(presented, "utf8").digest();
		return timingSafeEqual(candidate, this.digest);
	}
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

	/** Removes the user for this session and bumps their token version. Returns false for unknown users. */
	revoke(userId: number): boolean {
		const state = this.users.get(userId);
		if (!state) return false;
		state.revoked = true;
		state.ver += 1;
		return true;
	}

	/** A new signing key: every token issued so far stops working. */
	rotate(): void {
		this.key = newSigningKey();
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
