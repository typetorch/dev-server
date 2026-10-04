/**
 * Settings from the real environment and `.env` files. `.env` files are read from each start folder and every parent
 * (the nearest file wins; real environment variables win over every file).
 *
 * Unlike the TypeTorch CLI, values are NOT copied into process.env: they stay in this private map, so child processes
 * (Claude Code, git, build tools) never inherit the Open Cloud API key or other local secrets by accident. Values are
 * never printed; only variable names and file paths are.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

/** The `.env` files from `startDir` up to the filesystem root, nearest first. */
export function dotEnvChain(startDir: string): string[] {
	const files: string[] = [];
	let dir = resolve(startDir);
	while (true) {
		const file = join(dir, ".env");
		if (existsSync(file)) files.push(file);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return files;
}

export interface Setting {
	value: string;
	/** `.env` path, or "environment". */
	source: string;
}

export class Settings {
	readonly files: string[] = [];
	private readonly values = new Map<string, Setting>();

	constructor(startDirs: string[]) {
		for (const start of startDirs) {
			for (const file of dotEnvChain(start)) {
				if (this.files.includes(file)) continue;
				this.files.push(file);
				let parsed: Record<string, string>;
				try {
					parsed = parseDotEnv(readFileSync(file, "utf8"));
				} catch {
					continue;
				}
				for (const [key, value] of Object.entries(parsed)) {
					if (!this.values.has(key) && value !== "") this.values.set(key, { value, source: file });
				}
			}
		}
	}

	get(name: string): Setting | undefined {
		const real = process.env[name]?.trim();
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

/** Open Cloud API key variables, in the TypeTorch CLI's priority order. */
export const API_KEY_VARS = ["TYPETORCH_API_KEY", "OPENCLOUD_API_KEY", "ROBLOX_API_KEY"] as const;

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
export const SCRUBBED_VARS: readonly string[] = [...API_KEY_VARS, ...API_BILLING_VARS];

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
 * process.env for a child process: without the Open Cloud API key variables, without any variable that would switch
 * Claude Code to API billing (isApiBillingVar), without anything Bun auto-loaded from a `.env` file, and (for Claude)
 * without parent-session variables. `extra` is added last (the deploy gets the Open Cloud API key this way).
 */
export function childEnv(options: { forClaude?: boolean; extra?: Record<string, string> } = {}): Record<string, string> {
	const env: Record<string, string> = {};
	const drop = new Set([...SCRUBBED_VARS, ...(options.forClaude ? PARENT_SESSION_VARS : [])]);
	const fromFiles = autoLoadedDotEnv();
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (drop.has(key) || drop.has(key.toUpperCase()) || isApiBillingVar(key)) continue;
		if (fromFiles.get(key)?.has(value)) continue;
		env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	return { ...env, ...(options.extra ?? {}) };
}
