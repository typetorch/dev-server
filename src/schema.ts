/** Strict request body validation: exact shapes, size caps, unknown fields rejected. */
import { ATTACHMENT_ID_PATTERN, ATTACHMENT_LIMITS, type AttachmentRequest } from "./attachments.ts";
import { CONVERSATION_ID_PATTERN } from "./conversations.ts";
import { STROKE_COLORS, type Stroke, type StrokeColor } from "./images.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

export const LIMITS = {
	tokenBodyBytes: 1024,
	/** Room for three attached log texts (about 64 KB each, JSON-escaped): My logs, Server logs, Player logs. */
	promptBodyBytes: 480 * 1024,
	promptChars: 4000,
	contextPathChars: 1024,
	contextErrors: 50,
	contextErrorChars: 4000,
	contextArtifactChars: 128,
	/** Each attached log text ("My logs", "Server logs"): about 64 KB, newest lines kept by the game. */
	contextLogChars: 66_000,
	/** Non-proxy request headers, total bytes (plans/11: headers over 2 KB are rejected before parsing). */
	headerBytes: 2048,
	/** Every header including those Cloudflare adds. */
	allHeaderBytes: 8192,
} as const;

interface GrantBase {
	sid: string;
	user: number;
	job: string;
	branch: string;
}

export type TokenGrant = (GrantBase & { grant: "code"; code: string }) | (GrantBase & { grant: "refresh"; refresh_token: string });

/**
 * `{grant:"code", sid, user, job, branch, code}` or `{grant:"refresh", sid, user, job, branch, refresh_token}`, nothing
 * else. `job` may be "" (Studio servers have an empty JobId).
 */
export function parseTokenGrant(raw: unknown): TokenGrant | undefined {
	if (!isPlainObject(raw)) return undefined;
	const { grant, sid, user, job, branch } = raw;
	if (typeof sid !== "string" || !/^[0-9a-f]{32}$/.test(sid)) return undefined;
	if (typeof user !== "number" || !Number.isSafeInteger(user) || user <= 0) return undefined;
	if (typeof job !== "string" || !/^[A-Za-z0-9._:{}-]{0,64}$/.test(job)) return undefined;
	if (typeof branch !== "string" || branch.length === 0 || branch.length > 64) return undefined;
	const base = { sid, user, job, branch };
	if (grant === "code") {
		if (!onlyKeys(raw, ["grant", "sid", "user", "job", "branch", "code"])) return undefined;
		if (typeof raw.code !== "string" || raw.code.length === 0 || raw.code.length > 64) return undefined;
		return { grant, ...base, code: raw.code };
	}
	if (grant === "refresh") {
		if (!onlyKeys(raw, ["grant", "sid", "user", "job", "branch", "refresh_token"])) return undefined;
		if (typeof raw.refresh_token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw.refresh_token)) return undefined;
		return { grant, ...base, refresh_token: raw.refresh_token };
	}
	return undefined;
}

export interface PromptLogs {
	/** The requesting developer's client log history. */
	client?: string;
	/** The game server's log history. */
	server?: string;
	/** Another player's client log history ("Player logs"), with that player's username. */
	player?: { name: string; text: string };
}

/** Roblox usernames: 3–20 letters, digits and one underscore; a little slack, nothing else. */
export const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

export interface PromptContext {
	path?: string;
	errors?: string[];
	artifact?: string;
	/** Untrusted; written to files for the run and dropped (prompts.ts). */
	logs?: PromptLogs;
}

export interface PromptRequest {
	prompt: string;
	context?: PromptContext;
	/** Continue this conversation (resume its Claude session); absent = a new conversation. */
	conversationId?: string;
	/** Attachment ids from POST /v1/attachments (owned by the requester, unused). */
	attachments?: string[];
	/** "live" (default) or "code": which tools the run gets (runner.ts). */
	mode?: "live" | "code";
	/** The dev picked "Toolbox" in the "+" menu for this message: the run gets the Creator Store tools (plans/14). */
	toolbox?: boolean;
}

/**
 * `{prompt: string ≤4000, mode?: "live"|"code", context?: {path?, errors?: string[], artifact?, logs?: {client?, server?}},
 * conversationId?: string, attachments?: string[] (≤4, distinct), toolbox?: boolean}`, nothing else.
 */
