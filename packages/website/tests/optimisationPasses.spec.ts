import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { optimiserPassNames } from "@essence-lang/compiler/optimiser"

// NOTE: "Every Optimiser pass is documented" is a completion gate, not an
// aspiration — the name is what `--without-optimisation` takes, and a pass
// nobody can look up is a flag nobody can use. The registry is the source of
// truth and can be read directly, unlike the Diagnostic codes next door: a pass
// is a value at run time rather than a member of a union that leaves nothing
// behind.

// NOTE: This spec lives in the documentation's own package, beside the file it
// holds to account — so the page is a sibling rather than something reached for
// across the repository, and moving the site means moving them together.
const OPTIMISATIONS_PAGE = path.resolve(
	import.meta.dirname,
	"../optimisations.md",
)

// NOTE: The headings of ONE section, so that the pass list and the runtime
// improvements — which are documented on the same page, in the same style, and
// are deliberately not passes — can not be mistaken for one another.
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
		// NOTE: An exact list rather than a set comparison, because the order
		// the passes run in is part of what the page states — and a pass
		// documented out of order would describe a Compiler that does not
		// exist.
		expect(headingsUnder("Passes")).toEqual([...optimiserPassNames])
	})

	it("documents every runtime improvement, by name", () => {
		// NOTE: These have no registry to be read out of — they are how the
		// runtime works rather than values a Compiler holds — so the list is
		// written out here, and this spec is what makes them nameable at all. A
		// runtime improvement that is renamed, dropped or added without the page
		// following fails, which is the whole of the gate for them.
		expect(headingsUnder("Runtime improvements")).toEqual([
			"interned-booleans",
			"interned-unit-cases",
			"reflexive-equality-fast-path",
			"grapheme-caching",
			"rational-reduction-caching",
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

	it("says how a pass is turned off", () => {
		let documentation = readFileSync(OPTIMISATIONS_PAGE, "utf8")

		expect(documentation).toContain("--without-optimisation")
		expect(documentation).toContain("--no-optimise")
	})
})
