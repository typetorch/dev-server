#!/usr/bin/env node
// Smoke test of the COMPILED dev-server under plain Node (no Bun): `bun run build`, then `node scripts/smoke.mjs [--pack]`.
//   - the bin (dist/index.js, `#!/usr/bin/env node`): --help, an unknown command; importing it doesn't run it;
//   - the library entry (dist/lib.js);
//   - runtime.ts as compiled: PATH lookup, child processes (Windows: an npm .cmd shim gets hostile arguments through
//     unharmed), kill-tree, zstd, the protected-path globs;
//   - the HTTP server under Node (node:http): scripts/http-check.mjs starts it on a random 127.0.0.1 port, checks the
//     headers, caps, timeouts and pairing, and stops it;
//   --pack: `npm pack`, the file list (only dist/*.js + *.d.ts, README.md, LICENSE, package.json), a scan of every packed
//   file for key-like strings, local paths and this machine's user name, then `npx <tarball> --help` in a temp folder,
//   offline (jose comes from a tarball of node_modules/jose). Nothing is published.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { httpChecks } from "./http-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const bin = join(root, pkg.bin["typetorch-dev-server"]);
const win = process.platform === "win32";
const dist = (file) => pathToFileURL(join(root, "dist", file)).href;
let failures = 0;

function check(name, ok, detail = "") {
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures += 1;
}

function node(args, options = {}) {
	const result = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true, ...options });
	return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

if (process.versions.bun) console.log("warning: run this with node (it is the Node smoke test); bun is running it");
console.log(`smoke: ${pkg.name} ${pkg.version} under node ${process.version} (${process.platform})`);
if (!existsSync(bin)) {
	console.error(`missing ${relative(root, bin)}: run \`bun run build\` first`);
	process.exit(1);
}

// 1. The bin and the library entry.
check("bin starts with #!/usr/bin/env node", readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));
let r = node([bin, "--help"]);
check("typetorch-dev-server --help", r.code === 0 && r.out.includes("typetorch-dev-server remote-claude --users"), `exit ${r.code}`);
r = node([bin, "remote-claude", "--help"]);
check("remote-claude --help", r.code === 0 && r.out.includes("--env-file"), `exit ${r.code}`);
r = node([bin, "bogus"]);
check("an unknown command exits 1", r.code === 1 && r.err.includes('unknown command "bogus"'), `exit ${r.code}`);
r = node([bin, "remote-claude", "--nope"]);
check("an unknown option exits 1", r.code === 1 && r.err.includes("unknown option --nope"), `exit ${r.code}`);
r = node(["--input-type=module", "-e", `const m = await import(${JSON.stringify(dist("index.js"))}); console.log(typeof m.parseUsers);`]);
check("importing dist/index.js doesn't run it", r.code === 0 && r.out.trim() === "function", r.out.trim() || r.err.trim().slice(0, 200));
const lib = await import(dist("lib.js"));
check("library entry (dist/lib.js)", ["startRemoteClaude", "createRemoteClaudeServer", "SessionAuth", "QuickTunnel", "handleCommand"].every((name) => typeof lib[name] === "function"));
check("types for the library entry", existsSync(join(root, "dist", "lib.d.ts")));

