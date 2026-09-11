import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { readSurface } from "../scripts/stdlibSurface.ts"

/*
 * "Every Member of the standard library has a page" is a completion gate, not
 * an aspiration — the same bargain `diagnosticCodes.spec.ts` strikes for
 * Diagnostic codes, for the same reason. A reference with holes in it is worse
 * than no reference: it teaches a reader that the absence of a Method from the
 * documentation means nothing, and from then on they have to read the sources
 * anyway.
 *
 * Adding a Method to the standard library therefore fails this until it has a
 * page. `bun scripts/generateStdlibDocs.ts` writes the missing ones from the
 * `§§` block already above the declaration, so the cost of the rule is a
 * command, and what it buys is that the reference cannot quietly fall behind.
 *
 * It runs the other way as well. A page whose Member no longer exists is a page
 * that documents something a reader cannot call — the failure mode of a rename,
 * and invisible without a check like this one.
 *
 * NOTE: The pages are read as files rather than through `astro:content`, which
 * only resolves inside an Astro build; this has to run under plain `bun test`.
 */

const DOCS = path.resolve(
	import.meta.dirname,
	"../src/content/docs/standard-library",
)

interface Page {
	/** Collection id, e.g. `standard-library/integer/add`. */
	id: string
	namespace: string | undefined
	member: string | undefined
	signature: string | undefined
	file: string
}

function frontmatterOf(contents: string): Record<string, string> {
	let block = /^---\n([\s\S]*?)\n---\n/.exec(contents)?.[1] ?? ""
	let fields: Record<string, string> = {}
	// Flat `key: value` pairs, plus block scalars, which is all the generator
	// writes and all this needs to read. A YAML parser would be a dependency
	// bought for two shapes.
	let lines = block.split("\n")

	for (let index = 0; index < lines.length; index++) {
		let match = /^([a-zA-Z]+): ?(.*)$/.exec(lines[index]!)

		if (match === null) {
			continue
		}

		let [, key, value] = match

		if (value === "|") {
			let body: string[] = []

			while (
				index + 1 < lines.length &&
				/^ {2}/.test(lines[index + 1]!)
			) {
				body.push(lines[++index]!.slice(2))
			}

			fields[key!] = body.join("\n")

			continue
		}

		fields[key!] = value!.replace(/^"(.*)"$/, "$1")
	}

	return fields
}

function pages(): Page[] {
	let found: Page[] = []

	for (let type of readdirSync(DOCS, { withFileTypes: true })) {
		if (!type.isDirectory()) {
			continue
		}

		for (let file of readdirSync(path.join(DOCS, type.name))) {
			let full = path.join(DOCS, type.name, file)
			let fields = frontmatterOf(readFileSync(full, "utf8"))

			found.push({
				id: `standard-library/${type.name}/${file.replace(/\.mdx?$/, "")}`,
				namespace: fields.namespace,
				member: fields.member,
				signature: fields.signature,
				file: full,
			})
		}
	}

	return found
}

/** The same reduction the generator applies — `NestedList` publishes on `List`. */
const MERGED_INTO: Record<string, string> = {
	NestedList: "List",
	NestedOptional: "Optional",
}

function declaredMembers(): Array<{
	namespace: string
	member: string
	signature: string
}> {
	return readSurface().namespaces.flatMap((namespace) =>
		namespace.members.map((member) => ({
			namespace: MERGED_INTO[namespace.name] ?? namespace.name,
			member: member.name,
			signature: member.signature,
		})),
	)
}

let declared = declaredMembers()
let published = pages()
let key = (namespace: string, member: string) => `${namespace}::${member}`

describe("the standard library reference", () => {
	it("has a page for every declared Member", () => {
		let have = new Set(
			published
				.filter(
					(page) =>
						page.namespace !== undefined &&
						page.member !== undefined,
				)
				.map((page) => key(page.namespace!, page.member!)),
		)

		let missing = declared
			.filter((entry) => !have.has(key(entry.namespace, entry.member)))
			.map((entry) => key(entry.namespace, entry.member))

		expect(
			missing,
			`These Members have no page. Run \`bun scripts/generateStdlibDocs.ts\` to write them.`,
		).toEqual([])
	})

	it("has no page for a Member the library does not declare", () => {
		let declaredKeys = new Set(
			declared.map((entry) => key(entry.namespace, entry.member)),
		)

		let orphans = published
			.filter((page) => page.member !== undefined)
			.filter(
				(page) =>
					!declaredKeys.has(key(page.namespace ?? "", page.member!)),
			)
			.map((page) => page.id)

		expect(
			orphans,
			"These pages document something the standard library no longer declares.",
		).toEqual([])
	})

	it("names every page after the declaration it documents", () => {
		// The frontmatter is what ties the two together, so a page without it is
		// invisible to both checks above — which would make them pass by saying
		// nothing.
		let untied = published
			.filter(
				(page) =>
					page.namespace === undefined || page.member === undefined,
			)
			.map((page) => page.id)

		expect(untied).toEqual([])
	})

	it("shows the signature the sources declare", () => {
		let bySignature = new Map(
			declared.map((entry) => [
				key(entry.namespace, entry.member),
				entry.signature,
			]),
		)

		let drifted = published.flatMap((page) => {
			if (page.member === undefined || page.signature === undefined) {
				return []
			}

			let current = bySignature.get(
				key(page.namespace ?? "", page.member),
			)

			return current === undefined || current === page.signature
				? []
				: [
						{
							page: page.id,
							published: page.signature,
							declared: current,
						},
					]
		})

		expect(
			drifted,
			"Run `bun scripts/generateStdlibDocs.ts --sync` to bring the signatures forward. Only frontmatter is rewritten; prose is left alone.",
		).toEqual([])
	})
})
