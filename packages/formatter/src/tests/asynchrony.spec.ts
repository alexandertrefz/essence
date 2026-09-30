import { describe, expect, it } from "bun:test"

import { format } from "../index"

// The prefix keywords `start` and `complete`, each written as one word, one
// space and its operand, which is the whole postfix chain.
//
// Every test here is a round trip over formatted source. The safety gate
// refuses output whose re-parse differs, so a form printed back as something
// else shows as a refusal rather than a diff.

function block(...lines: Array<string>): string {
	return ["implementation {", ...lines, "}", ""].join("\n")
}

function roundTrips(source: string): void {
	let once = format(source)
	let twice = format(once.text)

	expect(once.refusal).toBeNull()
	expect(once.text).toBe(source)
	expect(twice.text).toBe(once.text)
}

describe("start and complete", () => {
	it("writes one word, one space and the operand", () => {
		roundTrips(
			block(
				"\tconstant running = start work",
				"\tconstant answer  = complete running",
			),
		)
	})

	it("keeps the whole chain under the Keyword", () => {
		roundTrips(
			block(
				"\tconstant answer = complete headline(url)::retried(times 3)",
			),
		)
	})

	it("keeps one Keyword written through the other", () => {
		roundTrips(block("\tconstant answer = complete start headline(url)"))
	})

	it("writes either in a Statement of its own", () => {
		roundTrips(
			block("\tstart headline(url)", "", "\tcomplete headline(url)"),
		)
	})

	it("writes either as an Argument", () => {
		roundTrips(
			block(
				"\tTerminal.print(complete headline(url))",
				"\tTerminal.print(start headline(url))",
			),
		)
	})

	// Both are ordinary names where no Expression follows them on their line.
	it("writes either word where it is a name", () => {
		roundTrips(
			block(
				"\tconstant start = { complete = 1 }",
				"",
				"\tTerminal.print(start.complete::toString())",
			),
		)
	})

	// A word that ends its line is a name, and the next line is a Statement of
	// its own. The Parser reads the operand only from the keyword's line.
	it("leaves a word that ends its line where it was written", () => {
		roundTrips(
			block(
				"\tconstant start = 1",
				"\tconstant held  = start",
				"",
				"\tTerminal.print(held::toString())",
			),
		)
	})

	// A chain the keyword holds breaks as any chain does, each link on its own
	// line and the keyword staying with the head.
	it("breaks a chain that does not fit under the Keyword", () => {
		roundTrips(
			block(
				"\tconstant answer = complete headline(theAddressOfTheArticle)",
				"\t\t::retried(times 3, pausing 250)",
				"\t\t::within(milliseconds 5000)",
			),
		)
	})

	it("keeps a Comment written beside one", () => {
		roundTrips(
			block("\tconstant answer = complete headline(url) § waits here"),
		)
	})

	it("normalises the spacing around either Keyword", () => {
		let formatted = format(
			block("\tconstant answer =    complete   running"),
		)

		expect(formatted.refusal).toBeNull()
		expect(formatted.text).toBe(
			block("\tconstant answer = complete running"),
		)
	})
})
