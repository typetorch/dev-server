/**
 * Images in the chat (spike S11). Pixels and base64 are never logged; only file names, sizes and timing.
 *
 * Decoding: PNG in TS (8-bit gray/RGB/palette/gray+alpha/RGBA, non-interlaced, all five row filters); JPEG, WebP, GIF,
 * BMP and the PNGs the TS decoder doesn't handle (16-bit, interlaced, low bit depths) through ffmpeg, with the input
 * format fixed from the file's magic bytes (never auto-probed, so a playlist or other container can't make ffmpeg open
 * anything) and only the pipe protocol allowed. Downscaling is an area average (box filter).
 *
 * Game → Claude, main path: the dev's client takes a CaptureService screenshot; the Roblox client on THIS PC writes it to
 * `%LOCALAPPDATA%\Roblox\tmp-capture-storage\<userId>_<placeId>_<unixMs>.png`. The game server sends the capture time
 * (the client's clock, which is this PC's clock), and `pickUpCapture` finds the file of the requesting user (never
 * another user's) closest to that time, polling while Roblox writes it. The original is only read, never moved,
 * changed or deleted; the dev server keeps its own downscaled copy (attachments.ts).
 *
 * Game → Claude, fallback (the dev plays on another PC): the client uploads the capture with CaptureService and the dev
 * server downloads the asset with the Open Cloud key (`openCloudAssetDownloader`).
 *
 * Claude → game: images Claude shows with Markdown (`![caption](path)`, a file in the worktree) become RGBA8 at most
 * 1024 px per side, zstd-compressed, served in base64 chunks to the requesting dev's game server only
 * (GET /v1/images/:id?chunk=n), which relays them to that dev's client (EditableImage).
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants as zlibConstants, inflateSync, zstdCompressSync } from "node:zlib";
import { childEnv } from "./env";
import { PNG_SIGNATURE } from "./png";

export interface Rgba {
	width: number;
	height: number;
	/** width × height × 4 bytes, rows top to bottom. */
	pixels: Uint8Array;
}

/** Longest side of images handed to Claude (its vision input is about this size; bigger only costs tokens). */
export const CLAUDE_IMAGE_SIDE = 1568;
/** Longest side of images sent to the game (the EditableImage maximum). */
export const GAME_IMAGE_SIDE = 1024;
/** Source files larger than this are refused before reading. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Decoded sources larger than this many pixels are refused (a 16k × 16k image would need 1 GB). */
export const MAX_SOURCE_PIXELS = 40_000_000;
/** A game image's zstd data is kept under this (it is downscaled further until it fits). */
export const MAX_GAME_IMAGE_BYTES = 2 * 1024 * 1024;

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a PNG into RGBA8, or throws for anything it doesn't support (16-bit, interlaced, bit depths below 8). */
export function decodePng(file: Uint8Array): Rgba {
	if (file.length < 8) throw new Error("not a PNG");
	for (let i = 0; i < 8; i++) if (file[i] !== PNG_SIGNATURE[i]) throw new Error("not a PNG");
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	let pos = 8;
	let width = 0;
	let height = 0;
	let depth = 0;
	let colorType = 0;
	let interlace = 0;
	let palette: Uint8Array | undefined;
	let alphaTable: Uint8Array | undefined;
	const idat: Uint8Array[] = [];
	let sawHeader = false;
	while (pos + 8 <= file.length) {
		const length = view.getUint32(pos);
		const type = String.fromCharCode(file[pos + 4], file[pos + 5], file[pos + 6], file[pos + 7]);
		if (pos + 12 + length > file.length) throw new Error("truncated PNG");
		const data = file.subarray(pos + 8, pos + 8 + length);
		if (!sawHeader && type !== "IHDR") throw new Error("PNG without a header");
		if (type === "IHDR") {
			if (length !== 13) throw new Error("bad PNG header");
			sawHeader = true;
			width = view.getUint32(pos + 8);
			height = view.getUint32(pos + 12);
			depth = data[8];
			colorType = data[9];
			interlace = data[12];
		} else if (type === "PLTE") palette = data;
		else if (type === "tRNS") alphaTable = data;
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		pos += 12 + length;
	}
	if (width <= 0 || height <= 0 || width * height > MAX_SOURCE_PIXELS) throw new Error("bad PNG size");
	if (depth !== 8 || interlace !== 0) throw new Error("unsupported PNG (bit depth or interlace)");
	const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
	if (channels === 0 || (colorType === 3 && !palette)) throw new Error("unsupported PNG color type");
	const stride = width * channels;
	// The output cap is exactly what a valid image inflates to, so a deflate bomb stops there.
	const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
	if (raw.length < (stride + 1) * height) throw new Error("truncated PNG");
	const rows = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const out = y * stride;
		if (filter > 4) throw new Error("bad PNG filter");
		for (let x = 0; x < stride; x++) {
			const value = raw[src + x];
			const a = x >= channels ? rows[out + x - channels] : 0;
			const b = y > 0 ? rows[out - stride + x] : 0;
			let result: number;
			if (filter === 0) result = value;
			else if (filter === 1) result = value + a;
			else if (filter === 2) result = value + b;
			else if (filter === 3) result = value + ((a + b) >> 1);
			else result = value + paeth(a, b, x >= channels && y > 0 ? rows[out - stride + x - channels] : 0);
			rows[out + x] = result & 0xff;
		}
	}
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0, p = 0; i < width * height; i++, p += 4) {
		const s = i * channels;
		if (colorType === 6) {
			pixels[p] = rows[s];
			pixels[p + 1] = rows[s + 1];
			pixels[p + 2] = rows[s + 2];
			pixels[p + 3] = rows[s + 3];
		} else if (colorType === 2) {
			pixels[p] = rows[s];
			pixels[p + 1] = rows[s + 1];
			pixels[p + 2] = rows[s + 2];
			pixels[p + 3] = 255;
		} else if (colorType === 0 || colorType === 4) {
			pixels[p] = pixels[p + 1] = pixels[p + 2] = rows[s];
			pixels[p + 3] = colorType === 4 ? rows[s + 1] : 255;
		} else {
			const index = rows[s];
			pixels[p] = palette![index * 3] ?? 0;
			pixels[p + 1] = palette![index * 3 + 1] ?? 0;
			pixels[p + 2] = palette![index * 3 + 2] ?? 0;
			pixels[p + 3] = alphaTable && index < alphaTable.length ? alphaTable[index] : 255;
		}
	}
	return { width, height, pixels };
}

