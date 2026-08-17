import { describe, expect, it } from "bun:test"

import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import type { common } from "@essence-lang/interfaces"

import {
	type CallHierarchyCalls,
	findIncomingCalls,
	findOutgoingCalls,
	prepareCallHierarchy,
} from "../callHierarchy"

function analyse(source: string) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return { program, enrichedProgram }
}

function prepare(source: string, cursor: common.Cursor) {
	let { program, enrichedProgram } = analyse(source)

	return prepareCallHierarchy(program, cursor, enrichedProgram)
}

function incoming(source: string, cursor: common.Cursor) {
	let { program, enrichedProgram } = analyse(source)

	return findIncomingCalls(program, cursor, enrichedProgram)
}

function outgoing(source: string, cursor: common.Cursor) {
	let { program, enrichedProgram } = analyse(source)

	return findOutgoingCalls(program, cursor, enrichedProgram)
}

// NOTE: Who calls whom, and how often — the grouping is what the expectations
// below are about; the individual call Positions are asserted where they carry
// the point of the test.
function summarise(calls: Array<CallHierarchyCalls>) {
	return calls.map((entry) => ({
		name: entry.item.name,
		kind: entry.item.kind,
		container: entry.item.container,
		calls: entry.ranges.length,
	}))
}

describe("Call Hierarchy", () => {
	it("should prepare an item on a Function declaration name", () => {
		let source = [
			"implementation {",
			"\tfunction helper(_ value: Integer) -> Integer {",
			"\t\t<- value",
			"\t}",
			"}",
		].join("\n")

		expect(prepare(source, { line: 2, column: 11 })).toEqual({
			name: "helper",
			kind: "function",
			container: null,
			// NOTE: The whole Statement, so that an Editor can reveal the
			// Function as it is written.
			range: {
				start: { line: 2, column: 2 },
				end: { line: 4, column: 3 },
			},
			selectionRange: {
				start: { line: 2, column: 11 },
				end: { line: 2, column: 17 },
			},
		})
	})

	it("should prepare a Method with the Namespace it belongs to", () => {
		let source = [
			"implementation {",
			"\tnamespace Doubler for Integer {",
			"\t\tdouble() -> Integer {",
			"\t\t\t<- @::add(@)",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		let item = prepare(source, { line: 3, column: 3 })

		expect(item?.name).toBe("double")
		expect(item?.kind).toBe("method")
		expect(item?.container).toBe("Doubler")
	})

	it("should prepare the same item from a call site as from the declaration", () => {
		let source = [
			"implementation {",
			"\tfunction helper(_ value: Integer) -> Integer {",
			"\t\t<- value",
			"\t}",
			"",
			"\tfunction first() -> Integer {",
			"\t\t<- helper(1)",
			"\t}",
			"}",
		].join("\n")

		expect(prepare(source, { line: 7, column: 8 })).toEqual(
			prepare(source, { line: 2, column: 11 }),
		)
	})

	it("should prepare nothing on a Constant, even one holding a Function", () => {
		let source = [
			"implementation {",
			"\tconstant total = 1",
			"\tconstant double = (_ value: Integer) -> Integer {",
			"\t\t<- value::add(value)",
			"\t}",
			"",
			"\tTerminal.inspect(double(total)::toString())",
			"}",
		].join("\n")

		expect(prepare(source, { line: 2, column: 12 })).toBeNull()
		expect(prepare(source, { line: 3, column: 12 })).toBeNull()
	})

	it("should report incoming calls per calling Function and from the top level", () => {
		let source = [
			"implementation {",
			"\tfunction helper(_ value: Integer) -> Integer {",
			"\t\t<- value",
			"\t}",
			"",
			"\tfunction first() -> Integer {",
			"\t\t<- helper(1)",
			"\t}",
			"",
			"\tfunction second() -> Integer {",
			"\t\t<- helper(2)::add(helper(3))",
			"\t}",
			"",
			"\tTerminal.inspect(helper(4)::toString())",
			"}",
		].join("\n")

		expect(summarise(incoming(source, { line: 2, column: 11 }))).toEqual([
			{ name: "first", kind: "function", container: null, calls: 1 },
			{ name: "second", kind: "function", container: null, calls: 2 },
			{
				name: "implementation",
				kind: "implementation",
				container: null,
				calls: 1,
			},
		])
	})

	it("should report outgoing calls to a Function and to a Method, skipping builtins", () => {
		let source = [
			"implementation {",
			"\tfunction helper(_ value: Integer) -> Integer {",
			"\t\t<- value",
			"\t}",
			"",
			"\tnamespace Doubler for Integer {",
			"\t\tdouble() -> Integer {",
			"\t\t\t<- @::add(@)",
			"\t\t}",
			"\t}",
			"",
			"\tfunction caller(_ value: Integer) -> Integer {",
			"\t\t<- helper(value::double())::add(1)",
			"\t}",
			"}",
		].join("\n")

		// NOTE: `add` is a standard library Method — it has no Declaration in
		// this document, so there is nothing to expand and it is left out.
		expect(summarise(outgoing(source, { line: 12, column: 11 }))).toEqual([
			{ name: "helper", kind: "function", container: null, calls: 1 },
			{
				name: "double",
				kind: "method",
				container: "Doubler",
				calls: 1,
			},
		])
	})

	it("should report a static Method called through its Namespace name", () => {
		let source = [
			"implementation {",
			"\tnamespace Greetings {",
			"\t\tstatic fallback() -> String {",
			'\t\t\t<- "Hello, stranger!"',
			"\t\t}",
			"",
			"\t\tstatic shout() -> String {",
			"\t\t\t<- Greetings.fallback()",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(summarise(incoming(source, { line: 3, column: 10 }))).toEqual([
			{
				name: "shout",
				kind: "staticMethod",
				container: "Greetings",
				calls: 1,
			},
		])
	})

	it("should aggregate calls across an Overload set", () => {
		let source = [
			"implementation {",
			"\tnamespace Combiner for Integer {",
			"\t\toverload combine {",
			"\t\t\t(_ other: Integer) -> Integer {",
			"\t\t\t\t<- @::add(other)",
			"\t\t\t}",
			"",
			"\t\t\t(_ other: Integer, _ third: Integer) -> Integer {",
			"\t\t\t\t<- @::add(other)::add(third)",
			"\t\t\t}",
			"\t\t}",
			"\t}",
			"",
			"\tfunction useBoth(_ value: Integer) -> Integer {",
			"\t\t<- value::combine(1)::combine(2, 3)",
			"\t}",
			"}",
		].join("\n")

		// NOTE: Both Overloads share one name and therefore one Declaration —
		// one item, both calls, exactly as renaming treats them.
		let calls = incoming(source, { line: 3, column: 12 })

		expect(summarise(calls)).toEqual([
			{
				name: "useBoth",
				kind: "function",
				container: null,
				calls: 2,
			},
		])

		expect(calls[0].ranges.map((range) => range.start)).toEqual([
			{ line: 15, column: 13 },
			{ line: 15, column: 25 },
		])
	})

	it("should report a recursive Function as its own caller and callee", () => {
		let source = [
			"implementation {",
			"\tfunction countdown(_ value: Integer) -> Integer {",
			"\t\tif value::isLessThan(1) {",
			"\t\t\t<- 0",
			"\t\t}",
			"",
			"\t\t<- countdown(value::subtract(1))",
			"\t}",
			"}",
		].join("\n")

		expect(summarise(incoming(source, { line: 2, column: 11 }))).toEqual([
			{ name: "countdown", kind: "function", container: null, calls: 1 },
		])

		expect(summarise(outgoing(source, { line: 2, column: 11 }))).toEqual([
			{ name: "countdown", kind: "function", container: null, calls: 1 },
		])
	})

	it("should see a call made inside a Match Guard", () => {
		let source = [
			"implementation {",
			"\tfunction isBig(_ value: Integer) -> Boolean {",
			"\t\t<- value::isGreaterThan(100)",
			"\t}",
			"",
			"\tfunction describe(_ value: Integer) -> String {",
			"\t\t<- match value -> String {",
			'\t\t\tcase Integer where isBig(value) { <- "big" }',
			'\t\t\tcase Integer { <- "small" }',
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		let calls = incoming(source, { line: 2, column: 11 })

		expect(summarise(calls)).toEqual([
			{ name: "describe", kind: "function", container: null, calls: 1 },
		])

		expect(calls[0].ranges[0].start).toEqual({ line: 8, column: 23 })
	})

	it("should attribute a call inside a Function value to the enclosing named caller", () => {
		let source = [
			"implementation {",
			"\tfunction helper(_ value: Integer) -> Integer {",
			"\t\t<- value",
			"\t}",
			"",
			"\tfunction outer() -> Integer {",
			"\t\tconstant twice = (_ value: Integer) -> Integer {",
			"\t\t\t<- helper(value)",
			"\t\t}",
			"",
			"\t\t<- twice(2)",
			"\t}",
			"}",
		].join("\n")

		expect(summarise(incoming(source, { line: 2, column: 11 }))).toEqual([
			{ name: "outer", kind: "function", container: null, calls: 1 },
		])
	})

	it("should attribute a call in a Namespace Property initialiser to the Property", () => {
		let source = [
			"implementation {",
			"\tfunction seedValue() -> Integer {",
			"\t\t<- 1",
			"\t}",
			"",
			"\tnamespace Holder {",
			"\t\tstatic seed = seedValue()",
			"\t}",
			"}",
		].join("\n")

		expect(summarise(incoming(source, { line: 2, column: 11 }))).toEqual([
			{
				name: "seed",
				kind: "property",
				container: "Holder",
				calls: 1,
			},
		])
	})

	it("should skip a Method dispatched on a Union receiver", () => {
		let source = [
			"implementation {",
			"\tnamespace Describer for Integer {",
			"\t\tdescribe() -> String {",
			'\t\t\t<- "a whole number"',
			"\t\t}",
			"\t}",
			"",
			"\tnamespace RationalDescriber for Rational {",
			"\t\tdescribe() -> String {",
			'\t\t\t<- "a fraction"',
			"\t\t}",
			"\t}",
			"",
			"\tconstant amount: Integer | Rational = 1",
			"\tconstant described = amount::describe()",
			"}",
		].join("\n")

		// NOTE: The dispatched call resolves per member Type, and its
		// `namespace` is a placeholder — see the NOTE on the Method Invocation
		// case in `callHierarchy.ts`.
		expect(incoming(source, { line: 3, column: 3 })).toEqual([])
	})
})

// NOTE: `= @::length()` IS a call, made by the Declaration the default is
// written on — so it is an outgoing call of that Method exactly as one written
// in the body is.
describe("Call Hierarchy of a call written in a default", () => {
	let source = [
		"implementation {",
		"\tfunction length() -> Integer {",
		"\t\t<- 4",
		"\t}",
		"",
		"\tfunction upTo(_ end: Integer = length()) -> Integer {",
		"\t\t<- end",
		"\t}",
		"}",
	].join("\n")

	it("lists it among the caller's outgoing calls", () => {
		expect(summarise(outgoing(source, { line: 6, column: 11 }))).toEqual([
			{ name: "length", kind: "function", container: null, calls: 1 },
		])
	})

	it("lists the caller among the callee's incoming calls", () => {
		expect(summarise(incoming(source, { line: 2, column: 11 }))).toEqual([
			{ name: "upTo", kind: "function", container: null, calls: 1 },
		])
	})
})
