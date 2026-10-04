/**
 * The game repo's `typetorch.json`, read leniently (only the fields remote-claude needs). Branch and channel rules
 * match the TypeTorch CLI (cli/src/naming.ts):
 *   - TypeTorch branch = `branches[gitBranch]`, else the git branch lowercased with "/" turned into "-";
 *   - channel = `channels[branch]`, else "prod" for `defaultBranch` (default "prod"), else "dev".
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Channel = "prod" | "dev";
export const CONFIG_FILE = "typetorch.json";
export const BRANCH_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface GameConfig {
	path: string;
	root: string;
	project?: string;
	universeId?: number;
	defaultBranch: string;
	branches: Record<string, string>;
	channels: Record<string, Channel>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) {
		return Number(value);
	}
	return undefined;
}

export function findConfigPath(start: string): string | undefined {
	let dir = resolve(start);
	while (true) {
		const file = join(dir, CONFIG_FILE);
		if (existsSync(file)) return file;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function loadGameConfig(start: string): GameConfig {
	const path = findConfigPath(start);
	if (!path) throw new Error(`no ${CONFIG_FILE} in ${resolve(start)} or a parent folder; run inside a TypeTorch game repo (or pass --repo)`);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	if (!isRecord(raw)) throw new Error(`${path} must hold a JSON object`);
	const defaultBranch = typeof raw.defaultBranch === "string" && raw.defaultBranch ? raw.defaultBranch : "prod";
	const branches: Record<string, string> = {};
	if (isRecord(raw.branches)) for (const [git, branch] of Object.entries(raw.branches)) if (typeof branch === "string") branches[git] = branch;
	const channels: Record<string, Channel> = {};
	if (isRecord(raw.channels)) {
		for (const [branch, channel] of Object.entries(raw.channels)) {
			if (channel === "prod" || channel === "dev") channels[branch] = channel;
			else throw new Error(`${path}: "channels.${branch}" must be "prod" or "dev"`);
		}
	}
	return {
		path,
		root: dirname(path),
		project: typeof raw.project === "string" ? raw.project : undefined,
		universeId: positiveInt(raw.universeId),
		defaultBranch,
		branches,
		channels,
	};
}

export function branchFromGit(gitBranch: string, mapping: Record<string, string>): string {
	return mapping[gitBranch] ?? gitBranch.toLowerCase().replace(/\//g, "-");
}

export function branchChannel(config: Pick<GameConfig, "defaultBranch" | "channels">, branch: string): Channel {
	return config.channels[branch] ?? (branch === config.defaultBranch ? "prod" : "dev");
}
