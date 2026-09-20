import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { enrich } from "../enricher/index"
import { parse } from "../parser/index"
import { printType } from "../printType"
import { validate } from "../validator/index"

// NOTE: Two Records that disagree are not two Types to print — they are one
// member, and the whole of this file is about which member the report names and
// what it calls the Record it was measured against. End to end, because both
// halves are decided in two stages: the Enricher stamps the Alias name onto the
// Type and the Validator writes most of the reports, and a spec that stubbed
// either would be testing itself.
function errorsFor(source: string): Array<common.Diagnostic> {
	let { program, diagnostics } = enrich(parse(source))

	return [...diagnostics, ...validate(program)].filter(
		(diagnostic) => diagnostic.severity === "error",
	)
}

function onlyError(source: string): common.Diagnostic {
	let errors = errorsFor(source)

	expect(errors.map((error) => error.code)).toHaveLength(1)

	return errors[0] as common.Diagnostic
}

function labelsOf(diagnostic: common.Diagnostic): Array<string> {
	return diagnostic.labels.map((label) => label.message)
}

// NOTE: The text a Label actually stands over, cut out of the source the report
// was made from — an assertion on the span itself only says the numbers agree
// with each other, and what is being claimed here is that the arrow lands on the
// member and not on the two hundred characters around it.
function spansOf(source: string, diagnostic: common.Diagnostic): Array<string> {
	let lines = source.split("\n")

	return diagnostic.labels.map((label) => {
		let line = lines[label.position.start.line - 1] as string

		return line.slice(
			label.position.start.column - 1,
			label.position.end.column - 1,
		)
	})
}

function implementation(body: string): string {
	return `implementation {\n${body}\n}`
}

const standing = `	type Team = { name: String, code: String }
	type Standing = { team: Team, played: Integer, points: Integer }`

