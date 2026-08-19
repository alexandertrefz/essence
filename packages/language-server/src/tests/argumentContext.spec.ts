import { describe, expect, it } from "bun:test"

import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import type { common } from "@essence-lang/interfaces"

import { findArgumentContext } from "../argumentContext"

function contextAt(source: string, cursor: common.Cursor) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findArgumentContext(enrichedProgram, cursor, source.split("\n"))
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
			shorthand: true,
		})
	})
})

// NOTE: An update's right-hand side is held to the LEFT side's Type — every
// member it may name is one the left side already has — and an unannotated
// `{ base with … }` has no other expected Type at all. Both spellings of the
// right-hand side are covered here, because they are one Node with one shape
// and only the braces tell them apart.
describe("Argument context inside an update", () => {
	let source = [
		"implementation {",
		'\tconstant base = { host = "local", port = 80 }',
		"",
		"\tconstant keys = { base with port = 8080 }",
		"\tconstant merged = { base with { port = 8080 } }",
		"}",
	].join("\n")

	it("offers the left side's members in the key list", () => {
		let context = contextAt(source, { line: 4, column: 32 })

		expect(context).toEqual({
			kind: "record",
			memberTypes: {
				host: { type: "String" },
				port: { type: "Integer" },
			},
			presentMembers: ["port"],
			shorthand: false,
		})
	})

	it("offers them in a braced right-hand side, where a bare name is legal", () => {
		let context = contextAt(source, { line: 5, column: 35 })

		expect(context).toEqual({
			kind: "record",
			memberTypes: {
				host: { type: "String" },
				port: { type: "Integer" },
			},
			presentMembers: ["port"],
			shorthand: true,
		})
	})
})
