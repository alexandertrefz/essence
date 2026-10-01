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

// These specs walk a whole enriched Program, so they hold the walker apart from
// the probe Completion reaches it through.
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
			omittableMembers: [],
			shorthand: true,
		})
	})
})

// An update's right-hand side is held to the left side's Type, and an
// unannotated `{ base with … }` has no other expected Type. Both spellings are
// one Node, and only the braces tell them apart.
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
			omittableMembers: [],
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
			omittableMembers: [],
			shorthand: true,
		})
	})
})

// Every arm's value answers the whole `define`, so it is held to the Type the
// position expects.
describe("Argument context inside a define arm", () => {
	let source = [
		"implementation {",
		"\ttype Point = { x: Integer, y: Integer }",
		"",
		"\tconstant origin: Point = define {",
		"\t\tas { x = 0, y = 0 } if true",
		"\t\tas { x = 1, y = 1 } otherwise",
		"\t}",
		"}",
	].join("\n")

	it("should offer the expected Record's members in an arm's value", () => {
		let context = contextAt(source, { line: 5, column: 8 })

		expect(context?.kind).toBe("record")
		expect(context).toMatchObject({
			memberTypes: { x: { type: "Integer" }, y: { type: "Integer" } },
		})
	})

	it("should offer them in the otherwise arm's value too", () => {
		let context = contextAt(source, { line: 6, column: 8 })

		expect(context?.kind).toBe("record")
	})
})

describe("Argument context inside a Protocol-provided Method body", () => {
	let source = [
		"implementation {",
		"\ttype Point = { x: Integer, y: Integer }",
		"",
		"\tfunction isOrigin (_ point: Point) -> Boolean {",
		"\t\t<- point.x::is(0)",
		"\t}",
		"",
		"\tprotocol Placed {",
		"\t\tplace() -> Point",
		"",
		"\t\tisHome() -> Boolean {",
		"\t\t\t<- isOrigin({ x = 0, y = 0 })",
		"\t\t}",
		"\t}",
		"}",
	].join("\n")

	it("should offer the callee's Parameters at the call", () => {
		expect(contextAt(source, { line: 12, column: 15 })?.kind).toBe(
			"arguments",
		)
	})

	it("should offer the Record's members inside the literal", () => {
		expect(contextAt(source, { line: 12, column: 20 })).toEqual({
			kind: "record",
			memberTypes: { x: { type: "Integer" }, y: { type: "Integer" } },
			presentMembers: ["x", "y"],
			omittableMembers: [],
			shorthand: true,
		})
	})
})

describe("Argument context inside a refused value", () => {
	let source = [
		"implementation {",
		"\ttype Point = { x: Integer, y: Integer }",
		"",
		"\tfunction around (_ point: Point) -> List<Point> {",
		"\t\t<- [point]",
		"\t}",
		"",
		"\tconstant first = around({ x = 0, y = 0 })[0]",
		"}",
	].join("\n")

	it("should offer the callee's Parameters at the call", () => {
		expect(contextAt(source, { line: 8, column: 25 })?.kind).toBe(
			"arguments",
		)
	})

	it("should offer the Record's members inside the literal", () => {
		expect(contextAt(source, { line: 8, column: 29 })).toMatchObject({
			kind: "record",
			presentMembers: ["x", "y"],
		})
	})
})

// A valid predicate is a Method call on `@`, but while one is being typed a
// call there offers what any call offers.
describe("Argument context inside a refinement predicate", () => {
	let source = [
		"implementation {",
		"\tfunction limit (_ value: Integer, upTo bound: Integer) -> Boolean {",
		"\t\t<- value::isLessThan(bound)",
		"\t}",
		"",
		"\ttype Small = Integer where limit(@, upTo 10)",
		"}",
	].join("\n")

	it("should offer the callee's Parameters at the call", () => {
		expect(contextAt(source, { line: 6, column: 37 })?.kind).toBe(
			"arguments",
		)
	})
})

// The members offered at the cursor, and those already written there.
function membersAt(source: string, cursor: common.Cursor) {
	let context = contextAt(source, cursor)

	return context?.kind === "record"
		? {
				members: Object.keys(context.memberTypes),
				present: context.presentMembers,
			}
		: null
}