describe("a Record that does not fit another", () => {
	describe("the finding this was written for", () => {
		let source = implementation(`${standing}
	function blank(of team: Team) -> Standing {
		<- { team = team, played = 0, pointsFor = 0, points = "0" }
	}`)
		let error = onlyError(source)

		it("leads with the first member that was refused", () => {
			expect(error.code).toBe("return-type-mismatch")
			expect(error.labels[0]?.kind).toBe("primary")
			expect(labelsOf(error)[0]).toBe(
				"'pointsFor' is not a member of Standing",
			)
		})

		it("points the Diagnostic at that member rather than at the value", () => {
			expect(spansOf(source, error)[0]).toBe("0")
			expect(error.position).toEqual(
				(error.labels[0] as common.DiagnosticLabel).position,
			)
		})

		it("labels the next offending member as well", () => {
			expect(error.labels[1]?.kind).toBe("secondary")
			expect(labelsOf(error)[1]).toBe(
				"this is a String, and Standing declares an Integer",
			)
			expect(spansOf(source, error)[1]).toBe('"0"')
		})

		it("names the expected Type by its Alias and spells no shape", () => {
			expect(error.notes).toEqual(["The Function returns Standing."])
			expect(JSON.stringify(error)).not.toContain("team: Team")
		})

		it("offers the near miss, and does not also call it missing", () => {
			expect(error.helps).toEqual(["Did you mean 'points'?"])
			expect(error.notes.join(" ")).not.toContain("is missing")
		})

		it("carries the member and the near miss for a Quick Fix", () => {
			expect(error.data).toEqual({
				kind: "record-member",
				member: "pointsFor",
				suggestion: "points",
			})
		})
	})

	describe("members nobody wrote", () => {
		let source = implementation(`${standing}
	constant blank: Standing = { team = { name = "a", code = "b" } }`)
		let error = onlyError(source)

		// NOTE: Nothing inside the Literal is wrong, so there is nothing inside
		// it to point at — and the Literal printed back at the reader is what
		// this whole report exists to stop.
		it("labels the Literal with the members it does not write", () => {
			expect(labelsOf(error)).toEqual(["'played', 'points' are missing"])
		})

		it("says it once, in the Label rather than twice", () => {
			expect(error.notes).toEqual(["'blank' is declared as Standing."])
		})

		it("names one missing member in the singular", () => {
			let one = onlyError(
				implementation(`${standing}
	constant blank: Standing = { team = { name = "a", code = "b" }, played = 0 }`),
			)

			expect(labelsOf(one)).toEqual(["'points' is missing"])
		})
	})

	describe("a member of a member", () => {
		let source = implementation(`${standing}
	constant blank: Standing = { team = { name = "a", code = 1 }, played = 0, points = 0 }`)
		let error = onlyError(source)

		// NOTE: The path is spelled from the outside in and the Type is the one
		// that DECLARES the member — `Team` rather than `Standing`, which is the
		// Declaration a reader would open to check.
		it("names the member at the depth it is wrong at", () => {
			expect(labelsOf(error)).toEqual([
				"this is an Integer, and Team declares a String",
			])
			expect(spansOf(source, error)).toEqual(["1"])
		})

		it("spells the path in a Note past the Labels", () => {
			let wide = onlyError(
				implementation(`	type Inner = { a: Integer, b: Integer, c: Integer, d: Integer }
	type Outer = { inner: Inner }
	constant broken: Outer = { inner = { a = "", b = "", c = "", d = "" } }`),
			)

			expect(wide.notes).toContain(
				"'inner.d' is a String; Inner declares an Integer.",
			)
		})
	})

	describe("a Record a default fills in", () => {
		// NOTE: A member the default writes is not one the Argument is missing,
		// which is the rule `missingRecordMembers` answers for the report beside
		// this one and is asked again here.
		it("counts a defaulted member as written", () => {
			let error = onlyError(
				implementation(`	type Options = { host: String, retries: Integer }
	function connect(using options: Options = { retries = 3 }) -> String {
		<- options.host
	}

	Terminal.print(connect(using { host = 1 }))`),
			)

			expect(error.code).toBe("argument-type-mismatch")
			expect(labelsOf(error)).toEqual([
				"this is an Integer, and Options declares a String",
			])
			expect(error.notes).toEqual(["Parameter 'using' is Options."])
		})

		// NOTE: An update and a payload default are PARTIALS — leaving members
		// out is what they are for — so only what they write can be wrong.
		it("calls nothing missing from an update", () => {
			let error = onlyError(
				implementation(`	type Options = { host: String, retries: Integer }
	constant base: Options = { host = "h", retries = 1 }
	constant broken = { base with hosts = "other" }`),
			)

			expect(error.code).toBe("partial-type-mismatch")
			expect(labelsOf(error)[0]).toBe(
				"'hosts' is not a member of Options",
			)
			expect(error.notes.join(" ")).not.toContain("is missing")
			expect(error.helps).toEqual(["Did you mean 'host'?"])
		})
	})

	describe("a Union of Records", () => {
		let error = onlyError(
			implementation(`	type Circle = { radius: Integer, filled: Boolean }
	type Rect = { width: Integer, height: Integer }
	constant shape: Circle | Rect = { radius = 1, filled = 1 }`),
		)

		it("diffs against the closest arm and says which", () => {
			expect(labelsOf(error)).toEqual([
				"this is an Integer, and Circle declares a Boolean",
			])
			expect(error.notes).toContain(
				"Compared against Circle, the closest of the 2 Records this Union holds.",
			)
		})
	})

	describe("the cap", () => {
		let members = "abcdefghijk".split("")
		let error = onlyError(
			implementation(`	type Wide = { ${members
				.map((name) => `${name}: Integer`)
				.join(", ")} }
	constant wide: Wide = { ${members.map((name) => `${name} = ""`).join(", ")} }`),
		)

		it("labels three members and notes six more", () => {
			expect(error.labels).toHaveLength(3)
			expect(error.notes).toHaveLength(8)
		})

		it("counts the rest rather than listing them", () => {
			expect(error.notes[error.notes.length - 1]).toBe(
				"And 2 more members differ.",
			)
		})
	})

	describe("what it says nothing about", () => {
		// NOTE: An empty List Literal leaves a blank, and a blank fits the List
		// it is written into — the sentences about one are
		// `undecidedSlotEvidence`'s, and a member holding one is not a member
		// that differs.
		it("leaves an undecided slot out of the diff", () => {
			let error = onlyError(
				implementation(`	type Row = { form: List<String>, points: Integer }
	constant row: Row = { form = [], points = "0" }`),
			)

			expect(labelsOf(error)).toEqual([
				"this is a String, and Row declares an Integer",
			])
			expect(error.notes).toEqual(["'row' is declared as Row."])
		})

		// NOTE: Record assignability is width subtyping, so a member the Type
		// does not declare refuses nothing OUTSIDE a partial position. Pinned
		// because the diff would otherwise be reporting a refusal there is none
		// of.
		it("reports nothing for an extra member where one is allowed", () => {
			expect(
				errorsFor(
					implementation(`	type Point = { x: Integer }
	constant wide: Point = { x = 1, y = 2 }`),
				),
			).toEqual([])
		})
	})
})

