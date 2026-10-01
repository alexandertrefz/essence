import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { projectSchema } from "@essence-lang/compiler/configuration"

// The bundled JSON Schema for `essence.json`, generated from the reader's
// catalogue. This spec compares and never writes; `bun run generate:schema`
// regenerates a stale copy.
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
