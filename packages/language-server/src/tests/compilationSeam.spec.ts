import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

// Invariants an edit can break without any other spec failing. They are read
// off the source text, since no runtime value says where an import or an
// `await` is written.

const sourceDirectory = path.join(import.meta.dir, "..")

// Every source file under `src`, named by its path from there, the specs left
// out.
function productionSources(): Array<{ name: string; text: string }> {
	return readdirSync(sourceDirectory, { recursive: true, encoding: "utf-8" })
		.filter(
			(name) =>
				name.endsWith(".ts") && name.split(path.sep)[0] !== "tests",
		)
		.map((name) => ({
			name,
			text: readFileSync(path.join(sourceDirectory, name), "utf-8"),
		}))
}

describe("the compilation seam", () => {
	// `compilation.ts` counts the Compiler entry points this Server runs, and
	// every cost spec asserts those counters. An import around them makes the
	// counts quietly low.
	it("should be the only place the counted Compiler entry points are imported", () => {
		// What `compilation.ts` wraps, as in `parseDocument as
		// parseDocumentUncounted`, so a new counter joins the list on its own.
		let counted = [
			...readFileSync(
				path.join(sourceDirectory, "compilation.ts"),
				"utf-8",
			).matchAll(/\b(\w+) as \1Uncounted\b/g),
		].map(([, name]) => name as string)

		expect(counted).toContain("linkModuleAgainst")

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
						/^@essence-lang\/compiler(\/|$)/.test(specifier!) &&
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
