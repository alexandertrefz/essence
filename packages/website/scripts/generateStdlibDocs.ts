/*
 * Writes the standard library reference: one page per type, and the member
 * manifest beside it.
 *
 *   bun scripts/generateStdlibDocs.ts          write the pages that do not exist yet
 *   bun scripts/generateStdlibDocs.ts --sync   rewrite every page from the sources
 *
 * A person writes only a page's `description` and its "Taught on" line; the
 * rest is regenerated. See "Generated pages" in DEVELOPMENT.md.
 */

import { spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import * as path from "node:path"

import { buildLibrary } from "./libraryPages.ts"
import { GENERATED_MARKER, readPreserved, renderPage } from "./libraryRender.ts"
import { readSurface } from "./stdlibSurface.ts"

export const LIBRARY_DIRECTORY = path.resolve(
	import.meta.dirname,
	"../src/content/docs/library",
)

const REPOSITORY = path.resolve(import.meta.dirname, "../../..")

/** The manifest as it is written, before the formatter lays it out. */
export function serializeManifest(manifest: unknown): string {
	return `${JSON.stringify(manifest, null, "\t")}\n`
}

function readIfThere(file: string): string | null {
	return existsSync(file) ? readFileSync(file, "utf8") : null
}

/** Whether a manifest on disk says what a new one says, however it is laid out. */
function sameManifest(existing: string | null, manifest: unknown): boolean {
	return (
		existing !== null &&
		JSON.stringify(JSON.parse(existing)) === JSON.stringify(manifest)
	)
}

/*
 * Formats the written manifests, so `bun run check` leaves a fresh tree alone.
 * Without the formatter they stay as written, which no reader minds.
 */
function format(files: string[]): void {
	let formatter = path.join(REPOSITORY, "node_modules/.bin/oxfmt")

	if (files.length === 0 || !existsSync(formatter)) {
		return
	}

	let result = spawnSync(formatter, ["--write", ...files], {
		cwd: REPOSITORY,
		encoding: "utf8",
	})

	if (result.status !== 0) {
		throw new Error(
			`oxfmt could not lay out the manifests:\n${result.stdout}${result.stderr}`,
		)
	}
}

function main(): void {
	let sync = process.argv.includes("--sync")
	let surface = readSurface()

	if (surface.undocumented.length > 0) {
		console.log(
			`  ${surface.undocumented.length} members carry no §§ block and will be published without a word about them:`,
		)

		for (let hole of surface.undocumented.slice(0, 10)) {
			console.log(`    ${hole.namespace}::${hole.member}`)
		}
	}

	/*
	 * A Parameter without a `@param` line gets an empty description, which only
	 * the standard library can fix. Every run warns, since the page looks
	 * finished.
	 */
	let undescribed = surface.namespaces.flatMap((namespace) =>
		namespace.members.flatMap((member) =>
			member.entries
				.filter((entry) =>
					entry.parameters.some(
						(parameter) => parameter.description === null,
					),
				)
				.map(() => `${namespace.name}::${member.name}`),
		),
	)

	if (undescribed.length > 0) {
		console.log(
			`  ${undescribed.length} entries take an argument no @param describes: ${[
				...new Set(undescribed),
			]
				.slice(0, 6)
				.join(", ")}`,
		)
	}

	let pages = buildLibrary(surface)
	let counts = { created: 0, rewritten: 0, unchanged: 0, removed: 0 }
	let written: string[] = []

	mkdirSync(LIBRARY_DIRECTORY, { recursive: true })

	for (let page of pages) {
		let file = path.join(LIBRARY_DIRECTORY, `${page.manifest.slug}.mdx`)
		let manifestFile = path.join(
			LIBRARY_DIRECTORY,
			`${page.manifest.slug}.json`,
		)
		let existing = readIfThere(file)

		if (existing !== null && !sync) {
			counts.unchanged++
			continue
		}

		if (existing !== null && !existing.includes(GENERATED_MARKER)) {
			throw new Error(
				`${path.relative(process.cwd(), file)} was not written by the generator, and --sync will not write over it. Move it aside, or fold what it says into the sources.`,
			)
		}

		let { mdx, manifest } = renderPage(
			page,
			existing === null ? {} : readPreserved(existing),
		)
		if (existing === null) {
			counts.created++
		} else if (
			existing !== mdx ||
			!sameManifest(readIfThere(manifestFile), manifest)
		) {
			counts.rewritten++
		} else {
			counts.unchanged++
		}

		writeFileSync(file, mdx)
		writeFileSync(manifestFile, serializeManifest(manifest))
		written.push(manifestFile)
	}

	format(written)

	if (sync) {
		let slugs = new Set(pages.map((page) => page.manifest.slug))

		for (let name of readdirSync(LIBRARY_DIRECTORY)) {
			let slug = name.replace(/\.(mdx|json)$/, "")
			let file = path.join(LIBRARY_DIRECTORY, name)

			if (slugs.has(slug) || !/\.(mdx|json)$/.test(name)) {
				continue
			}

			let page = readIfThere(path.join(LIBRARY_DIRECTORY, `${slug}.mdx`))
			let generated = name.endsWith(".mdx")
				? readFileSync(file, "utf8").includes(GENERATED_MARKER)
				: page === null || page.includes(GENERATED_MARKER)

			if (generated) {
				rmSync(file)
				counts.removed++
			}
		}
	}

	let members = pages.reduce(
		(total, page) =>
			total +
			page.manifest.groups
				.flatMap((group) => group.members)
				.filter(
					(member) =>
						member.origin === "declared" &&
						member.kind !== "function",
				).length,
		0,
	)

	console.log(
		`  ${pages.length} pages, ${members} members — ${counts.created} created, ${counts.rewritten} rewritten, ${counts.unchanged} unchanged${
			counts.removed > 0 ? `, ${counts.removed} files removed` : ""
		}${sync ? "" : " (run with --sync to rewrite pages that exist)"}.`,
	)
}

if (import.meta.main) {
	main()
}
