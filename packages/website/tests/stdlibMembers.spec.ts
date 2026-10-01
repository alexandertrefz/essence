import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import GithubSlugger from "github-slugger"

import {
	LIBRARY_DIRECTORY,
	serializeManifest,
} from "../scripts/generateStdlibDocs.ts"
import type { PageManifest } from "../scripts/libraryManifest.ts"
import { buildLibrary, loopLabel } from "../scripts/libraryPages.ts"
import {
	GENERATED_MARKER,
	readPreserved,
	renderPage,
} from "../scripts/libraryRender.ts"
import { readSurface } from "../scripts/stdlibSurface.ts"

/*
 * The standard library reference, held to the standard library page by page.
 * A new member fails this until `scripts/libraryTable.ts` groups it and
 * `bun run docs:stdlib:sync` writes it. A manifest listing a member the library
 * lacks fails too, as after a rename.
 *
 * The checks read each page's `library/<slug>.json` manifest, and the anchor
 * checks read the pages as Astro does. Pages are read as files, since
 * `astro:content` only resolves inside an Astro build.
 */

const SYNC = "Run `bun run docs:stdlib:sync` in packages/website."

let surface = readSurface()
let expected = buildLibrary(surface)
let files = readdirSync(LIBRARY_DIRECTORY)
let manifests = new Map(
	files
		.filter((name) => name.endsWith(".json"))
		.map((name) => [
			name.slice(0, -".json".length),
			JSON.parse(
				readFileSync(path.join(LIBRARY_DIRECTORY, name), "utf8"),
			) as PageManifest,
		]),
)
let pages = new Map(
	files
		.filter((name) => name.endsWith(".mdx"))
		.map((name) => [
			name.slice(0, -".mdx".length),
			readFileSync(path.join(LIBRARY_DIRECTORY, name), "utf8"),
		]),
)
let generatedPages = new Map(
	[...pages].filter(([, mdx]) => mdx.includes(GENERATED_MARKER)),
)

let listed = [...manifests.values()].flatMap((manifest) =>
	manifest.groups.flatMap((group) =>
		group.members.map((member) => ({
			page: manifest.slug,
			group: group.label,
			member,
		})),
	),
)

let key = (owner: string, name: string) => `${owner}::${name}`

/** Every entry the sources declare or a conformance provides, by the key a manifest lists it under. */
let signatures = new Map<string, string[]>()

for (let namespace of surface.namespaces) {
	for (let member of namespace.members) {
		signatures.set(
			key(namespace.name, member.name),
			member.entries.map((entry) => entry.signature),
		)
	}
}

for (let member of surface.provided) {
	signatures.set(
		key(member.namespace, member.name),
		member.entries.map((entry) => entry.signature),
	)
}

for (let family of surface.functions) {
	for (let entry of family.entries) {
		signatures.set(key(family.name, loopLabel(entry)), [entry.signature])
	}
}

for (let protocol of surface.protocols) {
	for (let method of protocol.methods) {
		signatures.set(
			key(protocol.name, method.name),
			method.entries.map((entry) => entry.signature),
		)
	}
}

/*
 * The ids a page's HTML will carry, found as Astro finds them. Each Markdown
 * heading's text, without its JSX, goes through github-slugger in page order,
 * and every explicit `id` counts. This is the real slugger the generator
 * simulates.
 */
function idsOf(mdx: string): string[] {
	let slugger = new GithubSlugger()
	let ids: string[] = []
	let fenced = false

	for (let line of mdx.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n")) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced
			continue
		}

		if (fenced) {
			continue
		}

		let heading = /^#{1,6} (.*)$/.exec(line)

		if (heading !== null) {
			ids.push(slugger.slug(heading[1]!.replace(/<[^>]*>/g, "")))
		}

		for (let match of line.matchAll(/\bid="([^"]+)"/g)) {
			ids.push(match[1]!)
		}
	}

	return ids
}

