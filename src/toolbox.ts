/**
 * Creator Store ("Toolbox") search for remote-claude (plans/14). Runs on this PC, never on a game server:
 *
 *   GET https://apis.roblox.com/toolbox-service/v2/assets:search   (Open Cloud, BETA; unauthenticated: no key, no cookie)
 *     ?searchCategoryType=Model|MeshPart|Decal|Audio&query=...&maxPageSize=n&searchView=Full&maxPriceCents=0
 *     &includeOnlyVerifiedCreators=true|false&sortCategory=...&pageToken=...
 *
 * - Free assets only (maxPriceCents=0, and a result with a reported price is dropped anyway).
 * - Results are shaped to what the cards and Claude need: id, type, name, creator (+ verified), votes, script count,
 *   instance counts, triangles, update date; MeshPart mesh/texture ids, Decal texture id, Audio duration.
 * - Every string from the store (names, descriptions, creator names) is strangers' text: control, bidi and zero-width
 *   characters are removed, whitespace collapsed and lengths capped here; toolbox-tools.ts wraps it as untrusted data.
 * - At most one request per second (queued up to 5 s), a 10-minute cache per (query, filters), and a back-off after a
 *   429. Search costs no HttpService budget and needs no key (plans/14 "Search APIs").
 * - ToolboxMemory remembers each conversation's results (id → snapshot). Insert and add accept only remembered ids, and
 *   the game's approval card shows the snapshot, never text Claude wrote.
 */

export const TOOLBOX_SEARCH_URL = "https://apis.roblox.com/toolbox-service/v2/assets:search";

export const TOOLBOX_TYPES = ["Model", "MeshPart", "Decal", "Audio"] as const;
export type ToolboxType = (typeof TOOLBOX_TYPES)[number];
export const TOOLBOX_SORTS = ["relevance", "top", "trending", "updated"] as const;
export type ToolboxSort = (typeof TOOLBOX_SORTS)[number];

const SORT_CATEGORY: Record<ToolboxSort, string> = { relevance: "Relevance", top: "Top", trending: "Trending", updated: "UpdatedTime" };
/** assetTypeId → our type (Roblox AssetType values). */
const ASSET_TYPE_IDS: Record<number, ToolboxType> = { 10: "Model", 40: "MeshPart", 13: "Decal", 3: "Audio" };

export const TOOLBOX_LIMITS = {
	queryChars: 100,
	defaultResults: 6,
	maxResults: 10,
	/** noScripts filters on this side, so it asks for more (and the API's page cap is 100). */
	filterFactor: 3,
	nameChars: 60,
	descriptionChars: 160,
	creatorChars: 40,
	categoryChars: 40,
	pageTokenChars: 200,
	audioSeconds: 600,
	cacheTtlMs: 10 * 60_000,
	cacheEntries: 200,
	minIntervalMs: 1000,
	/** A search that would wait longer than this for its slot fails instead. */
	maxQueueMs: 5000,
	timeoutMs: 10_000,
	responseBytes: 1024 * 1024,
	backoffMs: 30_000,
	maxBackoffMs: 5 * 60_000,
	/** ToolboxMemory caps. */
	conversations: 100,
	assetsPerConversation: 300,
} as const;

export interface ToolboxQuery {
	query: string;
	type: ToolboxType;
	/** Default true (the API's own default). */
	verifiedOnly: boolean;
	/** Models: drop results with scripts (filtered here). */
	noScripts: boolean;
	sort: ToolboxSort;
	/** 1–10. */
	limit: number;
	/** nextPageToken of an earlier page. */
	page?: string;
	audioMinSeconds?: number;
	audioMaxSeconds?: number;
}

export interface ToolboxCreator {
	name: string;
	kind: "user" | "group";
	id: number;
	verified: boolean;
}

/** One search result, already cleaned: the snapshot insert/add use and the cards show. */
export interface ToolboxAsset {
	id: number;
	type: ToolboxType;
	name: string;
	/** At most 160 characters, one line. */
	description: string;
	creator: ToolboxCreator;
	/** Omitted when the store hides the votes. */
	votes?: { upPercent: number; count: number };
	/** Models: the listing's script count (the game counts again after loading). */
	scripts?: number;
	counts?: { meshPart: number; tool: number; decal: number; audio: number; animation: number; script: number };
	triangles?: number;
	/** YYYY-MM-DD of the last update. */
	updated?: string;
	/** ISO time of the last update (toolbox.lock.toml keeps it). */
	updateTime?: string;
	category?: string;
	/** MeshPart. */
	meshId?: number;
	/** MeshPart and Decal (a Decal's image id). */
	textureId?: number;
	/** Audio. */
	durationSeconds?: number;
}

