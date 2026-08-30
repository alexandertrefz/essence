import { describe, expect, it } from "bun:test"

import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import { validate } from "@essence-lang/compiler/validator"
import type { common } from "@essence-lang/interfaces"

import { collectCallSites, prepareCallHierarchy } from "../callHierarchy"
import { findCodeActions } from "../codeActions"
import { findCompletions } from "../completion"
import { findDocumentSymbols } from "../documentSymbols"
import { findFoldingRanges } from "../foldingRanges"
import { findHover } from "../hover"
import { findInlayHints } from "../inlayHints"
import {
	findDefinition,
	findRenameableOccurrence,
	renameEdits,
} from "../rename"
import { findSelectionRanges } from "../selectionRanges"
import { findSemanticTokens } from "../semanticTokens"
import { findSignatureHelp } from "../signatureHelp"

// NOTE: What an editor answers over the third written container. A Dictionary
// reaches every walk in the Language Server through a Node kind none of them
// had before, so what is worth pinning is that the two halves of an entry are
// REACHED — a key and a value are both Expressions, and a walk that visited
// only one of them would go blind inside half of every Dictionary anybody
// writes.
//
// NOTE: Where a List or a Record already answers the same question, the
// Dictionary's answer is written as a PAIR with theirs, so a Dictionary can not
// quietly grow — or quietly miss — a behaviour its two sibling containers have.

function programs(source: string) {
	let { program } = parseWithDiagnostics(source)
	let enriched = enrich(program, { annotations: true })

	return { program, enriched }
}

function hover(source: string, cursor: common.Cursor): string | null {
	let { program, enriched } = programs(source)

	return (
		findHover(
			enriched.program,
			cursor,
			program,
			enriched.annotations,
			source,
		)?.content ?? null
	)
}

function labels(source: string, cursor: common.Cursor): Array<string> {
	return findCompletions(source, cursor).map((entry) => entry.label)
}

function tokenAt(source: string, line: number, column: number) {
	let { program, enriched } = programs(source)

	return findSemanticTokens(program, enriched.program).find(
		(token) => token.line === line && token.column === column,
	)
}

function definitionAt(source: string, cursor: common.Cursor) {
	let { program, enriched } = programs(source)

	return findDefinition(program, cursor, enriched.program)
}

// NOTE: Every edit applied to the buffer by hand, last one first, so an earlier
// edit does not move a later one's columns. What comes back is the renamed file
// as an Editor would show it.
function rename(source: string, cursor: common.Cursor, newName: string) {
	let { program, enriched } = programs(source)
	let occurrence = findRenameableOccurrence(program, cursor, enriched.program)

	if (occurrence === null) {
		return null
	}

	let lines = source.split("\n")
	let edits = occurrence.declaration.occurrences
		.flatMap((site) => renameEdits(site, newName))
		.sort(
			(a, b) =>
				b.position.start.line - a.position.start.line ||
				b.position.start.column - a.position.start.column,
		)

	for (let edit of edits) {
		let index = edit.position.start.line - 1
		let line = lines[index] ?? ""

		lines[index] =
			line.slice(0, edit.position.start.column - 1) +
			edit.newText +
			line.slice(edit.position.end.column - 1)
	}

	return lines.join("\n")
}

// NOTE: Every Diagnostic the front end has about a Program, from all three of
// the stages that report one — what an editor draws is the union of them.
function diagnosticsFor(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)
	let enriched = enrich(parsed.program)

	return [
		...parsed.diagnostics,
		...enriched.diagnostics,
		...validate(enriched.program),
	]
}

function spanOf(diagnostic: common.Diagnostic): string {
	let primary =
		diagnostic.labels.find((label) => label.kind === "primary") ??
		diagnostic.labels[0]
	let position = primary?.position ?? diagnostic.position

	if (position === null) {
		return "<none>"
	}

	return `${position.start.line}:${position.start.column}-${position.end.line}:${position.end.column}`
}

// NOTE: Every `wrong-update-brackets` Quick Fix a document offers, and the
// document with them applied — last edit first, so an earlier one does not move
// a later one's columns. What a Quick Fix is worth is the TEXT it leaves, and a
// title alone says nothing about that.
function actionsFor(source: string) {
	let { enriched } = programs(source)
	let [diagnostic] = enriched.diagnostics.filter(
		(entry) => entry.code === "wrong-update-brackets",
	)

	return findCodeActions(source, diagnostic!.position!)
}

