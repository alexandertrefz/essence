/*
 * The index the ⌘K palette fetches, built at build time, since the site is
 * static and small. One entry per docs page with its headings, so a query can
 * land on a section. `searchDepth` limits the headings and defaults to
 * `tocDepth`. A library type page sets it deeper, so its members are found by
 * name.
 */

import type { APIRoute } from "astro"
import { getCollection, render } from "astro:content"

import { SECTIONS } from "../content.config.ts"

type Section = (typeof SECTIONS)[number]

// The heading a result groups under. These copy the labels in
// `lib/navigation.ts`, which this route could import instead. The order travels
// to the browser as `groupOrder` on every entry.
const SECTION_LABELS: Record<Section, string> = {
	"getting-started": "Getting started",
	language: "Language",
	library: "Library",
	guides: "Guides",
	reference: "Reference",
}

interface IndexHeading {
	text: string
	slug: string
}

interface IndexEntry {
	title: string
	url: string
	/** Section label, e.g. `Library`. */
	group: string
	/** The label's position in the fixed section order. */
	groupOrder: number
	/** `docs / language / lists`, `reference / …` for the reference. */
	crumb: string
	/** A type page's title is code (`List`) and sets the mono face. */
	mono: boolean
	headings: IndexHeading[]
}

export const GET: APIRoute = async () => {
	let docs = await getCollection("docs")

	let ordered = [...docs].sort(
		(a, b) =>
			SECTIONS.indexOf(a.data.section) -
				SECTIONS.indexOf(b.data.section) ||
			a.data.order - b.data.order ||
			a.data.title.localeCompare(b.data.title),
	)

	let entries: IndexEntry[] = []

	for (let entry of ordered) {
		let { headings } = await render(entry)
		let segments = entry.id.split("/")

		entries.push({
			title: entry.data.title,
			url: `/docs/${entry.id}`,
			group: SECTION_LABELS[entry.data.section],
			groupOrder: SECTIONS.indexOf(entry.data.section),
			// The reference is its own root in the crumb, not filed under
			// `docs /`.
			crumb: (entry.data.section === "reference"
				? segments
				: ["docs", ...segments]
			).join(" / "),
			mono: entry.data.template === "type",
			headings: headings
				.filter(
					(heading) =>
						heading.depth >= 2 &&
						heading.depth <= entry.data.searchDepth,
				)
				.map((heading) => ({
					text: heading.text,
					slug: heading.slug,
				})),
		})
	}

	return new Response(JSON.stringify(entries), {
		headers: { "content-type": "application/json; charset=utf-8" },
	})
}
