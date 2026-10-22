/** A prod-channel branch: refused for a public session, allowed for a local one (serve --claude) without deploys. */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../src/log";
import { startRemoteClaude } from "../src/session";

const FAKE = [process.execPath, join(import.meta.dir, "fake-claude.ts")];
const dir = mkdtempSync(join(tmpdir(), "tt-rc-prod-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const repo = join(dir, "game");
mkdirSync(repo);
writeFileSync(join(repo, "typetorch.json"), JSON.stringify({ project: "t", defaultBranch: "prod", branches: { main: "prod" } }));
const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "init");
const base = { users: [1], repo, claudeCommand: FAKE, terminal: false, clipboard: false, installDeps: false, logger: silentLogger };

test("a public session on a prod-channel branch is refused", async () => {
	await expect(startRemoteClaude({ ...base, tunnel: false, announce: true })).rejects.toThrow('is on the prod channel; remote-claude only runs on dev-channel branches here');
	await expect(startRemoteClaude({ ...base, tunnel: true, announce: false })).rejects.toThrow("only runs on dev-channel branches here");
});

test("a local session on a prod-channel branch works on remote-claude/<branch>", async () => {
	const lines: string[] = [];
	const session = await startRemoteClaude({ ...base, tunnel: false, announce: false, logger: { ...silentLogger, info: (text: string) => void lines.push(text) } });
	try {
		expect(session.branch).toBe("prod");
		expect(session.worktree.workBranch).toBe("remote-claude/main");
		expect(lines.some((line) => line.includes("local only, edits on remote-claude/main, no deploys"))).toBe(true);
		// Each allowed dev gets their own worktree, made at start.
		for (let i = 0; i < 300 && !lines.some((line) => line.includes("roblox:1: worktree")); i++) await Bun.sleep(10);
		const made = lines.find((line) => line.includes("roblox:1: worktree"));
		expect(made).toContain("game-remote-claude-1");
		expect(made).toContain("on remote-claude/main-1");
		expect(git("branch", "--list", "remote-claude/main-1").stdout.toString()).toContain("remote-claude/main-1");
	} finally {
		await session.close();
	}
});
