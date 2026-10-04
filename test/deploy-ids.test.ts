/** Artifact ids in `typetorch deploy` output: the CLI 0.2 `<commit7>[-dirty]-<hash6>` form and the legacy form. */
import { describe, expect, test } from "bun:test";
import { deployedArtifactId, lastArtifactId } from "../src/runner";

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
