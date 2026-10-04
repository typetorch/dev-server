/**
 * Settings from the real environment and `.env` files. `.env` files are read from each start folder and every parent
 * (the nearest file wins; real environment variables win over every file).
 *
 * Unlike the TypeTorch CLI, values are NOT copied into process.env: they stay in this private map, so child processes
 * (Claude Code, git, build tools) never inherit the exchange secret or the Open Cloud API key by accident. Values are
 * never printed; only variable names and file paths are.
 */
import { existsSync, readFileSync } from "node:fs";
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
export const SECRET_VAR = "TYPETORCH_REMOTE_CLAUDE_SECRET";

/** Variables never passed to Claude Code or git (they would be readable by anything those processes run). */
export const SCRUBBED_VARS = [SECRET_VAR, ...API_KEY_VARS];

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

/** process.env without the secret variables (and, for Claude, without parent-session variables). */
export function childEnv(options: { forClaude?: boolean; extra?: Record<string, string> } = {}): Record<string, string> {
	const env: Record<string, string> = {};
	const drop = new Set([...SCRUBBED_VARS, ...(options.forClaude ? PARENT_SESSION_VARS : [])]);
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (drop.has(key) || drop.has(key.toUpperCase())) continue;
		env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	return { ...env, ...(options.extra ?? {}) };
}
