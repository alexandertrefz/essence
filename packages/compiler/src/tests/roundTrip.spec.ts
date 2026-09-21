import { describe, expect, it } from "bun:test"

import { createRandomness, nextWord } from "@essence-lang/runtime/Randomness"
import { quotedText } from "@essence-lang/runtime/String"

import { Lexer } from "../lexer/index"

// NOTE: THE PROMISE `quotedText` MAKES, held to by the two halves that make it:
// the runtime's printer and this Compiler's Lexer, standing beside each other in
// one process. Whatever `quote()`, `Terminal.inspect` or any structural
// rendering prints, pasted into a source file as it stands, is a String Literal
// that reads back to the very value it came from.
//
// It was not true before `\u{…}` existed. `"a\{b\}"::quote()` printed `"a{b}"`,
// whose `{` opens an interpolation hole when it is read back, and every control
// character was already printed as `\u{1B}` — an escape the Lexer then refused
// twice over. Both halves of that are what this holds.
//
// NOTE: A property test rather than a table, because the interesting values are
// the COMBINATIONS: a backslash in front of a brace, a quote in front of a
// control character, half of a surrogate pair beside a whole one. A table is
// the list of cases somebody thought of, and the two bugs above were both in
// the part nobody did.

// NOTE: The alphabet the cases are drawn from — every character that has ever
// been a reason to escape one, and enough ordinary text around them that a case
// is a String rather than a pile of controls. Drawn as code points and joined,
// so an astral character arrives whole.
const ALPHABET: Array<string> = [
	// The five with a spelling of their own, and the two that open and close a
	// hole.
	...'\\"\n\r\t{}',
	// Ordinary text, which is most of what a real value is made of.
	..."abcXYZ 019.,-_/:é日",
	// Every C0 control and DEL, C1, and the three the standard hides.
	...Array.from({ length: 0x20 }, (_, code) => String.fromCodePoint(code)),
	"\u007F",
	"\u0080",
	"\u009F",
	"\u2028",
	"\u2029",
	"\uFEFF",
	// The bidi controls — the ones that make a printed line read as something
	// other than what it holds.
	"\u061C",
	"\u200E",
	"\u200F",
	"\u202A",
	"\u202B",
	"\u202C",
	"\u202D",
	"\u202E",
	"\u2066",
	"\u2067",
	"\u2068",
	"\u2069",
	// The invisible ones that are deliberately left alone, so a case that draws
	// one proves they still read back.
	"\u200B",
	"\u200C",
	"\u200D",
	"\u00AD",
	"\u00A0",
	// Astral characters, a combining mark, and a whole emoji sequence with its
	// joiners.
	"\u{1F600}",
	"\u{10FFFF}",
	"\u{1D11E}",
	"\u0301",
	"\u{1F469}\u200D\u{1F4BB}",
	// A carriage return and line feed written together, which is one line
	// ending and two characters.
	"\r\n",
	// The replacement character itself, so it is told apart from what a lone
	// surrogate is printed as.
	"\uFFFD",
	// Text that LOOKS like an escape without being one.
	"\\u{1B}",
	"\\{",
	"u{1B}",
]

// NOTE: The Lexer reading one String Literal, which is the half of the promise
// this file can not write itself. A refusal or a second Token is a failure of
// the printer, not of the case: what was handed in was the printer's own
// output, and the printer's claim is that this reads.
function readBack(literal: string): string {
	let lexer = new Lexer()

	lexer.reset(literal)

	let token = lexer.next()
	let after = lexer.next()

	expect({
		literal,
		errors: lexer.errors.map((error) => error.code as string),
		type: token?.type as string | undefined,
		after: after?.type as string | undefined,
	}).toEqual({
		literal,
		errors: [],
		type: "LiteralString",
		after: undefined,
	})

	return token?.value ?? ""
}

// NOTE: The runtime's own seeded source, so a failing run names a seed that
// draws the same cases again — and so the generator is one this repository
// already trusts rather than a second one written here.
function casesFrom(seed: number, count: number): Array<string> {
	let source = createRandomness(seed)
	let cases: Array<string> = []

	for (let index = 0; index < count; index++) {
		let length = nextWord(source) % 12
		let text = ""

		for (let piece = 0; piece < length; piece++) {
			text += ALPHABET[nextWord(source) % ALPHABET.length]
		}

		cases.push(text)
	}

	return cases
}

// NOTE: FIXED seeds, and several of them. One seed is one sequence of cases and
// would pass forever once it did; several spread over the alphabet without
// making the suite's result depend on the day it ran.
const SEEDS = [0x5eed_1, 0x5eed_2, 0x5eed_3, 0xc0ffee, 0x1f600]

