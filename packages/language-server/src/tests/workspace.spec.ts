import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { canonicalPath, parseDocument } from "@essence-lang/compiler/documents"
import type { common } from "@essence-lang/interfaces"

import { analyseDocument, documentFilePath } from "../analyse"
import { insertImportEdit, relativeSpecifier } from "../autoImport"
import { findCodeActions } from "../codeActions"
import { findCompletions } from "../completion"
import { findHover } from "../hover"
import { uriOf } from "../server"
import { createWorkspace, type Workspace } from "../workspace"

// NOTE: A workspace is a directory of files, so these run against a real one.
// The alternative — an in-memory host — would exercise everything except the
// two things that actually break: which path a specifier resolves to, and
// whether the discovery walk finds a file at all.
let directories: Array<string> = []

function makeWorkspace(files: Record<string, string>): {
	workspace: Workspace
	root: string
	pathOf: (name: string) => string
} {
	let root = canonicalPath(mkdtempSync(path.join(tmpdir(), "essence-ws-")))

	directories.push(root)

	for (let [name, contents] of Object.entries(files)) {
		let filePath = path.join(root, name)

		mkdirSync(path.dirname(filePath), { recursive: true })
		writeFileSync(filePath, contents)
	}

	let workspace = createWorkspace()

	workspace.setFolders([root])

	return {
		workspace,
		root,
		pathOf: (name: string) => canonicalPath(path.join(root, name)),
	}
}

afterEach(() => {
	for (let directory of directories) {
		rmSync(directory, { recursive: true, force: true })
	}

	directories = []
})

// NOTE: A Cursor by what it points AT rather than by a column counted out by
// hand — a tab is one column here and the sources below are tab-indented, so a
// counted column is a fact about the whitespace rather than about the name.
function cursorAt(source: string, line: number, needle: string): common.Cursor {
	let text = source.split("\n")[line - 1] ?? ""
	let column = text.indexOf(needle)

	if (column === -1) {
		throw new Error(`'${needle}' is not on line ${line}`)
	}

	return { line, column: column + 1 }
}

// NOTE: Where a Completion is asked from: directly BEHIND what has been typed
// so far, which is the only place an Editor ever asks from.
function cursorPast(
	source: string,
	line: number,
	needle: string,
): common.Cursor {
	let cursor = cursorAt(source, line, needle)

	return { line, column: cursor.column + needle.length }
}

// NOTE: The Range a Code Action request carries — an Editor sends the selection,
// which for a cursor sitting in a name is that name.
function spanOf(source: string, line: number, needle: string): common.Position {
	let start = cursorAt(source, line, needle)

	return { start, end: { line, column: start.column + needle.length } }
}

// NOTE: Applies a workspace rename textually, file by file, so the expectations
// below can state whole Programs instead of position lists — the same shape
// `rename.spec.ts` uses for one file.
function renameAcross(
	workspace: Workspace,
	filePath: string,
	cursor: common.Cursor,
	newName: string,
): Record<string, string> | null {
	let symbol = workspace.symbolAt(filePath, cursor)

	if (symbol === null) {
		return null
	}

	let byFile = new Map<string, Array<common.Position>>()

	for (let occurrence of symbol.occurrences) {
		let positions = byFile.get(occurrence.filePath)

		if (positions === undefined) {
			positions = []
			byFile.set(occurrence.filePath, positions)
		}

		positions.push(occurrence.position)
	}

	let result: Record<string, string> = {}

	for (let [file, positions] of byFile) {
		let lines = (workspace.sourceOf(file) ?? "").split("\n")

		for (let position of [...positions].sort(
			(a, b) =>
				b.start.line - a.start.line || b.start.column - a.start.column,
		)) {
			let line = lines[position.start.line - 1] ?? ""

			lines[position.start.line - 1] =
				line.slice(0, position.start.column - 1) +
				newName +
				line.slice(position.end.column - 1)
		}

		result[path.basename(file)] = lines.join("\n")
	}

	return result
}

const geometry = [
	"implementation {",
	"",
	"\ttype Rectangle = { width: Integer, height: Integer }",
	"",
	"\tnamespace RectangleMeasurable for Rectangle {",
	"\t\tarea() -> Integer {",
	"\t\t\t<- @.width::multiply(with @.height)",
	"\t\t}",
	"\t}",
	"}",
	"",
	"export {",
	"\tRectangle",
	"\tRectangleMeasurable",
	"}",
	"",
].join("\n")

const bad = [
	"implementation {",
	"",
	"\tfunction answer() -> Integer {",
	"\t\t<- missingName()",
	"\t}",
	"}",
	"",
	"export {",
	"\tanswer",
	"}",
	"",
].join("\n")

const math = [
	"implementation {",
	"",
	"\tconstant PI = 314/100",
	"",
	"\tfunction squared(_ value: Integer) -> Integer {",
	"\t\t<- value::multiply(with value)",
	"\t}",
	"}",
	"",
	"export {",
	"\tPI",
	"\tsquared as square",
	"}",
	"",
].join("\n")

