import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

// Invariants an edit can break without any other spec failing. They are read
// off the source text, since no runtime value says where an import or an
// `await` is written.

const sourceDirectory = path.join(import.meta.dir, "..")

function productionSources(): Array<{ name: string; text: string }> {
	return readdirSync(sourceDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => ({
			name: entry.name,
			text: readFileSync(path.join(sourceDirectory, entry.name), "utf-8"),
		}))
}

describe("the compilation seam", () => {
	// `compilation.ts` counts the Compiler entry points this Server runs, and
	// every cost spec asserts those counters. An import around them makes the
	// counts quietly low.
	it("should be the only place the counted Compiler entry points are imported", () => {
		let counted = [
			"parseDocument",
			"enrichDocument",
			"loadModuleGraph",
			"linkModuleGraph",
		]
		let offenders = productionSources().flatMap((source) => {
			if (source.name === "compilation.ts") {
				return []
			}

			return [
				...source.text.matchAll(
					/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g,
				),
			]
				.filter(
					([, names, specifier]) =>
						/@essence-lang\/compiler\/(documents|modules)/.test(
							specifier!,
						) &&
						counted.some((name) =>
							new RegExp(`\\b${name}\\b`).test(names!),
						),
				)
				.map(() => source.name)
		})

		expect(offenders).toEqual([])
	})

	// A second suspension point would let two compilations interleave, which
	// attributes one Module's Diagnostics to another under load. See "Where the
	// Server suspends" in packages/language-server/DEVELOPMENT.md.
	it("should suspend in exactly one place", () => {
		let server = readFileSync(
			path.join(sourceDirectory, "server.ts"),
			"utf-8",
		)
		let suspensions = [...server.matchAll(/await\s+([A-Za-z]+)/g)].map(
			(match) => match[1],
		)

		expect(new Set(suspensions)).toEqual(
			new Set(["isCurrent", "yieldToConnection"]),
		)
		// The one inside `isCurrent`, which every other suspension goes through.
		expect(
			suspensions.filter((name) => name === "yieldToConnection"),
		).toHaveLength(1)
	})
})
