import { describe, expect, it } from "bun:test"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	applyMutation,
	type MutationSite,
	enumerateMutations,
} from "../mutation/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"

// NOTE: What the walker finds and what a mutant EMITS, together — the same
// pairing `testingCodegen.spec` keeps, and for the same reason: a list of sites
// proves nothing about the JavaScript a mutant turns into, and a golden of that
// JavaScript says nothing about which site produced it.
//
// NOTE: The mutants are emitted with the Optimiser OFF, which is what `esc
// build --no-optimise` compiles with. It is not a shortcut: the passes that
// lower `left::isGreaterThan(right)` to `<` are exactly the ones that would
// hide the swapped Method name this spec is about, and the site is the same
// site either way — enumeration happens before the first pass runs.

const SOURCE = [
	"implementation {",
	"	choice Outcome {",
	"		Win,",
	"		Draw,",
	"		Loss,",
	"	}",
	"",
	"	function points(_ outcome: Outcome) -> Integer {",
	"		<- match outcome -> Integer {",
	"			case #Win  { <- 3 }",
	"			case #Draw { <- 1 }",
	"			case #Loss { <- 0 }",
	"		}",
	"	}",
	"",
	"	function best() -> Outcome {",
	"		<- #Win",
	"	}",
	"",
	"	function ahead(_ left: Integer, _ right: Integer) -> Boolean {",
	"		if left::isGreaterThan(right) {",
	"			<- true",
	"		} else {",
	"			<- false",
	"		}",
	"	}",
	"",
	"	function total(_ left: Integer, _ right: Integer) -> Integer {",
	"		<- left::add(right)",
	"	}",
	"",
	"	function same(_ left: Integer, _ right: Integer) -> Boolean {",
	"		<- left::is(right)",
	"	}",
	"}",
	"",
].join("\n")

function simplified(source: string = SOURCE) {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)

	return simplify(enriched.program)
}

function sitesOf(source: string = SOURCE): Array<MutationSite> {
	return enumerateMutations(simplified(source), "Fixture.es")
}

function only(
	sites: Array<MutationSite>,
	operator: MutationSite["operator"],
): Array<string> {
	return sites
		.filter((site) => site.operator === operator)
		.map((site) => `${site.position.start.line} ${site.description}`)
}

// NOTE: Every pass off, which is what `--no-optimise` means — see the note at
// the top of the file.
function emitted(site: number, source: string = SOURCE): string {
	return rewrite(
		optimise(applyMutation(simplified(source), site), {
			enabled: false,
			disabledPasses: new Set(),
			coverage: false,
		}),
	)
}

function siteFor(description: string, source: string = SOURCE): MutationSite {
	let site = sitesOf(source).find((each) => each.description === description)

	expect(site).toBeDefined()

	return site as MutationSite
}

