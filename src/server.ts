/**
 * The loopback HTTP server (plans/11 §3, pairing-code variant). These endpoints, nothing else:
 *   POST /v1/token                  pairing code or refresh token → 5-minute JWT
 *   POST /v1/prompts                JWT → {id, state:"queued", conversationId}
 *   GET  /v1/prompts/:id[?since=n]  JWT → status (+ events i >= n)
 *   POST /v1/prompts/:id/cancel     JWT → {ok:true}   (a pending deploy proposal is discarded)
 *   POST /v1/prompts/:id/deploy     JWT → {ok:true}   {decision: "deploy" | "discard"}: the requester's answer to a proposal
 *   POST /v1/attachments            JWT → {id, width, height}   (RGBA8 screenshot → PNG in the worktree)
 *   GET  /v1/conversations          JWT → the caller's conversations, latest first
 *   GET  /v1/conversations/:id      JWT → one of the caller's conversations with its messages
 *   GET  /v1/game/pending           JWT → game-tool requests waiting for this user's game server (job)
 *   GET  /v1/game/requests/:id      JWT → one request (tool + args), only for its user AND job
 *   POST /v1/game/requests/:id/result JWT → the game server's answer
 *   GET  /v1/game/poll?since=n      JWT → long-poll: this server's chat events and tool requests (feed.ts)
 *   POST /v1/game/tool-result       JWT → {id, ...result} for a request from the poll
 *   POST /mcp                       per-run bearer token (local claude only) → MCP JSON-RPC: the game tools
 * Errors are bare status codes with no body; the reason is only logged locally (never a token or code).
 */
import type { Server } from "bun";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_ID_PATTERN, ATTACHMENT_LIMITS, AttachmentStore } from "./attachments";
import { SessionAuth, type Scope } from "./auth";
import { CONVERSATION_ID_PATTERN, ConversationStore, type Conversation } from "./conversations";
import { NonceCache, SlidingWindow } from "./limits";
import { addSecret, consoleLogger, oneLine, type Logger } from "./log";
import { GameFeeds, requestPayload } from "./feed";
import { DEFAULT_CODE_TTL_MS, PairingCode, PairingLockout, type RotateReason } from "./pairing";
import {
	GAME_LIMITS,
	GAME_MCP_SERVER,
	GAME_TOOL_DEFS,
	GAME_TOOLS,
	READ_ONLY_GAME_TOOLS,
	GameRequestStore,
	REQUEST_ID_PATTERN,
	formatGameResult,
	parseGameResult,
	parseToolCall,
	waitMsFor,
	wakeMessage,
} from "./game-tools";
import { PromptQueue, type PromptRecord, type Runner } from "./prompts";
import {
	LIMITS,
	NONCE_PATTERN,
	PROMPT_ID_PATTERN,
	SINCE_PATTERN,
	parseAttachmentRequest,
	parseDeployDecision,
	parsePromptRequest,
	parseTokenGrant,
} from "./schema";

export const TIMESTAMP_WINDOW_SECONDS = 300;
export const TOKENS_PER_USER_PER_MINUTE = 6;
/** Conversations listed by GET /v1/conversations, and messages returned by GET /v1/conversations/:id. */
export const CONVERSATIONS_LISTED = 20;
export const MESSAGES_RETURNED = 30;

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
	| { kind: "cancel"; id: string }
	| { kind: "deploy"; id: string }
	| { kind: "attach" }
	| { kind: "conversations" }
	| { kind: "conversation"; id: string }
	| { kind: "gamePending" }
	| { kind: "gamePoll" }
	| { kind: "gameToolResult" }
	| { kind: "gameRequest"; id: string }
	| { kind: "gameResult"; id: string };

type AuthedRoute = Exclude<Route, { kind: "token" }>;

const MCP_PATH = "/mcp";

