/**
 * Marks on screenshots (the crop view's Draw mode): the raster (strokes land on the right pixels, round ends, every
 * pixel checked against the exact distance), crop + strokes composing, the ink budget, the strokes schema and its caps,
 * and the capture / asset endpoints drawing the marks before the crop and the downscale.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STROKE_COLORS, cropImage, decodePng, drawStrokes, type Rgba, type Stroke } from "../src/images";
import { silentLogger } from "../src/log";
import { encodePng } from "../src/png";
import type { Runner } from "../src/prompts";
import { wrapPrompt } from "../src/runner";
import { STROKE_LIMITS, parseAssetRequest, parseCaptureRequest, parseStrokes } from "../src/schema";
import { createRemoteClaudeServer, type RemoteClaudeServer } from "../src/server";

const WHITE = [255, 255, 255, 255];
const RED = [...STROKE_COLORS.red, 255];
const YELLOW = [...STROKE_COLORS.yellow, 255];

function solid(width: number, height: number, rgba: number[]): Rgba {
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
	return { width, height, pixels };
}

const at = (image: Rgba, x: number, y: number) => [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

/** Distance from (px, py) to the segment a-b. */
function distance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const length2 = dx * dx + dy * dy;
	const t = length2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Every pixel: marked exactly when its center is within the radius of one of the stroke's segments. */
function expectExact(image: Rgba, stroke: Stroke, color: number[]) {
	const radius = Math.max(1, (stroke.width * image.height) / 2);
	const p = stroke.points.map((value, i) => value * (i % 2 === 0 ? image.width : image.height));
	const segments: number[][] = [];
	if (p.length === 2) segments.push([p[0], p[1], p[0], p[1]]);
	for (let i = 0; i + 3 < p.length; i += 2) segments.push([p[i], p[i + 1], p[i + 2], p[i + 3]]);
	let marked = 0;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			const inside = segments.some(([ax, ay, bx, by]) => distance(x + 0.5, y + 0.5, ax, ay, bx, by) <= radius);
			if (inside) marked += 1;
			expect(at(image, x, y)).toEqual(inside ? color : WHITE);
		}
	}
	expect(marked).toBeGreaterThan(0);
}

describe("drawing strokes", () => {
	test("a horizontal stroke covers its band, with round ends", () => {
		const image = solid(100, 100, WHITE);
		// 0.04 of 100 px: 4 px thick (radius 2), from (25, 50) to (75, 50).
		drawStrokes(image, [{ color: "red", width: 0.04, points: [0.25, 0.5, 0.75, 0.5] }]);
		expect(at(image, 50, 50)).toEqual(RED);
		expect(at(image, 50, 48)).toEqual(RED); // center 48.5: 1.5 from the line
		expect(at(image, 50, 51)).toEqual(RED);
		expect(at(image, 50, 47)).toEqual(WHITE); // 2.5
		expect(at(image, 50, 52)).toEqual(WHITE);
		expect(at(image, 76, 50)).toEqual(RED); // past the end, inside the round cap
		expect(at(image, 77, 50)).toEqual(WHITE);
		expect(at(image, 76, 48)).toEqual(WHITE); // the cap's corner is cut off (round, not square)
		expect(at(image, 23, 50)).toEqual(RED);
		expect(at(image, 22, 50)).toEqual(WHITE);
	});

	test("diagonal, steep and bent strokes match the exact distance at every pixel", () => {
		const strokes: Stroke[] = [
			{ color: "red", width: 0.05, points: [0.1, 0.1, 0.9, 0.8] },
			{ color: "red", width: 0.03, points: [0.5, 0.05, 0.52, 0.95] },
			{ color: "red", width: 0.08, points: [0.1, 0.9, 0.4, 0.3, 0.45, 0.31, 0.9, 0.9] },
			{ color: "red", width: 0.02, points: [0.2, 0.5, 0.8, 0.505] },
		];
		for (const stroke of strokes) {
			const image = solid(120, 80, WHITE);
			drawStrokes(image, [stroke]);
			expectExact(image, stroke, RED);
		}
	});

	test("one point is a dot; the color and thickness are the stroke's", () => {
		const image = solid(40, 40, WHITE);
		const dot: Stroke = { color: "yellow", width: 0.25, points: [0.5, 0.5] }; // radius 5 at (20, 20)
		drawStrokes(image, [dot]);
		expect(at(image, 20, 20)).toEqual(YELLOW);
		expect(at(image, 24, 20)).toEqual(YELLOW);
		expect(at(image, 25, 20)).toEqual(WHITE);
		expectExact(image, dot, YELLOW);
		const thin = solid(40, 40, WHITE);
		drawStrokes(thin, [{ color: "black", width: 0.001, points: [0.5, 0.5] }]);
		expect(at(thin, 20, 20)).toEqual([0, 0, 0, 255]); // thinner than a pixel still marks one (radius ≥ 1)
	});

	test("points are relative to the full capture: drawn first, then cropped, they land at the crop's pixels", () => {
		const image = solid(200, 100, WHITE);
		drawStrokes(image, [{ color: "red", width: 0.1, points: [0.75, 0.5] }]); // a dot of radius 5 at (150, 50)
		const part = cropImage(image, { x: 0.5, y: 0, w: 0.5, h: 1 });
		expect([part.width, part.height]).toEqual([100, 100]);
		expect(at(part, 50, 50)).toEqual(RED);
		expect(at(part, 54, 50)).toEqual(RED);
		expect(at(part, 55, 50)).toEqual(WHITE);
		expect(at(part, 45, 50)).toEqual(RED);
		expect(at(part, 44, 50)).toEqual(WHITE);
		// A stroke wholly outside the crop leaves the crop untouched.
		const other = solid(200, 100, WHITE);
		drawStrokes(other, [{ color: "red", width: 0.1, points: [0.1, 0.1, 0.3, 0.9] }]);
		const clean = cropImage(other, { x: 0.5, y: 0, w: 0.5, h: 1 });
		for (let i = 0; i < clean.pixels.length; i += 4) expect([...clean.pixels.subarray(i, i + 4)]).toEqual(WHITE);
	});

	test("crafted strokes over the ink budget are refused before anything is drawn", () => {
		const image = { width: 4000, height: 4000, pixels: new Uint8Array(0) } as Rgba;
		const zigzag = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? [0, 0] : [1, 1])).flat();
		expect(() => drawStrokes(image, Array.from({ length: 7 }, () => ({ color: "red" as const, width: 0.04, points: zigzag })))).toThrow("marks too large");
	});
});

