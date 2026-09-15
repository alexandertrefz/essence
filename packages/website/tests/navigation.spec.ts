import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import {
	type DocEntryLike,
	getCrumbs,
	getGuideToc,
	getPrevNext,
	getReadingChain,
	getSidebar,
	getToc,
	stepAnchor,
} from "../src/lib/navigation.ts"

// NOTE: The rules that decide what is a chapter and what is a lookup table,
// checked on a hand-made collection rather than on the real one — the real
// one is whatever the writers have published so far, and the rules must not
// bend with it.

function entry(
	id: string,
	order: number,
	template: DocEntryLike["data"]["template"] = "article",
): DocEntryLike {
	let section = id.split("/")[0] as DocEntryLike["data"]["section"]

	return {
		id,
		data: {
			title: id.split("/").at(-1)!,
			description: `About ${id}.`,
			section,
			order,
			template,
		},
	}
}

// Deliberately out of order, so the sort is what puts them right.
let entries = [
	entry("reference/cli", 20, "reference"),
	entry("library/list", 90, "type"),
	entry("guides/projects", 20, "guide"),
	entry("language/records", 50),
	entry("getting-started/installation", 20),
	entry("library/overview", 10),
	entry("library/integer", 20, "type"),
	entry("guides/using-the-compiler", 10, "guide"),
	entry("reference/diagnostics", 40, "reference"),
	entry("getting-started/what-essence-is", 10),
	entry("language/programs-and-values", 10),
]

describe("the reading chain", () => {
	it("runs through articles and guides in sidebar order and skips lookup pages", () => {
		expect(getReadingChain(entries).map((link) => link.id)).toEqual([
			"getting-started/what-essence-is",
			"getting-started/installation",
			"language/programs-and-values",
			"language/records",
			"library/overview",
			"guides/using-the-compiler",
			"guides/projects",
		])
	})

	it("turns the page from the last language article to the library overview, and from there to the first guide", () => {
		let { previous, next } = getPrevNext(entries, "library/overview")

		expect(previous?.id).toBe("language/records")
		expect(next?.id).toBe("guides/using-the-compiler")
	})

	it("has no previous or next on a type page or a reference page", () => {
		expect(getPrevNext(entries, "library/list")).toEqual({})
		expect(getPrevNext(entries, "reference/cli")).toEqual({})
	})
})

describe("the sidebar", () => {
	it("lists every section in the fixed order, each one flat and sorted by order", () => {
		let sidebar = getSidebar(entries)

		expect(sidebar.map((section) => section.label)).toEqual([
			"Getting started",
			"Language",
			"Library",
			"Guides",
			"Reference",
		])
		expect(
			sidebar
				.find((section) => section.id === "library")!
				.items.map((item) => [item.id, item.children.length]),
		).toEqual([
			["library/overview", 0],
			["library/integer", 0],
			["library/list", 0],
		])
	})

	it("omits a section with no pages", () => {
		let sidebar = getSidebar(
			entries.filter((e) => e.data.section !== "guides"),
		)

		expect(sidebar.map((section) => section.id)).not.toContain("guides")
	})
})

function grouped(id: string, order: number, group: string): DocEntryLike {
	let base = entry(id, order)

	return { ...base, data: { ...base.data, group } }
}

/** A section's runs as `[label, ids]`, which is all a failure needs to show. */
function runsOf(
	sidebar: ReturnType<typeof getSidebar>,
	id: DocEntryLike["data"]["section"],
): [string, string[]][] {
	return sidebar
		.find((section) => section.id === id)!
		.groups.map((group) => [
			group.label,
			group.items.map((item) => item.id),
		])
}

// Deliberately out of order again: the runs have to come out of the sort, not
// out of the order the entries were written in.
let language = [
	grouped("language/generics", 190, "Abstraction"),
	grouped("language/method-calls", 20, "Basics"),
	grouped("language/records", 50, "Modelling data"),
	grouped("language/programs-and-values", 10, "Basics"),
	grouped("language/protocols", 200, "Abstraction"),
	grouped("language/optional", 70, "Modelling data"),
]

