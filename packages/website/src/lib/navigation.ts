/*
 * The shape of the documentation: its sections and their order, a page's place
 * in the reading chain, and its name in a breadcrumb. Nothing
 * here imports `astro:content`, so specs can pass entries in directly.
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
 * The order of the sidebar and of the prev/next chain. The ids mirror the
 * `section` enum in `src/content.config.ts`, and a section missing here is a
 * type error.
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
 * The templates whose pages are read in order. `type` and `reference` pages are
 * looked up rather than read through, so the chain skips them.
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
		/** The labelled run a top-level page sits in. See `groupsIn`. */
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
 * A page in the rail, with whatever is nested under it. Only the file tree
 * nests: `guides/projects/settings` would be a child of `guides/projects`.
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
	 * The same pages split into their labelled runs, or empty when no page
	 * names a group. Laid end to end, the groups' items are `items`, so the
	 * rail never disagrees with the reading chain.
	 */
	groups: SidebarGroup[]
}

export interface Crumb {
	label: string
	href?: string
	/** The last crumb: the page you are on. */
	current?: boolean
}

/** One line of the on-this-page list. Structurally Astro's `MarkdownHeading`. */
export interface TocItem {
	depth: number
	slug: string
	text: string
}

/**
 * The headings a page shows in its on-this-page list: `##` and deeper, down to
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
 * A guide's on-this-page list: its steps and its headings, in page order. Astro
 * does not collect a step's `<h2>`, so steps are read off the source and the
 * headings slotted in. If the two readings disagree about the headings, the
 * list falls back to the headings alone.
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

// `order` decides, and the title breaks ties so the order is stable across
// builds.
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
 * The id of the page an entry hangs off in the sidebar, or null. The parent
 * must be in the same section, since the sidebar is built a section at a time.
 */
export function parentOf(
	entry: DocEntryLike,
	within: ReadonlySet<string>,
): string | null {
	let parent = parentId(entry.id)

	return parent !== null && within.has(parent) ? parent : null
}

/** The pages of a section that hang off nothing: the roots of its tree. */
function topLevelIn(
	entries: readonly DocEntryLike[],
	section: SectionId,
): DocEntryLike[] {
	let inSection = entriesIn(entries, section)
	let ids = new Set(inSection.map((entry) => entry.id))

	return inSection.filter((entry) => parentOf(entry, ids) === null)
}

/*
 * A section's top-level pages as runs of neighbours naming the same `group`.
 * A section groups all its top-level pages or none, and a label names one run.
 * Breaking either throws, since the rail would draw the mistake as deliberate.
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
 * The sidebar tree: sections in order, empty ones omitted, each page carrying
 * its children, split into labelled runs. A page whose parent is missing goes
 * to the top of its section, so it stays reachable.
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

			// A nested page is drawn under its parent, so its own `group` would
			// do nothing, and frontmatter that does nothing is refused.
			if (entry.data.group !== undefined) {
				throw new Error(
					`${entry.id} names the group "${entry.data.group}", but it is written under ${parent}, and only a section's top-level pages are grouped. Take \`group\` off it: it sits wherever ${parent} does.`,
				)
			}

			children.set(parent, [...(children.get(parent) ?? []), entry])
		}

		// The file tree bounds the depth, and each id is visited once.
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
 * The guided path in reading order: the sidebar's order, keeping only pages
 * that are read rather than looked up. It ends at the last guide.
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
 * `Docs / Section / Title`, the section linking its first page. A nested page
 * also shows its parent.
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
