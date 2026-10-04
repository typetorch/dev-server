/**
 * `remote-claude`: the whole session (plans/11 §1). Checks → worktree → loopback HTTP server → Quick Tunnel →
 * registration every 60 s → terminal controls. Ctrl+C (or `quit`) publishes the closed message, stops the tunnel and
 * exits; the in-memory signing key dies with the process, so every token dies too.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Announcer, closedMessage, registrationMessage } from "./announce";
import { branchChannel, branchFromGit, loadGameConfig } from "./config";
import { API_KEY_VARS, SECRET_VAR, Settings, childEnv } from "./env";
import { branchExists, currentBranch, ensureWorktree, repoRoot, type Worktree } from "./git";
import { addSecret, consoleLogger, type Logger } from "./log";
import { run } from "./proc";
import type { Runner } from "./prompts";
import { createClaudeRunner, resolveCli } from "./runner";
import { secretStrengthError } from "./secret";
import { createRemoteClaudeServer, type RemoteClaudeServer } from "./server";
import { attachTerminal } from "./terminal";
import { QuickTunnel, findCloudflared } from "./tunnel";

export interface RemoteClaudeOptions {
	/** Roblox user ids allowed to prompt. Required; no default, no wildcard. */
	users: number[];
	/** The game repo (default: cwd). */
	repo?: string;
	/** Git branch (default: the repo's current branch). Must map to a dev-channel TypeTorch branch. */
	branch?: string;
	port?: number;
	maxPrompts?: number;
	/** false = stop after the commit. */
	deploy?: boolean;
	/** Path to the TypeTorch CLI entry (or binary). */
	cli?: string;
	/** false = no tunnel (local only, for testing). */
	tunnel?: boolean;
	/** false = never publish registration messages (testing). */
	announce?: boolean;
	/** Install cloudflared with winget when missing (default true). */
	installCloudflared?: boolean;
	/** Run `bun install` in a fresh worktree that has a package.json but no node_modules (default true). */
	installDeps?: boolean;
	/** Read terminal commands from stdin (default true). */
	terminal?: boolean;
	model?: string;
	maxBudgetUsd?: number;
	logger?: Logger;
	/** Replaces the Claude runner (tests). */
	runner?: Runner;
}

export interface RemoteClaudeSession {
	readonly sessionId: string;
	readonly branch: string;
	readonly worktree: Worktree;
	readonly server: RemoteClaudeServer;
	url(): string | undefined;
	revoke(userId: number): boolean;
	rotate(): void;
	status(): string;
	/** Publishes the closed message, stops the tunnel and the server. Idempotent. */
	close(): Promise<void>;
	/** Resolves when the session has closed. */
	readonly closed: Promise<void>;
}

