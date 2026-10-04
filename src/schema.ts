/** Strict request body validation: exact shapes, size caps, unknown fields rejected. */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

export const LIMITS = {
	tokenBodyBytes: 1024,
	promptBodyBytes: 32 * 1024,
	promptChars: 4000,
	contextPathChars: 1024,
	contextErrors: 50,
	contextErrorChars: 4000,
	contextArtifactChars: 128,
	/** Non-proxy request headers, total bytes (plans/11: headers over 2 KB are rejected before parsing). */
	headerBytes: 2048,
	/** Every header including those Cloudflare adds. */
	allHeaderBytes: 8192,
} as const;

interface GrantBase {
	sid: string;
	user: number;
	job: string;
	branch: string;
}

export type TokenGrant = (GrantBase & { grant: "code"; code: string }) | (GrantBase & { grant: "refresh"; refresh_token: string });

/**
 * `{grant:"code", sid, user, job, branch, code}` or `{grant:"refresh", sid, user, job, branch, refresh_token}`, nothing
 * else. `job` may be "" (Studio servers have an empty JobId).
 */
export function parseTokenGrant(raw: unknown): TokenGrant | undefined {
	if (!isPlainObject(raw)) return undefined;
	const { grant, sid, user, job, branch } = raw;
	if (typeof sid !== "string" || !/^[0-9a-f]{32}$/.test(sid)) return undefined;
	if (typeof user !== "number" || !Number.isSafeInteger(user) || user <= 0) return undefined;
	if (typeof job !== "string" || !/^[A-Za-z0-9._:{}-]{0,64}$/.test(job)) return undefined;
	if (typeof branch !== "string" || branch.length === 0 || branch.length > 64) return undefined;
	const base = { sid, user, job, branch };
	if (grant === "code") {
		if (!onlyKeys(raw, ["grant", "sid", "user", "job", "branch", "code"])) return undefined;
		if (typeof raw.code !== "string" || raw.code.length === 0 || raw.code.length > 64) return undefined;
		return { grant, ...base, code: raw.code };
	}
	if (grant === "refresh") {
		if (!onlyKeys(raw, ["grant", "sid", "user", "job", "branch", "refresh_token"])) return undefined;
		if (typeof raw.refresh_token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw.refresh_token)) return undefined;
		return { grant, ...base, refresh_token: raw.refresh_token };
	}
	return undefined;
}

export interface PromptContext {
	path?: string;
	errors?: string[];
	artifact?: string;
}

export interface PromptRequest {
	prompt: string;
	context?: PromptContext;
}

/** `{prompt: string ≤4000, context?: {path?, errors?: string[], artifact?}}`, nothing else. */
export function parsePromptRequest(raw: unknown): PromptRequest | undefined {
	if (!isPlainObject(raw) || !onlyKeys(raw, ["prompt", "context"])) return undefined;
	const { prompt, context } = raw;
	if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > LIMITS.promptChars) return undefined;
	if (prompt.includes("\u0000")) return undefined;
	if (context === undefined) return { prompt };
	if (!isPlainObject(context) || !onlyKeys(context, ["path", "errors", "artifact"])) return undefined;
	const out: PromptContext = {};
	if (context.path !== undefined) {
		if (typeof context.path !== "string" || context.path.length > LIMITS.contextPathChars) return undefined;
		out.path = context.path;
	}
	if (context.errors !== undefined) {
		if (!Array.isArray(context.errors) || context.errors.length > LIMITS.contextErrors) return undefined;
		for (const line of context.errors) if (typeof line !== "string" || line.length > LIMITS.contextErrorChars) return undefined;
		out.errors = context.errors as string[];
	}
	if (context.artifact !== undefined) {
		if (typeof context.artifact !== "string" || context.artifact.length > LIMITS.contextArtifactChars) return undefined;
		out.artifact = context.artifact;
	}
	return { prompt, context: out };
}

export const NONCE_PATTERN = /^[A-Za-z0-9._:{}-]{8,128}$/;
export const PROMPT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
