import { describe, expect, it } from "bun:test"

import { quotedText } from "@essence-lang/runtime/String"

import { actsOnTerminal } from "../helpers/terminalText"

// Pins the whole set of characters the printer escapes. `roundTrip.spec.ts`
// cannot see a missing escape: a raw U+2069 reads back as itself, so the round
// trip passes while the printed line is already reordered.
//
// The expectation is written from the documentation, not captured from the
// printer, which would agree with whatever the printer does. The set holds the
// characters with a short escape, the C0 controls, DEL and the C1 controls. It
// also holds U+2028, U+2029, the byte order mark, and the bidi controls U+061C,
// U+200E, U+200F, U+202A to U+202E and U+2066 to U+2069.

const SHORT_ESCAPES: { [code: number]: string } = {
	0x5c: "\\\\",
	0x22: '\\"',
	0x0a: "\\n",
	0x0d: "\\r",
	0x09: "\\t",
	0x7b: "\\{",
	0x7d: "\\}",
}

// The invisible part of the set. Each range spells out its bounds for checking
// against the documentation, since an off-by-one bound is what this spec catches.
function documentedAsInvisible(code: number): boolean {
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0xfeff ||
		code === 0x061c ||
		code === 0x200e ||
		code === 0x200f ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069)
	)
}

function documentedSpelling(code: number): string {
	let short = SHORT_ESCAPES[code]

	if (short !== undefined) {
		return short
	}

	return documentedAsInvisible(code)
		? `\\u{${code.toString(16).toUpperCase()}}`
		: String.fromCharCode(code)
}

function named(code: number): string {
	return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`
}

// Every code point up to U+2FFF, which covers each range the set names but the
// byte order mark. It is a run rather than a list because what is left alone
// matters too: U+202F and U+206A must print as themselves.
const SWEPT = 0x3000

// Above the sweep the set names only the byte order mark, so its neighbours
// are sampled. A lone surrogate is not a character and has its own specs.
const SAMPLED = [
	0x3000, 0x4e00, 0x7fff, 0xd7ff, 0xe000, 0xfefe, 0xfeff, 0xff00, 0xfffd,
	0xfffe, 0xffff,
]

describe("the escape set", () => {
	it("escapes exactly what the documentation says it does", () => {
		let mismatches: Array<string> = []

		for (let code = 0; code < SWEPT; code++) {
			if (code >= 0xd800 && code <= 0xdfff) {
				continue
			}

			let printed = quotedText(`a${String.fromCharCode(code)}b`)
			let expected = `"a${documentedSpelling(code)}b"`

			if (printed !== expected) {
				mismatches.push(
					`${named(code)} printed ${JSON.stringify(printed)}, documented as ${JSON.stringify(expected)}`,
				)
			}
		}

		expect(mismatches).toEqual([])
	})

	it("escapes exactly what the documentation says above the sweep", () => {
		let mismatches: Array<string> = []

		for (let code of SAMPLED) {
			let printed = quotedText(`a${String.fromCharCode(code)}b`)
			let expected = `"a${documentedSpelling(code)}b"`

			if (printed !== expected) {
				mismatches.push(
					`${named(code)} printed ${JSON.stringify(printed)}, documented as ${JSON.stringify(expected)}`,
				)
			}
		}

		expect(mismatches).toEqual([])
	})

	// The set names no astral character. A printer judging the two code units
	// separately would escape both halves of every emoji.
	it("leaves every astral character as itself", () => {
		let mismatches: Array<number> = []

		for (let point = 0x10000; point <= 0x10ffff; point += 0x11) {
			let character = String.fromCodePoint(point)

			if (quotedText(character) !== `"${character}"`) {
				mismatches.push(point)
			}
		}

		expect(mismatches).toEqual([])
	})

	// `actsOnTerminal` guards text the toolchain prints, such as a Diagnostic or
	// a test name. It must match the invisible part of the set, which leaves out
	// `\`, `"`, `{` and `}` since only a Literal needs those escaped.
	it("agrees with what the toolchain will not echo", () => {
		let disagreements: Array<string> = []

		for (let code = 0; code < SWEPT; code++) {
			if (actsOnTerminal(code) !== documentedAsInvisible(code)) {
				disagreements.push(named(code))
			}
		}

		expect(disagreements).toEqual([])
	})
})
