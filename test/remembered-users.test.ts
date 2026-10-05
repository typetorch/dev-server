/** `--users` is remembered per game repo (.typetorch/remote-claude.json) and reused when omitted. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRememberedUsers, rememberUsers, REMEMBERED_FILE } from "../src/remembered-users.ts";

const root = mkdtempSync(join(tmpdir(), "tt-users-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ENTRY = resolve(import.meta.dir, "..", "src", "index.ts");

describe("remembered --users", () => {
	test("saves what was passed and reads it back", () => {
		const repo = join(root, "a");
		mkdirSync(repo, { recursive: true });
		expect(readRememberedUsers(repo)).toBeUndefined();
		rememberUsers(repo, [409950512, 111111111], new Date("2026-10-05T18:00:00Z"));
		expect(readRememberedUsers(repo)).toEqual([409950512, 111111111]);
		expect(JSON.parse(readFileSync(join(repo, REMEMBERED_FILE), "utf8")).savedAt).toBe("2026-10-05T18:00:00.000Z");
	});

	test("ignores broken or unsafe files (never a wildcard or an empty list)", () => {
		const repo = join(root, "b");
		mkdirSync(join(repo, ".typetorch"), { recursive: true });
		for (const content of ["not json", "{}", '{"users":[]}', '{"users":["*"]}', '{"users":[0]}', '{"users":[-5]}', '{"users":[1.5]}']) {
			writeFileSync(join(repo, REMEMBERED_FILE), content);
			expect(readRememberedUsers(repo)).toBeUndefined();
		}
	});

	test("without --users and nothing remembered: a clear error, exit 1", () => {
		const repo = join(root, "c");
		mkdirSync(repo, { recursive: true });
		Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
		const result = Bun.spawnSync(["bun", ENTRY, "remote-claude"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("--users is required the first time in this repo");
	});
});
