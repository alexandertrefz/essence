import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"
import { RUNTIME_DIRECTORY } from "@essence-lang/runtime"
import { readStdlibFiles } from "@essence-lang/standard-library"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	loadStdlib,
	loadStdlibFrom,
	parseStdlibSource,
	type Stdlib,
	useStdlib,
} from "../enricher/stdlib"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite, rewriteModules } from "../rewriter/index"
import { essenceMethodName } from "../rewriter/stdlibPrelude"
import { simplify } from "../simplifier/index"
import { renderNativesModule } from "../tools/generateNatives"
import { validate } from "../validator/index"

// NOTE: A Protocol Method written with a block is PROVIDED: every conformer
// answers it without writing anything, and ONE const answers for all of them.
// The whole feature rides the bounded-Generic rail — a provided Method is a
// Function over `Self is <Protocol>` — so what is asked here is that the rail
// carries it: that the body may only see the Protocol's surface, that a
// Namespace writing the name replaces it, that an extension inherits and
// grants, and that the emission is one const reached through a witness.

function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return parsed.diagnostics
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		return enriched.diagnostics
	}

	return validate(enriched.program)
}

function codesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.code)
}

function messagesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.message)
}

function labelsOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) =>
		diagnostic.labels.map((label) => label.message),
	)
}

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