describe("The printer reads back", () => {
	it("draws cases holding every reason to escape one", () => {
		// NOTE: A guard on the generator. A draw that stopped reaching the
		// interesting half of the alphabet would leave every property below
		// passing over `abc`.
		let drawn = SEEDS.flatMap((seed) => casesFrom(seed, 200)).join("")

		for (let character of [
			'"',
			"\\",
			"{",
			"}",
			"\u001B",
			"\u202E",
			"\u{1F600}",
		]) {
			expect([character, drawn.includes(character)]).toEqual([
				character,
				true,
			])
		}
	})

	for (let seed of SEEDS) {
		it(`round-trips every drawn String at seed ${seed.toString(16)}`, () => {
			for (let text of casesFrom(seed, 200)) {
				expect([seed, readBack(quotedText(text))]).toEqual([seed, text])
			}
		})
	}

	// NOTE: The cases a generator reaches only by luck, written down so they are
	// reached every run. Each of these was a real reading: a bare brace opening
	// a hole, `\` and `{` written flush so the printed `\\` and `\{` must not
	// run together into `\\{`, and an escape-looking run that is text.
	it("round-trips the readings a draw only reaches by luck", () => {
		let written = [
			"",
			"{",
			"}",
			"a{b}",
			"\\{",
			"\\",
			"\\\\",
			'"',
			'"{"',
			"\u001B[0m",
			"\\u{1B}",
			"{{{}}}",
			"\u202Eabc\u202C",
			"e\u0301",
			"\uFEFFleading",
			"\r\n\t",
			"\u{1F469}\u200D\u{1F4BB}",
		]

		for (let text of written) {
			expect([text, readBack(quotedText(text))]).toEqual([text, text])
		}
	})

	// NOTE: What the printed text may NOT hold, read off the output rather than
	// off the value. It is the round-trip said the other way round, and it
	// catches the one failure a round-trip over a finite alphabet could miss:
	// an escape spelled in a way the Lexer happens to accept as something else.
	it("prints no bare brace and no raw control character", () => {
		for (let seed of SEEDS) {
			for (let text of casesFrom(seed, 200)) {
				let printed = quotedText(text)

				// NOTE: Stepping OVER each escape rather than looking behind
				// each character: the braces of a `\u{2066}` are part of one,
				// and a test that read them as bare would be a test of its own
				// naivety. The step is the Lexer's own reading — two characters
				// for the short escapes, and through the `}` for the long one.
				let index = 1

				while (index < printed.length - 1) {
					if (printed[index] === "\\") {
						index +=
							printed[index + 1] === "u"
								? printed.indexOf("}", index) + 1 - index
								: 2

						continue
					}

					let code = printed.charCodeAt(index)

					expect({
						printed,
						bare: code === 0x7b || code === 0x7d ? index : -1,
						control: code < 0x20 || code === 0x7f ? index : -1,
						quote: code === 0x22 ? index : -1,
					}).toEqual({
						printed,
						bare: -1,
						control: -1,
						quote: -1,
					})

					index++
				}
			}
		}
	})
})

// NOTE: The one value the promise is NOT made about, said out loud. A lone
// surrogate is half of a character; no Literal spells one, `String.of(codePoint
// 55296)` answers nothing, and segmenting never splits a pair — one can only
// have crossed the embedding boundary from a JavaScript host. There is no
// escape that reads back to it, because the Lexer refuses `\u{D800}` on
// purpose, so it is printed as what encoding the text would turn it into
// anyway.
describe("A lone surrogate", () => {
	it("is printed as the replacement character's escape", () => {
		expect(quotedText("a\uD800b")).toBe('"a\\u{FFFD}b"')
		expect(quotedText("a\uDFFFb")).toBe('"a\\u{FFFD}b"')
		expect(quotedText("\uD83D")).toBe('"\\u{FFFD}"')
		expect(quotedText("\uDE00")).toBe('"\\u{FFFD}"')
	})

	it("leaves a whole pair alone", () => {
		expect(quotedText("\uD83D\uDE00")).toBe('"\u{1F600}"')
		expect(readBack(quotedText("\uD83D\uDE00"))).toBe("\u{1F600}")
	})

	it("is told apart from a replacement character that was really there", () => {
		expect(quotedText("\uFFFD")).toBe('"\uFFFD"')
		expect(readBack(quotedText("\uFFFD"))).toBe("\uFFFD")
	})

	it("reads back as the character it names", () => {
		expect(readBack(quotedText("a\uD800b"))).toBe("a\uFFFDb")
	})
})
