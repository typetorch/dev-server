/**
 * `toolbox.lock.toml` (plans/14 "toolbox_add"): the Creator Store assets a project uses by reference. Written only by
 * the dev-server (Claude's toolbox_add tool), never by Claude's file tools: it is a protected file, and the dev-server
 * remembers the SHA-256 of its own last write so the protected-file check can accept exactly that change.
 *
 *   [assets."toolbox/icons/coin"]
 *   kind = "image"
 *   storeId = 15589362420          # the Creator Store asset
 *   assetId = 15589362394          # what the game loads (a Decal's image, the audio, the mesh, the model)
 *   ...
 *
 * Assets are referenced by id and never re-uploaded (Creator Terms). The CLI merges the lock into the artifact asset
 * map later (plans/14 build step 3); until then the ids are used directly.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolboxAsset, ToolboxType } from "./toolbox";

export const TOOLBOX_LOCK_FILE = "toolbox.lock.toml";
/** Typed asset paths: "toolbox/" then 1–5 lowercase segments. */
export const TOOLBOX_PATH_PATTERN = /^toolbox(?:\/[a-z0-9][a-z0-9_-]{0,39}){1,5}$/;
export const TOOLBOX_LOCK_LIMITS = { entries: 500, fileBytes: 512 * 1024 } as const;

export type ToolboxKind = "image" | "sound" | "mesh" | "model";
export const KIND_OF: Record<ToolboxType, ToolboxKind> = { Decal: "image", Audio: "sound", MeshPart: "mesh", Model: "model" };

export interface ToolboxLockEntry {
	path: string;
	kind: ToolboxKind;
	/** The Creator Store asset id. */
	storeId: number;
	/** What the game loads: a Decal's image id, the audio id, a MeshPart's mesh id, the model id. */
	assetId: number;
	/** MeshPart: its texture (0 = none). */
	textureId?: number;
	name: string;
	/** "user/<id>" or "group/<id>". */
	creator: string;
	creatorName: string;
	verified: boolean;
	scripts: number;
	updated: string;
	addedBy: string;
	added: string;
	/** Models only: sha256 of the sanitized tree (spike T6); "" until then. */
	fingerprint: string;
}

const KEYS: Record<string, "string" | "integer" | "boolean"> = {
	kind: "string",
	storeId: "integer",
	assetId: "integer",
	textureId: "integer",
	name: "string",
	creator: "string",
	creatorName: "string",
	verified: "boolean",
	scripts: "integer",
	updated: "string",
	addedBy: "string",
	added: "string",
	fingerprint: "string",
};
const KINDS = new Set<string>(["image", "sound", "mesh", "model"]);

/** A TOML basic string: quotes, backslashes and every control character escaped. */
export function tomlString(value: string): string {
	let out = '"';
	for (const char of value) {
		const code = char.codePointAt(0)!;
		if (char === '"') out += '\\"';
		else if (char === "\\") out += "\\\\";
		else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) out += `\\u${code.toString(16).padStart(4, "0")}`;
		else out += char;
	}
	return `${out}"`;
}

function parseTomlString(text: string): string | undefined {
	if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return undefined;
	let out = "";
	const body = text.slice(1, -1);
	for (let i = 0; i < body.length; i++) {
		const char = body[i];
		if (char === '"') return undefined;
		if (char !== "\\") {
			out += char;
			continue;
		}
		const next = body[++i];
		if (next === '"' || next === "\\") out += next;
		else if (next === "n") out += "\n";
		else if (next === "t") out += "\t";
		else if (next === "r") out += "\r";
		else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(body.slice(i + 1, i + 5))) {
			out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
			i += 4;
		} else return undefined;
	}
	return out;
}

/** Drops a trailing `# comment` that is outside a string. */
function stripComment(line: string): string {
	let inString = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === "\\" && inString) i++;
		else if (char === '"') inString = !inString;
		else if (char === "#" && !inString) return line.slice(0, i);
	}
	return line;
}

