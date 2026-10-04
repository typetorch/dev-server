#!/usr/bin/env bun
/**
 * typetorch-dev-server remote-claude --users 1,2,56 [--repo <dir>] [--branch <name>] [--port <n>]
 *                                    [--max-prompts 50] [--no-deploy] [--cli <path>]
 * Prints a pairing code; a dev pastes it into DEV > Claude in game to pair that game server with this session.
 */
import { consoleLogger } from "./log";
import { startRemoteClaude } from "./session";

const USAGE = `typetorch-dev-server remote-claude: prompt Claude Code on this machine from inside a live Roblox dev server.

Usage:
  typetorch-dev-server remote-claude --users <id,id,...> [options]

It prints a pairing code (also copied to the clipboard and saved to <repo>/.typetorch/remote-claude.code).
Paste it into DEV > Claude in game to pair the server you are in.

remote-claude only runs on your Claude subscription (claude auth login with your Claude.ai account); API keys,
ANTHROPIC_* variables, Bedrock, Vertex and Foundry are refused.

Options:
  --users <ids>          Roblox user ids allowed to prompt (required; no default, no wildcard)
  --repo <dir>           the game repo (default: current directory)
  --branch <name>        git branch (default: the current branch); must map to a dev-channel branch
  --port <n>             local port (default: a random free port; always bound to 127.0.0.1)
  --max-prompts <n>      prompts accepted per session (default 50)
  --no-deploy            stop after the commit
  --cli <path>           TypeTorch CLI entry used for "deploy" (default: ../cli/src/index.ts, then typetorch on PATH)
  --model <name>         Claude model for the runs (default: your Claude Code default)
  --max-budget-usd <n>   per-run cap on Claude Code's cost estimate (runs always use your subscription)
  --protect <globs>      extra comma-separated globs Claude may not edit (e.g. files your build script runs);
                         a change to one is committed but not deployed
  --code-ttl <minutes>   lifetime of each pairing code (default 180); a new one is printed when it expires,
                         and paired servers must pair again at most this long after pairing
  --no-announce          do not publish the session to game servers (local testing)
  --no-install           do not bun install in a fresh worktree

Terminal commands while running: code (show the pairing code again), revoke <userId>, users, rotate (new pairing code;
every token dies), status, cancel <promptId>, quit (or Ctrl+C).`;

interface Parsed {
	command?: string;
	flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["users", "repo", "branch", "port", "max-prompts", "cli", "model", "max-budget-usd", "protect", "code-ttl"]);

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

const KNOWN = new Set([...VALUE_FLAGS, "no-deploy", "no-announce", "no-install", "help"]);

async function main(argv: string[]): Promise<number> {
	const { command, flags } = parseArgs(argv);
	for (const name of flags.keys()) if (!KNOWN.has(name)) throw new Error(`unknown option --${name}`);
	if (flags.has("help") || !command) {
		console.log(USAGE);
		return 0;
	}
	if (command && command !== "remote-claude") throw new Error(`unknown command "${command}"`);


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
		codeTtlMinutes: positive(flags, "code-ttl"),
		protect: typeof flags.get("protect") === "string" ? (flags.get("protect") as string).split(",").map((g) => g.trim()).filter(Boolean) : undefined,
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