function applied(
	source: string,
	actions: ReturnType<typeof findCodeActions>,
): string {
	let lines = source.split("\n")
	let edits = actions
		.filter((action) => action.diagnosticCode === "wrong-update-brackets")
		.flatMap((action) => action.edits)
		.sort(
			(a, b) =>
				b.range.start.line - a.range.start.line ||
				b.range.start.column - a.range.start.column,
		)

	for (let edit of edits) {
		let index = edit.range.start.line - 1

		lines[index] =
			lines[index].slice(0, edit.range.start.column - 1) +
			edit.newText +
			lines[index].slice(edit.range.end.column - 1)
	}

	return lines.join("\n")
}

function textOf(source: string, span: string): string {
	let [start, end] = span.split("-")
	let [startLine, startColumn] = start.split(":").map(Number)
	let [endLine, endColumn] = end.split(":").map(Number)
	let lines = source.split("\n")

	if (startLine !== endLine) {
		return "<multi-line>"
	}

	return lines[startLine - 1].slice(startColumn - 1, endColumn - 1)
}

describe("Dictionary literals", () => {
	describe("Hover", () => {
		let source = [
			"implementation {",
			'\tconstant ages = ["alex" = 39, "sam" = 25]',
			"}",
		].join("\n")

		it("answers the literal with its own Type", () => {
			expect(hover(source, { line: 2, column: 18 })).toBe(
				"Dictionary<String, Integer>",
			)
		})

		it("answers a key and a value with theirs", () => {
			expect(hover(source, { line: 2, column: 20 })).toBe("String")
			expect(hover(source, { line: 2, column: 29 })).toBe("Integer")
		})

		// NOTE: The empty Dictionary answers with what IT says and not with what
		// the annotation above it decided — both slots undecided, exactly as
		// `[]` answers `List<Unknown>` under a `List<Integer>`. The Declaration
		// carries the decided Type and answers with it on its own name.
		it("answers the empty Dictionary with both slots undecided", () => {
			let source = [
				"implementation {",
				"\tconstant ages: Dictionary<String, Integer> = [=]",
				"}",
			].join("\n")

			expect(hover(source, { line: 2, column: 47 })).toBe(
				"Dictionary<Unknown, Unknown>",
			)
			expect(hover(source, { line: 2, column: 11 })).toBe(
				"ages: Dictionary<String, Integer>",
			)
		})
	})

	// NOTE: A key stands in the key slot of the expected Dictionary and a value
	// in the value slot, which is what puts a Choice in reach of a bare `#` in
	// either — the same decision a List's item position makes, made twice.
	describe("Case completion", () => {
		let choice = [
			"implementation {",
			"\tchoice Suit {",
			"\t\tRed,",
			"\t\tBlack,",
			"\t}",
		]

		it("offers the key Type's Cases in key position", () => {
			let source = [
				...choice,
				"\tconstant scores: Dictionary<Suit, Integer> = [# = 1]",
				"}",
			].join("\n")

			expect(
				findCompletions(source, { line: 6, column: 49 }).map(
					(entry) => entry.label,
				),
			).toEqual(["Red", "Black"])
		})

		it("offers the value Type's Cases in value position", () => {
			let source = [
				...choice,
				'\tconstant suits: Dictionary<String, Suit> = ["a" = #]',
				"}",
			].join("\n")

			expect(
				findCompletions(source, { line: 6, column: 53 }).map(
					(entry) => entry.label,
				),
			).toEqual(["Red", "Black"])
		})

		it("offers the base's key Type's Cases inside an update", () => {
			let source = [
				...choice,
				"\tconstant scores: Dictionary<Suit, Integer> = [#Red = 1]",
				"\tconstant more = [scores with # = 2]",
				"}",
			].join("\n")

			expect(
				findCompletions(source, { line: 7, column: 32 }).map(
					(entry) => entry.label,
				),
			).toEqual(["Red", "Black"])
		})

		// NOTE: A name written inside a Dictionary is in Scope like a name
		// written anywhere else, which is what says the walk reaches BOTH
		// halves of an entry rather than only the one a List would have.
		it("completes a name written in either half", () => {
			let source = [
				"implementation {",
				"\tconstant alexander = 39",
				"\tconstant ages = [alexan = alexan]",
				"}",
			].join("\n")

			expect(
				findCompletions(source, { line: 3, column: 24 }),
			).toContainEqual(expect.objectContaining({ label: "alexander" }))
			expect(
				findCompletions(source, { line: 3, column: 33 }),
			).toContainEqual(expect.objectContaining({ label: "alexander" }))
		})
	})

	describe("ranges", () => {
		let source = [
			"implementation {",
			"\tconstant ages = [",
			'\t\t"alex" = 39,',
			'\t\t"sam" = 25,',
			"\t]",
			"}",
		].join("\n")

		it("folds the brackets", () => {
			let { program } = parseWithDiagnostics(source)

			expect(findFoldingRanges(program)).toContainEqual({
				startLine: 2,
				endLine: 4,
			})
		})

		// NOTE: Widening from a key reaches the key itself first and the whole
		// literal further out — the entries are two Expressions deep where a
		// List's items are one, and both depths have to be walked for a widen
		// from inside an entry to stop where a reader expects.
		it("widens from a key out to the literal", () => {
			let { program } = parseWithDiagnostics(source)
			let ranges = findSelectionRanges(program, { line: 3, column: 3 })
			let spans = ranges.map(
				(range) =>
					`${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`,
			)

			expect(spans[0]).toBe("3:3-3:9")
			expect(spans).toContain("2:18-5:3")
		})

		// NOTE: And the ENTRY stands between them. A Dictionary entry is the
		// one member-shaped Node in the language that has a Position of its own
		// covering `key = value`; a Record member does not, which is why a
		// Record can not stop there and a Dictionary can.
		it("widens from a value through the entry", () => {
			let { program } = parseWithDiagnostics(source)
			let spans = findSelectionRanges(program, {
				line: 3,
				column: 12,
			}).map(
				(range) =>
					`${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`,
			)

			expect(spans[0]).toBe("3:12-3:14")
			expect(spans[1]).toBe("3:3-3:14")
			expect(spans[2]).toBe("2:18-5:3")
		})

		// NOTE: An update's key list folds as its own range — it is a Node with
		// a Position, and a reader collapsing a long update wants the entries
		// gone and the base left standing.
		it("folds a multi-line update's key list", () => {
			let { program } = parseWithDiagnostics(
				[
					"implementation {",
					"\tconstant ages = [",
					'\t\t"alex" = 39,',
					'\t\t"sam" = 25,',
					"\t]",
					"\tconstant older = [",
					"\t\tages with",
					'\t\t\t"alex" = 40,',
					'\t\t\t"kim" = 7,',
					"\t]",
					"}",
				].join("\n"),
			)
			let ranges = findFoldingRanges(program)

			expect(ranges).toContainEqual({ startLine: 2, endLine: 4 })
			expect(ranges).toContainEqual({ startLine: 8, endLine: 8 })
		})
	})

	// NOTE: A Dictionary's key is an Expression standing where no container put
	// one before, so every walk that reaches a value has to reach a key too.
	// These ask that of the walks the Hover and Completion tests above do not.
	describe("both halves of an entry", () => {
		it("offers Dictionary Methods after a written literal", () => {
			let source = [
				"implementation {",
				'\tconstant n = ["a" = 1]::',
				"}",
			].join("\n")
			let offered = labels(source, { line: 2, column: 26 })

			expect(offered).toContain("length")
			expect(offered).toContain("value")
			expect(offered).toContain("keys")
		})

		it("offers Methods on a receiver written inside a value", () => {
			let source = [
				"implementation {",
				'\tconstant d = ["a" = "text"::]',
				"}",
			].join("\n")

			expect(labels(source, { line: 2, column: 30 })).toContain("length")
		})

		it("offers Methods on a receiver written inside a key", () => {
			let source = [
				"implementation {",
				'\tconstant d = ["text":: = 1]',
				"}",
			].join("\n")

			expect(labels(source, { line: 2, column: 24 })).toContain("length")
		})

		it("reaches a Constant used as a key, as a value and as a base", () => {
			let source = [
				"implementation {",
				'\tconstant alex = "alex"',
				"\tconstant age = 39",
				"\tconstant ages = [alex = age]",
				"\tconstant older = [ages with alex = 40]",
				"}",
			].join("\n")

			expect(
				definitionAt(source, { line: 4, column: 19 })?.start.line,
			).toBe(2)
			expect(
				definitionAt(source, { line: 4, column: 26 })?.start.line,
			).toBe(3)
			expect(
				definitionAt(source, { line: 5, column: 21 })?.start.line,
			).toBe(4)
			expect(
				definitionAt(source, { line: 5, column: 30 })?.start.line,
			).toBe(2)
		})

		it("renames a Constant used as a key in a literal and in an update", () => {
			let source = [
				"implementation {",
				'\tconstant alex = "alex"',
				"\tconstant ages = [alex = 39]",
				"\tconstant older = [ages with alex = 40]",
				"}",
			].join("\n")

			expect(rename(source, { line: 3, column: 19 }, "alexander")).toBe(
				[
					"implementation {",
					'\tconstant alexander = "alex"',
					"\tconstant ages = [alexander = 39]",
					"\tconstant older = [ages with alexander = 40]",
					"}",
				].join("\n"),
			)
		})

		it("reaches a call written in a key and in a value", () => {
			let source = [
				"implementation {",
				"\tfunction key () -> String {",
				'\t\t<- "a"',
				"\t}",
				"\tfunction age () -> Integer {",
				"\t\t<- 39",
				"\t}",
				"\tconstant ages = [key() = age()]",
				"}",
			].join("\n")
			let { program, enriched } = programs(source)
			let sites = collectCallSites(program, enriched.program)

			expect(sites.map((site) => site.callee.name)).toContain("key")
			expect(sites.map((site) => site.callee.name)).toContain("age")
			expect(findDocumentSymbols(program).length).toBeGreaterThan(0)
			expect(
				prepareCallHierarchy(
					program,
					{ line: 8, column: 20 },
					enriched.program,
				),
			).not.toBeNull()
		})

		it("reaches a call written inside an entry's value", () => {
			let source = [
				"implementation {",
				"\tfunction double (_ n: Integer) -> Integer {",
				"\t\t<- n",
				"\t}",
				'\tconstant ages = ["alex" = double(',
				"}",
			].join("\n")

			expect(
				findSignatureHelp(source, { line: 5, column: 35 })
					?.signatures[0].label,
			).toBe("double(_ Integer) -> Integer")
		})

		it("reaches a call written inside an entry's key", () => {
			let source = [
				"implementation {",
				"\tfunction double (_ n: Integer) -> Integer {",
				"\t\t<- n",
				"\t}",
				"\tconstant ages = [double(",
				"}",
			].join("\n")

			expect(
				findSignatureHelp(source, { line: 5, column: 26 })
					?.signatures[0].label,
			).toBe("double(_ Integer) -> Integer")
		})

		it("colours a bare Case written as a key and as a value", () => {
			let source = [
				"implementation {",
				"\tchoice Suit {",
				"\t\tRed,",
				"\t\tBlack,",
				"\t}",
				"\tconstant a: Dictionary<Suit, Suit> = [#Red = #Black]",
				"}",
			].join("\n")

			expect(tokenAt(source, 6, 41)?.type).toBe("enumMember")
			expect(tokenAt(source, 6, 48)?.type).toBe("enumMember")
		})
	})

	describe("what an editor draws beside a Dictionary", () => {
		it("offers both value entries on a Dictionary receiver", () => {
			let source = [
				"implementation {",
				'\tconstant ages = ["alex" = 39]',
				"\tconstant a = ages::value(",
				"}",
			].join("\n")

			expect(
				findSignatureHelp(source, {
					line: 3,
					column: 27,
				})?.signatures.map((signature) => signature.label),
			).toEqual([
				"value<ValueType, KeyType is Equatable>(at: KeyType) -> Optional<ValueType>",
				"value<ValueType, KeyType is Equatable>(at: KeyType, defaultingTo: ValueType) -> ValueType",
			])
		})

		it("hints the Type of a Constant bound to a written Dictionary", () => {
			let { enriched } = programs(
				[
					"implementation {",
					'\tconstant ages = ["alex" = 39]',
					"}",
				].join("\n"),
			)

			expect(
				findInlayHints(enriched.program).map((hint) => hint.label),
			).toContain(": Dictionary<String, Integer>")
		})

		it("answers the update with the Dictionary it makes", () => {
			let source = [
				"implementation {",
				'\tconstant ages = ["alex" = 39]',
				'\tconstant older = [ages with "alex" = 40]',
				"}",
			].join("\n")

			expect(hover(source, { line: 3, column: 11 })).toBe(
				"older: Dictionary<String, Integer>",
			)
		})

		it("answers over the '=' of an entry with the literal's Type", () => {
			let source = [
				"implementation {",
				'\tconstant ages = ["alex" = 39]',
				"}",
			].join("\n")

			expect(hover(source, { line: 2, column: 26 })).toBe(
				"Dictionary<String, Integer>",
			)
		})

		// NOTE: The primary Label is the SECOND key — the one to delete — and
		// the secondary points at the first, which is the pair
		// `reportDuplicateDeclaration` is the model for.
		it("squiggles the second key of a duplicate, and points at the first", () => {
			let source = [
				"implementation {",
				'\tconstant d = ["a" = 1, "a" = 2]',
				"}",
			].join("\n")
			let [diagnostic] = diagnosticsFor(source)

			expect(diagnostic.code).toBe("duplicate-key")
			expect(spanOf(diagnostic)).toBe("2:25-2:28")
			expect(textOf(source, spanOf(diagnostic))).toBe('"a"')

			let secondary = diagnostic.labels.find(
				(label) => label.kind !== "primary",
			)!

			expect(
				textOf(
					source,
					`${secondary.position.start.line}:${secondary.position.start.column}-${secondary.position.end.line}:${secondary.position.end.column}`,
				),
			).toBe('"a"')
			expect(secondary.position.start.column).toBe(16)
		})

		// NOTE: ONCE. The shape is wrong, so nothing inside the update is a
		// name the Program meant to write — an `unknown-name` about `port`
		// beside it is noise that sends the reader after a Declaration nobody
		// needs.
		it("reports a Record updated in brackets exactly once", () => {
			let source = [
				"implementation {",
				"\tconstant config = { port = 1 }",
				"\tconstant moved = [config with port = 2]",
				"}",
			].join("\n")
			let codes = diagnosticsFor(source).map(
				(diagnostic) => diagnostic.code,
			)

			expect(codes).toEqual(["wrong-update-brackets"])
		})

		// NOTE: The braced spelling of a Dictionary update is the mistake this
		// feature invites most, and it is reached by the Parser rather than the
		// Enricher — the value key gives the form away one Token past the
		// `with`, where no reading of the text goes any further.
		it("tells a Dictionary update written in braces which brackets it wants", () => {
			let source = [
				"implementation {",
				'\tconstant ages = ["alex" = 39]',
				'\tconstant older = { ages with "alex" = 40 }',
				"}",
			].join("\n")
			let [diagnostic] = diagnosticsFor(source)

			expect(diagnostic.message).toBe(
				"A key that is a value belongs to a Dictionary",
			)
			expect(diagnostic.code).toBe("wrong-update-brackets")
		})

		// NOTE: The same rule, one Token earlier. Pinned beside the case above
		// so the gap that used to stand between them is visible.
		it("tells a Dictionary literal written in braces which brackets it wants", () => {
			let source = [
				"implementation {",
				'\tconstant ages = { "alex" = 39 }',
				"}",
			].join("\n")
			let [diagnostic] = diagnosticsFor(source)

			expect(diagnostic.message).toBe(
				"A key that is a value belongs to a Dictionary",
			)
		})

		it("does not claim a Dictionary can not be combined", () => {
			let source = [
				"implementation {",
				"\tconstant names = [1, 2]",
				"\tconstant more = [names with 3]",
				"}",
			].join("\n")
			let [diagnostic] = diagnosticsFor(source)

			expect(diagnostic.code).toBe("uncombinable-types")
			expect(diagnostic.notes).not.toContain(
				"Only Records and Namespaces can be combined.",
			)
		})

		// NOTE: The most mechanical fix the feature has — one pair of brackets
		// for the other — and the padding travels with the pair, because
		// `{ … }` pads and `[…]` does not.
		it("offers a Quick Fix that swaps the brackets", () => {
			let source = [
				"implementation {",
				'\tconstant ages = ["alex" = 39]',
				"\tconstant older = { ages with ages }",
				"}",
			].join("\n")
			let { enriched } = programs(source)
			let diagnostics = enriched.diagnostics.filter(
				(diagnostic) => diagnostic.code === "wrong-update-brackets",
			)

			expect(diagnostics).toHaveLength(1)

			let actions = findCodeActions(source, diagnostics[0].position!)

			expect(actions.map((action) => action.title)).toContainEqual(
				"Write the update in brackets",
			)
			expect(applied(source, actions)).toBe(
				[
					"implementation {",
					'\tconstant ages = ["alex" = 39]',
					"\tconstant older = [ages with ages]",
					"}",
				].join("\n"),
			)
		})

		// NOTE: The other direction, and both of them over an update laid out
		// on several lines — where the space beside a bracket is the INDENTATION
		// of a closing line rather than the padding, and swapping it would leave
		// the `]` at column one.
		it("swaps the brackets of a multi-line update either way", () => {
			let braced = [
				"implementation {",
				'\tconstant ages = ["alex" = 39]',
				"\tconstant older = {",
				"\t\tages with",
				"\t\t\tages",
				"\t}",
				"}",
			].join("\n")
			let bracketed = [
				"implementation {",
				"\tconstant config = { port = 1 }",
				"\tconstant moved = [",
				"\t\tconfig with",
				"\t\t\tconfig",
				"\t]",
				"}",
			].join("\n")

			expect(applied(braced, actionsFor(braced))).toBe(
				braced.replace("= {", "= [").replace("\t}", "\t]"),
			)
			expect(applied(bracketed, actionsFor(bracketed))).toBe(
				bracketed.replace("= [", "= {").replace("\t]", "\t}"),
			)
		})
	})
})
