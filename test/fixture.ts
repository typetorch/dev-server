/**
 * Creates the throwaway game repo test-fixture/game (gitignored): branches main (prod) and dev (dev channel), with dev
 * checked out, like a dev's own working copy. Re-running reuses it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const FIXTURE = resolve(import.meta.dir, "..", "test-fixture", "game");
export const FIXTURE_UNIVERSE = 10769310634;

function git(args: string[]) {
	const result = Bun.spawnSync(["git", ...args], { cwd: FIXTURE, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

export function ensureFixture(): string {
	if (existsSync(join(FIXTURE, ".git"))) return FIXTURE;
	mkdirSync(join(FIXTURE, "src"), { recursive: true });
	writeFileSync(join(FIXTURE, "README.md"), "# remote-claude fixture game\n\nA throwaway repo for the dev-server end-to-end test.\n");
	writeFileSync(
		join(FIXTURE, "typetorch.json"),
		`${JSON.stringify(
			{ project: "remote-claude-fixture", universeId: FIXTURE_UNIVERSE, defaultBranch: "prod", branches: { main: "prod" }, channels: { prod: "prod", dev: "dev" } },
			null,
			"\t",
		)}\n`,
	);
	writeFileSync(join(FIXTURE, "package.json"), `${JSON.stringify({ name: "remote-claude-fixture", private: true, scripts: { build: "echo build ok" } }, null, "\t")}\n`);
	writeFileSync(join(FIXTURE, "src", "hello.ts"), 'export const greeting = "hello";\n');
	writeFileSync(join(FIXTURE, ".gitignore"), "node_modules/\n.env\n");
	git(["init", "-q", "-b", "main"]);
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "fixture: initial commit"]);
	git(["checkout", "-q", "-b", "dev"]);
	return FIXTURE;
}

if (import.meta.main) console.log(ensureFixture());