/** Area-average downscale so the longest side is at most `maxSide` (returns the input when it already fits). */
export function downscale(image: Rgba, maxSide: number): Rgba {
	const { width, height, pixels } = image;
	const longest = Math.max(width, height);
	if (longest <= maxSide) return image;
	const scale = maxSide / longest;
	const tw = Math.max(1, Math.min(maxSide, Math.round(width * scale)));
	const th = Math.max(1, Math.min(maxSide, Math.round(height * scale)));
	const out = new Uint8Array(tw * th * 4);
	const sums = new Float64Array(tw * 4);
	const counts = new Float64Array(tw);
	const columnOf = new Int32Array(width);
	for (let x = 0; x < width; x++) columnOf[x] = Math.min(tw - 1, Math.floor((x * tw) / width));
	let row = 0;
	for (let ty = 0; ty < th; ty++) {
		const end = ty === th - 1 ? height : Math.min(height, Math.floor(((ty + 1) * height) / th));
		sums.fill(0);
		counts.fill(0);
		for (; row < end; row++) {
			const base = row * width * 4;
			for (let x = 0; x < width; x++) {
				const tx = columnOf[x];
				const s = base + x * 4;
				const t = tx * 4;
				sums[t] += pixels[s];
				sums[t + 1] += pixels[s + 1];
				sums[t + 2] += pixels[s + 2];
				sums[t + 3] += pixels[s + 3];
				counts[tx] += 1;
			}
		}
		for (let tx = 0; tx < tw; tx++) {
			const n = counts[tx] || 1;
			const o = (ty * tw + tx) * 4;
			out[o] = Math.round(sums[tx * 4] / n);
			out[o + 1] = Math.round(sums[tx * 4 + 1] / n);
			out[o + 2] = Math.round(sums[tx * 4 + 2] / n);
			out[o + 3] = Math.round(sums[tx * 4 + 3] / n);
		}
	}
	return { width: tw, height: th, pixels: out };
}

/**
 * The part of an image inside a normalized rectangle (0..1 from the top left), at least 1 × 1 pixel. Used for the
 * dev's crop of a screenshot, before downscaling.
 */
