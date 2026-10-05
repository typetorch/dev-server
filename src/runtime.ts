/**
 * The few places where Bun and Node differ, behind one small API, so the dev-server runs the same under
 * `bun src/index.ts` (development) and `node dist/index.js` (npm / npx):
 *   - child processes on node:child_process: PATH lookup (PATHEXT on Windows), Windows .cmd scripts (Node refuses to
 *     spawn them directly), kill-tree;
 *   - the loopback HTTP server: Bun.serve under Bun (as before), node:http under Node, with the same contract (see
 *     `serve`);
 *   - zstd (node:zlib has it from Node 22.15 / 23.8; Bun always), AbortSignal.any, "is this the main module", the
 *     module's folder, the Bun executable.
 * Everything but `serve`'s Bun branch uses Node's own modules (Bun implements them too).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { constants as osConstants } from "node:os";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

/** True under Bun (development: `bun src/index.ts`); false under Node (the npm package). */
export const isBun = typeof process.versions.bun === "string";

/** "bun 1.3.14" or "node v22.17.1". */
export function runtimeName(): string {
	return isBun ? `bun ${process.versions.bun}` : `node ${process.version}`;
}

export function sleep(ms: number): Promise<void> {
	return delay(ms).then(() => undefined);
}

/** The folder of a module (`import.meta.dir` in Bun). */
export function moduleDir(meta: ImportMeta): string {
	return dirname(fileURLToPath(meta.url));
}

/** `import.meta.main`: true when this module is the entry point (Bun and Node 24.2+ say so; else argv[1] is compared). */
export function isMainModule(meta: ImportMeta): boolean {
	const main = (meta as { main?: unknown }).main;
	if (typeof main === "boolean") return main;
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		const a = realpathSync(entry);
		const b = realpathSync(fileURLToPath(meta.url));
		return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	} catch {
		return false;
	}
}

