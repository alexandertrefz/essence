import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { optimiserPassNames } from "@essence-lang/compiler/optimiser"

// Every Optimiser pass must be documented, since `--without-optimisation` takes
// its name. The registry holds the passes as values, so it is read directly.

// The published page, read as a file, as a reader is shown it.
const OPTIMISATIONS_PAGE = path.resolve(
	import.meta.dirname,
	"../src/content/docs/reference/optimisations.mdx",
)

// The headings of one section, so the passes and the runtime improvements on
// the same page are never mistaken for each other.
function headingsUnder(section: string): Array<string> {
	let documentation = readFileSync(OPTIMISATIONS_PAGE, "utf8")
	let start = documentation.indexOf(`## ${section}\n`)

	if (start === -1) {
		throw new Error(`Could not find the '${section}' section`)
	}

	let rest = documentation.slice(start + `## ${section}\n`.length)
	let end = rest.indexOf("\n## ")

	return [
		...(end === -1 ? rest : rest.slice(0, end)).matchAll(
			/^### `([^`]+)`$/gm,
		),
	].map((match) => match[1] as string)
}

describe("Optimisation Passes", () => {
	it("documents every registered pass, in the order they run", () => {
		// An exact list, since the page states the order the passes run in.
		expect(headingsUnder("Passes")).toEqual([...optimiserPassNames])
	})

	it("documents every runtime improvement, by name", () => {
		// No registry holds the runtime improvements, so they are listed here,
		// and a change the page does not follow fails.
		expect(headingsUnder("Runtime improvements")).toEqual([
			"interned-booleans",
			"interned-unit-cases",
			"reflexive-equality-fast-path",
			"grapheme-caching",
			"string-window-sharing",
			"rational-reduction-caching",
			"hybrid-integers",
			"list-tail-sharing",
			"list-window-trimming",
			"list-in-place-writes",
			"canonical-key-encoding",
		])
	})

	it("keeps the runtime improvements apart from the passes", () => {
		let improvements = headingsUnder("Runtime improvements")

		expect(improvements.length).toBeGreaterThan(0)
		expect(
			improvements.filter((name) =>
				(optimiserPassNames as Array<string>).includes(name),
			),
		).toEqual([])
	})

	it("documents every emitted shape, by name", () => {
		// Listed here too, since these are Rewriter decisions that no registry
		// holds. A change the page does not follow fails.
		expect(headingsUnder("Emitted shapes")).toEqual([
			"tag-binding",
			"unboxed-loop-state",
			"unboxed-operand",
		])
	})

	it("keeps the emitted shapes apart from the passes", () => {
		// The section's point: an emitted shape is not something
		// `--without-optimisation` can name, so it must not share a pass's name.
		expect(
			headingsUnder("Emitted shapes").filter((name) =>
				(optimiserPassNames as Array<string>).includes(name),
			),
		).toEqual([])
	})

	it("says how a pass is turned off", () => {
		let documentation = readFileSync(OPTIMISATIONS_PAGE, "utf8")

		expect(documentation).toContain("--without-optimisation")
		expect(documentation).toContain("--no-optimise")
	})
})
