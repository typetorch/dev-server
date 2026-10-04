/**
 * Image attachments (screenshots from the game), saved as PNGs in the session's own temp folder OUTSIDE the worktree
 * (owner-only), so they can never be committed. Three ways in:
 *   - POST /v1/attachments: raw RGBA8 pixels from the game (zstd or not, base64), every size checked;
 *   - POST /v1/attachments/capture: the screenshot the Roblox client wrote on this PC (images.ts pickUpCapture), the
 *     main path; Roblox's own file is only read, the session keeps a downscaled copy;
 *   - POST /v1/attachments/asset: a capture the game uploaded with CaptureService, downloaded with Open Cloud.
 * Captures and downloads are downscaled to at most 1568 px on the long side. A prompt references attachments by id;
 * when its run starts they are moved into that run's own temp folder (Claude gets `--add-dir` for it) and the folder
 * is deleted when the run ends. Attachments never sent with a prompt are deleted after 30 minutes, and the whole
 * folder when the session ends. Pixels are never logged.
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { CLAUDE_IMAGE_SIDE, downscale, type Rgba } from "./images";
import { encodePng } from "./png";

export const ATTACHMENT_LIMITS = {
	/** Longest side in pixels of a raw upload (and the EditableImage maximum). */
	maxSide: 1024,
	/** width × height × 4. */
	maxRawBytes: 4 * 1024 * 1024,
	/** The decoded `data` (compressed or not). */
	maxDataBytes: 2 * 1024 * 1024,
	/** The JSON body (base64 of maxDataBytes plus the other fields). */
	maxBodyBytes: 3 * 1024 * 1024,
	perMessage: 4,
	/** Per user, per session (every source). */
	perUser: 40,
	/** Attachments a user holds without having sent them yet. */
	unusedPerUser: 8,
	/** An attachment not sent with a prompt within this long is deleted. */
	unusedTtlMs: 30 * 60_000,
	/** Capture pickups and asset downloads per user per minute. */
	fetchesPerMinute: 10,
} as const;

export const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface AttachmentRequest {
	width: number;
	height: number;
	format: "rgba8";
	compression: "zstd" | "none";
	data: string;
}

export type AttachmentSource = "upload" | "capture" | "asset";

export interface Attachment {
	id: string;
	userId: number;
	width: number;
	height: number;
	source: AttachmentSource;
	/** Absolute path of the PNG (outside the worktree; inside the run's folder while its prompt runs). */
	path: string;
	pngBytes: number;
	/** Unix ms. */
	createdAt: number;
	/** The prompt that used it (each attachment goes with one prompt). */
	promptId?: string;
	/** Its file was deleted (the prompt ended, it expired unused, or the session stopped). */
	released?: boolean;
}

/** Frame_Content_Size of a single zstd frame: a number, undefined when the frame doesn't say, or "invalid". */
export function zstdContentSize(data: Uint8Array): number | undefined | "invalid" {
	if (data.length < 6 || data[0] !== 0x28 || data[1] !== 0xb5 || data[2] !== 0x2f || data[3] !== 0xfd) return "invalid";
	const descriptor = data[4];
	if (descriptor & 0x08) return "invalid"; // reserved bit
	const fcsFlag = descriptor >> 6;
	const singleSegment = (descriptor >> 5) & 1;
	const dictFlag = descriptor & 3;
	const pos = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][dictFlag];
	const size = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [1, 2, 4, 8][fcsFlag];
	if (size === 0) return undefined;
	if (data.length < pos + size) return "invalid";
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (size === 1) return data[pos];
	if (size === 2) return view.getUint16(pos, true) + 256;
	if (size === 4) return view.getUint32(pos, true);
	const high = view.getUint32(pos + 4, true);
	if (high > 0x1fffff) return "invalid";
	return high * 2 ** 32 + view.getUint32(pos, true);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** RGBA8 pixels from an upload, or a short reason. Every size is checked before anything is allocated or inflated. */
export function decodeAttachment(request: AttachmentRequest): Uint8Array | string {
	const { width, height, compression, data } = request;
	const raw = width * height * 4;
	if (raw > ATTACHMENT_LIMITS.maxRawBytes) return "image too large";
	if (data.length % 4 !== 0 || !BASE64.test(data)) return "data is not base64";
	if ((data.length / 4) * 3 > ATTACHMENT_LIMITS.maxDataBytes + 3) return "data too large";
	const bytes = new Uint8Array(Buffer.from(data, "base64"));
	if (bytes.length > ATTACHMENT_LIMITS.maxDataBytes) return "data too large";
	if (compression === "none") return bytes.length === raw ? bytes : "data size is not width × height × 4";
	const declared = zstdContentSize(bytes);
	if (declared === "invalid") return "not a zstd frame";
	if (declared !== undefined && declared !== raw) return "zstd size is not width × height × 4";
	let pixels: Uint8Array;
	try {
		pixels = new Uint8Array(zstdDecompressSync(bytes, { maxOutputLength: raw }));
	} catch {
		return "zstd data is invalid or too large";
	}
	return pixels.length === raw ? pixels : "decompressed size is not width × height × 4";
}

