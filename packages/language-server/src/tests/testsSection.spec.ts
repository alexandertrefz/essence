import { afterEach, describe, expect, it } from "bun:test"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/documents"
import { enrich } from "@essence-lang/compiler/enricher"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import type { common } from "@essence-lang/interfaces"

import { findIncomingCalls, prepareCallHierarchy } from "../callHierarchy"
import { findCompletions } from "../completion"
import { findFoldingRanges } from "../foldingRanges"
import { findHover } from "../hover"
import { findInlayHints } from "../inlayHints"
import {
	findDefinition,
	findRenameableOccurrence,
	renameEdits,
} from "../rename"
import { typedProgramSections } from "../sections"
import { findSelectionRanges } from "../selectionRanges"
import { findSemanticTokens } from "../semanticTokens"
import { findSignatureHelp } from "../signatureHelp"
import { createWorkspace, type Workspace } from "../workspace"

// NOTE: Everything the Language Server can say about a file used to stop at the
// implementation. These are the answers inside the `tests { … }` block: the
// same Hover, the same rename, the same Completion, plus the three binders only
// a test has — a table's row, a property's generated Parameters, and the names
// a `require MATCHER = EXPR` introduces.
//
// The Editor's own Workspace types the section, so every helper here asks for
// it exactly as the Server does.

function compile(source: string) {
	let { program } = parseWithDiagnostics(source)
	let {
		program: enrichedProgram,
		diagnostics,
		annotations,
	} = enrich(program, { tests: true, annotations: true, source })

	return { program, enrichedProgram, diagnostics, annotations }
}

// NOTE: A Cursor by what it points AT — the sources below are tab-indented, so
// a column counted by hand would be a fact about the whitespace.
function cursorAt(
	source: string,
	needle: string,
	occurrence: number = 1,
): common.Cursor {
	let lines = source.split("\n")
	let seen = 0

	for (let [index, text] of lines.entries()) {
		let column = -1

		while ((column = text.indexOf(needle, column + 1)) !== -1) {
			seen += 1

			if (seen === occurrence) {
				return { line: index + 1, column: column + 1 }
			}
		}
	}

	throw new Error(`'${needle}' is not written ${occurrence} time(s) here`)
}

// NOTE: Directly BEHIND what was written, which is where an Editor asks a
// Completion from.
function cursorPast(
	source: string,
	needle: string,
	occurrence: number = 1,
): common.Cursor {
	let cursor = cursorAt(source, needle, occurrence)

	return { line: cursor.line, column: cursor.column + needle.length }
}

// NOTE: A name written INSIDE a longer piece of text — `row` of `(row: Row)` —
// so that a cursor is stated by what it points at even where the name is
// written many times over.
function cursorWithin(
	source: string,
	needle: string,
	name: string,
	occurrence: number = 1,
): common.Cursor {
	let cursor = cursorAt(source, needle, occurrence)

	return { line: cursor.line, column: cursor.column + needle.indexOf(name) }
}

function hover(source: string, cursor: common.Cursor): string | null {
	let { program, enrichedProgram, annotations } = compile(source)

	return (
		findHover(enrichedProgram, cursor, program, annotations)?.content ??
		null
	)
}

// NOTE: Applied textually, through `renameEdits`, so an expectation can state a
// whole Program — the shape `rename.spec.ts` uses.
function rename(source: string, cursor: common.Cursor, newName: string) {
	let { program, enrichedProgram } = compile(source)
	let occurrence = findRenameableOccurrence(program, cursor, enrichedProgram)

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

	for (let { position, newText } of edits) {
		let line = lines[position.start.line - 1] ?? ""

		lines[position.start.line - 1] =
			line.slice(0, position.start.column - 1) +
			newText +
			line.slice(position.end.column - 1)
	}

	return lines.join("\n")
}

function definition(source: string, cursor: common.Cursor) {
	let { program, enrichedProgram } = compile(source)

	return findDefinition(program, cursor, enrichedProgram)
}

