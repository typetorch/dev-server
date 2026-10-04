/** Artifact ids in `typetorch deploy` output: the CLI 0.2 `<commit7>[-dirty]-<hash6>` form and the legacy form. */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployedArtifactId, deployProposalId, lastArtifactId, proposalDecision, waitForProposal } from "../src/runner";

describe("artifact ids in deploy output", () => {
	test("new ids", () => {
		expect(lastArtifactId("deployed #17 dev@12b63b9 -> 12b63b9-3fa91c (asset 1)")).toBe("12b63b9-3fa91c");
		expect(lastArtifactId("built 12b63b9-dirty-3fa91c  (branch dev)")).toBe("12b63b9-dirty-3fa91c");
		expect(lastArtifactId("uncommitted-dirty-abcdef.")).toBe("uncommitted-dirty-abcdef");
		expect(deployedArtifactId("not json\nartifact 7654321-a1b2c3")).toBe("7654321-a1b2c3");
	});
	test("legacy ids still parse", () => {
		expect(lastArtifactId("deployed artifact dev-12b63b9.r2 to dev")).toBe("dev-12b63b9.r2");
		expect(lastArtifactId("prod-abcdef1-dirty-a1b2c3, next")).toBe("prod-abcdef1-dirty-a1b2c3");
	});
	test("hashes and words that only look similar are not ids", () => {
		expect(lastArtifactId("sha256 12b63b9-3fa91c0")).toBeUndefined();
		expect(lastArtifactId("commit 12b63b9")).toBeUndefined();
	});
});

describe("waiting for the dev's approval (typetorch approve)", () => {
	const proposed = (id: string, expiresAt: string) => JSON.stringify({ event: "proposed", id, at: "2026-10-04T12:00:00.000Z", expiresAt, kind: "deploy", branch: "dev" });
	test("deployProposalId reads the CLI's --json proposal output", () => {
		expect(deployProposalId(JSON.stringify({ proposal: { id: "3fa9c01b" }, approve: "typetorch approve 3fa9c01b" }, null, 2))).toBe("3fa9c01b");
		expect(deployProposalId(JSON.stringify({ deployment: { artifactId: "x" } }))).toBeUndefined();
		expect(deployProposalId(JSON.stringify({ proposal: { id: "../../etc" } }))).toBeUndefined();
		expect(deployProposalId("not json")).toBeUndefined();
	});
	test("pending, approved (with the deploy's artifact and seq), rejected, expired", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-wait-"));
		const future = new Date(Date.now() + 60_000).toISOString();
		writeFileSync(join(dir, "proposals.jsonl"), [proposed("aaaaaaaa", future), proposed("bbbbbbbb", future), proposed("cccccccc", "2026-01-01T00:00:00.000Z")].join("\n") + "\n");
		expect(proposalDecision(dir, "aaaaaaaa").status).toBe("pending");
		expect(proposalDecision(dir, "cccccccc")).toEqual({ status: "expired" });
		appendFileSync(join(dir, "proposals.jsonl"), JSON.stringify({ event: "approved", id: "aaaaaaaa", seq: 21 }) + "\n" + JSON.stringify({ event: "rejected", id: "bbbbbbbb", reason: "no" }) + "\n");
		writeFileSync(join(dir, "deployments.jsonl"), JSON.stringify({ seq: 21, artifactId: "12b63b9-3fa91c", proposalId: "aaaaaaaa" }) + "\n");
		expect(proposalDecision(dir, "aaaaaaaa")).toEqual({ status: "approved", artifactId: "12b63b9-3fa91c", seq: 21 });
		expect(proposalDecision(dir, "bbbbbbbb")).toEqual({ status: "rejected", reason: "no" });
	});
	test("waitForProposal polls until decided, and stops on abort", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-wait2-"));
		writeFileSync(join(dir, "proposals.jsonl"), proposed("dddddddd", new Date(Date.now() + 60_000).toISOString()) + "\n");
		setTimeout(() => appendFileSync(join(dir, "proposals.jsonl"), JSON.stringify({ event: "rejected", id: "dddddddd" }) + "\n"), 120);
		expect(await waitForProposal(dir, "dddddddd", new AbortController().signal, 30)).toEqual({ status: "rejected", reason: undefined });
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 80);
		writeFileSync(join(dir, "proposals.jsonl"), proposed("eeeeeeee", new Date(Date.now() + 60_000).toISOString()) + "\n");
		expect(await waitForProposal(dir, "eeeeeeee", abort.signal, 30)).toBe("cancelled");
	});
});
