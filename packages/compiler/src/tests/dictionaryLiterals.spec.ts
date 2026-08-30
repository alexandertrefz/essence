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

// NOTE: The three WRITTEN forms of a Dictionary — `["a" = 1]`, `[=]` and
// `[base with …]` — end to end. What is worth pinning about them is not one
// stage's output but that every stage agrees: the same brackets read as a List,
// as a Dictionary and as an update depending on ONE Token past the first
// Expression, and each reading has to survive typing, lowering and emission as
// the thing it was read as.
//
// NOTE: The harness runs the emitted JavaScript, as `rationals.spec.ts` and
// `decimalLiterals.spec.ts` do and for the same reason: a construction that
// compiles green and stores its keys in the wrong place is visible from Essence
// and from nowhere else.

function block(...lines: Array<string>): string {
	return ["implementation {", ...lines, "}"].join("\n")
}

// NOTE: Every Diagnostic the front end has about a Program, from all three of
// the stages that report one — an assignment that does not fit is the
// Validator's to say, and a spec reading only the Enricher's would pass on a
// Program the Compiler refuses.
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

// NOTE: The Type the LAST Declaration of the implementation came to, spelled
// the way a Hover would spell it — which is the only thing about a literal's
// Type that anybody outside the Compiler ever reads.
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
		// NOTE: One Token of lookahead past the first Expression decides all
		// three readings, so the three are asserted together: what tells them
		// apart is the `=`, the `with` and the absence of both.
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

		// NOTE: An entry's Position spans the key and the value, so a
		// Diagnostic about one entry underlines the entry and not the bracket
		// list it stands in.
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

		// NOTE: A List's mistakes keep a List's messages, and a Dictionary's
		// report where the reader is standing. Both are here because ONE Token
		// decides which of the two a bracket list is, so a message from the
		// wrong reading is the failure mode this arrangement has.
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

		// NOTE: A key that is a VALUE is a Dictionary's, and braces never hold
		// one — so the braces say what was meant rather than reporting about a
		// `with` nobody wrote.
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

		// NOTE: A bare name after a Dictionary's `with` is the whole value
		// being merged, never a key short for itself — there is no `a = a` for
		// it to have meant, because a key is a value and not a name.
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

		// NOTE: The same narrowing an empty List gets — the Declaration holds
		// no Type until an assignment decides one, and the assignment pins both
		// slots at once.
		it("narrows an empty Dictionary through an assignment", () => {
			expect(
				codesFor(
					block("\tvariable ages = [=]", '\tages = ["alex" = 39]'),
				),
			).toEqual([])
		})

		// NOTE: A key stands in the key slot of whatever the Dictionary is
		// expected to be, so a bare Case resolves there exactly as it does in a
		// List's item position.
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

		// NOTE: A key Type has to be Equatable because a construction COMPARES
		// its keys, and the bound is resolved exactly as a bounded Method call
		// resolves its own — so what a key Type with no conformance reports is
		// the Diagnostic that call would report.
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

	// NOTE: A written Dictionary proves what its brackets say and what stands
	// inside them, exactly as a written List does — `["a" = [1]]` is a
	// `Dictionary<String, NonEmptyList<Integer>>` because the inner brackets are
	// right there, one pair per entry. Both slots are walked, so a refinement in
	// the key position is admitted on the same terms.
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

		// NOTE: The key is the VALUE and not the characters — `2/4` is `1/2`,
		// and a whole Rational is the Integer it is, because that is what the
		// runtime's canonical encoding makes of them.
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

		// NOTE: String equality in Essence is canonical equivalence, so a
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

		// NOTE: A key the Compiler can not compare as written is left to the
		// runtime rule — a later duplicate wins — which is the honest division:
		// what is refused is what is visible.
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

		// NOTE: Overriding is the POINT of an update, so a key the base already
		// holds is no duplicate at all.
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

		// NOTE: An update over a base nothing has decided the slots of decides
		// them, exactly as an assignment does.
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

		// NOTE: ONCE, in both directions. The pair that was written says which
		// form was meant, so the key list is read under a form nobody wrote —
		// `port` there is an Expression naming no Constant, and `alex = 40` is
		// a Partial of a Dictionary. Both are Diagnostics about mistakes the
		// reader did not make, and the second of them contradicts the first
		// one's Help.
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

		// NOTE: And a braced update whose key is a written VALUE never reaches
		// the Enricher at all — no reading of `{ ages with "alex" = 40 }` gets
		// past the `=`. The Parser reports the same code, because the value key
		// says which pair was wanted without any Type being known.
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
		})

		// NOTE: `uncombinable-types` reaches a Dictionary-shaped base from two
		// directions now — a Union of Dictionaries, and a bare `Dictionary`
		// nothing applied Arguments to — so what it says about which Types
		// combine has to be true of Dictionaries too.
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

		// NOTE: A bare `Dictionary` takes every Dictionary, as a bare `List`
		// takes every List — and updating one is refused as a "Generic Type".
		// What is missing is exactly what would make it updatable, so the Help
		// names it rather than leaving the reader with a category.
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

	// NOTE: The Diagnostics the empty Dictionary alone reaches. `[=]` decides
	// neither of its slots, so it is the one written Dictionary whose Type a
	// later line has to settle — and every Diagnostic about that used to be a
	// sentence written about an empty LIST.
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

		// NOTE: A Dictionary has no item Type — it has two slots — and the
		// Help a List is given, `variable ages: List<Integer> = []`, is advice
		// that does not compile under a `[=]`.
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
			expect(diagnostic.helps).toEqual([
				"Annotate the declaration — 'variable ages: Dictionary<String, Integer> = [=]' — so the Function is checked against the Types it will hold.",
			])
		})

		// NOTE: A Method called on `[=]` binds NEITHER Type Parameter, and one
		// report per Parameter is the same sentence twice about one pair of
		// brackets — with a Help that can not be followed, since `length` takes
		// no Type Argument to write.
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
				"Annotate the declaration — 'constant d: Dictionary<String, Integer> = [=]'.",
			])
		})

		// NOTE: Both slots erase before a Match runs, so an EMPTY Dictionary is
		// a value of every Dictionary Type there is — exactly what the empty
		// List is, and exactly what `empty-list-overlap` exists to warn about.
		// Written as a PAIR, because the hazard is one hazard and reporting it
		// for one container and not the other is the failure this catches.
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

	// NOTE: `hasKey` is `@::value(at key)::hasValue()` and nothing else, so a
	// branch guarded by one and opening with that same lookup walks the
	// Dictionary twice for one answer. What is worth pinning is not the
	// Warning on its own but the line either side of it: every way the
	// repetition stops being something a reader can SEE is a way the Warning
	// has to go quiet, because a style lint that fires on a Program somebody
	// wrote deliberately is worse than no lint at all.
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

		// NOTE: Both entries of the `value` Overload count. The one that
		// answers an Optional is the shape the Help points AT — and it is
		// still one lookup too many while the `if` stands in front of it.
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

		// NOTE: An `else` changes nothing about the branch the `if` opens —
		// and the `match` the Help asks for is exactly the two-armed shape an
		// `if`/`else` around one lookup was reaching for.
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

		// NOTE: The branch is entered by the key being ABSENT, so the lookup
		// under it is the first one there is.
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

		// NOTE: Two calls that answer the same key are not two spellings of
		// one key — nothing a reader reads says the second call answers what
		// the first one did, and the Warning would be claiming it does.
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

		// NOTE: The same rule from the receiver's side. Two written updates
		// are two Dictionaries built one after the other, and holding the
		// first call's answer says nothing about the second one's.
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

		// NOTE: Everything past the first Statement could be what the branch
		// was entered FOR — a lookup after a line that acted on the key being
		// there is a second question rather than the first one repeated.
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

		// NOTE: And the boundary that makes the Statement above the whole of
		// what is read: the walk stops at a body. A lookup inside a Function
		// literal runs whenever the Function is called, which is not here, so
		// nothing says the guard's answer is still the answer.
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

		// NOTE: The one construction that compares nothing, and the one that
		// hands over no witness — there is no key in an empty store for a
		// written key to be measured against.
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

		// NOTE: A literal written inside a bounded Method or Function hands over
		// the witness that ARRIVED — the hidden conformance Parameter — rather
		// than one resolved for a Type Parameter nothing has decided yet.
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

		// NOTE: `merge` is written in Essence, so the whole-value form has to
		// reach it by name through the helper every emission site routes
		// through — otherwise the search that decides which standard library
		// consts a Module carries would never draw the edge, and the emitted
		// Program would name a const nobody declared.
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

	// NOTE: What the emitted JavaScript actually does, which is the only place
	// the insertion order, the override rule and the witness can be seen at all.
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

		// NOTE: The runtime's rule for a duplicate the Compiler could not see:
		// the later value wins and the key keeps the place its FIRST occurrence
		// took.
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

		// NOTE: An overwritten key keeps its place and a new one lands at the
		// end — the ratified order rule, seen through the written form.
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

		// NOTE: A Record key has no encoding, so it is found by the scan path
		// — through the very witness the literal carried into the construction.
		it("holds a key the runtime can only find by comparing", async () => {
			expect(
				await run(
					block(
						"\tconstant scores = [{ x = 1, y = 2 } = 10]",
						"\tTerminal.inspect(scores::value(at { x = 1, y = 2 }, defaultingTo 0))",
					),
				),
			).toEqual(["10"])
		})

		// NOTE: `3` and `3/1` are one key under a `Number` key Type, which is
		// what the Rational arm of the canonical encoding is for.
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