function matchRoute(method: string, path: string): Route | undefined {
	if (method === "POST" && path === "/v1/token") return { kind: "token" };
	if (method === "POST" && path === "/v1/prompts") return { kind: "create" };
	if (method === "POST" && path === "/v1/attachments") return { kind: "attach" };
	if (method === "GET" && path === "/v1/conversations") return { kind: "conversations" };
	if (method === "GET" && path === "/v1/game/pending") return { kind: "gamePending" };
	if (method === "GET" && path === "/v1/game/poll") return { kind: "gamePoll" };
	if (method === "POST" && path === "/v1/game/tool-result") return { kind: "gameToolResult" };
	let m = /^\/v1\/prompts\/([^/]{1,128})$/.exec(path);
	if (m && method === "GET") return { kind: "get", id: m[1] };
	m = /^\/v1\/prompts\/([^/]{1,128})\/cancel$/.exec(path);
	if (m && method === "POST") return { kind: "cancel", id: m[1] };
	m = /^\/v1\/prompts\/([^/]{1,128})\/deploy$/.exec(path);
	if (m && method === "POST") return { kind: "deploy", id: m[1] };
	m = /^\/v1\/conversations\/([^/]{1,128})$/.exec(path);
	if (m && method === "GET") return { kind: "conversation", id: m[1] };
	m = /^\/v1\/game\/requests\/([^/]{1,128})$/.exec(path);
	if (m && method === "GET") return { kind: "gameRequest", id: m[1] };
	m = /^\/v1\/game\/requests\/([^/]{1,128})\/result$/.exec(path);
	if (m && method === "POST") return { kind: "gameResult", id: m[1] };
	return undefined;
}

const SCOPE_FOR: Record<AuthedRoute["kind"], Scope> = {
	create: "prompt:create",
	attach: "prompt:create",
	get: "prompt:read",
	conversations: "prompt:read",
	conversation: "prompt:read",
	cancel: "prompt:cancel",
	deploy: "prompt:create",
	gamePending: "prompt:read",
	gamePoll: "prompt:read",
	gameToolResult: "prompt:create",
	gameRequest: "prompt:read",
	gameResult: "prompt:create",
};

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
	/** Called with the new pairing code after every rotation (manual, used, expired, tunnel restart). */
	onPairingCode?: (formatted: string, reason: RotateReason, expiresAt: number) => void;
	/** Lifetime of each pairing code (default 3 hours); refresh tokens never outlive it (counted from pairing). */
	codeTtlMs?: number;
	/** Clock in ms for code and refresh-token expiry (tests inject one). */
	now?: () => number;
	/**
	 * Absolute folder for attachment PNGs: `<worktree>/.typetorch/attachments` (git-ignored). Default: a temp folder
	 * (embedding and tests).
	 */
	attachmentsDir?: string;
	/**
	 * Publishes a game-tool wake message on MessagingService topic TypeTorch/tool (session.ts passes the Open Cloud
	 * publisher). Without it, game servers still find requests through GET /v1/game/pending.
	 */
	publishWake?: (message: string) => Promise<boolean>;
	/** How long a deploy proposal waits for the dev (default 15 minutes; tests shorten it). */
	proposalTtlMs?: number;
	/** Tests: long-poll hold and coalescing (defaults 20 s and 250 ms). */
	feedTiming?: { holdMs?: number; coalesceMs?: number };
	/** Tests: how long a tool call waits for the game (default: approval + timeout + grace). */
	gameWaitMs?: (defaultMs: number) => number;
	/** Tests only (honored only when NODE_ENV=test): a known signing key so tests can forge crafted tokens. */
	unsafeSigningKey?: Uint8Array;
}

