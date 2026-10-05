// The HTTP server's contract, checked the same way on every implementation (runtime.ts `serve`): Bun.serve and the
// node:http adapter under `bun test` (test/http.test.ts), and node:http under plain Node (scripts/smoke.mjs, compiled).
//   loopback only; bare 404 with the security headers and no CORS; 413 for a declared oversized body; 431 for big
//   headers; 401 for a wrong content type or an oversized token body (chunked); pairing + JWT; a long-poll held past the
//   idle timeout (per-request timeout); an idle connection closed; nothing listening after stop().
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

const JOB = "6f1c2b9e-3d4a-4b8c-9e7f-0a1b2c3d4e5f";
const USER = 4242;

/** Sends raw bytes, returns the first response line (or "closed" / "timeout"). */
function rawRequest(port, text, { host = "127.0.0.1", waitMs = 5000 } = {}) {
	return new Promise((done) => {
		const socket = connect({ host, port });
		let data = "";
		const finish = (value) => {
			clearTimeout(timer);
			socket.destroy();
			done(value);
		};
		const timer = setTimeout(() => finish(data ? data.split("\r\n")[0] : "timeout"), waitMs);
		socket.on("connect", () => socket.write(text));
		socket.on("data", (chunk) => {
			data += chunk.toString("latin1");
			if (data.includes("\r\n")) finish(data.split("\r\n")[0]);
		});
		socket.on("error", (error) => finish(`error ${error.code ?? error.message}`));
		socket.on("close", () => finish(data ? data.split("\r\n")[0] : "closed"));
	});
}

/** Opens a connection that sends nothing and resolves with how long the server kept it open (ms), or -1. */
function idleClose(port, limitMs) {
	return new Promise((done) => {
		const started = Date.now();
		const socket = connect({ host: "127.0.0.1", port });
		const timer = setTimeout(() => {
			socket.destroy();
			done(-1);
		}, limitMs);
		socket.on("close", () => {
			clearTimeout(timer);
			done(Date.now() - started);
		});
		socket.on("error", () => {});
	});
}

/**
 * @param {{ createRemoteClaudeServer: Function, backend?: "bun" | "node", check: (name: string, ok: boolean, detail?: string) => void }} options
 */
export async function httpChecks({ createRemoteClaudeServer, backend, check }) {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const runner = async () => ({ state: "answered", summary: "ok" });
	const srv = await createRemoteClaudeServer({
		branch: "dev",
		users: [USER],
		runner,
		logger,
		feedTiming: { holdMs: 1500, coalesceMs: 50 },
		http: { backend, idleTimeoutSeconds: 1 },
	});
	const base = srv.localUrl;
	try {
		check("server: backend", backend === undefined || srv.backend === backend, `${srv.backend} on ${base}`);
		check("server: bound to 127.0.0.1", base.startsWith("http://127.0.0.1:"), base);

		// Not reachable on this machine's other addresses (only the tunnel can reach it).
		const lan = Object.values(networkInterfaces())
			.flat()
			.find((a) => a && a.family === "IPv4" && !a.internal);
		if (lan) {
			const line = await rawRequest(srv.port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", { host: lan.address, waitMs: 2000 });
			check("server: not listening on the LAN address", line.startsWith("error") || line === "closed" || line === "timeout", `${lan.address}: ${line}`);
		}

		const res = await fetch(`${base}/`);
		const headers = Object.fromEntries(res.headers);
		check(
			"GET / -> bare 404 with the security headers",
			res.status === 404 && (await res.text()) === "" && headers["cache-control"] === "no-store" && headers["x-content-type-options"] === "nosniff" && headers["referrer-policy"] === "no-referrer",
			`${res.status} ${JSON.stringify(headers)}`,
		);
		check("no CORS / X-Powered-By headers", !Object.keys(headers).some((h) => h.startsWith("access-control-") || h === "x-powered-by"));
		const preflight = await fetch(`${base}/v1/token`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
		check("OPTIONS preflight -> 404, no CORS", preflight.status === 404 && !preflight.headers.get("access-control-allow-origin"), String(preflight.status));

		const declared = await rawRequest(srv.port, "POST /v1/token HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 50000000\r\n\r\n");
		check("declared 50 MB body -> 413", declared.includes(" 413"), declared);

		const big = await fetch(`${base}/v1/token`, { method: "POST", headers: { "content-type": "application/json", "x-filler": "a".repeat(9000), connection: "close" }, body: "{}" });
		check("9 KB of headers -> 431", big.status === 431, String(big.status));

		const wrongType = await fetch(`${base}/v1/token`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
		check("token: wrong content type -> 401", wrongType.status === 401, String(wrongType.status));

		// Raw, on a connection of its own: a client may stop sending a body once the answer arrives.
		const payload = `{"x":"${"a".repeat(64 * 1024)}"}`;
		const tooBig = await rawRequest(
			srv.port,
			["POST /v1/token HTTP/1.1", "Host: 127.0.0.1", "Content-Type: application/json", "Transfer-Encoding: chunked", "", payload.length.toString(16), payload, "0", "", ""].join("\r\n"),
		);
		check("token: 64 KB chunked body -> 401 (over the token cap)", tooBig.includes(" 401"), tooBig);

		const pair = await fetch(`${base}/v1/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ grant: "code", sid: srv.auth.sessionId, user: USER, job: JOB, branch: "dev", code: srv.pairing.formatted }),
		});
		const token = pair.status === 200 ? (await pair.json()).access_token : undefined;
		check("pairing code -> 200 + access token", typeof token === "string", String(pair.status));
		if (token) {
			const auth = { authorization: `Bearer ${token}`, "x-tt-job": JOB };
			const unknown = await fetch(`${base}/v1/prompts/00000000000000000000000000000000`, { headers: auth });
			check("JWT: unknown prompt -> 404", unknown.status === 404, String(unknown.status));
			const otherJob = await fetch(`${base}/v1/conversations`, { headers: { ...auth, "x-tt-job": "another-job" } });
			check("JWT from another job -> 401/403", otherJob.status === 401 || otherJob.status === 403, String(otherJob.status));
			// The first poll answers at once with the cursor; the next one holds (1.5 s here) while nothing happens.
			const first = await fetch(`${base}/v1/game/poll`, { headers: auth });
			const cursor = first.status === 200 ? (await first.json()).cursor : 0;
			const started = Date.now();
			const poll = await fetch(`${base}/v1/game/poll?since=${cursor}`, { headers: auth });
			const held = Date.now() - started;
			check("long-poll held past the 1 s idle timeout -> 200", poll.status === 200 && held >= 1200, `${poll.status} after ${held} ms`);
		}

		const kept = await idleClose(srv.port, 12_000);
		check("an idle connection is closed", kept > 0, kept > 0 ? `after ${kept} ms` : "still open after 12 s");
	} finally {
		await srv.stop();
	}
	const after = await rawRequest(srv.port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", { waitMs: 2000 });
	check("stop(): nothing listens any more", after.startsWith("error") || after === "closed", after);
}
