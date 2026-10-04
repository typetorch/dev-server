/**
 * Pairing code: how a game server gets credentials. The dev server shows a 24-character code in unambiguous base32,
 * printed as XXXX-XXXX-XXXX-XXXX-XXXX-XXXX:
 *   - the first 20 characters are random (100 bits);
 *   - the last 4 are the tunnel fingerprint: the first 20 bits of HMAC-SHA256(key = the 20 random characters,
 *     message = the tunnel's hostname in lowercase), in the same alphabet.
 * The game server recomputes the fingerprint from the code and the URL it was announced, and refuses to send a code
 * whose fingerprint doesn't match (security audit H1): a code can only ever go to the tunnel it was made for, even if
 * someone re-announces the session with their own URL. The key is the code's secret part, so nobody can search for a
 * hostname with a matching fingerprint without knowing the code.
 *
 * Codes are single-use (audit M5): the first successful pairing consumes the code and a new one is printed at once. A
 * code therefore pairs exactly one user on one game server. A solo dev pairing a second server uses the next code.
 * Every code also expires `ttlMs` after it is issued (default 3 hours) and is then replaced.
 *
 * Wrong codes are counted per (user, job) in `PairingLockout` (audit L1): 5 failures within 10 minutes lock that pair
 * for 15 minutes. Failures never rotate the code and never block other users or servers, so an outsider who knows a
 * user id can't lock the dev out. Guessing is hopeless anyway: 100 random bits, single use, 3 hours.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** 32 symbols without the look-alikes 0/O and 1/I. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const SECRET_LENGTH = 20;
export const CHECK_LENGTH = 4;
export const CODE_LENGTH = SECRET_LENGTH + CHECK_LENGTH;
export const DEFAULT_CODE_TTL_MS = 3 * 60 * 60 * 1000;

/** Per (user, job): this many wrong codes within the window lock the pair. */
export const PAIR_FAILURES = 5;
export const PAIR_WINDOW_MS = 10 * 60_000;
export const PAIR_LOCK_MS = 15 * 60_000;
const PAIR_MAX_KEYS = 10_000;

/** 20 random symbols (each byte & 31 is uniform over the 32 symbols). */
export function generateSecret(): string {
	let out = "";
	for (const byte of crypto.getRandomValues(new Uint8Array(SECRET_LENGTH))) out += CODE_ALPHABET[byte & 31];
	return out;
}

/** The hostname a fingerprint covers: lowercase, no scheme, port or path ("" when there is no tunnel). */
export function tunnelHost(url: string | undefined): string {
	if (!url) return "";
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** The 4 check symbols: the first 20 bits of HMAC-SHA256(secret, host). The game computes the same in Luau. */
export function fingerprint(secret: string, host: string): string {
	const mac = createHmac("sha256", Buffer.from(secret, "utf8")).update(host.toLowerCase(), "utf8").digest();
	const v = (mac[0] << 16) | (mac[1] << 8) | mac[2];
	return [19, 14, 9, 4].map((shift) => CODE_ALPHABET[(v >>> shift) & 31]).join("");
}

/** A complete code (secret + fingerprint) for `host`. */
export function generateCode(host = ""): string {
	const secret = generateSecret();
	return secret + fingerprint(secret, host);
}

/** Uppercase, spaces and dashes removed. */
export function normalizeCode(input: string): string {
	return input.toUpperCase().replace(/[\s-]+/g, "");
}

export function formatCode(code: string): string {
	return code.match(/.{1,4}/g)!.join("-");
}

/** True when a (normalized) code's last 4 symbols are the fingerprint of `host`. */
export function codeMatchesHost(code: string, host: string): boolean {
	const normalized = normalizeCode(code);
	if (normalized.length !== CODE_LENGTH) return false;
	return fingerprint(normalized.slice(0, SECRET_LENGTH), host) === normalized.slice(SECRET_LENGTH);
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();

/**
 * Why a new code was made: "manual" (rotate), "expired", "used" (a pairing consumed it), "tunnel" (the tunnel URL
 * changed, so the fingerprint changed).
 */
export type RotateReason = "manual" | "expired" | "used" | "tunnel";

export interface PairingCodeOptions {
	/** Lifetime of each code (default 3 hours). */
	ttlMs?: number;
	/** Clock in ms (tests inject one). */
	now?: () => number;
}

export class PairingCode {
	private host = "";
	private code = generateCode();
	private hash = digest(this.code);
	private issuedAt: number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	readonly ttlMs: number;
	private readonly now: () => number;

	constructor(
		private readonly onRotate?: (code: string, reason: RotateReason) => void,
		options: PairingCodeOptions = {},
	) {
		this.ttlMs = options.ttlMs ?? DEFAULT_CODE_TTL_MS;
		if (!(this.ttlMs > 0)) throw new Error("the pairing code lifetime must be positive");
		this.now = options.now ?? Date.now;
		this.issuedAt = this.now();
		this.schedule();
	}

	/** XXXX-XXXX-XXXX-XXXX-XXXX-XXXX */
	get formatted(): string {
		return formatCode(this.code);
	}

	/** The normalized code (for redaction). */
	get raw(): string {
		return this.code;
	}

	/** The tunnel hostname the current code is bound to ("" before there is a tunnel). */
	get boundHost(): string {
		return this.host;
	}

	/** When the current code expires (ms since the epoch). */
	get expiresAt(): number {
		return this.issuedAt + this.ttlMs;
	}

	/**
	 * Binds codes to a tunnel URL: a fresh code with that URL's fingerprint. `reason` undefined = silent (the first
	 * binding at startup, before the code is shown); "tunnel" = a restart, announced through onRotate.
	 */
	bindUrl(url: string | undefined, reason?: "tunnel"): void {
		this.host = tunnelHost(url);
		this.replace(reason);
	}

	/** Replaces the code if it has expired. Returns true when it did. */
	checkExpiry(now = this.now()): boolean {
		if (now < this.expiresAt) return false;
		this.rotate("expired");
		return true;
	}

	/** Constant-time comparison of a normalized attempt (an expired code is replaced first, so it never matches). */
	matches(input: string): boolean {
		this.checkExpiry();
		return timingSafeEqual(digest(normalizeCode(input)), this.hash);
	}

	/** A pairing used the code: it never works again, and the next code is printed. */
	consume(): void {
		this.rotate("used");
	}

	rotate(reason: Exclude<RotateReason, "tunnel"> = "manual"): void {
		this.replace(reason);
	}

	/** Stops the expiry timer. */
	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private replace(reason: RotateReason | undefined): void {
		this.code = generateCode(this.host);
		this.hash = digest(this.code);
		this.issuedAt = this.now();
		this.schedule();
		if (reason) this.onRotate?.(this.code, reason);
	}

	/** Replaces the code when it expires, even if nobody tries it (so a fresh code is printed right away). */
	private schedule(): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.disposed) return;
		const delay = Math.min(Math.max(0, this.expiresAt - this.now()), 2_147_000_000);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.checkExpiry()) this.schedule();
		}, delay + 5);
		(this.timer as { unref?: () => void }).unref?.();
	}
}

