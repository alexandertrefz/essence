import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { canonicalPath, parseDocument } from "@essence/compiler/documents"
import type { common } from "@essence/interfaces"

import { analyseDocument, documentFilePath } from "../analyse"
import { insertImportEdit, relativeSpecifier } from "../autoImport"
import { findCodeActions } from "../codeActions"
import { findCompletions } from "../completion"
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
					'\tRectangle from "./Geometry.es"',
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
	})

	describe("rename", () => {
		it("should rewrite a declaration, its export entry and every importer", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tRectangle from "./Geometry.es"',
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
					'\tRectangle from "./Geometry.es"',
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
			expect(renamed?.["Main.es"]).toContain('\tBox from "./Geometry.es"')
			expect(renamed?.["Main.es"]).toContain("_ shape: Box")
			expect(renamed?.["Other.es"]).toContain(
				'\tBox from "./Geometry.es"',
			)
		})

		// NOTE: An aliased import's local name is a symbol of this file alone —
		// what the other Module publishes is not renamed by renaming it, and
		// nothing else in the workspace has ever seen the alias.
		it("should keep an aliased import's local name to the file that wrote it", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Math.es": math,
				"Main.es": [
					"import {",
					'\tPI as Pi from "./Math.es"',
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
				'\tPI as Ratio from "./Math.es"',
			)
			expect(renamed?.["Main.es"]).toContain("with Ratio")
		})

		it("should rewrite the exported side of an aliased import without touching the alias", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Math.es": math,
				"Main.es": [
					"import {",
					'\tPI as Pi from "./Math.es"',
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
				'\tCIRCLE as Pi from "./Math.es"',
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
					'\tsquare from "./Math.es"',
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
				'\ttoSquare from "./Math.es"',
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
					'\tRectangle from "./Geometry.es"',
					'\tRectangleMeasurable from "./Geometry.es"',
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
		it("should insert an entry at its canonical position in an existing block", () => {
			let source = [
				"import {",
				'\tAmount from "./A.es"',
				'\tRectangle from "./Geometry.es"',
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

			expect(edit).not.toBeNull()
			expect(edit?.range.start).toEqual({ line: 3, column: 1 })
			expect(edit?.newText).toBe('\tCircle from "./Geometry.es"\n')

			// NOTE: Sorted by specifier FIRST, so an entry from a later file
			// goes below every entry of an earlier one whatever the names are.
			let last = insertImportEdit(source, program, {
				name: "PI",
				alias: "Pi",
				specifier: "./math/Math.es",
			})

			expect(last?.range.start).toEqual({ line: 4, column: 1 })
			expect(last?.newText).toBe('\tPI as Pi from "./math/Math.es"\n')
		})

		it("should refuse to insert an entry the block already holds", () => {
			let source = [
				"import {",
				'\tRectangle from "./Geometry.es"',
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
				'import {\n\tRectangle from "./Geometry.es"\n}\n\n',
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
				'import {\n\tRectangle from "./Geometry.es"\n}\n\n',
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
					'\tRectangle from "./Geometry.es"',
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

		it("should offer to remove an unused entry, line and all", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tRectangle from "./Geometry.es"',
					'\tRectangleMeasurable from "./Geometry.es"',
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
					3,
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
				start: { line: 3, column: 1 },
				end: { line: 4, column: 1 },
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
				'import {\n\tRectangle from "./Geometry.es"\n}\n\n',
			)
		})

		it("should not offer a name the file already binds", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tRectangle from "./Geometry.es"',
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
					'\tRectangle from "./Geometry.es"',
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
					'\tRectangle from "./Geometry.es"',
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
					'\tanswer from "./Broken.es"',
					"}",
					"",
					"implementation {",
					"\t__print(answer()::toString())",
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
})
