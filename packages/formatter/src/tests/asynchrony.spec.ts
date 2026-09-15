import { describe, expect, it } from "bun:test"

import { format } from "../index"

// NOTE: The two prefix Keywords. Each is written as one word, one space and its
// operand — there is nothing else to decide, because the operand is the whole
// postfix chain and Essence has no grouping parentheses to put around one.
//
// Every test here is a ROUND TRIP over canonically formatted source: the safety
// gate refuses output whose re-parse differs, so a form printed back as
// something else shows up as a refusal rather than as a diff.

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

	// NOTE: A chain the Keyword holds breaks the way any chain does, with each
	// link on a line of its own and the Keyword staying with the head.
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