/**
 * Reads the lock (the subset of TOML the dev-server writes: `[assets."<path>"]` tables of string, integer and boolean
 * keys, comments, blank lines). A string is the reason it can't be read; nothing is written then.
 */
export function parseToolboxLock(text: string): Map<string, ToolboxLockEntry> | string {
	const entries = new Map<string, ToolboxLockEntry>();
	let current: Record<string, unknown> | undefined;
	let currentPath = "";
	const finish = (): string | undefined => {
		if (!current) return undefined;
		const entry = current as unknown as ToolboxLockEntry;
		if (typeof entry.kind !== "string" || !KINDS.has(entry.kind)) return `${currentPath}: kind must be image, sound, mesh or model`;
		if (typeof entry.storeId !== "number" || typeof entry.assetId !== "number") return `${currentPath}: storeId and assetId are required`;
		entries.set(currentPath, {
			path: currentPath,
			kind: entry.kind,
			storeId: entry.storeId,
			assetId: entry.assetId,
			...(typeof entry.textureId === "number" ? { textureId: entry.textureId } : {}),
			name: typeof entry.name === "string" ? entry.name : "",
			creator: typeof entry.creator === "string" ? entry.creator : "",
			creatorName: typeof entry.creatorName === "string" ? entry.creatorName : "",
			verified: entry.verified === true,
			scripts: typeof entry.scripts === "number" ? entry.scripts : 0,
			updated: typeof entry.updated === "string" ? entry.updated : "",
			addedBy: typeof entry.addedBy === "string" ? entry.addedBy : "",
			added: typeof entry.added === "string" ? entry.added : "",
			fingerprint: typeof entry.fingerprint === "string" ? entry.fingerprint : "",
		});
		current = undefined;
		return undefined;
	};
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = stripComment(lines[index]).trim();
		if (line === "") continue;
		const where = `line ${index + 1}`;
		const header = /^\[\s*assets\s*\.\s*("(?:[^"\\]|\\.)*")\s*\]$/.exec(line);
		if (header) {
			const problem = finish();
			if (problem) return problem;
			const path = parseTomlString(header[1]);
			if (path === undefined || !TOOLBOX_PATH_PATTERN.test(path)) return `${where}: bad asset path`;
			if (entries.has(path)) return `${where}: ${path} appears twice`;
			currentPath = path;
			current = {};
			continue;
		}
		const pair = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(line);
		if (!pair || !current) return `${where}: not understood (only [assets."toolbox/..."] tables are allowed)`;
		const [, key, rawValue] = pair;
		const type = KEYS[key];
		if (!type) continue; // unknown keys are ignored (and dropped on the next write)
		const value = rawValue.trim();
		if (type === "string") {
			const parsed = parseTomlString(value);
			if (parsed === undefined) return `${where}: ${key} must be a string`;
			current[key] = parsed;
		} else if (type === "integer") {
			if (!/^\d{1,16}$/.test(value)) return `${where}: ${key} must be a whole number`;
			current[key] = Number(value);
		} else {
			if (value !== "true" && value !== "false") return `${where}: ${key} must be true or false`;
			current[key] = value === "true";
		}
	}
	const problem = finish();
	if (problem) return problem;
	return entries;
}

/** The lock file text: a header, then the entries sorted by path. */
export function formatToolboxLock(entries: Iterable<ToolboxLockEntry>): string {
	const lines = [
		"# Creator Store assets used by reference (TypeTorch remote-claude toolbox_add, plans/14).",
		"# Written by the TypeTorch dev-server; never re-uploaded. Edit by removing whole [assets.\"...\"] tables only.",
	];
	for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		lines.push("", `[assets.${tomlString(entry.path)}]`);
		lines.push(`kind = ${tomlString(entry.kind)}`);
		lines.push(`storeId = ${entry.storeId}`);
		lines.push(`assetId = ${entry.assetId}`);
		if (entry.textureId !== undefined) lines.push(`textureId = ${entry.textureId}`);
		lines.push(`name = ${tomlString(entry.name)}`);
		lines.push(`creator = ${tomlString(entry.creator)}`);
		lines.push(`creatorName = ${tomlString(entry.creatorName)}`);
		lines.push(`verified = ${entry.verified}`);
		lines.push(`scripts = ${entry.scripts}`);
		lines.push(`updated = ${tomlString(entry.updated)}`);
		lines.push(`addedBy = ${tomlString(entry.addedBy)}`);
		lines.push(`added = ${tomlString(entry.added)}`);
		lines.push(`fingerprint = ${tomlString(entry.fingerprint)}`);
	}
	return `${lines.join("\n")}\n`;
}

