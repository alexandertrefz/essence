/*
 * Writes the standard library reference: one page per type, and the member
 * manifest beside it.
 *
 *   bun scripts/generateStdlibDocs.ts          write the pages that do not exist yet
 *   bun scripts/generateStdlibDocs.ts --sync   rewrite every page from the sources
 *
 * ── What it will and will not touch ───────────────────────────────────────
 *
 * A library page is generated whole — from `packages/standard-library/sources`
 * by way of `stdlibSurface.ts`, placed by the rules in `libraryPages.ts` and
 * grouped by `libraryTable.ts` — except for two things a person writes: the
 * frontmatter `description` and the "Taught on" line under the lede. The
 * generator seeds both when it creates a page and never overwrites either.
 * Everything else on the page is a fact about the library, and has to be able
 * to travel when the library changes, so `--sync` rewrites it.
 *
 * Without `--sync`, a page that exists is left alone. `--sync` also removes a
 * generated page the library no longer has, told apart from a hand-written one
 * such as `overview.mdx` by the marker comment every generated body opens
 * with; a hand-written page standing where a generated one belongs stops it.
 *
 * ── Why generated at all ──────────────────────────────────────────────────
 *
 * Because the alternative is hundreds of members that fall out of date one at
 * a time, silently, and a reference that lies is worse than no reference. The
 * gate in `tests/stdlibMembers.spec.ts` is the other half: it fails when a
 * member has no place, or a place the library no longer backs, so adding a
 * Method breaks the build until somebody decides where it goes and runs
 * `--sync`.
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
 * The manifests are JSON the repository's formatter also reads, so they are
 * handed to it once written — `bun run check` then leaves a freshly generated
 * tree alone. Where the formatter is not installed they stay as written, and
 * nothing that reads them cares: the gate compares what they say.
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
	 * Not an error, and not something this can fix: an entry that takes an
	 * argument nothing has been written about gets a Parameters row with an
	 * empty description. The `@param` has to be written in the standard
	 * library, where the editor will show it too. Said out loud on every run,
	 * because the page it produces looks finished.
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
