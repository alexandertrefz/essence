import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { snippets } from "@essence-lang/language-server/snippets"

import { renderSnippets } from "../../../scripts/generateSnippets"

// NOTE: The extension SHIPS the snippet file and deliberately does not
// contribute it. VS Code loads a contributed `.code-snippets` whenever the
// language is active rather than only when the Server is off, and it does not
// deduplicate a file snippet against an identically labelled one the Server
// offered — so contributing it would show every prefix twice and offer the
// unscoped copy of each where the Server had just refused it, which is the
// whole of what the scoping is for. The file stays as the EXPORT: the form
// every other Editor takes, and the one a reader who switches the Server off
// installs as user snippets.
//
// The copy is generated from the Server's own table; this spec re-renders and
// compares, and NEVER writes — a drifted copy is fixed by
// `bun run generate:snippets`.
const BUNDLED_COPY = path.resolve(
	import.meta.dirname,
	"../snippets/essence.code-snippets",
)

describe("the bundled snippets", () => {
	it("are in sync with the Language Server's table", () => {
		let rendered = renderSnippets()
		let bundled = readFileSync(BUNDLED_COPY, "utf8")

		if (bundled !== rendered) {
			throw new Error(
				"snippets/essence.code-snippets is out of date. Run `bun run generate:snippets` to regenerate it.",
			)
		}

		expect(Object.keys(JSON.parse(bundled))).toHaveLength(snippets.length)
	})

	// NOTE: And the manifest says nothing about it, which is the point: a
	// contributed file would be loaded beside the Server rather than instead of
	// it, and the reader would be offered each prefix twice — once scoped to
	// the block the cursor stands in, once not scoped at all.
	it("are not contributed for the language", () => {
		expect(
			JSON.parse(
				readFileSync(
					path.resolve(import.meta.dirname, "../package.json"),
					"utf8",
				),
			).contributes.snippets,
		).toBeUndefined()
	})
})
