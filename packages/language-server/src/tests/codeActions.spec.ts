import { describe, expect, it, spyOn } from "bun:test"
import * as path from "node:path"

import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import { format } from "@essence-lang/formatter"
import type { common, parser } from "@essence-lang/interfaces"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import { analyse, analyseDocument } from "../analyse"
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
import { missingMembersAction, suggestionAction } from "../codeActions/fixes"
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
import { mergeModifierAction } from "../codeActions/testFixes"
import { typedExpressionAt } from "../codeActions/typedLookups"
import * as spellableTypes from "../spellableTypes"
import { applyEdits } from "./textEdits"

// Fixtures are joined line arrays with literal `\t`, so an assertion on an
// inserted arm's indentation checks the exact characters.
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

// A misspelled Case reports beside whatever the misspelling did to the Types
// around it, so the fix is picked out by its code.
function unknownCaseFixes(lines: Array<string>): Array<CodeActionEntry> {
	return quickFixes(lines).filter(
		(entry) => entry.diagnosticCode === "unknown-case",
	)
}

// The buffer once the action is applied. An assertion on the text catches an
// off-by-one that an assertion on the range would encode.
function applied(lines: Array<string>, entry: CodeActionEntry): Array<string> {
	return applyEdits(lines.join("\n"), entry.edits).split("\n")
}

// What the Compiler makes of the buffer the action produced. An arm the fix
// scaffolds is empty, so a `missing-return` behind it is expected.
function codesOf(lines: Array<string>): Array<common.DiagnosticCode> {
	return analyse(lines.join("\n")).map((diagnostic) => diagnostic.code)
}

// The same, from a compile with the tests, as a Code Action request is
// answered. A build drops the `tests { … }` block and the codes inside it.
function testCodesOf(lines: Array<string>): Array<common.DiagnosticCode> {
	return analyse(lines.join("\n"), undefined, { tests: true }).map(
		(diagnostic) => diagnostic.code,
	)
}

// A span by what it points at. The fixtures are tab-indented, so a column
// counted by hand would be a fact about the whitespace.
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

// A Diagnostic as a debounced Editor hands one back, over a buffer edited
// since. Every fix reads its span back off the buffer before it writes, which
// only a stale span can test.
function staleDiagnostic(
	code: common.DiagnosticCode,
	position: common.Position,
	labels: Array<common.DiagnosticLabel> = [],
	data?: common.DiagnosticData,
): common.Diagnostic & { position: common.Position } {
	return {
		severity: "error",
		message: "",
		code,
		position,
		labels: [{ position, message: "", kind: "primary" }, ...labels],
		notes: [],
		helps: [],
		data,
	}
}

// A fix that writes code must write code the Formatter can read back as a
// whole Program. Null means the Formatter has nothing to say.
function refusalOf(lines: Array<string>): unknown {
	return format(lines.join("\n")).refusal
}

// The URI a refactoring hands its rename command. A path with no import or
// export block is analysed on its own, as every fixture here is.
const DOCUMENT = "file:///repo/Sample.es"

// The refactorings of one kind on a range in a document. An action that ends
// by opening rename needs a URI, which the other helpers do not pass.
function refactorsOf(
	lines: Array<string>,
	range: common.Position,
	kind: CodeActionEntry["kind"],
): Array<CodeActionEntry> {
	return findCodeActions(lines.join("\n"), range, DOCUMENT).filter(
		(entry) => entry.kind === kind,
	)
}

// A range spelled as the text it covers, so a fixture gaining a line breaks
// no assertion. The first line holding the text answers.
function rangeOf(lines: Array<string>, text: string): common.Position {
	let line = lines.findIndex((candidate) => candidate.includes(text)) + 1
	let column = (lines[line - 1] as string).indexOf(text) + 1

	return {
		start: { line, column },
		end: { line, column: column + text.length },
	}
}

// From the start of one span to the end of another, as a selection over
// several lines.
function rangeFrom(
	lines: Array<string>,
	from: string,
	to: string,
): common.Position {
	return { start: rangeOf(lines, from).start, end: rangeOf(lines, to).end }
}

// What the Compiler makes of a refactoring's result, with the tests section
// enriched, as `findCodeActions` reads a file.
function refactoredCodesOf(lines: Array<string>): Array<common.DiagnosticCode> {
	return analyse(lines.join("\n"), undefined, { tests: true }).map(
		(diagnostic) => diagnostic.code,
	)
}

