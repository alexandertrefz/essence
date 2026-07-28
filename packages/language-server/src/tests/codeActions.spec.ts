import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { analyse } from "../analyse"
import { type CodeActionEntry, findCodeActions } from "../codeActions"

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
				"\tconstant inner: Boolean | Nothing = true",
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

			expect(applied(lines, inner)[8]).toBe("\t\t\t\tcase Nothing {}")
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
