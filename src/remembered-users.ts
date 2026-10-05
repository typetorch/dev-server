/**
 * The last `--users` list, remembered per game repo in `<repo>/.typetorch/remote-claude.json` (git-ignored), so
 * `typetorch dev` without `--users` reuses it. Only a list the dev typed is ever saved; there is still no default and no
 * wildcard. Claude can't edit `.typetorch/` (runner.ts protected paths), so it can't widen the list.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REMEMBERED_FILE = join(".typetorch", "remote-claude.json");

/** The remembered Roblox user ids, or undefined when none are saved (or the file is unreadable). */
export function readRememberedUsers(repo: string): number[] | undefined {
	const path = join(repo, REMEMBERED_FILE);
	if (!existsSync(path)) return undefined;
	try {
		const users = (JSON.parse(readFileSync(path, "utf8")) as { users?: unknown }).users;
		if (!Array.isArray(users) || users.length === 0) return undefined;
		if (!users.every((id) => Number.isSafeInteger(id) && (id as number) > 0)) return undefined;
		return users as number[];
	} catch {
		return undefined;
	}
}

/** Saves the list a dev passed with `--users`. */
export function rememberUsers(repo: string, users: number[], now = new Date()): void {
	mkdirSync(join(repo, ".typetorch"), { recursive: true });
	writeFileSync(join(repo, REMEMBERED_FILE), JSON.stringify({ users, savedAt: now.toISOString() }, null, "\t") + "\n");
}
