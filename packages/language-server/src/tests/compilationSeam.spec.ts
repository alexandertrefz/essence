import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

// NOTE: Two invariants this package leans on that are otherwise written down
// only in a comment, and both are the kind a future edit breaks silently:
// nothing fails, nothing is slower to the eye, and what stops being true is a
// guarantee something else was built on.
//
// They are checked against the source text because that is what they are ABOUT —
// where an import is written, and where an `await` is. There is no value at
// runtime that answers either question.

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
	// NOTE: `compilation.ts` wraps the four Compiler entry points this Server runs
	// so that "how many times did answering this request compile something" can be
	// asked at all. Every cost test in this package is an assertion about those
	// counters, so an import that goes around them does not fail — it makes the
	// measurements quietly wrong, in the direction of looking better.
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

	// NOTE: Every stage of the Compiler collects its Diagnostics into module level
	// state, and `collectDiagnostics` nests deliberately — a save and a restore
	// around a synchronous call. That is safe exactly as long as no two collections
	// interleave, which holds because a handler may suspend BEFORE it compiles and
	// never inside. An `await` added below the one in `isCurrent` would not throw
	// and would not fail a test: it would attribute one Module's Diagnostics to
	// another, occasionally, under load.
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
		// NOTE: The one inside `isCurrent` itself, which is what every other
		// suspension goes through.
		expect(
			suspensions.filter((name) => name === "yieldToConnection"),
		).toHaveLength(1)
	})
})
