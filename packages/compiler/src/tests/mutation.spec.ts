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

// What the walker finds and what a mutant emits, side by side, as in
// `testingCodegen.spec.ts`. A list of sites says nothing about the emitted
// JavaScript, and a golden of that JavaScript says nothing about its site.
//
// Mutants are emitted with every pass off, as `--no-optimise` builds, since
// lowering `left::isGreaterThan(right)` to `<` would hide the swapped Method
// name. Sites are enumerated before any pass runs, so they are the same
// either way.

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

// A ladder that narrows nothing, so its arms are free to move. It is a file
// of its own because the expectations on `SOURCE` name lines.
const DEFINE_SOURCE = [
	"implementation {",
	"	function grade(_ score: Integer) -> String {",
	"		<- define {",
	'			as "A" if score::isGreaterThanOrEqualTo(90)',
	'			as "B" if score::isGreaterThanOrEqualTo(80)',
	'			as "F" otherwise',
	"		}",
	"	}",
	"}",
	"",
].join("\n")

// A `modulePath` makes this a Module compile, as on the command line, so its
// Choices are identified by path and name together.
function simplified(source: string = SOURCE, modulePath?: string) {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program, { modulePath })

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

// Every pass off, as `--no-optimise` builds.
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

	// Every comparison, the `…OrEqualTo` names included, gets a bound moved
	// by one and an order reversed. A reversed bound is the commonest
	// comparison bug.
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

	// Nothing constructs `#Draw`, so only the declaration can offer it.
	it("swaps for the declared next sibling in a Module compile", () => {
		let sites = enumerateMutations(
			simplified(SOURCE, "/modules/Fixture.es"),
			"Fixture.es",
		)

		expect(only(sites, "case")).toEqual(["17 swap #Win for #Draw"])
	})

	it("swaps for the declared next sibling when a construction comes first", () => {
		let source = [
			"implementation {",
			"	function best() -> Outcome {",
			"		<- #Draw",
			"	}",
			"",
			"	choice Outcome {",
			"		Win,",
			"		Draw,",
			"		Loss,",
			"	}",
			"}",
			"",
		].join("\n")

		expect(only(sitesOf(source), "case")).toEqual([
			"3 swap #Draw for #Loss",
		])
		expect(
			only(
				enumerateMutations(
					simplified(source, "/modules/Fixture.es"),
					"Fixture.es",
				),
				"case",
			),
		).toEqual(["3 swap #Draw for #Loss"])
	})

	// A worker enumerates the Program for itself and compiles a mutant by
	// id, so two enumerations must give the same list.
	it("enumerates the same sites twice", () => {
		expect(JSON.stringify(sitesOf())).toEqual(JSON.stringify(sitesOf()))
	})

	it("names the Module it was told about", () => {
		expect(new Set(sitesOf().map((site) => site.module))).toEqual(
			new Set(["Fixture.es"]),
		)
	})

	// Ids are counted before the per-line cap filters anything, so a crowded
	// line leaves a gap rather than renumbering what follows.
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

	// A narrowing condition types the body it opens. A mutant asking another
	// question there runs the body against an unproven refinement and fails
	// every suite alike.
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
		// The conditions' literals are still sites: the refusal is about the
		// question, not the line.
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

	// A condition can narrow only its `else`. Where `separator::isEmpty()`
	// fails it proves `NonEmptyString`, which lets the `else` call `split`, and
	// a swap would move that call out from under the proof.
	it("offers nothing at an if whose condition narrows its else", () => {
		let source = [
			"implementation {",
			"	function pieces(_ text: String, on separator: String) -> NonEmptyList<String> {",
			"		if separator::isEmpty() {",
			"			<- [text]",
			"		} else {",
			"			<- text::split(on separator)",
			"		}",
			"	}",
			"",
			"	function share(_ total: Integer, by divisor: Integer) -> Rational {",
			"		if divisor::isLessThanOrEqualTo(0) {",
			"			<- 0/1",
			"		} else {",
			"			<- total::divide(by divisor)",
			"		}",
			"	}",
			"}",
			"",
		].join("\n")
		let sites = sitesOf(source)

		expect(only(sites, "branch")).toEqual([])
		// `divisor::isLessThanOrEqualTo(0)` proves the `PositiveInteger` the
		// `else` divides by, so neither rotation is offered.
		expect(only(sites, "comparison")).toEqual([])
		// The condition's literals are still sites.
		expect(only(sites, "integer")).toEqual([
			"11 swap 0 for 1",
			"11 swap 0 for -1",
		])
	})

	// With no `else`, no body stands under the complement, so the swap moves
	// a body read under no evidence into a branch that holds some.
	it("still inverts an if with no else whose condition narrows below", () => {
		let source = [
			"implementation {",
			"	function width(_ text: String, on separator: String) -> Integer {",
			"		if separator::isEmpty() {",
			"			<- 0",
			"		}",
			"",
			"		<- text::length()",
			"	}",
			"}",
			"",
		].join("\n")

		expect(only(sitesOf(source), "branch")).toEqual([
			"3 swap the branches of this if",
		])
	})

	// An arm and the `otherwise` are an `if` and its `else`, so each arm gets
	// a branch swap with the fallback.
	it("offers one swap for every arm of a define", () => {
		// Both stand at the `define` line, since each arm's own line already
		// spends its capped sites on its Condition.
		expect(only(sitesOf(DEFINE_SOURCE), "branch")).toEqual([
			"3 swap arm 1's answer for the 'otherwise' one",
			"3 swap arm 2's answer for the 'otherwise' one",
		])
	})

	// This ladder establishes nothing, so its Conditions are mutated like any
	// other call.
	it("still rotates the comparisons a define asks", () => {
		// One rotation per arm, since the bound's nudges spend most of the
		// line's capped sites.
		expect(only(sitesOf(DEFINE_SOURCE), "comparison")).toEqual([
			"4 swap ::isGreaterThanOrEqualTo for ::isGreaterThan",
			"5 swap ::isGreaterThanOrEqualTo for ::isGreaterThan",
		])
	})

	// An arm's value is read behind its own Condition and the complements of
	// the earlier ones. So `separator::isEmpty()` narrows only the next arm,
	// and `n::isGreaterThan(0)` only its own.
	it("offers nothing at a define whose arms narrow anything", () => {
		let source = [
			"implementation {",
			"	function pieces(_ text: String, on separator: String) -> List<String> {",
			"		<- define {",
			"			as [text] if separator::isEmpty()",
			"			as text::split(on separator) otherwise",
			"		}",
			"	}",
			"",
			"	function shrunk(_ n: Integer) -> Integer {",
			"		<- define {",
			"			as n::subtract(1) if n::isGreaterThan(0)",
			"			as 0 otherwise",
			"		}",
			"	}",
			"}",
			"",
		].join("\n")
		let sites = sitesOf(source)

		expect(only(sites, "branch")).toEqual([])
		expect(only(sites, "comparison")).toEqual([])
		expect(only(sites, "arithmetic")).toEqual([])
		// The literals are still sites, in walk order: an arm's Condition is
		// read before its answer.
		expect(only(sites, "integer")).toEqual([
			"11 swap 0 for 1",
			"11 swap 0 for -1",
			"11 swap 1 for 2",
			"11 swap 1 for 0",
			"12 swap 0 for 1",
			"12 swap 0 for -1",
		])
	})

	// A swap keeps the call's Arguments, so a target of another arity would
	// crash, and a run would record a kill the tests never earned.
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

	// A swap onto a provided Method is sound where the Protocol wrote a body
	// for the target. `Comparable` writes every comparison.
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

	// `Equatable` requires `is` and writes no body for it, so a swap onto `is`
	// would call a Function that does not exist.
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

	// Two answers exchanged, with the Conditions unmoved, so the mutant lies
	// only about which arm answers.
	it("emits the swapped define answer", () => {
		let javaScript = emitted(
			siteFor(
				"swap arm 1's answer for the 'otherwise' one",
				DEFINE_SOURCE,
			).id,
			DEFINE_SOURCE,
		)
		let body = javaScript.split("function grade(score)")[1] as string

		expect(body).toContain('createString("F")')
		expect(body.indexOf('createString("F")')).toBeLessThan(
			body.indexOf('createString("B")'),
		)
		expect(body.lastIndexOf('createString("A")')).toBeGreaterThan(
			body.indexOf('createString("B")'),
		)
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
