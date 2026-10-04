/**
 * End-to-end: a real two-message conversation through the real Quick Tunnel and real headless Claude Code (on the
 * dev's Claude subscription), in the throwaway fixture repo, with --no-deploy and no announcement. The first message
 * carries a generated screenshot (zstd RGBA8, like the game sends); the second refers to the first. Spends a little
 * Claude usage, so it is a script, not part of `bun test`.
 *
 *   bun test/e2e.ts                 (E2E_MODEL=<model>, default sonnet; E2E_EDIT=1 adds a third message that edits)
 *
 * Pairs with the session's pairing code the way the game does (code grant), then uses the access token.
 */
import { consoleLogger } from "../src/log";
import { startRemoteClaude } from "../src/session";
import { ensureFixture } from "./fixture";

const USER = 111;
const JOB = crypto.randomUUID();
const fixture = ensureFixture();

/** 320×180: left half solid red, right half solid blue, a white square in the middle. */
function screenshot(width = 320, height = 180): Uint8Array {
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const square = Math.abs(x - width / 2) < 20 && Math.abs(y - height / 2) < 20;
			const [r, g, b] = square ? [255, 255, 255] : x < width / 2 ? [220, 20, 20] : [20, 40, 220];
			pixels.set([r, g, b, 255], i);
		}
	}
	return pixels;
}

const session = await startRemoteClaude({
	users: [USER],
	repo: fixture,
	deploy: false,
	announce: false,
	terminal: false,
	clipboard: false,
	model: process.env.E2E_MODEL ?? "sonnet",
	logger: consoleLogger(),
});

interface Event {
	i: number;
	kind: string;
	text: string;
	block?: number;
	state?: string;
}

try {
	const url = session.url()!;
	let tokenRes: Response | undefined;
	for (let i = 0; i < 30; i++) {
		try {
			tokenRes = await fetch(`${url}/v1/token`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ grant: "code", sid: session.sessionId, user: USER, job: JOB, branch: session.branch, code: session.server.pairing.formatted }),
				signal: AbortSignal.timeout(10_000),
			});
			if (tokenRes.status === 200) break;
		} catch {}
		await Bun.sleep(2000);
	}
	if (tokenRes?.status !== 200) throw new Error(`token exchange through the tunnel failed (${tokenRes?.status})`);
	const jwt = ((await tokenRes.json()) as { access_token: string }).access_token;
	console.log("[e2e] paired (code grant) through the tunnel");
	const headers = (json = true): Record<string, string> => ({
		authorization: `Bearer ${jwt}`,
		...(json ? { "content-type": "application/json" } : {}),
		"x-tt-job": JOB,
		"x-tt-nonce": crypto.randomUUID(),
		"x-tt-timestamp": String(Math.floor(Date.now() / 1000)),
	});

	// 1. The attachment, the way the game uploads it.
	const pixels = screenshot();
	const zstd = Bun.zstdCompressSync(pixels, { level: 3 });
	const attachRes = await fetch(`${url}/v1/attachments`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ width: 320, height: 180, format: "rgba8", compression: "zstd", data: Buffer.from(zstd).toString("base64") }),
	});
	if (attachRes.status !== 200) throw new Error(`attachment upload → ${attachRes.status}`);
	const attachment = (await attachRes.json()) as { id: string };
	console.log(`[e2e] POST /v1/attachments → 200 ${JSON.stringify(attachment)} (raw ${pixels.length} B, zstd ${zstd.length} B)`);

	const send = async (prompt: string, extra: Record<string, unknown>) => {
		const res = await fetch(`${url}/v1/prompts`, { method: "POST", headers: headers(), body: JSON.stringify({ prompt, ...extra }) });
		const body = (await res.json()) as { id: string; state: string; conversationId: string };
		console.log(`[e2e] POST /v1/prompts → ${res.status} ${JSON.stringify(body)}`);
		return body;
	};

	/** Polls like the game (about once a second, ?since=next) and prints the events as they arrive. */
	const follow = async (id: string) => {
		let since = 0;
		const events: Event[] = [];
		let last: any;
		const deadline = Date.now() + 15 * 60_000;
		while (Date.now() < deadline) {
			await Bun.sleep(1000);
			const res = await fetch(`${url}/v1/prompts/${id}?since=${since}`, { headers: { authorization: `Bearer ${jwt}`, "x-tt-job": JOB } });
			if (res.status !== 200) {
				console.log(`[e2e] GET → ${res.status}`);
				continue;
			}
			last = await res.json();
			for (const event of last.events as Event[]) {
				events.push(event);
				if (event.kind !== "assistant_text") console.log(`[e2e]   #${event.i} ${event.kind}: ${event.text}`);
			}
			since = last.next;
			if (last.finishedAt && !last.more) break;
		}
		const reply = events.filter((e) => e.kind === "assistant_text").map((e) => e.text).join("");
		const chunks = events.filter((e) => e.kind === "assistant_text").length;
		console.log(`[e2e]   reply (${chunks} streamed chunks):\n${reply.split("\n").map((l) => `      ${l}`).join("\n")}`);
		console.log(`[e2e]   final: ${JSON.stringify({ state: last.state, summary: last.summary, commit: last.commit, error: last.error, costUsd: last.costUsd })}`);
		return { last, reply };
	};

	const first = await send(
		"Remember this code word for later: PINEAPPLE. Also look at the attached screenshot and tell me, in one short sentence, which two main colors it shows (left and right). Do not change any files.",
		{ attachments: [attachment.id] },
	);
	const one = await follow(first.id);
	const second = await send("What was the code word I gave you in my previous message? Answer with just the word. Do not change any files.", {
		conversationId: first.conversationId,
	});
	const two = await follow(second.id);

	const checks = {
		"message 1 answered": one.last.state === "answered",
		"message 1 saw red and blue": /red/i.test(one.reply) && /blue/i.test(one.reply),
		"message 2 same conversation": second.conversationId === first.conversationId,
		"message 2 answered": two.last.state === "answered",
		"message 2 remembered PINEAPPLE": /PINEAPPLE/i.test(two.reply),
	};
	if (process.env.E2E_EDIT === "1") {
		const third = await send("Add a comment line to README.md saying it was edited by remote-claude. Change nothing else.", { conversationId: first.conversationId });
		const three = await follow(third.id);
		Object.assign(checks, { "message 3 committed": three.last.state === "committed" });
	}
	const list = (await (await fetch(`${url}/v1/conversations`, { headers: { authorization: `Bearer ${jwt}`, "x-tt-job": JOB } })).json()) as { conversations: unknown[] };
	console.log(`[e2e] GET /v1/conversations → ${JSON.stringify(list.conversations)}`);
	const files = Bun.spawnSync(["git", "status", "--porcelain", "--ignored"], { cwd: session.worktree.path, stdout: "pipe" }).stdout.toString();
	console.log(`[e2e] worktree status (attachment must be ignored, not untracked):\n${files}`);
	console.log(`[e2e] checks: ${JSON.stringify(checks, null, 1)}`);
	if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
} finally {
	await session.close();
}
process.exit(process.exitCode ?? 0);
