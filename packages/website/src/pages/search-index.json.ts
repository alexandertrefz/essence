/*
 * The index the ⌘K palette fetches, built once at build time — there is no
 * server behind this site, and it is far too small to want a search engine.
 *
 * One entry per docs page, carrying the page's own headings so a query can
 * land on a section rather than only on a page. The palette deep-links a
 * heading hit with `#slug`; `searchDepth` decides how deep that goes. It
 * defaults to `tocDepth`, so a page that hides its h3s from the on-this-page
 * list keeps them out of search too — unless it says otherwise, which is what
 * a library type page does: its rail shows the reader groups, and its eighty
 * member headings still have to be findable by name.
 */

import type { APIRoute } from "astro"
import { getCollection, render } from "astro:content"

import { SECTIONS } from "../content.config.ts"

type Section = (typeof SECTIONS)[number]

// NOTE: The heading a result groups under: a second copy of the labels in
// `SECTIONS` of `lib/navigation.ts`, which this build-time route could import
// instead. The order travels to the browser as `groupOrder` on every entry.
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
			// The reference is its own root in the crumb: an entry there is
			// looked up, not read as a page filed under `docs /`.
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
