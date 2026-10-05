/**
 * Conversations: a chain of prompts from one user that share one Claude Code session. The first prompt starts a new
 * Claude session (its id comes from the stream-json init event); every follow-up runs `claude -p --resume <id>` in the
 * same worktree, so Claude keeps the context. Conversations live in memory for the dev-server session and are visible
 * only to the user who started them.
 */
import { oneLine } from "./log.ts";

export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Claude Code session ids are UUIDs. */
export const CLAUDE_SESSION_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface Conversation {
	id: string;
	userId: number;
	title: string;
	/** Unix seconds. */
	createdAt: number;
	updatedAt: number;
	/** Set by the first run that reached Claude's init event. */
	claudeSessionId?: string;
	/** Oldest first. */
	promptIds: string[];
	/** Activity counter (newest = highest), so ordering never depends on clock resolution. */
	order: number;
}

const now = () => Math.floor(Date.now() / 1000);

export class ConversationStore {
	private readonly items = new Map<string, Conversation>();
	private counter = 0;

	create(userId: number, firstPrompt: string): Conversation {
		const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
		const title = oneLine(firstPrompt.split(/\r?\n/).find((line) => line.trim()) ?? "chat", 60);
		const conversation: Conversation = { id, userId, title, createdAt: now(), updatedAt: now(), promptIds: [], order: ++this.counter };
		this.items.set(id, conversation);
		return conversation;
	}

	/** Removes a conversation that never got a prompt (the queue refused the first one). */
	discard(id: string): void {
		const conversation = this.items.get(id);
		if (conversation && conversation.promptIds.length === 0) this.items.delete(id);
	}

	/** The conversation, only when `userId` owns it. */
	owned(id: string, userId: number): Conversation | undefined {
		const conversation = this.items.get(id);
		return conversation && conversation.userId === userId ? conversation : undefined;
	}

	/** The user's conversations, latest activity first. */
	forUser(userId: number): Conversation[] {
		return [...this.items.values()].filter((c) => c.userId === userId).sort((a, b) => b.order - a.order);
	}

	touch(conversation: Conversation): void {
		conversation.updatedAt = now();
		conversation.order = ++this.counter;
	}
}
