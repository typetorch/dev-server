/**
 * Terminal logging. Every line goes through `redact`, which removes the values registered with `addSecret` (the
 * pairing code, the Open Cloud API key) and anything shaped like a JWT, so a token or key can never reach the
 * terminal, a prompt's `log` or a file even by accident.
 */

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

/** Multi-line event text: redacted, CRLF → LF, control characters other than \n and \t removed, cut to `max`. */
export function redactEvent(text: string, max = 4000): string {
	let out = redact(text);
	for (const secret of eventSecrets) if (out.includes(secret)) out = out.split(secret).join("<redacted>");
	out = out
		.replace(TUNNEL_URL, "<tunnel-url>")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
	return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Tails that might be the start of something `redactEvent` removes (a JWT, a Bearer value, a URL). */
const RISKY_TAIL = /(?:\be|\bey|eyJ[A-Za-z0-9_.-]*|\bB(?:e(?:a(?:r(?:e(?:r(?:\s+[A-Za-z0-9._~+/=-]*)?)?)?)?)?)?|\bh(?:t(?:t(?:p(?:s?(?::(?:\/(?:\/[A-Za-z0-9.-]*)?)?)?)?)?)?)?)$/;

/**
 * How much of a streamed text may be published now: everything except a tail that could be the first part of a
 * secret or of a token/URL shape (the rest arrives with the next chunk and is redacted whole).
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
	const risky = RISKY_TAIL.exec(text);
	if (risky) hold = Math.max(hold, text.length - risky.index);
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
