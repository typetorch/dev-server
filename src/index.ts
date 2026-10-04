#!/usr/bin/env bun
/**
 * typetorch-dev-server remote-claude --users 1,2,56 [--repo <dir>] [--branch <name>] [--port <n>]
 *                                    [--max-prompts 50] [--no-deploy] [--cli <path>]
 * typetorch-dev-server remote-claude --init-secret [--env-file <path>]
 */
import { resolve } from "node:path";
import { consoleLogger } from "./log";
import { CREATOR_HUB_STEPS, defaultEnvFile, initSecret } from "./secret";
import { startRemoteClaude } from "./session";

const USAGE = `typetorch-dev-server remote-claude: prompt Claude Code on this machine from inside a live Roblox dev server.

Usage:
  typetorch-dev-server remote-claude --users <id,id,...> [options]
  typetorch-dev-server remote-claude --init-secret [--env-file <path>]

Options:
  --users <ids>          Roblox user ids allowed to prompt (required; no default, no wildcard)
  --repo <dir>           the game repo (default: current directory)
  --branch <name>        git branch (default: the current branch); must map to a dev-channel branch
  --port <n>             local port (default: a random free port; always bound to 127.0.0.1)
  --max-prompts <n>      prompts accepted per session (default 50)
  --no-deploy            stop after the commit
  --cli <path>           TypeTorch CLI entry used for "deploy" (default: ../cli/src/index.ts, then typetorch on PATH)
  --model <name>         Claude model for the runs (default: your Claude Code default)
  --max-budget-usd <n>   per-run spend cap passed to claude
  --no-announce          do not publish the session to game servers (local testing)
  --no-install           do not bun install in a fresh worktree
  --init-secret          add TYPETORCH_REMOTE_CLAUDE_SECRET to a .env (never printed) and show the Roblox steps
  --env-file <path>      the .env --init-secret writes (default: the nearest .env above the current directory)

Terminal commands while running: revoke <userId>, users, rotate, status, cancel <promptId>, quit (or Ctrl+C).`;

interface Parsed {
	command?: string;
	flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["users", "repo", "branch", "port", "max-prompts", "cli", "env-file", "model", "max-budget-usd"]);

function parseArgs(argv: string[]): Parsed {
	const flags = new Map<string, string | true>();
	let command: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
			if (VALUE_FLAGS.has(name)) {
				const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
				if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
				flags.set(name, value);
			} else if (eq >= 0) throw new Error(`--${name} takes no value`);
			else flags.set(name, true);
		} else if (arg === "-h") flags.set("help", true);
		else if (!command) command = arg;
		else throw new Error(`unexpected argument "${arg}"`);
	}
	return { command, flags };
}

export function parseUsers(text: string): number[] {
	const ids = text.split(",").map((part) => part.trim()).filter(Boolean);
	if (ids.length === 0) throw new Error("--users needs at least one Roblox user id");
	return ids.map((id) => {
		if (!/^[1-9]\d{0,18}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error(`--users: "${id}" is not a Roblox user id (no wildcards)`);
		return Number(id);
	});
}

function positive(flags: Map<string, string | true>, name: string): number | undefined {
	const value = flags.get(name);
	if (value === undefined) return undefined;
	const n = Number(value);
	if (typeof value !== "string" || !Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
	return n;
}

const KNOWN = new Set([...VALUE_FLAGS, "no-deploy", "no-announce", "no-install", "init-secret", "help"]);

async function main(argv: string[]): Promise<number> {
	const { command, flags } = parseArgs(argv);
	for (const name of flags.keys()) if (!KNOWN.has(name)) throw new Error(`unknown option --${name}`);
	if (flags.has("help") || (!command && !flags.has("init-secret"))) {
		console.log(USAGE);
		return 0;
	}
	if (command && command !== "remote-claude") throw new Error(`unknown command "${command}"`);

	if (flags.has("init-secret")) {
		const envFile = typeof flags.get("env-file") === "string" ? resolve(flags.get("env-file") as string) : defaultEnvFile();
		const result = initSecret(envFile);
		if (result.status === "added") console.log(`Added TYPETORCH_REMOTE_CLAUDE_SECRET (48 random bytes, base64url) to ${result.file}.`);
		else {
			console.log(`TYPETORCH_REMOTE_CLAUDE_SECRET is already set (${result.file}); nothing changed.`);
			if (result.weakness) console.log(`Warning: ${result.weakness}`);
		}
		console.log("");
		console.log(CREATOR_HUB_STEPS);
		return 0;
	}

	const usersFlag = flags.get("users");
	if (typeof usersFlag !== "string") throw new Error("--users is required, e.g. --users 1,2,56 (no default, no wildcard)");
	const port = positive(flags, "port");
	const session = await startRemoteClaude({
		users: parseUsers(usersFlag),
		repo: flags.get("repo") as string | undefined,
		branch: flags.get("branch") as string | undefined,
		port,
		maxPrompts: positive(flags, "max-prompts"),
		deploy: !flags.has("no-deploy"),
		cli: flags.get("cli") as string | undefined,
		announce: !flags.has("no-announce"),
		installDeps: !flags.has("no-install"),
		model: flags.get("model") as string | undefined,
		maxBudgetUsd: positive(flags, "max-budget-usd"),
		logger: consoleLogger(),
	});
	await session.closed;
	return 0;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(`error: ${(error as Error).message}`);
			process.exit(1);
		},
	);
}
