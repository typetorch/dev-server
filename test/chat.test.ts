/**
 * Chat features of the remote-claude server: conversations (resume), incremental events, the `answered` state, image
 * attachments, and the subscription-only rule. Claude is either a scripted stub runner or test/fake-claude.ts driven
 * through the real runner in a throwaway git repo.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { ATTACHMENT_LIMITS, decodeAttachment, zstdContentSize } from "../src/attachments";
import { assessAuthStatus, checkSubscriptionAuth, judgeInitEvent, SubscriptionRequiredError } from "../src/billing";
import { childEnv, isApiBillingVar } from "../src/env";
import { ensureIgnored, ensureWorktree } from "../src/git";
import { addEventSecret, redactEvent, safePrefixLength, silentLogger } from "../src/log";
import { crc32, encodePng, PNG_SIGNATURE } from "../src/png";
import type { PromptEvent, Runner } from "../src/prompts";
import { createClaudeRunner, deployedArtifactId, lastArtifactId, summarizeToolResult, wrapPrompt } from "../src/runner";
import { createRemoteClaudeServer, type RemoteClaudeServer } from "../src/server";
import { startRemoteClaude } from "../src/session";

const JOB = "6f1c2b9e-3d4a-4b8c-9e7f-0a1b2c3d4e5f";
const BRANCH = "dev";
const USERS = Array.from({ length: 40 }, (_, i) => 5000 + i);
let nextUser = 0;
const user = () => USERS[nextUser++];
const FAKE = [process.execPath, join(import.meta.dir, "fake-claude.ts")];

// HTTP helpers ------------------------------------------------------------------------------------------------------

async function pair(server: RemoteClaudeServer, userId: number): Promise<string> {
	const res = await fetch(`${server.localUrl}/v1/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant: "code", sid: server.auth.sessionId, user: userId, job: JOB, branch: BRANCH, code: server.pairing.formatted }),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { access_token: string }).access_token;
}

let nonce = 0;
function post(server: RemoteClaudeServer, jwt: string, path: string, body: unknown, extra: Record<string, string> = {}) {
	return fetch(`${server.localUrl}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${jwt}`,
			"content-type": "application/json",
			"x-tt-job": JOB,
			"x-tt-nonce": `n-${++nonce}-${crypto.randomUUID()}`,
			"x-tt-timestamp": String(Math.floor(Date.now() / 1000)),
			...extra,
		},
		body: JSON.stringify(body),
	});
}

function get(server: RemoteClaudeServer, jwt: string, path: string) {
	return fetch(`${server.localUrl}${path}`, { headers: { authorization: `Bearer ${jwt}`, "x-tt-job": JOB } });
}

interface View {
	id: string;
	state: string;
	conversationId?: string;
	summary?: string;
	commit?: string;
	error?: string;
	costUsd?: number;
	finishedAt?: number;
	events?: PromptEvent[];
	next?: number;
	more?: boolean;
	attachments?: { id: string; width: number; height: number }[];
}

async function waitDone(server: RemoteClaudeServer, jwt: string, id: string, timeoutMs = 20_000): Promise<View> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const view = (await (await get(server, jwt, `/v1/prompts/${id}`)).json()) as View;
		if (view.finishedAt) return view;
		await Bun.sleep(50);
	}
	throw new Error("prompt did not finish");
}

async function allEvents(server: RemoteClaudeServer, jwt: string, id: string): Promise<PromptEvent[]> {
	const events: PromptEvent[] = [];
	let since = 0;
	for (let page = 0; page < 50; page++) {
		const view = (await (await get(server, jwt, `/v1/prompts/${id}?since=${since}`)).json()) as View;
		events.push(...(view.events ?? []));
		since = view.next!;
		if (!view.more) break;
	}
	return events;
}

const text = (events: PromptEvent[]) => events.filter((e) => e.kind === "assistant_text").map((e) => e.text).join("");

/** A runner whose events are scripted by the prompt text. */
const scripted: Runner = async (ctx) => {
	const prompt = ctx.record.prompt;
	if (prompt.startsWith("hold")) {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 20_000);
			ctx.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()));
		});
		return { state: "answered", summary: "held" };
	}
	if (prompt.startsWith("many")) {
		for (let i = 0; i < 700; i++) ctx.event("tool_use", `Read file${i}.ts`, { tool: "Read", target: `file${i}.ts` });
	}
	ctx.text(1, "Hi ");
	ctx.text(1, "there");
	ctx.setClaudeSession("11111111-2222-4333-8444-555555555555");
	ctx.setCost(0.01234);
	return { state: "answered", summary: "Hi there" };
};

