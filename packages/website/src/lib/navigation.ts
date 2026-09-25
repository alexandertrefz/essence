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
	| "library"
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
	{ id: "getting-started", label: "Getting started" },
	{ id: "language", label: "Language" },
	{ id: "library", label: "Library" },
	{ id: "guides", label: "Guides" },
	{ id: "reference", label: "Reference" },
]

export type Template = "article" | "guide" | "reference" | "type"

/**
 * The templates whose pages are read in order. A `type` page and a `reference`
 * page are lookup tables — nobody reads `List` and then turns the page to
 * `Dictionary` — so the chain skips them wherever they sit: it runs through
 * the library's overview and past its type pages.
 */
const CHAINED_TEMPLATES: ReadonlySet<Template> = new Set(["article", "guide"])

export const DOCS_ROOT = "/docs"

/** The part of a collection entry the navigation actually reads. */
export interface DocEntryLike {
	id: string
	data: {
		title: string
		description: string
		section: SectionId
		order: number
		template: Template
		/** The labelled run a top-level page sits in — see `groupsIn`. */
		group?: string
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
 * The file tree is the only relation that nests: `guides/projects/settings`
 * would be a child of `guides/projects` because that is where it is written,
 * so moving a page is what moves it in the navigation and the two cannot
 * disagree. Nothing published today nests — every section is a flat list.
 */
export interface SidebarItem extends DocLink {
	children: SidebarItem[]
}

/**
 * A labelled run of a section's top-level pages: the Language section's
 * "Basics", "Modelling data" and the rest.
 */
export interface SidebarGroup {
	label: string
	items: SidebarItem[]
}

export interface SidebarSection extends Section {
	/** Every top-level page of the section, in order, grouped or not. */
	items: SidebarItem[]
	/**
	 * The same pages split into their labelled runs, or empty for a section
	 * whose pages name no group. Laid end to end, the groups' items are `items`.
	 *
	 * NOTE: Beside the flat list rather than instead of it, and a label laid
	 * over the order rather than a sort of its own. The reading chain, the
	 * breadcrumbs, the hub and search each put a section's pages in `order`
	 * without ever seeing a group, so a grouping that moved a page in the rail
	 * would have the rail disagree with that page's own next link.
	 */
	groups: SidebarGroup[]
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

/** The anchor a guide step's title is reached by, unless the step names its own. */
export function stepAnchor(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

const STEP_ITEM = /^<StepItem\s/
const STEP_TITLE = /\stitle="([^"]*)"/
const STEP_ID = /\sid="([^"]*)"/
const HEADING = /^#{1,6}\s/
const FENCE = /^(`{3,}|~{3,})/

/**
 * A guide's on-this-page list: its steps and its own headings, in the order the
 * page takes them.
 *
 * NOTE: A step's title is a component's `<h2>`, not Markdown, so it is not
 * among the `headings` Astro collects — and a guide is read by its steps, so a
 * list without them would name only what comes before and after the work. The
 * steps are read off the page's source instead, and the collected headings are
 * slotted in where their Markdown stands. Where the two readings disagree about
 * how many headings the page has, the source was read wrong, and the list falls
 * back to the headings alone rather than put one where it does not stand.
 */
export function getGuideToc(
	body: string,
	headings: readonly TocItem[],
	maxDepth: number,
): TocItem[] {
	let items: TocItem[] = []
	let pending = [...headings]
	let fence: string | undefined

	for (let line of body.split("\n")) {
		let marker = FENCE.exec(line)?.[1]

		if (fence !== undefined) {
			if (
				marker !== undefined &&
				marker[0] === fence[0] &&
				marker.length >= fence.length
			) {
				fence = undefined
			}

			continue
		}

		if (marker !== undefined) {
			fence = marker

			continue
		}

		let title = STEP_ITEM.test(line)
			? STEP_TITLE.exec(line)?.[1]
			: undefined

		if (title !== undefined) {
			items.push({
				depth: 2,
				slug: STEP_ID.exec(line)?.[1] ?? stepAnchor(title),
				text: title,
			})

			continue
		}

		if (HEADING.test(line)) {
			let heading = pending.shift()

			if (heading === undefined) {
				return getToc(headings, maxDepth)
			}

			if (heading.depth >= 2 && heading.depth <= maxDepth) {
				items.push(heading)
			}
		}
	}

	return pending.length === 0 ? items : getToc(headings, maxDepth)
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

/** The id of the page an entry is written under, or null when it is not. */
export function parentId(id: string): string | null {
	let segments = id.split("/")

	return segments.length > 2 ? segments.slice(0, -1).join("/") : null
}

/**
 * The id of the page an entry hangs off in the sidebar, or null when it stands
 * on its own. The parent has to be a page of the same section — the sidebar is
 * built a section at a time, and a branch that crossed between them could not
 * be drawn.
 */
export function parentOf(
	entry: DocEntryLike,
	within: ReadonlySet<string>,
): string | null {
	let parent = parentId(entry.id)

	return parent !== null && within.has(parent) ? parent : null
}

/** The pages of a section that hang off nothing — the roots of its tree. */
function topLevelIn(
	entries: readonly DocEntryLike[],
	section: SectionId,
): DocEntryLike[] {
	let inSection = entriesIn(entries, section)
	let ids = new Set(inSection.map((entry) => entry.id))

	return inSection.filter((entry) => parentOf(entry, ids) === null)
}

/*
 * A section's top-level pages as labelled runs, in the order they already
 * have: each run is the pages next to one another that name the same `group`.
 *
 * NOTE: A section groups every one of its top-level pages or none of them, and
 * a label names one run. Breaking either throws rather than drawing something,
 * because what would be drawn looks deliberate: a page without a group would
 * sit under the heading of whichever run it followed, and a label that came
 * back after another run would put the same heading in the rail twice. Both
 * are what the next page a writer adds is likely to do — a new Language page
 * with no `group`, or an `order` that lands inside another run — and a build
 * that names the page is the one place that mistake would be seen.
 */
function groupsIn(
	section: Section,
	pages: readonly { entry: DocEntryLike; item: SidebarItem }[],
): SidebarGroup[] {
	if (pages.every(({ entry }) => entry.data.group === undefined)) {
		return []
	}

	let groups: SidebarGroup[] = []

	for (let { entry, item } of pages) {
		let label = entry.data.group

		if (label === undefined) {
			throw new Error(
				`${entry.id} has no \`group\`, but other ${section.label} pages name one. A section groups every top-level page or none of them: give it the group it belongs in.`,
			)
		}

		let last = groups.at(-1)

		if (last !== undefined && last.label === label) {
			last.items.push(item)

			continue
		}

		if (groups.some((group) => group.label === label)) {
			throw new Error(
				`${entry.id} is in the group "${label}", but pages of another group come between it and the rest of "${label}". A group is one run of pages in \`order\`: move this page's \`order\` next to theirs, or change its group.`,
			)
		}

		groups.push({ label, items: [item] })
	}

	return groups
}

