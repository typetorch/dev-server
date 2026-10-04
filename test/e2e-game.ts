/**
 * End-to-end for the game tools with the REAL claude CLI (subscription) and a fake game server: claude gets the
 * "typetorch-game" MCP server, calls game_status and run_luau, and the fake game answers over the JWT endpoints.
 * Local only (no tunnel, no announcement), --no-deploy, in test-fixture/. Spends a little Claude usage.
 *
 *   bun test/e2e-game.ts        (E2E_MODEL=<model>, default sonnet)
 */
import { consoleLogger } from "../src/log";
import { startRemoteClaude } from "../src/session";
import { ensureFixture } from "./fixture";

const USER = 222;
const JOB = crypto.randomUUID();
const session = await startRemoteClaude({
	users: [USER],
	repo: ensureFixture(),
	deploy: false,
	tunnel: false,
	announce: false,
	terminal: false,
	clipboard: false,
	model: process.env.E2E_MODEL ?? "sonnet",
	logger: consoleLogger(),
});
const base = session.server.localUrl;
let stop = false;
try {
	const token = await fetch(`${base}/v1/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant: "code", sid: session.sessionId, user: USER, job: JOB, branch: session.branch, code: session.server.pairing.formatted }),
	});
	const jwt = ((await token.json()) as { access_token: string }).access_token;
	const headers = (post = false): Record<string, string> => ({
		authorization: `Bearer ${jwt}`,
		"x-tt-job": JOB,
		...(post ? { "content-type": "application/json", "x-tt-nonce": crypto.randomUUID(), "x-tt-timestamp": String(Math.floor(Date.now() / 1000)) } : {}),
	});

	// The fake game server.
	const handled: string[] = [];
	const game = (async () => {
		while (!stop) {
			const pending = (await (await fetch(`${base}/v1/game/pending`, { headers: headers() })).json()) as { requests: { id: string }[] };
			for (const { id } of pending.requests) {
				const request = (await (await fetch(`${base}/v1/game/requests/${id}`, { headers: headers() })).json()) as { tool: string; args: Record<string, unknown> };
				handled.push(`${request.tool} ${JSON.stringify(request.args)}`);
				console.log(`[e2e-game] game got ${request.tool} ${JSON.stringify(request.args)}`);
				const body =
					request.tool === "game_status"
						? { ok: true, data: JSON.stringify({ artifact: "dev-1234567", branch: "dev", channel: "dev", players: [{ name: "Builderman", userId: USER, position: [12, 3, -40] }, { name: "Guest", userId: 9, position: [0, 3, 0] }] }) }
						: request.tool === "run_luau"
							? { ok: true, output: ["coins before 5"], returned: "105", ms: 2 }
							: { ok: false, error: "not in this fake", output: [] };
				await fetch(`${base}/v1/game/requests/${id}/result`, { method: "POST", headers: headers(true), body: JSON.stringify(body) });
			}
			await Bun.sleep(300);
		}
	})();

	const created = await fetch(`${base}/v1/prompts`, {
		method: "POST",
		headers: headers(true),
		body: JSON.stringify({
			prompt: "Use your game tools: first check the server status and tell me how many players are in my server. Then give me 100 coins with run_luau (assume `player.leaderstats.Coins.Value`). Don't change any files.",
		}),
	});
	const { id } = (await created.json()) as { id: string };
	let since = 0;
	let view: any;
	for (let i = 0; i < 600; i++) {
		await Bun.sleep(1000);
		view = await (await fetch(`${base}/v1/prompts/${id}?since=${since}`, { headers: headers() })).json();
		for (const event of view.events) if (event.kind !== "assistant_text") console.log(`[e2e-game]   ${event.kind}: ${event.text}`);
		since = view.next;
		if (view.finishedAt && !view.more) break;
	}
	const all = (await (await fetch(`${base}/v1/prompts/${id}?since=0`, { headers: headers() })).json()) as { events: { kind: string; text: string }[] };
	const reply = all.events.filter((e) => e.kind === "assistant_text").map((e) => e.text).join("");
	console.log(`[e2e-game] reply:\n${reply}`);
	const checks = {
		answered: view.state === "answered",
		"game_status called": handled.some((h) => h.startsWith("game_status")),
		"run_luau called": handled.some((h) => h.startsWith("run_luau")),
		"reply mentions 2 players": /\b2\b|two/i.test(reply),
	};
	console.log(`[e2e-game] checks: ${JSON.stringify(checks, null, 1)}`);
	if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
	stop = true;
	await game;
} finally {
	stop = true;
	await session.close();
}
process.exit(process.exitCode ?? 0);
