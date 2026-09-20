import { describe, expect, it } from "bun:test"

import type { common, parser } from "@essence-lang/interfaces"

import { analyseSource } from "../analysis"
import { enrich } from "../enricher/index"
import { parseWithDiagnostics } from "../parser/index"

// NOTE: What the Parser abandoned, and what the stages behind it do about it.
// A Statement the Parser dropped is a Statement the reader WROTE — the file
// declares what it declares — so every name it bound has to keep resolving, or
// one syntax error is reported again at every line that reads one of them.
// That cascade is what this spec is about; `parser.Recovery` is the record it
// is answered from.

function recoveryOf(source: string): parser.Recovery {
	return (
		parseWithDiagnostics(source).program.recovery ?? {
			declarations: [],
			lines: [],
			headLines: [],
		}
	)
}

// NOTE: The names alone, which is what most of this spec is about — WHERE each
// one reaches is the subject of "Where a dropped Declaration's silence reaches"
// below.
function declaredNamesOf(source: string): Array<string> {
	return recoveryOf(source).declarations.map((declared) => declared.name)
}

// NOTE: Every stage's verdict in one list, which is what the checks that STAND
// DOWN have to be read against: what they suppress only makes sense beside what
// the stage above them already said.
function analysisCodesOf(source: string): Array<string> {
	return analyseSource(source).diagnostics.map(
		(diagnostic: common.Diagnostic) => diagnostic.code,
	)
}

function enricherCodesOf(source: string): Array<string> {
	let parsed = parseWithDiagnostics(source)

	return enrich(parsed.program).diagnostics.map(
		(diagnostic: common.Diagnostic) => diagnostic.code,
	)
}

describe("Parser recovery", () => {
	it("should record nothing for a Program that parsed", () => {
		expect(
			parseWithDiagnostics(`implementation {
	constant limit: Integer = 10
	Terminal.print("{limit}")
}`).program.recovery,
		).toBeUndefined()
	})

	it("should record the name a dropped Constant declared", () => {
		expect(
			declaredNamesOf(`implementation {
	constant limit Integer = 10
}`),
		).toEqual(["limit"])
	})

	it("should record the name a dropped Function declared", () => {
		expect(
			declaredNamesOf(`implementation {
	function twice(_ n Integer) -> Integer {
		<- n::multiplyWith(2)
	}
}`),
		).toEqual(["twice"])
	})

	it("should record the name a dropped Type Alias declared", () => {
		expect(
			declaredNamesOf(`implementation {
	type Point = { x: Integer y: Integer }
}`),
		).toEqual(["Point"])
	})

	// NOTE: A Namespace takes its Methods down with it, and the rest of the file
	// calls them by name — so each is recorded beside the Namespace's own.
	it("should record a dropped Namespace's Methods", () => {
		expect(
			declaredNamesOf(`implementation {
	namespace Boxes Integer {
		doubled() -> Integer { <- @::multiplyWith(2) }
		static origin = 0
	}
}`),
		).toEqual(["Boxes", "doubled", "origin"])
	})

	// NOTE: And no deeper than the body's own level. `multiplyWith` is a name
	// the Method CALLS, and a call says nothing about what this file declares —
	// recording it would silence a genuine mistake anywhere else in the file.
	it("should not record the names a dropped Namespace's bodies call", () => {
		expect(
			declaredNamesOf(`implementation {
	namespace Boxes Integer {
		doubled() -> Integer { <- @::multiplyWith(2) }
	}
}`),
		).not.toContain("multiplyWith")
	})

	// NOTE: A Parameter list goes down with the head it is written on, so its
	// names are as undeclared as the Function's own — and the body reading them
	// is exactly what survives a dropped head.
	it("should record a dropped Function's Parameters", () => {
		expect(
			declaredNamesOf(`implementation {
	function exclaimed(_ text: String) -> String
		<- text::append("!")
	}
}`),
		).toEqual(["exclaimed", "text"])
	})

	// NOTE: And nothing a Type names. A `{ x: Integer }` declares members
	// rather than bindings, and a `type` Declaration has no Parameter list at
	// all — recording either would silence a genuine mistake about a name
	// spelled the same way somewhere else in the file.
	it("should not record the members a dropped Type names", () => {
		expect(
			declaredNamesOf(`implementation {
	type Point = { x: Integer y: Integer }
}`),
		).toEqual(["Point"])
	})

	it("should record a dropped Choice's Cases", () => {
		expect(
			declaredNamesOf(`implementation {
	choice Colour { #Red #Green( }
}`),
		).toEqual(["Colour", "Green", "Red"])
	})

	// NOTE: Up to where the recovery stopped, which is the `}` that closes the
	// block the Statement was written in — a resynchronisation halts AT a
	// closing brace rather than reading past it, so the brace's own line is the
	// one line of the Declaration this does not claim.
	it("should record every line a dropped Statement was written across", () => {
		expect(
			recoveryOf(`implementation {
	function twice(_ n Integer) -> Integer {
		<- n::multiplyWith(2)
	}
}`).lines,
		).toEqual([2, 3, 4])
	})
})

