import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The full pipeline minus bundling, mirroring loop.spec — the searching
// Methods below are only proven once the emitted JavaScript RUNS, because what
// went wrong in them was never a Type error: a List that STORES an empty
// Optional, a `List<Optional<Integer>>` walked by `anyItem` and
// `"aaa"::lastIndex(of "aa")` all compiled without a single Diagnostic and
// answered the wrong value.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-search-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

// NOTE: An `Integer | Nothing` conformance spelled by hand — an item Type that
// still CONTAINS `Nothing` now that `Optional` does not, and the hand-written
// counterpart to the equality a Choice derives for `Optional<Integer>` above
// it. The narrowed Integer can not answer with its own `is` here: with the
// other side still a Union that call resolves back to this very Method and
// never returns, so the comparison goes through `compare`, the way `String.is`
// does.
const maybeIntegers = `namespace MaybeInts for Integer | Nothing is Equatable {
	is(_ other: Integer | Nothing) -> Boolean {
		<- match @ -> Boolean {
			case Nothing {
				<- match other -> Boolean {
					case Nothing { <- true }
					case _ { <- false }
				}
			}

			case _ {
				constant mine = @

				<- match other -> Boolean {
					case Nothing { <- false }
					case _ { <- mine::compare(to @)::is(#Equal) }
				}
			}
		}
	}

	isNot(_ other: Integer | Nothing) -> Boolean {
		<- @::is(other)::negate()
	}
}`

