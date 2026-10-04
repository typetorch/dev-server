/** Rate limits, the per-IP failure lockout and the nonce replay cache. All in memory, for one session. */

/** At most `limit` hits per key in a sliding window of `windowMs`. */
export class SlidingWindow {
	private readonly hits = new Map<string, number[]>();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
	) {}

	private recent(key: string, now: number): number[] {
		const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
		if (list.length) this.hits.set(key, list);
		else this.hits.delete(key);
		return list;
	}

	/** True when another hit fits; records it. */
	take(key: string, now = Date.now()): boolean {
		const list = this.recent(key, now);
		if (list.length >= this.limit) return false;
		list.push(now);
		this.hits.set(key, list);
		return true;
	}

	/** Records a hit and returns how many are in the window now. */
	record(key: string, now = Date.now()): number {
		const list = this.recent(key, now);
		list.push(now);
		this.hits.set(key, list);
		return list.length;
	}
}

/** After `limit` failures from one IP within `windowMs`, the IP is blocked for the rest of the session. */
export class Lockout {
	private readonly failures: SlidingWindow;
	private readonly blocked = new Set<string>();

	constructor(
		private readonly limit = 5,
		windowMs = 60_000,
	) {
		this.failures = new SlidingWindow(Number.MAX_SAFE_INTEGER, windowMs);
	}

	isBlocked(ip: string): boolean {
		return this.blocked.has(ip);
	}

	/** Records a failure; returns true when this one blocked the IP. */
	fail(ip: string): boolean {
		if (this.failures.record(ip) >= this.limit && !this.blocked.has(ip)) {
			this.blocked.add(ip);
			return true;
		}
		return false;
	}

	blockedCount(): number {
		return this.blocked.size;
	}
}

/** Remembers nonces for `ttlMs` (longer than the timestamp window plus the token lifetime). */
export class NonceCache {
	private readonly seen = new Map<string, number>();

	constructor(
		private readonly ttlMs = 11 * 60_000,
		private readonly maxEntries = 100_000,
	) {}

	/** Returns false if the nonce was already used; otherwise records it. */
	use(nonce: string, now = Date.now()): boolean {
		if (this.seen.size > this.maxEntries / 2) this.prune(now);
		const at = this.seen.get(nonce);
		if (at !== undefined && now - at < this.ttlMs) return false;
		if (this.seen.size >= this.maxEntries) return false; // fail closed under a flood
		this.seen.set(nonce, now);
		return true;
	}

	prune(now = Date.now()): void {
		for (const [nonce, at] of this.seen) if (now - at >= this.ttlMs) this.seen.delete(nonce);
	}
}
