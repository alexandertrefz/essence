import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common, parser } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parse, parseWithDiagnostics } from "../parser/index"
import { printType } from "../printType"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"
import { compiles } from "./followedHelps"

// The written forms of a Dictionary, `["a" = 1]`, `[=]` and `[base with …]`,
// end to end. One Token past the first Expression decides between a List, a
// Dictionary and an update, and every stage must keep that reading.
//
// The harness runs the emitted JavaScript, since keys stored in the wrong
// place show only from Essence.

function block(...lines: Array<string>): string {
	return ["implementation {", ...lines, "}"].join("\n")
}

// Every Diagnostic the front end reports, since an assignment that does not
// fit is the Validator's to report.
function diagnosticsFor(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)
	let enriched = enrich(parsed.program)

	return [
		...parsed.diagnostics,
		...enriched.diagnostics,
		...validate(enriched.program),
	]
}

function codesFor(source: string): Array<string> {
	return diagnosticsFor(source).map((diagnostic) => diagnostic.code)
}

// The Type the last Declaration of the implementation came to, spelled the
// way a Hover spells it.
function typeOfLastDeclaration(source: string): string {
	let { program, diagnostics } = enrich(parse(source))

	expect(containsErrors(diagnostics)).toBe(false)

	let nodes = program.implementation.nodes
	let last = nodes[nodes.length - 1]

	if (
		last.nodeType !== "ConstantDeclarationStatement" &&
		last.nodeType !== "VariableDeclarationStatement"
	) {
		throw new Error("The last node is not a Declaration.")
	}

	return printType(last.value.type)
}

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-dictionaries-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