export function cropImage(image: Rgba, crop: { x: number; y: number; w: number; h: number }): Rgba {
	const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
	const left = clamp(Math.floor(crop.x * image.width), image.width - 1);
	const top = clamp(Math.floor(crop.y * image.height), image.height - 1);
	const right = clamp(Math.ceil((crop.x + crop.w) * image.width), image.width);
	const bottom = clamp(Math.ceil((crop.y + crop.h) * image.height), image.height);
	const width = Math.max(1, right - left);
	const height = Math.max(1, bottom - top);
	if (left === 0 && top === 0 && width === image.width && height === image.height) return image;
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const from = ((top + y) * image.width + left) * 4;
		pixels.set(image.pixels.subarray(from, from + width * 4), y * width * 4);
	}
	return { width, height, pixels };
}

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "bmp";

/** The image format from the magic bytes (never from a file name or a declared type). */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
	const at = (offset: number, ...values: number[]) => values.every((value, i) => bytes[offset + i] === value);
	if (bytes.length >= 8 && at(0, ...PNG_SIGNATURE)) return "png";
	if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "jpeg";
	if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
	if (bytes.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "gif";
	if (bytes.length >= 2 && at(0, 0x42, 0x4d)) return "bmp";
	return undefined;
}

/** ffmpeg's demuxer for each format: the input format is always given, never probed. */
const DEMUXER: Record<ImageFormat, string> = { png: "png_pipe", jpeg: "jpeg_pipe", webp: "webp_pipe", gif: "gif", bmp: "bmp_pipe" };

/** ffmpeg: TT_FFMPEG, else on PATH; undefined when it isn't installed. */
export function findFfmpeg(): string | undefined {
	const configured = process.env.TT_FFMPEG?.trim();
	if (configured) return existsSync(configured) ? configured : undefined;
	return Bun.which("ffmpeg") ?? undefined;
}

/** Reads a stream to the end, or throws once it passes `max` bytes. */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
	if (!stream) return new Uint8Array(0);
	const parts: Uint8Array[] = [];
	let total = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			throw new Error("too large");
		}
		parts.push(value);
	}
	return new Uint8Array(Buffer.concat(parts));
}

export interface DecodeOptions {
	/** The ffmpeg binary; default findFfmpeg(). `false` = never use ffmpeg. */
	ffmpeg?: string | false;
	timeoutMs?: number;
}

