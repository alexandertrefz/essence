import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { canonicalPath, parseDocument } from "@essence-lang/compiler/documents"
import type { common } from "@essence-lang/interfaces"

import { analyseDocument, documentFilePath } from "../analyse"
import {
	insertExportEdit,
	insertImportEdit,
	relativeSpecifier,
} from "../autoImport"
import {
	type CodeActionEdit,
	type CodeActionEntry,
	findCodeActions,
} from "../codeActions"
import { findCompletions } from "../completion"
import { findHover } from "../hover"
import { renameEdits } from "../rename"
import { uriOf } from "../server"
import { createWorkspace, type Workspace } from "../workspace"
import { applyEdits } from "./textEdits"

// A workspace is a directory of files, so these run against a real one. An
// in-memory host would not test which path a specifier resolves to, or whether
// discovery finds a file.
let directories: Array<string> = []

function makeFolder(files: Record<string, string>): string {
	let root = canonicalPath(mkdtempSync(path.join(tmpdir(), "essence-ws-")))

	directories.push(root)

	for (let [name, contents] of Object.entries(files)) {
		let filePath = path.join(root, name)

		mkdirSync(path.dirname(filePath), { recursive: true })
		writeFileSync(filePath, contents)
	}

	return root
}

function makeWorkspace(files: Record<string, string>): {
	workspace: Workspace
	root: string
	pathOf: (name: string) => string
} {
	let root = makeFolder(files)
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

// A Cursor by what it points at. The sources are tab-indented, so a column
// counted by hand would be a fact about the whitespace.
function cursorAt(source: string, line: number, needle: string): common.Cursor {
	let text = source.split("\n")[line - 1] ?? ""
	let column = text.indexOf(needle)

	if (column === -1) {
		throw new Error(`'${needle}' is not on line ${line}`)
	}

	return { line, column: column + 1 }
}

// Directly after what has been typed, where an Editor asks for Completion.
function cursorPast(
	source: string,
	line: number,
	needle: string,
): common.Cursor {
	let cursor = cursorAt(source, line, needle)

	return { line, column: cursor.column + needle.length }
}

// The Range a Code Action request carries. An Editor sends the selection,
// which for a cursor in a name is that name.
function spanOf(source: string, line: number, needle: string): common.Position {
	let start = cursorAt(source, line, needle)

	return { start, end: { line, column: start.column + needle.length } }
}

// Applies a workspace rename textually, file by file, so an expectation can
// state whole Programs, as `rename.spec.ts` does for one file. It goes through
// `renameEdits`, as the Server does, so a shorthand is spelled out.
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

	let byFile = new Map<
		string,
		Array<{ range: common.Position; newText: string }>
	>()

	for (let occurrence of symbol.occurrences) {
		let edits = byFile.get(occurrence.filePath)

		if (edits === undefined) {
			edits = []
			byFile.set(occurrence.filePath, edits)
		}

		for (let edit of renameEdits(
			{ position: occurrence.position, edits: occurrence.edits ?? null },
			newName,
		)) {
			edits.push({ range: edit.position, newText: edit.newText })
		}
	}

	let result: Record<string, string> = {}

	for (let [file, edits] of byFile) {
		result[path.basename(file)] = applyEdits(
			workspace.sourceOf(file) ?? "",
			edits,
		)
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

const other = [
	"implementation {",
	"",
	"\tconstant thing = 1",
	"}",
	"",
	"export {",
	"\tthing",
	"}",
	"",
].join("\n")

// A second Module publishing a name `Geometry.es` publishes too. One import
// block can then bind a name twice from two files.
const shapes = [
	"implementation {",
	"",
	"\ttype Rectangle = { width: Integer, height: Integer }",
	"}",
	"",
	"export {",
	"\tRectangle",
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

			// An unaliased entry's Position is one occurrence, both the binding
			// and the reference to the dependency. Two would be two edits of one
			// Range.
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

		// The joined symbol's `filePath` and `definition` point at the
		// declaration behind an import entry, not at the entry itself.
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

		// The mark holds a rename of such a Parameter to the label rules too,
		// and the Server reads it off the joined symbol.
		it("should carry the mark of a Parameter whose name doubles as its label", () => {
			let compute = [
				"implementation {",
				"\tconstant result = compute(seed 1, by 2)",
				"",
				"\tfunction compute (seed: Integer, by factor: Integer) -> Integer {",
				"\t\t<- seed::multiply(with factor)",
				"\t}",
				"}",
				"",
			].join("\n")
			let { workspace, pathOf } = makeWorkspace({ "Compute.es": compute })
			let symbolAt = (line: number, needle: string) =>
				workspace.symbolAt(
					pathOf("Compute.es"),
					cursorAt(compute, line, needle),
				)

			expect(symbolAt(4, "seed:")?.kind).toBe("parameter")
			expect(symbolAt(4, "seed:")?.labelled).toBe(true)
			expect(symbolAt(2, "seed 1")?.labelled).toBe(true)
			expect(symbolAt(4, "factor:")?.labelled).toBeUndefined()
		})
	})

	// Hover reads the linked enrichment. Resolved on the file alone, every
	// imported name would answer 'Error'.
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
				"namespace RectangleMeasurable for Rectangle",
			)
		})
	})

	// `Main.es` imports `Sized` as `Measurable`, so that is what a Hover
	// there calls it, while `Sized.es` goes on calling it by its own name.
	describe("a Protocol imported under an alias", () => {
		const sized = [
			"implementation {",
			"\tprotocol Sized {",
			"\t\tsize() -> Integer",
			"",
			"\t\tisBig() -> Boolean {",
			"\t\t\t<- @::size()::isGreaterThan(2)",
			"\t\t}",
			"\t}",
			"",
			"\tfunction measure <infer Item is Sized>(_ item: Item) -> Integer {",
			"\t\t<- item::size()",
			"\t}",
			"}",
			"",
			"export {",
			"\tSized",
			"\tmeasure",
			"}",
			"",
		].join("\n")
		const main = [
			"import {",
			'\tfrom "./Sized.es" {',
			"\t\tSized as Measurable",
			"\t\tmeasure",
			"\t}",
			"}",
			"",
			"implementation {",
			"\tnamespace IntegerMeasured for Integer is Measurable {",
			"\t\tsize() -> Integer {",
			"\t\t\t<- @",
			"\t\t}",
			"\t}",
			"",
			"\tTerminal.inspect(measure(3))",
			"\tTerminal.inspect(3::isBig())",
			"}",
			"",
		].join("\n")

		function hoverIn(
			fileName: string,
			source: string,
			line: number,
			needle: string,
		) {
			let { workspace, pathOf } = makeWorkspace({
				"Main.es": main,
				"Sized.es": sized,
			})
			let filePath = pathOf(fileName)
			let document = workspace.documentOf(filePath)

			expect(document?.enrichedProgram).not.toBeNull()

			return findHover(
				document!.enrichedProgram!,
				cursorAt(source, line, needle),
				document!.program,
				workspace.annotationsOf(filePath),
				source,
				document!.module?.imported.protocols,
			)
		}

		it("should spell a bound the way each file names its Protocol", () => {
			expect(hoverIn("Main.es", main, 15, "measure")?.content).toBe(
				"measure<Item is Measurable>(_ Item) -> Integer",
			)
			expect(hoverIn("Sized.es", sized, 10, "measure")?.content).toBe(
				"function measure<Item is Sized>(_ Item) -> Integer",
			)
		})

		it("should name the Protocol that provides a Method by the file's alias", () => {
			expect(
				hoverIn("Main.es", main, 16, "isBig")?.documentation,
			).toContain("Provided by `Measurable`.")
		})

		// The clause names the alias, which no Protocol of the file declares.
		it("should describe a clause naming the Protocol under its alias", () => {
			expect(hoverIn("Main.es", main, 9, "Measurable")?.content).toBe(
				[
					"protocol Measurable",
					"size() -> Integer",
					"isBig() -> Boolean",
				].join("\n"),
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

		// One entry publishes a Type and the Namespace written under its name,
		// so a rename moves both from whichever side it is asked.
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

		// An aliased import's local name is a symbol of this file alone.
		// Renaming it leaves what the other Module publishes alone.
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

		// `squared as square` publishes one name and declares another, and
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

		// `shape::area()` names no Namespace, so the resolved Invocation is its
		// only trace. Its Namespace is joined through the entry that brought it
		// in.
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

		// A provided Method's call names the Protocol, not a Namespace. The join
		// reads the importing file's Type space and the declaring file's Protocol
		// members.
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

		it("should rename the call a provided body makes from an importer's call site", () => {
			let sizable = [
				"implementation {",
				"",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"",
				"\t\tisEmpty() -> Boolean {",
				"\t\t\t<- @::size()::is(0)",
				"\t\t}",
				"",
				"\t\thasItems() -> Boolean {",
				"\t\t\t<- @::isEmpty()::negate()",
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
			let main = [
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
			].join("\n")

			let { workspace, pathOf } = makeWorkspace({
				"Sizable.es": sizable,
				"Main.es": main,
			})

			let renamed = renameAcross(
				workspace,
				pathOf("Main.es"),
				cursorAt(main, 9, "isEmpty"),
				"vacant",
			)

			expect(renamed?.["Sizable.es"]).toBe(
				sizable.replaceAll("isEmpty", "vacant"),
			)
			expect(renamed?.["Main.es"]).toBe(
				main.replaceAll("isEmpty", "vacant"),
			)
		})

		// The requirement, a conformer's extension and a call through a bounded
		// Type each live in a file of their own.
		describe("a Protocol requirement", () => {
			const sizable = [
				"implementation {",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"\t}",
				"}",
				"",
				"export {",
				"\tSizable",
				"}",
				"",
			].join("\n")
			const listed = [
				"import {",
				'\tfrom "./Sizable.es" { Sizable }',
				"}",
				"",
				"implementation {",
				"\tprotocol Listed is Sizable {",
				"\t\tfirst() -> Integer",
				"\t}",
				"}",
				"",
				"export {",
				"\tListed",
				"}",
				"",
			].join("\n")
			const bag = [
				"import {",
				'\tfrom "./Listed.es" { Listed }',
				"}",
				"",
				"implementation {",
				"\ttype Bag = { count: Integer }",
				"",
				"\tnamespace Bags for Bag is Listed {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"",
				"\t\tfirst() -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"}",
				"",
				"export {",
				"\tBag",
				"\tBags",
				"}",
				"",
			].join("\n")
			const main = [
				"import {",
				'\tfrom "./Sizable.es" { Sizable }',
				'\tfrom "./Bag.es" { Bag }',
				'\tfrom "./Bag.es" { Bags }',
				"}",
				"",
				"implementation {",
				"\tfunction measure <infer Value is Sizable>(_ value: Value) -> Integer {",
				"\t\t<- value::size()",
				"\t}",
				"",
				"\tconstant bag: Bag = { count = 0 }",
				"",
				"\tTerminal.inspect(bag::size())",
				"\tTerminal.inspect(measure(bag))",
				"}",
				"",
			].join("\n")
			const files = {
				"Sizable.es": sizable,
				"Listed.es": listed,
				"Bag.es": bag,
				"Main.es": main,
			}

			let expectEverySizeMoved = (
				renamed: Record<string, string> | null,
			): void => {
				expect(renamed).toEqual({
					"Sizable.es": sizable.replaceAll("size", "extent"),
					"Bag.es": bag.replaceAll("size", "extent"),
					"Main.es": main.replaceAll("size", "extent"),
				})
			}

			it("should move every conformer and bounded call from the requirement", () => {
				let { workspace, pathOf } = makeWorkspace(files)

				expectEverySizeMoved(
					renameAcross(
						workspace,
						pathOf("Sizable.es"),
						cursorAt(sizable, 3, "size"),
						"extent",
					),
				)
			})

			it("should move the requirement from a conformer's implementation", () => {
				let { workspace, pathOf } = makeWorkspace(files)

				expectEverySizeMoved(
					renameAcross(
						workspace,
						pathOf("Bag.es"),
						cursorAt(bag, 9, "size"),
						"extent",
					),
				)
			})

			it("should move the requirement from a call through a bounded Type", () => {
				let { workspace, pathOf } = makeWorkspace(files)

				expectEverySizeMoved(
					renameAcross(
						workspace,
						pathOf("Main.es"),
						cursorAt(main, 9, "size"),
						"extent",
					),
				)
			})

			// `Measurable` is only how `Main.es` spells `Sizable`, and the
			// bound the call resolves through is the Protocol `Sizable.es`
			// declares.
			it("should move the requirement from a call bounded under an alias", () => {
				let aliased = main
					.replace(
						'\tfrom "./Sizable.es" { Sizable }',
						'\tfrom "./Sizable.es" { Sizable as Measurable }',
					)
					.replace("is Sizable>", "is Measurable>")
				let { workspace, pathOf } = makeWorkspace({
					...files,
					"Main.es": aliased,
				})

				expect(
					renameAcross(
						workspace,
						pathOf("Main.es"),
						cursorAt(aliased, 9, "size"),
						"extent",
					),
				).toEqual({
					"Sizable.es": sizable.replaceAll("size", "extent"),
					"Bag.es": bag.replaceAll("size", "extent"),
					"Main.es": aliased.replaceAll("size", "extent"),
				})
			})

			// One rename group, but each call still has its own definition.
			it("should keep each call's definition where its Method is written", () => {
				let { workspace, pathOf } = makeWorkspace(files)
				let conformerCall = workspace.symbolAt(
					pathOf("Main.es"),
					cursorAt(main, 14, "size"),
				)
				let boundedCall = workspace.symbolAt(
					pathOf("Main.es"),
					cursorAt(main, 9, "size"),
				)

				expect(conformerCall?.filePath).toBe(pathOf("Bag.es"))
				expect(conformerCall?.definition?.start.line).toBe(9)
				expect(boundedCall?.filePath).toBe(pathOf("Sizable.es"))
				expect(boundedCall?.definition?.start.line).toBe(3)
			})
		})

		// A Protocol declared in a body is named by no top level entry, and may
		// share its name with a top level one.
		describe("a Protocol declared in a body", () => {
			const tagged = [
				"\tfunction inner() -> Integer {",
				"\t\tprotocol Tagged {",
				"\t\t\ttag() -> Integer",
				"",
				"\t\t\tdoubled() -> Integer {",
				"\t\t\t\t<- @::tag()::multiply(with 2)",
				"\t\t\t}",
				"\t\t}",
				"",
				"\t\tnamespace IntegerTagged for Integer is Tagged {",
				"\t\t\ttag() -> Integer {",
				"\t\t\t\t<- @",
				"\t\t\t}",
				"\t\t}",
				"",
				"\t\tfunction read <infer Item is Tagged>(_ item: Item) -> Integer {",
				"\t\t\t<- item::tag()",
				"\t\t}",
				"",
				"\t\t<- read(3)",
				"\t}",
			]

			let renamedLines = (
				source: string,
				renamed: Record<string, string> | null,
			): Array<number> =>
				(renamed?.["Main.es"] ?? "")
					.split("\n")
					.flatMap((line, index) =>
						line !== source.split("\n")[index] ? [index + 1] : [],
					)

			it("should rename a conformer's Method with its requirement and calls", () => {
				let main = [
					"implementation {",
					...tagged,
					"",
					"\tTerminal.inspect(inner())",
					"}",
					"",
				].join("\n")
				let { workspace, pathOf } = makeWorkspace({ "Main.es": main })

				for (let line of [4, 7, 12, 18]) {
					expect(
						renamedLines(
							main,
							renameAcross(
								workspace,
								pathOf("Main.es"),
								cursorAt(main, line, "tag"),
								"label",
							),
						),
					).toEqual([4, 7, 12, 18])
				}
			})

			it("should keep it apart from the top level Protocol of its name", () => {
				let main = [
					"implementation {",
					"\tprotocol Tagged {",
					"\t\ttag() -> Integer",
					"\t}",
					"",
					"\tnamespace StringTagged for String is Tagged {",
					"\t\ttag() -> Integer {",
					"\t\t\t<- 1",
					"\t\t}",
					"\t}",
					"",
					"\tfunction outer <infer Item is Tagged>(_ item: Item) -> Integer {",
					"\t\t<- item::tag()",
					"\t}",
					"",
					...tagged,
					"",
					'\tTerminal.inspect(outer("a"))',
					"\tTerminal.inspect(inner())",
					"}",
					"",
				].join("\n")
				let { workspace, pathOf } = makeWorkspace({ "Main.es": main })
				let renamedFrom = (line: number) =>
					renamedLines(
						main,
						renameAcross(
							workspace,
							pathOf("Main.es"),
							cursorAt(main, line, "tag"),
							"label",
						),
					)

				expect(renamedFrom(3)).toEqual([3, 7, 13])
				expect(renamedFrom(18)).toEqual([18, 21, 26, 32])
			})
		})

		// The alias is the importing file's alone, so the members are read off
		// the Module that declares the Protocol.
		describe("a Protocol imported under an alias", () => {
			const sizable = [
				"implementation {",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"\t}",
				"}",
				"",
				"export {",
				"\tSizable",
				"}",
				"",
			].join("\n")
			const bag = [
				"import {",
				'\tfrom "./Sizable.es" { Sizable as Measurable }',
				"}",
				"",
				"implementation {",
				"\ttype Bag = { count: Integer }",
				"",
				"\tnamespace Bags for Bag is Measurable {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"}",
				"",
				"export {",
				"\tBag",
				"\tBags",
				"}",
				"",
			].join("\n")
			const main = [
				"import {",
				'\tfrom "./Sizable.es" { Sizable as Measurable }',
				'\tfrom "./Bag.es" { Bag }',
				'\tfrom "./Bag.es" { Bags }',
				"}",
				"",
				"implementation {",
				"\tfunction measure <infer Value is Measurable>(_ value: Value) -> Integer {",
				"\t\t<- value::size()",
				"\t}",
				"",
				"\tconstant bag: Bag = { count = 0 }",
				"",
				"\tTerminal.inspect(bag::size())",
				"\tTerminal.inspect(measure(bag))",
				"}",
				"",
			].join("\n")
			const files = {
				"Sizable.es": sizable,
				"Bag.es": bag,
				"Main.es": main,
			}

			let expectEverySizeMoved = (
				renamed: Record<string, string> | null,
			): void => {
				expect(renamed).toEqual({
					"Sizable.es": sizable.replaceAll("size", "extent"),
					"Bag.es": bag.replaceAll("size", "extent"),
					"Main.es": main.replaceAll("size", "extent"),
				})
			}

			it("should move every conformer and bounded call from the requirement", () => {
				let { workspace, pathOf } = makeWorkspace(files)

				expectEverySizeMoved(
					renameAcross(
						workspace,
						pathOf("Sizable.es"),
						cursorAt(sizable, 3, "size"),
						"extent",
					),
				)
			})

			it("should move the requirement from a conformer's implementation", () => {
				let { workspace, pathOf } = makeWorkspace(files)

				expectEverySizeMoved(
					renameAcross(
						workspace,
						pathOf("Bag.es"),
						cursorAt(bag, 9, "size"),
						"extent",
					),
				)
			})

			it("should hold every file that declares the name", () => {
				let { workspace, pathOf } = makeWorkspace(files)
				let symbol = workspace.symbolAt(
					pathOf("Bag.es"),
					cursorAt(bag, 9, "size"),
				)

				expect(symbol?.declaredIn.sort()).toEqual(
					[pathOf("Bag.es"), pathOf("Sizable.es")].sort(),
				)
			})
		})

		it("should rename a Method across the files that import its Namespace under an alias", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					'\tfrom "./Geometry.es" { RectangleMeasurable as Measures }',
					"}",
					"",
					"implementation {",
					"\tfunction describe(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape::area()",
					"\t}",
					"",
					"\tconstant unit = Measures.area({ width = 1, height = 1 })",
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
			expect(renamed?.["Main.es"]).toContain("Measures.surface({")
		})

		// The alias is published by a Module that only forwards, so the
		// members are read off the Module that declares the Protocol.
		describe("a Protocol forwarded under an alias", () => {
			const sizable = [
				"implementation {",
				"\tprotocol Sizable {",
				"\t\tsize() -> Integer",
				"\t}",
				"}",
				"",
				"export {",
				"\tSizable",
				"}",
				"",
			].join("\n")
			const facade = [
				"implementation {}",
				"",
				"export {",
				'\tfrom "./Sizable.es" { Sizable as Measurable }',
				"}",
				"",
			].join("\n")
			const bag = [
				"import {",
				'\tfrom "./Facade.es" { Measurable }',
				"}",
				"",
				"implementation {",
				"\ttype Bag = { count: Integer }",
				"",
				"\tnamespace Bags for Bag is Measurable {",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.count",
				"\t\t}",
				"\t}",
				"}",
				"",
				"export {",
				"\tBag",
				"\tBags",
				"}",
				"",
			].join("\n")
			const files = {
				"Sizable.es": sizable,
				"Facade.es": facade,
				"Bag.es": bag,
			}
			const moved = {
				"Sizable.es": sizable.replaceAll("size", "extent"),
				"Bag.es": bag.replaceAll("size", "extent"),
			}

			it("should move the conformer from the requirement", () => {
				let { workspace, pathOf } = makeWorkspace(files)

				expect(
					renameAcross(
						workspace,
						pathOf("Sizable.es"),
						cursorAt(sizable, 3, "size"),
						"extent",
					),
				).toEqual(moved)
			})

			it("should move the requirement from the conformer", () => {
				let { workspace, pathOf } = makeWorkspace(files)

				expect(
					renameAcross(
						workspace,
						pathOf("Bag.es"),
						cursorAt(bag, 9, "size"),
						"extent",
					),
				).toEqual(moved)
			})

			it("should move the conformer through a second forwarding alias", () => {
				let gauged = bag
					.replace(
						'"./Facade.es" { Measurable }',
						'"./Gauge.es" { Gaugeable }',
					)
					.replace("is Measurable", "is Gaugeable")
				let { workspace, pathOf } = makeWorkspace({
					"Sizable.es": sizable,
					"Facade.es": facade,
					"Gauge.es": [
						"implementation {}",
						"",
						"export {",
						'\tfrom "./Facade.es" { Measurable as Gaugeable }',
						"}",
						"",
					].join("\n"),
					"Bag.es": gauged,
				})

				expect(
					renameAcross(
						workspace,
						pathOf("Sizable.es"),
						cursorAt(sizable, 3, "size"),
						"extent",
					),
				).toEqual({
					"Sizable.es": sizable.replaceAll("size", "extent"),
					"Bag.es": gauged.replaceAll("size", "extent"),
				})
			})
		})

		it("should rename a Method across the files that import its Namespace forwarded under an alias", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Facade.es": [
					"implementation {}",
					"",
					"export {",
					'\tfrom "./Geometry.es" { Rectangle }',
					'\tfrom "./Geometry.es" { RectangleMeasurable as Measures }',
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Facade.es" { Rectangle }',
					'\tfrom "./Facade.es" { Measures }',
					"}",
					"",
					"implementation {",
					"\tfunction describe(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape::area()",
					"\t}",
					"",
					"\tconstant unit = Measures.area({ width = 1, height = 1 })",
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
			expect(renamed?.["Main.es"]).toContain("<- shape::surface()")
			expect(renamed?.["Main.es"]).toContain("Measures.surface({")
		})

		// Record Types are structural, so a member is joined to its uses in
		// another Module by the shapes both write, as within one file.
		describe("a Record member another Module declares", () => {
			const types = [
				"implementation {",
				"\ttype Server = { host: String, port: Integer }",
				"\ttype Config = { name: String, server: Server }",
				"\ttype Endpoint = Server",
				"",
				"\tchoice Fetch {",
				"\t\tGet { url: String, retries: Integer },",
				"\t\tStop,",
				"\t}",
				"}",
				"",
				"export {",
				"\tServer",
				"\tConfig",
				"\tEndpoint",
				"\tFetch",
				"}",
				"",
			].join("\n")

			const main = [
				"import {",
				'\tfrom "./Types.es" {',
				"\t\tServer",
				"\t\tConfig",
				"\t\tEndpoint",
				"\t\tFetch",
				"\t}",
				"}",
				"",
				"implementation {",
				"\t§§ Answers the port.",
				"\t§§",
				"\t§§ @param using — where to connect.",
				"\t§§ @returns — the port.",
				'\tfunction connect(using server: Server = { host = "h", port = 80 }) -> Integer {',
				"\t\t<- server.port",
				"\t}",
				"",
				"\t§§ Answers the port.",
				"\t§§",
				"\t§§ @param _ — what to read.",
				"\t§§ @returns — the port.",
				"\tfunction portOf(_ server: Server) -> Integer {",
				"\t\tconstant { port } = server",
				"\t\t<- port",
				"\t}",
				"",
				'\tconstant s: Server = { host = "a", port = 80 }',
				"\tconstant moved = { s with port = 81 }",
				"\tconstant servers: List<Server> = [s]",
				"\tconstant ports = servers::map(.port)",
				"\tconstant port = 8080",
				'\tconstant short: Server = { host = "b", port }',
				'\tconstant config: Config = { name = "c", server = s }',
				"\tconstant deeper = { config with server.port = 2 }",
				'\tconstant e: Endpoint = { host = "e", port = 3 }',
				'\tconstant f: Fetch = #Get({ url = "u", retries = 1 })',
				"\tconstant tries = match f -> Integer {",
				"\t\tcase #Get({ retries }) { <- retries }",
				"\t\tcase #Stop { <- 0 }",
				"\t}",
				"",
				"\tTerminal.inspect(e.port::add(config.server.port))",
				"\tconstant read = match f -> Integer {",
				"\t\tcase #Get { <- @.retries }",
				"\t\tcase #Stop { <- 0 }",
				"\t}",
				"}",
				"",
			].join("\n")

			// The Diagnostics of every file once the rename is written back.
			function codesAfter(
				workspace: Workspace,
				pathOf: (name: string) => string,
				renamed: Record<string, string> | null,
			): Record<string, Array<common.DiagnosticCode>> {
				for (let [name, text] of Object.entries(renamed ?? {})) {
					writeFileSync(pathOf(name), text)
					workspace.changed(pathOf(name))
				}

				let codes: Record<string, Array<common.DiagnosticCode>> = {}

				for (let name of ["Types.es", "Main.es"]) {
					codes[name] = analyseDocument(
						workspace.sourceOf(pathOf(name)) ?? "",
						pathOf(name),
						{ host: workspace.host },
					).diagnostics.map((diagnostic) => diagnostic.code)
				}

				return codes
			}

			const renamedMain = main
				.replace("port = 80 }) -> Integer", "socket = 80 }) -> Integer")
				.replace("<- server.port", "<- server.socket")
				.replace("constant { port }", "constant { socket as port }")
				.replace('"a", port = 80', '"a", socket = 80')
				.replace("s with port", "s with socket")
				.replace("map(.port)", "map(.socket)")
				.replace('"b", port }', '"b", socket = port }')
				.replace("server.port = 2", "server.socket = 2")
				.replace('"e", port = 3', '"e", socket = 3')
				.replace(
					"e.port::add(config.server.port)",
					"e.socket::add(config.server.socket)",
				)

			it("should rename every use in the importing Module from the declaration", () => {
				let { workspace, pathOf } = makeWorkspace({
					"Types.es": types,
					"Main.es": main,
				})

				let renamed = renameAcross(
					workspace,
					pathOf("Types.es"),
					cursorAt(types, 2, "port"),
					"socket",
				)

				expect(renamed).toEqual({
					"Types.es": types.replace(
						"port: Integer",
						"socket: Integer",
					),
					"Main.es": renamedMain,
				})
				expect(codesAfter(workspace, pathOf, renamed)).toEqual({
					"Types.es": [],
					"Main.es": [],
				})
			})

			it("should reach the declaration from a member read and from a Record key", () => {
				for (let [line, needle] of [
					[16, "port"],
					[28, "port"],
				] as const) {
					let { workspace, pathOf } = makeWorkspace({
						"Types.es": types,
						"Main.es": main,
					})

					let renamed = renameAcross(
						workspace,
						pathOf("Main.es"),
						cursorAt(main, line, needle),
						"socket",
					)

					expect(renamed).toEqual({
						"Types.es": types.replace(
							"port: Integer",
							"socket: Integer",
						),
						"Main.es": renamedMain,
					})
					expect(codesAfter(workspace, pathOf, renamed)).toEqual({
						"Types.es": [],
						"Main.es": [],
					})
				}
			})

			it("should list the uses in the importing Module as references", () => {
				let { workspace, pathOf } = makeWorkspace({
					"Types.es": types,
					"Main.es": main,
				})

				let symbol = workspace.symbolAt(
					pathOf("Types.es"),
					cursorAt(types, 2, "port"),
				)

				expect(
					symbol?.occurrences
						.map(
							(occurrence) =>
								`${path.basename(occurrence.filePath)}:${occurrence.position.start.line}`,
						)
						.sort(),
				).toEqual(
					[
						"Types.es:2",
						"Main.es:15",
						"Main.es:16",
						"Main.es:24",
						"Main.es:28",
						"Main.es:29",
						"Main.es:31",
						"Main.es:33",
						"Main.es:35",
						"Main.es:36",
						"Main.es:43",
						"Main.es:43",
					].sort(),
				)
			})

			it("should rename a Case payload member of an exported Choice", () => {
				let { workspace, pathOf } = makeWorkspace({
					"Types.es": types,
					"Main.es": main,
				})

				let renamed = renameAcross(
					workspace,
					pathOf("Types.es"),
					cursorAt(types, 7, "retries"),
					"attempts",
				)

				expect(renamed).toEqual({
					"Types.es": types.replace("retries:", "attempts:"),
					"Main.es": main
						.replace("retries = 1", "attempts = 1")
						.replace("{ retries }", "{ attempts as retries }")
						.replace("@.retries", "@.attempts"),
				})
				expect(codesAfter(workspace, pathOf, renamed)).toEqual({
					"Types.es": [],
					"Main.es": [],
				})
			})

			// A bare path key is refused. Its last step is also the value it reads,
			// so renaming the member spells the value out and the update compiles.
			it("should spell out a bare path key in the importing Module", () => {
				let bare = [
					"import {",
					'\tfrom "./Types.es" { Config }',
					"}",
					"",
					"implementation {",
					'\tconstant config: Config = { name = "c", server = { host = "h", port = 1 } }',
					"\tconstant port = 8080",
					'\tconstant moved = { config with server.port, name = "d" }',
					"}",
					"",
				].join("\n")
				let { workspace, pathOf } = makeWorkspace({
					"Types.es": types,
					"Main.es": bare,
				})

				let renamed = renameAcross(
					workspace,
					pathOf("Types.es"),
					cursorAt(types, 2, "port"),
					"socket",
				)

				expect(renamed).toEqual({
					"Types.es": types.replace(
						"port: Integer",
						"socket: Integer",
					),
					"Main.es": bare
						.replace("port = 1 }", "socket = 1 }")
						.replace("server.port,", "server.socket = port,"),
				})
				expect(codesAfter(workspace, pathOf, renamed)).toEqual({
					"Types.es": [],
					"Main.es": [],
				})
			})

			// `Proxy` shares the member's name, and neither shape holds the
			// other.
			it("should leave a member of another Type with the same name", () => {
				let proxied = [
					"import {",
					'\tfrom "./Types.es" { Server }',
					"}",
					"",
					"implementation {",
					"\ttype Proxy = { port: Integer, timeout: Integer }",
					"",
					"\tconstant proxy: Proxy = { port = 1, timeout = 2 }",
					'\tconstant s: Server = { host = "a", port = 80 }',
					"",
					"\tTerminal.inspect(proxy.port::add(s.port))",
					"}",
					"",
				].join("\n")
				let { workspace, pathOf } = makeWorkspace({
					"Types.es": types,
					"Main.es": proxied,
				})

				let fromServer = renameAcross(
					workspace,
					pathOf("Types.es"),
					cursorAt(types, 2, "port"),
					"socket",
				)

				expect(fromServer).toEqual({
					"Types.es": types.replace(
						"port: Integer",
						"socket: Integer",
					),
					"Main.es": proxied
						.replace('"a", port = 80', '"a", socket = 80')
						.replace("s.port)", "s.socket)"),
				})

				expect(
					renameAcross(
						workspace,
						pathOf("Main.es"),
						cursorAt(proxied, 6, "port"),
						"gate",
					),
				).toEqual({
					"Main.es": proxied
						.replace("{ port: Integer", "{ gate: Integer")
						.replace("{ port = 1", "{ gate = 1")
						.replace("proxy.port", "proxy.gate"),
				})
				expect(codesAfter(workspace, pathOf, fromServer)).toEqual({
					"Types.es": [],
					"Main.es": [],
				})
			})

			// An update and a Pattern write part of a `Server`, by keys `Proxy`
			// shares.
			it("should leave another Type's member through an update and a Pattern", () => {
				let proxied = [
					"import {",
					'\tfrom "./Types.es" { Server }',
					"}",
					"",
					"implementation {",
					"\ttype Proxy = { port: Integer, timeout: Integer }",
					"",
					"\tconstant proxy: Proxy = { port = 1, timeout = 2 }",
					'\tconstant s: Server = { host = "a", port = 80 }',
					"\tconstant moved = { s with port = 81 }",
					"\tconstant { port } = moved",
					"",
					"\tTerminal.inspect(proxy.port::add(port))",
					"}",
					"",
				].join("\n")
				let { workspace, pathOf } = makeWorkspace({
					"Types.es": types,
					"Main.es": proxied,
				})

				let renamed = renameAcross(
					workspace,
					pathOf("Types.es"),
					cursorAt(types, 2, "port"),
					"socket",
				)

				expect(renamed).toEqual({
					"Types.es": types.replace(
						"port: Integer",
						"socket: Integer",
					),
					"Main.es": proxied
						.replace('"a", port = 80', '"a", socket = 80')
						.replace("s with port", "s with socket")
						.replace("{ port } =", "{ socket as port } ="),
				})
				expect(codesAfter(workspace, pathOf, renamed)).toEqual({
					"Types.es": [],
					"Main.es": [],
				})
			})
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

			// An empty query is every symbol, since the client filters.
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

			// Sorted by specifier, so a group for a later file goes below
			// every group of an earlier one whatever the names are.
			let last = insertImportEdit(source, program, {
				name: "PI",
				alias: "Pi",
				specifier: "./math/Math.es",
			})

			expect(last?.range.start).toEqual({ line: 4, column: 1 })
			expect(last?.newText).toBe('\tfrom "./math/Math.es" { PI as Pi }\n')
		})

		// A group of one name is written flat. A second name writes it out one
		// name to a line, in order, as the Formatter does.
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

		// Applied and parsed again, since only a parse shows an insertion stayed
		// inside the braces of a block written on one line.
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

		// `shape::area()` names no Namespace, so the Enricher's own help says
		// which one declares the Method for this receiver.
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

		// The specifier names a Namespace this Module does not import, which is
		// an unknown name like any other.
		it("should offer an import for a Namespace specifier", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"\tfunction describe(_ shape: Rectangle) -> Integer {",
					"\t\t<- shape::<RectangleMeasurable>area()",
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
					7,
					"RectangleMeasurable",
				),
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

		// The last name of a group takes the group with it, since an empty
		// group imports nothing.
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

		// Two entries may share a line. The removal takes the unused name and
		// its blank, and leaves the entry that is still read.
		it("should remove an unused entry written beside a used one", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle RectangleMeasurable }',
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
			let source = workspace.sourceOf(mainPath) ?? ""
			let removal = findCodeActions(
				source,
				spanOf(source, 2, "RectangleMeasurable"),
				mainPath,
				workspace,
			).find((action) =>
				action.title.startsWith("Remove the unused import"),
			) as CodeActionEntry
			let fixed = applyEdits(source, removal.edits)

			expect(fixed.split("\n")[1]).toBe(
				'\tfrom "./Geometry.es" { Rectangle }',
			)
			expect(
				analyseDocument(fixed, mainPath, { host: workspace.host })
					.diagnostics,
			).toEqual([])
		})

		// Two groups may share a line too. The duplicate fix drops the later
		// one and leaves the earlier where it was written.
		it("should remove a duplicate group written beside another", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Shapes.es": shapes,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle } from "./Shapes.es" { Rectangle }',
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
			let source = workspace.sourceOf(mainPath) ?? ""
			let removal = findCodeActions(
				source,
				spanOf(source, 2, '"./Shapes.es" { Rectangle }'),
				mainPath,
				workspace,
			).find(
				(action) => action.diagnosticCode === "duplicate-import",
			) as CodeActionEntry
			let fixed = applyEdits(source, removal.edits)

			expect(fixed.split("\n")[1]).toBe(
				'\tfrom "./Geometry.es" { Rectangle }',
			)
			expect(
				analyseDocument(fixed, mainPath, { host: workspace.host })
					.diagnostics,
			).toEqual([])
		})

		// The Diagnostic points at the later of the two entries, since the
		// earlier one already holds the name.
		it("should offer to remove the later of two entries binding one name", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Shapes.es": shapes,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					'\tfrom "./Shapes.es" { Rectangle }',
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
			let source = workspace.sourceOf(mainPath) ?? ""
			let removal = findCodeActions(
				source,
				spanOf(source, 3, "Rectangle"),
				mainPath,
				workspace,
			).find((action) => action.diagnosticCode === "duplicate-import")
			let fixed = applyEdits(source, removal?.edits ?? [])

			expect(removal?.title).toBe(
				"Remove the duplicate import of 'Rectangle'",
			)
			// Offered, never preferred. The entries name two Modules'
			// `Rectangle`, so dropping the second changes what every use reads.
			// The Help asks for the `as` that keeps both.
			expect(removal?.isPreferred).toBe(false)

			expect(fixed.split("\n")).toEqual([
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
			])

			expect(
				analyseDocument(fixed, mainPath, { host: workspace.host })
					.diagnostics,
			).toEqual([])
		})

		// The same code covers a clash with the file's own declaration. Dropping
		// the entry would change the Program, and no edit can choose an `as`.
		it("should offer nothing where a declaration holds the name", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle }',
					"}",
					"",
					"implementation {",
					"\ttype Rectangle = { width: Integer }",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let actions = findCodeActions(
				source,
				spanOf(source, 2, "Rectangle"),
				mainPath,
				workspace,
			)

			expect(
				actions.filter(
					(action) => action.diagnosticCode === "duplicate-import",
				),
			).toEqual([])
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
			expect(offered?.tier).toBe(7)
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

		// A facade forwards another Module's declaration, and the entry names
		// the facade. Importing past it would be a different dependency.
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

	// These are reported by the graph rather than by one document's pipeline,
	// so their fixes need a workspace.
	describe("the Module Diagnostics a Quick Fix answers", () => {
		function fixesFor(
			workspace: Workspace,
			filePath: string,
			line: number,
			needle: string,
		): Array<CodeActionEntry> {
			let source = workspace.sourceOf(filePath) ?? ""

			return findCodeActions(
				source,
				spanOf(source, line, needle),
				filePath,
				workspace,
			).filter((action) => action.kind === "quickfix")
		}

		function codesAfter(
			workspace: Workspace,
			filePath: string,
			text: string,
		): Array<common.DiagnosticCode> {
			return analyseDocument(text, filePath, {
				host: workspace.host,
			}).diagnostics.map((diagnostic) => diagnostic.code)
		}

		// Printing also needs a Namespace stating it, so the import is only the
		// first of the Help's two edits and the fix is not preferred.
		it("should not prefer an import that is only half of the Help", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Signals.es": [
					"implementation {",
					"\tchoice Signal { Go, Stop }",
					"",
					"\tfunction signal() -> Signal {",
					"\t\t<- #Go",
					"\t}",
					"}",
					"",
					"export {",
					"\tSignal",
					"\tsignal",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Signals.es" { signal }',
					"}",
					"",
					"implementation {",
					"\tTerminal.print(signal())",
					"}",
					"",
				].join("\n"),
			})
			let mainPath = pathOf("Main.es")
			let [fix] = fixesFor(workspace, mainPath, 6, "Terminal.print")

			expect(fix.title).toBe("Import 'Signal' from ./Signals.es")
			expect(fix.isPreferred).toBe(false)
		})

		// `Main.es` names neither Choice. A Case is written bare where that
		// resolves against the matched value, and `case _` takes the rest.
		describe("a Match over Choices no import names", () => {
			let files = {
				"Parcels.es": [
					"implementation {",
					"\tchoice Box<Value> { Full { value: Value }, Empty }",
					"\tchoice Crate { Full { count: Integer }, Bare }",
					"",
					"\tfunction boxes() -> Box<Integer> | Box<String> {",
					"\t\t<- Box<Integer>#Full(1)",
					"\t}",
					"",
					"\tfunction parcels() -> Box<Integer> | Crate {",
					"\t\t<- Crate#Bare",
					"\t}",
					"}",
					"",
					"export {",
					"\tboxes",
					"\tparcels",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Parcels.es" {',
					"\t\tboxes",
					"\t\tparcels",
					"\t}",
					"}",
					"",
					"implementation {",
					"\tconstant boxed = boxes()",
					"\tconstant parcel = parcels()",
					"",
					"\tTerminal.print(match boxed -> String {",
					'\t\tcase #Empty { <- "empty" }',
					"\t})",
					"\tTerminal.print(match parcel -> String {",
					'\t\tcase #Bare { <- "bare" }',
					"\t})",
					"}",
					"",
				].join("\n"),
			}

			it("should write the missing arms the file can name", () => {
				let { workspace, pathOf } = makeWorkspace(files)
				let mainPath = pathOf("Main.es")
				let source = workspace.sourceOf(mainPath) ?? ""
				let [boxedFix] = fixesFor(
					workspace,
					mainPath,
					12,
					"match boxed",
				)
				let [parcelFix] = fixesFor(
					workspace,
					mainPath,
					15,
					"match parcel",
				)

				expect(boxedFix.title).toBe("Add missing Cases")
				expect(
					applyEdits(source, boxedFix.edits)
						.split("\n")
						.slice(11, 15),
				).toEqual([
					"\tTerminal.print(match boxed -> String {",
					'\t\tcase #Empty { <- "empty" }',
					"\t\tcase #Full {}",
					"\t})",
				])
				expect(
					applyEdits(source, parcelFix.edits)
						.split("\n")
						.slice(14, 19),
				).toEqual([
					"\tTerminal.print(match parcel -> String {",
					'\t\tcase #Bare { <- "bare" }',
					"\t\tcase #Empty {}",
					"\t\tcase _ {}",
					"\t})",
				])

				let codes = codesAfter(
					workspace,
					mainPath,
					applyEdits(source, [...boxedFix.edits, ...parcelFix.edits]),
				)

				expect(codes).not.toContain("missing-case")
				expect(codes).not.toContain("unknown-type")
			})

			it("should scaffold a Match the file can write", () => {
				let { workspace, pathOf } = makeWorkspace({
					...files,
					"Main.es": [
						"import {",
						'\tfrom "./Parcels.es" { parcels }',
						"}",
						"",
						"implementation {",
						"\tfunction shown() -> String {",
						"\t\t<- parcels()",
						"\t}",
						"}",
						"",
					].join("\n"),
				})
				let mainPath = pathOf("Main.es")
				let source = workspace.sourceOf(mainPath) ?? ""
				let [scaffold] = findCodeActions(
					source,
					spanOf(source, 7, "parcels()"),
					mainPath,
					workspace,
				).filter((action) => action.title.startsWith("Match on"))
				let result = applyEdits(source, scaffold.edits)

				expect(result.split("\n").slice(5, 13)).toEqual([
					"\tfunction shown() -> String {",
					"\t\t<- match parcels() -> String {",
					"\t\t\tcase #Empty {}",
					"\t\t\tcase #Bare {}",
					"\t\t\tcase _ {}",
					"\t\t}",
					"\t}",
					"}",
				])
				expect(codesAfter(workspace, mainPath, result)).not.toContain(
					"unknown-type",
				)
			})
		})

		// `Problem` is a Choice another Module declares, and its derived
		// equality is in reach only where its name is. The fix is an import of the
		// Module the Type's nominal identity names.
		it("should answer an unreachable derived conformance with the import", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Parser.es": [
					"implementation {",
					"\tchoice Problem {",
					"\t\tNotANumber,",
					"\t}",
					"",
					"\tfunction parse(_ text: String) -> Result<Integer, Problem> {",
					"\t\t<- match Integer.parse(text) -> Result<Integer, Problem> {",
					"\t\t\tcase #Value(number) { <- Result<Integer, Problem>#Value(number) }",
					"\t\t\tcase #Empty { <- Result<Integer, Problem>#Failure(#NotANumber) }",
					"\t\t}",
					"\t}",
					"}",
					"",
					"export {",
					"\tProblem",
					"\tparse",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Parser.es" { parse }',
					"}",
					"",
					"implementation {",
					'\tconstant outcome = parse("seven")',
					'\tTerminal.print("{outcome::is(#Failure(#NotANumber))}")',
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let reported = analyseDocument(source, mainPath, {
				host: workspace.host,
			}).diagnostics.find(
				(diagnostic) => diagnostic.code === "unsatisfied-bound",
			)

			expect(reported?.helps).toEqual([
				"'Problem' is declared in Parser.es — import it here, so its derived 'Equatable' is in scope.",
			])

			let [fix] = fixesFor(workspace, mainPath, 7, "outcome::is")

			expect(fix.title).toBe("Import 'Problem' from ./Parser.es")
			expect(fix.isPreferred).toBe(true)

			let result = applyEdits(source, fix.edits)

			expect(result.split("\n").slice(0, 5)).toEqual([
				"import {",
				'\tfrom "./Parser.es" {',
				"\t\tProblem",
				"\t\tparse",
				"\t}",
			])

			// The bound is satisfied. `usedNames` counts a named Type the tree
			// resolved to, so the entry this fix wrote is not read as unused.
			expect(codesAfter(workspace, mainPath, result)).not.toContain(
				"unsatisfied-bound",
			)
		})

		// `unsatisfied-bound` asks for the import, and `usedNames` counts the
		// Type it brings in, though no name is spelled. Nothing is left to
		// report.
		it("should leave a Program with nothing left to report", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Parser.es": [
					"implementation {",
					"\tchoice Problem {",
					"\t\tNotANumber,",
					"\t}",
					"",
					"\tfunction parse(_ text: String) -> Result<Integer, Problem> {",
					"\t\t<- match Integer.parse(text) -> Result<Integer, Problem> {",
					"\t\t\tcase #Value(number) { <- Result<Integer, Problem>#Value(number) }",
					"\t\t\tcase #Empty { <- Result<Integer, Problem>#Failure(#NotANumber) }",
					"\t\t}",
					"\t}",
					"}",
					"",
					"export {",
					"\tProblem",
					"\tparse",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Parser.es" {',
					"\t\tProblem",
					"\t\tparse",
					"\t}",
					"}",
					"",
					"implementation {",
					'\tconstant outcome = parse("seven")',
					'\tTerminal.print("{outcome::is(#Failure(#NotANumber))}")',
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")

			expect(
				codesAfter(
					workspace,
					mainPath,
					workspace.sourceOf(mainPath) ?? "",
				),
			).toEqual([])
		})

		// `measure` is bounded by a Protocol `Main.es` never imported, and
		// `Sized.es` resolved it, so there is nothing to fix.
		it("should leave a call bounded by a Protocol the file never imports alone", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Sized.es": [
					"implementation {",
					"\tprotocol Sized {",
					"\t\tsize() -> Integer",
					"\t}",
					"",
					"\tnamespace IntegerSized for Integer is Sized {",
					"\t\tsize() -> Integer {",
					"\t\t\t<- @",
					"\t\t}",
					"\t}",
					"",
					"\tfunction measure <infer Item is Sized>(_ item: Item) -> Integer {",
					"\t\t<- item::size()",
					"\t}",
					"}",
					"",
					"export {",
					"\tIntegerSized",
					"\tSized",
					"\tmeasure",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Sized.es" {',
					"\t\tIntegerSized",
					"\t\tmeasure",
					"\t}",
					"}",
					"",
					"implementation {",
					"\tTerminal.inspect(measure(3))",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""

			expect(
				analyseDocument(source, mainPath, { host: workspace.host })
					.diagnostics,
			).toEqual([])
			expect(fixesFor(workspace, mainPath, 9, "measure(3)")).toEqual([])
		})

		// `Main.es` bounds its own Function by a `Sized` it never imported.
		// The Compiler names the Module that declares it, and the fix writes the
		// entry, after which nothing is left to report.
		it("should answer a bound naming an unimported Protocol with the import", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Sized.es": [
					"implementation {",
					"\tprotocol Sized {",
					"\t\tsize() -> Integer",
					"\t}",
					"",
					"\tconstant unit = 1",
					"}",
					"",
					"export {",
					"\tSized",
					"\tunit",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Sized.es" { unit }',
					"}",
					"",
					"implementation {",
					"\tfunction measure <infer Item is Sized>(_ item: Item) -> Integer {",
					"\t\t<- item::size()::add(unit)",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let reported = analyseDocument(source, mainPath, {
				host: workspace.host,
			}).diagnostics.find(
				(diagnostic) => diagnostic.code === "unknown-protocol",
			)

			expect(reported?.helps).toEqual([
				"'Sized' is declared in Sized.es — import it here.",
			])

			let [fix] = fixesFor(workspace, mainPath, 6, "Sized")

			expect(fix.title).toBe("Import 'Sized' from ./Sized.es")
			expect(
				codesAfter(workspace, mainPath, applyEdits(source, fix.edits)),
			).toEqual([])
		})

		// `Main.es` names `Sized.es` and has not imported `IntegerSized`,
		// the Namespace the call needs. The fix writes that entry, and nothing is
		// left to report once it stands.
		it("should answer a refused bound with the import of the Namespace that conforms", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Sized.es": [
					"implementation {",
					"\tprotocol Sized {",
					"\t\tsize() -> Integer",
					"\t}",
					"",
					"\tnamespace IntegerSized for Integer is Sized {",
					"\t\tsize() -> Integer {",
					"\t\t\t<- @",
					"\t\t}",
					"\t}",
					"",
					"\tfunction measure <infer Item is Sized>(_ item: Item) -> Integer {",
					"\t\t<- item::size()",
					"\t}",
					"}",
					"",
					"export {",
					"\tIntegerSized",
					"\tSized",
					"\tmeasure",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Sized.es" { measure }',
					"}",
					"",
					"implementation {",
					"\tTerminal.inspect(measure(3))",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 6, "measure(3)")

			expect(fix.title).toBe("Import 'IntegerSized' from ./Sized.es")

			let result = applyEdits(source, fix.edits)

			expect(result.split("\n").slice(0, 6)).toEqual([
				"import {",
				'\tfrom "./Sized.es" {',
				"\t\tIntegerSized",
				"\t\tmeasure",
				"\t}",
				"}",
			])
			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		// `Main.es` binds no name for `Sized`, so the bound and its import
		// are one edit, and nothing is left to report once both stand.
		it("should bound a Type Parameter and import its Protocol in one fix", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Sized.es": [
					"implementation {",
					"\tprotocol Sized {",
					"\t\tsize() -> Integer",
					"\t}",
					"",
					"\tfunction measure <infer Item is Sized>(_ item: Item) -> Integer {",
					"\t\t<- item::size()",
					"\t}",
					"}",
					"",
					"export {",
					"\tSized",
					"\tmeasure",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Sized.es" { measure }',
					"}",
					"",
					"implementation {",
					"\tfunction relay <infer Item>(_ item: Item) -> Integer {",
					"\t\t<- measure(item)",
					"\t}",
					"}",
					"",
					"export {",
					"\trelay",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 7, "measure(item)")

			expect(fix.title).toBe(
				"Declare it as '<infer Item is Sized>', importing 'Sized' from ./Sized.es",
			)

			let result = applyEdits(source, fix.edits)

			expect(result.split("\n").slice(0, 10)).toEqual([
				"import {",
				'\tfrom "./Sized.es" {',
				"\t\tSized",
				"\t\tmeasure",
				"\t}",
				"}",
				"",
				"implementation {",
				"\tfunction relay <infer Item is Sized>(_ item: Item) -> Integer {",
				"\t\t<- measure(item)",
			])
			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		it("should bound a Namespace's Type Parameter for one Method and import its Protocol", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Sized.es": [
					"implementation {",
					"\tprotocol Sized {",
					"\t\tsize() -> Integer",
					"\t}",
					"",
					"\tfunction measure <infer Item is Sized>(_ item: Item) -> Integer {",
					"\t\t<- item::size()",
					"\t}",
					"}",
					"",
					"export {",
					"\tSized",
					"\tmeasure",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Sized.es" { measure }',
					"}",
					"",
					"implementation {",
					"\ttype Holder<Item> = { item: Item }",
					"",
					"\tnamespace Holders<infer Item> for Holder<Item> {",
					"\t\ttotal() -> Integer {",
					"\t\t\t<- measure(@.item)",
					"\t\t}",
					"\t}",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 10, "measure(@.item)")

			expect(fix.title).toBe(
				"Bound it for this Method: '<Item is Sized>', importing 'Sized' from ./Sized.es",
			)

			let result = applyEdits(source, fix.edits)

			expect(result.split("\n").slice(0, 14)).toEqual([
				"import {",
				'\tfrom "./Sized.es" {',
				"\t\tSized",
				"\t\tmeasure",
				"\t}",
				"}",
				"",
				"implementation {",
				"\ttype Holder<Item> = { item: Item }",
				"",
				"\tnamespace Holders<infer Item> for Holder<Item> {",
				"\t\ttotal<Item is Sized>() -> Integer {",
				"\t\t\t<- measure(@.item)",
				"\t\t}",
			])
			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		// An import of `Sized` beside the file's own Type of that name
		// would be refused, so there is no fix to offer.
		it("should offer no bound whose import a Type of the file would collide with", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Sized.es": [
					"implementation {",
					"\tprotocol Sized {",
					"\t\tsize() -> Integer",
					"\t}",
					"",
					"\tfunction measure <infer Item is Sized>(_ item: Item) -> Integer {",
					"\t\t<- item::size()",
					"\t}",
					"}",
					"",
					"export {",
					"\tSized",
					"\tmeasure",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Sized.es" { measure }',
					"}",
					"",
					"implementation {",
					"\ttype Sized = { count: Integer }",
					"",
					"\tfunction relay <infer Item>(_ item: Item) -> Integer {",
					"\t\t<- measure(item)",
					"\t}",
					"}",
					"",
					"export {",
					"\trelay",
					"\tSized",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")

			expect(
				codesAfter(
					workspace,
					mainPath,
					workspace.sourceOf(mainPath) ?? "",
				),
			).toEqual(["unsatisfied-bound"])
			expect(fixesFor(workspace, mainPath, 9, "measure(item)")).toEqual(
				[],
			)
		})

		// `Sized.es` publishes `Sized` as `Measurable`, so the entry and
		// the bound are both written by that name.
		it("should bound a Type Parameter by the name its Protocol is exported under", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Sized.es": [
					"implementation {",
					"\tprotocol Sized {",
					"\t\tsize() -> Integer",
					"\t}",
					"",
					"\tfunction measure <infer Item is Sized>(_ item: Item) -> Integer {",
					"\t\t<- item::size()",
					"\t}",
					"}",
					"",
					"export {",
					"\tSized as Measurable",
					"\tmeasure",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Sized.es" { measure }',
					"}",
					"",
					"implementation {",
					"\tfunction relay <infer Item>(_ item: Item) -> Integer {",
					"\t\t<- measure(item)",
					"\t}",
					"}",
					"",
					"export {",
					"\trelay",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 7, "measure(item)")

			expect(fix.title).toBe(
				"Declare it as '<infer Item is Measurable>', importing 'Measurable' from ./Sized.es",
			)

			let result = applyEdits(source, fix.edits)

			expect(result.split("\n").slice(0, 10)).toEqual([
				"import {",
				'\tfrom "./Sized.es" {',
				"\t\tMeasurable",
				"\t\tmeasure",
				"\t}",
				"}",
				"",
				"implementation {",
				"\tfunction relay <infer Item is Measurable>(_ item: Item) -> Integer {",
				"\t\t<- measure(item)",
			])
			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		// The file's `type Sized` takes the name an entry would bind. The import
		// would be a duplicate, and no edit can choose an alias.
		it("should offer no import of a name the file binds already", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Sized.es": [
					"implementation {",
					"\tprotocol Sized {",
					"\t\tsize() -> Integer",
					"\t}",
					"",
					"\tfunction measure <infer Item is Sized>(_ item: Item) -> Integer {",
					"\t\t<- item::size()",
					"\t}",
					"}",
					"",
					"export {",
					"\tSized",
					"\tmeasure",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Sized.es" { measure }',
					"}",
					"",
					"implementation {",
					"\ttype Sized = { count: Integer }",
					"",
					"\tfunction relay <infer Item is Sized>(_ item: Item) -> Integer {",
					"\t\t<- 1",
					"\t}",
					"}",
					"",
					"export {",
					"\trelay",
					"\tSized",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let reported = analyseDocument(
				workspace.sourceOf(mainPath) ?? "",
				mainPath,
				{ host: workspace.host },
			).diagnostics.find(
				(diagnostic) => diagnostic.code === "unknown-protocol",
			)

			expect(reported?.helps).toEqual([
				"'Sized' is declared in Sized.es — import it under a name of its own, 'Sized as …', and write that name here, since this file binds 'Sized' already.",
			])
			expect(fixesFor(workspace, mainPath, 8, "Sized")).toEqual([])
		})

		it("should remove the whole entry of a self-import", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Main.es": [
					"import {",
					'\tfrom "./Main.es" { thing }',
					"}",
					"",
					"implementation {",
					"\tconstant thing = 1",
					"\tconstant used = thing",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 2, '"./Main.es"')

			expect(fix.title).toBe(`Remove the entry for "./Main.es"`)
			expect(fix.diagnosticCode).toBe("self-import")
			expect(fix.isPreferred).toBe(true)

			let result = applyEdits(source, fix.edits)

			// The group goes and the section stays, as `removeImportAction` does
			// with a group's last unused name. An empty `import { }` is not wrong.
			expect(result).toBe(
				[
					"import {",
					"}",
					"",
					"implementation {",
					"\tconstant thing = 1",
					"\tconstant used = thing",
					"}",
					"",
				].join("\n"),
			)

			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		// A self-import beside another group takes only the blanks in front of
		// it. The group sharing its line is how the file reaches what it names.
		it("should remove a self-import written beside another group", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Other.es": other,
				"Main.es": [
					"import {",
					'\tfrom "./Other.es" { thing } from "./Main.es" { here }',
					"}",
					"",
					"implementation {",
					"\tconstant here = 1",
					"\tconstant used = thing::add(here)",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 2, '"./Main.es"')
			let result = applyEdits(source, fix.edits)

			expect(result.split("\n")[1]).toBe('\tfrom "./Other.es" { thing }')
			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		// A self-export forwards what the Module may publish, so the fix writes
		// the names bare rather than dropping its public surface. It is never
		// preferred, since what a Module publishes is a decision.
		it("should write a self-export's names as bare entries", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Main.es": [
					"implementation {",
					"\tconstant thing = 1",
					"}",
					"",
					"export {",
					'\tfrom "./Main.es" { thing }',
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 6, '"./Main.es"')

			expect(fix.diagnosticCode).toBe("self-import")
			expect(fix.title).toBe("Write 'thing' as a bare entry")
			expect(fix.isPreferred).toBe(false)

			let result = applyEdits(source, fix.edits)

			expect(result).toBe(
				[
					"implementation {",
					"\tconstant thing = 1",
					"}",
					"",
					"export {",
					"\tthing",
					"}",
					"",
				].join("\n"),
			)

			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		// And an `as` survives the edit. A bare entry renames the same way
		// a forwarded one does, so the Module goes on publishing the name it
		// published.
		it("should keep an 'as' when it writes a self-export bare", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Main.es": [
					"implementation {",
					"\tconstant thing = 1",
					"\tconstant other = 2",
					"}",
					"",
					"export {",
					'\tfrom "./Main.es" { thing as first other }',
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 7, '"./Main.es"')

			expect(fix.title).toBe("Write the names as bare entries")

			let result = applyEdits(source, fix.edits)

			expect(result).toContain("\tthing as first\n\tother\n")
			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		it("should write the relative specifier a package-shaped one meant", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Other.es": other,
				"Main.es": [
					"import {",
					'\tfrom "Other.es" { thing }',
					"}",
					"",
					"implementation {",
					"\tconstant used = thing",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 2, '"Other.es"')

			expect(fix.title).toBe("Write './Other.es'")
			expect(fix.diagnosticCode).toBe("invalid-module-specifier")
			// A guess at where the file sits, which the Help hedges, so the
			// reader applies it rather than the Editor.
			expect(fix.isPreferred).toBe(false)

			let result = applyEdits(source, fix.edits)

			expect(result.split("\n")[1]).toBe('\tfrom "./Other.es" { thing }')
			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		it("should write the extension a specifier left off", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Other.es": other,
				"Main.es": [
					"import {",
					'\tfrom "./Other" { thing }',
					"}",
					"",
					"implementation {",
					"\tconstant used = thing",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 2, '"./Other"')

			expect(fix.title).toBe("Write './Other.es'")
			expect(fix.isPreferred).toBe(true)

			let result = applyEdits(source, fix.edits)

			expect(result.split("\n")[1]).toBe('\tfrom "./Other.es" { thing }')
			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		// Some rejections sharing this code spell no concrete specifier, and
		// there is nothing to offer for those.
		it("should stay silent where the Diagnostic spells no specifier", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Main.es": [
					"import {",
					'\tfrom "./shapes/" { thing }',
					"}",
					"",
					"implementation {",
					"}",
					"",
				].join("\n"),
			})

			expect(
				fixesFor(workspace, pathOf("Main.es"), 2, '"./shapes/"'),
			).toEqual([])
		})

		it("should declare an exported Variable as a Constant", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Main.es": [
					"implementation {",
					"\tvariable counter = 1",
					"}",
					"",
					"export {",
					"\tcounter",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let [fix] = fixesFor(workspace, mainPath, 6, "counter")

			expect(fix.title).toBe("Declare 'counter' as a Constant")
			expect(fix.diagnosticCode).toBe("export-of-variable")
			// Every assignment to the Variable becomes a
			// `constant-reassignment` the moment this lands.
			expect(fix.isPreferred).toBe(false)

			let result = applyEdits(source, fix.edits)

			expect(result.split("\n")[1]).toBe("\tconstant counter = 1")
			expect(codesAfter(workspace, mainPath, result)).toEqual([])
		})

		// Withheld where something assigns to the Variable, or each assignment
		// becomes a `constant-reassignment` whose Help asks for the `variable`
		// back. The fix reads the Diagnostic's Help.
		it("should not offer the Constant where the Variable is assigned", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Main.es": [
					"implementation {",
					"\tvariable counter = 1",
					"",
					"\tfunction bump() -> Integer {",
					"\t\tcounter = counter::add(1)",
					"\t\t<- counter",
					"\t}",
					"}",
					"",
					"export {",
					"\tcounter",
					"}",
					"",
				].join("\n"),
			})

			expect(
				fixesFor(workspace, pathOf("Main.es"), 11, "counter").map(
					(fix) => fix.diagnosticCode,
				),
			).not.toContain("export-of-variable")
		})
	})

	// A Protocol from another Module, and the Types its requirements name,
	// arrive under the names the entries bind. The stubs use those or none.
	describe("Implement a Protocol another Module declares", () => {
		const sized = [
			"implementation {",
			"\tchoice Colour {",
			"\t\tRed,",
			"\t\tGreen,",
			"\t}",
			"",
			"\ttype Box = { count: Integer }",
			"",
			"\tprotocol Sized {",
			"\t\tcolour() -> Colour",
			"\t\tboxed() -> Box",
			"\t\tstatic smallest() -> Self",
			"\t}",
			"}",
			"",
			"export {",
			"\tBox",
			"\tColour",
			"\tSized",
			"}",
			"",
		].join("\n")

		function implementIn(
			entries: Array<string>,
			protocol: string,
			line: number,
			needle: string,
		): {
			source: string
			actions: Array<CodeActionEntry>
			workspace: Workspace
			mainPath: string
		} {
			let { workspace, pathOf } = makeWorkspace({
				"Sized.es": sized,
				"Main.es": [
					"import {",
					'\tfrom "./Sized.es" {',
					...entries.map((entry) => `\t\t${entry}`),
					"\t}",
					"}",
					"",
					"implementation {",
					"\ttype Bag = { count: Integer }",
					"",
					`\tnamespace Bags for Bag is ${protocol} {`,
					"\t}",
					"}",
					"",
				].join("\n"),
			})
			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let actions = findCodeActions(
				source,
				spanOf(source, line, needle),
				mainPath,
				workspace,
			).filter((action) => action.title.startsWith("Implement"))

			return { source, actions, workspace, mainPath }
		}

		function codesAfter(
			workspace: Workspace,
			filePath: string,
			text: string,
		): Array<common.DiagnosticCode> {
			return analyseDocument(text, filePath, {
				host: workspace.host,
			}).diagnostics.map((diagnostic) => diagnostic.code)
		}

		it("should implement an imported Protocol, as the Quick Fix and on the head", () => {
			let entries = ["Box", "Colour", "Sized"]

			for (let [needle, kind] of [
				["Sized {", "quickfix"],
				["namespace", "refactor.rewrite"],
			] as const) {
				let { source, actions, workspace, mainPath } = implementIn(
					entries,
					"Sized",
					12,
					needle,
				)

				expect(
					actions.map((action) => [action.kind, action.title]),
				).toEqual([[kind, "Implement 'Sized'"]])

				let result = applyEdits(source, actions[0]!.edits)

				expect(result.split("\n").slice(11, 18)).toEqual([
					"\tnamespace Bags for Bag is Sized {",
					"\t\tcolour() -> Colour {}",
					"",
					"\t\tboxed() -> Box {}",
					"",
					"\t\tstatic smallest() -> Bag {}",
					"\t}",
				])
				expect(
					new Set(codesAfter(workspace, mainPath, result)),
				).toEqual(new Set(["missing-return"]))
			}
		})

		it("should title and stub it in the names the file imports it under", () => {
			let { source, actions, workspace, mainPath } = implementIn(
				["Box as Crate", "Colour as Hue", "Sized as Measurable"],
				"Measurable",
				12,
				"namespace",
			)

			expect(actions.map((action) => action.title)).toEqual([
				"Implement 'Measurable'",
			])

			let result = applyEdits(source, actions[0]!.edits)

			expect(result.split("\n").slice(11, 18)).toEqual([
				"\tnamespace Bags for Bag is Measurable {",
				"\t\tcolour() -> Hue {}",
				"",
				"\t\tboxed() -> Crate {}",
				"",
				"\t\tstatic smallest() -> Bag {}",
				"\t}",
			])
			expect(new Set(codesAfter(workspace, mainPath, result))).toEqual(
				new Set(["missing-return"]),
			)
		})

		// A Record has a shape to write for a name the file does not bind. A
		// Choice has none, so an unimported one leaves no stub to write.
		it("should write a Record's shape and offer nothing for an unbound Choice", () => {
			let bound = implementIn(
				["Colour", "Sized"],
				"Sized",
				11,
				"namespace",
			)
			let result = applyEdits(bound.source, bound.actions[0]!.edits)

			expect(result.split("\n")[13]).toBe(
				"\t\tboxed() -> { count: Integer } {}",
			)

			expect(
				implementIn(["Sized"], "Sized", 10, "namespace").actions,
			).toEqual([])
		})

		// `Shown` provides a `describe` answering an Integer, and a stub
		// written as `Described` declares one answering a String, which the
		// conformance to `Shown` refuses.
		it("should offer no stub another conformance would refuse", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Described.es": [
					"implementation {",
					"\tprotocol Described {",
					"\t\tdescribe() -> String",
					"\t}",
					"}",
					"",
					"export {",
					"\tDescribed",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Described.es" { Described }',
					"}",
					"",
					"implementation {",
					"\tprotocol Shown {",
					"\t\tdescribe() -> Integer {",
					"\t\t\t<- 1",
					"\t\t}",
					"\t}",
					"",
					"\tnamespace IntegerBoth for Integer is Described, is Shown {",
					"\t}",
					"}",
					"",
				].join("\n"),
			})
			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""

			for (let needle of ["namespace", "Described,"]) {
				expect(
					findCodeActions(
						source,
						spanOf(source, 12, needle),
						mainPath,
						workspace,
					).map((action) => action.title),
				).not.toContain("Implement 'Described'")
			}
		})
	})

	// A Type the file imports under an alias is written under the alias. A
	// Choice has no shape to fall back on where it is not imported.
	describe("an annotation naming an imported Type", () => {
		it("should write the name the file imports the Type under", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Paint.es": [
					"implementation {",
					"\tchoice Colour {",
					"\t\tRed,",
					"\t\tGreen,",
					"\t}",
					"",
					"\ttype Box = { count: Integer }",
					"",
					"\tfunction paint() -> Colour {",
					"\t\t<- #Red",
					"\t}",
					"",
					"\tfunction box() -> Box {",
					"\t\t<- { count = 1 }",
					"\t}",
					"}",
					"",
					"export {",
					"\tBox",
					"\tColour",
					"\tbox",
					"\tpaint",
					"}",
					"",
				].join("\n"),
				"Main.es": [
					"import {",
					'\tfrom "./Paint.es" {',
					"\t\tBox as Crate",
					"\t\tColour as Hue",
					"\t\tbox",
					"\t\tpaint",
					"\t}",
					"}",
					"",
					"implementation {",
					"\tconstant hue = paint()",
					"\tconstant crate = box()",
					"",
					"\tTerminal.inspect(hue)",
					"\tTerminal.inspect(crate)",
					"}",
					"",
				].join("\n"),
			})
			let mainPath = pathOf("Main.es")
			let source = workspace.sourceOf(mainPath) ?? ""
			let annotated = (line: number, needle: string) => {
				let [action] = findCodeActions(
					source,
					spanOf(source, line, needle),
					mainPath,
					workspace,
				).filter((entry) =>
					entry.title.startsWith("Add explicit Type annotation"),
				)

				return applyEdits(source, action?.edits ?? []).split("\n")[
					line - 1
				]
			}

			expect(annotated(11, "hue")).toBe("\tconstant hue: Hue = paint()")
			expect(annotated(12, "crate")).toBe(
				"\tconstant crate: Crate = box()",
			)
		})
	})

	// A source action. Removing an entry nothing reads is unambiguous and keeps
	// the Program's meaning, as a bulk action must.
	describe("organizing imports", () => {
		const toolbox = [
			"implementation {",
			"",
			"\ttype Rectangle = { width: Integer, height: Integer }",
			"",
			"\tconstant ONE = 1",
			"",
			"\tconstant TWO = 2",
			"}",
			"",
			"export {",
			"\tRectangle",
			"\tONE",
			"\tTWO",
			"}",
			"",
		].join("\n")

		let organizeAction = (
			workspace: Workspace,
			filePath: string,
		): CodeActionEntry | undefined =>
			findCodeActions(
				workspace.sourceOf(filePath) ?? "",
				spanOf(workspace.sourceOf(filePath) ?? "", 1, "import"),
				filePath,
				workspace,
			).find((action) => action.kind === "source.organizeImports")

		it("should remove every unused entry of a group at once", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Toolbox.es": toolbox,
				"Main.es": [
					"import {",
					'\tfrom "./Toolbox.es" {',
					"\t\tRectangle",
					"\t\tONE",
					"\t\tTWO",
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
			let action = organizeAction(workspace, mainPath) as CodeActionEntry

			expect(action.title).toBe("Remove the unused imports")
			expect(action.diagnosticCode).toBeNull()
			expect(action.isPreferred).toBe(false)

			let result = applyEdits(
				workspace.sourceOf(mainPath) ?? "",
				action.edits,
			)

			expect(result).toBe(
				[
					"import {",
					'\tfrom "./Toolbox.es" {',
					"\t\tRectangle",
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
			)
			expect(
				analyseDocument(result, mainPath, {
					host: workspace.host,
				}).diagnostics.map((diagnostic) => diagnostic.code),
			).toEqual([])
		})

		// One deletion for the group rather than one per entry, since deletions
		// over the same lines would overlap.
		it("should take a group that empties with its last entry", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Toolbox.es": toolbox,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" {',
					"\t\tRectangle",
					"\t\tRectangleMeasurable",
					"\t}",
					'\tfrom "./Toolbox.es" { ONE }',
					"}",
					"",
					"implementation {",
					"\tconstant width = ONE",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let action = organizeAction(workspace, mainPath) as CodeActionEntry
			let result = applyEdits(
				workspace.sourceOf(mainPath) ?? "",
				action.edits,
			)

			expect(result).toBe(
				[
					"import {",
					'\tfrom "./Toolbox.es" { ONE }',
					"}",
					"",
					"implementation {",
					"\tconstant width = ONE",
					"}",
					"",
				].join("\n"),
			)
			expect(
				analyseDocument(result, mainPath, {
					host: workspace.host,
				}).diagnostics.map((diagnostic) => diagnostic.code),
			).toEqual([])
		})

		// Two unused entries on one line, beside a third that is read.
		// Whole-line deletions would take all three and overlap.
		it("should remove two unused entries written on one line", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Toolbox.es": toolbox,
				"Main.es": [
					"import {",
					'\tfrom "./Toolbox.es" { ONE TWO Rectangle }',
					"}",
					"",
					"implementation {",
					"\tconstant width = ONE",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let action = organizeAction(workspace, mainPath) as CodeActionEntry
			let result = applyEdits(
				workspace.sourceOf(mainPath) ?? "",
				action.edits,
			)

			expect(result).toBe(
				[
					"import {",
					'\tfrom "./Toolbox.es" { ONE }',
					"}",
					"",
					"implementation {",
					"\tconstant width = ONE",
					"}",
					"",
				].join("\n"),
			)
			expect(
				analyseDocument(result, mainPath, {
					host: workspace.host,
				}).diagnostics.map((diagnostic) => diagnostic.code),
			).toEqual([])
		})

		// Two whole groups on one line, whose deletions both reach the blanks
		// between them, are folded into one edit.
		it("should remove two unused groups written on one line", () => {
			let { workspace, pathOf } = makeWorkspace({
				"Geometry.es": geometry,
				"Toolbox.es": toolbox,
				"Main.es": [
					"import {",
					'\tfrom "./Geometry.es" { Rectangle } from "./Toolbox.es" { TWO }',
					"}",
					"",
					"implementation {",
					"\tconstant width = 1",
					"}",
					"",
				].join("\n"),
			})

			let mainPath = pathOf("Main.es")
			let action = organizeAction(workspace, mainPath) as CodeActionEntry
			let result = applyEdits(
				workspace.sourceOf(mainPath) ?? "",
				action.edits,
			)

			expect(result).toBe(
				[
					"import {",
					"}",
					"",
					"implementation {",
					"\tconstant width = 1",
					"}",
					"",
				].join("\n"),
			)
			expect(
				analyseDocument(result, mainPath, {
					host: workspace.host,
				}).diagnostics.map((diagnostic) => diagnostic.code),
			).toEqual([])
		})

		it("should offer nothing where every entry is read", () => {
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

			expect(organizeAction(workspace, pathOf("Main.es"))).toBeUndefined()
		})
	})

	// The fixes whose edit lands in another file. Each is checked on the text
	// of both files, then by analysing the workspace again with the result
	// written back.
	describe("cross-Module actions", () => {
		function actionsFor(
			workspace: Workspace,
			filePath: string,
			line: number,
			needle: string,
		): Array<CodeActionEntry> {
			let source = workspace.sourceOf(filePath) ?? ""

			return findCodeActions(
				source,
				spanOf(source, line, needle),
				filePath,
				workspace,
			)
		}

		// The buffers once the action is applied, keyed by the file each edit
		// named.
		function appliedAcross(
			workspace: Workspace,
			documentPath: string,
			entry: CodeActionEntry,
		): Record<string, string> {
			let byFile = new Map<string, Array<CodeActionEdit>>()

			for (let edit of entry.edits) {
				let filePath = edit.filePath ?? documentPath
				let edits = byFile.get(filePath)

				if (edits === undefined) {
					edits = []
					byFile.set(filePath, edits)
				}

				edits.push(edit)
			}

			let result: Record<string, string> = {}

			for (let [filePath, edits] of byFile) {
				result[filePath] = applyEdits(
					workspace.sourceOf(filePath) ?? "",
					edits,
				)
			}

			return result
		}

		// The workspace with the action's result written back and analysed
		// again, every file it touched, since a Diagnostic may move to another
		// Module.
		function codesAfter(
			workspace: Workspace,
			texts: Record<string, string>,
			filePath: string,
		): Array<common.DiagnosticCode> {
			for (let [written, text] of Object.entries(texts)) {
				writeFileSync(written, text)
				workspace.changed(written)
			}

			return analyseDocument(
				workspace.sourceOf(filePath) ?? "",
				filePath,
				{ host: workspace.host },
			).diagnostics.map((diagnostic) => diagnostic.code)
		}

		describe("not-exported", () => {
			it("should write the name into the export block of the Module that declares it", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tconstant hidden = 1",
						"}",
						"",
					].join("\n"),
					"Main.es": [
						"import {",
						'\tfrom "./A.es" { hidden }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(hidden::toString())",
						"}",
						"",
					].join("\n"),
				})

				let mainPath = pathOf("Main.es")
				let [fix] = actionsFor(workspace, mainPath, 2, "hidden")

				expect(fix?.title).toBe("Export 'hidden' from ./A.es")
				expect(fix?.diagnosticCode).toBe("not-exported")
				expect(fix?.isPreferred).toBe(true)
				expect(fix?.edits[0]?.filePath).toBe(pathOf("A.es"))

				let texts = appliedAcross(workspace, mainPath, fix)

				expect(texts[pathOf("A.es")]).toBe(
					[
						"implementation {",
						"\tconstant hidden = 1",
						"}",
						"",
						"export {",
						"\thidden",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[mainPath]).toBeUndefined()
				expect(codesAfter(workspace, texts, mainPath)).toEqual([])
			})

			it("should add the name among the ones the block already publishes", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tconstant alpha = 1",
						"\tconstant middle = 2",
						"\tconstant zulu = 3",
						"}",
						"",
						"export {",
						"\talpha",
						"\tzulu",
						"}",
						"",
					].join("\n"),
					"Main.es": [
						"import {",
						'\tfrom "./A.es" { middle }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(middle::toString())",
						"}",
						"",
					].join("\n"),
				})

				let mainPath = pathOf("Main.es")
				let [fix] = actionsFor(workspace, mainPath, 2, "middle")
				let texts = appliedAcross(workspace, mainPath, fix)

				expect(texts[pathOf("A.es")]?.split("\n").slice(6, 11)).toEqual(
					["export {", "\talpha", "\tmiddle", "\tzulu", "}"],
				)
				expect(codesAfter(workspace, texts, mainPath)).toEqual([])
			})

			// A re-export asks another Module for a name exactly as an
			// import does, and is answered here exactly as one.
			it("should answer a re-export of a private name too", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tconstant hidden = 1",
						"}",
						"",
					].join("\n"),
					"Shapes.es": [
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./A.es" { hidden }',
						"}",
						"",
					].join("\n"),
				})

				let shapesPath = pathOf("Shapes.es")
				let [fix] = actionsFor(workspace, shapesPath, 5, "hidden")

				expect(fix?.title).toBe("Export 'hidden' from ./A.es")

				let texts = appliedAcross(workspace, shapesPath, fix)

				expect(texts[pathOf("A.es")]).toBe(
					[
						"implementation {",
						"\tconstant hidden = 1",
						"}",
						"",
						"export {",
						"\thidden",
						"}",
						"",
					].join("\n"),
				)
				expect(codesAfter(workspace, texts, shapesPath)).toEqual([])
			})

			// A Variable is the one declaration an export block may not
			// list, so publishing it would answer this Diagnostic with
			// `export-of-variable` in the other file.
			it("should offer nothing for a Variable", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tvariable counter = 0",
						"}",
						"",
					].join("\n"),
					"Main.es": [
						"import {",
						'\tfrom "./A.es" { counter }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(counter::toString())",
						"}",
						"",
					].join("\n"),
				})

				expect(
					actionsFor(workspace, pathOf("Main.es"), 2, "counter").map(
						(action) => action.title,
					),
				).toEqual([])
			})
		})

		describe("export-of-unknown-name", () => {
			it("should rewrite the entry as a group of the Module that declares the name", () => {
				let { workspace, pathOf } = makeWorkspace({
					"Geometry.es": geometry,
					"Shapes.es": [
						"implementation {",
						"}",
						"",
						"export {",
						"\tRectangle",
						"}",
						"",
					].join("\n"),
				})

				let shapesPath = pathOf("Shapes.es")
				let [fix] = actionsFor(workspace, shapesPath, 5, "Rectangle")

				expect(fix?.title).toBe(
					"Forward 'Rectangle' from ./Geometry.es",
				)
				expect(fix?.diagnosticCode).toBe("export-of-unknown-name")
				expect(fix?.isPreferred).toBe(true)

				let texts = appliedAcross(workspace, shapesPath, fix)

				expect(texts[shapesPath]).toBe(
					[
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./Geometry.es" { Rectangle }',
						"}",
						"",
					].join("\n"),
				)
				expect(codesAfter(workspace, texts, shapesPath)).toEqual([])
			})

			it("should join the group already written for that Module", () => {
				let { workspace, pathOf } = makeWorkspace({
					"Geometry.es": geometry,
					"Shapes.es": [
						"implementation {",
						"}",
						"",
						"export {",
						"\tRectangle",
						'\tfrom "./Geometry.es" { RectangleMeasurable }',
						"}",
						"",
					].join("\n"),
				})

				let shapesPath = pathOf("Shapes.es")
				let [fix] = actionsFor(workspace, shapesPath, 5, "Rectangle")
				let texts = appliedAcross(workspace, shapesPath, fix)

				expect(texts[shapesPath]).toBe(
					[
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./Geometry.es" {',
						"\t\tRectangle",
						"\t\tRectangleMeasurable",
						"\t}",
						"}",
						"",
					].join("\n"),
				)
				expect(codesAfter(workspace, texts, shapesPath)).toEqual([])
			})

			// What the block publishes must not change under a fix that only
			// answers where the name comes from.
			it("should keep the 'as' the entry was written with", () => {
				let { workspace, pathOf } = makeWorkspace({
					"Geometry.es": geometry,
					"Shapes.es": [
						"implementation {",
						"}",
						"",
						"export {",
						"\tRectangle as Rect",
						"}",
						"",
					].join("\n"),
				})

				let shapesPath = pathOf("Shapes.es")
				let [fix] = actionsFor(workspace, shapesPath, 5, "Rectangle")
				let texts = appliedAcross(workspace, shapesPath, fix)

				expect(texts[shapesPath]?.split("\n")[4]).toBe(
					'\tfrom "./Geometry.es" { Rectangle as Rect }',
				)
				expect(codesAfter(workspace, texts, shapesPath)).toEqual([])
			})

			// Two Modules may publish one name, a facade and the Module behind
			// it, and the block does not say which it meant.
			it("should offer one action per Module publishing the name, none preferred", () => {
				let { workspace, pathOf } = makeWorkspace({
					"Geometry.es": geometry,
					"Facade.es": [
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./Geometry.es" { Rectangle }',
						"}",
						"",
					].join("\n"),
					"Shapes.es": [
						"implementation {",
						"}",
						"",
						"export {",
						"\tRectangle",
						"}",
						"",
					].join("\n"),
				})

				let actions = actionsFor(
					workspace,
					pathOf("Shapes.es"),
					5,
					"Rectangle",
				)

				expect(actions.map((action) => action.title).sort()).toEqual([
					"Forward 'Rectangle' from ./Facade.es",
					"Forward 'Rectangle' from ./Geometry.es",
				])
				expect(
					actions.every((action) => action.isPreferred === false),
				).toBe(true)
			})

			it("should offer nothing for a name no other Module publishes", () => {
				let { workspace, pathOf } = makeWorkspace({
					"Shapes.es": [
						"implementation {",
						"}",
						"",
						"export {",
						"\tnowhere",
						"}",
						"",
					].join("\n"),
				})

				expect(
					actionsFor(workspace, pathOf("Shapes.es"), 5, "nowhere"),
				).toEqual([])
			})
		})

		// A move touches the Module the Declaration leaves, the one it lands in,
		// and one that named it in an entry. Each spec checks all three texts and
		// analyses them.
		describe("moving a Declaration to another Module", () => {
			const declaring = [
				"implementation {",
				"\tfunction double(_ value: Integer) -> Integer {",
				"\t\t<- value::multiply(with 2)",
				"\t}",
				"}",
				"",
				"export {",
				"\tdouble",
				"}",
				"",
			].join("\n")

			const target = [
				"implementation {",
				"\tconstant one = 1",
				"}",
				"",
				"export {",
				"\tone",
				"}",
				"",
			].join("\n")

			const dependent = [
				"import {",
				'\tfrom "./A.es" { double }',
				"}",
				"",
				"implementation {",
				"\tTerminal.inspect(double(2)::toString())",
				"}",
				"",
			].join("\n")

			function moves(
				workspace: Workspace,
				filePath: string,
				line: number,
				needle: string,
			): Array<CodeActionEntry> {
				return actionsFor(workspace, filePath, line, needle).filter(
					(action) => action.kind === "refactor.move",
				)
			}

			function moveTo(
				workspace: Workspace,
				filePath: string,
				line: number,
				needle: string,
				title: string,
			): CodeActionEntry {
				let found = moves(workspace, filePath, line, needle).find(
					(action) => action.title === title,
				)

				expect(found).toBeDefined()

				return found as CodeActionEntry
			}

			it("should carry the Declaration, what publishes it and every entry naming it", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": declaring,
					"B.es": target,
					"Main.es": dependent,
				})

				let declaringPath = pathOf("A.es")
				let actions = moves(workspace, declaringPath, 2, "double")

				// Every `.es` file beside the document, in path order,
				// and the Module this would write last of all.
				expect(actions.map((action) => action.title)).toEqual([
					"Move 'double' to ./B.es",
					"Move 'double' to ./Main.es",
					"Move 'double' to a new Module",
				])

				let move = actions[0] as CodeActionEntry

				expect(move.isPreferred).toBe(false)
				expect(move.diagnosticCode).toBeNull()

				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					["implementation {", "}", ""].join("\n"),
				)
				expect(texts[pathOf("B.es")]).toBe(
					[
						"implementation {",
						"\tconstant one = 1",
						"",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble",
						"\tone",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[pathOf("Main.es")]).toBe(
					[
						"import {",
						'\tfrom "./B.es" { double }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(double(2)::toString())",
						"}",
						"",
					].join("\n"),
				)

				expect(codesAfter(workspace, texts, pathOf("Main.es"))).toEqual(
					[],
				)
			})

			// An importer names the Declaration by the name it is published
			// under, which the landing Module publishes it under too.
			it("should carry an `as` the Declaration is published under", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": declaring.replace(
						"\tdouble\n",
						"\tdouble as twice\n",
					),
					"B.es": target,
					"Main.es": [
						"import {",
						'\tfrom "./A.es" { twice }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(twice(2)::toString())",
						"}",
						"",
					].join("\n"),
					"Other.es": [
						"import {",
						'\tfrom "./A.es" { twice as doubled }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(doubled(2)::toString())",
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					2,
					"double",
					"Move 'double' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					["implementation {", "}", ""].join("\n"),
				)
				expect(texts[pathOf("B.es")]).toBe(
					[
						"implementation {",
						"\tconstant one = 1",
						"",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble as twice",
						"\tone",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[pathOf("Main.es")]).toBe(
					[
						"import {",
						'\tfrom "./B.es" { twice }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(twice(2)::toString())",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[pathOf("Other.es")]).toBe(
					[
						"import {",
						'\tfrom "./B.es" { twice as doubled }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(doubled(2)::toString())",
						"}",
						"",
					].join("\n"),
				)

				for (let name of ["B.es", "Main.es", "Other.es"]) {
					expect(codesAfter(workspace, texts, pathOf(name))).toEqual(
						[],
					)
				}
			})

			// A group of only this name would otherwise be pointed at the
			// landing Module beside a group that names it already.
			it("should join an entry to the group already naming the landing Module", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": declaring,
					"B.es": target,
					"Main.es": [
						"import {",
						'\tfrom "./A.es" { double as twice }',
						'\tfrom "./B.es" { one }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(twice(one)::toString())",
						"}",
						"",
					].join("\n"),
					"Forward.es": [
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./A.es" { double }',
						'\tfrom "./B.es" { one }',
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					2,
					"double",
					"Move 'double' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("Main.es")]).toBe(
					[
						"import {",
						'\tfrom "./B.es" {',
						"\t\tdouble as twice",
						"\t\tone",
						"\t}",
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(twice(one)::toString())",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[pathOf("Forward.es")]).toBe(
					[
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./B.es" {',
						"\t\tdouble",
						"\t\tone",
						"\t}",
						"}",
						"",
					].join("\n"),
				)

				for (let name of ["B.es", "Main.es", "Forward.es"]) {
					expect(codesAfter(workspace, texts, pathOf(name))).toEqual(
						[],
					)
				}
			})

			// The Comments written inside the group go with the entry. One
			// written after the group stays where it was.
			it("should keep the Comments of a group it joins to another", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": declaring,
					"B.es": target,
					"Main.es": [
						"import {",
						'\tfrom "./A.es" {',
						"\t\t§ keep this note",
						"\t\tdouble",
						"\t}",
						'\tfrom "./B.es" { one }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(double(one)::toString())",
						"}",
						"",
					].join("\n"),
					"Trailing.es": [
						"import {",
						'\tfrom "./A.es" { double } § trailing',
						'\tfrom "./B.es" { one }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(double(one)::toString())",
						"}",
						"",
					].join("\n"),
					"Forward.es": [
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./A.es" { double § forwarded',
						"\t}",
						'\tfrom "./B.es" {',
						"\t\tone",
						"\t}",
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					2,
					"double",
					"Move 'double' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("Main.es")]).toBe(
					[
						"import {",
						'\tfrom "./B.es" {',
						"\t\t§ keep this note",
						"\t\tdouble",
						"\t\tone",
						"\t}",
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(double(one)::toString())",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[pathOf("Trailing.es")]).toBe(
					[
						"import {",
						"\t§ trailing",
						'\tfrom "./B.es" {',
						"\t\tdouble",
						"\t\tone",
						"\t}",
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(double(one)::toString())",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[pathOf("Forward.es")]).toBe(
					[
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./B.es" {',
						"\t\t§ forwarded",
						"\t\tdouble",
						"\t\tone",
						"\t}",
						"}",
						"",
					].join("\n"),
				)

				for (let name of [
					"B.es",
					"Main.es",
					"Trailing.es",
					"Forward.es",
				]) {
					expect(codesAfter(workspace, texts, pathOf(name))).toEqual(
						[],
					)
				}
			})

			it("should import a Declaration published under an `as` back by that name", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"",
						"\tfunction quadruple(_ value: Integer) -> Integer {",
						"\t\t<- double(double(value))",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble as twice",
						"\tquadruple",
						"}",
						"",
					].join("\n"),
					"B.es": target,
					"Main.es": [
						"import {",
						'\tfrom "./A.es" { quadruple twice }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(quadruple(twice(1))::toString())",
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					2,
					"double",
					"Move 'double' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					[
						"import {",
						'\tfrom "./B.es" { twice as double }',
						"}",
						"",
						"implementation {",
						"\tfunction quadruple(_ value: Integer) -> Integer {",
						"\t\t<- double(double(value))",
						"\t}",
						"}",
						"",
						"export {",
						"\tquadruple",
						"}",
						"",
					].join("\n"),
				)
				// The shared group loses the entry, which joins a group for the
				// landing Module under the published name.
				expect(texts[pathOf("Main.es")]).toBe(
					[
						"import {",
						'\tfrom "./A.es" { quadruple }',
						'\tfrom "./B.es" { twice }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(quadruple(twice(1))::toString())",
						"}",
						"",
					].join("\n"),
				)

				for (let name of ["A.es", "B.es", "Main.es"]) {
					expect(codesAfter(workspace, texts, pathOf(name))).toEqual(
						[],
					)
				}
			})

			// Its entry there goes, and the reads of its local name with it.
			it("should not move a Declaration into a Module that imports it under another name", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": declaring.replace(
						"\tdouble\n",
						"\tdouble as twice\n",
					),
					"B.es": [
						"import {",
						'\tfrom "./A.es" { twice }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(twice(2)::toString())",
						"}",
						"",
					].join("\n"),
				})

				expect(
					moves(workspace, pathOf("A.es"), 2, "double").map(
						(action) => action.title,
					),
				).toEqual(["Move 'double' to a new Module"])
			})

			// B's own `twice` would answer every importer of A's.
			it("should not move a Declaration into a Module that already publishes its `as`", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": declaring.replace(
						"\tdouble\n",
						"\tdouble as twice\n",
					),
					"B.es": [
						"implementation {",
						"\tfunction twice(_ n: Integer) -> Integer {",
						"\t\t<- n::add(1)",
						"\t}",
						"}",
						"",
						"export {",
						"\ttwice",
						"}",
						"",
					].join("\n"),
				})

				expect(
					moves(workspace, pathOf("A.es"), 2, "double").map(
						(action) => action.title,
					),
				).toEqual(["Move 'double' to a new Module"])
			})

			// A file the action writes, which the Server turns into a resource
			// operation.
			it("should offer a Module named after the Declaration", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": declaring,
					"Main.es": dependent,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					2,
					"double",
					"Move 'double' to a new Module",
				)
				let written = move.edits.find(
					(edit) => edit.createFile === true,
				)

				expect(written?.filePath).toBe(pathOf("double.es"))
				expect(written?.range).toEqual({
					start: { line: 1, column: 1 },
					end: { line: 1, column: 1 },
				})
				expect(written?.newText).toBe(
					[
						"implementation {",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble",
						"}",
						"",
					].join("\n"),
				)
			})

			// Moving a helper into the Module that reads it drops that Module's
			// entry, since a Module does not import what it declares.
			it("should drop the entry of the Module it lands in", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble",
						"}",
						"",
					].join("\n"),
					"Main.es": dependent,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					2,
					"double",
					"Move 'double' to ./Main.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("Main.es")]).toBe(
					[
						"implementation {",
						"\tTerminal.inspect(double(2)::toString())",
						"",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[declaringPath]).toBe(
					["implementation {", "}", ""].join("\n"),
				)
				expect(codesAfter(workspace, texts, pathOf("Main.es"))).toEqual(
					[],
				)
			})

			// The Module it leaves imports it back, and the one it lands in
			// publishes it, though nothing published it before.
			it("should import the Declaration back where this Module still reads it", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"",
						"\tTerminal.inspect(double(2)::toString())",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					2,
					"double",
					"Move 'double' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					[
						"import {",
						'\tfrom "./B.es" { double }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(double(2)::toString())",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[pathOf("B.es")]).toBe(
					[
						"implementation {",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble",
						"}",
						"",
					].join("\n"),
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
			})

			// A name the Statement reads is declared where it stands. Where it
			// lands the name is an import, which the move writes.
			it("should import what the Declaration reads into the Module it lands in", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tconstant STEP = 2",
						"",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::multiply(with STEP)",
						"\t}",
						"}",
						"",
						"export {",
						"\tSTEP",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					4,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("B.es")]).toBe(
					[
						"import {",
						'\tfrom "./A.es" { STEP }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::multiply(with STEP)",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
				)
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			const helping = [
				"implementation {",
				"\tfunction helper(_ n: Integer) -> Integer {",
				"\t\t<- n::add(1)",
				"\t}",
				"}",
				"",
				"export {",
				"\thelper",
				"}",
				"",
			].join("\n")

			// The import goes with the Statement, and this Module drops it once
			// nothing here reads it.
			it("should carry an import the Declaration reads to the Module it lands in", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { helper }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- helper(n)",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": target,
					"C.es": helping,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					["implementation {", "}", ""].join("\n"),
				)
				expect(texts[pathOf("B.es")]).toBe(
					[
						"import {",
						'\tfrom "./C.es" { helper }',
						"}",
						"",
						"implementation {",
						"\tconstant one = 1",
						"",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- helper(n)",
						"\t}",
						"}",
						"",
						"export {",
						"\tone",
						"\trun",
						"}",
						"",
					].join("\n"),
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// The entry travels under the name the Statement reads it by, and
			// stays here while another Statement reads it too.
			it("should carry an aliased import and keep one this Module still reads", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { helper as bump }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- bump(n)",
						"\t}",
						"",
						"\tconstant once = bump(1)",
						"}",
						"",
						"export {",
						"\tonce",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
					"C.es": helping,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					[
						"import {",
						'\tfrom "./C.es" { helper as bump }',
						"}",
						"",
						"implementation {",
						"\tconstant once = bump(1)",
						"}",
						"",
						"export {",
						"\tonce",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[pathOf("B.es")]).toBe(
					[
						"import {",
						'\tfrom "./C.es" { helper as bump }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- bump(n)",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// The Module the name comes from declares it, so it imports nothing.
			// This Module's entry for the name it no longer reads becomes the
			// entry that imports the Declaration back.
			it("should move a Declaration into the Module it imports from", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { helper }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- helper(n)",
						"\t}",
						"",
						"\tconstant once = run(1)",
						"}",
						"",
						"export {",
						"\tonce",
						"}",
						"",
					].join("\n"),
					"C.es": helping,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"run",
					"Move 'run' to ./C.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					[
						"import {",
						'\tfrom "./C.es" { run }',
						"}",
						"",
						"implementation {",
						"\tconstant once = run(1)",
						"}",
						"",
						"export {",
						"\tonce",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[pathOf("C.es")]).toBe(
					[
						"implementation {",
						"\tfunction helper(_ n: Integer) -> Integer {",
						"\t\t<- n::add(1)",
						"\t}",
						"",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- helper(n)",
						"\t}",
						"}",
						"",
						"export {",
						"\thelper",
						"\trun",
						"}",
						"",
					].join("\n"),
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("C.es"))).toEqual([])
			})

			// A call dispatching into an imported Namespace needs that
			// Namespace in reach, though no name of it is written.
			it("should carry the import of a Namespace a call dispatches to", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { IntegerExtras }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::doubled()",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
					"C.es": [
						"implementation {",
						"\tnamespace IntegerExtras for Integer {",
						"\t\tdoubled() -> Integer {",
						"\t\t\t<- @::multiply(with 2)",
						"\t\t}",
						"\t}",
						"}",
						"",
						"export {",
						"\tIntegerExtras",
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					["implementation {", "}", ""].join("\n"),
				)
				expect(texts[pathOf("B.es")]?.split("\n")[1]).toBe(
					'\tfrom "./C.es" { IntegerExtras }',
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// The Module it lands in drops its entry for the Declaration and
			// gains one for `STEP` in the same group. The one replaces the other.
			it("should import what the Declaration reads in place of the entry that named it", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tconstant STEP = 2",
						"",
						"\tfunction double(_ n: Integer) -> Integer {",
						"\t\t<- n::multiply(with STEP)",
						"\t}",
						"}",
						"",
						"export {",
						"\tSTEP",
						"\tdouble",
						"}",
						"",
					].join("\n"),
					"Main.es": dependent,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					4,
					"double",
					"Move 'double' to ./Main.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("Main.es")]).toBe(
					[
						"import {",
						'\tfrom "./A.es" { STEP }',
						"}",
						"",
						"implementation {",
						"\tTerminal.inspect(double(2)::toString())",
						"",
						"\tfunction double(_ n: Integer) -> Integer {",
						"\t\t<- n::multiply(with STEP)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble",
						"}",
						"",
					].join("\n"),
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("Main.es"))).toEqual(
					[],
				)
			})

			const sizing = [
				"implementation {",
				"\tprotocol Sized {",
				"\t\tsize() -> Integer",
				"",
				"\t\ttwice() -> Integer {",
				"\t\t\t<- @::size()::multiply(with 2)",
				"\t\t}",
				"\t}",
				"",
				"\ttype BoxValue = { n: Integer }",
				"",
				"\tnamespace Box for BoxValue is Sized {",
				"\t\tstatic of(_ n: Integer) -> BoxValue {",
				"\t\t\t<- { n }",
				"\t\t}",
				"",
				"\t\tsize() -> Integer {",
				"\t\t\t<- @.n",
				"\t\t}",
				"\t}",
				"}",
				"",
				"export {",
				"\tBox",
				"\tBoxValue",
				"\tSized",
				"}",
				"",
			].join("\n")

			const suits = [
				"implementation {",
				"\tchoice Suit { Hearts, Spades }",
				"",
				"\tfunction paint(_ suit: Suit) -> String {",
				"\t\t<- match suit -> String {",
				'\t\t\tcase #Hearts { <- "red" }',
				'\t\t\tcase #Spades { <- "black" }',
				"\t\t}",
				"\t}",
				"}",
				"",
				"export {",
				"\tSuit",
				"\tpaint",
				"}",
				"",
			].join("\n")

			// `twice` is answered by the body `Sized` provides, which needs
			// `Sized` in scope though the call never writes it.
			it("should carry the Protocol whose provided Method the Declaration calls", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { Box Sized }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- Box.of(n)::twice()",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
					"C.es": sizing,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					["implementation {", "}", ""].join("\n"),
				)
				expect(texts[pathOf("B.es")]?.split("\n")[1]).toBe(
					'\tfrom "./C.es" { Box Sized }',
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			it("should keep an import whose Protocol a provided Method here still calls", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { Box Sized }',
						"}",
						"",
						"implementation {",
						"\tfunction measured<infer Item is Sized>(_ item: Item) -> Integer {",
						"\t\t<- item::size()",
						"\t}",
						"",
						"\tconstant once = Box.of(2)::twice()",
						"}",
						"",
						"export {",
						"\tmeasured",
						"\tonce",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
					"C.es": sizing,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"measured",
					"Move 'measured' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]?.split("\n")[1]).toBe(
					'\tfrom "./C.es" { Box Sized }',
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// A bare Case resolves through the Choices in Scope, so the Choice
			// moves with the Declaration that writes it.
			it("should carry the Choice a bare Case in the Declaration resolves through", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { Suit paint }',
						"}",
						"",
						"implementation {",
						"\tfunction favourite() -> String {",
						"\t\tconstant chosen = #Hearts",
						"",
						"\t\t<- paint(chosen)",
						"\t}",
						"}",
						"",
						"export {",
						"\tfavourite",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
					"C.es": suits,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"favourite",
					"Move 'favourite' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("B.es")]?.split("\n")[1]).toBe(
					'\tfrom "./C.es" { Suit paint }',
				)
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// `is` on a Case is derived, which needs the Choice in scope though
			// the call never writes it.
			it("should carry the Choice a derived Method in the Declaration needs", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { Suit pick }',
						"}",
						"",
						"implementation {",
						"\tfunction check() -> Boolean {",
						"\t\t<- pick()::is(pick())",
						"\t}",
						"",
						"\tconstant favourite: Suit = #Hearts",
						"}",
						"",
						"export {",
						"\tcheck",
						"\tfavourite",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
					"C.es": [
						"implementation {",
						"\tchoice Suit { Hearts, Spades }",
						"",
						"\tfunction pick() -> Suit {",
						"\t\t<- Suit#Spades",
						"\t}",
						"}",
						"",
						"export {",
						"\tSuit",
						"\tpick",
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"check",
					"Move 'check' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("B.es")]?.split("\n")[1]).toBe(
					'\tfrom "./C.es" { Suit pick }',
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// Derived printing also needs the Namespace that states the Choice
			// `is Printable`, though the call names neither.
			it("should carry the Namespace that makes a Choice printable", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { Suit SuitShow pick }',
						"}",
						"",
						"implementation {",
						"\tfunction shown() -> String {",
						"\t\t<- pick()::toString()",
						"\t}",
						"",
						"\tconstant favourite: Suit = #Hearts",
						"}",
						"",
						"export {",
						"\tfavourite",
						"\tshown",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
					"C.es": [
						"implementation {",
						"\tchoice Suit { Hearts, Spades }",
						"",
						"\tnamespace SuitShow for Suit is Printable {",
						"\t}",
						"",
						"\tfunction pick() -> Suit {",
						"\t\t<- Suit#Spades",
						"\t}",
						"}",
						"",
						"export {",
						"\tSuit",
						"\tSuitShow",
						"\tpick",
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"shown",
					"Move 'shown' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("B.es")]?.split("\n")[1]).toBe(
					'\tfrom "./C.es" { Suit SuitShow pick }',
				)
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// The bare `#Hearts` left behind still resolves through `Suit`.
			it("should keep an import of a Choice this Module reaches through a bare Case", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { Suit paint }',
						"}",
						"",
						"implementation {",
						"\tfunction isRed(_ suit: Suit) -> Boolean {",
						"\t\t<- suit::is(Suit#Hearts)",
						"\t}",
						"",
						"\tconstant chosen = #Hearts",
						"\tconstant painted = paint(chosen)",
						"}",
						"",
						"export {",
						"\tisRed",
						"\tpainted",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
					"C.es": suits,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"isRed",
					"Move 'isRed' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]?.split("\n")[1]).toBe(
					'\tfrom "./C.es" { Suit paint }',
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			const extras = [
				"implementation {",
				"\tnamespace IntegerExtras for Integer {",
				"\t\tstatic seed() -> Integer {",
				"\t\t\t<- 10",
				"\t\t}",
				"",
				"\t\tdoubled() -> Integer {",
				"\t\t\t<- @::multiply(with 2)",
				"\t\t}",
				"\t}",
				"}",
				"",
				"export {",
				"\tIntegerExtras",
				"}",
				"",
			].join("\n")

			// `F.es` forwards the very Namespace the Statement dispatches
			// through, so the entry for it already serves.
			it("should dispatch through a Namespace the Module it lands in reaches through a forwarding Module", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { IntegerExtras }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::doubled()",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": [
						"import {",
						'\tfrom "./F.es" { IntegerExtras }',
						"}",
						"",
						"implementation {",
						"\tconstant once = 1::doubled()",
						"}",
						"",
						"export {",
						"\tonce",
						"}",
						"",
					].join("\n"),
					"C.es": extras,
					"F.es": [
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./C.es" { IntegerExtras }',
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("B.es")]?.split("\n").slice(0, 3)).toEqual([
					"import {",
					'\tfrom "./F.es" { IntegerExtras }',
					"}",
				])
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// A second entry for one Namespace would make every call through it
			// ambiguous, its own Module's included.
			it("should dispatch through a Namespace the Module it lands in imports under another name", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { IntegerExtras }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::doubled()",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": [
						"import {",
						'\tfrom "./C.es" { IntegerExtras as Extras }',
						"}",
						"",
						"implementation {",
						"\tconstant once = 1::doubled()",
						"}",
						"",
						"export {",
						"\tonce",
						"}",
						"",
					].join("\n"),
					"C.es": extras,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("B.es")]?.split("\n")[1]).toBe(
					'\tfrom "./C.es" { IntegerExtras as Extras }',
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// The Statement writes `Extras`, which `B.es` and `C.es` both bind
			// to the Namespace under another name.
			it("should not offer a Module that binds a Namespace the Declaration names under another name", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { IntegerExtras as Extras }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- Extras.seed()::add(n)",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": [
						"import {",
						'\tfrom "./C.es" { IntegerExtras }',
						"}",
						"",
						"implementation {",
						"\tconstant once = 1::doubled()",
						"}",
						"",
						"export {",
						"\tonce",
						"}",
						"",
					].join("\n"),
					"C.es": extras,
				})

				expect(
					moves(workspace, pathOf("A.es"), 6, "run").map(
						(action) => action.title,
					),
				).toEqual(["Move 'run' to a new Module"])
			})

			// `B.es` and `E.es` reach `OtherExtras`, whose `doubled` would answer
			// the moved call or make it, and `B.es`'s own, ambiguous.
			it("should not offer a Module whose Namespaces declare a Method the Declaration calls", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { IntegerExtras }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::doubled()",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": [
						"import {",
						'\tfrom "./E.es" { OtherExtras }',
						"}",
						"",
						"implementation {",
						"\tconstant once = 1::doubled()",
						"}",
						"",
						"export {",
						"\tonce",
						"}",
						"",
					].join("\n"),
					"C.es": extras,
					"E.es": [
						"implementation {",
						"\tnamespace OtherExtras for Integer {",
						"\t\tdoubled() -> Integer {",
						"\t\t\t<- @::multiply(with 3)",
						"\t\t}",
						"\t}",
						"}",
						"",
						"export {",
						"\tOtherExtras",
						"}",
						"",
					].join("\n"),
				})

				expect(
					moves(workspace, pathOf("A.es"), 6, "run").map(
						(action) => action.title,
					),
				).toEqual([
					"Move 'run' to ./C.es",
					"Move 'run' to a new Module",
				])
			})

			// `Money`'s `add` answers for `Money` values only, so it can not
			// answer the `Integer` the Statement adds to.
			it("should offer a Module whose Namespace declares the Method for another receiver", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tfunction bump(_ n: Integer) -> Integer {",
						"\t\t<- n::add(1)",
						"\t}",
						"}",
						"",
						"export {",
						"\tbump",
						"}",
						"",
					].join("\n"),
					"B.es": [
						"implementation {",
						"\ttype Money = { cents: Integer }",
						"",
						"\tnamespace Money for Money {",
						"\t\tadd(_ other: Money) -> Money {",
						"\t\t\t<- { cents = @.cents::add(other.cents) }",
						"\t\t}",
						"\t}",
						"}",
						"",
						"export {",
						"\tMoney",
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					2,
					"bump",
					"Move 'bump' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// A Function bound twice is no ambiguity, so the name the
			// Statement writes joins the one already there.
			it("should write a second entry for a Function the Module it lands in imports under another name", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { helper }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- helper(n)",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": [
						"import {",
						'\tfrom "./C.es" { helper as bump }',
						"}",
						"",
						"implementation {",
						"\tconstant once = bump(1)",
						"}",
						"",
						"export {",
						"\tonce",
						"}",
						"",
					].join("\n"),
					"C.es": helping,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// Each destination would import `step` from this Module, which
			// imports `run` back, and a Constant does not hoist.
			it("should offer nothing that would import a Constant across a cycle", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { helper }',
						"}",
						"",
						"implementation {",
						"\tconstant step = 4",
						"",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- helper(n)::add(step)",
						"\t}",
						"",
						"\tconstant kept = run(1)",
						"}",
						"",
						"export {",
						"\tkept",
						"\tstep",
						"}",
						"",
					].join("\n"),
					"C.es": helping,
				})

				expect(moves(workspace, pathOf("A.es"), 8, "run")).toEqual([])
			})

			// `kept` calls `run` while A's body runs, and `run` would then come
			// from a Module of the cycle, whose body may not have run yet.
			it("should offer nothing where a Module body would run code of a cycle", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tfunction base() -> Integer {",
						"\t\t<- 1",
						"\t}",
						"",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::add(base())",
						"\t}",
						"",
						"\tconstant kept = run(1)",
						"}",
						"",
						"export {",
						"\tbase",
						"\tkept",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
				})

				expect(moves(workspace, pathOf("A.es"), 6, "run")).toEqual([])
			})

			// `empty` reads the Constant `size` and has no annotation, so the
			// Namespace `Board` can not hoist, and B could not bind it.
			it("should offer nothing that would put a Namespace that can not hoist in a cycle", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\ttype Board = List<Integer>",
						"",
						"\tconstant size = 2",
						"",
						"\tnamespace Board for Board {",
						"\t\tstatic empty = List.repeat(0, times size)",
						"",
						"\t\tfilled() -> Integer {",
						"\t\t\t<- @::length()",
						"\t\t}",
						"\t}",
						"}",
						"",
						"export {",
						"\tBoard",
						"}",
						"",
					].join("\n"),
					"B.es": [
						"import {",
						'\tfrom "./A.es" { Board }',
						"}",
						"",
						"implementation {",
						"\ttype Game = { board: Board }",
						"",
						"\tfunction cells(_ game: Game) -> Integer {",
						"\t\t<- game.board::filled()",
						"\t}",
						"",
						"\tfunction start() -> Game {",
						"\t\t<- { board = Board.empty }",
						"\t}",
						"}",
						"",
						"export {",
						"\tGame",
						"\tcells",
						"\tstart",
						"}",
						"",
					].join("\n"),
				})

				expect(
					moves(workspace, pathOf("B.es"), 8, "cells").map(
						(action) => action.title,
					),
				).not.toContain("Move 'cells' to ./A.es")
			})

			// Main's `Terminal.print` would run in an order the cycle does not
			// state, which is the Warning `cyclic-side-effects`.
			it("should offer nothing that would put a Statement with effects in a cycle", () => {
				let { workspace, pathOf } = makeWorkspace({
					"Lib.es": [
						"implementation {",
						"\tfunction helper(_ n: Integer) -> Integer {",
						"\t\t<- n::add(1)",
						"\t}",
						"",
						"\tfunction twice(_ n: Integer) -> Integer {",
						"\t\t<- helper(helper(n))",
						"\t}",
						"}",
						"",
						"export {",
						"\ttwice",
						"}",
						"",
					].join("\n"),
					"Main.es": [
						"import {",
						'\tfrom "./Lib.es" { twice }',
						"}",
						"",
						"implementation {",
						'\tTerminal.print("hello")',
						"",
						"\tfunction run() -> Integer {",
						"\t\t<- twice(1)",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
				})

				expect(
					moves(workspace, pathOf("Lib.es"), 2, "helper").map(
						(action) => action.title,
					),
				).not.toContain("Move 'helper' to ./Main.es")
			})

			// Only Function bodies read across the cycle, and those run once
			// both Module bodies have.
			it("should make two Modules import each other where neither body runs the other", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tfunction base() -> Integer {",
						"\t\t<- 1",
						"\t}",
						"",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::add(base())",
						"\t}",
						"",
						"\tfunction twice(_ n: Integer) -> Integer {",
						"\t\t<- run(run(n))",
						"\t}",
						"}",
						"",
						"export {",
						"\tbase",
						"\ttwice",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					6,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					[
						"import {",
						'\tfrom "./B.es" { run }',
						"}",
						"",
						"implementation {",
						"\tfunction base() -> Integer {",
						"\t\t<- 1",
						"\t}",
						"",
						"\tfunction twice(_ n: Integer) -> Integer {",
						"\t\t<- run(run(n))",
						"\t}",
						"}",
						"",
						"export {",
						"\tbase",
						"\ttwice",
						"}",
						"",
					].join("\n"),
				)
				expect(texts[pathOf("B.es")]).toBe(
					[
						"import {",
						'\tfrom "./A.es" { base }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::add(base())",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
				)

				for (let name of ["A.es", "B.es"]) {
					expect(codesAfter(workspace, texts, pathOf(name))).toEqual(
						[],
					)
				}
			})

			// `empty` reads `Board.empty` while A's body runs, which fails where
			// B's body has not run yet.
			it("should offer nothing where a Module body would read a Namespace of a cycle", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./B.es" { Board }',
						"}",
						"",
						"implementation {",
						"\ttype Game = { board: Board }",
						"",
						"\tconstant empty: Game = { board = Board.empty }",
						"",
						"\tfunction cells(_ game: Game) -> Integer {",
						"\t\t<- game.board::length()",
						"\t}",
						"}",
						"",
						"export {",
						"\tGame",
						"\tcells",
						"\tempty",
						"}",
						"",
					].join("\n"),
					"B.es": [
						"implementation {",
						"\ttype Board = List<Integer>",
						"",
						"\tnamespace Board for Board {",
						"\t\tstatic empty: Board = [0, 0]",
						"\t}",
						"}",
						"",
						"export {",
						"\tBoard",
						"}",
						"",
					].join("\n"),
				})

				expect(
					moves(workspace, pathOf("A.es"), 10, "cells").map(
						(action) => action.title,
					),
				).toEqual(["Move 'cells' to a new Module"])
			})

			// The group that goes shares its line with the new one written
			// before it. The Formatter closes up the space it leaves.
			it("should swap a group in an import block written on one line", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						'import { from "./C.es" { helper } }',
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- helper(n)",
						"\t}",
						"",
						"\tconstant once = run(1)",
						"}",
						"",
						"export {",
						"\tonce",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
					"C.es": helping,
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					4,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]?.split("\n")[0]).toBe(
					'import { from "./B.es" { run }  }',
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// The name would read the destination's own `helper` there.
			it("should not offer a Module that binds an imported name to something else", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"import {",
						'\tfrom "./C.es" { helper }',
						"}",
						"",
						"implementation {",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- helper(n)",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": [
						"implementation {",
						"\tfunction helper(_ n: Integer) -> Integer {",
						"\t\t<- n",
						"\t}",
						"}",
						"",
					].join("\n"),
					"C.es": helping,
				})

				expect(
					moves(workspace, pathOf("A.es"), 6, "run").map(
						(action) => action.title,
					),
				).toEqual([
					"Move 'run' to ./C.es",
					"Move 'run' to a new Module",
				])
			})

			// A Type is one of those names too, and a Module the file
			// writes from scratch takes the block with the rest of the Program.
			it("should import a Type into the Module it writes", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\ttype Crate = { count: Integer }",
						"",
						"\tfunction sized(_ crate: Crate) -> Integer {",
						"\t\t<- crate.count",
						"\t}",
						"}",
						"",
						"export {",
						"\tCrate",
						"\tsized",
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					4,
					"sized",
					"Move 'sized' to a new Module",
				)
				let written = move.edits.find(
					(edit) => edit.createFile === true,
				)

				expect(written?.newText).toBe(
					[
						"import {",
						'\tfrom "./A.es" { Crate }',
						"}",
						"",
						"implementation {",
						"\tfunction sized(_ crate: Crate) -> Integer {",
						"\t\t<- crate.count",
						"\t}",
						"}",
						"",
						"export {",
						"\tsized",
						"}",
						"",
					].join("\n"),
				)
			})

			// A Method is reached through a Type, but its Namespace is reached by
			// name. A Namespace this Module keeps private is out of scope where the
			// Statement lands.
			it("should refuse a Declaration dispatching into a private Namespace", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tnamespace IntegerExtras for Integer {",
						"\t\tdoubled() -> Integer {",
						"\t\t\t<- @::multiply(with 2)",
						"\t\t}",
						"\t}",
						"",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::doubled()",
						"\t}",
						"}",
						"",
						"export {",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
				})

				expect(
					moves(workspace, pathOf("A.es"), 8, "run").map(
						(action) => action.title,
					),
				).toEqual([])
			})

			// And the same Namespace published is one the target can
			// import, so the move is offered and brings it along.
			it("should carry a published Namespace along with the Declaration", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tnamespace IntegerExtras for Integer {",
						"\t\tdoubled() -> Integer {",
						"\t\t\t<- @::multiply(with 2)",
						"\t\t}",
						"\t}",
						"",
						"\tfunction run(_ n: Integer) -> Integer {",
						"\t\t<- n::doubled()",
						"\t}",
						"}",
						"",
						"export {",
						"\tIntegerExtras",
						"\trun",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					8,
					"run",
					"Move 'run' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("B.es")]?.split("\n")[1]).toBe(
					'\tfrom "./A.es" { IntegerExtras }',
				)
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// Members, properties, Methods and Argument labels are reached through
			// a Type, so only the names beside them travel with the Statement.
			it("should offer a Declaration writing Record members and Argument labels", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\ttype Point = { x: Integer, y: Integer }",
						"",
						"\tfunction scaled(_ value: Integer, by factor: Integer) -> Integer {",
						"\t\t<- value::multiply(with factor)",
						"\t}",
						"",
						"\tfunction origin(scale: Integer) -> Point {",
						"\t\t<- { x = scaled(0, by scale), y = 0 }",
						"\t}",
						"}",
						"",
						"export {",
						"\tPoint",
						"\torigin",
						"\tscaled",
						"}",
						"",
					].join("\n"),
					"B.es": target,
				})

				expect(
					moves(workspace, pathOf("A.es"), 8, "origin").map(
						(action) => action.title,
					),
				).toContain("Move 'origin' to ./B.es")
			})

			// The Statement reads a name this Module keeps private, so no other
			// Module could read it.
			it("should offer nothing for a Declaration reading a private name", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tconstant factor = 2",
						"",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with factor)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble",
						"}",
						"",
					].join("\n"),
					"B.es": target,
				})

				expect(moves(workspace, pathOf("A.es"), 4, "double")).toEqual(
					[],
				)
			})

			it("should offer a Declaration reading a name this Module publishes", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tconstant factor = 2",
						"",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with factor)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble",
						"\tfactor",
						"}",
						"",
					].join("\n"),
					"B.es": target,
				})

				expect(
					moves(workspace, pathOf("A.es"), 4, "double").map(
						(action) => action.title,
					),
				).toContain("Move 'double' to ./B.es")
			})

			// This Module publishes `factor` as `scale`, so that is the name the
			// destination imports, under the one the Statement writes.
			it("should import a name this Module publishes under another name by that name", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tconstant factor = 2",
						"",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with factor)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble",
						"\tfactor as scale",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					4,
					"double",
					"Move 'double' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("B.es")]?.split("\n")[1]).toBe(
					'\tfrom "./A.es" { scale as factor }',
				)
				expect(codesAfter(workspace, texts, declaringPath)).toEqual([])
				expect(codesAfter(workspace, texts, pathOf("B.es"))).toEqual([])
			})

			// One export entry publishes the Type and its Namespace, and an
			// importer would lose whichever half stayed behind.
			it("should offer nothing for a Type or a Namespace sharing its name with the other", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\ttype Point = { x: Integer }",
						"",
						"\tnamespace Point for Point {",
						"\t\tshifted() -> Point {",
						"\t\t\t<- { x = @.x::add(1) }",
						"\t\t}",
						"\t}",
						"}",
						"",
						"export {",
						"\tPoint",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
				})

				expect(moves(workspace, pathOf("A.es"), 2, "Point")).toEqual([])
				expect(moves(workspace, pathOf("A.es"), 4, "Point")).toEqual([])
			})

			// A Variable cannot be exported, so it cannot move. The cursor must be
			// on the name, or every Statement of a body would offer the move.
			it("should offer nothing for a Variable, or for a cursor off the name", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tvariable counter = 0",
						"",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"}",
						"",
					].join("\n"),
					"B.es": target,
				})

				expect(moves(workspace, pathOf("A.es"), 2, "counter")).toEqual(
					[],
				)
				expect(moves(workspace, pathOf("A.es"), 5, "value")).toEqual([])
			})

			// The `§§` block documents the Declaration and travels with
			// it, and the Comment that documented the Statement beside it stays
			// exactly where it was.
			it("should carry the documentation block with the Declaration", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\t§§ Twice what it is given.",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					3,
					"double",
					"Move 'double' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[declaringPath]).toBe(
					["implementation {", "}", ""].join("\n"),
				)
				expect(texts[pathOf("B.es")]).toBe(
					[
						"implementation {",
						"\t§§ Twice what it is given.",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"}",
						"",
					].join("\n"),
				)
			})

			// A Module forwarding the name is naming the Module behind
			// it, and that Module is about to be a different one.
			it("should retarget a re-export and an entry sharing its group", () => {
				let { workspace, pathOf } = makeWorkspace({
					"A.es": [
						"implementation {",
						"\tconstant one = 1",
						"",
						"\tfunction double(_ value: Integer) -> Integer {",
						"\t\t<- value::multiply(with 2)",
						"\t}",
						"}",
						"",
						"export {",
						"\tdouble",
						"\tone",
						"}",
						"",
					].join("\n"),
					"B.es": ["implementation {", "}", ""].join("\n"),
					"Facade.es": [
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./A.es" {',
						"\t\tdouble",
						"\t\tone",
						"\t}",
						"}",
						"",
					].join("\n"),
				})

				let declaringPath = pathOf("A.es")
				let move = moveTo(
					workspace,
					declaringPath,
					4,
					"double",
					"Move 'double' to ./B.es",
				)
				let texts = appliedAcross(workspace, declaringPath, move)

				expect(texts[pathOf("Facade.es")]).toBe(
					[
						"implementation {",
						"}",
						"",
						"export {",
						'\tfrom "./A.es" {',
						"\t\tone",
						"\t}",
						'\tfrom "./B.es" { double }',
						"}",
						"",
					].join("\n"),
				)
				expect(
					codesAfter(workspace, texts, pathOf("Facade.es")),
				).toEqual([])
			})
		})

		describe("insertExportEdit", () => {
			function edited(
				lines: Array<string>,
				entry: {
					name: string
					alias?: string | null
					specifier: string | null
				},
			) {
				let source = lines.join("\n")
				let edit = insertExportEdit(
					source,
					parseDocument(source).program,
					{
						alias: null,
						...entry,
					},
				)

				return edit === null
					? null
					: applyEdits(source, [edit]).split("\n")
			}

			it("should open a block below the implementation and above the tests", () => {
				expect(
					edited(
						[
							"implementation {",
							"\tconstant one = 1",
							"}",
							"",
							"tests {",
							'\ttest "one" {',
							"\t\texpect one::isEqualTo(1)",
							"\t}",
							"}",
							"",
						],
						{ name: "one", specifier: null },
					),
				).toEqual([
					"implementation {",
					"\tconstant one = 1",
					"}",
					"",
					"export {",
					"\tone",
					"}",
					"",
					"tests {",
					'\ttest "one" {',
					"\t\texpect one::isEqualTo(1)",
					"\t}",
					"}",
					"",
				])
			})

			it("should write a forwarded name as a group of its own", () => {
				expect(
					edited(
						[
							"implementation {",
							"}",
							"",
							"export {",
							"\tone",
							'\tfrom "./C.es" { three }',
							"}",
							"",
						],
						{ name: "two", specifier: "./B.es" },
					),
				).toEqual([
					"implementation {",
					"}",
					"",
					"export {",
					"\tone",
					'\tfrom "./B.es" { two }',
					'\tfrom "./C.es" { three }',
					"}",
					"",
				])
			})

			// A bare name stands in front of every group, whatever it is called,
			// since what a Module declares and what it forwards are two lists.
			it("should write a bare name above the groups", () => {
				expect(
					edited(
						[
							"implementation {",
							"\tconstant zulu = 1",
							"}",
							"",
							"export {",
							'\tfrom "./B.es" { two }',
							"}",
							"",
						],
						{ name: "zulu", specifier: null },
					),
				).toEqual([
					"implementation {",
					"\tconstant zulu = 1",
					"}",
					"",
					"export {",
					"\tzulu",
					'\tfrom "./B.es" { two }',
					"}",
					"",
				])
			})

			it("should join the group already written for the Module", () => {
				expect(
					edited(
						[
							"implementation {",
							"}",
							"",
							"export {",
							'\tfrom "./B.es" { two }',
							"}",
							"",
						],
						{ name: "four", specifier: "./B.es" },
					),
				).toEqual([
					"implementation {",
					"}",
					"",
					"export {",
					'\tfrom "./B.es" {',
					"\t\tfour",
					"\t\ttwo",
					"\t}",
					"}",
					"",
				])
			})

			// A block is ordered by each entry's name at home, not the name it
			// publishes, as the Formatter orders it.
			it("should order a name against what an aliased entry is called at home", () => {
				expect(
					edited(
						[
							"implementation {",
							"\tconstant alpha = 1",
							"\tconstant beta = 2",
							"}",
							"",
							"export {",
							"\talpha as zzz",
							"}",
							"",
						],
						{ name: "beta", alias: "second", specifier: null },
					),
				).toEqual([
					"implementation {",
					"\tconstant alpha = 1",
					"\tconstant beta = 2",
					"}",
					"",
					"export {",
					"\talpha as zzz",
					"\tbeta as second",
					"}",
					"",
				])
			})

			it("should answer with nothing for a name the block already publishes", () => {
				expect(
					edited(
						[
							"implementation {",
							"\tconstant one = 1",
							"}",
							"",
							"export {",
							"\tone",
							"}",
							"",
						],
						{ name: "one", specifier: null },
					),
				).toBeNull()
			})
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

			// One Diagnostic per broken Module, not per entry naming it.
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

		// `Item` is bounded by the `Sized` that `SizedBox` demands, which
		// `Boxes.es` never imports and `Box.es` keeps to itself. The file is
		// being edited, so the member is read off a relink of the edited text.
		it("should complete a member of a bound private to another Module", () => {
			let written = [
				"import {",
				'\tfrom "./Box.es" { SizedBox }',
				"}",
				"",
				"implementation {",
				"\tnamespace Boxes<infer Item> for SizedBox<Item> {",
				"\t\tsized() -> Integer {",
				"\t\t\t<- match @ -> Integer {",
				"\t\t\t\tcase #Box({ item }) { <- 1 }",
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
				"",
			].join("\n")
			let { workspace, pathOf } = makeWorkspace({
				"Box.es": [
					"implementation {",
					"\tprotocol Sized {",
					"\t\tsize() -> Integer",
					"\t}",
					"",
					"\tchoice SizedBox<Item is Sized> {",
					"\t\tBox { item: Item },",
					"\t}",
					"}",
					"",
					"export {",
					"\tSizedBox",
					"}",
					"",
				].join("\n"),
				"Boxes.es": written,
			})
			let boxesPath = pathOf("Boxes.es")
			let edited = written.replace("{ <- 1 }", "{ <- item:: }")

			let entries = findCompletions(
				edited,
				cursorPast(edited, 9, "item::"),
				boxesPath,
				{
					offers: workspace.offersFor(boxesPath),
					namespaces: workspace.namespaceOffersFor(boxesPath),
				},
			)

			expect(entries.map((entry) => entry.label)).toContain("size")
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

	// A Diagnostic for a file nobody has open is addressed by URI. A path that
	// does not survive the round trip puts a squiggle in the wrong file.
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

	// `exclude` in the nearest `essence.json`. The discovery walk decides what
	// the Problems panel reports, and a project may hold `.es` files that are
	// not its sources.
	describe("the directories a project excludes", () => {
		let projectFile = JSON.stringify({ exclude: ["broken"] })

		it("should stay out of a directory the project excludes", () => {
			let { workspace, pathOf } = makeWorkspace({
				"essence.json": projectFile,
				"Math.es": math,
				"broken/Bad.es": bad,
			})

			expect([...workspace.knownFiles()]).toEqual([pathOf("Math.es")])
			expect(workspace.roots()).toEqual([pathOf("Math.es")])
			expect(workspace.isExcluded(pathOf("broken/Bad.es"))).toBe(true)
		})

		// An excluded file is not discovered, but a file this project imports
		// is still analysed, whatever directory it sits in.
		it("should still report on an excluded file a source imports", () => {
			let { workspace, pathOf } = makeWorkspace({
				"essence.json": projectFile,
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

		// The watcher keeps the walk current, so an exclusion must hold on the
		// watcher's path too.
		it("should not take an excluded file from the watcher", () => {
			let { workspace, root, pathOf } = makeWorkspace({
				"essence.json": projectFile,
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

		// When the project file changes the Server sets the folders again,
		// which forgets the exclusions and every answer derived under them.
		it("should read the exclusions again when the folders are set", () => {
			let { workspace, root, pathOf } = makeWorkspace({
				"essence.json": projectFile,
				"Math.es": math,
				"broken/Bad.es": bad,
			})

			expect(workspace.knownFiles().has(pathOf("broken/Bad.es"))).toBe(
				false,
			)

			writeFileSync(
				path.join(root, "essence.json"),
				JSON.stringify({ exclude: [] }),
			)
			workspace.setFolders(workspace.folders())

			expect(workspace.knownFiles().has(pathOf("broken/Bad.es"))).toBe(
				true,
			)
		})

		// Exclusions apply per file, not per workspace, so one folder cannot
		// silence a directory of the same name in another.
		it("should keep one folder's exclusions out of another's", () => {
			let excluding = makeFolder({
				"essence.json": projectFile,
				"Math.es": math,
				"broken/Bad.es": bad,
			})
			let plain = makeFolder({
				"Other.es": math,
				"broken/Bad.es": bad,
			})
			let workspace = createWorkspace()

			workspace.setFolders([excluding, plain])

			let known = workspace.knownFiles()

			expect(
				known.has(canonicalPath(path.join(excluding, "broken/Bad.es"))),
			).toBe(false)
			expect(
				known.has(canonicalPath(path.join(plain, "broken/Bad.es"))),
			).toBe(true)
		})

		// A project inside a project. The nearest file governs, so the
		// inner one draws its own boundary and the outer one's says nothing
		// about what is under it.
		it("should let a nested project file govern its own subtree", () => {
			let { workspace, pathOf } = makeWorkspace({
				"essence.json": JSON.stringify({ exclude: [] }),
				"Math.es": math,
				"inner/essence.json": JSON.stringify({ exclude: ["broken"] }),
				"inner/Kept.es": math,
				"inner/broken/Bad.es": bad,
				"broken/Bad.es": bad,
			})

			let known = workspace.knownFiles()

			expect(known.has(pathOf("inner/Kept.es"))).toBe(true)
			expect(known.has(pathOf("broken/Bad.es"))).toBe(true)
			expect(known.has(pathOf("inner/broken/Bad.es"))).toBe(false)
			expect(workspace.isExcluded(pathOf("inner/broken/Bad.es"))).toBe(
				true,
			)
			expect(workspace.isExcluded(pathOf("broken/Bad.es"))).toBe(false)
		})

		// Nothing is read from a `package.json`'s `essence` key. The key gets a
		// Diagnostic, since its author may believe the setting is in force.
		it("should read nothing from a manifest that still spells the old key", () => {
			let { workspace, pathOf } = makeWorkspace({
				"package.json": JSON.stringify({
					essence: { exclude: ["broken"] },
				}),
				"Math.es": math,
				"broken/Bad.es": bad,
			})

			expect(workspace.knownFiles().has(pathOf("broken/Bad.es"))).toBe(
				true,
			)
			expect(workspace.isExcluded(pathOf("broken/Bad.es"))).toBe(false)
			expect(
				workspace
					.configurationProblems()
					.map((problem) => [
						problem.filePath,
						problem.diagnostics.map(
							(diagnostic) => diagnostic.code,
						),
					]),
			).toEqual([[pathOf("package.json"), ["moved-setting"]]])
		})

		// A changed `package.json` reads the settings again but keeps the walk,
		// since a manifest draws no boundary.
		it("should forget the settings without forgetting the files", () => {
			let { workspace, root, pathOf } = makeWorkspace({
				"package.json": JSON.stringify({
					essence: { exclude: ["broken"] },
				}),
				"Math.es": math,
			})

			expect(workspace.configurationProblems()).toHaveLength(1)

			let known = workspace.knownFiles()

			writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify({ name: "moved" }),
			)
			workspace.forgetConfiguration()

			expect(workspace.configurationProblems()).toEqual([])
			expect(workspace.knownFiles()).toBe(known)
			expect(workspace.knownFiles().has(pathOf("Math.es"))).toBe(true)
		})
	})
})
