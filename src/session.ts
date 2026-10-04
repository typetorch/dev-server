/**
 * `remote-claude`: the whole session (plans/11 §1). Checks → worktree → loopback HTTP server → Quick Tunnel →
 * registration every 60 s → terminal controls. Ctrl+C (or `quit`) publishes the closed message, stops the tunnel and
 * exits; the in-memory signing key dies with the process, so every token dies too.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Announcer, closedMessage, publishMessage, registrationMessage } from "./announce";
import { GAME_TOPIC } from "./game-tools";
import { ATTACHMENT_DIR } from "./attachments";
import { checkSubscriptionAuth } from "./billing";
import { branchChannel, branchFromGit, loadGameConfig } from "./config";
import { API_KEY_VARS, Settings, childEnv } from "./env";
import { branchExists, currentBranch, ensureIgnored, ensureWorktree, repoRoot, type Worktree } from "./git";
import { addEventSecret, addSecret, consoleLogger, setEventPaths, type Logger } from "./log";
import { run } from "./proc";
import type { Runner } from "./prompts";
import { createClaudeRunner, protectedGlobs, resolveCli } from "./runner";
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
	/** A cap on Claude Code's own cost estimate per run (runs always use the Claude subscription). */
	maxBudgetUsd?: number;
	/** Extra globs Claude may not edit and whose change blocks the deploy (files your build script executes). */
	protect?: string[];
	logger?: Logger;
	/** Replaces the Claude runner (tests). */
	runner?: Runner;
	/** The claude command (default: `claude` on PATH); tests pass [bun, fake-claude.ts]. */
	claudeCommand?: string[];
	/** Copy the pairing code to the clipboard (default true). */
	clipboard?: boolean;
	/** Lifetime of each pairing code in minutes (default 180). Refresh tokens never outlive it. */
	codeTtlMinutes?: number;
	/** Clock in ms for code and refresh-token expiry (tests). */
	now?: () => number;
}

export interface RemoteClaudeSession {
	readonly sessionId: string;
	readonly branch: string;
	readonly worktree: Worktree;
	readonly server: RemoteClaudeServer;
	url(): string | undefined;
	revoke(userId: number): boolean;
	rotate(): void;
	/** Prints the pairing code again (and re-copies it to the clipboard). */
	showCode(): void;
	/** Where the pairing code is saved. */
	readonly codeFile: string;
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
	protectedGlobs(options.protect); // throws on a bad --protect glob

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

	// 2. Settings (the API key is never printed).
	const settings = new Settings([process.cwd(), repo]);
	const announce = options.announce !== false;
	const apiKey = settings.first(API_KEY_VARS);
	addSecret(apiKey?.value);
	// No .env value may reach a game client through prompt events.
	for (const value of settings.fileValues()) addEventSecret(value);
	const universeId = config.universeId ?? (Number(settings.get("UNIVERSE_ID")?.value) || undefined);
	if (announce && !apiKey) throw new Error(`no Open Cloud API key (${API_KEY_VARS.join(", ")}); it is needed to announce the session to game servers`);
	if (announce && !universeId) throw new Error(`no universe id: set "universeId" in ${config.path} or UNIVERSE_ID`);

	// 3. Tools. Claude Code must be logged in with a Claude subscription: API billing is refused (billing.ts).
	let claudeCommand = options.claudeCommand;
	let subscriptionVerified = false;
	if (!options.runner || options.claudeCommand) {
		if (!claudeCommand) {
			const claude = Bun.which("claude");
			if (!claude) throw new Error("the claude CLI is not installed (https://claude.com/claude-code)");
			claudeCommand = [claude];
		}
		const version = await run([...claudeCommand, "--version"], { cwd: repo, env: childEnv({ forClaude: true }), timeoutMs: 30_000 });
		if (version.code !== 0) throw new Error("`claude --version` failed; is Claude Code installed and logged in?");
		await checkSubscriptionAuth(claudeCommand, repo);
		subscriptionVerified = true;
		logger.info("claude: logged in with a Claude subscription (API billing is refused)");
	}
	const cloudflared = options.tunnel === false ? undefined : await findCloudflared(logger, options.installCloudflared !== false);

