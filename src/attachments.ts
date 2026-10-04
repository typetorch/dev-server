/**
 * Image attachments (screenshots from the game). A game server uploads raw RGBA8 pixels, zstd-compressed or not, as
 * base64 JSON; the dev server checks every size, decompresses with a hard output cap, encodes a PNG itself and saves it
 * as `<worktree>/.typetorch/attachments/<id>.png` (git-ignored through .git/info/exclude, never committed, deleted when
 * the session ends). A prompt references attachments by id; the runner tells Claude the relative paths so it can open
 * them with its Read tool.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { encodePng } from "./png";

export const ATTACHMENT_LIMITS = {
	/** Longest side in pixels (and the EditableImage maximum). */
	maxSide: 1024,
	/** width × height × 4. */
	maxRawBytes: 4 * 1024 * 1024,
	/** The decoded `data` (compressed or not). */
	maxDataBytes: 2 * 1024 * 1024,
	/** The JSON body (base64 of maxDataBytes plus the other fields). */
	maxBodyBytes: 3 * 1024 * 1024,
	perMessage: 4,
	/** Per user, per session. */
	perUser: 20,
} as const;

export const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{32}$/;
/** Where attachments live, relative to the worktree (forward slashes, as Claude sees them). */
export const ATTACHMENT_DIR = ".typetorch/attachments";

export interface AttachmentRequest {
	width: number;
	height: number;
	format: "rgba8";
	compression: "zstd" | "none";
	data: string;
}

export interface Attachment {
	id: string;
	userId: number;
	width: number;
	height: number;
	/** Relative to the worktree, forward slashes. */
	relPath: string;
	pngBytes: number;
	createdAt: number;
	/** The prompt that used it (each attachment goes with one prompt). */
	promptId?: string;
}

/** Frame_Content_Size of a single zstd frame: a number, undefined when the frame doesn't say, or "invalid". */
export function zstdContentSize(data: Uint8Array): number | undefined | "invalid" {
	if (data.length < 6 || data[0] !== 0x28 || data[1] !== 0xb5 || data[2] !== 0x2f || data[3] !== 0xfd) return "invalid";
	const descriptor = data[4];
	if (descriptor & 0x08) return "invalid"; // reserved bit
	const fcsFlag = descriptor >> 6;
	const singleSegment = (descriptor >> 5) & 1;
	const dictFlag = descriptor & 3;
	let pos = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][dictFlag];
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

export class AttachmentStore {
	private readonly items = new Map<string, Attachment>();
	private readonly perUser = new Map<number, number>();

	/** `dir` is the absolute attachments folder inside the worktree (ATTACHMENT_DIR), created on first use. */
	constructor(readonly dir: string) {}

	count(userId: number): number {
		return this.perUser.get(userId) ?? 0;
	}

	get(id: string): Attachment | undefined {
		return this.items.get(id);
	}

	/** Decodes, encodes and saves an upload. A string is the reason it was refused. */
	add(userId: number, request: AttachmentRequest): Attachment | "quota" | string {
		if (this.count(userId) >= ATTACHMENT_LIMITS.perUser) return "quota";
		const pixels = decodeAttachment(request);
		if (typeof pixels === "string") return pixels;
		const png = encodePng(request.width, request.height, pixels);
		const id = newAttachmentId();
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, `${id}.png`), png);
		const attachment: Attachment = {
			id,
			userId,
			width: request.width,
			height: request.height,
			relPath: `${ATTACHMENT_DIR}/${id}.png`,
			pngBytes: png.length,
			createdAt: Math.floor(Date.now() / 1000),
		};
		this.items.set(id, attachment);
		this.perUser.set(userId, this.count(userId) + 1);
		return attachment;
	}

	/** The attachments for a new prompt: every id must belong to `userId` and be unused. Nothing is marked yet. */
	check(ids: readonly string[], userId: number): Attachment[] | undefined {
		const found: Attachment[] = [];
		for (const id of ids) {
			const attachment = this.items.get(id);
			if (!attachment || attachment.userId !== userId || attachment.promptId !== undefined) return undefined;
			found.push(attachment);
		}
		return found;
	}

	/** Deletes every saved file (session end). */
	clear(): void {
		this.items.clear();
		rmSync(this.dir, { recursive: true, force: true });
	}
}
