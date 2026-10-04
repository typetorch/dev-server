/**
 * Registration with game servers over Open Cloud MessagingService (plans/11 §1.5), topic `TypeTorch/remote-claude`:
 *   {"v":1,"s":<sessionId>,"b":<branch>,"u":[<userIds>],"url":<tunnel URL>,"exp":<unix now+120>}  every 60 s
 *   {"v":1,"s":<sessionId>,"closed":true}                                                       on exit
 * Messages are at most 1 KiB. The API key is sent only in the x-api-key header and never logged.
 */
import type { Logger } from "./log";

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

export function closedMessage(sessionId: string): string {
	return JSON.stringify({ v: 1, s: sessionId, closed: true });
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

	async publish(message: string): Promise<boolean> {
		if (Buffer.byteLength(message, "utf8") > 1024) {
			this.options.logger.error("registration message is over 1 KiB (too many users?); not sent");
			return false;
		}
		try {
			const response = await fetch(`${API}/cloud/v2/universes/${this.options.universeId}:publishMessage`, {
				method: "POST",
				headers: { "x-api-key": this.options.apiKey, "content-type": "application/json" },
				body: JSON.stringify({ topic: TOPIC, message }),
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) {
				this.options.logger.warn(`publishMessage failed: HTTP ${response.status}`);
				return false;
			}
			return true;
		} catch (error) {
			this.options.logger.warn(`publishMessage failed: ${(error as Error).name}`);
			return false;
		}
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
