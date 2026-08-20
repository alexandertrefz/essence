/*
 * The index the ⌘K palette fetches, built once at build time — there is no
 * server behind this site, and it is far too small to want a search engine.
 *
 * One entry per docs page, carrying the page's own headings so a query can
 * land on a section rather than only on a page. The palette deep-links a
 * heading hit with `#slug`; `tocDepth` decides how deep that goes, so a page
 * that hides its h3s from the on-this-page list does not smuggle them back in
 * through search (the diagnostics page and its 95 codes is the case that
 * matters).
 */

import type { APIRoute } from "astro"
import { getCollection, render } from "astro:content"

import { SECTIONS } from "../content.config.ts"

type Section = (typeof SECTIONS)[number]

// NOTE: The heading a result groups under. It duplicates the sidebar's labels
// rather than importing them, because the grouping order has to survive into
// the browser: `lib/` may not import `astro:content`, and the palette's client
// script must not pull the content collection into the page bundle. The order
// itself travels as `groupOrder` on every entry.
const SECTION_LABELS: Record<Section, string> = {
	"getting-started": "Getting Started",
	language: "Language",
	"standard-library": "Standard Library",
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
	/** Section label, e.g. `Standard Library`. */
	group: string
	/** The label's position in the fixed section order. */
	groupOrder: number
	/** `docs / language / pattern-matching`, `reference / …` for the reference. */
	crumb: string
	/** A reference title that is code (`Integer::add`) sets the mono face. */
	mono: boolean
	headings: IndexHeading[]
}

/*
 * A Member's results group under its type rather than under the section.
 *
 * The palette caps a group at four rows so that one exhaustive page cannot own
 * the results. With 179 Members filed under one label that cap became the
 * opposite of what it is for: a query for `append` could show four results in
 * total, and whether `List::append` was among them was down to scoring. Grouped
 * by type, each of them competes with its own siblings — and the reader is told
 * which type every hit belongs to, which for a Method is most of the answer.
 *
 * The order is the section's, plus the type's own position scaled down small
 * enough to sort within it and never across it.
 */
function memberGroupOrder(sectionIndex: number, typeOrder: number): number {
	return sectionIndex + typeOrder / 10_000
}

export const GET: APIRoute = async () => {
	let docs = await getCollection("docs")
	let byId = new Map(docs.map((entry) => [entry.id, entry]))

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
		/*
		 * A standard library Member page's headings are its template — Parameters,
		 * Returns, See also — repeated identically on all 179 of them. Indexed,
		 * they would be 179 rows all called "Returns", crowding out whatever a
		 * query was actually looking for. The page itself is indexed under the
		 * name somebody would search for, which is the Method's.
		 */
		let isMember = entry.data.member !== undefined
		let sectionIndex = SECTIONS.indexOf(entry.data.section)
		let parent = isMember
			? byId.get(segments.slice(0, -1).join("/"))
			: undefined

		entries.push({
			title: entry.data.title,
			url: `/docs/${entry.id}`,
			group:
				parent === undefined
					? SECTION_LABELS[entry.data.section]
					: parent.data.title,
			groupOrder:
				parent === undefined
					? sectionIndex
					: memberGroupOrder(sectionIndex, parent.data.order),
			// The reference is its own root in the crumb: an entry there is
			// looked up, not read as a page filed under `docs /`.
			crumb: (entry.data.section === "reference"
				? segments
				: ["docs", ...segments]
			).join(" / "),
			mono: entry.data.monoTitle === true,
			headings: isMember
				? []
				: headings
						.filter(
							(heading) =>
								heading.depth >= 2 &&
								heading.depth <= entry.data.tocDepth,
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
