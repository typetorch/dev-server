/**
 * Cloudflare Quick Tunnel (TryCloudflare): `cloudflared tunnel --url http://127.0.0.1:<port>`. No account, no login;
 * a random https://<words>.trycloudflare.com URL per run that dies with the process. The tunnel is public, so the
 * HTTP server does all of its own auth.
 *
 * cloudflared is run with an empty --config file, because a named-tunnel ~/.cloudflared/config.yml would otherwise
 * take over the quick tunnel. If it dies unexpectedly it is restarted, and the new URL is reported to `onUrl`.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "./env.ts";
import type { Logger } from "./log.ts";
import { forEachLine, killTree, run } from "./proc.ts";
import { sleep, spawnChild, which, type ChildHandle } from "./runtime.ts";

const URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/;

function candidates(): string[] {
	const list: string[] = [];
	const onPath = which("cloudflared");
	if (onPath) list.push(onPath);
	if (process.platform === "win32") {
		const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const pf = process.env.ProgramFiles ?? "C:\\Program Files";
		const local = process.env.LOCALAPPDATA ?? "";
		list.push(join(pf86, "cloudflared", "cloudflared.exe"), join(pf, "cloudflared", "cloudflared.exe"));
		if (local) list.push(join(local, "Microsoft", "WinGet", "Links", "cloudflared.exe"));
	} else {
		list.push("/usr/local/bin/cloudflared", "/opt/homebrew/bin/cloudflared", "/usr/bin/cloudflared");
	}
	return list;
}

export function locateCloudflared(): string | undefined {
	return candidates().find((path) => existsSync(path));
}

/** Finds cloudflared, installing it with winget on Windows when it is missing and `install` is set. */
export async function findCloudflared(logger: Logger, install: boolean): Promise<string> {
	const found = locateCloudflared();
	if (found) return found;
	if (!install || process.platform !== "win32") {
		throw new Error(
			"cloudflared is not installed. Windows: winget install --id Cloudflare.cloudflared -e; macOS: brew install cloudflared; " +
				"Linux: see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
		);
	}
	logger.info("cloudflared not found; installing it with winget (Cloudflare.cloudflared)…");
	const result = await run(
		["winget", "install", "--id", "Cloudflare.cloudflared", "-e", "--accept-source-agreements", "--accept-package-agreements"],
		{ cwd: process.cwd(), timeoutMs: 10 * 60_000 },
	);
	const after = locateCloudflared();
	if (!after) throw new Error(`winget install of cloudflared failed (exit ${result.code}); install it by hand and retry`);
	logger.info(`cloudflared installed at ${after}`);
	return after;
}

export interface QuickTunnelOptions {
	exe: string;
	port: number;
	logger: Logger;
	/** Called with every new public URL (first start and every restart). */
	onUrl?: (url: string) => void;
	/** How long to wait for a URL. */
	startTimeoutMs?: number;
}

export class QuickTunnel {
	private proc: ChildHandle | undefined;
	private stopping = false;
	private restarts = 0;
	private readonly configFile: string;
	private readonly recent: string[] = [];
	url: string | undefined;

	constructor(private readonly options: QuickTunnelOptions) {
		const dir = mkdtempSync(join(tmpdir(), "typetorch-cloudflared-"));
		this.configFile = join(dir, "config.yml");
		writeFileSync(this.configFile, "# empty: forces a quick tunnel even when ~/.cloudflared/config.yml exists\n");
	}

	/** Starts cloudflared and resolves with the public URL once the tunnel has a connection (or after a grace period). */
	start(): Promise<string> {
		this.stopping = false;
		return this.spawn();
	}

	private spawn(): Promise<string> {
		const { exe, port, logger } = this.options;
		const proc = spawnChild([exe, "tunnel", "--config", this.configFile, "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: childEnv(),
		});
		this.proc = proc;
		let url: string | undefined;
		let resolveUrl!: (url: string) => void;
		let rejectUrl!: (error: Error) => void;
		const ready = new Promise<string>((res, rej) => {
			resolveUrl = res;
			rejectUrl = rej;
		});
		let settled = false;
		const settle = (value: string | Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (typeof value === "string") resolveUrl(value);
			else rejectUrl(value);
		};
		let grace: ReturnType<typeof setTimeout> | undefined;
		const onLine = (line: string) => {
			this.recent.push(line);
			if (this.recent.length > 30) this.recent.shift();
			const match = URL_PATTERN.exec(line);
			if (match && !url) {
				url = match[0];
				this.url = url;
				// Wait for the first registered connection; fall back after 15 s.
				grace = setTimeout(() => settle(url!), 15_000);
			}
			if (url && /Registered tunnel connection/i.test(line)) {
				if (grace) clearTimeout(grace);
				settle(url);
			}
		};
		const timer = setTimeout(() => {
			settle(new Error(`cloudflared gave no trycloudflare.com URL in time; last output:\n${this.recent.slice(-8).join("\n")}`));
			killTree(proc);
		}, this.options.startTimeoutMs ?? 60_000);
		void forEachLine(proc.stdout, onLine);
		void forEachLine(proc.stderr, onLine);

		void proc.exited.then((code) => {
			if (grace) clearTimeout(grace);
			settle(new Error(`cloudflared exited (${code}) before the tunnel was ready; last output:\n${this.recent.slice(-8).join("\n")}`));
			if (this.stopping || this.proc !== proc) return;
			this.url = undefined;
			this.restarts += 1;
			const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.restarts - 1, 5));
			logger.warn(`cloudflared exited (${code}); restarting in ${Math.round(delay / 1000)} s`);
			setTimeout(() => {
				if (this.stopping) return;
				this.spawn()
					.then(() => {
						this.restarts = 0;
					})
					.catch((error) => logger.error((error as Error).message));
			}, delay);
		});

		return ready.then((value) => {
			logger.info(`tunnel up: ${value}`);
			this.options.onUrl?.(value);
			return value;
		});
	}

	/**
	 * Waits until the public URL reaches this server (a fresh trycloudflare.com name can take 10–20 s to resolve), so
	 * the URL is only announced once game servers can use it. `GET /` is answered by our server with a bare 404 that
	 * carries our security headers; Cloudflare's own error pages don't.
	 */
	async waitReachable(timeoutMs = 45_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && this.url) {
			try {
				const res = await fetch(`${this.url}/`, { signal: AbortSignal.timeout(8_000) });
				await res.arrayBuffer().catch(() => {});
				if (res.status === 404 && res.headers.get("referrer-policy") === "no-referrer") return true;
			} catch {}
			await sleep(1500);
		}
		return false;
	}

	stop(): void {
		this.stopping = true;
		if (this.proc) killTree(this.proc);
		this.proc = undefined;
		this.url = undefined;
	}
}
