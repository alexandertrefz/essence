import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { loadStdlib } from "../enricher/stdlib"
import { renderNativesModule } from "../tools/generateNatives"

// NOTE: The checked-in native contract, `src/rewriter/__internal/natives.generated.ts`,
// is produced by `renderNativesModule` off the loaded standard library. This
// test re-renders and compares, and NEVER writes — a drifted file is a failure
// the developer fixes by running `bun run generate:natives`, not something a
// test run silently repairs.
const GENERATED_PATH = path.resolve(
	import.meta.dirname,
	"../rewriter/__internal/natives.generated.ts",
)

// NOTE: A first-differing-line report — enough to see WHAT drifted without a
// full diff library, and it always ends on the one action that fixes it.
function describeDrift(expected: string, actual: string): string {
	let expectedLines = expected.split("\n")
	let actualLines = actual.split("\n")
	let lineCount = Math.max(expectedLines.length, actualLines.length)

	for (let index = 0; index < lineCount; index++) {
		let expectedLine = expectedLines[index]
		let actualLine = actualLines[index]

		if (expectedLine !== actualLine) {
			return [
				`natives.generated.ts is out of date at line ${index + 1}:`,
				`  on disk:   ${actualLine ?? "<missing>"}`,
				`  rendered:  ${expectedLine ?? "<missing>"}`,
				"",
				"Run `bun run generate:natives` to regenerate it.",
			].join("\n")
		}
	}

	return "natives.generated.ts is out of date. Run `bun run generate:natives` to regenerate it."
}

describe("Native contract", () => {
	it("natives.generated.ts is in sync with the renderer", () => {
		let expected = renderNativesModule(loadStdlib())
		let actual = readFileSync(GENERATED_PATH, "utf-8")

		if (actual !== expected) {
			throw new Error(describeDrift(expected, actual))
		}

		expect(actual).toEqual(expected)
	})
})