/** AbortSignal.any (Node 20.3+), with a fallback. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
	if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
	}
	return controller.signal;
}

// PATH lookup and Windows .cmd scripts -------------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

/** An environment variable, case-insensitively on Windows (a child env object may spell it "Path"). */
function envValue(env: Env, name: string): string | undefined {
	if (process.platform !== "win32") return env[name];
	const key = Object.keys(env).find((k) => k.toUpperCase() === name);
	return key === undefined ? undefined : env[key];
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (process.platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The executable `name` resolves to, like Bun.which: a path is checked as is; a bare name is searched in PATH (from
 * `env`, default the real environment), on Windows with each PATHEXT extension (extensionless files there are shell
 * scripts for Git Bash, not programs). The current directory is never searched.
 */
export function which(name: string, env: Env = process.env): string | undefined {
	if (!name) return undefined;
	const win = process.platform === "win32";
	const exts = win ? (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase()) : [""];
	const named = (base: string) => (win && !exts.some((e) => base.toLowerCase().endsWith(e)) ? exts.map((e) => base + e) : [base]);
	if (name.includes("/") || (win && name.includes("\\"))) return named(resolve(name)).find(isExecutableFile);
	for (const dir of (envValue(env, "PATH") ?? "").split(win ? ";" : ":")) {
		if (!dir) continue;
		const found = named(resolve(dir.replace(/^"(.*)"$/, "$1"), name)).find(isExecutableFile);
		if (found) return found;
	}
	return undefined;
}

/** Bun's executable: this process under Bun, else `bun` on PATH (game repos are Bun projects). */
export function bunExecutable(): string | undefined {
	return isBun ? process.execPath : which("bun");
}

/** The target of an npm (cmd-shim) .cmd script: `"%dp0%\node_modules\pkg\cli.js" %*`, resolved next to it. */
export function npmShimTarget(cmdFile: string): string | undefined {
	let text: string;
	try {
		if (statSync(cmdFile).size > 64 * 1024) return undefined;
		text = readFileSync(cmdFile, "utf8");
	} catch {
		return undefined;
	}
	const matches = [...text.matchAll(/"%~?dp0%?\\?([^"%]+)"\s+%\*/g)];
	const rel = matches.at(-1)?.[1];
	if (!rel || /[\r\n]/.test(rel)) return undefined;
	const target = resolve(dirname(cmdFile), rel);
	return isExecutableFile(target) ? target : undefined;
}

// cmd.exe metacharacters (cross-spawn's set): each is escaped with ^ when a .cmd script runs through cmd.exe.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for `cmd /d /s /c "<script> <args>"`: quoted, then every metacharacter caret-escaped for cmd's own
 * parse. The script parses its %* again, where only the quotes protect & | < > ( ): an argument holding a double quote
 * would unbalance them (BatBadBut), so it is refused, like a line break (cmd can't pass one at all).
 */
function cmdQuote(arg: string): string {
	if (/["\r\n\0]/.test(arg)) throw new Error("an argument with a double quote or a line break can't be passed to a .cmd/.bat script safely");
	return `"${arg.replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1");
}

export class ExecutableNotFoundError extends Error {
	override name = "ExecutableNotFoundError";
	readonly code = "ENOENT";
	constructor(readonly executable: string) {
		super(`Executable not found in $PATH: "${executable}"`);
	}
}

export interface ResolvedCommand {
	file: string;
	args: string[];
	/** cmd.exe gets its command line exactly as built (already quoted and escaped). */
	windowsVerbatimArguments?: boolean;
}

/**
 * How to start `cmd` with node:child_process, without a shell: the executable is looked up first (in the child's PATH,
 * then this process's), and a missing one throws ExecutableNotFoundError at once, as Bun.spawn does. On Windows a
 * .cmd/.bat file can't be spawned directly: an npm shim runs its JavaScript target with node (or its .exe target); any
 * other script runs through cmd.exe with every argument quoted and escaped (arguments holding a double quote or a line
 * break are refused).
 */
export function resolveCommand(cmd: readonly string[], env: Env = process.env): ResolvedCommand {
	const [exe, ...args] = cmd;
	const found = exe ? (which(exe, env) ?? (env === process.env ? undefined : which(exe))) : undefined;
	if (!found) throw new ExecutableNotFoundError(exe ?? "");
	if (process.platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
		const target = npmShimTarget(found);
		if (target && /\.[cm]?js$/i.test(target)) {
			const local = resolve(dirname(found), "node.exe");
			const node = isExecutableFile(local) ? local : (which("node", env) ?? which("node") ?? process.execPath);
			return { file: node, args: [target, ...args] };
		}
		if (target && /\.exe$/i.test(target)) return { file: target, args };
		const line = [found.replace(CMD_META, "^$1"), ...args.map(cmdQuote)].join(" ");
		return { file: envValue(process.env, "COMSPEC") ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
	}
	return { file: found, args };
}

// Child processes -----------------------------------------------------------------------------------------------------

export interface SpawnOptions {
	cwd?: string;
	/** The child's whole environment (default: this process's). */
	env?: Record<string, string>;
	/** Bytes or text written to stdin, then closed; default "ignore". */
	stdin?: "ignore" | "inherit" | Uint8Array | string;
	stdout?: "pipe" | "ignore" | "inherit";
	stderr?: "pipe" | "ignore" | "inherit";
}

/** A running child, shaped like Bun's Subprocess for what this package uses. */
export interface ChildHandle {
	readonly pid: number;
	/** null while it runs; its exit code once it exited (128 + n after signal n; 127 when it could not start). */
	readonly exitCode: number | null;
	/** Resolves with the exit code when the process exits (like Bun's `exited`; the pipes may still hold output). */
	readonly exited: Promise<number>;
	/** Async-iterable byte streams when piped. */
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	kill(signal?: NodeJS.Signals | number): void;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
	if (code !== null) return code;
	return signal ? 128 + (osConstants.signals[signal] ?? 1) : 1;
}

/**
 * Starts a process (never through a shell; see resolveCommand). Throws ExecutableNotFoundError at once for a missing
 * executable, like Bun.spawn; a later start failure ends it with exit 127.
 */
export function spawnChild(cmd: readonly string[], options: SpawnOptions = {}): ChildHandle {
	const env = options.env ?? (process.env as Record<string, string>);
	const resolved = resolveCommand(cmd, env);
	const input = options.stdin ?? "ignore";
	const child: ChildProcess = spawn(resolved.file, resolved.args, {
		cwd: options.cwd,
		env,
		stdio: [typeof input === "string" && (input === "ignore" || input === "inherit") ? input : "pipe", options.stdout ?? "pipe", options.stderr ?? "pipe"],
		windowsHide: true,
		windowsVerbatimArguments: resolved.windowsVerbatimArguments,
	});
	let exitCode: number | null = null;
	const exited = new Promise<number>((done) => {
		child.once("exit", (code, signal) => {
			exitCode ??= exitCodeOf(code, signal);
			done(exitCode);
		});
		child.once("error", () => {
			// Could not start (or could not be killed after it exited): settle only once.
			if (exitCode !== null || child.exitCode !== null || child.signalCode !== null) return;
			exitCode = 127;
			child.stdout?.destroy();
			child.stderr?.destroy();
			done(127);
		});
	});
	if (child.stdin) {
		child.stdin.on("error", () => {}); // EPIPE when the child exits before reading everything
		if (input instanceof Uint8Array) child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
		else if (typeof input === "string" && input !== "ignore" && input !== "inherit") child.stdin.end(input);
		else child.stdin.end();
	}
	return {
		get pid() {
			return child.pid ?? 0;
		},
		get exitCode() {
			return exitCode;
		},
		exited,
		stdout: child.stdout ?? null,
		stderr: child.stderr ?? null,
		kill(signal?: NodeJS.Signals | number) {
			try {
				child.kill(signal);
			} catch {}
		},
	};
}

/** Kills a process and everything it started (Windows: taskkill /T; elsewhere SIGKILL to the process). */
export function killTree(proc: { pid: number; exitCode: number | null; kill(signal?: NodeJS.Signals | number): void }): void {
	if (proc.exitCode !== null) return;
	if (process.platform === "win32" && proc.pid) {
		try {
			spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		} catch {}
	}
	try {
		proc.kill("SIGKILL");
	} catch {}
}

// zstd ----------------------------------------------------------------------------------------------------------------

export class ZstdUnavailableError extends Error {
	override name = "ZstdUnavailableError";
	constructor() {
		super(`zstd needs Node 22.15+ (or Bun); this is ${runtimeName()}`);
	}
}

type ZstdFn = (data: Uint8Array, options?: { maxOutputLength?: number; params?: Record<number, number> }) => Buffer;
const zstd = zlib as unknown as { zstdCompressSync?: ZstdFn; zstdDecompressSync?: ZstdFn };

/** True when this runtime can (de)compress zstd (images for the game, zstd attachments). */
export function hasZstd(): boolean {
	return typeof zstd.zstdDecompressSync === "function" && typeof zstd.zstdCompressSync === "function";
}

export function zstdDecompress(data: Uint8Array, maxOutputLength?: number): Uint8Array {
	if (typeof zstd.zstdDecompressSync !== "function") throw new ZstdUnavailableError();
	return new Uint8Array(zstd.zstdDecompressSync(data, maxOutputLength ? { maxOutputLength } : undefined));
}

export function zstdCompress(data: Uint8Array, params?: Record<number, number>): Uint8Array {
	if (typeof zstd.zstdCompressSync !== "function") throw new ZstdUnavailableError();
	return new Uint8Array(zstd.zstdCompressSync(data, params ? { params } : undefined));
}

// The HTTP server -----------------------------------------------------------------------------------------------------

export interface ServeContext {
	/** This request's idle timeout in seconds, 0 = none (Bun's `server.timeout(req, seconds)`). */
	timeout(req: Request, seconds: number): void;
}

export interface ServeOptions {
	hostname: string;
	/** 0 = a random free port. */
	port: number;
	/** A body over this many bytes is refused with `reject(413)` (Bun: maxRequestBodySize). */
	maxRequestBodySize: number;
	/** Seconds without traffic before a request or idle connection is closed (Bun's idleTimeout; default 10). */
	idleTimeoutSeconds?: number;
	fetch(req: Request, ctx: ServeContext): Promise<Response> | Response;
	/** The answer when `fetch` throws. */
	error(error: Error): Response;
	/** The answer the adapter itself gives (Node: 413 for an oversized body, 404 for a target that isn't a path). */
	reject(status: number): Response;
	/** Which implementation (default: Bun.serve under Bun, node:http under Node; tests force one). */
	backend?: "bun" | "node";
}

export interface Served {
	readonly port: number;
	readonly backend: "bun" | "node";
	/** Stops listening and closes every connection, active ones too. */
	stop(): Promise<void>;
}

interface BunServer {
	port: number;
	timeout(req: Request, seconds: number): void;
	stop(closeActiveConnections?: boolean): Promise<void> | void;
}

interface BunServeApi {
	serve(options: {
		hostname: string;
		port: number;
		development: boolean;
		maxRequestBodySize: number;
		idleTimeout: number;
		fetch(req: Request, server: BunServer): Promise<Response> | Response;
		error(error: Error): Response;
	}): BunServer;
}

/**
 * The HTTP server. Under Bun it is Bun.serve; under Node, node:http behind an adapter that keeps Bun.serve's contract,
 * so the handlers (Request → Response) and the security properties are the same on both:
 *   - bound to `hostname` only (127.0.0.1: the tunnel is the only way in);
 *   - a declared Content-Length over maxRequestBodySize gets 413 before the handler runs, and a body that grows past
 *     it while streaming is cut off (413, connection closed); an unread body is drained only up to the cap;
 *   - every connection has an idle timeout (default 10 s, Bun's default); `ctx.timeout(req, s)` changes it per request
 *     (the long-poll, captures, MCP calls), and it returns to the default after the response;
 *   - `req.signal` aborts when the client goes away (the long-poll stops holding);
 *   - only the handler's headers (plus Date and the connection headers Node adds); no CORS, no X-Powered-By.
 */
export async function serve(options: ServeOptions): Promise<Served> {
	const bun = (globalThis as unknown as { Bun?: BunServeApi }).Bun;
	// `TT_TEST_HTTP_BACKEND=node bun test` runs the whole suite against the node:http adapter (tests only).
	const forced = process.env.NODE_ENV === "test" ? process.env.TT_TEST_HTTP_BACKEND : undefined;
	const backend = options.backend ?? (forced === "node" || forced === "bun" ? forced : bun ? "bun" : "node");
	if (backend === "bun") {
		if (!bun) throw new Error("Bun.serve needs Bun");
		const server = bun.serve({
			hostname: options.hostname,
			port: options.port,
			development: false,
			maxRequestBodySize: options.maxRequestBodySize,
			idleTimeout: options.idleTimeoutSeconds ?? 10,
			fetch: (req, srv) => options.fetch(req, { timeout: (r, seconds) => srv.timeout(r, seconds) }),
			error: options.error,
		});
		return {
			port: server.port,
			backend,
			async stop() {
				await server.stop(true);
			},
		};
	}
	return serveNode(options);
}

async function serveNode(options: ServeOptions): Promise<Served> {
	const idleMs = (options.idleTimeoutSeconds ?? 10) * 1000;
	const max = options.maxRequestBodySize;
	const sockets = new WeakMap<Request, Socket>();
	let port = 0;
	const server = createServer({
		// Bun closes on idleness only; Node also bounds the time to receive the headers and the whole request.
		headersTimeout: Math.max(20_000, idleMs),
		requestTimeout: 120_000,
		keepAliveTimeout: idleMs,
		connectionsCheckingInterval: 2_000,
	});
	server.on("connection", (socket: Socket) => {
		socket.setTimeout(idleMs);
		socket.on("timeout", () => socket.destroy());
	});
	server.on("request", (req: IncomingMessage, res: ServerResponse) => void handle(req, res));
	server.on("error", (error: Error) => options.error(error));

	async function send(req: IncomingMessage, res: ServerResponse, response: Response): Promise<void> {
		const body = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
		if (res.headersSent || res.destroyed) return;
		const headers: Record<string, string | string[]> = {};
		response.headers.forEach((value, name) => {
			if (name !== "set-cookie") headers[name] = value;
		});
		const cookies = response.headers.getSetCookie?.() ?? [];
		if (cookies.length) headers["set-cookie"] = cookies;
		const noBody = response.status === 204 || response.status === 304 || req.method === "HEAD";
		if (!noBody) headers["content-length"] = String(body.length);
		res.writeHead(response.status, headers);
		res.end(noBody ? undefined : body);
	}

	/** Answers with `status` and closes the connection (the rest of the body is read for at most a second, then cut). */
	async function refuse(req: IncomingMessage, res: ServerResponse, status: number): Promise<void> {
		res.shouldKeepAlive = false;
		res.once("finish", () => setTimeout(() => req.socket.destroy(), 1000).unref());
		await send(req, res, options.reject(status));
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const socket = req.socket;
		socket.setTimeout(idleMs);
		res.on("finish", () => {
			if (!socket.destroyed) socket.setTimeout(idleMs);
		});
		const abort = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) abort.abort();
		});

		// A declared body over the cap is refused before the handler runs.
		const declared = req.headers["content-length"];
		if (declared !== undefined && (!/^\d{1,15}$/.test(declared) || Number(declared) > max)) {
			req.resume();
			await refuse(req, res, 413);
			return;
		}
		// Otherwise the body streams to the handler with a running count; past the cap it is cut off (413). What the
		// handler leaves unread is drained, still counted, so the connection can be reused.
		const bodyExpected = (declared !== undefined && declared !== "0") || req.headers["transfer-encoding"] !== undefined;
		let received = 0;
		let draining = false;
		let tooLarge = false;
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		if (bodyExpected) {
			req.pause();
			req.on("data", (chunk: Buffer) => {
				received += chunk.length;
				if (received > max) {
					if (tooLarge) return;
					tooLarge = true;
					controller?.error(new Error("request body too large"));
					if (res.headersSent) socket.destroy();
					else void refuse(req, res, 413);
					return;
				}
				if (draining || tooLarge || !controller) return;
				controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
				if ((controller.desiredSize ?? 1) <= 0) req.pause();
			});
			req.on("end", () => {
				if (!draining && !tooLarge) controller?.close();
			});
			req.on("error", (error) => {
				if (!draining && !tooLarge) controller?.error(error);
			});
			res.on("finish", () => {
				if (!req.complete) {
					draining = true;
					req.resume();
				}
			});
		}
		const withBody = bodyExpected && req.method !== "GET" && req.method !== "HEAD";
		const body = withBody
			? new ReadableStream<Uint8Array>(
					{
						start(c) {
							controller = c;
						},
						pull() {
							req.resume();
						},
						cancel() {
							draining = true;
							req.resume();
						},
					},
					{ highWaterMark: 64 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
				)
			: undefined;
		if (bodyExpected && !withBody) {
			draining = true;
			req.resume();
		}

		const target = req.url ?? "";
		if (!target.startsWith("/")) {
			await refuse(req, res, 404);
			return;
		}
		let request: Request;
		try {
			const headers = new Headers();
			for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
			request = new Request(`http://${options.hostname}:${port}${target}`, {
				method: req.method,
				headers,
				body,
				signal: abort.signal,
				// Node's fetch needs this for a streamed body.
				...({ duplex: "half" } as Record<string, unknown>),
			});
		} catch {
			await refuse(req, res, 400);
			return;
		}
		sockets.set(request, socket);
		let response: Response;
		try {
			response = await options.fetch(request, {
				timeout: (r, seconds) => {
					const s = sockets.get(r);
					if (s && !s.destroyed) s.setTimeout(Math.max(0, seconds) * 1000);
				},
			});
		} catch (error) {
			response = options.error(error instanceof Error ? error : new Error(String(error)));
		}
		if (tooLarge) return;
		await send(req, res, response).catch(() => socket.destroy());
	}

	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(options.port, options.hostname, () => {
			server.off("error", fail);
			done();
		});
	});
	port = (server.address() as AddressInfo).port;
	return {
		port,
		backend: "node",
		stop() {
			return new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			});
		},
	};
}
