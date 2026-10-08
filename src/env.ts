/**
 * Settings from the real environment and the game repo's `.env` (`--env-file` / TYPETORCH_ENV_FILE replace it), as the
 * TypeTorch CLI 0.9 reads them; real environment variables win over the file.
 *
 * As in the TypeTorch CLI, values are NOT copied into process.env: they stay in this private map, so child processes
 * (Claude Code, git, build tools) never inherit the Open Cloud API key or other local secrets by accident. Values are
 * never printed; only variable names and file paths are.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { bunExecutable } from "./runtime.ts";

export function parseDotEnv(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2];
		const quote = value[0];
		if ((quote === '"' || quote === "'" || quote === "`") && value.lastIndexOf(quote) > 0) {
			value = value.slice(1, value.lastIndexOf(quote));
		} else {
			value = value.replace(/\s+#.*$/, "").trim();
		}
		values[match[1]] = value;
	}
	return values;
}

export interface Setting {
	value: string;
	/** Env file or `.env` path, or "environment". */
	source: string;
}

/** The env file the TypeTorch CLI reads keys from (recommended: outside the repo, e.g. ~/.config/typetorch/<game>.env). */
export const ENV_FILE_VAR = "TYPETORCH_ENV_FILE";

/** `~/x` → home; relative paths against `base` (as the CLI's expandPath). */
export function expandPath(path: string, base: string): string {
	if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(1));
	return isAbsolute(path) ? path : resolve(base, path);
}

