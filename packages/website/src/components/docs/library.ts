/*
 * The library pages' manifests, for the components that draw them.
 *
 * `scripts/generateStdlibDocs.ts` writes a `src/content/docs/library/<slug>.json`
 * beside every page it generates. They are read through Vite's glob import
 * rather than the content collection: the collection only takes the pages, and
 * a component wants one page's manifest by its slug.
 */

import type {
	ManifestMember,
	PageManifest,
} from "../../../scripts/libraryManifest.ts"

const manifests = import.meta.glob<PageManifest>(
	"../../content/docs/library/*.json",
	{ eager: true, import: "default" },
)

/** The manifest of `library/<slug>`, or undefined for a page that has none. */
export function findLibraryPage(slug: string): PageManifest | undefined {
	return manifests[`../../content/docs/library/${slug}.json`]
}

export function libraryPage(slug: string): PageManifest {
	let manifest = findLibraryPage(slug)

	if (manifest === undefined) {
		throw new Error(
			`library/${slug} has no manifest beside it. Run \`bun run docs:stdlib:sync\` in packages/website.`,
		)
	}

	return manifest
}

/** Every member of a page that carries `name`, in the order the page lists them. */
export function membersNamed(
	page: PageManifest,
	name: string,
): ManifestMember[] {
	return page.groups
		.flatMap((group) => group.members)
		.filter((member) => member.name === name)
}

/** The first sentence of a `§§` block, for a line that only has room for one. */
export function firstSentence(text: string): string {
	let paragraph = text.split(/\n{2,}/)[0] ?? ""
	let end = /[.!?](\s|$)/.exec(paragraph)

	return end === null ? paragraph : paragraph.slice(0, end.index + 1)
}
