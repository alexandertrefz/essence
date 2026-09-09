import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { entryPoints, TestEvent } from "@essence-lang/runtime/Testing"
import { registry, registryOf } from "@essence-lang/runtime/Testing"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The String entries wave 4 added — the code points, the four character
// classes, the folding searches, the cuts and the rest of the vocabulary —
// beside the two parses that read the notation the language writes.
// `stdlibStrings.spec.ts` holds the entries that were there before, and the
// same rule decides what belongs here: an ASCII String and a String the scan
// refuses take two different routes through the runtime, so every answer below
// is asked over both.
//
// NOTE: What the golden capture can not hold is here instead. It prints a
// value per call, so a claim ABOUT two calls — that `everyIndex` and `count`
// agree, that a String is its own points read back — has to be written down as
// a claim.
function generate(source: string, options: { tests?: boolean } = {}): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = options.tests
		? enrich(parsed.program, { tests: true, source })
		: enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-string-additions-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

type Loaded = { $tests: typeof entryPoints }

// NOTE: The property tests, driven through the loaded program's OWN `$tests`
// for the reason `testingProperties.spec.ts` gives: every Essence value carries
// a hidden Type key belonging to the runtime instance that built it.
async function propertyFailures(source: string): Promise<Array<string>> {
	let javaScript = generate(source, { tests: true })
	let directory = mkdtempSync(join(tmpdir(), "essence-string-properties-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let before = registry().modules.length
	let loaded = (await import(file)) as Loaded
	let scoped = registryOf(loaded.$tests.registry().modules.slice(before))
	let events: Array<TestEvent> = []

	try {
		loaded.$tests.run(scoped, {
			sink: (event) => events.push(event),
			now: () => 0,
			seed: "w4stringadditions",
		})

		return events
			.filter((event) => event.kind === "test-fail")
			.map((event) => (event as { name: string }).name)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// NOTE: A four-person family emoji — eleven code units joined by zero-width
// joiners, ONE character — and a flag, whose two regional indicators are also
// one. The Lexer knows no `\u` escape, so the JavaScript String carries the
// code points in. `combining` is an `e` and a combining acute, which is one
// character that NFC composes into one code point.
const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"
const flag = "\u{1F1E9}\u{1F1EA}"
const combining = "e\u0301"
const mark = "\u0301"

describe("Character", () => {
	// NOTE: A refinement erases before anything runs, so what this shows is
	// that a Character reaches every position a String reaches and that a
	// written one-character Literal is its own proof.
	it("is a String a one-character Literal proves", async () => {
		expect(
			await run(`implementation {
				constant written: Character = "x"
				constant read = "Lions"::character(at 0, defaultingTo "?")
				constant asString: String = read

				Terminal.inspect(written)
				Terminal.inspect(asString::append("!"))
				Terminal.inspect("Lions"::characters())
				Terminal.inspect("Lions"::firstCharacter(defaultingTo "?"))
				Terminal.inspect("Lions"::lastCharacter(defaultingTo "?"))
			}`),
		).toEqual(['"x"', '"L!"', '[ "L", "i", "o", "n", "s" ]', '"L"', '"s"'])
	})

	it("counts a grapheme cluster as the one character it is", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("x"::isOneCharacter())
				Terminal.inspect("ab"::isOneCharacter())
				Terminal.inspect(""::isOneCharacter())
				Terminal.inspect("${family}"::isOneCharacter())
				Terminal.inspect("${flag}"::isOneCharacter())
				Terminal.inspect("${combining}"::isOneCharacter())
				Terminal.inspect("\\r\\n"::isOneCharacter())
			}`),
		).toEqual(["true", "false", "false", "true", "true", "true", "true"])
	})
})

describe("code points", () => {
	// NOTE: The level difference stated as a measurement: one character of
	// seven points, one of two, and one that NFC composes into one.
	it("reads the points below the characters", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("ab"::codePoints())
				Terminal.inspect(""::codePoints())
				Terminal.inspect("${family}"::codePoints()::length())
				Terminal.inspect("${family}"::length())
				Terminal.inspect("${flag}"::codePoints())
				Terminal.inspect("${combining}"::codePoints())
				Terminal.inspect("${combining}"::length())
			}`),
		).toEqual([
			"[ 97, 98 ]",
			"[]",
			"7",
			"1",
			"[ 127465, 127466 ]",
			"[ 233 ]",
			"1",
		])
	})

	it("reads a String back from its own points", async () => {
		expect(
			await run(`implementation {
				constant texts = ["ab", "", "${family}", "${flag}", "${combining}"]

				Terminal.inspect(
					texts::everyItem(where (text) {
						<- String.of(codePoints text::codePoints())::isNot(text)
					}),
				)
			}`),
		).toEqual(["[]"])
	})

	it("refuses a point that names no character", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(String.of(codePoint 97))
				Terminal.inspect(String.of(codePoint 0))
				Terminal.inspect(String.of(codePoint 55295))
				Terminal.inspect(String.of(codePoint 55296))
				Terminal.inspect(String.of(codePoint 57343))
				Terminal.inspect(String.of(codePoint 57344))
				Terminal.inspect(String.of(codePoint 1114111))
				Terminal.inspect(String.of(codePoint 1114112))
				Terminal.inspect(String.of(codePoints [97, 1114112]))
				Terminal.inspect(String.of(codePoints [97, -1]))
			}`),
		).toEqual([
			'Optional#Value("a")',
			'Optional#Value("\\u{0}")',
			'Optional#Value("퟿")',
			"Optional#Empty",
			"Optional#Empty",
			'Optional#Value("")',
			'Optional#Value("\u{10FFFF}")',
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
		])
	})
})

describe("the character classes", () => {
	it("classifies by Unicode category, not by ASCII", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("2026"::hasOnlyDigits())
				Terminal.inspect("٣٤"::hasOnlyDigits())
				Terminal.inspect("2026-09"::hasOnlyDigits())
				Terminal.inspect(""::hasOnlyDigits())
				Terminal.inspect("Grüße"::hasOnlyLetters())
				Terminal.inspect("字"::hasOnlyLetters())
				Terminal.inspect("Rule 34"::hasOnlyLetters())
				Terminal.inspect(""::hasOnlyLetters())
				Terminal.inspect("route66"::hasOnlyLettersOrDigits())
				Terminal.inspect("route 66"::hasOnlyLettersOrDigits())
				Terminal.inspect(" \\t\\r\\n"::hasOnlyWhitespace())
				Terminal.inspect(" x "::hasOnlyWhitespace())
				Terminal.inspect(""::hasOnlyWhitespace())
			}`),
		).toEqual([
			"true",
			"true",
			"false",
			"true",
			"true",
			"true",
			"false",
			"true",
			"true",
			"false",
			"true",
			"false",
			"true",
		])
	})

	// NOTE: A mark belongs to the letter BEFORE it, which is what the two
	// letter patterns say. So a decomposed accent is letters and a mark
	// standing on its own is not.
	it("counts a combining mark as part of the letter before it", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("${combining}"::hasOnlyLetters())
				Terminal.inspect("a${combining}"::hasOnlyLetters())
				Terminal.inspect("${mark}"::hasOnlyLetters())
				Terminal.inspect("${family}"::hasOnlyLetters())
				Terminal.inspect("${family}"::hasOnlyLettersOrDigits())
			}`),
		).toEqual(["true", "true", "false", "false", "false"])
	})
})

describe("a folded search", () => {
	it("finds a part under either case over either route", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("Lions"::contains("ION", comparing #Insensitive))
				Terminal.inspect("Lions"::contains("ION", comparing #Sensitive))
				Terminal.inspect("Lions"::doesNotContain("ION", comparing #Insensitive))
				Terminal.inspect("Lions"::starts(with "li", comparing #Insensitive))
				Terminal.inspect("Lions"::doesNotStart(with "li", comparing #Insensitive))
				Terminal.inspect("Lions"::ends(with "NS", comparing #Insensitive))
				Terminal.inspect("Lions"::doesNotEnd(with "NS", comparing #Insensitive))
				Terminal.inspect("bAnana"::count(of "A", comparing #Insensitive))
				Terminal.inspect("bAnana"::count(of "A", comparing #Sensitive))
				Terminal.inspect("a${family}B"::contains("b", comparing #Insensitive))
				Terminal.inspect("a${family}B"::ends(with "b", comparing #Insensitive))
				Terminal.inspect("a${family}B"::starts(with "A", comparing #Insensitive))
				Terminal.inspect("a${family}B"::count(of "${family}", comparing #Insensitive))
			}`),
		).toEqual([
			"true",
			"false",
			"false",
			"true",
			"false",
			"true",
			"false",
			"3",
			"1",
			"true",
			"true",
			"true",
			"1",
		])
	})

	// NOTE: The rule the `§` note above `contains` states, as the one pair of
	// answers that tells the two foldings apart. A whole String folds a
	// closing capital sigma to the final form and this walk does not, so `is`
	// finds the part equal where `contains` does not find it inside.
	it("folds each character rather than the whole String", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("ΟΣ"::is("ος", comparing #Insensitive))
				Terminal.inspect("ΟΣ"::contains("ος", comparing #Insensitive))
				Terminal.inspect("ΟΣ"::contains("οσ", comparing #Insensitive))
				Terminal.inspect("ΟΣ"::firstIndex(of "Σ", comparing #Insensitive))
			}`),
		).toEqual(["true", "false", "true", "Optional#Value(1)"])
	})

	// NOTE: A position is a position of the RECEIVER, which is what folding
	// per character buys — the answer indexes the String that was asked, not
	// the folded copy the walk read.
	it("answers a position of the receiver", async () => {
		expect(
			await run(`implementation {
				constant text = "a${family}BAND"

				Terminal.inspect(text::firstIndex(of "b", comparing #Insensitive))
				Terminal.inspect(text::lastIndex(of "n", comparing #Insensitive))
				Terminal.inspect(text::everyIndex(of "B"))
				Terminal.inspect(text::character(at 2, defaultingTo "?"))
				Terminal.inspect("İstanbul"::firstIndex(of "STAN", comparing #Insensitive))
			}`),
		).toEqual([
			"Optional#Value(2)",
			"Optional#Value(4)",
			"[ 2 ]",
			'"B"',
			"Optional#Value(1)",
		])
	})

	it("replaces on the receiver's own text", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("aAa"::replaceEvery("a", with "-", comparing #Insensitive))
				Terminal.inspect("aAa"::replaceEvery("a", with "-", comparing #Sensitive))
				Terminal.inspect("aAa"::replaceFirst("A", with "-", comparing #Insensitive))
				Terminal.inspect("aAa"::replaceFirst("z", with "-", comparing #Insensitive))
				Terminal.inspect("aAa"::replaceEvery("", with "-", comparing #Insensitive))
				Terminal.inspect("x${family}Y"::replaceEvery("y", with "!", comparing #Insensitive))
				Terminal.inspect("x${family}Y"::replaceFirst("${family}", with "!", comparing #Insensitive))
			}`),
		).toEqual([
			'"---"',
			'"-A-"',
			'"-Aa"',
			'"aAa"',
			'"aAa"',
			`"x${family}!"`,
			'"x!Y"',
		])
	})
})

describe("the cuts", () => {
	it("cuts at one separator, and keeps the rest whole", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("key=a=b"::split(onFirst "="))
				Terminal.inspect("key=a=b"::split(onLast "="))
				Terminal.inspect("key"::split(onFirst "="))
				Terminal.inspect("key"::split(onLast "="))
				Terminal.inspect("abc"::split(onFirst ""))
				Terminal.inspect("abc"::split(onLast ""))
				Terminal.inspect("a${family}b"::split(onFirst "${family}"))
			}`),
		).toEqual([
			'Optional#Value({ leading = "key", trailing = "a=b" })',
			'Optional#Value({ leading = "key=a", trailing = "b" })',
			"Optional#Empty",
			"Optional#Empty",
			'Optional#Value({ leading = "", trailing = "abc" })',
			'Optional#Value({ leading = "abc", trailing = "" })',
			'Optional#Value({ leading = "a", trailing = "b" })',
		])
	})

	it("stops at the count it was given", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("a=b=c"::split(on "=", atMost 1))
				Terminal.inspect("a=b=c"::split(on "=", atMost 2))
				Terminal.inspect("a=b=c"::split(on "=", atMost 3))
				Terminal.inspect("a=b=c"::split(on "=", atMost 9))
				Terminal.inspect(""::split(on "=", atMost 2))
				Terminal.inspect("a${family}b${family}c"::split(on "${family}", atMost 2))
			}`),
		).toEqual([
			'[ "a=b=c" ]',
			'[ "a", "b=c" ]',
			'[ "a", "b", "c" ]',
			'[ "a", "b", "c" ]',
			'[ "" ]',
			`[ "a", "b${family}c" ]`,
		])
	})

	it("takes a prefix or a suffix off, and nothing else", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("/api/users"::remove(prefix "/api"))
				Terminal.inspect("/api/users"::remove(prefix "/nope"))
				Terminal.inspect("/api/users"::remove(prefix ""))
				Terminal.inspect("String.es"::remove(suffix ".es"))
				Terminal.inspect("String.es"::remove(suffix ".nope"))
				Terminal.inspect("String.es"::remove(suffix ""))
				Terminal.inspect("aa"::remove(prefix "aa"))
				Terminal.inspect("${family}x"::remove(prefix "${family}"))
				Terminal.inspect("x${family}"::remove(suffix "${family}"))
			}`),
		).toEqual([
			'"/users"',
			'"/api/users"',
			'"/api/users"',
			'"String"',
			'"String.es"',
			'"String.es"',
			'""',
			'"x"',
			'"x"',
		])
	})
})

describe("the rest of the vocabulary", () => {
	it("truncates by character, never past the length asked", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("Hello, World"::truncate(to 8))
				Terminal.inspect("Hello"::truncate(to 8))
				Terminal.inspect("Hello"::truncate(to 5))
				Terminal.inspect("Hello"::truncate(to 1))
				Terminal.inspect("Hello"::truncate(to 0))
				Terminal.inspect("Hello"::truncate(to -3))
				Terminal.inspect("Hello"::truncate(to 4, with "..."))
				Terminal.inspect("${family}${family}${family}"::truncate(to 2))
				Terminal.inspect("${family}${family}${family}"::truncate(to 2)::length())
			}`),
		).toEqual([
			'"Hello, …"',
			'"Hello"',
			'"Hello"',
			'"…"',
			'""',
			'""',
			'"H..."',
			`"${family}…"`,
			"2",
		])
	})

	it("indents every line that carries text", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("text"::indent(by 2))
				Terminal.inspect("text"::indent(by 0))
				Terminal.inspect("a\\nb"::indent(by 1))
				Terminal.inspect("a\\n\\nb"::indent(by 1))
				Terminal.inspect("a\\r\\nb"::indent(by 1))
				Terminal.inspect("text"::indent(by 1, with "\\t"))
				Terminal.inspect(""::indent(by 2))
			}`),
		).toEqual([
			'"    text"',
			'"text"',
			'"  a\\n  b"',
			'"  a\\n\\n  b"',
			'"  a\\n  b"',
			'"\\ttext"',
			'""',
		])
	})

	it("separates from either end, counting characters", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("1234567"::separate(every 3, with ","))
				Terminal.inspect("1234567"::separate(every 3, with ",", from #Start))
				Terminal.inspect("1234567"::separate(every 3, with ",", from #BothEnds))
				Terminal.inspect("123"::separate(every 3, with ","))
				Terminal.inspect("12"::separate(every 3, with ","))
				Terminal.inspect(""::separate(every 3, with ","))
				Terminal.inspect("1234"::separate(every 1, with " "))
				Terminal.inspect("${family}${family}${family}"::separate(every 2, with "-"))
			}`),
		).toEqual([
			'"1,234,567"',
			'"123,456,7"',
			'"1,234,567"',
			'"123"',
			'"12"',
			'""',
			'"1 2 3 4"',
			`"${family}-${family}${family}"`,
		])
	})

	it("quotes as a Program would write it down", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("Lions"::quote())
				Terminal.inspect(""::quote())
				Terminal.inspect("a\\nb"::quote())
				Terminal.inspect("${family}"::quote())
			}`),
		).toEqual([
			'"\\"Lions\\""',
			'"\\"\\""',
			'"\\"a\\\\nb\\""',
			`"\\"${family}\\""`,
		])
	})

	it("capitalizes the first character alone", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect("lions"::capitalize())
				Terminal.inspect("LIONS"::capitalize())
				Terminal.inspect(""::capitalize())
				Terminal.inspect("ß"::capitalize())
				Terminal.inspect("${family}a"::capitalize())
			}`),
		).toEqual(['"Lions"', '"LIONS"', '""', '"SS"', `"${family}a"`])
	})
})