describe("a Record under the name its Alias gave it", () => {
	it("prints as the Alias where a value of one is named", () => {
		let error = onlyError(
			implementation(`	type Point = { x: Integer }
	constant broken: Point = 1`),
		)

		expect(error.notes).toEqual(["'broken' is declared as Point."])
	})

	it("prints an applied generic Alias as applied", () => {
		let error = onlyError(
			implementation(`	type Pair<Held> = { first: Held, second: Held }
	constant broken: Pair<Integer> = { first = 1, second = "two" }`),
		)

		expect(labelsOf(error)).toEqual([
			"this is a String, and Pair<Integer> declares an Integer",
		])
		expect(error.notes).toEqual(["'broken' is declared as Pair<Integer>."])
	})

	// NOTE: The name is DISPLAY. Two Aliases of one shape are one Type, and a
	// value of either fits the other — which is what keeps this a change to what
	// a reader is shown and to nothing else.
	it("changes nothing about what fits what", () => {
		expect(
			errorsFor(
				implementation(`	type A = { x: Integer }
	type B = { x: Integer }
	constant a: A = { x = 1 }
	constant b: B = a
	constant back: A = b`),
			),
		).toEqual([])
	})

	it("prints each of two same-shaped Aliases as itself", () => {
		let first = onlyError(
			implementation(`	type A = { x: Integer }
	type B = { x: Integer }
	constant a: A = { x = "one" }`),
		)
		let second = onlyError(
			implementation(`	type A = { x: Integer }
	type B = { x: Integer }
	constant b: B = { x = "one" }`),
		)

		expect(labelsOf(first)).toEqual([
			"this is a String, and A declares an Integer",
		])
		expect(labelsOf(second)).toEqual([
			"this is a String, and B declares an Integer",
		])
	})

	// NOTE: A Record the PROGRAM builds carries no name, which is what keeps the
	// spelling from going stale rather than anybody remembering to clear it.
	it("gives a written Literal no name of its own", () => {
		let { program } = enrich(
			parse(
				implementation(`	type Point = { x: Integer }
	constant written = { x = 1 }
	constant annotated: Point = { x = 1 }`),
			),
		)
		let declarations = program.implementation.nodes.filter(
			(node) => node.nodeType === "ConstantDeclarationStatement",
		)

		// NOTE: The LITERAL's own Type is anonymous on both lines — a written
		// Record is a Record the Program built — and only the Declaration that
		// annotated one carries the Alias.
		expect(declarations.map((node) => printType(node.value.type))).toEqual([
			"{ x: Integer }",
			"{ x: Integer }",
		])
		expect(
			declarations.map((node) =>
				node.declaredType === null
					? null
					: printType(node.declaredType),
			),
		).toEqual([null, "Point"])
	})

	// NOTE: A Pattern proves a shape with the members it required written over
	// the ones the Alias declares, and a shape with a member the Alias never
	// mentions is not that Alias. Read off a refusal INSIDE the Handler, which
	// is the only place the narrowed Type is named.
	it("drops the name where a Pattern narrows one", () => {
		let error = onlyError(
			implementation(`	type Point = { x: Integer }
	function widen(_ value: Point | String) -> Point {
		<- match value -> Point {
			case { x: String } { <- @ }
			case Point { <- @ }
			case String { <- { x = 0 } }
		}
	}`),
		)

		expect(labelsOf(error)).toEqual(["this is a { x: String }"])
	})
})
