import { describe, expect, it } from "bun:test"

import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import type { common, parser } from "@essence-lang/interfaces"

import { analyse } from "../analyse"
import { type CodeActionEntry, findCodeActions } from "../codeActions"
import { removeDefaultAction } from "../codeActions/defaultFixes"
import {
	closeStringAction,
	documentationSeparatorAction,
	invalidEscapeActions,
	mixedRationalActions,
	partialDecimalActions,
} from "../codeActions/literalFixes"
import {
	enclosingStatementOf,
	findInnermostNodeContaining,
} from "../codeActions/lookups"
import {
	expandShorthandKeyAction,
	expandShorthandPathAction,
} from "../codeActions/shorthandFixes"

// NOTE: Fixtures are joined line arrays with literal `\t`, so an assertion on
// an inserted arm's indentation is an assertion on the exact characters —
// which is the whole point of the missing-case fix.
function actionsOf(
	lines: Array<string>,
	range?: common.Position,
): Array<CodeActionEntry> {
	let source = lines.join("\n")

	return findCodeActions(
		source,
		range ?? {
			start: { line: 1, column: 1 },
			end: {
				line: lines.length,
				column: (lines.at(-1) as string).length + 1,
			},
		},
	)
}

function quickFixes(
	lines: Array<string>,
	range?: common.Position,
): Array<CodeActionEntry> {
	return actionsOf(lines, range).filter((entry) => entry.kind === "quickfix")
}

function titles(entries: Array<CodeActionEntry>): Array<string> {
	return entries.map((entry) => entry.title)
}

// NOTE: A misspelled Case reports beside whatever the misspelling made of the
// surrounding Types, so the fix under test has to be picked out by its code
// rather than taken as the first one offered.
function unknownCaseFixes(lines: Array<string>): Array<CodeActionEntry> {
	return quickFixes(lines).filter(
		(entry) => entry.diagnosticCode === "unknown-case",
	)
}

// NOTE: What the buffer looks like once the action is applied — an assertion
// on the resulting text catches an off-by-one in a range that an assertion on
// the range itself only encodes.
function applied(lines: Array<string>, entry: CodeActionEntry): Array<string> {
	let text = lines.join("\n")

	for (let edit of [...entry.edits].reverse()) {
		text = `${sliceUntil(text, edit.range.start)}${edit.newText}${sliceFrom(
			text,
			edit.range.end,
		)}`
	}

	return text.split("\n")
}

// NOTE: What the Compiler makes of the buffer the action produced — the only
// answer to "is this Match exhaustive now" that is not the fix marking its own
// homework. An arm the fix scaffolds is empty, so a `missing-return` behind it
// is expected and is the reader's to fill in.
function codesOf(lines: Array<string>): Array<common.DiagnosticCode> {
	return analyse(lines.join("\n")).map((diagnostic) => diagnostic.code)
}

// NOTE: A span by what it points AT rather than by a column counted out by
// hand — the fixtures are tab-indented, so a counted column is a fact about the
// whitespace rather than about the text under it.
function spanOf(
	lines: Array<string>,
	line: number,
	needle: string,
): common.Position {
	let column = (lines[line - 1] as string).indexOf(needle)

	if (column === -1) {
		throw new Error(`'${needle}' is not on line ${line}`)
	}

	return {
		start: { line, column: column + 1 },
		end: { line, column: column + 1 + needle.length },
	}
}

// NOTE: A Diagnostic as a DEBOUNCED Editor hands one back: the code and the
// span it was reported at, over a buffer that has been edited since. Every fix
// reads its span back off the buffer before it writes, and handing the two
// apart is the only way to ask one whether it really does — an analysis run on
// the text under test agrees with it by construction.
function staleDiagnostic(
	code: common.DiagnosticCode,
	position: common.Position,
	labels: Array<common.DiagnosticLabel> = [],
): common.Diagnostic & { position: common.Position } {
	return {
		severity: "error",
		message: "",
		code,
		position,
		labels: [{ position, message: "", kind: "primary" }, ...labels],
		notes: [],
		helps: [],
	}
}

function offsetOf(text: string, cursor: common.Cursor): number {
	let lines = text.split("\n")
	let offset = 0

	for (let line = 1; line < cursor.line; line++) {
		offset += (lines[line - 1] as string).length + 1
	}

	return offset + cursor.column - 1
}

function sliceUntil(text: string, cursor: common.Cursor): string {
	return text.slice(0, offsetOf(text, cursor))
}

function sliceFrom(text: string, cursor: common.Cursor): string {
	return text.slice(offsetOf(text, cursor))
}

