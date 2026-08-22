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
