import { describe, expect, it } from "bun:test"

import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import { format } from "@essence-lang/formatter"
import type { common, parser } from "@essence-lang/interfaces"

import { analyse } from "../analyse"
import { type CodeActionEntry, findCodeActions } from "../codeActions"
import {
	compareWrittenValueAction,
	matcherBeforeValueAction,
	requireKeywordAction,
} from "../codeActions/assertionFixes"
import { removeDefaultAction } from "../codeActions/defaultFixes"
import {
	inlineDefineValueAction,
	otherwiseArmAction,
	unreachableDefineArmActions,
} from "../codeActions/defineFixes"
import {
	closeStringAction,
	documentationSeparatorAction,
	invalidEscapeActions,
	mixedRationalActions,
	ordinaryCommentAction,
	partialDecimalActions,
} from "../codeActions/literalFixes"
import {
	enclosingStatementOf,
	findInnermostNodeContaining,
} from "../codeActions/lookups"
import {
	implementationHeaderAction,
	moduleSpecifierActions,
	removeSelfImportAction,
	variableToConstantAction,
} from "../codeActions/sectionFixes"
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

// NOTE: The same question asked of a compile that wanted the TESTS, which is
// what a Code Action request is answered from. A `tests { … }` block is dropped
// by a build, so the codes reported inside one — and the stray value comment,
// which only a test compile has anything to answer — are absent from the
// analysis above and an assertion against it would hold for the wrong reason.
function testCodesOf(lines: Array<string>): Array<common.DiagnosticCode> {
	return analyse(lines.join("\n"), undefined, { tests: true }).map(
		(diagnostic) => diagnostic.code,
	)
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

// NOTE: The honesty check a generator gets, over and above the Diagnostics: a
// fix that SYNTHESIZES code has to write code, and the Formatter is the one
// reader that refuses outright anything it can not read back as a whole
// Program. Null is "nothing to say about it", which is what every applied
// generator below has to leave behind.
function refusalOf(lines: Array<string>): unknown {
	return format(lines.join("\n")).refusal
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

// NOTE: The URI a refactoring needs to hand its rename command a document. Any
// path with no import or export block beside it is analysed on its own, which is
// what every fixture here is.
const DOCUMENT = "file:///repo/Sample.es"

// NOTE: The refactorings of one kind, offered on a range and against a document
// — a Code Action that ends by opening rename has a URI to name, and the
// helpers above deliberately hand none over.
function refactorsOf(
	lines: Array<string>,
	range: common.Position,
	kind: CodeActionEntry["kind"],
): Array<CodeActionEntry> {
	return findCodeActions(lines.join("\n"), range, DOCUMENT).filter(
		(entry) => entry.kind === kind,
	)
}

// NOTE: A range spelled as the text it covers, so a fixture gaining a line
// takes no assertion with it. The first line holding the text answers, which is
// what every fixture below is written to make unambiguous.
function rangeOf(lines: Array<string>, text: string): common.Position {
	let line = lines.findIndex((candidate) => candidate.includes(text)) + 1
	let column = (lines[line - 1] as string).indexOf(text) + 1

	return {
		start: { line, column },
		end: { line, column: column + text.length },
	}
}

// NOTE: From the start of one span to the end of another — the selection a
// reader drags over several lines.
function rangeFrom(
	lines: Array<string>,
	from: string,
	to: string,
): common.Position {
	return { start: rangeOf(lines, from).start, end: rangeOf(lines, to).end }
}

// NOTE: What the Compiler makes of the buffer a refactoring produced, with the
// tests section enriched — `findCodeActions` reads a file that way, so a
// refactoring inside a `tests { … }` block has to be measured against the same
// reading.
function refactoredCodesOf(lines: Array<string>): Array<common.DiagnosticCode> {
	return analyse(lines.join("\n"), undefined, { tests: true }).map(
		(diagnostic) => diagnostic.code,
	)
}

// NOTE: The three things every refactoring here promises. The fixture compiles
// to begin with — a refactoring is offered on code the Compiler has nothing to
// say about, and one measured against a fixture with a mistake in it would be
// measured against the wrong baseline. What it produces compiles too, which is
// the whole of what makes it a refactoring rather than an edit: a quick fix
// answers a Diagnostic and may leave a hole behind, and this may not. And the
// Formatter accepts the result, because source the Formatter refuses is source
// nobody can go on editing.
function expectRefactored(before: Array<string>, after: Array<string>) {
	expect(refactoredCodesOf(before)).toEqual([])
	expect(refactoredCodesOf(after)).toEqual([])
	expect(format(after.join("\n")).refusal).toBeNull()
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

		// NOTE: The prefixed Matcher resolves through a path of its own, and it
		// underlines the NAME rather than the whole Matcher for exactly this
		// reason: the fix writes the suggestion over what is underlined, and
		// the prefix the reader wrote stays where it is.
		it("should suggest a Case for a prefixed Matcher", () => {
			let lines = [
				"implementation {",
				"\tchoice Stride { Walk, Walks }",
				"\tconstant taken: Stride = Stride#Walk",
				"\tconstant described = match taken -> String {",
				'\t\tcase Stride#Walk { <- "walk" }',
				"\t\tcase _ {",
				"\t\t\t<- match @ -> String {",
				'\t\t\t\tcase Stride#Walk { <- "again" }',
				'\t\t\t\tcase _ { <- "other" }',
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = unknownCaseFixes(lines)

			expect(fix.title).toBe("Change to '#Walks'")
			expect(applied(lines, fix)[7]).toBe(
				'\t\t\t\tcase Stride#Walks { <- "again" }',
			)
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

	describe("redundant-pattern-binder", () => {
		// NOTE: A dropped binder leaves every read of its name unresolved, so
		// the arm reports an `unknown-name` beside it and the fix under test has
		// to be picked out by its code rather than taken as the first offered.
		function binderFixes(lines: Array<string>): Array<CodeActionEntry> {
			return quickFixes(lines).filter(
				(entry) => entry.diagnosticCode === "redundant-pattern-binder",
			)
		}

		const MATCHED = [
			"implementation {",
			"\ttype Point = { x: Integer, y: Integer }",
			"\tconstant p: Point | String = { x = 1, y = 2 }",
			"",
		]

		// NOTE: The binder goes and every read of it becomes `@`, which names
		// the very same value — the Help applied, and the Program compiles.
		it("should write '@' where the binder was read", () => {
			let lines = [
				...MATCHED,
				"\tconstant found = match p -> Integer {",
				"\t\tcase { x, y } as point { <- point.x }",
				"\t\tcase String { <- 0 }",
				"\t}",
				"}",
			]

			let [fix] = binderFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Use '@' instead of 'point'")
			expect(fix.isPreferred).toBe(true)
			expect(result[5]).toBe("\t\tcase { x, y } { <- @.x }")

			expect(codesOf(result)).toEqual([])
		})

		it("should rewrite every read in the arm", () => {
			let lines = [
				...MATCHED,
				"\tconstant found = match p -> Integer {",
				"\t\tcase { x, y } as point {",
				"\t\t\tconstant across = point.x",
				"\t\t\t<- across::add(point.y)",
				"\t\t}",
				"",
				"\t\tcase String { <- 0 }",
				"\t}",
				"}",
			]

			let result = applied(lines, binderFixes(lines)[0])

			expect(result.slice(5, 9)).toEqual([
				"\t\tcase { x, y } {",
				"\t\t\tconstant across = @.x",
				"\t\t\t<- across::add(@.y)",
				"\t\t}",
			])

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A binder on a line of its own takes the line break and the
		// indentation with it, or what is left behind is a line of trailing
		// whitespace.
		it("should take the whole line a binder stands alone on", () => {
			let lines = [
				...MATCHED,
				"\tconstant found = match p -> Integer {",
				"\t\tcase { x, y }",
				"\t\t\tas point",
				"\t\t{",
				"\t\t\t<- point.x",
				"\t\t}",
				"",
				"\t\tcase String { <- 0 }",
				"\t}",
				"}",
			]

			let result = applied(lines, binderFixes(lines)[0])

			expect(result.slice(5, 9)).toEqual([
				"\t\tcase { x, y }",
				"\t\t{",
				"\t\t\t<- @.x",
				"\t\t}",
			])

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A nested Match rebinds `@` to ITS scrutinee, so a read in one of
		// its arms would be rewritten into a different value. The whole action
		// is turned away rather than applied to the reads around it: an arm half
		// in one spelling and half in the other is worse than none.
		it("should offer nothing for a read under a nested Match", () => {
			let lines = [
				...MATCHED,
				"\tconstant found = match p -> Integer {",
				"\t\tcase { x, y } as point {",
				"\t\t\t<- match p -> Integer {",
				"\t\t\t\tcase String { <- point.x }",
				"\t\t\t\tcase _ { <- 0 }",
				"\t\t\t}",
				"\t\t}",
				"",
				"\t\tcase String { <- 0 }",
				"\t}",
				"}",
			]

			expect(binderFixes(lines)).toEqual([])
		})

		// NOTE: And a Declaration in the body spelling the same name means the
		// reads after it are that Declaration's, not the binder's.
		it("should offer nothing where the body declares the name", () => {
			let lines = [
				...MATCHED,
				"\tconstant found = match p -> Integer {",
				"\t\tcase { x, y } as point {",
				"\t\t\tconstant point = 9",
				"\t\t\t<- point",
				"\t\t}",
				"",
				"\t\tcase String { <- 0 }",
				"\t}",
				"}",
			]

			expect(binderFixes(lines)).toEqual([])
		})

		// NOTE: A Match the arm is written ON still reads the arm's `@`, so the
		// scrutinee of a nested Match is rewritten like any other read.
		it("should rewrite a nested Match's own scrutinee", () => {
			let lines = [
				"implementation {",
				"\ttype Tagged = { tag: Integer | String }",
				"\tconstant t: Tagged | Boolean = { tag = 1 }",
				"",
				"\tconstant found = match t -> Integer {",
				"\t\tcase { tag } as holder {",
				"\t\t\t<- match holder.tag -> Integer {",
				"\t\t\t\tcase Integer { <- @ }",
				"\t\t\t\tcase String { <- 0 }",
				"\t\t\t}",
				"\t\t}",
				"",
				"\t\tcase Boolean { <- 0 }",
				"\t}",
				"}",
			]

			let result = applied(lines, binderFixes(lines)[0])

			expect(result[5]).toBe("\t\tcase { tag } {")
			expect(result[6]).toBe("\t\t\t<- match @.tag -> Integer {")

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
	describe("ambiguous-case", () => {
		// NOTE: Two Choices of the Program's own, so both actions leave a
		// Program that compiles — the builtin `Optional` and `Result` are
		// generic and would leave `undecided-type-arguments` behind, which the
		// test below is about.
		const TWO_CHOICES = [
			"implementation {",
			"\tchoice Colour { Red, Blue }",
			"\tchoice Shade { Red, Dark }",
			"",
			"\tconstant red = #Red",
			"}",
		]

		it("should offer one prefix per declaring Choice", () => {
			let fixes = quickFixes(TWO_CHOICES)

			expect(titles(fixes)).toEqual([
				"Prefix with 'Colour#'",
				"Prefix with 'Shade#'",
			])
			expect(fixes.map((entry) => entry.isPreferred)).toEqual([
				false,
				false,
			])
		})

		// NOTE: The Diagnostic underlines the name and stops short of the `#`,
		// so the Choice is written in FRONT of a sigil that is already there —
		// the Case's own spelling is never retyped.
		it("should write the Choice in front of the sigil", () => {
			let [fix] = quickFixes(TWO_CHOICES)
			let result = applied(TWO_CHOICES, fix)

			expect(result[4]).toBe("\tconstant red = Colour#Red")

			expect(codesOf(result)).toEqual([])
		})

		it("should write the second Choice for the second action", () => {
			let result = applied(TWO_CHOICES, quickFixes(TWO_CHOICES)[1])

			expect(result[4]).toBe("\tconstant red = Shade#Red")

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A generic Choice's Type Arguments are the reader's to write —
		// an ellipsis is no spelling, and picking Arguments is a second
		// decision. The prefix settles the ambiguity and what is left points at
		// where the Arguments go, which is exactly what the Helps say.
		it("should leave a generic Choice's Type Arguments to the reader", () => {
			let lines = [
				"implementation {",
				"\tchoice Box<ItemType> { Value { item: ItemType }, Blank }",
				"",
				"\tconstant boxed = #Value(1)",
				"}",
			]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Prefix with 'Optional#'",
				"Prefix with 'Result#'",
				"Prefix with 'Box#'",
			])

			let result = applied(lines, fixes[2])

			expect(result[3]).toBe("\tconstant boxed = Box#Value(1)")

			expect(codesOf(result)).toEqual(["undecided-type-arguments"])
		})
	})

	describe("ambiguous-namespace", () => {
		// NOTE: A Namespace of the Program's own tying with a Method
		// `Orderable` provides — two candidates, and which of them was meant is
		// exactly what the Diagnostic could not decide. So one action each, in
		// the order the notes named them, and neither of them preferred.
		const TIED = [
			"implementation {",
			"\tnamespace Extras for Integer {",
			"\t\tisBetween(_ lower: Integer, and upper: Integer) -> Boolean {",
			"\t\t\t<- false",
			"\t\t}",
			"\t}",
			"",
			"\tconstant inside = 5::isBetween(1, and 9)",
			"}",
		]

		it("should offer one specifier per candidate", () => {
			let fixes = quickFixes(TIED)

			expect(titles(fixes)).toEqual([
				"Write '::<Extras>' at the call",
				"Write '::<Orderable>' at the call",
			])
			expect(fixes.map((entry) => entry.isPreferred)).toEqual([
				false,
				false,
			])
		})

		it("should write the specifier between the '::' and the name", () => {
			let [fix] = quickFixes(TIED)
			let result = applied(TIED, fix)

			expect(result[7]).toBe(
				"\tconstant inside = 5::<Extras>isBetween(1, and 9)",
			)

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: The Protocol that PROVIDES the Method is what the specifier
		// writes — `5::<Integer>isBetween(…)` names a Namespace that declares
		// no such Method, and the second action would be the first one's edit
		// spelled a second wrong way.
		it("should name the providing Protocol for a provided Method", () => {
			let result = applied(TIED, quickFixes(TIED)[1])

			expect(result[7]).toBe(
				"\tconstant inside = 5::<Orderable>isBetween(1, and 9)",
			)

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A receiver on a line of its own puts the `::` on the next one,
		// which is why the specifier is written in front of the NAME rather
		// than measured off the `::`.
		it("should write it over a call broken across lines", () => {
			let lines = [
				"implementation {",
				"\tnamespace Extras for Integer {",
				"\t\tisBetween(_ lower: Integer, and upper: Integer) -> Boolean {",
				"\t\t\t<- false",
				"\t\t}",
				"\t}",
				"",
				"\tconstant inside = 5",
				"\t\t::isBetween(1, and 9)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result[8]).toBe("\t\t::<Extras>isBetween(1, and 9)")

			expect(codesOf(result)).toEqual([])
		})
	})

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

	describe("argument-label-mismatch", () => {
		const SHOUT = [
			"implementation {",
			"\tfunction shout(about topic: String) -> String {",
			"\t\t<- topic",
			"\t}",
			"",
		]

		// NOTE: The Parameter declares a label the call never wrote, so the
		// label is written in — the value itself is never retyped.
		it("should write a label the call left out", () => {
			let lines = [...SHOUT, '\tconstant said = shout("hi")', "}"]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Write 'about' before the value")
			expect(fix.isPreferred).toBe(true)
			expect(result[5]).toBe('\tconstant said = shout(about "hi")')

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A label was written and it is the wrong one, so the word alone
		// is replaced — read backwards out of the buffer, because an Argument
		// is no Node of its own and the label has no Position to read off.
		it("should change a label the Parameter does not declare", () => {
			let lines = [
				...SHOUT,
				'\tconstant said = shout(regarding "hi")',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Change the label to 'about'")
			expect(result[5]).toBe('\tconstant said = shout(about "hi")')

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: And a Parameter that takes none has the written label taken
		// away, together with the space that separated it from the value.
		it("should remove a label the Parameter takes none of", () => {
			let lines = [
				"implementation {",
				"\tfunction shout(_ topic: String) -> String {",
				"\t\t<- topic",
				"\t}",
				"",
				'\tconstant said = shout(about "hi")',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove the label")
			expect(result[5]).toBe('\tconstant said = shout("hi")')

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A label written on a line of its own is found all the same —
		// what is walked back over is whitespace, line breaks included.
		it("should find a label written above its value", () => {
			let lines = [
				...SHOUT,
				"\tconstant said = shout(",
				"\t\tregarding",
				'\t\t\t"hi",',
				"\t)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result[6]).toBe("\t\tabout")

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A Comment between the label and the value means the span in
		// front of the value is not the label, and nothing is offered rather
		// than a rewrite of text nobody read back.
		it("should offer nothing when the label is not what stands there", () => {
			let lines = [
				...SHOUT,
				'\tconstant said = shout(regarding §note§ "hi")',
				"}",
			]

			expect(quickFixes(lines)).toEqual([])
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

	describe("incomplete-record-argument", () => {
		const CONNECT = [
			"implementation {",
			"\ttype Options = { host: String, port: Integer, retries: Integer }",
			"",
			"\tfunction connect(using options: Options = { retries = 3 }) -> Integer {",
			"\t\t<- options.port",
			"\t}",
			"",
		]

		// NOTE: `{}` is the hole, and the Argument stays refused until it is
		// filled — which is why the action is not preferred. `argument-type-
		// mismatch` is what the reader is left with, and it is what the unit
		// Type standing where a String and an Integer belong deserves.
		it("should write the missing members beside the ones written", () => {
			let lines = [
				...CONNECT,
				"\tconstant opened = connect(using { retries = 1 })",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Write the missing members")
			expect(fix.isPreferred).toBe(false)
			expect(result[7]).toBe(
				"\tconstant opened = connect(using { retries = 1, host = {}, port = {} })",
			)

			expect(codesOf(result)).toEqual(["argument-type-mismatch"])
		})

		// NOTE: An empty Literal has no member to write a comma after, and the
		// padding a one-line Literal is written with is what the fix writes
		// back.
		it("should pad an empty Literal it fills in", () => {
			let lines = [
				...CONNECT,
				"\tconstant opened = connect(using {})",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[7]).toBe(
				"\tconstant opened = connect(using { host = {}, port = {} })",
			)
		})

		// NOTE: A Literal written over lines takes a line per member, indented
		// as the members already there are — the layout the reader chose is
		// what the fix goes on writing in.
		it("should take a line per member in a Literal broken over lines", () => {
			let lines = [
				...CONNECT,
				"\tconstant opened = connect(using {",
				"\t\tretries = 1,",
				"\t})",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result.slice(7, 12)).toEqual([
				"\tconstant opened = connect(using {",
				"\t\tretries = 1,",
				"\t\thost = {},",
				"\t\tport = {},",
				"\t})",
			])

			expect(codesOf(result)).toEqual(["argument-type-mismatch"])
		})

		// NOTE: And one whose last member carries no trailing comma is given
		// the one it needs before anything is written after it.
		it("should write the comma a last member never had", () => {
			let lines = [
				...CONNECT,
				"\tconstant opened = connect(using {",
				"\t\tretries = 1",
				"\t})",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[8]).toBe("\t\tretries = 1,")
			expect(result[9]).toBe("\t\thost = {},")
		})

		// NOTE: A Case's payload is a Record Literal measured against a default
		// exactly as an Argument is, and it takes the same scaffold.
		it("should scaffold a Case payload the same way", () => {
			let lines = [
				"implementation {",
				"\tchoice Shape {",
				'\t\tRect { width: Integer, height: Integer, label: String } = { label = "r" },',
				"\t}",
				"",
				"\tconstant boxed = Shape#Rect({ width = 1 })",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Write the missing member 'height'")
			expect(result[5]).toBe(
				"\tconstant boxed = Shape#Rect({ width = 1, height = {} })",
			)

			expect(codesOf(result)).toEqual(["payload-type-mismatch"])
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

	describe("unreachable-define-arm", () => {
		let ladder = [
			"implementation {",
			"\tconstant flag = true",
			"\tconstant other = false",
			"\tconstant grade = define {",
			"\t\tas 1 if flag",
			"\t\tas 0 otherwise",
			"\t\tas 2 if other",
			"\t}",
			"}",
		]

		it("should delete the arm, and offer to move it above the otherwise arm", () => {
			let fixes = quickFixes(ladder)

			expect(titles(fixes)).toEqual([
				"Remove the arm",
				"Move the arm above the 'otherwise' arm",
			])

			expect(fixes[0].isPreferred).toBe(true)
			expect(fixes[1].isPreferred).toBe(false)

			let removed = applied(ladder, fixes[0])

			expect(removed).toEqual([
				"implementation {",
				"\tconstant flag = true",
				"\tconstant other = false",
				"\tconstant grade = define {",
				"\t\tas 1 if flag",
				"\t\tas 0 otherwise",
				"\t}",
				"}",
			])

			expect(codesOf(removed)).not.toContain("unreachable-define-arm")

			let moved = applied(ladder, fixes[1])

			expect(moved).toEqual([
				"implementation {",
				"\tconstant flag = true",
				"\tconstant other = false",
				"\tconstant grade = define {",
				"\t\tas 1 if flag",
				"\t\tas 2 if other",
				"\t\tas 0 otherwise",
				"\t}",
				"}",
			])

			expect(codesOf(moved)).not.toContain("unreachable-define-arm")
		})

		// NOTE: The move writes whole lines, and a `define` on one line has no
		// line above its `otherwise` arm to write into.
		it("should offer the deletion alone for a define written on one line", () => {
			let lines = [
				"implementation {",
				"\tconstant flag = true",
				"\tconstant grade = define { as 1 if flag as 0 otherwise as 2 if flag }",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual(["Remove the arm"])
		})

		it("should stay silent where the span no longer opens with 'as'", () => {
			let { program } = parseWithDiagnostics(ladder.join("\n"))

			expect(
				unreachableDefineArmActions(
					staleDiagnostic(
						"unreachable-define-arm",
						spanOf(ladder, 5, "1 if flag"),
					),
					program,
					ladder,
				),
			).toEqual([])
		})
	})

	describe("define-without-cases", () => {
		it("should write the otherwise value in place of the define", () => {
			let lines = [
				"implementation {",
				"\tconstant grade = define {",
				"\t\tas 1 otherwise",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Write the value on its own")
			expect(fix.diagnosticCode).toBe("define-without-cases")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result).toEqual([
				"implementation {",
				"\tconstant grade = 1",
				"}",
			])

			expect(codesOf(result)).not.toContain("define-without-cases")
		})

		it("should stay silent where no define stands at the span", () => {
			let lines = ["implementation {", "\tconstant grade = 1", "}"]
			let { program } = parseWithDiagnostics(lines.join("\n"))

			expect(
				inlineDefineValueAction(
					staleDiagnostic(
						"define-without-cases",
						spanOf(lines, 2, "1"),
					),
					program,
					lines,
				),
			).toBeNull()
		})
	})

	describe("define-without-otherwise", () => {
		it("should scaffold an empty otherwise arm below the last one", () => {
			let lines = [
				"implementation {",
				"\tconstant flag = true",
				"\tconstant grade = define {",
				"\t\tas 1 if flag",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Add an empty 'otherwise' arm")
			expect(fix.diagnosticCode).toBe("define-without-otherwise")
			expect(fix.isPreferred).toBe(false)

			expect(applied(lines, fix)).toEqual([
				"implementation {",
				"\tconstant flag = true",
				"\tconstant grade = define {",
				"\t\tas 1 if flag",
				"\t\tas  otherwise",
				"\t}",
				"}",
			])
		})

		it("should stay silent where the span no longer reads as a define", () => {
			let lines = ["implementation {", "\tconstant grade = 1", "}"]

			expect(
				otherwiseArmAction(
					staleDiagnostic(
						"define-without-otherwise",
						spanOf(lines, 2, "grade = 1"),
					),
					lines,
				),
			).toBeNull()
		})
	})

	describe("declarations-outside-stdlib", () => {
		it("should swap the keyword for 'implementation'", () => {
			let lines = ["declarations {", "\tconstant one = 1", "}"]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Open the Program with 'implementation'")
			expect(fix.diagnosticCode).toBe("declarations-outside-stdlib")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result).toEqual([
				"implementation {",
				"\tconstant one = 1",
				"}",
			])

			expect(codesOf(result)).toEqual([])
		})

		it("should stay silent where the span no longer reads the keyword", () => {
			let lines = ["implementation {", "\tconstant one = 1", "}"]

			expect(
				implementationHeaderAction(
					staleDiagnostic(
						"declarations-outside-stdlib",
						spanOf(lines, 1, "implementation"),
					),
					lines,
				),
			).toBeNull()
		})
	})

	describe("assertions written in a shape the language has not", () => {
		function inTest(...body: Array<string>): Array<string> {
			return [
				"implementation {",
				"}",
				"",
				"tests {",
				'\ttest "a" {',
				...body,
				"\t}",
				"}",
			]
		}

		it("should write an 'expect' that takes a value apart as a 'require'", () => {
			let lines = inTest(
				"\t\tconstant value = 3",
				"\t\texpect Integer = value",
			)

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Take the value apart with 'require'")
			expect(fix.diagnosticCode).toBe("matcher-on-expect")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result[6]).toBe("\t\trequire Integer = value")
			expect(testCodesOf(result)).not.toContain("matcher-on-expect")
		})

		it("should write a Matcher behind the value in front of it", () => {
			let lines = inTest(
				"\t\tconstant value = 3",
				"\t\texpect value is Integer",
			)

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Take the value apart with 'require'")
			expect(fix.diagnosticCode).toBe("matcher-after-value")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result[6]).toBe("\t\trequire Integer = value")
			expect(testCodesOf(result)).not.toContain("matcher-after-value")
		})

		it("should compare a written value rather than take it apart", () => {
			let lines = inTest(
				"\t\tconstant value = 3",
				"\t\trequire 3 = value",
			)

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Compare it instead: 'value::is(3)'")
			expect(fix.diagnosticCode).toBe("literal-in-require")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result[6]).toBe("\t\trequire value::is(3)")
			expect(testCodesOf(result)).not.toContain("literal-in-require")
		})

		// NOTE: A backwards search finds the LAST keyword before the cursor, so
		// the one that matters is the one with nothing but indentation in front
		// of it.
		it("should stay silent where no keyword opens the line", () => {
			let lines = ["implementation {", "\tconstant value = 3", "}"]

			expect(
				requireKeywordAction(
					staleDiagnostic("matcher-on-expect", spanOf(lines, 2, "3")),
					lines,
				),
			).toBeNull()

			expect(
				matcherBeforeValueAction(
					staleDiagnostic(
						"matcher-after-value",
						spanOf(lines, 2, "value = 3"),
					),
					lines,
				),
			).toBeNull()
		})

		it("should stay silent where no '=' stands between the two spans", () => {
			let lines = ["implementation {", "\tconstant value = 3", "}"]

			expect(
				compareWrittenValueAction(
					staleDiagnostic(
						"literal-in-require",
						spanOf(lines, 2, "constant"),
						[
							{
								position: spanOf(lines, 2, "value"),
								message: "",
								kind: "secondary",
							},
						],
					),
					lines,
				),
			).toBeNull()
		})
	})

	describe("value-comment-outside-tests", () => {
		it("should write the sigil of an ordinary Comment", () => {
			let lines = ["implementation {", "\tconstant one = 1 §? what", "}"]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Write an ordinary '§' Comment")
			expect(fix.diagnosticCode).toBe("value-comment-outside-tests")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result[1]).toBe("\tconstant one = 1 § what")
			expect(testCodesOf(result)).not.toContain(
				"value-comment-outside-tests",
			)
		})

		it("should stay silent where the span no longer opens with the sigil", () => {
			let lines = ["implementation {", "\tconstant one = 1 § what", "}"]

			expect(
				ordinaryCommentAction(
					staleDiagnostic(
						"value-comment-outside-tests",
						spanOf(lines, 2, "§ what"),
					),
					lines,
				),
			).toBeNull()
		})
	})

	// NOTE: The Module Diagnostics are reported by the graph, so their fixes are
	// exercised over a real workspace in `workspace.spec.ts`. What is left to ask
	// here is what each of them does with a buffer that has moved on, which
	// needs no graph at all.
	describe("the Module fixes measured against a stale buffer", () => {
		it("should stay silent where no group's specifier stands at the span", () => {
			let lines = [
				"import {",
				'\tfrom "./Other.es" { thing }',
				"}",
				"",
				"implementation {",
				"\tconstant used = thing",
				"}",
			]

			let { program } = parseWithDiagnostics(lines.join("\n"))

			expect(
				removeSelfImportAction(
					staleDiagnostic("self-import", spanOf(lines, 2, "thing")),
					program,
					lines,
				),
			).toBeNull()
		})

		it("should stay silent where the span no longer reads as a specifier", () => {
			let lines = ["import {", "\tfrom ./Other.es { thing }", "}"]

			expect(
				moduleSpecifierActions(
					staleDiagnostic(
						"invalid-module-specifier",
						spanOf(lines, 2, "./Other.es"),
					),
					lines,
				),
			).toEqual([])
		})

		it("should stay silent where the Declaration is no longer a Variable", () => {
			let lines = [
				"implementation {",
				"\tconstant counter = 1",
				"}",
				"",
				"export {",
				"\tcounter",
				"}",
			]

			let { program } = parseWithDiagnostics(lines.join("\n"))

			expect(
				variableToConstantAction(
					staleDiagnostic(
						"export-of-variable",
						spanOf(lines, 6, "counter"),
						[
							{
								position: spanOf(lines, 2, "counter"),
								message: "declared here",
								kind: "secondary",
							},
						],
					),
					program,
					lines,
				),
			).toBeNull()
		})
	})

	describe("infer-on-applied-parameter", () => {
		it("should take the marker off and leave the Parameter", () => {
			let lines = [
				"implementation {",
				"\tchoice Holder<infer Item> { Bare }",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove 'infer'")
			expect(fix.isPreferred).toBe(true)
			expect(result[1]).toBe("\tchoice Holder<Item> { Bare }")

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: The Diagnostic spans the whole Type Parameter, bound and all,
		// and only the Keyword in front of it is the mistake.
		it("should keep a bound the Parameter carries", () => {
			let lines = [
				"implementation {",
				"\ttype Pair<infer Item is Comparable> = { left: Item, right: Item }",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result[1]).toBe(
				"\ttype Pair<Item is Comparable> = { left: Item, right: Item }",
			)

			expect(codesOf(result)).toEqual([])
		})
	})

	describe("uninferred-namespace-parameter", () => {
		it("should write the marker in front of the Parameter", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<Item> for { value: Integer } {",
				"\t\tget () -> Integer { <- @.value }",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Declare it as 'infer Item'")
			expect(fix.isPreferred).toBe(true)
			expect(result[1]).toBe(
				"\tnamespace Boxes<infer Item> for { value: Integer } {",
			)

			expect(codesOf(result)).toEqual([])
		})
	})

	describe("at-in-static-method", () => {
		it("should drop the Keyword in front of the Method's name", () => {
			let lines = [
				"implementation {",
				"\tnamespace Counters for { count: Integer } {",
				"\t\tstatic doubled () -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Drop 'static'")
			// NOTE: The other reading is to take the value as a Parameter,
			// which is a change to the Signature and to every call — so an
			// Editor must not apply this one without being asked.
			expect(fix.isPreferred).toBe(false)
			expect(result[2]).toBe("\t\tdoubled () -> Integer {")

			expect(codesOf(result)).toEqual([])
		})

		it("should reach a Method inside an overload block", () => {
			let lines = [
				"implementation {",
				"\tnamespace Counters for { count: Integer } {",
				"\t\toverload static made {",
				"\t\t\t() -> Integer { <- @.count }",
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)[2]).toBe("\t\toverload made {")
		})

		// NOTE: `keywordBefore` looks along the name's own line, so a Keyword
		// the Parser read from the line above is one this refuses to touch —
		// deleting a span that does not read `static ` would eat whatever does
		// stand there.
		it("should stay silent where the Keyword opens a line of its own", () => {
			let lines = [
				"implementation {",
				"\tnamespace Counters for { count: Integer } {",
				"\t\tstatic",
				"\t\tdoubled () -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
		})
	})

	describe("where-on-protocol-extension", () => {
		it("should take the whole clause off the extension", () => {
			let lines = [
				"implementation {",
				"\tprotocol Sizeable is Equatable where Item is Comparable {",
				"\t\tsize () -> Integer",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Drop the 'where' clause")
			expect(fix.isPreferred).toBe(true)
			expect(result[1]).toBe("\tprotocol Sizeable is Equatable {")

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: One Diagnostic per condition, and one edit that answers all of
		// them — a clause with one condition left is the same refusal, so there
		// is nothing to take out but the clause.
		it("should answer every condition of the clause with the same edit", () => {
			let lines = [
				"implementation {",
				"\tprotocol Sizeable is Equatable where Item is Comparable, Key is Equatable {",
				"\t\tsize () -> Integer",
				"\t}",
				"}",
			]

			let fixes = quickFixes(lines)
			let result = applied(lines, fixes[1])

			expect(fixes.length).toBe(2)
			expect(result[1]).toBe("\tprotocol Sizeable is Equatable {")

			expect(codesOf(result)).toEqual([])
		})
	})

	describe("unexpected-payload", () => {
		it("should take the payload and its brackets off the Case", () => {
			let lines = [
				"implementation {",
				"\tchoice Signal { Red, Green }",
				"\tconstant chosen = Signal#Red(1)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Write '#Red' on its own")
			expect(fix.isPreferred).toBe(true)
			expect(result[2]).toBe("\tconstant chosen = Signal#Red")

			expect(codesOf(result)).toEqual([])
		})

		it("should carry a payload written over several lines", () => {
			let lines = [
				"implementation {",
				"\tchoice Signal { Red, Green }",
				"\tconstant chosen = #Red({",
				"\t\tbrightness = 1,",
				"\t})",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)).toEqual([
				"implementation {",
				"\tchoice Signal { Red, Green }",
				"\tconstant chosen = #Red",
				"}",
			])
		})
	})

	describe("duplicate-key", () => {
		it("should remove the entry and the comma in front of it", () => {
			let lines = [
				"implementation {",
				'\tconstant ages = ["alex" = 39, "alex" = 40]',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove this entry")
			expect(fix.isPreferred).toBe(true)
			expect(result[1]).toBe('\tconstant ages = ["alex" = 39]')

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: An update's key list is one bracket list on the same terms, and
		// the walk reaches it because both spellings build one Node kind.
		it("should reach the key list of an update", () => {
			let lines = [
				"implementation {",
				'\tconstant ages = ["alex" = 39]',
				'\tconstant updated = [ages with "sam" = 25, "sam" = 26]',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result[2]).toBe(
				'\tconstant updated = [ages with "sam" = 25]',
			)

			expect(codesOf(result)).toEqual([])
		})

		it("should leave the line the entry stood on empty", () => {
			let lines = [
				"implementation {",
				"\tconstant ages = [",
				'\t\t"alex" = 39,',
				'\t\t"alex" = 40,',
				"\t]",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)).toEqual([
				"implementation {",
				"\tconstant ages = [",
				'\t\t"alex" = 39,',
				"\t]",
				"}",
			])
		})
	})

	describe("literal-match-shape", () => {
		it("should write a 'case _' before the Match's closing brace", () => {
			let lines = [
				"implementation {",
				"\tconstant n = 3",
				"\tconstant described = match n -> String {",
				'\t\tcase 0 { <- "zero" }',
				'\t\tcase 1 { <- "one" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Add a 'case _' for the rest of the values")
			// NOTE: The arm it writes is empty, so the `missing-return` behind
			// it is the reader's to fill in — a hole that is visible rather
			// than a Match that answers for nothing.
			expect(fix.isPreferred).toBe(false)

			expect(result).toEqual([
				"implementation {",
				"\tconstant n = 3",
				"\tconstant described = match n -> String {",
				'\t\tcase 0 { <- "zero" }',
				'\t\tcase 1 { <- "one" }',
				"\t\tcase _ {}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("literal-match-shape")
		})

		it("should take a Guard off a Case that names a value", () => {
			let lines = [
				"implementation {",
				"\tconstant n = 3",
				"\tconstant described = match n -> String {",
				'\t\tcase 0 where true { <- "zero" }',
				'\t\tcase _ { <- "more" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Drop the Guard")
			expect(fix.isPreferred).toBe(false)
			expect(result[3]).toBe('\t\tcase 0 { <- "zero" }')

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: Two of the four sites report at a Handler's Matcher, and the
		// primary Label is the whole of what tells them apart — a Guard's fix
		// applied to a Case whose problem is that it names no value would take
		// a Guard off something else entirely.
		it("should offer nothing for a Case that names no value", () => {
			let lines = [
				"implementation {",
				"\tconstant n = 3",
				"\tconstant described = match n -> String {",
				'\t\tcase Integer where true { <- "number" }',
				'\t\tcase 0 { <- "zero" }',
				'\t\tcase _ { <- "more" }',
				"\t}",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
		})
	})

	describe("empty-list-overlap", () => {
		it("should guard the Case that runs first", () => {
			let lines = [
				"implementation {",
				"\tconstant value: List<String> | List<Integer> = [1]",
				"\tconstant described = match value -> String {",
				'\t\tcase List<String> { <- "strings" }',
				'\t\tcase List<Integer> { <- "integers" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Guard it with 'where @::hasItems()'")
			// NOTE: The empty List the Cases stop answering for wants a Case of
			// its own, and that Case is the reader's to write — which is why
			// the `missing-case` below is expected rather than a regression.
			expect(fix.isPreferred).toBe(false)
			expect(result[3]).toBe(
				'\t\tcase List<String> where @::hasItems() { <- "strings" }',
			)

			expect(codesOf(result)).not.toContain("empty-list-overlap")
		})

		// NOTE: The dispatch branches of a Method Invocation report the same
		// Warning, and its secondary Label points at the receiver rather than
		// at a Matcher. There is no arm to edit, and the lookup answering
		// nothing is what says so.
		it("should offer nothing where the branches are a dispatch", () => {
			let lines = [
				"implementation {",
				"\tnamespace Firsts for List<String> {",
				'\t\tdescribe () -> String { <- "strings" }',
				"\t}",
				"\tnamespace Seconds for List<Integer> {",
				'\t\tdescribe () -> String { <- "integers" }',
				"\t}",
				"\tconstant value: List<String> | List<Integer> = [1]",
				"\tconstant described = value::describe()",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
		})
	})

	describe("empty-dictionary-overlap", () => {
		it("should ask the Dictionary's own question", () => {
			let lines = [
				"implementation {",
				'\tconstant value: Dictionary<String, Integer> | Dictionary<Integer, String> = ["a" = 1]',
				"\tconstant described = match value -> String {",
				'\t\tcase Dictionary<String, Integer> { <- "one" }',
				'\t\tcase Dictionary<Integer, String> { <- "two" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Guard it with 'where @::hasEntries()'")
			expect(result[3]).toBe(
				'\t\tcase Dictionary<String, Integer> where @::hasEntries() { <- "one" }',
			)

			expect(codesOf(result)).not.toContain("empty-dictionary-overlap")
		})
	})

	describe("unknown-modifier", () => {
		it("should remove the word and the space in front of it", () => {
			let lines = [
				"implementation {",
				"}",
				"tests {",
				'\ttest "ranks the table" slowly {}',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove 'slowly'")
			expect(fix.isPreferred).toBe(true)
			expect(result[3]).toBe('\ttest "ranks the table" {}')

			expect(testCodesOf(result)).toEqual([])
		})

		// NOTE: A literal always belongs to the Modifier in front of it, so the
		// word deleted on its own would leave a `3` that opens nothing.
		it("should take the arguments the Modifier was read with", () => {
			let lines = [
				"implementation {",
				"}",
				"tests {",
				'\ttest "ranks the table" retries 3 {}',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove 'retries'")
			expect(result[3]).toBe('\ttest "ranks the table" {}')

			expect(testCodesOf(result)).toEqual([])
		})

		// NOTE: The Enricher regroups what the Parser read before it reports —
		// `tagged slow focussed` is read as `tagged` and `slow(focussed)`, and
		// the typo it reports about is an ARGUMENT in the tree. So the fix finds
		// no Modifier and takes the word alone, which is what `tagged slow`
		// needs. The near miss also puts a spelling above the removal, and the
		// removal stops being the preferred answer.
		it("should offer the spelling above the removal for a near miss", () => {
			let lines = [
				"implementation {",
				"}",
				"tests {",
				'\ttest "ranks the table" tagged slow focussed {}',
				"}",
			]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Change to 'focused'",
				"Remove 'focussed'",
			])

			expect(fixes[1].isPreferred).toBe(false)
			expect(applied(lines, fixes[1])[3]).toBe(
				'\ttest "ranks the table" tagged slow {}',
			)
		})
	})

	describe("contradictory-modifiers", () => {
		// NOTE: Neither is preferred, which is the whole of what the Diagnostic
		// has to say: which of the two was meant is not something the source
		// says, and an Editor applying one unasked would be the guess it refuses
		// to make.
		it("should offer both Modifiers, and neither as the answer", () => {
			let lines = [
				"implementation {",
				"}",
				"tests {",
				'\ttest "ranks the table" focused skipped "flaky" {}',
				"}",
			]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Remove 'skipped'",
				"Remove 'focused'",
			])

			expect(fixes.map((fix) => fix.isPreferred)).toEqual([false, false])
		})

		it("should take the reason String with the skip", () => {
			let lines = [
				"implementation {",
				"}",
				"tests {",
				'\ttest "ranks the table" focused skipped "flaky" {}',
				"}",
			]

			let [skip, focus] = quickFixes(lines)

			expect(applied(lines, skip)[3]).toBe(
				'\ttest "ranks the table" focused {}',
			)

			expect(applied(lines, focus)[3]).toBe(
				'\ttest "ranks the table" skipped "flaky" {}',
			)

			expect(testCodesOf(applied(lines, focus))).toEqual([])
		})
	})

	describe("duplicate-modifier", () => {
		it("should write the second tagged's names onto the first", () => {
			let lines = [
				"implementation {",
				"}",
				"tests {",
				'\ttest "ranks the table" tagged slow tagged network, flaky {}',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Merge into one 'tagged'")
			expect(fix.isPreferred).toBe(true)
			expect(result[3]).toBe(
				'\ttest "ranks the table" tagged slow, network, flaky {}',
			)

			expect(testCodesOf(result)).toEqual([])
		})

		// NOTE: Every other Modifier says ONE thing, so there is nothing to
		// merge. The Enricher already keeps the first, and the edit says so.
		it("should remove the second of a Modifier that carries nothing", () => {
			let lines = [
				"implementation {",
				"}",
				"tests {",
				'\ttest "ranks the table" focused focused {}',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove the second 'focused'")
			expect(fix.isPreferred).toBe(false)
			expect(result[3]).toBe('\ttest "ranks the table" focused {}')

			expect(testCodesOf(result)).toEqual([])
		})
	})

	describe("static-method-on-value", () => {
		const BOXES = [
			"implementation {",
			"\ttype Box = { v: Integer }",
			"",
			"\tnamespace Boxes for Box {",
			"\t\tstatic make(_ v: Integer) -> Box {",
			"\t\t\t<- { v = v }",
			"\t\t}",
			"\t}",
			"",
			"\tconstant boxed: Box = { v = 1 }",
		]

		// NOTE: Two actions and neither preferred — a static takes no receiver,
		// so the value the call was written on either belongs among the
		// Arguments or does not belong at all, and nothing in the Diagnostic
		// says which. Its own Help hedges for the same reason.
		it("should offer the call with the value and without it", () => {
			let lines = [...BOXES, "\tconstant made = boxed::make(2)", "}"]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write 'Boxes.make(…)' passing the value",
				"Write 'Boxes.make(…)' without the value",
			])
			expect(fixes.map((entry) => entry.isPreferred)).toEqual([
				false,
				false,
			])
		})

		it("should pass the value as the first Argument", () => {
			let lines = [...BOXES, "\tconstant made = boxed::make(2)", "}"]

			expect(applied(lines, quickFixes(lines)[0])[10]).toBe(
				"\tconstant made = Boxes.make(boxed, 2)",
			)
		})

		it("should drop the receiver where the static does not take it", () => {
			let lines = [...BOXES, "\tconstant made = boxed::make(2)", "}"]
			let result = applied(lines, quickFixes(lines)[1])

			expect(result[10]).toBe("\tconstant made = Boxes.make(2)")

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A call passing nothing needs no comma written after the value —
		// the closing bracket the call already carries is what closes it.
		it("should write no comma for a call with no Arguments", () => {
			let lines = [
				"implementation {",
				"\ttype Box = { v: Integer }",
				"",
				"\tnamespace Boxes for Box {",
				"\t\tstatic describe(_ b: Box) -> Integer {",
				"\t\t\t<- b.v",
				"\t\t}",
				"\t}",
				"",
				"\tconstant boxed: Box = { v = 1 }",
				"\tconstant said = boxed::describe()",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[10]).toBe("\tconstant said = Boxes.describe(boxed)")

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: The receiver's own text is never retyped — it is the one thing
		// the two edits are written around.
		it("should carry a written receiver across untouched", () => {
			let lines = [...BOXES, "\tconstant made = { v = 9 }::make(2)", "}"]

			expect(applied(lines, quickFixes(lines)[0])[10]).toBe(
				"\tconstant made = Boxes.make({ v = 9 }, 2)",
			)
		})
	})

	describe("unsatisfied-bound", () => {
		const SIZED = [
			"implementation {",
			"\tprotocol Sized {",
			"\t\tsize() -> Integer",
			"\t}",
			"",
			"\tfunction total<infer Item is Sized>(_ items: List<Item>) -> Integer {",
			"\t\t<- 0",
			"\t}",
			"",
		]

		// NOTE: The Diagnostic is reported at the CALL and the edit lands on the
		// declaration around it, found by the name the Compiler carried.
		it("should bound the Type Parameter the call passes", () => {
			let lines = [
				...SIZED,
				"\tfunction wrap<infer Thing>(_ things: List<Thing>) -> Integer {",
				"\t\t<- total(things)",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Declare it as '<infer Thing is Sized>'")
			expect(fix.isPreferred).toBe(true)
			expect(result[9]).toBe(
				"\tfunction wrap<infer Thing is Sized>(_ things: List<Thing>) -> Integer {",
			)

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A Method's own list is a head like any other, and the walk
		// answers with the innermost that declares the name.
		it("should bound a Method's own Type Parameter", () => {
			let lines = [
				...SIZED,
				"\tnamespace Extras for Integer {",
				"\t\tcount<infer Thing>(_ things: List<Thing>) -> Integer {",
				"\t\t\t<- total(things)",
				"\t\t}",
				"\t}",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[10]).toBe(
				"\t\tcount<infer Thing is Sized>(_ things: List<Thing>) -> Integer {",
			)

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: `<infer T is A is P>` is not a spelling, and which of the two
		// bounds a reader meant to keep is not a question a Diagnostic about one
		// of them can answer.
		it("should offer nothing where the Parameter is bound already", () => {
			let lines = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"\t}",
				"",
				"\tprotocol Named {",
				"\t\tname() -> String",
				"\t}",
				"",
				"\tfunction total<infer Item is Sized>(_ items: List<Item>) -> Integer {",
				"\t\t<- 0",
				"\t}",
				"",
				"\tfunction wrap<infer Thing is Named>(_ things: List<Thing>) -> Integer {",
				"\t\t<- total(things)",
				"\t}",
				"}",
			]

			expect(quickFixes(lines)).toEqual([])
		})

		// NOTE: A concrete Type that conforms to nothing is asking for a
		// Namespace, which is a Declaration rather than an edit to a span.
		it("should offer nothing for a concrete Type", () => {
			let lines = [...SIZED, '\tconstant counted = total(["a"])', "}"]

			expect(quickFixes(lines)).toEqual([])
		})
	})

	describe("undeclared-conformance", () => {
		// NOTE: The Diagnostic is reported against the METHOD that gave the
		// Namespace away, and the edit lands on the head above it.
		it("should declare the conformance on the Namespace head", () => {
			let lines = [
				"implementation {",
				"\tchoice Colour { Red, Green }",
				"",
				"\tnamespace Extras for Colour {",
				"\t\tis(_ other: Colour) -> Boolean {",
				"\t\t\t<- true",
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Declare the conformance: 'is Equatable'")
			expect(fix.isPreferred).toBe(true)
			expect(result[3]).toBe(
				"\tnamespace Extras for Colour is Equatable {",
			)

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A conformance list is comma separated, so a head that already
		// declares one takes the new clause after it rather than beside it.
		it("should write it after a conformance already declared", () => {
			let lines = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"\t}",
				"",
				"\tchoice Colour { Red, Green }",
				"",
				"\tnamespace Extras for Colour is Sized {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"",
				"\t\tis(_ other: Colour) -> Boolean {",
				"\t\t\t<- true",
				"\t\t}",
				"\t}",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[7]).toBe(
				"\tnamespace Extras for Colour is Sized, is Equatable {",
			)

			expect(codesOf(result)).toEqual([])
		})
	})

	describe("unknown-where-generic", () => {
		// NOTE: A Type Parameter a Namespace never declared is `unknown-type`
		// in its target Type as well, so the fix under test is picked out by
		// its code rather than taken as the first offered.
		function parameterFixes(lines: Array<string>): Array<CodeActionEntry> {
			return quickFixes(lines).filter(
				(entry) => entry.diagnosticCode === "unknown-where-generic",
			)
		}

		const BOXES = [
			"implementation {",
			"\tprotocol Sized {",
			"\t\tsize() -> Integer",
			"\t}",
			"",
			"\ttype Box<Item> = { item: Item }",
			"",
		]

		// NOTE: The shape this is nearly always written by hand — a target Type
		// naming a Parameter the Generic list forgot — where declaring it
		// answers the `unknown-type` beside it as well and the Namespace
		// compiles.
		it("should declare the Parameter after the Namespace's name", () => {
			let lines = [
				...BOXES,
				"\tnamespace Boxes for Box<Thing> is Sized where Thing is Sized {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = parameterFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Declare it as '<infer Thing>'")
			expect(fix.isPreferred).toBe(true)
			expect(result[7]).toBe(
				"\tnamespace Boxes<infer Thing> for Box<Thing> is Sized where Thing is Sized {",
			)

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A list that already holds Parameters takes the new one after
		// them — `infer` and all, since a Namespace's Type Parameters are every
		// one of them inferred. What is left is the condition speaking about a
		// Parameter the target Type never mentions, which is the reader's to
		// answer and says so in its own words.
		it("should write it into a Generic list already there", () => {
			let lines = [
				...BOXES,
				"\tnamespace Boxes<infer Item> for Box<Item> is Sized where Thing is Sized {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"}",
			]

			let result = applied(lines, parameterFixes(lines)[0])

			expect(result[7]).toBe(
				"\tnamespace Boxes<infer Item, infer Thing> for Box<Item> is Sized where Thing is Sized {",
			)

			expect(codesOf(result)).toEqual(["unwitnessable-where-condition"])
		})
	})

	describe("documentation tags", () => {
		it("should write the line a Parameter is missing under the run", () => {
			let lines = [
				"implementation {",
				"\t§§ Joins two texts.",
				"\t§§ @param left — the text to put first",
				"\tfunction join(left: String, right: String) -> String {",
				"\t\t<- left::append(right)",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Add a '@param right' line")
			expect(fix.diagnosticCode).toBe("undocumented-parameter")
			// NOTE: The description is left empty, so the reader still has
			// something to write — which is why the fix is not preferred.
			expect(fix.isPreferred).toBe(false)

			expect(result).toEqual([
				"implementation {",
				"\t§§ Joins two texts.",
				"\t§§ @param left — the text to put first",
				"\t§§ @param right —",
				"\tfunction join(left: String, right: String) -> String {",
				"\t\t<- left::append(right)",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("undocumented-parameter")
		})

		// NOTE: A tag's description runs until the next tag opens, so the line
		// goes under everything the tag above it wrote — and above the tag
		// below it, whatever that tag is.
		it("should write it below the lines that continue the tag above", () => {
			let lines = [
				"implementation {",
				"\t§§ Joins two texts.",
				"\t§§ @param left — the text to put first",
				"\t§§ and it goes on about it",
				"\t§§ @returns — the two of them",
				"\tfunction join(left: String, right: String) -> String {",
				"\t\t<- left::append(right)",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result[4]).toBe("\t§§ @param right —")
			expect(result[5]).toBe("\t§§ @returns — the two of them")
			expect(codesOf(result)).not.toContain("undocumented-parameter")
		})

		it("should offer no line for a Parameter the run cannot reach", () => {
			let lines = [
				"implementation {",
				"\t§§ Joins.",
				"\t§§ @param left — the text to put first",
				"\tfunction join(left: String, middle: String, right: String) -> String {",
				"\t\t<- left::append(middle)::append(right)",
				"\t}",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([
				"Add a '@param middle' line",
			])
		})

		it("should rewrite a tag to the Parameter standing at its position", () => {
			let lines = [
				"implementation {",
				"\t§§ Greets.",
				"\t§§ @param subjekt — who to greet",
				"\tfunction greet(subject: String) -> String { <- subject }",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Change to '@param subject'")
			expect(fix.diagnosticCode).toBe("misnamed-documentation-parameter")
			expect(fix.isPreferred).toBe(true)
			expect(result[2]).toBe("\t§§ @param subject — who to greet")
			expect(codesOf(result)).toEqual([])
		})

		// NOTE: The whole line and the lines under it, since a description left
		// behind would read as prose about whatever tag stands above it.
		it("should remove a tag past the last Parameter, description and all", () => {
			let lines = [
				"implementation {",
				"\t§§ Greets.",
				"\t§§ @param subject — who to greet",
				"\t§§ @param loudly — and how",
				"\t§§ which nobody asked about",
				"\tfunction greet(subject: String) -> String { <- subject }",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove the '@param' line")
			expect(fix.isPreferred).toBe(true)

			expect(result).toEqual([
				"implementation {",
				"\t§§ Greets.",
				"\t§§ @param subject — who to greet",
				"\tfunction greet(subject: String) -> String { <- subject }",
				"}",
			])

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: An `overload` block's tags are read by NAME, so a near miss is
		// tellable there — and the fix that keeps the description stands above
		// the one that throws it away.
		it("should offer a near miss above the removal", () => {
			let lines = [
				"implementation {",
				"\tnamespace Ladder for Integer {",
				"\t\t§§ Climbs.",
				"\t\t§§ @param hight — how far",
				"\t\toverload climb {",
				"\t\t\t(_ height: Integer) -> Integer { <- @ }",
				"\t\t\t() -> Integer { <- @ }",
				"\t\t}",
				"\t}",
				"}",
			]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Change to '@param height'",
				"Remove the '@param' line",
			])
			expect(fixes[1].isPreferred).toBe(false)
			expect(applied(lines, fixes[0])[3]).toBe(
				"\t\t§§ @param height — how far",
			)
			expect(codesOf(applied(lines, fixes[0]))).toEqual([])
		})
	})

	describe("snapshot-after-matcher", () => {
		it("should record the name on a line of its own", () => {
			let lines = [
				"implementation {",
				"\tconstant found: Optional<Integer> = #Value(1)",
				"}",
				"",
				"tests {",
				'\ttest "records the item" {',
				"\t\trequire #Value(item) = found matches snapshot",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Record 'item' on a line of its own")
			expect(fix.diagnosticCode).toBe("snapshot-after-matcher")
			expect(fix.isPreferred).toBe(true)

			expect(result).toEqual([
				"implementation {",
				"\tconstant found: Optional<Integer> = #Value(1)",
				"}",
				"",
				"tests {",
				'\ttest "records the item" {',
				"\t\trequire #Value(item) = found",
				"\t\texpect item matches snapshot",
				"\t}",
				"}",
			])

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: The snapshot is moved WHOLE — a stored one names an entry of
		// the snapshot file, and the name goes with it.
		it("should take a stored snapshot's name along", () => {
			let lines = [
				"implementation {",
				"\tconstant found: Optional<Integer> = #Value(1)",
				"}",
				"",
				"tests {",
				'\ttest "records the item" {',
				'\t\trequire #Value(item) = found matches snapshot from "the item"',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)[7]).toBe(
				'\t\texpect item matches snapshot from "the item"',
			)
		})

		// NOTE: One action per name, and none of them preferred: which member
		// of the Pattern the snapshot meant is not something the Diagnostic
		// can say.
		it("should offer one line per name a Pattern introduced", () => {
			let lines = [
				"implementation {",
				"\tconstant standing = { points = 3, played = 1 }",
				"}",
				"",
				"tests {",
				'\ttest "records the row" {',
				"\t\trequire { points, played } = standing matches snapshot",
				"\t}",
				"}",
			]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Record 'points' on a line of its own",
				"Record 'played' on a line of its own",
			])
			expect(fixes.every((fix) => !fix.isPreferred)).toBe(true)
			expect(applied(lines, fixes[1])[7]).toBe(
				"\t\texpect played matches snapshot",
			)
		})

		it("should offer nothing where the Matcher introduced no name", () => {
			let lines = [
				"implementation {",
				"\tconstant value: Integer = 1",
				"}",
				"",
				"tests {",
				'\ttest "records it" {',
				"\t\trequire Integer = value matches snapshot",
				"\t}",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
		})
	})

	// NOTE: A moved block keeps its text byte for byte — what is adjusted is
	// the blank line in front of it and the one behind it, so a file spaced the
	// way its author spaced it stays that way.
	describe("misplaced sections", () => {
		it("should move a tests block below the implementation", () => {
			let lines = [
				"tests {",
				'\ttest "counts" { expect true }',
				"}",
				"",
				"implementation {",
				"\tconstant a = 1",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Move the 'tests { … }' block to the end")
			expect(fix.diagnosticCode).toBe("misplaced-tests-section")
			expect(fix.isPreferred).toBe(true)

			expect(result).toEqual([
				"implementation {",
				"\tconstant a = 1",
				"}",
				"",
				"tests {",
				'\ttest "counts" { expect true }',
				"}",
			])

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: The block goes to the END, which is below whatever the Module
		// hands out rather than directly below the implementation.
		it("should move a tests block below the exports", () => {
			let lines = [
				"implementation {",
				"\tconstant a = 1",
				"}",
				"",
				"§ what it proves",
				"tests {",
				'\ttest "counts" { expect true }',
				"}",
				"",
				"export {",
				"\ta",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result).toEqual([
				"implementation {",
				"\tconstant a = 1",
				"}",
				"",
				"export {",
				"\ta",
				"}",
				"",
				"§ what it proves",
				"tests {",
				'\ttest "counts" { expect true }',
				"}",
			])

			expect(codesOf(result)).toEqual([])
		})

		it("should move an import block above the implementation", () => {
			let lines = [
				"implementation {",
				"\tconstant a = 1",
				"}",
				"",
				"import {",
				'\tfrom "./Other.es" { thing }',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe(
				"Move the 'import { … }' block above the implementation",
			)
			expect(fix.diagnosticCode).toBe("misplaced-module-section")

			expect(result).toEqual([
				"import {",
				'\tfrom "./Other.es" { thing }',
				"}",
				"",
				"implementation {",
				"\tconstant a = 1",
				"}",
			])

			// NOTE: The specifier names no file here, so the graph is what is
			// left to complain about rather than the shape of the Program.
			expect(codesOf(result)).not.toContain("misplaced-module-section")
		})

		// NOTE: A Comment held off from the block below it is about the FILE,
		// so an import written back above the implementation goes under it
		// rather than over it.
		it("should leave a file's own header above the import block", () => {
			let lines = [
				"§ A file about things",
				"",
				"implementation {",
				"\tconstant a = 1",
				"}",
				"",
				"import {",
				'\tfrom "./Other.es" { thing }',
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)).toEqual([
				"§ A file about things",
				"",
				"import {",
				'\tfrom "./Other.es" { thing }',
				"}",
				"",
				"implementation {",
				"\tconstant a = 1",
				"}",
			])
		})

		it("should move an export block below the implementation", () => {
			let lines = [
				"export {",
				"\ta",
				"}",
				"",
				"implementation {",
				"\tconstant a = 1",
				"}",
				"",
				"tests {",
				'\ttest "counts" { expect true }',
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe(
				"Move the 'export { … }' block below the implementation",
			)

			expect(result).toEqual([
				"implementation {",
				"\tconstant a = 1",
				"}",
				"",
				"export {",
				"\ta",
				"}",
				"",
				"tests {",
				'\ttest "counts" { expect true }',
				"}",
			])

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A file that separates nothing with blank lines gets none
		// invented for it — the move adjusts the spacing the block had, and it
		// had none.
		it("should invent no blank line for a file that writes none", () => {
			let lines = [
				"export {",
				"\ta",
				"}",
				"implementation {",
				"\tconstant a = 1",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(applied(lines, fix)).toEqual([
				"implementation {",
				"\tconstant a = 1",
				"}",
				"export {",
				"\ta",
				"}",
			])
		})
	})

	describe("use-before-declaration", () => {
		it("should move the Statement below the Namespace it names", () => {
			let lines = [
				"implementation {",
				"\tconstant total = Maths.zero",
				"",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Move this Statement below 'Maths'")
			expect(fix.diagnosticCode).toBe("use-before-declaration")
			// NOTE: Moving a Statement changes what it can see and what can see
			// it, so the reader decides rather than the Editor.
			expect(fix.isPreferred).toBe(false)

			expect(result).toEqual([
				"implementation {",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"",
				"\tconstant total = Maths.zero",
				"}",
			])

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: A `§§` block is a run of Comments directly above what it
		// documents, so it travels with the Statement the way any Comment
		// glued to a block does.
		it("should take the Statement's documentation along", () => {
			let lines = [
				"implementation {",
				"\t§§ The running total.",
				"\tconstant total = Maths.zero",
				"",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"",
				"\tconstant other = 2",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result).toEqual([
				"implementation {",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"",
				"\t§§ The running total.",
				"\tconstant total = Maths.zero",
				"",
				"\tconstant other = 2",
				"}",
			])

			expect(codesOf(result)).toEqual([])
		})

		// NOTE: The same code covers a Property read from another Property's
		// initialiser. What would move there is a member of a Namespace, and
		// the Parser records no span for one.
		it("should offer nothing for a Property read too early", () => {
			let lines = [
				"implementation {",
				"\tnamespace Maths {",
				"\t\tstatic doubled: Integer = Maths.zero",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"}",
			]

			expect(codesOf(lines)).toEqual(["use-before-declaration"])
			expect(titles(quickFixes(lines))).toEqual([])
		})
	})

	// NOTE: The stubs a Namespace owes, carrying the Protocol's own signatures
	// and nothing in their bodies. Applying one leaves a `missing-return` under
	// each stub, which is the visible hole this trades a conformance nobody can
	// see the shape of for.
	describe("nonconforming-namespace", () => {
		it("should write a stub for the one requirement a Namespace owes", () => {
			let lines = [
				"implementation {",
				"\ttype Point = { x: Integer }",
				"",
				"\tnamespace Point for Point is Printable {",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Implement 'Printable'")
			expect(fix.diagnosticCode).toBe("nonconforming-namespace")
			expect(fix.isPreferred).toBe(false)

			expect(result).toEqual([
				"implementation {",
				"\ttype Point = { x: Integer }",
				"",
				"\tnamespace Point for Point is Printable {",
				"\t\ttoString() -> String {",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("nonconforming-namespace")
			expect(codesOf(result)).not.toContain("syntax-error")
			expect(refusalOf(result)).toBeNull()
		})

		// NOTE: `Self` is written back as the target Type was WRITTEN. A Record
		// Alias resolves to the Record it names and carries the name nowhere,
		// so a signature printed from the Type would read `-> { side: Integer }`
		// where the reader wrote `Square`.
		it("should write every requirement, a static and a Self among them", () => {
			let lines = [
				"implementation {",
				"\tprotocol Shape {",
				"\t\tarea() -> Integer",
				"\t\tscaled(by factor: Integer) -> Self",
				"\t\tstatic blank() -> Self",
				"\t}",
				"",
				"\ttype Square = { side: Integer }",
				"",
				"\tnamespace Square for Square is Shape {",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "square"',
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Implement 'Shape'")

			// NOTE: A blank line in front of the first stub, because the
			// Namespace already holds a Method — its members stand a line
			// apart, and a stub written straight under one reads as part of it.
			expect(result.slice(9)).toEqual([
				"\tnamespace Square for Square is Shape {",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "square"',
				"\t\t}",
				"",
				"\t\tarea() -> Integer {",
				"\t\t}",
				"",
				"\t\tscaled(by: Integer) -> Square {",
				"\t\t}",
				"",
				"\t\tstatic blank() -> Square {",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("nonconforming-namespace")
			expect(codesOf(result)).not.toContain("syntax-error")
			expect(refusalOf(result)).toBeNull()
		})

		it("should count the requirements of a Protocol the one named extends", () => {
			let lines = [
				"implementation {",
				"\tprotocol Named {",
				"\t\tname() -> String",
				"\t}",
				"",
				"\tprotocol Titled is Named {",
				"\t\ttitle() -> String",
				"\t}",
				"",
				"\ttype Book = { pages: Integer }",
				"",
				"\tnamespace Book for Book is Titled {",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Implement 'Titled'")
			expect(result.slice(11)).toEqual([
				"\tnamespace Book for Book is Titled {",
				"\t\tname() -> String {",
				"\t\t}",
				"",
				"\t\ttitle() -> String {",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("nonconforming-namespace")
			expect(refusalOf(result)).toBeNull()
		})

		// NOTE: `Equatable` requires `is` and PROVIDES `isNot`. A stub for the
		// provided one would replace a working Method with an empty one.
		it("should leave a Method the Protocol provides alone", () => {
			let lines = [
				"implementation {",
				"\ttype Point = { x: Integer }",
				"",
				"\tnamespace Point for Point is Equatable {",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result.slice(3)).toEqual([
				"\tnamespace Point for Point is Equatable {",
				"\t\tis(_: Point) -> Boolean {",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("nonconforming-namespace")
			expect(refusalOf(result)).toBeNull()
		})

		// NOTE: An `overload` requirement is a SET, so the stub is the block
		// and an entry per Overload — a Namespace fulfilling one entry and not
		// the others fulfills none of them.
		it("should write an 'overload' block for an overloaded requirement", () => {
			let lines = [
				"implementation {",
				"\tprotocol Scaled {",
				"\t\toverload scaled {",
				"\t\t\t(by factor: Integer) -> Self",
				"\t\t\t(_ factor: Integer, and offset: Integer) -> Self",
				"\t\t}",
				"",
				"\t\toverload static of {",
				"\t\t\t(_ side: Integer) -> Self",
				"\t\t\t() -> Self",
				"\t\t}",
				"\t}",
				"",
				"\ttype Square = { side: Integer }",
				"",
				"\tnamespace Square for Square is Scaled {",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Implement 'Scaled'")
			expect(result.slice(15)).toEqual([
				"\tnamespace Square for Square is Scaled {",
				"\t\toverload scaled {",
				"\t\t\t(by: Integer) -> Square {",
				"\t\t\t}",
				"",
				"\t\t\t(_: Integer, and: Integer) -> Square {",
				"\t\t\t}",
				"\t\t}",
				"",
				"\t\toverload static of {",
				"\t\t\t(_: Integer) -> Square {",
				"\t\t\t}",
				"",
				"\t\t\t() -> Square {",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("nonconforming-namespace")
			expect(codesOf(result)).not.toContain("syntax-error")
			expect(refusalOf(result)).toBeNull()
		})

		// NOTE: A Choice derives its own equality, so a Namespace that writes
		// nothing is right — and there is no Diagnostic to answer.
		it("should offer nothing where the Choice derives the conformance", () => {
			expect(
				titles(
					actionsOf([
						"implementation {",
						"\tchoice Colour { Red, Green, Blue }",
						"",
						"\tnamespace Colour for Colour is Equatable {",
						"\t}",
						"}",
					]),
				).filter((title) => title.startsWith("Implement")),
			).toEqual([])
		})

		// NOTE: The same edit, offered where the Quick Fix can not reach — the
		// Diagnostic underlines the clause's Protocol Identifier alone, and a
		// cursor resting on `namespace` is nowhere near it.
		it("should offer the same edit as a refactoring on the Namespace head", () => {
			let lines = [
				"implementation {",
				"\ttype Point = { x: Integer }",
				"",
				"\tnamespace Point for Point is Printable {",
				"\t}",
				"}",
			]

			let [refactor] = actionsOf(lines, {
				start: { line: 4, column: 2 },
				end: { line: 4, column: 11 },
			})

			expect(refactor.kind).toBe("refactor.rewrite")
			expect(refactor.title).toBe("Implement 'Printable'")
			expect(refactor.diagnosticCode).toBeNull()
			expect(applied(lines, refactor)[4]).toBe(
				"\t\ttoString() -> String {",
			)
		})

		// NOTE: The refactoring stands down on the clause itself rather than
		// offering the reader one edit under one title twice.
		it("should not repeat the Quick Fix on the clause it answers", () => {
			expect(
				actionsOf([
					"implementation {",
					"\ttype Point = { x: Integer }",
					"",
					"\tnamespace Point for Point is Printable {",
					"\t}",
					"}",
				])
					.filter((entry) => entry.title.startsWith("Implement"))
					.map((entry) => entry.kind),
			).toEqual(["quickfix"])
		})
	})

	// NOTE: The conformance a property test asks for, written beside the Type it
	// is about. What it can not draw it leaves OUT, so the value it builds is
	// incomplete and says so — a drawn value that was plausible rather than
	// right would make every property over it a report about the generator.
	describe("ungeneratable-type", () => {
		let generatableActions = (
			lines: Array<string>,
			line: number,
			column: number,
		): Array<CodeActionEntry> =>
			actionsOf(lines, {
				start: { line, column },
				end: { line, column },
			}).filter((entry) => entry.title.startsWith("Make"))

		it("should write a conformance beside the Type a property test can not build", () => {
			let lines = [
				"implementation {",
				"\ttype Handler = { x: Integer, read: (_: String) -> Integer }",
				"}",
				"",
				"tests {",
				'\ttest "a property" for any (h: Handler) {',
				"\t\texpect true",
				"\t}",
				"}",
			]

			let [fix] = generatableActions(lines, 6, 31)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Make 'Handler' Generatable")
			expect(fix.kind).toBe("quickfix")
			expect(fix.diagnosticCode).toBe("ungeneratable-type")
			expect(fix.isPreferred).toBe(false)

			expect(result.slice(0, 10)).toEqual([
				"implementation {",
				"\ttype Handler = { x: Integer, read: (_: String) -> Integer }",
				"",
				"\tnamespace HandlerGeneratable for Handler is Generatable {",
				"\t\tstatic generate(from source: Randomness) -> Handler {",
				"\t\t\t§ No draw for 'read' — write one, or the value below is incomplete.",
				"\t\t\t<- { x = source::drawInteger(between 0, and 100) }",
				"\t\t}",
				"\t}",
				"}",
			])

			// NOTE: The conformance replaces the derivation, so the refusal is
			// answered — and the member it could not draw is a hole the Record
			// below reports on its own.
			expect(codesOf(result)).not.toContain("ungeneratable-type")
			expect(codesOf(result)).not.toContain("syntax-error")
			expect(codesOf(result)).toContain("return-type-mismatch")
			expect(refusalOf(result)).toBeNull()
		})

		it("should draw a Record member by member", () => {
			let lines = [
				"implementation {",
				"\ttype Point = { x: Integer, label: String }",
				"}",
			]

			let [refactor] = generatableActions(lines, 2, 8)
			let result = applied(lines, refactor)

			expect(refactor.kind).toBe("refactor.rewrite")
			expect(refactor.diagnosticCode).toBeNull()

			expect(result).toEqual([
				"implementation {",
				"\ttype Point = { x: Integer, label: String }",
				"",
				"\tnamespace PointGeneratable for Point is Generatable {",
				"\t\tstatic generate(from source: Randomness) -> Point {",
				"\t\t\t<- {",
				"\t\t\t\tx = source::drawInteger(between 0, and 100),",
				"\t\t\t\tlabel = source::drawString(upTo 10),",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).toEqual([])
			expect(refusalOf(result)).toBeNull()
		})

		it("should pick a Choice's Case from a written List", () => {
			let lines = [
				"implementation {",
				"\tchoice Colour { Red, Green, Blue }",
				"}",
			]

			let result = applied(lines, generatableActions(lines, 2, 10)[0])

			expect(result.slice(3)).toEqual([
				"\tnamespace ColourGeneratable for Colour is Generatable {",
				"\t\tstatic generate(from source: Randomness) -> Colour {",
				"\t\t\t<- source::pick(from [Colour#Red, Colour#Green, Colour#Blue])",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).toEqual([])
			expect(refusalOf(result)).toBeNull()
		})

		// NOTE: A Case carrying a payload is BUILT before it is picked, and the
		// list breaks where the Formatter would break it — a scaffold laid out
		// differently would be rewritten the next time the file is saved.
		it("should build a Case's payload and break the list that does not fit", () => {
			let lines = [
				"implementation {",
				"\tchoice Shape {",
				"\t\tBlank,",
				"\t\tCircle { radius: Integer },",
				"\t}",
				"}",
			]

			let result = applied(lines, generatableActions(lines, 2, 9)[0])

			expect(result.slice(6)).toEqual([
				"\tnamespace ShapeGeneratable for Shape is Generatable {",
				"\t\tstatic generate(from source: Randomness) -> Shape {",
				"\t\t\t<- source::pick(from [",
				"\t\t\t\tShape#Blank,",
				"\t\t\t\tShape#Circle({ radius = source::drawInteger(between 0, and 100) }),",
				"\t\t\t])",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).toEqual([])
			expect(refusalOf(result)).toBeNull()
		})

		it("should offer nothing where the Type already conforms", () => {
			expect(
				generatableActions(
					[
						"implementation {",
						"\ttype Point = { x: Integer }",
						"",
						"\tnamespace PointGeneratable for Point is Generatable {",
						"\t\tstatic generate(from source: Randomness) -> Point {",
						"\t\t\t<- { x = 1 }",
						"\t\t}",
						"\t}",
						"}",
					],
					2,
					8,
				),
			).toEqual([])
		})

		// NOTE: `generate` takes a source and nothing else, so a call has no
		// Argument for a Type Parameter to be worked out from — which is what
		// `unreachable-conformance` refuses. Offering to write one would be
		// offering to break the file.
		it("should offer nothing for a generic Choice", () => {
			expect(
				generatableActions(
					[
						"implementation {",
						"\tchoice Maybe<ItemType> {",
						"\t\tNone,",
						"\t\tSome { item: ItemType },",
						"\t}",
						"}",
					],
					2,
					9,
				),
			).toEqual([])
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

	// NOTE: The Match a reader is about to write, scaffolded from the value the
	// cursor stands on. Its arms are the `missing-case` fix's arms, by the same
	// rule and in the same spelling, so a scaffold and a Case added later meet
	// as one thing rather than two.
	describe("Match on a value", () => {
		let matchActions = (
			lines: Array<string>,
			range: common.Position,
		): Array<CodeActionEntry> =>
			actionsOf(lines, range).filter((entry) =>
				entry.title.startsWith("Match on"),
			)

		it("should scaffold an arm per Case of a Choice", () => {
			let lines = [
				"implementation {",
				"\tchoice Colour { Red, Green, Blue }",
				"",
				"\tfunction describe (chosen: Colour) -> String {",
				"\t\t<- chosen",
				"\t}",
				"}",
			]

			let [refactor] = matchActions(lines, {
				start: { line: 5, column: 9 },
				end: { line: 5, column: 9 },
			})
			let result = applied(lines, refactor)

			expect(refactor.title).toBe("Match on 'chosen'")
			expect(refactor.kind).toBe("refactor.rewrite")
			expect(refactor.diagnosticCode).toBeNull()
			expect(refactor.isPreferred).toBe(false)

			// NOTE: The `<- ` is left where it was — only what stands between
			// `match ` and ` -> ` is written, so the Return stays a Return and
			// the Function's own `-> String` is what the Match answers with.
			expect(result).toEqual([
				"implementation {",
				"\tchoice Colour { Red, Green, Blue }",
				"",
				"\tfunction describe (chosen: Colour) -> String {",
				"\t\t<- match chosen -> String {",
				"\t\t\tcase Colour#Red {}",
				"\t\t\tcase Colour#Green {}",
				"\t\t\tcase Colour#Blue {}",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("syntax-error")
			expect(refusalOf(result)).toBeNull()
		})

		it("should scaffold an Optional's two Cases as the Choice they are", () => {
			let lines = [
				"implementation {",
				"\tconstant maybe: Optional<Integer> = #Value(1)",
				"\tconstant described = maybe",
				"}",
			]

			let [refactor] = matchActions(lines, {
				start: { line: 3, column: 24 },
				end: { line: 3, column: 24 },
			})
			let result = applied(lines, refactor)

			expect(refactor.title).toBe("Match on 'maybe'")
			expect(result).toEqual([
				"implementation {",
				"\tconstant maybe: Optional<Integer> = #Value(1)",
				"\tconstant described = match maybe -> Optional<Integer> {",
				"\t\tcase Optional#Value {}",
				"\t\tcase Optional#Empty {}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("syntax-error")
			expect(refusalOf(result)).toBeNull()
		})

		it("should scaffold a Union of Types under its member Types", () => {
			let lines = [
				"implementation {",
				"\tconstant value: Integer | String | Boolean = 1",
				"\tconstant described = value",
				"}",
			]

			let [refactor] = matchActions(lines, {
				start: { line: 3, column: 24 },
				end: { line: 3, column: 24 },
			})
			let result = applied(lines, refactor)

			expect(result.slice(2)).toEqual([
				"\tconstant described = match value -> Integer | String | Boolean {",
				"\t\tcase Integer {}",
				"\t\tcase String {}",
				"\t\tcase Boolean {}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("syntax-error")
			expect(refusalOf(result)).toBeNull()
		})

		it("should reach the call a chain ends in", () => {
			let lines = [
				"implementation {",
				"\tconstant items = [1, 2]",
				"\tconstant first = items::firstItem()",
				"}",
			]

			let [refactor] = matchActions(lines, {
				start: { line: 3, column: 30 },
				end: { line: 3, column: 30 },
			})

			expect(refactor.title).toBe("Match on 'items::firstItem()'")
			expect(applied(lines, refactor)[2]).toBe(
				"\tconstant first = match items::firstItem() -> Optional<Integer> {",
			)
		})

		// NOTE: There is nothing to take apart — a Match over a Type with no
		// members to name would be a `case Integer` and nothing else.
		it("should offer nothing on a value that is no Union", () => {
			expect(
				matchActions(["implementation {", "\tconstant n = 1", "}"], {
					start: { line: 2, column: 15 },
					end: { line: 2, column: 15 },
				}),
			).toEqual([])
		})

		// NOTE: The request has to sit INSIDE the Expression. A client asking
		// about a selection of the whole file is asking about no Expression in
		// particular, and scaffolding into the last one would be a guess.
		it("should offer nothing for a request no Expression contains", () => {
			expect(
				titles(
					actionsOf([
						"implementation {",
						"\tconstant maybe: Optional<Integer> = #Value(1)",
						"\tconstant described = maybe",
						"}",
					]),
				).filter((title) => title.startsWith("Match on")),
			).toEqual([])
		})
	})

	// NOTE: The `§§` block a signature wants, with nothing written in it. The
	// assertion that matters is the one about the Diagnostics: a `@param` line
	// documents the Parameter at its own position and names it the way the
	// signature does, and getting that wrong by hand is what the three Warnings
	// exist for.
	describe("Document a Function", () => {
		const documentationCodes: Array<common.DiagnosticCode> = [
			"undocumented-parameter",
			"unknown-documentation-parameter",
			"misnamed-documentation-parameter",
			"missing-documentation-separator",
		]

		let documentActions = (
			lines: Array<string>,
			line: number,
		): Array<CodeActionEntry> =>
			actionsOf(lines, {
				start: { line, column: 3 },
				end: { line, column: 3 },
			}).filter((entry) => entry.title.startsWith("Document"))

		function expectNoDocumentationCodes(result: Array<string>) {
			for (let code of documentationCodes) {
				expect(codesOf(result)).not.toContain(code)
			}
		}

		it("should write a line per Parameter, named as the signature names it", () => {
			let lines = [
				"implementation {",
				"\tfunction area (of width: Integer, by height: Integer) -> Integer {",
				"\t\t<- width::multiply(with height)",
				"\t}",
				"}",
			]

			let [refactor] = documentActions(lines, 2)
			let result = applied(lines, refactor)

			expect(refactor.title).toBe("Document 'area'")
			expect(refactor.kind).toBe("refactor.rewrite")
			expect(refactor.diagnosticCode).toBeNull()
			expect(refactor.isPreferred).toBe(false)

			expect(result).toEqual([
				"implementation {",
				"\t§§",
				"\t§§",
				"\t§§ @param of —",
				"\t§§ @param by —",
				"\t§§ @returns —",
				"\tfunction area (of width: Integer, by height: Integer) -> Integer {",
				"\t\t<- width::multiply(with height)",
				"\t}",
				"}",
			])

			expectNoDocumentationCodes(result)
			expect(codesOf(result)).not.toContain("syntax-error")
			expect(refusalOf(result)).toBeNull()
		})

		// NOTE: The LABEL, never the internal name — a Parameter that carries
		// no label is `_` to the signature and to the rule alike, whatever the
		// body reads it under.
		it("should name a Parameter that carries no label '_'", () => {
			let lines = [
				"implementation {",
				"\tfunction twice (_ value: Integer) -> Integer {",
				"\t\t<- value::multiply(with 2)",
				"\t}",
				"}",
			]

			let result = applied(lines, documentActions(lines, 2)[0])

			expect(result.slice(1, 4)).toEqual([
				"\t§§",
				"\t§§",
				"\t§§ @param _ —",
			])

			expectNoDocumentationCodes(result)
			expect(refusalOf(result)).toBeNull()
		})

		it("should write no '@returns' for a Function answering the unit Type", () => {
			let lines = [
				"implementation {",
				"\tfunction shout (_ text: String) -> {} {",
				"\t\tTerminal.print(text)",
				"\t}",
				"}",
			]

			let result = applied(lines, documentActions(lines, 2)[0])

			expect(result.slice(1, 5)).toEqual([
				"\t§§",
				"\t§§",
				"\t§§ @param _ —",
				"\tfunction shout (_ text: String) -> {} {",
			])

			expectNoDocumentationCodes(result)
			expect(refusalOf(result)).toBeNull()
		})

		it("should reach a Method and indent the block with it", () => {
			let lines = [
				"implementation {",
				"\tnamespace Sign for Integer {",
				"\t\tdescribe (as style: String) -> String {",
				"\t\t\t<- style",
				"\t\t}",
				"\t}",
				"}",
			]

			let [refactor] = documentActions(lines, 3)
			let result = applied(lines, refactor)

			expect(refactor.title).toBe("Document 'describe'")
			expect(result.slice(2, 6)).toEqual([
				"\t\t§§",
				"\t\t§§",
				"\t\t§§ @param as —",
				"\t\t§§ @returns —",
			])

			expectNoDocumentationCodes(result)
			expect(refusalOf(result)).toBeNull()
		})

		// NOTE: The `static` keyword stands in front of the name on the same
		// line, and the block goes above that line rather than between them.
		it("should write above the 'static' keyword rather than under it", () => {
			let lines = [
				"implementation {",
				"\tnamespace Sign for Integer {",
				"\t\tstatic zero () -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"}",
			]

			let [refactor] = documentActions(lines, 3)
			let result = applied(lines, refactor)

			expect(refactor.title).toBe("Document 'zero'")
			expect(result.slice(2, 6)).toEqual([
				"\t\t§§",
				"\t\t§§",
				"\t\t§§ @returns —",
				"\t\tstatic zero () -> Integer {",
			])

			expectNoDocumentationCodes(result)
			expect(refusalOf(result)).toBeNull()
		})

		it("should offer nothing where a block is already written", () => {
			expect(
				documentActions(
					[
						"implementation {",
						"\t§§ Answers the area.",
						"\t§§",
						"\t§§ @param of — the width",
						"\t§§ @returns — the area.",
						"\tfunction area (of width: Integer) -> Integer {",
						"\t\t<- width",
						"\t}",
						"}",
					],
					6,
				),
			).toEqual([])
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

	// NOTE: The Enricher writes a path's Function literal for it, so the two
	// spellings reach the rest of the pipeline as one Node — which is what
	// makes this a round trip rather than a rewording. Both directions are
	// offered inside an Argument and nowhere else, so that neither of them can
	// produce something the other would refuse to turn back.
	describe("Member paths", () => {
		let pathRefactors = (
			lines: Array<string>,
			range?: common.Position,
		): Array<CodeActionEntry> =>
			actionsOf(lines, range).filter((entry) =>
				entry.title.startsWith("Write it as"),
			)

		let onlyRefactor = (lines: Array<string>): CodeActionEntry => {
			let [entry, ...rest] = pathRefactors(lines)

			expect(rest).toEqual([])

			return entry
		}

		it("should offer the path a reading literal stands for", () => {
			let lines = [
				"implementation {",
				'\tconstant people = [{ name = "Ada", city = "London" }]',
				"\tconstant names = people::map((item) { <- item.name })",
				"}",
			]

			let refactor = onlyRefactor(lines)

			expect(refactor.title).toBe("Write it as the path '.name'")
			expect(refactor.kind).toBe("refactor.rewrite")
			expect(refactor.diagnosticCode).toBeNull()
			expect(refactor.isPreferred).toBe(false)
			expect(applied(lines, refactor)[2]).toBe(
				"\tconstant names = people::map(.name)",
			)
		})

		it("should offer the literal a path stands for", () => {
			let lines = [
				"implementation {",
				'\tconstant people = [{ name = "Ada", city = "London" }]',
				"\tconstant names = people::map(.name)",
				"}",
			]

			let refactor = onlyRefactor(lines)

			expect(refactor.title).toBe("Write it as a Function literal")
			expect(applied(lines, refactor)[2]).toBe(
				"\tconstant names = people::map((item) { <- item.name })",
			)
		})

		// NOTE: The two directions are inverses, and the Compiler is asked
		// about every text either of them wrote — a rewrite that produced a
		// Program nobody can compile would still round trip.
		it("should hand the text back when both directions are applied", () => {
			let lines = [
				"implementation {",
				'\tconstant people = [{ name = "Ada", city = "London" }]',
				"\tconstant names = people::map((item) { <- item.name })",
				"}",
			]

			let asPath = applied(lines, onlyRefactor(lines))

			expect(codesOf(asPath)).toEqual([])
			expect(applied(asPath, onlyRefactor(asPath))).toEqual(lines)
			expect(codesOf(lines)).toEqual([])
		})

		it("should step through every member a path names", () => {
			let lines = [
				"implementation {",
				'\tconstant people = [{ home = { city = "London" } }]',
				"\tconstant cities = people::map((item) { <- item.home.city })",
				"}",
			]

			let refactor = onlyRefactor(lines)

			expect(refactor.title).toBe("Write it as the path '.home.city'")
			expect(applied(lines, refactor)[2]).toBe(
				"\tconstant cities = people::map(.home.city)",
			)
			expect(codesOf(applied(lines, refactor))).toEqual([])
		})

		// NOTE: A path reads members and does nothing else — a call in the
		// chain is a Function that only the literal can write.
		it("should offer nothing on a body that computes", () => {
			expect(
				titles(
					pathRefactors([
						"implementation {",
						'\tconstant people = [{ name = "Ada" }]',
						"\tconstant loud = people::map((item) { <- item.name::uppercased() })",
						"}",
					]),
				),
			).toEqual([])
		})

		it("should offer nothing on a literal of two Parameters", () => {
			expect(
				titles(
					pathRefactors([
						"implementation {",
						'\tconstant people = [{ name = "Ada" }]',
						"\tconstant sorted = people::sort(by (first, second) { <- #Ascending })",
						"}",
					]),
				),
			).toEqual([])
		})

		// NOTE: A path is read in several kinds of position and an Argument is
		// only one of them, but it is the one that can be recognised without
		// asking the Enricher what the position expected. A literal bound to an
		// annotated name keeps its own spelling.
		it("should offer nothing outside an Argument", () => {
			expect(
				titles(
					pathRefactors([
						"implementation {",
						"\tconstant read: (_ item: { name: String }) -> String = (item) { <- item.name }",
						"}",
					]),
				),
			).toEqual([])
		})

		// NOTE: The Comment stands between the brackets that are about to go,
		// and there is nowhere in a path to write it.
		it("should offer nothing on a literal holding a Comment", () => {
			expect(
				titles(
					pathRefactors([
						"implementation {",
						'\tconstant people = [{ name = "Ada" }]',
						"\tconstant names = people::map((item) { § the name",
						"\t\t<- item.name",
						"\t})",
						"}",
					]),
				),
			).toEqual([])
		})

		it("should step past a name the Scope already binds", () => {
			let lines = [
				"implementation {",
				"\tconstant item = 1",
				"\tconstant item2 = 2",
				'\tconstant people = [{ name = "Ada" }]',
				"\tconstant names = people::map(.name)",
				"}",
			]

			expect(applied(lines, onlyRefactor(lines))[4]).toBe(
				"\tconstant names = people::map((item3) { <- item3.name })",
			)
			expect(codesOf(applied(lines, onlyRefactor(lines)))).toEqual([])
		})

		it("should only offer what the requested range touches", () => {
			let lines = [
				"implementation {",
				'\tconstant people = [{ name = "Ada", city = "London" }]',
				"\tconstant names = people::map(.name)",
				"\tconstant cities = people::map(.city)",
				"}",
			]

			expect(
				titles(
					pathRefactors(lines, {
						start: { line: 3, column: 31 },
						end: { line: 3, column: 31 },
					}),
				),
			).toEqual(["Write it as a Function literal"])
		})
	})

	// NOTE: The other way round: an if/else whose branches only answer is a
	// definition by cases with the case written after the answer instead of in
	// front of it. Both directions are offered, and the `-> Type` is what a
	// `define` needs and an if/else does not.
	describe("define ladders", () => {
		let defineRefactors = (
			lines: Array<string>,
			range?: common.Position,
		): Array<CodeActionEntry> =>
			actionsOf(lines, range).filter(
				(entry) =>
					entry.title === "Write it as a define" ||
					entry.title === "Write it as if/else",
			)

		let onlyRefactor = (lines: Array<string>): CodeActionEntry => {
			let [entry, ...rest] = defineRefactors(lines)

			expect(rest).toEqual([])

			return entry
		}

		let ladder = [
			"implementation {",
			"\tfunction grade(_ score: Integer) -> String {",
			"\t\tif score::isGreaterThan(90) {",
			'\t\t\t<- "A"',
			"\t\t} else {",
			'\t\t\t<- "F"',
			"\t\t}",
			"\t}",
			"}",
		]

		let written = [
			"implementation {",
			"\tfunction grade(_ score: Integer) -> String {",
			"\t\t<- define -> String {",
			'\t\t\tas "A" if score::isGreaterThan(90)',
			'\t\t\tas "F" otherwise',
			"\t\t}",
			"\t}",
			"}",
		]

		it("should offer the define a returning if/else stands for", () => {
			let refactor = onlyRefactor(ladder)

			expect(refactor.title).toBe("Write it as a define")
			expect(refactor.kind).toBe("refactor.rewrite")
			expect(refactor.diagnosticCode).toBeNull()
			expect(refactor.isPreferred).toBe(false)
			expect(applied(ladder, refactor)).toEqual(written)
			expect(codesOf(written)).toEqual([])
		})

		it("should offer the if/else a define stands for", () => {
			let refactor = onlyRefactor(written)

			expect(refactor.title).toBe("Write it as if/else")
			expect(applied(written, refactor)).toEqual(ladder)
		})

		it("should hand the text back when both directions are applied", () => {
			expect(codesOf(ladder)).toEqual([])
			expect(applied(ladder, onlyRefactor(ladder))).toEqual(written)
			expect(applied(written, onlyRefactor(written))).toEqual(ladder)
		})

		// NOTE: One action rather than one per rung — every `else if` of a
		// cascade is an if/else of its own, and each would offer the same
		// rewrite one arm shorter.
		it("should read a whole else-if cascade as one ladder", () => {
			let lines = [
				"implementation {",
				"\tfunction grade(_ score: Integer) -> String {",
				"\t\tif score::isGreaterThan(90) {",
				'\t\t\t<- "A"',
				"\t\t} else if score::isGreaterThan(80) {",
				'\t\t\t<- "B"',
				"\t\t} else {",
				'\t\t\t<- "F"',
				"\t\t}",
				"\t}",
				"}",
			]

			let result = applied(lines, onlyRefactor(lines))

			expect(result).toEqual([
				"implementation {",
				"\tfunction grade(_ score: Integer) -> String {",
				"\t\t<- define -> String {",
				'\t\t\tas "A" if score::isGreaterThan(90)',
				'\t\t\tas "B" if score::isGreaterThan(80)',
				'\t\t\tas "F" otherwise',
				"\t\t}",
				"\t}",
				"}",
			])
			expect(codesOf(result)).toEqual([])
			expect(applied(result, onlyRefactor(result))).toEqual(lines)
		})

		// NOTE: A `define` takes its Type from its own annotation and not from
		// the `<-` it stands under, so an arm answering with a bare `#Case`
		// needs the one the Function wrote. A contextually typed literal wrote
		// none, and there is nothing to copy.
		it("should leave the annotation out where the Function wrote none", () => {
			let lines = [
				"implementation {",
				"\tconstant kept = [1, 2, 3]::removeEvery(where (item) {",
				"\t\tif item::isGreaterThan(2) {",
				"\t\t\t<- true",
				"\t\t} else {",
				"\t\t\t<- false",
				"\t\t}",
				"\t})",
				"}",
			]

			let result = applied(lines, onlyRefactor(lines))

			expect(result).toEqual([
				"implementation {",
				"\tconstant kept = [1, 2, 3]::removeEvery(where (item) {",
				"\t\t<- define {",
				"\t\t\tas true if item::isGreaterThan(2)",
				"\t\t\tas false otherwise",
				"\t\t}",
				"\t})",
				"}",
			])
			expect(codesOf(result)).toEqual([])
		})

		// NOTE: An arm below the first is read behind the COMPLEMENT of every
		// Condition above it, and an `else` branch is read behind its own —
		// `separator::isEmpty()` proves the `NonEmptyString` that `split` asks
		// for either way. Both spellings are put to the Compiler, since a
		// narrowing that survived one direction and not the other would be a
		// rewrite that changes what compiles.
		it("should keep what a Condition proves about the branch below it", () => {
			let lines = [
				"implementation {",
				"\tfunction pieces(_ text: String, on separator: String) -> List<String> {",
				"\t\tif separator::isEmpty() {",
				"\t\t\t<- [text]",
				"\t\t} else {",
				"\t\t\t<- text::split(on separator)",
				"\t\t}",
				"\t}",
				"}",
			]

			let result = applied(lines, onlyRefactor(lines))

			expect(result).toEqual([
				"implementation {",
				"\tfunction pieces(_ text: String, on separator: String) -> List<String> {",
				"\t\t<- define -> List<String> {",
				"\t\t\tas [text] if separator::isEmpty()",
				"\t\t\tas text::split(on separator) otherwise",
				"\t\t}",
				"\t}",
				"}",
			])
			expect(codesOf(lines)).toEqual([])
			expect(codesOf(result)).toEqual([])
			expect(applied(result, onlyRefactor(result))).toEqual(lines)
		})

		it("should reach a Method's body as well as a Function's", () => {
			let lines = [
				"implementation {",
				"\tnamespace Sign for Integer {",
				"\t\tdescribe() -> String {",
				"\t\t\tif @::isGreaterThan(0) {",
				'\t\t\t\t<- "positive"',
				"\t\t\t} else {",
				'\t\t\t\t<- "other"',
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"\tTerminal.print(1::describe())",
				"}",
			]

			let result = applied(lines, onlyRefactor(lines))

			expect(result[3]).toBe("\t\t\t<- define -> String {")
			expect(result[4]).toBe(
				'\t\t\t\tas "positive" if @::isGreaterThan(0)',
			)
			expect(result[5]).toBe('\t\t\t\tas "other" otherwise')
			expect(result[6]).toBe("\t\t\t}")
			expect(codesOf(result)).toEqual([])
		})

		// NOTE: The annotation is the Function's own, copied as it was spelled
		// — and one written over several lines can not be copied onto the line
		// the `define` opens. Leaving it out is a different rewrite, so nothing
		// is offered instead.
		it("should offer nothing where the return Type spans lines", () => {
			expect(
				titles(
					defineRefactors([
						"implementation {",
						"\tfunction sized(_ big: Boolean) -> {",
						"\t\twidth: Integer,",
						"\t\theight: Integer,",
						"\t} {",
						"\t\tif big {",
						"\t\t\t<- { width = 10, height = 10 }",
						"\t\t} else {",
						"\t\t\t<- { width = 1, height = 1 }",
						"\t\t}",
						"\t}",
						"}",
					]),
				),
			).toEqual([])
		})

		it("should offer nothing on a branch that does more than answer", () => {
			expect(
				titles(
					defineRefactors([
						"implementation {",
						"\tfunction grade(_ score: Integer) -> String {",
						"\t\tif score::isGreaterThan(90) {",
						'\t\t\tconstant top = "A"',
						"\t\t\t<- top",
						"\t\t} else {",
						'\t\t\t<- "F"',
						"\t\t}",
						"\t}",
						"}",
					]),
				),
			).toEqual([])
		})

		// NOTE: The Comment stands between two of the Expressions this moves,
		// and an arm has nowhere to put it.
		it("should offer nothing on an if/else holding a Comment", () => {
			expect(
				titles(
					defineRefactors([
						"implementation {",
						"\tfunction grade(_ score: Integer) -> String {",
						"\t\tif score::isGreaterThan(90) {",
						"\t\t\t§ the top grade",
						'\t\t\t<- "A"',
						"\t\t} else {",
						'\t\t\t<- "F"',
						"\t\t}",
						"\t}",
						"}",
					]),
				),
			).toEqual([])
		})

		it("should offer nothing on a define holding a define", () => {
			expect(
				titles(
					defineRefactors([
						"implementation {",
						"\tfunction describe(_ value: Integer) -> String {",
						"\t\t<- define -> String {",
						"\t\t\tas define {",
						'\t\t\t\tas "exactly one" if value::is(1)',
						'\t\t\t\tas "several" otherwise',
						"\t\t\t} if value::isPositive()",
						'\t\t\tas "none at all" otherwise',
						"\t\t}",
						"\t}",
						"}",
					]),
				),
			).toEqual([])
		})

		// NOTE: A Condition written over several lines lands in a column
		// nobody chose, whichever way it is moved.
		it("should offer nothing on a Condition written over two lines", () => {
			expect(
				titles(
					defineRefactors([
						"implementation {",
						"\tfunction grade(_ score: Integer) -> String {",
						"\t\tif score",
						"\t\t\t::isGreaterThan(90) {",
						'\t\t\t<- "A"',
						"\t\t} else {",
						'\t\t\t<- "F"',
						"\t\t}",
						"\t}",
						"}",
					]),
				),
			).toEqual([])
		})
	})

	// NOTE: The Record member shorthand one level up — a Case of exactly one
	// member takes that member's value directly, and the Enricher wraps it back
	// up. Which of the two was written is a question only the enriched Program
	// answers, since a payload that is itself a Record fits both readings.
	describe("Case payloads", () => {
		let payloadRefactors = (
			lines: Array<string>,
			range?: common.Position,
		): Array<CodeActionEntry> =>
			actionsOf(lines, range).filter((entry) =>
				entry.title.includes("payload"),
			)

		let onlyRefactor = (lines: Array<string>): CodeActionEntry => {
			let [entry, ...rest] = payloadRefactors(lines)

			expect(rest).toEqual([])

			return entry
		}

		let choice = [
			"implementation {",
			"\tchoice Progress {",
			"\t\tStopped { total: Integer },",
			"\t\tRunning { done: Integer, total: Integer },",
			"\t}",
		]

		it("should offer the Record a shorthand payload stands for", () => {
			let lines = [
				...choice,
				"\tconstant total = 5",
				"\tconstant done: Progress = #Stopped(total)",
				"}",
			]

			let refactor = onlyRefactor(lines)

			expect(refactor.title).toBe("Expand the payload to '{ total = … }'")
			expect(refactor.kind).toBe("refactor.rewrite")
			expect(refactor.diagnosticCode).toBeNull()
			expect(refactor.isPreferred).toBe(false)

			let result = applied(lines, refactor)

			expect(result[6]).toBe(
				"\tconstant done: Progress = #Stopped({ total = total })",
			)
			expect(codesOf(result)).toEqual([])
		})

		it("should offer the shorthand a one-member Record stands for", () => {
			let lines = [
				...choice,
				"\tconstant total = 5",
				"\tconstant done: Progress = #Stopped({ total = total })",
				"}",
			]

			let refactor = onlyRefactor(lines)

			expect(refactor.title).toBe(
				"Shorten the payload to the value of 'total'",
			)
			expect(applied(lines, refactor)[6]).toBe(
				"\tconstant done: Progress = #Stopped(total)",
			)
		})

		it("should hand the text back when both directions are applied", () => {
			let lines = [
				...choice,
				"\tconstant total = 5",
				"\tconstant done: Progress = #Stopped(total)",
				"}",
			]

			let expanded = applied(lines, onlyRefactor(lines))

			expect(codesOf(lines)).toEqual([])
			expect(codesOf(expanded)).toEqual([])
			expect(applied(expanded, onlyRefactor(expanded))).toEqual(lines)
		})

		it("should offer nothing on a Case carrying more than one member", () => {
			expect(
				titles(
					payloadRefactors([
						...choice,
						"\tconstant running: Progress = #Running({ done = 1, total = 5 })",
						"}",
					]),
				),
			).toEqual([])
		})

		// NOTE: The payload the Enricher read as the Case's whole Record, not
		// as its one member — shortening it would hand the Record where the
		// member goes, which is a different value.
		it("should offer nothing where the payload IS the Record", () => {
			let lines = [
				...choice,
				"\tconstant payload = { total = 5 }",
				"\tconstant done: Progress = #Stopped(payload)",
				"}",
			]

			expect(codesOf(lines)).toEqual([])
			expect(titles(payloadRefactors(lines))).toEqual([])
		})

		// NOTE: The Comment stands inside the braces this deletes, and the
		// shorthand has nowhere to write it.
		it("should offer nothing on a Record holding a Comment", () => {
			expect(
				titles(
					payloadRefactors([
						...choice,
						"\tconstant done: Progress = #Stopped({",
						"\t\t§ everything",
						"\t\ttotal = 5,",
						"\t})",
						"}",
					]),
				),
			).toEqual([])
		})

		it("should reach a shorthand member of the payload Record", () => {
			let lines = [
				...choice,
				"\tconstant total = 5",
				"\tconstant done: Progress = #Stopped({ total })",
				"}",
			]

			expect(applied(lines, onlyRefactor(lines))[6]).toBe(
				"\tconstant done: Progress = #Stopped(total)",
			)
		})
	})

	// NOTE: The mirror of the `constant-reassignment` fix, on code the Compiler
	// is happy with. The rename index is what makes it safe: it records every
	// site that binds a value to the name, so "no write but the declaration" is
	// a fact rather than a guess.
	describe("Constant declarations", () => {
		let constantRefactors = (
			lines: Array<string>,
			range?: common.Position,
		): Array<CodeActionEntry> =>
			actionsOf(lines, range).filter((entry) =>
				entry.title.endsWith("as a Constant"),
			)

		it("should offer the keyword swap on a Variable nothing assigns", () => {
			let lines = [
				"implementation {",
				"\tvariable total = 0",
				"\tTerminal.print(total::toString())",
				"}",
			]

			let [refactor] = constantRefactors(lines)

			expect(refactor.title).toBe("Declare 'total' as a Constant")
			expect(refactor.kind).toBe("refactor.rewrite")
			expect(refactor.diagnosticCode).toBeNull()
			expect(refactor.isPreferred).toBe(false)

			let result = applied(lines, refactor)

			expect(result[1]).toBe("\tconstant total = 0")
			expect(codesOf(result)).toEqual([])
		})

		it("should offer nothing on a Variable something assigns", () => {
			expect(
				titles(
					constantRefactors([
						"implementation {",
						"\tvariable total = 0",
						"\ttotal = 5",
						"\tTerminal.print(total::toString())",
						"}",
					]),
				),
			).toEqual([])
		})

		// NOTE: The assignment is written inside a Function literal that
		// captures the name, which the index records as a write on the very
		// same Declaration — so a rewrite that only read the enclosing body
		// would offer a keyword swap the Compiler then refuses.
		it("should offer nothing where a captured Variable is assigned", () => {
			expect(
				titles(
					constantRefactors([
						"implementation {",
						"\tvariable total = 0",
						"\tconstant bump = () -> Integer {",
						"\t\ttotal = total::add(1)",
						"\t\t<- total",
						"\t}",
						"\tTerminal.print(bump()::toString())",
						"}",
					]),
				),
			).toEqual([])
		})

		// NOTE: One Declaration per name per Scope — the inner `total` is
		// assigned and the outer one is not, and only the outer one is offered.
		it("should tell two Variables of one name apart", () => {
			let lines = [
				"implementation {",
				"\tvariable total = 0",
				"\tfunction counted() -> Integer {",
				"\t\tvariable total = 1",
				"\t\ttotal = 2",
				"\t\t<- total",
				"\t}",
				"\tTerminal.print(counted()::toString())",
				"\tTerminal.print(total::toString())",
				"}",
			]

			let [refactor, ...rest] = constantRefactors(lines)

			expect(rest).toEqual([])
			expect(applied(lines, refactor)[1]).toBe("\tconstant total = 0")
		})

		// NOTE: A Pattern binds several names at once, and `variable` there
		// stands over the list rather than over one name.
		it("should offer nothing on a Variable a Pattern declares", () => {
			expect(
				titles(
					constantRefactors([
						"implementation {",
						"\tconstant point = { x = 1, y = 2 }",
						"\tvariable { x, y } = point",
						"\tTerminal.print(x::add(y)::toString())",
						"}",
					]),
				),
			).toEqual([])
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

// NOTE: The one door a Diagnostic this analysis did NOT produce comes in by —
// the Server hands the workspace-wide `similar-tags` through it, and the focus
// Warning too. A Diagnostic arriving that way carries a Position from some other
// reading of the file, which is why every fix measures its edit against the LIVE
// text and refuses where that text does not read as the Diagnostic says.
//
// One Program with none of the constructs these codes are about, and one
// Diagnostic per code laid over a Constant standing in it: nothing may be
// offered for any of them. The failure this guards against is a fix that trusts
// a Position and rewrites whatever happens to stand there.
describe("A Diagnostic the analysis did not produce", () => {
	const lines = ["implementation {", "\tconstant count = 1", "}"]

	// NOTE: `count` and the `1` beside it — a primary span for the codes that
	// read one, and a secondary for the four that point back at a second place.
	const name = {
		start: { line: 2, column: 11 },
		end: { line: 2, column: 16 },
	}
	const value = {
		start: { line: 2, column: 19 },
		end: { line: 2, column: 20 },
	}

	function stale(code: common.DiagnosticCode): common.Diagnostic {
		return {
			severity: "error",
			message: "This Diagnostic belongs to another buffer",
			code,
			notes: [],
			helps: [],
			position: name,
			labels: [
				{ position: name, message: "here", kind: "primary" },
				{ position: value, message: "and here", kind: "secondary" },
			],
		}
	}

	it("should offer nothing the buffer does not bear out", () => {
		let source = lines.join("\n")
		let range = {
			start: { line: 1, column: 1 },
			end: { line: lines.length, column: 2 },
		}
		let codes: Array<common.DiagnosticCode> = [
			"at-in-static-method",
			"contradictory-modifiers",
			"duplicate-key",
			"duplicate-modifier",
			"empty-dictionary-overlap",
			"empty-list-overlap",
			"infer-on-applied-parameter",
			"literal-match-shape",
			"unexpected-payload",
			"uninferred-namespace-parameter",
			"unknown-modifier",
			"where-on-protocol-extension",
		]

		let offered = codes.flatMap((code) =>
			findCodeActions(source, range, undefined, undefined, null, [
				stale(code),
			])
				.filter((entry) => entry.kind === "quickfix")
				.map((entry) => `${code}: ${entry.title}`),
		)

		expect(offered).toEqual([])
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

// NOTE: A refactoring is offered on code the Compiler is happy with, so every
// case below asserts the applied text against what the Compiler said BEFORE it
// — an extraction that type-checks is the whole of what makes it an extraction
// rather than an edit.
describe("Extract to a Constant", () => {
	// NOTE: By title rather than by kind alone — the two extractions share a
	// kind, and a selection that reads as both is a shape either of them may
	// meet.
	function extractions(
		lines: Array<string>,
		range: common.Position,
	): Array<CodeActionEntry> {
		return refactorsOf(lines, range, "refactor.extract").filter(
			(entry) => entry.title === "Extract to a Constant",
		)
	}

	it("lifts the Expression the selection sits in above its Statement", () => {
		let lines = [
			"implementation {",
			"\tfunction report(_ order: { price: Integer }) -> String {",
			"\t\t<- order.price::toString()",
			"\t}",
			"}",
		]

		let [action] = extractions(lines, rangeOf(lines, "order.price"))
		let result = applied(lines, action)

		expect(action.title).toBe("Extract to a Constant")
		expect(action.isPreferred).toBe(false)

		expect(result).toEqual([
			"implementation {",
			"\tfunction report(_ order: { price: Integer }) -> String {",
			"\t\tconstant price = order.price",
			"\t\t<- price::toString()",
			"\t}",
			"}",
		])

		expectRefactored(lines, result)
	})

	// NOTE: The selection is a character short at either end, which is what
	// dragging over a name actually produces — the Node it points at is the
	// same one, and answering with nothing would be answering about the mouse.
	it("answers with the Expression a partial selection sits inside", () => {
		let lines = [
			"implementation {",
			"\tconstant scores = [1, 2, 3]",
			"\tconstant highest = scores::highestItem(defaultingTo 0)",
			"}",
		]

		let [action] = extractions(lines, rangeOf(lines, "highestItem"))

		expect(applied(lines, action)).toEqual([
			"implementation {",
			"\tconstant scores = [1, 2, 3]",
			"\tconstant highestItem = scores::highestItem(defaultingTo 0)",
			"\tconstant highest = highestItem",
			"}",
		])
	})

	it("numbers the derived name when the Scope already has it", () => {
		let lines = [
			"implementation {",
			"\tconstant price = 1",
			"\tconstant order = { price = 2 }",
			"\tconstant doubled = order.price::multiply(with 2)",
			"}",
		]

		let [action] = extractions(lines, rangeOf(lines, "order.price"))
		let result = applied(lines, action)

		expect(result[3]).toBe("\tconstant price2 = order.price")
		expectRefactored(lines, result)
	})

	// NOTE: Both halves of a whole Match travel together — the binder a Handler
	// introduces is declared inside what is being lifted, so it is in scope
	// wherever the Constant lands.
	it("lifts a whole Match, binders and all", () => {
		let lines = [
			"implementation {",
			"\tfunction describe(_ score: Optional<Integer>) -> String {",
			"\t\t<- match score -> String {",
			"\t\t\tcase #Value(item) { <- item::toString() }",
			'\t\t\tcase #Empty { <- "none" }',
			"\t\t}",
			"\t}",
			"}",
		]

		let [action] = extractions(
			lines,
			rangeFrom(lines, "match score", "\t\t}"),
		)
		let result = applied(lines, action)

		expect(result).toEqual([
			"implementation {",
			"\tfunction describe(_ score: Optional<Integer>) -> String {",
			"\t\tconstant value = match score -> String {",
			"\t\t\tcase #Value(item) { <- item::toString() }",
			'\t\t\tcase #Empty { <- "none" }',
			"\t\t}",
			"\t\t<- value",
			"\t}",
			"}",
		])

		expectRefactored(lines, result)
	})

	it("carries the command that opens rename on the name it invented", () => {
		let lines = [
			"implementation {",
			"\tfunction report(_ order: { price: Integer }) -> String {",
			"\t\t<- order.price::toString()",
			"\t}",
			"}",
		]

		let [action] = extractions(lines, rangeOf(lines, "order.price"))

		expect(action.command).toEqual({
			title: "Rename",
			command: "essence.renameAt",
			// NOTE: Zero based on both axes, and past the `constant ` the edit
			// writes in front of the name — the Position of the name as it will
			// stand once the edits have landed, which is the only Position the
			// Editor can act on.
			arguments: [DOCUMENT, { line: 2, character: 11 }],
		})
	})

	it("offers nothing for a name or a literal, which are named already", () => {
		let lines = [
			"implementation {",
			"\tconstant score = 1",
			"\tconstant copied = score",
			"}",
		]

		expect(extractions(lines, rangeOf(lines, "1"))).toEqual([])
		expect(
			extractions(lines, {
				start: { line: 3, column: 20 },
				end: { line: 3, column: 25 },
			}),
		).toEqual([])
	})

	// NOTE: An arm is read only when its Condition holds, and a Constant above
	// the Statement is read every time — lifting one out of the other changes
	// what the Program does, which is more than a refactoring may do.
	it("offers nothing for an Expression only one `define` arm reads", () => {
		let lines = [
			"implementation {",
			"\tconstant score = 1",
			"\tconstant label = define {",
			"\t\tas score::toString() if score::isGreaterThan(0)",
			'\t\tas "none" otherwise',
			"\t}",
			"}",
		]

		expect(extractions(lines, rangeOf(lines, "score::toString()"))).toEqual(
			[],
		)
	})

	it("offers nothing where the Statement does not open its line", () => {
		let lines = [
			"implementation {",
			"\tfunction describe(_ score: Integer) -> String {",
			"\t\t<- match score -> String {",
			"\t\t\tcase 0 { <- score::toString() }",
			'\t\t\tcase _ { <- "some" }',
			"\t\t}",
			"\t}",
			"}",
		]

		expect(extractions(lines, rangeOf(lines, "score::toString()"))).toEqual(
			[],
		)
	})

	it("offers nothing without a selection", () => {
		let lines = ["implementation {", "\tconstant total = 1::add(2)", "}"]

		expect(
			extractions(lines, {
				start: { line: 2, column: 19 },
				end: { line: 2, column: 19 },
			}),
		).toEqual([])
	})
})

describe("Inline a Constant", () => {
	function inlines(
		lines: Array<string>,
		range: common.Position,
	): Array<CodeActionEntry> {
		return refactorsOf(lines, range, "refactor.inline")
	}

	it("writes the value into every read and takes the declaration away", () => {
		let lines = [
			"implementation {",
			"\tfunction total(_ scores: List<Integer>) -> Integer {",
			"\t\tconstant fallback = 0::subtract(1)",
			"",
			"\t\t<- scores::highestItem(defaultingTo fallback)",
			"\t}",
			"}",
		]

		let [action] = inlines(lines, rangeOf(lines, "fallback = 0"))
		let result = applied(lines, action)

		expect(action.title).toBe("Inline 'fallback'")
		expect(action.isPreferred).toBe(false)

		expect(result).toEqual([
			"implementation {",
			"\tfunction total(_ scores: List<Integer>) -> Integer {",
			"",
			"\t\t<- scores::highestItem(defaultingTo 0::subtract(1))",
			"\t}",
			"}",
		])

		expectRefactored(lines, result)
	})

	// NOTE: A compound value is delimited by its own brackets, so it reads as
	// itself in front of a `::` — the grammar has no precedence for an inline to
	// get wrong, and no parentheses to write if it had.
	it("writes a compound value in as it stands", () => {
		let lines = [
			"implementation {",
			'\tconstant base = { port = 1, host = "db" }',
			"\tconstant updated = { base with port = 2 }",
			"\tconstant port = updated.port",
			"}",
		]

		let [action] = inlines(lines, rangeOf(lines, "updated ="))
		let result = applied(lines, action)

		expect(result).toEqual([
			"implementation {",
			'\tconstant base = { port = 1, host = "db" }',
			"\tconstant port = { base with port = 2 }.port",
			"}",
		])

		expectRefactored(lines, result)
	})

	it("is offered from a read as well as from the declaration", () => {
		let lines = [
			"implementation {",
			"\tconstant limit: Integer = 10",
			"\tconstant doubled = limit::add(1)",
			"\tconstant halved = limit::subtract(1)",
			"}",
		]

		let [action] = inlines(lines, rangeOf(lines, "limit::add"))

		expect(applied(lines, action)).toEqual([
			"implementation {",
			"\tconstant doubled = 10::add(1)",
			"\tconstant halved = 10::subtract(1)",
			"}",
		])
	})

	// NOTE: The value moves DOWN into a Scope that declares the name it reads,
	// which is the one way copying an Expression quietly says something else.
	it("offers nothing where a read stands under a name that shadows one", () => {
		let lines = [
			"implementation {",
			"\tconstant factor = 2",
			"\tconstant scaled = factor::multiply(with 3)",
			"",
			"\tfunction scale(_ n: Integer) -> Integer {",
			"\t\tconstant factor = 10",
			"",
			"\t\t<- scaled::add(factor)",
			"\t}",
			"}",
		]

		expect(inlines(lines, rangeOf(lines, "scaled ="))).toEqual([])
	})

	it("offers nothing for an exported Constant", () => {
		let lines = [
			"implementation {",
			"\tconstant limit = 10",
			"\tconstant doubled = limit::add(1)",
			"}",
			"",
			"export {",
			"\tlimit",
			"\tdoubled",
			"}",
		]

		expect(inlines(lines, rangeOf(lines, "limit = 10"))).toEqual([])
	})

	it("offers nothing for a value that reads its position", () => {
		let lines = [
			"implementation {",
			"\tnamespace Doubling for Integer {",
			"\t\tdoubled() -> Integer {",
			"\t\t\tconstant twice = @::multiply(with 2)",
			"",
			"\t\t\t<- twice",
			"\t\t}",
			"\t}",
			"}",
		]

		expect(inlines(lines, rangeOf(lines, "twice ="))).toEqual([])
	})

	it("offers nothing for a bare Case or an empty List", () => {
		let lines = [
			"implementation {",
			"\tconstant missing: Optional<Integer> = #Empty",
			"\tconstant empty: List<Integer> = []",
			"\tconstant described = missing::value(defaultingTo 0)",
			"\tconstant counted = empty::length()",
			"}",
		]

		expect(inlines(lines, rangeOf(lines, "missing:"))).toEqual([])
		expect(inlines(lines, rangeOf(lines, "empty:"))).toEqual([])
	})

	// NOTE: A hole is inside a String Literal, and the Lexer ends that Literal
	// at the next `"` — so a value carrying one can not be written into a hole,
	// while every other value can.
	it("offers nothing for a value with a quote read inside a hole", () => {
		let lines = [
			"implementation {",
			'\tconstant name = "Ada"',
			'\tconstant greeting = "hello {name}"',
			"}",
		]

		expect(inlines(lines, rangeOf(lines, "name ="))).toEqual([])
	})

	it("writes a quoteless value into a hole", () => {
		let lines = [
			"implementation {",
			"\tconstant scores = [1, 2, 3]",
			"\tconstant counted = scores::length()",
			'\tconstant reported = "there are {counted}"',
			"}",
		]

		let [action] = inlines(lines, rangeOf(lines, "counted ="))
		let result = applied(lines, action)

		expect(result).toEqual([
			"implementation {",
			"\tconstant scores = [1, 2, 3]",
			'\tconstant reported = "there are {scores::length()}"',
			"}",
		])

		expectRefactored(lines, result)
	})

	it("offers nothing for a Constant nothing reads", () => {
		let lines = ["implementation {", "\tconstant unused = 1::add(2)", "}"]

		expect(inlines(lines, rangeOf(lines, "unused"))).toEqual([])
	})
})

describe("Extract to a Function", () => {
	function extractions(
		lines: Array<string>,
		range: common.Position,
	): Array<CodeActionEntry> {
		return refactorsOf(lines, range, "refactor.extract").filter(
			(entry) => entry.title === "Extract to a Function",
		)
	}

	it("writes a selection ending in a Return as a Function that answers it", () => {
		let lines = [
			"implementation {",
			"\tfunction report(_ scored: Integer, _ conceded: Integer) -> String {",
			"\t\tconstant total = scored::add(conceded)",
			"\t\tconstant doubled = total::multiply(with 2)",
			"",
			"\t\t<- doubled::toString()",
			"\t}",
			"}",
		]

		let [action] = extractions(
			lines,
			rangeFrom(lines, "constant total", "<- doubled::toString()"),
		)
		let result = applied(lines, action)

		expect(action.title).toBe("Extract to a Function")
		expect(action.isPreferred).toBe(false)

		expect(result).toEqual([
			"implementation {",
			"\tfunction report(_ scored: Integer, _ conceded: Integer) -> String {",
			"\t\t<- extracted(scored, conceded)",
			"\t}",
			"",
			"\tfunction extracted(_ scored: Integer, _ conceded: Integer) -> String {",
			"\t\tconstant total = scored::add(conceded)",
			"\t\tconstant doubled = total::multiply(with 2)",
			"",
			"\t\t<- doubled::toString()",
			"\t}",
			"}",
		])

		expectRefactored(lines, result)
	})

	// NOTE: The Position is measured against the text the edits produce, not
	// against the text they were computed from — the call site collapses the
	// selection onto one line, and the new Function moves up with it.
	it("carries the command that opens rename on the new Function", () => {
		let lines = [
			"implementation {",
			"\tfunction report(_ scored: Integer, _ conceded: Integer) -> String {",
			"\t\tconstant total = scored::add(conceded)",
			"",
			"\t\t<- total::toString()",
			"\t}",
			"}",
		]

		let [action] = extractions(
			lines,
			rangeFrom(lines, "constant total", "<- total::toString()"),
		)

		expect(action.command).toEqual({
			title: "Rename",
			command: "essence.renameAt",
			arguments: [DOCUMENT, { line: 5, character: 10 }],
		})

		expect(applied(lines, action)[5]).toBe(
			"\tfunction extracted(_ scored: Integer, _ conceded: Integer) -> String {",
		)
	})

	// NOTE: `{}` is the unit Type, and a Function answering it is called as a
	// Statement — which is what a selection that answers nothing becomes.
	it("writes a selection that answers nothing as a Function of unit Type", () => {
		let lines = [
			"implementation {",
			"\tfunction report(_ scored: Integer) -> Integer {",
			"\t\tTerminal.print(scored::toString())",
			'\t\tTerminal.print("done")',
			"",
			"\t\t<- scored",
			"\t}",
			"}",
		]

		let [action] = extractions(
			lines,
			rangeFrom(lines, "Terminal.print(scored", '"done")'),
		)
		let result = applied(lines, action)

		expect(result).toEqual([
			"implementation {",
			"\tfunction report(_ scored: Integer) -> Integer {",
			"\t\textracted(scored)",
			"",
			"\t\t<- scored",
			"\t}",
			"",
			"\tfunction extracted(_ scored: Integer) -> {} {",
			"\t\tTerminal.print(scored::toString())",
			'\t\tTerminal.print("done")',
			"\t}",
			"}",
		])

		expectRefactored(lines, result)
	})

	it("numbers the name when the Scope already has 'extracted'", () => {
		let lines = [
			"implementation {",
			"\tfunction extracted(_ n: Integer) -> Integer {",
			"\t\t<- n::add(1)",
			"\t}",
			"",
			"\tfunction report(_ scored: Integer) -> Integer {",
			"\t\t<- scored::add(2)",
			"\t}",
			"}",
		]

		let [action] = extractions(lines, rangeOf(lines, "<- scored::add(2)"))
		let result = applied(lines, action)

		expect(result[9]).toBe(
			"\tfunction extracted2(_ scored: Integer) -> Integer {",
		)
		expectRefactored(lines, result)
	})

	// NOTE: A Match Handler's body is a body like any other, and the `<-` that
	// ends it is the ARM's value — which is exactly the Type the extracted
	// Function then answers, so the call reads back into the arm unchanged.
	it("lifts Statements out of a Match Handler's body", () => {
		let lines = [
			"implementation {",
			"\tfunction describe(_ score: Integer) -> String {",
			"\t\t<- match score -> String {",
			"\t\t\tcase 0 {",
			"\t\t\t\tconstant label = score::toString()",
			"",
			"\t\t\t\t<- label",
			"\t\t\t}",
			'\t\t\tcase _ { <- "some" }',
			"\t\t}",
			"\t}",
			"}",
		]

		let [action] = extractions(
			lines,
			rangeFrom(lines, "constant label", "<- label"),
		)
		let result = applied(lines, action)

		expect(result).toEqual([
			"implementation {",
			"\tfunction describe(_ score: Integer) -> String {",
			"\t\t<- match score -> String {",
			"\t\t\tcase 0 {",
			"\t\t\t\t<- extracted(score)",
			"\t\t\t}",
			'\t\t\tcase _ { <- "some" }',
			"\t\t}",
			"\t}",
			"",
			"\tfunction extracted(_ score: Integer) -> String {",
			"\t\tconstant label = score::toString()",
			"",
			"\t\t<- label",
			"\t}",
			"}",
		])

		expectRefactored(lines, result)
	})

	// NOTE: What the selection declares travels with it, so a name it declares
	// and the Function goes on reading is a name the Function would lose.
	it("offers nothing when a name it declares is read after it", () => {
		let lines = [
			"implementation {",
			"\tfunction report(_ scored: Integer) -> String {",
			"\t\tconstant total = scored::add(1)",
			"",
			"\t\t<- total::toString()",
			"\t}",
			"}",
		]

		expect(extractions(lines, rangeOf(lines, "constant total"))).toEqual([])
	})

	// NOTE: The Function would have to declare the Variable again, under a name
	// that does not clash with the Parameter carrying its incoming value — which
	// is a rename nobody asked for. See the note at the top of the file.
	it("offers nothing when it writes a Variable declared above it", () => {
		let lines = [
			"implementation {",
			"\tfunction report(_ scored: Integer) -> Integer {",
			"\t\tvariable total = 0",
			"",
			"\t\ttotal = total::add(scored)",
			"\t\ttotal = total::add(1)",
			"",
			"\t\t<- total",
			"\t}",
			"}",
		]

		expect(
			extractions(
				lines,
				rangeFrom(lines, "total = total::add(scored)", "total::add(1)"),
			),
		).toEqual([])
	})

	// NOTE: A Return that is not the last Statement answers the FUNCTION, and
	// inside the extracted one it would answer that instead.
	it("offers nothing for a Return in the middle of the selection", () => {
		let lines = [
			"implementation {",
			"\tfunction report(_ scored: Integer) -> Integer {",
			"\t\tif scored::isGreaterThan(0) {",
			"\t\t\t<- scored",
			"\t\t}",
			"",
			'\t\tTerminal.print("none")',
			"",
			"\t\t<- 0",
			"\t}",
			"}",
		]

		expect(
			extractions(
				lines,
				rangeFrom(lines, "if scored", 'Terminal.print("none")'),
			),
		).toEqual([])
	})

	// NOTE: A Method extracted beside a Method has to decide what `@` becomes,
	// and that decision changes what the extracted code means — so a Namespace
	// is turned away whether or not the selection reads `@` at all.
	it("offers nothing inside a Namespace", () => {
		let lines = [
			"implementation {",
			"\tnamespace Doubling for Integer {",
			"\t\tstatic base() -> Integer {",
			"\t\t\tconstant twice = 2",
			"",
			"\t\t\t<- twice::multiply(with 3)",
			"\t\t}",
			"\t}",
			"}",
		]

		expect(
			extractions(
				lines,
				rangeFrom(
					lines,
					"constant twice",
					"<- twice::multiply(with 3)",
				),
			),
		).toEqual([])
	})

	// NOTE: `@` inside a Match Handler is the value the arm caught, and a
	// Function written beside the Function is about nothing.
	it("offers nothing for a selection that reads its position", () => {
		let lines = [
			"implementation {",
			"\tfunction describe(_ score: Integer) -> String {",
			"\t\t<- match score -> String {",
			"\t\t\tcase 0 {",
			"\t\t\t\tconstant label = @::toString()",
			"",
			"\t\t\t\t<- label",
			"\t\t\t}",
			'\t\t\tcase _ { <- "some" }',
			"\t\t}",
			"\t}",
			"}",
		]

		expect(
			extractions(lines, rangeFrom(lines, "constant label", "<- label")),
		).toEqual([])
	})

	// NOTE: An assertion records against the test that is running, and a
	// Function called from a test body can not do that — the Enricher refuses
	// one written in a Function literal for the same reason.
	it("offers nothing for a selection holding an assertion", () => {
		let lines = [
			"implementation {",
			"\tfunction sum(_ a: Integer, _ b: Integer) -> Integer {",
			"\t\t<- a::add(b)",
			"\t}",
			"}",
			"",
			"tests {",
			"\tfunction check() -> {} {",
			"\t\texpect sum(1, 2)::is(3)",
			"\t\texpect sum(2, 3)::is(5)",
			"\t}",
			"}",
		]

		expect(
			extractions(lines, rangeFrom(lines, "expect sum(1, 2)", "::is(5)")),
		).toEqual([])
	})
})

describe("Write it as a table test", () => {
	function tables(
		lines: Array<string>,
		range: common.Position,
	): Array<CodeActionEntry> {
		return refactorsOf(lines, range, "refactor.rewrite").filter(
			(entry) => entry.title === "Write it as a table test",
		)
	}

	// NOTE: The whole test is the target, so a cursor anywhere in it offers
	// the rewrite — which is what the `test` keyword's own line is here.
	function onTheTest(lines: Array<string>, name: string): common.Position {
		let line = lines.findIndex((candidate) => candidate.includes(name)) + 1

		return { start: { line, column: 2 }, end: { line, column: 2 } }
	}

	it("collects repeated expectations into rows", () => {
		let lines = [
			"implementation {",
			"\tfunction sum(_ a: Integer, _ b: Integer) -> Integer {",
			"\t\t<- a::add(b)",
			"\t}",
			"}",
			"",
			"tests {",
			'\ttest "adds up" {',
			"\t\texpect sum(1, 2)::is(3)",
			"\t\texpect sum(2, 3)::is(5)",
			"\t}",
			"}",
		]

		let [action] = tables(lines, onTheTest(lines, '"adds up"'))
		let result = applied(lines, action)

		expect(action.kind).toBe("refactor.rewrite")
		expect(action.isPreferred).toBe(false)

		expect(result).toEqual([
			"implementation {",
			"\tfunction sum(_ a: Integer, _ b: Integer) -> Integer {",
			"\t\t<- a::add(b)",
			"\t}",
			"}",
			"",
			"tests {",
			'\ttest "adds up" across [',
			"\t\t{ a = 1, b = 2, expected = 3 },",
			"\t\t{ a = 2, b = 3, expected = 5 },",
			"\t] ({ a, b, expected }: { a: Integer, b: Integer, expected: Integer }) {",
			"\t\texpect sum(a, b)::is(expected)",
			"\t}",
			"}",
		])

		expectRefactored(lines, result)
	})

	// NOTE: A column takes its name from the Argument's label where there is
	// one, which is what makes a row read as the call did — at the price of the
	// label being written twice at the call itself.
	it("names a column after the label, and widens a Case to its Choice", () => {
		let lines = [
			"implementation {",
			"\tchoice Outcome {",
			"\t\tWin,",
			"\t\tLoss,",
			"\t}",
			"",
			"\tfunction outcomeOf(_ scored: Integer, against conceded: Integer) -> Outcome {",
			"\t\t<- define {",
			"\t\t\tas #Win if scored::isGreaterThan(conceded)",
			"\t\t\tas #Loss otherwise",
			"\t\t}",
			"\t}",
			"}",
			"",
			"tests {",
			'\ttest "scores" {',
			"\t\texpect outcomeOf(2, against 0)::is(#Win)",
			"\t\texpect outcomeOf(0, against 2)::is(#Loss)",
			"\t}",
			"}",
		]

		let [action] = tables(lines, onTheTest(lines, '"scores"'))
		let result = applied(lines, action)

		expect(result.slice(15)).toEqual([
			'\ttest "scores" across [',
			"\t\t{ a = 2, against = 0, expected = #Win },",
			"\t\t{ a = 0, against = 2, expected = #Loss },",
			"\t] ({ a, against, expected }: { a: Integer, against: Integer, expected: Outcome }) {",
			"\t\texpect outcomeOf(a, against against)::is(expected)",
			"\t}",
			"}",
		])

		expectRefactored(lines, result)
	})

	it("offers nothing for one expectation, or for two of different calls", () => {
		let lines = [
			"implementation {",
			"\tfunction sum(_ a: Integer, _ b: Integer) -> Integer {",
			"\t\t<- a::add(b)",
			"\t}",
			"",
			"\tfunction gap(_ a: Integer, _ b: Integer) -> Integer {",
			"\t\t<- a::subtract(b)",
			"\t}",
			"}",
			"",
			"tests {",
			'\ttest "adds up" {',
			"\t\texpect sum(1, 2)::is(3)",
			"\t}",
			"",
			'\ttest "does both" {',
			"\t\texpect sum(1, 2)::is(3)",
			"\t\texpect gap(3, 1)::is(2)",
			"\t}",
			"}",
		]

		expect(tables(lines, onTheTest(lines, '"adds up"'))).toEqual([])
		expect(tables(lines, onTheTest(lines, '"does both"'))).toEqual([])
	})

	// NOTE: A row holds a value and nothing else, so an Argument that reads a
	// name has nowhere to go — and an assertion that is not `::is(…)` says
	// something a column of expected values can not.
	it("offers nothing for an Argument that is not written out", () => {
		let lines = [
			"implementation {",
			"\tfunction sum(_ a: Integer, _ b: Integer) -> Integer {",
			"\t\t<- a::add(b)",
			"\t}",
			"}",
			"",
			"tests {",
			"\tconstant one = 1",
			"",
			'\ttest "adds up" {',
			"\t\texpect sum(one, 2)::is(3)",
			"\t\texpect sum(2, 3)::is(5)",
			"\t}",
			"",
			'\ttest "is bigger" {',
			"\t\texpect sum(1, 2)::isGreaterThan(1)",
			"\t\texpect sum(2, 3)::isGreaterThan(2)",
			"\t}",
			"}",
		]

		expect(tables(lines, onTheTest(lines, '"adds up"'))).toEqual([])
		expect(tables(lines, onTheTest(lines, '"is bigger"'))).toEqual([])
	})

	it("offers nothing for a column whose values are of two Types", () => {
		let lines = [
			"implementation {",
			"\tfunction describe(_ n: Number) -> String {",
			"\t\t<- n::toString()",
			"\t}",
			"}",
			"",
			"tests {",
			'\ttest "describes" {',
			'\t\texpect describe(1)::is("1")',
			'\t\texpect describe(1/2)::is("1/2")',
			"\t}",
			"}",
		]

		expect(tables(lines, onTheTest(lines, '"describes"'))).toEqual([])
	})

	it("offers nothing for a test that is already a table", () => {
		let lines = [
			"implementation {",
			"\tfunction sum(_ a: Integer, _ b: Integer) -> Integer {",
			"\t\t<- a::add(b)",
			"\t}",
			"}",
			"",
			"tests {",
			'\ttest "adds up" across [',
			"\t\t{ a = 1, b = 2, expected = 3 },",
			"\t\t{ a = 2, b = 3, expected = 5 },",
			"\t] ({ a, b, expected }: { a: Integer, b: Integer, expected: Integer }) {",
			"\t\texpect sum(a, b)::is(expected)",
			"\t}",
			"}",
		]

		expect(tables(lines, onTheTest(lines, '"adds up"'))).toEqual([])
	})
})