describe("Dictionary literals", () => {
	describe("the Parser", () => {
		// The `=`, the `with` or neither after the first Expression decides the
		// reading.
		it("reads the three forms out of one pair of brackets", () => {
			let { program } = parseWithDiagnostics(
				block(
					"\tconstant ages = [1 = 2]",
					"\tconstant items = [1, 2]",
					"\tconstant older = [ages with 1 = 3]",
					"\tconstant empty = [=]",
					"\tconstant none = []",
				),
			)

			let nodes = program.implementation
				.nodes as Array<parser.ImplementationNode>
			let kinds = nodes.map((node) =>
				node.nodeType === "ConstantDeclarationStatement"
					? node.value.nodeType
					: node.nodeType,
			)

			expect(kinds).toEqual([
				"DictionaryValue",
				"ListValue",
				"Combination",
				"DictionaryValue",
				"ListValue",
			])
		})

		it("marks an update written in brackets", () => {
			let { program } = parseWithDiagnostics(
				block(
					"\tconstant ages = [1 = 2]",
					"\tconstant older = [ages with 1 = 3]",
					"\tconstant config = { port = 1 }",
					"\tconstant moved = { config with port = 2 }",
				),
			)

			let combinations = program.implementation.nodes.flatMap((node) =>
				node.nodeType === "ConstantDeclarationStatement" &&
				node.value.nodeType === "Combination"
					? [node.value]
					: [],
			)

			expect(combinations).toHaveLength(2)
			expect(combinations[0].brackets).toBe(true)
			expect(combinations[1].brackets).toBeUndefined()
		})

		// An entry's Position spans the key and the value, so a Diagnostic
		// underlines the entry, not the whole list.
		it("spans an entry from its key to its value", () => {
			let source = block('\tconstant ages = ["alex" = 39]')
			let { program } = parseWithDiagnostics(source)
			let literal = (
				program.implementation
					.nodes[0] as parser.ConstantDeclarationStatementNode
			).value as parser.DictionaryValueNode
			let { start, end } = literal.entries[0].position

			expect(
				source
					.split("\n")
					[start.line - 1].slice(start.column - 1, end.column - 1),
			).toBe('"alex" = 39')
		})

		it("allows a trailing comma, as a List does", () => {
			expect(
				codesFor(block('\tconstant ages = ["alex" = 39, "sam" = 25,]')),
			).toEqual([])
		})

		it("refuses an update with nothing after its 'with'", () => {
			let diagnostics = diagnosticsFor(
				block(
					"\tconstant ages = [1 = 2]",
					"\tconstant older = [ages with]",
				),
			)

			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"An update says what it changes",
			)
		})

		// One Token decides the reading, so each mistake must get the message
		// of the reading the reader meant.
		it("reports a List's mistake as a List's and an entry's as an entry's", () => {
			expect(
				diagnosticsFor(block('\tconstant ages = ["alex" 39]'))[0]
					.message,
			).toBe("Expected ']' but found '39'.")
			expect(
				diagnosticsFor(
					block('\tconstant ages = ["alex" = 39, "sam"]'),
				)[0].message,
			).toBe("A Dictionary entry is written with '='")
			expect(
				diagnosticsFor(block('\tconstant ages = ["alex" = ]'))[0]
					.message,
			).toBe("Expected an Expression but found ']'.")
		})

		// Braces never hold a value key, so the report points at the brackets
		// rather than at a missing `with`.
		it("sends a value key written in braces to the brackets", () => {
			let diagnostics = diagnosticsFor(
				block('\tconstant ages = { "alex" = 39 }'),
			)

			expect(diagnostics[0].message).toBe(
				"A key that is a value belongs to a Dictionary",
			)
			expect(diagnostics[0].helps?.[0]).toBe(
				"Write it in brackets: '[\"a\" = 1]'.",
			)
		})

		// A bare name after a Dictionary's `with` is the whole value merged,
		// since a key is a value and not a name.
		it("reads a bare name after 'with' as the whole value", () => {
			let { program } = parseWithDiagnostics(
				block(
					"\tconstant ages = [1 = 2]",
					"\tconstant more = [3 = 4]",
					"\tconstant both = [ages with more]",
				),
			)

			let combination = (
				program.implementation
					.nodes[2] as parser.ConstantDeclarationStatementNode
			).value as parser.CombinationNode

			expect(combination.rhs.nodeType).toBe("Identifier")
		})

		// A comma after a bare name says a key list was meant. The Helps spell
		// entries, or one whole Dictionary to merge.
		it("follows a bare key list's Helps to Programs that compile", () => {
			let names = [
				'\tconstant ages = ["kim" = 7]',
				'\tconstant a = "ada"',
				'\tconstant b = "bo"',
				'\tconstant other = ["sam" = 25]',
			]
			let diagnostics = diagnosticsFor(
				block(...names, "\tconstant older = [ages with a, b]"),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"shorthand-in-combination",
			])
			expect(diagnostics[0].helps).toEqual([
				"Write each entry: '[d with a = 1, b = 2]'.",
				"Or merge one whole Dictionary: '[d with other]'.",
			])

			for (let update of [
				"[ages with a = 1, b = 2]",
				"[ages with other]",
			]) {
				expect(
					compiles(block(...names, `\tconstant older = ${update}`)),
				).toBe(true)
			}
		})
	})

	describe("typing", () => {
		it("takes both slots from what was written", () => {
			expect(
				typeOfLastDeclaration(
					block('\tconstant ages = ["alex" = 39, "sam" = 25]'),
				),
			).toBe("Dictionary<String, Integer>")
		})

		it("unions the distinct Types of each slot, in written order", () => {
			expect(
				typeOfLastDeclaration(
					block('\tconstant mixed = [1 = "a", 1/2 = 2]'),
				),
			).toBe("Dictionary<Integer | Rational, String | Integer>")
		})

		it("leaves both slots Unknown for the empty Dictionary", () => {
			expect(typeOfLastDeclaration(block("\tconstant ages = [=]"))).toBe(
				"Dictionary<Unknown, Unknown>",
			)
		})

		it("accepts the empty Dictionary at any annotated Dictionary", () => {
			expect(
				codesFor(
					block("\tconstant ages: Dictionary<String, Integer> = [=]"),
				),
			).toEqual([])
		})

		// As for an empty List, an assignment decides the Declaration's Type,
		// both slots at once.
		it("narrows an empty Dictionary through an assignment", () => {
			expect(
				codesFor(
					block("\tvariable ages = [=]", '\tages = ["alex" = 39]'),
				),
			).toEqual([])
		})

		// A bare Case in key position resolves against the expected key Type,
		// as in a List's item position.
		it("resolves a bare Case in key position", () => {
			expect(
				codesFor(
					block(
						"\tchoice Suit { Red, Black }",
						"\tconstant scores: Dictionary<Suit, Integer> = [#Red = 1, #Black = 2]",
					),
				),
			).toEqual([])
		})

		it("resolves a bare Case in value position", () => {
			expect(
				codesFor(
					block(
						"\tchoice Suit { Red, Black }",
						'\tconstant sides: Dictionary<String, Suit> = ["a" = #Red]',
					),
				),
			).toEqual([])
		})

		it("refuses a value the annotation does not hold", () => {
			expect(
				codesFor(
					block(
						'\tconstant ages: Dictionary<String, Integer> = ["alex" = "39"]',
					),
				),
			).toEqual(["assignment-type-mismatch"])
		})

		// A construction compares its keys, so the key Type must be Equatable.
		// The bound reports as a bounded Method call would.
		it("refuses a key Type that is not Equatable", () => {
			expect(
				codesFor(
					block(
						"\tconstant scores = [(x: Integer) -> Integer { <- x } = 1]",
					),
				),
			).toEqual(["unsatisfied-bound"])
		})

		it("asks the empty Dictionary for no Equatable witness", () => {
			expect(codesFor(block("\tconstant ages = [=]"))).toEqual([])
		})
	})

	// A written Dictionary proves what its brackets hold, as a written List
	// does. Both slots are walked, so `["a" = [1]]` admits a `NonEmptyList`
	// value.
	describe("refinement admission", () => {
		it("admits a written value that proves the slot's refinement", () => {
			expect(
				codesFor(
					block(
						'\tconstant d: Dictionary<String, NonEmptyList<Integer>> = ["a" = [1]]',
					),
				),
			).toEqual([])
		})

		it("admits a written key that proves the slot's refinement", () => {
			expect(
				codesFor(
					block(
						'\tconstant d: Dictionary<NonEmptyString, Integer> = ["a" = 1]',
					),
				),
			).toEqual([])
		})

		it("names the half that did not prove it", () => {
			let refusedValue = diagnosticsFor(
				block(
					'\tconstant d: Dictionary<String, NonEmptyList<Integer>> = ["a" = []]',
				),
			)
			let refusedKey = diagnosticsFor(
				block(
					'\tconstant d: Dictionary<NonEmptyString, Integer> = ["" = 1]',
				),
			)

			expect(refusedValue.map((diagnostic) => diagnostic.code)).toEqual([
				"assignment-type-mismatch",
			])
			expect(
				refusedValue[0].labels?.map((label) => label.message),
			).toContain("this value is a List<Unknown>")
			expect(
				refusedKey[0].labels?.map((label) => label.message),
			).toContain("this key is a String")
		})
	})

	describe("duplicate keys", () => {
		it("refuses the same String key written twice", () => {
			let diagnostics = diagnosticsFor(
				block('\tconstant ages = ["alex" = 39, "alex" = 40]'),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"duplicate-key",
			])
			expect(
				diagnostics[0].labels?.map((label) => label.message),
			).toEqual(["written a second time here", "first written here"])
		})

		// The key is the value, not the characters, as the runtime's canonical
		// encoding reads it: `2/4` is `1/2`, and `3/1` is `3`.
		it("refuses two spellings of one Rational", () => {
			expect(
				codesFor(block("\tconstant scores = [1/2 = 1, 2/4 = 2]")),
			).toEqual(["duplicate-key"])
		})

		it("refuses a whole Rational beside the Integer it is", () => {
			expect(
				codesFor(block("\tconstant scores = [3 = 1, 3/1 = 2]")),
			).toEqual(["duplicate-key"])
		})

		// String equality in Essence is canonical equivalence, so a
		// composed accent and a decomposed one are one key.
		it("refuses two normalisations of one String", () => {
			expect(
				codesFor(block('\tconstant ages = ["é" = 1, "é" = 2]')),
			).toEqual(["duplicate-key"])
		})

		it("refuses the same unit Case written twice", () => {
			expect(
				codesFor(
					block(
						"\tchoice Suit { Red, Black }",
						"\tconstant scores: Dictionary<Suit, Integer> = [#Red = 1, #Red = 2]",
					),
				),
			).toEqual(["duplicate-key"])
		})

		// A key the Compiler can not compare as written is left to the runtime,
		// where a later duplicate wins.
		it("says nothing about keys it can not compare", () => {
			expect(
				codesFor(
					block(
						"\tconstant offset = 1",
						"\tconstant scores = [offset = 1, offset = 2]",
					),
				),
			).toEqual([])
		})

		// An update overrides, so a key the base holds is no duplicate.
		it("allows an update to override a key the base holds", () => {
			expect(
				codesFor(
					block(
						'\tconstant ages = ["alex" = 39]',
						'\tconstant older = [ages with "alex" = 40]',
					),
				),
			).toEqual([])
		})

		it("still refuses a key written twice inside one update", () => {
			expect(
				codesFor(
					block(
						'\tconstant ages = ["alex" = 39]',
						'\tconstant older = [ages with "alex" = 40, "alex" = 41]',
					),
				),
			).toEqual(["duplicate-key"])
		})
	})

	describe("the update form", () => {
		it("answers the base's Type", () => {
			expect(
				typeOfLastDeclaration(
					block(
						'\tconstant ages: Dictionary<String, Integer> = ["alex" = 39]',
						'\tconstant older = [ages with "kim" = 7]',
					),
				),
			).toBe("Dictionary<String, Integer>")
		})

		it("refuses a key the base's key Type does not hold", () => {
			let diagnostics = diagnosticsFor(
				block(
					'\tconstant ages: Dictionary<String, Integer> = ["alex" = 39]',
					"\tconstant older = [ages with 5 = 7]",
				),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"partial-type-mismatch",
			])
			expect(diagnostics[0].message).toBe(
				"This is not a key the Dictionary can hold",
			)
		})

		it("refuses a value the base's value Type does not hold", () => {
			let diagnostics = diagnosticsFor(
				block(
					'\tconstant ages: Dictionary<String, Integer> = ["alex" = 39]',
					'\tconstant older = [ages with "kim" = "7"]',
				),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"partial-type-mismatch",
			])
			expect(diagnostics[0].message).toBe(
				"This is not a value the Dictionary holds",
			)
		})

		it("refuses a whole value that is no Dictionary of the same Types", () => {
			expect(
				codesFor(
					block(
						'\tconstant ages: Dictionary<String, Integer> = ["alex" = 39]',
						'\tconstant other: Dictionary<String, String> = ["kim" = "7"]',
						"\tconstant both = [ages with other]",
					),
				),
			).toEqual(["partial-type-mismatch"])
		})

		// An update decides the slots of an undecided base, as an assignment
		// does.
		it("lets the entries decide an Unknown base's slots", () => {
			expect(
				typeOfLastDeclaration(
					block(
						"\tconstant empty = [=]",
						'\tconstant ages = [empty with "alex" = 39]',
					),
				),
			).toBe("Dictionary<String, Integer>")
		})
	})

	describe("brackets and braces", () => {
		it("refuses a Dictionary updated in braces", () => {
			let diagnostics = diagnosticsFor(
				block(
					'\tconstant ages = ["alex" = 39]',
					'\tconstant more = ["kim" = 7]',
					"\tconstant both = { ages with more }",
				),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"wrong-update-brackets",
			])
			expect(diagnostics[0].message).toBe(
				"A Dictionary is updated in brackets",
			)
		})

		it("refuses a Record updated in brackets", () => {
			let diagnostics = diagnosticsFor(
				block(
					"\tconstant config = { port = 1 }",
					"\tconstant moved = [config with config]",
				),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"wrong-update-brackets",
			])
			expect(diagnostics[0].message).toBe("A Record is updated in braces")
		})

		it("refuses a Record's key list written in brackets", () => {
			expect(
				codesFor(
					block(
						"\tconstant config = { port = 1 }",
						"\tconstant moved = [config with 1 = 2]",
					),
				),
			).toEqual(["wrong-update-brackets"])
		})

		// Once, in both directions. The key list is not also read under the
		// form the brackets did not mean.
		it("reports once for a Record updated in brackets with a named key", () => {
			expect(
				codesFor(
					block(
						"\tconstant config = { port = 80 }",
						"\tconstant moved = [config with port = 90]",
					),
				),
			).toEqual(["wrong-update-brackets"])
		})

		it("reports once for a Dictionary updated in braces with a named key", () => {
			expect(
				codesFor(
					block(
						'\tconstant ages = ["alex" = 39]',
						"\tconstant older = { ages with alex = 40 }",
					),
				),
			).toEqual(["wrong-update-brackets"])
		})

		// A braced update with a value key never reaches the Enricher. The
		// Parser reports the same code, since the value key says which pair was
		// wanted.
		it("names the brackets for a value key written after a braced 'with'", () => {
			let diagnostics = diagnosticsFor(
				block(
					'\tconstant ages = ["alex" = 39]',
					'\tconstant older = { ages with "alex" = 40 }',
				),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"wrong-update-brackets",
			])
			expect(diagnostics[0].message).toBe(
				"A key that is a value belongs to a Dictionary",
			)
			expect(diagnostics[0].helps).toEqual([
				"Write the update in brackets: '[base with \"a\" = 1]'.",
				"Or name the member, if a Record is what was meant: '{ base with a = 1 }'.",
			])
			expect(
				compiles(
					block(
						'\tconstant ages = ["alex" = 39]',
						'\tconstant older = [ages with "alex" = 40]',
					),
				),
			).toBe(true)
			expect(
				compiles(
					block(
						"\tconstant ages = { alex = 39 }",
						"\tconstant older = { ages with alex = 40 }",
					),
				),
			).toBe(true)
		})

		// The Enricher's report names the other pair, which is all the
		// rewrite takes.
		it("compiles once the update is written in the other pair", () => {
			let swapped = (base: string, update: string) =>
				diagnosticsFor(block(base, `\tconstant both = ${update}`))

			expect(
				swapped(
					'\tconstant ages = ["alex" = 39]',
					"{ ages with ages }",
				)[0]?.helps,
			).toEqual([
				"Write the update in brackets: '[base with \"key\" = value]'.",
			])
			expect(
				swapped(
					"\tconstant config = { port = 1 }",
					"[config with port = 2]",
				)[0]?.helps,
			).toEqual([
				"Write the update in braces: '{ base with member = value }'.",
			])
			expect(
				compiles(
					block(
						'\tconstant ages = ["alex" = 39]',
						'\tconstant both = [ages with "kim" = 7]',
					),
				),
			).toBe(true)
			expect(
				compiles(
					block(
						"\tconstant config = { port = 1 }",
						"\tconstant both = { config with port = 2 }",
					),
				),
			).toBe(true)
		})

		// `uncombinable-types` reaches a Union of Dictionaries and a bare
		// `Dictionary`, so its Notes must be true of Dictionaries.
		it("does not claim a Dictionary can not be combined", () => {
			let diagnostics = diagnosticsFor(
				block(
					"\tconstant u: Dictionary<String, Integer> | Dictionary<String, String> =",
					'\t\t["a" = 1]',
					'\tconstant v = [u with "b" = 2]',
				),
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("uncombinable-types")
			expect(diagnostics[0].notes).not.toContain(
				"Only Records and Namespaces can be combined.",
			)
		})

		// A bare `Dictionary` can not be updated, so the Help names the Type
		// Arguments that would make it updatable.
		it("says which Type Arguments a bare Dictionary is missing", () => {
			let diagnostics = diagnosticsFor(
				block(
					'\tconstant d: Dictionary = ["a" = 1]',
					'\tconstant e = [d with "b" = 2]',
				),
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("uncombinable-types")
			expect(diagnostics[0].helps).toContain(
				"Write the Types it holds: 'Dictionary<String, Integer>'.",
			)
		})
	})

	// `[=]` decides neither slot, so a later line settles its Type. Its
	// Diagnostics speak of a Dictionary, not a List.
	describe("the empty Dictionary's Diagnostics", () => {
		const captured = block(
			"\tvariable ages = [=]",
			"\tconstant read = () -> Dictionary<String, String> {",
			"\t\t<- ages",
			"\t}",
			'\tages = ["alex" = 39]',
			"\tTerminal.inspect(read())",
		)

		it("refuses a Function that captured it before a slot was decided", () => {
			expect(codesFor(captured)).toEqual(["uninferable-item-type"])
		})

		// A Dictionary has two slots rather than an item Type, and a List's
		// Help would not compile under a `[=]`.
		it("speaks of both slots rather than of an item Type", () => {
			let [diagnostic] = diagnosticsFor(captured)

			expect(diagnostic.message).toBe(
				"'ages' is captured before its key and value Types are decided",
			)
			expect(
				[diagnostic.message, ...diagnostic.notes].every(
					(line) => !line.includes("item Type"),
				),
			).toBe(true)
			// The annotation alone, marked as an example: a capture has no value
			// opposite it, so both slot Types are made up.
			expect(diagnostic.helps).toEqual([
				"Annotate the declaration — 'variable ages: Dictionary<String, Integer>', for instance — so the Function is checked against the Types it will hold.",
			])
		})

		// A Method called on `[=]` binds neither Type Parameter, and the two
		// are reported once together.
		it("reports once for a Method called on it, with an annotation to write", () => {
			let diagnostics = diagnosticsFor(
				block("\tconstant count = [=]::length()"),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"uninferable-type-parameter",
			])
			expect(diagnostics[0].message).toBe(
				"Type Parameters 'KeyType' and 'ValueType' could not be inferred",
			)
			expect(diagnostics[0].helps).toEqual([
				"Annotate the declaration — 'constant d: Dictionary<…, …> = [=]', with the Type you mean in place of each '…'.",
			])
			expect(
				compiles(
					block(
						"\tconstant d: Dictionary<String, Integer> = [=]",
						"\tconstant count = d::length()",
					),
				),
			).toBe(true)
		})

		// An empty Dictionary is a value of every Dictionary Type, as an empty
		// List is of every List Type. Both containers get the Warning. See
		// "Runtime overlap" in packages/compiler/src/validator/DEVELOPMENT.md.
		it("warns about the crossover in a Match, as the empty List does", () => {
			let list = block(
				"\tconstant u: List<String> | List<Integer> = []",
				"\tconstant answer = match u -> String {",
				'\t\tcase List<Integer> { <- "integers" }',
				'\t\tcase List<String> { <- "strings" }',
				"\t}",
			)
			let dictionary = block(
				"\tconstant u: Dictionary<String, Integer> | Dictionary<Integer, String> =",
				"\t\t[=]",
				"\tconstant answer = match u -> String {",
				'\t\tcase Dictionary<Integer, String> { <- "integers" }',
				'\t\tcase Dictionary<String, Integer> { <- "strings" }',
				"\t}",
			)

			expect(codesFor(list)).toEqual(["empty-list-overlap"])
			expect(codesFor(dictionary)).toEqual(["empty-dictionary-overlap"])

			let [diagnostic] = diagnosticsFor(dictionary)

			expect(diagnostic.message).toBe(
				"This Case never sees an empty Dictionary",
			)
			expect(diagnostic.helps).toEqual([
				"Guard the Cases with 'where @::hasEntries()' and answer for the empty Dictionary in a Case of its own.",
			])
		})
	})

	// A branch guarded by `hasKey` and opening with the same lookup looks the
	// key up twice. The Warning must stay quiet wherever a reader can not see
	// the repetition.
	describe("the redundant key check", () => {
		const ages = '\tconstant ages = ["alex" = 39, "sam" = 25]'

		it("warns where the branch reads the key it was guarded by", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tif ages::hasKey("alex") {',
						'\t\tconstant age = ages::value(at "alex", defaultingTo 0)',
						"\t}",
					),
				),
			).toEqual(["redundant-key-check"])
		})

		// Both entries of the `value` Overload count, including the one that
		// answers the Optional the Help points at.
		it("warns where the branch asks for the Optional itself", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tif ages::hasKey("alex") {',
						'\t\tTerminal.inspect(ages::value(at "alex"))',
						"\t}",
					),
				),
			).toEqual(["redundant-key-check"])
		})

		it("warns where the key is a name rather than a literal", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tconstant who = "alex"',
						"\tif ages::hasKey(who) {",
						"\t\tconstant age = ages::value(at who, defaultingTo 0)",
						"\t}",
					),
				),
			).toEqual(["redundant-key-check"])
		})

		it("warns where the key is a member path", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tconstant person = { name = "alex" }',
						"\tif ages::hasKey(person.name) {",
						"\t\tconstant age = ages::value(at person.name, defaultingTo 0)",
						"\t}",
					),
				),
			).toEqual(["redundant-key-check"])
		})

		// An `else` changes nothing about the branch the `if` opens.
		it("warns in the true branch of an if/else", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tif ages::hasKey("alex") {',
						'\t\tconstant age = ages::value(at "alex", defaultingTo 0)',
						"\t} else {",
						'\t\tTerminal.print("nobody")',
						"\t}",
					),
				),
			).toEqual(["redundant-key-check"])
		})

		it("says what was asked and where it was answered", () => {
			let [diagnostic] = diagnosticsFor(
				block(
					ages,
					'\tif ages::hasKey("alex") {',
					'\t\tconstant age = ages::value(at "alex", defaultingTo 0)',
					"\t}",
				),
			)

			expect(diagnostic.severity).toBe("warning")
			expect(diagnostic.message).toBe("This key is looked up twice")
			expect(diagnostic.labels).toMatchObject([
				{ kind: "primary", message: "asked here" },
				{ kind: "secondary", message: "and answered here" },
			])
			expect(diagnostic.notes).toEqual([
				"'hasKey' is a lookup of its own — it asks the Dictionary for the key's value and answers whether it found one.",
			])
			expect(diagnostic.helps).toEqual([
				"Ask 'value(at:)' once and match its Optional, or use 'value(at:defaultingTo:)' or 'update(at:with:)'.",
			])
		})

		// Each way out asks once, so the Warning is gone as well.
		it("follows each Help to a Program that compiles without it", () => {
			for (let lookup of [
				[
					'\tmatch ages::value(at "alex") -> {} {',
					"\t\tcase #Value(age) { Terminal.print(age) }",
					"\t\tcase #Empty {}",
					"\t}",
				],
				[
					'\tconstant age = ages::value(at "alex", defaultingTo 0)',
					"\tTerminal.print(age)",
				],
				[
					'\tconstant older = ages::update(at "alex", with (age) { <- age::add(1) })',
					"\tTerminal.inspect(older)",
				],
			]) {
				let followed = block(ages, ...lookup)

				expect(compiles(followed)).toBe(true)
				expect(codesFor(followed)).not.toContain("redundant-key-check")
			}
		})

		it("stays silent where the branch reads another Dictionary", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tconstant scores = ["alex" = 1]',
						'\tif ages::hasKey("alex") {',
						'\t\tconstant score = scores::value(at "alex", defaultingTo 0)',
						"\t}",
					),
				),
			).toEqual([])
		})

		it("stays silent where the branch reads another key", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tif ages::hasKey("alex") {',
						'\t\tconstant age = ages::value(at "sam", defaultingTo 0)',
						"\t}",
					),
				),
			).toEqual([])
		})

		// The branch is entered when the key is absent, so its lookup is the
		// first.
		it("stays silent where the check is negated", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tif ages::hasKey("alex")::negate() {',
						'\t\tconstant age = ages::value(at "alex", defaultingTo 0)',
						"\t}",
					),
				),
			).toEqual([])
		})

		it("stays silent where the check is part of a larger question", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tif ages::hasKey("alex")::and(ages::hasKey("sam")) {',
						'\t\tconstant age = ages::value(at "alex", defaultingTo 0)',
						"\t}",
					),
				),
			).toEqual([])
		})

		// Two calls that answer the same key are not visibly one key.
		it("stays silent where the key is worked out", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tconstant keyOf = (_ index: Integer) -> String { <- "alex" }',
						"\tif ages::hasKey(keyOf(1)) {",
						"\t\tconstant age = ages::value(at keyOf(1), defaultingTo 0)",
						"\t}",
					),
				),
			).toEqual([])
		})

		// Two written updates are two Dictionaries, so the guard says nothing
		// about the second.
		it("stays silent where the receiver is worked out", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tif [ages with "kim" = 7]::hasKey("alex") {',
						'\t\tconstant age = [ages with "kim" = 7]::value(at "alex", defaultingTo 0)',
						"\t}",
					),
				),
			).toEqual([])
		})

		// Only the first Statement of the branch is read. A later lookup is a
		// second question.
		it("stays silent where the lookup is not the first Statement", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tif ages::hasKey("alex") {',
						'\t\tTerminal.print("found")',
						'\t\tconstant age = ages::value(at "alex", defaultingTo 0)',
						"\t}",
					),
				),
			).toEqual([])
		})

		// The walk stops at a body, since a Function literal's lookup runs
		// whenever the Function is called.
		it("stays silent where the lookup is inside a body", () => {
			expect(
				codesFor(
					block(
						ages,
						'\tif ages::hasKey("alex") {',
						"\t\tconstant read = () -> Integer {",
						'\t\t\t<- ages::value(at "alex", defaultingTo 0)',
						"\t\t}",
						"\t\tTerminal.inspect(read())",
						"\t}",
					),
				),
			).toEqual([])
		})
	})

	describe("emission", () => {
		it("builds a literal through createDictionary", () => {
			expect(
				generate(
					block(
						'\tconstant ages = ["alex" = 39]',
						"\tTerminal.inspect(ages::length())",
					),
				),
			).toContain("Dictionary.createDictionary(")
		})

		// The empty Dictionary compares nothing, so it hands over no witness.
		it("hands the empty Dictionary no witness", () => {
			expect(
				generate(
					block(
						"\tconstant ages: Dictionary<String, Integer> = [=]",
						"\tTerminal.inspect(ages::length())",
					),
				),
			).toContain("Dictionary.createDictionary([], null)")
		})

		it("emits an update as nested set calls", () => {
			let js = generate(
				block(
					'\tconstant ages = ["alex" = 39]',
					'\tconstant older = [ages with "kim" = 7, "sam" = 25]',
					"\tTerminal.inspect(older::length())",
				),
			)

			expect(js).toContain("Dictionary.set(Dictionary.set(")
		})

		// A literal inside a bounded Method or Function hands over the hidden
		// conformance Parameter.
		it("forwards a bound the enclosing signature carries", () => {
			let js = generate(
				block(
					"\tfunction sized <infer Key is Equatable> (_ key: Key) -> Integer {",
					"\t\t<- [key = 1]::length()",
					"\t}",
					'\tTerminal.inspect(sized("alex"))',
				),
			)

			expect(js).toContain("function sized(key, Key__conformance)")
			expect(js).toContain("Key__conformance)")
		})

		// `merge` is written in Essence, so the whole-value form names it in a
		// way prelude reachability sees. See "Prelude reachability" in
		// packages/compiler/src/rewriter/DEVELOPMENT.md.
		it("emits the whole-value form as merge, and pulls its const in", () => {
			let js = generate(
				block(
					'\tconstant ages = ["alex" = 39]',
					'\tconstant more = ["kim" = 7]',
					"\tconstant both = [ages with more]",
					"\tTerminal.inspect(both::length())",
				),
			)

			expect(js).toContain("$es_Dictionary_merge__overload$1(")
			expect(js).toContain("const $es_Dictionary_merge__overload$1 =")
		})
	})

	// The insertion order, the override rule and the witness show only in the
	// emitted JavaScript.
	describe("running", () => {
		it("holds what was written, in the order it was written", async () => {
			expect(
				await run(
					block(
						'\tconstant ages = ["alex" = 39, "sam" = 25]',
						"\tTerminal.inspect(ages::toString())",
					),
				),
			).toEqual(['"[\\"alex\\" = 39, \\"sam\\" = 25]"'])
		})

		it("prints the empty Dictionary as the empty Dictionary", async () => {
			expect(
				await run(
					block(
						"\tconstant ages: Dictionary<String, Integer> = [=]",
						"\tTerminal.inspect(ages::toString())",
					),
				),
			).toEqual(['"[=]"'])
		})

		it("answers a key that is there and one that is not", async () => {
			expect(
				await run(
					block(
						'\tconstant ages = ["alex" = 39, "sam" = 25]',
						'\tTerminal.inspect(ages::value(at "alex", defaultingTo 0))',
						'\tTerminal.inspect(ages::value(at "kim", defaultingTo 0))',
					),
				),
			).toEqual(["39", "0"])
		})

		// A duplicate the Compiler could not see: the later value wins in the
		// first one's place.
		it("lets a later duplicate win, in the first one's place", async () => {
			expect(
				await run(
					block(
						'\tconstant first = "a"',
						'\tconstant second = "a"',
						'\tconstant ages = [first = 1, "b" = 2, second = 3]',
						"\tTerminal.inspect(ages::toString())",
					),
				),
			).toEqual(['"[\\"a\\" = 3, \\"b\\" = 2]"'])
		})

		it("sets into the empty Dictionary an annotation decided", async () => {
			expect(
				await run(
					block(
						"\tconstant ages: Dictionary<String, Integer> = [=]",
						'\tTerminal.inspect(ages::set("alex", to 39)::toString())',
					),
				),
			).toEqual(['"[\\"alex\\" = 39]"'])
		})

		// An overwritten key keeps its place and a new one lands at the end.
		it("runs an update as the sets it stands for", async () => {
			expect(
				await run(
					block(
						'\tconstant ages = ["alex" = 39, "sam" = 25]',
						'\tconstant older = [ages with "alex" = 40, "kim" = 7]',
						"\tTerminal.inspect(older::toString())",
						"\tTerminal.inspect(ages::toString())",
					),
				),
			).toEqual([
				'"[\\"alex\\" = 40, \\"sam\\" = 25, \\"kim\\" = 7]"',
				'"[\\"alex\\" = 39, \\"sam\\" = 25]"',
			])
		})

		it("merges a whole Dictionary with the Argument winning", async () => {
			expect(
				await run(
					block(
						'\tconstant ages = ["alex" = 39, "sam" = 25]',
						'\tconstant newer = ["alex" = 40, "kim" = 7]',
						"\tTerminal.inspect([ages with newer]::toString())",
					),
				),
			).toEqual(['"[\\"alex\\" = 40, \\"sam\\" = 25, \\"kim\\" = 7]"'])
		})

		it("holds a Record key, found by its encoding", async () => {
			expect(
				await run(
					block(
						"\tconstant scores = [{ x = 1, y = 2 } = 10]",
						"\tTerminal.inspect(scores::value(at { x = 1, y = 2 }, defaultingTo 0))",
					),
				),
			).toEqual(["10"])
		})

		// An Algebraic has no canonical encoding, so the lookup compares it
		// through `Number`'s `is`.
		it("holds a key the runtime can only find by comparing", async () => {
			expect(
				await run(
					block(
						"\tconstant scores: Dictionary<Number, Integer> = [2::squareRoot() = 10, 1/2 = 2]",
						"\tTerminal.inspect(scores::value(at 2::squareRoot(), defaultingTo 0))",
					),
				),
			).toEqual(["10"])
		})

		// `3` and `3/1` are one key under a `Number` key Type.
		it("holds a whole Rational and the Integer it is as one key", async () => {
			expect(
				await run(
					block(
						"\tconstant scores: Dictionary<Number, Integer> = [3 = 1, 1/2 = 2]",
						"\tTerminal.inspect(scores::value(at 3/1, defaultingTo 0))",
						"\tTerminal.inspect(scores::length())",
					),
				),
			).toEqual(["1", "2"])
		})

		it("holds a bare Case as a key", async () => {
			expect(
				await run(
					block(
						"\tchoice Suit { Red, Black }",
						"\tconstant scores: Dictionary<Suit, Integer> = [#Red = 1, #Black = 2]",
						"\tTerminal.inspect(scores::value(at #Black, defaultingTo 0))",
					),
				),
			).toEqual(["2"])
		})
	})
})
