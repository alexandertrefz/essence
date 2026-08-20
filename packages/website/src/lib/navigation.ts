/*
 * The shape of the documentation: which sections exist, in what order, where a
 * page sits in the reading chain, and how it is named in a breadcrumb.
 *
 * Nothing here imports `astro:content`. Every function takes the entries it
 * works on, so the ordering rules are readable — and testable — on their own,
 * and a page never has to know how the collection is loaded.
 */

export type SectionId =
	| "getting-started"
	| "language"
	| "standard-library"
	| "guides"
	| "reference"

export interface Section {
	id: SectionId
	label: string
}

/**
 * The one place the sidebar's order lives.
 *
 * NOTE: The ids mirror the `section` enum in `src/content.config.ts`, but the
 * order is this file's alone — it is the sidebar's order and the prev/next
 * chain's. Adding a section there without adding it here is a type error at
 * every call site rather than a silently missing group.
 */
export const SECTIONS: readonly Section[] = [
	{ id: "getting-started", label: "Getting Started" },
	{ id: "language", label: "Language" },
	{ id: "standard-library", label: "Standard Library" },
	{ id: "guides", label: "Guides" },
	{ id: "reference", label: "Reference" },
]

/**
 * The reference is a lookup table, not a chapter, so it is left out of the
 * prev/next chain — nobody reads `Integer::add` and then turns the page.
 */
const UNCHAINED_SECTION: SectionId = "reference"

export const DOCS_ROOT = "/docs"

/** The part of a collection entry the navigation actually reads. */
export interface DocEntryLike {
	id: string
	data: {
		title: string
		description: string
		section: SectionId
		order: number
		/** The id of the page this one is a case of; see `SidebarItem`. */
		nestUnder?: string | undefined
	}
}

export interface DocLink {
	id: string
	title: string
	description: string
	href: string
}

/**
 * A page in the rail, with whatever is nested under it.
 *
 * Two relations put a page under another, and they answer different questions.
 *
 * The file tree is the first: `standard-library/integer/add` is a child of
 * `standard-library/integer` because that is where it is written, so moving a
 * page is what moves it in the navigation and the two cannot disagree.
 *
 * `nestUnder` is the second, for a relationship the URLs do not have. `Integer`
 * is a case of `Number` — the standard library declares the union — but it does
 * not live inside it, and burying its URL under `number/` would say that it did.
 * So the reading tree says so and the addresses stay flat.
 *
 * Children are themselves items, because both relations can apply at once:
 * Number holds Integer, and Integer holds its own Methods.
 */
export interface SidebarItem extends DocLink {
	children: SidebarItem[]
	/**
	 * Whether this page is a case of the one above it rather than something
	 * written inside it — `Integer` under `Number`, as against `Integer::add`
	 * under `Integer`.
	 *
	 * The rail treats the two differently, because they are different: the cases
	 * of a union are how you get around the standard library, and there are four
	 * of them, so they show whenever their union is on the way to wherever you
	 * are. A type's Methods are the content, and there are 179 of them, so they
	 * show only for the type you are actually reading.
	 */
	structural: boolean
}

export interface SidebarSection extends Section {
	items: SidebarItem[]
}

export interface Crumb {
	label: string
	href?: string
	/** The last crumb — the page you are on. */
	current?: boolean
}

/** One line of the on-this-page list. Structurally Astro's `MarkdownHeading`. */
export interface TocItem {
	depth: number
	slug: string
	text: string
}

/**
 * The headings a page shows in its on-this-page list: `##` and below, down to
 * the depth the entry asked for. `#` is the page title, which is never in it.
 */
export function getToc(
	headings: readonly TocItem[],
	maxDepth: number,
): TocItem[] {
	return headings.filter(
		(heading) => heading.depth >= 2 && heading.depth <= maxDepth,
	)
}

export function docHref(id: string): string {
	return `${DOCS_ROOT}/${id}`
}

export function sectionLabel(id: SectionId): string {
	return SECTIONS.find((section) => section.id === id)?.label ?? id
}

export function toDocLink(entry: DocEntryLike): DocLink {
	return {
		id: entry.id,
		title: entry.data.title,
		description: entry.data.description,
		href: docHref(entry.id),
	}
}

// `order` is the author's intent; the title only settles ties so that two
// pages sharing a number still come out in a stable order across builds.
function byOrder(a: DocEntryLike, b: DocEntryLike): number {
	return (
		a.data.order - b.data.order || a.data.title.localeCompare(b.data.title)
	)
}

function entriesIn(
	entries: readonly DocEntryLike[],
	section: SectionId,
): DocEntryLike[] {
	return entries
		.filter((entry) => entry.data.section === section)
		.sort(byOrder)
}

/**
 * The id of the page an entry is nested under, or null when it stands on its
 * own. `standard-library/integer/add` hangs off `standard-library/integer` by
 * where it is written; `standard-library/integer` hangs off
 * `standard-library/number` because it says so. A `nestUnder` that names a page
 * outside the entry's own section is ignored — the sidebar is built a section at
 * a time, and a branch that crossed between them could not be drawn.
 */