describe("Workspace", () => {
	describe("the index join", () => {
		it("should carry one Declaration across the file that declares it and the files that import it", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"\tfunction widthOf(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape.width",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let symbol = workspace.symbolAt(
				pathOf("Main.es"),
				cursorAt(
					workspace.sourceOf(pathOf("Main.es")) ?? "",
					6,
					"Rectangle",
				),
			)

			expect(symbol?.name).toBe("Rectangle")
			expect(symbol?.filePath).toBe(pathOf("Geometry.es"))
			expect(
				new Set(
					symbol?.occurrences.map((occurrence) =>
						path.basename(occurrence.filePath),
					),
				),
			).toEqual(new Set(["Geometry.es", "Main.es"]))

			// NOTE: The Position an unaliased entry writes belongs to ONE
			// occurrence, not two — it is the entry's own binding and the
			// reference to what the dependency publishes at once, and a rename
			// that emitted it twice would be two edits of one Range.
			expect(
				symbol?.occurrences.filter(
					(occurrence) =>
						occurrence.filePath === pathOf("Main.es") &&
						occurrence.position.start.line === 2,
				).length,
			).toBe(1)
		})

		it("should not join two Modules' same-named declarations", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Left.es": [
					"implementation {",
					"\tfunction size() -> Integer { <- 1 }",
					"}",
					"",
					"export {",
					"\tsize",
					"}",
					"",
				].join("\n"),
				"Right.es": [
					"implementation {",
					"\tfunction size() -> Integer { <- 2 }",
					"}",
					"",
					"export {",
					"\tsize",
					"}",
					"",
				].join("\n"),
			})

			let symbol = workspace.symbolAt(
				pathOf("Left.es"),
				cursorAt(
					workspace.sourceOf(pathOf("Left.es")) ?? "",
					2,
					"size",
				),
			)

			expect(
				new Set(
					symbol?.occurrences.map((occurrence) =>
						path.basename(occurrence.filePath),
					),
				),
			).toEqual(new Set(["Left.es"]))
		})

		// NOTE: What Go to Definition returns — the joined symbol's
		// `filePath`/`definition` pair must point at the declaration BEHIND an
		// import entry, not at the entry itself, or a definition request from
		// the entry answers with the very line it was asked from.
		it("should point a definition asked on an import entry at the declaration behind it", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"\tfunction widthOf(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape.width",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let main = workspace.sourceOf(pathOf("Main.es")) ?? ""
			let symbol = workspace.symbolAt(
				pathOf("Main.es"),
				cursorAt(main, 2, "Rectangle"),
			)

			expect(symbol?.filePath).toBe(pathOf("Geometry.es"))
			expect(symbol?.definition?.start.line).toBe(3)
		})

		it("should point a definition asked on a use of an imported name at the declaration too", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"\tfunction widthOf(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape.width",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let main = workspace.sourceOf(pathOf("Main.es")) ?? ""
			let symbol = workspace.symbolAt(
				pathOf("Main.es"),
				cursorAt(main, 6, "Rectangle"),
			)

			expect(symbol?.filePath).toBe(pathOf("Geometry.es"))
			expect(symbol?.definition?.start.line).toBe(3)
		})
	})

	// NOTE: Hover reads the linked enrichment — its annotations resolved on the
	// file alone answer 'Error' for every imported name, and an entry's own
	// Identifier has no typed body node to answer for it at all.
	describe("hover through the graph", () => {
		const main = [
			"import {",
			'\tfrom "./Geometry.es" { Rectangle }',
			'\tfrom "./Geometry.es" { RectangleMeasurable }',
			"}",
			"",
			"implementation {",
			"\tfunction widthOf(_ shape: Rectangle) -> Integer {",
			"\t\t<- shape.width",
			"\t}",
			"}",
			"",
		].join("\n")

		function hoverAt(line: number, needle: string) {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": main,
			})

			let filePath = pathOf("Main.es")
			let annotations = workspace.annotationsOf(filePath)
			let enriched = workspace.enrichedOf(filePath)

			expect(enriched).not.toBeNull()

			return findHover(
				enriched!,
				cursorAt(main, line, needle),
				parseDocument(main, filePath).program,
				annotations,
			)
		}

		it("should answer an annotation naming an imported Type with the Type, not 'Error'", () => {
			expect(hoverAt(7, "Rectangle")?.content).toBe(
				"{ width: Integer, height: Integer }",
			)
		})

		it("should answer an import entry with what it bound", () => {
			expect(hoverAt(2, "Rectangle")?.content).toBe(
				"{ width: Integer, height: Integer }",
			)
			expect(hoverAt(3, "RectangleMeasurable")?.content).toBe(
				"namespace RectangleMeasurable for { width: Integer, height: Integer }",
			)
		})
	})

	describe("rename", () => {
		it("should rewrite a declaration, its export entry and every importer", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"\tfunction widthOf(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape.width",
					"\t}",
					"}",
					"",
				].join("\n"),
				"Other.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"\tfunction heightOf(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape.height",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let renamed = renameAcross(
				workspace,
				pathOf("Main.es"),
				cursorAt(
					workspace.sourceOf(pathOf("Main.es")) ?? "",
					6,
					"Rectangle",
				),
				"Box",
			)

			expect(Object.keys(renamed ?? {}).sort()).toEqual([
				"Geometry.es",
				"Main.es",
				"Other.es",
			])
			expect(renamed?.["Geometry.es"]).toContain(
				"\ttype Box = { width: Integer, height: Integer }",
			)
			expect(renamed?.["Geometry.es"]).toContain(
				"\tnamespace RectangleMeasurable for Box {",
			)
			expect(renamed?.["Geometry.es"]).toContain("\tBox\n")
			expect(renamed?.["Main.es"]).toContain(
				'\tfrom "./Geometry.es" { Box }',
			)
			expect(renamed?.["Main.es"]).toContain("_ shape: Box")
			expect(renamed?.["Other.es"]).toContain(
				'\tfrom "./Geometry.es" { Box }',
			)
		})

		// NOTE: `namespace Rectangle for Rectangle` is how the corpus writes a
		// Namespace over a Type, and one entry publishes both of them — so a
		// rename has to move both, from whichever side it is asked. Moving one
		// leaves the export entry publishing a name only the other still
		// answers to, which is a workspace that no longer compiles.
		describe("a Type and the Namespace written under its name", () => {
			let shapes = {
				"Geometry.es": [
					"implementation {",
					"",
					"\ttype Rectangle = { width: Integer, height: Integer }",
					"",
					"\tnamespace Rectangle for Rectangle {",
					"\t\tstatic of(width: Integer, height: Integer) -> Rectangle {",
					"\t\t\t<- { width = width, height = height }",
					"\t\t}",
					"\t}",
					"}",
					"",
					"export {",
					"\tRectangle",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"\tconstant made = Rectangle.of(width 3, height 4)",
					"",
					"\tfunction widthOf(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape.width",
					"\t}",
					"}",
					"",
				].join("\n"),
			}

			let expectAllOfItMoved = (
				renamed: Record<string, string> | null,
			): void => {
				expect(Object.keys(renamed ?? {}).sort()).toEqual([
					"Geometry.es",
					"Main.es",
				])
				expect(renamed?.["Geometry.es"]).toContain(
					"\ttype Box = { width: Integer, height: Integer }",
				)
				expect(renamed?.["Geometry.es"]).toContain(
					"\tnamespace Box for Box {",
				)
				expect(renamed?.["Geometry.es"]).toContain("-> Box {")
				expect(renamed?.["Geometry.es"]).toContain("\tBox\n")
				expect(renamed?.["Geometry.es"]).not.toContain("Rectangle")
				expect(renamed?.["Main.es"]).toContain(
					'\tfrom "./Geometry.es" { Box }',
				)
				expect(renamed?.["Main.es"]).toContain(
					"Box.of(width 3, height 4)",
				)
				expect(renamed?.["Main.es"]).toContain("_ shape: Box")
				expect(renamed?.["Main.es"]).not.toContain("Rectangle")
			}

			it("should move as one from the file that imports them", () => {
				let { workspace, pathOf } = makeWorkspace(shapes)

				expectAllOfItMoved(
					renameAcross(
						workspace,
						pathOf("Main.es"),
						cursorAt(
							workspace.sourceOf(pathOf("Main.es")) ?? "",
							8,
							"Rectangle",
						),
						"Box",
					),
				)
			})

			it("should move as one from the Type's own declaration", () => {
				let { workspace, pathOf } = makeWorkspace(shapes)

				expectAllOfItMoved(
					renameAcross(
						workspace,
						pathOf("Geometry.es"),
						cursorAt(
							workspace.sourceOf(pathOf("Geometry.es")) ?? "",
							3,
							"Rectangle",
						),
						"Box",
					),
				)
			})
		})

		// NOTE: An aliased import's local name is a symbol of this file alone —
		// what the other Module publishes is not renamed by renaming it, and
		// nothing else in the workspace has ever seen the alias.
		it("should keep an aliased import's local name to the file that wrote it", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Math.es": math,
				"Main.es": [
					"import {",
					'\tfrom "./Math.es" { PI as Pi }',
					"}",
					"",
					"implementation {",
					"\tfunction circumference(_ radius: Rational) -> Rational {",
					"\t\t<- radius::multiply(with Pi)::multiply(with 2/1)",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let renamed = renameAcross(
				workspace,
				pathOf("Main.es"),
				cursorAt(workspace.sourceOf(pathOf("Main.es")) ?? "", 7, "Pi)"),
				"Ratio",
			)

			expect(Object.keys(renamed ?? {})).toEqual(["Main.es"])
			expect(renamed?.["Main.es"]).toContain(
				'\tfrom "./Math.es" { PI as Ratio }',
			)
			expect(renamed?.["Main.es"]).toContain("with Ratio")
		})

		it("should rewrite the exported side of an aliased import without touching the alias", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Math.es": math,
				"Main.es": [
					"import {",
					'\tfrom "./Math.es" { PI as Pi }',
					"}",
					"",
					"implementation {",
					"\tconstant doubled = Pi::multiply(with 2/1)",
					"}",
					"",
				].join("\n"),
			})

			let renamed = renameAcross(
				workspace,
				pathOf("Main.es"),
				cursorAt(
					workspace.sourceOf(pathOf("Main.es")) ?? "",
					2,
					"PI as",
				),
				"CIRCLE",
			)

			expect(Object.keys(renamed ?? {}).sort()).toEqual([
				"Main.es",
				"Math.es",
			])
			expect(renamed?.["Main.es"]).toContain(
				'\tfrom "./Math.es" { CIRCLE as Pi }',
			)
			expect(renamed?.["Main.es"]).toContain("constant doubled = Pi")
			expect(renamed?.["Math.es"]).toContain(
				"\tconstant CIRCLE = 314/100",
			)
			expect(renamed?.["Math.es"]).toContain("\tCIRCLE\n")
		})

		// NOTE: `squared as square` publishes one name and declares another, and
		// they are two symbols. Renaming the public one reaches every importer
		// and stops at the alias; renaming the local one stays inside the Module.
		it("should tell the two sides of an aliased export apart", () => {
			let files = {
				"Math.es": math,
				"Main.es": [
					"import {",
					'\tfrom "./Math.es" { square }',
					"}",
					"",
					"implementation {",
					"\tconstant nine = square(3)",
					"}",
					"",
				].join("\n"),
			}

			let published = makeWorkspace(files)
			let publicSide = renameAcross(
				published.workspace,
				published.pathOf("Math.es"),
				cursorPast(math, 12, "as "),
				"toSquare",
			)

			expect(Object.keys(publicSide ?? {}).sort()).toEqual([
				"Main.es",
				"Math.es",
			])
			expect(publicSide?.["Math.es"]).toContain("\tsquared as toSquare")
			expect(publicSide?.["Math.es"]).toContain("function squared(")
			expect(publicSide?.["Main.es"]).toContain(
				'\tfrom "./Math.es" { toSquare }',
			)

			let local = makeWorkspace(files)
			let localSide = renameAcross(
				local.workspace,
				local.pathOf("Math.es"),
				cursorAt(math, 5, "squared"),
				"powered",
			)

			expect(Object.keys(localSide ?? {})).toEqual(["Math.es"])
			expect(localSide?.["Math.es"]).toContain("function powered(")
			expect(localSide?.["Math.es"]).toContain("\tpowered as square")
		})

		// NOTE: A Method reference in an importer names no Namespace at all —
		// `shape::area()` dispatches through one — so the only trace of it is the
		// resolved Invocation, and the Namespace it names is joined through the
		// entry that brought it in rather than by its name.
		it("should rename a Namespace Method across the files that dispatch through it", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					'\tfrom "./Geometry.es" { RectangleMeasurable }',
					"}",
					"",
					"implementation {",
					"\tfunction describe(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape::area()",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let renamed = renameAcross(
				workspace,
				pathOf("Geometry.es"),
				cursorAt(geometry, 6, "area"),
				"surface",
			)

			expect(Object.keys(renamed ?? {}).sort()).toEqual([
				"Geometry.es",
				"Main.es",
			])
			expect(renamed?.["Geometry.es"]).toContain(
				"\t\tsurface() -> Integer",
			)
			expect(renamed?.["Main.es"]).toContain("<- shape::surface()")
		})

		// NOTE: A provided Method's call names the PROTOCOL, not a Namespace,
		// so the join reads the importing file's Type space and the declaring
		// file's Protocol members — two tables over from the Namespace case,
		// and the same join between them.
		it("should rename a provided Method across the files that call it", () => {
			let sizable = [
				"implementation {",
				"",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"",
				"\t\tisEmpty() -> Boolean {",
				"\t\t\t<- @::size()::is(0)",
				"\t\t}",
				"\t}",
				"",
				"\ttype Bag = { count: Integer }",
				"",
				"\tnamespace Bags for Bag is Sizable {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"}",
				"",
				"export {",
				"\tSizable",
				"\tBag",
				"\tBags",
				"}",
				"",
			].join("\n")

			let { workspace, pathOf } = makeWorkspace({
				"Sizable.es": sizable,
				"Main.es": [
					"import {",
					'\tfrom "./Sizable.es" { Sizable }',
					'\tfrom "./Sizable.es" { Bag }',
					'\tfrom "./Sizable.es" { Bags }',
					"}",
					"",
					"implementation {",
					"\tfunction report(_ bag: Bag) -> Boolean {",
					"\t\t<- bag::isEmpty()",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let renamed = renameAcross(
				workspace,
				pathOf("Sizable.es"),
				cursorAt(sizable, 6, "isEmpty"),
				"vacant",
			)

			expect(Object.keys(renamed ?? {}).sort()).toEqual([
				"Main.es",
				"Sizable.es",
			])
			expect(renamed?.["Sizable.es"]).toContain("\t\tvacant() -> Boolean")
			expect(renamed?.["Main.es"]).toContain("<- bag::vacant()")
		})
	})

	describe("workspace symbols", () => {
		it("should find declarations of every file, with the Namespace members under them", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Math.es": math,
			})

			let found = workspace.symbols("area")

			expect(found.length).toBe(1)
			expect(found[0]?.name).toBe("area")
			expect(found[0]?.container).toBe("RectangleMeasurable")
			expect(found[0]?.filePath).toBe(pathOf("Geometry.es"))

			expect(
				workspace
					.symbols("squared")
					.map((entry) => [entry.name, entry.exported]),
			).toEqual([["squared", true]])

			// NOTE: An empty query is every symbol — the client filters, and the
			// protocol says so.
			expect(workspace.symbols("").length).toBeGreaterThan(4)
		})
	})

	describe("auto-import", () => {
		it("should open a group at its canonical position in an existing block", () => {
			let source = [
				"import {",
				'\tfrom "./A.es" { Amount }',
				'\tfrom "./Geometry.es" { Rectangle }',
				"}",
				"",
				"implementation {",
				"}",
				"",
			].join("\n")
			let { program } = parseDocument(source)

			let edit = insertImportEdit(source, program, {
				name: "Box",
				alias: null,
				specifier: "./Bounds.es",
			})

			expect(edit).not.toBeNull()
			expect(edit?.range.start).toEqual({ line: 3, column: 1 })
			expect(edit?.newText).toBe('\tfrom "./Bounds.es" { Box }\n')

			// NOTE: Sorted by specifier, so a group for a later file goes below
			// every group of an earlier one whatever the names are.
			let last = insertImportEdit(source, program, {
				name: "PI",
				alias: "Pi",
				specifier: "./math/Math.es",
			})

			expect(last?.range.start).toEqual({ line: 4, column: 1 })
			expect(last?.newText).toBe('\tfrom "./math/Math.es" { PI as Pi }\n')
		})

		// NOTE: A group of one name is written flat, and a second name is what
		// writes it out — so the edit replaces the flat group with the two
		// names one to a line, in order, which is what the Formatter makes of
		// a group of two.
		it("should write a flat group out when a second name joins it", () => {
			let source = [
				"import {",
				'\tfrom "./A.es" { Amount }',
				'\tfrom "./Geometry.es" { Rectangle } § the shape',
				"}",
				"",
				"implementation {",
				"}",
				"",
			].join("\n")
			let { program } = parseDocument(source)

			let edit = insertImportEdit(source, program, {
				name: "Circle",
				alias: null,
				specifier: "./Geometry.es",
			})

			expect(edit?.range).toEqual({
				start: { line: 3, column: 2 },
				end: { line: 3, column: 36 },
			})
			expect(edit?.newText).toBe(
				'from "./Geometry.es" {\n\t\tCircle\n\t\tRectangle\n\t}',
			)

			let updated = withInsertedEntry(source, {
				name: "Circle",
				alias: null,
				specifier: "./Geometry.es",
			})

			expect(updated).toBe(
				[
					"import {",
					'\tfrom "./A.es" { Amount }',
					'\tfrom "./Geometry.es" {',
					"\t\tCircle",
					"\t\tRectangle",
					"\t} § the shape",
					"}",
					"",
					"implementation {",
					"}",
					"",
				].join("\n"),
			)
		})

		it("should insert a name into a written-out group at its canonical position", () => {
			let source = [
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\t§ the shape",
				"\t\tRectangle",
				"\t\tarea",
				"\t}",
				"}",
				"",
				"implementation {",
				"}",
				"",
			].join("\n")
			let { program } = parseDocument(source)

			let between = insertImportEdit(source, program, {
				name: "Square",
				alias: null,
				specifier: "./Geometry.es",
			})

			expect(between?.range.start).toEqual({ line: 5, column: 1 })
			expect(between?.newText).toBe("\t\tSquare\n")

			let first = insertImportEdit(source, program, {
				name: "Circle",
				alias: null,
				specifier: "./Geometry.es",
			})

			expect(first?.range.start).toEqual({ line: 4, column: 1 })
			expect(first?.newText).toBe("\t\tCircle\n")

			let last = insertImportEdit(source, program, {
				name: "perimeter",
				alias: null,
				specifier: "./Geometry.es",
			})

			expect(last?.range.start).toEqual({ line: 6, column: 1 })
			expect(last?.newText).toBe("\t\tperimeter\n")
		})

		// NOTE: Applied and reparsed rather than matched against a spelling —
		// what an insertion must never do is land outside the braces of a
		// block written on one line, which only a reparse can attest.
		function withInsertedEntry(
			source: string,
			entry: { name: string; alias: string | null; specifier: string },
		): string {
			let edit = insertImportEdit(
				source,
				parseDocument(source).program,
				entry,
			)

			expect(edit).not.toBeNull()

			let lines = source.split("\n")
			let line = lines[edit!.range.start.line - 1] ?? ""

			lines[edit!.range.start.line - 1] =
				line.slice(0, edit!.range.start.column - 1) +
				edit!.newText +
				line.slice(edit!.range.end.column - 1)

			return lines.join("\n")
		}

		it("should insert inside the braces of a one-line empty block", () => {
			let source = ["import {}", "", "implementation {", "}", ""].join(
				"\n",
			)

			let updated = withInsertedEntry(source, {
				name: "Rectangle",
				alias: null,
				specifier: "./Geometry.es",
			})
			let reparsed = parseDocument(updated)

			expect(reparsed.diagnostics).toEqual([])
			expect(
				reparsed.program.imports?.entries.map(
					(entry) => entry.name.content,
				),
			).toEqual(["Rectangle"])
		})

		it("should insert inline into a block written on one line", () => {
			let source = [
				'import { from "./z.es" { Zeta } }',
				"",
				"implementation {",
				"}",
				"",
			].join("\n")

			let first = parseDocument(
				withInsertedEntry(source, {
					name: "Alpha",
					alias: null,
					specifier: "./a.es",
				}),
			)

			expect(first.diagnostics).toEqual([])
			expect(
				first.program.imports?.entries.map(
					(entry) => entry.name.content,
				),
			).toEqual(["Alpha", "Zeta"])

			let last = parseDocument(
				withInsertedEntry(source, {
					name: "Last",
					alias: null,
					specifier: "./zz.es",
				}),
			)

			expect(last.diagnostics).toEqual([])
			expect(
				last.program.imports?.entries.map(
					(entry) => entry.name.content,
				),
			).toEqual(["Zeta", "Last"])
		})

		it("should refuse to insert an entry the block already holds", () => {
			let source = [
				"import {",
				'\tfrom "./Geometry.es" { Rectangle }',
				"}",
				"",
				"implementation {",
				"}",
				"",
			].join("\n")

			expect(
				insertImportEdit(source, parseDocument(source).program, {
					name: "Rectangle",
					alias: null,
					specifier: "./Geometry.es",
				}),
			).toBeNull()
		})

		it("should write a whole block into a file that has none", () => {
			let source = [
				"implementation {",
				"\tconstant one = 1",
				"}",
				"",
			].join("\n")

			let edit = insertImportEdit(source, parseDocument(source).program, {
				name: "Rectangle",
				alias: null,
				specifier: "./Geometry.es",
			})

			expect(edit?.range.start).toEqual({ line: 1, column: 1 })
			expect(edit?.newText).toBe(
				'import {\n\tfrom "./Geometry.es" { Rectangle }\n}\n\n',
			)
		})

		it("should offer an import for an unknown name every Module exporting it", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"implementation {",
					"\tfunction widthOf(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape.width",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let actions = findCodeActions(
				workspace.sourceOf(mainPath) ?? "",
				spanOf(workspace.sourceOf(mainPath) ?? "", 2, "Rectangle"),
				mainPath,
				workspace,
			)

			let importAction = actions.find((action) =>
				action.title.startsWith("Import"),
			)

			expect(importAction?.title).toBe(
				"Import 'Rectangle' from ./Geometry.es",
			)
			expect(importAction?.edits[0]?.newText).toBe(
				'import {\n\tfrom "./Geometry.es" { Rectangle }\n}\n\n',
			)
		})

		// NOTE: The Namespace offer is the one that can not be worked out from
		// the name at the cursor — `shape::area()` names no Namespace at all, so
		// the Enricher's own help is what says which one declares the Method for
		// this receiver.
		it("should offer the Namespace an unresolved Method would dispatch through", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"\tfunction describe(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape::area()",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let actions = findCodeActions(
				workspace.sourceOf(mainPath) ?? "",
				spanOf(workspace.sourceOf(mainPath) ?? "", 7, "area"),
				mainPath,
				workspace,
			)

			expect(actions.map((action) => action.title)).toContain(
				"Import 'RectangleMeasurable' from ./Geometry.es",
			)
		})

		it("should offer to remove an unused name, line and all", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" {',
					"\t\tRectangle",
					"\t\tRectangleMeasurable",
					"\t}",
					"}",
					"",
					"implementation {",
					"\tfunction widthOf(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape.width",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let actions = findCodeActions(
				workspace.sourceOf(mainPath) ?? "",
				spanOf(
					workspace.sourceOf(mainPath) ?? "",
					4,
					"RectangleMeasurable",
				),
				mainPath,
				workspace,
			)

			let removal = actions.find((action) =>
				action.title.startsWith("Remove the unused import"),
			)

			expect(removal?.title).toBe(
				"Remove the unused import of 'RectangleMeasurable'",
			)
			expect(removal?.edits[0]?.range).toEqual({
				start: { line: 4, column: 1 },
				end: { line: 5, column: 1 },
			})
		})

		// NOTE: The last name of a group takes the group with it — an empty
		// `from "./Geometry.es" {}` imports nothing and says so on two lines.
		it("should remove a whole group with its last unused name", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" {',
					"\t\t§ the witness",
					"\t\tRectangleMeasurable",
					"\t}",
					"}",
					"",
					"implementation {",
					"\tconstant width = 1",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let actions = findCodeActions(
				workspace.sourceOf(mainPath) ?? "",
				spanOf(
					workspace.sourceOf(mainPath) ?? "",
					4,
					"RectangleMeasurable",
				),
				mainPath,
				workspace,
			)

			let removal = actions.find((action) =>
				action.title.startsWith("Remove the unused import"),
			)

			expect(removal?.edits[0]?.range).toEqual({
				start: { line: 2, column: 1 },
				end: { line: 6, column: 1 },
			})
		})

		it("should offer a workspace export Completion carrying its own entry", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"implementation {",
					"\tfunction widthOf(_ shape: Rec) -> Integer {",
					"\t\t<- shape.width",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let entries = findCompletions(
				workspace.sourceOf(mainPath) ?? "",
				cursorPast(workspace.sourceOf(mainPath) ?? "", 2, "Rec"),
				mainPath,
				{
					offers: workspace.offersFor(mainPath),
					namespaces: workspace.namespaceOffersFor(mainPath),
				},
			)

			let offered = entries.find((entry) => entry.label === "Rectangle")

			expect(offered?.detail).toBe("from ./Geometry.es")
			expect(offered?.tier).toBe(6)
			expect(offered?.additionalEdits?.[0]?.newText).toBe(
				'import {\n\tfrom "./Geometry.es" { Rectangle }\n}\n\n',
			)
		})

		it("should not offer a name the file already binds", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"}",
					"",
				].join("\n"),
			})

			expect(
				workspace
					.offersFor(pathOf("Main.es"))
					.map((offer) => offer.name),
			).toEqual(["RectangleMeasurable"])
		})

		// NOTE: A facade forwards someone else's declaration, and the specifier
		// an entry writes has to name the FACADE — importing past it is a
		// different dependency, and one the author of the facade did not offer.
		it("should offer a re-exported name under the Module that publishes it", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Shapes.es": [
					"implementation {",
					"}",
					"",
					"export {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
				].join("\n"),
				"Main.es": ["implementation {", "}", ""].join("\n"),
			})

			expect(
				workspace
					.offersFor(pathOf("Main.es"))
					.filter((offer) => offer.name === "Rectangle")
					.map((offer) => offer.specifier)
					.sort(),
			).toEqual(["./Geometry.es", "./Shapes.es"])
		})

		it("should write a specifier from the importing file", () => {
			expect(
				relativeSpecifier("/project/src/Main.es", "/project/src/A.es"),
			).toBe("./A.es")
			expect(
				relativeSpecifier(
					"/project/src/Main.es",
					"/project/math/Math.es",
				),
			).toBe("../math/Math.es")
		})
	})

	describe("graph-aware analysis", () => {
		it("should resolve imported names and report a dependency under its own path", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"\tfunction widthOf(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape.width",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let analysis = analyseDocument(
				workspace.sourceOf(mainPath) ?? "",
				mainPath,
				{ host: workspace.host },
			)

			expect(analysis.diagnostics).toEqual([])
			expect([...analysis.dependencies.keys()]).toEqual([
				pathOf("Geometry.es"),
			])
			expect(analysis.dependencies.get(pathOf("Geometry.es"))).toEqual([])
		})

		it("should say on the import line that a dependency did not compile", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Broken.es": [
					"implementation {",
					"\tfunction answer() -> Integer {",
					"\t\t<- missingName()",
					"\t}",
					"}",
					"",
					"export {",
					"\tanswer",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Broken.es" { answer }',
					"}",
					"",
					"implementation {",
					"\tTerminal.inspect(answer()::toString())",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let analysis = analyseDocument(
				workspace.sourceOf(mainPath) ?? "",
				mainPath,
				{ host: workspace.host },
			)

			let reported = analysis.diagnostics.find(
				(diagnostic) => diagnostic.code === "dependency-has-errors",
			)

			expect(reported?.message).toBe("./Broken.es has errors of its own")
			expect(reported?.position?.start.line).toBe(2)
			expect(reported?.labels.length).toBeGreaterThan(0)
			expect(reported?.helps.length).toBeGreaterThan(0)

			// NOTE: One Diagnostic per broken Module, not per entry naming it.
			expect(
				analysis.diagnostics.filter(
					(diagnostic) => diagnostic.code === "dependency-has-errors",
				).length,
			).toBe(1)

			expect(
				analysis.dependencies
					.get(pathOf("Broken.es"))
					?.map((diagnostic) => diagnostic.code),
			).toContain("unknown-name")
		})

		it("should leave a Program that writes neither section exactly as it was", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Alone.es": [
					"implementation {",
					"\tconstant one = 1",
					"}",
					"",
				].join("\n"),
			})

			let alonePath = pathOf("Alone.es")
			let analysis = analyseDocument(
				workspace.sourceOf(alonePath) ?? "",
				alonePath,
				{ host: workspace.host },
			)

			expect(analysis.diagnostics).toEqual([])
			expect(analysis.dependencies.size).toBe(0)
		})
	})

	// NOTE: A Diagnostic published for a file nobody has open is addressed by
	// URI, and the client matches it against the URI it handed over — a path
	// that does not survive the round trip is a squiggle in the wrong file, or
	// in none.
	describe("paths and URIs", () => {
		it("should round-trip a path with characters a URI escapes", () => {
			for (let filePath of [
				"/project/src/Main.es",
				"/project/a folder/Main.es",
				"/project/Grüße.es",
			]) {
				expect(documentFilePath(uriOf(filePath))).toBe(filePath)
			}
		})
	})

	describe("the watcher", () => {
		it("should see a file the walk never found", () => {
			let { workspace, root, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
			})

			expect(workspace.knownFiles().size).toBe(1)

			writeFileSync(path.join(root, "Later.es"), math)
			workspace.changed(pathOf("Later.es"))

			expect(workspace.knownFiles().has(pathOf("Later.es"))).toBe(true)
			expect(
				workspace
					.exportsOf(pathOf("Later.es"))
					.map((exported) => exported.name)
					.sort(),
			).toEqual(["PI", "square"])

			workspace.removed(pathOf("Later.es"))

			expect(workspace.knownFiles().has(pathOf("Later.es"))).toBe(false)
		})

		it("should read an open document rather than the file on disk", () => {
			let root = canonicalPath(
				mkdtempSync(path.join(tmpdir(), "essence-ws-")),
			)

			directories.push(root)
			writeFileSync(path.join(root, "Math.es"), math)

			let filePath = canonicalPath(path.join(root, "Math.es"))
			let edited = math.replace("squared as square", "squared as sqr")
			let workspace = createWorkspace({
				openDocument: (candidate) =>
					candidate === filePath
						? { text: edited, version: 7 }
						: undefined,
			})

			workspace.setFolders([root])

			expect(
				workspace
					.exportsOf(filePath)
					.map((exported) => exported.name)
					.sort(),
			).toEqual(["PI", "sqr"])
		})
	})

	// NOTE: `essence.exclude` in the nearest `package.json`. Reported on a
	// project rather than on the open tabs, the discovery walk decides what the
	// Problems panel speaks for — and a project holds `.es` files that are not
	// its sources: a corpus kept deliberately broken, a vendored copy, whatever
	// the last build wrote into it. This is the only way it can say so.
	describe("the directories a project excludes", () => {
		let manifest = JSON.stringify({ essence: { exclude: ["broken"] } })

		it("should stay out of a directory the project excludes", () => {
			let { workspace, pathOf } = makeWorkspace({
				"package.json": manifest,
				"Math.es": math,
				"broken/Bad.es": bad,
			})

			expect([...workspace.knownFiles()]).toEqual([pathOf("Math.es")])
			expect(workspace.roots()).toEqual([pathOf("Math.es")])
			expect(workspace.isExcluded(pathOf("broken/Bad.es"))).toBe(true)
		})

		// NOTE: The line between "not discovered" and "not analysed". A file
		// this project IMPORTS is this project's, whichever directory it sits
		// in — excluding a directory says nothing is to be walked INTO, not
		// that a Module named out loud stops being checked.
		it("should still report on an excluded file a source imports", () => {
			let { workspace, pathOf } = makeWorkspace({
				"package.json": manifest,
				"Main.es": [
					"import {",
					'\tfrom "./broken/Bad.es" { answer }',
					"}",
					"",
					"implementation {",
					"\tconstant given = answer()",
					"}",
					"",
				].join("\n"),
				"broken/Bad.es": bad,
			})

			let mainPath = pathOf("Main.es")
			let analysis = analyseDocument(
				workspace.sourceOf(mainPath) ?? "",
				mainPath,
				{ host: workspace.host },
			)

			expect([...analysis.dependencies.keys()]).toEqual([
				pathOf("broken/Bad.es"),
			])
			expect(
				analysis.dependencies.get(pathOf("broken/Bad.es")),
			).not.toEqual([])
		})

		// NOTE: The walk is answered once and the watcher keeps it current
		// afterwards, so an exclusion the walk obeyed has to hold on the
		// watcher's path too — a file appearing under an excluded directory is
		// how a corpus grows.
		it("should not take an excluded file from the watcher", () => {
			let { workspace, root, pathOf } = makeWorkspace({
				"package.json": manifest,
				"Math.es": math,
			})

			expect(workspace.knownFiles().size).toBe(1)

			mkdirSync(path.join(root, "broken"), { recursive: true })
			writeFileSync(path.join(root, "broken", "Late.es"), bad)
			workspace.changed(pathOf("broken/Late.es"))

			expect(workspace.knownFiles().has(pathOf("broken/Late.es"))).toBe(
				false,
			)
		})

		// NOTE: What the Server does when a manifest changes: sets the folders
		// again, which is what forgets the exclusions along with every answer
		// derived under them.
		it("should read the exclusions again when the folders are set", () => {
			let { workspace, root, pathOf } = makeWorkspace({
				"package.json": manifest,
				"Math.es": math,
				"broken/Bad.es": bad,
			})

			expect(workspace.knownFiles().has(pathOf("broken/Bad.es"))).toBe(
				false,
			)

			writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify({ essence: { exclude: [] } }),
			)
			workspace.setFolders(workspace.folders())

			expect(workspace.knownFiles().has(pathOf("broken/Bad.es"))).toBe(
				true,
			)
		})
	})
})
