import { describe, expect, it } from "bun:test"

import {
	type DocEntryLike,
	getCrumbs,
	getPrevNext,
	getReadingChain,
	getSidebar,
	getToc,
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
			sidebar.find((section) => section.id === "library")!.items.map(
				(item) => [item.id, item.children.length],
			),
		).toEqual([
			["library/overview", 0],
			["library/integer", 0],
			["library/list", 0],
		])
	})

	it("omits a section with no pages", () => {
		let sidebar = getSidebar(entries.filter((e) => e.data.section !== "guides"))

		expect(sidebar.map((section) => section.id)).not.toContain("guides")
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