	// 4. Worktree.
	const worktree = await ensureWorktree(repo, gitBranch);
	logger.info(`worktree ${worktree.path} on ${worktree.workBranch}`);
	// Text relayed to game servers names files relative to the worktree, and never the repo, home folder or username.
	setEventPaths({ worktree: worktree.path, repo });
	if (worktree.workBranch !== gitBranch) {
		logger.info(`"${gitBranch}" is checked out elsewhere, so commits go to ${worktree.workBranch} (git merge ${worktree.workBranch})`);
	}
	// Attachments: <worktree>/.typetorch/attachments, git-ignored, emptied now and deleted when the session ends.
	const attachmentsDir = join(worktree.path, ...ATTACHMENT_DIR.split("/"));
	await ensureIgnored(worktree.path, `${ATTACHMENT_DIR}/`);
	rmSync(attachmentsDir, { recursive: true, force: true });
	if (options.installDeps !== false && existsSync(join(worktree.path, "package.json")) && !existsSync(join(worktree.path, "node_modules"))) {
		logger.info("installing dependencies in the worktree (bun install)…");
		const installed = await run([process.execPath, "install"], { cwd: worktree.path, env: childEnv(), timeoutMs: 10 * 60_000 });
		if (installed.code !== 0) logger.warn(`bun install failed in the worktree (exit ${installed.code}); builds may fail`);
	}

	// 5. Pairing code output: one terminal line, the clipboard and <repo>/.typetorch/remote-claude.code (git-ignored).
	// Nowhere else: it is redacted from every other log line and never announced or committed.
	const codeFile = join(repo, ".typetorch", "remote-claude.code");
	await ensureIgnored(repo, ".typetorch/remote-claude.code");
	const clock = options.now ?? Date.now;
	const codeTtlMinutes = options.codeTtlMinutes ?? 180;
	if (!(codeTtlMinutes > 0)) throw new Error("--code-ttl must be a positive number of minutes");
	const codeTtlMs = Math.round(codeTtlMinutes * 60_000);
	const publishCode = (formatted: string, expiresAt: number) => {
		try {
			mkdirSync(dirname(codeFile), { recursive: true });
			writeFileSync(codeFile, `${formatted}\nexpires ${new Date(expiresAt).toISOString()}\n`, { mode: 0o600 });
		} catch (error) {
			logger.warn(`could not save the pairing code to ${codeFile}: ${(error as Error).message}`);
		}
		if (options.clipboard !== false) void copyToClipboard(formatted);
		process.stdout.write(`pairing code: ${formatted}  (valid until ${formatClock(expiresAt, clock())}, paste it into DEV > Claude in game)\n`);
	};

