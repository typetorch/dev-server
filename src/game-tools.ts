/**
 * Game tools: Claude reads and changes the requesting developer's live dev game server.
 *
 *   claude -p ──MCP "typetorch-game" (http, per-run bearer token)──► POST /mcp  tools/call
 *     run_luau {code, timeoutSeconds?, description?}   Luau on the server (the dev approves it in the chat)
 *     game_logs {realm, since?, filter?, limit?}        server logs, or the requesting dev's client logs
 *     inspect {realm, path, depth?, properties?}        an instance: properties, attributes, tags, children
 *     find {realm, query, under?, limit?}               instances whose Name or ClassName contains the query
 *     game_status {}                                    artifact, generation, branch, channel, players, uptime
 *     screenshot {}                                     not available yet (spike S11)
 *   dev server: a request bound to the prompt's requester (user id) and the game server that sent the prompt (the
 *               JWT `job`); a tiny wake message on MessagingService topic TypeTorch/tool {v,s,j,x,u} (never the code);
 *   game server (same JobId, dev channel, requester still in it and still a dev):
 *               GET /v1/game/pending (backup poll) → GET /v1/game/requests/:id → runs it →
 *               POST /v1/game/requests/:id/result {ok, output[], returned?, error?, data?, ms, denied?}
 *   dev server: the tool call returns the result to Claude, wrapped as untrusted game data, capped at 64 KB.
 * Only the token's user AND job can read or answer a request: no other server and no other dev.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { oneLine, redactEvent } from "./log";

export const GAME_MCP_SERVER = "typetorch-game";
export const GAME_TOPIC = "TypeTorch/tool";
export const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
export const GAME_TOOLS = ["run_luau", "game_logs", "inspect", "find", "game_status", "screenshot"] as const;
export type GameToolName = (typeof GAME_TOOLS)[number];
/** As Claude Code names MCP tools: mcp__<server>__<tool>. */
export const fullToolName = (tool: GameToolName) => `mcp__${GAME_MCP_SERVER}__${tool}`;
export const GAME_TOOL_PREFIX = `mcp__${GAME_MCP_SERVER}__`;

export const GAME_LIMITS = {
	codeBytes: 16 * 1024,
	descriptionChars: 120,
	pathChars: 500,
	queryChars: 100,
	defaultTimeout: 10,
	maxTimeout: 30,
	/** Read-only tools answer within this long. */
	readTimeout: 15,
	/** The dev approves run_luau (or "always" is set) within this long, or the game server denies it. */
	approvalSeconds: 60,
	/** Extra wait for delivery and the HTTP round trips. */
	graceSeconds: 20,
	resultBodyBytes: 80 * 1024,
	outputLines: 200,
	lineChars: 1000,
	/** Text returned to Claude (and `data` from the game). */
	resultChars: 64 * 1024,
	/** Requests per prompt. */
	perPrompt: 60,
} as const;

export type RequestState = "pending" | "delivered" | "done" | "expired";

export interface GameResult {
	ok: boolean;
	output: string[];
	returned?: string;
	error?: string;
	/** Read-only tools: the answer (JSON or text). */
	data?: string;
	ms?: number;
	/** The dev said no (or didn't answer in time). */
	denied?: boolean;
}

export interface GameRequest {
	id: string;
	promptId: string;
	conversationId?: string;
	userId: number;
	job: string;
	tool: GameToolName;
	args: Record<string, unknown>;
	/** A short label the developer sees. */
	description: string;
	timeoutSeconds: number;
	state: RequestState;
	createdAt: number;
	result?: GameResult;
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest();

/** `{"v":1,"s":<session>,"j":<job>,"x":<request id>,"u":<user id>}`: a wake-up only, never the request itself. */
export function wakeMessage(sessionId: string, job: string, requestId: string, userId: number): string {
	return JSON.stringify({ v: 1, s: sessionId, j: job, x: requestId, u: userId });
}

export class GameRequestStore {
	private readonly items = new Map<string, GameRequest>();
	private readonly waiters = new Map<string, Set<(record: GameRequest) => void>>();
	/** sha256(run token) → prompt id, while that prompt runs. */
	private readonly runTokens = new Map<string, string>();

	issueRunToken(promptId: string): string {
		const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
		this.runTokens.set(sha(token).toString("hex"), promptId);
		return token;
	}

	revokeRunToken(token: string): void {
		this.runTokens.delete(sha(token).toString("hex"));
	}