export function parsePromptRequest(raw: unknown): PromptRequest | undefined {
	if (!isPlainObject(raw) || !onlyKeys(raw, ["prompt", "context", "conversationId", "attachments", "mode", "toolbox"])) return undefined;
	const { prompt, context, conversationId, attachments, mode, toolbox } = raw;
	if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > LIMITS.promptChars) return undefined;
	if (prompt.includes("\u0000")) return undefined;
	const request: PromptRequest = { prompt };
	if (mode !== undefined) {
		if (mode !== "live" && mode !== "code") return undefined;
		request.mode = mode;
	}
	if (toolbox !== undefined) {
		if (typeof toolbox !== "boolean") return undefined;
		if (toolbox) request.toolbox = true;
	}
	if (conversationId !== undefined) {
		if (typeof conversationId !== "string" || !CONVERSATION_ID_PATTERN.test(conversationId)) return undefined;
		request.conversationId = conversationId;
	}
	if (attachments !== undefined) {
		if (!Array.isArray(attachments) || attachments.length > ATTACHMENT_LIMITS.perMessage) return undefined;
		for (const id of attachments) if (typeof id !== "string" || !ATTACHMENT_ID_PATTERN.test(id)) return undefined;
		if (new Set(attachments).size !== attachments.length) return undefined;
		if (attachments.length > 0) request.attachments = attachments as string[];
	}
	if (context === undefined) return request;
	if (!isPlainObject(context) || !onlyKeys(context, ["path", "errors", "artifact", "logs"])) return undefined;
	const out: PromptContext = {};
	if (context.path !== undefined) {
		if (typeof context.path !== "string" || context.path.length > LIMITS.contextPathChars) return undefined;
		out.path = context.path;
	}
	if (context.errors !== undefined) {
		if (!Array.isArray(context.errors) || context.errors.length > LIMITS.contextErrors) return undefined;
		for (const line of context.errors) if (typeof line !== "string" || line.length > LIMITS.contextErrorChars) return undefined;
		out.errors = context.errors as string[];
	}
	if (context.artifact !== undefined) {
		if (typeof context.artifact !== "string" || context.artifact.length > LIMITS.contextArtifactChars) return undefined;
		out.artifact = context.artifact;
	}
	if (context.logs !== undefined) {
		const logs = context.logs;
		if (!isPlainObject(logs) || !onlyKeys(logs, ["client", "server", "player"])) return undefined;
		const parsed: PromptLogs = {};
		const logText = (text: unknown) => typeof text === "string" && text.length <= LIMITS.contextLogChars && !text.includes("\u0000");
		for (const realm of ["client", "server"] as const) {
			const text = logs[realm];
			if (text === undefined) continue;
			if (!logText(text)) return undefined;
			parsed[realm] = text as string;
		}
		if (logs.player !== undefined) {
			const player = logs.player;
			if (!isPlainObject(player) || !onlyKeys(player, ["name", "text"])) return undefined;
			if (typeof player.name !== "string" || !PLAYER_NAME_PATTERN.test(player.name) || !logText(player.text)) return undefined;
			parsed.player = { name: player.name, text: player.text as string };
		}
		if (parsed.client !== undefined || parsed.server !== undefined || parsed.player !== undefined) out.logs = parsed;
	}
	request.context = out;
	return request;
}

/** `{width, height: 1..1024, format: "rgba8", compression: "zstd"|"none", data: base64}`, nothing else. */
export function parseAttachmentRequest(raw: unknown): AttachmentRequest | undefined {
	if (!isPlainObject(raw) || !onlyKeys(raw, ["width", "height", "format", "compression", "data"])) return undefined;
	const { width, height, format, compression, data } = raw;
	const side = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= ATTACHMENT_LIMITS.maxSide;
	if (!side(width) || !side(height)) return undefined;
	if (format !== "rgba8" || (compression !== "zstd" && compression !== "none")) return undefined;
	if (typeof data !== "string" || data.length === 0) return undefined;
	return { width: width as number, height: height as number, format, compression, data };
}

/** A crop rectangle in normalized image coordinates (0..1 from the top left). */
export interface Crop {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** `{x, y, w, h}`: numbers in 0..1, w and h > 0, inside the image (1e-6 slack); undefined when malformed. */
export function parseCrop(raw: unknown): Crop | undefined {
	if (!isPlainObject(raw) || !onlyKeys(raw, ["x", "y", "w", "h"])) return undefined;
	const values = [raw.x, raw.y, raw.w, raw.h];
	if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) return undefined;
	const [x, y, w, h] = values as number[];
	if (w <= 0 || h <= 0 || x + w > 1 + 1e-6 || y + h > 1 + 1e-6) return undefined;
	return { x, y, w, h };
}

export const STROKE_LIMITS = {
	/** Strokes per image. */
	strokes: 30,
	/** Points per stroke. */
	pointsPerStroke: 400,
	/** Points of all strokes of one image together. */
	points: 3000,
	/** The thickest pen, as a fraction of the capture's height. */
	maxWidth: 0.04,
	/**
	 * The JSON body of a capture or asset request (with its strokes). 3000 points at 4 decimals are about 42 KB, and
	 * about 125 KB even if every number were printed with 17 digits, so any drawing within the caps above fits.
	 */
	bodyBytes: 160 * 1024,
} as const;

/**
 * `[{color: "red"|"yellow"|"white"|"black", width: (0, 0.04], points: [x0, y0, x1, y1, ...]}]`: at most 30 strokes,
 * 1–400 points each and 3000 in all, every coordinate a finite number in 0..1 (normalized to the FULL capture),
 * nothing else. A fresh copy, or undefined when malformed. An empty list is no strokes.
 */
