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
import { loadModuleGraph } from "../modules/graph"
import { diskModuleHost } from "../modules/host"
import { linkModuleGraph } from "../modules/link"
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

function notesOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.notes)
}

function helpsOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.helps)
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

		// NOTE: Two Protocols providing one name leave the call ambiguous, and
		// `ambiguous-namespace` answers it with "name it at the call" — so the
		// specifier has to reach a Protocol, or the Help names a spelling the
		// Program can not write and the only way out is a rename.
		const TWO_PROVIDERS = [
			"implementation {",
			"\tprotocol Left {",
			"\t\tsize() -> Integer",
			"",
			"\t\tlabel() -> String {",
			'\t\t\t<- "left"',
			"\t\t}",
			"\t}",
			"",
			"\tprotocol Right {",
			"\t\tweight() -> Integer",
			"",
			"\t\tlabel() -> String {",
			'\t\t\t<- "right"',
			"\t\t}",
			"\t}",
			"",
			"\ttype Box = { v: Integer }",
			"",
			"\tnamespace Boxes for Box is Left, is Right {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- @.v",
			"\t\t}",
			"",
			"\t\tweight() -> Integer {",
			"\t\t\t<- @.v",
			"\t\t}",
			"\t}",
		].join("\n")

		function twoProviderProgram(...lines: Array<string>): string {
			return [TWO_PROVIDERS, "", ...lines, "}"].join("\n")
		}

		it("should tie two Protocols providing one name", () => {
			let source = twoProviderProgram(
				"\tconstant box: Box = { v = 1 }",
				"\tTerminal.inspect(box::label())",
			)

			expect(codesOf(source)).toEqual(["ambiguous-namespace"])
			expect(
				diagnosticsOf(source).flatMap((diagnostic) => diagnostic.helps),
			).toEqual(["Name it at the call, e.g. 'value::<Left>label(…)'."])
		})

		it("should answer a specifier naming the Protocol that provides it", async () => {
			expect(
				await run(
					twoProviderProgram(
						"\tconstant box: Box = { v = 1 }",
						"\tTerminal.inspect(box::<Left>label())",
						"\tTerminal.inspect(box::<Right>label())",
					),
				),
			).toEqual(['"left"', '"right"'])
		})

		it("should answer a specifier naming a standard library Protocol", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tTerminal.inspect(5::<Equatable>isNot(3))",
						"\tTerminal.inspect(5::<Orderable>isBetween(1, and 10))",
						"}",
					].join("\n"),
				),
			).toEqual(["true", "true"])
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

		// NOTE: One const above every Program, so the body's reach ends at the
		// prelude — the standard library and the builtins. Everything the
		// Program declares is emitted BELOW it, under names the const can not
		// see, which is a `ReferenceError` and not a Diagnostic without this.
		it("should refuse a read of a Constant the Program declares", () => {
			let source = [
				"implementation {",
				'\tconstant unit = "m"',
				"",
				"\tprotocol Measured {",
				"\t\tamount() -> Integer",
				"",
				"\t\tspell() -> String {",
				'\t\t\t<- "{@::amount()}{unit}"',
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["provided-method-out-of-reach"])
			expect(messagesOf(source)).toEqual([
				"'unit' can not be read from a provided Method",
			])
		})

		it("should refuse a call of a Function the Program declares", () => {
			expect(
				codesOf(
					[
						"implementation {",
						"\tfunction shout(_ text: String) -> String {",
						"\t\t<- text::uppercase()",
						"\t}",
						"",
						"\tprotocol Tagged {",
						"\t\ttag() -> String",
						"",
						"\t\tloudly() -> String {",
						"\t\t\t<- shout(@::tag())",
						"\t\t}",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual(["provided-method-out-of-reach"])
		})

		it("should refuse a read of a Namespace the Program declares", () => {
			expect(
				codesOf(
					[
						"implementation {",
						"\tnamespace Sizes for Integer {",
						'\t\tstatic suffix() -> String { <- "!" }',
						"\t}",
						"",
						"\tprotocol Measured {",
						"\t\tamount() -> Integer",
						"",
						"\t\tspell() -> String {",
						"\t\t\t<- Sizes.suffix()",
						"\t\t}",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual(["provided-method-out-of-reach"])
		})

		it("should accept a read of the standard library, which is emitted above it too", () => {
			expect(
				diagnosticsOf(
					[
						"implementation {",
						"\tprotocol Tagged {",
						"\t\ttag() -> String",
						"",
						"\t\tcounted() -> String {",
						"\t\t\t<- Integer.parse(@::tag(), defaultingTo 0)::toString()",
						"\t\t}",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual([])
		})

		it("should accept what the body itself binds", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tdoubled() -> Integer {",
						"\t\t\tconstant own = @::size()",
						"",
						"\t\t\t<- own::multiply(with 2)",
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
						"\tconstant tally: Tally = { count = 3 }",
						"\tTerminal.inspect(tally::doubled())",
						"}",
					].join("\n"),
				),
			).toEqual(["6"])
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
		// override answers every call, written on the Namespace's own target
		// Type or on a Protocol-bounded Type Parameter alike — the witness a
		// bounded call reads carries the override where the conformer wrote one
		// and the Protocol's shared const where it did not. These are Rust's and
		// Swift's semantics for a requirement with a default, and they are why
		// an override may say something DIFFERENT rather than only the same
		// thing faster.
		//
		// The provided const can not simply be named in a witness: a conformer
		// that overrides nothing would have to name a const curried with the
		// very witness being built. `$type.providedConformance` closes each
		// provided entry over the finished map, which is what makes the two
		// spellings one.
		it("should answer a bounded call with the override", async () => {
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
						"\ttype Place = { where: String }",
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
						"\tnamespace Places for Place is Named {",
						"\t\tname() -> String {",
						"\t\t\t<- @.where",
						"\t\t}",
						"\t}",
						"",
						"\tfunction say<infer Item is Named>(_ item: Item) -> String {",
						"\t\t<- item::describe()",
						"\t}",
						"",
						'\tconstant person: Person = { who = "Ada" }',
						'\tconstant place: Place = { where = "Bath" }',
						"\tTerminal.inspect(person::describe())",
						"\tTerminal.inspect(say(person))",
						"\tTerminal.inspect(place::describe())",
						"\tTerminal.inspect(say(place))",
						"}",
					].join("\n"),
				),
			).toEqual(['"override"', '"override"', '"Bath"', '"Bath"'])
		})

		// NOTE: The standard library's own override, both ways round.
		// `Integer::isLessThan` is written for the performance stratification
		// the library explains at length, and a `<Item is Orderable>` bound has
		// to reach it — not the Protocol's body on `compare`.
		it("should answer a bounded call with the library's own override", () => {
			expect(
				generate(
					[
						"implementation {",
						"\tfunction below<infer Item is Orderable>(",
						"\t\t_ value: Item,",
						"\t\t_ other: Item,",
						"\t) -> Boolean {",
						"\t\t<- value::isLessThan(other)",
						"\t}",
						"",
						"\tTerminal.inspect(below(5, 3))",
						"}",
					].join("\n"),
				),
			).toContain("isLessThan: $es_Integer_isLessThan")
		})

		// NOTE: A conditional conformance carries its own `where` witnesses, and
		// the provided half closes over the map those were curried onto — so a
		// `<Item is Equatable>` bound over a List reaches `Equatable`'s `isNot`
		// with the List's Equatable witness and the item's witness both in place.
		it("should answer a bounded call through a conditional conformance", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tfunction differs<infer Item is Equatable>(",
						"\t\t_ value: Item,",
						"\t\t_ other: Item,",
						"\t) -> Boolean {",
						"\t\t<- value::isNot(other)",
						"\t}",
						"",
						"\tTerminal.inspect(differs([1, 2], [1, 3]))",
						"\tTerminal.inspect(differs([1, 2], [1, 2]))",
						"}",
					].join("\n"),
				),
			).toEqual(["true", "false"])
		})

		// NOTE: A derived conformance writes its own `isNot`, so the witness
		// names the derive's helper rather than the Protocol's const — the same
		// rule an override follows, applied to the Method a Choice derives.
		it("should answer a bounded call with a Choice's derived equality", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tchoice Colour {",
						"\t\tRed,",
						"\t\tGreen,",
						"\t}",
						"",
						"\tfunction differs<infer Item is Equatable>(",
						"\t\t_ value: Item,",
						"\t\t_ other: Item,",
						"\t) -> Boolean {",
						"\t\t<- value::isNot(other)",
						"\t}",
						"",
						"\tconstant red: Colour = #Red",
						"\tconstant green: Colour = #Green",
						"",
						"\tTerminal.inspect(differs(red, green))",
						"\tTerminal.inspect(differs(red, red))",
						"}",
					].join("\n"),
				),
			).toEqual(["true", "false"])
		})

		// NOTE: An extension chain through one bound — `Orderable` grants
		// `Comparable`, so a body bounded by the descendant reaches the
		// ancestor's requirement and the descendant's provided Method off the
		// one witness it was handed.
		it("should answer both halves of an extension through one bound", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tfunction spread<infer Item is Orderable>(",
						"\t\t_ low: Item,",
						"\t\t_ high: Item,",
						"\t) -> String {",
						"\t\t<- match low::compare(to high) -> String {",
						"\t\t\tcase Ordering#Less {",
						"\t\t\t\t<- low::isBetween(low, and high)::toString()",
						"\t\t\t}",
						"",
						"\t\t\tcase _ {",
						'\t\t\t\t<- "not below"',
						"\t\t\t}",
						"\t\t}",
						"\t}",
						"",
						"\tTerminal.inspect(spread(1, 5))",
						"\tTerminal.inspect(spread(5, 1))",
						"}",
					].join("\n"),
				),
			).toEqual(['"true"', '"not below"'])
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

		// NOTE: An override that carries a bound of its own MATCHES the
		// provided signature — what it lacks is the `where` clause letting the
		// conformance assume the bound, which is the requirement path's own
		// answer and its own actionable help. Reporting a signature mismatch
		// here told the writer the one thing that was not wrong.
		it("should ask for the condition an override's own bound needs", () => {
			let source = [
				"implementation {",
				"\tprotocol Rankable {",
				"\t\trank() -> Integer",
				"",
				"\t\tspread(to other: Self) -> Ordering {",
				"\t\t\t<- Ordering#Equal",
				"\t\t}",
				"\t}",
				"",
				"\tnamespace Ranks<infer Item> for List<Item> is Rankable {",
				"\t\trank() -> Integer {",
				"\t\t\t<- @::length()",
				"\t\t}",
				"",
				"\t\tspread<infer Item is Comparable>(",
				"\t\t\tto other: List<Item>",
				"\t\t) -> Ordering {",
				"\t\t\t<- Ordering#Greater",
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["nonconforming-namespace"])
			expect(labelsOf(source)).toEqual([
				"Method 'spread' needs 'Item is Comparable'",
			])
			expect(helpsOf(source)).toEqual([
				"Add 'where Item is Comparable' to this conformance.",
			])
		})

		// NOTE: The override rule is about the NAMESPACE, not about the name.
		// `Extras` writes `isEmpty` for the same Type and declares no
		// conformance at all — that replaces the provided Method on Extras' own
		// rung of the ladder and on nobody else's, so `Bags`'s conformance still
		// answers the call `Extras` rejects. This is the same continuation a
		// written Overload gets, and it is why a Program is free to mean
		// something else by a name a Protocol in Scope happens to provide.
		it("should keep another Namespace's provided Method on the ladder", async () => {
			let source = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"",
				"\t\tisEmpty() -> Boolean {",
				"\t\t\t<- @::size()::is(0)",
				"\t\t}",
				"\t}",
				"",
				"\ttype Bag = { n: Integer }",
				"",
				"\tnamespace Bags for Bag is Sized {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.n",
				"\t\t}",
				"\t}",
				"",
				"\tnamespace Extras for Bag {",
				"\t\tisEmpty(_ tag: String) -> String {",
				"\t\t\t<- tag",
				"\t\t}",
				"\t}",
				"",
				"\tconstant bag: Bag = { n = 0 }",
				"\tTerminal.inspect(bag::isEmpty())",
				'\tTerminal.inspect(bag::isEmpty("tag"))',
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual([])
			expect(await run(source)).toEqual(["true", '"tag"'])
		})

		// NOTE: A provided Method is named by the Namespace whose conformance
		// put it in reach, with the Protocol that wrote the body said beside it
		// — a reader who never wrote `isEmpty` anywhere needs both halves.
		it("should name a provided candidate by its Namespace and its Protocol", () => {
			let source = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"",
				"\t\tisEmpty() -> Boolean {",
				"\t\t\t<- @::size()::is(0)",
				"\t\t}",
				"\t}",
				"",
				"\ttype Bag = { n: Integer }",
				"",
				"\tnamespace Bags for Bag is Sized {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.n",
				"\t\t}",
				"\t}",
				"",
				"\tconstant bag: Bag = { n = 0 }",
				"\tTerminal.inspect(bag::isEmpty(1))",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["no-matching-overload"])
			expect(notesOf(source)).toEqual([
				"'Bags::isEmpty' (provided by Sized) takes no Arguments.",
			])
		})

		// NOTE: A DERIVE answers only where nothing WRITTEN does, and where it
		// answers it answers alone — so the note names the derive and never a
		// provided Method beside it. `Extras` takes the name from the derive,
		// and the Argument here is of a Type nothing on the ladder accepts.
		it("should name the derive a shadowing Namespace replaced", () => {
			let source = [
				"implementation {",
				"\tchoice Colour {",
				"\t\tRed,",
				"\t\tGreen,",
				"\t}",
				"",
				"\tnamespace Extras for Colour {",
				"\t\tisNot(_ tag: String) -> String {",
				"\t\t\t<- tag",
				"\t\t}",
				"\t}",
				"",
				"\tconstant colour = Colour#Red",
				"\tTerminal.inspect(colour::isNot(1))",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["no-matching-overload"])
			expect(notesOf(source)).toEqual([
				"'Extras::isNot' takes 1 Argument: Parameter 1 is String.",
				"'Equatable::isNot' (provided by Equatable) takes 1 Argument: Parameter 1 is Colour.",
				"Colour#Red derives 'isNot', and a Namespace declaring the name replaces it.",
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

	// NOTE: A provided Method is a candidate of EVERY Namespace that declares
	// the conformance, ranked by that Namespace's target exactly as a written
	// Method is — so a question the narrow Namespace's rung rejects falls to the
	// covering one's, which is the continuation `5::compare(1/2)` has always
	// had. The standard library is where the ladder has more than one rung:
	// `Integer`, `Rational` and `Algebraic` each conform to `Orderable`, and the
	// covering `Number` conforms too.
	// NOTE: `Namespace.method(receiver, …)` is how an instance Method is called
	// on its Namespace — `Number.compare(3, to 4)` — and a provided Method is a
	// Method of that Namespace, so it answers the same spelling. `Self` is the
	// Namespace's own target, which is what the receiver Argument is held to.
	describe("the Namespace spelling", () => {
		it("should answer a provided Method read off the Namespace", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tTerminal.inspect(Integer.isNot(3, 4))",
						'\tTerminal.inspect(String.isNot("a", "b"))',
						"\tTerminal.inspect(Number.isLessThan(3, Number.Pi))",
						"\tTerminal.inspect(Integer.clamp(15, between 1, and 10))",
						"}",
					].join("\n"),
				),
			).toEqual(["true", "true", "true", "10"])
		})

		it("should read the shared const rather than a member of the Namespace", () => {
			expect(
				generate(
					[
						"implementation {",
						"\tTerminal.inspect(Number.isBetween(Number.Pi, 3, and 22/7))",
						"}",
					].join("\n"),
				),
			).toContain("$es_Orderable__isBetween(")
		})

		it("should still refuse a name no conformance provides", () => {
			let source = [
				"implementation {",
				"\tTerminal.inspect(Integer.isBigger(3, 4))",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["unknown-member"])
		})

		it("should answer a user Protocol's provided Method on its Namespace", async () => {
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
						"\ttype Bag = { n: Integer }",
						"",
						"\tnamespace Bags for Bag is Sized {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @.n",
						"\t\t}",
						"\t}",
						"",
						"\tTerminal.inspect(Bags.isEmpty({ n = 0 }))",
						"}",
					].join("\n"),
				),
			).toEqual(["true"])
		})

		// NOTE: A GENERIC Namespace has no receiver to specialize its target
		// with when it is NAMED, so `Self` is pinned to `List<ItemType>` and
		// the Arguments are what say what the items are. `List`'s conformance
		// is conditional on top of that, so the witness this solves is the one
		// whose own condition has to be solved with it.
		it("should answer the spelling on a generic Namespace", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tconstant a = [1, 2]",
						"\tconstant b = [1, 3]",
						"\tTerminal.inspect(List.isNot(a, b))",
						'\tTerminal.inspect(List.isNot(["x"], ["x"]))',
						"}",
					].join("\n"),
				),
			).toEqual(["true", "false"])
		})

		it("should answer the spelling on a user generic Namespace", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Measurable {",
						"\t\tsize() -> Integer",
						"",
						"\t\tisBlank() -> Boolean {",
						"\t\t\t<- @::size()::is(0)",
						"\t\t}",
						"\t}",
						"",
						"\ttype Box<ItemType> = { items: List<ItemType> }",
						"",
						"\tnamespace Boxes<infer ItemType> for Box<ItemType> is Measurable {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @.items::length()",
						"\t\t}",
						"\t}",
						"",
						"\tconstant box: Box<Integer> = { items = [1, 2] }",
						"\tTerminal.inspect(Boxes.isBlank(box))",
						"}",
					].join("\n"),
				),
			).toEqual(["false"])
		})
	})

	describe("the specificity ladder", () => {
		it("should fall from a narrow Namespace's rung to the covering one", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tTerminal.inspect(3::isLessThan(Number.Pi))",
						"\tTerminal.inspect(Number.Pi::isLessThan(4))",
						"\tTerminal.inspect(5::isBetween(1, and 3/2))",
						"\tTerminal.inspect(Number.Pi::isBetween(3, and 22/7))",
						"}",
					].join("\n"),
				),
			).toEqual(["true", "true", "false", "true"])
		})

		// NOTE: The narrow rung still wins where it matches, and the emitted text
		// is what says which rung answered: `Integer`'s own written entry is a
		// Namespace Method the Optimiser knows how to lower, and the provided one
		// would stand in the output as a const of its own.
		it("should keep the narrowest rung that matches", async () => {
			let source = [
				"implementation {",
				"\tTerminal.inspect(5::isLessThan(3))",
				"}",
			].join("\n")

			expect(await run(source)).toEqual(["false"])
			expect(generate(source)).not.toContain("$es_Orderable__isLessThan")
		})

		// NOTE: `Integer` writes `isBetween` nowhere, so both rungs are provided
		// — and the one that answers is Integer's, whose witness is Integer's own
		// `compare` rather than the covering Namespace's sixteen-cell table.
		it("should answer a same-kind question on the narrow rung's witness", () => {
			expect(
				generate(
					[
						"implementation {",
						"\tTerminal.inspect(5::isBetween(1, and 10))",
						"}",
					].join("\n"),
				),
			).toContain("compare: Integer.compare")
		})

		it("should fall through for an Algebraic asked about an Integer", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tconstant rootTwo = 2::squareRoot()",
						"",
						"\tTerminal.inspect(match rootTwo -> Boolean {",
						"\t\tcase #Value(root) {",
						"\t\t\t<- match root -> Boolean {",
						"\t\t\t\tcase Algebraic { <- @::isLessThan(2) }",
						"\t\t\t\tcase Integer   { <- @::isLessThan(2) }",
						"\t\t\t}",
						"\t\t}",
						"",
						"\t\tcase #Empty { <- false }",
						"\t})",
						"}",
					].join("\n"),
				),
			).toEqual(["true"])
		})

		// NOTE: Naming the Protocol narrows the ladder to that Protocol's rungs
		// and leaves the ladder — the fall from Integer's rung to the covering
		// Number's still happens.
		it("should keep the ladder under a Protocol specifier", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tTerminal.inspect(5::<Orderable>isBetween(1, and 3/2))",
						"\tTerminal.inspect(3::<Orderable>isLessThan(Number.Pi))",
						"}",
					].join("\n"),
				),
			).toEqual(["false", "true"])
		})

		// NOTE: A user's own Namespaces climb the same ladder. `Wide` covers both
		// Types and `Narrow` covers one, so the call `Narrow`'s rung rejects is
		// answered by `Wide`'s — with `Self` bound to the Union `Wide` targets.
		it("should rank a user's Namespaces by their own targets", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tisBigger(_ other: Self) -> Boolean {",
						"\t\t\t<- @::size()::isGreaterThan(other::size())",
						"\t\t}",
						"\t}",
						"",
						"\ttype Box = { n: Integer }",
						"\ttype Bag = { m: Integer }",
						"",
						"\tnamespace Boxes for Box is Sized {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @.n",
						"\t\t}",
						"\t}",
						"",
						"\tnamespace Anything for Box | Bag is Sized {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- match @ -> Integer {",
						"\t\t\t\tcase Box { <- @.n }",
						"\t\t\t\tcase Bag { <- @.m }",
						"\t\t\t}",
						"\t\t}",
						"\t}",
						"",
						"\tconstant box: Box = { n = 3 }",
						"\tconstant bag: Bag = { m = 1 }",
						"",
						"\tTerminal.inspect(box::isBigger(box))",
						"\tTerminal.inspect(box::isBigger(bag))",
						"}",
					].join("\n"),
				),
			).toEqual(["false", "true"])
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

		// NOTE: The same Program, asked through the ANCESTOR bound. The witness
		// is solved for `Named`, whose own table answers with `Named`'s body —
		// and the descendant's is what a direct call runs, so both spellings
		// have to name it or one expression means two things.
		it("should reach the descendant's body through an ancestor bound", async () => {
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
				"\tfunction say<infer Item is Named>(_ item: Item) -> String {",
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

		// NOTE: An ancestor that only REQUIRES what a descendant provides is
		// owed nothing by the conformer — the descendant's body is what answers
		// it, through either bound.
		it("should let a descendant provide what its ancestor requires", async () => {
			let source = [
				"implementation {",
				"\tprotocol Named {",
				"\t\tname() -> String",
				"\t\tdescribe() -> String",
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
				"\tfunction say<infer Item is Named>(_ item: Item) -> String {",
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

// NOTE: One const per Protocol name AND Method name, which holds only while no
// two Protocol declarations provide the same pair. Two Modules of a graph each
// declaring a `Tagged` that provides `describe` would both emit
// `$es_Tagged__describe` and the second would answer for the first — a Program
// that compiles green and runs the wrong body. The graph is asked once it is
// linked, where both declarations are known; the emitter keeps its own throw
// as a last word, and both are asked about the PAIR, so two same-named
// Protocols providing different Methods still emit.
describe("two Protocols of one name", () => {
	function programWith(body: string): common.typedSimple.Program {
		let parsed = parseWithDiagnostics(body)
		let enriched = enrich(parsed.program)

		expect(containsErrors(enriched.diagnostics)).toBe(false)

		return optimise(simplify(enriched.program))
	}

	// NOTE: A conformer and a call, because an unreached const is shaken away
	// and the question here is what the emitted text HOLDS.
	function taggedProviding(memberName: string): string {
		return [
			"implementation {",
			"\tprotocol Tagged {",
			"\t\ttag() -> String",
			"",
			`\t\t${memberName}() -> String {`,
			"\t\t\t<- @::tag()",
			"\t\t}",
			"\t}",
			"",
			"\ttype Dog = { name: String }",
			"",
			"\tnamespace Dogs for Dog is Tagged {",
			"\t\ttag() -> String {",
			"\t\t\t<- @.name",
			"\t\t}",
			"\t}",
			"",
			`\tTerminal.print({ name = "x" }::${memberName}())`,
			"}",
		].join("\n")
	}

	function moduleAt(filePath: string, source: string) {
		return { filePath, program: programWith(source) }
	}

	it("should refuse to emit two declarations of one provided Method", () => {
		expect(() =>
			rewriteModules(
				[
					moduleAt("/a.es", taggedProviding("describe")),
					moduleAt("/b.es", taggedProviding("describe")),
				],
				"/a.es",
			),
		).toThrow(/Two Protocols named 'Tagged'/)
	})

	it("should emit two declarations that provide different Methods", () => {
		let emitted = [
			...rewriteModules(
				[
					moduleAt("/a.es", taggedProviding("describe")),
					moduleAt("/b.es", taggedProviding("announce")),
				],
				"/a.es",
			).sources.values(),
		].join("\n")

		expect(emitted).toContain("$es_Tagged__describe")
		expect(emitted).toContain("$es_Tagged__announce")
	})

	// NOTE: What a compile actually meets — the linker, which has both
	// declarations and a Position for each, so the report names a file and a
	// line instead of arriving as a Compiler bug with neither.
	it("should report the clash on the second Module, positioned", () => {
		let directory = mkdtempSync(join(tmpdir(), "essence-protocol-clash-"))

		// NOTE: Each Module keeps its Protocol to itself and exports a
		// Function — neither can see the other's `Tagged`, and each compiles
		// on its own, which is what makes the clash the graph's and not
		// either file's.
		function taggedModule(
			typeName: string,
			memberName: string,
			functionName: string,
		): string {
			return [
				"implementation {",
				"\tprotocol Tagged {",
				"\t\ttag() -> String",
				"",
				"\t\tdescribe() -> String {",
				"\t\t\t<- @::tag()",
				"\t\t}",
				"\t}",
				"",
				`\ttype ${typeName} = { ${memberName}: String }`,
				"",
				`\tnamespace ${typeName}s for ${typeName} is Tagged {`,
				"\t\ttag() -> String {",
				`\t\t\t<- @.${memberName}`,
				"\t\t}",
				"\t}",
				"",
				`\tfunction ${functionName}() -> String {`,
				`\t\t<- { ${memberName} = "x" }::describe()`,
				"\t}",
				"}",
				"",
				"export {",
				`\t${functionName}`,
				"}",
			].join("\n")
		}

		try {
			writeFileSync(
				join(directory, "A.es"),
				taggedModule("Dog", "name", "loud"),
			)
			writeFileSync(
				join(directory, "B.es"),
				taggedModule("Mouse", "title", "quiet"),
			)
			writeFileSync(
				join(directory, "Main.es"),
				[
					"import {",
					'\tloud  from "./A.es"',
					'\tquiet from "./B.es"',
					"}",
					"",
					"implementation {",
					"\tTerminal.print(loud())",
					"\tTerminal.print(quiet())",
					"}",
				].join("\n"),
			)

			let linked = linkModuleGraph(
				loadModuleGraph(join(directory, "Main.es"), diskModuleHost),
			)
			let reported = [...linked.modules.values()].flatMap(
				(module) => module.diagnostics,
			)

			expect(reported.map((diagnostic) => diagnostic.code)).toEqual([
				"clashing-provided-method",
			])
			expect(reported[0]!.message).toBe(
				"Two Protocols named 'Tagged' provide a Method named 'describe'",
			)
			expect(reported[0]!.position).not.toBeNull()
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
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
	// about the RUNTIME's exports — so a Protocol growing one moves exactly one
	// line of it: the witness type gains the provided Method, because a witness
	// carries one, and a native handed the witness may call it. Nothing else
	// moves. Compared against the file on disk, which is the contract the
	// runtime is written against.
	it("should add the provided Method to the witness contract and nothing else", () => {
		let onDisk = readFileSync(
			path.join(RUNTIME_DIRECTORY, "natives.generated.ts"),
			"utf-8",
		)
		let rendered = renderNativesModule(loadStdlib())
		let added = "\tdescribe: (self: Self) => StringType"

		expect(rendered).toContain(`${added}\n`)
		expect(rendered.split("\n").filter((line) => line !== added)).toEqual(
			onDisk.split("\n"),
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
