/**
 * Prompt records and the run queue: one run at a time, at most `maxQueued` waiting, at most `maxPrompts` per session.
 * States: queued → running → committed → building → deployed; or answered (no file changes, Claude replied); or
 * failed (a real error) / cancelled.
 *
 * Every record keeps an append-only list of events ({i, kind, text, ...}) that game servers page through with
 * `?since=<next>`: assistant text (streamed, in chunks), tool calls with a short target, one-line tool results, state
 * changes and errors. Event text is redacted (log.ts redactEvent) before it is stored.
 */
import type { Attachment } from "./attachments";
import type { Conversation } from "./conversations";
import type { Logger } from "./log";
import { oneLine, redactEvent, safePrefixLength } from "./log";
import type { PromptContext } from "./schema";

export type PromptState = "queued" | "running" | "committed" | "building" | "deployed" | "answered" | "failed" | "cancelled";
export const FINISHED_STATES: readonly PromptState[] = ["deployed", "answered", "failed", "cancelled"];
export const LOG_LINES = 20;
/** Events kept per prompt (status/error events may go a little past it, so the end is never lost). */
export const MAX_EVENTS = 2000;
/** Events returned per GET page. */
export const EVENTS_PER_PAGE = 300;
/** Characters per assistant_text event chunk; longer text is split. */
const TEXT_CHUNK = 2000;
/** Streamed text is published at most this often (and whenever a reader asks). */
const TEXT_FLUSH_MS = 250;

export type EventKind = "assistant_text" | "tool_use" | "tool_result" | "status" | "error";

export interface PromptEvent {
	i: number;
	kind: EventKind;
	text: string;
	/** tool_use / tool_result: the tool name. */
	tool?: string;
	/** tool_use: a short target (file path, command, pattern). */
	target?: string;
	/** assistant_text: consecutive chunks with the same block number belong to one text block. */
	block?: number;
	/** status: the new state. */
	state?: PromptState;
}

export interface PromptRecord {
	id: string;
	userId: number;
	prompt: string;
	context?: PromptContext;
	conversation?: Conversation;
	attachments: Attachment[];
	state: PromptState;
	summary?: string;
	commit?: string;
	artifactId?: string;
	error?: string;
	/** Claude Code's own cost estimate for the run (runs are billed to the subscription, never per token). */
	costUsd?: number;
	log: string[];
	events: PromptEvent[];
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Set once the runner returned (committed without deploy also ends here). */
	done: boolean;
	abort: AbortController;
	/** Streamed text not yet published as an event. */
	pending?: { block: number; text: string; timer?: ReturnType<typeof setTimeout> };
	eventsCapped?: boolean;
}

export interface AttachmentView {
	id: string;
	width: number;
	height: number;
}

export interface PromptView {
	id: string;
	state: PromptState;
	conversationId?: string;
	summary?: string;
	commit?: string;
	artifactId?: string;
	error?: string;
	costUsd?: number;
	attachments?: AttachmentView[];
	log: string[];
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Only with ?since=<n>: events i >= n (at most EVENTS_PER_PAGE), and the `since` to pass next time. */
	events?: PromptEvent[];
	next?: number;
	more?: boolean;
}

export interface RunContext {
	record: Readonly<PromptRecord>;
	signal: AbortSignal;
	/** The Claude Code session to resume (a follow-up in a conversation), if any. */
	resume?: string;
	log(line: string): void;
	setState(state: "committed" | "building", fields?: { commit?: string; summary?: string }): void;
	/** A tool_use / tool_result / status / error event (assistant text goes through `text`). */
	event(kind: Exclude<EventKind, "assistant_text">, text: string, extra?: { tool?: string; target?: string }): void;
	/** Appends streamed assistant text to text block `block` (published in chunks). */
	text(block: number, chunk: string): void;
	/** Records the Claude Code session id of this run (from the init event) on its conversation. */
	setClaudeSession(sessionId: string): void;
	setCost(usd: number): void;
}