describe("the two parses", () => {
	// NOTE: The claim is that the notation the language writes reads back, so
	// each of these is a Literal the Lexer accepts, spelled as text.
	it("reads the sign and the separators the language writes", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(Integer.parse("+42"))
				Terminal.inspect(Integer.parse("-42"))
				Terminal.inspect(Integer.parse("1_000"))
				Terminal.inspect(Integer.parse("9_007_199_254_740_991"))
				Terminal.inspect(Integer.parse("+1_000", defaultingTo 0))
				Terminal.inspect(Rational.parse("+3/4"))
				Terminal.inspect(Rational.parse("+1_000.5"))
				Terminal.inspect(Rational.parse("-1_0/2"))
				Terminal.inspect(Rational.parse("0.1_0"))
				Terminal.inspect(9_007::is(Integer.parse("9_007", defaultingTo 0)))
				Terminal.inspect(1_000.5::is(Rational.parse("1_000.5", defaultingTo 0/1)))
			}`),
		).toEqual([
			"Optional#Value(42)",
			"Optional#Value(-42)",
			"Optional#Value(1000)",
			"Optional#Value(9007199254740991)",
			"1000",
			"Optional#Value(3/4)",
			"Optional#Value(2001/2)",
			"Optional#Value(-5/1)",
			"Optional#Value(1/10)",
			"true",
			"true",
		])
	})

	// NOTE: The Lexer's rule exactly — an underscore stands between two digits
	// and nowhere else. `1_.5` is the one the decimal arm has to read apart to
	// refuse: joined, the two halves spell `1_5`.
	it("refuses a shape the language does not write", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(Integer.parse("_1"))
				Terminal.inspect(Integer.parse("1_"))
				Terminal.inspect(Integer.parse("1__0"))
				Terminal.inspect(Integer.parse("_"))
				Terminal.inspect(Integer.parse("+"))
				Terminal.inspect(Integer.parse("+-1"))
				Terminal.inspect(Integer.parse("1+1"))
				Terminal.inspect(Integer.parse("٣"))
				Terminal.inspect(Rational.parse("1_.5"))
				Terminal.inspect(Rational.parse("1._5"))
				Terminal.inspect(Rational.parse("1/+2"))
				Terminal.inspect(Rational.parse(".5"))
				Terminal.inspect(Rational.parse("1."))
			}`),
		).toEqual([
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
			"Optional#Empty",
		])
	})
})

