import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

import { fixturePath } from "@essence/fixtures"

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
async function bundleSizeOf(fixtureName: string): Promise<number> {
	let source = readFileSync(fixturePath(fixtureName), {
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
	// NOTE: Measured 55,292 bytes; a reintroduced `Number` spread was 60,437.
	// The measured size rose from 48,261 when the `Number` comparison cluster
	// (`is`, `isNot`, `toString` and the `isLessThan` family) moved into
	// Essence: each is now emitted as its own const reading the covering
	// `compareTo`, so an Everyday Program that compares Numbers carries those
	// bodies. It rose ~900 bytes again when String's derivable Methods
	// followed — a String Method now pulls in the small chain it is written on
	// (`length` -> `characters` -> `split`) instead of one native, and
	// ~1,300 more when List's did, for the same reason: `firstItem` now brings
	// `item`, `removeFirst` brings `slice` and `length`, and so on. It fell
	// back to 55,163 when List's equality Methods took an `Equatable` bound:
	// `contains`, `removeDuplicates` and the by-value `count`/`removeEvery`
	// lost their natives, and what replaced them is written on chains the
	// Program already carried. It now measures 55,578: anchoring esbuild's
	// working directory to the runtime took the checkout's path back out of
	// every inlined module's label, which is worth about 200 bytes here and
	// over a kilobyte to anyone whose checkout sits deeper. Still below the
	// spread figure, so the guard holds — the headroom is ~400 bytes, so the
	// next conversion that touches List will want this ceiling raised with it.
	it("keeps Everyday.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Everyday.es")).toBeLessThan(56_000)
	})

	// NOTE: Measured 42,719 bytes; a reintroduced `Number` spread was 54,849.
	// It rose to 44,174 when a Match grew its exhaustiveness fallback: every
	// emitted `if` chain now ends in an `else` that calls `noCaseMatched`
	// instead of falling off its end and answering `undefined`, and that helper
	// — like the rest of the runtime's Type Module — is carried by every
	// Program. The ceiling moved with it, keeping the same order of headroom;
	// it is still eleven kB below the spread figure this guard is about. It now
	// measures 44,011, for the same reason Everyday's figure fell.
	it("keeps Irrational.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Irrational.es")).toBeLessThan(45_500)
	})
})
