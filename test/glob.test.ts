/** src/glob.ts must match exactly like Bun.Glob (which the protected-path check used before it ran under Node). */
import { describe, expect, test } from "bun:test";
import { Glob } from "../src/glob";
import { protectedGlobs } from "../src/runner";

const PATTERNS = [
	...protectedGlobs(),
	"tools/**",
	"src/*.ts",
	"!src/**",
	"a?c",
	"[!a]bc",
	"[a-c]x",
	"[]a]",
	"[a",
	"a\\*b",
	"a/**/b",
	"a**b",
	"**",
	"*",
	"a/*",
	"x/**",
	"**/x",
	"scripts/**",
	"**/*.project.json",
	"*.json",
	"src/**/gen-*.luau",
];

const PATHS = [
	"package.json",
	"a/package.json",
	".hidden/package.json",
	"a/.b/package.json",
	"bun.lock",
	"x/bun.lockb",
	"tsconfig.json",
	"a/tsconfig.build.json",
	"default.project.json",
	".a.project.json",
	"src/x.project.json",
	"typetorch.json",
	".env",
	"a/.env.local",
	"src/.envrc",
	".github",
	".github/workflows/ci.yml",
	"scripts",
	"scripts/build.ts",
	"x/scripts/a",
	"node_modules/a",
	"a/node_modules",
	"a/node_modules/b/c.js",
	"CLAUDE.md",
	"docs/CLAUDE.md",
	"src/server/main.server.ts",
	"src/shared/package-info.ts",
	"README.md",
	"tools/gen.ts",
	"src/tools/gen.ts",
	"src/a.ts",
	"src/a/b.ts",
	"lib/a.ts",
	"abc",
	"a/c",
	"xbc",
	"bc",
	"bx",
	"]",
	"[a",
	"a*b",
	"axyb",
	"ax/yb",
	"a/b",
	"a/x/y/b",
	"x",
	"x/",
	"x/y",
	"a/.b",
	"toolbox.lock.toml",
	"src/gen/gen-1.luau",
	"src/gen-1.luau",
	".husky/pre-commit",
	".vscode/settings.json",
	".typetorch/state.json",
	".gitattributes",
	"rokit.toml",
	"pnpm-lock.yaml",
	"",
];

describe("glob", () => {
	test("matches exactly like Bun.Glob", () => {
		const diffs: string[] = [];
		for (const pattern of PATTERNS) {
			const ours = new Glob(pattern);
			const bun = new Bun.Glob(pattern);
			for (const path of PATHS) for (const p of [path, `x/${path}`]) if (ours.match(p) !== bun.match(p)) diffs.push(`${pattern} ${JSON.stringify(p)}: ours ${ours.match(p)}, Bun ${bun.match(p)}`);
		}
		expect(diffs).toEqual([]);
	});
});
