import { beforeAll, describe, expect, it } from "bun:test"

import {
	type Citation,
	citationsIn,
	findingsIn,
	readSource,
	sourceOf,
	trackedScripts,
} from "../commentProse"
import {
	developmentFiles,
	headingsOf,
	nearestDevelopment,
	problemOf,
	type Reader,
	readDevelopment,
	repeatedHeadingsOf,
} from "../developmentCitations"

// A comment that points to the development notes cites a heading in them, and
// the heading has to be there. The form is a rule of `scripts/commentProse.ts`,
// held to its baseline. Where a citation leads is checked here.

let citations: Array<Citation> = []
let developments: Array<string> = []

beforeAll(async () => {
	citations = (await trackedScripts()).map(readSource).flatMap(citationsIn)
	developments = await developmentFiles()
})

function citationsOf(text: string, file = "example.ts"): Array<Citation> {
	return citationsIn(sourceOf(file, text))
}

function uncitedLinesOf(text: string): Array<number> {
	return findingsIn(sourceOf("example.ts", text))
		.filter((finding) => finding.rule === "citation")
		.map((finding) => finding.line)
}

function readerOf(files: Record<string, string>): Reader {
	return (file) => files[file] ?? null
}

const library = readerOf({
	"DEVELOPMENT.md": "# Developing\n\n## Releases\n",
	"packages/a/DEVELOPMENT.md": "# Developing a\n\n## Layout\n\n### `wrap`\n",
})

function citation(file: string, heading: string, path: string | null = null) {
	return { file, line: 3, heading, path }
}

describe("Development Citations", () => {
	describe("reading", () => {
		it("should read a citation whose quote wraps onto the next line", () => {
			expect(
				citationsOf(
					[
						"let a = 1",
						'// The layout is kept apart. See "How the',
						'// layout works" in DEVELOPMENT.md.',
					].join("\n"),
				),
			).toEqual([
				{
					file: "example.ts",
					line: 2,
					heading: "How the layout works",
					path: null,
				},
			])
		})

		it("should read the path a citation names", () => {
			expect(
				citationsOf(
					'let a = 1\n/** See "Member order" in packages/standard-library/DEVELOPMENT.md. */\n',
				),
			).toEqual([
				{
					file: "example.ts",
					line: 2,
					heading: "Member order",
					path: "packages/standard-library/DEVELOPMENT.md",
				},
			])
		})

		it("should read a heading but not a line in a code fence", () => {
			expect(
				headingsOf(
					"# Title\n\n## `wrap` ##\n\n```sh\n# a shell comment\n```\n#hashtag\n",
				),
			).toEqual([
				{ text: "Title", line: 1 },
				{ text: "`wrap`", line: 3 },
			])
		})
	})

	describe("form", () => {
		it("should refuse a mention of DEVELOPMENT.md outside a citation", () => {
			expect(
				uncitedLinesOf(
					"let a = 1\n// The reasons are in DEVELOPMENT.md.\n",
				),
			).toEqual([2])
			expect(
				uncitedLinesOf(
					'let a = 1\n// Kept apart. See "Layout" in DEVELOPMENT.md.\n// The rest is in DEVELOPMENT.md too.\n',
				),
			).toEqual([3])
			expect(
				uncitedLinesOf(
					'let a = 1\n// See "Layout" in DEVELOPMENT.md, which says why.\n',
				),
			).toEqual([2])
		})

		it("should accept a mention that is a citation", () => {
			expect(
				uncitedLinesOf(
					'let a = 1\n// Kept apart. See "Layout" in\n// DEVELOPMENT.md.\n',
				),
			).toEqual([])
			expect(
				uncitedLinesOf(
					'let a = 1\n// See "Layout" in packages/a/DEVELOPMENT.md.\n',
				),
			).toEqual([])
		})
	})

	describe("resolving", () => {
		it("should find the nearest DEVELOPMENT.md walking up", () => {
			expect(nearestDevelopment("packages/a/src/b.ts", library)).toBe(
				"packages/a/DEVELOPMENT.md",
			)
			expect(nearestDevelopment("packages/b/src/c.ts", library)).toBe(
				"DEVELOPMENT.md",
			)
			expect(nearestDevelopment("scripts/c.ts", readerOf({}))).toBeNull()
		})

		it("should accept a heading the nearest DEVELOPMENT.md has", () => {
			expect(
				problemOf(citation("packages/a/src/b.ts", "`wrap`"), library),
			).toBeNull()
			expect(
				problemOf(citation("scripts/c.ts", "Releases"), library),
			).toBeNull()
		})

		it("should refuse a heading the nearest DEVELOPMENT.md lacks", () => {
			expect(
				problemOf(citation("packages/a/src/b.ts", "Releases"), library),
			).toBe(
				'packages/a/src/b.ts:3: cites "Releases", which is not a heading in packages/a/DEVELOPMENT.md',
			)
		})

		it("should say where it looked when no DEVELOPMENT.md stands above", () => {
			expect(
				problemOf(citation("scripts/c.ts", "Layout"), readerOf({})),
			).toBe(
				'scripts/c.ts:3: cites "Layout", but no DEVELOPMENT.md stands in scripts or any directory up to the repository root',
			)
		})

		it("should resolve a citation that names its DEVELOPMENT.md", () => {
			expect(
				problemOf(
					citation(
						"scripts/c.ts",
						"Layout",
						"packages/a/DEVELOPMENT.md",
					),
					library,
				),
			).toBeNull()
			expect(
				problemOf(
					citation(
						"scripts/c.ts",
						"Layout",
						"packages/b/DEVELOPMENT.md",
					),
					library,
				),
			).toBe(
				'scripts/c.ts:3: cites "Layout" in packages/b/DEVELOPMENT.md, which does not exist',
			)
		})
	})

	describe("headings", () => {
		it("should find a heading written twice", () => {
			expect(
				repeatedHeadingsOf(
					"a/DEVELOPMENT.md",
					"# A\n\n## Layout\n\n### Layout\n",
				),
			).toEqual([
				'a/DEVELOPMENT.md:5: repeats the heading "Layout" of line 3',
			])
			expect(
				repeatedHeadingsOf("a/DEVELOPMENT.md", "# A\n\n## Layout\n"),
			).toEqual([])
		})
	})

	describe("repository", () => {
		it("should resolve every citation", () => {
			// Passes on no citations at all, so the reader has to find some.
			expect(
				citations.some((entry) =>
					entry.file.startsWith("packages/formatter/"),
				),
			).toBe(true)
			expect(
				citations
					.map((entry) => problemOf(entry, readDevelopment))
					.filter((problem) => problem !== null)
					.join("\n"),
			).toBe("")
		})

		it("should keep the headings of each DEVELOPMENT.md apart", () => {
			expect(developments).toContain(
				"packages/standard-library/DEVELOPMENT.md",
			)
			expect(
				developments
					.flatMap((file) =>
						repeatedHeadingsOf(file, readDevelopment(file) ?? ""),
					)
					.join("\n"),
			).toBe("")
		})
	})
})