	/** The prompt a run token belongs to (constant-time compare of the hashes). */
	promptForToken(token: string): string | undefined {
		const hash = sha(token);
		let found: string | undefined;
		for (const [stored, promptId] of this.runTokens) {
			const candidate = Buffer.from(stored, "hex");
			if (candidate.length === hash.length && timingSafeEqual(candidate, hash)) found = promptId;
		}
		return found;
	}

	countFor(promptId: string): number {
		let count = 0;
		for (const record of this.items.values()) if (record.promptId === promptId) count += 1;
		return count;
	}

	create(fields: Omit<GameRequest, "id" | "state" | "createdAt">): GameRequest {
		const record: GameRequest = { ...fields, id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"), state: "pending", createdAt: Date.now() };
		this.items.set(record.id, record);
		return record;
	}

	get(id: string): GameRequest | undefined {
		return this.items.get(id);
	}

	/** Requests waiting for this user's game server (`job`), oldest first. */
	pendingFor(userId: number, job: string): GameRequest[] {
		return [...this.items.values()].filter((r) => r.state === "pending" && r.userId === userId && r.job === job);
	}

	complete(id: string, result: GameResult): boolean {
		const record = this.items.get(id);
		if (!record || record.state === "done" || record.state === "expired") return false;
		record.state = "done";
		record.result = result;
		for (const wake of this.waiters.get(id) ?? []) wake(record);
		this.waiters.delete(id);
		return true;
	}

	/** Resolves with the finished record, or undefined after `timeoutMs` or an abort (the request is then expired). */
	wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<GameRequest | undefined> {
		const record = this.items.get(id);
		if (!record) return Promise.resolve(undefined);
		if (record.state === "done") return Promise.resolve(record);
		return new Promise((resolve) => {
			const finish = (value: GameRequest | undefined) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.waiters.get(id)?.delete(wake);
				resolve(value);
			};
			const wake = (done: GameRequest) => finish(done);
			const onAbort = () => {
				if (record.state !== "done") record.state = "expired";
				finish(undefined);
			};
			const timer = setTimeout(() => {
				if (record.state !== "done") record.state = "expired";
				finish(record.state === "done" ? record : undefined);
			}, timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (!this.waiters.has(id)) this.waiters.set(id, new Set());
			this.waiters.get(id)!.add(wake);
		});
	}

	/** Expires everything of a finished prompt. */
	expirePrompt(promptId: string): void {
		for (const record of this.items.values()) if (record.promptId === promptId && record.state !== "done") record.state = "expired";
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** `{ok, output?, returned?, error?, data?, ms?, denied?}` from a game server, capped; undefined when malformed. */
export function parseGameResult(raw: unknown): GameResult | undefined {
	if (!isPlainObject(raw)) return undefined;
	for (const key of Object.keys(raw)) if (!["ok", "output", "returned", "error", "data", "ms", "denied"].includes(key)) return undefined;
	if (typeof raw.ok !== "boolean") return undefined;
	const output: string[] = [];
	if (raw.output !== undefined) {
		if (!Array.isArray(raw.output)) return undefined;
		for (const line of raw.output.slice(0, GAME_LIMITS.outputLines)) {
			if (typeof line !== "string") return undefined;
			output.push(line.slice(0, GAME_LIMITS.lineChars));
		}
	}
	const result: GameResult = { ok: raw.ok, output };
	for (const key of ["returned", "error", "data"] as const) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== "string") return undefined;
		result[key] = value.slice(0, GAME_LIMITS.resultChars);
	}
	if (raw.ms !== undefined) {
		if (typeof raw.ms !== "number" || !Number.isFinite(raw.ms) || raw.ms < 0) return undefined;
		result.ms = Math.round(raw.ms);
	}
	if (raw.denied !== undefined) {
		if (typeof raw.denied !== "boolean") return undefined;
		result.denied = raw.denied;
	}
	return result;
}

/** Game data as Claude sees it: labeled untrusted, "<" and ">" escaped so it can't close the block. */
function untrusted(tool: string, text: string): string {
	const safe = text.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
	return `<untrusted-game-data tool="${tool}">\n${safe}\n</untrusted-game-data>`;
}

/** What Claude reads back from a game tool. */
export function formatGameResult(tool: GameToolName, result: GameResult | undefined): { text: string; isError: boolean } {
	if (!result) {
		return {
			text: "No answer from the game server in time. The developer may have left that server, it may not run TypeTorch's dev menu, or it missed the request. Nothing was run as far as the dev server knows.",
			isError: true,
		};
	}
	if (result.denied) return { text: `The developer did not approve this${result.error ? ` (${result.error})` : ""}. Nothing was run.`, isError: true };
	const parts: string[] = [];
	if (tool === "run_luau") parts.push(result.ok ? `ok${result.ms !== undefined ? ` (${result.ms} ms)` : ""}` : `error${result.ms !== undefined ? ` after ${result.ms} ms` : ""}`);
	else if (!result.ok) parts.push("error");
	const body: string[] = [];
	if (result.output.length > 0) body.push(`output:\n${result.output.join("\n")}`);
	if (result.returned !== undefined) body.push(`returned: ${result.returned}`);
	if (result.data !== undefined) body.push(result.data);
	if (result.error !== undefined) body.push(`error: ${result.error}`);
	let data = body.join("\n");
	const cap = GAME_LIMITS.resultChars - 300;
	if (data.length > cap) data = `${data.slice(0, cap)}\n… (truncated: the result was over 64 KB; ask for less, e.g. a smaller depth, a filter or a limit)`;
	if (data) parts.push(untrusted(tool, data));
	return { text: redactEvent(parts.join("\n"), GAME_LIMITS.resultChars), isError: !result.ok };
}

const realm = { type: "string", enum: ["server", "client"], description: "server (default) or the requesting developer's own client" } as const;

/** The MCP tool definitions (JSON Schema inputs). */
export const GAME_TOOL_DEFS = [
	{
		name: "run_luau",
		description:
			"Run a Luau snippet on the requesting developer's live dev game server (server realm; the server that sent this prompt). The developer sees the code and approves it before it runs. In the snippet: `player` is the requesting Player, `kernel` the TypeTorch server kernel, `persist(key)` the kernel persist store; `game`, `workspace` and the usual globals work. print/warn output and returned values come back. Default timeout 10 s (max 30). Prefer small, reversible snippets that touch only the requester (their character, their data).",
		inputSchema: {
			type: "object",
			properties: {
				code: { type: "string", description: "Luau source (at most 16 KB). `return` a value to see it." },
				description: { type: "string", description: 'A short label the developer sees, e.g. "Give me 100 coins".' },
				timeoutSeconds: { type: "number", minimum: 1, maximum: 30 },
			},
			required: ["code"],
			additionalProperties: false,
		},
	},
	{
		name: "game_logs",
		description:
			"Recent log lines (print, warn, errors with their [file:line]) of the live game: the server, or the requesting developer's own client. Newest last.",
		inputSchema: {
			type: "object",
			properties: {
				realm,
				since: { type: "number", description: "Only lines after this log index (from an earlier call)." },
				filter: { type: "string", description: "Only lines containing this text (case-insensitive)." },
				limit: { type: "number", minimum: 1, maximum: 500, description: "Default 100." },
			},
			additionalProperties: false,
		},
	},
	{
		name: "inspect",
		description:
			"Look at one instance of the live game: class, properties, attributes, tags and children (to `depth` levels, max 3). Path like game.Workspace.Map or Workspace/Map/Part.",
		inputSchema: {
			type: "object",
			properties: {
				realm,
				path: { type: "string" },
				depth: { type: "number", minimum: 0, maximum: 3, description: "Child levels to list (default 1)." },
				properties: { type: "boolean", description: "Include properties and attributes (default true)." },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		name: "find",
		description: "Find instances in the live game whose Name or ClassName contains `query` (case-insensitive), under `under` (default game).",
		inputSchema: {
			type: "object",
			properties: {
				realm,
				query: { type: "string" },
				under: { type: "string", description: "A path to search under (default game)." },
				limit: { type: "number", minimum: 1, maximum: 200, description: "Default 50." },
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "game_status",
		description: "The live game server: artifact, generation, branch, channel, uptime, and its players (names, user ids, character positions).",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "screenshot",
		description: "A screenshot of the requesting developer's view. Not available yet.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
] as const;

export interface ParsedToolCall {
	tool: GameToolName;
	args: Record<string, unknown>;
	description: string;
	timeoutSeconds: number;
}

const int = (value: unknown, min: number, max: number): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined;

/** Validates a tool call; a string is the error to return to Claude. */
export function parseToolCall(name: unknown, raw: unknown): ParsedToolCall | string {
	if (typeof name !== "string" || !(GAME_TOOLS as readonly string[]).includes(name)) return "unknown tool";
	const tool = name as GameToolName;
	const input = raw === undefined ? {} : raw;
	if (!isPlainObject(input)) return "arguments must be an object";
	const allowed = (GAME_TOOL_DEFS.find((def) => def.name === tool)!.inputSchema as { properties: Record<string, unknown> }).properties;
	for (const key of Object.keys(input)) if (!(key in allowed)) return `unknown argument ${key}`;
	const realmOf = (): string | undefined => {
		if (input.realm === undefined) return "server";
		return input.realm === "server" || input.realm === "client" ? input.realm : undefined;
	};
	switch (tool) {
		case "run_luau": {
			if (typeof input.code !== "string" || input.code.trim() === "") return "code is required";
			if (Buffer.byteLength(input.code, "utf8") > GAME_LIMITS.codeBytes) return `code is over ${GAME_LIMITS.codeBytes} bytes`;
			if (input.description !== undefined && typeof input.description !== "string") return "description must be a string";
			const timeoutSeconds = input.timeoutSeconds === undefined ? GAME_LIMITS.defaultTimeout : int(input.timeoutSeconds, 1, GAME_LIMITS.maxTimeout);
			if (timeoutSeconds === undefined) return "timeoutSeconds must be a number";
			const firstLine = input.code.split(/\r?\n/).find((line) => line.trim()) ?? "luau";
			const description = oneLine(typeof input.description === "string" && input.description.trim() ? input.description : firstLine, GAME_LIMITS.descriptionChars);
			return { tool, args: { code: input.code, timeoutSeconds }, description, timeoutSeconds };
		}
		case "game_logs": {
			const where = realmOf();
			if (!where) return "realm must be server or client";
			const args: Record<string, unknown> = { realm: where, limit: input.limit === undefined ? 100 : int(input.limit, 1, 500) };
			if (args.limit === undefined) return "limit must be a number";
			if (input.since !== undefined) {
				const since = int(input.since, 0, 2 ** 31);
				if (since === undefined) return "since must be a number";
				args.since = since;
			}
			if (input.filter !== undefined) {
				if (typeof input.filter !== "string" || input.filter.length > GAME_LIMITS.queryChars) return "filter must be a short string";
				args.filter = input.filter;
			}
			return { tool, args, description: `${where} logs`, timeoutSeconds: GAME_LIMITS.readTimeout };
		}
		case "inspect": {
			const where = realmOf();
			if (!where) return "realm must be server or client";
			if (typeof input.path !== "string" || input.path.trim() === "" || input.path.length > GAME_LIMITS.pathChars) return "path is required (at most 500 characters)";
			const depth = input.depth === undefined ? 1 : int(input.depth, 0, 3);
			if (depth === undefined) return "depth must be a number";
			if (input.properties !== undefined && typeof input.properties !== "boolean") return "properties must be a boolean";
			return {
				tool,
				args: { realm: where, path: input.path, depth, properties: input.properties !== false },
				description: oneLine(input.path, 80),
				timeoutSeconds: GAME_LIMITS.readTimeout,
			};
		}
		case "find": {
			const where = realmOf();
			if (!where) return "realm must be server or client";
			if (typeof input.query !== "string" || input.query.trim() === "" || input.query.length > GAME_LIMITS.queryChars) return "query is required (at most 100 characters)";
			if (input.under !== undefined && (typeof input.under !== "string" || input.under.length > GAME_LIMITS.pathChars)) return "under must be a path";
			const limit = input.limit === undefined ? 50 : int(input.limit, 1, 200);
			if (limit === undefined) return "limit must be a number";
			const args: Record<string, unknown> = { realm: where, query: input.query, limit };
			if (input.under !== undefined) args.under = input.under;
			return { tool, args, description: oneLine(input.query, 60), timeoutSeconds: GAME_LIMITS.readTimeout };
		}
		case "game_status":
			return { tool, args: {}, description: "status", timeoutSeconds: GAME_LIMITS.readTimeout };
		case "screenshot":
			return { tool, args: {}, description: "screenshot", timeoutSeconds: GAME_LIMITS.readTimeout };
	}
}

/** How long the dev server waits for a request's result. */
export function waitMsFor(call: ParsedToolCall): number {
	const approval = call.tool === "run_luau" ? GAME_LIMITS.approvalSeconds : 0;
	return (approval + call.timeoutSeconds + GAME_LIMITS.graceSeconds) * 1000;
}
