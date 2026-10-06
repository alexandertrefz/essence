import { describe, expect, it } from "bun:test"

import { barredCompletion } from "../helpers/describe"
import { analysedDiagnosticsFor, compiles } from "./followedHelps"

// Every report that could offer `complete` gives one answer per position, the
// one `bodyCanWait` gives. See "Completing bodies" in
// packages/compiler/src/validator/DEVELOPMENT.md.
//
// The positions are every shape a body comes in, and the sites are every report
// that holds a Future where a value was wanted. A cell is what the report says
// about the word. Where it offers the word, the Program with it written in must
// compile.

type Verdict =
	// The word, written here, is the edit.
	| "offered"
	// Two steps: declare the enclosing Function a waiting one, then write it.
	| "two-step"
	// The position is a barrier, and what it is offered is the barrier's own edit.
	| "property-body"
	| "parameter-default"

let barrierHelp = (barrier: "property-body" | "parameter-default") =>
	barredCompletion(barrier).helps[0] as string

function verdictOf(helps: Array<string>): Verdict | "nothing" {
	if (helps.includes(barrierHelp("property-body"))) {
		return "property-body"
	}

	if (helps.includes(barrierHelp("parameter-default"))) {
		return "parameter-default"
	}

	// Case-folded, because the clause starts "Or declare" where it comes second
	// and "Declare" where it stands alone.
	if (
		helps.some((help) =>
			help.toLowerCase().includes("declare the enclosing function"),
		)
	) {
		return "two-step"
	}

	if (
		helps.some(
			(help) =>
				help.includes("add 'complete'") ||
				help.includes("constant answered = complete"),
		)
	) {
		return "offered"
	}

	return "nothing"
}

// Every probe declares the names the sites call, so two cells differ only
// in the position.
let preamble = [
	"	function fetched() -> Future<Integer> {",
	"		complete Async.sleep(milliseconds 1)",
	"",
	"		<- 41",
	"	}",
	"",
	"	function takes(_ number: Integer) -> Integer {",
	"		<- number",
	"	}",
	"",
	"	variable held = 0",
	"",
	"	function shown<infer Item is Printable>(_ item: Item) -> Integer {",
	"		<- 0",
	"	}",
].join("\n")

type Site = {
	// The code the report carries, so a cell that reports nothing fails.
	code: string
	// One statement holding a Future where a value goes, and the same statement
	// with the word written in.
	written: string
	followed: string
	// The same as an Expression, for the Parameter default position. Null
	// where the report has no such shape: an assignment can not be a default.
	asDefault: string | null
}

let sites: Array<Site> = [
	{
		code: "unknown-method",
		written: "Terminal.print(fetched()::is(1))",
		followed: [
			"constant answered = complete fetched()",
			"",
			"		Terminal.print(answered::is(1))",
		].join("\n"),
		asDefault: "fetched()::is(1)",
	},
	{
		code: "no-matching-overload",
		written: "Terminal.print(1::add(fetched()))",
		followed: "Terminal.print(1::add(complete fetched()))",
		asDefault: "1::add(fetched())",
	},
	{
		code: "argument-type-mismatch",
		written: "Terminal.print(takes(fetched()))",
		followed: "Terminal.print(takes(complete fetched()))",
		asDefault: "takes(fetched())",
	},
	{
		code: "assignment-type-mismatch",
		written: "held = fetched()",
		followed: "held = complete fetched()",
		asDefault: null,
	},
	{
		code: "interpolation-not-printable",
		written: 'Terminal.print("{fetched()}")',
		followed: 'Terminal.print("{complete fetched()}")',
		asDefault: '"{fetched()}"::length()',
	},
	{
		code: "unsatisfied-bound",
		written: "Terminal.print(shown(fetched()))",
		followed: "Terminal.print(shown(complete fetched()))",
		asDefault: "shown(fetched())",
	},
]

type Position = {
	name: string
	wrap: (statement: string) => string
	// The same position once the word is written, where that changes the body
	// around it. A body that waits answers with the value, not a Future it built.
	wrapFollowed?: (statement: string) => string
	verdict: Verdict
}

