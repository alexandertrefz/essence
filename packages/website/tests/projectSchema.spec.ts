import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { projectSchema } from "@essence-lang/compiler/configuration"

// NOTE: The site serves the JSON Schema for `essence.json` at the URL the
// file's `$schema` names, so an editor anywhere can validate a project file
// against what the toolchain actually reads. The copy is generated from the
// reader's catalogue; this spec re-renders and compares, and NEVER writes — a
// drifted copy is fixed by `bun run generate:schema`.
//
// NOTE: Beside the file it holds to account, in the package that ships it,
// rather than in the compiler's tests counting `../`s towards it.
const SERVED_COPY = path.resolve(
	import.meta.dirname,
	"../public/schemas/essence.schema.json",
)

describe("the served project-file Schema", () => {
	it("is in sync with the reader's catalogue", () => {
		let rendered = `${JSON.stringify(projectSchema(), null, "\t")}\n`
		let served = readFileSync(SERVED_COPY, "utf8")

		if (served !== rendered) {
			throw new Error(
				"public/schemas/essence.schema.json is out of date. Run `bun run generate:schema` to regenerate it.",
			)
		}

		expect(JSON.parse(served).$id).toBe(
			"https://essencelang.org/schemas/essence.schema.json",
		)
	})
})