describe("strokes schema", () => {
	const stroke = (points: unknown[], extra: Record<string, unknown> = {}) => ({ color: "red", width: 0.012, points, ...extra });
	const many = (count: number) => Array.from({ length: count }, (_, i) => [(i % 100) / 100, 0.5]).flat();

	test("valid strokes come back as a copy; an empty list is no strokes", () => {
		const raw = [stroke([0.1, 0.2, 0.3, 0.4]), { color: "black", width: 0.04, points: [1, 0] }];
		const parsed = parseStrokes(raw)!;
		expect(parsed).toEqual(raw as Stroke[]);
		expect(parsed[0].points).not.toBe(raw[0].points);
		expect(parseStrokes([])).toEqual([]);
		expect(parseCaptureRequest({ captureTime: 1_760_000_000_000, strokes: [] })).toEqual({ captureTime: 1_760_000_000_000 });
		expect(parseCaptureRequest({ captureTime: 1_760_000_000_000, strokes: raw })?.strokes).toEqual(raw as Stroke[]);
		expect(parseAssetRequest({ assetId: 5, crop: { x: 0, y: 0, w: 1, h: 0.5 }, strokes: raw })).toEqual({ assetId: 5, crop: { x: 0, y: 0, w: 1, h: 0.5 }, strokes: raw as Stroke[] });
	});

	test("caps: 30 strokes, 400 points per stroke, 3000 points in all", () => {
		expect(parseStrokes(Array.from({ length: STROKE_LIMITS.strokes }, () => stroke([0.5, 0.5])))).toBeDefined();
		expect(parseStrokes(Array.from({ length: STROKE_LIMITS.strokes + 1 }, () => stroke([0.5, 0.5])))).toBeUndefined();
		expect(parseStrokes([stroke(many(400))])).toBeDefined();
		expect(parseStrokes([stroke(many(401))])).toBeUndefined();
		expect(parseStrokes([...Array.from({ length: 7 }, () => stroke(many(400))), stroke(many(200))])).toBeDefined(); // 3000
		expect(parseStrokes([...Array.from({ length: 7 }, () => stroke(many(400))), stroke(many(201))])).toBeUndefined(); // 3001
	});

	test("malformed strokes are refused", () => {
		const bad: unknown[] = [
			stroke([]),
			stroke([0.5]),
			stroke([0.5, 0.5, 0.5]),
			stroke([0.5, Number.NaN]),
			stroke([0.5, Number.POSITIVE_INFINITY]),
			stroke([0.5, -0.01]),
			stroke([0.5, 1.01]),
			stroke([0.5, "0.5"]),
			stroke([0.5, [0.5]]),
			stroke([0.5, null]),
			stroke([0.5, 0.5], { color: "blue" }),
			stroke([0.5, 0.5], { color: "toString" }),
			stroke([0.5, 0.5], { color: "__proto__" }),
			stroke([0.5, 0.5], { width: 0 }),
			stroke([0.5, 0.5], { width: STROKE_LIMITS.maxWidth * 1.01 }),
			stroke([0.5, 0.5], { width: Number.NaN }),
			stroke([0.5, 0.5], { width: "0.01" }),
			stroke([0.5, 0.5], { extra: 1 }),
			{ color: "red", width: 0.01, points: { 0: 0.5, 1: 0.5 } },
			[0.5, 0.5],
			"red",
		];
		for (const item of bad) expect(parseStrokes([item])).toBeUndefined();
		expect(parseStrokes({ 0: stroke([0.5, 0.5]) })).toBeUndefined();
		expect(parseStrokes("[]")).toBeUndefined();
		// Infinity can arrive through JSON as 1e999.
		expect(parseStrokes(JSON.parse('[{"color":"red","width":0.01,"points":[0.5,1e999]}]'))).toBeUndefined();
		expect(parseCaptureRequest({ captureTime: 1_760_000_000_000, strokes: [stroke([2, 0])] })).toBeUndefined();
		expect(parseAssetRequest({ assetId: 5, strokes: "x" })).toBeUndefined();
	});

	test("Claude is told a screenshot carries the developer's marks", () => {
		const wrapped = wrapPrompt(1, "what is this?", undefined, [
			{ path: "/tmp/tt-rc-logs-x/screenshot-a.png", width: 640, height: 360, marks: 2 },
			{ path: "/tmp/tt-rc-logs-x/screenshot-b.png", width: 640, height: 360 },
		]);
		expect(wrapped).toContain("screenshot-a.png (640x360; the developer drew 2 colored marks on it to point things out)");
		expect(wrapped).toContain("screenshot-b.png (640x360)\n");
	});
});

