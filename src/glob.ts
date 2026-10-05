/**
 * A minimal glob matcher with Bun.Glob's `match` semantics for the patterns this package uses (protected paths and
 * --protect): `*` and `?` stay inside one path segment (and match dotfiles), `**` as a whole segment spans any number of
 * segments (a trailing one needs something after its slash; a leading one may match no segment at all), `[abc]` /
 * `[a-z]` / `[!a]` classes,
 * `\x` escapes, and a leading `!` negates. Braces are not supported (--protect refuses them). Paths use `/`.
 * test/glob.test.ts checks it against Bun.Glob.
 */

function escapeRegex(char: string): string {
	return /[\\^$.*+?()[\]{}|/-]/.test(char) ? `\\${char}` : char;
}

function toRegex(glob: string): RegExp {
	let out = "";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*") {
			let j = i;
			while (glob[j] === "*") j++;
			const stars = j - i;
			const segmentStart = i === 0 || glob[i - 1] === "/";
			const segmentEnd = j === glob.length || glob[j] === "/";
			if (stars >= 2 && segmentStart && segmentEnd) {
				if (j === glob.length) out += ".*"; // `**` alone, or `a/**` (its slash is already in `out`): anything
				else {
					out += "(?:[^/]*/)*"; // `**/`: zero or more whole segments
					j++; // the slash is part of the group
				}
			} else out += "[^/]*";
			i = j;
			continue;
		}
		if (c === "?") {
			out += "[^/]";
			i++;
			continue;
		}
		if (c === "[") {
			let j = i + 1;
			if (glob[j] === "!" || glob[j] === "^") j++;
			if (glob[j] === "]") j++;
			while (j < glob.length && glob[j] !== "]") j++;
			if (j >= glob.length) return /(?!)/; // an unclosed class matches nothing (as Bun.Glob)
			let body = glob.slice(i + 1, j);
			const negated = body[0] === "!" || body[0] === "^";
			if (negated) body = body.slice(1);
			const cls = body.replace(/[\\\]^[]/g, (ch, at: number) => (ch === "^" && at > 0 ? "^" : `\\${ch}`));
			out += negated ? `[^/${cls}]` : `[${cls}]`;
			i = j + 1;
			continue;
		}
		if (c === "\\" && i + 1 < glob.length) {
			out += escapeRegex(glob[i + 1]);
			i += 2;
			continue;
		}
		out += escapeRegex(c);
		i++;
	}
	return new RegExp(`^${out}$`);
}

export class Glob {
	private readonly regex: RegExp;
	private readonly negated: boolean;

	constructor(readonly pattern: string) {
		let body = pattern;
		let negated = false;
		while (body.startsWith("!")) {
			negated = !negated;
			body = body.slice(1);
		}
		this.negated = negated;
		this.regex = toRegex(body);
	}

	match(path: string): boolean {
		return this.regex.test(path) !== this.negated;
	}
}
