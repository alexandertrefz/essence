// The reader's own text on its way into toolchain output, such as a refused
// character or a test's name. A character that acts on the terminal is spelled
// rather than printed, so a test called "\u{1B}[2K" can not erase a line.
//
// The set is the invisible part of what the runtime's `quotedText` escapes.
// `escapeSet.spec.ts` holds both to the documented list.

// The C0 and C1 controls, DEL, the bidi marks, embeddings, overrides and
// isolates, the line and paragraph separators, and the byte order mark. Each
// drives the terminal or draws nothing while changing what its neighbours mean.
export function actsOnTerminal(code: number): boolean {
	return (
		code < 0x20 ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x061c ||
		(code >= 0x200e && code <= 0x200f) ||
		(code >= 0x2028 && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069) ||
		code === 0xfeff
	)
}

// The whole character at an offset, so a message never prints half of an
// astral character as a lone surrogate.
export function characterAt(text: string, offset: number): string {
	return String.fromCodePoint(text.codePointAt(offset) ?? 0)
}

// Whether a message can hand this character to the terminal as it stands.
export function printsAsItself(character: string): boolean {
	return !actsOnTerminal(character.codePointAt(0) ?? 0)
}

// A code point as a chart names one, `U+202E`, with at least four digits. Not
// the Literal escape `\u{202E}`, since the sentence is about a character.
export function codePointName(character: string): string {
	return `U+${(character.codePointAt(0) ?? 0)
		.toString(16)
		.toUpperCase()
		.padStart(4, "0")}`
}

// One character of the reader's text for a message: quoted where it prints as
// itself, named where it does not, as in `U+202E is not a hexadecimal digit`.
export function spelledCharacter(character: string): string {
	return printsAsItself(character)
		? `'${character}'`
		: codePointName(character)
}

// A test name with each character that acts on the terminal written as `\u{…}`,
// even `\n`. Nothing else changes: a name is printed, not quoted, so its quotes,
// braces and backslashes stay as written.
export function printableText(text: string): string {
	let printable = ""
	let runStart = -1

	for (let index = 0; index < text.length; index++) {
		let code = text.charCodeAt(index)

		if (!actsOnTerminal(code)) {
			continue
		}

		printable +=
			text.slice(runStart < 0 ? 0 : runStart, index) +
			`\\u{${code.toString(16).toUpperCase()}}`
		runStart = index + 1
	}

	return runStart < 0 ? text : printable + text.slice(runStart)
}
