import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { projectSchema } from "@essence-lang/compiler/configuration"

// NOTE: The extension bundles the JSON Schema for `essence.json` and registers
// it for the filename, which is what gives the file completion, hover text and
// validation without a line of server code. The copy is generated from the
// reader's catalogue; this spec re-renders and compares, and NEVER writes — a
// drifted copy is fixed by `bun run generate:schema`.
const BUNDLED_COPY = path.resolve(
	import.meta.dirname,
	"../schemas/essence.schema.json",
)

describe("the bundled project-file Schema", () => {
	it("is in sync with the reader's catalogue", () => {
		let rendered = `${JSON.stringify(projectSchema(), null, "\t")}\n`
		let bundled = readFileSync(BUNDLED_COPY, "utf8")

		if (bundled !== rendered) {
			throw new Error(
				"schemas/essence.schema.json is out of date. Run `bun run generate:schema` to regenerate it.",
			)
		}

		expect(JSON.parse(bundled).title).toBe("Essence project file")
	})
})
