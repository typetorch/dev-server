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