describe("Mutation sites", () => {
	it("finds every comparison rotation, one step at a time", () => {
		expect(only(sitesOf(), "comparison")).toEqual([
			"21 swap ::isGreaterThan for ::isGreaterThanOrEqualTo",
			"21 swap ::isGreaterThan for ::isLessThan",
		])
	})

	// NOTE: A bound moved by one, or an order REVERSED, for every member of
	// the table — the two `…OrEqualTo` names included. A bound written the
	// wrong way round is the commonest comparison bug there is, and leaving
	// those two with only their bound-moving step made them the two names a
	// suite could get backwards without the score moving.
	it("reverses the order of an OrEqualTo comparison too", () => {
		let source = [
			"implementation {",
			"	function within(_ n: Integer, _ limit: Integer) -> Boolean {",
			"		<- n::isLessThanOrEqualTo(limit)",
			"	}",
			"",
			"	function beyond(_ n: Integer, _ limit: Integer) -> Boolean {",
			"		<- n::isGreaterThanOrEqualTo(limit)",
			"	}",
			"}",
			"",
		].join("\n")

		expect(only(sitesOf(source), "comparison")).toEqual([
			"3 swap ::isLessThanOrEqualTo for ::isLessThan",
			"3 swap ::isLessThanOrEqualTo for ::isGreaterThanOrEqualTo",
			"7 swap ::isGreaterThanOrEqualTo for ::isGreaterThan",
			"7 swap ::isGreaterThanOrEqualTo for ::isLessThanOrEqualTo",
		])
	})

	it("finds the equality rotation", () => {
		expect(only(sitesOf(), "equality")).toEqual([
			"33 swap ::is for ::isNot",
		])
	})

	it("finds the arithmetic rotation", () => {
		expect(only(sitesOf(), "arithmetic")).toEqual([
			"29 swap ::add for ::subtract",
		])
	})

	it("flips a Boolean literal both ways", () => {
		expect(only(sitesOf(), "boolean")).toEqual([
			"22 swap true for false",
			"24 swap false for true",
		])
	})

	it("inverts an if by swapping its branches", () => {
		expect(only(sitesOf(), "branch")).toEqual([
			"21 swap the branches of this if",
		])
	})

	it("nudges an Integer literal up, down and to zero", () => {
		expect(only(sitesOf(), "integer")).toEqual([
			"10 swap 3 for 4",
			"10 swap 3 for 2",
			"10 swap 3 for 0",
			"11 swap 1 for 2",
			"11 swap 1 for 0",
			"12 swap 0 for 1",
			"12 swap 0 for -1",
		])
	})

	it("swaps a construction for the next sibling Case", () => {
		expect(only(sitesOf(), "case")).toEqual(["17 swap #Win for #Draw"])
	})

	// NOTE: The whole reason a site can be named by a number. Two enumerations
	// of one Program are the same list, so an id held between them means the
	// same Node — which is what the driver rests on when it compiles a mutant
	// in a worker that enumerated the Program for itself.
	it("enumerates the same sites twice", () => {
		expect(JSON.stringify(sitesOf())).toEqual(JSON.stringify(sitesOf()))
	})

	it("names the Module it was told about", () => {
		expect(new Set(sitesOf().map((site) => site.module))).toEqual(
			new Set(["Fixture.es"]),
		)
	})

	// NOTE: Ids are the walk's own count, assigned BEFORE the per-line cap
	// filters anything, so a crowded line leaves a gap rather than renumbering
	// what follows it.
	it("counts ids in walk order", () => {
		let sites = sitesOf()

		expect(sites.map((site) => site.id)).toEqual(
			[...sites]
				.sort((left, right) => left.id - right.id)
				.map((site) => site.id),
		)
	})

	it("caps the sites on one line", () => {
		let crowded = [
			"implementation {",
			"	function dense(_ n: Integer) -> Integer {",
			"		<- n::add(1)::add(2)::add(3)::add(4)",
			"	}",
			"}",
			"",
		].join("\n")
		let onLine = sitesOf(crowded).filter(
			(site) => site.position.start.line === 3,
		)

		expect(onLine.length).toBe(4)
	})

	// NOTE: The condition of a NARROWING `if` is what typed the body it opens.
	// A mutant that asks a different question there runs a body against a
	// refinement nobody proved — it fails everything it touches, which
	// distinguishes no suite from another. It is the same refusal the branch
	// swap has always had, reaching the condition it is written out of.
	it("offers nothing inside the condition of a narrowing if", () => {
		let source = [
			"implementation {",
			"	function share(_ total: Integer, _ parts: Integer) -> Rational {",
			"		if parts::isNot(0) {",
			"			<- total::divide(by parts)",
			"		} else {",
			"			<- 0",
			"		}",
			"	}",
			"",
			"	function above(_ n: Integer) -> Integer {",
			"		if n::isGreaterThan(0) {",
			"			<- n",
			"		} else {",
			"			<- 0",
			"		}",
			"	}",
			"}",
			"",
		].join("\n")
		let sites = sitesOf(source)

		expect(only(sites, "equality")).toEqual([])
		expect(only(sites, "comparison")).toEqual([])
		expect(only(sites, "branch")).toEqual([])
		// NOTE: And the literals of those conditions are still sites, which is
		// what says the refusal is about the QUESTION being asked rather than
		// about the line it is asked on.
		expect(only(sites, "integer")).toEqual([
			"3 swap 0 for 1",
			"3 swap 0 for -1",
			"6 swap 0 for 1",
			"6 swap 0 for -1",
			"11 swap 0 for 1",
			"11 swap 0 for -1",
			"14 swap 0 for 1",
			"14 swap 0 for -1",
		])
	})

	// NOTE: The Arguments a call site wrote are handed on UNTOUCHED, so a swap
	// onto a Method that takes a different number of them crashes wherever it
	// runs — which a mutation run would record as a kill the tests never
	// earned, the one answer this walker must never give. The builtin branch
	// has always checked it; the Module's own Namespaces did not.
	it("refuses a swap onto a same-slot Method of another arity", () => {
		let source = [
			"implementation {",
			"	type Money = { cents: Integer }",
			"",
			"	namespace Money for Money {",
			"		overload add {",
			"			(_ other: Money) -> Money {",
			"				<- { cents = 1 }",
			"			}",
			"",
			"			(_ other: Money, _ also: Money) -> Money {",
			"				<- { cents = 2 }",
			"			}",
			"		}",
			"",
			"		overload subtract {",
			"			(_ other: Money, _ also: Money) -> Money {",
			"				<- { cents = 3 }",
			"			}",
			"",
			"			(_ other: Money) -> Money {",
			"				<- { cents = 4 }",
			"			}",
			"		}",
			"	}",
			"",
			"	function total(_ left: Money, _ right: Money) -> Money {",
			"		<- left::add(right)",
			"	}",
			"}",
			"",
		].join("\n")

		expect(only(sitesOf(source), "arithmetic")).toEqual([])
	})

	// NOTE: A Method a PROTOCOL provided is answered by the Protocol, so the
	// swap is sound exactly where that Protocol wrote a body for the target.
	// `Orderable` writes all four comparisons, so a user Type conforming to it
	// offers the rotations a builtin does.
	it("rotates a comparison a Protocol provided", () => {
		let source = [
			"implementation {",
			"	type Rank = { value: Integer }",
			"",
			"	namespace Rank for Rank is Orderable {",
			"		compare(to other: Rank) -> Ordering {",
			"			<- @.value::compare(to other.value)",
			"		}",
			"	}",
			"",
			"	function below(_ left: Rank, _ right: Rank) -> Boolean {",
			"		<- left::isLessThan(right)",
			"	}",
			"",
			"	function atMost(_ left: Rank, _ right: Rank) -> Boolean {",
			"		<- left::isLessThanOrEqualTo(right)",
			"	}",
			"}",
			"",
		].join("\n")

		expect(only(sitesOf(source), "comparison")).toEqual([
			"11 swap ::isLessThan for ::isLessThanOrEqualTo",
			"11 swap ::isLessThan for ::isGreaterThan",
			"15 swap ::isLessThanOrEqualTo for ::isLessThan",
			"15 swap ::isLessThanOrEqualTo for ::isGreaterThanOrEqualTo",
		])
	})

	// NOTE: And the other half of the same rule. `Equatable` REQUIRES `is` and
	// provides `isNot`, so the body a swap onto `is` would name is written by
	// each conformer under its own Namespace and by the Protocol nowhere at
	// all. Offering it emitted a call to a Function that does not exist, which
	// this run would have recorded as a kill.
	it("refuses a swap onto a member the Protocol only requires", () => {
		let source = [
			"implementation {",
			"	type Tag = { name: String }",
			"",
			"	namespace Tag for Tag is Equatable {",
			"		is(_ other: Tag) -> Boolean {",
			"			<- @.name::is(other.name)",
			"		}",
			"	}",
			"",
			"	function differ(_ left: Tag, _ right: Tag) -> Boolean {",
			"		<- left::isNot(right)",
			"	}",
			"}",
			"",
		].join("\n")

		expect(
			only(sitesOf(source), "equality").filter((site) =>
				site.startsWith("11 "),
			),
		).toEqual([])
	})
})

