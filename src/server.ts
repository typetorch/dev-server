/**
 * The loopback HTTP server (plans/11 §3, pairing-code variant). Four endpoints, nothing else:
 *   POST /v1/token                pairing code or refresh token → 5-minute JWT
 *   POST /v1/prompts              JWT → {id, state:"queued"}
 *   GET  /v1/prompts/:id          JWT → status
 *   POST /v1/prompts/:id/cancel   JWT → {ok:true}
 * Errors are bare status codes with no body; the reason is only logged locally (never a token or code).
 */
import type { Server } from "bun";
import { SessionAuth, type Scope } from "./auth";
import { NonceCache, SlidingWindow } from "./limits";
import { addSecret, consoleLogger, oneLine, type Logger } from "./log";
import { DEFAULT_CODE_TTL_MS, PairingCode, type RotateReason } from "./pairing";
import { PromptQueue, type Runner } from "./prompts";
import { LIMITS, NONCE_PATTERN, PROMPT_ID_PATTERN, parsePromptRequest, parseTokenGrant } from "./schema";

export const TIMESTAMP_WINDOW_SECONDS = 300;
export const TOKENS_PER_USER_PER_MINUTE = 6;

const BASE_HEADERS: Record<string, string> = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

function empty(status: number): Response {
	return new Response(null, { status, headers: BASE_HEADERS });
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8" } });
}

type Route =
	| { kind: "token" }
	| { kind: "create" }
	| { kind: "get"; id: string }
	| { kind: "cancel"; id: string };

function matchRoute(method: string, path: string): Route | undefined {
	if (method === "POST" && path === "/v1/token") return { kind: "token" };
	if (method === "POST" && path === "/v1/prompts") return { kind: "create" };
	let m = /^\/v1\/prompts\/([^/]{1,128})$/.exec(path);
	if (m && method === "GET") return { kind: "get", id: m[1] };
	m = /^\/v1\/prompts\/([^/]{1,128})\/cancel$/.exec(path);
	if (m && method === "POST") return { kind: "cancel", id: m[1] };
	return undefined;
}

const TOO_LARGE = Symbol("too large");

async function readBody(req: Request, limit: number): Promise<string | typeof TOO_LARGE | undefined> {
	const declared = req.headers.get("content-length");
	if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > limit)) return TOO_LARGE;
	if (!req.body) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = req.body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			return TOO_LARGE;
		}
		chunks.push(value);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} catch {
		return undefined;
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isJson(req: Request): boolean {
	return /^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "");
}

function isProxyHeader(name: string): boolean {
	return name.startsWith("cf-") || name.startsWith("x-forwarded-") || name === "cdn-loop";
}

/** "ok", or the status for oversized headers. */
function headersTooLarge(req: Request): boolean {
	let own = 0;
	let all = 0;
	for (const [name, value] of req.headers) {
		const size = name.length + value.length + 4;
		all += size;
		if (!isProxyHeader(name)) own += size;
	}
	return own > LIMITS.headerBytes || all > LIMITS.allHeaderBytes;
}

export interface RemoteClaudeServerOptions {
	/** The TypeTorch branch this session serves. */
	branch: string;
	users: number[];
	runner: Runner;
	maxPrompts?: number;
	maxQueued?: number;
	/** 0 (default) = a random free port. Always bound to 127.0.0.1. */
	port?: number;
	logger?: Logger;
	/** Called with the new pairing code after every rotation (manual, brute force or expiry). */
	onPairingCode?: (formatted: string, reason: RotateReason, expiresAt: number) => void;
	/** Lifetime of each pairing code (default 3 hours); refresh tokens never outlive it (counted from pairing). */
	codeTtlMs?: number;
	/** Clock in ms for code and refresh-token expiry (tests inject one). */
	now?: () => number;
	/** Tests only (honored only when NODE_ENV=test): a known signing key so tests can forge crafted tokens. */
	unsafeSigningKey?: Uint8Array;
}

export interface RemoteClaudeServer {
	readonly auth: SessionAuth;
	readonly queue: PromptQueue;
	readonly pairing: PairingCode;
	readonly port: number;
	/** http://127.0.0.1:<port> */
	readonly localUrl: string;
	/** New signing key, no refresh tokens, new pairing code: every credential issued so far dies. */
	rotateAll(): void;
	stop(): Promise<void>;
}