export function parentOf(
	entry: DocEntryLike,
	within: ReadonlySet<string>,
): string | null {
	let declared = entry.data.nestUnder

	if (declared !== undefined && within.has(declared)) {
		return declared
	}

	let segments = entry.id.split("/")
	let parent = segments.length > 2 ? segments.slice(0, -1).join("/") : null

	return parent !== null && within.has(parent) ? parent : null
}

/** The path relation alone — what a breadcrumb follows, since it follows URLs. */
export function parentId(id: string): string | null {
	let segments = id.split("/")

	return segments.length > 2 ? segments.slice(0, -1).join("/") : null
}

/*
 * The pages of a section that hang off nothing — the roots of its tree.
 *
 * `order` only ever sorts a page against its siblings, so a Member's number and
 * a type's are not comparable — `Algebraic::is` is the zeroth Member of its
 * type, and sorting it against the section put it in front of every type page.
 * That is what "the first page of the standard library" resolved to before this,
 * which is a link nobody meant to publish.
 */
function topLevelIn(
	entries: readonly DocEntryLike[],
	section: SectionId,
): DocEntryLike[] {
	let inSection = entriesIn(entries, section)
	let ids = new Set(inSection.map((entry) => entry.id))

	return inSection.filter((entry) => parentOf(entry, ids) === null)
}

/*
 * The sidebar tree: sections in the fixed order, empty ones omitted, each
 * section's pages carrying whatever hangs off them, to any depth.
 *
 * A page whose parent does not exist is promoted to the top of its section
 * rather than dropped. It is a mistake either way — the gate in
 * `tests/stdlibMembers.spec.ts` is what names it — but a mistake that leaves a
 * page reachable is the better of the two.
 */
export function getSidebar(entries: readonly DocEntryLike[]): SidebarSection[] {
	return SECTIONS.flatMap((section) => {
		let inSection = entriesIn(entries, section.id)
		let ids = new Set(inSection.map((entry) => entry.id))
		let children = new Map<string, DocEntryLike[]>()

		for (let entry of inSection) {
			let parent = parentOf(entry, ids)

			if (parent === null) {
				continue
			}

			children.set(parent, [...(children.get(parent) ?? []), entry])
		}

		let isCase = (entry: DocEntryLike) => entry.data.nestUnder !== undefined

		// Depth is bounded by the content — a section, its types, their cases,
		// their Members — and every id is visited once as somebody's child, so
		// this cannot run away.
		let build = (entry: DocEntryLike): SidebarItem => ({
			...toDocLink(entry),
			structural: isCase(entry),
			/*
			 * Cases first, then Methods. Both are sorted by `order`, and those
			 * numbers are not comparable across the two — `Number.Pi` is its zeroth
			 * Member and `Integer` is the tenth type, so left to one list the four
			 * cases of the tower came out interleaved with the sixteen Methods of
			 * the union they are cases of.
			 */
			children: (children.get(entry.id) ?? [])
				.slice()
				.sort(
					(a, b) =>
						Number(isCase(b)) - Number(isCase(a)) || byOrder(a, b),
				)
				.map(build),
		})

		let items = topLevelIn(entries, section.id).map(build)

		return items.length === 0 ? [] : [{ ...section, items }]
	})
}

/*
 * Every page that is part of the guided path, flattened in reading order.
 *
 * Members are left out along with the whole reference: a type's Methods are a
 * list to look things up in, and turning the page from `Integer::add` to
 * `Integer::subtract` is not something anybody does. Their type pages stay in,
 * so the chain still runs through the standard library.
 */
export function getReadingChain(entries: readonly DocEntryLike[]): DocLink[] {
	return SECTIONS.filter((section) => section.id !== UNCHAINED_SECTION)
		.flatMap((section) => topLevelIn(entries, section.id))
		.map(toDocLink)
}

export function getPrevNext(
	entries: readonly DocEntryLike[],
	currentId: string,
): { previous?: DocLink; next?: DocLink } {
	let chain = getReadingChain(entries)
	let index = chain.findIndex((link) => link.id === currentId)

	if (index === -1) {
		return {}
	}

	return { previous: chain[index - 1], next: chain[index + 1] }
}

/**
 * `Docs / Section / Title`, with the section pointing at its first page — and
 * the type in between for a Member, so `Integer::add` says which Integer.
 */
export function getCrumbs(
	entries: readonly DocEntryLike[],
	currentId: string,
): Crumb[] {
	let current = entries.find((entry) => entry.id === currentId)

	if (current === undefined) {
		return [{ label: "Docs", href: DOCS_ROOT }]
	}

	let sectionId = current.data.section
	let first = topLevelIn(entries, sectionId)[0]
	let parent = parentId(currentId)
	let parentEntry =
		parent === null
			? undefined
			: entries.find((entry) => entry.id === parent)

	return [
		{ label: "Docs", href: DOCS_ROOT },
		{
			label: sectionLabel(sectionId),
			href: first === undefined ? undefined : docHref(first.id),
		},
		...(parentEntry === undefined
			? []
			: [
					{
						label: parentEntry.data.title,
						href: docHref(parentEntry.id),
					},
				]),
		{ label: current.data.title, current: true },
	]
}
