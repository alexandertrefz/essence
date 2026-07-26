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
// Program does not use stays shakeable. These two files in
// `packages/fixtures/files/` are the ones that reach an Essence-implemented
// Method AND a large runtime module — Everyday and Irrational both use
// `Number`, whose module drags in the numeric tower.
// Before the change each carried ~13 kB it never used; the ceilings here are a
// few kB above the measured sizes, low enough that a reintroduced spread (which
// would add those kilobytes straight back) trips them, high enough not to churn
// on an ordinary edit.
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
	// Program already carried. It fell to 55,407 when anchoring esbuild's
	// working directory to the runtime took the checkout's path back out of
	// every inlined module's label, which is worth about 370 bytes here and
	// over a kilobyte to anyone whose checkout sits deeper. It now measures
	// 44,190: the in-house bigint-rational core replaced `bigint-fraction`,
	// whose CJS-only bundle — ~9.4 kB no tree shaking could reach, plus the
	// interop wrappers esbuild grew around it — rode in every Program that
	// touched a Rational. The ceiling moved down with it, keeping ~1.3 kB of
	// headroom.
	it("keeps Everyday.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Everyday.es")).toBeLessThan(45_500)
	})

	// NOTE: Measured 42,719 bytes; a reintroduced `Number` spread was 54,849.
	// It rose to 44,174 when a Match grew its exhaustiveness fallback: every
	// emitted `if` chain now ends in an `else` that calls `noCaseMatched`
	// instead of falling off its end and answering `undefined`, and that helper
	// — like the rest of the runtime's Type Module — is carried by every
	// Program. The ceiling moved with it, keeping the same order of headroom;
	// it fell to 43,851 when the module labels lost the checkout's path, for
	// the same reason Everyday's figure did. It now measures 32,717, down
	// 11 kB with `bigint-fraction`'s departure — same story as Everyday's.
	it("keeps Irrational.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Irrational.es")).toBeLessThan(34_000)
	})
})