function readEnvFile(file: string): Record<string, string> | undefined {
	try {
		return parseDotEnv(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

export interface SettingsOptions {
	/** `--env-file` (relative to the working directory); wins over TYPETORCH_ENV_FILE. */
	envFile?: string;
	/** The real environment (default process.env; tests pass their own). */
	env?: Record<string, string | undefined>;
}

/**
 * Settings with the TypeTorch CLI's sources (cli/src/env.ts, CLI 0.9), highest first:
 *   1. the real environment;
 *   2. the game repo's `.env` (the folder holding typetorch.json; no parent folder's `.env` counts any more).
 * `--env-file` or TYPETORCH_ENV_FILE from the environment (relative to the working directory) is an override: that
 * file is read INSTEAD of the game's `.env`. A `TYPETORCH_ENV_FILE=` line inside the game's `.env` (the CLI 0.8
 * layout) is still followed for one release (that file wins over the `.env`). Values from files stay in this object:
 * never copied into process.env, so no child process inherits them (only the deploy gets the keys it needs).
 */
export class Settings {
	/** Every env file read, highest priority first. */
	readonly files: string[] = [];
	/** The override (or the file a `.env` names), resolved; undefined when none is configured. */
	readonly envFile?: string;
	/** That file is configured but doesn't exist. */
	readonly envFileMissing: boolean = false;
	/** The game repo's `.env` (read unless an override replaces it). */
	readonly dotEnv: string;
	private readonly values = new Map<string, Setting>();
	private readonly real: Record<string, string | undefined>;

	/** `gameDir`: the game repo (the folder holding typetorch.json). */
	constructor(gameDir: string, options: SettingsOptions = {}) {
		this.real = options.env ?? process.env;
		this.dotEnv = join(resolve(gameDir), ".env");
		const chain: { file: string; values?: Record<string, string> }[] = [];
		let envFile: string | undefined;
		if (options.envFile?.trim()) envFile = expandPath(options.envFile.trim(), process.cwd());
		else if (this.real[ENV_FILE_VAR]?.trim()) envFile = expandPath(this.real[ENV_FILE_VAR]!.trim(), process.cwd());
		else {
			if (existsSync(this.dotEnv)) chain.push({ file: this.dotEnv, values: readEnvFile(this.dotEnv) });
			const declared = chain[0]?.values?.[ENV_FILE_VAR]?.trim();
			if (declared) envFile = expandPath(declared, dirname(this.dotEnv));
		}
		this.envFile = envFile;
		const sources: { file: string; values?: Record<string, string> }[] = [];
		if (envFile) {
			if (existsSync(envFile)) sources.push({ file: envFile, values: readEnvFile(envFile) });
			else this.envFileMissing = true;
		}
		sources.push(...chain);
		for (const { file, values } of sources) {
			if (!values || this.files.includes(file)) continue;
			this.files.push(file);
			for (const [key, value] of Object.entries(values)) {
				if (!this.values.has(key) && value !== "") this.values.set(key, { value, source: file });
			}
		}
	}

	get(name: string): Setting | undefined {
		const real = this.real[name]?.trim();
		if (real) return { value: real, source: "environment" };
		return this.values.get(name);
	}

	/** Every value read from a `.env` file (never printed; used to keep them out of prompt events). */
	fileValues(): string[] {
		return [...this.values.values()].map((setting) => setting.value);
	}

	first(names: readonly string[]): (Setting & { name: string }) | undefined {
		for (const name of names) {
			const found = this.get(name);
			if (found) return { ...found, name };
		}
		return undefined;
	}
}

/** Open Cloud API key variables, in the TypeTorch CLI's priority order (CLI 0.9: TYPETORCH_API_KEY is not one). */
export const API_KEY_VARS = ["OPENCLOUD_API_KEY", "ROBLOX_API_KEY"] as const;

/**
 * The TypeTorch backend's secrets (the CLI's backend.ts): the game key, the admin token and their CLI 0.8 names. The
 * dev-server never uses them; they are scrubbed from every child (Claude, git, the deploy).
 */
export const BACKEND_SECRET_VARS = ["TYPETORCH_API_KEY", "TYPETORCH_ADMIN_TOKEN", "TYPETORCH_FLEET_TOKEN", "TYPETORCH_FLEET_INGEST_TOKEN"] as const;

/**
 * remote-claude only runs on the dev's Claude subscription (claude.ai login), never on pay-per-token API billing.
 * These variables would make Claude Code bill an API account or a cloud provider instead (or route its traffic
 * elsewhere), so no child process ever gets them. Any other ANTHROPIC_* variable is dropped too.
 */
export const API_BILLING_VARS: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"ANTHROPIC_VERTEX_PROJECT_ID",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"AWS_BEARER_TOKEN_BEDROCK",
];

/** True for variables that select API billing or another provider (API_BILLING_VARS, ANTHROPIC_*, CLAUDE_CODE_USE_*). */
export function isApiBillingVar(name: string): boolean {
	const upper = name.toUpperCase();
	return API_BILLING_VARS.includes(upper) || upper.startsWith("ANTHROPIC_") || upper.startsWith("CLAUDE_CODE_USE_");
}

/** Variables never passed to Claude Code or git (they would be readable by anything those processes run). */
/** The CLI's per-job Open Cloud keys (cli env.ts): passed to deploys only. */
export const DEPLOY_SECRET_VARS = ["OPENCLOUD_ASSETS_KEY", "OPENCLOUD_DEPLOY_KEY", "OPENCLOUD_PLACE_KEY"] as const;

/**
 * The CLI's prod signing keys (CLI 0.5, plans/03 "Signed prod messages and heads"): the key file paths, plus CLI 0.2-0.3
 * leftovers. remote-claude only deploys dev-channel branches, which are never signed, so neither Claude nor the deploy
 * it runs ever gets one of these (not even the paths).
 */
export const SIGNING_KEY_VARS = ["TYPETORCH_KEY_FILE", "TYPETORCH_FALLBACK_KEY_FILE", "TYPETORCH_SIGNING_KEY", "TYPETORCH_ALLOW_ENV_SIGNING_KEY"] as const;

export const SCRUBBED_VARS: readonly string[] = [...API_KEY_VARS, ...DEPLOY_SECRET_VARS, ...BACKEND_SECRET_VARS, ...SIGNING_KEY_VARS, ...API_BILLING_VARS];

/**
 * Variables that tie a process to the Claude Code session that launched this server (set when the dev server itself
 * is started from inside Claude Code). The headless Claude run must be its own session, so they are dropped.
 */
const PARENT_SESSION_VARS = [
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_HOST_SESSION_ID",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_MESSAGING_SOCKET",
	"CLAUDE_CODE_MESSAGING_TOKEN",
	"CLAUDE_CODE_SSE_PORT",
	"CLAUDE_PID",
];

let autoLoaded: Map<string, Set<string>> | undefined;

/**
 * Bun loads `.env`, `.env.local`, `.env.<NODE_ENV>`... from the working directory into process.env on its own. Those
 * values are the dev's local secrets (API keys, tokens), not environment, so child processes must not inherit them.
 * Returns key → values found in the working directory's `.env*` files.
 */
function autoLoadedDotEnv(): Map<string, Set<string>> {
	if (autoLoaded) return autoLoaded;
	autoLoaded = new Map();
	let names: string[] = [];
	try {
		names = readdirSync(process.cwd()).filter((name) => /^\.env(\..+)?$/.test(name));
	} catch {}
	for (const name of names) {
		try {
			for (const [key, value] of Object.entries(parseDotEnv(readFileSync(join(process.cwd(), name), "utf8")))) {
				if (!autoLoaded.has(key)) autoLoaded.set(key, new Set());
				autoLoaded.get(key)!.add(value);
			}
		} catch {}
	}
	return autoLoaded;
}

/**
 * The only variables a Claude run (and every command it starts) receives: what the OS, git, Bun and Claude Code need
 * to run and find the dev's claude.ai login. An allowlist, not a denylist, so a secret under an unexpected name never
 * reaches a process that game data can steer (security audit C1/H2). Compared case-insensitively (Windows).
 */
const CLAUDE_ENV_ALLOW = new Set([
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"WINDIR",
	"COMSPEC",
	"TEMP",
	"TMP",
	"TMPDIR",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"COMMONPROGRAMW6432",
	"USERNAME",
	"USERDOMAIN",
	"COMPUTERNAME",
	"OS",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"NUMBER_OF_PROCESSORS",
	"LANG",
	"LC_ALL",
	"TERM",
	"SHELL",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_CODE_GIT_BASH_PATH",
	"BUN_INSTALL",
]);

/**
 * process.env for a child process.
 * - Claude (`forClaude`): only CLAUDE_ENV_ALLOW, minus anything Bun auto-loaded from a `.env` file.
 * - Others (git, the tunnel, the deploy): everything except the Open Cloud API key variables, any variable that would
 *   switch Claude Code to API billing (isApiBillingVar) and anything Bun auto-loaded from a `.env` file.
 * `extra` is added last (the deploy gets the Open Cloud API key this way).
 */
export function childEnv(options: { forClaude?: boolean; extra?: Record<string, string> } = {}): Record<string, string> {
	const env: Record<string, string> = {};
	const drop = new Set([...SCRUBBED_VARS, ...(options.forClaude ? PARENT_SESSION_VARS : [])]);
	const fromFiles = autoLoadedDotEnv();
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		// TT_FAKE_*: the test suite's fake claude is configured through these (no secrets use the prefix).
		if (options.forClaude && !CLAUDE_ENV_ALLOW.has(key.toUpperCase()) && !key.startsWith("TT_FAKE_")) continue;
		if (drop.has(key) || drop.has(key.toUpperCase()) || isApiBillingVar(key)) continue;
		if (fromFiles.get(key)?.has(value)) continue;
		env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	// Claude's one allowed command is `bun run build`: make sure `bun` resolves to the Bun running this server (under
	// Node: the bun on PATH).
	const bun = options.forClaude ? bunExecutable() : undefined;
	if (bun) prependPath(env, dirname(bun));
	return { ...env, ...(options.extra ?? {}) };
}

/** Puts `dir` first on PATH (whatever case the variable has, as on Windows), unless it is already there. */
export function prependPath(env: Record<string, string>, dir: string): void {
	const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
	const parts = (env[key] ?? "").split(delimiter).filter(Boolean);
	const same = (a: string) => (process.platform === "win32" ? a.toLowerCase() === dir.toLowerCase() : a === dir);
	if (parts.some(same)) return;
	env[key] = [dir, ...parts].join(delimiter);
}
