/**
 * The dev-server reads keys like the TypeTorch CLI 0.9: the environment, then the game repo's .env; --env-file /
 * TYPETORCH_ENV_FILE replace that .env; a TYPETORCH_ENV_FILE line inside it still works (the CLI 0.8 layout).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { API_KEY_VARS, childEnv, ENV_FILE_VAR, expandPath, SCRUBBED_VARS, Settings } from "../src/env";

const root = mkdtempSync(join(tmpdir(), "tt-envfile-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** repo/.env, a .env in the folder above the repo, and an env file outside the repo. */
function layout(name: string, repoEnv: string, outside: string, parentEnv = "") {
	const dir = join(root, name);
	const repo = join(dir, "repo");
	mkdirSync(join(repo, "sub"), { recursive: true });
	writeFileSync(join(repo, ".env"), repoEnv);
	if (parentEnv) writeFileSync(join(dir, ".env"), parentEnv);
	const keys = join(dir, "keys");
	mkdirSync(keys);
	const file = join(keys, "game.env");
	writeFileSync(file, outside);
	return { dir, repo, file };
}

describe("env file", () => {
	test("the game repo's .env only (no parent folder's); the environment wins over it", () => {
		const { repo } = layout("plain", "OPENCLOUD_API_KEY=from-dotenv\nUNIVERSE_ID=1\n", "", "OPENCLOUD_DEPLOY_KEY=from-parent\n");
		const s = new Settings(repo, { env: {} });
		expect(s.envFile).toBeUndefined();
		expect(s.files).toEqual([join(repo, ".env")]);
		expect(s.get("OPENCLOUD_API_KEY")).toEqual({ value: "from-dotenv", source: join(repo, ".env") });
		expect(s.get("OPENCLOUD_DEPLOY_KEY")).toBeUndefined();
		expect(new Settings(repo, { env: { OPENCLOUD_API_KEY: "from-env" } }).get("OPENCLOUD_API_KEY")).toEqual({ value: "from-env", source: "environment" });
	});

	test("--env-file replaces the .env; the environment wins over both", () => {
		const { repo, file } = layout("flag", "OPENCLOUD_API_KEY=from-dotenv\nUNIVERSE_ID=1\n", "OPENCLOUD_API_KEY=from-envfile\nOPENCLOUD_DEPLOY_KEY=deploy-envfile\n");
		const s = new Settings(repo, { envFile: file, env: {} });
		expect(s.envFile).toBe(file);
		expect(s.envFileMissing).toBe(false);
		expect(s.files).toEqual([file]);
		expect(s.get("OPENCLOUD_API_KEY")).toEqual({ value: "from-envfile", source: file });
		expect(s.get("OPENCLOUD_DEPLOY_KEY")?.value).toBe("deploy-envfile");
		expect(s.get("UNIVERSE_ID")).toBeUndefined();
		const real = new Settings(repo, { envFile: file, env: { OPENCLOUD_API_KEY: "from-env" } });
		expect(real.get("OPENCLOUD_API_KEY")).toEqual({ value: "from-env", source: "environment" });
	});

	test("TYPETORCH_ENV_FILE from the environment (relative to the working directory); --env-file wins over it", () => {
		const { repo, file } = layout("envvar", "OPENCLOUD_API_KEY=from-dotenv\n", "OPENCLOUD_API_KEY=from-envfile\n");
		const s = new Settings(repo, { env: { [ENV_FILE_VAR]: relative(process.cwd(), file) } });
		expect(s.envFile).toBe(file);
		expect(s.get("OPENCLOUD_API_KEY")?.value).toBe("from-envfile");
		const other = join(root, "envvar", "keys", "other.env");
		writeFileSync(other, "OPENCLOUD_API_KEY=from-flag\n");
		expect(new Settings(repo, { envFile: other, env: { [ENV_FILE_VAR]: file } }).get("OPENCLOUD_API_KEY")?.value).toBe("from-flag");
	});

	test("a TYPETORCH_ENV_FILE line in the game's .env (CLI 0.8 layout): that file wins, the .env fills the rest", () => {
		const { repo, file } = layout("declared", "TYPETORCH_ENV_FILE=../keys/game.env\nUNIVERSE_ID=7\n", "OPENCLOUD_API_KEY=from-envfile\n");
		const s = new Settings(repo, { env: {} });
		expect(s.envFile).toBe(file);
		expect(s.get("OPENCLOUD_API_KEY")).toEqual({ value: "from-envfile", source: file });
		expect(s.get("UNIVERSE_ID")?.value).toBe("7");
	});

	test("a missing override is reported, not fatal; it replaces the .env, so nothing is read", () => {
		const { repo } = layout("missing", "OPENCLOUD_API_KEY=from-dotenv\n", "");
		const s = new Settings(repo, { envFile: join(root, "missing", "nope.env"), env: {} });
		expect(s.envFileMissing).toBe(true);
		expect(s.get("OPENCLOUD_API_KEY")).toBeUndefined();
	});

	test("TYPETORCH_API_KEY (the backend's game key since CLI 0.9) is no Open Cloud key, and no child gets it or the admin token", () => {
		expect(API_KEY_VARS).toEqual(["OPENCLOUD_API_KEY", "ROBLOX_API_KEY"]);
		for (const name of ["TYPETORCH_API_KEY", "TYPETORCH_ADMIN_TOKEN", "TYPETORCH_FLEET_TOKEN", "TYPETORCH_FLEET_INGEST_TOKEN", "OPENCLOUD_API_KEY"]) expect(SCRUBBED_VARS).toContain(name);
	});

	test("~ expands to the home folder", () => {
		expect(expandPath("~/.config/typetorch/game.env", "/x")).toBe(join(homedir(), ".config/typetorch/game.env"));
	});

	test("env file values never reach a child process (Claude or any other)", () => {
		const { repo, file } = layout("children", "", "OPENCLOUD_API_KEY=tt-secret-from-envfile-123456\nOPENCLOUD_DEPLOY_KEY=tt-deploy-secret-654321\n");
		const s = new Settings(repo, { envFile: file });
		expect(s.get("OPENCLOUD_API_KEY")?.value).toBe("tt-secret-from-envfile-123456");
		expect(process.env.OPENCLOUD_API_KEY).not.toBe("tt-secret-from-envfile-123456");
		for (const env of [childEnv({ forClaude: true }), childEnv()]) {
			for (const value of Object.values(env)) {
				expect(value).not.toContain("tt-secret-from-envfile");
				expect(value).not.toContain("tt-deploy-secret");
			}
		}
	});
});