export interface RemoteClaudeServer {
	readonly auth: SessionAuth;
	readonly queue: PromptQueue;
	readonly pairing: PairingCode;
	/** Wrong pairing codes per (user, job). */
	readonly lockout: PairingLockout;
	readonly conversations: ConversationStore;
	readonly attachments: AttachmentStore;
	readonly gameRequests: GameRequestStore;
	readonly port: number;
	/** http://127.0.0.1:<port> */
	readonly localUrl: string;
	/** New signing key, no refresh tokens, new pairing code: every credential issued so far dies. */
	rotateAll(): void;
	/**
	 * Binds pairing to the tunnel URL (security audit H1). The first call (startup) binds silently. A different URL
	 * later (a tunnel restart) re-keys the session: new session id, signing key and pairing code (printed through
	 * onPairingCode, reason "tunnel"); every refresh token dies. Returns the previous session id when it re-keyed.
	 */
	setTunnelUrl(url: string): string | undefined;
	/** Stops the server and deletes the attachment files. */
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
	const lockout = new PairingLockout();
	const gameRequests = new GameRequestStore();
	const feeds = new GameFeeds(options.feedTiming);
	let localUrl = "";
	const queue = new PromptQueue({
		runner: options.runner,
		maxQueued: options.maxQueued ?? 5,
		maxPrompts: options.maxPrompts ?? 50,
		logger,
		proposalTtlMs: options.proposalTtlMs,
		onEvent: (record, event) => feeds.promptEvent(record, event, () => queue.view(record)),
		// Each run gets the game tools over MCP with its own bearer token, valid only while it runs.
		runTools: (record) => {
			const token = gameRequests.issueRunToken(record.id);
			return {
				mcp: { url: `${localUrl}${MCP_PATH}`, token },
				dispose: () => {
					gameRequests.revokeRunToken(token);
					gameRequests.expirePrompt(record.id);
				},
			};
		},
	});
	const conversations = new ConversationStore();
	const attachments = new AttachmentStore(
		options.attachmentsDir ?? join(tmpdir(), `typetorch-attachments-${auth.sessionId.slice(0, 12)}`),
	);
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

		const onJob = `on job ${grant.job.slice(0, 8) || "(studio)"}`;

		if (grant.grant === "code") {
			// Wrong codes count per (user, job) only: no global block, no rotation (audit L1).
			if (lockout.isLocked(grant.user, grant.job)) return decide(429, what, `${label} ${onJob} locked (too many wrong codes)`), empty(429);
			if (!pairing.matches(grant.code)) {
				const { failures, locked } = lockout.fail(grant.user, grant.job);
				const note = locked ? `locked for ${Math.round(lockout.lockMs / 60_000)} min` : `${failures}/${lockout.maxFailures}`;
				return decide(401, what, `${label} ${onJob} wrong, used or expired code (${note})`), empty(401);
			}
			// Rate-limited before the code is consumed, so a 429 doesn't waste it.
			if (!tokenLimiter.take(String(grant.user))) return decide(429, what, `${label} token rate limit`), empty(429);
			lockout.clear(grant.user, grant.job);
			const issued = await auth.issue(grant.user, grant.job);
			const refresh = auth.issueRefresh(grant.user, grant.job);
			decide(200, what, `${label} ${onJob} jti=${issued.jti.slice(0, 8)} paired`);
			// Single use: the code is spent and the next one is printed (audit M5).
			pairing.consume();
			return json({ access_token: issued.token, expires_in: 300, refresh_token: refresh.token, refresh_expires_in: refresh.expiresIn });
		}

