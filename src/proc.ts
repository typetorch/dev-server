/** Child process helpers: run-to-completion, line streaming and whole-tree kill (Windows needs taskkill /T). */
import { childEnv } from "./env.ts";
import { killTree as killProcessTree, spawnChild } from "./runtime.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Reads a byte stream (a Node Readable or a web ReadableStream) to the end as UTF-8. */
async function readText(stream: AsyncIterable<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const parts: Buffer[] = [];
	for await (const chunk of stream) parts.push(Buffer.from(chunk));
	return Buffer.concat(parts).toString("utf8");
}

export async function run(
	cmd: string[],
	options: { cwd: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<RunResult> {
	const proc = spawnChild(cmd, {
		cwd: options.cwd,
		env: options.env ?? childEnv(),
		stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	if (options.timeoutMs) timer = setTimeout(() => killTree(proc), options.timeoutMs);
	const [stdout, stderr, code] = await Promise.all([readText(proc.stdout), readText(proc.stderr), proc.exited]);
	if (timer) clearTimeout(timer);
	return { code, stdout, stderr };
}

/** Kills a process and everything it started. */
export function killTree(proc: { pid: number; kill(signal?: number | NodeJS.Signals): void; exitCode: number | null }): void {
	killProcessTree(proc);
}

/** Calls `onLine` for every line of a byte stream (handles CRLF and partial chunks). */
export async function forEachLine(stream: AsyncIterable<Uint8Array> | null, onLine: (line: string) => void): Promise<void> {
	if (!stream) return;
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