describe("the standard library reference", () => {
	it("lists every member, loop entry and Protocol method the library declares", () => {
		let have = new Set(listed.map(({ member }) => member.key))
		let declared = [
			...surface.namespaces.flatMap((namespace) =>
				namespace.members.map((member) =>
					key(namespace.name, member.name),
				),
			),
			...surface.functions.flatMap((family) =>
				family.entries.map((entry) =>
					key(family.name, loopLabel(entry)),
				),
			),
			...surface.protocols.flatMap((protocol) =>
				protocol.methods.map((method) =>
					key(protocol.name, method.name),
				),
			),
		]

		expect(
			declared.filter((entry) => !have.has(entry)),
			`These are declared and on no page. Give each a group in scripts/libraryTable.ts, then: ${SYNC}`,
		).toEqual([])
	})

	it("lists nothing the library does not declare or provide", () => {
		expect(
			listed
				.filter(({ member }) => !signatures.has(member.key))
				.map(({ page, member }) => `library/${page}: ${member.key}`),
			`These document something the standard library no longer has. ${SYNC}`,
		).toEqual([])
	})

	it("puts every member in exactly one group", () => {
		let places = new Map<string, string[]>()

		for (let { page, group, member } of listed) {
			places.set(member.key, [
				...(places.get(member.key) ?? []),
				`library/${page} › ${group}`,
			])
		}

		expect([...places].filter(([, where]) => where.length > 1)).toEqual([])
	})

	it("files every member on the page the placement rules give it", () => {
		let rule = new Map(
			expected.flatMap((page) =>
				page.manifest.groups.flatMap((group) =>
					group.members.map(
						(member) => [member.key, page.manifest.slug] as const,
					),
				),
			),
		)

		expect(
			listed
				.filter(({ page, member }) => rule.get(member.key) !== page)
				.map(
					({ page, member }) =>
						`${member.key} is on library/${page}, and belongs on library/${rule.get(member.key)}`,
				),
		).toEqual([])

		let slugs = expected.map((page) => page.manifest.slug).sort()

		expect([...generatedPages.keys()].sort(), SYNC).toEqual(slugs)
		expect([...manifests.keys()].sort(), SYNC).toEqual(slugs)
	})

	it("shows the signatures the sources declare", () => {
		let drifted = listed.flatMap(({ page, member }) => {
			let declared = signatures.get(member.key)
			let published = member.entries.map((entry) => entry.signature)

			return declared === undefined ||
				JSON.stringify(declared) === JSON.stringify(published)
				? []
				: [{ page, member: member.key, published, declared }]
		})

		expect(drifted, SYNC).toEqual([])
	})

	it("is what the generator writes from today's sources", () => {
		for (let page of expected) {
			let slug = page.manifest.slug
			let written = pages.get(slug)

			expect(
				written,
				`library/${slug}.mdx is missing. ${SYNC}`,
			).toBeDefined()

			let { mdx, manifest } = renderPage(page, readPreserved(written!))

			expect(
				manifests.get(slug),
				`library/${slug}.json is not what the sources give. ${SYNC}`,
			).toEqual(JSON.parse(serializeManifest(manifest)))
			expect(
				written,
				`library/${slug}.mdx is not what the sources give. ${SYNC}`,
			).toBe(mdx)
		}
	})

	it("hands MDX no quoted prop with an escape in it", () => {
		// A quoted MDX attribute is taken literally, so an escape such as `\n`
		// in one would render as text.
		let escaped = [...pages]
			.filter(([, mdx]) => /\s\w+="(?:[^"\\]|\\.)*\\[nt]/.test(mdx))
			.map(([slug]) => slug)

		expect(escaped).toEqual([])
	})
})

