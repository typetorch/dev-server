/**
 * A deploy that waits for the dev's approval on their PC (`typetorch approve`): the queue shows
 * proposal.status "awaiting_approval" with the short id, then deployed / rejected / approval_expired.
 */
import { describe, expect, test } from "bun:test";
import { silentLogger } from "../src/log";
import { PromptQueue, type DeployOutcome, type PromptRecord, type Runner } from "../src/prompts";

function queueWith(outcome: () => Promise<DeployOutcome>, waitForApproval: Promise<void>) {
	const runner: Runner = async () => ({
		state: "proposed",
		commit: "a".repeat(40),
		summary: "spin coins",
		proposal: {
			base: "b".repeat(40),
			files: [],
			deploy: async (ctx) => {
				ctx.log("Waiting for your approval on your PC (proposal 3fa9c01b)");
				ctx.awaitingApproval?.("3fa9c01b");
				await waitForApproval;
				return outcome();
			},
			discard: async () => ({ ok: true }),
		},
	});
	return new PromptQueue({ runner, maxQueued: 5, maxPrompts: 50, logger: silentLogger });
}

async function until(check: () => boolean, ms = 3000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

async function proposedRecord(queue: PromptQueue): Promise<PromptRecord> {
	const record = queue.create(7, "make coins spin", undefined, { mode: "code" });
	if (typeof record === "string") throw new Error(record);
	await until(() => record.state === "proposed");
	return record;
}

describe("deploy waiting for approval", () => {
	for (const [name, outcome, status, state] of [
		["approved", { ok: true, artifactId: "12b63b9-3fa91c" }, "deployed", "deployed"],
		["rejected", { ok: false, error: "rejected on your PC", approval: "rejected" }, "rejected", "failed"],
		["expired", { ok: false, error: "the approval expired (24 h)", approval: "expired" }, "approval_expired", "failed"],
	] as const) {
		test(`awaiting_approval with the short id, then ${name}`, async () => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => (release = resolve));
			const queue = queueWith(async () => outcome, gate);
			const record = await proposedRecord(queue);
			expect(await queue.decide(record.id, 7, "deploy")).toBe("ok");
			await until(() => record.proposal?.status === "awaiting_approval");
			const waiting = queue.view(record, 0);
			expect(waiting.state).toBe("building");
			expect(waiting.proposal).toMatchObject({ status: "awaiting_approval", approvalId: "3fa9c01b" });
			expect(waiting.events?.some((e) => e.kind === "status" && e.text === "waiting for approval on your PC (3fa9c01b)")).toBe(true);
			expect(waiting.log).toContain("Waiting for your approval on your PC (proposal 3fa9c01b)");
			release();
			await until(() => record.proposal?.status === status);
			const done = queue.view(record);
			expect(done.state).toBe(state);
			expect(done.proposal?.status).toBe(status);
		});
	}
	test("a malformed id is ignored (the card keeps saying deploying)", async () => {
		const runner: Runner = async () => ({
			state: "proposed",
			commit: "a".repeat(40),
			proposal: {
				base: "b".repeat(40),
				files: [],
				deploy: async (ctx) => {
					ctx.awaitingApproval?.("../etc/passwd");
					return { ok: true };
				},
				discard: async () => ({ ok: true }),
			},
		});
		const queue = new PromptQueue({ runner, maxQueued: 5, maxPrompts: 50, logger: silentLogger });
		const record = await proposedRecord(queue);
		await queue.decide(record.id, 7, "deploy");
		await until(() => record.proposal?.status === "deployed");
		expect(record.proposal?.approvalId).toBeUndefined();
	});
});
