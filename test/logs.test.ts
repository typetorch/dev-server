/**
 * Logs > Upload (POST /v1/logs, src/logs.ts): the body schema, cleaning, file names and headers, and the endpoint: the
 * same JWT/session checks as every game endpoint, the 2 MB cap, the rate limit, one terminal line, and no prompt quota.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type Logger } from "../src/log";
import { cleanLogText, fileTime, formatLogFile, LOG_UPLOAD_LIMITS, logFileName, LogStore, parseLogUpload } from "../src/logs";
import type { Runner } from "../src/prompts";
import { createRemoteClaudeServer, type RemoteClaudeServer } from "../src/server";

const JOB = "6f1c2b9e-3d4a-4b8c-9e7f-0a1b2c3d4e5f";
const BRANCH = "dev";
const USERS = Array.from({ length: 20 }, (_, i) => 7000 + i);
let nextUser = 0;
const user = () => USERS[nextUser++];

const upload = (extra: Record<string, unknown> = {}) => ({
	kind: "server",
	uploader: "Builderman",
	artifact: "dev-abc1234#3",
	kernel: "0.3.5",
	framework: "0.3.2",
	time: 1_790_000_000,
	text: "[12:00:01] output hello\n[12:00:02] warning careful\n",
	...extra,
});

describe("logs.ts", () => {
	test("schema: the fields, nothing else", () => {
		expect(parseLogUpload(upload())).toMatchObject({ kind: "server", uploader: "Builderman", kernel: "0.3.5" });
		expect(parseLogUpload(upload({ kind: "player", player: "Alice_1" }))?.player).toBe("Alice_1");
		expect(parseLogUpload(upload({ kind: "player" }))).toBeUndefined(); // whose logs?
		expect(parseLogUpload(upload({ player: "Alice" }))).toBeUndefined(); // only for kind player
		expect(parseLogUpload(upload({ kind: "everything" }))).toBeUndefined();
		expect(parseLogUpload(upload({ uploader: "bad name" }))).toBeUndefined();
		expect(parseLogUpload(upload({ uploader: "\u001b[2Jx" }))).toBeUndefined();
		expect(parseLogUpload(upload({ artifact: "../../x" }))).toBeUndefined();
		expect(parseLogUpload(upload({ kernel: "0.3.5; rm -rf" }))).toBeUndefined();
		expect(parseLogUpload(upload({ time: -1 }))).toBeUndefined();
		expect(parseLogUpload(upload({ text: 5 }))).toBeUndefined();
		expect(parseLogUpload(upload({ extra: true }))).toBeUndefined();
		expect(parseLogUpload([upload()])).toBeUndefined();
		const { artifact: _a, kernel: _k, framework: _f, time: _t, ...minimal } = upload();
		expect(parseLogUpload(minimal)).toEqual({ kind: "server", uploader: "Builderman", text: minimal.text });
	});

	test("cleaning: no control characters or terminal escapes, tabs and lines kept", () => {
		expect(cleanLogText("a\r\nb\rc\td\u0000e\u001b[31mred\u001b[0m\u009b‮x\u0007")).toBe("a\nb\nc\tde[31mred[0mx");
	});

	test("file names: UTC time, branch, job8, kind; safe characters only", () => {
		const date = new Date(Date.UTC(2026, 9, 6, 12, 15, 30, 123));
		expect(fileTime(date)).toBe("2026-10-06T12-15-30Z");
		expect(logFileName(date, "dev", JOB, "server")).toBe("2026-10-06T12-15-30Z-dev-6f1c2b9e-server.log");
		expect(logFileName(date, "feature/new map", "", "client")).toBe("2026-10-06T12-15-30Z-feature-new-map-studio-client.log");
		expect(logFileName(date, "../..", "../../x", "player")).toBe("2026-10-06T12-15-30Z-branch-x-player.log");
	});

	test("file: header from the checked fields, then the text", () => {
		const parsed = parseLogUpload(upload({ kind: "player", player: "Alice" }))!;
		const { content, lines } = formatLogFile(parsed, { userId: 42, branch: "dev", job: JOB, savedAt: new Date(Date.UTC(2026, 9, 6, 12, 0, 0)) });
		expect(lines).toBe(2);
		expect(content).toBe(
			[
				"# TypeTorch logs: player (player Alice)",
				"# uploaded by: Builderman (roblox:42)",
				"# artifact: dev-abc1234#3",
				"# branch: dev",
				`# job: ${JOB}`,
				"# kernel: 0.3.5  framework: 0.3.2",
				"# time: 2026-09-21T14:13:20.000Z (game server), saved 2026-10-06T12:00:00.000Z",
				"# lines: 2",
				"",
				"[12:00:01] output hello",
				"[12:00:02] warning careful",
				"",
			].join("\n"),
		);
	});

	test("store: one file per upload, never overwritten, a session cap", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-logs-"));
		try {
			const fixed = new Date(Date.UTC(2026, 9, 6, 12, 0, 0));
			const store = new LogStore(join(dir, "nested", "logs"), () => fixed);
			const parsed = parseLogUpload(upload())!;
			const first = store.save(parsed, { userId: 1, branch: "dev", job: JOB });
			const second = store.save(parsed, { userId: 1, branch: "dev", job: JOB });
			if (first === "quota" || second === "quota") throw new Error("quota");
			expect(first.name).toBe("2026-10-06T12-00-00Z-dev-6f1c2b9e-server.log");
			expect(second.name).toBe("2026-10-06T12-00-00Z-dev-6f1c2b9e-server-2.log");
			expect(readdirSync(join(dir, "nested", "logs")).sort()).toEqual([first.name, second.name].sort());
			for (let i = 2; i < LOG_UPLOAD_LIMITS.perSession; i++) store.save(parsed, { userId: 1, branch: "dev", job: String(i) });
			expect(store.save(parsed, { userId: 1, branch: "dev", job: JOB })).toBe("quota");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("POST /v1/logs", () => {
	let srv: RemoteClaudeServer;
	let dir: string;
	const lines: string[] = [];
	const logger: Logger = { ...silentLogger, info: (message) => lines.push(message), warn: (message) => lines.push(`warn: ${message}`) };
	const stub: Runner = async () => ({ state: "answered", summary: "ok" });

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "tt-logs-srv-"));
		// maxPrompts 1: uploads must not use any of it.
		srv = await createRemoteClaudeServer({ branch: BRANCH, users: USERS, runner: stub, logger, maxPrompts: 1, logsDir: join(dir, ".typetorch", "logs") });
	});
	afterAll(async () => {
		await srv?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	async function pair(userId: number, job = JOB): Promise<string> {
		const res = await fetch(`${srv.localUrl}/v1/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ grant: "code", sid: srv.auth.sessionId, user: userId, job, branch: BRANCH, code: srv.pairing.formatted }),
		});
		expect(res.status).toBe(200);
		return ((await res.json()) as { access_token: string }).access_token;
	}
	let nonce = 0;
	const send = (jwt: string | undefined, body: unknown, extra: Record<string, string> = {}, server = srv) => {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"x-tt-job": JOB,
			"x-tt-nonce": `logs-${++nonce}-${crypto.randomUUID()}`,
			"x-tt-timestamp": String(Math.floor(Date.now() / 1000)),
			...extra,
		};
		if (jwt) headers.authorization = `Bearer ${jwt}`;
		return fetch(`${server.localUrl}/v1/logs`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
	};

	test("saves the file and prints one line; the game gets the name, not the path", async () => {
		const jwt = await pair(user());
		const before = lines.length;
		const res = await send(jwt, upload({ kind: "player", player: "Alice" }));
		expect(res.status).toBe(200);
		const reply = (await res.json()) as { ok: boolean; file: string; lines: number };
		expect(reply.ok).toBe(true);
		expect(reply.lines).toBe(2);
		expect(reply.file).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-dev-6f1c2b9e-player\.log$/);
		expect(JSON.stringify(reply)).not.toContain(dir.replace(/\\/g, "\\\\"));
		const path = join(dir, ".typetorch", "logs", reply.file);
		expect(existsSync(path)).toBe(true);
		const content = readFileSync(path, "utf8");
		expect(content).toContain("# TypeTorch logs: player (player Alice)");
		expect(content).toContain(`# job: ${JOB}`);
		expect(content.endsWith("[12:00:02] warning careful\n")).toBe(true);
		const printed = lines.slice(before);
		expect(printed).toEqual([`logs from Builderman (player Alice, 2 lines) saved: ${path}`]);
		// No prompt was created: the one allowed prompt is still there.
		const prompt = await send(jwt, {}, {}, srv);
		expect(prompt.status).toBe(400); // (schema, not quota) on /v1/logs; now a real prompt:
		const created = await fetch(`${srv.localUrl}/v1/prompts`, {
			method: "POST",
			headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", "x-tt-job": JOB, "x-tt-nonce": `p-${crypto.randomUUID()}`, "x-tt-timestamp": String(Math.floor(Date.now() / 1000)) },
			body: JSON.stringify({ prompt: "hello" }),
		});
		expect(created.status).toBe(200);
	});

	test("auth: no token, another job, no nonce, a replayed nonce", async () => {
		const jwt = await pair(user());
		expect((await send(undefined, upload())).status).toBe(401);
		expect((await send(jwt, upload(), { "x-tt-job": "another-job" })).status).toBe(403);
		const noNonce = await fetch(`${srv.localUrl}/v1/logs`, {
			method: "POST",
			headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", "x-tt-job": JOB, "x-tt-timestamp": String(Math.floor(Date.now() / 1000)) },
			body: JSON.stringify(upload()),
		});
		expect(noNonce.status).toBe(400);
		const fixed = { "x-tt-nonce": `fixed-${crypto.randomUUID()}` };
		expect((await send(jwt, upload(), fixed)).status).toBe(200);
		expect((await send(jwt, upload(), fixed)).status).toBe(409);
	});

	test("caps: content type, schema, 2 MB", async () => {
		const jwt = await pair(user());
		expect((await send(jwt, upload(), { "content-type": "text/plain" })).status).toBe(400);
		expect((await send(jwt, upload({ kind: "nope" }))).status).toBe(400);
		expect((await send(jwt, "{not json")).status).toBe(400);
		const near = await send(jwt, upload({ text: `${"x".repeat(100)}\n`.repeat(19_000) }));
		expect(near.status).toBe(200);
		expect(((await near.json()) as { lines: number }).lines).toBe(19_000);
		const over = await send(jwt, upload({ text: "x".repeat(LOG_UPLOAD_LIMITS.bodyBytes) }));
		expect(over.status).toBe(413);
	});

	test("rate limit: per user per minute", async () => {
		const jwt = await pair(user());
		for (let i = 0; i < LOG_UPLOAD_LIMITS.perMinute; i++) expect((await send(jwt, upload())).status).toBe(200);
		expect((await send(jwt, upload())).status).toBe(429);
		// Another user isn't affected.
		expect((await send(await pair(user()), upload())).status).toBe(200);
	});

	test("without a logs folder: 503", async () => {
		const other = await createRemoteClaudeServer({ branch: BRANCH, users: USERS, runner: stub, logger: silentLogger });
		try {
			const res = await fetch(`${other.localUrl}/v1/token`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ grant: "code", sid: other.auth.sessionId, user: USERS[0], job: JOB, branch: BRANCH, code: other.pairing.formatted }),
			});
			const jwt = ((await res.json()) as { access_token: string }).access_token;
			expect((await send(jwt, upload(), {}, other)).status).toBe(503);
		} finally {
			await other.stop();
		}
	});
});