function tokensOf(source: string) {
	let { program, enrichedProgram } = compile(source)

	return findSemanticTokens(program, enrichedProgram)
}

function labelsOf(source: string, cursor: common.Cursor) {
	return findCompletions(source, cursor).map((entry) => entry.label)
}

// NOTE: One Program that carries every form the section has: setup beside the
// tests, a suite with a Scope of its own, a `require` that takes a value apart,
// a table test and a property test.
const source = [
	"implementation {",
	"\ttype Row = { scored: Integer, points: Integer }",
	"",
	"\tconstant blank: Row = { scored = 0, points = 0 }",
	"",
	"\tfunction pointsFor(_ scored: Integer) -> Integer {",
	"\t\t<- scored",
	"\t}",
	"}",
	"tests {",
	"\tconstant rows: List<Row> = [{ scored = 2, points = 3 }]",
	"",
	'\tsuite "scoring" {',
	'\t\ttest "reads a row" {',
	"\t\t\trequire #Value(row) = rows::item(at 0)",
	"",
	"\t\t\texpect pointsFor(row.scored)::is(row.points)",
	"\t\t}",
	"",
	'\t\ttest "scores {row.scored}" across [',
	"\t\t\t{ scored = 1, points = 1 },",
	"\t\t] (row: Row) {",
	"\t\t\texpect pointsFor(row.scored)::is(row.points)",
	"\t\t}",
	"",
	'\t\ttest "is worth what it scores" for any (goals: Integer) {',
	"\t\t\texpect pointsFor(goals)::is(goals)",
	"\t\t}",
	"\t}",
	"}",
].join("\n")