// PNG decoding (test side) ------------------------------------------------------------------------------------------

function decodePng(png: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
	expect([...png.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let pos = 8;
	let width = 0;
	let height = 0;
	const idat: Uint8Array[] = [];
	let first = true;
	while (pos < png.length) {
		const length = view.getUint32(pos);
		const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
		const data = png.subarray(pos + 8, pos + 8 + length);
		expect(view.getUint32(pos + 8 + length)).toBe(crc32(png, pos + 4, pos + 8 + length));
		if (first) {
			expect(type).toBe("IHDR");
			expect(length).toBe(13);
			first = false;
		}
		if (type === "IHDR") {
			width = view.getUint32(pos + 8);
			height = view.getUint32(pos + 12);
			expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0]); // 8-bit RGBA, deflate, adaptive, no interlace
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		pos += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * 4;
	const pixels = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		for (let x = 0; x < stride; x++) {
			const value = raw[y * (stride + 1) + 1 + x];
			const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
			const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
			pixels[y * stride + x] = filter === 0 ? value : filter === 1 ? (value + left) & 0xff : filter === 2 ? (value + up) & 0xff : -1;
		}
	}
	return { width, height, pixels };
}

function testImage(width: number, height: number): Uint8Array {
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			pixels[i] = (x * 255) / Math.max(1, width - 1);
			pixels[i + 1] = (y * 255) / Math.max(1, height - 1);
			pixels[i + 2] = (x ^ y) & 0xff;
			pixels[i + 3] = 255;
		}
	}
	return pixels;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

// Server with a scripted runner ---------------------------------------------------------------------------------------

let srv: RemoteClaudeServer;
let attachmentsDir: string;

beforeAll(() => {
	attachmentsDir = mkdtempSync(join(tmpdir(), "tt-attach-"));
	srv = createRemoteClaudeServer({ branch: BRANCH, users: USERS, runner: scripted, logger: silentLogger, maxPrompts: 500, maxQueued: 50, attachmentsDir: join(attachmentsDir, "a") });
});

afterAll(async () => {
	await srv?.stop();
	rmSync(attachmentsDir, { recursive: true, force: true });
});

