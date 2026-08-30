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
	// NOTE: It now measures 59,658, down 2,730, and the ceiling came DOWN with
	// it to keep the same ~1 kB of headroom — a ceiling three kilobytes above
	// the measurement stops catching the kilobyte-scale mistakes it is here for.
	// `lower-unit-case-equality` is what shrank it: a comparison against a
	// payload-less Case is a tag test now, so the Programs that only ever
	// compared that way stop reaching the universal structural equality, and its
	// whole ladder of kind tests — Records, Lists, the cross-kind rational
	// arithmetic — falls out of the bundle with it. HelloWorld.es, which reaches
	// it through nothing but a comparison, lost a quarter of its bytes.
	//
	// NOTE: It now measures 52,873, down 6,785, and the ceiling came down with
	// it. `compile-type-tests` is what shrank it, and by a route worth stating:
	// a Match's Type check used to be a descriptor written out at the site and
	// handed to `$type.isValueOfType`, so the descriptors went with the checks
	// AND the function they were built for left the bundle entirely — measured
	// by turning the pass off, where `isValueOfType` is back and the bundle is
	// 59,690 again. What is left of the runtime's Type Module is the hidden key,
	// `createCase` and `noCaseMatched`.
	//
	// NOTE: It now measures 50,481, down another 2,392, and the ceiling follows
	// it down. `pool-constants` is what shrank it, and this one shrinks the TEXT
	// as well as the work: a Program the size of Everyday writes the same
	// handful of small Integers, the same conformance witnesses and the same
	// Type descriptors over and over, and each is now one const and a name at
	// every site. What it takes out of the RUN is larger than what it takes out
	// of the file — every one of those was an allocation per evaluation.
	//
	// NOTE: It now measures 51,560, up 1,079, and the ceiling moves UP with it
	// — the second pass to grow this file rather than shrink it, and for the
	// same reason `collapse-construction` did. `lower-scalar-operations` writes
	// `a::add(b)` out as the branded literal the runtime's constructor would
	// have built, `{ [$type.typeKeySymbol]: "Integer", value: a.value + b.value }`,
	// which is more characters than `Integer.add__overload$1(a, b)` and one
	// allocation and no call where that was one allocation and one — and for
	// `subtract`, which is `@::add(other::negate())`, two allocations and two
	// calls. Everyday deliberately exercises the whole numeric surface, so it
	// pays that text at every arithmetic site: minified, where what ships is
	// measured, the same change is 17,345 to 18,120.
	//
	// It is the WRONG WAY ROUND on files that mostly compare: Irrational.es
	// measures 28,129, down 136, and HelloWorld.es — which reaches the standard
	// library through a comparison and little else — falls from 10,563 to 9,525,
	// a tenth of its size, because the `isLessThan`/`isGreaterThan` bodies and
	// the `Ordering` Cases they built stop being reached at all.
	//
	// NOTE: It now measures 52,781, up 1,854, and the ceiling moves up with it.
	// `inline-loops` is what grew it, and it grew the SOURCE far more than what
	// ships: measured minified, where what ships is measured, the same change is
	// 17,695 to 17,748 — fifty-three bytes, a third of a percent. The
	// unminified figure is mostly the indentation escodegen puts a walk's body
	// under. What the bytes buy is every `reduce`, `everyItem` and `map` written
	// with a literal callback — the standard library's own derived Methods
	// among them — becoming a `for` with the callback's body in it, where each
	// was a call per item into a native that called a closure per item. Loops.es
	// measures the other direction, 11,281 to 10,488 unminified and 4,682 to
	// 3,941 minified, because the four `loop` drivers stop being reached at all.
	//
	// NOTE: What nearly landed here and did not: writing `Integer::isEven` as
	// `remainder(dividingBy 2)::is(#Value(0))` reads far better and cost
	// 2.4 kB, because a GENERIC Choice's derived equality goes through
	// `boundChoiceIs` and the descriptor machinery behind it — and almost
	// everything reaches `isEven`. It is a Match instead. This ceiling is what
	// caught that.
	//
	// NOTE: It now measures 52,153, and the ceiling comes down to 53,200 to keep
	// the ~1 kB of headroom every move above kept. 37 of the fall are
	// `lower-scalar-operations` reaching `NonZeroInteger.multiply`: the refined
	// Namespace answers the one Method by re-exporting Integer's own product, so
	// the same bigint multiplication was being called rather than written out
	// wherever a proven Integer met another — `Rational`'s own arithmetic
	// multiplies two denominators that way. 591 more fell with the checked
	// refinements themselves and went unrecorded here, the figure above staying at
	// 52,781 while the measurement moved to 52,190: a total `divide`, `remainder`
	// and `quotient` let the standard library stop laundering answers it had
	// already proven, and the `::value(defaultingTo …)` fallbacks that did the laundering
	// left the bundle with them.
	// NOTE: It now measures 51,987, down 166, and the ceiling STAYS at 53,200:
	// 166 bytes is not a kilobyte, and the headroom is still the ~1 kB every
	// move above kept. What fell is worth stating, because it fell the wrong way
	// round. `List::repeat` maps over the List `of` builds; `of` answers a
	// `NonEmptyList` now, so that `map` is answered by `NonEmptyList` — and
	// `inline-loops` recognises a walk by the Namespace that answers it and
	// knows only `List`. The call is a call again where it had become a `for`,
	// and the indentation it stopped writing out is the whole of the fall. Fewer
	// bytes and more work is the trade that pass exists to make in the other
	// direction, and it is made the same way by any Program mapping over a List
	// it has proven something about with a literal callback.
	//
	// NOTE: It measures 52,153 again, up those same 166, and the ceiling STAYS at
	// 53,200 — 53,200 − 52,153 is 1,047, which is the ~1 kB of headroom every
	// move above kept, so there is nothing to move. `inline-loops` knows the
	// second name now: `NonEmptyList` declares a `map` of its own so that it may
	// promise the answer is not empty, and the Method behind that promise is
	// `List`'s own `map` re-exported, so `List::repeat` is a `for` again and so
	// is every other walk over a List a Program has proven something about. This
	// is the pass paying text for work, which is the trade it exists to make:
	// minified, where what ships is measured, the same change is 17,489 to
	// 17,495 — six bytes. Only `map` moved, because it is the only walking Method
	// the two Namespaces share; `everyItem` and both `reduce` entries can answer
	// with fewer items than they were handed, are not declared on `NonEmptyList`
	// at all, and were reaching `List`'s own entry by widening the whole time.
	//
	// NOTE: It now measures 54,932, up 2,779, and the ceiling moves to 56,000
	// with it — the same ~1 kB of headroom as every move above. What grew is
	// `Transcendental.ts` becoming a linear span over a basis REGISTRY: a term
	// list a walk visits, in place of two struct fields, so that registering a
	// new constant is data rather than a change to the arithmetic. π is still
	// the only registered base, so the generality is text this Program carries
	// before anything uses it — what it buys lands with the next base.
	//
	// NOTE: It now measures 56,926, up 1,994, and the ceiling moves to 58,200
	// — the registry gained e, and `Number` gained the `E` and `GoldenRatio`
	// constants, whose initialisers ride into every Program that touches the
	// module. This is the move the registry design was bought for: the e-series
	// enclosure and two constants are the WHOLE of the growth, where the
	// previous base — π, hardcoded — cost 2,779 of machinery to merely
	// generalise. This Program writes no `e`, but "a stdlib body pulls its
	// whole transitive reach" is the standing shape of these bundles.
	//
	// NOTE: It now measures 61,136 and the ceiling moves to 62,200, keeping the
	// same ~1 kB of headroom. The figure it rose FROM is 57,859 rather than the
	// 56,926 recorded above — 933 bytes arrived between the two without a NOTE
	// — and the 3,277 that follow are `list-tail-sharing`, split two ways.
	// 2,877 are the runtime's: a List holds its items in two runs now, so every
	// walking native reads them through `viewOf` and walks the two rather than
	// one, `materialise` is the choke point that makes an upgraded List hold
	// them in one again, and both ride in wherever a List does. The remaining
	// 400 are the ONE emission change the improvement makes — each of this
	// Program's eight inlined walks reads `List.materialise(…)` where it read
	// `.value` and hoists its count into a const of its own.
	//
	// NOTE: 61,157 now, up 21: `split` binds the count of the Array it walks
	// instead of asking for it each turn, which is the rule the rest of the
	// file already kept. The ceiling stays where it is — the headroom was sized
	// for moves of a different order than a `let`.
	//
	// NOTE: It now measures 62,436, up 1,279, and the ceiling moves to 63,500 to
	// keep the same ~1 kB of headroom. All of it is the runtime's: the four List
	// edits answer with a box over the runs they do not touch, `remove(at:)`
	// came back from Essence as a native of its own, and `slice`, `insert` and
	// `replace` each grew the run-aware fill that replaces their `materialise`.
	// A little of it is paid back — the Essence `remove` body and its two-slice
	// composition left the prelude — and Irrational.es, which edits no List at
	// all, is unchanged to the byte, which is the shape to expect: what a
	// Program carries is the runtime reach of what it calls.
	//
	// NOTE: It measures 63,632 now, up 1,187 from 62,445, and the ceiling moves
	// to 64,700 to keep the same ~1 kB of headroom. It moved in three steps and
	// each is worth its own line, because two of them are the runtime growing
	// and one is the standard library shrinking. Up 1,028 for remembering a
	// String's normal form and its ASCII marker — the scan, the two Symbol keys
	// and `append` propagating them — which is what makes equality stop
	// normalising both sides per comparison and an append-build loop linear.
	// Down 278 when Rational's four same-kind arithmetic entries became natives
	// on the bigint-rational core: four Essence bodies left the prelude and what
	// replaced them is code the module already carried. Up 437 for `slice`,
	// `character(at:)` and `repeat` becoming natives, which is this file paying
	// TEXT for work in the plainest form — the Essence bodies were four calls
	// each into List Methods Everyday carries anyway, so nothing left with them,
	// and what arrived is a window taken out of the grapheme view instead of a
	// String allocated per character of the receiver. A String-heavy Program
	// collects the other side of that: String.es falls 1,851 to 25,406, which is
	// 807 BELOW where it started, because `characters`, `List.slice`, `List.item`
	// and `List.repeat` stop being reached through them at all.
	//
	// NOTE: It now measures 68,476, up 4,822, and the ceiling moved to keep
	// ~1 kB of headroom. The hybrid Integer is what grew it, and it grew the
	// TEXT rather than the work: an emitted `+`, `-` or `*` is now a guard —
	// two `typeof` reads and a pair of bounds on the answer — around the object
	// literal it used to be, and the answer's bound is a sixteen-digit number
	// written twice a site. Everyday performs arithmetic in twelve places it
	// can guard in line, which is about 3.3 kB of that; the rest is the three
	// escape entries and the canonicalisation the runtime gained. What RUNS is
	// between 1.4× and 2.2× faster on every arithmetic-bearing benchmark.
	//
	// NOTE: 68,858 now, up 382, and the ceiling STAYS: the three escape entries
	// each gained the arm that skips a canonicalisation the answer can not need.
	// Minifying does not take the guard back — it shortens the names AROUND a
	// pair of sixteen-digit literals it can not fold — so the figure this file
	// measures is the one to read.
	// NOTE: 70,766 now, up 2,286, and the ceiling moves to 71,800 to keep the
	// same ~1 kB of headroom. The file gained the readability pass's surface,
	// and one line of it is most of the figure: `hasItems(where:)` costs 1,459,
	// because the quantifier is written on `reduce`'s early-stopping entry and
	// brings that entry and the `Step` Choice into a Program that carried
	// neither. The receiver-side aggregates (`scores::sum()` and its three
	// siblings) cost 533, the two parsers asking for their own fallback 226,
	// and the held-Optional collapse 108; the two `firstItem` chains that
	// became `firstItem(defaultingTo:)` gave 40 back. Nothing here is the
	// numeric tower arriving whole, which is what this ceiling watches for.
	//
	// NOTE: 70,905 now, up 139, and the ceiling stays. `Record::toString` asks
	// the shared renderer for the printable form of a Rational, and every
	// recursive call carries the renderer it was asked for; the second
	// formatter itself stays out of a Program that prints no Record. The figure
	// the line above rose FROM is 68,653 rather than the 68,858 recorded, so
	// the readability pass is up 2,113 rather than 2,286 — the same unrecorded
	// drift this file has caught twice before.
	// NOTE: Byte-identical at 70,953 across the derived `Printable` for a
	// Choice of payload-free Cases: this file rounds a Rational and never
	// prints a Case, so it reached none of the six `toString` bodies that left
	// and does not carry the helper that replaced them. The 48 between 70,905
	// and 70,953 is drift that arrived on master without a NOTE, again.
	// NOTE: 71,337 now, up 384, and the ceiling moves to 72,400 to keep the
	// kilobyte of headroom the rest of this file keeps. `isBetween` and `clamp`
	// are `Orderable`'s provided Methods, and each is written on that
	// Protocol's own inequalities rather than on a native: this file reaches
	// `isBetween` and `clamp`, so it now carries five consts where it carried
	// two, each a line long, plus a method map per call site. What it stopped
	// carrying is the reason the trade is worth taking: `5::isBetween(1, and
	// 10)` reached `Number::compare` and the sixteen-cell cross-kind table
	// behind it, and now reaches `Integer.compare` alone.
	// NOTE: 73,032 now, up 1,695, and the ceiling moves to 74,100 to keep the
	// kilobyte of headroom the rest of this file keeps. A conformance witness
	// carries an entry for every Method the Protocol declares, PROVIDED ones
	// included, so that a bounded call reaches the conformer's override where it
	// wrote one — and `Integer` writes four of `Orderable`'s six. This file asks
	// `clamp` and `isBetween` and never asks an inequality, so those four bodies
	// are new here, and `$es_Equatable__isNot` and the `providedConformance`
	// helper arrive with them. What the rise buys is the one thing an override
	// is for: `5::isLessThan(3)` and the same call inside `<Item is Orderable>`
	// now run the same Method, so an override may say something different rather
	// than only the same thing faster.
	// NOTE: 72,831 now, down 201, and the ceiling STAYS at 74,100. Two figures
	// make the fall and only one of them is a change here: the line above rose
	// FROM 73,237 rather than the 73,032 recorded, so this campaign takes 406
	// off rather than 201 — the same unrecorded drift this file has caught
	// three times now. What leaves is the Optional handling around two powers.
	// `2::raise(to 10)` and `2/3::raise(to 2)` reach the entries a written
	// exponent proves and answer bare.
	// NOTE: 72,659 now, down 172, and the ceiling STAYS at 74,100 — 1,441 of
	// headroom, the order the rest of this file keeps. A written RECEIVER
	// proves its own predicates now, which retracts the last sentence above:
	// `2::raise(to -2)` answers bare as well, since a power is empty only
	// where a zero base meets a negative exponent. So does
	// `3/4::reciprocal()`, and `[1, 2, 3]::firstItem(defaultingTo 0)` and
	// `[1, 2]::average(defaultingTo 0/1)` lose fallbacks that could never be
	// read — the second of those never answered an Optional at all, it reached
	// the `NonEmptyList` entry. The fall is only 172 because the fixture had to
	// BUY an Optional back: `constant base = 1::add(1)` feeding
	// `base::raise(to -2)` is what keeps `value(defaultingTo:)` shown at all.
	// NOTE: 72,600 now, down 59, and the ceiling STAYS at 74,100. `Integer`
	// and `Rational` write an `is`/`isNot` pair of their own now, each holding
	// an entry for the other kind, so the witness this file builds for an
	// Integer names two consts of its own where it named `Equatable`'s
	// provided body through `providedConformance` — and that body leaves the
	// bundle entirely. What the pair buys is measured on a Program that asks
	// `rate::is(2)` and nothing else: 20.1 kB before and 6.2 kB now, against
	// 6.5 kB for the `rate::isLessThan(2)` that already had its Integer entry.
	// NOTE: 73,300 now, up 641 across the whole usability campaign, and the
	// ceiling moves to 74,400 to put back the kilobyte of headroom the rest of
	// this file keeps. Four changes reach this file and one is most of the
	// figure. `sort` takes a direction, so the `SortOrder` Choice and the
	// turned-around comparison arrive beside the three `sort()` calls here: 429.
	// `isBetween` reads its two bounds in either order for 203 — and for the
	// same 203 in Irrational.es, which never asks it, because a conformance
	// witness carries `Orderable`'s provided body whether the Program reaches it
	// or not. `List.of` splitting into an `overload static` block costs 27, and
	// the rendering rule gives 7 back: `List::toString` and `Optional::toString`
	// are natives now, so the walk that reached `join` is one runtime function
	// rather than an Essence body per Program. Everything else the campaign
	// added is free here — `firstItems`, `lastItems`, `group`, `replace(at:_:)`
	// and the numeric predicates are all unreached, which is the shakeability
	// this ceiling exists to watch.
	// NOTE: The figure the numeric line above fell to is 72,851 in this history
	// rather than the 72,600 it records, because `isBetween` landed before it
	// here and not on the branch it was measured on. The fall itself is the
	// same shape: 11 rather than 59.
	// NOTE: 74,806 now, up 1,506 from the 73,300 recorded, and the ceiling
	// moves to 75,900 to put back the kilobyte of headroom the rest of this
	// file keeps. Two figures make the rise and only one of them is a change:
	// the base commit measures 73,525, so 225 is drift that arrived on master
	// without a NOTE, and 1,281 is Dictionary. Every byte of that 1,281 is what
	// PRINTING a Dictionary costs, and every Program that prints anything at
	// all pays it: `getStringRepresentation` gained an arm for the written
	// form, and it reads a box through the `everyLiveEntry` and `liveEntriesOf`
	// pair, which the Type Module holds and no printing Program carried before.
	// Nothing else Dictionary added reaches this file — the Namespace, its
	// natives and the store are shaken away whole, which is the shakeability
	// this ceiling exists to watch.
	//
	// NOTE: 73,870 now, DOWN 936, and the ceiling comes down to 74,900 with it
	// — a ceiling two kilobytes above the measurement stops catching what this
	// one is for. The arithmetic is worth writing out, because the fall is a
	// design change rather than a deletion: 74,806 − 936 is 73,870, and against
	// the 73,525 the base commit measured that leaves 345. Those 345 are all a
	// Program that holds no Dictionary carries of one now — the KIND REGISTRY
	// (`registry.ts`: a `Map`, `kindOf`, and the line the printer probes it
	// with) — where the 1,281 above were the whole written form and the live
	// view behind it. The rendering moved into `Dictionary.ts`, which registers
	// it from the three doors a Dictionary is built through, so it rides in
	// with the container and nowhere else. The same move took the Dictionary
	// arms out of the universal equality and the test runtime's structural
	// difference; neither reaches this file, so neither is in the figure.
	it("keeps Everyday.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Everyday.es")).toBeLessThan(74_900)
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
	// `parse`. It now measures 31,932 — down 3,198 for the same reason
	// Everyday's figure fell, and by more of its own size, because a Program
	// this small carried structural equality for the sake of two comparisons.
	// The ceiling came down with it.
	//
	// NOTE: It now measures 28,265, and the two passes that moved it are worth
	// separating, because they moved it in OPPOSITE directions. Compiling a
	// Match's Type check to a tag test took 2,752 out (turning that pass off
	// puts the file back at 31,017), and letting the last Handler be the end of
	// its chain took 769 more — both of them by taking the last reference to a
	// runtime function out with the check, so the function leaves the bundle
	// too. `pool-constants` PUT 348 back: this Program writes few constants
	// twice, so what it gains in allocations it pays for in a band of consts
	// and a name at every site. That is the honest shape of that pass — it is
	// measured on what a Program DOES, and Everyday, which writes the same
	// handful of Integers and witnesses over and over, lost 2,392 bytes to it.
	//
	// NOTE: It now measures 31,151, up 2,886, for the same reason Everyday's
	// figure rose: the Transcendental representation is a basis-registry span
	// now. The ceiling moves to 32,200, keeping the same order of headroom.
	//
	// NOTE: It now measures 32,300, up 1,149, for the same reason Everyday's
	// figure rose — and this Program actually exercises the new base: it
	// prints `Number.E`, adds it to π, and holds the golden ratio. The ceiling
	// moves to 33,000, keeping the same order of headroom.
	//
	// NOTE: It now measures 33,635, up 852 from 32,783 — again a figure above
	// the 32,300 recorded, for the same unrecorded drift Everyday's saw — and
	// the ceiling moves to 34,400. All 852 are `list-tail-sharing`'s runtime
	// half; the emission half costs this Program nothing at all, because it
	// inlines no List walk, and that is the honest shape of the split: what
	// every Program pays is the runtime a List now needs, and what a walking
	// Program pays on top is a call and a const per walk.
	//
	// NOTE: It now measures 34,295, and the ceiling moves to 35,200 to put back
	// the order of headroom the rest of this file keeps. Two figures make the
	// rise, and only one of them is a change: the readability pass measured
	// 34,156, up 72 from the 34,084 the base commit measured, and the 449
	// between that and the 33,635 recorded above is drift that arrived on
	// master without a NOTE. The 139 on top are `Record::toString` asking the
	// shared renderer for the printable form of a Rational, which every
	// recursive call now carries.
	// NOTE: It now measures 34,083, down 260, and the ceiling STAYS at 35,200 —
	// a fall of this size leaves the same order of headroom. This file prints
	// what `compare` answers, twice, so it carried `Ordering`'s written
	// `toString`: a three-armed Match and the three String Literals under it.
	// A Choice of payload-free Cases derives that Method now, and what arrived
	// instead is the one `choiceName` helper reading the Case out of the tag —
	// which is what every Program that prints any such Choice pays, once.
	// NOTE: It now measures 34,438, up 355, and the ceiling STAYS at 35,200 —
	// the same 762 bytes of headroom this file has kept before, and a rise of
	// this size is the four inequalities becoming `Orderable`'s provided
	// Methods. This file asks three of them, so it carries three consts and a
	// method map where it carried three Methods of `Number`; the cross-kind
	// `compare` it reaches through the witness is the one it always reached.
	// NOTE: It now measures 36,102, up 1,664, and the ceiling moves to 37,000 —
	// the same order of headroom, and the same reason Everyday's figure rose.
	// This file compares Integers as well as Irrationals, so `Integer`'s written
	// inequalities enter its witness whether or not the file calls them; the
	// cross-kind `compare` it reaches through the covering Namespace's witness is
	// the one it always reached.
	// NOTE: It now measures 36,598, up 496, and the ceiling moves to 37,500 to
	// put back the order of headroom the rest of this file keeps. Two figures
	// make the rise and only one of them is a change here: the line above rose
	// FROM 36,211 rather than the 36,102 recorded, so this campaign adds 387
	// rather than 496. This file scales and divides irrationals by written
	// Integers, so `@::multiply(with 3)` and `Number.Pi::multiply(with 2)` reach
	// the `NonZeroInteger` rungs the irrationals gained and answer an Algebraic
	// or a Transcendental rather than a Union — which is what puts each answer's
	// own arithmetic in the bundle instead of the covering `Number`'s.
	// NOTE: It now measures 36,292, down 306, and the ceiling STAYS at 37,500 —
	// 1,208 of headroom, the order the rest of this file keeps. A written
	// receiver proves its own sign, so the three `Terminal.inspect(N::
	// squareRoot())` calls answer a number and the two Matches over a root
	// lose their `#Value`/`#Empty` arms. What arrived against it is the
	// Optional the fixture bought back: `constant computedNegative =
	// 0::subtract(4)` and the `squareRoot` of it, so a root that has no answer
	// is still shown.
	// NOTE: 36,467 now, up 175, and the ceiling STAYS at 37,500 — 1,033 of
	// headroom, the order the rest of this file keeps. Two changes reach a file
	// that asks for neither by name. `isBetween` reading its bounds in either
	// order adds 203, because the witness this file builds carries `Orderable`'s
	// provided body whichever Methods the Program calls. The rendering rule
	// gives 28 back: this file prints the `squareRoot` of a negative, and
	// `Optional::toString` is a native now rather than a body written on a hole.
	// Nothing else the campaign added is reached at all.
	// NOTE: 37,973 now, up 1,506 from the 36,467 recorded, and the ceiling
	// moves to 39,000 for the same reason and by the same split as Everyday's:
	// 225 of drift and 1,281 of Dictionary. The two files rise by exactly the
	// same amount, which is the honest shape of this one — what printing a
	// Dictionary costs is a fixed piece of the runtime rather than anything
	// either Program does, and neither of them names a Dictionary at all.
	//
	// NOTE: 37,017 now, down 956, and the ceiling comes down to 38,000. The
	// same fall as Everyday's and for the same reason — 37,973 − 956 is 37,017,
	// which is 325 above the 36,692 this file measured before Dictionary, and
	// those 325 are the kind registry and the printer's probe of it. It is
	// twenty fewer bytes than Everyday pays for the same thing, which is
	// escodegen's indentation and nothing else.
	it("keeps Irrational.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Irrational.es")).toBeLessThan(38_000)
	})

	// NOTE: And the other side of that trade, recorded rather than merely
	// implied: what a Program that DOES hold a Dictionary carries. Measured
	// 40,384 bytes for the fixture that walks the whole Namespace — the store,
	// every native the file reaches, the written form, the kind registry and
	// the registration that fills it. The ceiling keeps the kilobyte of
	// headroom the rest of this file keeps; what it is here to catch is the
	// registry being bypassed, which would put the rendering back in front of
	// every Program whether it holds a Dictionary or not, and a `Dictionary.ts`
	// grown top-level side effects, which would pin the whole store into the
	// two files above.
	it("charges a Dictionary Program for the container it uses", async () => {
		expect(await bundleSizeOf("Dictionary.es")).toBeLessThan(41_400)
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
	// NOTE: It now measures 15,259 and the ceiling moves to 15,800, keeping the
	// same ~500 bytes. The 5,434 bytes are `compile-type-tests`: these Modules
	// read fallible answers back through `Optional`, so every Match in them and
	// in the prelude they share was a descriptor handed to `isValueOfType`, and
	// with the descriptors gone the function is unreferenced and leaves the
	// bundle. `pool-constants` took 19 bytes more off it: these Modules are
	// small enough that most of their constants are written once, and a const
	// and a name cost about what the value cost inline. The headroom is what
	// matters here rather than the figure — the duplication this test exists to
	// catch is about a kilobyte.
	//
	// NOTE: It measured 20,693 before that, and the ceiling was 21,200. 530 of the
	// rise came with the nominal `Optional` and went unrecorded here — the
	// figure above stayed at 19,499 while the measurement moved to 20,030 — and
	// 663 are the unconditional runtime improvements: 137 for the interned
	// Booleans, 275 for the interned unit Cases, 38 for the reflexive equality
	// shortcut and 213 for remembering a Rational's lowest-terms form. This
	// bundle reaches no String Method that segments, so the grapheme view costs
	// it nothing. The ceiling keeps ~500 bytes of headroom deliberately: the
	// duplication it exists to catch is about a kilobyte here, so it has to stay
	// nearer than that to the measurement to catch one.
	//
	// NOTE: It now measures 10,887, down 4,436, and the ceiling comes DOWN to
	// 11,400 with it — a ceiling 4 kB above the measurement would no longer
	// catch the kilobyte of duplication this test is for, so a fall has to be
	// followed just as a rise is. `Main.es` prints for a reader now rather than
	// inspecting, and the structural printer is what left with the last
	// `inspect`: `getStringRepresentation` and the whole layout behind it —
	// Records, Lists, the Algebraic radical rendering and its two rational
	// formatters. The prelude GREW by three bodies while the bundle shrank
	// (`Terminal::print`'s two Overloads and `String::toString`), which is the
	// shape worth remembering: what these Programs carry is decided by the
	// runtime reach of what they call, not by how much Essence they inline.
	//
	// NOTE: It now measures 11,675 and the ceiling moves to 12,200, keeping the
	// same ~500 bytes. 652 of the rise are `append` propagating the ASCII marker
	// — the scan, the remembering around it and the branch that hands the join
	// the two counts added — which is what makes building a String by appending
	// and measuring it linear rather than quadratic. These Modules append
	// without ever measuring, so they pay for it and collect nothing, which is
	// the honest worst case for it. Against that, the eagerly built
	// `Intl.Segmenter` left: it is constructed on first use now, so a Program
	// that never segments neither carries it nor pays the millisecond of table
	// loading it cost at startup. 26 more arrived with Rational's arithmetic
	// natives, for 11,701; the ceiling is sized for moves of a different order.
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
		// NOTE: 14,683 since the hybrid Integer, for the reason Everyday's
		// figure rose: the prelude carries the standard library's own
		// arithmetic, and each site it can guard in line is a guard wider than
		// the operation it wraps.
		//
		// NOTE: Byte-identical at 14,890 across `Equatable`'s and `Orderable`'s
		// provided Methods. These Modules ask none of the six, and the one
		// `isNot` they would have reached is `Optional`'s, which is written.
		//
		// NOTE: And byte-identical again at 14,890 across a witness carrying its
		// Protocol's provided Methods. A witness only grows where the Protocol
		// provides something, and the ones these Modules build are `Printable`'s
		// and `Comparable`'s, which provide nothing at all. `HelloWorld.es` is
		// unmoved at 6,241 for the same reason.
		expect(result.outputs[0]!.contents.byteLength).toBeLessThan(15_500)
	})
})