describe("The tests section", () => {
	it("should type-check with nothing left unresolved", () => {
		expect(compile(source).diagnostics).toEqual([])
	})

	describe("Hover", () => {
		it("should answer an implementation name read in a test body", () => {
			expect(hover(source, cursorAt(source, "pointsFor", 2))).toBe(
				"pointsFor(_ Integer) -> Integer",
			)
		})

		it("should answer a name a suite's setup declared", () => {
			expect(hover(source, cursorAt(source, "rows", 2))).toBe(
				"rows: List<{ scored: Integer, points: Integer }>",
			)
		})

		// NOTE: The Type the MATCHER proved, not the one the asserted
		// Expression had — a `require` only lets the lines below it run where
		// the Matcher matched, so below it the value IS what the Case carried.
		it("should answer a require-bound name with the Matcher's Type", () => {
			expect(hover(source, cursorAt(source, "row.scored", 1))).toBe(
				"row: { scored: Integer, points: Integer }",
			)
			expect(
				hover(source, cursorWithin(source, "row.scored", "scored", 1)),
			).toBe("scored: Integer")
		})

		it("should answer a generated Parameter with what it generates", () => {
			expect(hover(source, cursorAt(source, "goals: Integer"))).toBe(
				"goals: Integer",
			)
		})

		it("should answer a Statement of the tests section itself", () => {
			expect(hover(source, cursorAt(source, "rows: List<Row>"))).toBe(
				"rows: List<{ scored: Integer, points: Integer }>",
			)
		})
	})

	describe("Rename", () => {
		it("should rename an implementation Function through every test that calls it", () => {
			let renamed = rename(
				source,
				cursorAt(source, "pointsFor", 1),
				"scoreOf",
			)

			expect(renamed).not.toBeNull()
			expect(renamed).toBe(source.replaceAll("pointsFor", "scoreOf"))
		})

		it("should rename an implementation Type named in a tests section", () => {
			let renamed = rename(source, cursorAt(source, "Row"), "Scoreline")

			expect(renamed).not.toBeNull()
			expect(renamed).toContain("constant rows: List<Scoreline> =")
			expect(renamed).toContain("] (row: Scoreline) {")
			expect(renamed).toContain("\ttype Scoreline = {")
		})

		it("should rename an implementation Constant no test reads without touching the tests", () => {
			let renamed = rename(source, cursorAt(source, "blank"), "empty")

			expect(renamed).toBe(source.replace("blank", "empty"))
		})

		// NOTE: Started from the binder AND from a use of it, because the two
		// have to reach the same Declaration — the binder is written in the
		// Matcher and the Constant the Enricher desugars it into stands at that
		// very span.
		it("should rename a require-bound name from either end", () => {
			let expected = [
				"\t\t\trequire #Value(scored) = rows::item(at 0)",
				"",
				"\t\t\texpect pointsFor(scored.scored)::is(scored.points)",
			].join("\n")

			expect(
				rename(
					source,
					cursorWithin(source, "#Value(row)", "row"),
					"scored",
				),
			).toContain(expected)
			expect(
				rename(source, cursorAt(source, "row.scored", 1), "scored"),
			).toContain(expected)
		})

		// NOTE: The name reads the row as well as the body does, which is what
		// a table test's interpolated name is for — so renaming the Parameter
		// has to reach into the String above it.
		it("should rename a table test's row Parameter, its name included", () => {
			let renamed = rename(
				source,
				cursorWithin(source, "] (row: Row)", "row"),
				"line",
			)

			expect(renamed).toContain('test "scores {line.scored}" across [')
			expect(renamed).toContain("] (line: Row) {")
			expect(renamed).toContain(
				"expect pointsFor(line.scored)::is(line.points)",
			)
			// NOTE: The OTHER test's `row` is a different Declaration entirely
			// — a test's body is a Scope of its own.
			expect(renamed).toContain("require #Value(row) = rows::item(at 0)")
		})

		it("should rename a generated Parameter of a property test", () => {
			let renamed = rename(
				source,
				cursorAt(source, "goals: Integer"),
				"scored",
			)

			expect(renamed).toContain("for any (scored: Integer) {")
			expect(renamed).toContain("expect pointsFor(scored)::is(scored)")
		})

		it("should rename a Constant the tests section declares", () => {
			let renamed = rename(source, cursorAt(source, "rows", 1), "table")

			expect(renamed).toContain("constant table: List<Row> =")
			expect(renamed).toContain("require #Value(row) = table::item(at 0)")
		})
	})

	describe("Go to definition", () => {
		it("should reach an implementation Function from a test body", () => {
			expect(
				definition(source, cursorAt(source, "pointsFor", 2)),
			).toEqual({
				start: cursorAt(source, "pointsFor", 1),
				end: {
					line: cursorAt(source, "pointsFor", 1).line,
					column: cursorAt(source, "pointsFor", 1).column + 9,
				},
			})
		})

		it("should reach a require-bound name from the line that reads it", () => {
			let binder = cursorWithin(source, "#Value(row)", "row")

			expect(
				definition(source, cursorAt(source, "row.scored", 1)),
			).toEqual({
				start: binder,
				end: { line: binder.line, column: binder.column + 3 },
			})
		})
	})

	describe("Semantic Tokens", () => {
		let tokens = tokensOf(source)
		let tokenAt = (cursor: common.Cursor) =>
			tokens.find(
				(token) =>
					token.line === cursor.line &&
					token.column === cursor.column,
			)

		it("should classify a call written in a test body", () => {
			expect(tokenAt(cursorAt(source, "pointsFor", 2))?.type).toBe(
				"function",
			)
		})

		it("should classify a require-bound name and the members it reads", () => {
			expect(
				tokenAt(cursorWithin(source, "#Value(row)", "row"))?.type,
			).toBe("variable")
			expect(tokenAt(cursorAt(source, "row.scored", 1))?.type).toBe(
				"variable",
			)
			expect(
				tokenAt(cursorWithin(source, "row.scored", "scored", 1))?.type,
			).toBe("property")
		})

		it("should classify a table's row Parameter and a generated one", () => {
			expect(
				tokenAt(cursorWithin(source, "] (row: Row)", "row"))?.type,
			).toBe("parameter")
			expect(tokenAt(cursorAt(source, "goals: Integer"))?.type).toBe(
				"parameter",
			)
		})
	})

	describe("Completion", () => {
		// NOTE: The Methods of what the MATCHER proved — a Record here, whose
		// Namespace is what `::` offers.
		it("should offer Methods on a require-bound name", () => {
			let text = source.replace(
				"expect pointsFor(row.scored)::is(row.points)",
				"expect row::",
			)

			expect(labelsOf(text, cursorPast(text, "expect row::"))).toContain(
				"is",
			)
		})

		it("should offer the members of a require-bound name", () => {
			let text = source.replace(
				"expect pointsFor(row.scored)::is(row.points)",
				"expect row.",
			)

			expect(labelsOf(text, cursorPast(text, "expect row."))).toEqual([
				"scored",
				"points",
			])
		})

		// NOTE: A `require` binds for the rest of the block BELOW it, exactly as
		// a Declaration does — offering the name above the line that binds it
		// would offer a name the Enricher refuses.
		it("should not offer a require-bound name above the line that binds it", () => {
			let text = [
				"implementation {}",
				"tests {",
				'\ttest "reads a row" {',
				"\t\tconstant early = r",
				"\t\trequire #Value(row) = [1]::item(at 0)",
				"\t}",
				"}",
			].join("\n")

			expect(labelsOf(text, { line: 4, column: 21 })).not.toContain("row")

			let below = [
				"implementation {}",
				"tests {",
				'\ttest "reads a row" {',
				"\t\trequire #Value(row) = [1]::item(at 0)",
				"\t\tconstant late = r",
				"\t}",
				"}",
			].join("\n")

			expect(labelsOf(below, { line: 5, column: 20 })).toContain("row")
		})
	})

	describe("Signature Help", () => {
		it("should show a Function's signature inside a test body", () => {
			let text = [
				"implementation {",
				"\tfunction greet(subject: String) -> String {",
				"\t\t<- subject",
				"\t}",
				"}",
				"tests {",
				'\ttest "greets" {',
				"\t\texpect greet(",
				"\t}",
				"}",
			].join("\n")

			let help = findSignatureHelp(
				text,
				cursorPast(text, "expect greet("),
			)

			expect(help?.signatures[0].label).toBe(
				"greet(subject: String) -> String",
			)
		})
	})

	describe("Inlay Hints and the Call Hierarchy", () => {
		it("should hint the Type of a Constant declared in a test body", () => {
			let text = source.replace(
				"expect pointsFor(row.scored)::is(row.points)",
				"constant total = pointsFor(row.scored)",
			)
			let { enrichedProgram } = compile(text)
			let hints = findInlayHints(enrichedProgram)
			let declaration = cursorAt(text, "constant total")

			expect(
				hints.find(
					(hint) =>
						hint.position.line === declaration.line &&
						hint.label === ": Integer",
				),
			).toBeDefined()
		})

		// NOTE: What a reader asks of a Function is whether the tests reach it,
		// so a call written in an assertion has to be an incoming call — and it
		// attributes to the `tests { … }` block, the way a top level Statement
		// attributes to the implementation.
		it("should report a call written in a test body as an incoming call", () => {
			let { program, enrichedProgram } = compile(source)
			let item = prepareCallHierarchy(
				program,
				cursorAt(source, "pointsFor", 1),
				enrichedProgram,
			)

			expect(item).not.toBeNull()

			let callers = findIncomingCalls(
				program,
				cursorAt(source, "pointsFor", 1),
				enrichedProgram,
			).map((call) => call.item.name)

			expect(callers).toContain("tests")
		})
	})

	describe("Folding and selection", () => {
		it("should fold the tests block, each suite and each test", () => {
			let { program } = parseWithDiagnostics(source)
			let folded = findFoldingRanges(program).map(
				(range) => range.startLine,
			)

			expect(folded).toContain(cursorAt(source, "tests {").line)
			expect(folded).toContain(cursorAt(source, 'suite "scoring"').line)
			expect(folded).toContain(
				cursorAt(source, 'test "reads a row"').line,
			)
		})

		// NOTE: Outwards from a Statement to the test, the suite and the block —
		// and never through the implementation, whose span the cursor is not in.
		it("should expand a selection out through the test and the suite", () => {
			let { program } = parseWithDiagnostics(source)
			let chain = findSelectionRanges(
				program,
				cursorAt(source, "pointsFor", 2),
			)
			let lines = chain.map((position) => position.start.line)

			expect(lines).toEqual([...lines].sort((a, b) => b - a))
			expect(lines).toContain(cursorAt(source, 'test "reads a row"').line)
			expect(lines).toContain(cursorAt(source, 'suite "scoring"').line)
			expect(lines).toContain(cursorAt(source, "tests {").line)
			expect(lines).not.toContain(1)
		})
	})

	// NOTE: The section the Enricher hands back holds the `@example` blocks as
	// the tests they are, and those stand at Positions inside a Comment. The
	// walk covers what the SOURCE wrote, so a rename never writes into a `§§`
	// line and no Semantic Token is drawn over one.
	describe("Documentation examples", () => {
		const documented = [
			"implementation {",
			"\t§§ Doubles a number.",
			"\t§§",
			"\t§§ @example",
			"\t§§ expect double(of 2)::is(4)",
			"\t§§ @param of — the number.",
			"\t§§ @returns — twice it.",
			"\tfunction double(of number: Integer) -> Integer {",
			"\t\t<- number::multiply(with 2)",
			"\t}",
			"}",
			"tests {",
			'\ttest "doubles" {',
			"\t\texpect double(of 2)::is(4)",
			"\t}",
			"}",
		].join("\n")

		it("should leave the synthesized suite out of the walk", () => {
			let { enrichedProgram } = compile(documented)

			expect(
				enrichedProgram.tests?.nodes.map((node) => node.nodeType),
			).toEqual(["Test", "Suite"])
			expect(
				typedProgramSections(enrichedProgram).map(
					(section) => section.kind,
				),
			).toEqual(["implementation", "tests", "test"])
		})

		it("should rename the written test and leave the example alone", () => {
			let renamed = rename(
				documented,
				cursorAt(documented, "double", 2),
				"twice",
			)

			expect(renamed).toContain("\tfunction twice(of number: Integer)")
			expect(renamed).toContain("\t\texpect twice(of 2)::is(4)")
			expect(renamed).toContain("\t§§ expect double(of 2)::is(4)")
		})
	})

	// NOTE: The `contracts` suite is synthesized the same way and left out of
	// the walk by the same rule — it stands at the section's own span, since no
	// source wrote a span for it. The Editor never compiles with the goals on
	// today, so this is the guarantee that turning them on would cost the walk
	// nothing rather than a behaviour anybody sees.
	describe("Contract goals", () => {
		const declaring = [
			"implementation {",
			"\ttype Positive = Integer where @::isGreaterThan(0)",
			"\tnamespace Counting for Integer {",
			"\t\tup() -> Positive {",
			"\t\t\t<- 1",
			"\t\t}",
			"\t}",
			"}",
			"tests {",
			'\ttest "counts" {',
			"\t\texpect 1::isGreaterThan(0)",
			"\t}",
			"}",
		].join("\n")

		it("should leave the contracts suite out of the walk", () => {
			let { program } = parseWithDiagnostics(declaring)
			let { program: enrichedProgram } = enrich(program, {
				tests: true,
				contracts: true,
				annotations: true,
				source: declaring,
			})

			expect(
				enrichedProgram.tests?.nodes.map((node) => node.nodeType),
			).toEqual(["Test", "Suite"])
			expect(
				typedProgramSections(enrichedProgram).map(
					(section) => section.kind,
				),
			).toEqual(["implementation", "tests", "test"])
		})
	})
})