let withGroups = [
	...entries.filter((e) => e.data.section !== "language"),
	...language,
]

describe("the sidebar's groups", () => {
	it("splits a section into labelled runs in the order its pages already have", () => {
		let sidebar = getSidebar(withGroups)
		let section = sidebar.find((s) => s.id === "language")!

		expect(runsOf(sidebar, "language")).toEqual([
			[
				"Basics",
				["language/programs-and-values", "language/method-calls"],
			],
			["Modelling data", ["language/records", "language/optional"]],
			["Abstraction", ["language/generics", "language/protocols"]],
		])
		expect(section.groups.flatMap((group) => group.items)).toEqual(
			section.items,
		)
	})

	it("never moves a page: the reading chain and the crumbs read the same order", () => {
		expect(
			getReadingChain(withGroups)
				.map((link) => link.id)
				.filter((id) => id.startsWith("language/")),
		).toEqual(
			getSidebar(withGroups)
				.find((s) => s.id === "language")!
				.items.map((item) => item.id),
		)
		expect(getCrumbs(withGroups, "language/optional")[1]).toEqual({
			label: "Language",
			href: "/docs/language/programs-and-values",
		})
	})

	it("leaves a section whose pages name no group as it was", () => {
		let before = getSidebar(entries)
		let after = getSidebar(withGroups)

		for (let section of before) {
			expect(section.groups).toEqual([])
		}

		for (let id of ["getting-started", "library", "guides", "reference"]) {
			let section = after.find((s) => s.id === id)!

			expect(section.groups).toEqual([])
			expect(section).toEqual(before.find((s) => s.id === id)!)
		}
	})

	it("refuses a page with no group in a section whose other pages name one", () => {
		let unfiled = [...withGroups, entry("language/strings", 160)]

		expect(() => getSidebar(unfiled)).toThrow(
			"language/strings has no `group`, but other Language pages name one.",
		)
	})

	it("refuses a group that comes back after another run", () => {
		let split = [
			...withGroups,
			grouped("language/checked-refinements", 100, "Basics"),
		]

		expect(() => getSidebar(split)).toThrow(
			'language/checked-refinements is in the group "Basics", but pages of another group come between it and the rest of "Basics".',
		)
	})

	it("refuses a group on a page written under another", () => {
		let nested = [
			...withGroups,
			grouped("language/records/with", 55, "Modelling data"),
		]

		expect(() => getSidebar(nested)).toThrow(
			'language/records/with names the group "Modelling data", but it is written under language/records',
		)
	})

	it("lets a page written under another follow its parent's run", () => {
		let nested = [...withGroups, entry("language/records/with", 55)]
		let records = getSidebar(nested)
			.find((s) => s.id === "language")!
			.groups.find((group) => group.label === "Modelling data")!
			.items.find((item) => item.id === "language/records")!

		expect(records.children.map((child) => child.id)).toEqual([
			"language/records/with",
		])
	})
})

// NOTE: The one check on the published pages. Every rule above is held on a
// hand-made collection, as the note at the top says — but "every page of a
// grouped section names its group" is a rule about what gets published, and
// the page it has to catch is the next one a writer adds. So the real pages go
// through `getSidebar` too, which is where the rules throw. They are read as
// files, as every doc gate reads them, because `astro:content` only resolves
// inside an Astro build.
const DOCS_DIRECTORY = path.resolve(import.meta.dirname, "../src/content/docs")

function pagesUnder(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true })
		.flatMap((file) => {
			let full = path.join(directory, file.name)

			return file.isDirectory()
				? pagesUnder(full)
				: /\.mdx?$/.test(file.name)
					? [full]
					: []
		})
		.sort()
}

/** What a page's frontmatter holds before the schema fills in its defaults. */
type Frontmatter = Omit<DocEntryLike["data"], "template"> & {
	template?: DocEntryLike["data"]["template"]
}

