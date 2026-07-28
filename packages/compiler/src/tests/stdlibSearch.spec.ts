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
// went wrong in them was never a Type error: a `List<Nothing>`, a
// `List<Optional<Integer>>` and `"aaa"::lastIndex(of "aa")` all compiled
// without a single Diagnostic and answered the wrong value.
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

// NOTE: An `Integer | Nothing` conformance spelled by hand — the second way a
// Program reaches an item Type that CONTAINS `Nothing` and still conforms to
// `Equatable` (the first is the builtin `List<Nothing>`). The narrowed Integer
// can not answer with its own `is` here: with the other side still a Union that
// call resolves back to this very Method and never returns, so the comparison
// goes through `compare`, the way `String.is` does.
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
	// NOTE: The whole point of this block: a `nothing` STORED in a List is an
	// item like any other, and the Methods that search by value have to compare
	// it rather than read it as "no item here". Walking the positions with
	// `item(at:)` can not tell the two apart — its `Optional<ItemType>` answer
	// is the same value for a stored `nothing` and for a position past the end
	// — so `firstIndex`/`lastIndex` count their way through the ITEMS instead.
	describe("a stored nothing is an item like any other", () => {
		it("finds the positions of nothing in a List<Nothing>", async () => {
			expect(
				await run(`implementation {
					constant nothings: List<Nothing> = [nothing, nothing]

					__print(nothings::firstIndex(of nothing)::toString())
					__print(nothings::lastIndex(of nothing)::toString())
				}`),
			).toEqual(['"0"', '"1"'])
		})

		it("sees a stored nothing from contains and count", async () => {
			expect(
				await run(`implementation {
					constant nothings: List<Nothing> = [nothing, nothing]

					__print(nothings::contains(nothing)::toString())
					__print(nothings::doesNotContain(nothing)::toString())
					__print(nothings::count(of nothing)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"2"'])
		})

		// NOTE: `removeDuplicates` asks `contains` whether it has kept an item
		// already, so it inherits the answer — with `contains` blind to a stored
		// `nothing` it kept every one of them.
		it("keeps one nothing when duplicates are removed", async () => {
			expect(
				await run(`implementation {
					constant nothings: List<Nothing> = [nothing, nothing]

					__print(nothings::removeDuplicates()::length()::toString())
				}`),
			).toEqual(['"1"'])
		})

		it("finds nothing among the items of a Union item Type", async () => {
			expect(
				await run(`implementation {
					${maybeIntegers}

					constant mixed: List<Integer | Nothing> = [nothing, 1, nothing]

					__print(mixed::firstIndex(of nothing)::toString())
					__print(mixed::lastIndex(of nothing)::toString())
					__print(mixed::count(of nothing)::toString())
				}`),
			).toEqual(['"0"', '"2"', '"2"'])
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
			).toEqual(['"1"', '"1"', '"Nothing"', '"Nothing"'])
		})
	})

	// NOTE: `anyItem`/`everyItem` used to be `firstItem(where:)::hasValue()`,
	// which reads the matching item back out — and a matching item that IS
	// `nothing` is the same value the Method answers when nothing matched at
	// all. They carry a Boolean through the fold now, which has no second
	// reading.
	describe("anyItem and everyItem decide on the check", () => {
		it("answers true when the matching item is itself nothing", async () => {
			expect(
				await run(`implementation {
					constant parsed: List<Optional<Integer>> = [
						Integer.parse("nope"),
						Integer.parse("5"),
					]

					__print(parsed::anyItem(matches (value) {
						<- value::isNothing()
					})::toString())
				}`),
			).toEqual(['"true"'])
		})

		it("answers false when the failing item is itself nothing", async () => {
			expect(
				await run(`implementation {
					constant parsed: List<Optional<Integer>> = [
						Integer.parse("nope"),
						Integer.parse("5"),
					]

					__print(parsed::everyItem(matches (value) {
						<- value::hasValue()
					})::toString())
				}`),
			).toEqual(['"false"'])
		})

		it("keeps the answers an ordinary List already had", async () => {
			expect(
				await run(`implementation {
					constant numbers = [1, 2, 3]
					constant none: List<Integer> = []

					__print(numbers::anyItem(matches (item) {
						<- item::isGreaterThan(2)
					})::toString())
					__print(numbers::anyItem(matches (item) {
						<- item::isGreaterThan(9)
					})::toString())
					__print(none::anyItem(matches (item) {
						<- item::isGreaterThan(0)
					})::toString())
					__print(numbers::everyItem(matches (item) {
						<- item::isGreaterThan(0)
					})::toString())
					__print(numbers::everyItem(matches (item) {
						<- item::isGreaterThan(2)
					})::toString())
					__print(none::everyItem(matches (item) {
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
					constant any = [1, 2, 3, 4]::anyItem(matches (item) {
						<- __print(item)::isGreaterThan(1)
					})
					constant every = [1, 2, 3, 4]::everyItem(matches (item) {
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
			).toEqual(['"1"', '"2"', '"3"', '"4"'])
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
			).toEqual(['"4"', '"10"', '"0"', '"7"', '"Nothing"'])
		})

		it("answers the length for the empty part, as its mirror does", async () => {
			expect(
				await run(`implementation {
					__print("hello"::lastIndex(of "")::toString())
					__print(""::lastIndex(of "")::toString())
					__print(""::lastIndex(of "a")::toString())
					__print("hello"::firstIndex(of "")::toString())
				}`),
			).toEqual(['"5"', '"0"', '"Nothing"', '"0"'])
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
			).toEqual(['"2"', '"0"'])
		})
	})

	// NOTE: The List Methods that were already right, kept right — the reversal
	// `lastIndex` is written on has to leave an ordinary List's positions where
	// they were, and the fold `firstIndex` counts with has to keep answering
	// `Nothing` for an absent item rather than the length it settles on.
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
			).toEqual(['"0"', '"3"', '"2"', '"2"'])
		})

		it("answers Nothing for an absent item and for the empty List", async () => {
			expect(
				await run(`implementation {
					constant numbers = [1, 2, 3, 1]
					constant none: List<Integer> = []

					__print(numbers::firstIndex(of 9)::toString())
					__print(numbers::lastIndex(of 9)::toString())
					__print(none::firstIndex(of 1)::toString())
					__print(none::lastIndex(of 1)::toString())
				}`),
			).toEqual(['"Nothing"', '"Nothing"', '"Nothing"', '"Nothing"'])
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
			).toEqual(['"2"', '"0"', '"2"'])
		})
	})
})
