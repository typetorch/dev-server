/** The HTTP server contract (scripts/http-check.mjs) on Bun.serve and on the node:http adapter (what Node runs). */
import { describe, expect, test } from "bun:test";
// @ts-expect-error: a plain .mjs script (also run by scripts/smoke.mjs under Node, against dist/)
import { httpChecks } from "../scripts/http-check.mjs";
import { createRemoteClaudeServer } from "../src/server";

describe("HTTP server", () => {
	for (const backend of ["bun", "node"] as const) {
		test(
			`${backend}: loopback, headers, caps, timeouts, stop`,
			async () => {
				const failed: string[] = [];
				await httpChecks({
					createRemoteClaudeServer,
					backend,
					check: (name: string, ok: boolean, detail = "") => {
						if (!ok) failed.push(`${name}: ${detail}`);
					},
				});
				expect(failed).toEqual([]);
			},
			30_000,
		);
	}
});