describe("conversations", () => {
	test("a prompt without conversationId starts one; a follow-up continues it; both are listed latest first", async () => {
		const u = user();
		const jwt = await pair(srv, u);
		const first = (await (await post(srv, jwt, "/v1/prompts", { prompt: "what is this game?" })).json()) as View;
		expect(first.conversationId).toMatch(/^[A-Za-z0-9_-]{22}$/);
		const done = await waitDone(srv, jwt, first.id);
		expect(done.state).toBe("answered");
		expect(done.conversationId).toBe(first.conversationId);
		expect(srv.conversations.owned(first.conversationId!, u)?.claudeSessionId).toBe("11111111-2222-4333-8444-555555555555");

		const second = (await (await post(srv, jwt, "/v1/prompts", { prompt: "and then?", conversationId: first.conversationId })).json()) as View;
		expect(second.conversationId).toBe(first.conversationId);
		await waitDone(srv, jwt, second.id);
		const other = (await (await post(srv, jwt, "/v1/prompts", { prompt: "another chat" })).json()) as View;
		await waitDone(srv, jwt, other.id);

		const list = (await (await get(srv, jwt, "/v1/conversations")).json()) as { conversations: { id: string; title: string; prompts: number; state: string }[] };
		expect(list.conversations.map((c) => c.id)).toEqual([other.conversationId!, first.conversationId!]);
		expect(list.conversations[1]).toMatchObject({ title: "what is this game?", prompts: 2, state: "answered" });

		const conv = (await (await get(srv, jwt, `/v1/conversations/${first.conversationId}`)).json()) as { messages: (View & { prompt: string; events: PromptEvent[]; next: number })[] };
		expect(conv.messages.map((m) => m.prompt)).toEqual(["what is this game?", "and then?"]);
		const merged = conv.messages[0].events.filter((e) => e.kind === "assistant_text");
		expect(merged).toHaveLength(1); // chunks of one block merged for replay
		expect(merged[0].text).toBe("Hi there");
		expect(conv.messages[0].costUsd).toBe(0.0123);
		expect(conv.messages[0].next).toBeGreaterThan(0);
	});

	test("conversations are private: another user gets 404 (read and follow-up); unknown ids 404", async () => {
		const owner = await pair(srv, user());
		const stranger = await pair(srv, user());
		const created = (await (await post(srv, owner, "/v1/prompts", { prompt: "mine" })).json()) as View;
		await waitDone(srv, owner, created.id);
		expect((await get(srv, stranger, `/v1/conversations/${created.conversationId}`)).status).toBe(404);
		expect((await post(srv, stranger, "/v1/prompts", { prompt: "hijack", conversationId: created.conversationId })).status).toBe(404);
		expect(((await (await get(srv, stranger, "/v1/conversations")).json()) as { conversations: unknown[] }).conversations).toEqual([]);
		expect((await get(srv, owner, `/v1/conversations/${"A".repeat(22)}`)).status).toBe(404);
		expect((await post(srv, owner, "/v1/prompts", { prompt: "x", conversationId: "bad id" })).status).toBe(400);
	});

	test("a follow-up while the conversation's prompt is still running → 409", async () => {
		const jwt = await pair(srv, user());
		const first = (await (await post(srv, jwt, "/v1/prompts", { prompt: "hold on" })).json()) as View;
		expect((await post(srv, jwt, "/v1/prompts", { prompt: "too soon", conversationId: first.conversationId })).status).toBe(409);
		srv.queue.cancel(first.id, "test");
		await waitDone(srv, jwt, first.id);
		expect((await post(srv, jwt, "/v1/prompts", { prompt: "now", conversationId: first.conversationId })).status).toBe(200);
	});

	test("the new endpoints need a valid access token", async () => {
		expect((await fetch(`${srv.localUrl}/v1/conversations`)).status).toBe(401);
		expect((await fetch(`${srv.localUrl}/v1/conversations/${"A".repeat(22)}`)).status).toBe(401);
		expect((await fetch(`${srv.localUrl}/v1/attachments`, { method: "POST", body: "{}" })).status).toBe(401);
		const jwt = await pair(srv, user());
		expect((await fetch(`${srv.localUrl}/v1/conversations`, { headers: { authorization: `Bearer ${jwt}`, "x-tt-job": "other-job" } })).status).toBe(403);
	});
});

describe("events", () => {
	test("?since pages through events (300 per page) and `next` continues; no since = no events", async () => {
		const jwt = await pair(srv, user());
		const created = (await (await post(srv, jwt, "/v1/prompts", { prompt: "many events" })).json()) as View;
		const done = await waitDone(srv, jwt, created.id);
		expect(done.events).toBeUndefined();
		const page1 = (await (await get(srv, jwt, `/v1/prompts/${created.id}?since=0`)).json()) as View;
		expect(page1.events).toHaveLength(300);
		expect(page1.more).toBe(true);
		expect(page1.events!.map((e) => e.i)).toEqual(Array.from({ length: 300 }, (_, i) => i));
		const events = await allEvents(srv, jwt, created.id);
		expect(events.map((e) => e.i)).toEqual(Array.from({ length: events.length }, (_, i) => i));
		expect(events[0]).toMatchObject({ kind: "status", state: "queued" });
		expect(events.filter((e) => e.kind === "tool_use")).toHaveLength(700);
		expect(events.find((e) => e.kind === "tool_use")).toMatchObject({ tool: "Read", target: "file0.ts", text: "Read file0.ts" });
		expect(text(events)).toBe("Hi there");
		expect(events[events.length - 1]).toMatchObject({ kind: "status", state: "answered" });
		const after = (await (await get(srv, jwt, `/v1/prompts/${created.id}?since=${events.length}`)).json()) as View;
		expect(after.events).toEqual([]);
		expect(after.next).toBe(events.length);
		expect((await get(srv, jwt, `/v1/prompts/${created.id}?since=-1`)).status).toBe(400);
		expect((await get(srv, jwt, `/v1/prompts/${created.id}?since=abc`)).status).toBe(400);
	});

	test("streamed text never publishes part of a secret, a JWT or a tunnel URL, even split across chunks", async () => {
		addEventSecret("SUPERSECRETVALUE-123456");
		const parts = ["key SUPERSECRET", "VALUE-123456 and eyJhbGciOiJIUzI1NiJ9.eyJz", "dWIiOiJ4In0.c2lnbmF0dXJlLXNpZw url https://abc-", "def.trycloudflare.com/x ok"];
		const runner: Runner = async (ctx) => {
			for (const part of parts) {
				ctx.text(1, part);
				await Bun.sleep(320); // let the flush timer publish what is safe
			}
			return { state: "answered", summary: "ok" };
		};
		const own = createRemoteClaudeServer({ branch: BRANCH, users: USERS, runner, logger: silentLogger, attachmentsDir: join(attachmentsDir, "b") });
		try {
			const jwt = await pair(own, USERS[0]);
			const created = (await (await post(own, jwt, "/v1/prompts", { prompt: "leak?" })).json()) as View;
			const record = own.queue.get(created.id)!;
			const seen: string[] = [];
			while (!record.done) {
				for (const e of record.events) if (e.kind === "assistant_text") seen[e.i] = e.text;
				await Bun.sleep(40);
			}
			const all = text(await allEvents(own, jwt, created.id));
			for (const chunk of [...seen.filter(Boolean), all]) {
				expect(chunk).not.toContain("SUPERSECRET");
				expect(chunk).not.toContain("eyJ");
				expect(chunk).not.toContain("trycloudflare");
			}
			expect(all).toBe("key <redacted> and <jwt> url <tunnel-url> ok");
		} finally {
			await own.stop();
		}
	});

	test("redaction helpers", () => {
		expect(safePrefixLength("hello wor")).toBe(9);
		expect(safePrefixLength("token eyJabc")).toBe(6);
		expect(safePrefixLength("see https://ab")).toBe(4);
		expect(redactEvent("a\r\nb\u0007c https://x-y.trycloudflare.com/v1/token")).toBe("a\nbc <tunnel-url>");
	});
});

