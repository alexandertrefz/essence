import { describe, expect, it } from "bun:test"

import { findCompletions } from "../completion"
import { moduleSectionCursor } from "../importCompletion"
import type { WorkspaceOffer } from "../workspace"

// NOTE: A whole Program written as the lines it is made of, since where the
// cursor stands in a Module section is a question about lines.
function source(...lines: Array<string>): string {
	return lines.join("\n") + "\n"
}

// NOTE: The cursor just past `needle` on `line`, one-based like every Cursor.
function past(text: string, line: number, needle: string) {
	let column = (text.split("\n")[line - 1] ?? "").indexOf(needle)

	expect(column).not.toBe(-1)

	return { line, column: column + needle.length + 1 }
}

function offer(
	name: string,
	specifier: string,
	kind: WorkspaceOffer["kind"] = "type",
): WorkspaceOffer {
	return {
		name,
		kind,
		specifier,
		filePath: `/project/${specifier.slice(2)}`,
		declaredIn: `/project/${specifier.slice(2)}`,
		position: {
			start: { line: 1, column: 1 },
			end: { line: 1, column: 1 },
		},
	}
}

const workspace = {
	offers: [
		offer("Rectangle", "./Geometry.es"),
		offer("Circle", "./Geometry.es"),
		offer("area", "./Geometry.es", "function"),
		offer("PI", "./math/Math.es", "constant"),
	],
	namespaces: [],
	specifiers: ["./Geometry.es", "./Season.es", "./math/Math.es"],
}

let completions = (text: string, cursor: { line: number; column: number }) =>
	findCompletions(text, cursor, undefined, workspace)

