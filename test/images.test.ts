/**
 * Images (spike S11): the PNG decoder, downscaling and cropping, format sniffing and the ffmpeg path, capture pickup
 * (user id, place and time window, LocalId, files still being written), the capture / asset / image endpoints, the
 * screenshot game tool, temp-folder cleanup and limits. Everything on 127.0.0.1 with temp folders standing in for
 * Roblox's tmp-capture-storage.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { ATTACHMENT_LIMITS, sweepStaleTempFolders } from "../src/attachments";
import {
	CLAUDE_IMAGE_SIDE,
	GAME_IMAGE_SIDE,
	ImageStore,
	cropImage,
	decodeImage,
	decodePng,
	downscale,
	findCaptureFile,
	findFfmpeg,
	markdownImages,
	openCloudAssetDownloader,
	pickUpCapture,
	prepareGameImage,
	resolveImageRef,
	sniffImageFormat,
	type Rgba,
} from "../src/images";
import { silentLogger } from "../src/log";
import { crc32, encodePng, PNG_SIGNATURE } from "../src/png";
import type { Runner } from "../src/prompts";
import { wrapPrompt } from "../src/runner";
import { parseCaptureRequest, parseCrop, parsePromptRequest } from "../src/schema";
import { createRemoteClaudeServer, type RemoteClaudeServer } from "../src/server";

const JOB = "6f1c2b9e-3d4a-4b8c-9e7f-0a1b2c3d4e5f";
const USERS = Array.from({ length: 30 }, (_, i) => 9100 + i);
let nextUser = 0;
const user = () => USERS[nextUser++];
const PLACE = 13_000_000;

function gradient(width: number, height: number): Rgba {
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			pixels[i] = (x * 7) & 0xff;
			pixels[i + 1] = (y * 13) & 0xff;
			pixels[i + 2] = (x ^ y) & 0xff;
			pixels[i + 3] = 255 - ((x + y) & 0x7f);
		}
	}
	return { width, height, pixels };
}

function solid(width: number, height: number, rgba: number[]): Rgba {
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
	return { width, height, pixels };
}

const png = (image: Rgba) => encodePng(image.width, image.height, image.pixels);

// A PNG writer for the other color types, with every row filter (Sub, Up, Average, Paeth cycling) -------------------

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
	return out;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** `samples`: width × height × channels bytes. */
function writePng(width: number, height: number, colorType: number, samples: Uint8Array, extra: Uint8Array[] = []): Uint8Array {
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]!;
	const stride = width * channels;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		const filter = y % 5;
		raw[y * (stride + 1)] = filter;
		for (let x = 0; x < stride; x++) {
			const value = samples[y * stride + x];
			const a = x >= channels ? samples[y * stride + x - channels] : 0;
			const b = y > 0 ? samples[(y - 1) * stride + x] : 0;
			const c = x >= channels && y > 0 ? samples[(y - 1) * stride + x - channels] : 0;
			const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
			raw[y * (stride + 1) + 1 + x] = (value - predictor) & 0xff;
		}
	}
	const header = new Uint8Array(13);
	new DataView(header.buffer).setUint32(0, width);
	new DataView(header.buffer).setUint32(4, height);
	header.set([8, colorType, 0, 0, 0], 8);
	const parts = [PNG_SIGNATURE, chunk("IHDR", header), ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
	return new Uint8Array(Buffer.concat(parts));
}

