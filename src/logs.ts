/**
 * Log uploads from the game (POST /v1/logs): the dev menu's Logs > Upload sends the logs a dev sees (this game server's
 * log ring, the dev's own client logs, or another player's client logs) and they land on this PC as
 * `<repo>/.typetorch/logs/<UTC time>-<branch>-<job8>-<server|client|player>.log` (git-ignored). Claude is not involved:
 * no prompt, no quota, nothing reaches a run.
 *
 * The text is untrusted (player names and chat can be in it): it is cleaned (control characters and terminal escapes
 * removed) and written to the file only, never printed. The header comes from the request's checked fields and the
 * JWT (user, job, branch), never from the text.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLAYER_NAME_PATTERN } from "./schema.ts";

export const LOG_UPLOAD_LIMITS = {
	/** The JSON body (the game keeps its text under about 900 KB). */
	bodyBytes: 2 * 1024 * 1024,
	/** Uploads per user per minute. */
	perMinute: 6,
	/** Files this session writes at most. */
	perSession: 500,
} as const;

export type LogKind = "server" | "client" | "player";

export interface LogUpload {
	kind: LogKind;
	/** The dev who sent it (their Roblox username, as the game server read it). */
	uploader: string;
	/** kind "player": whose client logs these are. */
	player?: string;
	/** "<artifact id>#<generation>". */
	artifact?: string;
	kernel?: string;
	framework?: string;
	/** The game server's clock (unix seconds). */
	time?: number;
	text: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

const ARTIFACT_PATTERN = /^[A-Za-z0-9._#-]{1,128}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;
const KEYS = ["kind", "uploader", "player", "artifact", "kernel", "framework", "time", "text"];

/** `{kind, uploader, player?, artifact?, kernel?, framework?, time?, text}`, nothing else; undefined when anything is off. */
export function parseLogUpload(raw: unknown): LogUpload | undefined {
	if (!isPlainObject(raw) || !Object.keys(raw).every((key) => KEYS.includes(key))) return undefined;
	const { kind, uploader, player, artifact, kernel, framework, time, text } = raw;
	if (kind !== "server" && kind !== "client" && kind !== "player") return undefined;
	if (typeof uploader !== "string" || !PLAYER_NAME_PATTERN.test(uploader)) return undefined;
	if (typeof text !== "string" || text.length > LOG_UPLOAD_LIMITS.bodyBytes) return undefined;
	const upload: LogUpload = { kind, uploader, text };
	if (kind === "player") {
		if (typeof player !== "string" || !PLAYER_NAME_PATTERN.test(player)) return undefined;
		upload.player = player;
	} else if (player !== undefined) return undefined;
	if (artifact !== undefined) {
		if (typeof artifact !== "string" || !ARTIFACT_PATTERN.test(artifact)) return undefined;
		upload.artifact = artifact;
	}
	for (const [name, value] of [["kernel", kernel], ["framework", framework]] as const) {
		if (value === undefined) continue;
		if (typeof value !== "string" || !VERSION_PATTERN.test(value)) return undefined;
		upload[name] = value;
	}
	if (time !== undefined) {
		if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0) return undefined;
		upload.time = time;
	}
	return upload;
}

/**
 * Log text safe to open in any terminal or editor: CRLF/CR become LF; every other control character (C0 except tab and
 * line feed, DEL, C1, so no ANSI escape sequences) and bidi overrides are dropped.
 */
export function cleanLogText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "");
}

/** A file-name piece: letters, digits, dot, dash, underscore; anything else a dash. */
function safePart(text: string, fallback: string, max = 48): string {
	const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, max);
	return cleaned === "" ? fallback : cleaned;
}

/** "2026-10-06T12-15-30Z" (UTC; no colons, so it works on every file system). */
export function fileTime(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

/** `<UTC time>-<branch>-<job8>-<kind>.log`; Studio servers (no JobId) are "studio". */
export function logFileName(date: Date, branch: string, job: string, kind: LogKind): string {
	const job8 = job === "" ? "studio" : safePart(job.slice(0, 8), "job");
	return `${fileTime(date)}-${safePart(branch, "branch")}-${job8}-${kind}.log`;
}

export interface LogMeta {
	userId: number;
	branch: string;
	job: string;
	savedAt: Date;
}

/** The file: a short `#` header (from the checked fields and the token), a blank line, then the cleaned text. */
export function formatLogFile(upload: LogUpload, meta: LogMeta): { content: string; lines: number } {
	const body = cleanLogText(upload.text).replace(/\n+$/, "");
	const lines = body === "" ? 0 : body.split("\n").length;
	const header = [`# TypeTorch logs: ${upload.kind}${upload.player ? ` (player ${upload.player})` : ""}`];
	header.push(`# uploaded by: ${upload.uploader} (roblox:${meta.userId})`);
	if (upload.artifact) header.push(`# artifact: ${upload.artifact}`);
	header.push(`# branch: ${meta.branch}`);
	header.push(`# job: ${meta.job === "" ? "(studio)" : meta.job}`);
	if (upload.kernel || upload.framework) header.push(`# kernel: ${upload.kernel ?? "?"}  framework: ${upload.framework ?? "?"}`);
	const gameTime = upload.time !== undefined ? `${new Date(upload.time * 1000).toISOString()} (game server), ` : "";
	header.push(`# time: ${gameTime}saved ${meta.savedAt.toISOString()}`);
	header.push(`# lines: ${lines}`);
	return { content: `${header.join("\n")}\n\n${body}${body === "" ? "" : "\n"}`, lines };
}

export interface SavedLog {
	/** Absolute path (for this PC's terminal only; never sent to the game). */
	path: string;
	/** The file name (what the game gets back). */
	name: string;
	lines: number;
}

/** Writes uploads into one folder (created on first use, owner-only files), at most LOG_UPLOAD_LIMITS.perSession. */
export class LogStore {
	private written = 0;

	constructor(
		readonly dir: string,
		private readonly now: () => Date = () => new Date(),
	) {}

	/** "quota" when this session wrote its maximum. */
	save(upload: LogUpload, meta: Omit<LogMeta, "savedAt">): SavedLog | "quota" {
		if (this.written >= LOG_UPLOAD_LIMITS.perSession) return "quota";
		const savedAt = this.now();
		const { content, lines } = formatLogFile(upload, { ...meta, savedAt });
		mkdirSync(this.dir, { recursive: true });
		const base = logFileName(savedAt, meta.branch, meta.job, upload.kind).replace(/\.log$/, "");
		let name = `${base}.log`;
		for (let n = 2; existsSync(join(this.dir, name)); n++) name = `${base}-${n}.log`;
		const path = join(this.dir, name);
		writeFileSync(path, content, { mode: 0o600, flag: "wx" });
		this.written += 1;
		return { path, name, lines };
	}
}
