/**
 * The exchange secret: `TYPETORCH_REMOTE_CLAUDE_SECRET` on the dev's machine, equal to the Roblox Secrets Store secret
 * `typetorch_remote_claude`. It is only ever compared (in constant time), never printed.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SECRET_VAR, Settings, dotEnvChain, parseDotEnv } from "./env";

export const SECRET_NAME_IN_ROBLOX = "typetorch_remote_claude";
export const SECRET_DOMAIN = "*.trycloudflare.com";
export const MIN_SECRET_BITS = 256;

function shannonBitsPerChar(text: string): number {
	const counts = new Map<string, number>();
	for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const p = count / text.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

/**
 * Why `secret` is too weak to start with, or undefined when it is at least 32 random bytes' worth. The estimate uses
 * the alphabet the value is written in (hex: 4 bits per char, base64/base64url: 6, other printable ASCII: 6.5) and
 * rejects low-variety values (repeats, short cycles, words) no matter how long they are.
 */
export function secretStrengthError(secret: string | undefined): string | undefined {
	if (!secret) return `${SECRET_VAR} is not set`;
	if (/\s/.test(secret)) return `${SECRET_VAR} must not contain whitespace`;
	if (!/^[\x21-\x7e]+$/.test(secret)) return `${SECRET_VAR} must be printable ASCII`;
	let bitsPerChar = 6.5;
	if (/^[0-9a-fA-F]+$/.test(secret)) bitsPerChar = 4;
	else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(secret)) bitsPerChar = 6;
	const length = secret.replace(/=+$/, "").length;
	const bits = Math.floor(length * bitsPerChar);
	if (bits < MIN_SECRET_BITS) {
		return `${SECRET_VAR} is too short (about ${bits} bits; at least 32 random bytes = ${MIN_SECRET_BITS} bits are required). Run with --init-secret to generate one`;
	}
	const distinct = new Set(secret).size;
	if (distinct < 10 || shannonBitsPerChar(secret) < 3) {
		return `${SECRET_VAR} does not look random (too few distinct characters). Run with --init-secret to generate one`;
	}
	return undefined;
}

/** 48 random bytes, base64url (64 characters). */
export function generateSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(48));
	return Buffer.from(bytes).toString("base64url");
}

export interface InitSecretResult {
	status: "added" | "present";
	file: string;
	/** Set when an existing value is too weak. */
	weakness?: string;
}

/**
 * Appends a new `TYPETORCH_REMOTE_CLAUDE_SECRET=` line to `envFile` unless the variable is already set in the
 * environment or any `.env` from `startDir` upwards. The value is never returned or printed.
 */
export function initSecret(envFile: string, startDir: string = process.cwd()): InitSecretResult {
	const target = resolve(envFile);
	const settings = new Settings([startDir]);
	const existing = settings.get(SECRET_VAR);
	if (existing) return { status: "present", file: existing.source, weakness: secretStrengthError(existing.value) };
	if (existsSync(target)) {
		const current = readFileSync(target, "utf8");
		if (parseDotEnv(current)[SECRET_VAR]) return { status: "present", file: target };
		const separator = current.length > 0 && !current.endsWith("\n") ? (current.includes("\r\n") ? "\r\n" : "\n") : "";
		const eol = current.includes("\r\n") ? "\r\n" : "\n";
		appendFileSync(target, `${separator}${SECRET_VAR}=${generateSecret()}${eol}`, { encoding: "utf8" });
	} else {
		writeFileSync(target, `${SECRET_VAR}=${generateSecret()}\n`, { encoding: "utf8" });
	}
	return { status: "added", file: target };
}

/** The `.env` --init-secret writes to by default: the nearest existing one above `startDir`, else `<startDir>/.env`. */
export function defaultEnvFile(startDir: string = process.cwd()): string {
	return dotEnvChain(startDir)[0] ?? resolve(startDir, ".env");
}

export const CREATOR_HUB_STEPS = [
	"One-time Roblox setup (the value itself is in the .env file above; it is never printed):",
	"  1. Creator Hub > your experience > Secrets > Create Secret",
	`       name:   ${SECRET_NAME_IN_ROBLOX}`,
	`       value:  the ${SECRET_VAR} value from the .env file`,
	`       domain: ${SECRET_DOMAIN}`,
	"  2. For Studio testing: Studio > Game Settings > Security > enable HTTP requests, and add the same secret",
	"     (same name, value and domain) under the local secrets for Studio.",
	"  3. Game servers read it with HttpService:GetSecret(\"typetorch_remote_claude\"); game code can attach it to",
	`     requests for ${SECRET_DOMAIN} but can never read or print it.`,
].join("\n");
