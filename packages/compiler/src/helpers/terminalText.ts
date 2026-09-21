// NOTE: The reader's OWN text, on its way into something the toolchain prints.
// A Diagnostic names the character a Literal was refused for; the test reporter
// prints the name a test was written under. Both used to hand that text to the
// terminal as it stood, which was harmless only while no Program could write a
// character that ACTS there — `\u{…}` made every one of them writable, so a
// test called "\u{1B}[2K" now erases the line the report had just written and a
// `\u{202E}` inside one reorders it. A report that can be made to say something
// other than what it holds is not a report.
//
// NOTE: The SAME SET the runtime's `quotedText` escapes, less the four
// characters it escapes for a reason that is not about the terminal at all
// (`"`, `\`, `{` and `}` are escaped so its output READS BACK as a Literal).
// The two are held together by `escapeSet.spec.ts`, which derives both from the
// one documented sentence — a character the printer escapes for being invisible
// and this does not is a drift the suite goes red for.

// NOTE: The C0 controls and DEL, the C1 controls, the bidi marks, embeddings,
// overrides and isolates, the two line separators, and the byte order mark.
// Every one of them either drives the terminal or draws nothing while changing
// what its neighbours mean; nothing else does.
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

// NOTE: The WHOLE character at an offset, not the code unit standing there. A
// message that named half of an astral character would print a lone surrogate,
// which is the one thing no text can carry.
export function characterAt(text: string, offset: number): string {
	return String.fromCodePoint(text.codePointAt(offset) ?? 0)
}

// NOTE: Whether a message can hand this character to the terminal as it stands.
export function printsAsItself(character: string): boolean {
	return !actsOnTerminal(character.codePointAt(0) ?? 0)
}

// NOTE: A code point the way a chart names one — `U+202E`, four digits at the
// least, which is how the standard writes it and how a reader looks it up. It
// is deliberately NOT the Literal spelling `\u{202E}`: the sentences it lands in
// are about a character, and a reader who has just been refused an escape does
// not need a second one to read past.
export function codePointName(character: string): string {
	return `U+${(character.codePointAt(0) ?? 0)
		.toString(16)
		.toUpperCase()
		.padStart(4, "0")}`
}

// NOTE: One character of the reader's text, ready to drop into a message:
// quoted where it prints as itself, and named where it does not. `'G' is not a
// hexadecimal digit` and `U+202E is not a hexadecimal digit` — the quotes go
// with the character, because a pair of them with nothing between is what a
// byte order mark used to print as.
export function spelledCharacter(character: string): string {
	return printsAsItself(character)
		? `'${character}'`
		: codePointName(character)
}

// NOTE: A whole run of the reader's text — a test NAME — with the characters
// that act on the terminal written as the escape a String Literal spells them
// with, and NOTHING else touched. A name is not a value: it is printed rather
// than quoted, so it keeps its quotes, its braces and its backslashes exactly
// as they were written and only what would drive the terminal is spelled.
//
// Every one of them as `\u{…}`, including the three with a short spelling of
// their own: `\n` in a name is rare enough that naming its code point costs
// nobody anything, and one rule here is one rule to read.
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
