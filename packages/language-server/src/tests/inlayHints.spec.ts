import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/documents"
import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import type { common } from "@essence-lang/interfaces"
import type { InlayHint as LspInlayHint } from "vscode-languageserver"
import {
	InlayHintRequest,
	InlayHintResolveRequest,
} from "vscode-languageserver/node"

import { analyseDocument } from "../analyse"
import { findInlayHints, type InlayHint } from "../inlayHints"
import { toLspInlayHint, uriOf } from "../server"
import { makeSessionWorkspace, startSession } from "./lspSession"
import { applyEdits } from "./textEdits"

function allHintsOf(source: string) {
	let { program } = parseWithDiagnostics(source)
	let { program: enrichedProgram } = enrich(program)

	return findInlayHints(enrichedProgram)
}

// What a Hint shows. The `textEdit` each Hint carries is asserted in the
// "Accepting a Hint" specs.
function hintsOf(source: string) {
	return allHintsOf(source).map((hint) => ({
		position: hint.position,
		label: hint.label,
		kind: hint.kind,
	}))
}

// Every Hint accepted at once, each with the label edit it carries.
function applyHints(source: string): string {
	return accepted(source, allHintsOf(source))
}

function accepted(source: string, hints: Array<InlayHint>): string {
	return applyEdits(
		source,
		hints.flatMap((hint) =>
			hint.textEdit === null
				? []
				: [
						...(hint.textEdit.labelEdit === undefined
							? []
							: [hint.textEdit.labelEdit]),
						{
							range: {
								start: hint.textEdit.position,
								end: hint.textEdit.position,
							},
							newText: hint.textEdit.newText,
						},
					],
		),
	)
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
		// The literal already spells the whole signature out on the same line,
		// so repeating it beside the name is noise.
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

	// A Hint is offered as an applied edit, so what it shows must parse back
	// as what it says. `Standing` does wherever the Alias is in scope.
	it("should annotate a Record reached through its Alias by name", () => {
		let source = [
			"implementation {",
			"\ttype Standing = { played: Integer, points: Integer }",
			"",
			"\tfunction blank() -> Standing {",
			"\t\t<- { played = 0, points = 0 }",
			"\t}",
			"",
			"\tconstant start = blank()",
			"}",
		].join("\n")

		expect(
			hintsOf(source).filter((hint) => hint.position.line === 8),
		).toEqual([
			{
				position: { line: 8, column: 16 },
				label: ": Standing",
				kind: "type",
			},
		])
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

	it("should annotate declarations inside a Protocol-provided Method body", () => {
		let source = [
			"implementation {",
			"\tprotocol Ranked {",
			"\t\tisAbove(_ mark: Integer) -> Boolean",
			"",
			"\t\tisAtMost(_ mark: Integer) -> Boolean {",
			"\t\t\tconstant flipped = @::isAbove(mark)::negate()",
			"\t\t\t<- flipped",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(hintsOf(source)).toEqual([
			{
				position: { line: 6, column: 20 },
				label: ": Boolean",
				kind: "type",
			},
		])
	})

	// Parameter name hints are deliberately absent. A labelled Parameter
	// requires its label at the call site, and a label-less one has no name.
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

	// An Error anywhere in a Type was reported where it was written, and no
	// annotation can spell it.
	it("should not annotate a Type that holds an Error", () => {
		let source = [
			"implementation {",
			"\tnamespace Clock for Integer {",
			"\t\tstatic now() -> Integer {",
			"\t\t\t<- 7",
			"\t\t}",
			"\t}",
			"",
			"\tconstant settings = { Clock }",
			"\tconstant names = [missingName]",
			"\tconstant nested = [1]::map((item) { <- [missingName] })",
			"}",
		].join("\n")

		expect(hintsOf(source)).toEqual([
			{
				position: { line: 10, column: 34 },
				label: ": Integer",
				kind: "type",
			},
		])
	})

	// No Namespace is a value, so a Constant can not hold one and has no Type
	// to show. What it reads off the Namespace does.
	it("should not annotate a Constant written as a Namespace", () => {
		let source = [
			"implementation {",
			"\tnamespace Clock for Integer {",
			"\t\tstatic now() -> Integer {",
			"\t\t\t<- 7",
			"\t\t}",
			"\t}",
			"",
			"\tconstant clock = Clock",
			"\tconstant now = Clock.now()",
			"}",
		].join("\n")

		expect(hintsOf(source)).toEqual([
			{
				position: { line: 9, column: 14 },
				label: ": Integer",
				kind: "type",
			},
		])
	})

	// A contextually typed Function literal shows its Parameter and return
	// Types nowhere in the source, which is what a Hint is for.
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

		// In a Guard, `@` is narrowed by the Matcher, so the literal's Types come
		// from a signature the line does not mention.
		it("should annotate a Function literal inside a Match Guard", () => {
			let source = [
				"implementation {",
				"\tconstant numbers: List<Integer> | String = [1, 2, 3]",
				"\tconstant label = match numbers -> String {",
				'\t\tcase List<Integer> where @::hasItems(where (item) { <- item::isGreaterThan(2) }) { <- "long" }',
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
					position: { line: 4, column: 51 },
					label: ": Integer",
					kind: "type",
				},
				{
					position: { line: 4, column: 52 },
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

		// The divisor is computed, since a written `2` proves it is not zero
		// and reaches `divide`'s total entry, as `sure` shows. `numbers` is
		// annotated because a written List proves it holds an item.
		it("should describe builtin fallible Methods as `Optional`", () => {
			let source = [
				"implementation {",
				"\tconstant two = 3::subtract(1)",
				"\tconstant numbers: List<Integer> = [1, 2, 3]",
				"\tconstant half = 1110::divide(by two)",
				"\tconstant sure = 1110::divide(by 2)",
				"\tconstant first = numbers::firstItem()",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toEqual([
				": Integer",
				": Optional<Rational>",
				": NonZeroRational",
				": Optional<Integer>",
			])
		})

		it("should resolve `value(defaultingTo:)` on an `Optional`-annotated value", () => {
			let source = [
				"implementation {",
				"\tconstant maybe: Optional<Integer> = #Empty",
				"\tconstant certain = maybe::value(defaultingTo 0)",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toContain(
				": Integer",
			)
		})

		it("should not resolve `value(defaultingTo:)` on a flat spelled-out Union", () => {
			// `value(defaultingTo:)` is a Method of the `Optional` Choice alone, and
			// a Method called on a Union must be one of every member. So `sure` gets
			// no Hint, and the wrapped payload collapses to `Integer | Rational`.
			let source = [
				"implementation {",
				"\tconstant flat: Integer | Rational = 1",
				"\tconstant sure = flat::value(defaultingTo 0)",
				"\tconstant wrapped: Optional<Integer | Rational> = #Empty",
				"\tconstant collapsed = wrapped::value(defaultingTo 0)",
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

		it("should not resolve `value(defaultingTo:)` on a named member of a wider Union", () => {
			// A named Alias keeps its name as a member of a wider Union, so
			// `echoed` reads back under it. Naming a Union does not make it
			// fallible, so `sure` gets no Hint.
			let source = [
				"implementation {",
				"\ttype MaybeInt = Integer | String",
				"\tconstant mixed: MaybeInt | Rational = 1",
				"\tconstant echoed = mixed",
				"\tconstant sure = mixed::value(defaultingTo 0)",
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
			// The inferred Union keeps the `Optional` branch as one member, so a
			// Union is never fallible by accident and `sure` gets no Hint. The
			// divisor is computed to keep that branch fallible.
			let source = [
				"implementation {",
				"\tnamespace Picker for Integer {",
				"\t\tpick<infer Target>(_ transform: (_ value: Integer) -> Target) -> Target {",
				"\t\t\t<- transform(1)",
				"\t\t}",
				"\t}",
				"",
				"\tconstant merged = 1::pick((value) {",
				"\t\tif value::isGreaterThan(0) { <- value::divide(by 4::subtract(2)) }",
				"",
				"\t\t<- value",
				"\t})",
				"\tconstant sure = merged::value(defaultingTo 0)",
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

		it("should keep a compound payload whole — and `value(defaultingTo:)` collapses it", () => {
			// The standard library writes a mixed fallible result as one nested
			// payload, which `value(defaultingTo:)` binds whole. The base is
			// computed, since a written base proves it is not zero and needs no
			// wrapper.
			let source = [
				"implementation {",
				"\tconstant two = 3::subtract(1)",
				"\tconstant power = two::raise(to -2)",
				"\tconstant sure = power::value(defaultingTo 0)",
				"}",
			].join("\n")

			expect(hintsOf(source).map((hint) => hint.label)).toEqual([
				": Integer",
				": Optional<Integer | Rational>",
				": Integer | Rational",
			])
		})
	})

	// A Hint's label is the annotation the source left out, and the Hint sits
	// where it belongs, so accepting one inserts it. A Function literal's
	// Parameter also writes its label, which `(item: Integer)` would change.
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
				expect(hint.textEdit).toMatchObject({
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
					"\tconstant kept: List<Integer> = [1]::removeEvery(where (_ item: Integer) -> Boolean { <- true })",
					"}",
				].join("\n"),
			)
			expect(hintsOf(applyHints(source))).toEqual([])
			expect(analyseDocument(applyHints(source)).diagnostics).toEqual([])
		})

		it("should annotate the underscore spelling after the name", () => {
			let source = [
				"implementation {",
				"\tconstant kept = [1]::removeEvery(where (_ item) { <- true })",
				"}",
			].join("\n")

			expect(applyHints(source)).toContain("(_ item: Integer) -> Boolean")
		})

		it("should hand an editor the label edit with the annotation", () => {
			let source = [
				"implementation {",
				"\tconstant kept = [1]::removeEvery(where (item) { <- true })",
				"}",
			].join("\n")
			let parameterHint = allHintsOf(source).find(
				(hint) => hint.label === ": Integer",
			) as InlayHint

			expect(toLspInlayHint(parameterHint).textEdits).toEqual([
				{
					range: {
						start: { line: 1, character: 41 },
						end: { line: 1, character: 41 },
					},
					newText: "_ ",
				},
				{
					range: {
						start: { line: 1, character: 45 },
						end: { line: 1, character: 45 },
					},
					newText: ": Integer",
				},
			])
		})

		it("should keep a Method literal's Parameter a name", () => {
			let source = [
				"implementation {",
				'\tconstant loans = ["grace" = 1]',
				'\tconstant updated = loans::update(at "grace", with (count) { <- count::add(1) })',
				"}",
			].join("\n")

			expect(applyHints(source).split("\n")[2]).toBe(
				'\tconstant updated: Dictionary<String, Integer> = loans::update(at "grace", with (_ count: Integer) -> Integer { <- count::add(1) })',
			)
			expect(analyseDocument(applyHints(source)).diagnostics).toEqual([])
		})

		// The signatures each literal in `acceptedLiteral` takes its Types and
		// labels from.
		const signatures = [
			"implementation {",
			"\tfunction discount(using rule: (on: Integer) -> Integer) -> Integer {",
			"\t\t<- rule(on 100)",
			"\t}",
			"",
			"\tfunction shaped(using rule: (_: { a: Integer }) -> Integer) -> Integer {",
			"\t\t<- rule({ a = 1 })",
			"\t}",
			"",
			"\tfunction shapedOn(using rule: (on: { a: Integer }) -> Integer) -> Integer {",
			"\t\t<- rule(on { a = 1 })",
			"\t}",
			"",
		]

		// The literal on its own line, annotated, and whether the result
		// compiles.
		function acceptedLiteral(literal: string) {
			let source = [
				...signatures,
				`\tconstant x: Integer = ${literal}`,
				"}",
			].join("\n")
			let result = applyHints(source)

			return {
				literal: result
					.split("\n")
					[signatures.length]?.slice(
						"\tconstant x: Integer = ".length,
					),
				diagnostics: analyseDocument(result).diagnostics,
			}
		}

		it("should write the label the expected signature gives", () => {
			expect(
				acceptedLiteral("discount(using (price) { <- price })"),
			).toEqual({
				literal:
					"discount(using (on price: Integer) -> Integer { <- price })",
				diagnostics: [],
			})
			expect(
				acceptedLiteral("discount(using (_ price) { <- price })"),
			).toEqual({
				literal:
					"discount(using (on price: Integer) -> Integer { <- price })",
				diagnostics: [],
			})
		})

		it("should write no second label where the name is the label", () => {
			expect(acceptedLiteral("discount(using (on) { <- on })")).toEqual({
				literal: "discount(using (on: Integer) -> Integer { <- on })",
				diagnostics: [],
			})
		})

		it("should label a Pattern Parameter as the signature does", () => {
			expect(acceptedLiteral("shaped(using ({ a }) { <- a })")).toEqual({
				literal:
					"shaped(using (_ { a }: { a: Integer }) -> Integer { <- a })",
				diagnostics: [],
			})
			expect(acceptedLiteral("shapedOn(using ({ a }) { <- a })")).toEqual(
				{
					literal:
						"shapedOn(using (on { a }: { a: Integer }) -> Integer { <- a })",
					diagnostics: [],
				},
			)
			expect(
				acceptedLiteral("shapedOn(using (on { a }) { <- a })"),
			).toEqual({
				literal:
					"shapedOn(using (on { a }: { a: Integer }) -> Integer { <- a })",
				diagnostics: [],
			})
		})

		// A bare `_` keeps its `_` and binds no name, so only the label is
		// written before it.
		it("should label a bare `_` as the signature does", () => {
			expect(acceptedLiteral("discount(using (_) { <- 1 })")).toEqual({
				literal: "discount(using (on _: Integer) -> Integer { <- 1 })",
				diagnostics: [],
			})
		})

		it("should keep a bare `_` without a label", () => {
			let source = [
				"implementation {",
				"\tconstant ones: List<Integer> = [1]::map((_) { <- 1 })",
				"}",
			].join("\n")
			let hints = allHintsOf(source)

			expect(hints.map((hint) => hint.label)).toEqual([
				": Integer",
				" -> Integer",
			])
			expect(applyHints(source).split("\n")[1]).toBe(
				"\tconstant ones: List<Integer> = [1]::map((_: Integer) -> Integer { <- 1 })",
			)
			expect(analyseDocument(applyHints(source)).diagnostics).toEqual([])
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

// Spelling a Type is what a Hint costs, and a whole-file request would spell
// every one. A client that resolves edits gets the Hints unspelled, and each
// edit is spelled when it is resolved.
describe("Inlay Hints spelled on resolve", () => {
	const source = [
		"implementation {",
		"\tchoice Colour { Red, Green }",
		"\ttype Point = { x: Integer, y: Integer }",
		"",
		"\tfunction origin() -> Point {",
		"\t\t<- { x = 0, y = 0 }",
		"\t}",
		"",
		"\tconstant point = origin()",
		"\tconstant colour = Colour#Red",
		"\tconstant kept = [1]::removeEvery(where (item) { <- true })",
		"\tconstant every = [1]::removeEvery(where (_) { <- true })",
		"}",
	].join("\n")

	it("makes no Type Hint's edit on an unspelled request", () => {
		let { program } = parseWithDiagnostics(source)
		let { program: enrichedProgram } = enrich(program)
		let spelled = findInlayHints(enrichedProgram)
		let unspelled = findInlayHints(enrichedProgram, null, false)

		expect(unspelled.map((hint) => hint.label)).toEqual(
			spelled.map((hint) => hint.label),
		)
		expect(unspelled.every((hint) => hint.textEdit === null)).toBe(true)
		// A bare `_` is written `_: Integer` too, so every Type Hint waits.
		expect(unspelled.every((hint) => hint.unspelled === true)).toBe(true)
	})

	it("sends a whole file unspelled and spells each Hint as it is resolved", async () => {
		let files = makeSessionWorkspace({ "Main.es": source })
		let uri = uriOf(files.pathOf("Main.es"))
		let wholeFile = {
			textDocument: { uri },
			range: {
				start: { line: 0, character: 0 },
				end: { line: 13, character: 0 },
			},
		}
		let hintsFor = async (textDocument: object) => {
			let session = startSession()

			try {
				await session.initialize([files.root], undefined, textDocument)
				await session.open(files.pathOf("Main.es"), source)

				let { result } = await session.request<Array<LspInlayHint>>(
					InlayHintRequest.type,
					wholeFile,
				)
				let resolved: Array<LspInlayHint> = []

				for (let hint of result) {
					resolved.push(
						(
							await session.request<LspInlayHint>(
								InlayHintResolveRequest.type,
								hint,
							)
						).result,
					)
				}

				// `data` a client mangled leaves the Hint as it was.
				let mangled = await Promise.all(
					[null, "Main.es", { uri }].map(
						async (data) =>
							(
								await session.request<LspInlayHint>(
									InlayHintResolveRequest.type,
									{ ...result[0], data },
								)
							).result,
					),
				)

				return { sent: result, resolved, mangled }
			} finally {
				await session.dispose()
			}
		}

		try {
			let spelled = await hintsFor({})
			let unspelled = await hintsFor({
				inlayHint: { resolveSupport: { properties: ["textEdits"] } },
			})

			expect(unspelled.sent.map((hint) => hint.label)).toEqual(
				spelled.sent.map((hint) => hint.label),
			)
			expect(unspelled.sent.some((hint) => hint.textEdits)).toBe(false)
			expect(
				unspelled.resolved.map((hint) => hint.textEdits ?? null),
			).toEqual(spelled.sent.map((hint) => hint.textEdits ?? null))
			// A Hint sent with its edit resolves to itself.
			expect(spelled.resolved).toEqual(spelled.sent)
			expect(
				unspelled.mangled.map((hint) => hint.textEdits ?? null),
			).toEqual([null, null, null])
		} finally {
			files.dispose()
		}
	})
})

// An inferred-Type Hint sits at the end of a Parameter's Position, which never
// covers a default. A Hint written after `= 1` would not parse. Only a
// contextual Function literal omits a Type and only a Declaration carries a
// default, and these pin both halves.
describe("Inlay Hints beside a default", () => {
	it("writes no Parameter Hint where a Type and a default are both written", () => {
		let source = [
			"implementation {",
			"\tfunction scaled(_ factor: Integer = 2) -> Integer {",
			"\t\t<- factor",
			"\t}",
			"}",
		].join("\n")

		expect(hintsOf(source)).toEqual([])
	})

	it("anchors a literal's Parameter Hint at the name, default or not", () => {
		let source = [
			"implementation {",
			"\tfunction apply(_ transform: (_: Integer) -> Integer) -> Integer {",
			"\t\t<- transform(1)",
			"\t}",
			"",
			"\tconstant value = apply((item) { <- item })",
			"}",
		].join("\n")

		expect(hintsOf(source)).toEqual([
			{
				position: { line: 6, column: 16 },
				label: ": Integer",
				kind: "type",
			},
			{
				position: { line: 6, column: 30 },
				label: ": Integer",
				kind: "type",
			},
			{
				position: { line: 6, column: 31 },
				label: " -> Integer",
				kind: "type",
			},
		])
	})
})

// A Hint is also offered as a refactoring, so its text must parse back as the
// Type it names. A Method taken as a value has no defaults to print, and
// `printType` writes no `?`.
describe("An Inlay Hint for a defaulted signature read as a value", () => {
	it("writes a Type that parses back as itself", () => {
		let source = [
			"implementation {",
			"\tnamespace Scaling {",
			"\t\tstatic scaled(of value: Integer, by factor: Integer = 2) -> Integer {",
			"\t\t\t<- value::multiply(with factor)",
			"\t\t}",
			"\t}",
			"",
			"\tconstant scaled = Scaling.scaled",
			"}",
		].join("\n")

		let hints = hintsOf(source)

		expect(hints).toEqual([
			{
				position: { line: 8, column: 17 },
				label: ": (of: Integer, by: Integer) -> Integer",
				kind: "type",
			},
		])

		// Applied where it is offered, and parsed.
		let annotated = source.replace(
			"constant scaled = ",
			`constant scaled${hints[0]!.label} = `,
		)

		expect(parseWithDiagnostics(annotated).diagnostics).toEqual([])
	})
})

// An arm declares nothing, but a contextually typed Function literal written
// as an arm's value shows its Types nowhere in the source.
describe("Inlay Hints inside a define", () => {
	it("should annotate a contextual Function literal in an arm's value", () => {
		let source = [
			"implementation {",
			"\tconstant kept = define {",
			"\t\tas [1]::removeEvery(where (item) { <- true }) if true",
			"\t\tas [1] otherwise",
			"\t}",
			"}",
		].join("\n")

		let labels = hintsOf(source).map((hint) => hint.label)

		expect(labels).toContain(": Integer")
		expect(labels).toContain(" -> Boolean")
	})
})

// A Constant holding work reads as `Started<…>`, not as what it will answer.
// The Function literal under the Keyword is reached only through the walk's
// case for `start`.
describe("Inlay Hints around start and complete", () => {
	let source = [
		"implementation {",
		"\tfunction doubled(_ value: Integer) -> Future<Integer> {",
		"\t\t<- complete Async.deferred(() { <- value })",
		"\t}",
		"",
		"\tconstant answer = complete doubled(21)",
		"\tconstant running = start doubled(21)",
		"}",
	].join("\n")

	it("should annotate what each Keyword answers with", () => {
		let labels = hintsOf(source).map((hint) => hint.label)

		expect(labels).toContain(": Integer")
		expect(labels).toContain(": Started<Integer>")
	})

	it("should annotate a Function literal written under the Keyword", () => {
		expect(hintsOf(source)).toContainEqual({
			position: { line: 3, column: 32 },
			label: " -> Integer",
			kind: "type",
		})
	})
})

// A Hint's label names the Alias the Type was declared under, and its edit
// may write only a name the position resolves. Each spec applies the edit and
// analyses what it left behind.
describe("Inlay Hints that write a name", () => {
	let directories: Array<string> = []

	afterEach(() => {
		for (let directory of directories) {
			rmSync(directory, { recursive: true, force: true })
		}

		directories = []
	})

	function makeFiles(
		files: Record<string, string>,
	): (name: string) => string {
		let root = canonicalPath(
			mkdtempSync(path.join(tmpdir(), "essence-module-hints-")),
		)

		directories.push(root)

		for (let [name, contents] of Object.entries(files)) {
			writeFileSync(path.join(root, name), contents)
		}

		return (name: string) => canonicalPath(path.join(root, name))
	}

	// The Hints of a linked Module, the only way the import block's Types are
	// in the Program. Whether this file can write a name another file declares
	// depends on what it imported.
	function moduleHints(files: Record<string, string>, entry: string) {
		let pathOf = makeFiles(files)
		let filePath = pathOf(entry)
		let { enrichedProgram } = analyseDocument(
			files[entry] as string,
			filePath,
		)

		return {
			hints: findInlayHints(enrichedProgram as common.typed.Program),
			filePath,
		}
	}

	const shapes = [
		"implementation {",
		"\ttype Point = { x: Integer, y: Integer }",
		"\ttype Reading = Integer | String",
		"",
		"\tchoice Edge {",
		"\t\tLeft,",
		"\t\tRight,",
		"\t}",
		"",
		"\tfunction origin() -> Point {",
		"\t\t<- { x = 0, y = 0 }",
		"\t}",
		"",
		"\tfunction read() -> Reading {",
		"\t\t<- 1",
		"\t}",
		"",
		"\tfunction side() -> Edge {",
		"\t\t<- #Left",
		"\t}",
		"}",
		"",
		"export {",
		"\torigin",
		"\tread",
		"\tside",
		"}",
		"",
	].join("\n")

	it("should show an Alias it can not write and apply the shape instead", () => {
		let main = [
			"import {",
			'\tfrom "./Shapes.es" { origin }',
			"}",
			"",
			"implementation {",
			"\tconstant p = origin()",
			"",
			"\tTerminal.inspect(p.x)",
			"}",
			"",
		].join("\n")
		let { hints, filePath } = moduleHints(
			{ "Shapes.es": shapes, "Main.es": main },
			"Main.es",
		)

		expect(hints.map((hint) => hint.label)).toEqual([": Point"])
		expect(hints[0]?.textEdit?.newText).toBe(": { x: Integer, y: Integer }")
		expect(
			analyseDocument(accepted(main, hints), filePath).diagnostics,
		).toEqual([])
	})

	// A Union Alias goes the same way. Its arms are Types in their own right,
	// so the pipe list is a spelling this file can read.
	it("should apply a Union Alias it can not write as its arms", () => {
		let main = [
			"import {",
			'\tfrom "./Shapes.es" { read }',
			"}",
			"",
			"implementation {",
			"\tconstant r = read()",
			"",
			"\tTerminal.inspect(r)",
			"}",
			"",
		].join("\n")
		let { hints, filePath } = moduleHints(
			{ "Shapes.es": shapes, "Main.es": main },
			"Main.es",
		)

		expect(hints.map((hint) => hint.label)).toEqual([": Reading"])
		expect(hints[0]?.textEdit?.newText).toBe(": Integer | String")
		expect(
			analyseDocument(accepted(main, hints), filePath).diagnostics,
		).toEqual([])
	})

	// A Choice's arms are Cases, which no Declaration writes as a Type, so with
	// its name out of reach there is nothing to write. The Hint still shows it.
	it("should offer no edit for a Choice whose name is out of reach", () => {
		let main = [
			"import {",
			'\tfrom "./Shapes.es" { side }',
			"}",
			"",
			"implementation {",
			"\tconstant s = side()",
			"",
			"\tTerminal.inspect(s)",
			"}",
			"",
		].join("\n")
		let { hints } = moduleHints(
			{ "Shapes.es": shapes, "Main.es": main },
			"Main.es",
		)

		expect(hints.map((hint) => hint.label)).toEqual([": Edge"])
		expect(hints[0]?.textEdit).toBeNull()
	})

	// The name that came across is written as the reader would write it, not
	// as the members it stands for.
	it("should write an imported Alias that is in scope", () => {
		let main = [
			"import {",
			'\tfrom "./Shapes.es" {',
			"\t\tPoint",
			"\t\torigin",
			"\t}",
			"}",
			"",
			"implementation {",
			"\tconstant p = origin()",
			"",
			"\tTerminal.inspect(p.x)",
			"}",
			"",
		].join("\n")
		let exporting = shapes.replace("export {", "export {\n\tPoint")
		let { hints, filePath } = moduleHints(
			{ "Shapes.es": exporting, "Main.es": main },
			"Main.es",
		)

		expect(hints[0]?.textEdit?.newText).toBe(": Point")
		expect(
			analyseDocument(accepted(main, hints), filePath).diagnostics,
		).toEqual([])
	})

	// Inside that body `Box` names the inner Declaration. A Hint over the outer
	// one writes the shape there and the name outside it.
	it("should write the shape where the name is shadowed", () => {
		let source = [
			"implementation {",
			"\ttype Box = { a: Integer }",
			"",
			"\tfunction make() -> Box {",
			"\t\t<- { a = 1 }",
			"\t}",
			"",
			"\tfunction inner() -> Integer {",
			"\t\ttype Box = { b: String }",
			"",
			"\t\tconstant made = make()",
			'\t\tconstant own: Box = { b = "x" }',
			"",
			"\t\t<- 1",
			"\t}",
			"",
			"\tconstant outside = make()",
			"}",
		].join("\n")
		let edits = allHintsOf(source).map((hint) => hint.textEdit?.newText)

		expect(edits).toEqual([": { a: Integer }", ": Box"])
		expect(analyseDocument(applyHints(source)).diagnostics).toEqual([])
	})
})

describe("Inlay Hints inside a refused value", () => {
	it("should annotate a contextual Function literal written in front of the brackets", () => {
		let source = [
			"implementation {",
			"\tconstant first = [1]::removeEvery(where (item) { <- true })[0]",
			"}",
		].join("\n")

		let labels = hintsOf(source).map((hint) => hint.label)

		expect(labels).toContain(": Integer")
		expect(labels).toContain(" -> Boolean")
	})
})