/** Any supported image file → RGBA8: PNGs in TS when possible, everything else through ffmpeg. */
export async function decodeImage(bytes: Uint8Array, options: DecodeOptions = {}): Promise<Rgba> {
	if (bytes.length > MAX_SOURCE_BYTES) throw new Error("image file too large");
	const format = sniffImageFormat(bytes);
	if (!format) throw new Error("not a PNG, JPEG, WebP, GIF or BMP image");
	let reason = "";
	if (format === "png") {
		try {
			return decodePng(bytes);
		} catch (error) {
			reason = (error as Error).message;
			if (reason === "bad PNG size" || reason === "not a PNG") throw error;
		}
	}
	const ffmpeg = options.ffmpeg === false ? undefined : (options.ffmpeg ?? findFfmpeg());
	if (!ffmpeg) throw new Error(`can't decode this ${format.toUpperCase()} without ffmpeg${reason ? ` (${reason})` : ""}`);
	const proc = Bun.spawn(
		[ffmpeg, "-hide_banner", "-v", "error", "-protocol_whitelist", "pipe", "-f", DEMUXER[format], "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-pix_fmt", "rgba", "pipe:1"],
		{ stdin: bytes, stdout: "pipe", stderr: "ignore", env: childEnv(), windowsHide: true },
	);
	const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 20_000);
	try {
		const [out, code] = await Promise.all([readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_SOURCE_PIXELS * 4 + 1024 * 1024), proc.exited]);
		if (code !== 0 || out.length === 0) throw new Error(`ffmpeg could not decode the image (exit ${code})`);
		return decodePng(out);
	} catch (error) {
		proc.kill();
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

// Capture pickup (game → Claude, main path) ---------------------------------------------------------------------------

/** Where the Roblox client saves screenshots on this PC (TT_CAPTURE_DIR overrides it). */
export function captureDir(): string {
	const configured = process.env.TT_CAPTURE_DIR?.trim();
	if (configured) return configured;
	if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Roblox", "tmp-capture-storage");
	return join(homedir(), "Library", "Roblox", "tmp-capture-storage");
}

/** `<userId>_<placeId>_<unixMs>.png` */
export const CAPTURE_NAME = /^(\d{1,19})_(\d{1,19})_(\d{10,16})\.png$/i;
/** A capture's LocalId may name its file stem; only these characters are ever used to build a file name. */
const LOCAL_ID_STEM = /(\d{1,19}_\d{1,19}_\d{10,16})/;

export interface CaptureQuery {
	/** The requesting dev (from the JWT): only their files are ever considered. */
	userId: number;
	/** The game's PlaceId; 0 or undefined = any place (Studio, unpublished places). */
	placeId?: number;
	/** The capture time in unix ms, on the dev's PC clock (the client sends it). */
	captureMs: number;
	/** Capture.LocalId: when it holds the file stem, that file is taken (if it is the user's). */
	localId?: string;
	/** Only files within this many ms of captureMs (default 5000). */
	windowMs?: number;
}

export interface CaptureMatch {
	file: string;
	name: string;
	/** File-name time minus the capture time, in ms. */
	deltaMs: number;
	/** Found through the LocalId. */
	exact: boolean;
}

/** The capture file of this user (and place) closest to the capture time, within the window; the LocalId's file first. */
export function findCaptureFile(dir: string, query: CaptureQuery): CaptureMatch | undefined {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return undefined;
	}
	const windowMs = query.windowMs ?? 5000;
	const ownFile = (name: string): { deltaMs: number } | undefined => {
		const m = CAPTURE_NAME.exec(name);
		if (!m || m[1] !== String(query.userId)) return undefined;
		if (query.placeId !== undefined && query.placeId > 0 && m[2] !== String(query.placeId)) return undefined;
		return { deltaMs: Number(m[3]) - query.captureMs };
	};
	const stem = query.localId ? LOCAL_ID_STEM.exec(query.localId)?.[1] : undefined;
	if (stem) {
		const name = names.find((candidate) => candidate.toLowerCase() === `${stem}.png`);
		const own = name ? ownFile(name) : undefined;
		if (name && own && Math.abs(own.deltaMs) <= 60_000) return { file: join(dir, name), name, deltaMs: own.deltaMs, exact: true };
	}
	let best: CaptureMatch | undefined;
	for (const name of names) {
		const own = ownFile(name);
		if (!own || Math.abs(own.deltaMs) > windowMs) continue;
		if (!best || Math.abs(own.deltaMs) < Math.abs(best.deltaMs)) best = { file: join(dir, name), name, deltaMs: own.deltaMs, exact: false };
	}
	return best;
}

const IEND_TRAILER = Uint8Array.of(0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82);

/** True unless the bytes are a PNG that doesn't end with its IEND chunk yet (a file still being written). */
export function pngComplete(bytes: Uint8Array): boolean {
	if (sniffImageFormat(bytes) !== "png") return true;
	if (bytes.length < 8 + IEND_TRAILER.length) return false;
	const tail = bytes.subarray(bytes.length - IEND_TRAILER.length);
	return IEND_TRAILER.every((value, i) => tail[i] === value);
}

export interface PickupOptions {
	/** How long to wait for the file (default 5000 ms). */
	timeoutMs?: number;
	/** Poll interval (default 150 ms). */
	pollMs?: number;
	/** A time match this close is taken at once; a farther one waits in case a closer file is still being written. */
	goodEnoughMs?: number;
}

export interface Pickup {
	match: CaptureMatch;
	bytes: Uint8Array;
	waitedMs: number;
}

/**
 * Waits for the capture file (Roblox may write it a moment after the capture callback) and reads it once its size is
 * stable. Regular files only (no links). The original is only read.
 */
