/** The dev-server reads keys like the TypeTorch CLI: environment > --env-file / TYPETORCH_ENV_FILE > .env files. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { childEnv, ENV_FILE_VAR, expandPath, Settings } from "../src/env";

const root = mkdtempSync(join(tmpdir(), "tt-envfile-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** repo/.env, repo/sub/.env and an env file outside the repo. */
function layout(name: string, repoEnv: string, outside: string) {
	const dir = join(root, name);
	const repo = join(dir, "repo");
	mkdirSync(join(repo, "sub"), { recursive: true });
	writeFileSync(join(repo, ".env"), repoEnv);
	const keys = join(dir, "keys");
	mkdirSync(keys);
	const file = join(keys, "game.env");
	writeFileSync(file, outside);
	return { dir, repo, file };
}

describe("env file", () => {
	test("--env-file wins over .env files; the environment wins over both", () => {
		const { repo, file } = layout("flag", "TYPETORCH_API_KEY=from-dotenv\nUNIVERSE_ID=1\n", "TYPETORCH_API_KEY=from-envfile\nOPENCLOUD_DEPLOY_KEY=deploy-envfile\n");
		const s = new Settings([repo], { envFile: file, env: {} });
		expect(s.envFile).toBe(file);
		expect(s.envFileMissing).toBe(false);
		expect(s.get("TYPETORCH_API_KEY")).toEqual({ value: "from-envfile", source: file });
		expect(s.get("OPENCLOUD_DEPLOY_KEY")?.value).toBe("deploy-envfile");
		expect(s.get("UNIVERSE_ID")).toEqual({ value: "1", source: join(repo, ".env") });
		expect(s.files[0]).toBe(file);
		const real = new Settings([repo], { envFile: file, env: { TYPETORCH_API_KEY: "from-env" } });
		expect(real.get("TYPETORCH_API_KEY")).toEqual({ value: "from-env", source: "environment" });
	});

	test("TYPETORCH_ENV_FILE from the environment (relative to the working directory)", () => {
		const { repo, file } = layout("envvar", "TYPETORCH_API_KEY=from-dotenv\n", "TYPETORCH_API_KEY=from-envfile\n");
		const s = new Settings([repo], { env: { [ENV_FILE_VAR]: relative(process.cwd(), file) } });
		expect(s.envFile).toBe(file);
		expect(s.get("TYPETORCH_API_KEY")?.value).toBe("from-envfile");
		// --env-file wins over the variable.
		const other = join(root, "envvar", "keys", "other.env");
		writeFileSync(other, "TYPETORCH_API_KEY=from-flag\n");
		expect(new Settings([repo], { envFile: other, env: { [ENV_FILE_VAR]: file } }).get("TYPETORCH_API_KEY")?.value).toBe("from-flag");
	});

	test("TYPETORCH_ENV_FILE declared in the nearest .env, relative to that file", () => {
		const { repo, file } = layout("declared", "TYPETORCH_ENV_FILE=../keys/game.env\nUNIVERSE_ID=7\n", "TYPETORCH_API_KEY=from-envfile\n");
		const s = new Settings([join(repo, "sub")], { env: {} });
		expect(s.envFile).toBe(file);
		expect(s.get("TYPETORCH_API_KEY")).toEqual({ value: "from-envfile", source: file });
		expect(s.get("UNIVERSE_ID")?.value).toBe("7");
	});

	test("a missing env file is reported, not fatal; .env files still apply", () => {
		const { repo } = layout("missing", "TYPETORCH_API_KEY=from-dotenv\n", "");
		const s = new Settings([repo], { envFile: join(root, "missing", "nope.env"), env: {} });
		expect(s.envFileMissing).toBe(true);
		expect(s.get("TYPETORCH_API_KEY")?.value).toBe("from-dotenv");
	});

	test("without an env file: .env files only (as before)", () => {
		const { repo } = layout("plain", "TYPETORCH_API_KEY=from-dotenv\n", "");
		const s = new Settings([repo], { env: {} });
		expect(s.envFile).toBeUndefined();
		expect(s.get("TYPETORCH_API_KEY")?.value).toBe("from-dotenv");
	});

	test("~ expands to the home folder", () => {
		expect(expandPath("~/.config/typetorch/game.env", "/x")).toBe(join(homedir(), ".config/typetorch/game.env"));
	});

	test("env file values never reach a child process (Claude or any other)", () => {
		const { repo, file } = layout("children", "", "TYPETORCH_API_KEY=tt-secret-from-envfile-123456\nOPENCLOUD_DEPLOY_KEY=tt-deploy-secret-654321\n");
		const s = new Settings([repo], { envFile: file });
		expect(s.get("TYPETORCH_API_KEY")?.value).toBe("tt-secret-from-envfile-123456");
		expect(process.env.TYPETORCH_API_KEY).not.toBe("tt-secret-from-envfile-123456");
		for (const env of [childEnv({ forClaude: true }), childEnv()]) {
			for (const value of Object.values(env)) {
				expect(value).not.toContain("tt-secret-from-envfile");
				expect(value).not.toContain("tt-deploy-secret");
			}
		}
	});
});
