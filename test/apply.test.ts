/** Apply (a local session): a proposal goes into the main checkout uncommitted, for Rojo to sync. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyToCheckout, ensureWorktree } from "../src/git";
import { silentLogger } from "../src/log";
import { PromptQueue, type ProposalActions, type PromptRecord, type Runner } from "../src/prompts";

async function until(check: () => boolean, ms = 3000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

function queueWith(actions: Partial<ProposalActions>) {
	const runner: Runner = async () => ({
		state: "proposed",
		commit: "a".repeat(40),
		summary: "spin coins",
		proposal: { base: "b".repeat(40), files: [], discard: async () => ({ ok: true }), ...actions },
	});
	return new PromptQueue({ runner, maxQueued: 5, maxPrompts: 50, logger: silentLogger });
}

async function proposed(queue: PromptQueue): Promise<PromptRecord> {
	const record = queue.create(7, "make coins spin", undefined, { mode: "code" });
	if (typeof record === "string") throw new Error(record);
	await until(() => record.state === "proposed");
	return record;
}

describe("proposal decisions", () => {
	test("the proposal lists what is offered; apply settles it as applied", async () => {
		const queue = queueWith({ apply: async () => ({ ok: true }) });
		const record = await proposed(queue);
		const view = queue.view(record, 0);
		expect(view.proposal?.actions).toEqual(["apply", "discard"]);
		expect(view.events?.find((e) => e.kind === "deploy_proposal")?.actions).toEqual(["apply", "discard"]);
		expect(await queue.decide(record.id, 7, "deploy")).toBe("unavailable");
		expect(await queue.decide(record.id, 7, "apply")).toBe("ok");
		expect(record.state).toBe("applied");
		expect(record.proposal?.status).toBe("applied");
	});

	test("a failed apply leaves the proposal waiting", async () => {
		const queue = queueWith({ apply: async () => ({ ok: false, error: "it doesn't apply" }), deploy: async () => ({ ok: true }) });
		const record = await proposed(queue);
		expect(queue.view(record).proposal?.actions).toEqual(["apply", "deploy", "discard"]);
		expect(await queue.decide(record.id, 7, "apply")).toBe("failed");
		expect(record.state).toBe("proposed");
		expect(record.proposal?.status).toBe("pending");
		expect(await queue.decide(record.id, 7, "discard")).toBe("ok");
		expect(record.state).toBe("discarded");
	});
});

describe("applyToCheckout", () => {
	const dir = mkdtempSync(join(tmpdir(), "tt-apply-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const repo = join(dir, "game");
	const sh = (cwd: string, ...args: string[]) => {
		const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(r.stderr.toString());
		return r.stdout.toString().trim();
	};

	test("the change lands uncommitted; a clash leaves the checkout alone", async () => {
		Bun.spawnSync(["mkdir", "-p", repo]);
		sh(repo, "init", "-q", "-b", "master");
		writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-q", "-m", "init");
		const wt = await ensureWorktree(repo, "master", { separate: true });
		const base = sh(wt.path, "rev-parse", "HEAD");
		writeFileSync(join(wt.path, "a.ts"), "export const a = 2;\n");
		sh(wt.path, "commit", "-qam", "change a");
		const commit = sh(wt.path, "rev-parse", "HEAD");

		expect(await applyToCheckout(wt, base, commit)).toEqual({ ok: true });
		expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("export const a = 2;\n");
		expect(sh(repo, "rev-parse", "HEAD")).toBe(base); // nothing committed on master
		sh(repo, "checkout", "--", "a.ts");

		writeFileSync(join(repo, "a.ts"), "export const a = 3;\n"); // the dev's own edit on the same line
		const clash = await applyToCheckout(wt, base, commit);
		expect(clash.ok).toBe(false);
		expect(clash.error).toContain("doesn't apply to your checkout");
		expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("export const a = 3;\n");
	});
});