export function parseStrokes(raw: unknown): Stroke[] | undefined {
	if (!Array.isArray(raw) || raw.length > STROKE_LIMITS.strokes) return undefined;
	const strokes: Stroke[] = [];
	let total = 0;
	for (const item of raw) {
		if (!isPlainObject(item) || !onlyKeys(item, ["color", "width", "points"])) return undefined;
		const { color, width, points } = item;
		if (typeof color !== "string" || !Object.hasOwn(STROKE_COLORS, color)) return undefined;
		if (typeof width !== "number" || !Number.isFinite(width) || width <= 0 || width > STROKE_LIMITS.maxWidth) return undefined;
		if (!Array.isArray(points) || points.length < 2 || points.length % 2 !== 0 || points.length > STROKE_LIMITS.pointsPerStroke * 2) return undefined;
		for (const value of points) if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
		total += points.length / 2;
		if (total > STROKE_LIMITS.points) return undefined;
		strokes.push({ color: color as StrokeColor, width, points: [...(points as number[])] });
	}
	return strokes;
}

export interface CaptureRequest {
	/** Unix ms on the dev's PC clock (the client's capture time). */
	captureTime: number;
	/** Capture.LocalId, if the client had one (only its digits and underscores are ever used). */
	localId?: string;
	/** game.PlaceId; 0 = any place. */
	placeId?: number;
	/** The part of the screenshot the dev selected (applied before downscaling). */
	crop?: Crop;
	/** Marks the dev drew (drawn onto the full capture before the crop and the downscale). */
	strokes?: Stroke[];
}

/** `{captureTime: unix ms, localId?: string ≤128, placeId?: number, crop?: Crop, strokes?: Stroke[]}`, nothing else. */
export function parseCaptureRequest(raw: unknown): CaptureRequest | undefined {
	if (!isPlainObject(raw) || !onlyKeys(raw, ["captureTime", "localId", "placeId", "crop", "strokes"])) return undefined;
	const { captureTime, localId, placeId } = raw;
	// 2001-09-09 .. 2286-11-20 in ms: a real clock reading, not seconds or garbage.
	if (typeof captureTime !== "number" || !Number.isSafeInteger(captureTime) || captureTime < 1e12 || captureTime >= 1e13) return undefined;
	const request: CaptureRequest = { captureTime };
	if (localId !== undefined) {
		if (typeof localId !== "string" || !/^[A-Za-z0-9._:/{}-]{1,128}$/.test(localId)) return undefined;
		request.localId = localId;
	}
	if (placeId !== undefined) {
		if (typeof placeId !== "number" || !Number.isSafeInteger(placeId) || placeId < 0) return undefined;
		request.placeId = placeId;
	}
	if (raw.crop !== undefined) {
		const crop = parseCrop(raw.crop);
		if (!crop) return undefined;
		request.crop = crop;
	}
	if (raw.strokes !== undefined) {
		const strokes = parseStrokes(raw.strokes);
		if (!strokes) return undefined;
		if (strokes.length > 0) request.strokes = strokes;
	}
	return request;
}

export interface AssetRequest {
	assetId: number;
	crop?: Crop;
	strokes?: Stroke[];
}

/** `{assetId: positive integer, crop?: Crop, strokes?: Stroke[]}`, nothing else. */
export function parseAssetRequest(raw: unknown): AssetRequest | undefined {
	if (!isPlainObject(raw) || !onlyKeys(raw, ["assetId", "crop", "strokes"])) return undefined;
	const { assetId } = raw;
	if (typeof assetId !== "number" || !Number.isSafeInteger(assetId) || assetId <= 0) return undefined;
	const request: AssetRequest = { assetId };
	if (raw.crop !== undefined) {
		const crop = parseCrop(raw.crop);
		if (!crop) return undefined;
		request.crop = crop;
	}
	if (raw.strokes !== undefined) {
		const strokes = parseStrokes(raw.strokes);
		if (!strokes) return undefined;
		if (strokes.length > 0) request.strokes = strokes;
	}
	return request;
}

export const NONCE_PATTERN = /^[A-Za-z0-9._:{}-]{8,128}$/;
export const PROMPT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** ?since=<n> on GET /v1/prompts/:id. */
export const SINCE_PATTERN = /^\d{1,7}$/;
/** ?chunk=<n> on GET /v1/images/:id. */
export const CHUNK_PATTERN = /^\d{1,4}$/;

/** `{decision: "deploy" | "discard"}` for POST /v1/prompts/:id/deploy, nothing else. */
export function parseDeployDecision(raw: unknown): "deploy" | "discard" | undefined {
	if (!isPlainObject(raw) || !onlyKeys(raw, ["decision"])) return undefined;
	return raw.decision === "deploy" || raw.decision === "discard" ? raw.decision : undefined;
}