// Each place holds its child to a Type of its own. A partial literal shows
// which: only that Type names the members the literal leaves out.
describe("Argument context at each place that expects a Record", () => {
	it("should hold a Record in a List Argument to the List's item Type", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"",
			"\tfunction centre (of points: List<Point>) -> Integer {",
			"\t\t<- 0",
			"\t}",
			"",
			"\tconstant middle = centre(of [{ x = 1 }])",
			"}",
		].join("\n")

		expect(membersAt(source, { line: 8, column: 39 })).toEqual({
			members: ["x", "y"],
			present: ["x"],
		})
	})

	it("should hold a Case's payload to the Case's Record", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"",
			"\tchoice Shape {",
			"\t\tDot { at: Point, size: Integer },",
			"\t}",
			"",
			"\tconstant dot = Shape#Dot({ size = 1 })",
			"}",
		].join("\n")

		expect(membersAt(source, { line: 8, column: 37 })).toEqual({
			members: ["at", "size"],
			present: ["size"],
		})
	})

	describe("a define arm inside a Case payload", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"",
			"\tchoice Shape {",
			"\t\tDot { at: Point },",
			"\t}",
			"",
			"\tconstant dot = Shape#Dot({ at = define {",
			"\t\tas { x = 1 } if { y = 2 }",
			"\t\tas { x = 0, y = 0 } otherwise",
			"\t} })",
			"}",
		].join("\n")

		it("should hold an arm's value to the payload member's Type", () => {
			expect(membersAt(source, { line: 9, column: 14 })).toEqual({
				members: ["x", "y"],
				present: ["x"],
			})
		})

		it("should hold an arm's Condition to nothing", () => {
			expect(membersAt(source, { line: 9, column: 27 })).toEqual({
				members: ["y"],
				present: ["y"],
			})
		})
	})

	// The Handler's `<-` hands on what the `match` expects.
	it("should hold a Handler's answer to what the match expects", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"",
			"\tconstant amount: Integer | String = 4",
			"\tconstant at: Point = match amount -> Point {",
			"\t\tcase Integer { <- { x = 1 } }",
			"\t\tcase String { <- { x = 0, y = 0 } }",
			"\t}",
			"}",
		].join("\n")

		expect(membersAt(source, { line: 6, column: 29 })).toEqual({
			members: ["x", "y"],
			present: ["x"],
		})
	})

	describe("a Dictionary inside a Record member", () => {
		let source = [
			"implementation {",
			"\ttype Name = { first: String, last: String }",
			"\ttype Point = { x: Integer, y: Integer }",
			"\ttype Atlas = { places: Dictionary<Name, Point> }",
			"",
			'\tconstant atlas: Atlas = { places = [{ first = "a" } = { x = 1 }] }',
			"}",
		].join("\n")

		it("should hold a key to the key Type", () => {
			expect(membersAt(source, { line: 6, column: 52 })).toEqual({
				members: ["first", "last"],
				present: ["first"],
			})
		})

		it("should hold a value to the value Type", () => {
			expect(membersAt(source, { line: 6, column: 64 })).toEqual({
				members: ["x", "y"],
				present: ["x"],
			})
		})
	})

	it("should hold a Case payload's default to the payload's Record", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"",
			"\tchoice Shape {",
			"\t\tDot { at: Point, size: Integer } = { size = 1 },",
			"\t}",
			"}",
		].join("\n")

		expect(membersAt(source, { line: 5, column: 49 })).toEqual({
			members: ["at", "size"],
			present: ["size"],
		})
	})

	it("should hold an update's left-hand Record to the annotation", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"",
			"\tconstant moved: Point = { { x = 1 } with x = 2 }",
			"}",
		].join("\n")

		expect(membersAt(source, { line: 4, column: 36 })).toEqual({
			members: ["x", "y"],
			present: ["x"],
		})
	})

	it("should hold an assigned value to its own Type", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"",
			"\tconstant amount: Integer | String = 4",
			"\tvariable at: Point = { x = 0, y = 0 }",
			"\tat = match amount -> Point {",
			"\t\tcase Integer { <- { x = 1 } }",
			"\t\tcase String { <- { x = 0, y = 0 } }",
			"\t}",
			"}",
		].join("\n")

		expect(membersAt(source, { line: 7, column: 29 })).toEqual({
			members: ["x", "y"],
			present: ["x"],
		})
	})

	it("should say which members a Record Argument's Parameter default fills", () => {
		let source = [
			"implementation {",
			"\ttype Options = { host: String, retries: Integer }",
			"",
			"\tfunction connect (using options: Options = { retries = 3 }) -> String {",
			"\t\t<- options.host",
			"\t}",
			"",
			'\tconstant reply = connect(using { host = "local" })',
			"}",
		].join("\n")

		expect(contextAt(source, { line: 8, column: 50 })).toMatchObject({
			presentMembers: ["host"],
			omittableMembers: ["retries"],
		})
	})
})
