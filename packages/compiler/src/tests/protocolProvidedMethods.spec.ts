import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"
import { RUNTIME_DIRECTORY } from "@essence-lang/runtime"
import { readStdlibFiles } from "@essence-lang/standard-library"

import { bundle } from "../bundler/index"
import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	loadStdlib,
	loadStdlibFrom,
	parseStdlibSource,
	type Stdlib,
	useStdlib,
} from "../enricher/stdlib"
import * as conformance from "../helpers/conformance"
import { loadModuleGraph } from "../modules/graph"
import { diskModuleHost } from "../modules/host"
import { linkModuleGraph } from "../modules/link"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import {
	reachableEssenceMethods,
	rewrite,
	rewriteModules,
} from "../rewriter/index"
import {
	essenceMethodName,
	type PreludeNamespace,
} from "../rewriter/stdlibPrelude"
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

function refusalsOf(source: string): Array<[string, string, Array<string>]> {
	return diagnosticsOf(source).map((diagnostic) => [
		diagnostic.code,
		diagnostic.message,
		diagnostic.labels.map((label) => label.message),
	])
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
			let directory = mkdtempSync(
				join(tmpdir(), "essence-protocol-unimported-"),
			)

			try {
				writeFileSync(
					join(directory, "Shapes.es"),
					[
						"implementation {",
						SHAPE,
						"}",
						"",
						"export {",
						"\tShape",
						"\tSquare",
						"\tSquares",
						"}",
					].join("\n"),
				)
				writeFileSync(
					join(directory, "Main.es"),
					[
						"import {",
						'\tfrom "./Shapes.es" {',
						"\t\tSquare",
						"\t\tSquares",
						"\t}",
						"}",
						"",
						"implementation {",
						"\tconstant square: Square = { side = 3/1 }",
						"\tTerminal.inspect(square::describe())",
						"}",
					].join("\n"),
				)

				let reported = [
					...linkModuleGraph(
						loadModuleGraph(
							join(directory, "Main.es"),
							diskModuleHost,
						),
					).modules.values(),
				].flatMap((module) => module.diagnostics)

				expect(reported.map((diagnostic) => diagnostic.code)).toEqual([
					"unknown-method",
					"unused-import",
				])
				expect(
					reported
						.flatMap((diagnostic) => diagnostic.helps)
						.filter((help) => help.startsWith("Import 'Shape'")),
				).toHaveLength(1)
			} finally {
				rmSync(directory, { recursive: true, force: true })
			}
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
			expect(helpsOf(source)).toEqual([
				"Name it at the call, e.g. 'value::<Left>label(…)'.",
			])
			// NOTE: The Namespace alone is the same word twice here, and
			// neither time true — `Boxes` declares no `label`. Each note names
			// the Protocol that wrote the body, which is also what the
			// specifier has to write, so `Right` is discoverable at all.
			expect(notesOf(source)).toEqual([
				"'Left' provides 'label' for 'Boxes'.",
				"'Right' provides 'label' for 'Boxes'.",
			])
			// NOTE: The Quick Fix writes what the notes named and not the
			// Namespace they were needed instead of — `box::<Boxes>label()`
			// resolves nothing, and two actions spelling it would be the same
			// wrong edit offered twice.
			expect(diagnosticsOf(source)[0].data).toEqual({
				kind: "namespace-candidates",
				names: ["Left", "Right"],
			})
		})

		// NOTE: A Namespace declaring the name ties with the provided Method it
		// did not replace — its own rung is not the rung the provided one
		// stands on. The note must not say `Integer` declares `isBetween`:
		// nothing in `Integer.es` does, and a reader sent there finds nothing.
		it("should name the Protocol beside a Namespace that ties with it", () => {
			let source = [
				"implementation {",
				"\tnamespace Extras for Integer {",
				"\t\tisBetween(_ lower: Integer, and upper: Integer) -> Boolean {",
				"\t\t\t<- false",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(5::isBetween(1, and 9))",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["ambiguous-namespace"])
			expect(notesOf(source)).toEqual([
				"'Extras' declares 'isBetween'.",
				"'Orderable' provides 'isBetween' for 'Integer'.",
			])
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

	// NOTE: A provided body calls the Methods of the Protocol that wrote it, so
	// a bound's witness curries it with the conformer's witness for that
	// Protocol, whichever Protocol the bound names.
	describe("the witness a provided body runs with", () => {
		const SIZED = [
			"\tprotocol Sized {",
			"\t\tsize() -> Integer",
			"\t\tdescribe() -> String",
			"\t}",
		]

		const BIG = [
			"\tprotocol Big is Sized {",
			"\t\textra() -> Integer",
			"",
			"\t\tdescribe() -> String {",
			'\t\t\t<- "big {@::extra()}"',
			"\t\t}",
			"\t}",
		]

		// NOTE: The declarations, then a bounded `gauge`, then the lines that
		// call it.
		function gaugeProgram(
			declarations: Array<string>,
			...lines: Array<string>
		): string {
			return [
				"implementation {",
				...SIZED,
				"",
				...declarations,
				"",
				"\tfunction gauge<infer Item is Sized>(_ item: Item) -> String {",
				"\t\t<- item::describe()",
				"\t}",
				"",
				...lines,
				"}",
			].join("\n")
		}

		function integerNamespace(
			clauses: string,
			...methods: Array<[string, string]>
		): Array<string> {
			return [
				`\tnamespace IntegerAll for Integer ${clauses} {`,
				...methods.flatMap(([signature, body], index) => [
					...(index === 0 ? [] : [""]),
					`\t\t${signature} {`,
					`\t\t\t<- ${body}`,
					"\t\t}",
				]),
				"\t}",
			]
		}

		it("should run a descendant's body with the descendant's witness", async () => {
			expect(
				await run(
					gaugeProgram(
						[
							...BIG,
							"",
							...integerNamespace(
								"is Big",
								["size() -> Integer", "@"],
								["extra() -> Integer", "7"],
							),
						],
						"\tTerminal.inspect(gauge(3))",
						"\tTerminal.inspect(3::describe())",
					),
				),
			).toEqual(['"big 7"', '"big 7"'])
		})

		it("should run an unrelated Protocol's body with that Protocol's witness", async () => {
			expect(
				await run(
					gaugeProgram(
						[
							"\tprotocol Counted {",
							"\t\tcount() -> Integer",
							"",
							"\t\tdescribe() -> String {",
							'\t\t\t<- "counted {@::count()}"',
							"\t\t}",
							"\t}",
							"",
							...BIG,
							"",
							...integerNamespace(
								"is Counted, is Big",
								["size() -> Integer", "@"],
								["extra() -> Integer", "7"],
								["count() -> Integer", "9"],
							),
						],
						"\tTerminal.inspect(gauge(3))",
					),
				),
			).toEqual(['"counted 9"'])
		})

		it("should reach a provided Method of the body's own Protocol", async () => {
			expect(
				await run(
					gaugeProgram(
						[
							"\tprotocol Shown {",
							"\t\tsize() -> Integer",
							"",
							"\t\thelper() -> String {",
							'\t\t\t<- "h{@::size()}"',
							"\t\t}",
							"",
							"\t\tdescribe() -> String {",
							'\t\t\t<- "shown {@::helper()}"',
							"\t\t}",
							"\t}",
							"",
							...BIG,
							"",
							...integerNamespace(
								"is Shown, is Big",
								["size() -> Integer", "@"],
								["extra() -> Integer", "7"],
							),
						],
						"\tTerminal.inspect(gauge(3))",
					),
				),
			).toEqual(['"shown h3"'])
		})

		// NOTE: Of two Protocols that do not extend each other the first the
		// clauses reach provides the body, and of two that do the more derived.
		it("should answer with the first of two unrelated bodies the clauses reach", async () => {
			let shown = [
				"\tprotocol Shown {",
				"\t\tsize() -> Integer",
				"",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "shown {@::size()}"',
				"\t\t}",
				"\t}",
			]

			expect(
				await run(
					gaugeProgram(
						[
							...shown,
							"",
							...BIG,
							"",
							"\tprotocol Bigger is Big {",
							"\t\tdescribe() -> String {",
							'\t\t\t<- "bigger {@::size()}"',
							"\t\t}",
							"\t}",
							"",
							...integerNamespace(
								"is Bigger, is Shown",
								["size() -> Integer", "@"],
								["extra() -> Integer", "7"],
							),
							"",
							"\tnamespace StringAll for String is Shown, is Bigger {",
							"\t\tsize() -> Integer {",
							"\t\t\t<- @::length()",
							"\t\t}",
							"",
							"\t\textra() -> Integer {",
							"\t\t\t<- 8",
							"\t\t}",
							"\t}",
						],
						"\tTerminal.inspect(gauge(3))",
						'\tTerminal.inspect(gauge("ab"))',
					),
				),
			).toEqual(['"bigger 3"', '"shown 2"'])
		})

		// NOTE: `Shown` comes first, and its body answers with an Integer where
		// `Sized` asks for a String.
		it("should pass over a body whose signature does not fulfil the requirement", async () => {
			expect(
				await run(
					gaugeProgram(
						[
							"\tprotocol Shown {",
							"\t\tsize() -> Integer",
							"",
							"\t\tdescribe() -> Integer {",
							"\t\t\t<- @::size()::multiply(with 100)",
							"\t\t}",
							"\t}",
							"",
							...BIG,
							"",
							...integerNamespace(
								"is Shown, is Big",
								["size() -> Integer", "@"],
								["extra() -> Integer", "7"],
							),
						],
						"\tTerminal.inspect(gauge(3))",
						"\tTerminal.inspect(gauge(3)::length())",
					),
				),
			).toEqual(['"big 7"', "5"])
		})

		it("should report a requirement no provided body fulfils at the conformance", () => {
			let source = gaugeProgram(
				[
					"\tprotocol Shown {",
					"\t\tsize() -> Integer",
					"",
					"\t\tdescribe() -> Integer {",
					"\t\t\t<- @::size()::multiply(with 100)",
					"\t\t}",
					"\t}",
					"",
					...integerNamespace("is Sized, is Shown", [
						"size() -> Integer",
						"@",
					]),
				],
				"\tTerminal.inspect(gauge(3))",
			)
			let [declaration, call] = diagnosticsOf(source)

			expect(declaration.code).toBe("nonconforming-namespace")
			expect(declaration.position?.start.line).toBe(15)
			expect(declaration.labels.map((label) => label.message)).toEqual([
				"Method 'describe' is missing",
			])
			expect(declaration.notes).toEqual([
				"'Shown' provides a 'describe' whose signature does not fulfil the one 'Sized' declares.",
				"'Sized' and 'Shown' declare 'describe' apart, so a 'describe' written as 'Sized' declares it refuses the 'is Shown' here.",
			])
			expect(declaration.helps).toEqual([
				"Declare 'is Sized' on a Namespace of its own that writes 'size', 'describe' as 'Sized' declares them, or drop the 'is Sized'.",
			])
			expect(declaration.data).toBeUndefined()
			expect(call.notes).toEqual([
				"'IntegerAll' does not write 'describe', which 'Sized' requires.",
				"'Shown' provides a 'describe' whose signature does not fulfil the one 'Sized' declares.",
			])
		})

		// NOTE: A `describe` answering a String fulfils the one `Shown` provides
		// as well, so writing it is the answer.
		it("should ask for a requirement another conformance accepts written as declared", () => {
			let source = gaugeProgram(
				[
					"\tprotocol Shown {",
					"\t\tsize() -> Integer",
					"",
					"\t\tdescribe() -> Integer | String {",
					"\t\t\t<- @::size()",
					"\t\t}",
					"\t}",
					"",
					...integerNamespace("is Sized, is Shown", [
						"size() -> Integer",
						"@",
					]),
				],
				"\tTerminal.inspect(gauge(3))",
			)
			let [declaration] = diagnosticsOf(source)

			expect(declaration.notes).toEqual([
				"'Shown' provides a 'describe' whose signature does not fulfil the one 'Sized' declares.",
			])
			expect(declaration.helps).toEqual([
				"Write 'describe' as 'Sized' declares it, or drop the 'is Sized'.",
			])
			expect(declaration.data).toEqual({
				kind: "missing-requirements",
				protocol: "Sized",
				methods: ["describe"],
			})
		})

		// NOTE: A body is Simple, so it answers no overloaded requirement.
		it("should not answer an overloaded requirement with a provided body", () => {
			let source = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"",
				"\t\toverload describe {",
				"\t\t\t() -> String",
				"\t\t\t(_ prefix: String) -> String",
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Shown {",
				"\t\tsize() -> Integer",
				"",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "shown {@::size()}"',
				"\t\t}",
				"\t}",
				"",
				...integerNamespace("is Sized, is Shown", [
					"size() -> Integer",
					"@",
				]),
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["nonconforming-namespace"])
			expect(labelsOf(source)).toEqual(["Method 'describe' is missing"])
		})

		// NOTE: A body is chosen at the Namespace's declared target, as the
		// declaration judges it, and has to fulfil its requirement at the value's
		// Type as well, so no value runs another body.
		function describing(
			parameter: string,
			target: string,
			...lines: Array<string>
		): string {
			return [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				`\t\tdescribe(_ other: ${parameter}) -> String`,
				"\t}",
				"",
				"\tprotocol Alpha {",
				"\t\tsize() -> Integer",
				"",
				"\t\tdescribe(_ other: Self) -> String {",
				'\t\t\t<- "alpha {@::size()}"',
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Beta {",
				"\t\tsize() -> Integer",
				"",
				`\t\tdescribe(_ other: ${parameter}) -> String {`,
				'\t\t\t<- "beta {@::size()}"',
				"\t\t}",
				"\t}",
				"",
				`\tnamespace All${target} is Sized, is Alpha, is Beta {`,
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"",
				"\tfunction gauge<infer Item is Sized>(_ item: Item) -> String {",
				"\t\t<- item::describe(2)",
				"\t}",
				"",
				...lines,
				"}",
			].join("\n")
		}

		it("should run the body the declaration chose for a value of the target", async () => {
			expect(
				await run(
					describing(
						"Number",
						" for Number",
						"\tconstant n: Number = 3",
						"\tTerminal.inspect(gauge(n))",
					),
				),
			).toEqual(['"alpha 1"'])
		})

		// NOTE: The body takes as `Self` what the requirement takes as a Number,
		// so it would be handed a Rational as an Integer.
		it("should refuse a narrower value the chosen body takes as `Self`", () => {
			expect(
				refusalsOf(
					describing(
						"Number",
						" for Number",
						"\tTerminal.inspect(gauge(3))",
						"\tTerminal.inspect(gauge(0.5))",
					),
				),
			).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'All' does not conform to 'Sized'",
					["this needs Integer to conform"],
				],
				[
					"nonconforming-namespace",
					"Namespace 'All' does not conform to 'Sized'",
					["this needs Rational to conform"],
				],
			])
		})

		it("should say which body refuses a narrower value, and how it narrows", () => {
			let source = describing(
				"Number",
				" for Number",
				"\tTerminal.inspect(gauge(3))",
			)

			expect(notesOf(source)).toEqual([
				"'describe' runs the body 'Alpha' provides, whose Parameter 1 is 'Self': at Integer it takes an Integer, where 'Sized' accepts any Number.",
			])
			expect(helpsOf(source)).toEqual([
				"Take 'Number' as Parameter 1 in the body 'Alpha' provides, or declare a Namespace for Integer that conforms to 'Sized'.",
			])
		})

		it("should run the body a generic Namespace's declaration chose for every item", async () => {
			expect(
				await run(
					describing(
						"List<Integer>",
						"<infer Item> for List<Item>",
						"\tfunction outer<infer Thing>(_ things: List<Thing>) -> String {",
						"\t\t<- gauge(things)",
						"\t}",
						"",
						"\tTerminal.inspect(gauge([1, 2]))",
						"\tTerminal.inspect(outer([1, 2]))",
						'\tTerminal.inspect(outer(["a"]))',
					).replace("item::describe(2)", "item::describe([2])"),
				),
			).toEqual(['"beta 1"', '"beta 1"', '"beta 1"'])
		})

		it("should refuse a narrower value where the one body fulfils only at the target", () => {
			expect(
				refusalsOf(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"\t\tdescribe(_ other: Number) -> String",
						"\t}",
						"",
						"\tprotocol Shown {",
						"\t\tsize() -> Integer",
						"\t\textra() -> String",
						"",
						"\t\tdescribe(_ other: Self) -> String {",
						'\t\t\t<- "shown {@::size()} {@::extra()}"',
						"\t\t}",
						"\t}",
						"",
						"\tnamespace NumberBoth for Number is Sized, is Shown {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"",
						"\t\textra() -> String {",
						'\t\t\t<- "e"',
						"\t\t}",
						"\t}",
						"",
						"\tfunction gauge<infer Item is Sized>(_ item: Item) -> String {",
						"\t\t<- item::describe(2)",
						"\t}",
						"",
						"\tconstant n: Number = 3",
						"\tTerminal.inspect(gauge(n))",
						"\tTerminal.inspect(gauge(3))",
						"}",
					].join("\n"),
				),
			).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'NumberBoth' does not conform to 'Sized'",
					["this needs Integer to conform"],
				],
			])
		})

		it("should say which one body refuses a narrower value, and how it narrows", () => {
			let source = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"\t\tdescribe(_ other: Number) -> String",
				"\t}",
				"",
				"\tprotocol Shown {",
				"\t\tsize() -> Integer",
				"",
				"\t\tdescribe(_ other: Self) -> String {",
				'\t\t\t<- "shown {@::size()}"',
				"\t\t}",
				"\t}",
				"",
				"\tnamespace NumberBoth for Number is Sized, is Shown {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"",
				"\tfunction gauge<infer Item is Sized>(_ item: Item) -> String {",
				"\t\t<- item::describe(2)",
				"\t}",
				"",
				"\tTerminal.print(gauge(3))",
				"\tTerminal.print(gauge(0.5))",
				"}",
			].join("\n")

			expect(notesOf(source)).toEqual([
				"'describe' runs the body 'Shown' provides, whose Parameter 1 is 'Self': at Integer it takes an Integer, where 'Sized' accepts any Number.",
				"'describe' runs the body 'Shown' provides, whose Parameter 1 is 'Self': at Rational it takes a Rational, where 'Sized' accepts any Number.",
			])
			expect(helpsOf(source)).toEqual([
				"Take 'Number' as Parameter 1 in the body 'Shown' provides, or declare a Namespace for Integer that conforms to 'Sized'.",
				"Take 'Number' as Parameter 1 in the body 'Shown' provides, or declare a Namespace for Rational that conforms to 'Sized'.",
			])
		})

		it("should run a standard library body a covering Union's Namespace fulfils with", async () => {
			let source = (...lines: Array<string>) =>
				[
					"implementation {",
					"\ttype Key = Integer | String",
					"",
					"\tprotocol Ranked {",
					"\t\tisLessThan(_ other: Key) -> Boolean",
					"\t}",
					"",
					"\tnamespace Keys for Key is Ranked, is Comparable {",
					"\t\tcompare(to other: Key) -> Ordering {",
					"\t\t\t<- @::toString()::length()::compare(to other::toString()::length())",
					"\t\t}",
					"\t}",
					"",
					"\tfunction smaller<infer Item is Ranked>(_ a: Item, _ b: Key) -> Boolean {",
					"\t\t<- a::isLessThan(b)",
					"\t}",
					"",
					...lines,
					"}",
				].join("\n")

			expect(
				await run(
					source(
						"\tconstant k: Key = 5",
						"\tconstant l: Key = 123",
						'\tTerminal.inspect(smaller(k, "abc"))',
						'\tTerminal.inspect(smaller(l, "a"))',
					),
				),
			).toEqual(["true", "false"])
			expect(
				refusalsOf(source('\tTerminal.inspect(smaller(123, "a"))')),
			).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'Keys' does not conform to 'Ranked'",
					["this needs Integer to conform"],
				],
			])
		})

		// NOTE: `Maker`'s body answers `Sized`'s requirement, and `Maker` is solved
		// at the value's Type, where the Namespace's `make` answers too wide a Type.
		function makerProgram(
			requirement: string,
			body: string,
			...lines: Array<string>
		): string {
			return [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				`\t\t${requirement}`,
				"\t}",
				"",
				"\tprotocol Maker {",
				"\t\tmake() -> Self",
				"",
				`\t\t${requirement} {`,
				`\t\t\t<- ${body}`,
				"\t\t}",
				"\t}",
				"",
				...lines,
				"}",
			].join("\n")
		}

		const MIXED = [
			"\tnamespace Mixed for Integer | String is Sized, is Maker {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- 1",
			"\t\t}",
			"",
			"\t\tmake() -> Integer | String {",
			'\t\t\t<- "str"',
			"\t\t}",
			"\t}",
			"",
		]

		const MIXED_REFUSAL: [string, string, Array<string>] = [
			"nonconforming-namespace",
			"Namespace 'Mixed' does not conform to 'Sized'",
			["this needs Integer to conform"],
		]

		it("should refuse a body whose Protocol a covering Union's Namespace answers only at the Union", () => {
			expect(
				refusalsOf(
					makerProgram(
						"twin() -> Self",
						"@::make()",
						...MIXED,
						"\tfunction gauge<infer T is Sized>(_ x: T) -> T {",
						"\t\t<- x::twin()",
						"\t}",
						"",
						"\tconstant r: Integer = gauge(3)",
						'\tTerminal.print("{r} {r::is(3)}")',
					),
				),
			).toEqual([MIXED_REFUSAL])
		})

		it("should refuse it where the body hands its `Self` to a Function the caller passes", () => {
			expect(
				refusalsOf(
					makerProgram(
						"visit(_ f: (_: Self) -> String) -> String",
						"f(@::make())",
						...MIXED,
						"\tfunction gauge<infer T is Sized>(_ x: T, _ f: (_: T) -> String) -> String {",
						"\t\t<- x::visit(f)",
						"\t}",
						"",
						'\tTerminal.print(gauge(3, (n) { <- "{n::add(1)}" }))',
					),
				),
			).toEqual([MIXED_REFUSAL])
		})

		it("should refuse a body whose Protocol a Choice's Namespace answers only at the Choice", () => {
			expect(
				refusalsOf(
					makerProgram(
						"twin() -> Self",
						"@::make()",
						"\tchoice Shape {",
						"\t\tCircle { radius: Integer },",
						"\t\tSquare { side: Integer },",
						"\t}",
						"",
						"\tnamespace Shapes for Shape is Sized, is Maker {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"",
						"\t\tmake() -> Shape {",
						"\t\t\t<- #Square(4)",
						"\t\t}",
						"\t}",
						"",
						"\tfunction gauge<infer T is Sized>(_ x: T) -> T {",
						"\t\t<- x::twin()",
						"\t}",
						"",
						"\tconstant c = Shape#Circle(2)",
						"\tTerminal.print(gauge(c).radius::add(1))",
					),
				),
			).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'Shapes' does not conform to 'Sized'",
					["this needs Shape#Circle to conform"],
				],
			])
		})

		it("should refuse a body whose Protocol a Record's Namespace answers only at the Record", () => {
			expect(
				refusalsOf(
					makerProgram(
						"twin() -> Self",
						"@::make()",
						"\ttype Box = { n: Integer }",
						"",
						"\tnamespace Boxes for Box is Sized, is Maker {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @.n",
						"\t\t}",
						"",
						"\t\tmake() -> Box {",
						"\t\t\t<- { n = 0 }",
						"\t\t}",
						"\t}",
						"",
						"\tfunction gauge<infer T is Sized>(_ x: T) -> T {",
						"\t\t<- x::twin()",
						"\t}",
						"",
						"\tconstant w: { n: Integer, m: Integer } = { n = 1, m = 2 }",
						"\tTerminal.print(gauge(w).m::add(1))",
					),
				),
			).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'Boxes' does not conform to 'Sized'",
					["this needs { n: Integer, m: Integer } to conform"],
				],
			])
		})

		// NOTE: `Alpha`'s body answers `twin` with the target's Type, which is no
		// `Self` of a narrower value.
		function alphaProgram(
			target: string,
			answer: string,
			...lines: Array<string>
		): string {
			return [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"\t\ttwin() -> Self",
				"\t}",
				"",
				"\tprotocol Alpha {",
				`\t\ttwin() -> ${target} {`,
				`\t\t\t<- ${answer}`,
				"\t\t}",
				"\t}",
				"",
				...lines,
				"",
				"\tfunction gauge<infer T is Sized>(_ x: T) -> T {",
				"\t\t<- x::twin()",
				"\t}",
				"}",
			].join("\n")
		}

		it("should refuse a narrower value a body answers with its target's Type", () => {
			expect(
				refusalsOf(
					alphaProgram(
						"Number",
						"1/2",
						"\tnamespace NumberAll for Number is Sized, is Alpha {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"\t}",
						"",
						"\tconstant r: Integer = gauge(3)",
						"\tTerminal.inspect(r)",
					),
				),
			).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'NumberAll' does not conform to 'Sized'",
					["this needs Integer to conform"],
				],
			])
		})

		it("should say what a body answers a narrower value with", () => {
			let source = alphaProgram(
				"Number",
				"1/2",
				"\tnamespace NumberAll for Number is Sized, is Alpha {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"",
				"\tconstant r: Integer = gauge(3)",
				"\tTerminal.inspect(r)",
			)

			expect(notesOf(source)).toEqual([
				"'twin' runs the body 'Alpha' provides, which answers a Number at Integer, where 'Sized' answers an Integer.",
			])
			expect(helpsOf(source)).toEqual([
				"Answer 'Self' from the body 'Alpha' provides, or declare a Namespace for Integer that conforms to 'Sized'.",
			])
		})

		it("should refuse a Case a body answers with its Choice", () => {
			expect(
				refusalsOf(
					alphaProgram(
						"Shape",
						"#Square(4)",
						"\tchoice Shape {",
						"\t\tCircle { radius: Integer },",
						"\t\tSquare { side: Integer },",
						"\t}",
						"",
						"\tnamespace Shapes for Shape is Sized, is Alpha {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"\t}",
						"",
						"\tconstant c = Shape#Circle(2)",
						"\tTerminal.inspect(gauge(c))",
					),
				),
			).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'Shapes' does not conform to 'Sized'",
					["this needs Shape#Circle to conform"],
				],
			])
		})

		it("should offer to annotate a Case a body answers with its Choice", () => {
			expect(
				helpsOf(
					alphaProgram(
						"Shape",
						"#Square(4)",
						"\tchoice Shape {",
						"\t\tCircle { radius: Integer },",
						"\t\tSquare { side: Integer },",
						"\t}",
						"",
						"\tnamespace Shapes for Shape is Sized, is Alpha {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"\t}",
						"",
						"\tconstant c = Shape#Circle(2)",
						"\tTerminal.inspect(gauge(c))",
					),
				),
			).toEqual([
				"Answer 'Self' from the body 'Alpha' provides, or annotate the value at 'Shape', since a bare Case binds the Case, not the Choice.",
			])
		})

		// NOTE: The requirement takes any Number where the body takes `Self`, so
		// the body would answer an Integer's `pick` with a Rational.
		it("should refuse a narrower value a body takes a wider Argument for as `Self`", () => {
			expect(
				refusalsOf(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"\t\tpick(_ other: Number) -> Self",
						"\t}",
						"",
						"\tprotocol Alpha {",
						"\t\tpick(_ other: Self) -> Self {",
						"\t\t\t<- other",
						"\t\t}",
						"\t}",
						"",
						"\tnamespace NumberAll for Number is Sized, is Alpha {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"\t}",
						"",
						"\tfunction gauge<infer T is Sized>(_ x: T) -> T {",
						"\t\t<- x::pick(1/2)",
						"\t}",
						"",
						"\tconstant r: Integer = gauge(3)",
						"\tTerminal.inspect(r::isEven())",
						"}",
					].join("\n"),
				),
			).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'NumberAll' does not conform to 'Sized'",
					["this needs Integer to conform"],
				],
			])
		})

		// NOTE: `Sized` requires the `make` `Maker`'s body reads, as the Type the
		// Namespace answers it with, so the witness being solved answers it too.
		function madeProgram(made: string, ...lines: Array<string>): string {
			return [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				`\t\tmake() -> ${made}`,
				"\t\ttwin() -> Self",
				"\t}",
				"",
				"\tprotocol Maker {",
				"\t\tmake() -> Self",
				"",
				"\t\ttwin() -> Self {",
				"\t\t\t<- @::make()",
				"\t\t}",
				"\t}",
				"",
				...lines,
				"",
				"\tfunction gauge<infer T is Sized>(_ x: T) -> T {",
				"\t\t<- x::twin()",
				"\t}",
				"}",
			].join("\n")
		}

		const NUMBER_MAKER_REFUSAL: [string, string, Array<string>] = [
			"nonconforming-namespace",
			"Namespace 'NumberAll' does not conform to 'Sized'",
			["this needs Integer to conform"],
		]

		it("should refuse a body whose Protocol a narrower value does not hold where the witness being solved answers what it reads", () => {
			expect(
				refusalsOf(
					madeProgram(
						"Number",
						"\tnamespace NumberAll for Number is Sized, is Maker {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"",
						"\t\tmake() -> Number {",
						"\t\t\t<- 1/2",
						"\t\t}",
						"\t}",
						"",
						"\tconstant r: Integer = gauge(3)",
						"\tTerminal.inspect(r::add(1))",
					),
				),
			).toEqual([NUMBER_MAKER_REFUSAL])
		})

		it("should refuse it where a covering Union's Namespace answers what the body reads", () => {
			expect(
				refusalsOf(
					madeProgram(
						"Integer | String",
						...MIXED,
						"\tconstant r: Integer = gauge(3)",
						"\tTerminal.inspect(r::add(1))",
					),
				),
			).toEqual([MIXED_REFUSAL])
		})

		it("should refuse it where a Choice's Namespace answers what the body reads", () => {
			expect(
				refusalsOf(
					madeProgram(
						"Shape",
						"\tchoice Shape {",
						"\t\tCircle { radius: Integer },",
						"\t\tSquare { side: Integer },",
						"\t}",
						"",
						"\tnamespace Shapes for Shape is Sized, is Maker {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"",
						"\t\tmake() -> Shape {",
						"\t\t\t<- #Square(4)",
						"\t\t}",
						"\t}",
						"",
						"\tconstant c = Shape#Circle(2)",
						"\tTerminal.print(gauge(c).radius::add(1))",
					),
				),
			).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'Shapes' does not conform to 'Sized'",
					["this needs Shape#Circle to conform"],
				],
			])
		})

		it("should refuse it where a third Protocol's body answers what the body reads", () => {
			expect(
				refusalsOf(
					madeProgram(
						"Number",
						"\tprotocol Halver {",
						"\t\tmake() -> Number {",
						"\t\t\t<- 1/2",
						"\t\t}",
						"\t}",
						"",
						"\tnamespace NumberAll for Number is Sized, is Maker, is Halver {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"\t}",
						"",
						"\tconstant r: Integer = gauge(3)",
						"\tTerminal.inspect(r::add(1))",
					),
				),
			).toEqual([NUMBER_MAKER_REFUSAL])
		})

		it("should refuse it where the body hands a wider Argument on as `Self`", () => {
			expect(
				refusalsOf(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"\t\tkeep(_ other: Number) -> Number",
						"\t\tpick(_ other: Self) -> Self",
						"\t}",
						"",
						"\tprotocol Maker {",
						"\t\tkeep(_ other: Self) -> Self",
						"",
						"\t\tpick(_ other: Self) -> Self {",
						"\t\t\t<- @::keep(other)",
						"\t\t}",
						"\t}",
						"",
						"\tnamespace NumberAll for Number is Sized, is Maker {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"",
						"\t\tkeep(_ other: Number) -> Number {",
						"\t\t\t<- other::add(1/2)",
						"\t\t}",
						"\t}",
						"",
						"\tfunction gauge<infer T is Sized>(_ x: T, _ y: T) -> T {",
						"\t\t<- x::pick(y)",
						"\t}",
						"",
						"\tconstant r: Integer = gauge(3, 4)",
						"\tTerminal.inspect(r::add(1))",
						"}",
					].join("\n"),
				),
			).toEqual([NUMBER_MAKER_REFUSAL])
		})

		it("should say which entry a body reads a narrower value answers otherwise", () => {
			let source = madeProgram(
				"Number",
				"\tnamespace NumberAll for Number is Sized, is Maker {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"",
				"\t\tmake() -> Number {",
				"\t\t\t<- 1/2",
				"\t\t}",
				"\t}",
				"",
				"\tconstant r: Integer = gauge(3)",
				"\tTerminal.inspect(r::add(1))",
			)

			expect(notesOf(source)).toEqual([
				"'twin' runs the body 'Maker' provides, which reads 'make': at Integer 'NumberAll' answers it with a Number, where 'Maker' answers an Integer.",
			])
			expect(helpsOf(source)).toEqual([
				"Declare a Namespace for Integer that conforms to 'Sized'.",
			])
		})

		// NOTE: `Sized` does not require the `twin` the body reads, so only the
		// body's own Protocol holds it.
		it("should say which entry a body reads where the bound does not require it", () => {
			let source = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tdescribe() -> String",
				"\t}",
				"",
				"\tprotocol Twinned {",
				"\t\ttwin() -> Self",
				"",
				"\t\tdescribe() -> String {",
				"\t\t\tconstant t: Self = @::twin()",
				'\t\t\t<- "d{[t]::length()}"',
				"\t\t}",
				"\t}",
				"",
				"\tnamespace NumberN for Number is Sized, is Twinned {",
				"\t\ttwin() -> Number {",
				"\t\t\t<- 1/2",
				"\t\t}",
				"\t}",
				"",
				"\tfunction gauge<infer T is Sized>(_ t: T) -> String {",
				"\t\t<- t::describe()",
				"\t}",
				"",
				"\tconstant n: Number = 3",
				"\tTerminal.print(gauge(n))",
				"\tTerminal.print(gauge(3))",
				"}",
			].join("\n")

			expect(refusalsOf(source)).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'NumberN' does not conform to 'Sized'",
					["this needs Integer to conform"],
				],
			])
			expect(notesOf(source)).toEqual([
				"'describe' runs the body 'Twinned' provides, which reads 'twin': at Integer 'NumberN' answers it with a Number, where 'Twinned' answers an Integer.",
			])
			expect(helpsOf(source)).toEqual([
				"Declare a Namespace for Integer that conforms to 'Sized'.",
			])
		})

		it("should offer to annotate a Case whose Namespace answers an entry a body reads with its Choice", () => {
			expect(
				helpsOf(
					madeProgram(
						"Shape",
						"\tchoice Shape {",
						"\t\tCircle { radius: Integer },",
						"\t\tSquare { side: Integer },",
						"\t}",
						"",
						"\tnamespace Shapes for Shape is Sized, is Maker {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- 1",
						"\t\t}",
						"",
						"\t\tmake() -> Shape {",
						"\t\t\t<- #Square(4)",
						"\t\t}",
						"\t}",
						"",
						"\tconstant c = Shape#Circle(2)",
						"\tTerminal.print(gauge(c).radius::add(1))",
					),
				),
			).toEqual([
				"Annotate the value at 'Shape', since a bare Case binds the Case, not the Choice.",
			])
		})

		it("should say how a body that a body reads answers a narrower value", () => {
			let source = madeProgram(
				"Number",
				"\tprotocol Halver {",
				"\t\tmake() -> Number {",
				"\t\t\t<- 1/2",
				"\t\t}",
				"\t}",
				"",
				"\tnamespace NumberAll for Number is Sized, is Maker, is Halver {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"",
				"\tconstant r: Integer = gauge(3)",
				"\tTerminal.inspect(r::add(1))",
			)

			expect(notesOf(source)).toEqual([
				"'twin' runs the body 'Maker' provides, which reads 'make'.",
				"'make' runs the body 'Halver' provides, which answers a Number at Integer, where 'Maker' answers an Integer.",
			])
			expect(helpsOf(source)).toEqual([
				"Answer 'Self' from the body 'Halver' provides, or declare a Namespace for Integer that conforms to 'Sized'.",
			])
		})

		// NOTE: Each Protocol provides what the other requires, so each body is
		// curried with the other's witness.
		it("should build the witnesses of two Protocols that provide for each other", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"\t\tshown() -> String",
						"",
						"\t\tlabel() -> String {",
						'\t\t\t<- "s{@::size()}"',
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Tagged {",
						"\t\ttag() -> String",
						"\t\tlabel() -> String",
						"",
						"\t\tshown() -> String {",
						'\t\t\t<- "t{@::tag()} {@::label()}"',
						"\t\t}",
						"\t}",
						"",
						...integerNamespace(
							"is Sized, is Tagged",
							["size() -> Integer", "@"],
							["tag() -> String", '"i"'],
						),
						"",
						"\tfunction bySize<infer Item is Sized>(_ item: Item) -> String {",
						"\t\t<- item::shown()",
						"\t}",
						"",
						"\tfunction byTag<infer Item is Tagged>(_ item: Item) -> String {",
						"\t\t<- item::label()",
						"\t}",
						"",
						"\tTerminal.inspect(bySize(3))",
						"\tTerminal.inspect(byTag(4))",
						"}",
					].join("\n"),
				),
			).toEqual(['"ti s3"', '"s4"'])
		})

		it("should curry each body of a chain with its own Protocol's witness", async () => {
			expect(
				await run(
					gaugeProgram(
						[
							"\tprotocol Big is Sized {",
							"\t\textra() -> Integer",
							"\t\tlabel() -> String",
							"",
							"\t\tdescribe() -> String {",
							'\t\t\t<- "big {@::extra()} {@::label()}"',
							"\t\t}",
							"\t}",
							"",
							"\tprotocol Labelled {",
							"\t\tname() -> String",
							"",
							"\t\tlabel() -> String {",
							'\t\t\t<- "labelled {@::name()}"',
							"\t\t}",
							"\t}",
							"",
							...integerNamespace(
								"is Big, is Labelled",
								["size() -> Integer", "@"],
								["extra() -> Integer", "7"],
								["name() -> String", '"n"'],
							),
						],
						"\tTerminal.inspect(gauge(3))",
					),
				),
			).toEqual(['"big 7 labelled n"'])
		})

		// NOTE: The body's Protocol is conformed to under a condition the one
		// being solved does not carry, and the witness still needs it.
		const SHOWN_LISTS = [
			"\tprotocol Shown {",
			"\t\tfirst() -> String",
			"",
			"\t\tdescribe() -> String {",
			'\t\t\t<- "shown {@::first()}"',
			"\t\t}",
			"\t}",
			"",
			"\tnamespace Lists<infer Item> for List<Item> is Sized, is Shown where Item is Printable {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- @::length()",
			"\t\t}",
			"",
			"\t\tfirst<Item is Printable>() -> String {",
			"\t\t\t<- @::toString()",
			"\t\t}",
			"\t}",
		]

		it("should solve the conditions of the Protocol a body is curried for", async () => {
			expect(
				await run(
					gaugeProgram(
						SHOWN_LISTS,
						"\tTerminal.inspect(gauge([1, 2]))",
					),
				),
			).toEqual(['"shown [1, 2]"'])
		})

		it("should refuse a call where that Protocol's conditions do not hold", () => {
			let source = gaugeProgram(
				[...SHOWN_LISTS, "", "\ttype Opaque = { run: () -> Integer }"],
				"\tconstant opaque: Opaque = { run = () -> Integer { <- 1 } }",
				"\tTerminal.inspect(gauge([opaque]))",
			)

			expect(codesOf(source)).toEqual([
				"unsatisfied-conformance-condition",
			])
			expect(notesOf(source).slice(0, 3)).toEqual([
				"'describe' runs the body 'Shown' provides, which needs the conformance to 'Shown'.",
				"List<Opaque> does not conform to 'Shown'.",
				"Opaque does not conform to 'Printable'.",
			])
		})

		// NOTE: Where the witness being solved holds every Method the body's
		// Protocol has, and the same answer for each, the body is curried with
		// it.
		it("should curry a body with the witness being solved where that holds its Protocol", () => {
			let emitted = generate(
				gaugeProgram(
					[
						"\tprotocol Walled {",
						"\t\tsize() -> Integer",
						"",
						"\t\tdescribe() -> String {",
						'\t\t\t<- "walled {@::size()}"',
						"\t\t}",
						"\t}",
						"",
						...integerNamespace("is Walled, is Sized", [
							"size() -> Integer",
							"@",
						]),
					],
					"\tTerminal.inspect(gauge(3))",
				),
			)

			expect(emitted).toContain("$type.providedConformance(")
			expect(emitted).not.toContain("$type.providedConformances(")
		})

		it("should build the witnesses together where a body's Protocol asks for more", () => {
			let emitted = generate(
				gaugeProgram(
					[
						...BIG,
						"",
						...integerNamespace(
							"is Big",
							["size() -> Integer", "@"],
							["extra() -> Integer", "7"],
						),
					],
					"\tTerminal.inspect(gauge(3))",
				),
			)

			expect(emitted).toContain("$type.providedConformances(")
		})

		// NOTE: The witness being solved holds everything the body reads, so it is
		// the witness the body is curried with, whatever else its Protocol asks
		// for and under whichever conditions.
		function expectOneWitness(emitted: string): void {
			expect(emitted).toContain("$type.providedConformance(")
			expect(emitted).not.toContain("$type.providedConformances(")
		}

		// NOTE: `Big`'s body hands `@` on as another Protocol, which reads only
		// that Protocol's Methods off the witness.
		function handingOnProgram(
			sizedIs: string,
			bigIs: string,
			answer: string,
			...method: Array<string>
		): string {
			return [
				"implementation {",
				`\tprotocol Sized${sizedIs} {`,
				"\t\tsize() -> Integer",
				"\t\tdescribe() -> String",
				"\t}",
				"",
				`\tprotocol Big ${bigIs} {`,
				"\t\textra() -> String",
				"",
				"\t\tdescribe() -> String {",
				`\t\t\t<- ${answer}`,
				"\t\t}",
				"\t}",
				"",
				"\ttype Box = { value: Integer }",
				"",
				"\tnamespace Boxes for Box is Big {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.value",
				"\t\t}",
				"",
				"\t\textra() -> String {",
				'\t\t\t<- "e"',
				"\t\t}",
				"",
				...method,
				"\t}",
				"",
				"\tfunction gauge<infer Item is Sized>(_ item: Item) -> String {",
				"\t\t<- item::describe()",
				"\t}",
				"",
				"\tconstant box: Box = { value = 3 }",
				"\tTerminal.inspect(gauge(box))",
				"}",
			].join("\n")
		}

		const BOX_TO_STRING = [
			"\t\ttoString() -> String {",
			'\t\t\t<- "box{@.value}"',
			"\t\t}",
		]

		it("should curry a body that interpolates `@` with the witness being solved where that is Printable", async () => {
			let source = handingOnProgram(
				" is Printable",
				"is Sized",
				'"Big {@}"',
				...BOX_TO_STRING,
			)

			expect(await run(source)).toEqual(['"Big box3"'])
			expectOneWitness(generate(source))
		})

		it("should curry a body that hands `@` on as Equatable with the witness being solved where that is", async () => {
			let source = handingOnProgram(
				" is Equatable",
				"is Sized",
				'"Big {[@]::contains(@)}"',
				"\t\tis(_ other: Box) -> Boolean {",
				"\t\t\t<- @.value::is(other.value)",
				"\t\t}",
			)

			expect(await run(source)).toEqual(['"Big true"'])
			expectOneWitness(generate(source))
		})

		it("should build the witnesses together where the one being solved is not Printable", async () => {
			let source = handingOnProgram(
				"",
				"is Sized, is Printable",
				'"Big {@}"',
				...BOX_TO_STRING,
			)

			expect(await run(source)).toEqual(['"Big box3"'])
			expect(generate(source)).toContain("$type.providedConformances(")
		})

		const SHOWN_ON_NOTHING = [
			"\tprotocol Shown {",
			"\t\tfirst() -> String",
			"",
			"\t\tdescribe() -> String {",
			'\t\t\t<- "shown"',
			"\t\t}",
			"\t}",
			"",
			"\tnamespace Lists<infer Item> for List<Item> is Sized, is Shown where Item is Printable {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- @::length()",
			"\t\t}",
			"",
			"\t\tfirst<Item is Printable>() -> String {",
			'\t\t\t<- "first"',
			"\t\t}",
			"\t}",
		]

		it("should not ask for the conditions of a Protocol whose body reads nothing more", async () => {
			let source = gaugeProgram(
				[
					...SHOWN_ON_NOTHING,
					"",
					"\ttype Opaque = { run: () -> Integer }",
				],
				"\tconstant opaque: Opaque = { run = () -> Integer { <- 1 } }",
				"\tTerminal.inspect(gauge([opaque]))",
				"\tTerminal.inspect([opaque]::size())",
			)

			expect(await run(source)).toEqual(['"shown"', "1"])
			expectOneWitness(generate(source))
		})

		it("should pool the witness a generic caller builds where the body reads nothing more", async () => {
			let source = gaugeProgram(
				[
					...SHOWN_ON_NOTHING,
					"",
					"\tfunction outer<infer Thing is Printable>(_ thing: Thing) -> String {",
					"\t\t<- gauge([thing, thing])",
					"\t}",
					"",
					"\tfunction unbounded<infer Thing>(_ thing: Thing) -> String {",
					"\t\t<- gauge([thing])",
					"\t}",
				],
				"\tTerminal.inspect(outer(4))",
				"\tTerminal.inspect(unbounded(5))",
			)
			let emitted = generate(source)

			expect(await run(source)).toEqual(['"shown"', '"shown"'])
			expect(emitted).toMatch(
				/const \$pool_\d+ = \$type\.providedConformance\(/,
			)
			expectOneWitness(emitted)
		})

		const BIG_ON_SIZE = [
			"\tprotocol Big is Sized {",
			"\t\textra() -> String",
			"",
			"\t\tdescribe() -> String {",
			'\t\t\t<- "Big {@::size()}"',
			"\t\t}",
			"\t}",
		]

		it("should curry a descendant's body that reads its ancestor with the ancestor's witness", async () => {
			let source = gaugeProgram(
				[
					...BIG_ON_SIZE,
					"",
					...integerNamespace(
						"is Big",
						["size() -> Integer", "@"],
						["extra() -> String", '"e"'],
					),
				],
				"\tTerminal.inspect(gauge(3))",
			)

			expect(await run(source)).toEqual(['"Big 3"'])
			expectOneWitness(generate(source))
		})

		it("should curry it so under a condition a generic caller hands on", async () => {
			let source = gaugeProgram(
				[
					...BIG_ON_SIZE,
					"",
					"\tnamespace ListBig<infer ItemType> for List<ItemType> is Big where ItemType is Printable {",
					"\t\tsize() -> Integer {",
					"\t\t\t<- @::length()",
					"\t\t}",
					"",
					"\t\textra() -> String {",
					"\t\t\t<- @::length()::toString()",
					"\t\t}",
					"\t}",
					"",
					"\tfunction outer<infer Thing is Printable>(_ thing: Thing) -> String {",
					"\t\t<- gauge([thing, thing])",
					"\t}",
				],
				"\tTerminal.inspect(outer(4))",
				'\tTerminal.inspect(outer("a"))',
			)

			expect(await run(source)).toEqual(['"Big 2"', '"Big 2"'])
			expectOneWitness(generate(source))
		})

		// NOTE: `Coded` restates the `tag` that `Labelled`'s body reads.
		function restatingProgram(
			tagged: string,
			restated: string,
			...lines: Array<string>
		): string {
			return [
				"implementation {",
				"\tprotocol Labelled {",
				"\t\tname() -> String",
				"",
				`\t\ttag() -> ${tagged} {`,
				'\t\t\t<- "L"',
				"\t\t}",
				"",
				"\t\tlabel() -> String {",
				'\t\t\t<- "{@::tag()}!"',
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Coded is Labelled {",
				`\t\ttag() -> ${restated} {`,
				'\t\t\t<- "C"',
				"\t\t}",
				"\t}",
				"",
				"\tnamespace IntegerCoded for Integer is Coded {",
				"\t\tname() -> String {",
				'\t\t\t<- "i"',
				"\t\t}",
				"\t}",
				"",
				"\tfunction byLabelled<infer T is Labelled>(_ t: T) -> String {",
				"\t\t<- t::label()",
				"\t}",
				"",
				"\tfunction byCoded<infer T is Coded>(_ t: T) -> String {",
				"\t\t<- t::label()",
				"\t}",
				"",
				...lines,
				"}",
			].join("\n")
		}

		it("should curry an ancestor's body with the witness being solved where a descendant restates what it reads", async () => {
			expect(
				await run(
					restatingProgram(
						"String",
						"String",
						"\tTerminal.inspect(byLabelled(3))",
						"\tTerminal.inspect(3::label())",
						"\tTerminal.inspect(byCoded(3))",
					),
				),
			).toEqual(['"C!"', '"C!"', '"C!"'])
		})

		it("should refuse a descendant restating what an ancestor's body reads with another Type", () => {
			expect(
				refusalsOf(
					restatingProgram(
						"String",
						"Integer",
						"\tTerminal.inspect(byCoded(3))",
					).replace('<- "C"', "<- 7"),
				),
			).toEqual([
				[
					"incompatible-restatement",
					"Protocol 'Coded' restates 'tag' with a signature 'Labelled' does not accept",
					["'Labelled' declares it as 'tag() -> String'"],
				],
			])
		})

		it("should refuse a Protocol whose two extensions declare what a body reads apart", () => {
			expect(
				refusalsOf(
					[
						"implementation {",
						"\tprotocol Named {",
						"\t\tname() -> String",
						"\t}",
						"",
						"\tprotocol Labelled is Named {",
						"\t\ttag() -> String {",
						'\t\t\t<- "L"',
						"\t\t}",
						"",
						"\t\tlabel() -> String {",
						'\t\t\t<- @::tag()::append("?")',
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Coded is Named {",
						"\t\ttag() -> Integer {",
						"\t\t\t<- 5",
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Both is Labelled, is Coded {",
						"\t\textra() -> String",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual([
				[
					"incompatible-restatement",
					"Protocol 'Both' inherits 'tag' with a signature 'Labelled' does not accept",
					[
						"'tag' comes from 'Coded' as 'tag() -> Integer'",
						"'Labelled' declares it as 'tag() -> String'",
					],
				],
			])
		})

		it("should refuse a descendant restating a requirement an ancestor's body reads", () => {
			expect(
				refusalsOf(
					[
						"implementation {",
						"\tprotocol Named {",
						"\t\tname() -> String",
						"",
						"\t\tshow() -> String {",
						'\t\t\t<- "n {@::name()::append("?")}"',
						"\t\t}",
						"",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @::name()::length()",
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Coded is Named {",
						"\t\tname() -> List<Integer>",
						"\t}",
						"",
						"\tnamespace IntegerCoded for Integer is Coded {",
						"\t\tname() -> List<Integer> {",
						"\t\t\t<- [@, @, @]",
						"\t\t}",
						"\t}",
						"",
						"\tfunction byCoded<infer T is Coded>(_ x: T) -> String {",
						'\t\t<- "{x::show()} {x::size()::add(1)}"',
						"\t}",
						"",
						"\tTerminal.print(byCoded(4))",
						"}",
					].join("\n"),
				),
			).toEqual([
				[
					"incompatible-restatement",
					"Protocol 'Coded' restates 'name' with a signature 'Named' does not accept",
					["'Named' declares it as 'name() -> String'"],
				],
			])
		})

		// NOTE: `merge` answers `Self` with the Namespace's target, which a value
		// narrower than the target does not; the body reads only `size`.
		it("should curry a body with the witness a narrower value is solved for", async () => {
			let source = gaugeProgram(
				[
					"\tprotocol Merged {",
					"\t\tsize() -> Integer",
					"\t\tmerge(_ other: Self) -> Self",
					"",
					"\t\tdescribe() -> String {",
					'\t\t\t<- "merged {@::size()}"',
					"\t\t}",
					"\t}",
					"",
					"\tchoice Color {",
					"\t\tRed,",
					"\t\tGreen,",
					"\t}",
					"",
					"\ttype Circle = { radius: Integer }",
					"\ttype Square = { side: Integer }",
					"\ttype Shape = Circle | Square",
					"",
					...[
						["NumberBoth", "Number", "1"],
						["Colors", "Color", "2"],
						["Shapes", "Shape", "3"],
					].flatMap(([name, target, size]) => [
						`\tnamespace ${name} for ${target} is Sized, is Merged {`,
						"\t\tsize() -> Integer {",
						`\t\t\t<- ${size}`,
						"\t\t}",
						"",
						`\t\tmerge(_ other: ${target}) -> ${target} {`,
						"\t\t\t<- @",
						"\t\t}",
						"\t}",
						"",
					]),
				],
				"\tconstant circle: Circle = { radius = 2 }",
				"\tTerminal.inspect(gauge(3))",
				"\tTerminal.inspect(gauge(Color#Red))",
				"\tTerminal.inspect(gauge(circle))",
			)

			expect(await run(source)).toEqual([
				'"merged 1"',
				'"merged 2"',
				'"merged 3"',
			])
			expectOneWitness(generate(source))
		})

		// NOTE: `Equatable`'s `isNot` reads `is`, which the Choices derive.
		it("should curry a body with the equality a Choice derives", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Differ {",
						"\t\tisNot(_ other: Self) -> Boolean",
						"\t}",
						"",
						"\ttype Box = { n: Integer }",
						"",
						"\tnamespace Boxes for Box is Equatable {",
						"\t\tis(_ other: Box) -> Boolean {",
						"\t\t\t<- true",
						"\t\t}",
						"\t}",
						"",
						"\tchoice Color {",
						"\t\tRed,",
						"\t\tGreen,",
						"\t}",
						"",
						"\tchoice Crate {",
						"\t\tFull { box: Box },",
						"\t\tEmpty,",
						"\t}",
						"",
						"\tnamespace Colors for Color is Equatable, is Differ {}",
						"",
						"\tnamespace Crates for Crate is Equatable, is Differ {}",
						"",
						"\tfunction differs<infer Item is Differ>(_ a: Item, _ b: Item) -> Boolean {",
						"\t\t<- a::isNot(b)",
						"\t}",
						"",
						"\tconstant red: Color = Color#Red",
						"\tconstant one: Crate = Crate#Full({ box = { n = 1 } })",
						"\tconstant two: Crate = Crate#Full({ box = { n = 2 } })",
						"\tconstant empty: Crate = Crate#Empty",
						"\tTerminal.inspect(differs(red, Color#Green))",
						"\tTerminal.inspect(differs(red, red))",
						"\tTerminal.inspect(differs(one, two))",
						"\tTerminal.inspect(differs(one, empty))",
						"}",
					].join("\n"),
				),
			).toEqual(["true", "false", "false", "true"])
		})

		it("should report nothing more of a Choice that names itself", () => {
			expect(
				codesOf(
					[
						"implementation {",
						"\tprotocol Differ {",
						"\t\tisNot(_ o: Self) -> Boolean",
						"\t}",
						"",
						"\tchoice Tree {",
						"\t\tLeaf,",
						"\t\tNode { kids: List<Tree> },",
						"\t}",
						"",
						"\tnamespace Trees for Tree is Differ, is Equatable {}",
						"",
						"\tfunction differs<infer Item is Differ>(_ a: Item, _ b: Item) -> Boolean {",
						"\t\t<- a::isNot(b)",
						"\t}",
						"",
						"\tconstant leaf: Tree = Tree#Leaf",
						"\tTerminal.inspect(differs(leaf, Tree#Node([Tree#Leaf])))",
						"}",
					].join("\n"),
				),
			).toEqual(["recursive-type-declaration", "nonconforming-namespace"])
		})

		// NOTE: A body that hands `@` on reads its witness whole.
		it("should curry a body that hands its value on with its own Protocol's witness", async () => {
			expect(
				await run(
					gaugeProgram(
						[
							"\tprotocol Shown is Printable {",
							"\t\textra() -> Integer",
							"",
							"\t\tdescribe() -> String {",
							'\t\t\t<- "shown {@}"',
							"\t\t}",
							"\t}",
							"",
							"\ttype Box = { n: Integer }",
							"",
							"\tnamespace Boxes for Box is Sized, is Shown {",
							"\t\tsize() -> Integer {",
							"\t\t\t<- @.n",
							"\t\t}",
							"",
							"\t\textra() -> Integer {",
							"\t\t\t<- 1",
							"\t\t}",
							"",
							"\t\ttoString() -> String {",
							'\t\t\t<- "box {@.n}"',
							"\t\t}",
							"\t}",
						],
						"\tconstant box: Box = { n = 3 }",
						"\tTerminal.inspect(gauge(box))",
					),
				),
			).toEqual(['"shown box 3"'])
		})

		// NOTE: The literal's Parameter is a `Self`, from the requirement it is
		// handed to, and sorting or searching a List of it hands the witness on.
		// `Walker` holds `visit` too, so its witness holds all the body names.
		function visiting(
			extending: string,
			written: Array<string>,
			...body: Array<string>
		): string {
			return [
				"implementation {",
				"\tprotocol Walker {",
				"\t\tvisit(_ f: (_: Self) -> String) -> String",
				"\t\tdescribe() -> String",
				"\t}",
				"",
				`\tprotocol Visited is ${extending} {`,
				"\t\tvisit(_ f: (_: Self) -> String) -> String",
				"",
				"\t\tdescribe() -> String {",
				"\t\t\t<- @::visit((item) {",
				...body.map((line) => `\t\t\t\t${line}`),
				"\t\t\t})",
				"\t\t}",
				"\t}",
				"",
				"\ttype Box = { n: Integer }",
				"",
				"\tnamespace Boxes for Box is Walker, is Visited {",
				"\t\tvisit(_ f: (_: Box) -> String) -> String {",
				"\t\t\t<- f(@)",
				"\t\t}",
				"",
				...written.map((line) => `\t\t${line}`),
				"\t}",
				"",
				"\tfunction walk<infer Item is Walker>(_ item: Item) -> String {",
				"\t\t<- item::describe()",
				"\t}",
				"",
				"\tconstant box: Box = { n = 3 }",
				"\tTerminal.inspect(walk(box))",
				"\tTerminal.inspect(box::describe())",
				"}",
			].join("\n")
		}

		it("should curry a body whose Function literal sorts its `Self` with its own Protocol's witness", async () => {
			expect(
				await run(
					visiting(
						"Comparable",
						[
							"compare(to other: Box) -> Ordering {",
							"\t<- @.n::compare(to other.n)",
							"}",
						],
						"constant sorted = [item, item]::sort()",
						"",
						'<- "sorted {sorted::length()}"',
					),
				),
			).toEqual(['"sorted 2"', '"sorted 2"'])
		})

		it("should curry a body whose Function literal searches for its `Self` with its own Protocol's witness", async () => {
			expect(
				await run(
					visiting(
						"Equatable",
						[
							"is(_ other: Box) -> Boolean {",
							"\t<- @.n::is(other.n)",
							"}",
						],
						"constant found = [item]::contains(item)",
						"",
						'<- "found {found}"',
					),
				),
			).toEqual(['"found true"', '"found true"'])
		})

		// NOTE: `Shown`'s body builds a List of `@` and only counts it, so it
		// reads nothing of its witness and its Protocol's condition is not asked
		// for. Sorting the List instead hands the witness on.
		function counting(item: string, ...body: Array<string>): string {
			return gaugeProgram(
				[
					"\tprotocol Tagged {",
					"\t\ttag() -> String",
					"\t}",
					"",
					"\tprotocol Shown is Comparable {",
					"\t\textra() -> String",
					"",
					"\t\tdescribe() -> String {",
					...body.map((line) => `\t\t\t${line}`),
					"\t\t}",
					"\t}",
					"",
					"\ttype Box<Item> = { item: Item }",
					"",
					"\tnamespace Boxes<infer Item> for Box<Item> is Sized, is Shown where Item is Tagged {",
					"\t\tsize() -> Integer {",
					"\t\t\t<- 1",
					"\t\t}",
					"",
					"\t\textra<Item is Tagged>() -> String {",
					"\t\t\t<- @.item::tag()",
					"\t\t}",
					"",
					"\t\tcompare<Item is Tagged>(to other: Box<Item>) -> Ordering {",
					"\t\t\t<- @.item::tag()::compare(to other.item::tag())",
					"\t\t}",
					"\t}",
					"",
					"\ttype Opaque = { n: Integer }",
					"",
					"\tnamespace IntegerTagged for Integer is Tagged {",
					"\t\ttag() -> String {",
					'\t\t\t<- "t{@}"',
					"\t\t}",
					"\t}",
				],
				"\tconstant opaque: Opaque = { n = 1 }",
				`\tconstant box: Box<${item}> = { item = ${item === "Opaque" ? "opaque" : "2"} }`,
				"\tTerminal.inspect(gauge(box))",
			)
		}

		it("should not ask for the condition of a Protocol whose body only counts a List of `@`", async () => {
			let source = counting(
				"Opaque",
				"constant items = [@]",
				"",
				'<- "shown {items::length()}"',
			)

			expect(await run(source)).toEqual(['"shown 1"'])
			expectOneWitness(generate(source))
		})

		it("should ask for it where the body sorts that List", () => {
			expect(
				codesOf(
					counting(
						"Opaque",
						"constant items = [@, @]::sort()",
						"",
						'<- "shown {items::length()}"',
					),
				),
			).toEqual(["unsatisfied-conformance-condition"])
		})

		it("should build the witnesses together where the body sorts that List", async () => {
			let source = counting(
				"Integer",
				"constant items = [@, @]::sort()",
				"",
				'<- "shown {items::length()} {@::extra()}"',
			)

			expect(await run(source)).toEqual(['"shown 2 t2"'])
			expect(generate(source)).toContain("$type.providedConformances(")
		})

		// NOTE: A provided `toString` stands in the group beside a body curried
		// with another witness, and is curried with its own.
		it("should curry a provided toString in a group with its own witness", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Shown {",
						"\t\ttoString() -> String",
						"\t\tdescribe() -> String",
						"\t}",
						"",
						"\tprotocol Named {",
						"\t\ttoString() -> String {",
						'\t\t\t<- "named"',
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Big {",
						"\t\textra() -> String",
						"",
						"\t\tdescribe() -> String {",
						'\t\t\t<- "big {@::extra()}"',
						"\t\t}",
						"\t}",
						"",
						"\ttype Box = { n: Integer }",
						"",
						"\tnamespace Boxes for Box is Shown, is Named, is Big {",
						"\t\textra() -> String {",
						'\t\t\t<- "e"',
						"\t\t}",
						"\t}",
						"",
						"\tfunction show<infer Item is Shown>(_ item: Item) -> String {",
						"\t\t<- item::describe()::append(item::toString())",
						"\t}",
						"",
						"\tconstant box: Box = { n = 1 }",
						"\tTerminal.inspect(show(box))",
						"}",
					].join("\n"),
				),
			).toEqual(['"big enamed"'])
		})

		// NOTE: Both of the Namespace's clauses carry `where Item is Sized`, so
		// the group for a nested List builds that condition once, not once per
		// member, and its size grows with the nesting rather than doubling.
		function nestedProgram(depth: number, ...lines: Array<string>): string {
			return gaugeProgram(
				[
					"\tprotocol Shown {",
					"\t\tfirst() -> String",
					"",
					"\t\tdescribe() -> String {",
					'\t\t\t<- "shown {@::first()}"',
					"\t\t}",
					"\t}",
					"",
					"\tnamespace Lists<infer Item> for List<Item> is Sized where Item is Sized, is Shown where Item is Sized {",
					"\t\tsize() -> Integer {",
					"\t\t\t<- @::length()",
					"\t\t}",
					"",
					"\t\tfirst() -> String {",
					'\t\t\t<- @::map((_ item: Item) -> String { <- item::describe() })::join(with " ")',
					"\t\t}",
					"\t}",
					"",
					...integerNamespace(
						"is Sized",
						["size() -> Integer", "@"],
						["describe() -> String", '"i{@}"'],
					),
					"",
					`\tfunction deep<infer Element is Sized>(_ items: ${"List<".repeat(depth)}Element${">".repeat(depth)}) -> String {`,
					"\t\t<- gauge(items)",
					"\t}",
				],
				...lines,
			)
		}

		function nested(depth: number): string {
			return `${"[".repeat(depth)}1${"]".repeat(depth)}`
		}

		it("should build each condition of a group once however deep the Type nests", async () => {
			expect(
				await run(
					nestedProgram(
						1,
						`\tTerminal.inspect(gauge(${nested(10)}))`,
					),
				),
			).toEqual([`"${"shown ".repeat(10)}i1"`])
		})

		it("should hand a generic caller's group each condition once", async () => {
			let source = nestedProgram(
				6,
				`\tTerminal.inspect(deep(${nested(6)}))`,
			)
			let emitted = generate(source)

			expect(await run(source)).toEqual([`"${"shown ".repeat(6)}i1"`])
			expect(
				emitted.split("$type.providedConformances(").length - 1,
			).toBe(6)
			expect(
				emitted.split("$type.boundConformance(").length - 1,
			).toBeLessThanOrEqual(6)
		})

		// NOTE: Each Protocol's body reads what only the other's witness holds,
		// so a nested List's group holds both, and each is built once however
		// deep the List. `deep` is declared only where it is called.
		function answeringProgram(depth: number, caller: string): string {
			return [
				"implementation {",
				"\tprotocol Ay {",
				"\t\ta() -> String",
				"\t\tx() -> String",
				"",
				"\t\ty() -> String {",
				'\t\t\t<- "ay {@::a()}"',
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Be {",
				"\t\tb() -> String",
				"\t\ty() -> String",
				"",
				"\t\tx() -> String {",
				'\t\t\t<- "bx {@::b()}"',
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Both is Ay, is Be {}",
				"",
				"\tnamespace Lists<infer Item> for List<Item> is Ay where Item is Ay, is Be where Item is Be {",
				"\t\ta() -> String {",
				'\t\t\t<- @::map((_ item: Item) -> String { <- item::y() })::join(with " ")',
				"\t\t}",
				"",
				"\t\tb() -> String {",
				'\t\t\t<- @::map((_ item: Item) -> String { <- item::y() })::join(with " ")',
				"\t\t}",
				"\t}",
				"",
				"\tnamespace IntegerBoth for Integer is Both {",
				"\t\ta() -> String {",
				'\t\t\t<- "a{@}"',
				"\t\t}",
				"",
				"\t\tb() -> String {",
				'\t\t\t<- "b{@}"',
				"\t\t}",
				"\t}",
				"",
				"\tfunction gauge<infer Item is Ay>(_ item: Item) -> String {",
				"\t\t<- item::x()",
				"\t}",
				"",
				...(caller === "deep"
					? [
							`\tfunction deep<infer Element is Both>(_ items: ${"List<".repeat(depth)}Element${">".repeat(depth)}) -> String {`,
							"\t\t<- gauge(items)",
							"\t}",
							"",
						]
					: []),
				`\tTerminal.inspect(${caller}(${nested(depth)}))`,
				"}",
			].join("\n")
		}

		// NOTE: An Integer's witnesses are a group of their own, and `deep`
		// hands its Element's witness in whole.
		it("should build each witness of a nested List's groups once", async () => {
			for (let [caller, groups] of [
				["deep", 4],
				["gauge", 5],
			] as const) {
				let source = answeringProgram(4, caller)

				expect(await run(source)).toEqual(['"bx ay ay ay ay a1"'])
				expect(
					generate(source).split("$type.providedConformances(")
						.length - 1,
				).toBe(groups)
			}
		})

		// NOTE: A chain of Protocols whose bodies each read their own requirement,
		// with a call bounded by each. The entries solved grow with the cube of
		// the depth where every inherited body's whole witness is solved.
		it("should solve a chain of bounds in work that grows with the square of its depth", () => {
			let chain = (depth: number): string =>
				[
					"implementation {",
					...Array.from({ length: depth }, (_, k) => [
						`\tprotocol P${k}${k === 0 ? "" : ` is P${k - 1}`} {`,
						`\t\tm${k}() -> String`,
						"",
						`\t\tk${k}() -> String {`,
						`\t\t\t<- @::m${k}()`,
						"\t\t}",
						"\t}",
						"",
					]).flat(),
					`\tnamespace IntegerN for Integer is P${depth - 1} {`,
					...Array.from({ length: depth }, (_, k) => [
						`\t\tm${k}() -> String {`,
						`\t\t\t<- "m${k}"`,
						"\t\t}",
						"",
					]).flat(),
					"\t}",
					"",
					...Array.from({ length: depth }, (_, k) => [
						`\tfunction via${k}<infer T is P${k}>(_ t: T) -> String {`,
						`\t\t<- t::k${k}()`,
						"\t}",
						"",
						`\tTerminal.inspect(via${k}(3))`,
					]).flat(),
					"}",
				].join("\n")
			let solved = (depth: number): number => {
				let solving = spyOn(conformance, "computeConformanceMethodMap")

				try {
					expect(
						containsErrors(
							enrich(parseWithDiagnostics(chain(depth)).program)
								.diagnostics,
						),
					).toBe(false)

					return solving.mock.calls
						.filter(([protocol]) => /^P[0-9]+$/.test(protocol.name))
						.reduce(
							(entries, [protocol]) =>
								entries + Object.keys(protocol.methods).length,
							0,
						)
				} finally {
					solving.mockRestore()
				}
			}

			expect(solved(32) / solved(16)).toBeLessThan(5)
		})

		// NOTE: Two Protocols providing `describe` beside `Sized`, and which of
		// them answers `gauge`'s bound. Whichever body runs can call every
		// Method of its own Protocol.
		describe("the body each conformer's bound runs", () => {
			function providing(
				name: string,
				extending: string,
				requirements: Array<string>,
				body: string,
				returns: string = "String",
			): Array<string> {
				return [
					`\tprotocol ${name}${extending === "" ? "" : ` is ${extending}`} {`,
					...requirements.map((requirement) => `\t\t${requirement}`),
					...(requirements.length === 0 ? [] : [""]),
					`\t\tdescribe() -> ${returns} {`,
					`\t\t\t<- ${body}`,
					"\t\t}",
					"\t}",
					"",
				]
			}

			const walled = providing(
				"Walled",
				"",
				["size() -> Integer"],
				'"W {@::size()}"',
			)
			const bigOnSize = providing("Big", "Sized", [], '"B {@::size()}"')
			const other = ["\tprotocol Other is Big {}", ""]
			const bigger = providing(
				"Bigger",
				"Big",
				["extra() -> Integer"],
				'"X {@::extra()}"',
			)
			const bigOnExtra = providing(
				"Big",
				"Sized",
				["extra() -> String"],
				'"Big {@::extra()}"',
			)
			const bigBesideExtra = providing(
				"Big",
				"Sized",
				["extra() -> String"],
				'"Big {@::size()}"',
			)
			const shown = providing(
				"Shown",
				"",
				["size() -> Integer"],
				'"Shown {@::size()}"',
			)
			const shownAsInteger = providing(
				"Shown",
				"",
				["size() -> Integer"],
				"@::size()::multiply(with 100)",
				"Integer",
			)
			const size: [string, string] = ["size() -> Integer", "@"]
			const extraString: [string, string] = ["extra() -> String", '"e"']
			const extraInteger: [string, string] = ["extra() -> Integer", "7"]

			const cases: Array<{
				shape: string
				declarations: Array<string>
				lines?: Array<string>
				printed: Array<string>
			}> = [
				{
					shape: "Walled before a Protocol extending Big twice over",
					declarations: [
						...walled,
						...bigOnSize,
						...other,
						...bigger,
						...integerNamespace(
							"is Walled, is Other, is Bigger",
							size,
							extraInteger,
						),
					],
					printed: ['"W 3"'],
				},
				{
					shape: "Walled before Big and a descendant of Big",
					declarations: [
						...walled,
						...bigOnSize,
						...bigger,
						...integerNamespace(
							"is Walled, is Big, is Bigger",
							size,
							extraInteger,
						),
					],
					printed: ['"W 3"'],
				},
				{
					shape: "Walled before a descendant of Big",
					declarations: [
						...walled,
						...bigOnSize,
						...bigger,
						...integerNamespace(
							"is Walled, is Bigger",
							size,
							extraInteger,
						),
					],
					printed: ['"W 3"'],
				},
				{
					shape: "Big before Shown",
					declarations: [
						...bigBesideExtra,
						...shown,
						...integerNamespace(
							"is Big, is Shown",
							size,
							extraString,
						),
					],
					printed: ['"Big 3"'],
				},
				{
					shape: "Big before a Shown answering an Integer",
					declarations: [
						...bigBesideExtra,
						...shownAsInteger,
						...integerNamespace(
							"is Big, is Shown",
							size,
							extraString,
						),
					],
					lines: ["\tTerminal.inspect(gauge(3)::length())"],
					printed: ['"Big 3"', "5"],
				},
				{
					shape: "a Shown answering an Integer before Big",
					declarations: [
						...bigBesideExtra,
						...shownAsInteger,
						...integerNamespace(
							"is Shown, is Big",
							size,
							extraString,
						),
					],
					printed: ['"Big 3"'],
				},
				{
					shape: "a Shown that asks for more than Sized before Big",
					declarations: [
						...bigOnExtra,
						...providing(
							"Shown",
							"",
							["size() -> Integer", "other() -> Integer"],
							'"Shown {@::size()}"',
						),
						...integerNamespace(
							"is Shown, is Big",
							size,
							["other() -> Integer", "5"],
							extraString,
						),
					],
					printed: ['"Shown 3"'],
				},
				{
					shape: "Shown before a Big that asks for its extra",
					declarations: [
						...bigOnExtra,
						...shown,
						...integerNamespace(
							"is Shown, is Big",
							size,
							extraString,
						),
					],
					printed: ['"Shown 3"'],
				},
				{
					shape: "a Big that asks for its extra before Shown",
					declarations: [
						...bigOnExtra,
						...shown,
						...integerNamespace(
							"is Big, is Shown",
							size,
							extraString,
						),
					],
					printed: ['"Big e"'],
				},
				{
					shape: "Shown before a Big on size",
					declarations: [
						...bigBesideExtra,
						...shown,
						...integerNamespace(
							"is Shown, is Big",
							size,
							extraString,
						),
					],
					printed: ['"Shown 3"'],
				},
				{
					shape: "Big before Shown, beside a pick of Big",
					declarations: [
						...bigBesideExtra,
						...shown,
						...integerNamespace(
							"is Big, is Shown",
							size,
							extraString,
						),
					],
					lines: ["\tTerminal.inspect(3::<Big>describe())"],
					printed: ['"Big 3"', '"Big 3"'],
				},
				{
					shape: "a Counted on size before Big",
					declarations: [
						...providing(
							"Counted",
							"",
							["size() -> Integer"],
							'"C {@::size()}"',
						),
						...providing(
							"Big",
							"Sized",
							["extra() -> Integer"],
							'"B {@::extra()}"',
						),
						...integerNamespace(
							"is Counted, is Big",
							size,
							extraInteger,
						),
					],
					printed: ['"C 3"'],
				},
			]

			for (let { shape, declarations, lines, printed } of cases) {
				it(`should run the body the rule picks for ${shape}`, async () => {
					expect(
						await run(
							gaugeProgram(
								declarations,
								"\tTerminal.inspect(gauge(3))",
								...(lines ?? []),
							),
						),
					).toEqual(printed)
				})
			}

			it("should still tie the two at a call that names neither", () => {
				let source = gaugeProgram(
					[
						...bigOnExtra,
						...shown,
						...integerNamespace(
							"is Shown, is Big",
							size,
							extraString,
						),
					],
					"\tTerminal.inspect(3::describe())",
				)

				expect(codesOf(source)).toEqual(["ambiguous-namespace"])
			})
		})
	})

	// NOTE: What a body reads decides whether the witness being solved can be
	// curried onto it, so it is pinned on the standard library's bodies and on
	// the shapes that hand `@` on.
	describe("what a provided body reads", () => {
		function readsOf(
			returns: string,
			...body: Array<string>
		): Array<string> {
			let enriched = enrich(
				parseWithDiagnostics(
					[
						"implementation {",
						"\tprotocol Shown is Equatable {",
						"\t\tsize() -> Integer",
						"\t\tmerge(_ other: Self) -> Self",
						"\t\tvisit(_ f: (_: Self) -> Boolean) -> Boolean",
						"",
						"\t\toverload label {",
						"\t\t\t() -> String",
						"\t\t\t(_ prefix: String) -> String",
						"\t\t}",
						"",
						`\t\tdescribe(_ other: Self) -> ${returns} {`,
						...body.map((line) => `\t\t\t${line}`),
						"\t\t}",
						"\t}",
						"}",
					].join("\n"),
				).program,
			)

			expect(containsErrors(enriched.diagnostics)).toBe(false)

			let declaration = enriched.program.implementation.nodes.find(
				(node) => node.nodeType === "ProtocolDeclarationStatement",
			) as common.typed.ProtocolDeclarationStatementNode

			return declaration.protocolType.providedReads?.describe ?? []
		}

		it("should read the Methods its body calls on `@` and on values of `Self`", () => {
			expect(
				readsOf(
					"Boolean",
					"<- @::merge(other)::is(other)::and(@::size()::isZero())",
				),
			).toEqual(["is", "size", "merge"])
		})

		it("should read every Overload of a Method it calls", () => {
			expect(readsOf("String", "<- @::label()")).toEqual([
				"label__overload$1",
				"label__overload$2",
			])
		})

		it("should read nothing where it answers with `@`", () => {
			expect(
				readsOf(
					"Self",
					"<- define {",
					"\tas other if true",
					"\tas @ otherwise",
					"}",
				),
			).toEqual([])
		})

		it("should read the entries of the Protocol it hands `@` on as", () => {
			expect(readsOf("String", '<- "{[@, other]::contains(@)}"')).toEqual(
				["is", "isNot"],
			)
			expect(readsOf("Boolean", "<- [other]::contains(@)")).toEqual([
				"is",
				"isNot",
			])
		})

		it("should read the entries of the Protocol `@` keys a Dictionary by", () => {
			expect(readsOf("Boolean", '<- [@ = "a"]::isEmpty()')).toEqual([
				"is",
				"isNot",
			])
		})

		// NOTE: The literal's Parameter is a `Self`, from the requirement it is
		// handed to.
		it("should read what a Function literal calls on the `Self` it is handed", () => {
			expect(
				readsOf(
					"Boolean",
					"<- @::visit((item) { <- item::size()::isZero() })",
				),
			).toEqual(["size", "visit"])
		})

		it("should read what a Function literal hands its `Self` on as", () => {
			expect(
				readsOf(
					"Boolean",
					"<- @::visit((item) {",
					"\tconstant found = [item]::contains(item)",
					"",
					"\t<- found",
					"})",
				),
			).toEqual(["is", "isNot", "visit"])
		})

		// NOTE: The body is typed once before the Program is, to read it, and
		// that typing leaves nothing behind for the one reported.
		it("should keep the report of a Function literal nothing types", () => {
			let source = [
				"implementation {",
				"\tprotocol Ranked is Comparable {",
				"\t\tsorter() -> (_: Self) -> Integer {",
				"\t\t\t<- (item) { <- [item, item]::sort()::length() }",
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toContain("uninferable-parameter-type")
		})

		// NOTE: Nothing the List is asked takes a witness for its items.
		it("should read nothing where a List of `@` is only counted", () => {
			expect(
				readsOf(
					"Boolean",
					"constant items = [@, other]",
					"",
					"<- items::length()::isZero()",
				),
			).toEqual([])
		})

		it("should read what each standard library body calls", () => {
			let { protocols } = loadStdlib()

			expect(protocols.Equatable?.providedReads).toEqual({
				isNot: ["is"],
			})
			expect(protocols.Comparable?.providedReads).toEqual({
				isLessThan: ["compare"],
				isLessThanOrEqualTo: ["isGreaterThan"],
				isGreaterThan: ["compare"],
				isGreaterThanOrEqualTo: ["isLessThan"],
			})
			expect(protocols.Orderable?.providedReads).toEqual({
				isBetween: [
					"isLessThanOrEqualTo",
					"isGreaterThan",
					"isGreaterThanOrEqualTo",
				],
				clamp: ["isLessThan", "isGreaterThan"],
			})
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

		// NOTE: The body writes no name the Program declares, and its emission
		// still reads `Helpers.shout`.
		it("should refuse a call of a Method a Namespace the Program declares", () => {
			let source = [
				"implementation {",
				"\tnamespace Helpers for Integer {",
				'\t\tshout() -> String { <- "H{@}" }',
				"\t}",
				"",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"",
				"\t\tdescribe() -> String {",
				"\t\t\t<- @::size()::shout()",
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["provided-method-out-of-reach"])
			expect(messagesOf(source)).toEqual([
				"'shout' can not be called from a provided Method",
			])
			expect(labelsOf(source)).toEqual([
				"this calls the 'shout' that 'Helpers' declares",
			])
			expect(notesOf(source)).toEqual([
				"A provided Method is emitted once, above every Program that reaches 'Sized', so its body can reach the standard library and nothing the Program declares.",
			])
			expect(helpsOf(source)).toEqual([
				"Give 'Sized' a requirement the body calls on '@' in place of this call, and let each conforming Namespace call 'shout'.",
			])
		})

		it("should name every Namespace a Union receiver may run the call off", () => {
			expect(
				labelsOf(
					[
						"implementation {",
						"\ttype Box = { n: Integer }",
						"",
						"\tnamespace Boxes for Box {",
						'\t\tshout() -> String { <- "box" }',
						"\t}",
						"",
						"\tnamespace Texts for String {",
						'\t\tshout() -> String { <- "text" }',
						"\t}",
						"",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tdescribe() -> String {",
						"\t\t\tconstant value: Box | String = { n = @::size() }",
						"",
						"\t\t\t<- value::shout()",
						"\t\t}",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual([
				"this calls the 'shout' that 'Boxes' and 'Texts' declare",
			])
		})

		it("should refuse a witness a Namespace the Program declares answers", () => {
			let source = [
				"implementation {",
				"\ttype Box = { n: Integer }",
				"",
				"\tnamespace Boxes for Box is Printable {",
				'\t\ttoString() -> String { <- "box" }',
				"\t}",
				"",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"",
				"\t\tdescribe() -> String {",
				"\t\t\tconstant box: Box = { n = @::size() }",
				"",
				'\t\t\t<- "held {box}"',
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["provided-method-out-of-reach"])
			expect(messagesOf(source)).toEqual([
				"'Boxes' can not be reached from a provided Method",
			])
			expect(labelsOf(source)).toEqual([
				"this needs the 'Printable' conformance that 'Boxes' declares",
			])
			expect(helpsOf(source)).toEqual([
				"Give 'Sized' a requirement the body calls on '@' in place of this, and let each conforming Namespace write it.",
			])
		})

		it("should refuse its own Protocol's conformance for a written value", () => {
			let source = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "size {@::size()}"',
				"\t\t}",
				"",
				"\t\tcompared() -> String {",
				'\t\t\t<- "{@::describe()} {7::describe()}"',
				"\t\t}",
				"\t}",
				"",
				"\tnamespace IntegerSized for Integer is Sized {",
				"\t\tsize() -> Integer { <- @ }",
				"\t}",
				"}",
			].join("\n")

			expect(messagesOf(source)).toEqual([
				"'IntegerSized' can not be reached from a provided Method",
			])
			expect(labelsOf(source)).toEqual([
				"this needs the 'Sized' conformance that 'IntegerSized' declares",
			])
		})

		// NOTE: `Boxes` writes nothing for Equatable, and the witness `contains`
		// needs is built together with its `Keyed` one, which reads `key` off it.
		it("should refuse a witness a group builds from a Namespace the Program declares", () => {
			let source = [
				"implementation {",
				"\ttype Box = { n: Integer }",
				"",
				"\tprotocol Keyed {",
				"\t\tkey() -> Integer",
				"",
				"\t\tis(_ other: Self) -> Boolean {",
				"\t\t\t<- @::key()::is(other::key())",
				"\t\t}",
				"\t}",
				"",
				"\tnamespace Boxes for Box is Equatable, is Keyed {",
				"\t\tkey() -> Integer { <- @.n }",
				"\t}",
				"",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"",
				"\t\tdescribe() -> String {",
				"\t\t\tconstant box: Box = { n = @::size() }",
				"",
				'\t\t\t<- "held {[box]::contains(box)}"',
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(messagesOf(source)).toEqual([
				"'Boxes' can not be reached from a provided Method",
			])
			expect(labelsOf(source)).toEqual([
				"this needs the 'Keyed' conformance that 'Boxes' declares",
			])
		})

		// NOTE: A witness names its Namespace once for each Method in its map, and
		// `IntegerTagged` writes none.
		it("should accept a witness whose Methods are all provided", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Tagged {",
						'\t\ttag() -> String { <- "t" }',
						"\t}",
						"",
						"\tnamespace IntegerTagged for Integer is Tagged {}",
						"",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tdescribe() -> String {",
						'\t\t\t<- "{@::size()::tag()} {@::size()}"',
						"\t\t}",
						"\t}",
						"",
						"\tnamespace IntegerSized for Integer is Sized {",
						"\t\tsize() -> Integer { <- @ }",
						"\t}",
						"",
						"\tTerminal.inspect(3::describe())",
						"}",
					].join("\n"),
				),
			).toEqual(['"t 3"'])
		})

		it("should accept a Namespace the body declares itself", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tnamespace Helpers for Integer {",
						'\t\tshout() -> String { <- "outer" }',
						"\t}",
						"",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tdescribe() -> String {",
						"\t\t\tnamespace Helpers for Integer {",
						'\t\t\t\tshout() -> String { <- "inner" }',
						"\t\t\t}",
						"",
						"\t\t\t<- @::size()::shout()",
						"\t\t}",
						"\t}",
						"",
						"\tnamespace IntegerSized for Integer is Sized {",
						"\t\tsize() -> Integer { <- @ }",
						"\t}",
						"",
						"\tTerminal.inspect(3::describe())",
						"}",
					].join("\n"),
				),
			).toEqual(['"inner"'])
		})

		// NOTE: The `Helpers` the `if` branch declares is a class of that branch,
		// so the `else` branch still reads the Program's.
		it("should refuse a call beside a block declaring a Namespace of its name", () => {
			let source = [
				"implementation {",
				"\tnamespace Helpers for Integer {",
				'\t\tshout() -> String { <- "outer" }',
				"\t}",
				"",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"",
				"\t\tdescribe() -> String {",
				"\t\t\tif @::size()::isGreaterThan(100) {",
				"\t\t\t\tnamespace Helpers for String {",
				'\t\t\t\t\twhisper() -> String { <- "inner" }',
				"\t\t\t\t}",
				"",
				'\t\t\t\t<- "a"::whisper()',
				"\t\t\t} else {",
				"\t\t\t\t<- @::size()::shout()",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["provided-method-out-of-reach"])
			expect(labelsOf(source)).toEqual([
				"this calls the 'shout' that 'Helpers' declares",
			])
		})

		it("should accept a Namespace a block around the call declares", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\ttype Box = { n: Integer }",
						"",
						"\tnamespace Helpers for Integer {",
						'\t\tshout() -> String { <- "outer" }',
						"\t}",
						"",
						"\tnamespace Boxes for Box is Printable {",
						'\t\ttoString() -> String { <- "outer" }',
						"\t}",
						"",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"",
						"\t\tdescribe() -> String {",
						"\t\t\tnamespace Helpers for Integer {",
						'\t\t\t\twhisper() -> String { <- "inner{@}" }',
						"\t\t\t}",
						"",
						"\t\t\tconstant size = @::size()",
						"\t\t\tconstant whispered = () -> String {",
						"\t\t\t\t<- size::whisper()",
						"\t\t\t}",
						"\t\t\tconstant boxed = (_ n: Integer) -> String {",
						"\t\t\t\tnamespace Boxes for Box is Printable {",
						'\t\t\t\t\ttoString() -> String { <- "box{@.n}" }',
						"\t\t\t\t}",
						"",
						"\t\t\t\tconstant box: Box = { n = n }",
						"",
						'\t\t\t\t<- "{box}"',
						"\t\t\t}",
						"",
						'\t\t\t<- "{whispered()} {boxed(size)}"',
						"\t\t}",
						"\t}",
						"",
						"\tnamespace IntegerSized for Integer is Sized {",
						"\t\tsize() -> Integer { <- @ }",
						"\t}",
						"",
						"\tTerminal.inspect(3::describe())",
						"}",
					].join("\n"),
				),
			).toEqual(['"inner3 box3"'])
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
				"\t\tspread<Item is Comparable>(",
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

		// NOTE: The same spelling on a Protocol-bounded Type Parameter, which
		// is what the Parameter's conformance is FOR: `Item` is no Namespace,
		// and the witness the call was handed is what answers. It is the only
		// spelling a static requirement has, and it reaches the instance
		// Methods for the same reason — the witness holds every Method the
		// Protocol declares.
		it("should answer a bounded Type Parameter's own conformance", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tfunction differ <infer Item is Equatable>(_ a: Item, _ b: Item) -> Boolean {",
						"\t\t<- Item.isNot(a, b)",
						"\t}",
						"",
						"\tfunction held <infer Item is Orderable>(_ a: Item, _ b: Item) -> Item {",
						"\t\t<- Item.clamp(a, between b, and b)",
						"\t}",
						"",
						"\tTerminal.inspect(differ(1, 2))",
						'\tTerminal.inspect(differ("a", "a"))',
						"\tTerminal.inspect(held(5, 9))",
						"}",
					].join("\n"),
				),
			).toEqual(["true", "false", "9"])
		})

		it("should refuse a name the bound's Protocol does not declare", () => {
			let source = [
				"implementation {",
				"\tfunction differ <infer Item is Equatable>(_ a: Item) -> Boolean {",
				"\t\t<- Item.isBigger(a, a)",
				"\t}",
				"",
				"\tTerminal.inspect(differ(1))",
				"}",
			].join("\n")

			expect(codesOf(source)).toEqual(["unknown-name"])
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

		// NOTE: The Arguments are matched against the Namespace's own rung, so
		// a call that misses is the ordinary Argument mismatch the `::`
		// spelling reports — never the Compiler's own bug channel, which is
		// where a bounded Signature's missing witness used to send it.
		//
		// NOTE: `Boolean` rather than `Integer`, because `Integer` WRITES an
		// `isNot` of its own now — a two entry Overload, whose misses are
		// `no-matching-overload` and say nothing about a provided Method.
		// Boolean's `isNot` is `Equatable`'s, which is what this asks about.
		it("should report the Arguments the pinned signature rejects", () => {
			expect(
				codesOf(
					[
						"implementation {",
						'\tTerminal.inspect(Boolean.isNot(true, "x"))',
						"}",
					].join("\n"),
				),
			).toEqual(["argument-type-mismatch"])

			expect(
				codesOf(
					[
						"implementation {",
						"\tTerminal.inspect(Boolean.isNot(true))",
						"}",
					].join("\n"),
				),
			).toEqual(["argument-count-mismatch"])

			expect(
				codesOf(
					[
						"implementation {",
						'\tTerminal.inspect(Boolean.isNot("y", "x"))',
						"}",
					].join("\n"),
				),
			).toEqual(["argument-type-mismatch", "argument-type-mismatch"])
		})

		// NOTE: The same hole, on the shape it was always reachable through —
		// a bounded free Function nothing selected. A `<Item is Equatable>` is
		// a Signature with a witness to solve like any other, and its Arguments
		// missing is the Program's mistake, not the Compiler's.
		it("should report the Arguments a bounded Function rejects", () => {
			let bounded = [
				"implementation {",
				"\tfunction differs<infer Item is Equatable>(",
				"\t\t_ value: Item,",
				"\t\t_ other: Item",
				"\t) -> Boolean {",
				"\t\t<- value::isNot(other)",
				"\t}",
				"",
			]

			expect(
				codesOf(
					[
						...bounded,
						'\tTerminal.inspect(differs(3, "x"))',
						"}",
					].join("\n"),
				),
			).toEqual(["argument-type-mismatch"])

			expect(
				codesOf(
					[...bounded, "\tTerminal.inspect(differs(3))", "}"].join(
						"\n",
					),
				),
			).toEqual(["argument-count-mismatch"])
		})
	})

	// NOTE: A provided Method is a candidate of EVERY Namespace that declares
	// the conformance, ranked by that Namespace's target exactly as a written
	// Method is — so a question the narrow Namespace's rung rejects falls to the
	// covering one's, which is the continuation `5::compare(1/2)` has always
	// had. The standard library is where the ladder has more than one rung:
	// `Integer`, `Rational` and `Algebraic` each conform to `Orderable`, and the
	// covering `Number` conforms too.
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
			expect(generate(source)).not.toContain("$es_Comparable__isLessThan")
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
						"\t\tcase Algebraic { <- @::isLessThan(2) }",
						"\t\tcase Integer   { <- @::isLessThan(2) }",
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
						"\tTerminal.inspect(3::<Comparable>isLessThan(Number.Pi))",
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

	// NOTE: A descendant's witness answers every bound on its ancestors, so each
	// Method it restates keeps a signature the ancestor accepts under its key.
	describe("a restated Method", () => {
		// NOTE: `A` and a descendant `B`, a Namespace conforming to `B`, and a
		// Function bounded by `B` that hands its value on to one bounded by `A`.
		function handedOnProgram(
			ancestor: Array<string>,
			descendant: Array<string>,
			conformer: Array<string>,
		): string {
			return [
				"implementation {",
				"\tprotocol A {",
				...ancestor,
				"\t}",
				"",
				"\tprotocol B is A {",
				...descendant,
				"\t}",
				"",
				"\tnamespace IntegerB for Integer is B {",
				...conformer,
				"\t}",
				"",
				"\tfunction viaA<infer T is A>(_ t: T) -> String {",
				'\t\t<- "{t::z()}"',
				"\t}",
				"",
				"\tfunction hand<infer T is B>(_ t: T) -> String {",
				"\t\t<- viaA(t)",
				"\t}",
				"",
				"\tTerminal.inspect(viaA(3))",
				"\tTerminal.inspect(hand(3))",
				"}",
			].join("\n")
		}

		const OVERLOADED = [
			"\t\toverload z {",
			"\t\t\t() -> String",
			"\t\t\t(_ n: Integer) -> String",
			"\t\t}",
		]

		const OVERLOADS_WRITTEN = [
			"\t\toverload z {",
			"\t\t\t() -> String {",
			'\t\t\t\t<- "Nz"',
			"\t\t\t}",
			"",
			"\t\t\t(_ n: Integer) -> String {",
			'\t\t\t\t<- "Nz{n}"',
			"\t\t\t}",
			"\t\t}",
		]

		const REFUSED_Z: [string, string, Array<string>] = [
			"incompatible-restatement",
			"Protocol 'B' restates 'z' with a signature 'A' does not accept",
			["'A' declares it as 'z() -> String'"],
		]

		it("should refuse restating a provided Method as an overload", () => {
			let source = handedOnProgram(
				[
					"\t\ta() -> String",
					"",
					"\t\tz() -> String {",
					'\t\t\t<- "Az"',
					"\t\t}",
				],
				OVERLOADED,
				[
					"\t\ta() -> String {",
					'\t\t\t<- "ia"',
					"\t\t}",
					"",
					...OVERLOADS_WRITTEN,
				],
			)

			expect(refusalsOf(source)).toEqual([REFUSED_Z])
			expect(notesOf(source)).toEqual([
				"Whatever conforms to 'B' conforms to 'A' as well, so a call through 'A' reaches this 'z' and calls it as 'A' declares it.",
				"A call through 'A' reaches the one 'z' it declares, and an 'overload' block keeps each of its signatures as an entry of its own, so none of them is that one.",
			])
			expect(helpsOf(source)).toEqual([
				"Restate 'z' as the one signature 'A' declares for it, 'z() -> String', and give the other signatures a name of their own.",
			])
		})

		it("should refuse restating a requirement as an overload", () => {
			expect(
				refusalsOf(
					handedOnProgram(
						["\t\tz() -> String"],
						OVERLOADED,
						OVERLOADS_WRITTEN,
					),
				),
			).toEqual([REFUSED_Z])
		})

		it("should refuse restating a provided Method with another Type", () => {
			expect(
				refusalsOf(
					handedOnProgram(
						[
							"\t\ta() -> String",
							"",
							"\t\tz() -> String {",
							'\t\t\t<- "Az"',
							"\t\t}",
						],
						["\t\tz() -> Integer {", "\t\t\t<- 7", "\t\t}"],
						["\t\ta() -> String {", '\t\t\t<- "ia"', "\t\t}"],
					),
				),
			).toEqual([REFUSED_Z])
		})

		it("should refuse restating it with a Parameter the ancestor's does not take", () => {
			expect(
				refusalsOf(
					handedOnProgram(
						["\t\tz() -> String {", '\t\t\t<- "Az"', "\t\t}"],
						["\t\tz(_ n: Integer) -> String"],
						[
							"\t\tz(_ n: Integer) -> String {",
							'\t\t\t<- "Nz{n}"',
							"\t\t}",
						],
					),
				),
			).toEqual([REFUSED_Z])
		})

		it("should refuse restating a standard library requirement as an overload", () => {
			expect(
				refusalsOf(
					[
						"implementation {",
						"\tprotocol Odd is Equatable {",
						"\t\toverload is {",
						"\t\t\t(_ other: Self) -> Boolean",
						"\t\t\t(_ other: Integer) -> Boolean",
						"\t\t}",
						"",
						"\t\thas(_ o: Self) -> Boolean {",
						"\t\t\t<- [@]::contains(o)",
						"\t\t}",
						"\t}",
						"",
						"\ttype Bag = { k: Integer }",
						"",
						"\tnamespace Bags for Bag is Odd {",
						"\t\toverload is {",
						"\t\t\t(_ other: Bag) -> Boolean {",
						"\t\t\t\t<- @.k::is(other.k)",
						"\t\t\t}",
						"",
						"\t\t\t(_ other: Integer) -> Boolean {",
						"\t\t\t\t<- @.k::is(other)",
						"\t\t\t}",
						"\t\t}",
						"\t}",
						"",
						"\tfunction viaUser<infer T is Odd>(_ a: T, _ b: T) -> Boolean {",
						"\t\t<- [a]::contains(b)",
						"\t}",
						"",
						"\tconstant a: Bag = { k = 1 }",
						"\tTerminal.inspect(viaUser(a, a))",
						"}",
					].join("\n"),
				),
			).toEqual([
				[
					"incompatible-restatement",
					"Protocol 'Odd' restates 'is' with a signature 'Equatable' does not accept",
					["'Equatable' declares it as 'is(_ Self) -> Boolean'"],
				],
			])
		})

		it("should refuse a Protocol whose two extensions declare one Method apart", () => {
			let source = [
				"implementation {",
				"\tprotocol Labelled {",
				"\t\ttag() -> String {",
				'\t\t\t<- "L"',
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Coded {",
				"\t\ttag() -> Integer {",
				"\t\t\t<- 5",
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Both is Labelled, is Coded {}",
				"}",
			].join("\n")

			expect(refusalsOf(source)).toEqual([
				[
					"incompatible-restatement",
					"Protocol 'Both' inherits 'tag' with a signature 'Labelled' does not accept",
					[
						"'tag' comes from 'Coded' as 'tag() -> Integer'",
						"'Labelled' declares it as 'tag() -> String'",
					],
				],
			])
			expect(helpsOf(source)).toEqual([
				"Declare 'tag' with one signature in 'Coded' and 'Labelled', or give one of the two Methods a name of its own.",
			])
		})

		it("should report a conformance a refused restatement breaks only there", () => {
			expect(
				refusalsOf(
					[
						"implementation {",
						"\tprotocol Sized {",
						"\t\tsize() -> Integer",
						"\t\tdescribe() -> String",
						"\t}",
						"",
						"\tprotocol Base {",
						"\t\tsize() -> Integer",
						"",
						"\t\tdescribe() -> String {",
						'\t\t\t<- "base {@::size()}"',
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Derived is Base {",
						"\t\tdescribe(_ p: String) -> String {",
						'\t\t\t<- "derived {p} {@::size()}"',
						"\t\t}",
						"\t}",
						"",
						"\tnamespace IntegerD for Integer is Sized, is Derived {",
						"\t\tsize() -> Integer {",
						"\t\t\t<- @",
						"\t\t}",
						"\t}",
						"",
						"\tfunction gauge<infer Item is Sized>(_ item: Item) -> String {",
						"\t\t<- item::describe()",
						"\t}",
						"",
						"\tTerminal.print(gauge(3))",
						"}",
					].join("\n"),
				),
			).toEqual([
				[
					"incompatible-restatement",
					"Protocol 'Derived' restates 'describe' with a signature 'Base' does not accept",
					["'Base' declares it as 'describe() -> String'"],
				],
			])
		})

		it("should hand a value on through a requirement restated with its signature", async () => {
			expect(
				await run(
					handedOnProgram(
						["\t\tz() -> String"],
						["\t\tz() -> String"],
						["\t\tz() -> String {", '\t\t\t<- "Nz"', "\t\t}"],
					),
				),
			).toEqual(['"Nz"', '"Nz"'])
		})

		it("should hand a value on through a body restated with a narrower answer", async () => {
			expect(
				await run(
					handedOnProgram(
						["\t\tz() -> Number {", "\t\t\t<- 1/2", "\t\t}"],
						["\t\tz() -> Integer {", "\t\t\t<- 7", "\t\t}"],
						[],
					),
				),
			).toEqual(['"7"', '"7"'])
		})

		it("should hand a value on through an overload restated as its ancestor declares it", async () => {
			expect(
				await run(
					handedOnProgram(
						OVERLOADED,
						OVERLOADED,
						OVERLOADS_WRITTEN,
					).replace('"{t::z()}"', '"{t::z()} {t::z(5)}"'),
				),
			).toEqual(['"Nz Nz5"', '"Nz Nz5"'])
		})

		it("should accept a Method two extensions reach from one ancestor", async () => {
			expect(
				await run(
					[
						"implementation {",
						"\tprotocol Top {",
						"\t\tbase() -> String",
						"\t}",
						"",
						"\tprotocol Left is Top {",
						"\t\tleft() -> String {",
						'\t\t\t<- "l {@::base()}"',
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Right is Top {",
						"\t\tright() -> String {",
						'\t\t\t<- "r {@::base()}"',
						"\t\t}",
						"\t}",
						"",
						"\tprotocol Both is Left, is Right {}",
						"",
						"\tnamespace IntegerBoth for Integer is Both {",
						"\t\tbase() -> String {",
						'\t\t\t<- "b"',
						"\t\t}",
						"\t}",
						"",
						"\tfunction viaTop<infer T is Top>(_ t: T) -> String {",
						"\t\t<- t::base()",
						"\t}",
						"",
						"\tfunction viaBoth<infer T is Both>(_ t: T) -> String {",
						'\t\t<- "{viaTop(t)} {t::left()} {t::right()}"',
						"\t}",
						"",
						"\tTerminal.inspect(viaBoth(3))",
						"}",
					].join("\n"),
				),
			).toEqual(['"b l b r b"'])
		})

		// NOTE: `Narrow` restates `Base`'s `z` with a narrower answer and `Reader`
		// inherits it as `Base` declares it, so `Both` takes `Narrow`'s whichever
		// clause comes first.
		function narrowedDiamond(clauses: string): string {
			return [
				"implementation {",
				"\tprotocol Base {",
				"\t\tz() -> Number",
				"\t}",
				"",
				"\tprotocol Narrow is Base {",
				"\t\tz() -> Integer",
				"\t}",
				"",
				"\tprotocol Reader is Base {",
				"\t\tw() -> String {",
				'\t\t\t<- "w{@::z()}"',
				"\t\t}",
				"\t}",
				"",
				`\tprotocol Both is ${clauses} {}`,
				"",
				"\tnamespace IntegerBoth for Integer is Both {",
				"\t\tz() -> Integer {",
				"\t\t\t<- @::add(1)",
				"\t\t}",
				"\t}",
				"",
				"\tfunction viaNarrow<infer T is Narrow>(_ t: T) -> Integer {",
				"\t\t<- t::z()",
				"\t}",
				"",
				"\tfunction viaReader<infer T is Reader>(_ t: T) -> String {",
				"\t\t<- t::w()",
				"\t}",
				"",
				"\tfunction viaBoth<infer T is Both>(_ t: T) -> String {",
				"\t\tconstant i: Integer = viaNarrow(t)",
				'\t\t<- "{i} {viaReader(t)} {t::z()::add(1)}"',
				"\t}",
				"",
				"\tTerminal.inspect(viaBoth(3))",
				"}",
			].join("\n")
		}

		it("should take the entry of one extension the other accepts, in either clause order", async () => {
			for (let clauses of ["Narrow, is Reader", "Reader, is Narrow"]) {
				expect(await run(narrowedDiamond(clauses))).toEqual([
					'"4 w4 5"',
				])
			}
		})

		// NOTE: `Counted` provides a `z` answering an Integer and `Weighed` one
		// answering a Number, so `Both` takes `Counted`'s entry and its body.
		it("should run the body of the extension whose entry it takes, in either clause order", async () => {
			for (let clauses of [
				"Counted, is Weighed",
				"Weighed, is Counted",
			]) {
				expect(
					await run(
						[
							"implementation {",
							"\tprotocol Counted {",
							"\t\tv() -> Integer",
							"",
							"\t\tz() -> Integer {",
							"\t\t\t<- @::v()",
							"\t\t}",
							"\t}",
							"",
							"\tprotocol Weighed {",
							"\t\tw() -> Integer",
							"",
							"\t\tz() -> Number {",
							"\t\t\t<- @::w()",
							"\t\t}",
							"\t}",
							"",
							`\tprotocol Both is ${clauses} {}`,
							"",
							"\tnamespace IntegerBoth for Integer is Both {",
							"\t\tv() -> Integer {",
							"\t\t\t<- 10",
							"\t\t}",
							"",
							"\t\tw() -> Integer {",
							"\t\t\t<- 20",
							"\t\t}",
							"\t}",
							"",
							"\tfunction viaWeighed<infer T is Weighed>(_ t: T) -> Number {",
							"\t\t<- t::z()",
							"\t}",
							"",
							"\tfunction viaCounted<infer T is Counted>(_ t: T) -> Integer {",
							"\t\t<- t::z()",
							"\t}",
							"",
							"\tfunction viaBoth<infer T is Both>(_ t: T) -> String {",
							'\t\t<- "{viaWeighed(t)} {viaCounted(t)} {t::z()}"',
							"\t}",
							"",
							"\tTerminal.inspect(viaBoth(1))",
							"\tTerminal.inspect(viaWeighed(2))",
							"}",
						].join("\n"),
					),
				).toEqual(['"10 10 10"', "10"])
			}
		})

		// NOTE: `Halved` provides a `z` answering a Number and `Counted` one
		// answering an Integer, and a Function bounded by the extending Protocol
		// hands its value on to one bounded by `Halved`.
		function answeredApart(
			declarations: Array<string>,
			conformances: string,
			extending: string,
			written: Array<string> = [],
		): string {
			return [
				"implementation {",
				"\tprotocol Halved {",
				"\t\th() -> Integer",
				"",
				"\t\tz() -> Number {",
				"\t\t\t<- @::h()::add(1/2)",
				"\t\t}",
				"\t}",
				"",
				"\tprotocol Counted {",
				"\t\tv() -> Integer",
				"",
				"\t\tz() -> Integer {",
				"\t\t\t<- @::v()",
				"\t\t}",
				"\t}",
				"",
				...declarations,
				"",
				`\tnamespace IntegerN for Integer is ${conformances} {`,
				...written,
				"\t\th() -> Integer {",
				"\t\t\t<- 20",
				"\t\t}",
				"",
				"\t\tv() -> Integer {",
				"\t\t\t<- 30",
				"\t\t}",
				"\t}",
				"",
				"\tfunction viaHalved<infer T is Halved>(_ t: T) -> Number {",
				"\t\t<- t::z()",
				"\t}",
				"",
				`\tfunction hand<infer T is ${extending}>(_ t: T) -> Number {`,
				"\t\t<- viaHalved(t)",
				"\t}",
				"",
				'\tTerminal.inspect("{viaHalved(3)} {hand(3)}")',
				"}",
			].join("\n")
		}

		const APART = [
			{
				shape: "an extension taking the other's entry",
				declarations: ["\tprotocol Both is Counted, is Halved {}"],
				conformances: "Halved, is Both",
				extending: "Both",
			},
			{
				shape: "an extension taking the other's entry, clauses swapped",
				declarations: ["\tprotocol Both is Halved, is Counted {}"],
				conformances: "Halved, is Both",
				extending: "Both",
			},
			{
				shape: "an extension restating the Method as a requirement",
				declarations: [
					"\tprotocol Whole is Halved {",
					"\t\tz() -> Integer",
					"\t}",
				],
				conformances: "Whole, is Counted",
				extending: "Whole",
			},
		]

		for (let { shape, declarations, conformances, extending } of APART) {
			it(`should refuse a Namespace answering a Method with two bodies through ${shape}`, () => {
				let source = answeredApart(
					declarations,
					conformances,
					extending,
				)

				expect(refusalsOf(source)).toEqual([
					[
						"nonconforming-namespace",
						`Namespace 'IntegerN' does not conform to '${extending}'`,
						[
							`Method 'z' runs one body for '${extending}' and another for 'Halved'`,
						],
					],
				])
				expect(notesOf(source)).toEqual([
					`'z' runs the body 'Counted' provides for '${extending}', and the body 'Halved' provides for 'Halved'.`,
					`A value bounded by '${extending}' can be handed to a bound on 'Halved', and a bound runs one body.`,
				])
				expect(helpsOf(source)).toEqual([
					`Write 'z' in 'IntegerN' as '${extending}' declares it, so one Method answers both.`,
				])
			})

			it(`should run the Method the Namespace writes for both through ${shape}`, async () => {
				expect(
					await run(
						answeredApart(declarations, conformances, extending, [
							"\t\tz() -> Integer {",
							"\t\t\t<- 7",
							"\t\t}",
							"",
						]),
					),
				).toEqual(['"7 7"'])
			})
		}

		// NOTE: `Named` declares a `z` answering a String, so no `z` the
		// Namespace writes answers both it and `Both`.
		it("should ask a conformance declaring the Method apart to move before the Namespace writes it", async () => {
			let named = [
				"\tprotocol Both is Counted, is Halved {}",
				"",
				"\tprotocol Named {",
				"\t\tz() -> String {",
				'\t\t\t<- "named"',
				"\t\t}",
				"\t}",
			]
			let source = answeredApart(
				named,
				"Halved, is Both, is Named",
				"Both",
			)

			expect(refusalsOf(source)).toEqual([
				[
					"nonconforming-namespace",
					"Namespace 'IntegerN' does not conform to 'Both'",
					[
						"Method 'z' runs one body for 'Both' and another for 'Halved'",
					],
				],
			])
			expect(notesOf(source)).toEqual([
				"'z' runs the body 'Counted' provides for 'Both', and the body 'Halved' provides for 'Halved'.",
				"A value bounded by 'Both' can be handed to a bound on 'Halved', and a bound runs one body.",
				"'Both' and 'Named' declare 'z' apart, so a 'z' written as 'Both' declares it refuses the 'is Named' here.",
			])
			expect(helpsOf(source)).toEqual([
				"Declare 'is Named' on a Namespace of its own, and write 'z' in 'IntegerN' as 'Both' declares it.",
			])
			expect(
				await run(
					answeredApart(
						[
							...named,
							"",
							"\tnamespace IntegerNamed for Integer is Named {}",
						],
						"Halved, is Both",
						"Both",
						["\t\tz() -> Integer {", "\t\t\t<- 7", "\t\t}", ""],
					),
				),
			).toEqual(['"7 7"'])
		})

		it("should refuse two extensions declaring one Method apart, in either clause order", () => {
			for (let [clauses, from, refused] of [
				["Labelled, is Coded", "Coded", "Labelled"],
				["Coded, is Labelled", "Labelled", "Coded"],
			] as const) {
				let signature = (name: string) =>
					`'tag() -> ${name === "Coded" ? "Integer" : "String"}'`

				expect(
					refusalsOf(
						[
							"implementation {",
							"\tprotocol Labelled {",
							"\t\ttag() -> String",
							"\t}",
							"",
							"\tprotocol Coded {",
							"\t\ttag() -> Integer",
							"\t}",
							"",
							`\tprotocol Both is ${clauses} {}`,
							"}",
						].join("\n"),
					),
				).toEqual([
					[
						"incompatible-restatement",
						`Protocol 'Both' inherits 'tag' with a signature '${refused}' does not accept`,
						[
							`'tag' comes from '${from}' as ${signature(from)}`,
							`'${refused}' declares it as ${signature(refused)}`,
						],
					],
				])
			}
		})

		it("should report an extension's refused restatement where it is made alone", () => {
			expect(
				refusalsOf(
					[
						"implementation {",
						"\tprotocol Labelled {",
						"\t\ttag() -> String",
						"\t}",
						"",
						"\tprotocol Coded is Labelled {",
						"\t\ttag() -> Integer",
						"\t}",
						"",
						"\tprotocol Both is Labelled, is Coded {}",
						"}",
					].join("\n"),
				),
			).toEqual([
				[
					"incompatible-restatement",
					"Protocol 'Coded' restates 'tag' with a signature 'Labelled' does not accept",
					["'Labelled' declares it as 'tag() -> String'"],
				],
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

// NOTE: One const per Protocol and Method. Two Protocols of one name are two
// Protocols, so the second to provide a Method gets a numbered const of its
// own; the emitter throws only where one identity provides a Method twice.
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

	// NOTE: Fed in reverse, because the names follow the declaring Module's path
	// rather than the order the entries arrive in.
	it("should give each of two identities a const of its own", () => {
		let entryFor = (identity: string): PreludeNamespace => {
			let protocol = programWith(
				taggedProviding("describe"),
			).implementation.nodes.find(
				(node) => node.nodeType === "ProtocolDeclarationStatement",
			) as common.typedSimple.ProtocolDeclarationStatementNode

			return {
				name: "Tagged",
				protocol: true,
				identity,
				node: {
					nodeType: "NamespaceDefinitionStatement",
					name: protocol.name,
					properties: {},
					methods: protocol.methods,
					nativeShims: [],
					type: {
						type: "Namespace",
						name: "Tagged",
						targetType: null,
						generics: [],
						properties: {},
						methods: {},
					},
					position: protocol.position,
				},
			}
		}

		let reachable = reachableEssenceMethods(
			[entryFor("/b.es#Tagged"), entryFor("/a.es#Tagged")],
			[
				{
					type: "ExpressionStatement",
					expression: {
						type: "ArrayExpression",
						elements: [
							{
								type: "Identifier",
								name: "$es_Tagged__describe",
							},
							{
								type: "Identifier",
								name: "$es_Tagged_2__describe",
							},
						],
					},
				},
			],
		)

		expect([...reachable.keys()]).toEqual([
			"$es_Tagged__describe",
			"$es_Tagged_2__describe",
		])
	})

	// NOTE: Two nested Protocols of one name in one file are two Protocols, and
	// each conformer runs its own Protocol's body.
	it("should run the body each of two nested Protocols provides", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tfunction one() -> String {",
					"\t\tprotocol Tagged {",
					"\t\t\ttag() -> String",
					"",
					"\t\t\tshout() -> String {",
					'\t\t\t\t<- "one"',
					"\t\t\t}",
					"\t\t}",
					"",
					"\t\tnamespace IntegerTagged for Integer is Tagged {",
					"\t\t\ttag() -> String {",
					'\t\t\t\t<- "a"',
					"\t\t\t}",
					"\t\t}",
					"",
					"\t\t<- 1::shout()",
					"\t}",
					"",
					"\tfunction two() -> String {",
					"\t\tprotocol Tagged {",
					"\t\t\ttag() -> String",
					"",
					"\t\t\tshout() -> String {",
					'\t\t\t\t<- "two"',
					"\t\t\t}",
					"\t\t}",
					"",
					"\t\tnamespace BooleanTagged for Boolean is Tagged {",
					"\t\t\ttag() -> String {",
					'\t\t\t\t<- "b"',
					"\t\t\t}",
					"\t\t}",
					"",
					"\t\t<- true::shout()",
					"\t}",
					"",
					"\tTerminal.inspect(one())",
					"\tTerminal.inspect(two())",
					"}",
				].join("\n"),
			),
		).toEqual(['"one"', '"two"'])
	})

	// NOTE: The nested `Printable` shadows the name and is a Protocol of its
	// own, so a String hole still asks for the standard library's.
	it("should keep a nested Protocol apart from the standard library's", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tfunction inner() -> Integer {",
					"\t\tprotocol Printable {",
					"\t\t\tcount() -> Integer",
					"\t\t}",
					"",
					"\t\tnamespace IntegerCounted for Integer is Printable {",
					"\t\t\tcount() -> Integer {",
					"\t\t\t\t<- 100",
					"\t\t\t}",
					"\t\t}",
					"",
					'\t\tTerminal.inspect("{3}")',
					"",
					"\t\t<- 3::count()",
					"\t}",
					"",
					"\tTerminal.inspect(inner())",
					"}",
				].join("\n"),
			),
		).toEqual(['"3"', "100"])
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

	// NOTE: Writes a Module graph into a directory of its own, and removes it
	// whatever the spec asks of it.
	async function withModules(
		files: Record<string, string>,
		ask: (directory: string) => Promise<void>,
	): Promise<void> {
		let directory = mkdtempSync(join(tmpdir(), "essence-protocol-twice-"))

		try {
			for (let [name, source] of Object.entries(files)) {
				mkdirSync(path.dirname(join(directory, name)), {
					recursive: true,
				})
				writeFileSync(join(directory, name), source)
			}

			await ask(directory)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	}

	function emitModules(directory: string, entry: string) {
		let linked = linkModuleGraph(
			loadModuleGraph(join(directory, entry), diskModuleHost),
		)

		expect(
			[...linked.modules.values()].flatMap(
				(module) => module.diagnostics,
			),
		).toEqual([])

		return rewriteModules(
			[...linked.modules.values()].map((module) => ({
				filePath: module.module.filePath,
				program: optimise(simplify(module.program)),
			})),
			linked.entryPath,
		)
	}

	// NOTE: A bundle file per name, since an imported file runs once.
	async function printedBy(
		directory: string,
		sources: ReturnType<typeof rewriteModules>,
		name: string = "bundle",
	): Promise<string> {
		let file = join(directory, `${name}.mjs`)
		let result = await bundle(sources, {
			sourceFileName: "Main.es",
			outputFileName: file,
		})

		writeFileSync(file, result.outputs[0]!.contents)

		let printed = ""
		let originalWrite = process.stdout.write

		process.stdout.write = ((chunk: unknown) => {
			printed += String(chunk)

			return true
		}) as typeof process.stdout.write

		try {
			await import(file)
		} finally {
			process.stdout.write = originalWrite
		}

		return printed
	}

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
			`\t\t\t<- "${typeName} {@::tag()}"`,
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

	// NOTE: Each Module keeps its `Tagged` to itself, so neither can see the
	// other's, and each provides a `describe` of its own.
	it("should run each Module's own body for two Protocols of one name", async () => {
		await withModules(
			{
				"A.es": taggedModule("Dog", "name", "loud"),
				"B.es": taggedModule("Mouse", "title", "quiet"),
				"Main.es": [
					"import {",
					'\tfrom "./A.es" { loud }',
					'\tfrom "./B.es" { quiet }',
					"}",
					"",
					"implementation {",
					"\tTerminal.print(loud())",
					"\tTerminal.print(quiet())",
					"}",
				].join("\n"),
			},
			async (directory) => {
				let sources = emitModules(directory, "Main.es")
				let emitted = [...sources.sources.values()].join("\n")

				expect(emitted).toContain("const $es_Tagged__describe =")
				expect(emitted).toContain("const $es_Tagged_2__describe =")
				expect(await printedBy(directory, sources)).toBe(
					"Dog x\nMouse x\n",
				)
			},
		)
	})

	// NOTE: The const a Module's body is emitted under follows the Module's path,
	// so a graph loaded from an entry in another directory names it alike.
	it("should name each Module's const alike from any entry", async () => {
		let main = (a: string, b: string) =>
			[
				"import {",
				`\tfrom "${a}" { loud }`,
				`\tfrom "${b}" { quiet }`,
				"}",
				"",
				"implementation {",
				"\tTerminal.print(loud())",
				"\tTerminal.print(quiet())",
				"}",
			].join("\n")

		await withModules(
			{
				"a/Tagged.es": taggedModule("Dog", "name", "loud"),
				"b/Tagged.es": taggedModule("Mouse", "title", "quiet"),
				"Main.es": main("./a/Tagged.es", "./b/Tagged.es"),
				"a/Main.es": main("./Tagged.es", "../b/Tagged.es"),
			},
			async (directory) => {
				for (let entry of ["Main.es", "a/Main.es"]) {
					let sources = emitModules(directory, entry)
					let prelude = sources.sources.get("essence:$prelude")!
					let first = prelude.indexOf("const $es_Tagged__describe =")

					expect([entry, prelude.slice(first, first + 200)]).toEqual([
						entry,
						expect.stringContaining('"Dog "'),
					])
					expect(
						await printedBy(
							directory,
							sources,
							entry.replace("/", "-"),
						),
					).toBe("Dog x\nMouse x\n")
				}
			},
		)
	})

	// NOTE: One Namespace conforms to both, and neither extends the other, so
	// both bounds run the first clause's body, with that Protocol's witness. A
	// pick reaches either body.
	it("should answer both bounds of one conformer with the first same-named body", async () => {
		let sized = (requirement: string, letter: string, gauge: string) =>
			[
				"implementation {",
				"\tprotocol Sized {",
				`\t\t${requirement}() -> Integer`,
				"",
				"\t\tdescribe() -> String {",
				`\t\t\t<- "${letter} {@::${requirement}()}"`,
				"\t\t}",
				"\t}",
				"",
				`\tfunction ${gauge} <infer Item is Sized>(_ item: Item) -> String {`,
				"\t\t<- item::describe()",
				"\t}",
				"}",
				"",
				"export {",
				"\tSized",
				`\t${gauge}`,
				"}",
			].join("\n")

		await withModules(
			{
				"A.es": sized("size", "A", "gaugeA"),
				"B.es": sized("count", "B", "gaugeB"),
				"Main.es": [
					"import {",
					'\tfrom "./A.es" {',
					"\t\tSized as SizedA",
					"\t\tgaugeA",
					"\t}",
					'\tfrom "./B.es" {',
					"\t\tSized as SizedB",
					"\t\tgaugeB",
					"\t}",
					"}",
					"",
					"implementation {",
					"\tnamespace IntegerBoth for Integer is SizedA, is SizedB {",
					"\t\tsize() -> Integer {",
					"\t\t\t<- @",
					"\t\t}",
					"",
					"\t\tcount() -> Integer {",
					"\t\t\t<- @::multiply(with 10)",
					"\t\t}",
					"\t}",
					"",
					"\tTerminal.print(gaugeA(3))",
					"\tTerminal.print(gaugeB(3))",
					"\tTerminal.print(3::<SizedA>describe())",
					"\tTerminal.print(3::<SizedB>describe())",
					"}",
				].join("\n"),
			},
			async (directory) => {
				expect(
					await printedBy(
						directory,
						emitModules(directory, "Main.es"),
					),
				).toBe("A 3\nA 3\nA 3\nB 30\n")
			},
		)
	})

	// NOTE: The same where one is imported under an alias, and a pick through
	// the alias reaches that Protocol's body.
	it("should reach the body of a Protocol imported under an alias beside its namesake", async () => {
		let tagged = (letter: string, show: string) =>
			[
				"implementation {",
				"\tprotocol Tagged {",
				"\t\ttag() -> String",
				"",
				"\t\tdescribe() -> String {",
				`\t\t\t<- "${letter} {@::tag()}"`,
				"\t\t}",
				"\t}",
				"",
				`\tfunction ${show} <infer Item is Tagged>(_ item: Item) -> String {`,
				"\t\t<- item::describe()",
				"\t}",
				"}",
				"",
				"export {",
				"\tTagged",
				`\t${show}`,
				"}",
			].join("\n")

		await withModules(
			{
				"A.es": tagged("A", "showA"),
				"B.es": tagged("B", "showB"),
				"Main.es": [
					"import {",
					'\tfrom "./A.es" {',
					"\t\tTagged",
					"\t\tshowA",
					"\t}",
					'\tfrom "./B.es" {',
					"\t\tTagged as Marked",
					"\t\tshowB",
					"\t}",
					"}",
					"",
					"implementation {",
					"\tnamespace IntegerBoth for Integer is Tagged, is Marked {",
					"\t\ttag() -> String {",
					'\t\t\t<- "i"',
					"\t\t}",
					"\t}",
					"",
					"\tTerminal.print(showA(1))",
					"\tTerminal.print(showB(1))",
					"\tTerminal.print(1::<Marked>describe())",
					"}",
				].join("\n"),
			},
			async (directory) => {
				expect(
					await printedBy(
						directory,
						emitModules(directory, "Main.es"),
					),
				).toBe("A i\nA i\nB i\n")
			},
		)
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
