import { describe, expect, it } from "bun:test"

import { enrich } from "@essence/compiler/enricher"
import { parseWithDiagnostics } from "@essence/compiler/parser"
import type { common } from "@essence/interfaces"

import { findArgumentContext } from "../argumentContext"

function contextAt(source: string, cursor: common.Cursor) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findArgumentContext(enrichedProgram, cursor)
}

// NOTE: Completion reaches this walker through a probe, which cannot close an
// open Handler yet — so a Guard is covered here, where the Program is whole.
describe("Argument context inside a Match Guard", () => {
	let source = [
		"implementation {",
		"\ttype Point = { x: Integer, y: Integer }",
		"",
		"\tfunction isOrigin (_ point: Point) -> Boolean {",
		"\t\t<- point.x::is(0)",
		"\t}",
		"",
		"\tconstant amount: Integer | String = 4",
		"\tconstant label = match amount -> String {",
		'\t\tcase Integer where isOrigin({ x = 0, y = 0 }) { <- "origin" }',
		'\t\tcase Integer { <- "somewhere" }',
		"\t\tcase String { <- @ }",
		"\t}",
		"}",
	].join("\n")

	it("should offer the callee's Parameters at the call", () => {
		let context = contextAt(source, { line: 10, column: 30 })

		expect(context?.kind).toBe("arguments")
	})

	it("should offer the Record's members inside the literal", () => {
		let context = contextAt(source, { line: 10, column: 40 })

		expect(context).toEqual({
			kind: "record",
			memberTypes: { x: { type: "Integer" }, y: { type: "Integer" } },
			presentMembers: ["x", "y"],
		})
	})
})
