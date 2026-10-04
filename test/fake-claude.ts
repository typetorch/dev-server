/**
 * A stand-in for the `claude` CLI in tests (run as [bun, fake-claude.ts, ...args]). Controlled by env variables the
 * test sets (they pass through childEnv; ANTHROPIC_* never do):
 *   TT_FAKE_AUTH        "subscription" (default) | "apikey" | "loggedout" | "bedrock"   for `auth status`
 *   TT_FAKE_KEYSOURCE   apiKeySource in the init event (default "none"; "omit" leaves it out)
 *   TT_FAKE_OUT         a file that gets one JSON line per run: args, stdin, which billing variables were visible
 *   TT_FAKE_MISSING     a session id that `--resume` treats as unknown (exit 1, like the real CLI)
 * The prompt (stdin) steers a run: "EDIT" writes src/edited.ts; "SECRET" streams a JWT and a tunnel URL split across
 * deltas; "SLOW" waits 5 s after init.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const out = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args[0] === "--version") {
	console.log("9.9.9 (Claude Code, fake)");
	process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
	const mode = process.env.TT_FAKE_AUTH ?? "subscription";
	const status =
		mode === "apikey"
			? { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }
			: mode === "loggedout"
				? { loggedIn: false }
				: mode === "bedrock"
					? { loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }
					: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "x@example.com" };
	console.log(JSON.stringify(status, null, 2));
	process.exit(mode === "loggedout" ? 1 : 0);
}

const stdin = await new Response(Bun.stdin.stream()).text();
const resumeAt = args.indexOf("--resume");
const resume = resumeAt >= 0 ? args[resumeAt + 1] : undefined;
const billingVars = Object.keys(process.env).filter((name) => /^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_BEARER_TOKEN_BEDROCK)/i.test(name));
if (process.env.TT_FAKE_OUT) appendFileSync(process.env.TT_FAKE_OUT, `${JSON.stringify({ args, stdin, resume, billingVars, cwd: process.cwd() })}\n`);

if (resume && resume === process.env.TT_FAKE_MISSING) {
	out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: resume, total_cost_usd: 0 });
	console.error(`No conversation found with session ID: ${resume}`);
	process.exit(1);
}

const sessionId = resume ?? crypto.randomUUID();
const keySource = process.env.TT_FAKE_KEYSOURCE ?? "none";
const init: Record<string, unknown> = { type: "system", subtype: "init", session_id: sessionId, model: "fake-model", cwd: process.cwd() };
if (keySource !== "omit") init.apiKeySource = keySource;
out({ type: "system", subtype: "ui_toast", text: "hello" });
out(init);
if (stdin.includes("SLOW")) await Bun.sleep(5000);

const message = (id: string, text: string[]) => {
	out({ type: "stream_event", event: { type: "message_start", message: { id } } });
	out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
	for (const delta of text) out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } } });
	out({ type: "assistant", message: { id, content: [{ type: "text", text: text.join("") }] } });
	out({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
};

const secretParts = ["Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIi", "OiJ4In0.c2lnbmF0dXJlLXNpZw and url https://abc-def", "-ghi.trycloudflare.com/v1 done"];
message("msg_1", stdin.includes("SECRET") ? secretParts : ["Hello ", "**world**", resume ? " (again)" : ""]);
// A tool call and its result.
out({ type: "assistant", message: { id: "msg_2", content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file_path: join(process.cwd(), "README.md") } }] } });
out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool_1", content: "line one\nline two\nline three" }] } });
let resultText = "Hello world";
if (stdin.includes("EDIT")) {
	mkdirSync(join(process.cwd(), "src"), { recursive: true });
	writeFileSync(join(process.cwd(), "src", "edited.ts"), `export const edited = ${Date.now()};\n`);
	out({ type: "assistant", message: { id: "msg_3", content: [{ type: "tool_use", id: "tool_2", name: "Write", input: { file_path: join(process.cwd(), "src", "edited.ts") } }] } });
	out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool_2", content: "File created successfully" }] } });
	resultText = "Done.\nSUMMARY: add src/edited.ts";
}
message("msg_4", ["Final answer."]);
out({ type: "result", subtype: "success", is_error: false, num_turns: 3, session_id: sessionId, total_cost_usd: 0.0123, result: resultText });
process.exit(0);