// NOTE: The cross-Module half. `examples/league` is the real thing this feature
// was written for: `Season.tests.es` is a file of nothing but imports and a
// `tests { … }` block, and every name it proves something about is declared in
// another file.
describe("The tests section across Modules", () => {
	const EXAMPLE = path.join(
		import.meta.dirname,
		"..",
		"..",
		"..",
		"..",
		"examples",
		"league",
	)

	let directories: Array<string> = []

	afterEach(() => {
		for (let directory of directories) {
			rmSync(directory, { recursive: true, force: true })
		}

		directories = []
	})

	// NOTE: Copied rather than indexed where they lie — a Workspace walks the
	// directory it is given, and the example's own directory is not this spec's
	// to hand out.
	function leagueWorkspace(): {
		workspace: Workspace
		pathOf: (name: string) => string
	} {
		let root = canonicalPath(
			mkdtempSync(path.join(tmpdir(), "essence-league-lsp-")),
		)

		directories.push(root)

		for (let name of [
			"Season.es",
			"Standings.es",
			"Table.es",
			"Season.tests.es",
		]) {
			copyFileSync(path.join(EXAMPLE, name), path.join(root, name))
		}

		// NOTE: With the tests ON, as the Server's own Workspace has them.
		let workspace = createWorkspace({ tests: true })

		workspace.setFolders([root])

		return {
			workspace,
			pathOf: (name: string) => canonicalPath(path.join(root, name)),
		}
	}

	it("should reach a test body in another Module when an exported name is renamed", () => {
		let { workspace, pathOf } = leagueWorkspace()
		let seasonPath = pathOf("Season.es")
		let season = workspace.sourceOf(seasonPath) ?? ""
		let declaration = cursorAt(season, "constant fixtures")
		let symbol = workspace.symbolAt(seasonPath, {
			line: declaration.line,
			column: declaration.column + "constant ".length,
		})

		expect(symbol).not.toBeNull()
		expect(symbol?.name).toBe("fixtures")

		let inTests = (symbol?.occurrences ?? []).filter(
			(occurrence) => occurrence.filePath === pathOf("Season.tests.es"),
		)
		let testsSource = workspace.sourceOf(pathOf("Season.tests.es")) ?? ""
		let testsLines = testsSource.split("\n")

		// NOTE: The import entry AND every reading of it inside the
		// `tests { … }` block — before the section was walked, the entry was
		// renamed on its own and every use of it was left behind, which is a
		// rename that breaks the file it was asked for.
		expect(inTests.length).toBeGreaterThan(1)
		expect(
			inTests.every((occurrence) =>
				(testsLines[occurrence.position.start.line - 1] ?? "").includes(
					"fixtures",
				),
			),
		).toBe(true)
		expect(
			inTests.some(
				(occurrence) =>
					occurrence.position.start.line >
					cursorAt(testsSource, "tests {").line,
			),
		).toBe(true)
	})

	it("should answer a Hover inside another Module's tests", () => {
		let { workspace, pathOf } = leagueWorkspace()
		let testsPath = pathOf("Season.tests.es")
		let testsSource = workspace.sourceOf(testsPath) ?? ""
		let analysis = workspace.analysisOf(testsPath)
		let cursor = cursorAt(testsSource, "constant leader")

		expect(analysis?.enrichedProgram).not.toBeNull()

		let info = findHover(
			analysis!.enrichedProgram!,
			{ line: cursor.line, column: cursor.column + "constant ".length },
			analysis!.program!,
			workspace.annotationsOf(testsPath) ?? [],
		)

		expect(info?.content).toContain("leader")
	})
})
