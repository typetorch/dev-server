/**
 * Git: the repo's current branch and the dedicated remote-claude worktree.
 *
 * The worktree lives next to the repo (`<repo>/../<repo-name>-remote-claude`) so Claude never touches the dev's own
 * working copy. Git refuses to check out one branch in two worktrees, and the session branch is usually the one the
 * dev has checked out, so:
 *   - if the branch is free, the worktree works on it directly and commits land on it;
 *   - if it is checked out elsewhere, the worktree works on `remote-claude/<branch>`, which is fast-forwarded (or
 *     merged) to the branch head before every run; the dev merges it back with `git merge remote-claude/<branch>`.
 * Every commit made here runs with hooks disabled, because hook scripts are files Claude could have edited.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { childEnv } from "./env";
import { run } from "./proc";

export class GitError extends Error {
	override name = "GitError";
}

export async function git(cwd: string, args: string[], allowFail = false): Promise<string> {
	const result = await run(["git", "-c", "core.quotepath=off", ...args], { cwd, env: childEnv() });
	if (result.code !== 0 && !allowFail) {
		throw new GitError(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
	}
	return result.stdout.trim();
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
	const result = await run(["git", ...args], { cwd, env: childEnv() });
	return result.code === 0;
}

export function samePath(a: string, b: string): boolean {
	const norm = (p: string) => {
		const r = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
		return process.platform === "win32" ? r.toLowerCase() : r;
	};
	return norm(a) === norm(b);
}

export async function repoRoot(dir: string): Promise<string> {
	const top = await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => "");
	if (!top) throw new GitError(`${resolve(dir)} is not inside a git repository`);
	return resolve(top);
}

export async function currentBranch(dir: string): Promise<string> {
	const name = await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
	if (!name) throw new GitError("HEAD is detached; pass --branch <name>");
	return name;
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
	return gitOk(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

interface WorktreeEntry {
	path: string;
	branch?: string;
	prunable: boolean;
}

export async function worktrees(dir: string): Promise<WorktreeEntry[]> {
	const out = await git(dir, ["worktree", "list", "--porcelain"]);
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | undefined;
	for (const line of out.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			current = { path: resolve(line.slice(9)), prunable: false };
			entries.push(current);
		} else if (current && line.startsWith("branch ")) current.branch = line.slice(7);
		else if (current && line.startsWith("prunable")) current.prunable = true;
	}
	return entries;
}

export interface Worktree {
	repo: string;
	path: string;
	/** The session's git branch. */
	branch: string;
	/** The branch checked out in the worktree: `branch`, or `remote-claude/<branch>` when `branch` is in use. */
	workBranch: string;
}

export function worktreePathFor(repo: string): string {
	return resolve(repo, "..", `${basename(repo)}-remote-claude`);
}

/** Creates the dedicated worktree, or reuses it. */
export async function ensureWorktree(repo: string, branch: string): Promise<Worktree> {
	const path = worktreePathFor(repo);
	let list = await worktrees(repo);
	if (list.some((w) => samePath(w.path, path) && (w.prunable || !existsSync(path)))) {
		await git(repo, ["worktree", "prune"]);
		list = await worktrees(repo);
	}
	const inUse = list.some((w) => w.branch === `refs/heads/${branch}` && !samePath(w.path, path));
	const workBranch = inUse ? `remote-claude/${branch}` : branch;
	if (workBranch !== branch && !(await branchExists(repo, workBranch))) await git(repo, ["branch", workBranch, branch]);

	const existing = list.find((w) => samePath(w.path, path));
	if (!existing) {
		if (existsSync(path)) throw new GitError(`${path} exists but is not a worktree of ${repo}; move it away first`);
		await git(repo, ["worktree", "add", "--quiet", path, workBranch]);
	} else if (existing.branch !== `refs/heads/${workBranch}`) {
		await git(path, ["reset", "--hard", "--quiet"]);
		await git(path, ["clean", "-fd", "--quiet"]);
		await git(path, ["checkout", "--quiet", workBranch]);
	}
	return { repo, path, branch, workBranch };
}

function noHooks(): string[] {
	// A hooks path that does not exist disables every hook (pre-commit, commit-msg, post-commit, post-merge...).
	const dir = join(tmpdir(), `typetorch-no-hooks-${crypto.randomUUID()}`);
	return ["-c", `core.hooksPath=${dir.replace(/\\/g, "/")}`];
}

