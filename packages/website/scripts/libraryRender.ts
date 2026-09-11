/*
 * A library page as MDX, and the manifest that goes beside it.
 *
 * The page is a skeleton of headings and component calls: the components draw
 * what goes under each heading from the manifest, so a signature is written in
 * exactly one place. The headings themselves are Markdown on purpose. Astro
 * collects a page's headings from its Markdown — never from JSX — for the
 * on-page rail and for the search index, and a member heading written as an
 * `<h3>` element would be invisible to both.
 *
 * ── Two ids per heading ─────────────────────────────────────────────────────
 *
 * A reader arrives at a member with its name as hover or completion spelled
 * it, so `/docs/library/list#firstItem` has to land. Astro gives a Markdown
 * heading the id github-slugger makes of its text — `firstitem`, always lower
 * case — and offers no way to set another without a plugin. So the heading
 * keeps that id, which is the lowercase alias the addressing scheme promises
 * as well, and its text is wrapped in a `<span>` that carries the name
 * verbatim. Both land on the same heading.
 *
 * The slugger is simulated here, for ASCII, which is all a heading here ever
 * is: the writer knows every id the rendered page will carry, records them in
 * the manifest, and refuses a page on which two things would carry the same
 * one. `tests/stdlibMembers.spec.ts` checks the simulation against the real
 * slugger.
 */

import type { PageManifest } from "./libraryManifest.ts"
import type { LibraryPage } from "./libraryPages.ts"

/** The first line of every generated body — and how `--sync` tells a generated page from a hand-written one. */
export const GENERATED_MARKER =
	"{/* Generated from packages/standard-library/sources by packages/website/scripts/generateStdlibDocs.ts. The description and the Taught on line are this page's own and survive --sync; everything else is rewritten by it. */}"

/*
 * The Language pages a type page says it is taught on, by title. Only the ones
 * `libraryTable.ts` names; a slug missing here stops the generator rather than
 * linking a page under the wrong name.
 */
const LANGUAGE_TITLES: Record<string, string> = {
	"language/programs-and-values": "Programs and values",
	"language/method-calls": "Method calls",
	"language/conditions": "Conditions",
	"language/records": "Records",
	"language/optional": "Optional",
	"language/result": "Result",
	"language/unions-and-type-aliases": "Unions and type aliases",
	"language/checked-refinements": "Checked refinements",
	"language/numbers": "Numbers",
	"language/lists": "Lists",
	"language/iteration": "Iteration",
	"language/dictionaries": "Dictionaries",
	"language/strings": "Strings",
	"language/protocols": "Protocols",
	"language/tests": "Tests",
}

/** What a page keeps across `--sync`: the parts a person wrote. */
export interface Preserved {
	/** The frontmatter value, exactly as written. */
	description?: string
	/** The whole "Taught on:" line. */
	taughtOn?: string
}

/*
 * github-slugger 2.0, for ASCII: lower case, every ASCII punctuation mark but
 * `-` and `_` removed, spaces made hyphens, and a repeat numbered `-1`, `-2`.
 */
