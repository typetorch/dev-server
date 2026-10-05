/**
 * The Toolbox gate end to end on 127.0.0.1 (plans/14): a prompt without the chip gets no Creator Store tools (not in
 * the run's allow rules, denied, not listed, refused per call); with the chip, search runs on this PC (fake fetch),
 * the chat gets a toolbox_results event, and toolbox_insert becomes a game request carrying the dev-server's snapshot.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../src/log";
import type { Runner } from "../src/prompts";
import { claudeArgs, isProtectedPath, systemPrompt } from "../src/runner";
import { parsePromptRequest } from "../src/schema";
import { createRemoteClaudeServer, type RemoteClaudeServer } from "../src/server";
import { ToolboxClient } from "../src/toolbox";
import { TOOLBOX_NOT_SELECTED } from "../src/toolbox-tools";

const JOB = "6f1c2b9e-3d4a-4b8c-9e7f-0a1b2c3d4e5f";
const USERS = [8101, 8102, 8103, 8104];
const TREE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "toolbox", "v2-search-model-tree.json"), "utf8"));

const seen = new Map<string, unknown[]>();
let searches = 0;

async function mcp(url: string, token: string, body: unknown) {
	return fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

/** A runner that lists the tools and calls the ones named in the prompt (JSON), like game-tools.test.ts. */
const runner: Runner = async (ctx) => {
	const replies: unknown[] = [];
	seen.set(ctx.record.id, replies);
	if (!ctx.mcp) return { state: "failed", error: "no mcp" };
	const { url, token } = ctx.mcp;
	replies.push(await (await mcp(url, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json());
	let id = 2;
	for (const call of JSON.parse(ctx.record.prompt) as unknown[]) replies.push(await (await mcp(url, token, { jsonrpc: "2.0", id: id++, method: "tools/call", params: call })).json());
	return { state: "answered", summary: "done" };
};

let srv: RemoteClaudeServer;
let dir: string;
let nonce = 0;
const postHeaders = (jwt: string) => ({
	authorization: `Bearer ${jwt}`,
	"content-type": "application/json",
	"x-tt-job": JOB,
	"x-tt-nonce": `t-${++nonce}-${crypto.randomUUID()}`,
	"x-tt-timestamp": String(Math.floor(Date.now() / 1000)),
});
const get = (jwt: string, path: string) => fetch(`${srv.localUrl}${path}`, { headers: { authorization: `Bearer ${jwt}`, "x-tt-job": JOB } });

async function pair(userId: number): Promise<string> {
	const res = await fetch(`${srv.localUrl}/v1/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant: "code", sid: srv.auth.sessionId, user: userId, job: JOB, branch: "dev", code: srv.pairing.formatted }),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { access_token: string }).access_token;
}

async function send(jwt: string, calls: unknown[], extra: Record<string, unknown> = {}): Promise<{ id: string; conversationId: string }> {
	const res = await fetch(`${srv.localUrl}/v1/prompts`, { method: "POST", headers: postHeaders(jwt), body: JSON.stringify({ prompt: JSON.stringify(calls), ...extra }) });
	expect(res.status).toBe(200);
	return (await res.json()) as { id: string; conversationId: string };
}

async function waitDone(jwt: string, id: string) {
	for (let i = 0; i < 400; i++) {
		const view = (await (await get(jwt, `/v1/prompts/${id}?since=0`)).json()) as { finishedAt?: number; events: { kind: string; tiles?: unknown[] }[] };
		if (view.finishedAt) return view;
		await Bun.sleep(25);
	}
	throw new Error("not finished");
}

/** Answers game requests until `count` were handled. */
async function fakeGame(jwt: string, answer: (request: { tool: string; args: Record<string, unknown> }) => unknown, count = 1) {
	const handled: { id: string; tool: string; args: Record<string, unknown>; promptId: string; conversationId?: string }[] = [];
	for (let i = 0; i < 200 && handled.length < count; i++) {
		const pending = (await (await get(jwt, "/v1/game/pending")).json()) as { requests: { id: string }[] };
		for (const { id } of pending.requests) {
			const request = (await (await get(jwt, `/v1/game/requests/${id}`)).json()) as (typeof handled)[number];
			handled.push(request);
			await fetch(`${srv.localUrl}/v1/game/requests/${id}/result`, { method: "POST", headers: postHeaders(jwt), body: JSON.stringify(answer(request)) });
		}
		await Bun.sleep(20);
	}
	return handled;
}

const tools = (reply: unknown) => (reply as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
const callResult = (reply: unknown) => (reply as { result: { content: { text: string }[]; isError: boolean } }).result;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "tt-toolbox-gate-"));
	srv = await createRemoteClaudeServer({
		branch: "dev",
		users: USERS,
		runner,
		logger: silentLogger,
		attachmentsDir: join(dir, "a"),
		worktree: dir,
		toolboxClient: new ToolboxClient({
			fetch: async () => {
				searches += 1;
				return new Response(JSON.stringify(TREE), { status: 200, headers: { "content-type": "application/json" } });
			},
			sleep: async () => {},
			minIntervalMs: 0,
		}),
		gameWaitMs: (ms) => Math.min(ms, 3000),
	});
});

afterAll(async () => {
	await srv?.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("the Toolbox chip gates the Creator Store tools", () => {
	test("schema: toolbox must be a boolean", () => {
		expect(parsePromptRequest({ prompt: "x", toolbox: true })?.toolbox).toBe(true);
		expect(parsePromptRequest({ prompt: "x", toolbox: false })?.toolbox).toBeUndefined();
		expect(parsePromptRequest({ prompt: "x", toolbox: "yes" })).toBeUndefined();
	});

	test("run args: allowed only with the chip; denied otherwise; system prompt says so", () => {
		const opts = { model: undefined, maxBudgetUsd: undefined, protect: undefined };
		const rules = (args: string[], flag: string) => args[args.indexOf(flag) + 1].split(",");
		const off = claudeArgs(opts, "s", { mode: "live", mcpConfigFile: "m.json" });
		expect(rules(off, "--allowedTools").some((r) => r.includes("toolbox_"))).toBe(false);
		expect(rules(off, "--disallowedTools")).toEqual(expect.arrayContaining(["mcp__typetorch-game__toolbox_search", "mcp__typetorch-game__toolbox_insert", "mcp__typetorch-game__toolbox_add"]));
		const live = claudeArgs(opts, "s", { mode: "live", toolbox: true, mcpConfigFile: "m.json" });
		expect(rules(live, "--allowedTools")).toEqual(expect.arrayContaining(["mcp__typetorch-game__toolbox_search", "mcp__typetorch-game__toolbox_insert"]));
		expect(rules(live, "--disallowedTools")).toContain("mcp__typetorch-game__toolbox_add");
		const code = claudeArgs(opts, "s", { mode: "code", toolbox: true, mcpConfigFile: "m.json" });
		expect(rules(code, "--allowedTools")).toContain("mcp__typetorch-game__toolbox_add");
		expect(rules(code, "--disallowedTools")).toContain("mcp__typetorch-game__toolbox_insert");
		expect(systemPrompt("dev", "dev", "dev", "live", false)).toContain("Creator Store tools are off for this message");
		expect(systemPrompt("dev", "dev", "dev", "live", true)).toContain("toolbox_insert puts one asset");
		expect(isProtectedPath("toolbox.lock.toml")).toBe(true);
	});

	test("without the chip: not listed, every call refused, nothing searched", async () => {
		const jwt = await pair(USERS[0]);
		const before = searches;
		const { id } = await send(jwt, [
			{ name: "toolbox_search", arguments: { query: "tree" } },
			{ name: "toolbox_insert", arguments: { id: 580221169 } },
		]);
		await waitDone(jwt, id);
		const replies = seen.get(id)!;
		expect(tools(replies[0]).some((name) => name.startsWith("toolbox_"))).toBe(false);
		expect(callResult(replies[1])).toEqual({ content: [{ type: "text", text: TOOLBOX_NOT_SELECTED }], isError: true } as never);
		expect(callResult(replies[2]).content[0].text).toBe(TOOLBOX_NOT_SELECTED);
		expect(searches).toBe(before);
		expect(srv.gameRequests.countFor(id)).toBe(0);
	});

	test("with the chip (live): search, cards event, insert as a game request with the snapshot", async () => {
		const jwt = await pair(USERS[1]);
		const first = await send(jwt, [{ name: "toolbox_search", arguments: { query: "tree", limit: 3 } }], { toolbox: true });
		const view = await waitDone(jwt, first.id);
		const replies = seen.get(first.id)!;
		expect(tools(replies[0])).toEqual(expect.arrayContaining(["toolbox_search", "toolbox_insert"]));
		expect(tools(replies[0])).not.toContain("toolbox_add");
		expect(callResult(replies[1]).content[0].text).toContain("<untrusted-toolbox-data");
		const cards = view.events.find((event) => event.kind === "toolbox_results");
		expect(cards?.tiles).toHaveLength(3);

		// A follow-up in the same conversation needs the chip again; with it, the insert goes to the game.
		const noChip = await send(jwt, [{ name: "toolbox_insert", arguments: { id: 580221169 } }], { conversationId: first.conversationId });
		await waitDone(jwt, noChip.id);
		expect(callResult(seen.get(noChip.id)![1]).content[0].text).toBe(TOOLBOX_NOT_SELECTED);

		const second = await send(jwt, [{ name: "toolbox_insert", arguments: { id: 580221169, reason: "lobby" } }], { conversationId: first.conversationId, toolbox: true });
		const handled = await fakeGame(jwt, () => ({ ok: true, data: '{"path":"Workspace.TypeTorchToolbox.Tree"}', ms: 700 }));
		await waitDone(jwt, second.id);
		expect(handled).toHaveLength(1);
		expect(handled[0]).toMatchObject({ tool: "toolbox_insert", promptId: second.id, conversationId: first.conversationId });
		expect(handled[0].args).toMatchObject({ id: 580221169, type: "Model", place: "front", anchor: true, reason: "lobby", asset: { name: "Tree", creator: { name: "SheriffTaco", verified: true } } });
		const inserted = callResult(seen.get(second.id)![1]);
		expect(inserted.isError).toBe(false);
		expect(inserted.content[0].text).toContain("inserted (700 ms)");
	});

	test("code mode with the chip: search and add, never insert", async () => {
		const jwt = await pair(USERS[2]);
		const { id } = await send(jwt, [{ name: "toolbox_search", arguments: { query: "tree" } }, { name: "toolbox_insert", arguments: { id: 580221169 } }], { toolbox: true, mode: "code" });
		await waitDone(jwt, id);
		const replies = seen.get(id)!;
		expect(tools(replies[0])).toEqual(expect.arrayContaining(["toolbox_search", "toolbox_add"]));
		expect(tools(replies[0])).not.toContain("toolbox_insert");
		expect(callResult(replies[2]).content[0].text).toContain("only available in Live mode");
		expect(srv.gameRequests.countFor(id)).toBe(0);
	});
});