// 2. runtime.ts as compiled.
const rt = await import(dist("runtime.js"));
check("runtime is node", rt.isBun === false && rt.runtimeName().startsWith("node v"), rt.runtimeName());
const git = rt.which("git");
check("which(git)", Boolean(git), git ?? "not found");
const proc = await import(dist("proc.js"));
if (git) {
	const ran = await proc.run(["git", "--version"], { cwd: root });
	check("run(git --version)", ran.code === 0 && /^git version /.test(ran.stdout), ran.stdout.trim());
}
let threw = false;
try {
	rt.spawnChild(["typetorch-no-such-binary"]);
} catch (error) {
	threw = error?.code === "ENOENT";
}
check("a missing executable throws ENOENT at once (as Bun.spawn)", threw);
const sleeper = rt.spawnChild([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdout: "ignore", stderr: "ignore" });
const killedAt = Date.now();
rt.killTree(sleeper);
const code = await Promise.race([sleeper.exited, new Promise((done) => setTimeout(() => done("timeout"), 5000))]);
check("killTree stops a child", code !== "timeout" && code !== 0, `exit ${code} after ${Date.now() - killedAt} ms`);
const lines = [];
const echo = rt.spawnChild([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], { stdin: "one\r\ntwo\nthree" });
await proc.forEachLine(echo.stdout, (line) => lines.push(line));
check("stdin bytes in, lines out (forEachLine)", JSON.stringify(lines) === JSON.stringify(["one", "two", "three"]) && (await echo.exited) === 0, JSON.stringify(lines));
if (win) {
	const dir = mkdtempSync(join(tmpdir(), "tt-smoke-cmd-"));
	try {
		mkdirSync(join(dir, "node_modules", "fake"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "fake", "cli.js"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
		writeFileSync(
			join(dir, "fake.cmd"),
			'@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake\\cli.js" %*\r\n',
		);
		const hostile = ["a b", "c&echo INJECTED", 'x"y', "%PATH%", "^caret", "trail\\", "(p)|<x>;"];
		const shim = await proc.run([join(dir, "fake.cmd"), ...hostile], { cwd: dir });
		let parsed;
		try {
			parsed = JSON.parse(shim.stdout);
		} catch {}
		check("npm .cmd shim (e.g. claude, typetorch): arguments arrive unchanged", JSON.stringify(parsed) === JSON.stringify(hostile), shim.stdout.trim() || shim.stderr.trim());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const runner = await import(dist("runner.js"));
check(
	"protected paths (glob)",
	["package.json", "a/tsconfig.build.json", ".env.local", "src/x/.env", ".github/workflows/ci.yml", "node_modules/x/y.js"].every((p) => runner.isProtectedPath(p)) &&
		!["src/server/main.server.ts", "README.md"].some((p) => runner.isProtectedPath(p)) &&
		runner.isProtectedPath("tools/gen.ts", ["tools/**"]),
);
if (rt.hasZstd()) {
	const images = await import(dist("images.js"));
	const pixels = new Uint8Array(64 * 64 * 4).fill(200);
	const prepared = images.prepareGameImage({ width: 64, height: 64, pixels });
	check("zstd: an image for the game", rt.zstdDecompress(prepared.zstd).length === prepared.width * prepared.height * 4, `${prepared.zstd.length} bytes`);
} else console.log(`note: ${rt.runtimeName()} has no zstd (Node 22.15+): images to the game and zstd screenshots are off here`);

// 3. The HTTP server under Node.
const { createRemoteClaudeServer } = await import(dist("server.js"));
await httpChecks({ createRemoteClaudeServer, backend: "node", check: (name, ok, detail) => check(`http: ${name}`, ok, detail) });

// 4. A whole session under Node (no tunnel, no announcement, a stub runner instead of Claude): a throwaway game repo on
// a dev-channel branch, its worktree, the server, the pairing code file; then close.
if (git) {
	const dir = mkdtempSync(join(tmpdir(), "tt-smoke-session-"));
	const repo = join(dir, "game");
	try {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "typetorch.json"), JSON.stringify({ project: "smoke", universeId: 1, defaultBranch: "prod", branches: { main: "prod" }, channels: { prod: "prod", dev: "dev" } }));
		writeFileSync(join(repo, "src", "hello.ts"), "export const x = 1;\n");
		const g = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
		g("init", "-q", "-b", "main");
		g("-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "add", "-A");
		g("-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "-m", "init");
		g("checkout", "-q", "-b", "dev");
		const { startRemoteClaude } = await import(dist("session.js"));
		const logger = { info() {}, warn() {}, error() {}, debug() {} };
		const session = await startRemoteClaude({ users: [1], repo, runner: async () => ({ state: "answered", summary: "ok" }), tunnel: false, announce: false, terminal: false, clipboard: false, installDeps: false, logger });
		const codeFile = join(repo, ".typetorch", "remote-claude.code");
		check("session: starts under Node (worktree, server, pairing code)", session.server.backend === "node" && existsSync(session.worktree.path) && existsSync(codeFile), `${session.branch}, ${session.server.localUrl}`);
		await session.close();
		check("session: closes (code file removed)", !existsSync(codeFile));
	} catch (error) {
		check("session: starts under Node", false, String(error?.message ?? error));
	} finally {
		spawnSync("git", ["worktree", "prune"], { cwd: repo, windowsHide: true });
		rmSync(dir, { recursive: true, force: true });
	}
}
const cli = runner.resolveCli();
console.log(`note: the deploy CLI here: ${cli ? cli.label : "none (code runs stop at committed)"}`);

// 5. --pack: the packed file list and contents, then npx on the tarball.
if (process.argv.includes("--pack")) {
	const out = mkdtempSync(join(tmpdir(), "tt-smoke-pack-"));
	try {
		const npm = (args, cwd) => spawnSync("npm", args, { cwd, encoding: "utf8", shell: win, windowsHide: true });
		const packed = npm(["pack", "--json", "--pack-destination", out], root);
		let info;
		try {
			info = JSON.parse(packed.stdout)[0];
		} catch {}
		check("npm pack", packed.status === 0 && Boolean(info?.filename), info ? `${info.filename}, ${info.files.length} files, ${info.size} bytes` : packed.stderr.trim().slice(-300));
		if (info) {
			const files = info.files.map((f) => f.path.replace(/\\/g, "/"));
			const allowed = (p) => p === "package.json" || p === "README.md" || p === "LICENSE" || /^dist\/[\w./-]+\.(js|d\.ts)$/.test(p);
			const bad = files.filter((p) => !allowed(p) || /(^|\/)(test|tests|fixtures?|test-fixture|\.typetorch|node_modules)(\/|$)|\.env|\.key$|CHANGELOG/i.test(p));
			check("packed files: dist + README + LICENSE + package.json only", bad.length === 0, bad.join(", "));
			const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const hard = [
				{ what: "this machine's user name", re: new RegExp(`(^|[^a-z0-9])${escape(userInfo().username)}([^a-z0-9]|$)`, "i") },
				{ what: "the home folder", re: new RegExp(escape(homedir()).replace(/\\\\/g, "[\\\\/]+"), "i") },
				{ what: "a Windows user folder", re: /[A-Za-z]:[\\/]+Users[\\/]+(?!<|\{|\$|%|\*|\.\.\.)[\w.-]+/ },
				{ what: "a macOS/Linux user folder", re: /(?<![\w.])\/(?:Users|home)\/(?!<|\{|\$|\*|\.\.\.)[a-z][\w.-]+/ },
				{ what: "a private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
				{ what: "an Anthropic/OpenAI-style key", re: /\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{20,}/ },
				{ what: "a JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
				{ what: "a trycloudflare URL", re: /https:\/\/(?!<)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/ },
				{ what: "a Roblox cookie", re: /_\|WARNING:-DO-NOT-SHARE-THIS/ },
			];
			const soft = /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g;
			const findings = [];
			const review = [];
			for (const file of files) {
				const text = readFileSync(join(root, file), "utf8");
				for (const { what, re } of hard) if (re.test(text)) findings.push(`${file}: ${what} (${re.exec(text)[0].slice(0, 40)})`);
				for (const m of text.matchAll(soft)) review.push(`${file}: ${m[0].slice(0, 12)}… (${m[0].length} chars)`);
			}
			check("packed contents: no user name, local paths, keys or tokens", findings.length === 0, findings.join("; "));
			if (review.length) console.log(`note: ${review.length} long mixed-case token(s) to eyeball:\n  ${review.join("\n  ")}`);
			// npx on the tarball, offline: its one dependency (jose) comes from a tarball of the installed copy.
			const jose = npm(["pack", "--json", "--pack-destination", out, join(root, "node_modules", "jose")], root);
			let joseFile;
			try {
				joseFile = JSON.parse(jose.stdout)[0].filename;
			} catch {}
			check("npm pack node_modules/jose (for an offline install)", Boolean(joseFile), joseFile ?? jose.stderr.trim().slice(-200));
			if (joseFile) {
				const args = ["--yes", "--offline", `--package=./${joseFile}`, `--package=./${info.filename}`, "--", "typetorch-dev-server", "--help"];
				const run = spawnSync("npx", args, { cwd: out, encoding: "utf8", shell: win, windowsHide: true });
				check("npx ./<tarball> --help (offline)", run.status === 0 && run.stdout.includes("typetorch-dev-server remote-claude --users"), `exit ${run.status}${run.status ? `: ${(run.stderr || run.stdout).trim().slice(-400)}` : ""}`);
			}
		}
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
