import { describe, expect, it } from "bun:test"

import { createRandomness, nextWord } from "@essence-lang/runtime/Randomness"
import { quotedText } from "@essence-lang/runtime/String"

import { Lexer } from "../lexer/index"

// The runtime's `quotedText` and this Compiler's Lexer, side by side. Whatever
// the printer writes is a String Literal that reads back to the value it came
// from. See "Quoting a String" in packages/runtime/DEVELOPMENT.md.
//
// A property test rather than a table, because the interesting values are
// combinations. Examples are a backslash before a brace, or a quote before a
// control character.

// Every character that is a reason to escape, with enough ordinary text around
// them. Drawn as code points and joined, so an astral character arrives whole.
const ALPHABET: Array<string> = [
	// The characters with a short escape, including the braces of a hole.
	...'\\"\n\r\t{}',
	// Ordinary text.
	..."abcXYZ 019.,-_/:é日",
	// Every C0 control, DEL, the ends of C1, the line and paragraph separators
	// and the byte order mark.
	...Array.from({ length: 0x20 }, (_, code) => String.fromCodePoint(code)),
	"\u007F",
	"\u0080",
	"\u009F",
	"\u2028",
	"\u2029",
	"\uFEFF",
	// The bidi controls, which make a printed line read as something other than
	// what it holds.
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
	// Invisible characters the printer leaves alone, which must still read back.
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
	// One line ending of two characters.
	"\r\n",
	// The replacement character itself, told apart from what a lone surrogate
	// is printed as.
	"\uFFFD",
	// Text that looks like an escape without being one.
	"\\u{1B}",
	"\\{",
	"u{1B}",
]

// The Lexer reads one String Literal. A refusal or a second Token is a failure
// of the printer, since the input is the printer's own output.
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

// The runtime's own seeded source, so a failing run names a seed that draws
// the same cases again.
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

// Several fixed seeds spread over the alphabet without making the result
// depend on the day it ran.
const SEEDS = [0x5eed_1, 0x5eed_2, 0x5eed_3, 0xc0ffee, 0x1f600]

describe("The printer reads back", () => {
	it("draws cases holding every reason to escape one", () => {
		// A guard on the generator: a draw that missed the interesting half of
		// the alphabet would pass every property over plain text.
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

	// Cases a generator reaches only by luck. A bare brace opens a hole. A
	// printed `\\` and `\{` must not run together. An escape-looking run is text.
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

	// What the printed text may not hold, read off the output. It catches an
	// escape the Lexer happens to accept as something else.
	it("prints no bare brace and no raw control character", () => {
		for (let seed of SEEDS) {
			for (let text of casesFrom(seed, 200)) {
				let printed = quotedText(text)

				// Step over each escape as the Lexer reads it, since the braces
				// of a `\u{2066}` are not bare. A short escape is two characters,
				// a long one runs through the `}`.
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

// The one value that does not read back. A lone surrogate can only arrive from
// a JavaScript host, and the Lexer refuses `\u{D800}`. It is printed as the
// replacement character, which encoding produces anyway.
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