describe("Reads of a dropped Declaration", () => {
	it("should stay silent for a Constant", () => {
		expect(
			enricherCodesOf(`implementation {
	constant limit Integer = 10
	constant doubled = limit::multiplyWith(2)
	Terminal.print("{limit}")
}`),
		).toEqual([])
	})

	it("should stay silent for a Type", () => {
		expect(
			enricherCodesOf(`implementation {
	type Point = { x: Integer y: Integer }
	function origin() -> Point {
		<- { x = 0, y = 0 }
	}
}`),
		).toEqual([])
	})

	it("should stay silent for a Namespace's Method", () => {
		expect(
			enricherCodesOf(`implementation {
	namespace Duration for Integer {
		seconds() ->  {
			<- @::remainder(dividingBy 60)
		}
	}

	Terminal.print("{3600::seconds()}")
}`),
		).toEqual([])
	})

	it("should stay silent for a Choice's Cases", () => {
		expect(
			enricherCodesOf(`implementation {
	choice Colour { #Red #Green( }
	constant chosen: Colour = #Red
}`),
		).toEqual([])
	})

	// NOTE: The other half of the rule, and the one that decides whether this is
	// worth having at all: a name nothing declared is still a name nothing
	// declared. Silence is owed to what the recovery took away and to nothing
	// else.
	it("should still report a name nothing declared", () => {
		expect(
			enricherCodesOf(`implementation {
	constant limit Integer = 10
	constant shown = missing
}`),
		).toEqual(["unknown-name"])
	})
})

// NOTE: The two kinds of abandonment in ONE Program, because they are recorded
// two different ways and were written in two different branches. A dropped
// STATEMENT abandons text, which is what the lines are read off; a dropped
// PATTERN BINDER abandons a name while the Matcher around it parses whole, so it
// leaves no line at all. A `recovery()` keyed on the lines alone answered
// `undefined` for the second, and the binder's name then reported once per read
// as a name nobody declared.
describe("A Program that abandoned a Statement and a binder", () => {
	let source = `implementation {
	constant limit Integer = 10

	constant point: { x: Integer, y: Integer } | String = { x = 1, y = 2 }

	Terminal.print(match point -> String {
		case { x, y } as whole { <- "{whole.x} and {y} under {limit}" }
		case String { <- "a string" }
	})
}`

	it("should record both, the name and the lines", () => {
		let recovery = recoveryOf(source)

		expect(recovery.declarations.map((declared) => declared.name)).toEqual([
			"limit",
			"whole",
		])
		expect(recovery.lines).toEqual([2])
	})

	// NOTE: Two mistakes, two reports — and nothing about either name, though
	// the body below reads both of them.
	it("should say nothing about either name it took away", () => {
		expect(enricherCodesOf(source)).toEqual([])
	})
})

