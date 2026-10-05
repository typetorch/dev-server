#!/usr/bin/env node
/**
 * typetorch-dev-server remote-claude --users 1,2,56 [--repo <dir>] [--branch <name>] [--port <n>]
 *                                    [--max-prompts 50] [--no-deploy] [--cli <path>]
 * Prints a pairing code; a dev pastes it into DEV > Claude in game to pair that game server with this session.
 */
import { consoleLogger } from "./log.ts";
import { isMainModule } from "./runtime.ts";
import { resolve } from "node:path";
import { ensureIgnored, repoRoot } from "./git.ts";
import { readRememberedUsers, rememberUsers } from "./remembered-users.ts";
import { startRemoteClaude } from "./session.ts";

const USAGE = `typetorch-dev-server remote-claude: prompt Claude Code on this machine from inside a live Roblox dev server.

Usage:
  typetorch-dev-server remote-claude --users <id,id,...> [options]

It prints a pairing code (also copied to the clipboard and saved to <repo>/.typetorch/remote-claude.code).
Paste it into DEV > Claude in game to pair the server you are in. Each code pairs one user on one server once;
the next code is printed as soon as one is used.

In game, Live mode (default) acts on your running server (run_luau with your approval); Code mode edits the branch,
and you deploy or discard each change from the chat.

remote-claude only runs on your Claude subscription (claude auth login with your Claude.ai account); API keys,
ANTHROPIC_* variables, Bedrock, Vertex and Foundry are refused.

Options:
  --users <ids>          Roblox user ids allowed to prompt (no default, no wildcard). Required the first time in a
                         repo; remembered in .typetorch/remote-claude.json and reused when omitted
  --repo <dir>           the game repo (default: current directory)
  --branch <name>        git branch (default: the current branch); must map to a dev-channel branch
  --port <n>             local port (default: a random free port; always bound to 127.0.0.1)
  --max-prompts <n>      prompts accepted per session (default 50)
  --no-deploy            stop after the commit
  --cli <path>           TypeTorch CLI used for "deploy" (default: a CLI next to this package, then typetorch on PATH)
  --env-file <path>      env file with the Open Cloud API key (default: TYPETORCH_ENV_FILE, as the TypeTorch CLI;
                         the environment wins over it, it wins over .env files; Claude never sees its values)
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

const VALUE_FLAGS = new Set(["users", "repo", "branch", "port", "max-prompts", "cli", "env-file", "model", "max-budget-usd", "protect", "code-ttl"]);

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


	// --users once per game repo: the list is remembered in <repo>/.typetorch/remote-claude.json and reused next time.
	const repo = await repoRoot(resolve((flags.get("repo") as string | undefined) ?? process.cwd()));
	const usersFlag = flags.get("users");
	let users: number[];
	if (typeof usersFlag === "string") {
		users = parseUsers(usersFlag);
		rememberUsers(repo, users);
		await ensureIgnored(repo, ".typetorch/remote-claude.json");
	} else {
		const remembered = readRememberedUsers(repo);
		if (!remembered) throw new Error("--users is required the first time in this repo, e.g. --users 1,2,56 (no default, no wildcard; it's remembered after that)");
		users = remembered;
		console.log(`users ${users.join(",")} (remembered; pass --users to change)`);
	}
	const port = positive(flags, "port");
	const session = await startRemoteClaude({
		users,
		repo: flags.get("repo") as string | undefined,
		branch: flags.get("branch") as string | undefined,
		port,
		maxPrompts: positive(flags, "max-prompts"),
		deploy: !flags.has("no-deploy"),
		cli: flags.get("cli") as string | undefined,
		envFile: flags.get("env-file") as string | undefined,
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

if (isMainModule(import.meta)) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(`error: ${(error as Error).message}`);
			process.exit(1);
		},
	);
}
