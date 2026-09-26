import { describe, expect, it } from "bun:test"

import { probeSourcesFor } from "../probe"

// NOTE: Every reading a probe hands out is a parse and an enrichment of the
// whole document, and they are tried in turn until one answers — so a reading
// that can not be the one is paid for exactly at the cursors nothing explains,
// which are the cursors a reader produces while typing a name out.

describe("the define arm readings", () => {
	let armHead = [
		"implementation {",
		"\tfunction grade (_ score: Integer) -> String {",
		"\t\t<- define {",
		'\t\t\tas "A" if score',
	].join("\n")

	let plainHead = [
		"implementation {",
		"\tfunction grade (_ score: Integer) -> String {",
		"\t\t<- score",
	].join("\n")

	it("closes an arm both ways where a define stands above the cursor", () => {
		let sources = probeSourcesFor(armHead, "::lspProbeMember()")

		// NOTE: A cursor in a Condition is a whole arm short of a block that
		// closes; a cursor in a value is one word short of one.
		expect(
			sources.some((source) => source.endsWith(" as {} otherwise}}}")),
		).toBe(true)
		expect(sources.some((source) => source.endsWith(" otherwise}}}"))).toBe(
			true,
		)
	})

	// NOTE: The gate is the Keyword standing anywhere above the cursor, which
	// is cheap and can never turn away a head that needs the readings — a
	// cursor inside an arm has `define` above it by construction.
	it("builds no arm reading where no define stands above the cursor", () => {
		let sources = probeSourcesFor(plainHead, "::lspProbeMember()")

		expect(sources.some((source) => source.includes("otherwise"))).toBe(
			false,
		)
		expect(sources).toHaveLength(3)
	})

	// NOTE: The arm tails are aimed at the `define`'s OWN block. A brace an arm
	// opened stands inside it, and an arm written in THAT closes nothing.
	it("closes the define's block and not a brace its arm opened", () => {
		let inArmBrace = [
			"implementation {",
			"\tfunction show (_ team: Team) -> { label: String } {",
			"\t\t<- define {",
			"\t\t\tas { label = team",
		].join("\n")

		let sources = probeSourcesFor(inArmBrace, "::lspProbeMember()")

		expect(
			sources.some((source) => source.endsWith("} otherwise}}}")),
		).toBe(true)
		expect(
			sources.some((source) => source.endsWith(" otherwise}}}}")),
		).toBe(false)
	})

	// NOTE: The `define`'s block is the `{` after its return Type, however many
	// brackets that Type writes of its own.
	for (let returnType of [
		"{ a: Integer }",
		"(_: Integer) -> Integer",
		"(_: { a: Integer }) -> Integer",
		"List<{ a: Integer }>",
		"Integer | { a: Integer }",
		"Dictionary<String, { a: Integer }>",
	]) {
		it(`closes the define's block past a return Type of ${returnType}`, () => {
			let head = [
				"implementation {",
				`\tconstant x = define -> ${returnType} {`,
				"\t\tas { a = y",
			].join("\n")

			let sources = probeSourcesFor(head, "::lspProbeMember()")

			expect(sources).toContain(`${head}::lspProbeMember()} otherwise}}`)
			expect(sources).toContain(
				`${head}::lspProbeMember()} as {} otherwise}}`,
			)
		})
	}

	it("closes an enclosing define's block past its return Type", () => {
		let head = [
			"implementation {",
			"\tconstant x = define -> { a: Integer } {",
			"\t\tas define {",
			"\t\t\tas { a = y",
		].join("\n")

		let sources = probeSourcesFor(head, "::lspProbeMember()")

		expect(sources).toContain(
			`${head}::lspProbeMember()} otherwise} otherwise}}`,
		)
	})

	// NOTE: `stripNoise` blanks Strings and Comments before the Keyword is
	// looked for, so a `define` that is only ever mentioned costs nothing.
	it("reads no define out of a String or a Comment", () => {
		let mentioned = [
			"implementation {",
			'\tconstant note = "define"',
			"\t§ define",
			"\tconstant found = note",
		].join("\n")

		expect(probeSourcesFor(mentioned, "::lspProbeMember()")).toHaveLength(3)
	})
})

describe("the closing brackets", () => {
	let plainReadingOf = (lines: Array<string>) =>
		probeSourcesFor(["implementation {", ...lines].join("\n"))[0]

	it("closes a bracket opened after a String holding an escaped quote", () => {
		let reading = plainReadingOf([
			'\tconstant quote = "\\""',
			"\tconstant marks = [quote",
		])

		expect(reading).toEndWith("[quote]}")
	})

	it("counts no bracket inside a String an interpolation hole holds", () => {
		let reading = plainReadingOf([
			'\tconstant names = ["Ada", "Bob"]',
			'\tconstant listed = "({names::join(with "), (")})"',
			"\tconstant all = [listed",
		])

		expect(reading).toEndWith("[listed]}")
	})

	it("closes an open interpolation hole and then its String", () => {
		let reading = plainReadingOf([
			'\tconstant person = { name = "Ada" }',
			'\tconstant greeting = "Hi {person',
		])

		expect(reading).toEndWith('"Hi {person}"}')
	})

	// NOTE: The Unicode escape is left unclosed on purpose. The Lexer still ends
	// its String at the quote, and a `}` would close a hole opened at its brace.
	it("opens no hole at an escaped brace or a Unicode escape", () => {
		let reading = plainReadingOf([
			'\tconstant brace = "\\{"',
			'\tconstant smile = "\\u{1F600"',
			"\tconstant list = [brace, smile",
		])

		expect(reading).toEndWith("[brace, smile]}")
	})

	// NOTE: The Lexer reports a Comment in a hole and ends it at the first `}`,
	// so the hole and its String still close.
	it("ends a Comment written in a hole at the hole's brace", () => {
		let reading = plainReadingOf([
			'\tconstant noted = "{1 § one} ["',
			"\tconstant list = [noted",
		])

		expect(reading).toEndWith("[noted]}")
	})
})
