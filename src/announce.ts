/**
 * Registration with game servers over Open Cloud MessagingService (plans/11 §1.5), topic `TypeTorch/remote-claude`:
 *   {"v":1,"s":<sessionId>,"b":<branch>,"u":[<userIds>],"url":<tunnel URL>,"exp":<unix now+120>}  every 60 s
 *   {"v":1,"s":<sessionId>,"url":<tunnel URL>,"closed":true}       on exit (and for the old session after a tunnel restart)
 * Messages are at most 1 KiB. The API key is sent only in the x-api-key header and never logged.
 *
 * Game servers bind a session id to the first URL they hear for it and ignore later messages that change it; a closed
 * message only counts when both its session id and its URL match (security audit H1). After a tunnel restart the dev
 * server therefore announces a new session id (auth.ts `rekey`) and closes the old one.
 */
import type { Logger } from "./log.ts";

export const TOPIC = "TypeTorch/remote-claude";
export const ANNOUNCE_INTERVAL_MS = 60_000;
export const ANNOUNCE_TTL_SECONDS = 120;
const API = "https://apis.roblox.com";

export interface SessionAnnouncement {
	v: 1;
	s: string;
	b: string;
	u: number[];
	url: string;
	exp: number;
}

export function registrationMessage(sessionId: string, branch: string, users: number[], url: string): string {
	const body: SessionAnnouncement = { v: 1, s: sessionId, b: branch, u: users, url, exp: Math.floor(Date.now() / 1000) + ANNOUNCE_TTL_SECONDS };
	return JSON.stringify(body);
}

/** Ends a session on game servers; they only accept it with the URL the session was announced with. */
export function closedMessage(sessionId: string, url: string): string {
	return JSON.stringify({ v: 1, s: sessionId, url, closed: true });
}

/** One Open Cloud MessagingService publish (at most 1 KiB). The key goes only in the x-api-key header. */
export async function publishMessage(universeId: number, apiKey: string, topic: string, message: string, logger: Logger): Promise<boolean> {
	if (Buffer.byteLength(message, "utf8") > 1024) {
		logger.error(`message for ${topic} is over 1 KiB; not sent`);
		return false;
	}
	try {
		const response = await fetch(`${API}/cloud/v2/universes/${universeId}:publishMessage`, {
			method: "POST",
			headers: { "x-api-key": apiKey, "content-type": "application/json" },
			body: JSON.stringify({ topic, message }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			logger.warn(`publishMessage ${topic} failed: HTTP ${response.status}`);
			return false;
		}
		return true;
	} catch (error) {
		logger.warn(`publishMessage ${topic} failed: ${(error as Error).name}`);
		return false;
	}
}

export class Announcer {
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly options: {
			universeId: number;
			apiKey: string;
			logger: Logger;
			/** Builds the current registration message, or undefined when there is nothing to announce yet. */
			current: () => string | undefined;
		},
	) {}

	publish(message: string): Promise<boolean> {
		return publishMessage(this.options.universeId, this.options.apiKey, TOPIC, message, this.options.logger);
	}

	/** Publishes the current registration now. */
	async announce(): Promise<boolean> {
		const message = this.options.current();
		if (!message) return false;
		const ok = await this.publish(message);
		if (ok) this.options.logger.info(`announced on ${TOPIC} (universe ${this.options.universeId}, expires in ${ANNOUNCE_TTL_SECONDS} s)`);
		return ok;
	}

	start(): void {
		this.stop();
		this.timer = setInterval(() => void this.announce(), ANNOUNCE_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
