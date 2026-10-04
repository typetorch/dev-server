/** A small PNG encoder for RGBA8 images (no dependency): adaptive None/Sub/Up row filters, zlib deflate, CRC-32. */
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
	let crc = 0xffffffff;
	for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
	return out;
}

/** Encodes `rgba` (width × height × 4 bytes, rows top to bottom) as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("bad PNG size");
	const stride = width * 4;
	if (rgba.length !== stride * height) throw new Error("pixel data does not match the size");

	// Each row: one filter byte, then the filtered bytes. Pick the filter with the smallest sum of |signed bytes|.
	const raw = new Uint8Array((stride + 1) * height);
	const candidates = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
	for (let y = 0; y < height; y++) {
		const row = y * stride;
		const prev = row - stride;
		let best = 0;
		let bestScore = Infinity;
		for (let filter = 0; filter < 3; filter++) {
			const out = candidates[filter];
			let score = 0;
			for (let x = 0; x < stride; x++) {
				const value = rgba[row + x];
				let filtered = value;
				if (filter === 1) filtered = (value - (x >= 4 ? rgba[row + x - 4] : 0)) & 0xff;
				else if (filter === 2) filtered = (value - (y > 0 ? rgba[prev + x] : 0)) & 0xff;
				out[x] = filtered;
				score += filtered < 128 ? filtered : 256 - filtered;
			}
			if (score < bestScore) {
				bestScore = score;
				best = filter;
			}
		}
		const at = y * (stride + 1);
		raw[at] = best;
		raw.set(candidates[best], at + 1);
	}

	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8; // bit depth
	header[9] = 6; // color type: RGBA
	header[10] = 0; // deflate
	header[11] = 0; // adaptive filtering
	header[12] = 0; // no interlace
	const parts = [PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))];
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const png = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		png.set(part, offset);
		offset += part.length;
	}
	return png;
}
