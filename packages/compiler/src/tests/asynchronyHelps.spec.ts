import { describe, expect, it } from "bun:test"

import { barredCompletion } from "../helpers/describe"
import { analysedDiagnosticsFor, compiles } from "./followedHelps"

// NOTE: One question, asked by every report that could offer `complete`, and one
// answer per position. The audit found the word offered where writing it is
// `complete-outside-future` and withheld where writing it compiles, because
// three reporters asked three questions: "is this body marked completing", "does
// it declare a Future", "is it the top level". They ask `bodyCanWait` now — the
// Enricher off the Scope chain, the Validator off its stack of enclosing bodies
// — and this is the table that says so.
//
// The positions are every shape a body comes in, and the sites are every report
// that holds a Future where a value was wanted. A cell is what the report SAYS
// about the word, and where it offers it, the Program with the word written in
// is compiled: a Help that offers an edit is a promise that the edit works.

type Verdict =
	// The word, written HERE, is the edit.
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

	// NOTE: Case-folded, because the clause is written "Or declare …" where it
	// comes second and "Declare …" where it stands alone.
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

// NOTE: `fetched` and the two names the sites call are written into every probe,
// so that what differs between two cells is the position and nothing else.
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
	// NOTE: The code the report carries, so that a cell testing the Helps of
	// nothing fails rather than passes.
	code: string
	// One statement holding a Future where a value goes, and the same statement
	// with the word written in.
	written: string
	followed: string
	// And the same statement as an EXPRESSION, for the Parameter default
	// position, which takes one rather than a statement. Null where the report
	// has no shape there at all — a default is a default, and an ASSIGNMENT is
	// not one, so `assignment-type-mismatch` has nothing to say in that cell.
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
	// NOTE: And the same position once the word IS written, where writing it
	// changes what the body around it has to say. A body that had completed
	// nothing answers with a Future it built; once it waits, it answers with the
	// value — which is the ordinary shape of every async body.
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
	// NOTE: The cell the whole seam was about. A body that declares
	// `-> Future<…>` and has not written its first `complete` is the body a
	// report is most likely to be offering the word to — and three of these
	// sites used to answer it with "declare the enclosing Function
	// '-> Future<…>'", which its author had already done.
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
	site: Site,
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
					let { codes, helps } = helpsAt(site, position, statement)

					// NOTE: The Parameter default position raises the
					// Declaration's own refusal for some of these — a default is
					// measured against the Parameter's Type before anything else
					// — so what is pinned there is the barrier's sentence rather
					// than which code carries it.
					if (!isDefaultPosition(position)) {
						expect(codes).toContain(site.code)
					}

					expect(verdictOf(helps)).toBe(position.verdict)
				})
			}

			// NOTE: And the promise, kept: where the word is offered, the Program
			// with the word written in is a Program that compiles.
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