// NOTE: Emits the Program, writes it to a throwaway module and imports it so
// its top-level `Terminal.inspect` calls run — the counterpart of `generate`,
// mirroring `choices.spec`'s own.
async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-protocol-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((arg) => String(arg)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

// NOTE: How many times a name is DECLARED in the emitted text — the question
// behind "one const per provided Method", which no amount of running the
// Program would answer.
function declarationsOf(javaScript: string, name: string): number {
	return javaScript.split(`const ${name} =`).length - 1
}

const SHAPE = [
	"\tprotocol Shape {",
	"\t\tarea() -> Rational",
	"",
	"\t\tdescribe() -> String {",
	'\t\t\t<- "area {@::area()}"',
	"\t\t}",
	"\t}",
	"",
	"\ttype Square = { side: Rational }",
	"",
	"\tnamespace Squares for Square is Shape {",
	"\t\tarea() -> Rational {",
	"\t\t\t<- @.side::multiply(with @.side)",
	"\t\t}",
	"\t}",
].join("\n")

function shapeProgram(...lines: Array<string>): string {
	return ["implementation {", SHAPE, "", ...lines, "}"].join("\n")
}

describe("Protocol-provided Methods", () => {
	describe("resolution", () => {
		it("should answer a call on a conforming Namespace's target Type", async () => {
			expect(
				await run(
					shapeProgram(
						"\tconstant square: Square = { side = 3/1 }",
						"\tTerminal.inspect(square::describe())",
					),
				),
			).toEqual(['"area 9"'])
		})

		it("should refuse the call where no Namespace declares the conformance", () => {
			expect(
				codesOf(
					shapeProgram(
						"\tconstant plain = { width = 3/1 }",
						"\tTerminal.inspect(plain::describe())",
					),
				),
			).toEqual(["unknown-method"])
		})

		// NOTE: A provided Method is reached through the PROTOCOL, exactly as a
		// written one is reached through its Namespace — so a Module holding the
		// conforming Namespace and not the Protocol sees the written Methods and
		// none of the provided ones. The report has to say which name is
		// missing, or the reader is left with "the Namespaces were searched" and
		// nothing to do about it.
		it("should name the Protocol a Module has not got", () => {
			let source = [
				"implementation {",
				"\ttype Square = { side: Rational }",
				"",
				"\tnamespace Squares for Square is Shape {",
				"\t\tarea() -> Rational {",
				"\t\t\t<- @.side",
				"\t\t}",
				"\t}",
				"",
				"\tconstant square: Square = { side = 3/1 }",
				"\tTerminal.inspect(square::describe())",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual([
				"unknown-protocol",
				"unknown-method",
			])
			expect(
				diagnosticsOf(source)
					.flatMap((diagnostic) => diagnostic.helps)
					.filter((help) => help.startsWith("Import 'Shape'")),
			).toHaveLength(1)
		})

		it("should not owe a provided Method at the conformance declaration", () => {
			expect(
				diagnosticsOf(shapeProgram('\tTerminal.inspect("declared")')),
			).toEqual([])
		})

		it("should list only the requirements a Namespace is missing", () => {
			let source = [
				"implementation {",
				"\tprotocol Shape {",
				"\t\tarea() -> Rational",
				"",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "area {@::area()}"',
				"\t\t}",
				"\t}",
				"",
				"\ttype Square = { side: Rational }",
				"",
				"\tnamespace Squares for Square is Shape { }",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["nonconforming-namespace"])
			expect(labelsOf(source)).toEqual(["Method 'area' is missing"])
		})

		it("should answer through a bound naming the Protocol", async () => {
			expect(
				await run(
					shapeProgram(
						"\tfunction say<infer Item is Shape>(_ item: Item) -> String {",
						"\t\t<- item::describe()",
						"\t}",
						"",
						"\tconstant square: Square = { side = 2/1 }",
						"\tTerminal.inspect(say(square))",
					),
				),
			).toEqual(['"area 4"'])
		})

		it("should answer on a covering Union Namespace's members", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tisEmpty() -> Boolean {",
						"\t\t\t<- @::size()::is(0)",
						"\t\t}",
						"\t}",
						"",
						"\tchoice Shape {",
						"\t\tDot,",
						"\t\tLine,",
						"\t}",
						"",
						"\tnamespace Shape for Shape is Sized {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- match @ -> Integer {",
						"\t\t\t\tcase #Dot  { <- 0 }",
						"\t\t\t\tcase #Line { <- 1 }",
						"\t\t\t}",
						"\t\t}",
						"\t}",
						"",
						"\tconstant dot: Shape = #Dot",
						"\tTerminal.inspect(dot::isEmpty())",
						"}",
					].join("\n"),
				),
			).toEqual(["true"])
		})

		// NOTE: No COVERING Namespace here, so the Union is resolved member by
		// member and each branch answers with the provided Method — the one
		// dispatch shape whose emitted call names the provided const rather
		// than a Namespace. A Protocol binds nothing at runtime, so a branch
		// that lost track of which of the two answered emits a member read on
		// a name that is not there.
		const UNION_MEMBERS = [
			"implementation {",
			"\tprotocol Sized {",
			"\t\tsize() -> Integer",
			"",
			"\t\tisEmpty() -> Boolean {",
			"\t\t\t<- @::size()::is(0)",
			"\t\t}",
			"\t}",
			"",
			"\ttype Bag = { count: Integer }",
			"\ttype Crate = { weight: Integer }",
			"",
			"\tnamespace Bags for Bag is Sized {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- @.count",
			"\t\t}",
			"\t}",
		].join("\n")

		function unionProgram(...lines: Array<string>): string {
			return [
				UNION_MEMBERS,
				"",
				...lines,
				"",
				"\tfunction isItEmpty(_ value: Bag | Crate) -> Boolean {",
				"\t\t<- value::isEmpty()",
				"\t}",
				"",
				"\tTerminal.inspect(isItEmpty({ count = 0 }))",
				"\tTerminal.inspect(isItEmpty({ weight = 7 }))",
				"}",
			].join("\n")
		}

		const PROVIDED_CRATE = [
			"\tnamespace Crates for Crate is Sized {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- @.weight",
			"\t\t}",
			"\t}",
		]

		it("should answer on every member of a Union no Namespace covers", async () => {
			expect(await run(unionProgram(...PROVIDED_CRATE))).toEqual([
				"true",
				"false",
			])
		})

		it("should name the provided const in a Union's dispatch branches", () => {
			let javaScript = generate(unionProgram(...PROVIDED_CRATE))

			expect(javaScript).toContain("$es_Sized__isEmpty(")
			expect(declarationsOf(javaScript, "$es_Sized__isEmpty")).toBe(1)
			expect(javaScript).not.toContain("Sized.isEmpty")
		})

		it("should answer a Union branch that writes the name with its own Method", async () => {
			expect(
				await run(
					unionProgram(
						"\tnamespace Crates for Crate is Sized {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @.weight",
						"\t\t}",
						"",
						"\t\tisEmpty() -> Boolean {",
						"\t\t\t<- true",
						"\t\t}",
						"\t}",
					),
				),
			).toEqual(["true", "true"])
		})

		it("should answer through a conditional conformance on a generic Namespace", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tisEmpty() -> Boolean {",
						"\t\t\t<- @::size()::is(0)",
						"\t\t}",
						"\t}",
						"",
						"\tnamespace Boxes<infer Item> for { value: Item }",
						"\t\tis Sized where Item is Sized",
						"\t{",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @.value::size()",
						"\t\t}",
						"\t}",
						"",
						"\ttype Tally = { count: Integer }",
						"",
						"\tnamespace Tallies for Tally is Sized {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @.count",
						"\t\t}",
						"\t}",
						"",
						"\tconstant box: { value: Tally } = { value = { count = 0 } }",
						"\tTerminal.inspect(box::isEmpty())",
						"}",
					].join("\n"),
				),
			).toEqual(["true"])
		})
	})

	describe("the body's surface", () => {
		it("should refuse a call the Protocol does not declare", () => {
			let source = [
				"implementation {",
				"\tprotocol Shape {",
				"\t\tarea() -> Rational",
				"",
				"\t\tdescribe() -> String {",
				"\t\t\t<- @::name()",
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["method-not-on-protocol"])
			expect(messagesOf(source)).toEqual([
				"'Shape' has no Method named 'name'",
			])
		})

		it("should accept a call on another provided Method", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tisEmpty() -> Boolean {",
						"\t\t\t<- @::size()::is(0)",
						"\t\t}",
						"",
						"\t\thasItems() -> Boolean {",
						"\t\t\t<- @::isEmpty()::negate()",
						"\t\t}",
						"\t}",
						"",
						"\ttype Tally = { count: Integer }",
						"",
						"\tnamespace Tallies for Tally is Sized {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @.count",
						"\t\t}",
						"\t}",
						"",
						"\tconstant tally: Tally = { count = 2 }",
						"\tTerminal.inspect(tally::hasItems())",
						"}",
					].join("\n"),
				),
			).toEqual(["true"])
		})

		it("should accept the Methods of what the Protocol answers", () => {
			expect(
				diagnosticsOf(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tdoubled() -> Integer {",
						"\t\t\t<- @::size()::multiply(with 2)",
						"\t\t}",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual([])
		})

		it("should refuse a body on a static Protocol Method", () => {
			expect(
				codesOf(
					[
						"implementation {",
						"\tprotocol Creatable {",
						"\t\tstatic create() -> Self { <- @ }",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual(["unwritable-provided-method"])
		})

		it("should refuse a body on an overloaded Protocol Method", () => {
			expect(
				codesOf(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\toverload size {",
						"\t\t\t() -> Integer { <- 0 }",
						"\t\t\t(_ scale: Integer) -> Integer",
						"\t\t}",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual(["unwritable-provided-method"])
		})
	})

	describe("the override rule", () => {
		it("should call the Namespace's own Method where it writes one", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Shape {",
						"\t\tarea() -> Rational",
						"",
						"\t\tdescribe() -> String {",
						'\t\t\t<- "area {@::area()}"',
						"\t\t}",
						"\t}",
						"",
						"\ttype Square = { side: Rational }",
						"",
						"\tnamespace Squares for Square is Shape {",
						"\t\tarea() -> Rational {",
						"\t\t\t<- @.side",
						"\t\t}",
						"",
						"\t\tdescribe() -> String {",
						'\t\t\t<- "a square"',
						"\t\t}",
						"\t}",
						"",
						"\tconstant square: Square = { side = 3/1 }",
						"\tTerminal.inspect(square::describe())",
						"}",
					].join("\n"),
				),
			).toEqual(['"a square"'])
		})

		// NOTE: A DECISION, pinned here so it can not drift by accident. An
		// override answers every call written on the Namespace's own target
		// Type. A call written on a Protocol-bounded Type Parameter dispatches
		// through the Protocol instead, and the provided body is what runs —
		// because the bound is all that is known there, and a provided Method is
		// not in the conformance witness: its body is ONE const every conformer
		// shares, so there is nothing per-conformer for a witness to name.
		//
		// The consequence for the standard library to come: `Integer`'s written
		// `isLessThan` answers `5::isLessThan(3)`, and `Orderable`'s provided
		// body answers the same call inside `<Item is Orderable>`. The two must
		// therefore AGREE — an override is for saying the same thing faster,
		// never for saying something else.
		//
		// Putting the provided Methods in the witness is what would change this,
		// and it can not be done by naming a const: a conformer that overrides
		// nothing would have to name the Protocol's const curried with the very
		// witness being built. It would take a runtime helper that closes each
		// provided entry over the finished witness.
		it("should answer a bounded call with the provided body, not the override", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Named {",
						"\t\tname() -> String",
						"",
						"\t\tdescribe() -> String {",
						"\t\t\t<- @::name()",
						"\t\t}",
						"\t}",
						"",
						"\ttype Person = { who: String }",
						"",
						"\tnamespace People for Person is Named {",
						"\t\tname() -> String {",
						"\t\t\t<- @.who",
						"\t\t}",
						"",
						"\t\tdescribe() -> String {",
						'\t\t\t<- "override"',
						"\t\t}",
						"\t}",
						"",
						"\tfunction say<infer Item is Named>(_ item: Item) -> String {",
						"\t\t<- item::describe()",
						"\t}",
						"",
						'\tconstant person: Person = { who = "Ada" }',
						"\tTerminal.inspect(person::describe())",
						"\tTerminal.inspect(say(person))",
						"}",
					].join("\n"),
				),
			).toEqual(['"override"', '"Ada"'])
		})

		it("should hold the written Method to the provided signature", () => {
			let source = [
				"implementation {",
				"\tprotocol Shape {",
				"\t\tarea() -> Rational",
				"",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "area {@::area()}"',
				"\t\t}",
				"\t}",
				"",
				"\ttype Square = { side: Rational }",
				"",
				"\tnamespace Squares for Square is Shape {",
				"\t\tarea() -> Rational {",
				"\t\t\t<- @.side",
				"\t\t}",
				"",
				"\t\tdescribe() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["nonconforming-namespace"])
			expect(labelsOf(source)).toEqual([
				"Method 'describe' does not match the Protocol's signature",
			])
		})

		it("should accept an Overload containing an entry that matches", () => {
			expect(
				diagnosticsOf(
					[
						"implementation {",
						"\tprotocol Shape {",
						"\t\tarea() -> Rational",
						"",
						"\t\tdescribe() -> String {",
						'\t\t\t<- "area {@::area()}"',
						"\t\t}",
						"\t}",
						"",
						"\ttype Square = { side: Rational }",
						"",
						"\tnamespace Squares for Square is Shape {",
						"\t\tarea() -> Rational {",
						"\t\t\t<- @.side",
						"\t\t}",
						"",
						"\t\toverload describe {",
						"\t\t\t() -> String {",
						'\t\t\t\t<- "a square"',
						"\t\t\t}",
						"",
						"\t\t\t(_ prefix: String) -> String {",
						"\t\t\t\t<- prefix",
						"\t\t\t}",
						"\t\t}",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual([])
		})
	})

	describe("extension", () => {
		const ORDERED = [
			"\tprotocol Ordered is Comparable {",
			"\t\tisBefore(_ other: Self) -> Boolean {",
			"\t\t\t<- @::compare(to other)::is(Ordering#Less)",
			"\t\t}",
			"\t}",
			"",
			"\ttype Weight = { grams: Integer }",
			"",
			"\tnamespace Weights for Weight is Ordered {",
			"\t\tcompare(to other: Weight) -> Ordering {",
			"\t\t\t<- @.grams::compare(to other.grams)",
			"\t\t}",
			"\t}",
		].join("\n")

		function orderedProgram(...lines: Array<string>): string {
			return ["implementation {", ORDERED, "", ...lines, "}"].join("\n")
		}

		it("should inherit the ancestor's requirements", () => {
			let source = [
				"implementation {",
				"\tprotocol Ordered is Comparable {",
				"\t\tisBefore(_ other: Self) -> Boolean {",
				"\t\t\t<- @::compare(to other)::is(Ordering#Less)",
				"\t\t}",
				"\t}",
				"",
				"\ttype Weight = { grams: Integer }",
				"",
				"\tnamespace Weights for Weight is Ordered { }",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["nonconforming-namespace"])
			expect(labelsOf(source)).toEqual(["Method 'compare' is missing"])
		})

		it("should grant conformance to the ancestor", async () => {
			expect(
				await run(
					orderedProgram(
						"\tfunction smaller<infer Item is Comparable>(_ a: Item, _ b: Item) -> Ordering {",
						"\t\t<- a::compare(to b)",
						"\t}",
						"",
						"\tconstant light: Weight = { grams = 1 }",
						"\tconstant heavy: Weight = { grams = 2 }",
						"\tTerminal.inspect(smaller(light, heavy))",
					),
				),
			).toEqual(["Ordering#Less"])
		})

		it("should reach the ancestor's requirement through the descendant bound", async () => {
			expect(
				await run(
					orderedProgram(
						"\tfunction order<infer Item is Ordered>(_ a: Item, _ b: Item) -> Ordering {",
						"\t\t<- a::compare(to b)",
						"\t}",
						"",
						"\tconstant light: Weight = { grams = 1 }",
						"\tconstant heavy: Weight = { grams = 2 }",
						"\tTerminal.inspect(order(heavy, light))",
					),
				),
			).toEqual(["Ordering#Greater"])
		})

		it("should reach the descendant's provided Method through its own bound", async () => {
			expect(
				await run(
					orderedProgram(
						"\tfunction first<infer Item is Ordered>(_ a: Item, _ b: Item) -> Boolean {",
						"\t\t<- a::isBefore(b)",
						"\t}",
						"",
						"\tconstant light: Weight = { grams = 1 }",
						"\tconstant heavy: Weight = { grams = 2 }",
						"\tTerminal.inspect(first(light, heavy))",
					),
				),
			).toEqual(["true"])
		})

		// NOTE: `List::sort()` asks for `ItemType is Comparable`, and the bound
		// here names only the descendant — the one witness answers both, which
		// is the whole point of an extension being a promise about conformers.
		it("should satisfy a standard library bound through the extension", async () => {
			expect(
				await run(
					orderedProgram(
						"\tfunction ordered<infer Item is Ordered>(_ items: List<Item>) -> List<Item> {",
						"\t\t<- items::sort()",
						"\t}",
						"",
						"\tconstant weights: List<Weight> = [{ grams = 3 }, { grams = 1 }]",
						"\tTerminal.inspect(ordered(weights)::firstItem()::value(defaultingTo { grams = 0 }).grams)",
					),
				),
			).toEqual(["1"])
		})

		it("should reach an ancestor's provided Method through the descendant bound", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tisEmpty() -> Boolean {",
						"\t\t\t<- @::size()::is(0)",
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Listed is Sized {",
						"\t\tfirst() -> Integer",
						"\t}",
						"",
						"\ttype Bag = { count: Integer }",
						"",
						"\tnamespace Bags for Bag is Listed {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @.count",
						"\t\t}",
						"",
						"\t\tfirst() -> Integer {",
						"\t\t\t<- 0",
						"\t\t}",
						"\t}",
						"",
						"\tfunction empty<infer Item is Listed>(_ item: Item) -> Boolean {",
						"\t\t<- item::isEmpty()",
						"\t}",
						"",
						"\tconstant bag: Bag = { count = 0 }",
						"\tTerminal.inspect(empty(bag))",
						"\tTerminal.inspect(bag::isEmpty())",
						"}",
					].join("\n"),
				),
			).toEqual(["true", "true"])
		})

		// NOTE: The declaration reads a descendant's own entry as replacing the
		// ancestor's, and a call has to read it the same way — otherwise both
		// answer and every call is ambiguous.
		it("should let a descendant re-provide an ancestor's Method", async () => {
			let source = [
				"implementation {",
				"\tprotocol Named {",
				"\t\tname() -> String",
				"",
				"\t\tdescribe() -> String {",
				"\t\t\t<- @::name()",
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Fancy is Named {",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "*{@::name()}*"',
				"\t\t}",
				"\t}",
				"",
				"\ttype Person = { who: String }",
				"",
				"\tnamespace People for Person is Fancy {",
				"\t\tname() -> String {",
				"\t\t\t<- @.who",
				"\t\t}",
				"\t}",
				"",
				"\tfunction say<infer Item is Fancy>(_ item: Item) -> String {",
				"\t\t<- item::describe()",
				"\t}",
				"",
				'\tconstant person: Person = { who = "Ada" }',
				"\tTerminal.inspect(person::describe())",
				"\tTerminal.inspect(say(person))",
				"}",
			].join("\n")

			expect(await run(source)).toEqual(['"*Ada*"', '"*Ada*"'])
		})

		// NOTE: The ancestor is still REACHED when it provides a second Method
		// the descendant did not re-provide — it answers that one and not this
		// one, and only the per-name guard at the call keeps the two apart.
		it("should keep an ancestor answering the Method it still provides", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Named {",
						"\t\tname() -> String",
						"",
						"\t\tdescribe() -> String {",
						"\t\t\t<- @::name()",
						"\t\t}",
						"",
						"\t\tshout() -> String {",
						'\t\t\t<- "{@::name()}!"',
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Fancy is Named {",
						"\t\tdescribe() -> String {",
						'\t\t\t<- "*{@::name()}*"',
						"\t\t}",
						"\t}",
						"",
						"\ttype Person = { who: String }",
						"",
						"\tnamespace People for Person is Fancy {",
						"\t\tname() -> String {",
						"\t\t\t<- @.who",
						"\t\t}",
						"\t}",
						"",
						'\tconstant person: Person = { who = "Ada" }',
						"\tTerminal.inspect(person::describe())",
						"\tTerminal.inspect(person::shout())",
						"}",
					].join("\n"),
				),
			).toEqual(['"*Ada*"', '"Ada!"'])
		})

		// NOTE: Two clauses may reach one ancestor, and the WEAKEST grant wins:
		// a Protocol granted outright by one clause does not carry the other
		// clause's `where`. What is left is the refusal that is TRUE — a Method
		// fulfilling a conditional clause carries its bound, and an
		// unconditional clause can not then use it — reported at the clause
		// with the fix in its Help, rather than as an `unsatisfied-conformance-
		// condition` at a use site about a `where` the reader never wrote for
		// that Protocol.
		it("should refuse a shared Method at the clause rather than at a use", () => {
			let source = [
				"implementation {",
				"\tprotocol Named {",
				"\t\tname() -> String",
				"",
				"\t\tdescribe() -> String {",
				"\t\t\t<- @::name()",
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Ordered is Named {",
				"\t\tfirst() -> Integer",
				"\t}",
				"",
				"\tprotocol Ranked is Named {",
				"\t\trank() -> Integer",
				"\t}",
				"",
				"\tnamespace Boxes<infer Item> for { value: Item }",
				"\t\tis Ordered where Item is Ordered, is Ranked",
				"\t{",
				"\t\tname() -> String {",
				'\t\t\t<- "box"',
				"\t\t}",
				"",
				"\t\tfirst() -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"",
				"\t\trank() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["nonconforming-namespace"])
			expect(labelsOf(source)).toEqual([
				"Method 'name' needs 'Item is Ordered'",
			])
		})

		// NOTE: And with the condition written on both clauses the ancestor
		// carries it once, and everything resolves.
		it("should carry one condition onto an ancestor both clauses reach", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Named {",
						"\t\tname() -> String",
						"",
						"\t\tdescribe() -> String {",
						"\t\t\t<- @::name()",
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Ordered is Named {",
						"\t\tfirst() -> Integer",
						"\t}",
						"",
						"\tprotocol Ranked is Named {",
						"\t\trank() -> Integer",
						"\t}",
						"",
						"\tnamespace Boxes<infer Item> for { value: Item }",
						"\t\tis Ordered where Item is Ordered,",
						"\t\tis Ranked where Item is Ordered",
						"\t{",
						"\t\tname() -> String {",
						'\t\t\t<- "box"',
						"\t\t}",
						"",
						"\t\tfirst() -> Integer {",
						"\t\t\t<- 0",
						"\t\t}",
						"",
						"\t\trank() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"\t}",
						"",
						"\ttype Weight = { grams: Integer }",
						"",
						"\tnamespace Weights for Weight is Ordered {",
						"\t\tname() -> String {",
						'\t\t\t<- "weight"',
						"\t\t}",
						"",
						"\t\tfirst() -> Integer {",
						"\t\t\t<- @.grams",
						"\t\t}",
						"\t}",
						"",
						"\tconstant box: { value: Weight } = { value = { grams = 1 } }",
						"\tTerminal.inspect(box::describe())",
						"}",
					].join("\n"),
				),
			).toEqual(['"box"'])
		})

		it("should refuse a 'where' clause on an extension", () => {
			expect(
				codesOf(
					[
						"implementation {",
						"\tprotocol Ordered is Comparable where Item is Comparable {",
						"\t\tisBefore(_ other: Self) -> Boolean {",
						"\t\t\t<- @::compare(to other)::is(Ordering#Less)",
						"\t\t}",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual(["where-on-protocol-extension"])
		})

		it("should refuse an extension naming no Protocol", () => {
			expect(
				codesOf(
					[
						"implementation {",
						"\tprotocol Ordered is Sortable {",
						"\t\tsize() -> Integer",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual(["unknown-protocol"])
		})

		it("should report a Protocol that extends itself", () => {
			let source = [
				"implementation {",
				"\tprotocol Ordered is Ordered {",
				"\t\tsize() -> Integer",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["recursive-protocol"])
			expect(messagesOf(source)).toEqual([
				"Protocol 'Ordered' extends itself",
			])
		})

		it("should report every member of an extension cycle", () => {
			let source = [
				"implementation {",
				"\tprotocol Ordered is Sortable {",
				"\t\tsize() -> Integer",
				"\t}",
				"",
				"\tprotocol Sortable is Ordered {",
				"\t\tfirst() -> Integer",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual([
				"recursive-protocol",
				"recursive-protocol",
			])
			expect(messagesOf(source)).toEqual([
				"Protocol 'Ordered' extends itself through 'Sortable'",
				"Protocol 'Sortable' extends itself through 'Ordered'",
			])
		})

		// NOTE: A cycle is refused, and the Protocols keep their own surface —
		// which is what stops a broken extension from cascading a Diagnostic
		// onto every Namespace that conforms.
		it("should keep a Protocol in a cycle usable", () => {
			let source = [
				"implementation {",
				"\tprotocol Ordered is Sortable {",
				"\t\tsize() -> Integer",
				"\t}",
				"",
				"\tprotocol Sortable is Ordered {",
				"\t\tfirst() -> Integer",
				"\t}",
				"",
				"\ttype Bag = { count: Integer }",
				"",
				"\tnamespace Bags for Bag is Ordered {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual([
				"recursive-protocol",
				"recursive-protocol",
			])
		})
	})

	describe("emission", () => {
		it("should emit one const per provided Method, whatever conforms", () => {
			let javaScript = generate(
				[
					"implementation {",
					"\tprotocol Shape {",
					"\t\tarea() -> Rational",
					"",
					"\t\tdescribe() -> String {",
					'\t\t\t<- "area {@::area()}"',
					"\t\t}",
					"\t}",
					"",
					"\ttype Square = { side: Rational }",
					"\ttype Disc = { radius: Rational }",
					"",
					"\tnamespace Squares for Square is Shape {",
					"\t\tarea() -> Rational {",
					"\t\t\t<- @.side",
					"\t\t}",
					"\t}",
					"",
					"\tnamespace Discs for Disc is Shape {",
					"\t\tarea() -> Rational {",
					"\t\t\t<- @.radius",
					"\t\t}",
					"\t}",
					"",
					"\tconstant square: Square = { side = 1/1 }",
					"\tconstant disc: Disc = { radius = 2/1 }",
					"\tTerminal.inspect(square::describe())",
					"\tTerminal.inspect(disc::describe())",
					"}",
				].join("\n"),
			)

			expect(declarationsOf(javaScript, "$es_Shape__describe")).toBe(1)
		})

		it("should take the conformance witness as its trailing Argument", () => {
			let javaScript = generate(
				shapeProgram(
					"\tconstant square: Square = { side = 1/1 }",
					"\tTerminal.inspect(square::describe())",
				),
			)

			expect(javaScript).toContain(
				"const $es_Shape__describe = function (_self, Self__conformance)",
			)
			expect(javaScript).toContain("Self__conformance.area(_self)")
		})

		it("should emit nothing for a provided Method nothing reaches", () => {
			let javaScript = generate(
				shapeProgram(
					"\tconstant square: Square = { side = 1/1 }",
					"\tTerminal.inspect(square::area()::toString())",
				),
			)

			expect(javaScript).not.toContain("$es_Shape__describe")
		})

		it("should emit nothing at all for a Protocol of requirements alone", () => {
			let javaScript = generate(
				[
					"implementation {",
					"\tprotocol Shape {",
					"\t\tarea() -> Rational",
					"\t}",
					"",
					"\ttype Square = { side: Rational }",
					"",
					"\tnamespace Squares for Square is Shape {",
					"\t\tarea() -> Rational {",
					"\t\t\t<- @.side",
					"\t\t}",
					"\t}",
					"",
					"\tconstant square: Square = { side = 1/1 }",
					"\tTerminal.inspect(square::area()::toString())",
					"}",
				].join("\n"),
			)

			expect(javaScript).not.toContain("$es_Shape")
		})

		// NOTE: A Protocol and a Namespace may be spelled exactly alike, and the
		// emitted names must not be. The Namespace scheme joins with ONE `_`, a
		// Protocol's with two, and no member name can begin with one — so
		// nothing a user names a Protocol can reach a Namespace's const. Before
		// that, `protocol Integer { toString() -> String { … } }` made
		// `42::toString()` print `hijacked`.
		it("should keep a Protocol named after a Namespace out of its consts", async () => {
			let source = [
				"implementation {",
				"\tprotocol Integer {",
				"\t\tsize() -> Integer",
				"",
				"\t\ttoString() -> String {",
				'\t\t\t<- "hijacked"',
				"\t\t}",
				"\t}",
				"",
				"\ttype Tally = { count: Integer }",
				"",
				"\tnamespace Tallies for Tally is Integer {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"",
				"\tfunction say<infer Item is Integer>(_ item: Item) -> String {",
				"\t\t<- item::toString()",
				"\t}",
				"",
				"\tconstant tally: Tally = { count = 2 }",
				"\tTerminal.inspect(42::toString())",
				"\tTerminal.inspect(say(tally))",
				"}",
			].join("\n")
			let javaScript = generate(source)

			expect(javaScript).toContain("Integer.toString")
			expect(declarationsOf(javaScript, "$es_Integer__toString")).toBe(1)
			expect(await run(source)).toEqual(['"42"', '"hijacked"'])
		})

		// NOTE: A provided Method reached only from ANOTHER provided Method has
		// to be pulled in by the reachability fixed point, not by the seed —
		// the same edge a standard library Method calling another one draws.
		it("should pull in a provided Method reached only through another", () => {
			let javaScript = generate(
				[
					"implementation {",
					"\tprotocol Sized {",
					"\t\tsize() -> Integer",
					"",
					"\t\tisEmpty() -> Boolean {",
					"\t\t\t<- @::size()::is(0)",
					"\t\t}",
					"",
					"\t\thasItems() -> Boolean {",
					"\t\t\t<- @::isEmpty()::negate()",
					"\t\t}",
					"\t}",
					"",
					"\ttype Tally = { count: Integer }",
					"",
					"\tnamespace Tallies for Tally is Sized {",
					"\t\tsize() -> Integer {",
					"\t\t\t<- @.count",
					"\t\t}",
					"\t}",
					"",
					"\tconstant tally: Tally = { count = 2 }",
					"\tTerminal.inspect(tally::hasItems())",
					"}",
				].join("\n"),
			)

			expect(declarationsOf(javaScript, "$es_Sized__isEmpty")).toBe(1)
			expect(declarationsOf(javaScript, "$es_Sized__hasItems")).toBe(1)
		})
	})
})

// NOTE: One const per Protocol NAME, which holds only while no two Protocol
// declarations share one. Two Modules of a graph each declaring `protocol
// Tagged` would both emit `$es_Tagged__…` and the second would answer for the
// first — a Program that compiles green and runs the wrong body. Refused, until
// a Protocol carries the identity of the Module that declared it, as a Choice
// does.
describe("two Protocols of one name", () => {
	function programWith(body: string): common.typedSimple.Program {
		let parsed = parseWithDiagnostics(body)
		let enriched = enrich(parsed.program)

		expect(containsErrors(enriched.diagnostics)).toBe(false)

		return optimise(simplify(enriched.program))
	}

	it("should refuse to emit two declarations under one name", () => {
		let tagged = [
			"implementation {",
			"\tprotocol Tagged {",
			"\t\ttag() -> String",
			"",
			"\t\tdescribe() -> String {",
			"\t\t\t<- @::tag()",
			"\t\t}",
			"\t}",
			"}",
		].join("\n")

		expect(() =>
			rewriteModules(
				[
					{ filePath: "/a.es", program: programWith(tagged) },
					{ filePath: "/b.es", program: programWith(tagged) },
				],
				"/a.es",
			),
		).toThrow(/Two Protocols named 'Tagged'/)
	})
})

// NOTE: Two things can only be asked of the STANDARD LIBRARY's own Protocols.
// A Choice derives its printing from the builtin `Printable` and from nothing
// else, so a provided Method reached through a derived conformance needs that
// Protocol to have one; and a provided body inside a `declarations { … }`
// Program is a shape only the loader ever meets. Both are asked here, against
// the real sources with one provided Method added — the shape the standard
// library is about to grow.
//
// NOTE: `Printable` rather than `Equatable`, because a body is Essence and
// `Protocols.es` imports nothing: `@::toString()` is the Protocol's own
// requirement and needs no Namespace in scope, where `@::is(other)::negate()`
// would need `Boolean.es` imported and would change the library's import graph.
//
// NOTE: The library is put back afterwards rather than dropped: every consumer
// reads the one process-wide object, so a test that left its own in place would
// compile every file after it against a library the repository does not have.
describe("a provided Method in the standard library", () => {
	const printable = [
		"\tprotocol Printable {",
		"\t\t§§ Answers the value as a String.",
		"\t\t§§",
		"\t\t§§ @returns — the String representation of the value.",
		"\t\ttoString() -> String",
		"",
		"\t\t§§ Answers the value as a String, for a reader.",
		"\t\t§§",
		"\t\t§§ @returns — the String representation of the value.",
		"\t\tdescribe() -> String {",
		"\t\t\t<- @::toString()",
		"\t\t}",
		"\t}",
	].join("\n")

	let replacedStdlib: Stdlib | null = null

	beforeAll(() => {
		let sources = readStdlibFiles().map(({ filePath, sourceText }) => {
			if (!filePath.endsWith("Protocols.es")) {
				return parseStdlibSource(filePath, sourceText)
			}

			let replaced = sourceText.replace(
				[
					"\tprotocol Printable {",
					"\t\t§§ Answers the value as a String.",
					"\t\t§§",
					"\t\t§§ @returns — the String representation of the value.",
					"\t\ttoString() -> String",
					"\t}",
				].join("\n"),
				printable,
			)

			expect(replaced).not.toBe(sourceText)

			return parseStdlibSource(filePath, replaced)
		})

		replacedStdlib = useStdlib(loadStdlibFrom(sources))
	})

	afterAll(() => {
		useStdlib(replacedStdlib)
	})

	// NOTE: A Protocol body is Essence, and the generated native contract is
	// about the RUNTIME's exports — so a Protocol growing one must not move a
	// line of it. Compared against the file on disk, which is the contract the
	// runtime is written against.
	it("should leave the generated native contract untouched", () => {
		expect(renderNativesModule(loadStdlib())).toBe(
			readFileSync(
				path.join(RUNTIME_DIRECTORY, "natives.generated.ts"),
				"utf-8",
			),
		)
	})

	// NOTE: `essenceMethodName` answers for a NAMESPACE member and must not
	// answer for a Protocol's — a Namespace spelled like the Protocol would
	// otherwise be routed to the Protocol's const. The provided Method is
	// reached through the Invocation's `providedBy` instead, which the emission
	// tests below read off the finished text.
	it("should load a provided body out of a declarations Program", () => {
		expect(essenceMethodName("Printable", "describe")).toBeNull()
		expect(
			generate(
				[
					"implementation {",
					"\tchoice Colour {",
					"\t\tRed,",
					"\t}",
					"",
					"\tnamespace Colour for Colour is Printable { }",
					"",
					"\tconstant red: Colour = #Red",
					"\tTerminal.inspect(red::describe())",
					"}",
				].join("\n"),
			),
		).toContain("$es_Printable__describe")
	})

	it("should answer on a Choice whose printing is derived", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tchoice Colour {",
					"\t\tRed,",
					"\t\tGreen,",
					"\t}",
					"",
					"\tnamespace Colour for Colour is Printable { }",
					"",
					"\tconstant red: Colour = #Red",
					"\tTerminal.inspect(red::describe())",
					"}",
				].join("\n"),
			),
		).toEqual(['"Red"'])
	})

	it("should hand the derived printing in as the witness", () => {
		let javaScript = generate(
			[
				"implementation {",
				"\tchoice Colour {",
				"\t\tRed,",
				"\t\tGreen,",
				"\t}",
				"",
				"\tnamespace Colour for Colour is Printable { }",
				"",
				"\tconstant red: Colour = #Red",
				"\tTerminal.inspect(red::describe())",
				"}",
			].join("\n"),
		)

		expect(declarationsOf(javaScript, "$es_Printable__describe")).toBe(1)
		expect(javaScript).toContain("toString: $helpers.choiceName")
	})

	it("should answer on a Namespace that wrote the requirement", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect(true::describe())",
					"}",
				].join("\n"),
			),
		).toEqual(['"true"'])
	})
})
