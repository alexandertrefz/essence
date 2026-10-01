import { describe, expect, it } from "bun:test"

import type { common, parser } from "@essence-lang/interfaces"

import { analyseSource } from "../analysis"
import { enrich } from "../enricher/index"
import { parseWithDiagnostics } from "../parser/index"

// A Statement the Parser dropped was still written. The names it bound must
// keep resolving, or one syntax error is reported again at every read. See
// "Recovery" in packages/interfaces/DEVELOPMENT.md.

function recoveryOf(source: string): parser.Recovery {
	return (
		parseWithDiagnostics(source).program.recovery ?? {
			declarations: [],
			lines: [],
			headLines: [],
		}
	)
}

// The names alone. Where each one reaches has a describe of its own.
function declaredNamesOf(source: string): Array<string> {
	return recoveryOf(source).declarations.map((declared) => declared.name)
}

// Every stage's codes in one list, since a check that stands down only makes
// sense beside what an earlier stage already said.
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

	// The rest of the file calls a dropped Namespace's Methods by name, so each
	// is recorded.
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

	// A call declares nothing, so recording `multiplyWith` would silence a real
	// mistake elsewhere in the file.
	it("should not record the names a dropped Namespace's bodies call", () => {
		expect(
			declaredNamesOf(`implementation {
	namespace Boxes Integer {
		doubled() -> Integer { <- @::multiplyWith(2) }
	}
}`),
		).not.toContain("multiplyWith")
	})

	// The Parameters go down with the head, and the body that reads them
	// survives it.
	it("should record a dropped Function's Parameters", () => {
		expect(
			declaredNamesOf(`implementation {
	function exclaimed(_ text: String) -> String
		<- text::append("!")
	}
}`),
		).toEqual(["exclaimed", "text"])
	})

	// A Record Type's members are not bindings, so recording them would silence
	// a real mistake about a name spelled the same way.
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

	// Recovery halts at the `}` that closes the enclosing block without reading
	// it, so that brace's line is not recorded.
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

	// Silence is owed only to the names the recovery took away.
	it("should still report a name nothing declared", () => {
		expect(
			enricherCodesOf(`implementation {
	constant limit Integer = 10
	constant shown = missing
}`),
		).toEqual(["unknown-name"])
	})
})

// A dropped Statement abandons lines, while a dropped Pattern binder abandons
// a name inside a Matcher that parses whole and leaves no line. One Program
// holds both, so a record keyed on lines alone would lose the binder.
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

	// The handler body reads both names, and neither is reported.
	it("should say nothing about either name it took away", () => {
		expect(enricherCodesOf(source)).toEqual([])
	})
})

// Silence covers only the reads the dropped Declaration could have answered.
// See "The silence of a dropped name" in packages/interfaces/DEVELOPMENT.md.
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

	// `hoistDeclarations` hoists only a section's own Statements, so a `type`
	// written inside a body is in scope only there. The other Function's
	// Parameter names a Type that is not in scope.
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

	// A top-level `choice` is in scope across the whole file, before its own
	// line too, so a dropped one silences every read of its name.
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

	// `ChoiceName#CaseName` resolves the Choice's name through a path of its
	// own, which must also stay silent for a dropped `choice`.
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

	// A Namespace's members are not lexical: a Method is called from outside
	// its Namespace's body, so a dropped one stays silent file-wide. See
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

// A dropped head orphans the `<-` lines after it, so `top-level-return` asks
// about a head above the `<-` rather than about its own line. See "Top-level
// returns" in packages/compiler/src/validator/DEVELOPMENT.md.
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

	// One missing `{` orphans every Return under it, so a Return must not raise
	// the floor.
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

	// A dropped Constant takes no body with it, so the `<-` after it was
	// written at the top level and is reported.
	it("should report under a dropped Constant", () => {
		expect(
			analysisCodesOf(`implementation {
	constant limit 10

	<- 42
}`),
		).toEqual(["syntax-error", "top-level-return"])
	})

	// The head must be dropped after the last top-level Statement read whole.
	// Text dropped inside a Function the Parser closed leaves the `<-` after
	// that Function at the top level.
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

	// Text dropped after a `<-` orphans nothing before it.
	it("should report above the run that was abandoned", () => {
		expect(
			analysisCodesOf(`implementation {
	<- 5

	constant step 1
}`),
		).toEqual(["top-level-return", "syntax-error"])
	})
})