describe("Applying a mutation", () => {
	it("refuses a site it can not find", () => {
		expect(() => applyMutation(simplified(), 9999)).toThrow(
			"No mutation site 9999 in this Module",
		)
	})

	it("leaves the Program it was handed alone", () => {
		let program = simplified()
		let before = JSON.stringify(program)

		applyMutation(program, siteFor("swap ::add for ::subtract").id)

		expect(JSON.stringify(program)).toEqual(before)
	})

	it("emits the rotated comparison", () => {
		let javaScript = emitted(
			siteFor("swap ::isGreaterThan for ::isGreaterThanOrEqualTo").id,
		)

		expect(javaScript).toContain("isGreaterThanOrEqualTo__overload$1")
		expect(javaScript).not.toContain(
			"Integer.isGreaterThan__overload$1(left, right)",
		)
	})

	it("emits the rotated equality", () => {
		let javaScript = emitted(siteFor("swap ::is for ::isNot").id)
		let body = javaScript.split("function same(left, right)")[1] as string

		expect(body).toContain("isNot__overload$1(left, right)")
		expect(body).not.toContain("_is__overload$1(left, right)")
	})

	it("emits the rotated arithmetic", () => {
		let javaScript = emitted(siteFor("swap ::add for ::subtract").id)

		expect(javaScript).toContain("subtract__overload$1(left, right)")
		expect(javaScript).not.toContain("add__overload$1(left, right)")
	})

	it("emits the flipped Boolean", () => {
		let javaScript = emitted(siteFor("swap true for false").id)

		expect(javaScript).toContain("function ahead(left, right)")
		expect(
			javaScript.split("function ahead(left, right)")[1],
		).not.toContain("$Boolean.true")
	})

	it("emits the nudged Integer", () => {
		let javaScript = emitted(siteFor("swap 3 for 4").id)
		let body = javaScript.split("function points(outcome)")[1] as string

		expect(body).toContain("createInteger(4)")
		expect(body).not.toContain("createInteger(3)")
	})

	it("emits the swapped Case", () => {
		let javaScript = emitted(siteFor("swap #Win for #Draw").id)

		expect(javaScript).toContain("function best()")
		expect(javaScript.split("function best()")[1]).toContain("Outcome#Draw")
	})

	it("emits the swapped branches", () => {
		let javaScript = emitted(siteFor("swap the branches of this if").id)
		let body = javaScript.split("function ahead(left, right)")[1] as string
		let trueFirst = body.indexOf("true")
		let falseFirst = body.indexOf("false")

		expect(falseFirst).toBeGreaterThan(-1)
		expect(falseFirst).toBeLessThan(trueFirst)
	})
})
