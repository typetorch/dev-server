/**
 * Prompt records and the run queue: one run at a time, at most `maxQueued` waiting, at most `maxPrompts` per session.
 * States: queued → running → committed → building → deployed, or failed / cancelled.
 */
import type { Logger } from "./log";
import { oneLine } from "./log";
import type { PromptContext } from "./schema";

export type PromptState = "queued" | "running" | "committed" | "building" | "deployed" | "failed" | "cancelled";
const FINISHED: PromptState[] = ["deployed", "failed", "cancelled"];
export const LOG_LINES = 20;

export interface PromptRecord {
	id: string;
	userId: number;
	prompt: string;
	context?: PromptContext;
	state: PromptState;
	summary?: string;
	commit?: string;
	artifactId?: string;
	error?: string;
	log: string[];
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Set once the runner returned (committed without deploy also ends here). */
	done: boolean;
	abort: AbortController;
}

export interface PromptView {
	id: string;
	state: PromptState;
	summary?: string;
	commit?: string;
	artifactId?: string;
	error?: string;
	log: string[];
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
}

export interface RunContext {
	record: Readonly<PromptRecord>;
	signal: AbortSignal;
	log(line: string): void;
	setState(state: "committed" | "building", fields?: { commit?: string; summary?: string }): void;
}

export interface RunOutcome {
	state: "committed" | "deployed" | "failed";
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

	create(userId: number, prompt: string, context?: PromptContext): PromptRecord | "queue-full" | "max-prompts" | "stopped" {
		if (this.stopped) return "stopped";
		if (this.created >= this.options.maxPrompts) return "max-prompts";
		if (this.waiting.length >= this.options.maxQueued) return "queue-full";
		this.created += 1;
		const record: PromptRecord = {
			id: newPromptId(),
			userId,
			prompt,
			context,
			state: "queued",
			log: [],
			queuedAt: now(),
			done: false,
			abort: new AbortController(),
		};
		this.records.set(record.id, record);
		this.waiting.push(record);
		this.options.logger.info(`prompt ${record.id.slice(0, 8)} queued  roblox:${userId}  "${oneLine(prompt, 60)}"`);
		queueMicrotask(() => void this.pump());
		return record;
	}

	/** "ok" when it is (now) cancelled, "finished" when it already ended. */
	cancel(id: string, by: string): "ok" | "finished" | "missing" {
		const record = this.records.get(id);
		if (!record) return "missing";
		if (record.state === "cancelled") return "ok";
		if (record.done || FINISHED.includes(record.state)) return "finished";
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

	view(record: PromptRecord): PromptView {
		const view: PromptView = { id: record.id, state: record.state, log: record.log.slice(-LOG_LINES), queuedAt: record.queuedAt };
		if (record.summary !== undefined) view.summary = record.summary;
		if (record.commit !== undefined) view.commit = record.commit;
		if (record.artifactId !== undefined) view.artifactId = record.artifactId;
		if (record.error !== undefined) view.error = record.error;
		if (record.startedAt !== undefined) view.startedAt = record.startedAt;
		if (record.finishedAt !== undefined) view.finishedAt = record.finishedAt;
		return view;
	}

	private pushLog(record: PromptRecord, line: string): void {
		record.log.push(oneLine(line, 200));
		if (record.log.length > LOG_LINES) record.log.splice(0, record.log.length - LOG_LINES);
	}

	private finish(record: PromptRecord, outcome: { state: PromptState; summary?: string; commit?: string; artifactId?: string; error?: string }): void {
		record.state = outcome.state;
		if (outcome.summary !== undefined) record.summary = oneLine(outcome.summary, 200);
		if (outcome.commit !== undefined) record.commit = outcome.commit;
		if (outcome.artifactId !== undefined) record.artifactId = outcome.artifactId;
		if (outcome.error !== undefined) record.error = oneLine(outcome.error, 200);
		record.finishedAt = now();
		record.done = true;
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
		this.options.logger.info(`prompt ${record.id.slice(0, 8)} running`);
		const ctx: RunContext = {
			record,
			signal: record.abort.signal,
			log: (line) => this.pushLog(record, line),
			setState: (state, fields) => {
				if (record.abort.signal.aborted) return;
				record.state = state;
				if (fields?.commit) record.commit = fields.commit;
				if (fields?.summary) record.summary = oneLine(fields.summary, 200);
				this.options.logger.info(`prompt ${record.id.slice(0, 8)} ${state}${fields?.commit ? `  commit ${fields.commit.slice(0, 8)}` : ""}`);
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