export interface ToolboxPage {
	results: ToolboxAsset[];
	next?: string;
	total?: number;
	/** Results dropped here (noScripts, a price, a type mismatch, a malformed row). */
	dropped: number;
}

export type SearchOutcome = { ok: true; page: ToolboxPage; cached: boolean } | { ok: false; error: string; retryAfterSeconds?: number };

// Characters that hide or reorder text: C0/C1 controls, bidi embeddings/overrides/isolates and marks, zero-width
// characters, the BOM and the line/paragraph separators. (A RegExp from a string: Bun's transpiler writes the escapes of
// a regex literal out as raw characters, and a raw U+2028 ends the literal.)
const HIDDEN = new RegExp(
	"[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u115f\\u1160\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufff8]",
	"g",
);

/** Strangers' text as one safe line: hidden characters removed, whitespace collapsed, cut to `max` characters. */
export function cleanText(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const flat = value.replace(/[\r\n\t]+/g, " ").replace(HIDDEN, "").replace(/\s+/g, " ").trim();
	const chars = [...flat];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const assetId = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : typeof value === "string" && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : undefined;

/** One `creatorStoreAssets[]` row → a cleaned asset, or undefined when it is malformed, paid or of another type. */
export function shapeAsset(raw: unknown, expected?: ToolboxType): ToolboxAsset | undefined {
	if (!isRecord(raw) || !isRecord(raw.asset)) return undefined;
	const asset = raw.asset;
	const id = assetId(asset.id);
	if (id === undefined) return undefined;
	const type = typeof asset.assetTypeId === "number" ? ASSET_TYPE_IDS[asset.assetTypeId] : undefined;
	if (!type || (expected && type !== expected)) return undefined;
	// Free only: the request asks for maxPriceCents=0; a row that still reports a price is dropped.
	const price = isRecord(raw.creatorStoreProduct) && isRecord(raw.creatorStoreProduct.purchasePrice) ? raw.creatorStoreProduct.purchasePrice.quantity : undefined;
	if (isRecord(price) && typeof price.significand === "number" && price.significand !== 0) return undefined;
	const creatorRaw = isRecord(raw.creator) ? raw.creator : {};
	const groupId = assetId(creatorRaw.groupId);
	const userId = assetId(creatorRaw.userId);
	const creator: ToolboxCreator = {
		name: cleanText(creatorRaw.name, TOOLBOX_LIMITS.creatorChars) || "?",
		kind: groupId !== undefined ? "group" : "user",
		id: groupId ?? userId ?? 0,
		verified: creatorRaw.verified === true,
	};
	const result: ToolboxAsset = {
		id,
		type,
		name: cleanText(asset.name, TOOLBOX_LIMITS.nameChars) || `asset ${id}`,
		description: cleanText(asset.description, TOOLBOX_LIMITS.descriptionChars),
		creator,
	};
	if (isRecord(raw.voting) && raw.voting.showVotes !== false) {
		result.votes = { upPercent: Math.min(100, count(raw.voting.upVotePercent)), count: count(raw.voting.voteCount) };
	}
	if (typeof asset.updateTime === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(asset.updateTime)) {
		result.updateTime = asset.updateTime;
		result.updated = asset.updateTime.slice(0, 10);
	}
	const category = cleanText(asset.categoryPath, TOOLBOX_LIMITS.categoryChars);
	if (category) result.category = category;
	if (type === "Model") {
		result.scripts = count(asset.scriptCount);
		if (asset.hasScripts === true && result.scripts === 0) result.scripts = 1; // listed with scripts but no count
		const counts = isRecord(asset.instanceCounts) ? asset.instanceCounts : {};
		result.counts = {
			meshPart: count(counts.meshPart),
			tool: count(counts.tool),
			decal: count(counts.decal),
			audio: count(counts.audio),
			animation: count(counts.animation),
			script: count(counts.script),
		};
		if (isRecord(asset.objectMeshSummary)) result.triangles = count(asset.objectMeshSummary.triangles);
	} else if (type === "MeshPart") {
		result.meshId = assetId(asset.meshId);
		result.textureId = assetId(asset.textureId);
	} else if (type === "Decal") {
		result.textureId = assetId(asset.textureId);
	} else if (type === "Audio") {
		if (typeof asset.durationSeconds === "number" && asset.durationSeconds >= 0) result.durationSeconds = Math.round(asset.durationSeconds);
	}
	return result;
}

/** The whole search response → a page; undefined when it isn't the documented shape. */
export function shapePage(raw: unknown, query: Pick<ToolboxQuery, "type" | "noScripts" | "limit">): ToolboxPage | undefined {
	if (!isRecord(raw) || !Array.isArray(raw.creatorStoreAssets)) return undefined;
	const results: ToolboxAsset[] = [];
	let dropped = 0;
	for (const row of raw.creatorStoreAssets) {
		const asset = shapeAsset(row, query.type);
		if (!asset || (query.noScripts && query.type === "Model" && (asset.scripts ?? 0) > 0) || results.some((r) => r.id === asset.id)) {
			dropped += 1;
			continue;
		}
		if (results.length < query.limit) results.push(asset);
	}
	const page: ToolboxPage = { results, dropped };
	if (typeof raw.nextPageToken === "string" && raw.nextPageToken.length > 0 && raw.nextPageToken.length <= TOOLBOX_LIMITS.pageTokenChars) page.next = raw.nextPageToken;
	if (typeof raw.totalResults === "number" && raw.totalResults >= 0) page.total = Math.floor(raw.totalResults);
	return page;
}

/** The request URL for a query (always free, Full view). */
export function searchUrl(query: ToolboxQuery): string {
	const params = new URLSearchParams();
	params.set("searchCategoryType", query.type);
	params.set("query", query.query);
	const size = query.noScripts && query.type === "Model" ? Math.min(100, query.limit * TOOLBOX_LIMITS.filterFactor) : query.limit;
	params.set("maxPageSize", String(size));
	params.set("searchView", "Full");
	params.set("maxPriceCents", "0");
	params.set("includeOnlyVerifiedCreators", query.verifiedOnly ? "true" : "false");
	params.set("sortCategory", SORT_CATEGORY[query.sort]);
	if (query.page) params.set("pageToken", query.page);
	if (query.type === "Audio") {
		if (query.audioMinSeconds !== undefined) params.set("audioMinDurationSeconds", String(query.audioMinSeconds));
		if (query.audioMaxSeconds !== undefined) params.set("audioMaxDurationSeconds", String(query.audioMaxSeconds));
	}
	return `${TOOLBOX_SEARCH_URL}?${params.toString()}`;
}

const cacheKey = (query: ToolboxQuery) =>
	JSON.stringify([query.type, query.query.toLowerCase(), query.verifiedOnly, query.noScripts, query.sort, query.limit, query.page ?? "", query.audioMinSeconds ?? -1, query.audioMaxSeconds ?? -1]);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ToolboxClientOptions {
	fetch?: FetchLike;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	minIntervalMs?: number;
	cacheTtlMs?: number;
	timeoutMs?: number;
}

/** The search client: one request per second, a 10-minute cache, a back-off after 429. */
export class ToolboxClient {
	private readonly fetcher: FetchLike;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly minIntervalMs: number;
	private readonly cacheTtlMs: number;
	private readonly timeoutMs: number;
	private readonly cache = new Map<string, { at: number; page: ToolboxPage }>();
	private nextSlot = 0;
	private blockedUntil = 0;
	private backoffMs: number = TOOLBOX_LIMITS.backoffMs;
	/** Requests actually sent (tests). */
	requests = 0;

	constructor(options: ToolboxClientOptions = {}) {
		this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.minIntervalMs = options.minIntervalMs ?? TOOLBOX_LIMITS.minIntervalMs;
		this.cacheTtlMs = options.cacheTtlMs ?? TOOLBOX_LIMITS.cacheTtlMs;
		this.timeoutMs = options.timeoutMs ?? TOOLBOX_LIMITS.timeoutMs;
	}

	async search(query: ToolboxQuery, signal?: AbortSignal): Promise<SearchOutcome> {
		const key = cacheKey(query);
		const now = this.now();
		const hit = this.cache.get(key);
		if (hit && now - hit.at < this.cacheTtlMs) return { ok: true, page: hit.page, cached: true };
		if (hit) this.cache.delete(key);
		if (now < this.blockedUntil) {
			const wait = Math.ceil((this.blockedUntil - now) / 1000);
			return { ok: false, error: `Creator Store search is rate limited; try again in ${wait} s.`, retryAfterSeconds: wait };
		}
		// One request per second: take the next slot, or give up when it is too far away.
		const slot = Math.max(now, this.nextSlot);
		if (slot - now > TOOLBOX_LIMITS.maxQueueMs) return { ok: false, error: "Too many Creator Store searches at once; try again in a few seconds.", retryAfterSeconds: Math.ceil((slot - now) / 1000) };
		this.nextSlot = slot + this.minIntervalMs;
		if (slot > now) await this.sleep(slot - now);
		if (signal?.aborted) return { ok: false, error: "cancelled" };
		this.requests += 1;
		let response: Response;
		try {
			const timeout = AbortSignal.timeout(this.timeoutMs);
			response = await this.fetcher(searchUrl(query), {
				method: "GET",
				// No cookie, no key: the endpoint answers unauthenticated GETs (plans/14). Nothing about the dev is sent.
				headers: { accept: "application/json" },
				redirect: "error",
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			return { ok: false, error: name === "TimeoutError" ? "Creator Store search timed out." : "Creator Store search failed (network)." };
		}
		if (response.status === 429) {
			const header = Number(response.headers.get("retry-after") ?? response.headers.get("x-ratelimit-reset") ?? "");
			const waitMs = Number.isFinite(header) && header > 0 ? Math.min(TOOLBOX_LIMITS.maxBackoffMs, header * 1000) : this.backoffMs;
			this.backoffMs = Math.min(TOOLBOX_LIMITS.maxBackoffMs, this.backoffMs * 2);
			this.blockedUntil = this.now() + waitMs;
			await response.body?.cancel().catch(() => {});
			return { ok: false, error: `Creator Store search is rate limited (HTTP 429); try again in ${Math.ceil(waitMs / 1000)} s.`, retryAfterSeconds: Math.ceil(waitMs / 1000) };
		}
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel().catch(() => {});
			return { ok: false, error: `Roblox refused the unauthenticated Creator Store search (HTTP ${response.status}); it may require a key now (plans/14 Q7).` };
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			return { ok: false, error: `Creator Store search failed (HTTP ${response.status}).` };
		}
		this.backoffMs = TOOLBOX_LIMITS.backoffMs;
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (declared > TOOLBOX_LIMITS.responseBytes) {
			await response.body?.cancel().catch(() => {});
			return { ok: false, error: "Creator Store search answered too much data." };
		}
		let text: string;
		try {
			text = await response.text();
		} catch {
			return { ok: false, error: "Creator Store search failed (network)." };
		}
		if (text.length > TOOLBOX_LIMITS.responseBytes) return { ok: false, error: "Creator Store search answered too much data." };
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return { ok: false, error: "Creator Store search answered something that isn't JSON." };
		}
		const page = shapePage(body, query);
		if (!page) return { ok: false, error: "Creator Store search answered an unexpected shape." };
		if (this.cache.size >= TOOLBOX_LIMITS.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
		this.cache.set(key, { at: this.now(), page });
		return { ok: true, page, cached: false };
	}
}

/**
 * Each conversation's search results, id → snapshot (the newest snapshot wins). Insert and add accept only ids found
 * here, so Claude can't be steered to an id hidden in a description or in game data.
 */
export class ToolboxMemory {
	private readonly conversations = new Map<string, Map<number, ToolboxAsset>>();

	remember(conversationId: string, assets: readonly ToolboxAsset[]): void {
		let known = this.conversations.get(conversationId);
		if (known) this.conversations.delete(conversationId); // re-insert: most recently used last
		else known = new Map();
		this.conversations.set(conversationId, known);
		for (const asset of assets) {
			known.delete(asset.id);
			known.set(asset.id, asset);
		}
		while (known.size > TOOLBOX_LIMITS.assetsPerConversation) known.delete(known.keys().next().value!);
		while (this.conversations.size > TOOLBOX_LIMITS.conversations) this.conversations.delete(this.conversations.keys().next().value!);
	}

	get(conversationId: string, id: number): ToolboxAsset | undefined {
		return this.conversations.get(conversationId)?.get(id);
	}

	forget(conversationId: string): void {
		this.conversations.delete(conversationId);
	}
}