describe("Stdlib searching Methods", () => {
	// NOTE: The whole point of this block: an EMPTY Optional stored in a List
	// is an item like any other, and the Methods that search by value have to
	// compare it rather than read it as "no item here".
	//
	// This used to be a claim about `item(at:)` as much as about the search:
	// while `Optional<ItemType>` collapsed when nested, its answer for a
	// stored empty item and its answer for a position past the end were the
	// SAME value, so no amount of reading could tell them apart and
	// `firstIndex`/`lastIndex` had to count their way through the ITEMS
	// instead. A nominal Choice nests, so `#Value(#Empty)` and `#Empty` are
	// now different values and the distinction is finally observable — the
	// test below pins it. The counting stays, but for the smaller reason the
	// Stdlib gives it: `reduce` hands each item as it stands, where walking
	// the positions would build and take apart a wrapper per item.
	describe("a stored empty Optional is an item like any other", () => {
		it("finds the positions of an empty Optional in a List of them", async () => {
			expect(
				await run(`implementation {
					constant empties: List<Optional<Integer>> = [#Empty, #Empty]

					__print(empties::firstIndex(of #Empty)::toString())
					__print(empties::lastIndex(of #Empty)::toString())
				}`),
			).toEqual(['"Value(0)"', '"Value(1)"'])
		})

		it("sees a stored empty Optional from contains and count", async () => {
			expect(
				await run(`implementation {
					constant empties: List<Optional<Integer>> = [#Empty, #Empty]

					__print(empties::contains(#Empty)::toString())
					__print(empties::doesNotContain(#Empty)::toString())
					__print(empties::count(of #Empty)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"2"'])
		})

		// NOTE: `removeDuplicates` asks `contains` whether it has kept an item
		// already, so it inherits the answer — with `contains` blind to a
		// stored empty Optional it kept every one of them.
		it("keeps one empty Optional when duplicates are removed", async () => {
			expect(
				await run(`implementation {
					constant empties: List<Optional<Integer>> = [#Empty, #Empty]

					__print(empties::removeDuplicates()::length()::toString())
				}`),
			).toEqual(['"1"'])
		})

		// NOTE: The sharper half of the block, and the one that could not be
		// written at all while `Optional` was a Type Alias: reading a stored
		// empty item now answers `Value(Empty)` — a value that IS there and
		// happens to be empty — where reading past the end answers `Empty`.
		// Two levels, two different answers, from the same `Optional<Integer>`
		// item Type.
		it("tells a stored empty Optional apart from a position past the end", async () => {
			expect(
				await run(`implementation {
					constant empties: List<Optional<Integer>> = [#Empty, #Empty]
					constant none: List<Optional<Integer>> = []

					__print(empties::item(at 0)::toString())
					__print(empties::item(at 5)::toString())
					__print(empties::firstItem()::toString())
					__print(none::firstItem()::toString())
				}`),
			).toEqual([
				'"Value(Empty)"',
				'"Empty"',
				'"Value(Empty)"',
				'"Empty"',
			])
		})

		// NOTE: The searches run on the equality a Choice DERIVES from its
		// tags and its payloads, so `#Empty` matches only the empty items and
		// `#Value(1)` only the one holding a 1 — no Namespace is written for
		// `Optional<Integer>` anywhere in this Program.
		it("finds the empty Optionals among the values beside them", async () => {
			expect(
				await run(`implementation {
					constant mixed: List<Optional<Integer>> = [
						#Empty,
						#Value(1),
						#Empty,
					]

					__print(mixed::firstIndex(of #Empty)::toString())
					__print(mixed::lastIndex(of #Empty)::toString())
					__print(mixed::count(of #Empty)::toString())
					__print(mixed::firstIndex(of #Value(1))::toString())
					__print(mixed::lastIndex(of #Value(1))::toString())
					__print(mixed::firstIndex(of #Value(7))::toString())
					__print(mixed::lastIndex(of #Value(7))::toString())
				}`),
			).toEqual([
				'"Value(0)"',
				'"Value(2)"',
				'"2"',
				'"Value(1)"',
				'"Value(1)"',
				'"Empty"',
				'"Empty"',
			])
		})

		it("finds the nothing among the items of a hand-written Union item Type", async () => {
			expect(
				await run(`implementation {
					${maybeIntegers}

					constant mixed: List<Integer | Nothing> = [nothing, 1, nothing]

					__print(mixed::firstIndex(of nothing)::toString())
					__print(mixed::lastIndex(of nothing)::toString())
					__print(mixed::count(of nothing)::toString())
				}`),
			).toEqual(['"Value(0)"', '"Value(2)"', '"2"'])
		})

		it("still finds the ordinary items beside them", async () => {
			expect(
				await run(`implementation {
					${maybeIntegers}

					constant mixed: List<Integer | Nothing> = [nothing, 1, nothing]

					__print(mixed::firstIndex(of 1)::toString())
					__print(mixed::lastIndex(of 1)::toString())
					__print(mixed::firstIndex(of 7)::toString())
					__print(mixed::lastIndex(of 7)::toString())
				}`),
			).toEqual(['"Value(1)"', '"Value(1)"', '"Empty"', '"Empty"'])
		})
	})

	// NOTE: `anyItem`/`everyItem` used to be `firstItem(where:)::hasValue()`,
	// which reads the matching item back out — and while `Optional` collapsed
	// when nested, a matching item that was itself empty came back as the very
	// value the Method answers when nothing matched at all. That is no longer
	// so: `#Value(#Empty)` is not `#Empty`, so the reading formulation would
	// answer these correctly today, and the test below holds it to that. The
	// Boolean fold stays for the remaining reason — it carries the ANSWER
	// through `reduce` and builds nothing, where reading builds an Optional
	// per call only to throw it away.
	describe("anyItem and everyItem decide on the check", () => {
		it("answers true when the matching item is itself empty", async () => {
			expect(
				await run(`implementation {
					constant parsed: List<Optional<Integer>> = [
						Integer.parse("nope"),
						Integer.parse("5"),
					]

					__print(parsed::anyItem(where (value) {
						<- value::isEmpty()
					})::toString())
				}`),
			).toEqual(['"true"'])
		})

		it("answers false when the failing item is itself empty", async () => {
			expect(
				await run(`implementation {
					constant parsed: List<Optional<Integer>> = [
						Integer.parse("nope"),
						Integer.parse("5"),
					]

					__print(parsed::everyItem(where (value) {
						<- value::hasValue()
					})::toString())
				}`),
			).toEqual(['"false"'])
		})

		// NOTE: The claim the NOTE above makes, pinned: the Optional the
		// reading formulation builds is `Value(Empty)` for the empty item it
		// FOUND and `Empty` for the List that holds no empty item at all, so
		// `hasValue` agrees with `anyItem` on both. Nothing depends on this —
		// it is the evidence that the fold is now a cost decision rather than
		// a correctness one.
		it("agrees with the reading formulation now that Optionals nest", async () => {
			expect(
				await run(`implementation {
					constant parsed: List<Optional<Integer>> = [
						Integer.parse("nope"),
						Integer.parse("5"),
					]
					constant allValues: List<Optional<Integer>> = [
						Integer.parse("5"),
					]

					__print(parsed::firstItem(where (value) {
						<- value::isEmpty()
					})::toString())
					__print(parsed::firstItem(where (value) {
						<- value::isEmpty()
					})::hasValue()::toString())
					__print(allValues::firstItem(where (value) {
						<- value::isEmpty()
					})::toString())
					__print(allValues::anyItem(where (value) {
						<- value::isEmpty()
					})::toString())
				}`),
			).toEqual(['"Value(Empty)"', '"true"', '"Empty"', '"false"'])
		})

		it("keeps the answers an ordinary List already had", async () => {
			expect(
				await run(`implementation {
					constant numbers = [1, 2, 3]
					constant none: List<Integer> = []

					__print(numbers::anyItem(where (item) {
						<- item::isGreaterThan(2)
					})::toString())
					__print(numbers::anyItem(where (item) {
						<- item::isGreaterThan(9)
					})::toString())
					__print(none::anyItem(where (item) {
						<- item::isGreaterThan(0)
					})::toString())
					__print(numbers::everyItem(where (item) {
						<- item::isGreaterThan(0)
					})::toString())
					__print(numbers::everyItem(where (item) {
						<- item::isGreaterThan(2)
					})::toString())
					__print(none::everyItem(where (item) {
						<- item::isGreaterThan(0)
					})::toString())
				}`),
			).toEqual([
				'"true"',
				'"false"',
				'"false"',
				'"true"',
				'"false"',
				'"true"',
			])
		})

		// NOTE: `__print` answers with the value it prints, so a check that
		// wraps its item leaves a record of every item the walk reached. This is
		// what proves the Boolean fold still LEAVES the walk: both stop at the
		// item that decided the answer and never see the fourth.
		it("still stops at the item that decides the answer", async () => {
			expect(
				await run(`implementation {
					constant any = [1, 2, 3, 4]::anyItem(where (item) {
						<- __print(item)::isGreaterThan(1)
					})
					constant every = [1, 2, 3, 4]::everyItem(where (item) {
						<- __print(item)::isLessThan(2)
					})

					__print(any::toString())
					__print(every::toString())
				}`),
			).toEqual(["1", "2", "1", "2", '"true"', '"false"'])
		})
	})

	// NOTE: `lastIndex` used to be derived from `split(on:)`, which scans left
	// to right and CONSUMES each match it finds, so it answered the last
	// non-overlapping match rather than the last occurrence. It is the first
	// occurrence of the reversed part in the reversed String now.
	describe("String.lastIndex(of:)", () => {
		it("finds the last occurrence when occurrences overlap", async () => {
			// NOTE: The positions JavaScript's own `lastIndexOf` answers, which
			// is what "the last occurrence" means: "aaa" has "aa" at 0 AND at 1.
			expect(
				await run(`implementation {
					__print("aaa"::lastIndex(of "aa")::toString())
					__print("aaaa"::lastIndex(of "aa")::toString())
					__print("banana"::lastIndex(of "ana")::toString())
					__print("mississippi"::lastIndex(of "issi")::toString())
				}`),
			).toEqual(['"Value(1)"', '"Value(2)"', '"Value(3)"', '"Value(4)"'])
		})

		it("keeps the answers the non-overlapping cases had", async () => {
			expect(
				await run(`implementation {
					__print("a-b-a"::lastIndex(of "a")::toString())
					__print("hello, World"::lastIndex(of "l")::toString())
					__print("hello, World"::lastIndex(of "hello")::toString())
					__print("hello, World"::lastIndex(of "World")::toString())
					__print("hello, World"::lastIndex(of "zz")::toString())
				}`),
			).toEqual([
				'"Value(4)"',
				'"Value(10)"',
				'"Value(0)"',
				'"Value(7)"',
				'"Empty"',
			])
		})

		it("answers the length for the empty part, as its mirror does", async () => {
			expect(
				await run(`implementation {
					__print("hello"::lastIndex(of "")::toString())
					__print(""::lastIndex(of "")::toString())
					__print(""::lastIndex(of "a")::toString())
					__print("hello"::firstIndex(of "")::toString())
				}`),
			).toEqual(['"Value(5)"', '"Value(0)"', '"Empty"', '"Value(0)"'])
		})

		// NOTE: Positions are by GRAPHEME everywhere in the Namespace, and the
		// reversal both sides go through is `characters()::reverse()`, which
		// never splits one — so a String of emoji counts the same either way.
		it("counts the positions by grapheme", async () => {
			expect(
				await run(`implementation {
					__print("😀a😀"::lastIndex(of "😀")::toString())
					__print("😀a😀"::firstIndex(of "😀")::toString())
				}`),
			).toEqual(['"Value(2)"', '"Value(0)"'])
		})
	})

	// NOTE: The List Methods that were already right, kept right — the reversal
	// `lastIndex` is written on has to leave an ordinary List's positions where
	// they were, and the fold `firstIndex` counts with has to keep answering an
	// EMPTY Optional for an absent item rather than the length it settles on.
	describe("List.firstIndex and List.lastIndex on ordinary items", () => {
		it("answers the first and last position of a repeated item", async () => {
			expect(
				await run(`implementation {
					constant numbers = [1, 2, 3, 1]

					__print(numbers::firstIndex(of 1)::toString())
					__print(numbers::lastIndex(of 1)::toString())
					__print(numbers::firstIndex(of 3)::toString())
					__print(numbers::lastIndex(of 3)::toString())
				}`),
			).toEqual(['"Value(0)"', '"Value(3)"', '"Value(2)"', '"Value(2)"'])
		})

		it("answers an empty Optional for an absent item and for the empty List", async () => {
			expect(
				await run(`implementation {
					constant numbers = [1, 2, 3, 1]
					constant none: List<Integer> = []

					__print(numbers::firstIndex(of 9)::toString())
					__print(numbers::lastIndex(of 9)::toString())
					__print(none::firstIndex(of 1)::toString())
					__print(none::lastIndex(of 1)::toString())
				}`),
			).toEqual(['"Empty"', '"Empty"', '"Empty"', '"Empty"'])
		})

		// NOTE: The bound is what carries equality down: a `List<List<Integer>>`
		// searches through `List.is` curried with the Integers' own, and both
		// Methods have to hand that witness on — `lastIndex` through the
		// `firstIndex` call it is written on.
		it("searches through the items' own conformance", async () => {
			expect(
				await run(`implementation {
					__print(["a", "b", "a"]::lastIndex(of "a")::toString())
					__print([[1], [2], [1]]::firstIndex(of [1])::toString())
					__print([[1], [2], [1]]::lastIndex(of [1])::toString())
				}`),
			).toEqual(['"Value(2)"', '"Value(0)"', '"Value(2)"'])
		})
	})
})
