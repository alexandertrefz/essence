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
// Program does not use stays shakeable. Everyday.es and Irrational.es are the
// fixtures that reach an Essence-implemented Method AND a large runtime module
// — both use `Number`, whose module drags in the numeric tower — and each
// carried ~13 kB it never used before the change. Dictionary.es holds the
// other side of the claim, and the fourth test holds it across a bundle of
// several Modules.
//
// NOTE: Every ceiling here is held about a kilobyte above the measurement and
// moves in BOTH directions — a ceiling several kilobytes clear stops catching
// the kilobyte-scale mistakes these tests are for, so a fall is followed just
// as a rise is. The prelude test keeps ~500 bytes instead, because the
// duplication it watches for is about a kilobyte and a wider gap would miss it.
//
// NOTE: What each figure was and why it moved is in the commit that moved it.
// What is written here is what the ceiling is FOR.
//
// NOTE: `bundle` imports esbuild lazily and costs a few hundred ms per call, so
// this is kept to the files that actually regressed. `write: false` keeps it
// off the file system — nothing reaches disk.
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
	// NOTE: 73,678 measured. What this ceiling watches for is the numeric tower
	// arriving whole: a reintroduced `Number` spread measures over five
	// kilobytes here, several times the headroom.
	//
	// NOTE: It has caught one design mistake worth keeping. Writing
	// `Integer::isEven` as `remainder(dividingBy 2)::is(#Value(0))` reads far
	// better and cost 2.4 kB, because a GENERIC Choice's derived equality goes
	// through `boundChoiceIs` and the descriptor machinery behind it — and
	// almost everything reaches `isEven`. It is a Match instead.
	//
	// NOTE: Several Optimiser passes GROW this figure and are meant to.
	// `collapse-construction`, `lower-scalar-operations` and `inline-loops`
	// each write out in full what was a call, buying an allocation or a call
	// per evaluation with text, and Everyday exercises the whole numeric
	// surface so it pays that text at every site. Read the MINIFIED figure
	// before treating a rise from one of them as a regression: unminified,
	// escodegen's indentation is most of it.
	//
	// NOTE: A Program carries the runtime reach of what it CALLS, not the
	// amount of Essence inlined into it. That is why a change to a runtime
	// module moves this file while Irrational.es is unchanged to the byte, and
	// why moving a body into Essence can shrink a String-heavy Program while
	// growing this one.
	it("keeps Everyday.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Everyday.es")).toBeLessThan(74_900)
	})

	// NOTE: 38,532 measured; a reintroduced `Number` spread was 54,849. The same
	// claim as Everyday's, on a Program that takes square roots rather than
	// doing arithmetic — so it reads the other side of several trades. A pass
	// that pays text for work on Everyday takes bytes OFF here, because a file
	// that mostly compares reaches fewer bodies to write out.
	//
	// NOTE: It moves on Methods it never names. A conformance witness carries
	// its Protocol's PROVIDED bodies whether the Program calls them or not, so
	// a change to `Orderable` lands here identically to Everyday even though
	// this file asks for none of it.
	it("keeps Irrational.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Irrational.es")).toBeLessThan(39_600)
	})

	// NOTE: 47,631 measured. The two tests above watch a Dictionary being shaken
	// away whole; this one records what a Program that DOES hold one carries —
	// the store, every native the file reaches, the written form, the kind
	// registry and the registration that fills it. The composite key encoding
	// — a Case or a Record spelled into a text from its parts — is 1,708 of
	// those bytes, and rides in with every Dictionary whatever its keys are,
	// because the encoding is one function with an arm per kind; the two
	// filters below it are 77 more.
	//
	// NOTE: What it watches for is the registry being BYPASSED, which would put
	// the rendering in front of every Program whether it holds a Dictionary or
	// not, and `Dictionary.ts` growing top-level side effects, which would pin
	// the whole store into the two files above. The evidence that neither has
	// happened is that those two do not move when this one does.
	it("charges a Dictionary Program for the container it uses", async () => {
		expect(await bundleSizeOf("Dictionary.es")).toBeLessThan(48_700)
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
	// catches a copy that arrives by some other route.
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
		// NOTE: 15,493 measured — SEVEN bytes under the ceiling, where the
		// rest of this file keeps ~500. The figure last recorded here was
		// 14,890, so 603 bytes arrived without a NOTE; the ceiling wants
		// moving once what they are is known, and until then this test is
		// one ordinary edit away from failing for no stated reason.
		expect(result.outputs[0]!.contents.byteLength).toBeLessThan(15_500)
	})
})
