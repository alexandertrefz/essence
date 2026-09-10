import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { snippets } from "@essence-lang/language-server/snippets"

import { renderSnippets } from "../../../scripts/generateSnippets"

// NOTE: The extension bundles the snippet file and registers it for the
// language, which is what expands a prefix before the Server has started — and
// for the readers who switch the Server off, all it ever does. The copy is
// generated from the Server's own table; this spec re-renders and compares, and
// NEVER writes — a drifted copy is fixed by `bun run generate:snippets`.
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

	// NOTE: The manifest is what makes the file anything at all — a
	// `.code-snippets` VS Code was never told about is a file nothing reads.
	it("are contributed for the language", () => {
		expect(
			JSON.parse(
				readFileSync(
					path.resolve(import.meta.dirname, "../package.json"),
					"utf8",
				),
			).contributes.snippets,
		).toEqual([
			{ language: "essence", path: "./snippets/essence.code-snippets" },
		])
	})
})