/**
 * Before each run: drop anything a failed or cancelled run left behind, then bring the work branch up to the session
 * branch head (fast-forward, or a merge when both moved). A conflicting merge is aborted and reported.
 */
export async function syncWorktree(wt: Worktree): Promise<string> {
	await git(wt.path, ["reset", "--hard", "--quiet"]);
	await git(wt.path, ["clean", "-fd", "--quiet"]);
	if (wt.workBranch !== wt.branch) {
		if (await gitOk(wt.path, ["merge-base", "--is-ancestor", wt.branch, "HEAD"])) {
			// Already contains the branch head.
		} else if (await gitOk(wt.path, ["merge-base", "--is-ancestor", "HEAD", wt.branch])) {
			await git(wt.path, ["merge", "--ff-only", "--quiet", wt.branch]);
		} else {
			const merged = await run(["git", ...noHooks(), "merge", "--no-edit", "--quiet", wt.branch], { cwd: wt.path, env: childEnv() });
			if (merged.code !== 0) {
				await git(wt.path, ["merge", "--abort"], true);
				throw new GitError(`${wt.workBranch} and ${wt.branch} conflict; merge them by hand (git merge ${wt.workBranch})`);
			}
		}
	}
	return git(wt.path, ["rev-parse", "HEAD"]);
}

/** Drops uncommitted changes and untracked files only (no merge): live runs while a deploy proposal is pending. */
export async function resetWorktree(wt: Worktree): Promise<string> {
	await git(wt.path, ["reset", "--hard", "--quiet"]);
	await git(wt.path, ["clean", "-fd", "--quiet"]);
	return git(wt.path, ["rev-parse", "HEAD"]);
}

/** The worktree's HEAD commit. */
export function worktreeHead(wt: Worktree): Promise<string> {
	return git(wt.path, ["rev-parse", "HEAD"]);
}

/** Moves the work branch back to `commit` (a discarded deploy proposal); the dropped commit stays in the reflog. */
export async function resetWorktreeTo(wt: Worktree, commit: string): Promise<void> {
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new GitError("bad commit");
	await git(wt.path, ["reset", "--hard", "--quiet", commit]);
	await git(wt.path, ["clean", "-fd", "--quiet"]);
}

export interface FileChange {
	path: string;
	/** Lines added and removed (-1 for binary files). */
	added: number;
	removed: number;
}

/** Changed files between two commits with their line counts (`git diff --numstat`). */
export async function diffStat(wt: Worktree, from: string, to: string): Promise<FileChange[]> {
	const out = await git(wt.path, ["diff", "--numstat", "-z", "--no-renames", from, to]);
	const changes: FileChange[] = [];
	for (const entry of out.split("\0")) {
		const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry.trim());
		if (!m) continue;
		changes.push({ path: m[3], added: m[1] === "-" ? -1 : Number(m[1]), removed: m[2] === "-" ? -1 : Number(m[2]) });
	}
	return changes;
}

export async function changedFiles(wt: Worktree): Promise<string[]> {
	await git(wt.path, ["add", "-A"]);
	const out = await git(wt.path, ["diff", "--cached", "--name-only", "-z"]);
	return out.split("\0").filter(Boolean);
}

/** Commits what `changedFiles` staged. Returns the new commit hash. */
export async function commitStaged(wt: Worktree, subject: string, trailer: string): Promise<string> {
	const result = await run(["git", ...noHooks(), "commit", "--no-verify", "--quiet", "-m", subject, "-m", trailer], {
		cwd: wt.path,
		env: childEnv(),
	});
	if (result.code !== 0) throw new GitError(`git commit failed: ${result.stderr.trim() || result.stdout.trim()}`);
	return git(wt.path, ["rev-parse", "HEAD"]);
}

/** Makes sure `relPath` is git-ignored in `repo`, adding it to the local `.git/info/exclude` (never a tracked file). */
export async function ensureIgnored(repo: string, relPath: string): Promise<void> {
	const rel = relPath.replace(/\\/g, "/");
	const checked = await run(["git", "check-ignore", "-q", rel], { cwd: repo, env: childEnv() });
	if (checked.code === 0) return;
	const exclude = resolve(repo, await git(repo, ["rev-parse", "--git-path", "info/exclude"]));
	mkdirSync(dirname(exclude), { recursive: true });
	const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
	const line = `/${rel}`;
	if (!current.split(/\r?\n/).includes(line)) appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}
