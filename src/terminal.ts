/** Terminal controls on stdin: code, revoke <id>, users, rotate, status, cancel <id>, quit (and Ctrl+C). */
import type { Logger } from "./log";
import type { RemoteClaudeSession } from "./session";

export const HELP = "commands: code | revoke <userId> | users | rotate | status | cancel <promptId> | quit   (Ctrl+C also quits)";

export function handleCommand(session: RemoteClaudeSession, line: string, logger: Logger): "quit" | void {
	const [command = "", arg] = line.trim().split(/\s+/);
	switch (command.toLowerCase()) {
		case "":
			return;
		case "revoke": {
			const id = Number(arg);
			if (!arg || !Number.isSafeInteger(id) || id <= 0) return logger.info("usage: revoke <userId>");
			if (!session.revoke(id)) logger.info(`roblox:${id} is not in --users`);
			return;
		}
		case "users":
			for (const u of session.server.auth.userTable()) logger.info(`roblox:${u.userId}  ${u.revoked ? "revoked" : "allowed"}  ver ${u.ver}`);
			return;
		case "rotate":
			session.rotate();
			return;
		case "code":
			session.showCode();
			return;
		case "status":
			for (const line of session.status().split("\n")) logger.info(line);
			for (const p of session.server.queue.all().slice(-10)) {
				logger.info(`  ${p.id}  roblox:${p.userId}  ${p.state}${p.commit ? `  ${p.commit.slice(0, 8)}` : ""}${p.error ? `  ${p.error}` : ""}`);
			}
			return;
		case "cancel": {
			const match = session.server.queue.all().find((p) => arg && (p.id === arg || p.id.startsWith(arg)));
			if (!match) return logger.info("usage: cancel <promptId> (see status)");
			const result = session.server.queue.cancel(match.id, "terminal");
			logger.info(result === "ok" ? `cancelled ${match.id}` : `${match.id} already ${match.state}`);
			return;
		}
		case "quit":
		case "exit":
			return "quit";
		case "help":
		case "?":
			logger.info(HELP);
			return;
		default:
			logger.info(`unknown command "${command}". ${HELP}`);
	}
}

export function attachTerminal(session: RemoteClaudeSession, logger: Logger): void {
	logger.info(HELP);
	let forced = false;
	const onSignal = () => {
		if (forced) process.exit(130);
		forced = true;
		void session.close().then(() => process.exit(0));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	if (process.platform === "win32") process.on("SIGBREAK", onSignal);

	void (async () => {
		try {
			for await (const line of console) {
				if (handleCommand(session, line, logger) === "quit") {
					await session.close();
					process.exit(0);
				}
			}
		} catch {
			// stdin closed or unavailable: keep serving; Ctrl+C still works.
		}
	})();
}