export async function pickUpCapture(dir: string, query: CaptureQuery, options: PickupOptions = {}): Promise<Pickup | undefined> {
	const started = Date.now();
	const timeoutMs = options.timeoutMs ?? 5000;
	const goodEnoughMs = options.goodEnoughMs ?? 1500;
	let last: { file: string; size: number } | undefined;
	while (true) {
		const elapsed = Date.now() - started;
		const match = findCaptureFile(dir, query);
		if (match && (match.exact || Math.abs(match.deltaMs) <= goodEnoughMs || elapsed >= timeoutMs)) {
			let stat: { isFile(): boolean; isSymbolicLink(): boolean; size: number } | undefined;
			try {
				stat = lstatSync(match.file);
			} catch {}
			if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES)) return undefined;
			if (stat && stat.size > 0 && last?.file === match.file && last.size === stat.size) {
				let bytes: Uint8Array | undefined;
				try {
					bytes = new Uint8Array(readFileSync(match.file));
				} catch {}
				// A PNG still being written has no IEND trailer yet: keep waiting for the rest.
				if (bytes && pngComplete(bytes)) return { match, bytes, waitedMs: Date.now() - started };
			}
			last = stat ? { file: match.file, size: stat.size } : undefined;
		}
		// Past the timeout, only a file already being read (its size not settled yet) gets one more poll.
		if (elapsed >= timeoutMs && !(match && last?.file === match.file && elapsed < timeoutMs + 2000)) return undefined;
		await Bun.sleep(options.pollMs ?? 150);
	}
}

// Asset download (game → Claude, fallback) ----------------------------------------------------------------------------

export type AssetDownloader = (assetId: number) => Promise<Uint8Array>;

/**
 * Downloads an image asset with Open Cloud (asset delivery). The key goes only in the x-api-key header of the
 * apis.roblox.com request, never to the CDN. A Decal (XML that names its image) is followed once to that image.
 */
