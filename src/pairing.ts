/**
 * Pairing code: how a game server gets credentials. At session start the dev server makes a 24-character
 * code (unambiguous base32, 120 bits) shown as XXXX-XXXX-XXXX-XXXX-XXXX-XXXX; the dev types it into the in-game
 * Claude tab and the game server exchanges it (with the user's id) for an access token plus a refresh token.
 *
 * Brute force (counted per session, not per IP: Roblox servers share egress IPs):
 *   - more than 10 failures within a minute → code grants answer 429 for 60 s (without checking the code);
 *   - more than 30 failures in total → the code is rotated automatically.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** 32 symbols without the look-alikes 0/O and 1/I. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 24;
export const CODE_FAILURES_PER_MINUTE = 10;
export const CODE_BLOCK_MS = 60_000;
export const CODE_FAILURES_BEFORE_ROTATE = 30;

export function generateCode(): string {
	// 15 random bytes = 120 bits = 24 symbols of 5 bits.
	const bytes = crypto.getRandomValues(new Uint8Array(15));
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += CODE_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		value &= (1 << bits) - 1;
	}
	return out;
}

/** Uppercase, spaces and dashes removed. */
export function normalizeCode(input: string): string {
	return input.toUpperCase().replace(/[\s-]+/g, "");
}

export function formatCode(code: string): string {
	return code.match(/.{1,4}/g)!.join("-");
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();

export type CodeFailure = { blocked: boolean; rotated: boolean };

export class PairingCode {
	private code = generateCode();
	private hash = digest(this.code);
	private recentFailures: number[] = [];
	private totalFailures = 0;
	private blockedUntil = 0;

	constructor(private readonly onRotate?: (code: string, reason: "manual" | "auto") => void) {}

	/** XXXX-XXXX-XXXX-XXXX-XXXX-XXXX */
	get formatted(): string {
		return formatCode(this.code);
	}

	/** The normalized code (for redaction). */
	get raw(): string {
		return this.code;
	}

	/** Wrong attempts since the last rotation. */
	get failureCount(): number {
		return this.totalFailures;
	}

	isBlocked(now = Date.now()): boolean {
		return now < this.blockedUntil;
	}

	/** Constant-time comparison of a normalized attempt. */
	matches(input: string): boolean {
		return timingSafeEqual(digest(normalizeCode(input)), this.hash);
	}

	/** Records a wrong code: may start the 60 s block and, past 30 failures, rotate the code. */
	fail(now = Date.now()): CodeFailure {
		this.totalFailures += 1;
		this.recentFailures = this.recentFailures.filter((t) => now - t < 60_000);
		this.recentFailures.push(now);
		let blocked = false;
		if (this.recentFailures.length > CODE_FAILURES_PER_MINUTE) {
			this.blockedUntil = now + CODE_BLOCK_MS;
			this.recentFailures = [];
			blocked = true;
		}
		let rotated = false;
		if (this.totalFailures > CODE_FAILURES_BEFORE_ROTATE) {
			this.rotate("auto");
			rotated = true;
		}
		return { blocked, rotated };
	}

	rotate(reason: "manual" | "auto" = "manual"): void {
		this.code = generateCode();
		this.hash = digest(this.code);
		this.totalFailures = 0;
		this.recentFailures = [];
		this.onRotate?.(this.code, reason);
	}
}
