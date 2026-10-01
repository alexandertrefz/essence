import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { snippets } from "@essence-lang/language-server/snippets"

import { renderSnippets } from "../../../scripts/generateSnippets"

// The extension ships the snippet file without contributing it, as an export
// for other editors or for user snippets. It is generated from the Server's
// table; `bun run generate:snippets` regenerates a stale copy.
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

	// VS Code would load a contributed file beside the Server's snippets,
	// offering each prefix twice, the second copy unscoped.
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