export function createRemoteClaudeServer(options: RemoteClaudeServerOptions): RemoteClaudeServer {
	if (options.users.length === 0) throw new Error("--users is required (no default, no wildcard)");
	for (const id of options.users) if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`invalid user id ${id}`);
	if (options.unsafeSigningKey && process.env.NODE_ENV !== "test") throw new Error("unsafeSigningKey is for tests only");

	const logger = options.logger ?? consoleLogger();
	const codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
	const auth = new SessionAuth({
		branch: options.branch,
		users: options.users,
		signingKey: options.unsafeSigningKey,
		refreshTtlSeconds: codeTtlMs / 1000,
		now: options.now,
	});
	const pairing = new PairingCode(
		(code, reason) => {
			addSecret(code);
			addSecret(pairing.formatted);
			options.onPairingCode?.(pairing.formatted, reason, pairing.expiresAt);
		},
		{ ttlMs: codeTtlMs, now: options.now },
	);
	addSecret(pairing.raw);
	addSecret(pairing.formatted);
	const queue = new PromptQueue({
		runner: options.runner,
		maxQueued: options.maxQueued ?? 5,
		maxPrompts: options.maxPrompts ?? 50,
		logger,
	});
	const tokenLimiter = new SlidingWindow(TOKENS_PER_USER_PER_MINUTE, 60_000);
	const nonces = new NonceCache();

	const decide = (status: number, what: string, detail: string) => {
		const line = `${what} → ${status}${detail ? `  ${detail}` : ""}`;
		if (status >= 400) logger.warn(line);
		else logger.info(line);
	};

	async function handleToken(req: Request): Promise<Response> {
		const what = "POST /v1/token";
		if (!isJson(req)) return decide(401, what, "content-type"), empty(401);
		const text = await readBody(req, LIMITS.tokenBodyBytes);
		if (text === TOO_LARGE || text === undefined) return decide(401, what, "body size/encoding"), empty(401);
		const grant = parseTokenGrant(parseJson(text));
		if (!grant) return decide(401, what, "body schema"), empty(401);
		const sub = `roblox:${grant.user}`;
		const label = `${grant.grant} grant ${sub}`;
		// Session, branch and user are checked before the code, so only callers who already know the session id, the
		// branch and an allowed user id can make code attempts count (or trip the brute-force block).
		if (grant.sid !== auth.sessionId) return decide(401, what, `${label} wrong sid`), empty(401);
		if (grant.branch !== auth.branch) return decide(401, what, `${label} wrong branch`), empty(401);
		if (!auth.isAllowed(grant.user)) return decide(401, what, `${label} not allowed`), empty(401);

		if (grant.grant === "code") {
			if (pairing.isBlocked()) return decide(429, what, `${label} code attempts blocked (too many failures)`), empty(429);
			if (!pairing.matches(grant.code)) {
				const { blocked, rotated } = pairing.fail();
				const notes = [blocked && "code attempts blocked for 60 s", rotated && "pairing code rotated after 30 failures"].filter(Boolean).join("; ");
				return decide(401, what, `${label} wrong code${notes ? ` (${notes})` : ""}`), empty(401);
			}
			if (!tokenLimiter.take(String(grant.user))) return decide(429, what, `${label} token rate limit`), empty(429);
			const issued = await auth.issue(grant.user, grant.job);
			const refresh = auth.issueRefresh(grant.user, grant.job);
			decide(200, what, `${label} jti=${issued.jti.slice(0, 8)} paired`);
			return json({ access_token: issued.token, expires_in: 300, refresh_token: refresh.token, refresh_expires_in: refresh.expiresIn });
		}

		const left = auth.checkRefresh(grant.refresh_token, grant.user, grant.job);
		if (left === undefined) return decide(401, what, `${label} refresh token not valid for this user/job/session`), empty(401);
		if (!tokenLimiter.take(String(grant.user))) return decide(429, what, `${label} token rate limit`), empty(429);
		const issued = await auth.issue(grant.user, grant.job);
		decide(200, what, `${label} jti=${issued.jti.slice(0, 8)} refreshed`);
		return json({ access_token: issued.token, expires_in: 300, refresh_token: grant.refresh_token, refresh_expires_in: left });
	}

	async function handlePrompts(req: Request, route: Exclude<Route, { kind: "token" }>): Promise<Response> {
		const what = route.kind === "create" ? "POST /v1/prompts" : `${route.kind === "get" ? "GET" : "POST"} /v1/prompts/${oneLine(route.id, 12)}${route.kind === "cancel" ? "/cancel" : ""}`;
		const authz = req.headers.get("authorization") ?? "";
		const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/.exec(authz);
		if (!m || m[1].length > 2048) return decide(401, what, "no bearer token"), empty(401);
		const scope: Scope = route.kind === "create" ? "prompt:create" : route.kind === "get" ? "prompt:read" : "prompt:cancel";
		const job = req.headers.get("x-tt-job") ?? "";
		const verified = await auth.verify(m[1], job, scope);
		if (!verified.ok) {
			const who = verified.userId !== undefined ? `roblox:${verified.userId} ` : "";
			return decide(verified.status, what, `${who}${verified.jti ? `jti=${verified.jti.slice(0, 8)} ` : ""}${verified.reason}`), empty(verified.status);
		}
		const { userId, claims } = verified;
		const who = `roblox:${userId} jti=${claims.jti.slice(0, 8)}`;

		// Every POST (create and cancel) carries a fresh X-TT-Nonce and an X-TT-Timestamp within ±300 s.
		if (req.method === "POST") {
			const stamp = req.headers.get("x-tt-timestamp") ?? "";
			if (!/^\d{1,12}$/.test(stamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(stamp)) > TIMESTAMP_WINDOW_SECONDS) {
				return decide(400, what, `${who} timestamp`), empty(400);
			}
			const nonce = req.headers.get("x-tt-nonce") ?? "";
			if (!NONCE_PATTERN.test(nonce)) return decide(400, what, `${who} nonce missing/invalid`), empty(400);
			if (!nonces.use(nonce)) return decide(409, what, `${who} nonce replay`), empty(409);
		}

		if (route.kind === "create") {
			if (!isJson(req)) return decide(400, what, `${who} content-type`), empty(400);
			const text = await readBody(req, LIMITS.promptBodyBytes);
			if (text === TOO_LARGE) return decide(413, what, `${who} body too large`), empty(413);
			if (text === undefined) return decide(400, what, `${who} body encoding`), empty(400);
			const body = parsePromptRequest(parseJson(text));
			if (!body) return decide(400, what, `${who} body schema`), empty(400);
			const record = queue.create(userId, body.prompt, body.context);
			if (record === "max-prompts" || record === "queue-full") return decide(429, what, `${who} ${record}`), empty(429);
			if (record === "stopped") return decide(503, what, `${who} shutting down`), empty(503);
			decide(200, what, `${who} queued ${record.id.slice(0, 8)}`);
			return json({ id: record.id, state: record.state });
		}

		if (!PROMPT_ID_PATTERN.test(route.id)) return decide(404, what, who), empty(404);
		const record = queue.get(route.id);
		if (!record) return decide(404, what, who), empty(404);
		if (route.kind === "get") return json(queue.view(record));

		// Cancel (no body or Content-Type expected; a body is ignored): only the requester (or the dev at the terminal).
		if (record.userId !== userId) return decide(403, what, `${who} not the requester`), empty(403);
		const result = queue.cancel(record.id, `roblox:${userId}`);
		if (result === "finished") return decide(409, what, `${who} already finished`), empty(409);
		if (result === "missing") return empty(404);
		decide(200, what, `${who} cancelled`);
		return json({ ok: true });
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		development: false,
		maxRequestBodySize: 64 * 1024,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			const route = matchRoute(req.method, url.pathname);
			if (!route) return empty(404);
			if (headersTooLarge(req)) return decide(431, `${req.method} ${url.pathname.slice(0, 40)}`, "headers too large"), empty(431);
			return route.kind === "token" ? handleToken(req) : handlePrompts(req, route);
		},
		error(error: Error): Response {
			logger.error(`request failed: ${error.message}`);
			return empty(500);
		},
	});

	const port = server.port as number;
	return {
		auth,
		queue,
		pairing,
		port,
		localUrl: `http://127.0.0.1:${port}`,
		rotateAll() {
			auth.rotate();
			pairing.rotate("manual");
		},
		async stop() {
			pairing.dispose();
			await queue.stop();
			await server.stop(true);
		},
	};
}