export interface RunOutcome {
	state: "committed" | "deployed" | "answered" | "failed";
	summary?: string;
	commit?: string;
	artifactId?: string;
	error?: string;
}

export type Runner = (ctx: RunContext) => Promise<RunOutcome>;

const now = () => Math.floor(Date.now() / 1000);

function newPromptId(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

export interface CreateOptions {
	conversation?: Conversation;
	attachments?: Attachment[];
}

export class PromptQueue {
	private readonly records = new Map<string, PromptRecord>();
	private readonly waiting: PromptRecord[] = [];
	private running: PromptRecord | undefined;
	private created = 0;
	private stopped = false;

	constructor(
		private readonly options: { runner: Runner; maxQueued: number; maxPrompts: number; logger: Logger },
	) {}

	get createdCount(): number {
		return this.created;
	}

	get active(): PromptRecord | undefined {
		return this.running;
	}

	get queued(): readonly PromptRecord[] {
		return this.waiting;
	}

	all(): PromptRecord[] {
		return [...this.records.values()];
	}

	get(id: string): PromptRecord | undefined {
		return this.records.get(id);
	}

	/** Why a prompt can't be accepted right now, or undefined when it can. */
	refusal(): "queue-full" | "max-prompts" | "stopped" | undefined {
		if (this.stopped) return "stopped";
		if (this.created >= this.options.maxPrompts) return "max-prompts";
		if (this.waiting.length >= this.options.maxQueued) return "queue-full";
		return undefined;
	}

	/** True while the conversation has a prompt that hasn't finished. */
	busy(conversation: Conversation): boolean {
		return conversation.promptIds.some((id) => {
			const record = this.records.get(id);
			return record !== undefined && !record.done && !FINISHED_STATES.includes(record.state);
		});
	}

	create(userId: number, prompt: string, context?: PromptContext, extra: CreateOptions = {}): PromptRecord | "queue-full" | "max-prompts" | "stopped" {
		const refused = this.refusal();
		if (refused) return refused;
		this.created += 1;
		const record: PromptRecord = {
			id: newPromptId(),
			userId,
			prompt,
			context,
			conversation: extra.conversation,
			attachments: extra.attachments ?? [],
			state: "queued",
			log: [],
			events: [],
			queuedAt: now(),
			done: false,
			abort: new AbortController(),
		};
		this.records.set(record.id, record);
		this.waiting.push(record);
		for (const attachment of record.attachments) attachment.promptId = record.id;
		if (extra.conversation) extra.conversation.promptIds.push(record.id);
		this.pushEvent(record, { kind: "status", text: "queued", state: "queued" });
		this.options.logger.info(`prompt ${record.id.slice(0, 8)} queued  roblox:${userId}  "${oneLine(prompt, 60)}"`);
		queueMicrotask(() => void this.pump());
		return record;
	}

	/** "ok" when it is (now) cancelled, "finished" when it already ended. */
	cancel(id: string, by: string): "ok" | "finished" | "missing" {
		const record = this.records.get(id);
		if (!record) return "missing";
		if (record.state === "cancelled") return "ok";
		if (record.done || FINISHED_STATES.includes(record.state)) return "finished";
		this.pushLog(record, `cancelled by ${by}`);
		const index = this.waiting.indexOf(record);
		if (index >= 0) {
			this.waiting.splice(index, 1);
			this.finish(record, { state: "cancelled" });
		} else {
			record.abort.abort();
		}
		return "ok";
	}

	/** Cancels everything the user has queued or running. Returns how many. */
	cancelUser(userId: number, by: string): number {
		let count = 0;
		for (const record of this.records.values()) {
			if (record.userId === userId && !record.done && this.cancel(record.id, by) === "ok") count += 1;
		}
		return count;
	}

	/** Cancels everything and refuses new prompts. Resolves when the running prompt has stopped. */
	async stop(): Promise<void> {
		this.stopped = true;
		for (const record of [...this.waiting]) this.cancel(record.id, "shutdown");
		const running = this.running;
		if (running) {
			this.cancel(running.id, "shutdown");
			const deadline = Date.now() + 10_000;
			while (this.running === running && Date.now() < deadline) await Bun.sleep(50);
		}
	}

	view(record: PromptRecord, since?: number): PromptView {
		const view: PromptView = { id: record.id, state: record.state, log: record.log.slice(-LOG_LINES), queuedAt: record.queuedAt };
		if (record.conversation) view.conversationId = record.conversation.id;
		if (record.summary !== undefined) view.summary = record.summary;
		if (record.commit !== undefined) view.commit = record.commit;
		if (record.artifactId !== undefined) view.artifactId = record.artifactId;
		if (record.error !== undefined) view.error = record.error;
		if (record.costUsd !== undefined) view.costUsd = record.costUsd;
		if (record.attachments.length > 0) view.attachments = record.attachments.map(({ id, width, height }) => ({ id, width, height }));
		if (record.startedAt !== undefined) view.startedAt = record.startedAt;
		if (record.finishedAt !== undefined) view.finishedAt = record.finishedAt;
		if (since !== undefined) {
			this.flushText(record, true);
			const from = Math.max(0, Math.min(since, record.events.length));
			const page = record.events.slice(from, from + EVENTS_PER_PAGE);
			view.events = page;
			view.next = from + page.length;
			view.more = view.next < record.events.length;
		}
		return view;
	}

	/**
	 * All events of a finished or running prompt, with consecutive chunks of one text block merged (conversation
	 * replay). `next` is where a reader continues with ?since.
	 */
	condensed(record: PromptRecord, maxTextChars = 8000): { events: PromptEvent[]; next: number } {
		this.flushText(record, true);
		const out: PromptEvent[] = [];
		for (const event of record.events) {
			const last = out[out.length - 1];
			if (event.kind === "assistant_text" && last?.kind === "assistant_text" && last.block === event.block) {
				if (last.text.length < maxTextChars) last.text = `${last.text}${event.text}`.slice(0, maxTextChars);
			} else {
				out.push({ ...event });
			}
		}
		return { events: out, next: record.events.length };
	}

	private pushLog(record: PromptRecord, line: string): void {
		record.log.push(redactEvent(oneLine(line, 200)));
		if (record.log.length > LOG_LINES) record.log.splice(0, record.log.length - LOG_LINES);
	}

	private pushEvent(record: PromptRecord, event: Omit<PromptEvent, "i">): void {
		const essential = event.kind === "status" || event.kind === "error";
		if (record.events.length >= MAX_EVENTS && !(essential && record.events.length < MAX_EVENTS + 20)) return;
		if (record.events.length >= MAX_EVENTS && !record.eventsCapped) {
			record.eventsCapped = true;
			record.events.push({ i: record.events.length, kind: "status", text: "output truncated (event limit)" });
		}
		const clean: PromptEvent = { i: record.events.length, kind: event.kind, text: redactEvent(event.text) };
		if (event.tool !== undefined) clean.tool = oneLine(event.tool, 40);
		if (event.target !== undefined) clean.target = redactEvent(oneLine(event.target, 160));
		if (event.block !== undefined) clean.block = event.block;
		if (event.state !== undefined) clean.state = event.state;
		record.events.push(clean);
	}

	/** Publishes buffered text: everything when `all` (block end, reads, other events), else only the safe prefix. */
	private flushText(record: PromptRecord, all = false): void {
		const pending = record.pending;
		if (!pending) return;
		if (pending.timer) clearTimeout(pending.timer);
		pending.timer = undefined;
		const cut = all ? pending.text.length : safePrefixLength(pending.text);
		let text = pending.text.slice(0, cut);
		pending.text = pending.text.slice(cut);
		while (text.length > 0) {
			this.pushEvent(record, { kind: "assistant_text", text: text.slice(0, TEXT_CHUNK), block: pending.block });
			text = text.slice(TEXT_CHUNK);
		}
		if (pending.text.length === 0) record.pending = undefined;
	}

	private appendText(record: PromptRecord, block: number, chunk: string): void {
		if (!chunk) return;
		if (record.pending && record.pending.block !== block) this.flushText(record, true);
		record.pending ??= { block, text: "" };
		record.pending.text += chunk;
		record.pending.timer ??= setTimeout(() => {
			if (record.pending) record.pending.timer = undefined;
			this.flushText(record);
		}, TEXT_FLUSH_MS);
	}

	private finish(record: PromptRecord, outcome: { state: PromptState; summary?: string; commit?: string; artifactId?: string; error?: string }): void {
		this.flushText(record, true);
		record.state = outcome.state;
		if (outcome.summary !== undefined) record.summary = redactEvent(oneLine(outcome.summary, 200));
		if (outcome.commit !== undefined) record.commit = outcome.commit;
		if (outcome.artifactId !== undefined) record.artifactId = outcome.artifactId;
		if (outcome.error !== undefined) record.error = redactEvent(oneLine(outcome.error, 200));
		record.finishedAt = now();
		record.done = true;
		if (record.error !== undefined) this.pushEvent(record, { kind: "error", text: record.error });
		this.pushEvent(record, { kind: "status", text: record.state, state: record.state });
		if (record.conversation) record.conversation.updatedAt = now();
		const extra = [record.commit && `commit ${record.commit.slice(0, 8)}`, record.artifactId, record.error].filter(Boolean).join("  ");
		this.options.logger.info(`prompt ${record.id.slice(0, 8)} finished: ${record.state}${extra ? `  ${extra}` : ""}`);
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		const record = this.waiting.shift();
		if (!record) return;
		this.running = record;
		record.state = "running";
		record.startedAt = now();
		this.pushEvent(record, { kind: "status", text: "running", state: "running" });
		this.options.logger.info(`prompt ${record.id.slice(0, 8)} running`);
		const live = () => !record.abort.signal.aborted && !record.done;
		const ctx: RunContext = {
			record,
			signal: record.abort.signal,
			resume: record.conversation?.claudeSessionId,
			log: (line) => this.pushLog(record, line),
			setState: (state, fields) => {
				if (record.abort.signal.aborted) return;
				this.flushText(record, true);
				record.state = state;
				if (fields?.commit) record.commit = fields.commit;
				if (fields?.summary) record.summary = redactEvent(oneLine(fields.summary, 200));
				this.pushEvent(record, { kind: "status", text: fields?.commit ? `${state} ${fields.commit.slice(0, 7)}` : state, state });
				this.options.logger.info(`prompt ${record.id.slice(0, 8)} ${state}${fields?.commit ? `  commit ${fields.commit.slice(0, 8)}` : ""}`);
			},
			event: (kind, text, extra) => {
				if (!live()) return;
				this.flushText(record, true);
				this.pushEvent(record, { kind, text, tool: extra?.tool, target: extra?.target });
			},
			text: (block, chunk) => {
				if (live()) this.appendText(record, block, chunk);
			},
			setClaudeSession: (sessionId) => {
				if (record.conversation) record.conversation.claudeSessionId = sessionId;
			},
			setCost: (usd) => {
				if (Number.isFinite(usd) && usd >= 0) record.costUsd = Math.round(usd * 10_000) / 10_000;
			},
		};
		try {
			const outcome = await this.options.runner(ctx);
			if (record.abort.signal.aborted && outcome.state !== "deployed") this.finish(record, { ...outcome, state: "cancelled", error: undefined });
			else this.finish(record, outcome);
		} catch (error) {
			this.finish(record, { state: record.abort.signal.aborted ? "cancelled" : "failed", error: record.abort.signal.aborted ? undefined : (error as Error).message });
		} finally {
			this.running = undefined;
			queueMicrotask(() => void this.pump());
		}
	}
}