/**
 * Wrong pairing codes per (user, job) (audit L1). A pair is locked for `lockMs` after `maxFailures` wrong codes within
 * `windowMs`. Nothing global: one pair's failures never affect another pair, and the code is never rotated for them.
 */
export class PairingLockout {
	private readonly entries = new Map<string, { failures: number[]; lockedUntil: number }>();
	private totalFailures = 0;
	readonly maxFailures: number;
	readonly windowMs: number;
	readonly lockMs: number;
	private readonly maxKeys: number;

	constructor(options: { maxFailures?: number; windowMs?: number; lockMs?: number; maxKeys?: number } = {}) {
		this.maxFailures = options.maxFailures ?? PAIR_FAILURES;
		this.windowMs = options.windowMs ?? PAIR_WINDOW_MS;
		this.lockMs = options.lockMs ?? PAIR_LOCK_MS;
		this.maxKeys = options.maxKeys ?? PAIR_MAX_KEYS;
	}

	private static key(userId: number, job: string): string {
		return `${userId}|${job}`;
	}

	/** Wrong codes since the session started (status line only). */
	get total(): number {
		return this.totalFailures;
	}

	isLocked(userId: number, job: string, now = Date.now()): boolean {
		const entry = this.entries.get(PairingLockout.key(userId, job));
		return entry !== undefined && now < entry.lockedUntil;
	}

	/** Pairs locked right now. */
	lockedCount(now = Date.now()): number {
		let count = 0;
		for (const entry of this.entries.values()) if (now < entry.lockedUntil) count += 1;
		return count;
	}

	/** Records a wrong code for (user, job). `locked` = this failure locked the pair. */
	fail(userId: number, job: string, now = Date.now()): { failures: number; locked: boolean } {
		this.totalFailures += 1;
		const key = PairingLockout.key(userId, job);
		if (!this.entries.has(key) && this.entries.size >= this.maxKeys) this.prune(now);
		const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
		entry.failures = entry.failures.filter((at) => now - at < this.windowMs);
		entry.failures.push(now);
		let locked = false;
		if (entry.failures.length >= this.maxFailures) {
			entry.lockedUntil = now + this.lockMs;
			entry.failures = [];
			locked = true;
		}
		this.entries.delete(key); // re-insert: Map order = least recently failed first (eviction order)
		this.entries.set(key, entry);
		return { failures: entry.failures.length, locked };
	}

	/** A good code: the pair's failures are forgotten. */
	clear(userId: number, job: string): void {
		this.entries.delete(PairingLockout.key(userId, job));
	}

	/** Drops idle entries; under a flood of distinct keys, the least recently failed ones go first. */
	private prune(now: number): void {
		for (const [key, entry] of this.entries) {
			if (now >= entry.lockedUntil && entry.failures.every((at) => now - at >= this.windowMs)) this.entries.delete(key);
		}
		for (const key of this.entries.keys()) {
			if (this.entries.size < this.maxKeys) break;
			this.entries.delete(key);
		}
	}
}
