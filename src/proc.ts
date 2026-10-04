/** Child process helpers: run-to-completion, line streaming and whole-tree kill (Windows needs taskkill /T). */
import { childEnv } from "./env";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function run(
	cmd: string[],
	options: { cwd: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<RunResult> {
	const proc = Bun.spawn(cmd, {
		cwd: options.cwd,
		env: options.env ?? childEnv(),
		stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	if (options.timeoutMs) timer = setTimeout(() => killTree(proc), options.timeoutMs);
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (timer) clearTimeout(timer);
	return { code, stdout, stderr };
}

/** Kills a process and everything it started. */
export function killTree(proc: { pid: number; kill(signal?: number | NodeJS.Signals): void; exitCode: number | null }): void {
	if (proc.exitCode !== null) return;
	if (process.platform === "win32") {
		try {
			Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
		} catch {}
	}
	try {
		proc.kill("SIGKILL");
	} catch {}
}

/** Calls `onLine` for every line of a byte stream (handles CRLF and partial chunks). */
export async function forEachLine(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (line) onLine(line);
		}
	}
	buffer += decoder.decode();
	if (buffer.trim()) onLine(buffer.replace(/\r$/, ""));
}