describe("endpoints draw the marks before the crop", () => {
	const JOB = "6f1c2b9e-3d4a-4b8c-9e7f-0a1b2c3d4e5f";
	const PLACE = 13_000_000;
	const USERS = Array.from({ length: 10 }, (_, i) => 9400 + i);
	let nextUser = 0;
	const user = () => USERS[nextUser++];
	const png = (image: Rgba) => encodePng(image.width, image.height, image.pixels);
	let dir: string;
	let captures: string;
	let srv: RemoteClaudeServer;
	const runner: Runner = async () => ({ state: "answered", summary: "ok" });
	// A red line across the middle, 8 px thick (radius 4) on a 200 px tall capture: (40, 100) to (360, 100).
	const line: Stroke = { color: "red", width: 0.04, points: [0.1, 0.5, 0.9, 0.5] };

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "tt-strokes-"));
		captures = join(dir, "tmp-capture-storage");
		mkdirSync(captures);
		srv = createRemoteClaudeServer({
			branch: "dev",
			users: USERS,
			runner,
			logger: silentLogger,
			attachmentsDir: join(dir, "att"),
			captureDir: captures,
			pickupTimeoutMs: 600,
			downloadAsset: async () => png(solid(400, 200, WHITE)),
		});
	});
	afterAll(async () => {
		await srv.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	async function pair(userId: number) {
		const res = await fetch(`${srv.localUrl}/v1/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ grant: "code", sid: srv.auth.sessionId, user: userId, job: JOB, branch: "dev", code: srv.pairing.formatted }),
		});
		expect(res.status).toBe(200);
		return ((await res.json()) as { access_token: string }).access_token;
	}
	const post = (jwt: string, path: string, body: unknown) =>
		fetch(`${srv.localUrl}${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${jwt}`,
				"content-type": "application/json",
				"x-tt-job": JOB,
				"x-tt-nonce": crypto.randomUUID(),
				"x-tt-timestamp": String(Math.floor(Date.now() / 1000)),
			},
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	const saved = (id: string) => {
		const attachment = srv.attachments.get(id)!;
		return { attachment, image: decodePng(new Uint8Array(readFileSync(attachment.path))) };
	};

	test("capture: the marks are in the saved copy, also after a crop", async () => {
		const u = user();
		const jwt = await pair(u);
		const t = Date.now();
		writeFileSync(join(captures, `${u}_${PLACE}_${t}.png`), png(solid(400, 200, WHITE)));
		const res = await post(jwt, "/v1/attachments/capture", { captureTime: t, placeId: PLACE, strokes: [line] });
		expect(res.status).toBe(200);
		const full = saved(((await res.json()) as { id: string }).id);
		expect(full.attachment.marks).toBe(1);
		expect([full.image.width, full.image.height]).toEqual([400, 200]);
		expect(at(full.image, 200, 100)).toEqual(RED);
		expect(at(full.image, 200, 103)).toEqual(RED);
		expect(at(full.image, 200, 104)).toEqual(WHITE);
		expect(at(full.image, 37, 100)).toEqual(RED); // the round start, 2.5 px before (40, 100)
		expect(at(full.image, 35, 100)).toEqual(WHITE);
		// The right half only: the line ends at x = 360 (160 in the crop), its cap at 164.
		const t2 = t + 10_000;
		writeFileSync(join(captures, `${u}_${PLACE}_${t2}.png`), png(solid(400, 200, WHITE)));
		const cropped = await post(jwt, "/v1/attachments/capture", { captureTime: t2, placeId: PLACE, crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, strokes: [line] });
		expect(cropped.status).toBe(200);
		const half = saved(((await cropped.json()) as { id: string }).id).image;
		expect([half.width, half.height]).toEqual([200, 200]);
		expect(at(half, 100, 100)).toEqual(RED);
		expect(at(half, 162, 100)).toEqual(RED);
		expect(at(half, 165, 100)).toEqual(WHITE);
		expect(at(half, 100, 103)).toEqual(RED);
		expect(at(half, 100, 104)).toEqual(WHITE);
	});

	test("asset fallback: the marks are drawn the same way", async () => {
		const jwt = await pair(user());
		const res = await post(jwt, "/v1/attachments/asset", { assetId: 77, strokes: [line, { color: "yellow", width: 0.02, points: [0.25, 0.25] }] });
		expect(res.status).toBe(200);
		const { attachment, image } = saved(((await res.json()) as { id: string }).id);
		expect(attachment.marks).toBe(2);
		expect(at(image, 200, 100)).toEqual(RED);
		expect(at(image, 100, 50)).toEqual(YELLOW);
		expect(at(image, 100, 60)).toEqual(WHITE);
	});

	test("caps over HTTP: malformed or too many strokes → 400, a body over 64 KB → 413, unmarked requests unchanged", async () => {
		const u = user();
		const jwt = await pair(u);
		const t = Date.now();
		const tooMany = Array.from({ length: STROKE_LIMITS.strokes + 1 }, () => ({ color: "red", width: 0.01, points: [0.5, 0.5] }));
		expect((await post(jwt, "/v1/attachments/capture", { captureTime: t, placeId: PLACE, strokes: tooMany })).status).toBe(400);
		expect((await post(jwt, "/v1/attachments/capture", { captureTime: t, placeId: PLACE, strokes: [{ color: "red", width: 0.01, points: [0.5] }] })).status).toBe(400);
		expect((await post(jwt, "/v1/attachments/asset", '{"assetId":5,"strokes":[{"color":"red","width":0.01,"points":[0.5,1e999]}]}')).status).toBe(400);
		const long = Array.from({ length: 20 }, () => ({ color: "red", width: 0.01, points: Array.from({ length: 400 }, () => 0.123456789012345) }));
		expect(JSON.stringify(long).length).toBeGreaterThan(STROKE_LIMITS.bodyBytes);
		expect((await post(jwt, "/v1/attachments/capture", { captureTime: t, placeId: PLACE, strokes: long })).status).toBe(413);
		writeFileSync(join(captures, `${u}_${PLACE}_${t}.png`), png(solid(400, 200, WHITE)));
		const plain = await post(jwt, "/v1/attachments/capture", { captureTime: t, placeId: PLACE });
		expect(plain.status).toBe(200);
		const { attachment, image } = saved(((await plain.json()) as { id: string }).id);
		expect(attachment.marks).toBeUndefined();
		expect(at(image, 200, 100)).toEqual(WHITE);
	});
});
