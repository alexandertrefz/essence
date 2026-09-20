import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { enrich } from "../enricher/index"
import { parseWithDiagnostics } from "../parser/index"

// NOTE: What the Parser abandoned, and what the stages behind it do about it.
// A Statement the Parser dropped is a Statement the reader WROTE — the file
// declares what it declares — so every name it bound has to keep resolving, or
// one syntax error is reported again at every line that reads one of them.
// That cascade is what this spec is about; `parser.Recovery` is the record it
// is answered from.

function recoveryOf(source: string): {
	declarations: Array<string>
	lines: Array<number>
} {
	return (
		parseWithDiagnostics(source).program.recovery ?? {
			declarations: [],
			lines: [],
		}
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
			recoveryOf(`implementation {
	constant limit Integer = 10
}`).declarations,
		).toEqual(["limit"])
	})

	it("should record the name a dropped Function declared", () => {
		expect(
			recoveryOf(`implementation {
	function twice(_ n Integer) -> Integer {
		<- n::multiplyWith(2)
	}
}`).declarations,
		).toEqual(["twice"])
	})

	it("should record the name a dropped Type Alias declared", () => {
		expect(
			recoveryOf(`implementation {
	type Point = { x: Integer y: Integer }
}`).declarations,
		).toEqual(["Point"])
	})

	// NOTE: A Namespace takes its Methods down with it, and the rest of the file
	// calls them by name — so each is recorded beside the Namespace's own.
	it("should record a dropped Namespace's Methods", () => {
		expect(
			recoveryOf(`implementation {
	namespace Boxes Integer {
		doubled() -> Integer { <- @::multiplyWith(2) }
		static origin = 0
	}
}`).declarations,
		).toEqual(["Boxes", "doubled", "origin"])
	})

	// NOTE: And no deeper than the body's own level. `multiplyWith` is a name
	// the Method CALLS, and a call says nothing about what this file declares —
	// recording it would silence a genuine mistake anywhere else in the file.
	it("should not record the names a dropped Namespace's bodies call", () => {
		expect(
			recoveryOf(`implementation {
	namespace Boxes Integer {
		doubled() -> Integer { <- @::multiplyWith(2) }
	}
}`).declarations,
		).not.toContain("multiplyWith")
	})

	it("should record a dropped Choice's Cases", () => {
		expect(
			recoveryOf(`implementation {
	choice Colour { #Red #Green( }
}`).declarations,
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