export async function startRemoteClaude(options: RemoteClaudeOptions): Promise<RemoteClaudeSession> {
	const logger = options.logger ?? consoleLogger();
	const users = [...new Set(options.users)];
	if (users.length === 0) throw new Error("--users is required (Roblox user ids, comma-separated; no default, no wildcard)");

	// 1. Repo, branch, channel.
	const repo = await repoRoot(resolve(options.repo ?? process.cwd()));
	const config = loadGameConfig(repo);
	const gitBranch = options.branch ?? (await currentBranch(repo));
	if (!(await branchExists(repo, gitBranch))) throw new Error(`git branch "${gitBranch}" does not exist in ${repo}`);
	const branch = branchFromGit(gitBranch, config.branches);
	const channel = branchChannel(config, branch);
	if (channel !== "dev") {
		throw new Error(`branch "${branch}" (git "${gitBranch}") is on the ${channel} channel; remote-claude only runs on dev-channel branches (no override)`);
	}

	// 2. Secrets (never printed).
	const settings = new Settings([process.cwd(), repo]);
	const secret = settings.get(SECRET_VAR);
	const weakness = secretStrengthError(secret?.value);
	if (weakness) throw new Error(weakness);
	addSecret(secret!.value);
	const announce = options.announce !== false;
	const apiKey = settings.first(API_KEY_VARS);
	addSecret(apiKey?.value);
	const universeId = config.universeId ?? (Number(settings.get("UNIVERSE_ID")?.value) || undefined);
	if (announce && !apiKey) throw new Error(`no Open Cloud API key (${API_KEY_VARS.join(", ")}); it is needed to announce the session to game servers`);
	if (announce && !universeId) throw new Error(`no universe id: set "universeId" in ${config.path} or UNIVERSE_ID`);

	// 3. Tools.
	if (!options.runner) {
		const claude = Bun.which("claude");
		if (!claude) throw new Error("the claude CLI is not installed (https://claude.com/claude-code)");
		const version = await run([claude, "--version"], { cwd: repo, env: childEnv({ forClaude: true }), timeoutMs: 30_000 });
		if (version.code !== 0) throw new Error("`claude --version` failed; is Claude Code installed and logged in?");
	}
	const cloudflared = options.tunnel === false ? undefined : await findCloudflared(logger, options.installCloudflared !== false);

	// 4. Worktree.
	const worktree = await ensureWorktree(repo, gitBranch);
	logger.info(`worktree ${worktree.path} on ${worktree.workBranch}`);
	if (worktree.workBranch !== gitBranch) {
		logger.info(`"${gitBranch}" is checked out elsewhere, so commits go to ${worktree.workBranch} (git merge ${worktree.workBranch})`);
	}
	if (options.installDeps !== false && existsSync(join(worktree.path, "package.json")) && !existsSync(join(worktree.path, "node_modules"))) {
		logger.info("installing dependencies in the worktree (bun install)…");
		const installed = await run([process.execPath, "install"], { cwd: worktree.path, env: childEnv(), timeoutMs: 10 * 60_000 });
		if (installed.code !== 0) logger.warn(`bun install failed in the worktree (exit ${installed.code}); builds may fail`);
	}

	// 5. Runner + HTTP server.
	const cli = resolveCli(options.cli);
	const deploy = options.deploy !== false;
	if (deploy && !cli) logger.warn("TypeTorch CLI not found; prompts will stop at \"committed\" (pass --cli <path>)");
	const runner =
		options.runner ??
		createClaudeRunner({
			worktree,
			ttBranch: branch,
			deploy,
			cli,
			deployEnv: apiKey ? { [apiKey.name]: apiKey.value } : undefined,
			model: options.model,
			maxBudgetUsd: options.maxBudgetUsd,
		});
	const server = createRemoteClaudeServer({
		secret: secret!.value,
		branch,
		users,
		runner,
		maxPrompts: options.maxPrompts ?? 50,
		port: options.port,
		logger,
	});
	const { auth } = server;

	// 6. Tunnel + registration.
	let tunnel: QuickTunnel | undefined;
	const announcer =
		announce && apiKey && universeId
			? new Announcer({
					universeId,
					apiKey: apiKey.value,
					logger,
					current: () => (tunnel?.url ? registrationMessage(auth.sessionId, branch, auth.allowedUsers(), tunnel.url) : undefined),
				})
			: undefined;
	let started = false;
	if (cloudflared) {
		tunnel = new QuickTunnel({
			exe: cloudflared,
			port: server.port,
			logger,
			onUrl: () => {
				if (started) void announcer?.announce(); // a restart: re-announce the new URL right away
			},
		});
		try {
			await tunnel.start();
		} catch (error) {
			await server.stop();
			throw error;
		}
	}
	started = true;
	if (announcer) {
		await announcer.announce();
		announcer.start();
	}

	let resolveClosed!: () => void;
	const closedPromise = new Promise<void>((res) => (resolveClosed = res));
	let closing: Promise<void> | undefined;

	const session: RemoteClaudeSession = {
		sessionId: auth.sessionId,
		branch,
		worktree,
		server,
		closed: closedPromise,
		url: () => tunnel?.url,
		revoke(userId) {
			const ok = auth.revoke(userId);
			if (ok) {
				const cancelled = server.queue.cancelUser(userId, "revoke");
				logger.info(`revoked roblox:${userId} for this session${cancelled ? ` (cancelled ${cancelled} prompt(s))` : ""}`);
				void announcer?.announce();
			}
			return ok;
		},
		rotate() {
			auth.rotate();
			logger.info("signing key rotated: every issued token is now invalid");
		},
		status() {
			const q = server.queue;
			const active = q.active;
			return [
				`session ${auth.sessionId.slice(0, 8)}  branch ${branch} (git ${gitBranch}, worktree on ${worktree.workBranch})`,
				`tunnel ${tunnel?.url ?? (cloudflared ? "(down)" : "(disabled)")}  announce ${announcer ? "on" : "off"}  deploy ${deploy ? (cli ? "on" : "no CLI") : "off"}`,
				`users ${auth.allowedUsers().join(", ") || "(none)"}  prompts ${q.createdCount}/${options.maxPrompts ?? 50}  queued ${q.queued.length}  running ${active ? `${active.id.slice(0, 8)} (${active.state})` : "-"}`,
				`blocked IPs ${server.lockout.blockedCount()}`,
			].join("\n");
		},
		close() {
			closing ??= (async () => {
				logger.info("closing session…");
				announcer?.stop();
				const closedSent = announcer ? announcer.publish(closedMessage(auth.sessionId)) : Promise.resolve(false);
				await server.stop();
				tunnel?.stop();
				if (await closedSent) logger.info("announced closed session");
				resolveClosed();
			})();
			return closing;
		},
	};

	logger.info(`remote-claude session ${auth.sessionId.slice(0, 8)} on ${branch} for roblox users ${users.join(", ")}`);
	if (options.terminal !== false) attachTerminal(session, logger);
	return session;
}