export function openCloudAssetDownloader(apiKey: string, fetchImpl: typeof fetch = fetch): AssetDownloader {
	const download = async (assetId: number, depth: number): Promise<Uint8Array> => {
		const meta = await fetchImpl(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`, {
			headers: { "x-api-key": apiKey },
			signal: AbortSignal.timeout(20_000),
		});
		if (!meta.ok) throw new Error(`asset delivery answered ${meta.status}`);
		const location = ((await meta.json()) as { location?: unknown }).location;
		if (typeof location !== "string" || !/^https:\/\/[A-Za-z0-9.-]+\.(rbxcdn\.com|roblox\.com)\//i.test(location)) throw new Error("asset delivery gave no CDN location");
		const file = await fetchImpl(location, { signal: AbortSignal.timeout(30_000) });
		if (!file.ok) throw new Error(`asset download answered ${file.status}`);
		const declared = Number(file.headers.get("content-length") ?? "0");
		if (declared > MAX_SOURCE_BYTES) throw new Error("asset too large");
		const bytes = await readCapped(file.body, MAX_SOURCE_BYTES).catch(() => {
			throw new Error("asset too large");
		});
		if (!sniffImageFormat(bytes) && depth === 0) {
			// A Decal: <roblox ...><Content name="Texture"><url>http://www.roblox.com/asset/?id=123</url>...
			const text = new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
			const id = /asset\/?\?id=(\d{1,19})/i.exec(text)?.[1];
			if (/<roblox/i.test(text) && id && Number.isSafeInteger(Number(id))) return download(Number(id), 1);
		}
		return bytes;
	};
	return (assetId) => download(assetId, 0);
}

// Claude → game ----------------------------------------------------------------------------------------------------------

export const IMAGE_ID_PATTERN = /^[0-9a-f]{32}$/;
/** Raw bytes per chunk (about 87 KB of base64 per response). */
export const IMAGE_CHUNK = 64 * 1024;
/** Images Claude may show per prompt. */
export const IMAGES_PER_PROMPT = 4;
/** Extensions Claude may show (the content is still checked by its magic bytes). */
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];

export interface OutgoingImage {
	id: string;
	promptId: string;
	userId: number;
	/** The game server (JWT job) that sent the prompt: the only one that may fetch it. */
	job: string;
	width: number;
	height: number;
	/** zstd of width × height × 4 RGBA8 bytes. */
	zstd: Uint8Array;
	createdAt: number;
}

export interface ImageMeta {
	id: string;
	width: number;
	height: number;
	/** zstd bytes. */
	bytes: number;
	chunks: number;
}

export function imageMeta(image: OutgoingImage): ImageMeta {
	return { id: image.id, width: image.width, height: image.height, bytes: image.zstd.length, chunks: Math.max(1, Math.ceil(image.zstd.length / IMAGE_CHUNK)) };
}

/** Images on their way to a game server, in memory only; the oldest go first past `maxBytes` or after `ttlMs`. */
export class ImageStore {
	private readonly items = new Map<string, OutgoingImage>();
	private bytes = 0;

	constructor(
		private readonly maxBytes = 64 * 1024 * 1024,
		private readonly ttlMs = 3 * 60 * 60_000,
	) {}

	get size(): number {
		return this.items.size;
	}

	get totalBytes(): number {
		return this.bytes;
	}

	add(image: Omit<OutgoingImage, "id" | "createdAt">, now = Date.now()): OutgoingImage {
		const stored: OutgoingImage = { ...image, id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"), createdAt: now };
		this.items.set(stored.id, stored);
		this.bytes += stored.zstd.length;
		for (const [oldId, old] of this.items) {
			if ((this.bytes <= this.maxBytes && now - old.createdAt < this.ttlMs) || oldId === stored.id) break;
			this.items.delete(oldId);
			this.bytes -= old.zstd.length;
		}
		return stored;
	}

	get(id: string, now = Date.now()): OutgoingImage | undefined {
		const image = this.items.get(id);
		if (image && now - image.createdAt >= this.ttlMs) {
			this.items.delete(id);
			this.bytes -= image.zstd.length;
			return undefined;
		}
		return image;
	}

	countFor(promptId: string): number {
		let count = 0;
		for (const image of this.items.values()) if (image.promptId === promptId) count += 1;
		return count;
	}

	chunk(image: OutgoingImage, index: number): { data: string; chunks: number } | undefined {
		const chunks = Math.max(1, Math.ceil(image.zstd.length / IMAGE_CHUNK));
		if (!Number.isInteger(index) || index < 0 || index >= chunks) return undefined;
		const part = image.zstd.subarray(index * IMAGE_CHUNK, (index + 1) * IMAGE_CHUNK);
		return { data: Buffer.from(part).toString("base64"), chunks };
	}

	clear(): void {
		this.items.clear();
		this.bytes = 0;
	}
}

export interface ImageRef {
	caption: string;
	path: string;
}

/** `![caption](path)` references in Markdown, in order. URLs (http, data, ...) are not files and are skipped. */
export function markdownImages(text: string): ImageRef[] {
	const found: ImageRef[] = [];
	const pattern = /!\[([^\]\n]{0,200})\]\(\s*<?([^)\s>]{1,400})>?(?:\s+"[^"\n]*")?\s*\)/g;
	for (const m of text.matchAll(pattern)) {
		const path = m[2];
		if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) continue;
		found.push({ caption: m[1].trim(), path });
	}
	return found;
}

/**
 * The absolute path of an image Claude referenced, or why it can't be shown. Only regular image files inside the
 * worktree (after resolving links), never in .git, never a .env file, at most MAX_SOURCE_BYTES.
 */
export function resolveImageRef(worktree: string, ref: string): { path: string; rel: string } | string {
	let path = ref.trim();
	try {
		path = decodeURI(path);
	} catch {}
	if (path.includes("\u0000")) return "bad path";
	const abs = isAbsolute(path) ? resolve(path) : resolve(worktree, path);
	let root: string;
	let real: string;
	try {
		root = realpathSync(worktree);
		real = realpathSync(abs);
	} catch {
		return "file not found";
	}
	const rel = relative(root, real);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return "only files in the worktree can be shown";
	const parts = rel.split(sep);
	if (parts.some((part) => part === ".git" || part.toLowerCase().startsWith(".env"))) return "that file can't be shown";
	if (!IMAGE_EXTENSIONS.includes(extname(real).toLowerCase())) return "not an image file";
	const stat = lstatSync(real);
	if (!stat.isFile()) return "not a file";
	if (stat.size > MAX_SOURCE_BYTES) return "file too large";
	return { path: real, rel: parts.join("/") };
}

/** RGBA8 for the game: at most GAME_IMAGE_SIDE per side, zstd under MAX_GAME_IMAGE_BYTES (smaller when it must). */
export function prepareGameImage(image: Rgba, maxBytes = MAX_GAME_IMAGE_BYTES): { width: number; height: number; zstd: Uint8Array } {
	let side = GAME_IMAGE_SIDE;
	while (true) {
		const scaled = downscale(image, side);
		const zstd = new Uint8Array(zstdCompressSync(scaled.pixels, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 9 } }));
		if (zstd.length <= maxBytes || side <= 64) return { width: scaled.width, height: scaled.height, zstd };
		side = Math.floor(Math.min(side, Math.max(scaled.width, scaled.height)) * 0.75);
	}
}