describe("Completion in the Module sections", () => {
	describe("where the cursor stands", () => {
		it("reads a specifier being typed after from", () => {
			let text = source(
				"import {",
				'\tfrom "./Sea',
				"}",
				"",
				"implementation {}",
			)

			expect(
				moduleSectionCursor(text.split("\n"), past(text, 2, "./Sea")),
			).toEqual({
				at: "path",
				section: "import",
				typed: "./Sea",
				replaces: {
					start: { line: 2, column: 8 },
					end: { line: 2, column: 13 },
				},
				quoted: false,
			})
		})

		it("notices a closing quote the Editor already wrote", () => {
			let text = source(
				"import {",
				'\tfrom ""',
				"}",
				"",
				"implementation {}",
			)

			expect(
				moduleSectionCursor(text.split("\n"), past(text, 2, 'from "')),
			).toMatchObject({ at: "path", typed: "", quoted: true })
		})

		it("reads the group a cursor stands in", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\tRectangle",
				"\t\t",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(
				moduleSectionCursor(text.split("\n"), { line: 4, column: 3 }),
			).toEqual({
				at: "names",
				section: "import",
				specifier: "./Geometry.es",
			})
		})

		it("reads a group written flat", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" { Rec }',
				"}",
				"",
				"implementation {}",
			)

			expect(
				moduleSectionCursor(text.split("\n"), past(text, 2, "Rec")),
			).toMatchObject({ at: "names", specifier: "./Geometry.es" })
		})

		it("reads the block itself between two groups", () => {
			let text = source(
				"export {",
				"\tarea",
				"\tfro",
				'\tfrom "./Geometry.es" { Rectangle }',
				"}",
			)

			expect(
				moduleSectionCursor(text.split("\n"), past(text, 3, "fro")),
			).toEqual({
				at: "members",
				section: "export",
				replaces: {
					start: { line: 3, column: 2 },
					end: { line: 3, column: 5 },
				},
			})
		})

		// NOTE: `from ` completed to a group must not read `from from …`.
		it("replaces a from already written, space and all", () => {
			let text = source(
				"import {",
				"\tfrom ",
				"}",
				"",
				"implementation {}",
			)

			expect(
				moduleSectionCursor(text.split("\n"), { line: 2, column: 7 }),
			).toMatchObject({
				at: "members",
				replaces: {
					start: { line: 2, column: 2 },
					end: { line: 2, column: 7 },
				},
			})
		})

		it("answers nothing below a closed block", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" { Rectangle }',
				"}",
				"",
				"implementation {}",
			)

			expect(
				moduleSectionCursor(text.split("\n"), { line: 4, column: 1 }),
			).toBeNull()
		})

		it("answers nothing inside the implementation", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" { Rectangle }',
				"}",
				"",
				"implementation {",
				'\tconstant note = "from "',
				"}",
			)

			expect(
				moduleSectionCursor(text.split("\n"), past(text, 6, "from ")),
			).toBeNull()
		})

		it("reads past a comment holding a brace", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" { § the shapes {',
				"\t\t",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(
				moduleSectionCursor(text.split("\n"), { line: 3, column: 3 }),
			).toMatchObject({ at: "names", specifier: "./Geometry.es" })
		})
	})

	describe("a specifier", () => {
		it("offers every Module of the workspace as a path from this file", () => {
			let text = source(
				"import {",
				'\tfrom "',
				"}",
				"",
				"implementation {}",
			)
			let entries = completions(text, past(text, 2, 'from "'))

			expect(entries.map((entry) => entry.label)).toEqual([
				"./Geometry.es",
				"./Season.es",
				"./math/Math.es",
			])
			expect(entries.every((entry) => entry.kind === "module")).toBe(true)
		})

		// NOTE: The Editor's word ends at every `.` and `/`, so the whole of
		// what was typed is what the entry replaces — else `./ma` completed to
		// `./math/Math.es` reads `./ma./math/Math.es`.
		it("replaces everything typed since the quote", () => {
			let text = source(
				"import {",
				'\tfrom "./ma',
				"}",
				"",
				"implementation {}",
			)
			let entry = completions(text, past(text, 2, "./ma")).find(
				(candidate) => candidate.label === "./math/Math.es",
			)

			expect(entry?.replaces).toEqual({
				start: { line: 2, column: 8 },
				end: { line: 2, column: 12 },
			})
			expect(entry?.insertText).toBe('./math/Math.es" { $0 }')
		})

		it("writes no second quote where one already follows", () => {
			let text = source(
				"import {",
				'\tfrom ""',
				"}",
				"",
				"implementation {}",
			)
			let entry = completions(text, past(text, 2, 'from "')).find(
				(candidate) => candidate.label === "./Season.es",
			)

			expect(entry?.insertText).toBe("./Season.es")
		})

		it("leaves out a Module the block already has a group for", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" { Rectangle }',
				'\tfrom "',
				"}",
				"",
				"implementation {}",
			)

			expect(
				completions(text, past(text, 3, 'from "')).map(
					(entry) => entry.label,
				),
			).toEqual(["./Season.es", "./math/Math.es"])
		})

		it("offers the same paths to a re-export", () => {
			let text = source(
				"implementation {}",
				"",
				"export {",
				'\tfrom "./',
				"}",
			)

			expect(
				completions(text, past(text, 4, "./")).map(
					(entry) => entry.label,
				),
			).toEqual(["./Geometry.es", "./Season.es", "./math/Math.es"])
		})
	})

	describe("the names of a group", () => {
		it("offers what the group's Module exports", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\t",
				"\t}",
				"}",
				"",
				"implementation {}",
			)
			let entries = completions(text, { line: 3, column: 3 })

			expect(entries.map((entry) => [entry.label, entry.kind])).toEqual([
				["Rectangle", "type"],
				["Circle", "type"],
				["area", "function"],
			])
		})

		it("leaves out a name the block already binds", () => {
			let text = source(
				"import {",
				'\tfrom "./Geometry.es" {',
				"\t\tRectangle",
				"\t\t",
				"\t}",
				"}",
				"",
				"implementation {}",
			)

			expect(
				completions(text, { line: 4, column: 3 }).map(
					(entry) => entry.label,
				),
			).toEqual(["Circle", "area"])
		})

		it("reads the specifier however it was spelled", () => {
			let text = source(
				"import {",
				'\tfrom "././Geometry.es" { ',
				"}",
				"",
				"implementation {}",
			)

			expect(
				completions(text, past(text, 2, "{ ")).map(
					(entry) => entry.label,
				),
			).toEqual(["Rectangle", "Circle", "area"])
		})

		it("offers nothing for a Module the workspace does not know", () => {
			let text = source(
				"import {",
				'\tfrom "./Gone.es" { ',
				"}",
				"",
				"implementation {}",
			)

			expect(completions(text, past(text, 2, "{ "))).toEqual([])
		})
	})

	describe("the block itself", () => {
		it("offers a group for every Module not yet written", () => {
			let text = source(
				"import {",
				'\tfrom "./Season.es" { fixtures }',
				"\t",
				"}",
				"",
				"implementation {}",
			)
			let entries = completions(text, { line: 3, column: 2 })

			expect(entries.map((entry) => entry.label)).toEqual([
				'from "./Geometry.es"',
				'from "./math/Math.es"',
			])
			expect(entries[0]?.insertText).toBe('from "./Geometry.es" { $0 }')
			expect(entries[0]?.replaces).toEqual({
				start: { line: 3, column: 2 },
				end: { line: 3, column: 2 },
			})
		})

		it("offers an export block the Module's own unexported names first", () => {
			let text = source(
				"implementation {",
				"\tconstant width = 1",
				"\tfunction area() -> Integer { <- 1 }",
				"\tnamespace Shapes for Integer {}",
				"\tconstant { a, b } = { a = 1, b = 2 }",
				"}",
				"",
				"export {",
				"\twidth",
				"\t",
				"}",
			)

			expect(
				completions(text, { line: 10, column: 2 }).map((entry) => [
					entry.label,
					entry.kind,
				]),
			).toEqual([
				["area", "function"],
				["Shapes", "namespace"],
				['from "./Geometry.es"', "module"],
				['from "./Season.es"', "module"],
				['from "./math/Math.es"', "module"],
			])
		})

		it("offers no name in Scope", () => {
			let text = source(
				"import {",
				"\t",
				"}",
				"",
				"implementation {",
				"\tconstant width = 1",
				"}",
			)

			expect(
				completions(text, { line: 2, column: 2 }).map(
					(entry) => entry.label,
				),
			).not.toContain("width")
		})
	})
})
