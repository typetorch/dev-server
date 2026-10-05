/**
 * Live and code modes, and deploy approval, with the real runner driving test/fake-claude.ts in a throwaway git repo and
 * test-fixture/fake-cli.ts standing in for `typetorch deploy`:
 *   - live runs get Read/Glob/Grep and every game tool, never change files, commit or deploy;
 *   - code runs get the file tools and exactly `bun run build`; a run that changed files is committed and proposed,
 *     never deployed until the requesting dev says so; discard and expiry reset the worktree to the commit before;
 *   - the one allowed shell command resolves on Claude's PATH.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { childEnv } from "../src/env";
import { ensureWorktree, type Worktree } from "../src/git";
import { silentLogger } from "../src/log";
import type { PromptEvent, PromptView, Runner } from "../src/prompts";
import { ALLOWED_COMMANDS, createClaudeRunner, systemPrompt } from "../src/runner";
import { createRemoteClaudeServer, type RemoteClaudeServer } from "../src/server";

const JOB = "6f1c2b9e-3d4a-4b8c-9e7f-0a1b2c3d4e5f";
const BRANCH = "dev";
const USERS = [9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008];
const FAKE = [process.execPath, join(import.meta.dir, "fake-claude.ts")];
const FAKE_CLI = resolve(import.meta.dir, "..", "test-fixture", "fake-cli.ts");

let dir: string;
let worktree: Worktree;
let out: string;
let server: RemoteClaudeServer;
const runs = () => readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; stdin: string });
const head = () => Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktree.path, stdout: "pipe" }).stdout.toString().trim();

async function pair(userId: number): Promise<string> {
	const res = await fetch(`${server.localUrl}/v1/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant: "code", sid: server.auth.sessionId, user: userId, job: JOB, branch: BRANCH, code: server.pairing.formatted }),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { access_token: string }).access_token;
}

let nonce = 0;
function post(jwt: string, path: string, body: unknown) {
	return fetch(`${server.localUrl}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${jwt}`,
			"content-type": "application/json",
			"x-tt-job": JOB,
			"x-tt-nonce": `m-${++nonce}-${crypto.randomUUID()}`,
			"x-tt-timestamp": String(Math.floor(Date.now() / 1000)),
		},
		body: JSON.stringify(body),
	});
}

async function view(jwt: string, id: string): Promise<PromptView & { events: PromptEvent[] }> {
	const res = await fetch(`${server.localUrl}/v1/prompts/${id}?since=0`, { headers: { authorization: `Bearer ${jwt}`, "x-tt-job": JOB } });
	return (await res.json()) as PromptView & { events: PromptEvent[] };
}

async function waitFor(jwt: string, id: string, done: (v: PromptView) => boolean, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const current = await view(jwt, id);
		if (done(current)) return current;
		await Bun.sleep(40);
	}
	throw new Error(`prompt ${id} never reached the expected state`);
}

async function send(jwt: string, prompt: string, mode?: "live" | "code"): Promise<string> {
	const res = await post(jwt, "/v1/prompts", { prompt, mode });
	expect(res.status).toBe(200);
	return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "tt-rc-modes-"));
	const repo = join(dir, "game");
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	git("init", "-q", "-b", "main");
	git("config", "user.name", "t");
	git("config", "user.email", "t@t");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	git("checkout", "-q", "-b", "dev");
	worktree = await ensureWorktree(repo, "dev");
	out = join(dir, "runs.jsonl");
	writeFileSync(out, "");
	process.env.TT_FAKE_OUT = out;
	const runner: Runner = createClaudeRunner({
		worktree,
		ttBranch: BRANCH,
		deploy: true,
		cli: { cmd: [process.execPath, FAKE_CLI], label: "fake-cli" },
		claudeCommand: FAKE,
		subscriptionVerified: true,
	});
	server = await createRemoteClaudeServer({ branch: BRANCH, users: USERS, runner, logger: silentLogger, attachmentsDir: join(dir, "att"), proposalTtlMs: 1500 });
});

afterAll(async () => {
	await server?.stop();
	delete process.env.TT_FAKE_OUT;
	rmSync(dir, { recursive: true, force: true });
});

describe("modes", () => {
	test("live (the default): read-only tools, the live system prompt; changed files are dropped, never committed", async () => {
		const jwt = await pair(USERS[0]);
		const before = head();
		const id = await send(jwt, "EDIT: jump me");
		const done = await waitFor(jwt, id, (v) => v.finishedAt !== undefined);
		expect(done.mode).toBe("live");
		expect(done.state).toBe("answered");
		expect(done.commit).toBeUndefined();
		expect(head()).toBe(before);
		expect(done.events.some((e) => e.kind === "status" && /live mode never changes files/.test(e.text))).toBe(true);
		const args = runs()[runs().length - 1].args;
		expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
		expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("LIVE mode");
		expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: worktree.path, stdout: "pipe" }).stdout.toString()).toBe("");
	}, 30_000);

	test("the system prompts route live effects to run_luau and code changes to code mode, and forbid hard-coded ids", () => {
		const live = systemPrompt("dev", "dev", "dev", "live");
		const code = systemPrompt("dev", "dev", "dev", "code");
		expect(live).toContain('"jump me"');
		expect(live).toContain("needs Code mode");
		expect(code).toContain("needs Live mode");
		expect(code).toContain("Never hard-code user ids");
		expect(code).toContain("exactly `bun run build`");
		expect(code).not.toContain("typetorch build");
		for (const prompt of [live, code]) expect(prompt).toContain("ask one short question");
	}, 30_000);

	test("the only allowed shell command resolves on Claude's PATH", () => {
		const env = childEnv({ forClaude: true });
		const path = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];
		for (const command of ALLOWED_COMMANDS) {
			const exe = command.split(" ")[0];
			expect(Bun.which(exe, { PATH: path })).toBeTruthy();
		}
	});
});

describe("deploy approval", () => {
	test("code run with changes → committed and proposed, not deployed; only the requester decides; Deploy deploys", async () => {
		const jwt = await pair(USERS[1]);
		const other = await pair(USERS[2]);
		const before = head();
		const id = await send(jwt, "EDIT: double the coin reward", "code");
		const proposed = await waitFor(jwt, id, (v) => v.state === "proposed");
		expect(proposed.finishedAt).toBeUndefined(); // not finished: the chat keeps following it
		expect(proposed.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(head()).toBe(proposed.commit!);
		expect(head()).not.toBe(before);
		const event = proposed.events.find((e) => e.kind === "deploy_proposal")!;
		expect(event.text).toBe("add src/edited.ts");
		expect(event.commit).toBe(proposed.commit!);
		expect(event.files).toEqual([{ path: "src/edited.ts", added: 1, removed: 0 }]);
		expect(proposed.proposal).toMatchObject({ status: "pending", commit: proposed.commit });
		const args = runs()[runs().length - 1].args;
		expect(args[args.indexOf("--tools") + 1]).toBe("Read,Edit,Write,Glob,Grep,Bash");
		// No deploy has run.
		expect(proposed.events.some((e) => e.state === "building" || e.state === "deployed")).toBe(false);
		// Another code prompt waits its turn (423); a live prompt still runs.
		expect((await post(jwt, "/v1/prompts", { prompt: "more", mode: "code" })).status).toBe(423);
		const liveId = await send(other, "what is the reward?");
		await waitFor(other, liveId, (v) => v.finishedAt !== undefined);
		expect(head()).toBe(proposed.commit!); // the live run kept the worktree at the proposal
		// Someone else can't decide; nonsense is refused.
		expect((await post(other, `/v1/prompts/${id}/deploy`, { decision: "deploy" })).status).toBe(403);
		expect((await post(jwt, `/v1/prompts/${id}/deploy`, { decision: "yes" })).status).toBe(400);
		const decided = await post(jwt, `/v1/prompts/${id}/deploy`, { decision: "deploy" });
		expect(decided.status).toBe(200);
		const deployed = await waitFor(jwt, id, (v) => v.finishedAt !== undefined);
		expect(deployed.state).toBe("deployed");
		expect(deployed.artifactId).toBe("dev-1234abc");
		expect(deployed.proposal?.status).toBe("deployed");
		expect((await post(jwt, `/v1/prompts/${id}/deploy`, { decision: "discard" })).status).toBe(409);
	}, 30_000);

	test("Discard resets the worktree to the commit before the run", async () => {
		const jwt = await pair(USERS[3]);
		const before = head();
		const id = await send(jwt, "EDIT: add a shop", "code");
		const proposed = await waitFor(jwt, id, (v) => v.state === "proposed");
		expect(head()).toBe(proposed.commit!);
		expect((await post(jwt, `/v1/prompts/${id}/deploy`, { decision: "discard" })).status).toBe(200);
		const done = await waitFor(jwt, id, (v) => v.finishedAt !== undefined);
		expect(done.state).toBe("discarded");
		expect(head()).toBe(before);
	}, 30_000);

	test("an unanswered proposal expires and counts as discarded", async () => {
		const jwt = await pair(USERS[4]);
		const before = head();
		const id = await send(jwt, "EDIT: add a pet", "code");
		await waitFor(jwt, id, (v) => v.state === "proposed");
		const done = await waitFor(jwt, id, (v) => v.finishedAt !== undefined, 10_000);
		expect(done.state).toBe("discarded");
		expect(done.proposal?.status).toBe("expired");
		expect(done.events.some((e) => e.kind === "status" && /expired/.test(e.text))).toBe(true);
		expect(head()).toBe(before);
	}, 30_000);

	test("Stop on a proposal discards it", async () => {
		const jwt = await pair(USERS[5]);
		const before = head();
		const id = await send(jwt, "EDIT: add a hat", "code");
		await waitFor(jwt, id, (v) => v.state === "proposed");
		const res = await fetch(`${server.localUrl}/v1/prompts/${id}/cancel`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${jwt}`,
				"x-tt-job": JOB,
				"x-tt-nonce": `m-${++nonce}-${crypto.randomUUID()}`,
				"x-tt-timestamp": String(Math.floor(Date.now() / 1000)),
			},
		});
		expect(res.status).toBe(200);
		const done = await waitFor(jwt, id, (v) => v.finishedAt !== undefined);
		expect(done.state).toBe("discarded");
		expect(head()).toBe(before);
	});
});
