import { describe, expect, it } from "bun:test"

import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"

import { findInlayHints } from "../inlayHints"

function allHintsOf(source: string) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findInlayHints(enrichedProgram)
}

// NOTE: What a Hint SHOWS. The `textEdit` every Hint carries is asserted on
// its own further down rather than repeated in each expectation here.
function hintsOf(source: string) {
	return allHintsOf(source).map((hint) => ({
		position: hint.position,
		label: hint.label,
		kind: hint.kind,
	}))
}

// NOTE: Applied back to front, so that an earlier insertion on a line does not
// shift the column a later one was measured at.
function applyHints(source: string): string {
	let lines = source.split("\n")
	let edits = allHintsOf(source)
		.map((hint) => hint.textEdit)
		.sort(
			(a, b) =>
				b.position.line - a.position.line ||
				b.position.column - a.position.column,
		)

	for (let edit of edits) {
		let index = edit.position.line - 1
		let column = edit.position.column - 1
		let line = lines[index] ?? ""

		lines[index] = line.slice(0, column) + edit.newText + line.slice(column)
	}

	return lines.join("\n")
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
		// line — repeat it beside the name is noise the width of a Type.
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
				'\t\t<- "none"',
				"\t})",
				"}",
			].join("\n")

			let labels = hintsOf(source).map((hint) => hint.label)

			expect(labels).toContain(" -> Number | String")
			expect(labels).toContain(": Number | String")
		})

		// NOTE: A Guard is where a contextually typed literal is hardest to
		// read back — `@` is narrowed by the Matcher, so the literal's Types
		// come from a signature the line does not mention.
		it("should annotate a Function literal inside a Match Guard", () => {
			let source = [
				"implementation {",
				"\tconstant numbers: List<Integer> | String = [1, 2, 3]",
				"\tconstant label = match numbers -> String {",
				'\t\tcase List<Integer> where @::anyItem(where (item) { <- item::isGreaterThan(2) }) { <- "long" }',
				'\t\tcase List<Integer> { <- "short" }',
				"\t\tcase String { <- @ }",
				"\t}",
				"}",
			].join("\n")

			expect(hintsOf(source)).toEqual([
				{
					position: { line: 3, column: 16 },
					label: ": String",
					kind: "type",
				},
				{
					position: { line: 4, column: 50 },
					label: ": Integer",
					kind: "type",
				},
				{
					position: { line: 4, column: 51 },
					label: " -> Boolean",
					kind: "type",
				},
			])
		})
	})

	describe("Optional", () => {
		it("should substitute the applied spelling along with the members", () => {
			let source = [
				"implementation {",
				"\tnamespace Firsts<infer Item> for List<Item> {",
				"\t\tmaybeFirst() -> Optional<Item> {",
				"\t\t\t<- #Empty",
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
				"\tconstant half = 1110::divide(by 2)",
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
				"\tconstant maybe: Optional<Integer> = #Empty",
				"\tconstant certain = maybe::otherwise(0)",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toContain(
				": Integer",
			)
		})

		it("should not resolve `otherwise` on a flat spelled-out Union", () => {
			// NOTE: `Optional` is a nominal Choice, not a second spelling of
			// `… | Nothing`, so `otherwise` is a Method of that Choice and of
			// nothing else. A hand-written Union that merely CONTAINS `Nothing`
			// never reaches it — a Method called on a Union has to be a Method
			// of every member, and `Integer` has none — so `sure` is left
			// without a Type and takes no Hint at all. The same payload wrapped
			// in an `Optional` collapses to `Integer | Rational` exactly as it
			// always did, which is the one Hint expected below: the collapse
			// did not go away, the accidental Union-shaped spelling of it did.
			let source = [
				"implementation {",
				"\tconstant flat: Integer | Rational | Nothing = 1",
				"\tconstant sure = flat::otherwise(0)",
				"\tconstant wrapped: Optional<Integer | Rational> = #Empty",
				"\tconstant collapsed = wrapped::otherwise(0)",
				"}",
			].join("\n")

			expect(hintsOf(source)).toEqual([
				{
					position: { line: 5, column: 20 },
					label: ": Integer | Rational",
					kind: "type",
				},
			])
		})

		it("should not resolve `otherwise` on a named member of a wider Union", () => {
			// NOTE: This test used to be about a `Nothing` BURIED inside a
			// named Alias: `type MaybeInt = Integer | Nothing` as a member of
			// `MaybeInt | Rational`, where a remainder fallback let the
			// `Nothing` an `otherwise` expected claim the buried one and typed
			// the payload as `Integer | Rational`. Neither the Type nor the
			// fallback exists — there is no Union SHAPE that means "fallible"
			// any more, only the Choice, and naming a Union does not make it
			// one. What is left worth pinning is the half that outlived them:
			// a named Alias keeps its name as a member of a wider Union, and
			// `otherwise` finds nothing to resolve against there. The one Hint
			// says both — `mixed` enriches and reads back under its own alias,
			// while `sure` gets none because the call did not resolve.
			let source = [
				"implementation {",
				"\ttype MaybeInt = Integer | String",
				"\tconstant mixed: MaybeInt | Rational = 1",
				"\tconstant echoed = mixed",
				"\tconstant sure = mixed::otherwise(0)",
				"}",
			].join("\n")

			expect(hintsOf(source)).toEqual([
				{
					position: { line: 4, column: 17 },
					label: ": MaybeInt | Rational",
					kind: "type",
				},
			])
		})

		it("should keep an `Optional` branch whole in a Union inferred from mixed branches", () => {
			// NOTE: One branch returns `Optional<Rational>`, the other a bare
			// Integer, and the inferred Union keeps the two side by side — the
			// Optional stays ONE nested member. Back when `Optional<X>` was an
			// Alias for a Union, the two branches dissolved into each other
			// and the Integer ended up sitting beside the missing case at the
			// top level; a nominal Choice has no shape to dissolve INTO. That
			// is what it buys: a Union cannot become fallible by accident, so
			// `merged` reads back as `Optional<Rational> | Integer` and has no
			// `otherwise` to call — `sure` gets no Type and no Hint. A value
			// that is fallible has to say so by being an `Optional` the whole
			// way out.
			let source = [
				"implementation {",
				"\tnamespace Picker for Integer {",
				"\t\tpick<infer Target>(_ transform: (_ value: Integer) -> Target) -> Target {",
				"\t\t\t<- transform(1)",
				"\t\t}",
				"\t}",
				"",
				"\tconstant merged = 1::pick((value) {",
				"\t\tif value::isGreaterThan(0) { <- value::divide(by 2) }",
				"",
				"\t\t<- value",
				"\t})",
				"\tconstant sure = merged::otherwise(0)",
				"}",
			].join("\n")

			expect(hintsOf(source)).toEqual([
				{
					position: { line: 8, column: 17 },
					label: ": Optional<Rational> | Integer",
					kind: "type",
				},
				{
					position: { line: 8, column: 34 },
					label: ": Integer",
					kind: "type",
				},
				{
					position: { line: 8, column: 35 },
					label: " -> Optional<Rational> | Integer",
					kind: "type",
				},
			])
		})

		it("should keep a compound payload whole — and `otherwise` collapses it", () => {
			// NOTE: The stdlib spells mixed fallible results as one nested
			// payload (`Optional<Integer | Rational>`), which is what lets
			// `otherwise` bind the payload in one piece.
			let source = [
				"implementation {",
				"\tconstant power = 2::raise(to -2)",
				"\tconstant sure = power::otherwise(0)",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toEqual([
				": Optional<Integer | Rational>",
				": Integer | Rational",
			])
		})
	})

	// NOTE: A Hint's label is the annotation the source left out, and the Hint
	// sits where that annotation belongs — which is what makes accepting one a
	// plain insertion rather than an inference of its own.
	describe("Accepting a Hint", () => {
		it("should insert its own label at its own position", () => {
			let source = [
				"implementation {",
				"\tconstant kept = [1]::removeEvery(where (item) { <- true })",
				"}",
			].join("\n")

			let hints = allHintsOf(source)

			expect(hints.map((hint) => hint.label)).toEqual([
				": List<Integer>",
				": Integer",
				" -> Boolean",
			])

			for (let hint of hints) {
				expect(hint.textEdit).toEqual({
					position: hint.position,
					newText: hint.label,
				})
			}
		})

		it("should leave a source that needs no Hints at all", () => {
			let source = [
				"implementation {",
				"\tconstant kept = [1]::removeEvery(where (item) { <- true })",
				"}",
			].join("\n")

			expect(applyHints(source)).toBe(
				[
					"implementation {",
					"\tconstant kept: List<Integer> = [1]::removeEvery(where (item: Integer) -> Boolean { <- true })",
					"}",
				].join("\n"),
			)
			expect(hintsOf(applyHints(source))).toEqual([])
		})

		it("should annotate the underscore spelling after the name", () => {
			let source = [
				"implementation {",
				"\tconstant kept = [1]::removeEvery(where (_ item) { <- true })",
				"}",
			].join("\n")

			expect(applyHints(source)).toContain("(_ item: Integer) -> Boolean")
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
