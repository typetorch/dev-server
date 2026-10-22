/** A worktree per user (local sessions): devs' prompts run side by side, and Apply stays safe on one checkout. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyToCheckout, ensureWorktree } from "../src/git";
import { silentLogger } from "../src/log";
import { PromptQueue, type PromptRecord, type Runner } from "../src/prompts";

async function until(check: () => boolean, ms = 3000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

describe("lanes", () => {
	test("two devs run at the same time; each dev still takes turns, and code mode is busy per dev", async () => {
		const gates = new Map<string, () => void>();
		const runner: Runner = (ctx) =>
			new Promise((done) => gates.set(ctx.record.id, () => done({ state: ctx.record.mode === "code" ? "proposed" : "answered", commit: "a".repeat(40), proposal: ctx.record.mode === "code" ? { base: "b".repeat(40), files: [], discard: async () => ({ ok: true }) } : undefined })));
		const queue = new PromptQueue({ runner, maxQueued: 5, maxPrompts: 50, logger: silentLogger, laneOf: (userId) => String(userId) });
		const make = (userId: number, mode: "live" | "code") => queue.create(userId, "x", undefined, { mode }) as PromptRecord;
		const a = make(7, "code");
		const b = make(8, "code");
		await until(() => a.state === "running" && b.state === "running");
		expect(queue.active).toHaveLength(2);
		// The same dev: a second code prompt is refused while theirs holds their worktree; a live one waits its turn.
		expect(queue.refusal("code", 7)).toBe("code-busy");
		const a2 = make(7, "live");
		await Bun.sleep(30);
		expect(a2.state).toBe("queued");
		gates.get(a.id)!();
		await until(() => a.state === "proposed" && a2.state === "running");
		// Dev 7's proposal holds only their own lane.
		expect(queue.worktreeHeld(7)).toBe(true);
		expect(queue.refusal("code", 9)).toBeUndefined();
		gates.get(a2.id)!();
		gates.get(b.id)!();
		await until(() => b.state === "proposed" && a2.done === true);
	});

	test("without laneOf everyone shares one lane, as before", async () => {
		const gates: (() => void)[] = [];
		const runner: Runner = () => new Promise((done) => gates.push(() => done({ state: "answered" })));
		const queue = new PromptQueue({ runner, maxQueued: 5, maxPrompts: 50, logger: silentLogger });
		const a = queue.create(7, "x") as PromptRecord;
		const b = queue.create(8, "y") as PromptRecord;
		await until(() => a.state === "running");
		await Bun.sleep(30);
		expect(b.state).toBe("queued");
		gates[0]();
		await until(() => b.state === "running");
		gates[1]();
	});
});

describe("worktrees per dev", () => {
	const dir = mkdtempSync(join(tmpdir(), "tt-lanes-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const repo = join(dir, "game");
	const sh = (cwd: string, ...args: string[]) => {
		const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(r.stderr.toString());
		return r.stdout.toString().trim();
	};

	test("each dev gets their own worktree and branch; their Applies land together, a clash is refused", async () => {
		Bun.spawnSync(["mkdir", "-p", repo]);
		sh(repo, "init", "-q", "-b", "master");
		writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-q", "-m", "init");
		const one = await ensureWorktree(repo, "master", { separate: true, lane: "7" });
		const two = await ensureWorktree(repo, "master", { separate: true, lane: "8" });
		expect(one.path).not.toBe(two.path);
		expect([one.workBranch, two.workBranch]).toEqual(["remote-claude/master-7", "remote-claude/master-8"]);
		const base = sh(one.path, "rev-parse", "HEAD");
		const change = (wt: typeof one, file: string, text: string) => {
			writeFileSync(join(wt.path, file), text);
			sh(wt.path, "commit", "-qam", `change ${file}`);
			return sh(wt.path, "rev-parse", "HEAD");
		};
		const c1 = change(one, "a.ts", "export const a = 2;\n");
		const c2 = change(two, "b.ts", "export const b = 2;\n");
		// Both at once: one after the other on the checkout, both land.
		const [r1, r2] = await Promise.all([applyToCheckout(one, base, c1), applyToCheckout(two, base, c2)]);
		expect(r1).toEqual({ ok: true });
		expect(r2).toEqual({ ok: true });
		expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("export const a = 2;\n");
		expect(readFileSync(join(repo, "b.ts"), "utf8")).toBe("export const b = 2;\n");
		// Dev 8 changed a.ts too, from the same base: refused, the checkout keeps dev 7's change.
		const c3 = change(two, "a.ts", "export const a = 3;\n");
		const r3 = await applyToCheckout(two, c2, c3);
		expect(r3.ok).toBe(false);
		expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("export const a = 2;\n");
	});
});
