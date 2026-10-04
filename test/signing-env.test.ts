/** The CLI's prod signing key variables never reach Claude or the dev deploys this server runs (plans/03, CLI 0.5). */
import { describe, expect, test } from "bun:test";
import { childEnv, SCRUBBED_VARS, SIGNING_KEY_VARS } from "../src/env";

describe("signing key variables are scrubbed", () => {
	test("from Claude's env and from the deploy's env, even when set in the real environment", () => {
		const names = [...SIGNING_KEY_VARS];
		expect(names).toEqual(["TYPETORCH_KEY_FILE", "TYPETORCH_FALLBACK_KEY_FILE", "TYPETORCH_SIGNING_KEY", "TYPETORCH_ALLOW_ENV_SIGNING_KEY"]);
		for (const name of names) expect(SCRUBBED_VARS).toContain(name);
		const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
		try {
			for (const n of names) process.env[n] = `/somewhere/${n.toLowerCase()}`;
			for (const env of [childEnv(), childEnv({ forClaude: true }), childEnv({ extra: { TYPETORCH_STATE_DIR: "/state" } })]) {
				for (const n of names) expect(env[n]).toBeUndefined();
			}
		} finally {
			for (const n of names) if (saved[n] === undefined) delete process.env[n];
			else process.env[n] = saved[n];
		}
	});
});