let positions: Array<Position> = [
	{
		name: "the top level",
		wrap: (statement) =>
			`implementation {\n${preamble}\n\n\t${statement}\n}`,
		verdict: "offered",
	},
	{
		name: "a plain Function",
		wrap: (statement) =>
			`implementation {\n${preamble}\n\n\tfunction plain() -> Integer {\n\t\t${statement}\n\n\t\t<- 0\n\t}\n\n\tTerminal.print(plain())\n}`,
		verdict: "two-step",
	},
	{
		name: "a waiting Function that has completed something",
		wrap: (statement) =>
			`implementation {\n${preamble}\n\n\tfunction waits() -> Future<Integer> {\n\t\tcomplete Async.sleep(milliseconds 1)\n\n\t\t${statement}\n\n\t\t<- 0\n\t}\n}`,
		verdict: "offered",
	},
	// A body that declares `-> Future<…>` but has not written `complete` yet is
	// offered the word, not the declaration it already has.
	{
		name: "a waiting Function that has not completed anything yet",
		wrap: (statement) =>
			`implementation {\n${preamble}\n\n\tfunction waits() -> Future<Integer> {\n\t\t${statement}\n\n\t\t<- Async.deferred(() { <- 0 })\n\t}\n}`,
		wrapFollowed: (statement) =>
			`implementation {\n${preamble}\n\n\tfunction waits() -> Future<Integer> {\n\t\t${statement}\n\n\t\t<- 0\n\t}\n}`,
		verdict: "offered",
	},
	{
		name: "a Function literal passed to 'map'",
		wrap: (statement) =>
			`implementation {\n${preamble}\n\n\tconstant all = [1]::map((number) -> Integer {\n\t\t${statement}\n\n\t\t<- number\n\t})\n}`,
		verdict: "two-step",
	},
	{
		name: "a 'test' body",
		wrap: (statement) =>
			`implementation {\n${preamble}\n}\n\ntests {\n\ttest "it" {\n\t\t${statement}\n\n\t\texpect true\n\t}\n}`,
		verdict: "offered",
	},
	{
		name: "a property body",
		wrap: (statement) =>
			`implementation {\n${preamble}\n}\n\ntests {\n\ttest "it" for any (number: Integer) {\n\t\t${statement}\n\n\t\texpect true\n\t}\n}`,
		verdict: "property-body",
	},
	{
		name: "a Parameter's default",
		wrap: (expression) =>
			`implementation {\n${preamble}\n\n\tfunction defaulted(_ number: Integer = ${expression}) -> Integer {\n\t\t<- number\n\t}\n}`,
		verdict: "parameter-default",
	},
]

let isDefaultPosition = (position: Position) =>
	position.verdict === "parameter-default"

function helpsAt(
	position: Position,
	statement: string,
): {
	codes: Array<string>
	helps: Array<string>
} {
	let diagnostics = analysedDiagnosticsFor(position.wrap(statement), {
		tests: true,
	})

	return {
		codes: diagnostics.map((diagnostic) => diagnostic.code),
		helps: diagnostics.flatMap((diagnostic) => diagnostic.helps ?? []),
	}
}

describe("Every report that could offer 'complete'", () => {
	for (let site of sites) {
		describe(site.code, () => {
			for (let position of positions.filter(
				(candidate) =>
					!isDefaultPosition(candidate) || site.asDefault !== null,
			)) {
				it(`says the same thing in ${position.name}`, () => {
					let statement = isDefaultPosition(position)
						? (site.asDefault as string)
						: site.written
					let { codes, helps } = helpsAt(position, statement)

					// A default is measured against the Parameter's Type first, so
					// the default position may report another code. It pins the
					// barrier's sentence alone.
					if (!isDefaultPosition(position)) {
						expect(codes).toContain(site.code)
					}

					expect(verdictOf(helps)).toBe(position.verdict)
				})
			}

			// Where the word is offered, the Program with it written in compiles.
			for (let position of positions.filter(
				(candidate) => candidate.verdict === "offered",
			)) {
				it(`compiles once the word is written in ${position.name}`, () => {
					expect(
						compiles(
							(position.wrapFollowed ?? position.wrap)(
								site.followed,
							),
							{ tests: true },
						),
					).toBe(true)
				})
			}
		})
	}
})

// The other side of the same word: a `complete` written where nothing can wait.
// Each shape of the report names its own edit, followed and compiled here.
describe("A 'complete' where nothing can wait", () => {
	let helpsOf = (source: string) =>
		analysedDiagnosticsFor(source)
			.filter(
				(diagnostic) => diagnostic.code === "complete-outside-future",
			)
			.map((diagnostic) => diagnostic.helps)

	it("compiles once the Function declares a Future", () => {
		let headline = (returned: string) => `implementation {
			function headline(_ url: String) -> ${returned} {
				constant answered = complete Async.deferred(() { <- url })

				<- answered
			}
		}`

		expect(helpsOf(headline("String"))).toEqual([
			["Declare the return Type 'Future<String>'."],
		])
		expect(compiles(headline("Future<String>"))).toBe(true)
	})

	it("compiles once a word before no work is dropped", () => {
		let doubled = (returned: string) => `implementation {
			function doubled(_ x: Integer) -> Integer {
				<- ${returned}
			}
		}`

		expect(helpsOf(doubled("complete x"))).toEqual([
			["Drop the 'complete'."],
		])
		expect(compiles(doubled("x"))).toBe(true)
	})

	it("compiles once a default reads work completed above it", () => {
		let shown = (completed: string, defaulted: string) => `implementation {
			function fetched() -> Future<Integer> {
				<- Async.deferred(() { <- 1 })
			}

			${completed}

			function shown(_ count: Integer = ${defaulted}) -> String {
				<- "{count}"
			}

			Terminal.print(shown())
		}`

		expect(helpsOf(shown("", "complete fetched()"))).toEqual([
			barredCompletion("parameter-default").helps,
		])
		expect(
			compiles(
				shown(
					"constant fetchedCount = complete fetched()",
					"fetchedCount",
				),
			),
		).toBe(true)
	})
})
