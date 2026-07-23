import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { bundle } from "../bundler/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The whole point of emitting each Essence Method as its own const rather
// than merging it into a spread of its runtime module is that a native the
// Program does not use stays shakeable. These two testFiles are the ones that
// reach an Essence-implemented Method AND a large runtime module — Everyday and
// Irrational both use `Number`, whose module drags in the numeric tower and
// `bigint-fraction`. Before the change each carried ~13 kB it never used; the
// ceilings here are a few kB above the measured sizes, low enough that a
// reintroduced spread (which would add those kilobytes straight back) trips
// them, high enough not to churn on an ordinary edit.
//
// NOTE: `bundle` imports esbuild lazily and costs a few hundred ms per call, so
// this is kept to the two files that actually regressed. `write: false` keeps
// it off the file system — nothing reaches disk.
async function bundleSizeOf(relativePath: string): Promise<number> {
	let source = readFileSync(join(import.meta.dir, "../..", relativePath), {
		encoding: "utf-8",
	})

	let parsed = parseWithDiagnostics(source)
	let enriched = enrich(parsed.program)

	validate(enriched.program)

	let code = rewrite(optimise(simplify(enriched.program)))

	let result = await bundle(code, {
		sourceFileName: "program.ts",
		outputFileName: "program.js",
	})

	expect(result.outputs).toHaveLength(1)

	return result.outputs[0]!.contents.byteLength
}

describe("Bundle Size", () => {
	// NOTE: Measured 53,074 bytes; a reintroduced `Number` spread was 60,437.
	// The measured size rose from 48,261 when the `Number` comparison cluster
	// (`is`, `isNot`, `toString` and the `isLessThan` family) moved into
	// Essence: each is now emitted as its own const reading the covering
	// `compareTo`, so an Everyday Program that compares Numbers carries those
	// bodies. Still comfortably below the spread figure, so the guard holds.
	it("keeps Everyday.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("testFiles/Everyday.es")).toBeLessThan(56_000)
	})

	// NOTE: Measured 42,827 bytes; a reintroduced `Number` spread was 54,849.
	it("keeps Irrational.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("testFiles/Irrational.es")).toBeLessThan(
			44_000,
		)
	})
})
