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
	// NOTE: 5,929 measured, and it is the floor every Program pays: the runtime
	// a bundle links whatever it calls. HelloWorld.es names no number, no
	// container and no constant — what it measures is what a `Terminal.print`
	// and a String interpolation drag in, and what NOTHING else does.
	//
	// NOTE: 189 of those bytes arrived with the character WINDOW, and they are
	// all in the ONE function this Program reaches of it: building a String's
	// character view. It never cuts a String, so it links none of the cutting —
	// what it pays for is the view remembering two things a cut will need, the
	// text its clusters partition where that is not the String's own text, and
	// whether the Segmenter ran. The second is read by no Program and only by
	// the specs that assert a drain segments its String once; it is 82 bytes,
	// and it buys the strongest guard in `stringWindows.spec.ts`.
	//
	// NOTE: It was 6,930 until the transcendental basis registry stopped
	// deriving its canonical order in a top-level call, which no bundler can
	// prove pure: the module, both series behind it and the tower they reach
	// were 1,190 bytes of this figure, in a Program that names no constant at
	// all. A ceiling here is what says the next such top-level effect is
	// noticed by a test rather than by a reader of a bundle.
	it("keeps the floor every Program pays", async () => {
		expect(await bundleSizeOf("HelloWorld.es")).toBeLessThan(6_950)
	})

	// NOTE: 81,445 measured. What this ceiling watches for is the numeric tower
	// arriving whole: a reintroduced `Number` spread measures over five
	// kilobytes here, several times the headroom.
	//
	// NOTE: 1,832 of those bytes are the String vocabulary wave, and this file
	// calls three of its entries: `Integer.parse`, `Integer.parse(defaultingTo:)`
	// and `Rational.parse`. 590 are the entries themselves — `characters` going
	// native, and the searches gaining a folding entry, which puts the shared
	// walk behind a handful of small wrappers. The other 1,242 are what the two
	// parses now READ: `codePoints`, the two ends of the List of points, and
	// `replaceEvery` for the digit count behind a decimal point, which is 351 of
	// them by itself. Reading the sign off the String instead — `starts(with:)`
	// and its neighbours — reaches `String::is` and its `compare`, and measured
	// 306 bytes more than the points do.
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
	// NOTE: 48 of those bytes are `List` Methods becoming Overload entries, at
	// the call sites here: each name binds its `__overload$1` suffix now.
	//
	// NOTE: 67 of those bytes are the transcendental basis registry carrying
	// its own canonical term order. The Map that derived that order was a
	// top-level call no bundler can prove pure, so every Program linked the
	// module and the two series behind it whether it named a constant or not —
	// which is what the floor below measures. A file that genuinely uses the
	// tower pays these 67 for the shape that shakes.
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
	// NOTE: 3,325 of those bytes are the character WINDOW — a cut of a String
	// sharing its parent's cluster Array by offset rather than copying it,
	// which is what made consuming a String from the front linear (2,245 ms to
	// 35 for the gap analysis's 40,000-character drain). This file reaches all
	// of it through `Integer.parse` and `Rational.parse`, which slice and
	// search. The offset table and the two makers it feeds are about 1,300, the
	// view's own readers and their keys about 1,000, and the rest is what the
	// searches, `slice` and `graphemesIn` grew by — against which the matcher
	// they share gave back the 305 of the one it replaced and whole-receiver
	// folding 183.
	//
	// NOTE: A Program that never CUTS a String pays 189 of it, all in the one
	// function that builds a view; `HelloWorld.es` above prices exactly that.
	// The one thing every String-touching Program pays is 74 bytes in `append`,
	// which marks a join the ASCII scan would refuse rather than leaving the
	// next Method to scan the whole of it — a token built one non-ASCII
	// character at a time measured 203 ms at 80,000 characters without that
	// mark and 33 ms with it.
	//
	// NOTE: A Program carries the runtime reach of what it CALLS, not the
	// amount of Essence inlined into it. That is why a change to a runtime
	// module moves this file while Irrational.es is unchanged to the byte, and
	// why moving a body into Essence can shrink a String-heavy Program while
	// growing this one.
	//
	// NOTE: 961 of the current figure are `list-window-trimming`: the half rule
	// that decides when a List trims a run, and the seam move that lets a
	// window holding neither end of a List be shared. They are in `List.ts`, so
	// every Program reaching `slice` carries them — the canonical functional
	// walk went from 634 ms to 36 at fifty thousand items for them, and a walk
	// dropping an item from each end from 1203 ms to 32. HelloWorld.es is
	// unchanged to the byte, which is what says the reach is `slice`'s and not
	// everything's.
	//
	// NOTE: 1,373 of them are `list-in-place-writes`: the catching up every
	// reader of a List now does, the sealing the walks do, and the `writes` a
	// box carries through the sharing literals. A Program that never reaches a
	// List pays NONE of it — the floor above is unmoved at 5,740 — and one that
	// reaches one pays it whether or not it writes a position, because catching
	// a box up is what every READER owes. `replace` itself shakes out of a
	// Program that does not call it, and a Program that does is smaller than it
	// was: the Essence body it replaces was a guard, a `remove` and an
	// `insert`.
	// NOTE: The ceiling is 80,000 rather than the measured figure plus a
	// handful, because a gate with twenty bytes of headroom fails for the next
	// person to write a line rather than for the next person to drag in a
	// tower, and that is not what it is for.
	it("keeps Everyday.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Everyday.es")).toBeLessThan(84_800)
	})

	// NOTE: 38,056 measured; a reintroduced `Number` spread was 54,849. The same
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
	//
	// NOTE: 8 are an identifier growing. `String.ts`'s internal `quoted` is
	// `quotedText` now, so that the Method `quote()` binds to can stand under
	// the shorter name, and the printer every Program links calls the helper
	// under the longer one.
	//
	// NOTE: 63 are the transcendental registry change Everyday's note above
	// explains, which every file that reaches the tower pays alike.
	it("keeps Irrational.es from dragging in the whole numeric tower", async () => {
		// NOTE: 1,047 are `list-in-place-writes`, which Everyday's note above
		// accounts for. This file names no List at all and still pays, because a
		// conformance witness carries `List`'s own Methods with it — the very thing
		// the note above this one is about.
		expect(await bundleSizeOf("Irrational.es")).toBeLessThan(40_200)
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
	// combinators. 8 more are the `quotedText` rename Irrational's note
	// explains, which every Program that prints pays alike.
	//
	// NOTE: 19 more are the key encoding moving to `keyEncoding.ts`, so that
	// the set-shaped List natives can rest on it without the store. The same
	// functions arrive here in the same order, under one more of esbuild's
	// per-module banner comments — which is the whole of the difference.
	//
	// NOTE: 59,505 measured then, and the 11,655 bytes between the two figures
	// are what the fixture ITSELF grew by: it exercises the Methods the
	// completeness wave added, and each drags its own reach in. Measured one
	// call at a time against a fixture without the new section, which is
	// 47,850: `sort()` is 3,412 of them and `sort(on:)` 3,139 — the two share
	// most of that, since both reach the same native and the `Comparable`
	// witness of what they order — `Dictionary.of(_, valuedBy:)` 2,137 for the
	// `List::map` it is written on, `count(where:)` 1,384 for `List::count`,
	// `hasValue` 1,157 for `List::contains`, and the five remaining calls 684
	// or less each.
	//
	// NOTE: 48 bytes of that base moved without a Method being added to it:
	// `remove` and `of` are Overloads now, so the emitted name of each native
	// carries its `__overload$1` suffix at every call site.
	//
	// NOTE: 58,328 measured now. Every figure above it was taken before the
	// transcendental registry stopped deriving its base order at load, which
	// gave 1,177 bytes back here and 1,190 to every Program that names no
	// constant at all.
	//
	// NOTE: What says this is the fixture and not the runtime is the three
	// figures that did NOT move with it: `Everyday.es`, the removeDuplicates
	// Program below, and `HelloWorld.es` at 5,740. `Everyday.es`
	// reads 78,120 now, and nothing it has taken since is anything a Dictionary
	// reaches: 48 bytes of `List` Methods becoming Overloads, 381 of the range
	// natives folding into one walk, 27 of `List.split` becoming an Overload
	// entry, 67 of the transcendental registry, and the 1,832 of the String
	// vocabulary wave its own note above accounts for. A Dictionary runtime
	// that grew would move the second of those, which reaches the whole store
	// through one call and none of the new Methods.
	//
	// NOTE: 59,045 measured now, and the 717 bytes it rose by are a List
	// becoming a key kind that ENCODES rather than one that scans: the spelling
	// of a List and the memo that remembers it. The two Programs below take 709
	// of the same thing, the eight bytes between them being what esbuild's own
	// renaming makes of it in a bundle that holds the store as well.
	//
	// NOTE: What a Program pays depends on whether it had a List reader already,
	// and the three figures are worth keeping together because they say where
	// the weight really falls. `keyEncoding.ts` now reaches `List.runsOf`, 671
	// bytes of reader. A Program that compares anything structurally has it
	// already — `anyIs` has a List arm, and that arm reads a view — so this
	// fixture, and any Record- or Case-keyed Dictionary, pays only the 717. A
	// Program whose keys are Strings reaches no such arm and pays the reader
	// too: 16,588 before and 17,808 after, +1,220, for a key kind it never uses.
	// That is the true price of the encoding being ONE function with an arm per
	// kind, and the `Http.get` ceiling below is where it is written out.
	//
	// NOTE: And a Program that holds no Dictionary and asks a List no set-shaped
	// question pays NOTHING: `HelloWorld.es` (5,740), `Everyday.es` (78,120) and
	// `Irrational.es` (38,056) are byte-identical across the change. That is the
	// claim the module split was made for, and it still holds.
	it("charges a Dictionary Program for the container it uses", async () => {
		// NOTE: 1,356 are `list-in-place-writes`, which Everyday's note accounts
		// for; `Dictionary.of(entries:)` walks a List of entry Records and seals it,
		// which is where this file meets them.
		expect(await bundleSizeOf("Dictionary.es")).toBeLessThan(61_600)
	})

	// NOTE: 12,272 measured, where the same Program without the one call
	// measures 3,893 — so `removeDuplicates` costs 8,379 bytes, more than twice
	// as much as the Program that calls it. It was 18,607 while the body was
	// `@::tally()::keys()` on `GroupedList`: a List Method reached the whole
	// second container, and the store, the kind registry, the registration and
	// the written form all arrived with it. It is a List native over a plain
	// Map now, and what it still carries is the canonical key encoding those
	// two containers share — `keyEncoding.ts`, a runtime module of its own so
	// that this one can rest on it alone.
	//
	// NOTE: What the 8,379 buys is the Method being linear: one call over
	// 20,000 items with 2,000 distinct measured 106 ms as a fold on `contains`
	// and 22 ms here, and with all 20,000 distinct 650 ms against 22 ms — both
	// best of three with 21 ms of subprocess startup inside. The figure is here so the trade
	// is a number rather than a surprise, and so that either half of it moving
	// is caught. The set-shaped Methods beside it — `hasDuplicates`,
	// `everyItem(alsoIn:)`, `removeEvery(contentsOf:)` and
	// `contains(everyItemOf:)` — rest on the same module, so this figure
	// stands for all of them.
	//
	// NOTE: 709 of those bytes are the LAST thing that module took: a List
	// becoming a key kind that encodes. What they buy here is the same Methods
	// staying linear when the items are Lists rather than Strings — the call
	// over 10,000 two-item Lists measured 1,929 ms before and 1.8 ms now,
	// because a List key used to answer no encoding and fall onto the scan.
	// The Dictionary ceiling above accounts for the same 709 in a Program that
	// holds a Dictionary instead.
	it("charges a removeDuplicates Program for the key encoding behind it", async () => {
		expect(
			await bundleSizeOfSource(`implementation {
	constant names = ["ada", "bob", "ada", "cy"]

	Terminal.print(names::removeDuplicates()::join(with ", "))
}`),
			// NOTE: 1,080 are `list-in-place-writes`, which Everyday's note accounts
			// for.
		).toBeLessThan(14_400)
	})

	// NOTE: 10,152 measured, where the same Program calling `median` measures
	// 2,760 — so `mode` costs 7,392 bytes, the count and the canonical key
	// encoding it counts by, 709 of them the List arm that arrived last and
	// that `mode` itself can not reach: it counts Integers, Rationals and
	// Numbers, and pays for the arm because the encoding is one function.
	// It measured 20,560 while the body was
	// `@::tally()::entries()::highestItem(on .value).key`: a List Method
	// reached the whole second container, and the store, the kind registry,
	// the registration and the written form all arrived with it. That is the
	// same shape the removeDuplicates ceiling above watches, one Namespace
	// along, and this figure is what says a numeric aggregate does not pull a
	// container in either.
	it("charges a mode Program for the count rather than a Dictionary", async () => {
		expect(
			await bundleSizeOfSource(`implementation {
	constant numbers = [3, 1, 1, 3, 2]

	Terminal.print(numbers::mode(defaultingTo 0)::toString())
}`),
			// NOTE: 1,058 are `list-in-place-writes`, which Everyday's note accounts
			// for, and it is the smallest Program here that reaches a List — so it is
			// the honest price of the change for anything that touches one.
		).toBeLessThan(12_300)
	})

	// NOTE: 22,358 measured, where the same Program completing an
	// `Async.deferred` instead measures 5,724 — so one `Http.get` costs 16,634
	// bytes. Almost all of it is the second container: a request's headers and
	// an answer's are a `Dictionary<String, String>`, so `Http.ts` reaches the
	// store, the canonical key encoding and the kind registry, which the
	// Dictionary ceiling above prices on its own. What is left is `Http.ts`
	// itself, the three Case constructors beside it, and the asynchrony
	// `Future.es` already pays for.
	//
	// NOTE: It was 20,321, and the 2,037 bytes it rose by are three fixes with
	// nothing else in them: the abort link that keeps a stop reaching a finished
	// run's descendants on a host with no `AbortSignal.any` (709), the fold that
	// stops a second `set-cookie` overwriting the first (243), and the checks
	// that let this library refuse a request in its own words rather than in
	// `fetch()`'s (1,085).
	//
	// NOTE: The figure is here so that the Namespace which reaches the world is
	// the one whose weight is a number rather than a surprise, and so that a
	// top-level side effect added to `Http.ts` is caught HERE as well as by the
	// floor above: a Program that sends nothing must carry none of this, and a
	// Program that sends must carry no more than a request needs.
	//
	// NOTE: 23,578 measured now, and this is where a List becoming an encodable
	// key kind costs the MOST. The 1,220 bytes are `keyEncoding.ts` reaching
	// `List.runsOf`: 671 of reader, 20 of the empty run beside it, and the
	// spelling and the memo. This Program holds a `Dictionary<String, String>`
	// and no List at all, so every one of those bytes is dead weight in it —
	// the true price of the encoding being ONE function with an arm per kind.
	//
	// NOTE: It is the most because a String key reaches no structural
	// comparison. The Dictionary ceiling above pays 717 of the same change and
	// not 1,220, because anything that compares a value structurally already
	// carries the reader: `anyIs` has a List arm, and that arm reads a view.
	// Those two figures together are what say where the weight falls, which is
	// why both are written down.
	//
	// NOTE: What was weighed against it: reaching a List through the kind
	// registry instead, so that only a Program carrying `List.ts` pays. It
	// moves about 420 bytes onto EVERY Program that holds a List, which is
	// nearly all of them, to take 1,220 off the ones that hold a Dictionary and
	// no List — a Program paying for a container it does not use, in the other
	// direction. And a Dictionary keyed by Lists would then encode only where
	// something had registered the reader first, which is a correctness answer
	// that depends on what else the Program happens to call.
	it("charges a Program that sends one request for the request", async () => {
		expect(
			await bundleSizeOfSource(`implementation {
	constant answered = complete Http.get("https://example.test/")

	Terminal.print(answered::hasValue())
}`),
		).toBeLessThan(24_600)
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
		// NOTE: 16,273 measured, and the ceiling keeps the ~500 bytes this
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
		// NOTE: 1,197 came off again with the transcendental registry, which no
		// Module here names: the floor test above says what that change was.
		//
		// NOTE: 82 more are the Integer `toString` binding under its Overload
		// name: the plain entry is an Overload entry now, so
		// `toString__overload$1` stands where `toString` did, at eight sites
		// here and two in Everyday, which pays 22 of the same. Nothing is
		// reached that was not reached before — the entries beside it are
		// Essence bodies over `Rational`, and a Program that names no format
		// links none of them.
		expect(result.outputs[0]!.contents.byteLength).toBeLessThan(16_800)
	})
})
