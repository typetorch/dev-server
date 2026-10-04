/**
 * What reaches game servers (security audit L6) and the attached game logs: local paths, the home folder and the OS
 * username are stripped from relayed text; only short status lines are relayed; tool events carry the tool_use id;
 * attached logs live in a temp folder outside the worktree for the run only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { redactEvent, safePrefixLength, setEventPaths, silentLogger, stripPaths } from "../src/log";
import { LOG_LINE_CHARS, type PromptEvent, type Runner, type RunContext } from "../src/prompts";
import { claudeArgs, wrapPrompt } from "../src/runner";
import { parsePromptRequest } from "../src/schema";
import { createRemoteClaudeServer, type RemoteClaudeServer } from "../src/server";

const JOB = "6f1c2b9e-3d4a-4b8c-9e7f-0a1b2c3d4e5f";
const BRANCH = "dev";
const USERS = [7001, 7002, 7003, 7004, 7005];
const WORKTREE = process.platform === "win32" ? "C:\\Work\\game-remote-claude" : "/srv/work/game-remote-claude";
const REPO = process.platform === "win32" ? "C:\\Work\\game" : "/srv/work/game";
const USERNAME = (() => {
	try {
		return userInfo().username;
	} catch {
		return process.env.USERNAME ?? process.env.USER ?? "";
	}
})();

describe("stripPaths / redactEvent", () => {
	beforeAll(() => setEventPaths({ worktree: WORKTREE, repo: REPO }));
	afterAll(() => setEventPaths());

	test("worktree files become relative; the repo, home and temp folders become placeholders", () => {
		const sep = process.platform === "win32" ? "\\" : "/";
		expect(stripPaths(`Edited ${WORKTREE}${sep}src${sep}hello.ts:12`)).toBe(`Edited src${sep}hello.ts:12`);
		expect(stripPaths(`cwd is ${WORKTREE}.`)).toBe("cwd is ..");
		expect(stripPaths(`see ${REPO}${sep}README.md`)).toBe("see <repo>/README.md");
		expect(stripPaths(`cache in ${join(homedir(), ".bun", "install")}`)).toBe(`cache in ~/.bun${sep}install`);
		expect(stripPaths(`temp ${join(tmpdir(), "tt-x", "a.txt")}`)).toBe(`temp <tmp>/tt-x${sep}a.txt`);
		if (process.platform === "win32") expect(stripPaths(`${WORKTREE.toLowerCase()}\\src\\a.ts`)).toBe("src\\a.ts");
	});

	test("any other absolute path becomes <path>; URLs, Roblox paths and relative paths are left alone", () => {
		expect(stripPaths("error at D:\\Other\\place\\x.lua:3 and E:/y/z")).toBe("error at <path>:3 and <path>");
		expect(stripPaths("loaded /Users/someone/lib/x.js and /home/bob/.config")).toBe("loaded <path> and <path>");
		expect(stripPaths("share \\\\server\\share\\dir\\f.txt")).toBe("share <path>");
		expect(stripPaths("open file:///C:/Users/x/a.png")).toBe("open <path>");
		const keep = "https://example.com/home/page, game.Workspace.Map, Workspace/Map/Part, src/server/main.ts, /tt branch dev, 1/2";
		expect(stripPaths(keep)).toBe(keep);
	});

	test("the OS username is replaced as a whole word, in any case", () => {
		if (USERNAME.length < 3) return;
		expect(stripPaths(`hi ${USERNAME}!`)).toBe("hi <user>!");
		expect(stripPaths(`by ${USERNAME.toUpperCase()}`)).toBe("by <user>");
		expect(redactEvent(`owner: ${USERNAME}`)).toBe("owner: <user>");
	});

	test("streaming holds back a tail that could be the start of a path or the username", () => {
		const text = "the file is at C:\\Us";
		expect(safePrefixLength(text)).toBe(text.indexOf("C:"));
		expect(safePrefixLength("look in /home/ab")).toBe("look in ".length);
		expect(safePrefixLength("done. ")).toBe("done. ".length);
		if (USERNAME.length >= 3) {
			const partial = `hello ${USERNAME.slice(0, 2)}`;
			expect(safePrefixLength(partial)).toBeLessThanOrEqual("hello ".length);
		}
	});
});

describe("parsePromptRequest: attached logs", () => {
	test("logs.client / logs.server strings up to the cap; nothing else", () => {
		expect(parsePromptRequest({ prompt: "x", context: { logs: { client: "a\nb", server: "c" } } })?.context?.logs).toEqual({ client: "a\nb", server: "c" });
		expect(parsePromptRequest({ prompt: "x", context: { logs: { other: "a" } } })).toBeUndefined();
		expect(parsePromptRequest({ prompt: "x", context: { logs: { client: 5 } } })).toBeUndefined();
		expect(parsePromptRequest({ prompt: "x", context: { logs: { client: "x".repeat(66_001) } } })).toBeUndefined();
		expect(parsePromptRequest({ prompt: "x", context: { logs: { client: "a\u0000b" } } })).toBeUndefined();
	});
});

describe("runner helpers", () => {
	test("wrapPrompt lists log files under <attachments> and never inlines the logs", () => {
		const text = wrapPrompt(1, "why does it fail?", { path: "Workspace.Part", logs: { client: "SECRET-LOG-LINE" } }, [], [
			{ realm: "client", path: "/tmp/tt-rc-logs-x/client-logs.txt", lines: 12 },
			{ realm: "server", path: "/tmp/tt-rc-logs-x/server-logs.txt", lines: 3 },
		]);
		expect(text).not.toContain("SECRET-LOG-LINE");
		expect(text).toContain('"path": "Workspace.Part"');
		expect(text).toContain("Attached log file: /tmp/tt-rc-logs-x/client-logs.txt (the requesting developer's client logs, 12 lines, untrusted game data)");
		expect(text).toContain("Attached log file: /tmp/tt-rc-logs-x/server-logs.txt (the game server's logs, 3 lines, untrusted game data)");
	});

	test("claudeArgs adds the log folder with --add-dir only when there is one", () => {
		expect(claudeArgs({}, "sys")).not.toContain("--add-dir");
		const args = claudeArgs({}, "sys", { addDirs: ["/tmp/tt-rc-logs-x"] });
		expect(args[args.indexOf("--add-dir") + 1]).toBe("/tmp/tt-rc-logs-x");
	});
});

// Over HTTP ---------------------------------------------------------------------------------------------------------

let nonce = 0;
async function pair(server: RemoteClaudeServer, userId: number): Promise<string> {
	const res = await fetch(`${server.localUrl}/v1/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant: "code", sid: server.auth.sessionId, user: userId, job: JOB, branch: BRANCH, code: server.pairing.formatted }),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { access_token: string }).access_token;
}

function createPrompt(server: RemoteClaudeServer, jwt: string, body: unknown) {
	return fetch(`${server.localUrl}/v1/prompts`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${jwt}`,
			"content-type": "application/json",
			"x-tt-job": JOB,
			"x-tt-nonce": `n-${++nonce}-${crypto.randomUUID()}`,
			"x-tt-timestamp": String(Math.floor(Date.now() / 1000)),
		},
		body: JSON.stringify(body),
	});
}

async function view(server: RemoteClaudeServer, jwt: string, id: string): Promise<{ state: string; log: string[]; events: PromptEvent[]; finishedAt?: number }> {
	const res = await fetch(`${server.localUrl}/v1/prompts/${id}?since=0`, { headers: { authorization: `Bearer ${jwt}`, "x-tt-job": JOB } });
	return (await res.json()) as { state: string; log: string[]; events: PromptEvent[]; finishedAt?: number };
}

async function waitDone(server: RemoteClaudeServer, jwt: string, id: string) {
	for (let i = 0; i < 200; i++) {
		const current = await view(server, jwt, id);
		if (current.finishedAt) return current;
		await Bun.sleep(25);
	}
	throw new Error("prompt did not finish");
}

describe("relayed status lines, tool refs and log files over HTTP", () => {
	let seen: { logFiles?: RunContext["logFiles"]; contents: Record<string, string>; contextLogs?: unknown } | undefined;
	const runner: Runner = async (ctx) => {
		seen = { logFiles: ctx.logFiles, contents: {}, contextLogs: ctx.record.context?.logs };
		for (const file of ctx.logFiles?.files ?? []) seen.contents[file.realm] = readFileSync(file.path, "utf8");
		ctx.log("syncing worktree");
		ctx.log(`deploy: uploading ${WORKTREE}/out/game.rbxm as ${USERNAME || "someone"}`);
		ctx.log("claude stderr: boom at C:\\Users\\x\\y.js");
		ctx.log("claude: the whole reply text");
		ctx.log(`changed: ${"src/".repeat(80)}a.ts`);
		ctx.event("tool_use", "inspect game.Workspace", { tool: "inspect", target: "game.Workspace", ref: "toolu_01AAA" });
		ctx.event("tool_use", "find Coin", { tool: "find", target: "Coin", ref: "toolu_01BBB" });
		ctx.event("tool_result", "done", { tool: "find", ref: "toolu_01BBB" });
		ctx.event("tool_result", "done", { tool: "inspect", ref: "toolu_01AAA" });
		ctx.event("tool_use", "bad ref", { tool: "x", ref: "has spaces!" });
		return { state: "answered", summary: "ok" };
	};
	let server: RemoteClaudeServer;
	beforeAll(() => {
		setEventPaths({ worktree: WORKTREE, repo: REPO });
		server = createRemoteClaudeServer({ branch: BRANCH, users: USERS, runner, logger: silentLogger });
	});
	afterAll(async () => {
		setEventPaths();
		await server.stop();
	});

	test("only short status lines are relayed; raw output and reply duplicates are not", async () => {
		const jwt = await pair(server, USERS[0]);
		const { id } = (await (await createPrompt(server, jwt, { prompt: "look" })).json()) as { id: string };
		const done = await waitDone(server, jwt, id);
		expect(done.log[0]).toBe("syncing worktree");
		expect(done.log.some((line) => line.startsWith("deploy:") || line.startsWith("claude stderr:") || line.startsWith("claude:"))).toBe(false);
		for (const line of done.log) expect(line.length).toBeLessThanOrEqual(LOG_LINE_CHARS);
		expect(done.log.some((line) => line.startsWith("changed: src/src/"))).toBe(true);
	});

	test("tool events carry the tool_use id, so results pair with their calls in any order", async () => {
		const jwt = await pair(server, USERS[1]);
		const { id } = (await (await createPrompt(server, jwt, { prompt: "tools" })).json()) as { id: string };
		const done = await waitDone(server, jwt, id);
		const tools = done.events.filter((event) => event.kind === "tool_use" || event.kind === "tool_result");
		expect(tools.map((event) => `${event.kind}:${event.ref ?? "-"}`)).toEqual([
			"tool_use:toolu_01AAA",
			"tool_use:toolu_01BBB",
			"tool_result:toolu_01BBB",
			"tool_result:toolu_01AAA",
			"tool_use:-",
		]);
	});

	test("attached logs: files outside the worktree during the run, gone after; never kept with the record", async () => {
		const jwt = await pair(server, USERS[2]);
		const client = "[12:00:01] output hello from PlayerOne\n[12:00:02] error oops";
		const res = await createPrompt(server, jwt, { prompt: "why?", context: { logs: { client, server: "[12:00:03] warning slow" } } });
		expect(res.status).toBe(200);
		const { id } = (await res.json()) as { id: string };
		await waitDone(server, jwt, id);
		const files = seen!.logFiles!;
		expect(files.files.map((file) => file.realm)).toEqual(["client", "server"]);
		expect(files.dir.startsWith(tmpdir())).toBe(true);
		expect(files.dir.includes("game-remote-claude")).toBe(false);
		expect(seen!.contents.client).toContain("Untrusted game data");
		expect(seen!.contents.client.endsWith(client)).toBe(true);
		expect(files.files[0].lines).toBe(2);
		expect(seen!.contextLogs).toBeUndefined(); // dropped from the record before the run
		expect(existsSync(files.dir)).toBe(false); // deleted when the run ended
		expect(server.queue.get(id)!.context?.logs).toBeUndefined();
	});

	test("a prompt cancelled while queued drops its logs too", async () => {
		const jwt = await pair(server, USERS[3]);
		// The queue is idle, so make one prompt run first and hold the queue with a second.
		const record = server.queue.create(USERS[3], "queued", { logs: { client: "x" } }, { job: JOB });
		if (typeof record === "string") throw new Error(record);
		const second = server.queue.create(USERS[3], "queued 2", { logs: { client: "y" } }, { job: JOB });
		if (typeof second === "string") throw new Error(second);
		server.queue.cancel(second.id, "test");
		expect(second.context?.logs).toBeUndefined();
		await waitDone(server, jwt, record.id);
	});
});