/*
 * The sidebar tree: sections in the fixed order, empty ones omitted, each
 * section's pages carrying whatever hangs off them, to any depth, and split
 * into their labelled runs where the pages name them.
 *
 * A page whose parent does not exist is promoted to the top of its section
 * rather than dropped. It is a mistake either way, but a mistake that leaves a
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

			// NOTE: A page written under another is drawn under it, whatever
			// run its parent is in, so a `group` of its own would do nothing —
			// and frontmatter that does nothing is refused, as the schema
			// refuses a key it does not name.
			if (entry.data.group !== undefined) {
				throw new Error(
					`${entry.id} names the group "${entry.data.group}", but it is written under ${parent}, and only a section's top-level pages are grouped. Take \`group\` off it: it sits wherever ${parent} does.`,
				)
			}

			children.set(parent, [...(children.get(parent) ?? []), entry])
		}

		// Depth is bounded by the file tree and every id is visited once as
		// somebody's child, so this cannot run away.
		let build = (entry: DocEntryLike): SidebarItem => ({
			...toDocLink(entry),
			children: (children.get(entry.id) ?? []).map(build),
		})

		let pages = topLevelIn(entries, section.id).map((entry) => ({
			entry,
			item: build(entry),
		}))

		if (pages.length === 0) {
			return []
		}

		return [
			{
				...section,
				items: pages.map(({ item }) => item),
				groups: groupsIn(section, pages),
			},
		]
	})
}

/*
 * Every page that is part of the guided path, flattened in reading order:
 * the sidebar's order, keeping only the templates that are read rather than
 * looked up. It runs Getting started → Language → the library's overview →
 * Guides and stops at the last guide; the reference never joins it.
 */
export function getReadingChain(entries: readonly DocEntryLike[]): DocLink[] {
	return SECTIONS.flatMap((section) =>
		entriesIn(entries, section.id).filter((entry) =>
			CHAINED_TEMPLATES.has(entry.data.template),
		),
	).map(toDocLink)
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
 * the page in between for one written under another, so it says where it is.
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