		// The rate limit is checked after the token checks and before the rotation (auth.ts), so a 429 never leaves the
		// game holding a rotated-out token, and bad tokens can't use up a user's budget.
		const redeemed = auth.redeemRefresh(grant.refresh_token, grant.user, grant.job, () => tokenLimiter.take(String(grant.user)));
		if (!redeemed.ok && redeemed.reason === "limited") return decide(429, what, `${label} token rate limit`), empty(429);
		if (!redeemed.ok) {
			if (redeemed.reason === "reuse") {
				logger.warn(
					`refresh token reuse for roblox:${redeemed.userId} on job ${redeemed.job?.slice(0, 8) || "(studio)"}: a rotated-out token was presented again, so that pairing is revoked (the game server must pair again)`,
				);
			}
			return decide(401, what, `${label} ${onJob} refresh token ${redeemed.reason}`), empty(401);
		}
		const issued = await auth.issue(grant.user, grant.job);
		decide(200, what, `${label} ${onJob} jti=${issued.jti.slice(0, 8)} refreshed`);
		return json({ access_token: issued.token, expires_in: 300, refresh_token: redeemed.token, refresh_expires_in: redeemed.expiresIn });
	}

	const describeRoute = (route: AuthedRoute): string => {
		switch (route.kind) {
			case "create":
				return "POST /v1/prompts";
			case "attach":
				return "POST /v1/attachments";
			case "conversations":
				return "GET /v1/conversations";
			case "conversation":
				return `GET /v1/conversations/${oneLine(route.id, 12)}`;
			case "get":
				return `GET /v1/prompts/${oneLine(route.id, 12)}`;
			case "cancel":
				return `POST /v1/prompts/${oneLine(route.id, 12)}/cancel`;
			case "deploy":
				return `POST /v1/prompts/${oneLine(route.id, 12)}/deploy`;
			case "gamePending":
				return "GET /v1/game/pending";
			case "gamePoll":
				return "GET /v1/game/poll";
			case "gameToolResult":
				return "POST /v1/game/tool-result";
			case "gameRequest":
				return `GET /v1/game/requests/${oneLine(route.id, 8)}`;
			case "gameResult":
				return `POST /v1/game/requests/${oneLine(route.id, 8)}/result`;
		}
	};

	/** A prompt as a conversation message (replay after a swap or rejoin). */
	const message = (record: PromptRecord) => {
		const view = queue.view(record);
		const { events, next } = queue.condensed(record);
		return {
			id: record.id,
			prompt: record.prompt,
			state: view.state,
			summary: view.summary,
			commit: view.commit,
			artifactId: view.artifactId,
			error: view.error,
			costUsd: view.costUsd,
			attachments: view.attachments ?? [],
			queuedAt: view.queuedAt,
			startedAt: view.startedAt,
			finishedAt: view.finishedAt,
			events,
			next,
		};
	};

	const conversationSummary = (conversation: Conversation) => {
		const lastId = conversation.promptIds[conversation.promptIds.length - 1];
		const last = lastId ? queue.get(lastId) : undefined;
		return {
			id: conversation.id,
			title: conversation.title,
			createdAt: conversation.createdAt,
			updatedAt: conversation.updatedAt,
			prompts: conversation.promptIds.length,
			state: last?.state,
		};
	};

	async function handleAuthed(req: Request, url: URL, route: AuthedRoute): Promise<Response> {
		const what = describeRoute(route);
		const authz = req.headers.get("authorization") ?? "";
		const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/.exec(authz);
		if (!m || m[1].length > 2048) return decide(401, what, "no bearer token"), empty(401);
		const job = req.headers.get("x-tt-job") ?? "";
		const verified = await auth.verify(m[1], job, SCOPE_FOR[route.kind]);
		if (!verified.ok) {
			const who = verified.userId !== undefined ? `roblox:${verified.userId} ` : "";
			return decide(verified.status, what, `${who}${verified.jti ? `jti=${verified.jti.slice(0, 8)} ` : ""}${verified.reason}`), empty(verified.status);
		}
		const { userId, claims } = verified;
		const who = `roblox:${userId} jti=${claims.jti.slice(0, 8)}`;

		// Every POST (create, cancel, attach) carries a fresh X-TT-Nonce and an X-TT-Timestamp within ±300 s.
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
			// A follow-up: only in the caller's own conversation, and not while its previous prompt is still going.
			let conversation: Conversation | undefined;
			if (body.conversationId !== undefined) {
				conversation = conversations.owned(body.conversationId, userId);
				if (!conversation) return decide(404, what, `${who} unknown conversation`), empty(404);
				if (queue.busy(conversation)) return decide(409, what, `${who} conversation busy`), empty(409);
			}
			const used = attachments.check(body.attachments ?? [], userId);
			if (!used) return decide(400, what, `${who} attachment not found, not yours or already used`), empty(400);
			const mode = body.mode ?? "live";
			const refused = queue.refusal(mode);
			if (refused === "max-prompts" || refused === "queue-full") return decide(429, what, `${who} ${refused}`), empty(429);
			if (refused === "stopped") return decide(503, what, `${who} shutting down`), empty(503);
			// Code runs take turns on the worktree, and wait while a deploy proposal is undecided.
			if (refused === "code-busy") return decide(423, what, `${who} code mode busy (a code run or deploy proposal is pending)`), empty(423);
			const isNew = conversation === undefined;
			conversation ??= conversations.create(userId, body.prompt);
			const record = queue.create(userId, body.prompt, body.context, { conversation, attachments: used, job: claims.job, mode });
			if (typeof record === "string") {
				if (isNew) conversations.discard(conversation.id);
				const status = record === "stopped" ? 503 : record === "code-busy" ? 423 : 429;
				return decide(status, what, `${who} ${record}`), empty(status);
			}
			conversations.touch(conversation);
			// Attached logs are counted, never printed (they can hold other players' names and chat).
			const logs = body.context?.logs;
			const extra = [
				mode,
				isNew ? "new conversation" : `conversation ${conversation.id.slice(0, 8)}`,
				used.length ? `${used.length} attachment(s)` : "",
				logs ? `${[logs.client !== undefined && "client", logs.server !== undefined && "server"].filter(Boolean).join(" + ")} logs attached` : "",
			]
				.filter(Boolean)
				.join(", ");
			decide(200, what, `${who} queued ${record.id.slice(0, 8)} (${extra})`);
			return json({ id: record.id, state: record.state, conversationId: conversation.id });
		}

		if (route.kind === "attach") {
			if (!isJson(req)) return decide(400, what, `${who} content-type`), empty(400);
			if (attachments.count(userId) >= ATTACHMENT_LIMITS.perUser) return decide(429, what, `${who} attachment quota (${ATTACHMENT_LIMITS.perUser})`), empty(429);
			const text = await readBody(req, ATTACHMENT_LIMITS.maxBodyBytes);
			if (text === TOO_LARGE) return decide(413, what, `${who} body too large`), empty(413);
			if (text === undefined) return decide(400, what, `${who} body encoding`), empty(400);
			const body = parseAttachmentRequest(parseJson(text));
			if (!body) return decide(400, what, `${who} body schema`), empty(400);
			const saved = attachments.add(userId, body);
			if (saved === "quota") return decide(429, what, `${who} attachment quota`), empty(429);
			if (typeof saved === "string") return decide(400, what, `${who} ${saved}`), empty(400);
			decide(200, what, `${who} ${saved.width}x${saved.height} → ${saved.relPath} (${saved.pngBytes} bytes)`);
			return json({ id: saved.id, width: saved.width, height: saved.height });
		}

		if (route.kind === "conversations") {
			const list = conversations.forUser(userId).slice(0, CONVERSATIONS_LISTED).map(conversationSummary);
			return json({ conversations: list });
		}

		if (route.kind === "conversation") {
			if (!CONVERSATION_ID_PATTERN.test(route.id)) return decide(404, what, who), empty(404);
			const conversation = conversations.owned(route.id, userId);
			if (!conversation) return decide(404, what, `${who} not found or not theirs`), empty(404);
			const records = conversation.promptIds.slice(-MESSAGES_RETURNED).map((id) => queue.get(id)).filter((r): r is PromptRecord => r !== undefined);
			return json({ ...conversationSummary(conversation), messages: records.map(message), truncated: conversation.promptIds.length > MESSAGES_RETURNED });
		}

		if (route.kind === "gamePoll") {
			const raw = url.searchParams.get("since");
			if (raw !== null && !SINCE_PATTERN.test(raw)) return decide(400, what, `${who} bad since`), empty(400);
			const pending = () => gameRequests.pendingFor(userId, claims.job).length > 0;
			const reply = await feeds.poll(userId, claims.job, raw === null ? undefined : Number(raw), pending, req.signal);
			const requests = gameRequests.pendingFor(userId, claims.job).map((request) => {
				request.state = "delivered";
				return requestPayload(request);
			});
			if (requests.length > 0) decide(200, what, `${who} ${requests.map((r) => r.tool).join(", ")} delivered`);
			return json({ ...reply, requests });
		}

		if (route.kind === "gameToolResult") {
			if (!isJson(req)) return decide(400, what, `${who} content-type`), empty(400);
			const text = await readBody(req, GAME_LIMITS.resultBodyBytes);
			if (text === TOO_LARGE) return decide(413, what, `${who} body too large`), empty(413);
			if (text === undefined) return decide(400, what, `${who} body encoding`), empty(400);
			const body = parseJson(text) as Record<string, unknown> | undefined;
			const id = body && typeof body === "object" ? body.id : undefined;
			const request = typeof id === "string" && REQUEST_ID_PATTERN.test(id) ? gameRequests.get(id) : undefined;
			if (!request || request.userId !== userId || request.job !== claims.job) return decide(404, what, `${who} not theirs or unknown`), empty(404);
			const { id: _id, ...rest } = body as Record<string, unknown>;
			const result = parseGameResult(rest);
			if (!result) return decide(400, what, `${who} body schema`), empty(400);
			if (!gameRequests.complete(request.id, result)) return decide(410, what, `${who} ${request.state}`), empty(410);
			decide(200, what, `${who} ${request.tool} ${result.denied ? "denied" : result.ok ? "ok" : "error"}${result.ms !== undefined ? ` ${result.ms} ms` : ""}`);
			return json({ ok: true });
		}

		if (route.kind === "gamePending") {
			const pending = gameRequests.pendingFor(userId, claims.job).map((r) => ({ id: r.id, tool: r.tool }));
			return json({ requests: pending });
		}

		if (route.kind === "gameRequest" || route.kind === "gameResult") {
			// Only the request's own user on its own game server (the token's job) may read or answer it.
			const request = REQUEST_ID_PATTERN.test(route.id) ? gameRequests.get(route.id) : undefined;
			if (!request || request.userId !== userId || request.job !== claims.job) return decide(404, what, `${who} not theirs or unknown`), empty(404);
			if (route.kind === "gameRequest") {
				if (request.state === "expired" || request.state === "done") return decide(410, what, `${who} ${request.state}`), empty(410);
				request.state = "delivered";
				decide(200, what, `${who} ${request.tool} delivered`);
				return json({
					id: request.id,
					tool: request.tool,
					args: request.args,
					description: request.description,
					timeoutSeconds: request.timeoutSeconds,
					conversationId: request.conversationId,
					promptId: request.promptId,
				});
			}
			if (!isJson(req)) return decide(400, what, `${who} content-type`), empty(400);
			const text = await readBody(req, GAME_LIMITS.resultBodyBytes);
			if (text === TOO_LARGE) return decide(413, what, `${who} body too large`), empty(413);
			if (text === undefined) return decide(400, what, `${who} body encoding`), empty(400);
			const result = parseGameResult(parseJson(text));
			if (!result) return decide(400, what, `${who} body schema`), empty(400);
			if (!gameRequests.complete(request.id, result)) return decide(410, what, `${who} ${request.state}`), empty(410);
			decide(200, what, `${who} ${request.tool} ${result.denied ? "denied" : result.ok ? "ok" : "error"}${result.ms !== undefined ? ` ${result.ms} ms` : ""}`);
			return json({ ok: true });
		}

		if (!PROMPT_ID_PATTERN.test(route.id)) return decide(404, what, who), empty(404);
		const record = queue.get(route.id);
		if (!record) return decide(404, what, who), empty(404);
		if (route.kind === "get") {
			const since = url.searchParams.get("since");
			if (since !== null && !SINCE_PATTERN.test(since)) return decide(400, what, `${who} bad since`), empty(400);
			return json(queue.view(record, since === null ? undefined : Number(since)));
		}

		// A deploy decision: only the requester, only while the proposal waits.
		if (route.kind === "deploy") {
			if (!isJson(req)) return decide(400, what, `${who} content-type`), empty(400);
			const text = await readBody(req, 256);
			if (typeof text !== "string") return decide(400, what, `${who} body`), empty(400);
			const decision = parseDeployDecision(parseJson(text));
			if (!decision) return decide(400, what, `${who} body schema`), empty(400);
			const result = await queue.decide(record.id, userId, decision);
			if (result === "not_yours") return decide(403, what, `${who} not the requester`), empty(403);
			if (result === "missing") return decide(404, what, `${who} no proposal`), empty(404);
			if (result === "not_pending") return decide(409, what, `${who} proposal already ${record.proposal?.status}`), empty(409);
			if (result === "failed") return decide(500, what, `${who} ${decision} failed: ${record.proposal?.error ?? "?"}`), json({ ok: false, error: "failed" }, 500);
			decide(200, what, `${who} ${decision}`);
			return json({ ok: true, state: record.state });
		}

		// Cancel (no body or Content-Type expected; a body is ignored): only the requester (or the dev at the terminal).
		if (record.userId !== userId) return decide(403, what, `${who} not the requester`), empty(403);
		const result = queue.cancel(record.id, `roblox:${userId}`);
		if (result === "finished") return decide(409, what, `${who} already finished`), empty(409);
		if (result === "missing") return empty(404);
		decide(200, what, `${who} cancelled`);
		return json({ ok: true });
	}

	/** One game-tool call from the running prompt's Claude: create, wake, wait, format. */
	async function callGameTool(record: PromptRecord, name: unknown, args: unknown): Promise<{ text: string; isError: boolean }> {
		const call = parseToolCall(name, args);
		if (typeof call === "string") return { text: call, isError: true };
		// Modes are enforced here too, not only by the run's tool allowlist: code runs never run Luau on the server.
		if (!(record.mode === "live" ? GAME_TOOLS : READ_ONLY_GAME_TOOLS).includes(call.tool as never)) {
			return { text: `${call.tool} is only available in Live mode. Tell the developer to switch to Live mode for this.`, isError: true };
		}
		if (call.tool === "screenshot") return { text: "Screenshots are not available yet.", isError: true };
		if (gameRequests.countFor(record.id) >= GAME_LIMITS.perPrompt) return { text: "Too many game tool calls in this prompt.", isError: true };
		queue.flush(record);
		const request = gameRequests.create({
			promptId: record.id,
			conversationId: record.conversation?.id,
			userId: record.userId,
			job: record.job,
			tool: call.tool,
			args: call.args,
			description: call.description,
			timeoutSeconds: call.timeoutSeconds,
		});
		// run_luau: the code's SHA-256 matches the game's durable audit record (audit/<date>/<job>/<n>), which never holds the code.
		const codeHash = call.tool === "run_luau" && typeof call.args.code === "string" ? `  code sha256 ${createHash("sha256").update(call.args.code, "utf8").digest("hex").slice(0, 16)}` : "";
		logger.info(`game tool ${call.tool} ${request.id.slice(0, 8)} for roblox:${record.userId} on job ${record.job.slice(0, 8) || "(studio)"}: "${oneLine(call.description, 60)}"${codeHash}`);
		// The game server's long-poll picks it up at once; a wake message only when no poll is open.
		feeds.requestAdded(record.userId, record.job);
		if (options.publishWake && !feeds.isPolling(record.userId, record.job)) void options.publishWake(wakeMessage(auth.sessionId, record.job, request.id, record.userId));
		const defaultMs = waitMsFor(call);
		const done = await gameRequests.wait(request.id, options.gameWaitMs ? options.gameWaitMs(defaultMs) : defaultMs, record.abort.signal);
		if (!done) logger.warn(`game tool ${call.tool} ${request.id.slice(0, 8)}: no answer from the game server`);
		return formatGameResult(call.tool, done?.result);
	}

	/**
	 * The game tools as an MCP server (streamable HTTP, JSON responses). Only the local claude process of a running
	 * prompt can use it: it needs that run's bearer token, and requests that came through the tunnel are refused.
	 */
	async function handleMcp(req: Request, bunServer: Server<unknown>): Promise<Response> {
		for (const name of req.headers.keys()) if (isProxyHeader(name)) return empty(404);
		if (req.method !== "POST") return empty(405);
		const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get("authorization") ?? "");
		const promptId = m ? gameRequests.promptForToken(m[1]) : undefined;
		const record = promptId ? queue.get(promptId) : undefined;
		if (!record || record.done) return decide(401, "POST /mcp", "no run token"), empty(401);
		bunServer.timeout(req, 0); // a tool call waits for the game (and the dev's approval)
		const text = await readBody(req, 64 * 1024);
		if (typeof text !== "string") return empty(413);
		const body = parseJson(text);
		const messages = Array.isArray(body) ? body : [body];
		const replies: unknown[] = [];
		for (const message of messages) {
			if (typeof message !== "object" || message === null) continue;
			const { id, method, params } = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
			if (id === undefined || id === null) continue; // notifications
			const reply = (result: unknown) => replies.push({ jsonrpc: "2.0", id, result });
			const fail = (code: number, text: string) => replies.push({ jsonrpc: "2.0", id, error: { code, message: text } });
			if (method === "initialize") {
				const version = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
				reply({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: GAME_MCP_SERVER, version: "0.1.0" } });
			} else if (method === "ping") reply({});
			else if (method === "tools/list") {
				const allowed: readonly string[] = record.mode === "live" ? GAME_TOOLS : READ_ONLY_GAME_TOOLS;
				reply({ tools: GAME_TOOL_DEFS.filter((def) => allowed.includes(def.name)) });
			}
			else if (method === "tools/call") {
				const result = await callGameTool(record, params?.name, params?.arguments);
				reply({ content: [{ type: "text", text: result.text }], isError: result.isError });
			} else fail(-32601, "method not found");
		}
		if (replies.length === 0) return new Response(null, { status: 202, headers: BASE_HEADERS });
		return json(Array.isArray(body) ? replies : replies[0]);
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		development: false,
		// The attachment body is the largest; every route still enforces its own cap while reading.
		maxRequestBodySize: ATTACHMENT_LIMITS.maxBodyBytes + 64 * 1024,
		async fetch(req: Request, bunServer: Server<unknown>): Promise<Response> {
			const url = new URL(req.url);
			if (url.pathname === MCP_PATH) return handleMcp(req, bunServer);
			const route = matchRoute(req.method, url.pathname);
			if (!route) return empty(404);
			if (headersTooLarge(req)) return decide(431, `${req.method} ${url.pathname.slice(0, 40)}`, "headers too large"), empty(431);
			// The long-poll holds up to 20 s (Bun closes idle requests after 10 s by default).
			if (route.kind === "gamePoll") bunServer.timeout(req, 40);
			return route.kind === "token" ? handleToken(req) : handleAuthed(req, url, route);
		},
		error(error: Error): Response {
			logger.error(`request failed: ${error.message}`);
			return empty(500);
		},
	});

	const port = server.port as number;
	localUrl = `http://127.0.0.1:${port}`;
	return {
		auth,
		queue,
		pairing,
		lockout,
		conversations,
		attachments,
		gameRequests,
		port,
		localUrl: `http://127.0.0.1:${port}`,
		rotateAll() {
			auth.rotate();
			pairing.rotate("manual");
		},
		setTunnelUrl(url) {
			if (auth.tunnelUrl === "") {
				auth.bindUrl(url);
				pairing.bindUrl(url);
				return undefined;
			}
			if (url === auth.tunnelUrl) return undefined;
			const previous = auth.rekey(url);
			pairing.bindUrl(url, "tunnel");
			logger.warn(`tunnel URL changed: new session ${auth.sessionId.slice(0, 8)} (was ${previous.slice(0, 8)}); every game server must pair again`);
			return previous;
		},
		async stop() {
			pairing.dispose();
			await queue.stop();
			await server.stop(true);
			attachments.clear();
		},
	};
}

export { ATTACHMENT_ID_PATTERN };