function newAttachmentId(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

/** Moves an attachment's file into `dir` (a run's folder) and updates its path. */
export function moveAttachment(attachment: Attachment, dir: string): void {
	const target = join(dir, `screenshot-${attachment.id.slice(0, 8)}.png`);
	try {
		renameSync(attachment.path, target);
	} catch {
		// Another volume: copy, then delete the original.
		copyFileSync(attachment.path, target);
		rmSync(attachment.path, { force: true });
	}
	attachment.path = target;
}

export class AttachmentStore {
	private readonly items = new Map<string, Attachment>();
	private readonly perUser = new Map<number, number>();

	/** `dir` is the session's attachments folder (absolute, outside the worktree), created on first use. */
	constructor(
		readonly dir: string,
		private readonly now: () => number = Date.now,
	) {}

	/** Attachments this user created this session (the quota counts every one). */
	count(userId: number): number {
		return this.perUser.get(userId) ?? 0;
	}

	/** Attachments this user holds that no prompt used yet. */
	unused(userId: number): number {
		this.prune();
		let count = 0;
		for (const attachment of this.items.values()) if (attachment.userId === userId && attachment.promptId === undefined && !attachment.released) count += 1;
		return count;
	}

	/** "quota" when the user can't add another one now. */
	refusal(userId: number): "quota" | undefined {
		return this.count(userId) >= ATTACHMENT_LIMITS.perUser || this.unused(userId) >= ATTACHMENT_LIMITS.unusedPerUser ? "quota" : undefined;
	}

	get(id: string): Attachment | undefined {
		return this.items.get(id);
	}

	/** Decodes, encodes and saves a raw upload. A string is the reason it was refused. */
	add(userId: number, request: AttachmentRequest): Attachment | "quota" | string {
		if (this.refusal(userId)) return "quota";
		const pixels = decodeAttachment(request);
		if (typeof pixels === "string") return pixels;
		return this.save(userId, { width: request.width, height: request.height, pixels }, "upload");
	}

	/** Saves a decoded image (capture pickup, asset download), downscaled for Claude. */
	addImage(userId: number, image: Rgba, source: AttachmentSource): Attachment | "quota" {
		if (this.refusal(userId)) return "quota";
		return this.save(userId, downscale(image, CLAUDE_IMAGE_SIDE), source);
	}

	private save(userId: number, image: Rgba, source: AttachmentSource): Attachment {
		const png = encodePng(image.width, image.height, image.pixels);
		const id = newAttachmentId();
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const path = join(this.dir, `${id}.png`);
		writeFileSync(path, png, { mode: 0o600 });
		const attachment: Attachment = { id, userId, width: image.width, height: image.height, source, path, pngBytes: png.length, createdAt: this.now() };
		this.items.set(id, attachment);
		this.perUser.set(userId, this.count(userId) + 1);
		return attachment;
	}

	/** The attachments for a new prompt: every id must belong to `userId` and be unused. Nothing is marked yet. */
	check(ids: readonly string[], userId: number): Attachment[] | undefined {
		this.prune();
		const found: Attachment[] = [];
		for (const id of ids) {
			const attachment = this.items.get(id);
			if (!attachment || attachment.userId !== userId || attachment.promptId !== undefined || attachment.released) return undefined;
			found.push(attachment);
		}
		return found;
	}

	/** Deletes attachments nobody sent within ATTACHMENT_LIMITS.unusedTtlMs. */
	prune(): void {
		const now = this.now();
		for (const attachment of this.items.values()) {
			if (attachment.promptId === undefined && !attachment.released && now - attachment.createdAt >= ATTACHMENT_LIMITS.unusedTtlMs) releaseAttachments([attachment]);
		}
	}

	/** Deletes every saved file (session end). */
	clear(): void {
		for (const attachment of this.items.values()) attachment.released = true;
		rmSync(this.dir, { recursive: true, force: true });
	}
}

/**
 * Deletes what a crashed session left in the temp folder: `tt-rc-att-*` (attachments) and `tt-rc-logs-*` (run
 * folders) untouched for `maxAgeMs` (default 2 hours, far longer than an unused attachment or a run may live, so a
 * live session's folders are never in the way). Returns how many folders went.
 */
export function sweepStaleTempFolders(root: string, maxAgeMs = 2 * 60 * 60_000, now = Date.now()): number {
	let removed = 0;
	let names: string[] = [];
	try {
		names = readdirSync(root);
	} catch {
		return 0;
	}
	for (const name of names) {
		if (!/^tt-rc-(att|logs)-[A-Za-z0-9]+$/.test(name)) continue;
		const path = join(root, name);
		try {
			const stat = lstatSync(path);
			if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < maxAgeMs) continue;
			rmSync(path, { recursive: true, force: true });
			removed += 1;
		} catch {}
	}
	return removed;
}

/** Deletes the files of attachments (their prompt finished, or they expired unused). Roblox's own files are never touched. */
export function releaseAttachments(attachments: readonly Attachment[]): void {
	for (const attachment of attachments) {
		if (attachment.released) continue;
		attachment.released = true;
		rmSync(attachment.path, { force: true });
	}
}
