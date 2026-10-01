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

// The full pipeline minus bundling, and the emitted JavaScript runs. A wrong
// search answer is never a Type error, so only running shows it.
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

// A Union derives no equality, so `List<Integer | String>` needs this
// hand-written conformance to be searched.
//
// Each arm narrows both sides before it compares. At the Union Type, `is`
// would resolve back to this Method and never return.
const integersOrStrings = `namespace IntegersOrStrings for Integer | String is Equatable {
	is(_ other: Integer | String) -> Boolean {
		<- match @ -> Boolean {
			case String {
				constant mine = @

				<- match other -> Boolean {
					case String { <- mine::is(@) }
					case Integer { <- false }
				}
			}

			case Integer {
				constant mine = @

				<- match other -> Boolean {
					case Integer { <- mine::is(@) }
					case String { <- false }
				}
			}
		}
	}

	isNot(_ other: Integer | String) -> Boolean {
		<- @::is(other)::negate()
	}
}`

describe("Stdlib searching Methods", () => {
	// An empty Optional stored in a List is an item like any other. The
	// searches by value compare it rather than read it as no item.
	describe("a stored empty Optional is an item like any other", () => {
		it("finds the positions of an empty Optional in a List of them", async () => {
			expect(
				await run(`implementation {
					constant empties: List<Optional<Integer>> = [#Empty, #Empty]

					Terminal.inspect(empties::firstIndex(of #Empty)::toString())
					Terminal.inspect(empties::lastIndex(of #Empty)::toString())
				}`),
			).toEqual(['"Value(0)"', '"Value(1)"'])
		})

		it("sees a stored empty Optional from contains and count", async () => {
			expect(
				await run(`implementation {
					constant empties: List<Optional<Integer>> = [#Empty, #Empty]

					Terminal.inspect(empties::contains(#Empty)::toString())
					Terminal.inspect(empties::doesNotContain(#Empty)::toString())
					Terminal.inspect(empties::count(of #Empty)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"2"'])
		})

		// `removeDuplicates` decides by the item's own `is`, as `contains`
		// does.
		it("keeps one empty Optional when duplicates are removed", async () => {
			expect(
				await run(`implementation {
					constant empties: List<Optional<Integer>> = [#Empty, #Empty]

					Terminal.inspect(empties::removeDuplicates()::length()::toString())
				}`),
			).toEqual(['"1"'])
		})

		// Reading a stored empty item answers `Value(Empty)`, and reading past
		// the end answers `Empty`.
		it("tells a stored empty Optional apart from a position past the end", async () => {
			expect(
				await run(`implementation {
					constant empties: List<Optional<Integer>> = [#Empty, #Empty]
					constant none: List<Optional<Integer>> = []

					Terminal.inspect(empties::item(at 0)::toString())
					Terminal.inspect(empties::item(at 5)::toString())
					Terminal.inspect(empties::firstItem()::toString())
					Terminal.inspect(none::firstItem()::toString())
				}`),
			).toEqual([
				'"Value(Empty)"',
				'"Empty"',
				'"Value(Empty)"',
				'"Empty"',
			])
		})

		// The searches run on the equality the Choice derives from its tags
		// and payloads. The Program writes no Namespace for `Optional<Integer>`.
		it("finds the empty Optionals among the values beside them", async () => {
			expect(
				await run(`implementation {
					constant mixed: List<Optional<Integer>> = [
						#Empty,
						#Value(1),
						#Empty,
					]

					Terminal.inspect(mixed::firstIndex(of #Empty)::toString())
					Terminal.inspect(mixed::lastIndex(of #Empty)::toString())
					Terminal.inspect(mixed::count(of #Empty)::toString())
					Terminal.inspect(mixed::firstIndex(of #Value(1))::toString())
					Terminal.inspect(mixed::lastIndex(of #Value(1))::toString())
					Terminal.inspect(mixed::firstIndex(of #Value(7))::toString())
					Terminal.inspect(mixed::lastIndex(of #Value(7))::toString())
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
	})

	// Over a Union the searches run a conformance the Program wrote, handed on
	// through the same bound.
	describe("a hand-written conformance over a Union item Type", () => {
		it("finds every item of one member of the Union", async () => {
			expect(
				await run(`implementation {
					${integersOrStrings}

					constant mixed: List<Integer | String> = ["a", 1, "a"]

					Terminal.inspect(mixed::firstIndex(of "a")::toString())
					Terminal.inspect(mixed::lastIndex(of "a")::toString())
					Terminal.inspect(mixed::count(of "a")::toString())
				}`),
			).toEqual(['"Value(0)"', '"Value(2)"', '"2"'])
		})

		it("still finds the items of the other member beside them", async () => {
			expect(
				await run(`implementation {
					${integersOrStrings}

					constant mixed: List<Integer | String> = ["a", 1, "a"]

					Terminal.inspect(mixed::firstIndex(of 1)::toString())
					Terminal.inspect(mixed::lastIndex(of 1)::toString())
					Terminal.inspect(mixed::firstIndex(of 7)::toString())
					Terminal.inspect(mixed::lastIndex(of 7)::toString())
				}`),
			).toEqual(['"Value(1)"', '"Value(1)"', '"Empty"', '"Empty"'])
		})
	})

	// The quantified `hasItems` entries fold a Boolean, so a matching item that
	// is itself empty still counts as a match.
	describe("the quantified hasItems entries decide on the check", () => {
		it("answers true when the matching item is itself empty", async () => {
			expect(
				await run(`implementation {
					constant parsed: List<Optional<Integer>> = [
						Integer.parse("nope"),
						Integer.parse("5"),
					]

					Terminal.inspect(parsed::hasItems(where (value) {
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

					Terminal.inspect(parsed::hasOnlyItems(where (value) {
						<- value::hasValue()
					})::toString())
				}`),
			).toEqual(['"false"'])
		})

		// Reading the match back with `firstItem(where:)` answers `Value(Empty)`
		// for an empty item found and `Empty` for none, so it agrees with
		// `hasItems(where:)`.
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

					Terminal.inspect(parsed::firstItem(where (value) {
						<- value::isEmpty()
					})::toString())
					Terminal.inspect(parsed::firstItem(where (value) {
						<- value::isEmpty()
					})::hasValue()::toString())
					Terminal.inspect(allValues::firstItem(where (value) {
						<- value::isEmpty()
					})::toString())
					Terminal.inspect(allValues::hasItems(where (value) {
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

					Terminal.inspect(numbers::hasItems(where (item) {
						<- item::isGreaterThan(2)
					})::toString())
					Terminal.inspect(numbers::hasItems(where (item) {
						<- item::isGreaterThan(9)
					})::toString())
					Terminal.inspect(none::hasItems(where (item) {
						<- item::isGreaterThan(0)
					})::toString())
					Terminal.inspect(numbers::hasOnlyItems(where (item) {
						<- item::isGreaterThan(0)
					})::toString())
					Terminal.inspect(numbers::hasOnlyItems(where (item) {
						<- item::isGreaterThan(2)
					})::toString())
					Terminal.inspect(none::hasOnlyItems(where (item) {
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

		// `Terminal.inspect` answers with the value it prints, so wrapping the
		// item records every item the walk reached. Both walks stop at the item
		// that decided.
		it("still stops at the item that decides the answer", async () => {
			expect(
				await run(`implementation {
					constant any = [1, 2, 3, 4]::hasItems(where (item) {
						<- Terminal.inspect(item)::isGreaterThan(1)
					})
					constant every = [1, 2, 3, 4]::hasOnlyItems(where (item) {
						<- Terminal.inspect(item)::isLessThan(2)
					})

					Terminal.inspect(any::toString())
					Terminal.inspect(every::toString())
				}`),
			).toEqual(["1", "2", "1", "2", '"true"', '"false"'])
		})
	})

	// The native walks the grapheme view from the end, so it answers the last
	// occurrence even where occurrences overlap.
	describe("String.lastIndex(of:)", () => {
		it("finds the last occurrence when occurrences overlap", async () => {
			// The positions JavaScript's own `lastIndexOf` answers: "aaa" has
			// "aa" at 0 and at 1.
			expect(
				await run(`implementation {
					Terminal.inspect("aaa"::lastIndex(of "aa")::toString())
					Terminal.inspect("aaaa"::lastIndex(of "aa")::toString())
					Terminal.inspect("banana"::lastIndex(of "ana")::toString())
					Terminal.inspect("mississippi"::lastIndex(of "issi")::toString())
				}`),
			).toEqual(['"Value(1)"', '"Value(2)"', '"Value(3)"', '"Value(4)"'])
		})

		it("keeps the answers the non-overlapping cases had", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect("a-b-a"::lastIndex(of "a")::toString())
					Terminal.inspect("hello, World"::lastIndex(of "l")::toString())
					Terminal.inspect("hello, World"::lastIndex(of "hello")::toString())
					Terminal.inspect("hello, World"::lastIndex(of "World")::toString())
					Terminal.inspect("hello, World"::lastIndex(of "zz")::toString())
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
					Terminal.inspect("hello"::lastIndex(of "")::toString())
					Terminal.inspect(""::lastIndex(of "")::toString())
					Terminal.inspect(""::lastIndex(of "a")::toString())
					Terminal.inspect("hello"::firstIndex(of "")::toString())
				}`),
			).toEqual(['"Value(5)"', '"Value(0)"', '"Empty"', '"Value(0)"'])
		})

		// Positions are by grapheme everywhere in the Namespace, so a String of
		// emoji counts the same from either end.
		it("counts the positions by grapheme", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect("😀a😀"::lastIndex(of "😀")::toString())
					Terminal.inspect("😀a😀"::firstIndex(of "😀")::toString())
				}`),
			).toEqual(['"Value(2)"', '"Value(0)"'])
		})
	})

	// `firstIndex` answers an empty Optional for an absent item rather than the
	// length its fold settles on.
	describe("List.firstIndex and List.lastIndex on ordinary items", () => {
		it("answers the first and last position of a repeated item", async () => {
			expect(
				await run(`implementation {
					constant numbers = [1, 2, 3, 1]

					Terminal.inspect(numbers::firstIndex(of 1)::toString())
					Terminal.inspect(numbers::lastIndex(of 1)::toString())
					Terminal.inspect(numbers::firstIndex(of 3)::toString())
					Terminal.inspect(numbers::lastIndex(of 3)::toString())
				}`),
			).toEqual(['"Value(0)"', '"Value(3)"', '"Value(2)"', '"Value(2)"'])
		})

		it("answers an empty Optional for an absent item and for the empty List", async () => {
			expect(
				await run(`implementation {
					constant numbers = [1, 2, 3, 1]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::firstIndex(of 9)::toString())
					Terminal.inspect(numbers::lastIndex(of 9)::toString())
					Terminal.inspect(none::firstIndex(of 1)::toString())
					Terminal.inspect(none::lastIndex(of 1)::toString())
				}`),
			).toEqual(['"Empty"', '"Empty"', '"Empty"', '"Empty"'])
		})

		// The bound carries equality down: a `List<List<Integer>>` searches
		// through `List.is` with the Integers' own `is` handed on.
		it("searches through the items' own conformance", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(["a", "b", "a"]::lastIndex(of "a")::toString())
					Terminal.inspect([[1], [2], [1]]::firstIndex(of [1])::toString())
					Terminal.inspect([[1], [2], [1]]::lastIndex(of [1])::toString())
				}`),
			).toEqual(['"Value(2)"', '"Value(0)"', '"Value(2)"'])
		})
	})
})