describe("PNG decoding", () => {
	test("RGBA (our encoder) round-trips", () => {
		const image = gradient(33, 17);
		const decoded = decodePng(png(image));
		expect([decoded.width, decoded.height]).toEqual([33, 17]);
		expect(Buffer.from(decoded.pixels).equals(Buffer.from(image.pixels))).toBe(true);
	});

	test("RGB, gray, gray+alpha and palette (+tRNS) with all five row filters", () => {
		const w = 13;
		const h = 11;
		const rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 37) & 0xff);
		let decoded = decodePng(writePng(w, h, 2, rgb));
		for (let p = 0; p < w * h; p++) expect([...decoded.pixels.subarray(p * 4, p * 4 + 4)]).toEqual([rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2], 255]);
		const gray = new Uint8Array(w * h).map((_, i) => (i * 11) & 0xff);
		decoded = decodePng(writePng(w, h, 0, gray));
		for (let p = 0; p < w * h; p++) expect([...decoded.pixels.subarray(p * 4, p * 4 + 4)]).toEqual([gray[p], gray[p], gray[p], 255]);
		const ga = new Uint8Array(w * h * 2).map((_, i) => (i * 23) & 0xff);
		decoded = decodePng(writePng(w, h, 4, ga));
		for (let p = 0; p < w * h; p++) expect([...decoded.pixels.subarray(p * 4, p * 4 + 4)]).toEqual([ga[p * 2], ga[p * 2], ga[p * 2], ga[p * 2 + 1]]);
		const palette = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255);
		const indices = new Uint8Array(w * h).map((_, i) => i % 3);
		decoded = decodePng(writePng(w, h, 3, indices, [chunk("PLTE", palette), chunk("tRNS", Uint8Array.of(128))]));
		expect([...decoded.pixels.subarray(0, 12)]).toEqual([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255]);
	});

	test("refuses what it can't read safely: not a PNG, truncated, huge sizes, 16-bit, bad filters, deflate bombs", () => {
		expect(() => decodePng(new Uint8Array(4))).toThrow("not a PNG");
		const good = png(gradient(8, 8));
		expect(() => decodePng(good.subarray(0, good.length - 30))).toThrow();
		const huge = writePng(1, 1, 0, new Uint8Array(1));
		new DataView(huge.buffer, huge.byteOffset).setUint32(16, 100_000); // IHDR width
		new DataView(huge.buffer, huge.byteOffset).setUint32(20, 100_000); // IHDR height
		expect(() => decodePng(huge)).toThrow("bad PNG size");
		const sixteen = writePng(2, 2, 0, new Uint8Array(4));
		sixteen[24] = 16; // bit depth
		expect(() => decodePng(sixteen)).toThrow(/bit depth/);
		// IDAT inflating far past (stride + 1) × height is cut off at that size.
		const header = new Uint8Array(13);
		new DataView(header.buffer).setUint32(0, 4);
		new DataView(header.buffer).setUint32(4, 4);
		header.set([8, 6, 0, 0, 0], 8);
		const bomb = Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(new Uint8Array(50_000_000))), chunk("IEND", new Uint8Array(0))]);
		expect(() => decodePng(new Uint8Array(bomb))).toThrow();
	});
});

