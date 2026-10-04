/**
 * Terminal logging. Every line goes through `redact`, which removes the values registered with `addSecret` (the
 * pairing code, the Open Cloud API key) and anything shaped like a JWT, so a token or key can never reach the
 * terminal, a prompt's `log` or a file even by accident.
 */
import { homedir, tmpdir, userInfo } from "node:os";

const secrets = new Set<string>();

/** Registers a value that must never be printed. Short values are ignored (they would mangle normal text). */
export function addSecret(value: string | undefined): void {
	if (value && value.length >= 8) secrets.add(value);
}

const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function redact(text: string): string {
	let out = text;
	for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("<redacted>");
	return out.replace(JWT_SHAPE, "<jwt>").replace(BEARER, "$1 <redacted>");
}

/**
 * Prompt events (assistant text, tool lines) go to game servers and then to dev clients, so they get extra redaction:
 * every `addSecret` value, values registered here (.env values, the tunnel URL) and anything shaped like a tunnel URL.
 */
const eventSecrets = new Set<string>();

export function addEventSecret(value: string | undefined): void {
	if (value && value.length >= 8) eventSecrets.add(value);
}

const TUNNEL_URL = /https?:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.trycloudflare\.com\S*/gi;

// Local paths (security audit L6): text relayed to game servers (and from there to dev clients) never carries an
// absolute path, the home folder or the OS username. Files inside the worktree become worktree-relative ("src/a.ts").
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Path body characters: no whitespace, quotes or brackets, and no ":" (so "a.ts:12" keeps its line number). */
const PATH_CHARS = "[^\\s\"'<>|*?`:]";
const URL_CHARS = "[^\\s\"'<>]";

/** A folder in either separator style (and any case on Windows), followed by a separator or a non-name character. */
function rootPattern(path: string): RegExp | undefined {
	const parts = path.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean).map(escapeRegExp);
	if (parts.length === 0) return undefined;
	const drive = /^[A-Za-z]:$/.test(path.slice(0, 2)) ? "" : "[\\\\/]";
	// The bare folder ends at a separator or at anything that can't continue a name ("." only when a name character
	// follows, so "in C:\a\b." at the end of a sentence still matches).
	return new RegExp(`${drive}${parts.join("[\\\\/]+")}(?:[\\\\/]+|(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-]))`, process.platform === "win32" ? "gi" : "g");
}

interface PathRoot {
	pattern: RegExp;
	/** What the root plus its trailing separator becomes ("" = relative). */
	prefix: string;
	/** What the bare root becomes. */
	bare: string;
}

let pathRoots: PathRoot[] = [];
let usernamePattern: RegExp | undefined;
let usernameLower = "";

function osUsername(): string | undefined {
	try {
		return userInfo().username;
	} catch {
		return process.env.USERNAME ?? process.env.USER;
	}
}

/**
 * Registers the session's folders. Longest roots are replaced first: the worktree (relative paths), the repo
 * ("<repo>/"), the temp folder ("<tmp>/") and the home folder ("~/"). Called once by session.ts; also sets up the
 * username. Without a call, only the generic rules and the home/temp folders apply.
 */
export function setEventPaths(paths: { worktree?: string; repo?: string } = {}): void {
	const roots: { path: string; prefix: string; bare: string }[] = [];
	if (paths.worktree) roots.push({ path: paths.worktree, prefix: "", bare: "." });
	if (paths.repo) roots.push({ path: paths.repo, prefix: "<repo>/", bare: "<repo>" });
	roots.push({ path: tmpdir(), prefix: "<tmp>/", bare: "<tmp>" }, { path: homedir(), prefix: "~/", bare: "~" });
	pathRoots = roots
		.filter((root) => root.path.length >= 3)
		.sort((a, b) => b.path.length - a.path.length)
		.flatMap((root) => {
			const pattern = rootPattern(root.path);
			return pattern ? [{ pattern, prefix: root.prefix, bare: root.bare }] : [];
		});
	const name = osUsername();
	usernameLower = name && name.length >= 3 ? name.toLowerCase() : "";
	usernamePattern = usernameLower ? new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name!)}(?![A-Za-z0-9])`, "gi") : undefined;
}
setEventPaths();

const GENERIC_PATHS = [
	// file:// URLs
	new RegExp(`file:\\/\\/${URL_CHARS}*`, "gi"),
	// C:\... and C:/...
	new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]${PATH_CHARS}*`, "g"),
	// \\server\share\...
	new RegExp(`\\\\\\\\[A-Za-z0-9._$-]+\\\\${PATH_CHARS}*`, "g"),
	// /Users/..., /home/..., /tmp/... (not URL paths: a slash after a word, a dot or a colon is left alone)
	new RegExp(
		`(?<![\\w.~\\-\\/:])\\/(?:Users|home|root|tmp|var|private|opt|mnt|Volumes|etc|usr|srv|media|run|proc|Library|Applications|workspace|workspaces)(?![A-Za-z0-9_-])${PATH_CHARS}*`,
		"g",
	),
];

