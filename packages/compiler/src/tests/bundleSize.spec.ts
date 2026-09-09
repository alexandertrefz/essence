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
// other side of the claim, the fourth prices one Method that reaches for it,
// and the last holds the claim across a bundle of several Modules.
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
	return bundleSizeOfSource(
		readFileSync(fixturePath(fixtureName), { encoding: "utf-8" }),
	)
}

// NOTE: The same measurement over a Program written here rather than a
// fixture, for a claim about ONE Method: the fixtures are exhaustive by
// design, and what a single call drags in is only visible next to a Program
// that does everything but make it.
async function bundleSizeOfSource(source: string): Promise<number> {
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
	// NOTE: 76,173 measured. What this ceiling watches for is the numeric tower
	// arriving whole: a reintroduced `Number` spread measures over five
	// kilobytes here, several times the headroom.
	//
	// NOTE: 27 of those bytes are `List.split` becoming an Overload entry.
	// `split__overload$1` stands where `split` did, and esbuild then renames
	// `String`'s own `split__overload$1` at three sites to keep the two apart.
	//
	// NOTE: 381 of those bytes are the four range natives folding into one
	// walk. `List.of(integersFrom:through:)` counts up only now, and the walk
	// behind it takes a signed step and the `downTo:` promise as parameters, so
	// the one Program here that writes a range carries the shape all four
	// entries share rather than the two loops that entry alone needed.
	//
	// NOTE: 834 of those bytes are the four inequalities moving from
	// `Orderable` to `Comparable`. A witness carries its Protocol's provided
	// Methods, so every `<T is Comparable>` witness this file builds — `sort`
	// asks for one — grew from one entry to five.
	//
	// NOTE: 1,132 more are the rest of that same wave, and only 22 of them are
	// this file's own text. 1,086 are `Rounding#NearestEven`: rounding to the
	// even neighbour asks the floor for its parity, so `Rational::round`
	// reaches `Integer.isEven` and the Euclidean `remainder` native behind it,
	// and everything that rounds carries both. 24 came with `Optional`'s new
	// combinators. The last 22 are `Integer::toString` becoming an Overload
	// entry — `toString__overload$1` stands where `toString` did, at two sites
	// here.
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
		expect(await bundleSizeOf("Everyday.es")).toBeLessThan(77_200)
	})

	// NOTE: 37,985 measured; a reintroduced `Number` spread was 54,849. The same
	// claim as Everyday's, on a Program that takes square roots rather than
	// doing arithmetic — so it reads the other side of several trades. A pass
	// that pays text for work on Everyday takes bytes OFF here, because a file
	// that mostly compares reaches fewer bodies to write out.
	//
	// NOTE: It moves on Methods it never names. A conformance witness carries
	// its Protocol's PROVIDED bodies whether the Program calls them or not, so
	// a change to `Comparable` or `Orderable` lands here even though this file
	// asks for none of it. That is where 927 of these bytes went: the four
	// inequalities are `Comparable`'s now, so a witness for the smaller
	// Protocol stops carrying `isBetween` and `clamp` with them.
	//
	// NOTE: 366 of them are the approximation wave, and this is the one file
	// that pays for it in bodies it does name. 270 are `Algebraic::raise(to:)`,
	// 64 the irrationals' `toString(as:)` entries, and 32 the `Integer` grid
	// rungs the `round` here resolves to for a whole receiver.
	it("keeps Irrational.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Irrational.es")).toBeLessThan(39_100)
	})

	// NOTE: 47,794 measured. The two tests above watch a Dictionary being shaken
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
	//
	// NOTE: 58 of these bytes arrived without a Dictionary being touched at
	// all: 34 with the `Integer` grid rungs, whose `toString` binding this file
	// links under its Overload name now, and 24 with `Optional`'s new
	// combinators.
	//
	// NOTE: 19 more are the key encoding moving to `keyEncoding.ts`, so that
	// the set-shaped List natives can rest on it without the store. The same
	// functions arrive here in the same order, under one more of esbuild's
	// per-module banner comments — which is the whole of the difference.
	it("charges a Dictionary Program for the container it uses", async () => {
		expect(await bundleSizeOf("Dictionary.es")).toBeLessThan(48_900)
	})

	// NOTE: 12,753 measured, where the same Program without the one call
	// measures 5,083 — so `removeDuplicates` costs 7,670 bytes, half again as
	// much as the Program that calls it. It was 18,607 while the body was
	// `@::tally()::keys()` on `GroupedList`: a List Method reached the whole
	// second container, and the store, the kind registry, the registration and
	// the written form all arrived with it. It is a List native over a plain
	// Map now, and what it still carries is the canonical key encoding those
	// two containers share — `keyEncoding.ts`, a runtime module of its own so
	// that this one can rest on it alone.
	//
	// NOTE: What the 7,670 buys is the Method being linear: one call over
	// 20,000 items with 2,000 distinct measured 106 ms as a fold on `contains`
	// and 22 ms here, and with all 20,000 distinct 650 ms against 22 ms — both
	// best of three with 21 ms of subprocess startup inside. The figure is here so the trade
	// is a number rather than a surprise, and so that either half of it moving
	// is caught. The set-shaped Methods beside it — `hasDuplicates`,
	// `everyItem(alsoIn:)`, `removeEvery(contentsOf:)` and
	// `contains(everyItemOf:)` — rest on the same module, so this figure
	// stands for all of them.
	it("charges a removeDuplicates Program for the key encoding behind it", async () => {
		expect(
			await bundleSizeOfSource(`implementation {
	constant names = ["ada", "bob", "ada", "cy"]

	Terminal.print(names::removeDuplicates()::join(with ", "))
}`),
		).toBeLessThan(13_700)
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
		// NOTE: 17,470 measured, and the ceiling keeps the ~500 bytes this
		// test's own rule asks for. It had five, which is not a guard but a
		// tripwire: it fires on the next ordinary edit and says nothing
		// about what moved. It even deformed the runtime — `String.append`
		// wrote its two marker keys by hand rather than calling the maker
		// every other Method calls, to stay inside those five bytes.
		//
		// NOTE: 89 of the bytes are that call coming back. The 603 over the
		// 14,890 two Protocol commits measured byte-identically are older
		// than that campaign: the same pipeline measures 15,495 at its base
		// commit as it does after it, so nothing there spent them.
		//
		// NOTE: 1,804 of them are `Rounding#NearestEven`. Rounding to the even
		// neighbour asks the floor for its parity, so `Rational::round` now
		// reaches `Integer.isEven` and the Euclidean `remainder` native behind
		// it, and every Program that rounds a Rational carries both. Everyday
		// pays 1,086 of the same. The alternative was a parity test spelled out
		// of `quotient` and `multiply`, which reaches two natives instead of
		// one and says the same thing worse.
		//
		// NOTE: 82 more are the Integer `toString` binding under its Overload
		// name: the plain entry is an Overload entry now, so
		// `toString__overload$1` stands where `toString` did, at eight sites
		// here and two in Everyday, which pays 22 of the same. Nothing is
		// reached that was not reached before — the entries beside it are
		// Essence bodies over `Rational`, and a Program that names no format
		// links none of them.
		expect(result.outputs[0]!.contents.byteLength).toBeLessThan(18_000)
	})
})
