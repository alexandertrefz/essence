import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher/index"
import { findInlayHints } from "../lsp/inlayHints"
import { parseWithDiagnostics } from "../parser/index"

function hintsOf(source: string) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findInlayHints(enrichedProgram)
}

describe("Inlay Hints", () => {
	it("should annotate an unannotated Constant with its inferred Type", () => {
		let source = ["implementation {", '\tconstant name = "Ada"', "}"].join(
			"\n",
		)

		expect(hintsOf(source)).toEqual([
			{
				position: { line: 2, column: 15 },
				label: ": String",
				kind: "type",
			},
		])
	})

	it("should not annotate a Constant that is already annotated", () => {
		let source = [
			"implementation {",
			'\tconstant name: String = "Ada"',
			"}",
		].join("\n")

		expect(hintsOf(source)).toEqual([])
	})

	it("should not annotate a Function literal that annotates itself", () => {
		// NOTE: The literal already spells the whole signature out on the same
		// line — repeating it beside the name is noise the width of a Type.
		let source = [
			"implementation {",
			"\tconstant halve = (_ value: Integer) -> Integer { <- value }",
			"}",
		].join("\n")

		expect(hintsOf(source)).toEqual([])
	})

	it("should annotate an inferred Record Type", () => {
		let source = [
			"implementation {",
			'\tconstant person = { firstName = "Ada" }',
			"}",
		].join("\n")

		expect(hintsOf(source)[0].label).toBe(": { firstName: String }")
	})

	it("should annotate declarations inside Function bodies", () => {
		let source = [
			"implementation {",
			"\tfunction greet (subject: String) -> String {",
			"\t\tconstant greeting = subject",
			"\t\t<- greeting",
			"\t}",
			"}",
		].join("\n")

		expect(hintsOf(source)).toEqual([
			{
				position: { line: 3, column: 20 },
				label: ": String",
				kind: "type",
			},
		])
	})

	// NOTE: Parameter name hints are deliberately absent — a labelled
	// Parameter requires its label at the call site, and a label-less one has
	// no name to show, so a hint could only ever repeat what is already there.
	it("should not annotate Arguments of a labelled call", () => {
		let source = [
			"implementation {",
			"\tfunction greet (subject: String) -> String {",
			"\t\t<- subject",
			"\t}",
			'\tconstant greeting = greet(subject "World")',
			"}",
		].join("\n")

		expect(hintsOf(source).map((hint) => hint.label)).toEqual([": String"])
	})

	it("should not annotate a declaration whose Type could not be inferred", () => {
		let source = [
			"implementation {",
			"\tconstant broken = missingName",
			"}",
		].join("\n")

		expect(hintsOf(source)).toEqual([])
	})

	// NOTE: A contextually typed Function literal shows neither its Parameter
	// Types nor its return Type anywhere in the source — they come from the
	// signature it is passed to — which is exactly what a Hint is for.
	describe("Contextual Function literals", () => {
		it("should annotate an inferred Parameter and return Type", () => {
			let source = [
				"implementation {",
				"\tconstant kept = [1]::removeEvery(where (item) { <- true })",
				"}",
			].join("\n")

			expect(hintsOf(source)).toEqual([
				{
					position: { line: 2, column: 15 },
					label: ": List<Integer>",
					kind: "type",
				},
				{
					position: { line: 2, column: 46 },
					label: ": Integer",
					kind: "type",
				},
				{
					position: { line: 2, column: 47 },
					label: " -> Boolean",
					kind: "type",
				},
			])
		})

		it("should annotate the underscore spelling too", () => {
			let source = [
				"implementation {",
				"\tconstant kept = [1]::removeEvery(where (_ item) { <- true })",
				"}",
			].join("\n")

			expect(
				hintsOf(source).filter((hint) => hint.label === ": Integer"),
			).toHaveLength(1)
		})

		it("should not annotate what the source already writes", () => {
			let source = [
				"implementation {",
				"\tconstant kept: List<Integer> = [1]::removeEvery(",
				"\t\twhere (_ item: Integer) -> Boolean { <- true },",
				"\t)",
				"}",
			].join("\n")

			expect(hintsOf(source)).toEqual([])
		})

		it("should annotate a return Type inferred from the body", () => {
			let source = [
				"implementation {",
				"\tnamespace Mapper<infer Item> for List<Item> {",
				"\t\ttransformFirst<infer Target>(",
				"\t\t\t_ transform: (_ item: Item) -> Target,",
				"\t\t) -> Target {",
				"\t\t\t<- transform(1)",
				"\t\t}",
				"\t}",
				"",
				"\tconstant described = [1]::transformFirst((value) {",
				"\t\t<- value::toString()",
				"\t})",
				"}",
			].join("\n")

			expect(
				hintsOf(source).filter((hint) => hint.label === " -> String"),
			).toHaveLength(1)
		})

		it("should keep `Number` by name in a return Type inferred from branches", () => {
			let source = [
				"implementation {",
				"\tnamespace Picker for Number {",
				"\t\tpick<infer Target>(",
				"\t\t\t_ transform: (_ value: Number) -> Target,",
				"\t\t) -> Target {",
				"\t\t\t<- transform(1)",
				"\t\t}",
				"\t}",
				"",
				"\tconstant value: Number = 1",
				"\tconstant picked = value::pick((item) {",
				"\t\tif item::isGreaterThan(0) { <- item }",
				"",
				"\t\t<- nothing",
				"\t})",
				"}",
			].join("\n")

			let labels = hintsOf(source).map((hint) => hint.label)

			expect(labels).toContain(" -> Number | Nothing")
			expect(labels).toContain(": Number | Nothing")
		})
	})

	describe("Optional", () => {
		it("should substitute the applied spelling along with the members", () => {
			let source = [
				"implementation {",
				"\tnamespace Firsts<infer Item> for List<Item> {",
				"\t\tmaybeFirst() -> Optional<Item> {",
				"\t\t\t<- nothing",
				"\t\t}",
				"\t}",
				"",
				"\tconstant found = [1]::maybeFirst()",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toContain(
				": Optional<Integer>",
			)
		})

		it("should describe builtin fallible Methods as `Optional`", () => {
			let source = [
				"implementation {",
				"\tconstant half = 1110::divideBy(2)",
				"\tconstant first = [1, 2, 3]::firstItem()",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toEqual([
				": Optional<Rational>",
				": Optional<Integer>",
			])
		})

		it("should resolve `otherwise` on an `Optional`-annotated value", () => {
			let source = [
				"implementation {",
				"\tconstant maybe: Optional<Integer> = nothing",
				"\tconstant certain = maybe::otherwise(0)",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toContain(
				": Integer",
			)
		})

		it("should resolve `otherwise` on a flat spelled-out Union", () => {
			// NOTE: Unions are built canonical — `Integer | Rational | Nothing`
			// carries its payload as one nested member, so `otherwise` binds
			// it in one piece even when the source spells the Union out flat.
			let source = [
				"implementation {",
				"\tconstant flat: Integer | Rational | Nothing = 1",
				"\tconstant sure = flat::otherwise(0)",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toEqual([
				": Integer | Rational",
			])
		})

		it("should resolve `otherwise` when Nothing hides inside a named member", () => {
			// NOTE: `MaybeInt` keeps its name — and its buried `Nothing` — as
			// a member of the wider Union. The remainder fallback lets the
			// expected `Nothing` claim it, so `otherwise` still resolves and
			// types the payload as `Integer | Rational`.
			let source = [
				"implementation {",
				"\ttype MaybeInt = Integer | Nothing",
				"\tconstant mixed: MaybeInt | Rational = 1",
				"\tconstant sure = mixed::otherwise(0)",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toEqual([
				": Integer | Rational",
			])
		})

		it("should resolve `otherwise` on a Union inferred from mixed branches", () => {
			// NOTE: One branch returns `Optional<Rational>`, the other a bare
			// Integer — the inferred Union hoists the Optional's `Nothing` to
			// the top level, so the result stays fallible-shaped.
			let source = [
				"implementation {",
				"\tnamespace Picker for Integer {",
				"\t\tpick<infer Target>(_ transform: (_ value: Integer) -> Target) -> Target {",
				"\t\t\t<- transform(1)",
				"\t\t}",
				"\t}",
				"",
				"\tconstant merged = 1::pick((value) {",
				"\t\tif value::isGreaterThan(0) { <- value::divideBy(2) }",
				"",
				"\t\t<- value",
				"\t})",
				"\tconstant sure = merged::otherwise(0)",
				"}",
			].join("\n")

			let labels = hintsOf(source).map((hint) => hint.label)

			expect(labels).toContain(": Rational | Integer | Nothing")
			expect(labels).toContain(": Rational | Integer")
		})

		it("should keep a compound payload whole — and `otherwise` collapses it", () => {
			// NOTE: The stdlib spells mixed fallible results as one nested
			// payload (`Optional<Integer | Rational>`), which is what lets
			// `otherwise` bind the payload in one piece.
			let source = [
				"implementation {",
				"\tconstant power = 2::toThePowerOf(-2)",
				"\tconstant sure = power::otherwise(0)",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toEqual([
				": Optional<Integer | Rational>",
				": Integer | Rational",
			])
		})
	})

	it("should restrict Hints to the requested line range", () => {
		let source = [
			"implementation {",
			"\tconstant first = 1",
			"\tconstant second = 2",
			"\tconstant third = 3",
			"}",
		].join("\n")

		let { program } = parseWithDiagnostics(source)
		let { program: enrichedProgram } = enrich(program)

		let hints = findInlayHints(enrichedProgram, {
			start: { line: 3, column: 1 },
			end: { line: 3, column: 1 },
		})

		expect(hints).toHaveLength(1)
		expect(hints[0].position.line).toBe(3)
	})
})