const STRIPPED = /[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g

export class Slugger {
	private occurrences = new Map<string, number>()

	slug(text: string): string {
		if (/[^\x20-\x7e]/.test(text)) {
			throw new Error(
				`The heading "${text}" is not plain ASCII, and the slug simulation only covers ASCII. Teach it the rest of github-slugger before writing one.`,
			)
		}

		let base = text.toLowerCase().replace(STRIPPED, "").replace(/ /g, "-")
		let result = base

		while (this.occurrences.has(result)) {
			let count = this.occurrences.get(base)! + 1

			this.occurrences.set(base, count)
			result = `${base}-${count}`
		}

		this.occurrences.set(result, 0)

		return result
	}
}

/*
 * A brace outside a code span opens an expression in MDX and an angle bracket
 * opens an element, and a `§§` block that shows a Record — `{ x = 1 }` — or a
 * generic Type in prose would be read as one and fail the build. Inside a code
 * span they are already inert, so only the text between spans is escaped.
 */
function escapeMdx(text: string): string {
	return text
		.split(/(`[^`]*`)/)
		.map((part, index) =>
			index % 2 === 1
				? part
				: part.replace(/[{}<>]/g, (mark) => `\\${mark}`),
		)
		.join("")
}

/** YAML-safe on one line, whatever punctuation the text happens to carry. */
function quoted(text: string): string {
	return JSON.stringify(text.replace(/\s+/g, " ").trim())
}

function yamlList(items: string[]): string {
	return items.length === 0
		? " []"
		: `\n${items.map((item) => `  - ${quoted(item)}`).join("\n")}`
}

function taughtOnLine(slugs: string[]): string {
	let links = slugs.map((slug) => {
		let title = LANGUAGE_TITLES[slug]

		if (title === undefined) {
			throw new Error(
				`libraryTable.ts says a page is taught on ${slug}, which libraryRender.ts has no title for.`,
			)
		}

		return `[${title}](/docs/${slug})`
	})
	let joined =
		links.length <= 1
			? links.join("")
			: `${links.slice(0, -1).join(", ")} and ${links.at(-1)}`

	return `Taught on: ${joined}.`
}

/** The parts of an existing page `--sync` carries over. */
export function readPreserved(existing: string): Preserved {
	let frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(existing)?.[1] ?? ""
	let lines = frontmatter.split("\n")
	let preserved: Preserved = {}
	let start = lines.findIndex((line) => line.startsWith("description:"))

	if (start !== -1) {
		let value = [lines[start]!.slice("description:".length)]

		// A folded or quoted value runs on over indented lines.
		for (
			let index = start + 1;
			/^\s+\S/.test(lines[index] ?? "");
			index++
		) {
			value.push(lines[index]!)
		}

		preserved.description = value.join("\n").trim()
	}

	let taughtOn = /^Taught on: .*$/m.exec(existing)?.[0]

	if (taughtOn !== undefined) {
		preserved.taughtOn = taughtOn
	}

	return preserved
}

class Layout {
	private slugger = new Slugger()
	private taken = new Set<string>()
	readonly anchors: string[] = []

	constructor(private slug: string) {}

	/**
	 * A heading, and the ids it has to answer to beyond the one Astro gives it.
	 * Answers the Markdown line and the id Astro will give the heading.
	 */
	heading(
		depth: 2 | 3,
		text: string,
		wanted: string[] = [],
	): { line: string; id: string } {
		let id = this.slugger.slug(text)
		let extra = [...new Set(wanted)].filter((candidate) => candidate !== id)

		for (let candidate of [id, ...extra]) {
			if (this.taken.has(candidate)) {
				throw new Error(
					`Two things on library/${this.slug} would carry the id "${candidate}", so a link to it could land on either.`,
				)
			}

			this.taken.add(candidate)
			this.anchors.push(candidate)
		}

		// The first extra id wraps the text, so the element it names has a box
		// for a link to scroll to; any further ones sit empty in front of it.
		let [wrap, ...rest] = extra
		let inner =
			wrap === undefined ? text : `<span id="${wrap}">${text}</span>`
		let before = rest.map((candidate) => `<span id="${candidate}"></span>`)

		return { line: `${"#".repeat(depth)} ${before.join("")}${inner}`, id }
	}
}

function frontmatter(page: LibraryPage, preserved: Preserved): string {
	let manifest = page.manifest
	let fields: Array<[string, string]> = [
		["title", ` ${quoted(manifest.title)}`],
		[
			"description",
			` ${preserved.description ?? quoted(page.definition.description)}`,
		],
		["section", " library"],
		["order", ` ${page.definition.order}`],
		["template", " type"],
		["tocDepth", " 2"],
		["searchDepth", " 3"],
		["namespaces", yamlList(manifest.namespaces)],
		[
			"aliases",
			yamlList([
				...manifest.refinements.map((refinement) => refinement.name),
				...manifest.tower.map((alias) => alias.name),
			]),
		],
		[
			"conformsTo",
			yamlList(
				manifest.conformsTo.map((clause) =>
					clause.condition === null
						? clause.protocol
						: `${clause.protocol} where ${clause.condition}`,
				),
			),
		],
	]

	return `---\n${fields.map(([key, value]) => `${key}:${value}`).join("\n")}\n---\n`
}

export function renderPage(
	page: LibraryPage,
	preserved: Preserved = {},
): { mdx: string; manifest: PageManifest } {
	let manifest = page.manifest
	let slug = manifest.slug
	let layout = new Layout(slug)
	let body: string[] = [GENERATED_MARKER]
	let block = (...lines: string[]) => body.push("", ...lines)
	let component = (name: string, props: Record<string, unknown>) =>
		`<${name} ${Object.entries(props)
			.map(([key, value]) =>
				typeof value === "string"
					? `${key}=${JSON.stringify(value)}`
					: `${key}={${JSON.stringify(value)}}`,
			)
			.join(" ")} />`

	if (page.lede !== null) {
		for (let paragraph of page.lede.split(/\n{2,}/)) {
			block(escapeMdx(paragraph.trim()))
		}
	}

	block(preserved.taughtOn ?? taughtOnLine(page.definition.taughtOn))

	if (page.definition.note !== undefined) {
		block(page.definition.note)
	}

	if (manifest.choice !== null) {
		block(
			component("SignatureBlock", {
				label: "Declaration",
				signature: manifest.choice,
			}),
		)
	}

	block(component("MemberIndex", { page: slug }))

	if (manifest.kind !== "protocols") {
		block(layout.heading(2, "At a glance").line)
		block(component("AtAGlance", { page: slug }))
	}

	if (manifest.tower.length > 0) {
		block(layout.heading(2, "The tower").line)

		for (let alias of manifest.tower) {
			block(layout.heading(3, alias.name, [alias.name]).line)
			block(component("AliasEntry", { page: slug, name: alias.name }))
		}
	}

	let groups = manifest.groups.map((group) => ({ ...group }))
	let headed = new Map<string, string>()

	for (let group of groups) {
		if (manifest.kind === "protocols") {
			let protocol = manifest.protocols.find(
				(candidate) => candidate.name === group.label,
			)!

			let heading = layout.heading(2, group.label, [group.label])

			group.id = heading.id
			block(heading.line)
			block(component("ProtocolEntry", { name: group.label }))

			for (let name of protocol.headed) {
				block(layout.heading(3, name, [name, name.toLowerCase()]).line)
				block(component("MemberEntries", { page: slug, name }))
			}

			continue
		}

		let heading = layout.heading(2, group.label)

		group.id = heading.id
		block(heading.line)

		let later: string[] = []

		for (let member of group.members) {
			if (headed.has(member.name)) {
				if (headed.get(member.name) !== group.id) {
					later.push(
						`\`${member.name}\` on \`${member.receiver ?? member.namespace}\` is listed under [\`${member.name}\`](#${member.name}), with the other entries of that name.`,
					)
				}

				continue
			}

			headed.set(member.name, group.id)
			block(
				layout.heading(3, member.name, [
					member.name,
					member.name.toLowerCase(),
				]).line,
			)
			block(component("MemberEntries", { page: slug, name: member.name }))
		}

		for (let line of later) {
			block(line)
		}
	}

	if (manifest.refinements.length > 0) {
		block(layout.heading(2, "Refinements").line)
		block(
			`Each type below is a checked refinement: the compiler holds a value to its condition before the value has the type. [Checked refinements](/docs/language/checked-refinements) shows how a value earns one. Each section lists the methods above that return something tighter on it, and the methods that return it.`,
		)

		for (let refinement of manifest.refinements) {
			block(layout.heading(3, refinement.name, [refinement.name]).line)
			block(
				component("RefinementEntry", {
					page: slug,
					name: refinement.name,
				}),
			)
		}
	}

	if (manifest.modes.length > 0) {
		block(layout.heading(2, "Modes").line)

		if (manifest.modes.every((mode) => mode.payloadFree)) {
			block(
				`Each mode below is a choice whose cases carry no payload, passed to a method to pick how it works. Every mode has \`is\`, \`isNot\` and \`toString\`, and its type lists its cases with \`cases()\`. The sources write none of them: [Protocols](/docs/library/protocols#Enumerable) says where each comes from.`,
			)
		}

		for (let mode of manifest.modes) {
			block(layout.heading(3, mode.name, [mode.name]).line)
			block(component("ModeEntry", { page: slug, name: mode.name }))
		}
	}

	if (manifest.seeAlso.length > 0) {
		block(layout.heading(2, "See also").line)
		block(component("SeeAlso", { links: manifest.seeAlso }))
	}

	return {
		mdx: `${frontmatter(page, preserved)}\n${body.join("\n")}\n`,
		manifest: { ...manifest, groups, anchors: layout.anchors },
	}
}
