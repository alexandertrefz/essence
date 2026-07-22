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
				"\tconstant describe = (_ value: Integer) { <- value::toString() }",
				"}",
			].join("\n")

			expect(
				hintsOf(source).filter((hint) => hint.label === " -> String"),
			).toHaveLength(1)
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