describe("downscale and crop", () => {
	test("the long side ends at most at the limit, the aspect ratio is kept, areas are averaged", () => {
		const big = gradient(1920, 1080);
		const small = downscale(big, CLAUDE_IMAGE_SIDE);
		expect([small.width, small.height]).toEqual([1568, 882]);
		expect(small.pixels.length).toBe(1568 * 882 * 4);
		const tall = downscale(gradient(300, 3000), GAME_IMAGE_SIDE);
		expect([tall.width, tall.height]).toEqual([102, 1024]);
		// 2×2 → 1×1 is the mean of the four.
		const four = { width: 2, height: 2, pixels: Uint8Array.of(0, 0, 0, 255, 100, 0, 0, 255, 0, 200, 0, 255, 100, 200, 40, 255) };
		expect([...downscale(four, 1).pixels]).toEqual([50, 100, 10, 255]);
		// Already small enough: the same object.
		const fits = gradient(100, 50);
		expect(downscale(fits, 100)).toBe(fits);
		// A solid color stays exactly that color.
		const red = downscale(solid(997, 613, [200, 10, 20, 255]), 300);
		for (let i = 0; i < red.pixels.length; i += 4) expect([...red.pixels.subarray(i, i + 4)]).toEqual([200, 10, 20, 255]);
	});

	test("crop takes the normalized rectangle (at least one pixel); full crop = same image", () => {
		const image = gradient(100, 50);
		const part = cropImage(image, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
		expect([part.width, part.height]).toEqual([50, 25]);
		expect([...part.pixels.subarray(0, 4)]).toEqual([...image.pixels.subarray((25 * 100 + 25) * 4, (25 * 100 + 25) * 4 + 4)]);
		expect(cropImage(image, { x: 0, y: 0, w: 1, h: 1 })).toBe(image);
		const tiny = cropImage(image, { x: 0.999, y: 0.999, w: 0.0001, h: 0.0001 });
		expect([tiny.width, tiny.height]).toEqual([1, 1]);
		expect(parseCrop({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 })).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
		for (const bad of [{ x: -0.1, y: 0, w: 0.5, h: 0.5 }, { x: 0.8, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0, h: 1 }, { x: 0, y: 0, w: 1, h: 1, z: 1 }, { x: "0", y: 0, w: 1, h: 1 }, [0, 0, 1, 1]]) {
			expect(parseCrop(bad)).toBeUndefined();
		}
	});

	test("game images: ≤ 1024 per side and zstd under the byte cap (smaller when noise doesn't compress)", () => {
		const noise = { width: 1500, height: 1000, pixels: crypto.getRandomValues(new Uint8Array(1500 * 1000 * 4)) };
		const prepared = prepareGameImage(noise, 1024 * 1024);
		expect(Math.max(prepared.width, prepared.height)).toBeLessThanOrEqual(GAME_IMAGE_SIDE);
		expect(prepared.zstd.length).toBeLessThanOrEqual(1024 * 1024);
		expect(Bun.zstdDecompressSync(prepared.zstd).length).toBe(prepared.width * prepared.height * 4);
		const flat = prepareGameImage(solid(1500, 1000, [1, 2, 3, 255]));
		expect([flat.width, flat.height]).toEqual([1024, 683]);
	});
});

describe("formats and ffmpeg", () => {
	test("formats come from magic bytes only", () => {
		expect(sniffImageFormat(png(gradient(2, 2)))).toBe("png");
		expect(sniffImageFormat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
		expect(sniffImageFormat(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
		expect(sniffImageFormat(new TextEncoder().encode("GIF89a"))).toBe("gif");
		expect(sniffImageFormat(new TextEncoder().encode("BM...."))).toBe("bmp");
		expect(sniffImageFormat(new TextEncoder().encode("#EXTM3U\nhttp://x/"))).toBeUndefined();
	});

	test("anything that isn't an image is refused before ffmpeg ever sees it", async () => {
		await expect(decodeImage(new TextEncoder().encode("#EXTM3U\n#EXTINF:1,\nhttps://example.com/a.ts\n"))).rejects.toThrow(/not a PNG, JPEG/);
		await expect(decodeImage(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), { ffmpeg: false })).rejects.toThrow(/without ffmpeg/);
	});

	const ffmpeg = findFfmpeg();
	test.skipIf(!ffmpeg)("JPEG (and 16-bit PNG) decode through ffmpeg with a fixed demuxer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-ffmpeg-"));
		try {
			const source = join(dir, "in.png");
			writeFileSync(source, png(solid(64, 48, [10, 200, 30, 255])));
			const jpeg = join(dir, "out.jpg");
			const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-i", source, "-q:v", "2", jpeg]);
			expect(made.exitCode).toBe(0);
			const decoded = await decodeImage(new Uint8Array(readFileSync(jpeg)));
			expect([decoded.width, decoded.height]).toEqual([64, 48]);
			const [r, g, b, a] = decoded.pixels.subarray(32 * 64 * 4, 32 * 64 * 4 + 4);
			expect(Math.abs(r - 10) + Math.abs(g - 200) + Math.abs(b - 30)).toBeLessThan(30);
			expect(a).toBe(255);
			const deep = join(dir, "deep.png");
			expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-i", source, "-pix_fmt", "rgba64be", deep]).exitCode).toBe(0);
			const decodedDeep = await decodeImage(new Uint8Array(readFileSync(deep)));
			expect([...decodedDeep.pixels.subarray(0, 4)]).toEqual([10, 200, 30, 255]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("capture pickup", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "tt-captures-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const write = (name: string, image = gradient(8, 8)) => writeFileSync(join(dir, name), png(image));

	test("only the requesting user's files, only this place, only within the window; the closest wins", () => {
		const t = 1_760_000_000_000;
		write(`111_${PLACE}_${t + 300}.png`);
		write(`111_${PLACE}_${t - 1200}.png`);
		write(`111_999_${t}.png`); // other place
		write(`222_${PLACE}_${t}.png`); // other user, exact time
		write(`111_${PLACE}_${t + 9000}.png`); // outside the window
		write(`111_${PLACE}_${t}.jpg`); // not a capture name
		write(`1111_${PLACE}_${t}.png`); // a user id that only starts the same
		expect(findCaptureFile(dir, { userId: 111, placeId: PLACE, captureMs: t })?.name).toBe(`111_${PLACE}_${t + 300}.png`);
		expect(findCaptureFile(dir, { userId: 111, placeId: PLACE, captureMs: t })?.deltaMs).toBe(300);
		expect(findCaptureFile(dir, { userId: 111, placeId: 0, captureMs: t })?.name).toBe(`111_999_${t}.png`); // place 0 = any
		expect(findCaptureFile(dir, { userId: 222, placeId: PLACE, captureMs: t })?.name).toBe(`222_${PLACE}_${t}.png`);
		expect(findCaptureFile(dir, { userId: 333, placeId: PLACE, captureMs: t })).toBeUndefined();
		expect(findCaptureFile(dir, { userId: 111, placeId: PLACE, captureMs: t + 20_000 })).toBeUndefined();
		expect(findCaptureFile(dir, { userId: 111, placeId: PLACE, captureMs: t, windowMs: 100 })).toBeUndefined();
		expect(findCaptureFile(join(dir, "missing"), { userId: 111, captureMs: t })).toBeUndefined();
	});

	test("a LocalId naming the file stem picks that file, but never another user's", () => {
		const t = 1_760_000_100_000;
		write(`444_${PLACE}_${t + 40_000}.png`);
		write(`555_${PLACE}_${t}.png`);
		expect(findCaptureFile(dir, { userId: 444, placeId: PLACE, captureMs: t, localId: `rbxtemp://444_${PLACE}_${t + 40_000}` })).toMatchObject({ exact: true, deltaMs: 40_000 });
		expect(findCaptureFile(dir, { userId: 444, placeId: PLACE, captureMs: t, localId: `555_${PLACE}_${t}` })).toBeUndefined();
		expect(findCaptureFile(dir, { userId: 444, placeId: PLACE, captureMs: t, localId: "../../etc/passwd" })).toBeUndefined();
	});

	test("waits for a file Roblox writes a moment later, and for its size to settle; gives up after the timeout", async () => {
		const t = Date.now();
		setTimeout(() => {
			// First a partial write, then the rest (as if Roblox were still writing).
			const bytes = png(gradient(40, 30));
			writeFileSync(join(dir, `777_${PLACE}_${t + 50}.png`), bytes.subarray(0, 20));
			setTimeout(() => writeFileSync(join(dir, `777_${PLACE}_${t + 50}.png`), bytes), 250);
		}, 300);
		const started = Date.now();
		const found = await pickUpCapture(dir, { userId: 777, placeId: PLACE, captureMs: t }, { timeoutMs: 3000, pollMs: 100 });
		expect(found).toBeDefined();
		expect(decodePng(found!.bytes).width).toBe(40);
		expect(Date.now() - started).toBeGreaterThanOrEqual(500);
		const none = await pickUpCapture(dir, { userId: 888, placeId: PLACE, captureMs: t }, { timeoutMs: 400, pollMs: 100 });
		expect(none).toBeUndefined();
	});

	test("a far match waits for a closer file still being written", async () => {
		const t = Date.now();
		write(`123_${PLACE}_${t - 3000}.png`, gradient(5, 5)); // an older capture
		setTimeout(() => write(`123_${PLACE}_${t + 20}.png`, gradient(6, 6)), 400);
		const found = await pickUpCapture(dir, { userId: 123, placeId: PLACE, captureMs: t }, { timeoutMs: 2000, pollMs: 100 });
		expect(found?.match.name).toBe(`123_${PLACE}_${t + 20}.png`);
	});

	test("the request schema: unix ms only, a safe LocalId, crop", () => {
		expect(parseCaptureRequest({ captureTime: 1_760_000_000_000, localId: "rbxtemp://123_456_1760000000000", placeId: 1 })).toBeDefined();
		expect(parseCaptureRequest({ captureTime: 1_760_000_000 })).toBeUndefined(); // seconds
		expect(parseCaptureRequest({ captureTime: 1_760_000_000_000.5 })).toBeUndefined();
		expect(parseCaptureRequest({ captureTime: 1_760_000_000_000, localId: "a b" })).toBeUndefined();
		expect(parseCaptureRequest({ captureTime: 1_760_000_000_000, path: "C:/x.png" })).toBeUndefined();
		expect(parseCaptureRequest({ captureTime: 1_760_000_000_000, crop: { x: 0, y: 0, w: 2, h: 1 } })).toBeUndefined();
	});
});

describe("endpoints", () => {
	let dir: string;
	let captures: string;
	let srv: RemoteClaudeServer;
	const downloads: number[] = [];
	const seenRuns: { paths: string[]; exist: boolean[] }[] = [];
	const runner: Runner = async (ctx) => {
		seenRuns.push({ paths: ctx.record.attachments.map((a) => a.path), exist: ctx.record.attachments.map((a) => existsSync(a.path)) });
		return { state: "answered", summary: "ok" };
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "tt-img-ep-"));
		captures = join(dir, "tmp-capture-storage");
		mkdirSync(captures);
		srv = await createRemoteClaudeServer({
			branch: "dev",
			users: USERS,
			runner,
			logger: silentLogger,
			attachmentsDir: join(dir, "att"),
			captureDir: captures,
			pickupTimeoutMs: 600,
			maxPrompts: 500,
			downloadAsset: async (assetId) => {
				downloads.push(assetId);
				if (assetId === 404) throw new Error("asset delivery answered 404");
				return png(gradient(2000, 1000));
			},
		});
	});
	afterAll(async () => {
		await srv.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	async function pair(userId: number, job = JOB) {
		const res = await fetch(`${srv.localUrl}/v1/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ grant: "code", sid: srv.auth.sessionId, user: userId, job, branch: "dev", code: srv.pairing.formatted }),
		});
		expect(res.status).toBe(200);
		return ((await res.json()) as { access_token: string }).access_token;
	}
	const post = (jwt: string, path: string, body: unknown, job = JOB) =>
		fetch(`${srv.localUrl}${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${jwt}`,
				"content-type": "application/json",
				"x-tt-job": job,
				"x-tt-nonce": crypto.randomUUID(),
				"x-tt-timestamp": String(Math.floor(Date.now() / 1000)),
			},
			body: JSON.stringify(body),
		});

	test("capture: the requester's file → a downscaled, cropped copy outside the worktree; Roblox's file untouched", async () => {
		const u = user();
		const jwt = await pair(u);
		const t = Date.now();
		const original = join(captures, `${u}_${PLACE}_${t + 120}.png`);
		writeFileSync(original, png(gradient(2560, 1440)));
		const before = readFileSync(original);
		const res = await post(jwt, "/v1/attachments/capture", { captureTime: t, localId: "rbxtemp://1", placeId: PLACE });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; width: number; height: number };
		expect([body.width, body.height]).toEqual([1568, 882]);
		const saved = srv.attachments.get(body.id)!;
		expect(saved.source).toBe("capture");
		expect(saved.path.startsWith(join(dir, "att"))).toBe(true);
		expect(decodePng(new Uint8Array(readFileSync(saved.path))).width).toBe(1568);
		expect(readFileSync(original).equals(before)).toBe(true); // only read
		// Cropped: the selected quarter, then downscaled only if still too big.
		const t2 = Date.now() + 10_000;
		writeFileSync(join(captures, `${u}_${PLACE}_${t2}.png`), png(gradient(2560, 1440)));
		const cropped = (await (await post(jwt, "/v1/attachments/capture", { captureTime: t2, placeId: PLACE, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } })).json()) as { width: number; height: number };
		expect([cropped.width, cropped.height]).toEqual([1280, 720]);
	});

	test("capture: someone else's file, another place or a time outside the window → 404 (the game falls back)", async () => {
		const u = user();
		const other = user();
		const jwt = await pair(u);
		const t = Date.now();
		writeFileSync(join(captures, `${other}_${PLACE}_${t}.png`), png(gradient(10, 10)));
		writeFileSync(join(captures, `${u}_42_${t}.png`), png(gradient(10, 10)));
		writeFileSync(join(captures, `${u}_${PLACE}_${t - 60_000}.png`), png(gradient(10, 10)));
		expect((await post(jwt, "/v1/attachments/capture", { captureTime: t, placeId: PLACE })).status).toBe(404);
		expect((await post(jwt, "/v1/attachments/capture", { captureTime: t, placeId: PLACE, extra: 1 })).status).toBe(400);
		expect((await post(jwt, "/v1/attachments/capture", { captureTime: "now" })).status).toBe(400);
	});

	test("asset fallback: downloaded, downscaled, cropped; failures are 502; no key → 503", async () => {
		const jwt = await pair(user());
		const res = await post(jwt, "/v1/attachments/asset", { assetId: 1234, crop: { x: 0, y: 0, w: 0.5, h: 1 } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; width: number; height: number };
		expect([body.width, body.height]).toEqual([1000, 1000]);
		expect(srv.attachments.get(body.id)!.source).toBe("asset");
		expect((await post(jwt, "/v1/attachments/asset", { assetId: 404 })).status).toBe(502);
		expect((await post(jwt, "/v1/attachments/asset", { assetId: -1 })).status).toBe(400);
		expect(downloads).toEqual([1234, 404]);
		const bare = await createRemoteClaudeServer({ branch: "dev", users: USERS, runner, logger: silentLogger, attachmentsDir: join(dir, "bare") });
		try {
			const token = await (async () => {
				const r = await fetch(`${bare.localUrl}/v1/token`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ grant: "code", sid: bare.auth.sessionId, user: USERS[0], job: JOB, branch: "dev", code: bare.pairing.formatted }),
				});
				return ((await r.json()) as { access_token: string }).access_token;
			})();
			const r = await fetch(`${bare.localUrl}/v1/attachments/asset`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-tt-job": JOB, "x-tt-nonce": crypto.randomUUID(), "x-tt-timestamp": String(Math.floor(Date.now() / 1000)) },
				body: JSON.stringify({ assetId: 5 }),
			});
			expect(r.status).toBe(503);
		} finally {
			await bare.stop();
		}
	});

	test("a prompt's screenshots exist while it runs and are deleted after it; a cancelled prompt deletes them too", async () => {
		const u = user();
		const jwt = await pair(u);
		const t = Date.now();
		writeFileSync(join(captures, `${u}_${PLACE}_${t}.png`), png(gradient(64, 64)));
		const { id } = (await (await post(jwt, "/v1/attachments/capture", { captureTime: t, placeId: PLACE })).json()) as { id: string };
		const created = (await (await post(jwt, "/v1/prompts", { prompt: "what is this?", attachments: [id] })).json()) as { id: string };
		for (let i = 0; i < 200 && !srv.queue.get(created.id)!.finishedAt; i++) await Bun.sleep(20);
		const run = seenRuns[seenRuns.length - 1];
		expect(run.exist).toEqual([true]);
		expect(existsSync(run.paths[0])).toBe(false);
		expect(srv.attachments.get(id)!.released).toBe(true);
		// Queued and cancelled before it ran.
		const raw = await post(jwt, "/v1/attachments", { width: 1, height: 1, format: "rgba8", compression: "none", data: "AAAAAA==" });
		const second = (await raw.json()) as { id: string };
		const file = srv.attachments.get(second.id)!.path;
		const record = srv.queue.create(u, "later", undefined, { job: JOB, attachments: [srv.attachments.get(second.id)!] });
		if (typeof record === "string") throw new Error(record);
		srv.queue.cancel(record.id, "test");
		expect(existsSync(file)).toBe(false);
	});

	test("limits: one fetch at a time and 10 a minute per user; the unused quota counts captures too", async () => {
		const u = user();
		const jwt = await pair(u);
		const t = Date.now();
		const slow = post(jwt, "/v1/attachments/capture", { captureTime: t, placeId: PLACE }); // nothing to find: waits
		await Bun.sleep(50);
		expect((await post(jwt, "/v1/attachments/capture", { captureTime: t, placeId: PLACE })).status).toBe(429); // in progress
		expect((await slow).status).toBe(404);
		const statuses: number[] = [];
		for (let i = 0; i < ATTACHMENT_LIMITS.fetchesPerMinute; i++) statuses.push((await post(jwt, "/v1/attachments/asset", { assetId: 77 })).status);
		// 1 (slow) + 8 more fit the minute, then 429; the 8 unused also hit the unused quota.
		expect(statuses.filter((s) => s === 200)).toHaveLength(ATTACHMENT_LIMITS.unusedPerUser);
		expect(statuses.slice(-1)).toEqual([429]);
	});

	test("images: only the requester's game server may fetch them", async () => {
		const u = user();
		const jwt = await pair(u);
		const otherJob = await pair(u, "11111111-2222-4333-8444-555555555555");
		const record = srv.queue.create(u, "show", undefined, { job: JOB });
		if (typeof record === "string") throw new Error(record);
		const stored = srv.images.add({ promptId: record.id, userId: u, job: JOB, width: 2, height: 2, zstd: new Uint8Array(Bun.zstdCompressSync(new Uint8Array(16))) });
		const get = (token: string, job: string) => fetch(`${srv.localUrl}/v1/images/${stored.id}?chunk=0`, { headers: { authorization: `Bearer ${token}`, "x-tt-job": job } });
		expect((await get(jwt, JOB)).status).toBe(200);
		expect((await get(otherJob, "11111111-2222-4333-8444-555555555555")).status).toBe(404);
	});
});

describe("screenshot game tool", () => {
	test("the game's capture time → the picked-up image goes to Claude as an MCP image block (never stored)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-shot-"));
		const userId = USERS[29];
		let reply: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError: boolean } | undefined;
		const runner: Runner = async (ctx) => {
			const call = await fetch(ctx.mcp!.url, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${ctx.mcp!.token}` },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screenshot", arguments: {} } }),
			});
			reply = ((await call.json()) as { result: typeof reply }).result;
			return { state: "answered", summary: "ok" };
		};
		const srv = await createRemoteClaudeServer({ branch: "dev", users: [userId], runner, logger: silentLogger, attachmentsDir: join(dir, "att"), captureDir: dir, pickupTimeoutMs: 1000 });
		try {
			const tokenRes = await fetch(`${srv.localUrl}/v1/token`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ grant: "code", sid: srv.auth.sessionId, user: userId, job: JOB, branch: "dev", code: srv.pairing.formatted }),
			});
			const jwt = ((await tokenRes.json()) as { access_token: string }).access_token;
			const headers = { authorization: `Bearer ${jwt}`, "x-tt-job": JOB };
			const postHeaders = () => ({ ...headers, "content-type": "application/json", "x-tt-nonce": crypto.randomUUID(), "x-tt-timestamp": String(Math.floor(Date.now() / 1000)) });
			await fetch(`${srv.localUrl}/v1/prompts`, { method: "POST", headers: postHeaders(), body: JSON.stringify({ prompt: "look at my screen" }) });
			// The fake game: takes the request from the poll, "captures" (writes Roblox's file) and answers with the time.
			let answered = false;
			for (let i = 0; i < 100 && !answered; i++) {
				const poll = (await (await fetch(`${srv.localUrl}/v1/game/poll?since=0`, { headers })).json()) as { requests: { id: string; tool: string }[] };
				for (const request of poll.requests) {
					expect(request.tool).toBe("screenshot");
					const t = Date.now();
					writeFileSync(join(dir, `${userId}_${PLACE}_${t + 30}.png`), png(gradient(3000, 1500)));
					const result = await fetch(`${srv.localUrl}/v1/game/tool-result`, { method: "POST", headers: postHeaders(), body: JSON.stringify({ id: request.id, ok: true, data: JSON.stringify({ captureTime: t, placeId: PLACE }) }) });
					expect(result.status).toBe(200);
					answered = true;
				}
				await Bun.sleep(20);
			}
			for (let i = 0; i < 200 && reply === undefined; i++) await Bun.sleep(20);
			expect(reply!.isError).toBe(false);
			expect(reply!.content[0].text).toContain("untrusted-game-data");
			const image = reply!.content.find((part) => part.type === "image")!;
			expect(image.mimeType).toBe("image/png");
			const decoded = decodePng(new Uint8Array(Buffer.from(image.data!, "base64")));
			expect([decoded.width, decoded.height]).toEqual([1568, 784]);
			expect(readdirSync(dir).filter((name) => name !== "att")).toHaveLength(1); // only Roblox's own file
		} finally {
			await srv.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Claude → game helpers and cleanup", () => {
	test("markdown image references: files only, in order", () => {
		expect(markdownImages('See ![a chart](out/chart.png) and ![](<shots/my shot.png>) ![t](x.png "title") ![u](https://x.y/z.png) ![d](data:image/png;base64,AA) ![w](C:\\a\\b.png)')).toEqual([
			{ caption: "a chart", path: "out/chart.png" },
			{ caption: "t", path: "x.png" },
			{ caption: "w", path: "C:\\a\\b.png" },
		]);
	});

	test("resolveImageRef: inside the worktree only, images only, not .git or .env", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-wt-"));
		try {
			const wt = join(root, "wt");
			mkdirSync(join(wt, "img"), { recursive: true });
			writeFileSync(join(wt, "img", "a.png"), png(gradient(2, 2)));
			writeFileSync(join(wt, ".env.png"), png(gradient(2, 2)));
			writeFileSync(join(wt, "notes.txt"), "x");
			writeFileSync(join(root, "outside.png"), png(gradient(2, 2)));
			expect(resolveImageRef(wt, "img/a.png")).toMatchObject({ rel: "img/a.png" });
			expect(resolveImageRef(wt, join(wt, "img", "a.png"))).toMatchObject({ rel: "img/a.png" });
			expect(resolveImageRef(wt, "img%2Fa.png")).toBe("file not found");
			expect(resolveImageRef(wt, "../outside.png")).toBe("only files in the worktree can be shown");
			expect(resolveImageRef(wt, join(root, "outside.png"))).toBe("only files in the worktree can be shown");
			expect(resolveImageRef(wt, ".env.png")).toBe("that file can't be shown");
			expect(resolveImageRef(wt, "notes.txt")).toBe("not an image file");
			expect(resolveImageRef(wt, "img")).toBe("not an image file");
			expect(resolveImageRef(wt, "nope.png")).toBe("file not found");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("ImageStore: chunks, memory cap and expiry", () => {
		const store = new ImageStore(300_000, 1000);
		const big = (n: number) => ({ promptId: "p", userId: 1, job: "", width: 1, height: 1, zstd: new Uint8Array(n) });
		const a = store.add(big(150_000), 0);
		expect(store.chunk(a, 0)!.chunks).toBe(3);
		expect(Buffer.from(store.chunk(a, 2)!.data, "base64").length).toBe(150_000 - 2 * 64 * 1024);
		expect(store.chunk(a, 3)).toBeUndefined();
		store.add(big(100_000), 10);
		store.add(big(100_000), 20); // over 300 KB: the oldest goes
		expect(store.get(a.id, 30)).toBeUndefined();
		expect(store.totalBytes).toBe(200_000);
		const b = store.add(big(10), 40);
		expect(store.get(b.id, 1039)).toBeDefined();
		expect(store.get(b.id, 1040)).toBeUndefined(); // expired
	});

	test("stale temp folders of a crashed session are swept; fresh ones and other folders stay", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-sweep-"));
		try {
			for (const name of ["tt-rc-att-0123456789ab", "tt-rc-logs-AbC123", "tt-rc-att-fresh", "other-folder"]) {
				mkdirSync(join(root, name));
				writeFileSync(join(root, name, "x.png"), "x");
			}
			const old = (Date.now() - 3 * 60 * 60_000) / 1000;
			for (const name of ["tt-rc-att-0123456789ab", "tt-rc-logs-AbC123", "other-folder"]) utimesSync(join(root, name), old, old);
			expect(sweepStaleTempFolders(root)).toBe(2);
			expect(readdirSync(root).sort()).toEqual(["other-folder", "tt-rc-att-fresh"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("Open Cloud download: the key only goes to apis.roblox.com; a Decal is followed once to its image", async () => {
		const calls: { url: string; key: string | null }[] = [];
		const image = png(gradient(4, 4));
		const fake = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, key: new Headers(init?.headers).get("x-api-key") });
			if (url.endsWith("/assetId/10")) return Response.json({ location: "https://c0.rbxcdn.com/decal" });
			if (url.endsWith("/assetId/11")) return Response.json({ location: "https://c1.rbxcdn.com/image" });
			if (url.endsWith("/assetId/12")) return Response.json({ location: "https://evil.example.com/x" });
			if (url === "https://c0.rbxcdn.com/decal") return new Response('<roblox><Item class="Decal"><Content name="Texture"><url>http://www.roblox.com/asset/?id=11</url></Content></Item></roblox>');
			if (url === "https://c1.rbxcdn.com/image") return new Response(image);
			return new Response(null, { status: 404 });
		}) as typeof fetch;
		const download = openCloudAssetDownloader("KEY-123", fake);
		expect(Buffer.from(await download(10)).equals(Buffer.from(image))).toBe(true);
		expect(calls.map((c) => [c.url, c.key])).toEqual([
			["https://apis.roblox.com/asset-delivery-api/v1/assetId/10", "KEY-123"],
			["https://c0.rbxcdn.com/decal", null],
			["https://apis.roblox.com/asset-delivery-api/v1/assetId/11", "KEY-123"],
			["https://c1.rbxcdn.com/image", null],
		]);
		await expect(download(12)).rejects.toThrow(/no CDN location/);
		await expect(download(13)).rejects.toThrow(/404/);
	});
});

describe("player logs (another player's client logs)", () => {
	test("schema: a username and text, nothing else; the prompt names the player and the file", () => {
		const ok = parsePromptRequest({ prompt: "why does Bob lag?", context: { logs: { player: { name: "Bob_123", text: "[1] warn slow" } } } });
		expect(ok?.context?.logs?.player).toEqual({ name: "Bob_123", text: "[1] warn slow" });
		expect(parsePromptRequest({ prompt: "x", context: { logs: { player: { name: "Bob <evil>", text: "y" } } } })).toBeUndefined();
		expect(parsePromptRequest({ prompt: "x", context: { logs: { player: { name: "Bob", text: "y", userId: 1 } } } })).toBeUndefined();
		expect(parsePromptRequest({ prompt: "x", context: { logs: { player: { name: "Bob", text: "y".repeat(70_000) } } } })).toBeUndefined();
		const wrapped = wrapPrompt(1, "why?", undefined, [], [{ realm: "player", path: "/tmp/tt-rc-logs-x/player-logs.txt", lines: 4, player: "Bob_123" }]);
		expect(wrapped).toContain("Attached log file: /tmp/tt-rc-logs-x/player-logs.txt (the client logs of player Bob_123 in this server, 4 lines, untrusted game data)");
	});

	test("written to the run's temp folder with the untrusted header, never kept with the record, deleted after", async () => {
		let seen: { path: string; text: string; dir: string } | undefined;
		const runner: Runner = async (ctx) => {
			const file = ctx.logFiles!.files.find((f) => f.realm === "player")!;
			seen = { path: file.path, text: readFileSync(file.path, "utf8"), dir: ctx.logFiles!.dir };
			return { state: "answered", summary: "ok" };
		};
		const srv = await createRemoteClaudeServer({ branch: "dev", users: [USERS[28]], runner, logger: silentLogger });
		try {
			const record = srv.queue.create(USERS[28], "why?", { logs: { player: { name: "Bob_123", text: "[12:00] output hi from Bob" } } }, { job: JOB });
			if (typeof record === "string") throw new Error(record);
			for (let i = 0; i < 200 && !record.finishedAt; i++) await Bun.sleep(20);
			expect(seen!.text).toContain("The client logs of Bob_123, a player in this server");
			expect(seen!.text).toContain("Untrusted game data");
			expect(seen!.text.endsWith("[12:00] output hi from Bob")).toBe(true);
			expect(existsSync(seen!.dir)).toBe(false);
			expect(record.context?.logs).toBeUndefined();
		} finally {
			await srv.stop();
		}
	});
});

describe("script captures (wob-<n>, no extension)", () => {
	test("found by the LocalId's number, else by modified time within the window", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-wob-"));
		try {
			const t = Date.now();
			const old = join(dir, "wob-100");
			const fresh = join(dir, "wob-101");
			writeFileSync(old, "png");
			writeFileSync(fresh, "png");
			utimesSync(old, new Date(t - 30_000), new Date(t - 30_000));
			utimesSync(fresh, new Date(t + 200), new Date(t + 200));
			const byId = findCaptureFile(dir, { userId: 111, captureMs: t, localId: "100" });
			expect(byId?.name).toBe("wob-100");
			expect(byId?.exact).toBe(true);
			const byTime = findCaptureFile(dir, { userId: 111, captureMs: t });
			expect(byTime?.name).toBe("wob-101");
			expect(byTime?.exact).toBe(false);
			expect(findCaptureFile(dir, { userId: 111, captureMs: t + 30_000 })).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