// Every refactoring promises that the fixture compiles, that its result
// compiles, and that the Formatter accepts the result. Unlike a quick fix, a
// refactoring may leave no hole behind.
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

		// A Case Matcher takes no Type Arguments, so the Case is written as its
		// Choice declares it.
		it("should write an applied Choice's Case without its Type Arguments", () => {
			let lines = [
				"implementation {",
				"\tconstant maybe: Optional<Integer> = #Value(1)",
				"\tconstant described = match maybe -> String {",
				'\t\tcase #Value { <- "some" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Add missing Cases")
			expect(result[4]).toBe("\t\tcase Optional#Empty {}")
			expect(codesOf(result)).not.toContain("syntax-error")
			expect(codesOf(result)).not.toContain("missing-case")
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

		// A Match written on one line has no line to insert arms on, so the
		// fix opens one.
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

		// The fix writes the named Cases it can, and only the Signature falls
		// to the catch-all.
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

			// Exhaustive, with the catch-all last, since a `case _` before the
			// named arm would make it unreachable.
			expect(codesOf(result)).not.toContain("missing-case")
			expect(codesOf(result)).not.toContain("unreachable-case")
		})

		// A Matcher can not test a refinement's predicate, so the arm tests
		// the base, which covers the member.
		it("should write a refinement member as its base", () => {
			let lines = [
				"implementation {",
				"\tconstant rootTwo = 2::squareRoot()",
				"\tconstant described = match rootTwo -> String {",
				'\t\tcase Algebraic { <- "algebraic" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Add missing Cases")
			expect(result[4]).toBe("\t\tcase Integer {}")
			// Only the empty arm's hole is left.
			expect(codesOf(result)).toEqual(["missing-return"])
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

		// `{ kye }` names a member and binds `kye`, which the body reads. Writing
		// `{ key }` would leave every read naming nothing.
		it("should keep the name a Pattern member binds", () => {
			let lines = [
				"implementation {",
				"\tconstant point = { key = 1, other = 2 }",
				"\tconstant { kye } = point",
				"\tconstant doubled = kye::multiply(with 2)",
				"",
				"\tfunction first({ kye: Integer }: { key: Integer }) -> Integer {",
				"\t\t<- kye",
				"\t}",
				"}",
			]

			let [declared] = quickFixes(lines, spanOf(lines, 3, "kye"))
			let declaredResult = applied(lines, declared)

			expect(declared.title).toBe("Change to 'key as kye'")
			expect(declared.diagnosticCode).toBe("unknown-member")
			expect(declaredResult[2]).toBe("\tconstant { key as kye } = point")

			// An annotated member takes its binder after the Type.
			let [parameter] = quickFixes(
				declaredResult,
				spanOf(lines, 6, "kye"),
			)
			let result = applied(declaredResult, parameter)

			expect(result[5]).toBe(
				"\tfunction first({ key: Integer as kye }: { key: Integer }) -> Integer {",
			)
			expect(codesOf(result)).toEqual([])
		})

		// A Case Matcher's payload Pattern is offered the payload's member, and
		// the body still reads `radus`.
		it("should offer a Case payload's member for a misspelt Pattern member", () => {
			let lines = [
				"implementation {",
				"\tchoice Shape { Circle { radius: Integer }, Square { side: Integer } }",
				"",
				"\tfunction area(_ shape: Shape) -> Integer {",
				"\t\t<- match shape -> Integer {",
				"\t\t\tcase #Circle({ radus }) { <- radus }",
				"\t\t\tcase #Square({ side }) { <- side }",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.print(area(#Square({ side = 2 })))",
				"}",
			]

			let [fix] = quickFixes(lines, spanOf(lines, 6, "radus"))

			expect(fix?.title).toBe("Change to 'radius as radus'")
			expect(fix?.diagnosticCode).toBe("unknown-member")

			let result = applied(lines, fix!)

			expect(result[5]).toBe(
				"\t\t\tcase #Circle({ radius as radus }) { <- radus }",
			)
			expect(codesOf(result)).toEqual([])
		})

		// `{ kye, key }` would take `key` apart twice as `{ key as kye, key }`,
		// and `{ key, key }` would also unbind `kye`. A member with a binder
		// of its own is only a name, which the spelling fix may change.
		it("should offer nothing where the Pattern names the suggestion already", () => {
			let lines = [
				"implementation {",
				"\tconstant point = { key = 1, other = 2 }",
				"\tconstant { kye, key } = point",
				"\tconstant { kye as k } = point",
				"\tconstant total = kye::add(key)::add(k)",
				"}",
			]

			expect(quickFixes(lines, spanOf(lines, 3, "kye"))).toEqual([])

			let [named] = quickFixes(lines, spanOf(lines, 4, "kye"))

			expect(named.title).toBe("Change to 'key'")
			expect(applied(lines, named)[3]).toBe(
				"\tconstant { key as k } = point",
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

		// `add` and `pad` are two edits apart on three letters, and `noon` and
		// `loop` two on four. Neither pair is close enough for a spelling fix.
		it("should offer no spelling fix for a Method two edits away", () => {
			let lines = [
				"implementation {",
				"\tconstant primes = [2, 3, 5]",
				"\tconstant first = primes",
				"",
				"\tTerminal.print(first::add(1)::toString())",
				"}",
			]

			expect(titles(quickFixes(lines))).not.toContain("Change to 'pad'")
		})

		it("should offer no spelling fix for a Name two edits away", () => {
			let lines = [
				"implementation {",
				"\tnamespace Clock for Integer {",
				"\t\tstatic noon = 43_200",
				"",
				"\t\tisAfterNoon() -> Boolean {",
				"\t\t\t<- @::isGreaterThan(noon)",
				"\t\t}",
				"\t}",
				"}",
			]

			expect(titles(quickFixes(lines))).not.toContain("Change to 'loop'")
		})

		// What the fix writes instead: the Namespace the static is reached
		// through.
		it("should write the Namespace in front of its own static", () => {
			let lines = [
				"implementation {",
				"\tnamespace Clock for Integer {",
				"\t\tstatic noon = 43_200",
				"",
				"\t\tisAfterNoon() -> Boolean {",
				"\t\t\t<- @::isGreaterThan(noon)",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.print(50_000::isAfterNoon()::toString())",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Write 'Clock.noon' instead of 'noon'")
			expect(fix.diagnosticCode).toBe("unknown-name")
			expect(applied(lines, fix)[5]).toBe(
				"\t\t\t<- @::isGreaterThan(Clock.noon)",
			)
			expect(codesOf(applied(lines, fix))).toEqual([])
		})

		it("should write the receiver in front of a Method called bare", () => {
			let lines = [
				"implementation {",
				"\tnamespace Clock for Integer {",
				"\t\tisAfterNoon() -> Boolean { <- @::isGreaterThan(1) }",
				"",
				"\t\ttwice() -> Boolean {",
				"\t\t\t<- isAfterNoon()",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.print(50_000::twice()::toString())",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe(
				"Write '@::isAfterNoon' instead of 'isAfterNoon'",
			)
			expect(applied(lines, fix)[5]).toBe("\t\t\t<- @::isAfterNoon()")
			expect(codesOf(applied(lines, fix))).toEqual([])
		})

		// Which Namespace was meant is the reader's to settle, so the report
		// lists them and no fix writes one.
		it("should offer no fix where several Namespaces declare the static", () => {
			let lines = [
				"implementation {",
				"\tnamespace Clock for Integer { static noon = 1 }",
				"\tnamespace Watch for Integer { static noon = 2 }",
				"",
				"\tTerminal.print(noon::toString())",
				"}",
			]

			expect(
				quickFixes(lines).filter(
					(entry) => entry.diagnosticCode === "unknown-name",
				),
			).toEqual([])
		})

		// A reach written over a shorthand member's name would be refused as
		// `shorthand-on-path-key`, so the member is spelled out with the reach.
		it("should spell out the member where the name is a shorthand", () => {
			let lines = [
				"implementation {",
				"\tconstant r = { head }",
				"",
				"\tTerminal.inspect(r)",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Write 'head = Http.head' instead of 'head'")
			expect(applied(lines, fix)[1]).toBe(
				"\tconstant r = { head = Http.head }",
			)
			expect(codesOf(applied(lines, fix))).toEqual([])
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

		// The bare `#Case` spelling resolves through a different path in the
		// Enricher from the Choice-prefixed one.
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

		// The prefixed Matcher underlines the name rather than the whole
		// Matcher, so the fix writes over the name and keeps the prefix.
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

		// The near miss is drawn from the Choice the Parameter takes, so the fix
		// writes a Case that resolves.
		it("should suggest a Case from the Choice a Parameter takes", () => {
			let lines = [
				"implementation {",
				"\tTerminal.inspect(7/2::round(toward #Doun))",
				"}",
			]

			let [fix] = unknownCaseFixes(lines)

			expect(fix.title).toBe("Change to '#Down'")
			expect(applied(lines, fix)[1]).toBe(
				"\tTerminal.inspect(7/2::round(toward #Down))",
			)
			expect(codesOf(applied(lines, fix))).toEqual([])
		})

		// A guess is offered only when it is close.
		it("should offer nothing when no Case is close", () => {
			let lines = [
				"implementation {",
				"\tchoice Operation { Add, Subtract }",
				"\tconstant chosen: Operation = #Zzzzzzzz",
				"}",
			]

			expect(unknownCaseFixes(lines)).toEqual([])
		})

		// This fix is preferred, so a stale span is written over unasked. Each
		// span here lands on something that is not a whole name, and the fix
		// offers nothing.
		it("should stay silent where the span does not stand on a name", () => {
			let member = [
				"implementation {",
				'\tconstant person = { firstName = "Ada" }',
				"\tconstant name = person.firstNme",
				"}",
			]
			let method = [
				"implementation {",
				'\tconstant size = "Ada"::lenth()',
				"}",
			]
			let holding = [
				"implementation {",
				"\tchoice Operation { Add, Subtract }",
				"\tconstant chosen = Operation#Ad",
				"}",
			]
			let spelled = (
				lines: Array<string>,
				line: number,
				needle: string,
				suggestion: string,
			) =>
				suggestionAction(
					staleDiagnostic(
						"unknown-name",
						spanOf(lines, line, needle),
						[],
						{ kind: "suggestion", suggestion },
					),
					lines,
					(written) => written,
				)

			expect(spelled(member, 3, ".firstNme", "firstName")).toBeNull()
			expect(spelled(method, 2, "lenth(", "length")).toBeNull()
			expect(spelled(holding, 3, "#Ad", "Add")).toBeNull()
		})

		// A span one column short of its Node has a name character beside it.
		it("should stay silent where the span cuts a name in half", () => {
			let lines = [
				"implementation {",
				"\tnamespace Counter for Integer is Countble {",
				"\t\tcount() -> Integer { <- @ }",
				"\t}",
				"}",
			]

			expect(
				suggestionAction(
					staleDiagnostic(
						"unknown-protocol",
						spanOf(lines, 2, "Countbl"),
						[],
						{ kind: "suggestion", suggestion: "Countable" },
					),
					lines,
					(written) => written,
				),
			).toBeNull()
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

		// A `§§` block before the Declaration must not move the keyword span
		// into the Comment. The fix checks the source slice before it rewrites.
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
		// The Diagnostic fires on a Function literal's unannotated Parameter,
		// which takes its label from the expected signature. The label is all
		// that is wrong here, so the fixed buffer analyses clean.
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
		// A dropped binder leaves its reads unresolved, so `unknown-name` reports
		// beside it and the fix is picked out by its code.
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

		// The binder goes and every read of it becomes `@`, the same value.
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

		// A binder on a line of its own takes the line break and indentation
		// with it.
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

		// A nested Match rebinds `@` to its own scrutinee, so the whole action is
		// withheld rather than applied to some reads.
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

		// `@` in a Protocol's provided Method is the conformer.
		it("should offer nothing for a read inside a provided Method", () => {
			let lines = [
				...MATCHED,
				"\tconstant found = match p -> Integer {",
				"\t\tcase { x, y } as point {",
				"\t\t\tprotocol Placed {",
				"\t\t\t\tplace() -> Integer",
				"",
				"\t\t\t\tshifted() -> Integer {",
				"\t\t\t\t\t<- point.x",
				"\t\t\t\t}",
				"\t\t\t}",
				"",
				"\t\t\t<- point.y",
				"\t\t}",
				"",
				"\t\tcase String { <- 0 }",
				"\t}",
				"}",
			]

			expect(binderFixes(lines)).toEqual([])
		})

		// A Declaration of the same name in the body takes the reads after it.
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

		// A nested Match's scrutinee still reads the arm's `@`, so it is
		// rewritten like any other read.
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

	// The Warning offers two spellings and the fix applies one. The result
	// says which question it asks, so the Warning is gone.
	describe("ambiguous-case", () => {
		// Two Choices of the Program's own, so both actions leave a Program that
		// compiles. A generic Choice would leave `undecided-type-arguments`.
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

		// The Diagnostic underlines the name and stops short of the `#`, so the
		// Choice is written in front of the sigil.
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

		// A generic Choice's Type Arguments are the reader's to write. The
		// prefix settles the ambiguity, and what is left points at where the
		// Arguments go.
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

		// Two applications of one Choice differ only in their Type Arguments, so
		// each action writes its own.
		it("should write the Type Arguments of an applied candidate", () => {
			let lines = [
				"implementation {",
				"\tchoice Box<ItemType> { Full { item: ItemType }, Blank }",
				"",
				'\tconstant boxed: Box<Integer> | Box<String> = #Full("x")',
				"}",
			]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Prefix with 'Box<Integer>#'",
				"Prefix with 'Box<String>#'",
			])

			let result = applied(lines, fixes[1])

			expect(result[3]).toBe(
				'\tconstant boxed: Box<Integer> | Box<String> = Box<String>#Full("x")',
			)

			expect(codesOf(result)).toEqual([])
		})
	})

	describe("ambiguous-namespace", () => {
		// A Namespace of the Program's own ties with a Method `Orderable`
		// provides. One action each, in the order the notes name them, neither
		// preferred.
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

		// The specifier names the Protocol that provides the Method, since
		// `5::<Integer>isBetween(…)` names a Namespace that declares none.
		it("should name the providing Protocol for a provided Method", () => {
			let result = applied(TIED, quickFixes(TIED)[1])

			expect(result[7]).toBe(
				"\tconstant inside = 5::<Orderable>isBetween(1, and 9)",
			)

			expect(codesOf(result)).toEqual([])
		})

		// The `::` may sit on the receiver's next line, so the specifier is
		// written in front of the name.
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

		// An Argument carrying a payload is wrapped whole by two insertions at
		// the ends of the span.
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

		// The fix wraps in the receiver's Case, so a Program's own carrier gets
		// its own Case name.
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

		// A carrier holding one Type in two Cases offers one rewrite per Case,
		// since each asks a different question. The titles tell them apart.
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

		// The Parameter declares a label the call never wrote, so the label is
		// written in.
		it("should write a label the call left out", () => {
			let lines = [...SHOUT, '\tconstant said = shout("hi")', "}"]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Write 'about' before the value")
			expect(fix.isPreferred).toBe(true)
			expect(result[5]).toBe('\tconstant said = shout(about "hi")')

			expect(codesOf(result)).toEqual([])
		})

		// The wrong label is replaced, found by reading back from the value,
		// since an Argument's label has no Position.
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

		// A Parameter that takes no label has the written one removed, with the
		// space after it.
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

		// A label on a line of its own is found too, since line breaks are
		// whitespace.
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

		// With a Comment between the label and the value, what stands in front
		// of the value is not the label, so nothing is offered.
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
		// The Argument the Warning names goes with the comma in front of it. The
		// Warning is all that is wrong, so the fixed buffer analyses clean.
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

		// A fallback that is the only Argument has no comma to take, and the
		// brackets stay.
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

		// A fallback ahead of another Argument takes the comma after it, or the
		// call would start with one.
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

		// The comma goes with its whitespace, so a call over several lines keeps
		// no line holding a lone comma.
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

		// `{}` is the hole, and the Argument stays refused until it is filled, so
		// the action is not preferred.
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

		// An empty Literal has no member to write a comma after, and the fix
		// writes the padding of a one-line Literal.
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

		// A Literal written over lines takes a line per member, indented as the
		// members already there.
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

		// A last member without a trailing comma is given one first.
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

		// Everything after a `§` is prose, so the scaffold goes in front of the
		// note rather than into it.
		it("should write in front of a trailing comment rather than into it", () => {
			let lines = [
				...CONNECT,
				"\tconstant opened = connect(using {",
				"\t\tretries = 1 § keep trying",
				"\t})",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result.slice(7, 12)).toEqual([
				"\tconstant opened = connect(using {",
				"\t\tretries = 1,",
				"\t\thost = {},",
				"\t\tport = {}, § keep trying",
				"\t})",
			])

			expect(codesOf(result)).toEqual(["argument-type-mismatch"])
		})

		// A comment on its own line last inside the Literal is not content
		// either. The members go after the last member, before the note.
		it("should walk back over a comment written on a line of its own", () => {
			let lines = [
				...CONNECT,
				"\tconstant opened = connect(using {",
				"\t\tretries = 1,",
				"\t\t§ more to come",
				"\t})",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result.slice(7, 13)).toEqual([
				"\tconstant opened = connect(using {",
				"\t\tretries = 1,",
				"\t\thost = {},",
				"\t\tport = {},",
				"\t\t§ more to come",
				"\t})",
			])

			expect(codesOf(result)).toEqual(["argument-type-mismatch"])
		})

		// A `§` inside a String is a character of the String, not the start of
		// prose.
		it("should read a comment sigil inside a String as text", () => {
			let lines = [
				"implementation {",
				"\ttype Options = { host: String, port: Integer, label: String }",
				"",
				'\tfunction connect(using options: Options = { label = "a" }) -> Integer {',
				"\t\t<- options.port",
				"\t}",
				"",
				"\tconstant opened = connect(using {",
				'\t\tlabel = "a § b",',
				"\t})",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result.slice(8, 11)).toEqual([
				'\t\tlabel = "a § b",',
				"\t\thost = {},",
				"\t\tport = {},",
			])
		})

		// A span that has slid into a comment names a `{` the buffer no longer
		// holds, so nothing is offered.
		it("should refuse a span that now stands inside a comment", () => {
			let lines = [
				...CONNECT,
				"\tconstant opened = connect(using § { retries = 1 })",
				"}",
			]

			expect(
				missingMembersAction(
					staleDiagnostic(
						"incomplete-record-argument",
						spanOf(lines, 8, "{ retries = 1 }"),
						[],
						{ kind: "missing-members", names: ["host", "port"] },
					),
					lines,
				),
			).toBeNull()
		})

		// A Case's payload is measured against a default as an Argument is, and
		// takes the same scaffold.
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

	// A Record Literal's misspelled member reports as a mismatch at the
	// member's value. The fix finds the name in the parsed tree and writes over
	// it.
	describe("a misspelled Record member", () => {
		const STANDING = [
			"implementation {",
			"\ttype Standing = { played: Integer, points: Integer }",
			"",
		]

		it("should write the near miss over the name that was misspelled", () => {
			let lines = [
				...STANDING,
				"\tconstant blank: Standing = { played = 0, pointsFor = 0 }",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Change to 'points'")
			expect(fix.diagnosticCode).toBe("assignment-type-mismatch")
			expect(fix.isPreferred).toBe(true)

			let result = applied(lines, fix)

			expect(result[3]).toBe(
				"\tconstant blank: Standing = { played = 0, points = 0 }",
			)
			expect(codesOf(result)).toEqual([])
		})

		it("should answer an Argument the same way", () => {
			let lines = [
				...STANDING,
				"\tfunction total(_ standing: Standing) -> Integer {",
				"\t\t<- standing.points",
				"\t}",
				"",
				"\tconstant sum = total({ played = 1, pointsFor = 2 })",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Change to 'points'")
			expect(fix.diagnosticCode).toBe("argument-type-mismatch")
			expect(result[7]).toBe(
				"\tconstant sum = total({ played = 1, points = 2 })",
			)
			expect(codesOf(result)).toEqual([])
		})

		// An update's key the Record does not declare is refused, though width
		// subtyping admits an extra member elsewhere.
		it("should answer an update's key", () => {
			let lines = [
				...STANDING,
				"\tconstant base: Standing = { played = 0, points = 0 }",
				"\tconstant grown = { base with pointz = 1 }",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Change to 'points'")
			expect(fix.diagnosticCode).toBe("partial-type-mismatch")
			expect(result[4]).toBe(
				"\tconstant grown = { base with points = 1 }",
			)
			expect(codesOf(result)).toEqual([])
		})

		// A member that is no near miss of anything carries no suggestion, so
		// nothing is offered.
		it("should offer nothing for a member that is not a near miss", () => {
			expect(
				quickFixes([
					...STANDING,
					"\tconstant base: Standing = { played = 0, points = 0 }",
					"\tconstant grown = { base with elevation = 1 }",
					"}",
				]),
			).toEqual([])
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

			// Titled for the hole it leaves, since the report stays until the
			// branch is filled in.
			expect(fix.title).toBe("Add an else branch to fill in")
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

	describe("unexpected-token", () => {
		// The `}` that ended the implementation early is the one removed, and
		// the brace the reader wrote at the end closes the block again.
		it("should remove the '}' that closed the implementation early", () => {
			let lines = [
				"implementation {",
				"\tfunction answer() -> Integer {",
				"\t\t<- 42",
				"\t}}",
				"",
				"\tTerminal.print(answer())",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Remove the '}'")
			expect(fix.diagnosticCode).toBe("unexpected-token")

			let result = applied(lines, fix)

			expect(result[3]).toBe("\t}")
			expect(codesOf(result)).toEqual([])
		})

		// Moving Statements in is the reader's edit, so nothing is offered.
		it("should offer nothing for Statements written after the Program", () => {
			let lines = [
				"implementation {",
				"\tconstant answer = 42",
				"}",
				"",
				"constant other = 1",
			]

			expect(codesOf(lines)).toEqual(["unexpected-token"])
			expect(quickFixes(lines)).toEqual([])
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

		// The Diagnostic stands on the swallowing String's opening quote. The fix
		// reads the start off the first Label on a `"`. The quote lands where it
		// was forgotten, at the end of line 2.
		it("should close the String that swallowed the lines below it", () => {
			let lines = [
				"implementation {",
				'\tconstant greeting = "Hello',
				'\tconstant name = "Ada"',
				"",
				"\tTerminal.print(greeting)",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Add the missing '\"'")
			expect(fix.diagnosticCode).toBe("unclosed-string")

			let result = applied(lines, fix)

			expect(result[1]).toBe('\tconstant greeting = "Hello"')
			expect(result[2]).toBe('\tconstant name = "Ada"')
			expect(codesOf(result)).not.toContain("unclosed-string")
		})

		// In `"{\"a\": 1}"` the `{` opened a hole, and a quote is not what is
		// missing. The report says what to write instead.
		it("should withhold the quote where a '{' opened a hole", () => {
			let lines = [
				"implementation {",
				'\tconstant body = "{\\"a\\": 1}"',
				"\tTerminal.print(body)",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
		})

		// A quote in a hole opens a String of its own, so the quote is withheld.
		// Either fix can be the one meant, and each compiles where it fits.
		it("should escape the brace or end the hole where a quote stands in one", () => {
			let lines = [
				"implementation {",
				'\tconstant s = "a } b { c"',
				'\tconstant name = "Ada"',
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write '\\{' for the brace",
				"End the hole in front of the quote",
			])
			expect(fixes.every((fix) => !fix.isPreferred)).toBe(true)

			let escaped = applied(lines, fixes[0])

			expect(escaped[1]).toBe('\tconstant s = "a } b \\{ c"')
			expect(codesOf(escaped)).toEqual([])

			let named = [
				"implementation {",
				'\tconstant name = "Ada"',
				'\tconstant s = "Hello, {name"',
				"}",
			]
			let ended = applied(named, quickFixes(named)[1])

			expect(ended[2]).toBe('\tconstant s = "Hello, {name}"')
			expect(codesOf(ended)).toEqual([])
		})

		// A String Argument the hole holds closes on its own line, so the hole
		// is ended in front of the quote after it.
		it("should end the hole past a String Argument it holds", () => {
			let lines = [
				"implementation {",
				'\tconstant names = ["a", "b"]',
				'\tconstant s = "{names::join(with ", ")"',
				"\tTerminal.print(s)",
				"}",
			]
			let ended = applied(lines, quickFixes(lines)[1])

			expect(ended[2]).toBe('\tconstant s = "{names::join(with ", ")}"')
			expect(codesOf(ended)).toEqual([])
		})

		// A hole holding a name was meant, and the String is one quote short.
		it("should still close a String whose hole holds a name", () => {
			let lines = [
				"implementation {",
				'\tconstant name = "Ada"',
				'\tconstant greeting = "Hello, {name}',
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[2]).toBe('\tconstant greeting = "Hello, {name}"')
			expect(codesOf(result)).not.toContain("unclosed-string")
		})

		// An even number of forgotten quotes leaves nothing unterminated, so the
		// Parser reports it. It carries the same Labels, and applying the fix
		// twice closes both.
		it("should close each of a pair of Strings that swallowed a line", () => {
			let lines = [
				"implementation {",
				'\tconstant a = "one',
				'\tconstant b = "two',
				'\tconstant c = "three"',
				"",
				"\tTerminal.print(a)",
				"}",
			]

			let [first] = quickFixes(lines)

			expect(first.diagnosticCode).toBe("unclosed-string")

			let once = applied(lines, first)

			expect(once[1]).toBe('\tconstant a = "one"')

			let [second] = quickFixes(once)
			let twice = applied(once, second)

			expect(twice[2]).toBe('\tconstant b = "two"')
			expect(codesOf(twice)).toEqual([])
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

		// The backslash would escape the quote and leave the String open, so
		// nothing is offered.
		it("should stay silent behind an odd run of backslashes", () => {
			let lines = [
				"implementation {",
				'\tconstant greeting = "hello\\',
				"\tconstant other = 1",
				"}",
			]

			expect(titles(quickFixes(lines))).not.toContain(
				"Add the missing '\"'",
			)
		})

		// An even run is a written backslash and closes as any character does.
		it("should close a String ending in a written backslash", () => {
			let lines = [
				"implementation {",
				'\tconstant greeting = "hello\\\\',
				"\tconstant other = 1",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[1]).toBe('\tconstant greeting = "hello\\\\"')
			expect(codesOf(result)).not.toContain("unclosed-string")
		})

		// With CRLF endings the quote goes in front of the `\r`, or the carriage
		// return would join the String.
		it("should write the quote in front of a carriage return", () => {
			let lines = [
				"implementation {\r",
				'\tconstant greeting = "hello\r',
				"\tconstant other = 1\r",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[1]).toBe('\tconstant greeting = "hello"\r')
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

	// The fix writes the Diagnostic's own Help for each shape the Lexer spells
	// a rewrite for. Other shapes get nothing.
	describe("the Unicode escapes", () => {
		it("rebrackets the JavaScript habit", () => {
			let lines = [
				"implementation {",
				'\tconstant cafe = "caf\\u00e9"',
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual(["Write it as '\\u{e9}'"])
			expect(fixes[0].diagnosticCode).toBe("unbraced-unicode-escape")
			expect(fixes[0].isPreferred).toBe(true)
			expect(applied(lines, fixes[0])).toEqual([
				"implementation {",
				'\tconstant cafe = "caf\\u{e9}"',
				"}",
			])
			expect(codesOf(applied(lines, fixes[0]))).not.toContain(
				"unbraced-unicode-escape",
			)
		})

		// Both halves, in every spelling of a pair, with the applied buffer
		// checked again. The fix is preferred, so it must clear the code it
		// answers.
		it("writes a surrogate pair as the one character it spells", () => {
			for (let written of [
				'"\\uD83D\\uDE00"',
				'"\\u{D83D}\\u{DE00}"',
				'"\\uD83D\\u{DE00}"',
				'"\\u{D83D}\\uDE00"',
			]) {
				let lines = [
					"implementation {",
					`\tconstant face = ${written}`,
					"}",
				]
				let fixes = quickFixes(lines)

				expect([written, titles(fixes)]).toEqual([
					written,
					["Write it as '\\u{1F600}'"],
				])
				expect([written, applied(lines, fixes[0])]).toEqual([
					written,
					["implementation {", '\tconstant face = "\\u{1F600}"', "}"],
				])
				expect([written, codesOf(applied(lines, fixes[0]))]).toEqual([
					written,
					[],
				])
			}
		})

		it("drops the leading zeros off a seventh digit", () => {
			let lines = [
				"implementation {",
				'\tconstant a = "\\u{0000041}"',
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual(["Write it as '\\u{41}'"])
			expect(codesOf(applied(lines, fixes[0]))).not.toContain(
				"malformed-unicode-escape",
			)
		})

		it("closes an escape that was never closed", () => {
			let lines = ["implementation {", '\tconstant a = "\\u{1B"', "}"]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual(["Write it as '\\u{1B}'"])
			expect(applied(lines, fixes[0])).toEqual([
				"implementation {",
				'\tconstant a = "\\u{1B}"',
				"}",
			])
		})

		it("takes the 'U+' off a code point written by name", () => {
			let lines = ["implementation {", '\tconstant a = "\\u{U+1B}"', "}"]

			expect(titles(quickFixes(lines))).toEqual(["Write it as '\\u{1B}'"])
		})

		// A lone surrogate stands for no character, and a code point too large
		// asks which base was meant. Neither is offered a fix.
		it("offers nothing where no rewrite is an answer", () => {
			for (let written of ['"\\u{D800}"', '"\\u{110000}"', '"\\u{1G}"']) {
				let lines = [
					"implementation {",
					`\tconstant a = ${written}`,
					"}",
				]

				expect([written, titles(quickFixes(lines))]).toEqual([
					written,
					[],
				])
			}
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

		// The two answers differ in the Type the Literal ends up with, so
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

		// A third has no decimal that says it, and a rounded one would be
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

		// JSDoc writes `@param name - text`, so the fix replaces that hyphen
		// rather than adding a separator in front of it.
		it("should replace the hyphen another language separates with", () => {
			let lines = [
				"implementation {",
				"\t§§ @param subject - who to greet",
				"\tfunction greet (subject: String) -> String { <- subject }",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[1]).toBe("\t§§ @param subject — who to greet")
			expect(codesOf(result)).not.toContain(
				"missing-documentation-separator",
			)
		})

		// Only a run at the head of the text is that separator. A hyphen inside
		// the description is punctuation.
		it("should leave a hyphen inside the text where it stands", () => {
			let lines = [
				"implementation {",
				"\t§§ @param subject the well-known name",
				"\tfunction greet (subject: String) -> String { <- subject }",
				"}",
			]

			expect(applied(lines, quickFixes(lines)[0])[1]).toBe(
				"\t§§ @param subject — the well-known name",
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

		// Without a binding of the name the fix would write an undeclared
		// name, so the reader writes the value.
		it("should offer nothing where the name is bound to nothing", () => {
			let lines = [
				"implementation {",
				"\tconstant base = { port = 1, host = 2 }",
				"\tconstant updated = { base with port, host }",
				"}",
			]

			expect(codesOf(lines)).toEqual([
				"shorthand-in-combination",
				"shorthand-in-combination",
			])
			expect(quickFixes(lines)).toEqual([])
		})

		// A Dictionary's key is a value rather than a name, so a bare one is
		// short for nothing.
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

		// Without a binding of the last step's name the fix would write an
		// undeclared name, so the reader writes the value.
		it("should offer nothing where the last step names no binding", () => {
			let lines = [
				"implementation {",
				"\tconstant config = { server = { port = 1 }, name = 2 }",
				"\tconstant updated = { config with server.port, name = 5 }",
				"}",
			]

			expect(codesOf(lines)).toEqual(["shorthand-on-path-key"])
			expect(quickFixes(lines)).toEqual([])
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

			expect(fix.diagnosticCode).toBe("default-on-protocol-method")

			let result = applied(lines, fix)

			expect(result[2]).toBe("\t\ttrim(at side: Integer) -> Self")
			expect(codesOf(result)).not.toContain("default-on-protocol-method")
		})

		// A tab typed at the head of the line since the analysis. The span now
		// reads a brace opened and never closed, so nothing is offered.
		it("should stay silent where the span no longer closes what it opens", () => {
			let was = [
				"implementation {",
				"\tchoice Colour { Red = { a = 1 }, Green }",
				"}",
			]
			let now = [
				"implementation {",
				"\t\tchoice Colour { Red = { a = 1 }, Green }",
				"}",
			]

			expect(
				removeDefaultAction(
					staleDiagnostic(
						"case-default-without-payload",
						spanOf(was, 2, "{ a = 1 }"),
					),
					now,
				),
			).toBeNull()
		})

		// The same slip over a value with no brackets, where the span cuts a
		// number in half.
		it("should stay silent where the span cuts a name in half", () => {
			let was = [
				"implementation {",
				"\tchoice Colour { Red = 42, Green }",
				"}",
			]
			let now = [
				"implementation {",
				"\t\tchoice Colour { Red = 42, Green }",
				"}",
			]

			expect(
				removeDefaultAction(
					staleDiagnostic(
						"case-default-without-payload",
						spanOf(was, 2, "42"),
					),
					now,
				),
			).toBeNull()
		})

		// A default written over lines may carry a comment, and what goes
		// with the value goes with it.
		it("should remove a default whose value carries a comment", () => {
			let lines = [
				"implementation {",
				"\tchoice Colour {",
				"\t\tRed = {",
				"\t\t\t§ how red",
				"\t\t\ta = 1,",
				"\t\t},",
				"\t\tGreen,",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(result.slice(1, 5)).toEqual([
				"\tchoice Colour {",
				"\t\tRed,",
				"\t\tGreen,",
				"\t}",
			])
			expect(codesOf(result)).not.toContain(
				"case-default-without-payload",
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

		// The move writes whole lines, so a `define` on one line gets the
		// deletion alone. It takes the blank in front of the arm.
		it("should offer the deletion alone for a define written on one line", () => {
			let lines = [
				"implementation {",
				"\tconstant flag = true",
				"\tconstant grade = define { as 1 if flag as 0 otherwise as 2 if flag }",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(titles(quickFixes(lines))).toEqual(["Remove the arm"])
			expect(applied(lines, fix)[2]).toBe(
				"\tconstant grade = define { as 1 if flag as 0 otherwise }",
			)
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

			expect(fix.title).toBe("Add an 'otherwise' arm to fill in")
			expect(fix.diagnosticCode).toBe("define-without-otherwise")
			expect(fix.isPreferred).toBe(false)

			let result = applied(lines, fix)

			expect(result).toEqual([
				"implementation {",
				"\tconstant flag = true",
				"\tconstant grade = define {",
				"\t\tas 1 if flag",
				"\t\tas {} otherwise",
				"\t}",
				"}",
			])

			// The hole parses. `{}` is the unit value, visibly not an answer, and
			// refused wherever the position names a Type.
			expect(codesOf(result)).toEqual([])
		})

		// Where the `define` has a Type to answer, the arm is refused for
		// answering `{}`, which names what is missing.
		it("leaves a hole the Compiler reports where the Type is known", () => {
			let lines = [
				"implementation {",
				"\tfunction label(of score: Integer) -> String {",
				"\t\t<- define {",
				'\t\t\tas "high" if score::isGreaterThan(10)',
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(codesOf(applied(lines, fix))).toEqual([
				"return-type-mismatch",
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

		// A backwards search finds the last keyword before the cursor, and only
		// one with nothing but indentation in front of it counts.
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

	// `workspace.spec.ts` exercises the Module fixes over a real workspace.
	// These ask what each does with a buffer that has moved on.
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

		// The Diagnostic spans the whole Type Parameter and its bound, and only
		// the Keyword in front of it is the mistake.
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

	describe("uninferred-type-parameter", () => {
		it("should write the marker in front of a Function's Parameter", () => {
			let lines = [
				"implementation {",
				"\tfunction plain<Item>(_ item: Item) -> Item {",
				"\t\t<- item",
				"\t}",
				"",
				"\tTerminal.inspect(plain(5))",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Declare it as 'infer Item'")
			expect(fix.isPreferred).toBe(true)
			expect(result[1]).toBe(
				"\tfunction plain<infer Item>(_ item: Item) -> Item {",
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
			// The other reading changes the Signature and every call, so this is
			// not preferred.
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

		// The fix changes how the Method is called, so every call it does not
		// touch would stop compiling. It is not offered where this file calls the
		// Method.
		it("should stay silent where the Method is called", () => {
			let lines = [
				"implementation {",
				"\tnamespace Counters for { count: Integer } {",
				"\t\tstatic doubled () -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"",
				"\tconstant first = Counters.doubled()",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
			expect(
				analyse(lines.join("\n")).flatMap(
					(diagnostic) => diagnostic.helps,
				),
			).toEqual([
				"Take the value as a Parameter, or drop 'static' to make this an instance Method — then every call writes its receiver, 'value::name(…)' rather than 'Namespace.name(…)'.",
			])
		})

		// A Method of the same name on another Namespace is another Method.
		it("should offer the fix where the call names another Namespace", () => {
			let lines = [
				"implementation {",
				"\tnamespace Counters for { count: Integer } {",
				"\t\tstatic doubled () -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"",
				"\tnamespace Totals for { count: Integer } {",
				"\t\tstatic doubled () -> Integer {",
				"\t\t\t<- 2",
				"\t\t}",
				"\t}",
				"",
				"\tconstant first = Totals.doubled()",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual(["Drop 'static'"])
		})

		// `keywordBefore` looks along the name's own line, so a Keyword read
		// from the line before is left alone.
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

		// One Diagnostic per condition, and one edit removing the clause answers
		// them all, so the lightbulb offers it once.
		it("should answer every condition of the clause with one offer", () => {
			let lines = [
				"implementation {",
				"\tprotocol Sizeable is Equatable where Item is Comparable, Key is Equatable {",
				"\t\tsize () -> Integer",
				"\t}",
				"}",
			]

			let fixes = quickFixes(lines)
			let result = applied(lines, fixes[0])

			expect(titles(fixes)).toEqual(["Drop the 'where' clause"])
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

		// An update's key list is a bracket list on the same terms, since both
		// spellings build one Node kind.
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
			// The arm it writes is empty, so a `missing-return` stands until the
			// reader fills it in.
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

		// Several sites report at a Handler's Matcher, and only the primary
		// Label tells them apart. A Case that names no value gets no Guard fix.
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

			// Every Case that names a List is guarded, and the `case _` the
			// Guards make necessary is added, so no `missing-case` follows.
			expect(fix.title).toBe(
				"Guard the Cases with 'where @::hasItems()' and add a 'case _'",
			)
			expect(fix.isPreferred).toBe(false)
			expect(result[3]).toBe(
				'\t\tcase List<String> where @::hasItems() { <- "strings" }',
			)
			expect(result[4]).toBe(
				'\t\tcase List<Integer> where @::hasItems() { <- "integers" }',
			)
			expect(result[5]).toBe("\t\tcase _ {}")

			// The Warning is gone and no Error replaces it. The empty arm's hole
			// is left for the reader.
			expect(codesOf(result)).not.toContain("empty-list-overlap")
			expect(codesOf(result)).not.toContain("missing-case")
			expect(refusalOf(result)).toBeNull()
		})

		// A Match already ending in a wildcard gets no second `case _`, which
		// would be unreachable.
		it("should write no arm where the Match already ends in one", () => {
			let lines = [
				"implementation {",
				"\tconstant value: List<String> | List<Integer> = [1]",
				"\tconstant described = match value -> String {",
				'\t\tcase List<String> { <- "strings" }',
				'\t\tcase List<Integer> { <- "integers" }',
				'\t\tcase _ { <- "empty" }',
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Guard the Cases with 'where @::hasItems()'")
			expect(codesOf(result)).toEqual([])
		})

		// A Method Invocation's dispatch branches report the same Warning, with
		// the secondary Label at the receiver. There is no arm to edit.
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

			expect(fix.title).toBe(
				"Guard the Cases with 'where @::hasEntries()' and add a 'case _'",
			)
			expect(result[3]).toBe(
				'\t\tcase Dictionary<String, Integer> where @::hasEntries() { <- "one" }',
			)
			expect(result[4]).toBe(
				'\t\tcase Dictionary<Integer, String> where @::hasEntries() { <- "two" }',
			)
			expect(result[5]).toBe("\t\tcase _ {}")

			expect(codesOf(result)).not.toContain("empty-dictionary-overlap")
			expect(codesOf(result)).not.toContain("missing-case")
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

		// A literal belongs to the Modifier in front of it, so it goes with the
		// word.
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

		// The Formatter puts a Modifier on its own line under a `test "…"` head,
		// so the line goes with it.
		it("should take the line a Modifier stood alone on", () => {
			let lines = [
				"implementation {",
				"}",
				"tests {",
				'\ttest "ranks the table"',
				"\t\tslowly",
				"\t{",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Remove 'slowly'")
			expect(result).toEqual([
				"implementation {",
				"}",
				"tests {",
				'\ttest "ranks the table"',
				"\t{",
				"\t}",
				"}",
			])

			expect(testCodesOf(result)).toEqual([])
		})

		// `tagged slow focussed` reads as `tagged` and `slow(focussed)`, so the
		// typo is an Argument and the fix takes the word alone. The spelling is
		// offered first, and the removal is not preferred.
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
		// Neither is preferred, since the source does not say which was meant.
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

		// Every other Modifier says one thing, so nothing merges. The Enricher
		// keeps the first, and the edit removes the second.
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

		// Two spans that slid by the same column still agree, so agreement
		// proves nothing. Both now cover `ocused`.
		it("should stay silent where both spans have slid off their words", () => {
			let was = [
				"implementation {",
				"}",
				"tests {",
				'\t\ttest "ranks the table" focused focused {}',
				"}",
			]
			let now = [
				"implementation {",
				"}",
				"tests {",
				'\ttest "ranks the table" focused focused {}',
				"}",
			]
			let at = spanOf(was, 4, "focused focused").start.column
			let word = (column: number): common.Position => ({
				start: { line: 4, column },
				end: { line: 4, column: column + "focused".length },
			})

			expect(
				mergeModifierAction(
					staleDiagnostic("duplicate-modifier", word(at + 8), [
						{
							position: word(at),
							message: "",
							kind: "secondary",
						},
					]),
					now,
				),
			).toBeNull()
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

		// A static whose Parameters the Arguments already fill has nowhere for
		// the receiver, so only the other shape is offered, and preferred.
		it("should offer only the call the signature accepts", () => {
			let lines = [...BOXES, "\tconstant made = boxed::make(2)", "}"]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write 'Boxes.make(…)' without the value",
			])
			expect(fixes.map((entry) => entry.isPreferred)).toEqual([true])
		})

		// A static with a Parameter left over takes the receiver into it, and the
		// shape that drops the value is withheld.
		it("should pass the value as the first Argument", () => {
			let lines = [
				"implementation {",
				"\ttype Box = { v: Integer }",
				"",
				"\tnamespace Boxes for Box {",
				"\t\tstatic held(_ b: Box, _ v: Integer) -> Integer {",
				"\t\t\t<- v",
				"\t\t}",
				"\t}",
				"",
				"\tconstant boxed: Box = { v = 1 }",
				"\tconstant made = boxed::held(2)",
				"}",
			]

			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write 'Boxes.held(…)' passing the value",
			])
			expect(applied(lines, fixes[0])[10]).toBe(
				"\tconstant made = Boxes.held(boxed, 2)",
			)
			expect(codesOf(applied(lines, fixes[0]))).toEqual([])
		})

		it("should drop the receiver where the static does not take it", () => {
			let lines = [...BOXES, "\tconstant made = boxed::make(2)", "}"]
			let result = applied(lines, quickFixes(lines)[0])

			expect(result[10]).toBe("\tconstant made = Boxes.make(2)")

			expect(codesOf(result)).toEqual([])
		})

		// A call passing nothing needs no comma after the value.
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

		// The receiver's own text is never retyped. The two edits are written
		// around it.
		it("should carry a written receiver across untouched", () => {
			let lines = [
				"implementation {",
				"\ttype Box = { v: Integer }",
				"",
				"\tnamespace Boxes for Box {",
				"\t\tstatic held(_ b: Box, _ v: Integer) -> Integer {",
				"\t\t\t<- v",
				"\t\t}",
				"\t}",
				"",
				"\tconstant made = { v = 9 }::held(2)",
				"}",
			]

			expect(applied(lines, quickFixes(lines)[0])[9]).toBe(
				"\tconstant made = Boxes.held({ v = 9 }, 2)",
			)
		})

		// A refinement's predicate admits only Methods of `@` with literal
		// Arguments, so the static call the fix writes is refused there too.
		it("should offer no rewrite inside a refinement's predicate", () => {
			let lines = [
				"implementation {",
				"\tnamespace Sizes for Integer {",
				"\t\tstatic isSmall() -> Boolean {",
				"\t\t\t<- true",
				"\t\t}",
				"\t}",
				"",
				"\ttype Small = Integer where @::isSmall()",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
		})
	})

	describe("a Namespace's own Type Parameter", () => {
		// The bound goes on the Method the call stands in, since a bound on the
		// Namespace's declaration is refused.
		it("should bound the Method the call is written in", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for { items: List<Item> } {",
				"\t\tordered() -> List<Item> {",
				"\t\t\t<- @.items::sort()",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe(
				"Bound it for this Method: '<Item is Comparable>'",
			)
			expect(result[2]).toBe(
				"\t\tordered<Item is Comparable>() -> List<Item> {",
			)
			expect(codesOf(result)).toEqual([])
		})

		it("should add the bound beside the Method's own Parameters", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for { items: List<Item> } {",
				"\t\tordered<infer Other>(_ other: Other) -> List<Item> {",
				"\t\t\t<- @.items::sort()",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[2]).toBe(
				"\t\tordered<infer Other, Item is Comparable>(_ other: Other) -> List<Item> {",
			)
			expect(codesOf(result)).toEqual([])
		})

		it("should drop a re-declaration that carries no bound", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for List<Item> {",
				"\t\theld<Item>() -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe(
				"Drop 'Item' from this Method's Type Parameters",
			)
			expect(result[2]).toBe("\t\theld() -> Integer {")
			expect(codesOf(result)).toEqual([])
		})

		it("should drop the 'infer' a bound restates", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for List<Item> {",
				"\t\tordered<infer Item is Comparable>() -> List<Item> {",
				"\t\t\t<- @::sort()",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Write '<Item is Comparable>'")
			expect(result[2]).toBe(
				"\t\tordered<Item is Comparable>() -> List<Item> {",
			)
			expect(codesOf(result)).toEqual([])
		})

		// A restated `infer` with no bound has nothing to keep, so the edit
		// removes it.
		it("should drop a restated 'infer' that carries no bound", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for List<Item> {",
				"\t\theld<infer Item>() -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe(
				"Drop 'Item' from this Method's Type Parameters",
			)
			expect(result[2]).toBe("\t\theld() -> Integer {")
			expect(codesOf(result)).toEqual([])
		})

		// A list broken across lines puts the `<` on the line before the entry.
		// Every layout asks for the same edit, and `codesOf` checks the buffer
		// compiles.
		it("should drop a lone re-declaration written across lines", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for List<Item> {",
				"\t\theld<",
				"\t\t\tItem,",
				"\t\t>() -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[2]).toBe("\t\theld() -> Integer {")
			expect(codesOf(result)).toEqual([])
		})

		it("should drop the first of several written across lines", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for List<Item> {",
				"\t\theld<",
				"\t\t\tItem,",
				"\t\t\tinfer Other,",
				"\t\t>(_ other: Other) -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result.slice(2, 5)).toEqual([
				"\t\theld<",
				"\t\t\tinfer Other,",
				"\t\t>(_ other: Other) -> Integer {",
			])
			expect(codesOf(result)).toEqual([])
		})

		it("should drop the middle of several written across lines", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for List<Item> {",
				"\t\theld<",
				"\t\t\tinfer First,",
				"\t\t\tItem,",
				"\t\t\tinfer Other,",
				"\t\t>(_ first: First, _ other: Other) -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result.slice(2, 6)).toEqual([
				"\t\theld<",
				"\t\t\tinfer First,",
				"\t\t\tinfer Other,",
				"\t\t>(_ first: First, _ other: Other) -> Integer {",
			])
			expect(codesOf(result)).toEqual([])
		})

		it("should drop the last of several written across lines", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for List<Item> {",
				"\t\theld<",
				"\t\t\tinfer Other,",
				"\t\t\tItem,",
				"\t\t>(_ other: Other) -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result.slice(2, 5)).toEqual([
				"\t\theld<",
				"\t\t\tinfer Other,",
				"\t\t>(_ other: Other) -> Integer {",
			])
			expect(codesOf(result)).toEqual([])
		})

		it("should drop a lone re-declaration written with a trailing comma", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for List<Item> {",
				"\t\theld<Item,>() -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result[2]).toBe("\t\theld() -> Integer {")
			expect(codesOf(result)).toEqual([])
		})

		// The span this edit removes would take a Comment inside the `<…>`
		// along, so nothing is offered. The Help still says what to write.
		it("should withhold the drop where a Comment sits in the list", () => {
			let lines = [
				"implementation {",
				"\tnamespace Boxes<infer Item> for List<Item> {",
				"\t\theld<",
				"\t\t\t§ the receiver already says what Item is",
				"\t\t\tItem,",
				"\t\t>() -> Integer {",
				"\t\t\t<- 0",
				"\t\t}",
				"\t}",
				"",
				"\tTerminal.inspect(1)",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
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

		// The Diagnostic is reported at the call, and the edit lands on the
		// declaration found by the name the Compiler carried.
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

		// A Method's own list is a head like any other, and the innermost one
		// declaring the name answers.
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

		// `<infer T is A is P>` is not a spelling, and the Diagnostic cannot say
		// which bound to keep.
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

		// A concrete Type that conforms to nothing is asking for a
		// Namespace, which is a Declaration rather than an edit to a span.
		it("should offer nothing for a concrete Type", () => {
			let lines = [...SIZED, '\tconstant counted = total(["a"])', "}"]

			expect(quickFixes(lines)).toEqual([])
		})
	})

	describe("undeclared-conformance", () => {
		// The Diagnostic is reported at the Method, and the edit lands on the
		// Namespace head.
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

		// A conformance list is comma separated, so the new clause goes after
		// one already declared.
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
		// An undeclared Type Parameter is also `unknown-type` in the target
		// Type, so the fix is picked out by its code.
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

		// A target Type naming a Parameter the Generic list forgot. Declaring it
		// answers the `unknown-type` too, and the Namespace compiles.
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

		// A list that holds Parameters takes the new one after them, with
		// `infer`, since a Namespace's Type Parameters are all inferred.
		it("should write it into a Generic list already there", () => {
			let lines = [
				...BOXES,
				"\tnamespace Boxes<infer Item> for { item: Item, thing: Thing } is Sized where Thing is Sized {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"}",
			]

			let result = applied(lines, parameterFixes(lines)[0])

			expect(result[7]).toBe(
				"\tnamespace Boxes<infer Item, infer Thing> for { item: Item, thing: Thing } is Sized where Thing is Sized {",
			)

			expect(codesOf(result)).toEqual([])
		})

		it("should change a misspelt Type Parameter to the one it is closest to", () => {
			let lines = [
				...BOXES,
				"\tnamespace Boxes<infer Item> for Box<Item> is Sized where Itme is Sized {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"}",
			]

			let [fix] = parameterFixes(lines)
			let result = applied(lines, fix!)

			expect(fix?.title).toBe("Change to 'Item'")
			expect(result[7]).toBe(
				"\tnamespace Boxes<infer Item> for Box<Item> is Sized where Item is Sized {",
			)
			expect(codesOf(result)).toEqual([])
		})

		// Declared, a Parameter the target Type never names could not prove the
		// condition, so nothing offers to declare it.
		it("should offer no declaration where the target never names it", () => {
			let lines = [
				...BOXES,
				"\tnamespace Boxes<infer Item> for Box<Item> is Sized where Thing is Sized {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- 1",
				"\t\t}",
				"\t}",
				"}",
			]

			expect(parameterFixes(lines)).toEqual([])
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
			// The description is left empty for the reader, so the fix is not
			// preferred.
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

		// A tag's description runs until the next tag, so the line goes after
		// the previous tag's text and before the next tag.
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

		// The line and its description, which would otherwise read as prose of
		// the tag before it.
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

		// An `overload` block's tags are read by name, so a near miss is offered
		// before the removal.
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

		// An empty `§§` separates prose from tags, so it goes with the last tag.
		it("should take the stranded separator with the last tag", () => {
			let lines = [
				"implementation {",
				"\t§§ A price in whole cents.",
				"\t§§",
				"\t§§ @param amount — how much",
				"\ttype Cents = Integer",
				"",
				"\tconstant price: Cents = 495",
				"\tTerminal.inspect(price)",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result).toEqual([
				"implementation {",
				"\t§§ A price in whole cents.",
				"\ttype Cents = Integer",
				"",
				"\tconstant price: Cents = 495",
				"\tTerminal.inspect(price)",
				"}",
			])
			expect(codesOf(result)).toEqual([])
		})

		// It is kept where a tag still stands before the removal.
		it("should keep a separator that still separates something", () => {
			let lines = [
				"implementation {",
				"\t§§ Greets.",
				"\t§§",
				"\t§§ @param subject — who to greet",
				"\t§§ @param loudly — and how",
				"\tfunction greet(subject: String) -> String { <- subject }",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0])

			expect(result).toEqual([
				"implementation {",
				"\t§§ Greets.",
				"\t§§",
				"\t§§ @param subject — who to greet",
				"\tfunction greet(subject: String) -> String { <- subject }",
				"}",
			])
			expect(codesOf(result)).toEqual([])
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

		// A stored snapshot names an entry of the snapshot file, so the name
		// moves with it.
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

		// One action per name, none preferred, since the Diagnostic cannot say
		// which member the snapshot meant.
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

	// A moved block keeps its text byte for byte. Only the blank lines around
	// it are adjusted.
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

		// The block goes to the end, after the exports.
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

			// The specifier names no file, so only the graph complains.
			expect(codesOf(result)).not.toContain("misplaced-module-section")
		})

		// A Program holds one import block, so a second one's entries, with
		// the Comment before it, join the block written first.
		it("should merge an import block into the one above the implementation", () => {
			let lines = [
				"import {",
				'\tfrom "./Other.es" { thing }',
				"}",
				"",
				"implementation {",
				"\tconstant a = 1",
				"}",
				"",
				"§ the rest",
				"import {",
				'\tfrom "./More.es" {',
				"\t\tother",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe(
				"Move the entries into the 'import { … }' block above the implementation",
			)
			expect(result).toEqual([
				"import {",
				'\tfrom "./Other.es" { thing }',
				"\t§ the rest",
				'\tfrom "./More.es" {',
				"\t\tother",
				"\t}",
				"}",
				"",
				"implementation {",
				"\tconstant a = 1",
				"}",
			])
			expect(codesOf(result)).toEqual([])
		})

		it("should merge an export block into one written on one line", () => {
			let lines = [
				"export { a }",
				"",
				"implementation {",
				"\tconstant a = 1",
				"\tconstant b = 2",
				"}",
				"",
				"export { b }",
			]

			let result = applied(lines, quickFixes(lines)[0]!)

			expect(result).toEqual([
				"implementation {",
				"\tconstant a = 1",
				"\tconstant b = 2",
				"}",
				"",
				"export { b a }",
			])
			expect(codesOf(result)).toEqual([])
		})

		// A Comment set apart from the block after it is about the file, so the
		// import block goes after it.
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

		// A file with no blank lines gets none, since the move keeps the
		// spacing the block had.
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
			// Moving a Statement changes what it sees and what sees it, so it is
			// not preferred.
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

		// A `§§` block travels with the Statement it documents.
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

		// The same code covers a Property read from another's initialiser. The
		// Parser records no span for a Namespace member to move.
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

		it("should move a Statement whose call reaches the Namespace through a Function", () => {
			let lines = [
				"implementation {",
				"\tfunction total() -> Integer {",
				"\t\t<- Maths.zero",
				"\t}",
				"",
				"\tconstant sum = total()",
				"",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let result = applied(lines, fix)

			expect(fix.title).toBe("Move this Statement below 'Maths'")
			expect(result).toEqual([
				"implementation {",
				"\tfunction total() -> Integer {",
				"\t\t<- Maths.zero",
				"\t}",
				"",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"",
				"\tconstant sum = total()",
				"}",
			])

			expect(codesOf(result)).toEqual([])
		})

		// Moving the Namespace below itself would change nothing.
		it("should offer nothing for a Property reaching its own Namespace through a Function", () => {
			let lines = [
				"implementation {",
				"\tfunction total() -> Integer {",
				"\t\t<- Maths.zero",
				"\t}",
				"",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t\tstatic sum: Integer = total()",
				"\t}",
				"}",
			]

			expect(codesOf(lines)).toEqual(["use-before-declaration"])
			expect(titles(quickFixes(lines))).toEqual([])
		})

		it("should move a Variable's Declaration below the Namespace it names", () => {
			let lines = [
				"implementation {",
				"\tvariable total = Maths.zero",
				"",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"}",
			]

			let result = applied(lines, quickFixes(lines)[0]!)

			expect(result).toEqual([
				"implementation {",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"",
				"\tvariable total = Maths.zero",
				"}",
			])
			expect(codesOf(result)).toEqual([])
		})

		// Moved past `Terminal.print(total)`, the assignment would leave it
		// printing the Variable's first value.
		it("should offer nothing where moving an assignment would pass a read of its Variable", () => {
			let lines = [
				"implementation {",
				"\tvariable total = 1",
				"",
				"\ttotal = Maths.zero",
				"",
				"\tTerminal.print(total)",
				"",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"}",
			]

			expect(codesOf(lines)).toEqual(["use-before-declaration"])
			expect(titles(quickFixes(lines))).toEqual([])
		})

		// `Terminal.print(total)` would read the Variable above its Declaration.
		it("should offer nothing where a Statement it would pass reads the Variable it declares", () => {
			let lines = [
				"implementation {",
				"\tvariable total = Maths.zero",
				"",
				"\tTerminal.print(total)",
				"",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"}",
			]

			expect(codesOf(lines)).toEqual(["use-before-declaration"])
			expect(titles(quickFixes(lines))).toEqual([])
		})

		// `show` reads `v`, so `Terminal.print(show())` would run it above the
		// Declaration of `v`. The fix offers only the moves the Help offers.
		it("should offer nothing where a Statement it would pass runs a body that reads what it declares", () => {
			let lines = [
				"implementation {",
				"\tfunction useIt() -> Integer {",
				"\t\t<- Maths.zero",
				"\t}",
				"",
				"\tconstant v = useIt()",
				"",
				"\tTerminal.print(show())",
				"",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"",
				"\tfunction show() -> Integer {",
				"\t\t<- v",
				"\t}",
				"}",
			]

			expect(codesOf(lines)).toEqual(["use-before-declaration"])
			expect(titles(quickFixes(lines))).toEqual([])
		})

		// `Terminal.inspect(total)` would read `total` above its Declaration.
		it("should offer nothing where a Statement it would pass reads what it declares", () => {
			let lines = [
				"implementation {",
				"\tconstant total = Maths.zero",
				"",
				"\tTerminal.inspect(total)",
				"",
				"\tnamespace Maths {",
				"\t\tstatic zero: Integer = 0",
				"\t}",
				"}",
			]

			expect(codesOf(lines)).toEqual(["use-before-declaration"])
			expect(titles(quickFixes(lines))).toEqual([])
		})
	})

	// The stubs a Namespace owes, with the Protocol's signatures and empty
	// bodies. Each leaves a `missing-return` for the reader.
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
				"\t\ttoString() -> String {}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("nonconforming-namespace")
			expect(codesOf(result)).not.toContain("syntax-error")
			expect(refusalOf(result)).toBeNull()
		})

		// `Self` is written as the target Type was written. A Record Alias
		// resolves to its Record, so printing the Type would lose `Square`.
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

			// A blank line before the first stub, since the Namespace's members
			// already stand a line apart.
			expect(result.slice(9)).toEqual([
				"\tnamespace Square for Square is Shape {",
				"\t\tdescribe() -> String {",
				'\t\t\t<- "square"',
				"\t\t}",
				"",
				"\t\tarea() -> Integer {}",
				"",
				"\t\tscaled(by: Integer) -> Square {}",
				"",
				"\t\tstatic blank() -> Square {}",
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
				"\t\tname() -> String {}",
				"",
				"\t\ttitle() -> String {}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("nonconforming-namespace")
			expect(refusalOf(result)).toBeNull()
		})

		// `Equatable` requires `is` and provides `isNot`. A stub for the
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
				"\t\tis(_: Point) -> Boolean {}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("nonconforming-namespace")
			expect(refusalOf(result)).toBeNull()
		})

		// An `overload` requirement is a set, so the stub is the block with an
		// entry per Overload.
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
				"\t\t\t(by: Integer) -> Square {}",
				"",
				"\t\t\t(_: Integer, and: Integer) -> Square {}",
				"\t\t}",
				"",
				"\t\toverload static of {",
				"\t\t\t(_: Integer) -> Square {}",
				"",
				"\t\t\t() -> Square {}",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).not.toContain("nonconforming-namespace")
			expect(codesOf(result)).not.toContain("syntax-error")
			expect(refusalOf(result)).toBeNull()
		})

		// A Choice derives its own equality, so a Namespace that writes nothing
		// is right.
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

		// The same edit as a refactoring, since the Diagnostic underlines only
		// the clause's Protocol and a cursor on `namespace` is not there.
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
				"\t\ttoString() -> String {}",
			)
		})

		// `Shown` provides a `describe` answering any Number, which does not
		// fulfil `Sized`'s. An Integer answers both.
		let describing = (sized: string, shown: string): Array<string> => [
			"implementation {",
			"\tprotocol Sized {",
			`\t\tdescribe() -> ${sized}`,
			"\t}",
			"",
			"\tprotocol Shown {",
			`\t\tdescribe() -> ${shown} {`,
			"\t\t\t<- 1",
			"\t\t}",
			"\t}",
			"",
			"\tnamespace IntegerBoth for Integer is Sized, is Shown {",
			"\t}",
			"}",
		]

		it("should write a requirement another Protocol's body does not fulfil", () => {
			let lines = describing("Integer", "Number")
			let refactors = actionsOf(lines, {
				start: { line: 12, column: 2 },
				end: { line: 12, column: 11 },
			})

			expect(refactors.map((refactor) => refactor.title)).toEqual([
				"Implement 'Sized'",
			])
			expect(applied(lines, refactors[0]!)[12]).toBe(
				"\t\tdescribe() -> Integer {}",
			)
			expect(codesOf(applied(lines, refactors[0]!))).not.toContain(
				"nonconforming-namespace",
			)
		})

		// A `describe` answering a String would replace `Shown`'s without
		// fulfilling it, so the stub would be refused.
		it("should offer no stub another conformance would refuse", () => {
			let lines = describing("String", "Integer")

			expect(
				titles(actionsOf(lines)).filter((title) =>
					title.startsWith("Implement"),
				),
			).toEqual([])
			expect(
				titles(
					actionsOf(lines, {
						start: { line: 12, column: 2 },
						end: { line: 12, column: 11 },
					}),
				),
			).not.toContain("Implement 'Sized'")
		})

		// The tests block's `Sized` is another Protocol, in reach only
		// inside the tests, so the Namespace owes the implementation's `size`.
		it("should stub the Protocol the clause resolved to, not one of its name", () => {
			let lines = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"\t}",
				"",
				"\tnamespace IntegerSized for Integer is Sized {",
				"\t}",
				"}",
				"",
				"tests {",
				"\tprotocol Sized {",
				"\t\tweight() -> String",
				"\t}",
				"}",
			]

			let [fix] = quickFixes(lines)
			let [refactor] = actionsOf(lines, {
				start: { line: 6, column: 2 },
				end: { line: 6, column: 11 },
			})

			expect(fix.title).toBe("Implement 'Sized'")
			expect(applied(lines, fix)[6]).toBe("\t\tsize() -> Integer {}")
			expect(refactor.title).toBe("Implement 'Sized'")
			expect(applied(lines, refactor)[6]).toBe("\t\tsize() -> Integer {}")
		})

		// A Function Type prints as no annotation the Parser reads back,
		// so a stub written with one would not compile.
		it("should offer no stub for a requirement it can not spell", () => {
			let lines = [
				"implementation {",
				"\tprotocol Mapped {",
				"\t\tapply(_ step: (_ n: Integer) -> Integer) -> Integer",
				"\t}",
				"",
				"\tnamespace IntegerMapped for Integer is Mapped {",
				"\t}",
				"}",
			]

			expect(
				titles(actionsOf(lines)).filter((title) =>
					title.startsWith("Implement"),
				),
			).toEqual([])
		})

		// The refactoring is not offered on the clause, where the Quick Fix
		// already is.
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

	// The conformance a property test asks for, written beside its Type. What
	// it cannot draw it leaves out, so the value is visibly incomplete.
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

			// The conformance replaces the derivation, so the refusal is answered.
			// The member it could not draw is a reported hole.
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

		// A value without those members would not fit the Type, and a
		// refactoring writes no hole. The Quick Fix does.
		it("should offer no refactoring for a Type with a member it can not draw", () => {
			let lines = [
				"implementation {",
				"\ttype Crate = { items: List<String>, held: Optional<Integer>, count: Integer }",
				"}",
			]

			expect(refactoredCodesOf(lines)).toEqual([])
			expect(generatableActions(lines, 2, 8)).toEqual([])
		})

		// A Record or Choice this file declares is built in place, and a Type
		// that conforms already is drawn through its own Namespace. A value
		// that does not fit breaks where the Formatter breaks it, at any depth.
		it("should draw a member whose Type this file declares", () => {
			let lines = [
				"implementation {",
				"\ttype Tls = { enabled: Boolean }",
				"\tchoice Zone {",
				"\t\tInside,",
				"\t\tOutside { distance: Integer, tls: Tls },",
				"\t}",
				"",
				"\ttype Pin = { label: String }",
				"",
				"\tnamespace PinGeneratable for Pin is Generatable {",
				"\t\tstatic generate(from source: Randomness) -> Pin {",
				'\t\t\t<- { label = "pin" }',
				"\t\t}",
				"\t}",
				"",
				"\ttype Server = {",
				"\t\ttls: Tls,",
				"\t\tzone: Zone,",
				"\t\tpin: Pin,",
				"\t\tinline: { a: Integer, b: Rational },",
				"\t}",
				"}",
			]

			let [refactor] = generatableActions(lines, 16, 8)
			let result = applied(lines, refactor)

			expect(result.slice(22, 43)).toEqual([
				"\tnamespace ServerGeneratable for Server is Generatable {",
				"\t\tstatic generate(from source: Randomness) -> Server {",
				"\t\t\t<- {",
				"\t\t\t\ttls = { enabled = source::drawBoolean() },",
				"\t\t\t\tzone = source::pick(from [",
				"\t\t\t\t\tZone#Inside,",
				"\t\t\t\t\tZone#Outside({",
				"\t\t\t\t\t\tdistance = source::drawInteger(between 0, and 100),",
				"\t\t\t\t\t\ttls = { enabled = source::drawBoolean() },",
				"\t\t\t\t\t}),",
				"\t\t\t\t]),",
				"\t\t\t\tpin = PinGeneratable.generate(from source),",
				"\t\t\t\tinline = {",
				"\t\t\t\t\ta = source::drawInteger(between 0, and 100),",
				"\t\t\t\t\tb = source::drawRational(between 0/1, and 1/1),",
				"\t\t\t\t},",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			])

			expectRefactored(lines, result)
			expect(format(result.join("\n")).text).toBe(
				`${result.join("\n")}\n`,
			)
		})

		// The Compiler refuses a Type naming itself, and a buffer being typed
		// may hold one. Drawing `Tree` inside `Tree` would never end.
		it("should not draw a Type inside itself", () => {
			let lines = [
				"implementation {",
				"\ttype Pair = { left: Tree }",
				"\tchoice Tree { Leaf, Node { pair: Pair } }",
				"}",
			]

			expect(refactoredCodesOf(lines)).toContain(
				"recursive-type-declaration",
			)
			expect(generatableActions(lines, 2, 8)).toEqual([])
			expect(generatableActions(lines, 3, 10)).toEqual([])
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

		// A Case carrying a payload is built before it is picked, and the list
		// breaks where the Formatter would break it.
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
				"\t\t\t\tShape#Circle({",
				"\t\t\t\t\tradius = source::drawInteger(between 0, and 100),",
				"\t\t\t\t}),",
				"\t\t\t])",
				"\t\t}",
				"\t}",
				"}",
			])

			expect(codesOf(result)).toEqual([])
			expect(format(result.join("\n")).text).toBe(
				`${result.join("\n")}\n`,
			)
		})

		// The Formatter fills a List of Cases without payloads, as many to a
		// line as fit, rather than one to a line.
		it("should fill a broken List of Cases without payloads", () => {
			let lines = [
				"implementation {",
				"\tchoice Month {",
				"\t\tJanuary,",
				"\t\tFebruary,",
				"\t\tMarch,",
				"\t\tApril,",
				"\t\tMay,",
				"\t\tJune,",
				"\t\tJuly,",
				"\t\tAugust,",
				"\t}",
				"}",
			]

			let result = applied(lines, generatableActions(lines, 2, 9)[0])

			expect(result.slice(14, 19)).toEqual([
				"\t\t\t<- source::pick(from [",
				"\t\t\t\tMonth#January, Month#February, Month#March, Month#April,",
				"\t\t\t\tMonth#May, Month#June, Month#July, Month#August,",
				"\t\t\t])",
				"\t\t}",
			])
			expect(format(result.join("\n")).text).toBe(
				`${result.join("\n")}\n`,
			)
		})

		// The head and the signature break where the Formatter breaks them.
		it("should break a head too long for its line", () => {
			let medium = [
				"implementation {",
				"\ttype CustomerPreferences = { name: String }",
				"}",
			]
			let long = [
				"implementation {",
				"\ttype CustomerPreferencesForTheAccount = { name: String }",
				"}",
			]

			let mediumResult = applied(
				medium,
				generatableActions(medium, 2, 8)[0],
			)
			let longResult = applied(long, generatableActions(long, 2, 8)[0])

			expect(mediumResult.slice(3, 7)).toEqual([
				"\tnamespace CustomerPreferencesGeneratable for CustomerPreferences",
				"\t\tis Generatable",
				"\t{",
				"\t\tstatic generate(from source: Randomness) -> CustomerPreferences {",
			])
			expect(longResult.slice(3, 10)).toEqual([
				"\tnamespace CustomerPreferencesForTheAccountGeneratable",
				"\t\tfor CustomerPreferencesForTheAccount",
				"\t\tis Generatable",
				"\t{",
				"\t\tstatic generate(",
				"\t\t\tfrom source: Randomness,",
				"\t\t) -> CustomerPreferencesForTheAccount {",
			])

			for (let result of [mediumResult, longResult]) {
				expect(codesOf(result)).toEqual([])
				expect(format(result.join("\n")).text).toBe(
					`${result.join("\n")}\n`,
				)
			}
		})

		// `Signal#On({})` is refused as a payload `On {}` does not take.
		it("should write a Case whose payload declares no member bare", () => {
			let lines = [
				"implementation {",
				"\tchoice Signal { Off, On {} }",
				"}",
			]

			let result = applied(lines, generatableActions(lines, 2, 10)[0])

			expect(result[5]).toBe(
				"\t\t\t<- source::pick(from [Signal#Off, Signal#On])",
			)
			expectRefactored(lines, result)
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

		// `generate` takes only a source, so no Argument can fix a Type
		// Parameter, which `unreachable-conformance` refuses.
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

		it("should keep a literal's Parameter a name, not a label", () => {
			let lines = [
				"implementation {",
				'\tconstant loans = ["grace" = 1]',
				'\tconstant updated = loans::update(at "grace", with (count) { <- count::add(1) })',
				"}",
			]

			let refactor = actionsOf(lines).find(
				(entry) =>
					entry.title === "Add explicit Type annotation ': Integer'",
			) as CodeActionEntry

			expect(applied(lines, refactor)[2]).toBe(
				'\tconstant updated = loans::update(at "grace", with (_ count: Integer) { <- count::add(1) })',
			)
			expect(codesOf(applied(lines, refactor))).toEqual([])
		})

		// The title quotes the Hint's edit, not its label. An Alias the position
		// cannot resolve is shown by name and written as the shape.
		it("should quote the annotation it writes where the two differ", () => {
			let lines = [
				"implementation {",
				"	type Box = { a: Integer }",
				"",
				"	function make() -> Box {",
				"		<- { a = 1 }",
				"	}",
				"",
				"	function inner() -> Integer {",
				"		type Box = { b: String }",
				"",
				"		constant made = make()",
				'		constant own: Box = { b = "x" }',
				"",
				"		<- 1",
				"	}",
				"}",
			]

			let [refactor] = actionsOf(lines, {
				start: { line: 11, column: 1 },
				end: { line: 11, column: 1 },
			})

			expect(refactor.title).toBe(
				"Add explicit Type annotation ': { a: Integer }'",
			)
			expect(applied(lines, refactor)[10]).toBe(
				"\t\tconstant made: { a: Integer } = make()",
			)
		})

		// Spelling a Type is the costly part of a Hint, so a request for one
		// line spells that line's Types and no others.
		it("should spell only the Types of the lines the request covers", () => {
			let lines = [
				"implementation {",
				...Array.from(
					{ length: 40 },
					(_, index) => `\tconstant value${index} = "${index}"`,
				),
				"}",
			]
			let line = 12
			let annotations = (entries: Array<CodeActionEntry>) =>
				entries.filter((entry) =>
					entry.title.startsWith("Add explicit Type annotation"),
				)
			let spelling = spyOn(spellableTypes, "spellTypeAt")

			try {
				let narrow = annotations(
					actionsOf(lines, {
						start: { line, column: 1 },
						end: { line, column: 1 },
					}),
				)

				expect(spelling).toHaveBeenCalledTimes(1)
				expect(narrow.map((entry) => entry.title)).toEqual([
					"Add explicit Type annotation ': String'",
				])
				expect(
					applied(lines, narrow[0] as CodeActionEntry)[line - 1],
				).toBe('\tconstant value10: String = "10"')
				expect(narrow).toEqual(
					annotations(actionsOf(lines)).filter(
						(entry) => entry.edits[0]?.range.start.line === line,
					),
				)
			} finally {
				spelling.mockRestore()
			}
		})
	})

	// A Match scaffolded from the value under the cursor. Its arms are the
	// `missing-case` fix's arms, in the same spelling.
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

			// The `<- ` stays, and the Match answers with the Function's own
			// `-> String`.
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

		// A second arm for another application would be unreachable.
		it("should scaffold one arm for two applications of a Case", () => {
			let lines = [
				"implementation {",
				"\tchoice Box<Item> { Full { item: Item }, Empty }",
				"\tconstant boxed: Box<Integer> | Box<String> = Box<Integer>#Empty",
				"\tconstant described = boxed",
				"}",
			]

			let [refactor] = matchActions(lines, {
				start: { line: 4, column: 24 },
				end: { line: 4, column: 24 },
			})
			let result = applied(lines, refactor)

			expect(result.slice(3, 7)).toEqual([
				"\tconstant described = match boxed -> Box<Integer> | Box<String> {",
				"\t\tcase Box#Full {}",
				"\t\tcase Box#Empty {}",
				"\t}",
			])
			expect(codesOf(result)).not.toContain("unreachable-case")
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

		// A Matcher can not test a refinement's predicate. Two refinements of
		// one base share its arm, since a second would be unreachable.
		it("should scaffold a refinement member under its base", () => {
			let lines = [
				"implementation {",
				"\ttype Healthy = Integer where @::isGreaterThan(4)",
				"\ttype Depleted = Integer where @::isLessThan(5)",
				"",
				"\tfunction describe (level: Healthy | Depleted | Algebraic) -> String {",
				"\t\tconstant described = level",
				'\t\t<- ""',
				"\t}",
				"}",
			]

			let [refactor] = matchActions(lines, spanOf(lines, 6, "level"))
			let result = applied(lines, refactor)

			expect(result.slice(5, 9)).toEqual([
				"\t\tconstant described = match level -> Healthy | Depleted | Algebraic {",
				"\t\t\tcase Integer {}",
				"\t\t\tcase Algebraic {}",
				"\t\t}",
			])
			// Only the empty arms' hole is left.
			expect(codesOf(result)).toEqual(["missing-return"])
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

		// A value that is no Union has nothing to take apart.
		it("should offer nothing on a value that is no Union", () => {
			expect(
				matchActions(["implementation {", "\tconstant n = 1", "}"], {
					start: { line: 2, column: 15 },
					end: { line: 2, column: 15 },
				}),
			).toEqual([])
		})

		// A binding's value is a read the Compiler writes at the binder, so a
		// `match` there would land inside the Matcher.
		it("should offer nothing on a Pattern's binding", () => {
			let lines = [
				"implementation {",
				"\tfunction depth (nested: Optional<Optional<Integer>>) -> Integer {",
				"\t\t<- match nested -> Integer {",
				"\t\t\tcase #Value(inner) {",
				"\t\t\t\t<- 1",
				"\t\t\t}",
				"\t\t\tcase #Empty {",
				"\t\t\t\t<- 0",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
				"",
				"tests {",
				'\ttest "unwraps" {',
				"\t\tconstant nested: Optional<Optional<Integer>> = #Value(#Empty)",
				"\t\trequire #Value(inner) = nested",
				"\t}",
				"}",
			]

			expect(matchActions(lines, spanOf(lines, 4, "inner"))).toEqual([])
			expect(matchActions(lines, spanOf(lines, 17, "inner"))).toEqual([])
		})

		// A name carries its value's Type, but a `match` written before it
		// would break the declaration. A member's name scaffolds the whole read.
		it("should offer nothing on a name and match the read a member ends", () => {
			let lines = [
				"implementation {",
				"\tconstant maybe: Optional<Integer> = #Value(1)",
				"\tfunction unwrap (given: Optional<Integer>) -> Optional<Integer> {",
				"\t\t<- given",
				"\t}",
				"\tvariable current: Optional<Integer> = #Empty",
				"\tcurrent = maybe",
				"\tconstant holder = { held = maybe }",
				"\tconstant read = holder.held",
				"\tchoice Shape { Circle { radius: Integer }, Square }",
				"\tconstant made = Shape#Circle(1)",
				"}",
			]

			expect(matchActions(lines, spanOf(lines, 2, "maybe"))).toEqual([])
			expect(matchActions(lines, spanOf(lines, 3, "given"))).toEqual([])
			expect(matchActions(lines, spanOf(lines, 7, "current"))).toEqual([])
			expect(matchActions(lines, spanOf(lines, 11, "Shape"))).toEqual([])
			expect(
				titles(matchActions(lines, spanOf(lines, 9, "held"))),
			).toEqual(["Match on 'holder.held'"])
		})

		// The request must sit inside the Expression. A selection of the whole
		// file is about no Expression in particular.
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

	// The empty `§§` block a signature wants. Each `@param` line documents the
	// Parameter at its position and names it as the signature does, which the
	// Warnings check.
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

		// The label, never the internal name. A Parameter with no label is `_`
		// to the signature and the rule alike.
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

		// The `static` keyword stands before the name on the same line, and
		// the block goes before that line.
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

	// The Formatter does not switch between the two spellings, so this does.
	// Neither direction is offered in an update's key list.
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

		// `{ base with x }` merges the value `x`, so shortening the key list
		// would change the meaning.
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

	// The Enricher writes a path's Function literal, so both spellings reach
	// the pipeline as one Node. Both directions are offered only inside an
	// Argument, so each can turn the other back.
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

		// The directions are inverses, and every text either wrote is compiled,
		// since a broken rewrite would still round trip.
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

		// A path only reads members, so a call in the chain needs the literal.
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

		// An Argument is the position recognised without asking the Enricher
		// what it expected. A literal bound to an annotated name keeps its
		// spelling.
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

		// A path has nowhere to keep the Comment.
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

	// An if/else whose branches only answer is a definition by cases. Both
	// directions are offered, and a `define` needs a `-> Type` an if/else does
	// not.
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

		// A `<-` inside a Match Handler answers the Match, so a `define` standing
		// in for one carries the Match's `-> Type`.
		it("should answer the Match a Handler's define stands in", () => {
			let handler = [
				"implementation {",
				"\tchoice Colour { Red, Blue }",
				"",
				"\tfunction describe(_ colour: Colour, _ n: Integer) -> String {",
				"\t\tconstant flag = match colour -> Boolean {",
				"\t\t\tcase #Red {",
				"\t\t\t\tif n::isGreaterThan(0) {",
				"\t\t\t\t\t<- true",
				"\t\t\t\t} else {",
				"\t\t\t\t\t<- false",
				"\t\t\t\t}",
				"\t\t\t}",
				"\t\t\tcase #Blue { <- false }",
				"\t\t}",
				"",
				"\t\t<- flag::toString()",
				"\t}",
				"}",
			]
			let asDefine = [
				"implementation {",
				"\tchoice Colour { Red, Blue }",
				"",
				"\tfunction describe(_ colour: Colour, _ n: Integer) -> String {",
				"\t\tconstant flag = match colour -> Boolean {",
				"\t\t\tcase #Red {",
				"\t\t\t\t<- define -> Boolean {",
				"\t\t\t\t\tas true if n::isGreaterThan(0)",
				"\t\t\t\t\tas false otherwise",
				"\t\t\t\t}",
				"\t\t\t}",
				"\t\t\tcase #Blue { <- false }",
				"\t\t}",
				"",
				"\t\t<- flag::toString()",
				"\t}",
				"}",
			]

			expect(codesOf(handler)).toEqual([])
			expect(applied(handler, onlyRefactor(handler))).toEqual(asDefine)
			expect(codesOf(asDefine)).toEqual([])
			expect(applied(asDefine, onlyRefactor(asDefine))).toEqual(handler)
		})

		// One action rather than one per rung of an `else if` cascade.
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

		// A `define` takes its Type from its own annotation, copied from the
		// Function. A contextually typed literal wrote none to copy.
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

		// A later arm is read behind the complement of every earlier Condition,
		// as an `else` is. `separator::isEmpty()` proves the `NonEmptyString`
		// that `split` asks for either way.
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

		// The Function's annotation is copied as spelled, and one written over
		// several lines cannot go on the `define`'s line. Nothing is offered.
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

		// An arm has nowhere to keep a Comment between the Expressions this
		// moves.
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

		// A Condition written over several lines would land in a column nobody
		// chose.
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

	// A Case of exactly one member takes that member's value directly, and the
	// Enricher wraps it. Only the enriched Program says which was written.
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

		// The Enricher read this payload as the Case's whole Record, so
		// shortening it would change the value.
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

		// The shorthand has nowhere to keep a Comment inside the braces.
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

	// Only the standard library declares natives, so the document is analysed
	// as one of its files.
	describe("Rewrites in a native Method's default", () => {
		let lines = [
			"import {",
			'\tfrom "./Optional.es" { Optional }',
			"}",
			"",
			"declarations {",
			"\tchoice Holder {",
			"\t\tHeld { value: Integer },",
			"\t\tNothing,",
			"\t}",
			"",
			"\tnamespace Holder for Holder {}",
			"",
			"\tnamespace Defaults {",
			"\t\tstatic fallback() -> Optional<Integer>",
			"",
			"\t\tstatic run(with holder: Holder = #Held(1)) -> Integer",
			"",
			"\t\tstatic pick(from other: Optional<Integer> = Defaults.fallback()) -> Integer",
			"\t}",
			"}",
		]

		let actionsAt = (range: common.Position): Array<CodeActionEntry> =>
			findCodeActions(
				lines.join("\n"),
				range,
				path.join(STDLIB_DIRECTORY, "Defaults.es"),
			)

		it("should expand a payload written as a native Method's default", () => {
			let refactors = actionsAt(spanOf(lines, 16, "1")).filter((entry) =>
				entry.title.includes("payload"),
			)

			expect(titles(refactors)).toEqual([
				"Expand the payload to '{ value = … }'",
			])
			expect(applied(lines, refactors[0] as CodeActionEntry)[15]).toBe(
				"\t\tstatic run(with holder: Holder = #Held({ value = 1 })) -> Integer",
			)
		})

		it("should scaffold a Match on a native Method's default", () => {
			expect(
				titles(
					actionsAt(spanOf(lines, 18, "Defaults.fallback()")),
				).filter((title) => title.startsWith("Match on")),
			).toEqual(["Match on 'Defaults.fallback()'"])
		})
	})

	// The mirror of the `constant-reassignment` fix. The rename index records
	// every site that writes the name, so a Variable written only once is known.
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

		// An assignment inside a capturing Function literal is a write on the
		// same Declaration in the index.
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

		// The inner `total` is assigned and the outer one is not, so only the
		// outer one is offered.
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

		// A Pattern binds several names, and `variable` stands over the list.
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

		// The suggestion is the fix, so a Diagnostic with no suggestion gets
		// none.
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

	describe("method-called-with-dot", () => {
		it("should write the separator a Method is reached with", () => {
			let lines = [
				"implementation {",
				'\tconstant names = ["ada", "alan"]',
				"\tTerminal.print(names.length())",
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual(["Call it with '::'"])

			let result = applied(lines, fixes[0])

			expect(result[2]).toBe("\tTerminal.print(names::length())")
			expect(codesOf(result)).toEqual([])
		})

		// A member that was read gets the separator and the parentheses a call
		// needs.
		it("should write the call a member read never wrote", () => {
			let lines = [
				"implementation {",
				'\tconstant names = ["ada", "alan"]',
				"\tTerminal.print(names.length)",
				"}",
			]
			let fixes = quickFixes(lines)
			let result = applied(lines, fixes[0])

			expect(result[2]).toBe("\tTerminal.print(names::length())")
			expect(codesOf(result)).toEqual([])
		})

		// A Method that takes an Argument gets no fix, since `()` would be a
		// second refusal.
		it("should offer nothing where the Method takes an Argument", () => {
			let lines = [
				"implementation {",
				"\tconstant n = 1",
				"\tTerminal.print(n.add)",
				"}",
			]

			expect(titles(quickFixes(lines))).toEqual([])
		})
	})

	// A Record literal in Argument or payload position names only declared
	// members, and the fix takes the extra one out with its comma.
	describe("a Record literal member no Type declares", () => {
		let declarations = [
			"implementation {",
			"\ttype Server = { host: String, port: Integer }",
			"\ttype Options = { retries: Integer, host: String }",
			"\tfunction connect(using settings: Options = { retries = 3 }) -> Options {",
			"\t\t<- settings",
			"\t}",
			"\tfunction serve(_ server: Server) -> String {",
			"\t\t<- server.host",
			"\t}",
			"\tnamespace Servers for Server {",
			"\t\tbeside(_ other: Server) -> Boolean {",
			"\t\t\t<- true",
			"\t\t}",
			"\t}",
			"\tchoice Call {",
			'\t\tPost { server: String, body: String } = { server = "localhost" },',
			"\t}",
			'\tconstant base: Server = { host = "h", port = 1 }',
		]

		it.each([
			[
				'\tconstant call = Call#Post({ body = "x", draft = true })',
				'\tconstant call = Call#Post({ body = "x" })',
				"Remove 'draft'",
			],
			[
				'\tconstant options = connect(using { extra = 1, host = "z" })',
				'\tconstant options = connect(using { host = "z" })',
				"Remove 'extra'",
			],
			[
				'\tconstant beside = base::beside({ host = "h", port = 2, extra })',
				'\tconstant beside = base::beside({ host = "h", port = 2 })',
				"Remove 'extra'",
			],
		])("should remove the member from %s", (written, fixed, title) => {
			let lines = [...declarations, "\tconstant extra = 1", written, "}"]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([title])
			expect(applied(lines, fixes[0])).toEqual([
				...declarations,
				"\tconstant extra = 1",
				fixed,
				"}",
			])
			expect(codesOf(applied(lines, fixes[0]))).toEqual([])
		})

		it("should remove a nested member written on a line of its own", () => {
			let lines = [
				...declarations,
				"\tconstant host = serve({",
				'\t\thost = "h",',
				"\t\tport = 1,",
				"\t\textra = 2,",
				"\t})",
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual(["Remove 'extra'"])

			let result = applied(lines, fixes[0])

			expect(result.slice(declarations.length)).toEqual([
				"\tconstant host = serve({",
				'\t\thost = "h",',
				"\t\tport = 1,",
				"\t})",
				"}",
			])
			expect(codesOf(result)).toEqual([])
		})
	})

	describe("foreign-syntax", () => {
		it("should write the Keyword Essence declares a binding with", () => {
			let lines = [
				"implementation {",
				"\tconst price = 12",
				"\tTerminal.print(price)",
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write 'constant' instead of 'const'",
			])

			let result = applied(lines, fixes[0])

			expect(result[1]).toBe("\tconstant price = 12")
			expect(codesOf(result)).toEqual([])
		})

		// Both parentheses go, including across lines, and the value between
		// them stays as written.
		it("should remove the parentheses that group one value", () => {
			let lines = [
				"implementation {",
				"\tconstant items = [(1), 2]",
				"\tconstant total = (",
				"\t\titems::length()",
				"\t)",
				"\tTerminal.print(total)",
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Remove the parentheses",
				"Remove the parentheses",
			])
			expect(fixes.every((fix) => fix.isPreferred)).toBe(true)

			let once = applied(lines, fixes[0])
			let result = applied(once, quickFixes(once)[0])

			expect(result).toEqual([
				"implementation {",
				"\tconstant items = [1, 2]",
				"\tconstant total = ",
				"\t\titems::length()",
				"\t",
				"\tTerminal.print(total)",
				"}",
			])
			expect(codesOf(result)).toEqual([])
		})

		it("should write the arrow a value leaves through", () => {
			let lines = [
				"implementation {",
				"\tfunction twice(_ n: Integer) -> Integer {",
				"\t\treturn n::multiply(with 2)",
				"\t}",
				"\tTerminal.print(twice(2))",
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual(["Write '<-' instead of 'return'"])
			expect(applied(lines, fixes[0])[2]).toBe(
				"\t\t<- n::multiply(with 2)",
			)
		})

		it("should write the separator a Record member is written with", () => {
			let lines = [
				"implementation {",
				"\tconstant origin = { x: 0 }",
				"\tTerminal.print(origin.x)",
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual(["Write '=' instead of ':'"])

			let result = applied(lines, fixes[0])

			expect(result[1]).toBe("\tconstant origin = { x = 0 }")
			expect(codesOf(result)).toEqual([])
		})

		it("should remove a ';' rather than write anything in its place", () => {
			let lines = ["implementation {", '\tTerminal.print("hi");', "}"]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual(["Remove the ';'"])

			let result = applied(lines, fixes[0])

			expect(result[1]).toBe('\tTerminal.print("hi")')
			expect(codesOf(result)).toEqual([])
		})

		it("should write the sigil a Comment is written with", () => {
			let lines = ["implementation {", "\t// a note", "}"]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual(["Write '§' instead of '//'"])
			expect(applied(lines, fixes[0])[1]).toBe("\t§ a note")
		})

		it("should write the same sigil over a Comment written with a '#'", () => {
			let lines = [
				"implementation {",
				"\t# count the items",
				"\tconstant items = [1, 2, 3]",
				"\tTerminal.print(items)",
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual(["Write '§' instead of '#'"])

			let result = applied(lines, fixes[0])

			expect(result[1]).toBe("\t§ count the items")
			expect(codesOf(result)).toEqual([])
		})

		// The edit writes `variable` over both words of `let mut`.
		it("should write one Keyword over the two 'let mut' spells", () => {
			let lines = [
				"implementation {",
				"\tlet mut total = 0",
				"\ttotal = total::add(1)",
				"\tTerminal.print(total)",
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write 'variable' instead of 'let mut'",
			])

			let result = applied(lines, fixes[0])

			expect(result[1]).toBe("\tvariable total = 0")
			expect(codesOf(result)).toEqual([])
		})

		// A run that closed on its own quote is one edit. A run broken into
		// pieces by its holes is left to the reader.
		it("should write the quotes a String is written in", () => {
			let lines = [
				"implementation {",
				"\tconstant s = `Hello`",
				"\tTerminal.print(s)",
				"}",
			]
			let fixes = quickFixes(lines)

			expect(titles(fixes)).toEqual([
				"Write '\"Hello\"' instead of '`Hello`'",
			])

			let result = applied(lines, fixes[0])

			expect(result[1]).toBe('\tconstant s = "Hello"')
			expect(codesOf(result)).toEqual([])
		})

		// A habit whose answer is a restructuring rather than a substitution
		// gets no fix.
		it("should offer nothing where the answer is a shape", () => {
			expect(
				titles(
					quickFixes([
						"implementation {",
						"\tconstant n = true ? 1 : 2",
						"}",
					]),
				),
			).toEqual([])

			expect(
				titles(
					quickFixes([
						"implementation {",
						"\tconstant double = (n: Integer) => n",
						"}",
					]),
				),
			).toEqual([])

			expect(
				titles(
					quickFixes([
						"implementation {",
						'\tconstant user = { name = "Ada" }',
						'\tuser.name = "Grace"',
						"}",
					]),
				),
			).toEqual([])
		})
	})

	describe("a Case written without its sigil", () => {
		const LINES = [
			"implementation {",
			"\tchoice Light { Red, Green }",
			"\tconstant light: Light = Red",
			"\tTerminal.print(light::is(#Red))",
			"}",
		]

		// The Case comes before the near miss and the imports, since the
		// Compiler matched it to a Case in scope.
		it("should write the sigil in front of the name", () => {
			let fixes = quickFixes(LINES)

			expect(titles(fixes)[0]).toBe("Write '#Red' instead of 'Red'")

			let result = applied(LINES, fixes[0])

			expect(result[2]).toBe("\tconstant light: Light = #Red")
			expect(codesOf(result)).toEqual([])
		})

		// In a Record Literal's shorthand the name is the member as well as its
		// value, and `{ #Red }` does not parse.
		it("should spell the member out where the name is a shorthand", () => {
			// A Record holding a `Light` is Printable only where `Light` is, so
			// the `is Printable` lets the fixed Program compile.
			let lines = [
				"implementation {",
				"\tchoice Light { Red, Green }",
				"\tnamespace Lights for Light is Printable {}",
				"\tconstant lit = { Red }",
				"",
				"\tTerminal.print(lit::toString())",
				"}",
			]

			let [fix] = quickFixes(lines)

			expect(fix.title).toBe("Write 'Red = #Red' instead of 'Red'")

			let result = applied(lines, fix)

			expect(result[3]).toBe("\tconstant lit = { Red = #Red }")
			expect(codesOf(result)).toEqual([])
		})
	})
})

// The Server hands in Diagnostics this analysis did not produce, such as
// `similar-tags`. Every fix measures its edit against the live text, so a
// Diagnostic laid over an unrelated Constant gets nothing.
describe("A Diagnostic the analysis did not produce", () => {
	const lines = ["implementation {", "\tconstant count = 1", "}"]

	// `count` and the `1` beside it: a primary span, and a secondary for the
	// codes that point at a second place.
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
			"uninferred-type-parameter",
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

// A `define` holds Expressions and no body, so the refactor walk needs a case
// for it to reach a Record literal in an arm.
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

// The lookups a refactoring starts from. A selection names no Node, so both
// answer by containment.
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

	// Parsed without Diagnostics, since a recovered fixture has a shape nobody
	// wrote.
	function programOf(): parser.Program {
		let { program, diagnostics } = parseWithDiagnostics(lines.join("\n"))

		expect(diagnostics).toEqual([])

		return program
	}

	// A range spelled as the text it covers, so a fixture gaining a line
	// breaks no assertion.
	function spanOf(text: string): common.Position {
		let line = lines.findIndex((candidate) => candidate.includes(text)) + 1
		let column = (lines[line - 1] as string).indexOf(text) + 1

		return {
			start: { line, column },
			end: { line, column: column + text.length },
		}
	}

	// From the start of one span to the end of another, as a selection over
	// several lines.
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

		// The Return covers the same lines, and the Match is inside it.
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

		// The Method body around a Handler's body holds the range too. An
		// inserted Statement belongs in the innermost.
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

// A refactoring is offered on code the Compiler is happy with, and its result
// must type-check too.
describe("Extract to a Constant", () => {
	// By title, since the extractions share a kind.
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

	// A selection a character short at either end, as dragging produces,
	// still points at the same Node.
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

	// Only a standard library file may write `overload function`, and each
	// entry's body is a body like any other.
	it("lifts an Expression inside an entry of an overload function", () => {
		let lines = [
			"declarations {",
			"\toverload function combine {",
			"\t\t(first value: Integer) -> Integer {",
			"\t\t\t<- value::add(1)",
			"\t\t}",
			"\t}",
			"}",
		]

		let [action] = findCodeActions(
			lines.join("\n"),
			rangeOf(lines, "value::add(1)"),
			path.join(STDLIB_DIRECTORY, "Combine.es"),
		).filter((entry) => entry.title === "Extract to a Constant")

		expect(applied(lines, action)).toEqual([
			"declarations {",
			"\toverload function combine {",
			"\t\t(first value: Integer) -> Integer {",
			"\t\t\tconstant add = value::add(1)",
			"\t\t\t<- add",
			"\t\t}",
			"\t}",
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

	// A Handler's binder is declared inside what is lifted, so it stays in
	// scope.
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
			// Zero-based, and where the name stands once the edits have landed,
			// past the written `constant `.
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

	// An arm is read only when its Condition holds, so lifting its Expression
	// into a Constant would change what the Program does.
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

	// A branch reads `n` as the refinement its condition proved, and a
	// Constant holding the condition's answer proves nothing about `n`.
	it("offers nothing for a condition that narrows, or any of its conjuncts", () => {
		let lines = [
			"implementation {",
			"\tfunction doubled(_ n: NonZeroInteger) -> Integer {",
			"\t\t<- n::multiply(with 2)",
			"\t}",
			"",
			"\tfunction doubledOrZero(_ n: Integer) -> Integer {",
			"\t\tif n::isNot(0)::and(n::isLessThan(10)) {",
			"\t\t\t<- doubled(n)",
			"\t\t}",
			"",
			"\t\t<- 0",
			"\t}",
			"",
			"\tfunction shout(_ text: String) -> String {",
			"\t\tif text::isEmpty() {",
			'\t\t\t<- ""',
			"\t\t} else {",
			"\t\t\t<- exclaimed(text)",
			"\t\t}",
			"\t}",
			"",
			"\tfunction exclaimed(_ text: NonEmptyString) -> String {",
			'\t\t<- text::append("!")',
			"\t}",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])

		for (let condition of [
			"n::isNot(0)::and(n::isLessThan(10))",
			"n::isNot(0)",
			"n::isLessThan(10)",
			"text::isEmpty()",
		]) {
			expect(extractions(lines, rangeOf(lines, condition))).toEqual([])
		}
	})

	// `isAtLeast(5)` asks what its body asks, so the `if` narrows `n`. With
	// the body's call in a Constant it would ask nothing.
	it("offers nothing for the question a Method's whole body asks of `@`", () => {
		let lines = [
			"implementation {",
			"\ttype Stocked = Integer where @::isGreaterThanOrEqualTo(5)",
			"",
			"\tnamespace Stock for Integer {",
			"\t\tisAtLeast(_ count: Integer) -> Boolean {",
			"\t\t\t<- @::isGreaterThanOrEqualTo(count)",
			"\t\t}",
			"",
			"\t\tisBelow(_ count: Integer) -> Boolean {",
			"\t\t\t<- @::isGreaterThanOrEqualTo(count)::negate()",
			"\t\t}",
			"\t}",
			"",
			"\tfunction shipped(_ n: Stocked) -> Integer {",
			"\t\t<- n",
			"\t}",
			"",
			"\tfunction shippedOrNone(_ n: Integer) -> Integer {",
			"\t\tif n::isAtLeast(5) {",
			"\t\t\t<- shipped(n)",
			"\t\t}",
			"",
			"\t\t<- 0",
			"\t}",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(
			extractions(
				lines,
				spanOf(lines, 6, "@::isGreaterThanOrEqualTo(count)"),
			),
		).toEqual([])
		expect(
			extractions(
				lines,
				spanOf(lines, 10, "@::isGreaterThanOrEqualTo(count)"),
			),
		).toEqual([])
		expect(
			extractions(
				lines,
				spanOf(lines, 10, "@::isGreaterThanOrEqualTo(count)::negate()"),
			),
		).toEqual([])
	})

	// Only a Method's own body, written to answer a `Boolean`, asks a
	// question: `doubled` answers an Integer, and `isSmall` asks in a branch.
	it("lifts a call on `@` from a body that asks no question", () => {
		let lines = [
			"implementation {",
			"\tnamespace Sizes for Integer {",
			"\t\tdoubled() -> Integer {",
			"\t\t\t<- @::multiply(with 2)",
			"\t\t}",
			"",
			"\t\tisSmall(_ flag: Boolean) -> Boolean {",
			"\t\t\tif flag {",
			"\t\t\t\t<- @::isLessThan(10)",
			"\t\t\t}",
			"",
			"\t\t\t<- false",
			"\t\t}",
			"\t}",
			"}",
		]

		let [doubled] = extractions(
			lines,
			rangeOf(lines, "@::multiply(with 2)"),
		)

		expect(applied(lines, doubled).slice(3, 5)).toEqual([
			"\t\t\tconstant multiply = @::multiply(with 2)",
			"\t\t\t<- multiply",
		])
		expectRefactored(lines, applied(lines, doubled))

		let [small] = extractions(lines, rangeOf(lines, "@::isLessThan(10)"))

		expectRefactored(lines, applied(lines, small))
	})

	// `limit` is no literal, so the condition proves nothing.
	it("lifts a condition that proves nothing", () => {
		let lines = [
			"implementation {",
			"\tfunction capped(_ n: Integer, _ limit: Integer) -> Integer {",
			"\t\tif n::isGreaterThan(limit) {",
			"\t\t\t<- limit",
			"\t\t}",
			"",
			"\t\t<- n",
			"\t}",
			"}",
		]

		let [action] = extractions(
			lines,
			rangeOf(lines, "n::isGreaterThan(limit)"),
		)
		let result = applied(lines, action)

		expect(result.slice(2, 4)).toEqual([
			"\t\tconstant isGreaterThan = n::isGreaterThan(limit)",
			"\t\tif isGreaterThan {",
		])
		expectRefactored(lines, result)
	})

	// `#Empty` resolves against the Type its position expects, and a Constant
	// with no written Type expects none. A Match writes its own.
	it("writes the Type a value holding a bare Case resolved against", () => {
		let lines = [
			"implementation {",
			"\tconstant held: List<Optional<Integer>> = [#Value(1), #Empty]",
			"",
			"\tfunction report(_ url: String) -> { url: String, code: Optional<Integer> } {",
			"\t\t<- { url, code = #Empty }",
			"\t}",
			"",
			"\tfunction checked(_ code: Integer) -> Optional<Integer> {",
			"\t\t<- match code -> Optional<Integer> {",
			"\t\t\tcase 0 { <- #Empty }",
			"\t\t\tcase _ { <- #Value(code) }",
			"\t\t}",
			"\t}",
			"}",
		]

		let [held] = extractions(lines, rangeOf(lines, "[#Value(1), #Empty]"))
		let [report] = extractions(
			lines,
			rangeOf(lines, "{ url, code = #Empty }"),
		)
		let [checked] = extractions(
			lines,
			rangeFrom(lines, "match code", "\t\t}"),
		)

		expect(applied(lines, held).slice(1, 3)).toEqual([
			"\tconstant value: List<Optional<Integer>> = [#Value(1), #Empty]",
			"\tconstant held: List<Optional<Integer>> = value",
		])
		expect(applied(lines, report).slice(4, 6)).toEqual([
			"\t\tconstant value: { url: String, code: Optional<Integer> } = { url, code = #Empty }",
			"\t\t<- value",
		])
		expect(applied(lines, checked)[8]).toBe(
			"\t\tconstant value = match code -> Optional<Integer> {",
		)

		for (let action of [held, report, checked]) {
			expectRefactored(lines, applied(lines, action))
		}
	})

	// The arrow is the Type `#Empty` resolves against.
	it("lifts a `define` that writes its answer Type", () => {
		let lines = [
			"implementation {",
			"\tfunction parsed(_ text: String) -> Optional<Integer> {",
			"\t\t<- define -> Optional<Integer> {",
			"\t\t\tas #Empty if text::isEmpty()",
			"\t\t\tas Integer.parse(text) otherwise",
			"\t\t}",
			"\t}",
			"}",
		]

		let [action] = extractions(
			lines,
			rangeFrom(lines, "define ->", "\t\t}"),
		)
		let result = applied(lines, action)

		expect(result[2]).toBe(
			"\t\tconstant value = define -> Optional<Integer> {",
		)
		expectRefactored(lines, result)
	})

	// `#Decimal` resolves against `toString`'s Parameter wherever the call
	// stands.
	it("lifts a call that passes a bare Case", () => {
		let lines = [
			"implementation {",
			"\tfunction rate(_ wins: Integer) -> String {",
			'\t\t<- wins::divide(by 1)::toString(as #Decimal, toPlaces 2)::append("%")',
			"\t}",
			"}",
		]

		let [action] = extractions(
			lines,
			rangeOf(
				lines,
				"wins::divide(by 1)::toString(as #Decimal, toPlaces 2)",
			),
		)
		let result = applied(lines, action)

		expect(result.slice(2, 4)).toEqual([
			"\t\tconstant toString = wins::divide(by 1)::toString(as #Decimal, toPlaces 2)",
			'\t\t<- toString::append("%")',
		])
		expectRefactored(lines, result)
	})

	// A Method taken as a value loses its defaults, and one with Protocol-bound
	// Type Parameters is refused as a value.
	it("offers nothing for a callee, but lifts the whole call", () => {
		let lines = [
			"implementation {",
			"\tnamespace Greeting for String {",
			'\t\tstatic greet(_ name: String, ending: String = "!") -> String {',
			"\t\t\t<- name::append(ending)",
			"\t\t}",
			"\t}",
			"",
			'\tTerminal.print(Greeting.greet("kim"))',
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(extractions(lines, rangeOf(lines, "Terminal.print"))).toEqual([])
		expect(extractions(lines, rangeOf(lines, "Greeting.greet"))).toEqual([])

		let [action] = extractions(
			lines,
			rangeOf(lines, 'Greeting.greet("kim")'),
		)
		let result = applied(lines, action)

		expect(result.slice(7, 9)).toEqual([
			'\tconstant greet = Greeting.greet("kim")',
			"\tTerminal.print(greet)",
		])
		expectRefactored(lines, result)
	})

	// `adder(1)` answers a Function value, which a Constant holds as it is.
	it("lifts a callee that a call answers", () => {
		let lines = [
			"implementation {",
			"\tfunction adder(_ n: Integer) -> (_ value: Integer) -> Integer {",
			"\t\t<- (_ x: Integer) -> Integer { <- x::add(n) }",
			"\t}",
			"",
			"\tconstant total = adder(1)(2)",
			"}",
		]

		let [action] = extractions(lines, rangeOf(lines, "adder(1)"))
		let result = applied(lines, action)

		expect(result.slice(5, 7)).toEqual([
			"\tconstant adder2 = adder(1)",
			"\tconstant total = adder2(2)",
		])
		expectRefactored(lines, result)
	})

	// `column = 1` and `"kim" = 7` would be written as a Constant's value,
	// which reads neither.
	it("offers nothing for the key list of a `with`", () => {
		let lines = [
			"implementation {",
			"\tfunction moved(_ cell: { row: Integer, column: Integer }) -> { row: Integer, column: Integer } {",
			"\t\t<- { cell with column = cell.column::add(1) }",
			"\t}",
			"",
			"\tfunction aged(_ ages: Dictionary<String, Integer>) -> Dictionary<String, Integer> {",
			'\t\t<- [ages with "kim" = 7]',
			"\t}",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(
			extractions(lines, rangeOf(lines, "column = cell.column::add(1)")),
		).toEqual([])
		expect(extractions(lines, rangeOf(lines, '"kim" = 7'))).toEqual([])
	})

	it("lifts a value out of the key list of a `with`", () => {
		let lines = [
			"implementation {",
			"\tfunction moved(_ cell: { row: Integer, column: Integer }) -> { row: Integer, column: Integer } {",
			"\t\t<- { cell with column = cell.column::add(1) }",
			"\t}",
			"}",
		]

		let [action] = extractions(lines, rangeOf(lines, "cell.column::add(1)"))
		let result = applied(lines, action)

		expect(result.slice(2, 4)).toEqual([
			"\t\tconstant add = cell.column::add(1)",
			"\t\t<- { cell with column = add }",
		])
		expectRefactored(lines, result)
	})

	// A path key reaches into a value the position supplies: the value being
	// updated, or a Parameter's default.
	it("offers nothing for a Record written with a path key", () => {
		let lines = [
			"implementation {",
			"\ttype Config = { server: { port: Integer, host: String } }",
			"",
			"\tfunction grouped(_ config: Config) -> Config {",
			'\t\t<- { config with server.{ port = 1, host = "db" } }',
			"\t}",
			"",
			'\tfunction serve(_ config: Config = { server = { port = 80, host = "web" } }) -> Integer {',
			"\t\t<- config.server.port",
			"\t}",
			"",
			"\tconstant port = serve({ server.port = 8080 })",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(
			extractions(lines, rangeOf(lines, '{ port = 1, host = "db" }')),
		).toEqual([])
		expect(
			extractions(lines, rangeOf(lines, "{ server.port = 8080 }")),
		).toEqual([])
	})

	// The brackets prove the List is not empty, which a name holding it does
	// not. The Constant writes the refinement the Parameter admitted it to.
	it("writes the refinement a Parameter admitted a written List to", () => {
		let lines = [
			"implementation {",
			"\tfunction first(_ items: NonEmptyList<Integer>) -> Integer {",
			"\t\t<- items::firstItem()",
			"\t}",
			"",
			"\tconstant one = first([1, 2])",
			"\tconstant mean = Number.average([1, 1/2])",
			"}",
		]

		let [admitted] = extractions(lines, rangeOf(lines, "[1, 2]"))
		let [chosen] = extractions(lines, rangeOf(lines, "[1, 1/2]"))

		expect(applied(lines, admitted).slice(5, 7)).toEqual([
			"\tconstant value: NonEmptyList<Integer> = [1, 2]",
			"\tconstant one = first(value)",
		])
		// The Overload taking a `NonEmptyList` answers a Rational, where the
		// one taking a List answers an Optional.
		expect(applied(lines, chosen)[6]).toBe(
			"\tconstant value: NonEmptyList<Scalar> = [1, 1/2]",
		)

		for (let action of [admitted, chosen]) {
			expectRefactored(lines, applied(lines, action))
		}
	})

	it("keeps the refinement a written receiver proved", () => {
		let lines = [
			"implementation {",
			"\tconstant mean = [1, 2]::average()",
			"\tconstant doubled = mean::multiply(with 2)",
			"}",
		]

		let [action] = extractions(lines, rangeOf(lines, "[1, 2]"))
		let result = applied(lines, action)

		expect(result.slice(1, 3)).toEqual([
			"\tconstant value: NonEmptyList<Integer> = [1, 2]",
			"\tconstant mean = value::average()",
		])
		expectRefactored(lines, result)
	})

	// A Constant annotated with the whole Record would lack the members the
	// default supplies, and an unannotated one merges nothing into it.
	it("offers nothing for a Record Literal that leaves members to a default", () => {
		let lines = [
			"implementation {",
			'\tfunction greet(_ person: { name: String, title: String } = { title = "Dr" }) -> String {',
			"\t\t<- person.title::append(person.name)",
			"\t}",
			"",
			"\tchoice Key {",
			"\t\tTyped { text: String, repeats: Integer } = { repeats = 1 },",
			"\t}",
			"",
			'\tconstant greeting = greet({ name = "Kim" })',
			'\tconstant key = Key#Typed({ text = "a" })',
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(extractions(lines, rangeOf(lines, '{ name = "Kim" }'))).toEqual(
			[],
		)
		expect(extractions(lines, rangeOf(lines, '{ text = "a" }'))).toEqual([])
	})

	// Nothing but the annotation decides the Choice's Type Arguments.
	it("writes the Type that decided a generic Choice's Case", () => {
		let lines = [
			"implementation {",
			"\tchoice Box<Item> {",
			"\t\tFull { item: Item },",
			"\t\tEmpty,",
			"\t}",
			"",
			"\tconstant box: Box<Integer> = Box#Empty",
			"}",
		]

		let [action] = extractions(lines, rangeOf(lines, "Box#Empty"))
		let result = applied(lines, action)

		expect(result.slice(6, 8)).toEqual([
			"\tconstant empty: Box<Integer> = Box#Empty",
			"\tconstant box: Box<Integer> = empty",
		])
		expectRefactored(lines, result)
	})

	// `inspect` has one signature, no bound and no default, so it means the
	// same as a value.
	it("lifts a callee that is a Function value", () => {
		let lines = ["implementation {", "\tTerminal.inspect([1, 2])", "}"]

		let [action] = extractions(lines, rangeOf(lines, "Terminal.inspect"))
		let result = applied(lines, action)

		expect(result.slice(1, 3)).toEqual([
			"\tconstant inspect = Terminal.inspect",
			"\tinspect([1, 2])",
		])
		expectRefactored(lines, result)
	})

	// `count` is a Variable, which no condition narrows, and `isEven` answers
	// nothing a refinement could be written with.
	it("lifts a condition that narrows nothing, and a `define`'s first one", () => {
		let lines = [
			"implementation {",
			"\tfunction label(_ start: Integer) -> String {",
			"\t\tvariable count = start",
			"",
			"\t\tif count::is(1) {",
			'\t\t\t<- "one"',
			"\t\t}",
			"",
			"\t\t<- define {",
			'\t\t\tas "even" if start::isEven()',
			'\t\t\tas "odd" otherwise',
			"\t\t}",
			"\t}",
			"}",
		]

		let [narrowsNothing] = extractions(
			lines,
			rangeOf(lines, "count::is(1)"),
		)
		let [first] = extractions(lines, rangeOf(lines, "start::isEven()"))

		expect(applied(lines, narrowsNothing).slice(4, 6)).toEqual([
			"\t\tconstant is = count::is(1)",
			"\t\tif is {",
		])
		expect(applied(lines, first).slice(8, 11)).toEqual([
			"\t\tconstant isEven = start::isEven()",
			"\t\t<- define {",
			'\t\t\tas "even" if isEven',
		])

		for (let action of [narrowsNothing, first]) {
			expectRefactored(lines, applied(lines, action))
		}
	})

	// `map` decides only its answer from the literal, and the literal's
	// Parameter from the receiver. A written Function Type is its own.
	it("lifts a Function literal only where it writes its Types", () => {
		let lines = [
			"implementation {",
			"\tconstant scores = [1, 2]",
			"\tconstant raised = scores::map((score) { <- score::add(1) })",
			"\tconstant doubled = scores::map((_ score: Integer) -> Integer { <- score::multiply(with 2) })",
			"}",
		]

		expect(
			extractions(lines, rangeOf(lines, "(score) { <- score::add(1) }")),
		).toEqual([])

		let [written] = extractions(
			lines,
			rangeOf(
				lines,
				"(_ score: Integer) -> Integer { <- score::multiply(with 2) }",
			),
		)
		let result = applied(lines, written)

		expect(result.slice(3, 5)).toEqual([
			"\tconstant value = (_ score: Integer) -> Integer { <- score::multiply(with 2) }",
			"\tconstant doubled = scores::map(value)",
		])
		expectRefactored(lines, result)
	})

	// `inspect` takes any Type, decided by its Argument alone, so the List's
	// own Type is all it asks.
	it("lifts a written Argument whose Type decides the Parameter's", () => {
		let lines = ["implementation {", "\tTerminal.inspect([1, 2])", "}"]

		let [action] = extractions(lines, rangeOf(lines, "[1, 2]"))
		let result = applied(lines, action)

		expect(result.slice(1, 3)).toEqual([
			"\tconstant value = [1, 2]",
			"\tTerminal.inspect(value)",
		])
		expectRefactored(lines, result)
	})

	// A Pattern's member name is no Expression, so the selection finds the
	// Match around it.
	it("offers nothing for a selection in a Matcher", () => {
		let lines = [
			"implementation {",
			"\tfunction size(_ shape: { width: Integer } | { radius: Integer }) -> Integer {",
			"\t\t<- match shape -> Integer {",
			"\t\t\tcase { width: Integer } { <- width }",
			"\t\t\tcase { radius } { <- radius }",
			"\t\t}",
			"\t}",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(extractions(lines, spanOf(lines, 4, "width"))).toEqual([])
		expect(extractions(lines, spanOf(lines, 4, "case"))).toEqual([])
	})

	// A Parameter's Pattern and Type, and a Comment, stand on no Expression,
	// so the selection finds the literal around them.
	it("offers nothing for a selection in a Function literal's declarations", () => {
		let lines = [
			"implementation {",
			"\ttype Rect = { width: Integer, height: Integer }",
			"",
			"\tconstant rects: List<Rect> = [{ width = 1, height = 2 }]",
			"\tconstant measured = rects::map((_ { width }: Rect) -> Integer {",
			"\t\t§ the width alone",
			"\t\t<- width",
			"\t})",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(extractions(lines, spanOf(lines, 5, "width"))).toEqual([])
		expect(extractions(lines, spanOf(lines, 5, "Rect"))).toEqual([])
		expect(extractions(lines, rangeOf(lines, "the width alone"))).toEqual(
			[],
		)
		expect(
			extractions(lines, rangeFrom(lines, "(_ { width }", "\t}")),
		).toHaveLength(1)
	})

	// A Comment stands on no Expression, so the selection finds the `define`
	// around it.
	it("offers nothing for a Comment inside a `define`", () => {
		let lines = [
			"implementation {",
			"\tconstant count = 3",
			"\tconstant label = define -> String {",
			"\t\t§ a comment in a define",
			'\t\tas "many" if count::isGreaterThan(1)',
			'\t\tas "few" otherwise',
			"\t}",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(
			extractions(lines, rangeOf(lines, "a comment in a define")),
		).toEqual([])
		expect(
			extractions(lines, rangeFrom(lines, "define -> String", "\t}")),
		).toHaveLength(1)
	})

	// The Warning reads the condition as written, which a Constant would hold
	// out of its sight.
	it("offers nothing for a key check `redundant-key-check` reads", () => {
		let lines = [
			"implementation {",
			'\tconstant ages = ["ada" = 36, "alan" = 41]',
			'\tconstant name = "alan"',
			"",
			'\tif ages::hasKey("ada") {',
			'\t\tTerminal.inspect(ages::value(at "ada"))',
			"\t}",
			"",
			"\tif ages::hasKey(name) {",
			"\t\tTerminal.inspect(ages::value(at name))",
			"\t}",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([
			"redundant-key-check",
			"redundant-key-check",
		])
		expect(
			extractions(lines, rangeOf(lines, 'ages::hasKey("ada")')),
		).toEqual([])
		expect(
			extractions(lines, rangeOf(lines, "ages::hasKey(name)")),
		).toEqual([])
	})

	// A completing Function's `<-` answers the value its Future completes
	// with, so that is the Type the position gave.
	it("writes the Type a completing Function's answer resolved against", () => {
		let lines = [
			"implementation {",
			"\tfunction maybe(_ number: Integer) -> Future<Optional<NonEmptyList<Integer>>> {",
			"\t\tconstant held = complete Async.deferred(() { <- number })",
			"",
			"\t\t<- #Value([held])",
			"\t}",
			"",
			"\tTerminal.inspect(complete maybe(3))",
			"}",
		]

		let [action] = extractions(lines, rangeOf(lines, "#Value([held])"))
		let result = applied(lines, action)

		expect(result.slice(4, 6)).toEqual([
			"\t\tconstant value: Optional<NonEmptyList<Integer>> = #Value([held])",
			"\t\t<- value",
		])
		expectRefactored(lines, result)
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
			"\t\tconstant fallback = { holds = 0 }",
			"",
			"\t\t<- scores::highestItem(defaultingTo fallback.holds)",
			"\t}",
			"}",
		]

		let [action] = inlines(lines, rangeOf(lines, "fallback = {"))
		let result = applied(lines, action)

		expect(action.title).toBe("Inline 'fallback'")
		expect(action.isPreferred).toBe(false)

		// The line goes with the declaration, break and all, so no blank line
		// is left under the opening brace.
		expect(result).toEqual([
			"implementation {",
			"\tfunction total(_ scores: List<Integer>) -> Integer {",
			"\t\t<- scores::highestItem(defaultingTo { holds = 0 }.holds)",
			"\t}",
			"}",
		])

		expectRefactored(lines, result)
	})

	// A predicate's Argument must be a literal, so the Constant is refused
	// there until its value is written in.
	it("writes the value into a refinement's predicate that reads it", () => {
		let lines = [
			"implementation {",
			"\tconstant limit = 10",
			"",
			"\ttype Small = Integer where @::isLessThan(limit)",
			"",
			"\tfunction main() -> Integer {",
			"\t\t<- limit",
			"\t}",
			"}",
		]

		let [action] = inlines(lines, rangeOf(lines, "limit = 10"))
		let result = applied(lines, action)

		expect(result).toEqual([
			"implementation {",
			"\ttype Small = Integer where @::isLessThan(10)",
			"",
			"\tfunction main() -> Integer {",
			"\t\t<- 10",
			"\t}",
			"}",
		])
		expect(refactoredCodesOf(result)).toEqual([])
	})

	// A compound value is delimited by its own brackets, so it reads as itself
	// in front of a `::`.
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
			"\tconstant limit = 10",
			"\tconstant range = { low = 0, high = limit }",
			"\tconstant bounds = [limit, 20]",
			"}",
		]

		let [action] = inlines(lines, rangeOf(lines, "limit }"))
		let result = applied(lines, action)

		expect(result).toEqual([
			"implementation {",
			"\tconstant range = { low = 0, high = 10 }",
			"\tconstant bounds = [10, 20]",
			"}",
		])

		expectRefactored(lines, result)
	})

	// A written `4` at a receiver is a `PositiveInteger`, whose `squareRoot`
	// answers an Integer rather than an Optional. See "Written receivers" in
	// packages/compiler/src/enricher/DEVELOPMENT.md.
	it("offers nothing for a written value a receiver would refine", () => {
		let lines = [
			"implementation {",
			"\tconstant n = 4",
			"\tconstant root = n::squareRoot()",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(inlines(lines, rangeOf(lines, "n ="))).toEqual([])
	})

	// A written `4` passed as `over` picks the overload that answers a
	// Rational rather than an Optional.
	it("offers nothing for a written value an Argument would refine", () => {
		let lines = [
			"implementation {",
			"\tconstant divisor = 4",
			"\tconstant quarter = Rational.of(1, over divisor)",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(inlines(lines, rangeOf(lines, "divisor ="))).toEqual([])
	})

	// A written List's items are admitted with it, so `[4]` picks the
	// `List<PositiveInteger>` overload where `[n]` picks the other.
	it("offers nothing for a written value read inside a written List passed as an Argument", () => {
		let lines = [
			"implementation {",
			"\ttype Holder = { n: Integer }",
			"",
			"\tnamespace Pick for Holder {",
			"\t\toverload static sign {",
			"\t\t\t(_ items: List<PositiveInteger>) -> String {",
			'\t\t\t\t<- "positive"',
			"\t\t\t}",
			"",
			"\t\t\t(_ items: List<Integer>) -> String {",
			'\t\t\t\t<- "any"',
			"\t\t\t}",
			"\t\t}",
			"\t}",
			"",
			"\tconstant n = 4",
			"\tconstant signed = Pick.sign([n])",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(inlines(lines, rangeOf(lines, "n = 4"))).toEqual([])
	})

	// A Function with one signature and no Type Parameters answers the same
	// for any Argument its Parameter admits.
	it("writes a written value into an Argument of a Function with one signature", () => {
		let lines = [
			"implementation {",
			"\tfunction twice(_ n: Integer) -> Integer {",
			"\t\t<- n::multiply(with 2)",
			"\t}",
			"",
			"\tconstant limit = 10",
			"\tconstant doubled = twice(limit)",
			"}",
		]

		let [action] = inlines(lines, rangeOf(lines, "limit ="))
		let result = applied(lines, action)

		expect(result).toEqual([
			"implementation {",
			"\tfunction twice(_ n: Integer) -> Integer {",
			"\t\t<- n::multiply(with 2)",
			"\t}",
			"",
			"\tconstant doubled = twice(10)",
			"}",
		])

		expectRefactored(lines, result)
	})

	// The value would move into a Scope that declares a name it reads, which
	// changes what it reads.
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

	// An empty List compiles only under a written Type, which is refused too.
	it("offers nothing for a bare Case or an empty List", () => {
		let lines = [
			"implementation {",
			"\tchoice Suit { Hearts, Spades }",
			"\tconstant chosen = #Hearts",
			"\tconstant empty: List<Integer> = []",
			"\tconstant matched = chosen::is(#Spades)",
			"\tconstant counted = empty::length()",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(inlines(lines, rangeOf(lines, "chosen ="))).toEqual([])
		expect(inlines(lines, rangeOf(lines, "empty:"))).toEqual([])
	})

	// A bare Case resolves against the Choices in scope where it is written,
	// and `Organ` would make the copy's `#Hearts` ambiguous.
	it("offers nothing for a value holding a bare Case", () => {
		let lines = [
			"implementation {",
			"\tchoice Suit { Hearts, Spades }",
			"\tconstant hand = [#Hearts]",
			"",
			"\tfunction counted() -> Integer {",
			"\t\tchoice Organ { Hearts, Lungs }",
			"",
			"\t\t<- hand::length()",
			"\t}",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(inlines(lines, rangeOf(lines, "hand ="))).toEqual([])
	})

	// The Lexer ends a String Literal at the next `"`, so a value with a quote
	// cannot be written into a hole.
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
			"\tconstant counted = [1, 2, 3]",
			'\tconstant reported = "there are {counted}"',
			"}",
		]

		let [action] = inlines(lines, rangeOf(lines, "counted ="))
		let result = applied(lines, action)

		expect(result).toEqual([
			"implementation {",
			'\tconstant reported = "there are {[1, 2, 3]}"',
			"}",
		])

		expectRefactored(lines, result)
	})

	it("offers nothing for a Constant nothing reads", () => {
		let lines = ["implementation {", "\tconstant unused = 1::add(2)", "}"]

		expect(inlines(lines, rangeOf(lines, "unused"))).toEqual([])
	})

	// A value that calls something would run once per read. A call that
	// answers a value looks like one that acts, so every call is turned away.
	it("offers nothing for a value that calls anything", () => {
		let lines = [
			"implementation {",
			"\tfunction run() -> Integer {",
			'\t\tconstant printed = Terminal.print("once")',
			"",
			"\t\tTerminal.inspect(printed)",
			"\t\tTerminal.inspect(printed)",
			"",
			"\t\t<- 1",
			"\t}",
			"}",
		]

		expect(inlines(lines, rangeOf(lines, "printed ="))).toEqual([])
	})

	// Each copy would start or wait for the work again, where it is read. A
	// copy before `::add(1)` would also wait for `work::add(1)`.
	it("offers nothing for a value that starts or completes anything", () => {
		let lines = [
			"implementation {",
			"\tfunction waited(_ work: Future<Integer>) -> Future<Integer> {",
			"\t\tconstant answer = complete work",
			"",
			"\t\t<- answer::add(1)",
			"\t}",
			"",
			"\tfunction launched(_ work: Future<Integer>) -> Future<Integer> {",
			"\t\tconstant running = start work",
			"",
			"\t\t<- complete running",
			"\t}",
			"",
			"\tfunction held(_ work: Future<Integer>) -> Future<Integer> {",
			"\t\tconstant box = { answer = complete work }",
			"",
			"\t\t<- box.answer",
			"\t}",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(inlines(lines, rangeOf(lines, "answer ="))).toEqual([])
		expect(inlines(lines, rangeOf(lines, "running ="))).toEqual([])
		expect(inlines(lines, rangeOf(lines, "box ="))).toEqual([])
	})

	// A copy takes its Type from where it is read, so `[1, 2]` there would be
	// a `List<Integer>` that refuses `1/2`.
	it("offers nothing for a Constant that writes its Type", () => {
		let lines = [
			"implementation {",
			"\tconstant mixed: List<Number> = [1, 2]",
			"\tconstant longer = mixed::append(1/2)",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(inlines(lines, rangeOf(lines, "mixed:"))).toEqual([])
	})

	// A copy reads the Variable where the Constant is read, after the
	// assignment.
	it("offers nothing for a value that reads a Variable", () => {
		let lines = [
			"implementation {",
			"\tfunction run() -> Integer {",
			"\t\tvariable count = 1",
			"\t\tconstant first = { count }",
			"",
			"\t\tcount = 2",
			"",
			"\t\t<- first.count",
			"\t}",
			"}",
		]

		expect(refactoredCodesOf(lines)).toEqual([])
		expect(inlines(lines, rangeOf(lines, "first ="))).toEqual([])
	})

	// A read inside a Function literal runs once per call of that literal.
	it("offers nothing for a read inside a Function literal", () => {
		let lines = [
			"implementation {",
			"\tfunction run() -> List<Integer> {",
			"\t\tconstant held = 7",
			"",
			"\t\t<- [1, 2, 3]::map((item) { <- held })",
			"\t}",
			"}",
		]

		expect(inlines(lines, rangeOf(lines, "held ="))).toEqual([])
	})

	// A builtin Type is in no Scope, and naming one does not refuse a value.
	it("offers a value that names a builtin Type", () => {
		let lines = [
			"implementation {",
			"\tconstant flag = true",
			"\tconstant described = define -> String {",
			'\t\tas "yes" if flag',
			'\t\tas "no" otherwise',
			"\t}",
			"\tconstant shown = described",
			"}",
		]
		let onOneLine = [
			"implementation {",
			"\tconstant flag = true",
			'\tconstant described = define -> String { as "yes" if flag as "no" otherwise }',
			"\tconstant shown = described",
			"}",
		]

		expect(inlines(lines, rangeOf(lines, "described ="))).toEqual([])
		expect(
			titles(inlines(onOneLine, rangeOf(onOneLine, "described ="))),
		).toEqual(["Inline 'described'"])
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

	// The Position is measured against the text the edits produce, since the
	// call site collapses the selection onto one line.
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

	// A selection that answers nothing becomes a Function answering `{}`,
	// called as a Statement.
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

	// The `<-` ending a Handler's body is the arm's value, so the extracted
	// Function answers that Type.
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

	// What the selection declares travels with it, so a later read of it would
	// lose its name.
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

	// The Function would have to declare the Variable again under a new name,
	// a rename nobody asked for.
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

	// A Return before the last Statement answers the Function, and would
	// answer the extracted one instead.
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

	// A Method extracted beside a Method must decide what `@` becomes, so a
	// Namespace is turned away.
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

	// `@` inside a Match Handler is the value the arm caught, which a Function
	// beside it cannot read.
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

	// An assertion records against the running test, which a Function called
	// from a test body cannot do.
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

	// A cursor anywhere in the test offers the rewrite. This uses the `test`
	// keyword's line.
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

	// A column takes its name from the Parameter the Argument fills, not from
	// the call's label.
	it("names a column after the Parameter, and widens a Case to its Choice", () => {
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
			"\t\t{ scored = 2, conceded = 0, expected = #Win },",
			"\t\t{ scored = 0, conceded = 2, expected = #Loss },",
			"\t] ({ scored, conceded, expected }: { scored: Integer, conceded: Integer, expected: Outcome }) {",
			"\t\texpect outcomeOf(scored, against conceded)::is(expected)",
			"\t}",
			"}",
		])

		expectRefactored(lines, result)
	})

	// A Parameter that binds no name, such as `_: Integer`, leaves its column
	// to a letter.
	it("falls back to a letter where the Parameter binds no name", () => {
		let lines = [
			"implementation {",
			"\tfunction first(_ a: Integer, _: Integer) -> Integer {",
			"\t\t<- a",
			"\t}",
			"}",
			"",
			"tests {",
			'\ttest "takes the first" {',
			"\t\texpect first(1, 2)::is(1)",
			"\t\texpect first(3, 4)::is(3)",
			"\t}",
			"}",
		]

		let [action] = tables(lines, onTheTest(lines, '"takes the first"'))
		let result = applied(lines, action)

		expect(result.slice(6)).toEqual([
			"tests {",
			'\ttest "takes the first" across [',
			"\t\t{ a = 1, b = 2, expected = 1 },",
			"\t\t{ a = 3, b = 4, expected = 3 },",
			"\t] ({ a, b, expected }: { a: Integer, b: Integer, expected: Integer }) {",
			"\t\texpect first(a, b)::is(expected)",
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

	// A row holds only values, and an assertion other than `::is(…)` says what
	// a column of expected values cannot.
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

	// A Case widens to its Choice, and a generic Choice needs its Type
	// Arguments.
	it("writes a generic Choice's column at the Type it was applied at", () => {
		let lines = [
			"implementation {",
			"\tfunction held(_ n: Integer) -> Optional<Integer> {",
			"\t\t<- #Empty",
			"\t}",
			"}",
			"",
			"tests {",
			'\ttest "it answers nothing" {',
			"\t\texpect held(1)::is(#Empty)",
			"\t\texpect held(2)::is(#Empty)",
			"\t}",
			"}",
		]

		let [action] = tables(lines, onTheTest(lines, '"it answers nothing"'))
		let result = applied(lines, action)

		expect(result[10]).toBe(
			"\t] ({ n, expected }: { n: Integer, expected: Optional<Integer> }) {",
		)

		expectRefactored(lines, result)
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

// A request's kinds narrow the work before it is done, since organizing
// imports on save asks for one kind. A Proxy over the section's Statement list
// counts the refactorings that walked it.
describe("the kinds a request narrowed itself to", () => {
	function walksOf(lines: Array<string>, only?: Array<string>): number {
		let source = lines.join("\n")
		let analysis = analyseDocument(source, undefined, { tests: true })
		let program = analysis.program as parser.Program
		let walks = 0
		let counted = new Proxy(program.implementation.nodes, {
			get(target, key, receiver) {
				if (key === Symbol.iterator) {
					walks += 1
				}

				return Reflect.get(target, key, receiver) as unknown
			},
		})

		findCodeActions(
			source,
			{
				start: { line: 1, column: 1 },
				end: {
					line: lines.length,
					column: (lines.at(-1) as string).length + 1,
				},
			},
			undefined,
			undefined,
			{
				...analysis,
				program: {
					...program,
					implementation: {
						...program.implementation,
						nodes: counted,
					},
				},
			},
			[],
			only,
		)

		return walks
	}

	const DOCUMENT = [
		"implementation {",
		"\ttype Crate = { count: Integer }",
		"",
		"\tconstant one = 1",
		"",
		"\tfunction sized(_ crate: Crate) -> Integer {",
		"\t\t<- crate.count",
		"\t}",
		"}",
		"",
	]

	it("walks the Program for a request that asked for everything", () => {
		expect(walksOf(DOCUMENT)).toBeGreaterThan(0)
	})

	it("walks it for nothing where one source kind was asked for", () => {
		expect(walksOf(DOCUMENT, ["source.organizeImports"])).toBe(0)
	})

	it("offers only the kind that was asked for", () => {
		let source = DOCUMENT.join("\n")
		let range = {
			start: { line: 1, column: 1 },
			end: {
				line: DOCUMENT.length,
				column: (DOCUMENT.at(-1) as string).length + 1,
			},
		}
		let kinds = (only?: Array<string>) =>
			new Set(
				findCodeActions(
					source,
					range,
					undefined,
					undefined,
					null,
					[],
					only,
				).map((entry) => entry.kind),
			)

		expect(kinds()).toContain("refactor.rewrite")
		expect(kinds(["refactor.extract"])).toEqual(new Set())
		expect(kinds(["refactor"])).toEqual(kinds())
	})

	// Writing a conformance's stubs from the Namespace head is a refactoring.
	it("offers the stubs on a Namespace head under the kind they have", () => {
		let source = [
			"implementation {",
			"\ttype Point = { x: Integer }",
			"",
			"\tnamespace Point for Point is Printable {",
			"\t}",
			"}",
		].join("\n")
		let offered = (only: Array<string>) =>
			findCodeActions(
				source,
				{ start: { line: 4, column: 2 }, end: { line: 4, column: 11 } },
				undefined,
				undefined,
				null,
				[],
				only,
			).map((entry) => [entry.kind, entry.title])

		expect(offered(["refactor"])).toEqual([
			["refactor.rewrite", "Implement 'Printable'"],
		])
		expect(offered(["refactor.rewrite"])).toEqual([
			["refactor.rewrite", "Implement 'Printable'"],
		])
		expect(offered(["quickfix"])).toEqual([])
	})
})

// The Quick Fixes for asynchrony's Diagnostics, checked by the applied buffer
// and by what the Compiler makes of it.
describe("Quick Fixes for asynchrony", () => {
	// Nothing in the source chooses between the two answers, so neither is
	// preferred.
	describe("a future whose value goes nowhere", () => {
		const LINES = ["implementation {", "\tAsync.deferred(() { <- 1 })", "}"]

		it("offers both words, and prefers neither", () => {
			let fixes = quickFixes(LINES).filter(
				(entry) => entry.diagnosticCode === "unused-future",
			)

			expect(titles(fixes)).toEqual([
				"Wait for it with 'complete'",
				"Put it in flight with 'start'",
			])
			expect(fixes.map((entry) => entry.isPreferred)).toEqual([
				false,
				false,
			])
		})

		it("writes the word in front of what was written", () => {
			let fixes = quickFixes(LINES).filter(
				(entry) => entry.diagnosticCode === "unused-future",
			)

			expect(applied(LINES, fixes[0] as CodeActionEntry)).toEqual([
				"implementation {",
				"\tcomplete Async.deferred(() { <- 1 })",
				"}",
			])
			expect(applied(LINES, fixes[1] as CodeActionEntry)).toEqual([
				"implementation {",
				"\tstart Async.deferred(() { <- 1 })",
				"}",
			])
		})

		it("leaves a Program the Compiler is happy with", () => {
			let fixes = quickFixes(LINES).filter(
				(entry) => entry.diagnosticCode === "unused-future",
			)

			expect(
				codesOf(applied(LINES, fixes[0] as CodeActionEntry)),
			).toEqual([])
			// Fire and forget is legal, so the second answer leaves the
			// Information behind.
			expect(
				codesOf(applied(LINES, fixes[1] as CodeActionEntry)),
			).toEqual(["unobserved-started"])
		})
	})

	// The body is right and the signature lags, so the declared Type is wrapped
	// rather than replaced.
	describe("a complete in a body that declared something else", () => {
		const LINES = [
			"implementation {",
			"\tfunction doubled(_ value: Integer) -> Integer {",
			"\t\t<- complete Async.deferred(() { <- value })",
			"\t}",
			"",
			"\tTerminal.inspect(complete doubled(2))",
			"}",
		]

		it("wraps the declared return Type in a Future", () => {
			let fix = quickFixes(LINES).find(
				(entry) => entry.diagnosticCode === "complete-outside-future",
			) as CodeActionEntry

			expect(fix.title).toBe("Declare the return Type 'Future<Integer>'")
			expect(fix.isPreferred).toBe(true)
			expect(applied(LINES, fix)).toEqual([
				"implementation {",
				"\tfunction doubled(_ value: Integer) -> Future<Integer> {",
				"\t\t<- complete Async.deferred(() { <- value })",
				"\t}",
				"",
				"\tTerminal.inspect(complete doubled(2))",
				"}",
			])
			expect(codesOf(applied(LINES, fix))).toEqual([])
		})

		// A Parameter's default is filled in before any asynchrony begins, so
		// wrapping the return Type would not answer it.
		it("offers nothing for a complete written in a Parameter's default", () => {
			let lines = [
				"implementation {",
				"\tfunction doubled(",
				"\t\t_ value: Integer = complete Async.deferred(() { <- 1 }),",
				"\t) -> Integer {",
				"\t\t<- value",
				"\t}",
				"",
				"\tTerminal.inspect(doubled(2))",
				"}",
			]

			expect(
				quickFixes(lines).filter(
					(entry) =>
						entry.diagnosticCode === "complete-outside-future",
				),
			).toEqual([])
		})

		// Before a value that is no work the word is the mistake, so it goes and
		// the declared Type stays.
		it("drops a complete that waits for no work", () => {
			let lines = [
				"implementation {",
				"\tfunction twice(_ value: Integer) -> Integer {",
				"\t\t<- complete value",
				"\t}",
				"}",
			]
			let fixes = quickFixes(lines).filter(
				(entry) => entry.diagnosticCode === "complete-outside-future",
			)
			let result = applied(lines, fixes[0] as CodeActionEntry)

			expect(titles(fixes)).toEqual(["Drop the 'complete'"])
			expect(result[2]).toBe("\t\t<- value")
			expect(codesOf(result)).toEqual([])
		})
	})

	describe("a Keyword in front of a value that is neither", () => {
		const LINES = [
			"implementation {",
			"\tconstant value = complete 3",
			"\tconstant other = start 4",
			"\tTerminal.inspect(value)",
			"\tTerminal.inspect(other)",
			"}",
		]

		it("takes the word and the space behind it away", () => {
			let fixes = quickFixes(LINES).filter((entry) =>
				["needless-complete", "needless-start"].includes(
					entry.diagnosticCode as string,
				),
			)

			expect(titles(fixes)).toEqual([
				"Drop the 'complete'",
				"Drop the 'start'",
			])

			let applyBoth = fixes.reduce(
				(lines, fix) => applied(lines, fix),
				LINES,
			)

			expect(applyBoth).toEqual([
				"implementation {",
				"\tconstant value = 3",
				"\tconstant other = 4",
				"\tTerminal.inspect(value)",
				"\tTerminal.inspect(other)",
				"}",
			])
			expect(codesOf(applyBoth)).toEqual([])
		})
	})

	// Picked out by the Help rather than the code, since every mismatch shares
	// these codes.
	describe("a mismatch that is one missing complete", () => {
		it("writes the word in front of the value assigned", () => {
			let lines = [
				"implementation {",
				"\tconstant work = Async.deferred(() { <- 1 })",
				"\tconstant value: Integer = work",
				"\tTerminal.inspect(value)",
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) => entry.diagnosticCode === "assignment-type-mismatch",
			) as CodeActionEntry

			expect(fix.title).toBe("Wait for it with 'complete'")
			expect(applied(lines, fix)).toEqual([
				"implementation {",
				"\tconstant work = Async.deferred(() { <- 1 })",
				"\tconstant value: Integer = complete work",
				"\tTerminal.inspect(value)",
				"}",
			])
			expect(codesOf(applied(lines, fix))).toEqual([])
		})

		// This fix trades its Diagnostic for another, since a body that waits
		// must declare a Future. The next fix wraps the annotation.
		it("writes it in front of what a body returns", () => {
			let lines = [
				"implementation {",
				"\tfunction doubled(_ value: Integer) -> Integer {",
				"\t\t<- Async.deferred(() { <- value })",
				"\t}",
				"",
				"\tTerminal.inspect(doubled(2))",
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) => entry.diagnosticCode === "return-type-mismatch",
			) as CodeActionEntry

			expect(applied(lines, fix)[2]).toBe(
				"\t\t<- complete Async.deferred(() { <- value })",
			)
			expect(codesOf(applied(lines, fix))).toEqual([
				"complete-outside-future",
			])
		})

		// The whole chain converges from a body that returns work to a Program
		// the Compiler says nothing about.
		it("converges in three steps from the body that returns work", () => {
			let lines = [
				"implementation {",
				"\tfunction doubled(_ value: Integer) -> Integer {",
				"\t\t<- Async.deferred(() { <- value })",
				"\t}",
				"",
				"\tTerminal.inspect(doubled(2))",
				"}",
			]
			let codes = [codesOf(lines)]

			for (let step = 0; step < 3; step++) {
				let fix = quickFixes(lines)[0] as CodeActionEntry

				lines = applied(lines, fix)
				codes.push(codesOf(lines))
			}

			expect(codes).toEqual([
				["return-type-mismatch"],
				["complete-outside-future"],
				["unused-future"],
				[],
			])
		})

		// `show(work)` is the everyday shape of a missing `complete`.
		it("writes the word in front of an Argument", () => {
			let lines = [
				"implementation {",
				"\tfunction show(_ value: Integer) -> Integer {",
				"\t\t<- value",
				"\t}",
				"",
				"\tconstant work = Async.deferred(() { <- 1 })",
				"",
				"\tTerminal.inspect(show(work))",
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) => entry.diagnosticCode === "argument-type-mismatch",
			) as CodeActionEntry

			expect(fix.title).toBe("Wait for it with 'complete'")
			expect(applied(lines, fix)[7]).toBe(
				"\tTerminal.inspect(show(complete work))",
			)
			expect(codesOf(applied(lines, fix))).toEqual([])
		})

		// A String's hole meets the forgotten word under a Diagnostic about
		// `Printable`.
		it("writes the word inside a String's hole", () => {
			let lines = [
				"implementation {",
				"\tconstant work = Async.deferred(() { <- 1 })",
				"",
				'\tTerminal.print("got {work}")',
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) =>
					entry.diagnosticCode === "interpolation-not-printable",
			) as CodeActionEntry

			expect(fix.title).toBe("Wait for it with 'complete'")
			expect(applied(lines, fix)[3]).toBe(
				'\tTerminal.print("got {complete work}")',
			)
			expect(codesOf(applied(lines, fix))).toEqual([])
		})

		// A run in flight at a Constant, one at a return, and a waiting body
		// handing back a future.
		it("writes the word for a run that is in flight", () => {
			let lines = [
				"implementation {",
				"\tconstant running = start Async.deferred(() { <- 1 })",
				"\tconstant value: Integer = running",
				"\tTerminal.inspect(value)",
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) => entry.diagnosticCode === "assignment-type-mismatch",
			) as CodeActionEntry

			expect(fix.title).toBe("Wait for it with 'complete'")
			expect(applied(lines, fix)[2]).toBe(
				"\tconstant value: Integer = complete running",
			)
			expect(codesOf(applied(lines, fix))).toEqual([])
		})

		it("writes the word for a run a body hands back", () => {
			let lines = [
				"implementation {",
				"\tfunction doubled(_ value: Integer) -> Integer {",
				"\t\t<- start Async.deferred(() { <- value })",
				"\t}",
				"",
				"\tTerminal.inspect(doubled(2))",
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) => entry.diagnosticCode === "return-type-mismatch",
			) as CodeActionEntry

			expect(fix.title).toBe("Wait for it with 'complete'")
			expect(applied(lines, fix)[2]).toBe(
				"\t\t<- complete start Async.deferred(() { <- value })",
			)
		})

		it("writes the word where a waiting body answers with a future", () => {
			let lines = [
				"implementation {",
				"\tfunction doubled(_ value: Integer) -> Future<Integer> {",
				"\t\tconstant ignored = complete Async.deferred(() { <- 1 })",
				"",
				"\t\t<- Async.deferred(() { <- value })",
				"\t}",
				"",
				"\tTerminal.inspect(complete doubled(2))",
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) => entry.diagnosticCode === "return-type-mismatch",
			) as CodeActionEntry

			expect(fix.title).toBe("Wait for it with 'complete'")
			expect(codesOf(applied(lines, fix))).toEqual([])
		})

		// The Enricher refuses a call that picks no Overload, so the Validator
		// never reports it. The same fix is offered there.
		it("writes the word in front of an Argument of a refused Overload", () => {
			let lines = [
				"implementation {",
				"\tnamespace Shown for Integer {",
				"\t\toverload show {",
				"\t\t\t(_ count: Integer) -> Integer { <- count }",
				"\t\t\t(twice flag: Boolean) -> Integer { <- 0 }",
				"\t\t}",
				"\t}",
				"",
				"\tconstant work = Async.deferred(() { <- 1 })",
				"",
				"\tTerminal.inspect(1::show(work))",
				"}",
			]

			let fix = quickFixes(lines).find(
				(entry) => entry.diagnosticCode === "no-matching-overload",
			) as CodeActionEntry

			expect(fix.title).toBe("Wait for it with 'complete'")
			expect(applied(lines, fix)[10]).toBe(
				"\tTerminal.inspect(1::show(complete work))",
			)
			expect(codesOf(applied(lines, fix))).toEqual([])
		})

		// The fix answers nothing where the Validator wrote no Help about
		// asynchrony.
		it("offers nothing for a mismatch that is not one", () => {
			let lines = [
				"implementation {",
				'\tconstant value: Integer = "two"',
				"\tTerminal.inspect(value)",
				"}",
			]

			expect(
				quickFixes(lines).filter(
					(entry) =>
						entry.diagnosticCode === "assignment-type-mismatch",
				),
			).toEqual([])
		})
	})

	// `unobserved-started` is offered nothing, since its answers are no edit
	// or a name only the reader knows.
	it("offers nothing for work nobody waits for", () => {
		let lines = [
			"implementation {",
			"\tstart Async.deferred(() { <- 1 })",
			"}",
		]

		expect(codesOf(lines)).toEqual(["unobserved-started"])
		expect(quickFixes(lines)).toEqual([])
	})
})

// What is written under `start` and `complete` is ordinary code, reached by
// walks that descend through the Keywords.
describe("Refactorings under start and complete", () => {
	it("annotates a Constant declared inside a started body", () => {
		let lines = [
			"implementation {",
			"\tconstant running = start Async.deferred(() {",
			"\t\tconstant inner = 41",
			"",
			"\t\t<- inner::add(1)",
			"\t})",
			"\tTerminal.inspect(complete running)",
			"}",
		]

		expect(titles(actionsOf(lines, spanOf(lines, 3, "inner")))).toContain(
			"Add explicit Type annotation ': Integer'",
		)
	})

	it("scaffolds a Match on a value written under the Keyword", () => {
		let lines = [
			"implementation {",
			"\tchoice Suit { Hearts, Spades }",
			"\tfunction chosen(_ suit: Suit) -> Future<Suit> {",
			"\t\t<- complete Async.deferred(() {",
			"\t\t\t<- suit",
			"\t\t})",
			"\t}",
			"\tconstant answer = complete chosen(#Hearts)",
			"\tTerminal.inspect(answer::is(#Hearts))",
			"}",
		]

		expect(titles(actionsOf(lines, spanOf(lines, 5, "suit")))).toContain(
			"Match on 'suit'",
		)
	})

	// The call inside the operand, and the whole Expression. A lifted
	// `complete` stays in a body that already suspends.
	describe("extracting to a Constant", () => {
		const LINES = [
			"implementation {",
			"\tfunction doubled(_ value: Integer) -> Future<Integer> {",
			"\t\t<- complete Async.deferred(() { <- value })",
			"\t}",
			"\tconstant answer = complete doubled(21)",
			"\tTerminal.inspect(answer)",
			"}",
		]

		it("lifts the future out from under the Keyword", () => {
			let action = actionsOf(LINES, spanOf(LINES, 5, "doubled(21)")).find(
				(entry) => entry.kind === "refactor.extract",
			)

			expect(applied(LINES, action as CodeActionEntry)).toEqual([
				"implementation {",
				"\tfunction doubled(_ value: Integer) -> Future<Integer> {",
				"\t\t<- complete Async.deferred(() { <- value })",
				"\t}",
				"\tconstant doubled2 = doubled(21)",
				"\tconstant answer = complete doubled2",
				"\tTerminal.inspect(answer)",
				"}",
			])
		})

		it("lifts the whole Expression, Keyword and all", () => {
			let action = actionsOf(
				LINES,
				spanOf(LINES, 5, "complete doubled(21)"),
			).find((entry) => entry.kind === "refactor.extract")

			expect(applied(LINES, action as CodeActionEntry)).toEqual([
				"implementation {",
				"\tfunction doubled(_ value: Integer) -> Future<Integer> {",
				"\t\t<- complete Async.deferred(() { <- value })",
				"\t}",
				"\tconstant doubled2 = complete doubled(21)",
				"\tconstant answer = doubled2",
				"\tTerminal.inspect(answer)",
				"}",
			])
		})
	})
})

describe("Code Actions inside a Protocol-provided Method body", () => {
	let within = (body: Array<string>): Array<string> => [
		"implementation {",
		"\tchoice Size { Small, Large }",
		"\tchoice Progress { Stopped { total: Integer } }",
		"",
		"\tprotocol Ranked {",
		"\t\tsize() -> Size",
		"",
		"\t\tlabel(_ chosen: Size) -> Progress {",
		...body.map((line) => `\t\t\t${line}`),
		"\t\t}",
		"\t}",
		"}",
	]
	let insideFunction = [
		"implementation {",
		"\tfunction outer(_ count: Integer) -> Integer {",
		"\t\tprotocol Ranked {",
		"\t\t\tisAbove(_ mark: Integer) -> Boolean",
		"",
		"\t\t\tisAtMost(_ mark: Integer) -> Boolean {",
		"\t\t\t\tconstant raised = mark::add(1)",
		"\t\t\t\t<- raised::isGreaterThan(0)",
		"\t\t\t}",
		"\t\t}",
		"",
		"\t\t<- count",
		"\t}",
		"}",
	]

	it("should add the missing Cases to a Match in the body", () => {
		let lines = within([
			"<- match chosen -> Progress {",
			"\tcase #Small { <- #Stopped(1) }",
			"}",
		])

		expect(titles(quickFixes(lines))).toContain("Add missing Cases")
	})

	it("should declare a reassigned Constant as a Variable", () => {
		let lines = within([
			"constant count = 1",
			"count = 2",
			"<- #Stopped(count)",
		])

		expect(titles(quickFixes(lines))).toContain(
			"Declare 'count' as a Variable",
		)
	})

	it("should scaffold a Match on a value in the body", () => {
		let lines = within(["constant same = chosen", "<- #Stopped(1)"])

		expect(titles(actionsOf(lines, spanOf(lines, 9, "chosen")))).toContain(
			"Match on 'chosen'",
		)
	})

	it("should expand a Case payload written in the body", () => {
		let lines = within(["<- #Stopped(1)"])

		expect(titles(actionsOf(lines, spanOf(lines, 9, "(1)")))).toContain(
			"Expand the payload to '{ total = … }'",
		)
	})

	it("should extract an Expression in the body to a Constant", () => {
		let lines = within(["<- #Stopped(@::size()::toString()::length())"])
		let action = actionsOf(lines, spanOf(lines, 9, "@::size()")).find(
			(entry) => entry.title === "Extract to a Constant",
		)

		expect(applied(lines, action as CodeActionEntry).slice(8, 10)).toEqual([
			"\t\t\tconstant size = @::size()",
			"\t\t\t<- #Stopped(size::toString()::length())",
		])
	})

	it("should offer no Extract to a Function out of the body", () => {
		let range = rangeFrom(
			insideFunction,
			"constant raised",
			"<- raised::isGreaterThan(0)",
		)

		expect(codesOf(insideFunction)).toEqual([])
		expect(titles(actionsOf(insideFunction, range))).not.toContain(
			"Extract to a Function",
		)
	})

	// Extract to a Function turns a provided body away before it spells a
	// Type, so the shared typed lookup is asked directly.
	it("should find the typed read of a Parameter in the body", () => {
		let analysis = analyseDocument(insideFunction.join("\n"), undefined, {
			tests: true,
		})
		let read = typedExpressionAt(
			analysis.enrichedProgram as common.typed.Program,
			spanOf(insideFunction, 7, "mark"),
		)

		expect(read).toMatchObject({
			nodeType: "Identifier",
			content: "mark",
			type: { type: "Integer" },
		})
	})
})

describe("Code Actions inside a refused value", () => {
	it("should extract an Expression in front of the brackets to a Constant", () => {
		let lines = [
			"implementation {",
			"\tconstant primes = [2, 3, 5]",
			"\tconstant first = primes::reverse()[0]",
			"}",
		]
		let action = actionsOf(
			lines,
			spanOf(lines, 3, "primes::reverse()"),
		).find((entry) => entry.title === "Extract to a Constant")

		expect(applied(lines, action as CodeActionEntry).slice(2, 4)).toEqual([
			"\tconstant reverse = primes::reverse()",
			"\tconstant first = reverse[0]",
		])
	})

	it("should scaffold a Match on a value in front of the brackets", () => {
		let lines = [
			"implementation {",
			"\tchoice Size { Small, Large }",
			"\tconstant chosen: Size = #Small",
			"\tconstant first = chosen[0]",
			"}",
		]

		expect(titles(actionsOf(lines, spanOf(lines, 4, "chosen")))).toContain(
			"Match on 'chosen'",
		)
	})

	it("should expand a Case payload in front of the brackets", () => {
		let lines = [
			"implementation {",
			"\tchoice Progress { Stopped { total: Integer } }",
			"\tconstant first = #Stopped(1)[0]",
			"}",
		]

		expect(titles(actionsOf(lines, spanOf(lines, 3, "(1)")))).toContain(
			"Expand the payload to '{ total = … }'",
		)
	})

	it("should type a Parameter read in front of the brackets when extracting a Function", () => {
		let lines = [
			"implementation {",
			"\tfunction report(_ primes: List<Integer>) -> Integer {",
			"\t\tconstant first = primes[0]",
			"\t\t<- 1",
			"\t}",
			"}",
		]
		let action = actionsOf(
			lines,
			spanOf(lines, 3, "constant first = primes[0]"),
		).find((entry) => entry.title === "Extract to a Function")

		expect(applied(lines, action as CodeActionEntry)).toContain(
			"\tfunction extracted(_ primes: List<Integer>) -> {} {",
		)
	})
})