/** Absolute paths → worktree-relative, "<repo>/…", "~/…", "<tmp>/…" or "<path>"; the OS username → "<user>". */
export function stripPaths(text: string): string {
	let out = text;
	for (const root of pathRoots) out = out.replace(root.pattern, (match) => (/[\\/]$/.test(match) ? root.prefix : root.bare));
	for (const pattern of GENERIC_PATHS) out = out.replace(pattern, "<path>");
	if (usernamePattern) out = out.replace(usernamePattern, "<user>");
	return out;
}

/**
 * Multi-line event text: redacted, local paths and the username stripped, CRLF → LF, control characters other than
 * \n and \t removed, cut to `max`.
 */
export function redactEvent(text: string, max = 4000): string {
	let out = redact(text);
	for (const secret of eventSecrets) if (out.includes(secret)) out = out.split(secret).join("<redacted>");
	out = stripPaths(out.replace(TUNNEL_URL, "<tunnel-url>"))
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
	return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Tails that might be the start of something `redactEvent` removes (a JWT, a Bearer value, a URL). */
const RISKY_TAIL = /(?:\be|\bey|eyJ[A-Za-z0-9_.-]*|\bB(?:e(?:a(?:r(?:e(?:r(?:\s+[A-Za-z0-9._~+/=-]*)?)?)?)?)?)?|\bh(?:t(?:t(?:p(?:s?(?::(?:\/(?:\/[A-Za-z0-9.-]*)?)?)?)?)?)?)?)$/;
/** Tails that might be the start of a local path (a drive letter, a UNC or POSIX path, ~/ or file:). */
const PATH_TAIL = new RegExp(
	`(?:(?<![A-Za-z0-9])[A-Za-z](?::(?:[\\\\/]${PATH_CHARS}*)?)?|\\\\${PATH_CHARS}*|(?<![\\w.~\\-\\/:])\\/${PATH_CHARS}*|~(?:[\\\\/]${PATH_CHARS}*)?|\\bf(?:i(?:l(?:e(?::${URL_CHARS}*)?)?)?)?)$`,
);

/**
 * How much of a streamed text may be published now: everything except a tail that could be the first part of a
 * secret, of a token/URL shape, of a local path or of the username (the rest arrives with the next chunk and is
 * redacted whole).
 */
export function safePrefixLength(text: string): number {
	let hold = 0;
	for (const secret of [...secrets, ...eventSecrets]) {
		for (let k = Math.min(secret.length - 1, text.length); k > hold; k--) {
			if (text.endsWith(secret.slice(0, k))) {
				hold = k;
				break;
			}
		}
	}
	if (usernameLower) {
		const lower = text.toLowerCase();
		for (let k = Math.min(usernameLower.length, text.length); k > hold; k--) {
			if (lower.endsWith(usernameLower.slice(0, k))) {
				hold = k;
				break;
			}
		}
	}
	for (const pattern of [RISKY_TAIL, PATH_TAIL]) {
		const risky = pattern.exec(text);
		if (risky) hold = Math.max(hold, text.length - risky.index);
	}
	return text.length - hold;
}

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

function stamp(): string {
	const now = new Date();
	return [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function consoleLogger(): Logger {
	return {
		info: (message) => console.log(`${stamp()} ${redact(message)}`),
		warn: (message) => console.warn(`${stamp()} warn: ${redact(message)}`),
		error: (message) => console.error(`${stamp()} error: ${redact(message)}`),
	};
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** One printable line: control characters removed, whitespace collapsed, cut to `max` characters. */
export function oneLine(text: string, max = 160): string {
	const flat = redact(text)
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