describe("the library's addresses", () => {
	let ids = new Map(
		[...generatedPages].map(([slug, mdx]) => [slug, idsOf(mdx)]),
	)

	it("records in each manifest exactly the ids its page carries, each once", () => {
		for (let [slug, found] of ids) {
			expect(
				found.filter((id, index) => found.indexOf(id) !== index),
				`library/${slug} carries an id twice`,
			).toEqual([])
			expect([...found].sort(), `library/${slug}`).toEqual(
				[...(manifests.get(slug)?.anchors ?? [])].sort(),
			)
		}
	})

	it("answers a member by its name verbatim and lower-cased, and a group by its slug", () => {
		let missing = [...manifests.values()].flatMap((manifest) => {
			let carried = new Set(ids.get(manifest.slug) ?? [])
			let wanted =
				manifest.kind === "protocols"
					? manifest.protocols.flatMap((protocol) => [
							protocol.name,
							...protocol.headed.flatMap((name) => [
								name,
								name.toLowerCase(),
							]),
						])
					: [
							...manifest.groups.flatMap((group) => [
								group.id,
								...group.members.flatMap((member) => [
									member.name,
									member.name.toLowerCase(),
								]),
							]),
						]

			return wanted
				.filter((id) => !carried.has(id))
				.map((id) => `/docs/library/${manifest.slug}#${id}`)
		})

		expect(missing).toEqual([])
	})

	it("answers every refinement, mode and union alias by its name", () => {
		let missing = [...manifests.values()].flatMap((manifest) => {
			let carried = new Set(ids.get(manifest.slug) ?? [])

			return [
				...manifest.refinements.map((refinement) => refinement.name),
				...manifest.modes.map((mode) => mode.name),
				...manifest.tower.map((alias) => alias.name),
			]
				.filter((id) => !carried.has(id))
				.map((id) => `/docs/library/${manifest.slug}#${id}`)
		})

		expect(missing).toEqual([])
	})

	it("gives the loop entries and Step the addresses the link register lists", () => {
		let carried = new Set(ids.get("loop") ?? [])

		expect(
			[
				"while",
				"until",
				"through",
				"upTo",
				"downTo",
				"step",
				"through-step",
				"upTo-step",
				"downTo-step",
				"Step",
			].filter((id) => !carried.has(id)),
		).toEqual([])
	})

	it("links only to addresses the library's pages carry", () => {
		let hrefs = [...generatedPages].flatMap(([slug, mdx]) => [
			...[...mdx.matchAll(/\]\((\/docs\/library\/[^)\s]+)\)/g)].map(
				(match) => ({ from: slug, href: match[1]! }),
			),
			...[
				...JSON.stringify(manifests.get(slug)).matchAll(
					/"(\/docs\/library\/[^"]+)"/g,
				),
			].map((match) => ({ from: slug, href: match[1]! })),
		])

		let broken = hrefs.filter(({ href }) => {
			let [target, anchor] = href
				.slice("/docs/library/".length)
				.split("#")
			let carried = ids.get(target!)

			if (carried === undefined) {
				return !pages.has(target!) || anchor !== undefined
			}

			return anchor !== undefined && !carried.includes(anchor)
		})

		expect([
			...new Set(
				broken.map(({ from, href }) => `library/${from} → ${href}`),
			),
		]).toEqual([])
	})
})

/*
 * The signatures the overview quotes, held to the library pages'. They sit in
 * a `§ fragment` block, which `docsExamples.spec.ts` never compiles. So each
 * quoted line must be a signature `list.json` carries, as the sources spell it.
 */
describe("The overview's quoted signatures", () => {
	it("quotes List signatures the library page carries", () => {
		let overview = readFileSync(
			path.join(LIBRARY_DIRECTORY, "overview.mdx"),
			"utf8",
		)
		let fragment = /```essence\n§ fragment\n([\s\S]*?)```/.exec(overview)

		expect(fragment).not.toBeNull()

		// An entry may span lines as the sources have it: a continuation is
		// indented or is the closing `)`. So entries are gathered, not read by
		// line.
		let quoted: Array<string> = []

		for (let line of (fragment![1] as string).split("\n")) {
			if (/^[a-z][A-Za-z0-9]*[<(]/.test(line)) {
				quoted.push(line)
			} else if (quoted.length > 0 && /^[\t)]/.test(line)) {
				quoted[quoted.length - 1] += `\n${line}`
			}
		}

		let signatures = JSON.stringify(manifests.get("list"))

		expect(quoted.length).toBeGreaterThan(3)
		expect(
			quoted.filter(
				(entry) =>
					!signatures.includes(JSON.stringify(entry).slice(1, -1)),
			),
		).toEqual([])
	})
})
