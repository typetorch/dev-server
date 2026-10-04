/**
 * The game-server feed (transport decision 2026-10-04): one HTTP long-poll per (user, game server) carries everything
 * a game server needs while a dev chats: the streamed events of the prompts it sent, prompt state changes, and the
 * game-tool requests addressed to it. MessagingService is only for the session announcement (and a wake when no poll
 * is open).
 *
 *   GET /v1/game/poll?since=<cursor>  (JWT; key = token user + token job)
 *     → {cursor, reset?, more?, items: FeedItem[], requests: GameRequestPayload[]}
 *   It answers at once when something is waiting, else holds up to `holdMs` (20 s); once data arrives it waits a
 *   little longer (`coalesceMs`, 250 ms) so a streaming reply goes out in batches.
 */
import type { GameRequest } from "./game-tools";
import type { PromptEvent, PromptRecord, PromptView } from "./prompts";

export type PromptSummary = Omit<PromptView, "log" | "events" | "next" | "more">;

export type FeedItem =
	| { seq: number; type: "event"; promptId: string; event: PromptEvent }
	| { seq: number; type: "prompt"; prompt: PromptSummary };

export interface GameRequestPayload {
	id: string;
	tool: string;
	args: Record<string, unknown>;
	description: string;
	timeoutSeconds: number;
	conversationId?: string;
	promptId: string;
}

export function requestPayload(request: GameRequest): GameRequestPayload {
	return {
		id: request.id,
		tool: request.tool,
		args: request.args,
		description: request.description,
		timeoutSeconds: request.timeoutSeconds,
		conversationId: request.conversationId,
		promptId: request.promptId,
	};
}

export function promptSummary(view: PromptView): PromptSummary {
	const { log: _log, events: _events, next: _next, more: _more, ...summary } = view;
	return summary;
}

const MAX_ITEMS = 5000;
const PER_RESPONSE = 500;

class Feed {
	items: FeedItem[] = [];
	nextSeq = 1;
	open = 0;
	lastPollEnd = 0;
	readonly waiters = new Set<() => void>();

	push(item: { type: "event"; promptId: string; event: PromptEvent } | { type: "prompt"; prompt: PromptSummary }): void {
		this.items.push({ ...item, seq: this.nextSeq++ } as FeedItem);
		if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
		this.notify();
	}

	notify(): void {
		for (const wake of [...this.waiters]) wake();
	}

	get baseSeq(): number {
		return this.items[0]?.seq ?? this.nextSeq;
	}
}

export interface PollReply {
	cursor: number;
	reset?: boolean;
	more?: boolean;
	items: FeedItem[];
}

export class GameFeeds {
	private readonly feeds = new Map<string, Feed>();

	constructor(private readonly options: { holdMs?: number; coalesceMs?: number } = {}) {}

	private feed(userId: number, job: string): Feed {
		const key = `${userId}|${job}`;
		let feed = this.feeds.get(key);
		if (!feed) {
			feed = new Feed();
			this.feeds.set(key, feed);
		}
		return feed;
	}

	/** A prompt event (and, for state changes, the prompt's summary) for the game server that sent the prompt. */
	promptEvent(record: PromptRecord, event: PromptEvent, view: () => PromptView): void {
		const feed = this.feed(record.userId, record.job);
		feed.push({ type: "event", promptId: record.id, event });
		if (event.kind === "status" && event.state !== undefined) feed.push({ type: "prompt", prompt: promptSummary(view()) });
	}

	/** Wakes the poll of (user, job) so it picks up a new tool request. */
	requestAdded(userId: number, job: string): void {
		this.feed(userId, job).notify();
	}

	/** True while a poll of (user, job) is open (or ended under 2 s ago, so the game server is about to poll again). */
	isPolling(userId: number, job: string, now = Date.now()): boolean {
		const feed = this.feeds.get(`${userId}|${job}`);
		return feed !== undefined && (feed.open > 0 || now - feed.lastPollEnd < 2000);
	}

	/**
	 * One long-poll. `since` undefined = a fresh start (cursor only). `hasRequests` is checked before holding and on
	 * every wake, so tool requests return at once.
	 */
	async poll(userId: number, job: string, since: number | undefined, hasRequests: () => boolean, signal?: AbortSignal): Promise<PollReply> {
		const feed = this.feed(userId, job);
		feed.open += 1;
		try {
			const ready = () => hasRequests() || (since !== undefined && feed.nextSeq > since);
			if (since === undefined) return { cursor: feed.nextSeq, items: [] };
			if (since > feed.nextSeq) return { cursor: feed.nextSeq, reset: true, items: [] };
			if (!ready()) {
				await new Promise<void>((resolve) => {
					let timer: ReturnType<typeof setTimeout>;
					const done = () => {
						clearTimeout(timer);
						feed.waiters.delete(wake);
						signal?.removeEventListener("abort", done);
						resolve();
					};
					// Data arrived: give a streaming reply a moment to collect more, then answer.
					const wake = () => {
						feed.waiters.delete(wake);
						clearTimeout(timer);
						timer = setTimeout(done, hasRequests() ? 0 : (this.options.coalesceMs ?? 250));
					};
					timer = setTimeout(done, this.options.holdMs ?? 20_000);
					feed.waiters.add(wake);
					signal?.addEventListener("abort", done, { once: true });
				});
			}
			const reset = since < feed.baseSeq;
			const from = reset ? feed.baseSeq : since;
			const items = feed.items.filter((item) => item.seq >= from).slice(0, PER_RESPONSE);
			const cursor = items.length > 0 ? items[items.length - 1].seq + 1 : Math.max(from, feed.nextSeq);
			const reply: PollReply = { cursor, items };
			if (reset) reply.reset = true;
			if (cursor < feed.nextSeq) reply.more = true;
			return reply;
		} finally {
			feed.open -= 1;
			feed.lastPollEnd = Date.now();
		}
	}
}