/** A search snapshot → its lock entry, or the reason it can't be added. */
export function lockEntryFor(asset: ToolboxAsset, path: string, addedBy: string, now = new Date()): ToolboxLockEntry | string {
	if (!TOOLBOX_PATH_PATTERN.test(path)) return 'path must look like "toolbox/<folder>/<name>" (lowercase letters, digits, "-" and "_"; at most 5 segments)';
	const kind = KIND_OF[asset.type];
	let assetIdToLoad: number | undefined;
	if (kind === "image") assetIdToLoad = asset.textureId;
	else if (kind === "mesh") assetIdToLoad = asset.meshId;
	else assetIdToLoad = asset.id;
	if (assetIdToLoad === undefined) return `the search result has no ${kind === "image" ? "image (texture) id" : "mesh id"} for ${asset.id}`;
	return {
		path,
		kind,
		storeId: asset.id,
		assetId: assetIdToLoad,
		...(kind === "mesh" ? { textureId: asset.textureId ?? 0 } : {}),
		name: asset.name,
		creator: `${asset.creator.kind}/${asset.creator.id}`,
		creatorName: asset.creator.name,
		verified: asset.creator.verified,
		scripts: asset.scripts ?? 0,
		updated: asset.updateTime ?? "",
		addedBy,
		added: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
		fingerprint: "",
	};
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** The lock file of one worktree. Only `add` writes it. */
export class ToolboxLock {
	/** SHA-256 of the file as this dev-server last wrote it. */
	private lastWrite: string | undefined;

	constructor(private readonly worktree: string) {}

	get file(): string {
		return join(this.worktree, TOOLBOX_LOCK_FILE);
	}

	read(): Map<string, ToolboxLockEntry> | string {
		if (!existsSync(this.file)) return new Map();
		const bytes = readFileSync(this.file);
		if (bytes.length > TOOLBOX_LOCK_LIMITS.fileBytes) return `${TOOLBOX_LOCK_FILE} is too large`;
		return parseToolboxLock(bytes.toString("utf8"));
	}

	/** Adds (or replaces) one entry; a string is the reason nothing was written. */
	add(entry: ToolboxLockEntry): { ok: true; replaced: boolean } | string {
		const entries = this.read();
		if (typeof entries === "string") return `${TOOLBOX_LOCK_FILE} can't be read (${entries}); nothing was written`;
		const replaced = entries.has(entry.path);
		if (!replaced && entries.size >= TOOLBOX_LOCK_LIMITS.entries) return `${TOOLBOX_LOCK_FILE} already has ${TOOLBOX_LOCK_LIMITS.entries} entries`;
		entries.set(entry.path, entry);
		const text = formatToolboxLock(entries.values());
		const temp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temp, text, "utf8");
		renameSync(temp, this.file);
		this.lastWrite = sha256(text);
		return { ok: true, replaced };
	}

	/** True when the file on disk is exactly what this dev-server last wrote (so a changed lock isn't Claude's edit). */
	isOwnWrite(): boolean {
		if (this.lastWrite === undefined || !existsSync(this.file)) return false;
		return sha256(readFileSync(this.file)) === this.lastWrite;
	}

	/** After a discard or a worktree reset the remembered write no longer applies. */
	forgetWrite(): void {
		this.lastWrite = undefined;
	}
}