describe("attachments", () => {
	test("zstd upload → PNG in the attachments folder (signature, IHDR, CRCs, pixels round-trip)", async () => {
		const jwt = await pair(srv, user());
		const pixels = testImage(37, 21);
		const zstd = Bun.zstdCompressSync(pixels, { level: 3 });
		expect(zstdContentSize(zstd)).toBe(pixels.length);
		const res = await post(srv, jwt, "/v1/attachments", { width: 37, height: 21, format: "rgba8", compression: "zstd", data: b64(zstd) });
		expect(res.status).toBe(200);
		const { id, width, height } = (await res.json()) as { id: string; width: number; height: number };
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect([width, height]).toEqual([37, 21]);
		const file = join(srv.attachments.dir, `${id}.png`);
		const decoded = decodePng(new Uint8Array(readFileSync(file)));
		expect([decoded.width, decoded.height]).toEqual([37, 21]);
		expect(Buffer.from(decoded.pixels).equals(Buffer.from(pixels))).toBe(true);
		expect(srv.attachments.get(id)?.relPath).toBe(`.typetorch/attachments/${id}.png`);
	});

	test("uncompressed upload works; every size mismatch is refused", async () => {
		const jwt = await pair(srv, user());
		const pixels = testImage(8, 4);
		const upload = (body: Record<string, unknown>) => post(srv, jwt, "/v1/attachments", { width: 8, height: 4, format: "rgba8", compression: "none", data: b64(pixels), ...body });
		expect((await upload({})).status).toBe(200);
		expect((await upload({ width: 9 })).status).toBe(400); // data ≠ w*h*4
		expect((await upload({ data: b64(pixels.subarray(4)) })).status).toBe(400);
		expect((await upload({ compression: "zstd" })).status).toBe(400); // not a zstd frame
		expect((await upload({ compression: "zstd", data: b64(Bun.zstdCompressSync(testImage(8, 5))) })).status).toBe(400); // declared size wrong
		expect((await upload({ width: 1025 })).status).toBe(400);
		expect((await upload({ format: "png" })).status).toBe(400);
		expect((await upload({ data: "not base64!" })).status).toBe(400);
		expect((await upload({ extra: 1 })).status).toBe(400);
		// A zstd bomb: a tiny frame that inflates past width*height*4 is cut off.
		const bomb = Bun.zstdCompressSync(new Uint8Array(4 * 1024 * 1024));
		expect(decodeAttachment({ width: 8, height: 4, format: "rgba8", compression: "zstd", data: b64(bomb) })).toBeTypeOf("string");
		expect(decodeAttachment({ width: 1024, height: 1024, format: "rgba8", compression: "none", data: b64(new Uint8Array(4)) })).toBeTypeOf("string");
	});

	test("auth: no token → 401, no nonce → 400, replayed nonce → 409; body over 3 MB → 413", async () => {
		const jwt = await pair(srv, user());
		const body = { width: 1, height: 1, format: "rgba8", compression: "none", data: b64(new Uint8Array(4)) };
		expect((await fetch(`${srv.localUrl}/v1/attachments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(401);
		expect((await post(srv, jwt, "/v1/attachments", body, { "x-tt-nonce": "" })).status).toBe(400);
		const fixed = { "x-tt-nonce": `fixed-${crypto.randomUUID()}` };
		expect((await post(srv, jwt, "/v1/attachments", body, fixed)).status).toBe(200);
		expect((await post(srv, jwt, "/v1/attachments", body, fixed)).status).toBe(409);
		expect((await post(srv, jwt, "/v1/attachments", { ...body, data: "A".repeat(ATTACHMENT_LIMITS.maxBodyBytes) })).status).toBe(413);
	});

	test("prompts: ≤4 attachments, only your own, each used once; 20 per user per session", async () => {
		const u = user();
		const jwt = await pair(srv, u);
		const strangerJwt = await pair(srv, user());
		const upload = async (token = jwt) => {
			const res = await post(srv, token, "/v1/attachments", { width: 2, height: 2, format: "rgba8", compression: "none", data: b64(testImage(2, 2)) });
			return { status: res.status, id: res.status === 200 ? ((await res.json()) as { id: string }).id : "" };
		};
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) ids.push((await upload()).id);
		const foreign = (await upload(strangerJwt)).id;
		expect((await post(srv, jwt, "/v1/prompts", { prompt: "five", attachments: ids })).status).toBe(400);
		expect((await post(srv, jwt, "/v1/prompts", { prompt: "dup", attachments: [ids[0], ids[0]] })).status).toBe(400);
		expect((await post(srv, jwt, "/v1/prompts", { prompt: "not mine", attachments: [foreign] })).status).toBe(400);
		expect((await post(srv, jwt, "/v1/prompts", { prompt: "unknown", attachments: ["0".repeat(32)] })).status).toBe(400);
		const ok = await post(srv, jwt, "/v1/prompts", { prompt: "look at these", attachments: ids.slice(0, 4) });
		expect(ok.status).toBe(200);
		const created = (await ok.json()) as View;
		const done = await waitDone(srv, jwt, created.id);
		expect(done.attachments?.map((a) => a.id)).toEqual(ids.slice(0, 4));
		expect((await post(srv, jwt, "/v1/prompts", { prompt: "again", attachments: [ids[0]] })).status).toBe(400); // used
		// Quota: 6 uploaded by u so far (5 + 0); 14 more fit, the 21st is refused.
		for (let i = srv.attachments.count(u); i < ATTACHMENT_LIMITS.perUser; i++) expect((await upload()).status).toBe(200);
		expect((await upload()).status).toBe(429);
	});

	test("the prompt tells Claude where the screenshots are; files are deleted when the server stops", async () => {
		const wrapped = wrapPrompt(1, "what is wrong here?", undefined, [{ relPath: ".typetorch/attachments/abc.png", width: 640, height: 360 }]);
		expect(wrapped).toContain("<attachments>\nAttached screenshot: .typetorch/attachments/abc.png (640x360)\n</attachments>");
		const dir = join(attachmentsDir, "stop");
		const own = createRemoteClaudeServer({ branch: BRANCH, users: USERS, runner: scripted, logger: silentLogger, attachmentsDir: dir });
		const jwt = await pair(own, USERS[0]);
		expect((await post(own, jwt, "/v1/attachments", { width: 1, height: 1, format: "rgba8", compression: "none", data: b64(new Uint8Array(4)) })).status).toBe(200);
		expect(existsSync(dir)).toBe(true);
		await own.stop();
		expect(existsSync(dir)).toBe(false);
	});

	test("PNG encoder: larger image with mixed content round-trips", () => {
		const pixels = testImage(300, 200);
		for (let i = 0; i < 2000; i++) pixels[(Math.random() * pixels.length) | 0] = (Math.random() * 256) | 0;
		const decoded = decodePng(encodePng(300, 200, pixels));
		expect(Buffer.from(decoded.pixels).equals(Buffer.from(pixels))).toBe(true);
	});
});

describe("subscription only (no API billing)", () => {
	test("`claude auth status`: only a claude.ai login on firstParty passes", () => {
		expect(assessAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })).ok).toBe(true);
		expect(assessAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })).ok).toBe(false);
		expect(assessAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" })).ok).toBe(false);
		expect(assessAuthStatus(JSON.stringify({ loggedIn: false })).ok).toBe(false);
		expect(assessAuthStatus("not json").ok).toBe(false);
	});

	test("checkSubscriptionAuth runs `claude auth status` and refuses an API key login", async () => {
		const saved = process.env.TT_FAKE_AUTH;
		try {
			process.env.TT_FAKE_AUTH = "subscription";
			await checkSubscriptionAuth(FAKE, process.cwd());
			for (const mode of ["apikey", "loggedout", "bedrock"]) {
				process.env.TT_FAKE_AUTH = mode;
				await expect(checkSubscriptionAuth(FAKE, process.cwd())).rejects.toBeInstanceOf(SubscriptionRequiredError);
			}
			await expect(checkSubscriptionAuth(FAKE, process.cwd())).rejects.toThrow(/only runs on your Claude subscription/);
		} finally {
			if (saved === undefined) delete process.env.TT_FAKE_AUTH;
			else process.env.TT_FAKE_AUTH = saved;
		}
	});

	test("child processes never get ANTHROPIC_* / CLAUDE_CODE_USE_* / AWS_BEARER_TOKEN_BEDROCK", () => {
		const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_CUSTOM_HEADERS"];
		const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
		try {
			for (const n of names) process.env[n] = "x-should-not-leak";
			for (const env of [childEnv(), childEnv({ forClaude: true })]) for (const n of names) expect(env[n]).toBeUndefined();
			expect(isApiBillingVar("anthropic_api_key")).toBe(true);
			expect(isApiBillingVar("PATH")).toBe(false);
		} finally {
			for (const n of names) if (saved[n] === undefined) delete process.env[n];
			else process.env[n] = saved[n];
		}
	});

	test("init event: apiKeySource must be \"none\"; a missing field passes only after the startup check", () => {
		expect(judgeInitEvent({ apiKeySource: "none" }, false)).toBe("ok");
		expect(judgeInitEvent({ apiKeySource: "ANTHROPIC_API_KEY" }, true)).toBe("refused");
		expect(judgeInitEvent({ apiKeySource: "apiKeyHelper" }, true)).toBe("refused");
		expect(judgeInitEvent({}, true)).toBe("ok");
		expect(judgeInitEvent({}, false)).toBe("refused");
	});

	test("startRemoteClaude refuses to start when Claude Code is logged in with an API key", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-rc-billing-"));
		const repo = join(dir, "game");
		mkdirSync(repo);
		writeFileSync(join(repo, "typetorch.json"), JSON.stringify({ project: "t", defaultBranch: "prod", branches: { main: "prod" } }));
		const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		git("init", "-q", "-b", "main");
		git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
		git("checkout", "-q", "-b", "dev");
		const saved = process.env.TT_FAKE_AUTH;
		process.env.TT_FAKE_AUTH = "apikey";
		try {
			await expect(
				startRemoteClaude({ users: [1], repo, claudeCommand: FAKE, tunnel: false, announce: false, terminal: false, clipboard: false, installDeps: false, logger: silentLogger }),
			).rejects.toBeInstanceOf(SubscriptionRequiredError);
			expect(existsSync(join(dir, "game-remote-claude"))).toBe(false); // refused before the worktree
		} finally {
			if (saved === undefined) delete process.env.TT_FAKE_AUTH;
			else process.env.TT_FAKE_AUTH = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("real runner with a fake claude (stream mapping, resume, answered, billing guard)", () => {
	let dir: string;
	let repo: string;
	let out: string;
	let server: RemoteClaudeServer;
	let subscriptionVerified = true;
	const runs = () => readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; stdin: string; resume?: string; billingVars: string[] });
	const env = (vars: Record<string, string | undefined>) => {
		for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "tt-rc-runner-"));
		repo = join(dir, "game");
		mkdirSync(repo);
		writeFileSync(join(repo, "README.md"), "# fixture\n");
		writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
		const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		git("init", "-q", "-b", "main");
		git("config", "user.name", "t");
		git("config", "user.email", "t@t");
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		git("checkout", "-q", "-b", "dev");
		const worktree = await ensureWorktree(repo, "dev");
		await ensureIgnored(worktree.path, ".typetorch/attachments/");
		out = join(dir, "runs.jsonl");
		writeFileSync(out, "");
		env({ TT_FAKE_OUT: out });
		const runner: Runner = (ctx) => createClaudeRunner({ worktree, ttBranch: BRANCH, deploy: false, claudeCommand: FAKE, subscriptionVerified })(ctx);
		server = createRemoteClaudeServer({ branch: BRANCH, users: USERS, runner, logger: silentLogger, attachmentsDir: join(worktree.path, ".typetorch", "attachments") });
	});

	afterAll(async () => {
		await server?.stop();
		env({ TT_FAKE_OUT: undefined, TT_FAKE_KEYSOURCE: undefined, TT_FAKE_MISSING: undefined });
		rmSync(dir, { recursive: true, force: true });
	});

	test("a question is `answered`: streamed text once (no duplicate from the full message), tool lines, est. cost", async () => {
		const jwt = await pair(server, USERS[30]);
		const created = (await (await post(server, jwt, "/v1/prompts", { prompt: "what does README say?" })).json()) as View;
		const done = await waitDone(server, jwt, created.id);
		expect(done.state).toBe("answered");
		expect(done.error).toBeUndefined();
		expect(done.costUsd).toBe(0.0123);
		const events = await allEvents(server, jwt, created.id);
		expect(text(events)).toBe("Hello **world**Final answer.");
		const blocks = new Set(events.filter((e) => e.kind === "assistant_text").map((e) => e.block));
		expect(blocks.size).toBe(2);
		expect(events.find((e) => e.kind === "tool_use")).toMatchObject({ tool: "Read", target: "README.md", text: "Read README.md" });
		expect(events.find((e) => e.kind === "tool_result")).toMatchObject({ tool: "Read", text: "3 lines" });
		expect(events.map((e) => e.state).filter(Boolean)).toEqual(["queued", "running", "answered"]);
		const last = runs()[runs().length - 1];
		expect(last.args).toContain("--include-partial-messages");
		expect(last.args).not.toContain("--no-session-persistence");
		expect(last.args).not.toContain("--resume");
		expect(last.args.some((a) => a.startsWith("--settings"))).toBe(false);
	});

	test("a follow-up resumes the same Claude session; an edit is committed", async () => {
		const jwt = await pair(server, USERS[31]);
		const first = (await (await post(server, jwt, "/v1/prompts", { prompt: "remember the number 42" })).json()) as View;
		await waitDone(server, jwt, first.id);
		const sessionId = server.conversations.owned(first.conversationId!, USERS[31])!.claudeSessionId!;
		expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
		const second = (await (await post(server, jwt, "/v1/prompts", { prompt: "EDIT: use it", conversationId: first.conversationId })).json()) as View;
		const done = await waitDone(server, jwt, second.id);
		expect(runs()[runs().length - 1].resume).toBe(sessionId);
		expect(done.state).toBe("committed");
		expect(done.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(done.summary).toBe("add src/edited.ts");
		const events = await allEvents(server, jwt, second.id);
		expect(text(events)).toContain("(again)");
		expect(events.find((e) => e.kind === "status" && e.state === "committed")?.text).toBe(`committed ${done.commit!.slice(0, 7)}`);
	});

	test("a lost Claude session: the follow-up starts fresh and says so", async () => {
		const jwt = await pair(server, USERS[32]);
		const first = (await (await post(server, jwt, "/v1/prompts", { prompt: "hello" })).json()) as View;
		await waitDone(server, jwt, first.id);
		const conversation = server.conversations.owned(first.conversationId!, USERS[32])!;
		env({ TT_FAKE_MISSING: conversation.claudeSessionId });
		try {
			const second = (await (await post(server, jwt, "/v1/prompts", { prompt: "again", conversationId: first.conversationId })).json()) as View;
			const done = await waitDone(server, jwt, second.id);
			expect(done.state).toBe("answered");
			const events = await allEvents(server, jwt, second.id);
			expect(events.some((e) => e.kind === "status" && /starting a fresh session/.test(e.text))).toBe(true);
			expect(conversation.claudeSessionId).not.toBe(process.env.TT_FAKE_MISSING);
		} finally {
			env({ TT_FAKE_MISSING: undefined });
		}
	});

	test("billing guard: apiKeySource ≠ none kills the run (api_billing_refused) before anything is published", async () => {
		const jwt = await pair(server, USERS[33]);
		env({ TT_FAKE_KEYSOURCE: "ANTHROPIC_API_KEY" });
		try {
			const started = Date.now();
			const created = (await (await post(server, jwt, "/v1/prompts", { prompt: "SLOW hello" })).json()) as View;
			const done = await waitDone(server, jwt, created.id);
			expect(Date.now() - started).toBeLessThan(4500); // killed, not waited out
			expect(done.state).toBe("failed");
			expect(done.error).toBe("api_billing_refused");
			const events = await allEvents(server, jwt, created.id);
			expect(events.filter((e) => e.kind === "assistant_text" || e.kind === "tool_use")).toEqual([]);
			// No apiKeySource and no startup check: refused too.
			env({ TT_FAKE_KEYSOURCE: "omit" });
			subscriptionVerified = false;
			const second = (await (await post(server, jwt, "/v1/prompts", { prompt: "hello" })).json()) as View;
			expect((await waitDone(server, jwt, second.id)).error).toBe("api_billing_refused");
			subscriptionVerified = true;
			const third = (await (await post(server, jwt, "/v1/prompts", { prompt: "hello" })).json()) as View;
			expect((await waitDone(server, jwt, third.id)).state).toBe("answered");
		} finally {
			env({ TT_FAKE_KEYSOURCE: undefined });
			subscriptionVerified = true;
		}
	});

	test("the spawned claude sees none of the billing variables (the host's ANTHROPIC_BASE_URL included)", async () => {
		const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "AWS_BEARER_TOKEN_BEDROCK"];
		const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
		try {
			for (const n of names) process.env[n] = "x-should-not-leak";
			const jwt = await pair(server, USERS[34]);
			const created = (await (await post(server, jwt, "/v1/prompts", { prompt: "env check" })).json()) as View;
			await waitDone(server, jwt, created.id);
			expect(runs()[runs().length - 1].billingVars).toEqual([]);
		} finally {
			env(saved);
		}
	});

	test("attachments reach Claude as paths inside the worktree", async () => {
		const jwt = await pair(server, USERS[35]);
		const res = await post(server, jwt, "/v1/attachments", { width: 4, height: 4, format: "rgba8", compression: "zstd", data: b64(Bun.zstdCompressSync(testImage(4, 4))) });
		const { id } = (await res.json()) as { id: string };
		const created = (await (await post(server, jwt, "/v1/prompts", { prompt: "see image", attachments: [id] })).json()) as View;
		await waitDone(server, jwt, created.id);
		const run = runs()[runs().length - 1];
		expect(run.stdin).toContain(`Attached screenshot: .typetorch/attachments/${id}.png (4x4)`);
		const wt = server.attachments.dir;
		expect(existsSync(join(wt, `${id}.png`))).toBe(true);
		// Git ignores it (never committed by the next run's `git add -A`).
		const status = Bun.spawnSync(["git", "status", "--porcelain", "--ignored"], { cwd: join(wt, "..", ".."), stdout: "pipe" }).stdout.toString();
		expect(status).toContain("!! .typetorch/");
	});
});

describe("helpers", () => {
	test("tool results are one line, never file contents", () => {
		expect(summarizeToolResult("Read", { content: "a\nb\nc" })).toBe("3 lines");
		expect(summarizeToolResult("Glob", { content: "x.ts\ny.ts" })).toBe("2 files");
		expect(summarizeToolResult("Grep", { content: "No matches found" })).toBe("no matches");
		expect(summarizeToolResult("Edit", { content: "The file x has been updated" })).toBe("done");
		expect(summarizeToolResult("Bash", { content: "building\nbuild ok" })).toBe("build ok");
		expect(summarizeToolResult("Read", { content: [{ type: "image", source: {} }] })).toBe("image");
		expect(summarizeToolResult("Edit", { content: "String not found\nmore", is_error: true })).toBe("error: String not found");
	});

	test("artifact ids with a revision suffix (dev-12b63b9.r2) and deploy --json output", () => {
		expect(lastArtifactId("deployed artifact dev-12b63b9.r2 to dev")).toBe("dev-12b63b9.r2");
		expect(lastArtifactId("prod-abcdef1-dirty-a1b2c3.r10, next")).toBe("prod-abcdef1-dirty-a1b2c3.r10");
		expect(lastArtifactId("artifact dev-1234abc.")).toBe("dev-1234abc");
		expect(lastArtifactId("nothing here")).toBeUndefined();
		expect(deployedArtifactId(JSON.stringify({ deployment: { artifactId: "dev-1234abc.r3" } }, null, 2))).toBe("dev-1234abc.r3");
		expect(deployedArtifactId("not json\nartifact dev-7654321.r4")).toBe("dev-7654321.r4");
	});
});
