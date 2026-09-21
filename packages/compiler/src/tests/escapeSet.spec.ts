import { describe, expect, it } from "bun:test"

import { quotedText } from "@essence-lang/runtime/String"

import { actsOnTerminal } from "../helpers/terminalText"

// NOTE: WHICH characters the printer escapes, pinned as a SET rather than one
// at a time. `roundTrip.spec.ts` holds the promise that whatever is printed
// reads back, and that promise can not see an escape that is MISSING: a raw
// U+2069 pasted back into a Literal lexes to U+2069, so the round trip passes
// while the printed line has already been reordered by something the reader can
// not see. Three mutations of the set survived an adversarial review for
// exactly that reason — one isolate dropped, one separator too many, and a
// normalisation at lex time — and this is what closes them.
//
// NOTE: The expectation is derived from the DOCUMENTED sentence, written out
// again here, and not from the code under test. A table captured from the
// printer would agree with whatever the printer does, which is the one thing a
// test about a set must not do. The sentence is
// `packages/website/src/content/docs/language/programs-and-values.mdx`:
// the seven with a spelling of their own; the C0 controls, DEL and the C1
// controls; the two line separators; the byte order mark; and the bidi
// controls U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069.

const SHORT_ESCAPES: { [code: number]: string } = {
	0x5c: "\\\\",
	0x22: '\\"',
	0x0a: "\\n",
	0x0d: "\\r",
	0x09: "\\t",
	0x7b: "\\{",
	0x7d: "\\}",
}

// NOTE: The invisible half of the set, said as the documentation says it. It is
// deliberately a ladder of comparisons naming each range, because a range
// written as a bound that is one off — `U+202F` instead of `U+202E`, `U+2068`
// instead of `U+2069` — is precisely the mistake this file exists to catch, and
// a reader checking it against the docs has to be able to read the bounds.
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

// NOTE: Every code point up to U+2FFF, which is every one of them that the set
// names something in, with the two isolates' neighbours and the byte order
// mark's above it. A run rather than a list, because what is being checked is
// as much what is NOT escaped as what is: U+202F is one past the last override
// and U+206A one past the last isolate, and both of them have to print as
// themselves.
const SWEPT = 0x3000

// NOTE: Above the sweep, where the set names one character and the interesting
// thing is everything around it. A surrogate is left out — it is not a
// character, it has its own rule and its own tests.
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

	// NOTE: An astral character is one character, and the set names none of
	// them — a printer that judged its two code units separately would escape
	// both halves of every emoji.
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

	// NOTE: The toolchain's OWN rule for text it is about to print — a
	// Diagnostic naming a character, a test name in the reporter — is the same
	// set less the four the printer escapes so that its output reads back as a
	// Literal. Two sets that are meant to agree and are written twice is a
	// drift waiting to happen, so it is checked rather than trusted.
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