	// 6. Runner + HTTP server.
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
			claudeCommand,
			subscriptionVerified,
			model: options.model,
			maxBudgetUsd: options.maxBudgetUsd,
			protect: options.protect,
		});
	const server = createRemoteClaudeServer({
		branch,
		users,
		runner,
		maxPrompts: options.maxPrompts ?? 50,
		port: options.port,
		logger,
		codeTtlMs: codeTtlMs,
		now: options.now,
		attachmentsDir,
		// Game tools: a wake message per request (no code in it); game servers also poll GET /v1/game/pending.
		publishWake: apiKey && universeId ? (message) => publishMessage(universeId, apiKey.value, GAME_TOPIC, message, logger) : undefined,
		onPairingCode: (formatted, reason, expiresAt) => {
			if (reason === "used") logger.info("pairing code used (each code pairs one user on one game server); the next code is below");
			if (reason === "expired") logger.info("pairing code expired; new code below (paired servers keep working until their refresh token expires)");
			if (reason === "tunnel") logger.warn("the tunnel restarted with a new URL: every game server must pair again with the code below");
			publishCode(formatted, expiresAt);
		},
	});
	const { auth } = server;

	// 7. Tunnel + registration. Pairing is bound to the tunnel URL: the code's fingerprint, the refresh tokens and the
	// session id all change with it (security audit H1).
	let tunnel: QuickTunnel | undefined;
	/** The URL the current session was announced with (the closed message must carry it). */
	let announcedUrl: string | undefined;
	const announcer =
		announce && apiKey && universeId
			? new Announcer({
					universeId,
					apiKey: apiKey.value,
					logger,
					current: () => {
						const url = tunnel?.url;
						if (!url || url !== auth.tunnelUrl) return undefined;
						announcedUrl = url;
						return registrationMessage(auth.sessionId, branch, auth.allowedUsers(), url);
					},
				})
			: undefined;
	let started = false;
	if (cloudflared) {
		tunnel = new QuickTunnel({
			exe: cloudflared,
			port: server.port,
			logger,
			onUrl: (url) => {
				addEventSecret(url);
				if (!started) return;
				// A restart: a new session bound to the new URL. Close the old session on game servers (with its own URL), then
				// announce the new one as soon as it is reachable.
				const oldUrl = announcedUrl;
				const previous = server.setTunnelUrl(url);
				if (previous && oldUrl && announcer) void announcer.publish(closedMessage(previous, oldUrl));
				void tunnel?.waitReachable().then(() => announcer?.announce());
			},
		});
		try {
			const url = await tunnel.start();
			// Before the code is first shown: its fingerprint covers this URL.
			server.setTunnelUrl(url);
			if (!(await tunnel.waitReachable())) logger.warn("the tunnel URL is not reachable yet; announcing anyway");
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
		get sessionId() {
			return auth.sessionId;
		},
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
		codeFile,
		rotate() {
			logger.info("rotating the signing key, refresh tokens and pairing code: every issued token is now invalid");
			server.rotateAll(); // prints the new pairing code through onPairingCode
		},
		showCode() {
			publishCode(server.pairing.formatted, server.pairing.expiresAt);
		},
		status() {
			const q = server.queue;
			const active = q.active;
			return [
				`session ${auth.sessionId.slice(0, 8)}  branch ${branch} (git ${gitBranch}, worktree on ${worktree.workBranch})`,
				`tunnel ${tunnel?.url ?? (cloudflared ? "(down)" : "(disabled)")}  announce ${announcer ? "on" : "off"}  deploy ${deploy ? (cli ? "on" : "no CLI") : "off"}`,
				`users ${auth.allowedUsers().join(", ") || "(none)"}  prompts ${q.createdCount}/${options.maxPrompts ?? 50}  queued ${q.queued.length}  running ${active ? `${active.id.slice(0, 8)} (${active.state})` : "-"}`,
				`pairing code valid for ${formatDuration(server.pairing.expiresAt - clock())} (until ${formatClock(server.pairing.expiresAt, clock())}, single use)  wrong codes ${server.lockout.total} (${server.lockout.lockedCount()} user+server pairs locked)  paired servers ${auth.refreshTokenCount()}`,
			].join("\n");
		},
		close() {
			closing ??= (async () => {
				logger.info("closing session…");
				announcer?.stop();
				const closedSent = announcer && announcedUrl ? announcer.publish(closedMessage(auth.sessionId, announcedUrl)) : Promise.resolve(false);
				await server.stop();
				tunnel?.stop();
				rmSync(codeFile, { force: true });
				if (await closedSent) logger.info("announced closed session");
				resolveClosed();
			})();
			return closing;
		},
	};

	logger.info(`remote-claude session ${auth.sessionId.slice(0, 8)} on ${branch} for roblox users ${users.join(", ")}`);
	if (options.terminal !== false) attachTerminal(session, logger);
	publishCode(server.pairing.formatted, server.pairing.expiresAt);
	return session;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local "HH:MM", with the date in front when it is not today. */
export function formatClock(at: number, now = Date.now()): string {
	const d = new Date(at);
	const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	return d.toDateString() === new Date(now).toDateString() ? time : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

/** "2 h 05 min", "12 min", "40 s". */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad2(m % 60)} min`;
}

/** Copies text to the clipboard (Windows clip.exe, macOS pbcopy; elsewhere nothing). */
export async function copyToClipboard(text: string): Promise<boolean> {
	const cmd = process.platform === "win32" ? ["clip"] : process.platform === "darwin" ? ["pbcopy"] : undefined;
	if (!cmd) return false;
	try {
		const proc = Bun.spawn(cmd, { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore", windowsHide: true });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}