/** A page as the collection loads it: its id and the frontmatter the navigation reads. */
function readPage(file: string): DocEntryLike {
	let source = readFileSync(file, "utf8")
	let frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1]

	if (frontmatter === undefined) {
		throw new Error(`${file} has no frontmatter.`)
	}

	let data = Bun.YAML.parse(frontmatter) as Frontmatter

	return {
		id: path
			.relative(DOCS_DIRECTORY, file)
			.replace(/\.mdx?$/, "")
			.split(path.sep)
			.join("/"),
		data: { ...data, template: data.template ?? "article" },
	}
}

describe("the published sidebar", () => {
	let published = pagesUnder(DOCS_DIRECTORY).map(readPage)

	it("groups every Language page, one run per label, in the order the pages already have", () => {
		let section = getSidebar(published).find((s) => s.id === "language")!
		let labels = section.groups.map((group) => group.label)

		expect(section.groups).not.toEqual([])
		expect(section.groups.flatMap((group) => group.items)).toEqual(
			section.items,
		)
		expect(new Set(labels).size).toBe(labels.length)
	})
})

describe("breadcrumbs and the on-this-page list", () => {
	it("points the section crumb at the section's first page", () => {
		expect(getCrumbs(entries, "library/list")).toEqual([
			{ label: "Docs", href: "/docs" },
			{ label: "Library", href: "/docs/library/overview" },
			{ label: "list", current: true },
		])
	})

	it("keeps headings from ## down to the depth asked for", () => {
		let headings = [
			{ depth: 1, slug: "title", text: "Title" },
			{ depth: 2, slug: "group", text: "Group" },
			{ depth: 3, slug: "member", text: "member" },
			{ depth: 4, slug: "deep", text: "Deep" },
		]

		expect(getToc(headings, 2).map((h) => h.slug)).toEqual(["group"])
		expect(getToc(headings, 3).map((h) => h.slug)).toEqual([
			"group",
			"member",
		])
	})
})

describe("a guide's on-this-page list", () => {
	let body = [
		"## Before you start",
		"",
		"<Steps>",
		"",
		'<StepItem title="Check it">',
		"",
		"```sh",
		"# not a heading",
		"```",
		"",
		"### What it prints",
		"",
		"</StepItem>",
		"",
		'<StepItem id="ship" title="Wire it into CI">',
		"",
		"````md",
		"```",
		"## still inside the outer fence",
		"```",
		"````",
		"",
		"</StepItem>",
		"",
		"</Steps>",
		"",
		"## Compared with tsc",
	].join("\n")

	let headings = [
		{ depth: 2, slug: "before-you-start", text: "Before you start" },
		{ depth: 3, slug: "what-it-prints", text: "What it prints" },
		{ depth: 2, slug: "compared-with-tsc", text: "Compared with tsc" },
	]

	it("lists the steps where they stand among the headings, skipping code", () => {
		expect(getGuideToc(body, headings, 3).map((item) => item.slug)).toEqual(
			[
				"before-you-start",
				"check-it",
				"what-it-prints",
				"ship",
				"compared-with-tsc",
			],
		)
	})

	it("keeps every step whatever depth the page asks for", () => {
		expect(getGuideToc(body, headings, 2).map((item) => item.slug)).toEqual(
			["before-you-start", "check-it", "ship", "compared-with-tsc"],
		)
	})

	it("falls back to the headings when the source does not account for them", () => {
		let more = [...headings, { depth: 2, slug: "extra", text: "Extra" }]

		expect(getGuideToc(body, more, 3)).toEqual(getToc(more, 3))
	})

	it("reaches a step by the anchor its component gives it", () => {
		expect(stepAnchor("Compile in a bundler")).toBe("compile-in-a-bundler")
		expect(stepAnchor("Write hello.es")).toBe("write-hello-es")
	})
})