// NOTE: What holds for EVERY String rather than for the ones written above.
// The generator's alphabet is ASCII plus an accent, an eszett and two emoji
// (`CHARACTERS` in `Randomness.ts`), so a drawn String exercises the grapheme
// route as well as the ASCII one.
describe("properties", () => {
	it("hold over generated Strings", async () => {
		expect(
			await propertyFailures(`implementation {}

tests {
	suite "String" {
		test "a String is its own code points read back" for any (
			text: String,
		) {
			expect String.of(codePoints text::codePoints())::is(text)
		}

		test "every index is an occurrence, and there are that many" for any (
			text: String,
			part: NonEmptyString,
		) {
			expect text::everyIndex(of part)::length()::is(text::count(of part))
		}

		test "a limited split joins back into the String" for any (
			text: String,
			separator: NonEmptyString,
			pieces: PositiveInteger,
		) {
			expect text
				::split(on separator, atMost pieces)
				::join(with separator)
				::is(text)
		}

		test "a truncated String is no longer than it was asked for" for any (
			text: String,
			length: PositiveInteger,
		) {
			expect text::truncate(to length)::length()::isLessThanOrEqualTo(length)
		}

		test "a Character is one character" for any (character: Character) {
			expect character::length()::is(1)
		}

		test "a prefix and a suffix come back off" for any (
			text: NonEmptyString,
		) {
			expect text::append("-tail")::remove(suffix "-tail")::is(text)
			expect text::prepend("head-")::remove(prefix "head-")::is(text)
		}
	}
}`),
		).toEqual([])
	})
})
