import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

import { fixturePath } from "@essence-lang/fixtures"

import { bundle } from "../bundler/index"
import { enrich } from "../enricher/index"
import { loadModuleGraph } from "../modules/graph"
import { diskModuleHost } from "../modules/host"
import { linkModuleGraph } from "../modules/link"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite, rewriteModules } from "../rewriter/index"
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
	// `compare`, so an Everyday Program that compares Numbers carries those
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
	// over a kilobyte to anyone whose checkout sits deeper. It fell to
	// 44,190 when the in-house bigint-rational core replaced
	// `bigint-fraction`, whose CJS-only bundle — ~9.4 kB no tree shaking
	// could reach, plus the interop wrappers esbuild grew around it — rode in
	// every Program that touched a Rational. It now measures 53,466: the
	// Rational arithmetic cluster, the Integer mixed-kind entries, the Number
	// aggregates and both `parse` Methods moved into Essence, and Everyday
	// deliberately calls every one of them, so it carries every one of those
	// bodies — a Program pays only for the Methods it reaches. It now measures
	// 59,924: `Optional` became a nominal Choice, so every fallible answer is a
	// constructed Case rather than a bare value or a shared singleton, and
	// every producer of one carries the construction. The two `parse` Methods
	// account for nearly half the rise on their own — they are the densest
	// fallible code in the library — and `Optional::map` and `keep` are two new
	// shared bodies the chains they replaced did not need. The ceiling moved
	// with it, keeping ~1 kB of headroom; a reintroduced spread is still
	// several kilobytes past it.
	//
	// NOTE: It now measures 61,600, and the ceiling moved to keep the same
	// ~1 kB of headroom. The 1,653 bytes are the five unconditional runtime
	// improvements, measured one at a time on this very file: the interned
	// Booleans cost 137, the interned unit Cases 275, the reflexive equality
	// shortcut 38, remembering a String's grapheme view 990, and remembering a
	// Rational's lowest-terms form 213. Each is a few lines that every Program
	// carries and that take an allocation, a walk or a segmentation out of a
	// hot path — the grapheme view alone turns a ~4,200ns call into a ~1ns one
	// — so this is the one direction the ceiling is meant to allow. What it
	// still catches is unchanged: a reintroduced `Number` spread was over five
	// kilobytes here, and the `isEven` shape below was 2.4.
	//
	// NOTE: It now measures 62,388, up 788, and the ceiling moved to keep the
	// same ~1 kB of headroom. `collapse-construction` is what grew it, and it
	// grew the TEXT rather than the work: fifteen `Record.createRecord(…)` and
	// eighteen `List.createList(…)` calls became branded object literals, which
	// are more characters than the calls they replace — an extra key, and
	// escodegen puts each member of a two-member object on its own line. What
	// ships is minified, where the same change is 23,722 to 23,944, and what
	// RUNS is one allocation per value instead of two. Irrational.es, which
	// constructs no Record and no List, is unchanged to the byte.
	//
	// NOTE: What nearly landed here and did not: writing `Integer::isEven` as
	// `remainder(dividingBy 2)::is(#Value(0))` reads far better and cost
	// 2.4 kB, because a GENERIC Choice's derived equality goes through
	// `boundChoiceIs` and the descriptor machinery behind it — and almost
	// everything reaches `isEven`. It is a Match instead. This ceiling is what
	// caught that.
	it("keeps Everyday.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Everyday.es")).toBeLessThan(63_400)
	})

	// NOTE: Measured 42,719 bytes; a reintroduced `Number` spread was 54,849.
	// It rose to 44,174 when a Match grew its exhaustiveness fallback: every
	// emitted `if` chain now ends in an `else` that calls `noCaseMatched`
	// instead of falling off its end and answering `undefined`, and that helper
	// — like the rest of the runtime's Type Module — is carried by every
	// Program. The ceiling moved with it, keeping the same order of headroom;
	// it fell to 43,851 when the module labels lost the checkout's path, for
	// the same reason Everyday's figure did. It fell to 32,717, down
	// 11 kB with `bigint-fraction`'s departure — same story as Everyday's. It
	// now measures 34,448: it takes square roots, which are fallible, so it
	// carries the Case construction a nominal `Optional` needs and `Optional`'s
	// own bodies. The rise is a fifth of Everyday's because it reaches neither
	// `parse`.
	it("keeps Irrational.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Irrational.es")).toBeLessThan(35_500)
	})

	// NOTE: The same claim for a bundle of several Modules, where it is far
	// easier to lose: rewriting each Module on its own would give every one of
	// them its own copy of every Essence-implemented standard library Method it
	// reaches, and the bundle would carry as many `Optional::otherwise` as there
	// are Modules that call it. The Module fixtures reach two of them from two
	// files each, so a per-Module prelude shows up here as four consts and as
	// about a kilobyte.
	//
	// NOTE: Counted as well as measured. The count is what the claim actually
	// IS — one const per Method, whatever it weighs — and it is taken against
	// the ONE prelude Module rather than against itself, because a second copy
	// would not be spelled alike: esbuild renames a colliding top-level name,
	// so two `$es_List_sorted` become `$es_List_sorted` and `$es_List_sorted2`
	// and a test that only deduplicated the names would pass. The ceiling
	// catches a copy that arrives by some other route again. Measured 12,067
	// bytes; then 17,444 — the fixtures' `truncate`, `divide` and `toString`
	// chains moved into Essence, so the prelude carries those bodies and the
	// `Rational.of`/accessor natives behind them. It now measures 19,499: the
	// four rounding Methods collapsed into `round(toward Rounding)`, and these
	// fixtures want only its `#TowardZero` branch. A Method is emitted as ONE
	// const, so they carry all four — the `#Nearest` branch's `subtract` and
	// `1/2` comparisons included. That is what rule 4 costs here, and it is
	// paid once: a Program reaching any rounding at all now reaches the same
	// body. A duplicated per-Module prelude would still overshoot the moved
	// ceiling by kilobytes.
	//
	// NOTE: It now measures 20,693 and the ceiling moves to 21,200. 530 of the
	// rise came with the nominal `Optional` and went unrecorded here — the
	// figure above stayed at 19,499 while the measurement moved to 20,030 — and
	// 663 are the unconditional runtime improvements: 137 for the interned
	// Booleans, 275 for the interned unit Cases, 38 for the reflexive equality
	// shortcut and 213 for remembering a Rational's lowest-terms form. This
	// bundle reaches no String Method that segments, so the grapheme view costs
	// it nothing. The ceiling keeps ~500 bytes of headroom deliberately: the
	// duplication it exists to catch is about a kilobyte here, so it has to stay
	// nearer than that to the measurement to catch one.
	it("carries one copy of the prelude across a bundle of Modules", async () => {
		let linked = linkModuleGraph(
			loadModuleGraph(fixturePath("modules", "Main.es"), diskModuleHost),
		)

		let sources = rewriteModules(
			[...linked.modules.values()].map((module) => ({
				filePath: module.module.filePath,
				program: optimise(simplify(module.program)),
			})),
			linked.entryPath,
		)

		let result = await bundle(sources, {
			sourceFileName: "Main.es",
			outputFileName: "bundle.js",
		})

		expect(result.diagnostics).toEqual([])
		expect(result.outputs).toHaveLength(1)

		let essenceConsts = (text: string) =>
			[
				...text.matchAll(
					/(?:const|let|var|function)\s+(\$es_[A-Za-z0-9_$]+)/g,
				),
			].map((match) => match[1]!)

		let inPrelude = essenceConsts(sources.sources.get("essence:$prelude")!)
		let inBundle = essenceConsts(
			new TextDecoder().decode(result.outputs[0]!.contents),
		)

		expect(inBundle.length).toBeGreaterThan(0)
		expect(inBundle.length).toBeLessThanOrEqual(inPrelude.length)
		expect(result.outputs[0]!.contents.byteLength).toBeLessThan(21_200)
	})
})