// NOTE: The other half of the rule, and the one this whole record exists to get
// right: the silence is owed to the reads the dropped Declaration would have
// ANSWERED, and to no others. A Constant dropped out of one Function's body was
// never in scope in the next Function along, so a read of the same name there
// resolved to nothing before the mistake and resolves to nothing without it —
// reporting it is not a cascade, it is the second mistake in the file, and one
// run that reports every mistake is the point.
describe("Where a dropped Declaration's silence reaches", () => {
	it("should stay silent below the run in the block it was written in", () => {
		expect(
			enricherCodesOf(`implementation {
	function subtotal() -> Integer {
		variable total 0
		<- total
	}
}`),
		).toEqual([])
	})

	it("should report the same name read in another body", () => {
		expect(
			enricherCodesOf(`implementation {
	function subtotal() -> Integer {
		variable total 0
		<- total
	}

	function report() -> String {
		<- total::toString()
	}
}`),
		).toEqual(["unknown-name"])
	})

	it("should report the same name read at the top level", () => {
		expect(
			enricherCodesOf(`implementation {
	function helper() -> Integer {
		constant shipping 5
		<- 0
	}

	Terminal.print(shipping::toString())
}`),
		).toEqual(["unknown-name"])
	})

	// NOTE: A `type` is hoistable by KEYWORD and hoisted by nobody when it is
	// written inside a body — `hoistDeclarations` runs over a section's own
	// Statements and nothing deeper. So a dropped one is in scope exactly where
	// it was written, and the Parameter annotation below reads a Type this file
	// does not have.
	it("should report a Type dropped inside a body and named outside it", () => {
		expect(
			enricherCodesOf(`implementation {
	function make() -> Integer {
		type Point { x: Integer }
		<- 1
	}

	function use(_ p: Point) -> Integer {
		<- 1
	}
}`),
		).toEqual(["unknown-type"])
	})

	// NOTE: And the hoisted case, which is why `hoistable` is recorded at all: a
	// top-level `choice` is in scope across the whole file and ABOVE its own
	// line, so a dropped one silences every read of its name wherever it stands.
	it("should stay silent file-wide for a dropped top-level Choice", () => {
		expect(
			enricherCodesOf(`implementation {
	constant early: Signal = Signal#Red

	choice Signal {
		Red,
		Amber
		Green,
	}
}`),
		).toEqual([])
	})

	// NOTE: `ChoiceName#CaseName` reads the Choice's name through a path of its
	// own, which had no such question to ask — so a dropped `choice` answered
	// its every qualified Case with "Type 'Signal' is not declared", the syntax
	// error said again about a Type the file declares.
	it("should stay silent for a qualified Case of a dropped Choice", () => {
		expect(
			enricherCodesOf(`implementation {
	choice Signal {
		Red,
		Amber
		Green,
	}

	constant s: Signal = Signal#Red
}`),
		).toEqual([])
	})

	// NOTE: A Namespace's members are NOT lexical — a Method dropped out of a
	// Namespace's body is called from outside that body, everywhere the
	// Namespace reaches — so their silence stays file-wide. See
	// `memberDeclarationWasAbandoned`.
	it("should stay silent for a dropped Method called outside its Namespace", () => {
		expect(
			enricherCodesOf(`implementation {
	namespace Duration for Integer {
		seconds() ->  {
			<- @::remainder(dividingBy 60)
		}
	}

	Terminal.print("{3600::seconds()}")
}`),
		).toEqual([])
	})
})

// NOTE: `top-level-return` is the one check whose stand-down can not ask about
// its own lines: a `<-` stands outside a Function because the HEAD that would
// have opened one is missing, and a head is dropped a line ABOVE the `<-` it
// orphans. It used to answer that by standing down for the whole file, which
// let a dropped Constant three lines up take away the report for a `<-` the
// reader really did write at the top level.
describe("A '<-' outside a Function beneath abandoned text", () => {
	it("should stay silent under a dropped Function head", () => {
		expect(
			analysisCodesOf(`implementation {
	function helper() -> Integer
		<- 1
	}
}`),
		).toEqual(["syntax-error", "unexpected-token"])
	})

	// NOTE: One dropped head, several orphaned Returns — the `{` it was missing
	// is ONE brace, so every Statement under it stands outside a Function for
	// the same one reason. A Return that advanced the floor would report the
	// second and every one after it.
	it("should stay silent for every Return one dropped head orphans", () => {
		expect(
			analysisCodesOf(`implementation {
	function helper() -> Integer
		<- 1
		<- 2
	}
}`),
		).toEqual(["syntax-error", "unexpected-token"])
	})

	// NOTE: A dropped Constant takes no body down with it, so the `<-` below it
	// is a `<-` the reader wrote at the top level and is owed its report. This
	// is the discriminator the whole condition exists for.
	it("should report under a dropped Constant", () => {
		expect(
			analysisCodesOf(`implementation {
	constant limit 10

	<- 42
}`),
		).toEqual(["syntax-error", "top-level-return"])
	})

	// NOTE: And the head has to be abandoned BELOW everything the Parser read
	// whole at the top level. A Statement dropped inside a Function the Parser
	// closed is a Statement whose body the Parser HAS — so what stands under
	// that Function stands at the top level.
	it("should report below a Function the Parser read whole", () => {
		expect(
			analysisCodesOf(`implementation {
	function helper() -> Integer {
		constant step 1
		<- 0
	}

	<- 5
}`),
		).toEqual(["syntax-error", "top-level-return"])
	})

	// NOTE: And the head has to be abandoned ABOVE the `<-` it is supposed to
	// have orphaned. Text dropped further down the file orphans nothing above
	// it.
	it("should report above the run that was abandoned", () => {
		expect(
			analysisCodesOf(`implementation {
	<- 5

	constant step 1
}`),
		).toEqual(["top-level-return", "syntax-error"])
	})
})