describe("Code Actions", () => {
	describe("missing-case", () => {
		it("should add an arm per unhandled member of a primitive Union", () => {
			let lines = [
				"implementation {",
				"\tconstant value: Integer | String | Boolean = 1",
				"\tconstant described = match value -> String {",
				'\t\tcase Integer { <- "number" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Add missing Cases")
			expect(fix.kind).toBe("quickfix")
			expect(fix.diagnosticCode).toBe("missing-case")
			expect(fix.isPreferred).toBe(true)

			expect(result).toEqual([
				"implementation {",
				"\tconstant value: Integer | String | Boolean = 1",
				"\tconstant described = match value -> String {",
				'\t\tcase Integer { <- "number" }',
				"\t\tcase String {}",
				"\t\tcase Boolean {}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("missing-case")
		})

		it("should write a Choice's Cases with their Choice's name", () => {
			let lines = [
				"implementation {",
				"\tchoice Operation { Add, Subtract }",
				"\tconstant chosen: Operation = Operation#Add",
				"\tconstant described = match chosen -> String {",
				'\t\tcase Operation#Add { <- "add" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)[5]).toBe(
				"\t\tcase Operation#Subtract {}",
			)
		})

		it("should indent from the line the match keyword sits on", () => {
			let lines = [
				"implementation {",
				"\tfunction describe (value: Integer | String) -> String {",
				"\t\t<- match value -> String {",
				'\t\t\tcase Integer { <- "number" }',
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)).toEqual([
				"implementation {",
				"\tfunction describe (value: Integer | String) -> String {",
				"\t\t<- match value -> String {",
				'\t\t\tcase Integer { <- "number" }',
				"\t\t\tcase String {}",
				"\t\t}",
				"\t}",
				"}",
			])
		})

		it("should indent a nested Match from its own line", () => {
			let lines = [
				"implementation {",
				"\tconstant outer: Integer | String = 1",
				"\tconstant inner: Boolean | Integer = true",
				"\tconstant described = match outer -> String {",
				'\t\tcase Integer { <- "number" }',
				"\t\tcase String {",
				"\t\t\t<- match inner -> String {",
				'\t\t\t\tcase Boolean { <- "boolean" }',
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			]

			let fixes = quickFixes(lines)
			let inner = fixes.find(
				(entry) =>
					entry.diagnosticCode === "missing-case" &&
					entry.diagnosticPosition?.start.line === 7,
			) as CodeActionEntry

			expect(applied(lines, inner)[8]).toBe("\t\t\t\tcase Integer {}")
		})

		// NOTE: A Match written on one line has no line to insert whole arms
		// on, so the fix opens one rather than refusing.
		it("should break the line for a Match written on one", () => {
			let lines = [
				"implementation {",
				"\tconstant value: Integer | String = 1",
				'\tconstant described = match value -> String { case Integer { <- "number" } }',
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)).toEqual([
				"implementation {",
				"\tconstant value: Integer | String = 1",
				'\tconstant described = match value -> String { case Integer { <- "number" }',
				"\t\tcase String {}",
				"\t}",
				"}",
			])
		})

		it("should fall back to a single 'case _' for a Function member", () => {
			let lines = [
				"implementation {",
				"\tconstant value: Integer | (_ value: Integer) -> Integer = 1",
				"\tconstant described = match value -> String {",
				'\t\tcase Integer { <- "number" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Add a 'case _' for the missing Cases")
			expect(result[4]).toBe("\t\tcase _ {}")
			expect(codesOf(result)).not.toContain("missing-case")
		})

		// NOTE: One unwritable member used to cost the reader every other arm
		// as well. The named Cases are what the Compiler already knows, and
		// only the Signature has to fall to the catch-all.
		it("should keep the named arms it can write beside the 'case _'", () => {
			let lines = [
				"implementation {",
				"\tconstant value: Integer | String | (_ value: Integer) -> Integer = 1",
				"\tconstant described = match value -> String {",
				'\t\tcase Integer { <- "number" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe(
				"Add the missing Cases and a 'case _' for the rest",
			)

			expect(result).toEqual([
				"implementation {",
				"\tconstant value: Integer | String | (_ value: Integer) -> Integer = 1",
				"\tconstant described = match value -> String {",
				'\t\tcase Integer { <- "number" }',
				"\t\tcase String {}",
				"\t\tcase _ {}",
				"\t}",
				"}",
			])

			// NOTE: Exhaustive, and the catch-all sits last — a `case _` above
			// the named arm would have made it unreachable instead.
			expect(codesOf(result)).not.toContain("missing-case")
			expect(codesOf(result)).not.toContain("unreachable-case")
		})
	})

	describe("unreachable-case", () => {
		it("should delete the Case with its line break and indentation", () => {
			let lines = [
				"implementation {",
				"\tconstant value: Integer | String = 1",
				"\tconstant described = match value -> String {",
				'\t\tcase Integer { <- "number" }',
				'\t\tcase String { <- "string" }',
				'\t\tcase Boolean { <- "boolean" }',
				"\t}",
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) => entry.diagnosticCode === "unreachable-case",
			) as CodeActionEntry

			expect(fix.title).toBe("Remove unreachable Case")
			expect(fix.edits[0].range).toEqual({
				start: { line: 5, column: 30 },
				end: { line: 6, column: 32 },
			})

			expect(applied(lines, fix)).toEqual([
				"implementation {",
				"\tconstant value: Integer | String = 1",
				"\tconstant described = match value -> String {",
				'\t\tcase Integer { <- "number" }',
				'\t\tcase String { <- "string" }',
				"\t}",
				"}",
			])
		})

		it("should delete a Case whose body spans several lines", () => {
			let lines = [
				"implementation {",
				"\tconstant value: Integer | String = 1",
				"\tconstant described = match value -> String {",
				'\t\tcase Integer { <- "number" }',
				'\t\tcase String { <- "string" }',
				"\t\tcase Boolean {",
				'\t\t\t<- "boolean"',
				"\t\t}",
				"\t}",
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) => entry.diagnosticCode === "unreachable-case",
			) as CodeActionEntry

			expect(applied(lines, fix)).toEqual([
				"implementation {",
				"\tconstant value: Integer | String = 1",
				"\tconstant described = match value -> String {",
				'\t\tcase Integer { <- "number" }',
				'\t\tcase String { <- "string" }',
				"\t}",
				"}",
			])
		})
	})

	describe("suggestions", () => {
		it("should offer the suggested name for an unknown Name", () => {
			let lines = [
				"implementation {",
				'\tconstant name = "Ada"',
				"\tconstant other = nme",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Change to 'name'")
			expect(fix.diagnosticCode).toBe("unknown-name")
			expect(applied(lines, fix)[2]).toBe("\tconstant other = name")
		})

		it("should offer the suggested name for an unknown Type", () => {
			let lines = [
				"implementation {",
				'\tconstant name: Strng = "Ada"',
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Change to 'String'")
			expect(fix.diagnosticCode).toBe("unknown-type")
			expect(applied(lines, fix)[1]).toBe(
				'\tconstant name: String = "Ada"',
			)
		})

		it("should offer the suggested name for an unknown Protocol", () => {
			let lines = [
				"implementation {",
				"\tprotocol Countable {",
				"\t\tcount() -> Integer",
				"\t}",
				"\tnamespace Counter for Integer is Countble {",
				"\t\tcount() -> Integer { <- @ }",
				"\t}",
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) => entry.diagnosticCode === "unknown-protocol",
			) as CodeActionEntry

			expect(fix.title).toBe("Change to 'Countable'")
			expect(applied(lines, fix)[4]).toBe(
				"\tnamespace Counter for Integer is Countable {",
			)
		})

		it("should offer the suggested name for an unknown Member", () => {
			let lines = [
				"implementation {",
				'\tconstant person = { firstName = "Ada" }',
				"\tconstant name = person.firstNme",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Change to 'firstName'")
			expect(fix.diagnosticCode).toBe("unknown-member")
			expect(applied(lines, fix)[2]).toBe(
				"\tconstant name = person.firstName",
			)
		})

		it("should offer the suggested name for an unknown Method", () => {
			let lines = [
				"implementation {",
				'\tconstant size = "Ada"::lenth()',
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Change to 'length'")
			expect(fix.diagnosticCode).toBe("unknown-method")
			expect(applied(lines, fix)[1]).toBe(
				'\tconstant size = "Ada"::length()',
			)
		})

		it("should render an unknown Case with its sigil but replace only the name", () => {
			let lines = [
				"implementation {",
				"\tchoice Operation { Add, Subtract }",
				"\tconstant chosen = Operation#Ad",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Change to '#Add'")
			expect(fix.diagnosticCode).toBe("unknown-case")
			expect(applied(lines, fix)[2]).toBe(
				"\tconstant chosen = Operation#Add",
			)
		})

		// NOTE: The bare `#Case` spelling is the one this codebase's own style
		// prefers, so it is the form the fix has to reach — the Choice-prefixed
		// site above resolves through a different path in the Enricher.
		it("should suggest a Case for the bare sigil form", () => {
			let lines = [
				"implementation {",
				"\tchoice Operation { Add, Subtract }",
				"\tconstant chosen: Operation = #Ad",
				"}",
			]

			let [fix] = unknownCaseFixes(lines)

			expect(fix.title).toBe("Change to '#Add'")
			expect(applied(lines, fix)[2]).toBe(
				"\tconstant chosen: Operation = #Add",
			)
		})

		it("should suggest a Case for a bare Matcher", () => {
			let lines = [
				"implementation {",
				"\tchoice Operation { Add, Subtract }",
				"\tconstant chosen: Operation = #Add",
				"\tconstant described = match chosen -> String {",
				'\t\tcase #Ad { <- "add" }',
				'\t\tcase #Subtract { <- "subtract" }',
				"\t}",
				"}",
			]

			let [fix] = unknownCaseFixes(lines)

			expect(fix.title).toBe("Change to '#Add'")
			expect(applied(lines, fix)[4]).toBe('\t\tcase #Add { <- "add" }')
		})

		// NOTE: A guess is only worth offering when it is close. A name nothing
		// resembles must leave the Diagnostic to speak for itself rather than
		// send the reader to an unrelated Case.
		it("should offer nothing when no Case is close", () => {
			let lines = [
				"implementation {",
				"\tchoice Operation { Add, Subtract }",
				"\tconstant chosen: Operation = #Zzzzzzzz",
				"}",
			]

			expect(unknownCaseFixes(lines)).toEqual([])
		})
	})

	describe("constant-reassignment", () => {
		it("should rewrite the Declaration's keyword", () => {
			let lines = [
				"implementation {",
				"\tconstant count = 1",
				"\tcount = 2",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Declare 'count' as a Variable")
			expect(applied(lines, fix)[1]).toBe("\tvariable count = 1")
		})

		// NOTE: A `§§` block above the Declaration must not drag the keyword
		// span up into the Comment — the fix verifies the source slice before
		// it rewrites anything, so this would come back as no action at all
		// rather than as a mangled Comment.
		it("should rewrite the keyword under a documentation block", () => {
			let lines = [
				"implementation {",
				"\t§§ How many.",
				"\tconstant count = 1",
				"\tcount = 2",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)[2]).toBe("\tvariable count = 1")
		})
	})

	describe("redundant-parameter-label", () => {
		// NOTE: A Function literal passed to a call is the only place this
		// Diagnostic can fire — a Parameter carrying a label everywhere else
		// is annotated, and an annotated label is legal. The label is the ONLY
		// thing wrong with this Program, so the buffer analyses clean once the
		// fix is applied, which is what the fix claims to do.
		it("should keep only the internal name", () => {
			let lines = [
				"implementation {",
				"\tconstant kept = [1]::removeEvery(where (with item) { <- true })",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove the label")
			expect(result[1]).toBe(
				"\tconstant kept = [1]::removeEvery(where (item) { <- true })",
			)

			expect(codesOf(result)).toEqual([])
		})
	})

	describe("redundant-interpolation-to-string", () => {
		it("should leave the receiver as the whole hole", () => {
			let lines = [
				"implementation {",
				"\tconstant count = 3",
				'\tconstant message = "count: {count::toString()}"',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove the redundant 'toString' call")
			expect(result[2]).toBe('\tconstant message = "count: {count}"')

			expect(codesOf(result)).toEqual([])
		})

		it("should remove only the redundant call of a chain", () => {
			let lines = [
				"implementation {",
				'\tconstant words = ["a", "b"]',
				'\tconstant message = "words: {words::length()::toString()}"',
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)[2]).toBe(
				'\tconstant message = "words: {words::length()}"',
			)
		})
	})

	// NOTE: The Warning offers two spellings and the fix applies one of them, so
	// it is a rewrite rather than a quickfix and is picked out by the code it
	// answers. Applying it leaves a Program that says which question it asks, so
	// the Warning is gone from the buffer the fix produced.
	describe("ambiguous-nesting-level", () => {
		function rewrites(lines: Array<string>): Array<CodeActionEntry> {
			return actionsOf(lines).filter(
				(entry) => entry.diagnosticCode === "ambiguous-nesting-level",
			)
		}

		it("should wrap the Argument in the Case that holds it", () => {
			let lines = [
				"implementation {",
				"\tconstant nested: Optional<Optional<Integer>> = #Value(#Empty)",
				"\tconstant answer = nested::is(#Empty)",
				"}",
			]

			let [fix] = rewrites(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Wrap the Argument in '#Value(…)'")
			expect(fix.kind).toBe("refactor.rewrite")
			expect(fix.isPreferred).toBe(false)
			expect(result[2]).toBe(
				"\tconstant answer = nested::is(#Value(#Empty))",
			)

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: An Argument carrying a payload is wrapped whole, and its own text
		// is never retyped — the fix is two insertions at the ends of the span.
		it("should wrap a Case carrying a payload", () => {
			let lines = [
				"implementation {",
				'\tconstant failed: Result<Result<Integer, String>, String> = #Value(#Failure("gone"))',
				'\tconstant answer = failed::is(#Failure("gone"))',
				"}",
			]

			let [fix] = rewrites(lines)

			expect(applied(lines, fix)[2]).toBe(
				'\tconstant answer = failed::is(#Value(#Failure("gone")))',
			)
		})

		// NOTE: The Case the fix wraps in is the receiver's, not the standard
		// library's — a Program's own carrier gets its own Case name.
		it("should name the receiver's own holding Case", () => {
			let lines = [
				"implementation {",
				"\tchoice Box<ItemType> {",
				"\t\tFull { item: ItemType },",
				"\t\tBlank,",
				"\t}",
				"",
				"\tnamespace Boxes<infer ItemType> for Box<ItemType> {",
				"\t\toverload holds {",
				"\t\t\t(_ other: Box<ItemType>) -> Boolean {",
				"\t\t\t\t<- true",
				"\t\t\t}",
				"",
				"\t\t\t(_ other: ItemType) -> Boolean {",
				"\t\t\t\t<- false",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"",
				"\tconstant nested: Box<Box<Integer>> = #Full(#Blank)",
				"",
				"\tconstant answer = nested::holds(#Blank)",
				"}",
			]

			let [fix] = rewrites(lines)

			expect(fix.title).toBe("Wrap the Argument in '#Full(…)'")
			expect(applied(lines, fix)[20]).toBe(
				"\tconstant answer = nested::holds(#Full(#Blank))",
			)
		})

		// NOTE: A carrier holding one Type in TWO Cases offers one rewrite per
		// Case, because each of them asks a different question — a single action
		// would present one of two readings as the answer. Both compile, and the
		// titles are what tell them apart in the list.
		it("should offer one rewrite per Case that holds", () => {
			let lines = [
				"implementation {",
				"\tchoice Twin<ItemType> {",
				"\t\tFirst { item: ItemType },",
				"\t\tSecond { item: ItemType },",
				"\t\tBlank,",
				"\t}",
				"",
				"\tnamespace Twins<infer ItemType> for Twin<ItemType> {",
				"\t\toverload holds {",
				"\t\t\t(_ other: Twin<ItemType>) -> Boolean {",
				"\t\t\t\t<- true",
				"\t\t\t}",
				"",
				"\t\t\t(_ other: ItemType) -> Boolean {",
				"\t\t\t\t<- false",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"",
				"\tconstant nested: Twin<Twin<Integer>> = #First(#Blank)",
				"",
				"\tconstant answer = nested::holds(#Blank)",
				"}",
			]
			let offered = rewrites(lines)

			expect(offered.map((entry) => entry.title)).toEqual([
				"Wrap the Argument in '#First(…)'",
				"Wrap the Argument in '#Second(…)'",
			])
			expect(applied(lines, offered[0])[21]).toBe(
				"\tconstant answer = nested::holds(#First(#Blank))",
			)
			expect(applied(lines, offered[1])[21]).toBe(
				"\tconstant answer = nested::holds(#Second(#Blank))",
			)
			expect(codesOf(applied(lines, offered[0]))).toEqual([])
			expect(codesOf(applied(lines, offered[1]))).toEqual([])
		})

		it("should offer nothing where nothing warns", () => {
			expect(
				rewrites([
					"implementation {",
					"\tconstant plain: Optional<Integer> = #Value(1)",
					"\tconstant answer = plain::is(#Empty)",
					"}",
				]),
			).toEqual([])
		})
	})

	describe("fallback-never-used", () => {
		// NOTE: The Argument the Warning names goes, and the comma in front of it
		// goes with it — a call left holding `(by 2, )` is not what the Help asks
		// for. The Warning is the only thing wrong with this Program, so the
		// buffer analyses clean once the fix is applied.
		it("should remove the fallback and the comma in front of it", () => {
			let lines = [
				"implementation {",
				"\tconstant half = 10::divide(by 2, defaultingTo 0/1)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove the 'defaultingTo' Argument")
			expect(result[1]).toBe("\tconstant half = 10::divide(by 2)")

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A fallback that is the only Argument has no comma to take, and
		// the brackets stay.
		it("should leave the brackets where the fallback stands alone", () => {
			let lines = [
				"implementation {",
				"\tconstant scores: NonEmptyList<Integer> = [3, 1, 2]",
				"\tconstant best = scores::firstItem(defaultingTo 0)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result[2]).toBe("\tconstant best = scores::firstItem()")

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: The Standard Library writes `defaultingTo:` last, but nothing
		// makes a Program do so — a fallback ahead of another Argument takes the
		// comma AFTER it instead, or the call is left starting with one.
		it("should take the comma after a fallback written first", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes for List<Integer> {",
				"\t\toverload head {",
				"\t\t\t(also extra: Integer) -> Optional<Integer> {",
				"\t\t\t\t<- @::firstItem()",
				"\t\t\t}",
				"",
				"\t\t\t(defaultingTo fallback: Integer, also extra: Integer) -> Integer {",
				"\t\t\t\t<- @::firstItem(defaultingTo fallback)",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"",
				"\tnamespace FilledBoxes for NonEmptyList<Integer> {",
				"\t\thead(also extra: Integer) -> Integer {",
				"\t\t\t<- @::firstItem()",
				"\t\t}",
				"\t}",
				"",
				"\tconstant proven: NonEmptyList<Integer> = [3, 1, 2]",
				"\tconstant head = proven::head(defaultingTo 0, also 1)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result[20]).toBe("\tconstant head = proven::head(also 1)")

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A call written over several lines leaves the Argument's line
		// empty rather than holding a comma on its own, which is what taking the
		// whitespace with the comma buys.
		it("should carry a call written over several lines", () => {
			let lines = [
				"implementation {",
				"\tconstant half = 10::divide(",
				"\t\tby 2,",
				"\t\tdefaultingTo 0/1,",
				"\t)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result.slice(1, 4)).toEqual([
				"\tconstant half = 10::divide(",
				"\t\tby 2,",
				"\t)",
			])

			expect(codesOf(result)).toEqual([])
		})
	})

	describe("missing-return", () => {
		it("should add an else branch when the body ends in an If", () => {
			let lines = [
				"implementation {",
				"\tfunction sign (value: Integer) -> Integer {",
				"\t\tif value::isGreaterThan(0) {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Add an empty else branch")
			expect(fix.isPreferred).toBe(false)

			expect(applied(lines, fix)).toEqual([
				"implementation {",
				"\tfunction sign (value: Integer) -> Integer {",
				"\t\tif value::isGreaterThan(0) {",
				"\t\t\t<- 1",
				"\t\t} else {",
				"\t\t}",
				"\t}",
				"}",
			])
		})

		it("should stay silent when the body does not end in an If", () => {
			let lines = [
				"implementation {",
				"\tfunction sign (value: Integer) -> Integer {",
				"\t\tconstant doubled = value",
				"\t}",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
		})

		it("should reach a Method's body as well as a Function's", () => {
			let lines = [
				"implementation {",
				"\tnamespace Sign for Integer {",
				"\t\tsign () -> Integer {",
				"\t\t\tif @::isGreaterThan(0) {",
				"\t\t\t\t<- 1",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.diagnosticCode).toBe("missing-return")
			expect(applied(lines, fix)[5]).toBe("\t\t\t} else {")
			expect(applied(lines, fix)[6]).toBe("\t\t\t}")
		})
	})

	describe("unclosed-string", () => {
		it("should close the String at the end of the line it opened on", () => {
			let lines = [
				"implementation {",
				'\tconstant greeting = "hello',
				"\tconstant other = 1",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Add the missing '\"'")
			expect(fix.diagnosticCode).toBe("unclosed-string")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result).toEqual([
				"implementation {",
				'\tconstant greeting = "hello"',
				"\tconstant other = 1",
				"}",
			])

			expect(codesOf(result)).not.toContain("unclosed-string")
		})

		it("should stay silent where the opening quote has been typed over", () => {
			let lines = ["implementation {", "\tconstant greeting = hello", "}"]

			expect(
				closeStringAction(
					staleDiagnostic("unclosed-string", spanOf(lines, 3, "}"), [
						{
							position: spanOf(lines, 2, "h"),
							message: "opened here",
							kind: "secondary",
						},
					]),
					lines,
				),
			).toBeNull()
		})
	})

	describe("invalid-escape", () => {
		it("should offer both readings of the backslash, neither preferred", () => {
			let lines = ["implementation {", '\tconstant quoted = "a\\qb"', "}"]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write '\\\\' for a literal backslash",
				"Drop the backslash",
			])

			expect(fixes.every((fix) => !fix.isPreferred)).toBe(true)

			expect(applied(lines, fixes[0])).toEqual([
				"implementation {",
				'\tconstant quoted = "a\\\\qb"',
				"}",
			])

			expect(applied(lines, fixes[1])).toEqual([
				"implementation {",
				'\tconstant quoted = "aqb"',
				"}",
			])

			expect(codesOf(applied(lines, fixes[0]))).not.toContain(
				"invalid-escape",
			)

			expect(codesOf(applied(lines, fixes[1]))).not.toContain(
				"invalid-escape",
			)
		})

		it("should stay silent where the span no longer reads as an escape", () => {
			let lines = ["implementation {", '\tconstant quoted = "ab"', "}"]

			expect(
				invalidEscapeActions(
					staleDiagnostic("invalid-escape", spanOf(lines, 2, "ab")),
					lines,
				),
			).toEqual([])
		})
	})

	describe("partial-decimal-literal", () => {
		it("should write the missing whole part of a leading point", () => {
			let lines = ["implementation {", "\tconstant share = .5", "}"]

			let [fix] = quickFixes(lines)

			expect(titles(quickFixes(lines))).toEqual(["Write it as '0.5'"])
			expect(fix.diagnosticCode).toBe("partial-decimal-literal")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result).toEqual([
				"implementation {",
				"\tconstant share = 0.5",
				"}",
			])

			expect(codesOf(result)).not.toContain("partial-decimal-literal")
		})

		// NOTE: The two answers differ in the Type the Literal ends up with, so
		// the reader picks and the Editor does not.
		it("should offer both readings of a trailing point", () => {
			let lines = ["implementation {", "\tconstant share = 1.", "}"]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write it as '1.0'",
				"Write it as '1'",
			])

			expect(fixes.every((fix) => !fix.isPreferred)).toBe(true)

			expect(applied(lines, fixes[0])[1]).toBe("\tconstant share = 1.0")
			expect(applied(lines, fixes[1])[1]).toBe("\tconstant share = 1")

			expect(codesOf(applied(lines, fixes[0]))).not.toContain(
				"partial-decimal-literal",
			)

			expect(codesOf(applied(lines, fixes[1]))).not.toContain(
				"partial-decimal-literal",
			)
		})

		it("should stay silent where the span no longer reads as half a decimal", () => {
			let lines = ["implementation {", "\tconstant share = 15", "}"]

			expect(
				partialDecimalActions(
					staleDiagnostic(
						"partial-decimal-literal",
						spanOf(lines, 2, "15"),
					),
					lines,
				),
			).toEqual([])
		})
	})

	describe("mixed-rational-literal", () => {
		it("should offer the value as a fraction and as a decimal", () => {
			let lines = ["implementation {", "\tconstant ratio = 1.5/2", "}"]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write it as '3/4'",
				"Write it as '0.75'",
			])

			expect(fixes.every((fix) => !fix.isPreferred)).toBe(true)

			expect(applied(lines, fixes[0])[1]).toBe("\tconstant ratio = 3/4")
			expect(applied(lines, fixes[1])[1]).toBe("\tconstant ratio = 0.75")

			expect(codesOf(applied(lines, fixes[0]))).not.toContain(
				"mixed-rational-literal",
			)

			expect(codesOf(applied(lines, fixes[1]))).not.toContain(
				"mixed-rational-literal",
			)
		})

		it("should read a decimal written behind the fraction the same way", () => {
			let lines = ["implementation {", "\tconstant ratio = 1/2.5", "}"]

			expect(titles(quickFixes(lines))).toEqual([
				"Write it as '2/5'",
				"Write it as '0.4'",
			])
		})

		// NOTE: A third has no decimal that says it, and a rounded one would be
		// a different number.
		it("should offer the fraction alone where no decimal says the value", () => {
			let lines = ["implementation {", "\tconstant ratio = 1.5/7", "}"]

			expect(titles(quickFixes(lines))).toEqual(["Write it as '3/14'"])
		})

		it("should stay silent where the span no longer reads as a Literal", () => {
			let lines = ["implementation {", "\tconstant ratio = 34", "}"]

			expect(
				mixedRationalActions(
					staleDiagnostic(
						"mixed-rational-literal",
						spanOf(lines, 2, "34"),
					),
					lines,
				),
			).toEqual([])
		})
	})

	describe("missing-documentation-separator", () => {
		it("should write the em-dash in front of the tag's text", () => {
			let lines = [
				"implementation {",
				"\t§§ @param subject who to greet",
				"\tfunction greet (subject: String) -> String { <- subject }",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Insert the '—' separator")
			expect(fix.diagnosticCode).toBe("missing-documentation-separator")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result[1]).toBe("\t§§ @param subject — who to greet")
			expect(codesOf(result)).not.toContain(
				"missing-documentation-separator",
			)
		})

		it("should stay silent where the separator already stands there", () => {
			let lines = [
				"implementation {",
				"\t§§ @param subject — who to greet",
				"\tfunction greet (subject: String) -> String { <- subject }",
				"}",
			]

			expect(
				documentationSeparatorAction(
					staleDiagnostic(
						"missing-documentation-separator",
						spanOf(lines, 2, "— who to greet"),
					),
					lines,
				),
			).toBeNull()
		})
	})

	describe("shorthand-in-combination", () => {
		it("should write the value a bare key stood for", () => {
			let lines = [
				"implementation {",
				"\tconstant base = { port = 1, host = 2 }",
				"\tconstant port = 3",
				"\tconstant host = 4",
				"\tconstant updated = { base with port, host }",
				"}",
			]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write 'port = port'",
				"Write 'host = host'",
			])

			expect(fixes[0].isPreferred).toBe(true)

			let result = applied(applied(lines, fixes[1]), fixes[0])

			expect(result[4]).toBe(
				"\tconstant updated = { base with port = port, host = host }",
			)

			expect(codesOf(result)).not.toContain("shorthand-in-combination")
		})

		// NOTE: A Dictionary's key is a VALUE rather than a name, so there is
		// nothing for a bare one to have been short for — the code is shared, the
		// answer is not.
		it("should stay silent for a bare name in a Dictionary update", () => {
			let lines = [
				"implementation {",
				'\tconstant base = ["a" = 1]',
				"\tconstant a = 2",
				"\tconstant b = 3",
				"\tconstant updated = [base with a, b]",
				"}",
			]

			expect(
				quickFixes(lines).filter(
					(fix) => fix.diagnosticCode === "shorthand-in-combination",
				),
			).toEqual([])
		})

		it("should stay silent where the span no longer reads as a name", () => {
			let lines = [
				"implementation {",
				"\tconstant updated = { base with port = 1 }",
				"}",
			]

			let { program } = parseWithDiagnostics(lines.join("\n"))

			expect(
				expandShorthandKeyAction(
					staleDiagnostic(
						"shorthand-in-combination",
						spanOf(lines, 2, "port = 1"),
					),
					program,
					lines,
				),
			).toBeNull()
		})
	})

	describe("shorthand-on-path-key", () => {
		it("should write the last step as the value the path sets", () => {
			let lines = [
				"implementation {",
				"\tconstant config = { server = { port = 1, name = 2 } }",
				"\tconstant port = 3",
				"\tconstant updated = { config with server.port, name = 5 }",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Write 'server.port = port'")
			expect(fix.diagnosticCode).toBe("shorthand-on-path-key")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result[3]).toBe(
				"\tconstant updated = { config with server.port = port, name = 5 }",
			)

			expect(codesOf(result)).not.toContain("shorthand-on-path-key")
		})

		it("should stay silent where the span no longer reads as a path", () => {
			let lines = [
				"implementation {",
				"\tconstant updated = { config with server = s }",
				"}",
			]

			expect(
				expandShorthandPathAction(
					staleDiagnostic(
						"shorthand-on-path-key",
						spanOf(lines, 2, "server"),
					),
					lines,
				),
			).toBeNull()
		})
	})

	describe("defaults written where they can never fire", () => {
		it("should remove a default on a Case with no payload", () => {
			let lines = [
				"implementation {",
				"\tchoice Colour { Red = { a = 1 }, Green }",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Remove the default")
			expect(fix.diagnosticCode).toBe("case-default-without-payload")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result[1]).toBe("\tchoice Colour { Red, Green }")
			expect(codesOf(result)).not.toContain(
				"case-default-without-payload",
			)
		})

		it("should remove a default on a Function literal", () => {
			let lines = [
				"implementation {",
				"\tconstant twice = (value: Integer = 3) -> Integer { <- value }",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.diagnosticCode).toBe("default-on-function-literal")

			let result = applied(lines, fix)

			expect(result[1]).toBe(
				"\tconstant twice = (value: Integer) -> Integer { <- value }",
			)

			expect(codesOf(result)).not.toContain("default-on-function-literal")
		})

		it("should remove a default on a Protocol requirement", () => {
			let lines = [
				"implementation {",
				"\tprotocol Trimmable {",
				"\t\ttrim(at side: Integer = 1) -> Self",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.diagnosticCode).toBe("default-on-protocol-requirement")

			let result = applied(lines, fix)

			expect(result[2]).toBe("\t\ttrim(at side: Integer) -> Self")
			expect(codesOf(result)).not.toContain(
				"default-on-protocol-requirement",
			)
		})

		it("should stay silent where no '=' stands in front of the span", () => {
			let lines = [
				"implementation {",
				"\tchoice Colour { Red, Green }",
				"}",
			]

			expect(
				removeDefaultAction(
					staleDiagnostic(
						"case-default-without-payload",
						spanOf(lines, 2, "Green"),
					),
					lines,
				),
			).toBeNull()
		})
	})

	describe("Type annotations", () => {
		it("should offer the inferred Type of a Constant as an edit", () => {
			let lines = ["implementation {", '\tconstant name = "Ada"', "}"]

			let [refactor] = actionsOf(lines)

			expect(refactor.title).toBe(
				"Add explicit Type annotation ': String'",
			)
			expect(refactor.kind).toBe("refactor.rewrite")
			expect(refactor.diagnosticCode).toBeNull()
			expect(applied(lines, refactor)[1]).toBe(
				'\tconstant name: String = "Ada"',
			)
		})

		it("should offer a contextually typed literal's return Type", () => {
			let lines = [
				"implementation {",
				"\tconstant kept = [1]::removeEvery(where (item) { <- true })",
				"}",
			]

			let refactor = actionsOf(lines).find((entry) =>
				entry.title.includes("->"),
			) as CodeActionEntry

			expect(refactor.title).toBe(
				"Add explicit Type annotation '-> Boolean'",
			)
			expect(applied(lines, refactor)[1]).toBe(
				"\tconstant kept = [1]::removeEvery(where (item) -> Boolean { <- true })",
			)
		})
	})

	// NOTE: The Formatter refuses to move between the two spellings, so this is
	// where a reader gets to. Both directions, and neither of them inside an
	// update's key list, where the two spellings do not mean the same thing.
	describe("Property shorthand", () => {
		let shorthandTitles = (
			lines: Array<string>,
			range?: common.Position,
		): Array<string> =>
			titles(
				actionsOf(lines, range).filter(
					(entry) =>
						entry.title.startsWith("Shorten to") ||
						entry.title.startsWith("Expand to"),
				),
			)

		it("should offer to shorten a member that repeats its own name", () => {
			let lines = [
				"implementation {",
				"\tconstant x = 1",
				"\tconstant point = { x = x }",
				"}",
			]

			let refactor = actionsOf(lines).find((entry) =>
				entry.title.startsWith("Shorten to"),
			) as CodeActionEntry

			expect(refactor.title).toBe("Shorten to 'x'")
			expect(refactor.kind).toBe("refactor.rewrite")
			expect(applied(lines, refactor)[2]).toBe("\tconstant point = { x }")
		})

		it("should offer to expand a bare member name", () => {
			let lines = [
				"implementation {",
				"\tconstant x = 1",
				"\tconstant point = { x }",
				"}",
			]

			let refactor = actionsOf(lines).find((entry) =>
				entry.title.startsWith("Expand to"),
			) as CodeActionEntry

			expect(refactor.title).toBe("Expand to 'x = x'")
			expect(applied(lines, refactor)[2]).toBe(
				"\tconstant point = { x = x }",
			)
		})

		it("should offer nothing on a member that names another value", () => {
			expect(
				shorthandTitles([
					"implementation {",
					"\tconstant y = 1",
					"\tconstant point = { x = y }",
					"}",
				]),
			).toEqual([])
		})

		// NOTE: `{ base with x }` merges the VALUE `x`, so shortening the key
		// list would be a rewrite of what the file means.
		it("should offer nothing inside an update's key list", () => {
			expect(
				shorthandTitles([
					"implementation {",
					"\tconstant x = 1",
					"\tconstant base = { x = 0 }",
					"\tconstant moved = { base with x = x }",
					"}",
				]),
			).toEqual([])
		})

		it("should offer inside a Literal an update merges", () => {
			expect(
				shorthandTitles([
					"implementation {",
					"\tconstant x = 1",
					"\tconstant base = { x = 0 }",
					"\tconstant moved = { base with { x = x } }",
					"}",
				]),
			).toEqual(["Shorten to 'x'"])
		})

		it("should only offer what the requested range touches", () => {
			let lines = [
				"implementation {",
				"\tconstant x = 1",
				"\tconstant y = 2",
				"\tconstant point = { x = x, y = y }",
				"}",
			]

			expect(
				shorthandTitles(lines, {
					start: { line: 4, column: 21 },
					end: { line: 4, column: 22 },
				}),
			).toEqual(["Shorten to 'x'"])
		})
	})

	describe("selection", () => {
		it("should find nothing in a Program with nothing to fix", () => {
			let lines = [
				"implementation {",
				'\tconstant name: String = "Ada"',
				"}",
			]

			expect(actionsOf(lines)).toEqual([])
		})

		// NOTE: The suggestion IS the fix — a Diagnostic that found nothing
		// close enough to suggest has nothing to offer, and an action titled
		// after a name the Compiler never proposed would be inventing one.
		it("should offer nothing when the Compiler suggested nothing", () => {
			let lines = [
				"implementation {",
				'\tconstant first = "Ada"',
				"\tconstant second = unrelatedName",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
		})

		it("should only offer what the requested range touches", () => {
			let lines = [
				"implementation {",
				'\tconstant first = "Ada"',
				"\tconstant second = frst",
				"\tconstant third = scond",
				"}",
			]

			expect(
				titles(
					quickFixes(lines, {
						start: { line: 3, column: 1 },
						end: { line: 3, column: 24 },
					}),
				),
			).toEqual(["Change to 'first'"])
		})
	})
})

// NOTE: The refactor walk reaches Record literals wherever they are written,
// and an arm's value is one more such place — a `define` holds Expressions and
// no body at all, so a walk with no case for it reaches none of them.
describe("Code Actions inside a define arm", () => {
	it("should offer the shorthand refactor on a literal in an arm's value", () => {
		let lines = [
			"implementation {",
			"\tconstant x = 1",
			"\tconstant chosen = define {",
			"\t\tas { x = x } if true",
			"\t\tas { x = 0 } otherwise",
			"\t}",
			"}",
		]

		expect(
			titles(actionsOf(lines)).filter((title) =>
				title.startsWith("Shorten to"),
			),
		).toEqual(["Shorten to 'x'"])
	})
})

// NOTE: The two lookups a REFACTORING starts from, which no fix above reaches:
// a Diagnostic names the Node it was reported against and a selection names
// nothing, so both of these answer by containment.
describe("Code Action lookups", () => {
	const lines = [
		"implementation {",
		"\tnamespace Sign for Integer {",
		"\t\tdescribe() -> String {",
		'\t\t\tconstant label = "sign"',
		"\t\t\t<- match @ -> String {",
		"\t\t\t\tcase Integer {",
		"\t\t\t\t\t<- label",
		"\t\t\t\t}",
		"\t\t\t}",
		"\t\t}",
		"\t}",
		"}",
	]

	// NOTE: Asserted on rather than only parsed — a fixture the Parser recovered
	// from has a shape nobody wrote, and every assertion below would be about
	// that shape instead.
	function programOf(): parser.Program {
		let { program, diagnostics } = parseWithDiagnostics(lines.join("\n"))

		expect(diagnostics).toEqual([])

		return program
	}

	// NOTE: A range spelled as the text it covers, so that a fixture gaining a
	// line takes no assertion with it.
	function spanOf(text: string): common.Position {
		let line = lines.findIndex((candidate) => candidate.includes(text)) + 1
		let column = (lines[line - 1] as string).indexOf(text) + 1

		return {
			start: { line, column },
			end: { line, column: column + text.length },
		}
	}

	// NOTE: From the start of one span to the end of another — the selection a
	// reader drags over several lines.
	function spanFrom(from: string, to: string): common.Position {
		return { start: spanOf(from).start, end: spanOf(to).end }
	}

	describe("findInnermostNodeContaining", () => {
		it("should answer with the smallest Node the range sits inside", () => {
			let node = findInnermostNodeContaining(
				programOf(),
				spanOf('"sign"'),
			)

			expect(node?.nodeType).toBe("StringValue")
			expect(node?.position).toEqual(spanOf('"sign"'))
		})

		// NOTE: The Return the Match is written in covers the very same lines,
		// and the Match is the one inside it.
		it("should answer with the Match a range over its arms sits inside", () => {
			let node = findInnermostNodeContaining(
				programOf(),
				spanFrom("case Integer", "<- label"),
			)

			expect(node?.nodeType).toBe("Match")
		})

		it("should answer with nothing for a range no Node holds", () => {
			expect(
				findInnermostNodeContaining(
					programOf(),
					spanOf("implementation {"),
				),
			).toBeNull()
		})
	})

	describe("enclosingStatementOf", () => {
		it("should answer with the Statement and where in its body it stands", () => {
			let found = enclosingStatementOf(programOf(), spanOf('"sign"'))

			expect(found?.statement.nodeType).toBe(
				"ConstantDeclarationStatement",
			)
			expect(found?.index).toBe(0)
			expect(found?.body).toHaveLength(2)
			expect(found?.body[1]?.nodeType).toBe("ReturnStatement")
		})

		// NOTE: A Handler's body is a body like any other, and the Method body
		// around it holds the range too — the innermost is the one an inserted
		// Statement belongs in.
		it("should answer with the innermost body holding the range", () => {
			let found = enclosingStatementOf(programOf(), spanOf("<- label"))

			expect(found?.statement.nodeType).toBe("ReturnStatement")
			expect(found?.body).toHaveLength(1)
			expect(found?.index).toBe(0)
		})

		it("should answer with the top level Statement a wider range sits in", () => {
			let found = enclosingStatementOf(
				programOf(),
				spanFrom("namespace Sign", "describe()"),
			)

			expect(found?.statement.nodeType).toBe(
				"NamespaceDefinitionStatement",
			)
			expect(found?.body).toHaveLength(1)
			expect(found?.index).toBe(0)
		})

		it("should answer with nothing for a range no body holds", () => {
			expect(
				enclosingStatementOf(programOf(), spanOf("implementation {")),
			).toBeNull()
		})
	})
})
