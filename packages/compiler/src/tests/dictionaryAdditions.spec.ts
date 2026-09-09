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

// NOTE: The Methods the completeness wave added to `Dictionary` — the rest of
// the `where` family, the question about a value, an ordering, the plural
// removal, the second `of` and the first entry. `dictionaries.spec.ts` drives
// the container itself; this file drives what was added to it, and both ask
// through the only door a Program has by compiling and RUNNING each claim.
//
// NOTE: Order is what most of these are about — which entry comes out first,
// which order a sort leaves, where a key that is set again lands — and none of
// it is visible from a Type. So every test here runs its Program and reads what
// it printed.
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
	let directory = mkdtempSync(join(tmpdir(), "essence-dictionary-added-"))
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

// NOTE: The receiver most of the groups below read. Three entries, two of them
// sharing a value, so a count and a quantifier each have something to answer
// about. The empty one is annotated where it stands, because an empty literal
// carries neither Type Argument.
const ages = `constant ages = ["alex" = 39, "sam" = 25, "kim" = 25]`
const noAges = `constant noAges: Dictionary<String, Integer> = [=]`

describe("Dictionary additions", () => {
	describe("The rest of the where family", () => {
		it("counts the entries the check accepts", async () => {
			expect(
				await run(`implementation {
					${ages}
					${noAges}

					Terminal.inspect(ages::count(where ({ key, value }) {
						<- value::is(25)
					}))
					Terminal.inspect(ages::count(where ({ key, value }) {
						<- key::is("nobody")
					}))
					Terminal.inspect(noAges::count(where ({ key, value }) {
						<- value::is(25)
					}))
				}`),
			).toEqual(["2", "0", "0"])
		})

		// NOTE: The empty Dictionary answers `true` to both quantifiers, which
		// is what makes each name read true in English: it has no entry to fail
		// the universal check and none to accept the empty one.
		it("answers the universal quantifier, and true for the empty one", async () => {
			expect(
				await run(`implementation {
					${ages}
					${noAges}

					Terminal.inspect(ages::hasOnlyEntries(where ({ key, value }) {
						<- value::isGreaterThan(20)
					}))
					Terminal.inspect(ages::hasOnlyEntries(where ({ key, value }) {
						<- value::isGreaterThan(30)
					}))
					Terminal.inspect(noAges::hasOnlyEntries(where ({ key, value }) {
						<- value::isGreaterThan(30)
					}))
				}`),
			).toEqual(["true", "false", "true"])
		})

		it("answers the empty quantifier, and true for the empty one", async () => {
			expect(
				await run(`implementation {
					${ages}
					${noAges}

					Terminal.inspect(ages::hasNoEntries(where ({ key, value }) {
						<- value::isGreaterThan(50)
					}))
					Terminal.inspect(ages::hasNoEntries(where ({ key, value }) {
						<- value::isGreaterThan(30)
					}))
					Terminal.inspect(noAges::hasNoEntries(where ({ key, value }) {
						<- value::isGreaterThan(30)
					}))
				}`),
			).toEqual(["true", "false", "true"])
		})

		// NOTE: The three quantifiers and the count are one family, so the
		// answers they give about one receiver have to line up: an accepted
		// entry means the universal complement is refused, and the count of
		// what a check accepts is zero exactly when no entry accepts it.
		it("agrees with the count over a hundred generated checks", async () => {
			expect(
				await run(`implementation {
					constant pairs = List.of(integersFrom 1, through 40)
						::map((n) { <- { key = n, value = n::remainder(dividingBy 7) } })
					constant sample = Dictionary.of(pairs)

					constant broken = loop(
						from 0,
						through 100,
						startingWith 0,
						(bound, wrong) {
							constant kept = sample::count(where ({ key, value }) {
								<- value::isLessThan(bound::remainder(dividingBy 9))
							})
							constant any = sample::hasEntries(where ({ key, value }) {
								<- value::isLessThan(bound::remainder(dividingBy 9))
							})
							constant none = sample::hasNoEntries(where ({ key, value }) {
								<- value::isLessThan(bound::remainder(dividingBy 9))
							})
							constant all = sample::hasOnlyEntries(where ({ key, value }) {
								<- value::isLessThan(bound::remainder(dividingBy 9))
							})

							if kept::isGreaterThan(0)::is(any)
								::and(none::is(any::negate()))
								::and(all::is(kept::is(sample::length())))
							{
								<- wrong
							} else {
								<- wrong::add(1)
							}
						},
					)

					Terminal.inspect(broken)
				}`),
			).toEqual(["0"])
		})
	})

	describe("Asking after a value", () => {
		it("answers whether an entry holds the value", async () => {
			expect(
				await run(`implementation {
					${ages}
					${noAges}

					Terminal.inspect(ages::hasValue(25))
					Terminal.inspect(ages::hasValue(39))
					Terminal.inspect(ages::hasValue(1))
					Terminal.inspect(noAges::hasValue(1))
				}`),
			).toEqual(["true", "true", "false", "false"])
		})

		// NOTE: Equality is the values' own `is`, so a value with a structure
		// is compared by it rather than by identity. A Record value is the
		// shape that says so: the one asked about is written afresh at the
		// call and is never the value the Dictionary holds.
		it("compares a value by its own equality", async () => {
			expect(
				await run(`implementation {
					constant seats = [
						"alex" = { row = 1, seat = 2 },
						"sam" = { row = 4, seat = 1 },
					]

					Terminal.inspect(seats::hasValue({ row = 4, seat = 1 }))
					Terminal.inspect(seats::hasValue({ row = 4, seat = 2 }))
				}`),
			).toEqual(["true", "false"])
		})

		// NOTE: `hasKey` and `hasValue` are the two halves of the same
		// question, and a Dictionary whose keys and values are the same List
		// is what makes that visible: every key is a value and nothing else
		// is.
		it("agrees with hasKey where the keys and the values are the same", async () => {
			expect(
				await run(`implementation {
					constant pairs = List.of(integersFrom 1, through 30)
						::map((n) { <- { key = n, value = n } })
					constant sample = Dictionary.of(pairs)

					constant broken = loop(
						from -10,
						through 40,
						startingWith 0,
						(candidate, wrong) {
							if sample::hasKey(candidate)
								::is(sample::hasValue(candidate))
							{
								<- wrong
							} else {
								<- wrong::add(1)
							}
						},
					)

					Terminal.inspect(broken)
				}`),
			).toEqual(["0"])
		})
	})

	describe("Ordering", () => {
		// NOTE: The receiver is written out of order, so an answer in order is
		// something the sort did rather than something the literal already was.
		it("orders by the keys, in either direction", async () => {
			expect(
				await run(`implementation {
					${ages}
					${noAges}

					Terminal.inspect(ages::sort()::toString())
					Terminal.inspect(ages::sort(in #Ascending)::toString())
					Terminal.inspect(ages::sort(in #Descending)::toString())
					Terminal.inspect(noAges::sort()::toString())
				}`),
			).toEqual([
				'"[\\"alex\\" = 39, \\"kim\\" = 25, \\"sam\\" = 25]"',
				'"[\\"alex\\" = 39, \\"kim\\" = 25, \\"sam\\" = 25]"',
				'"[\\"sam\\" = 25, \\"kim\\" = 25, \\"alex\\" = 39]"',
				'"[=]"',
			])
		})

		// NOTE: `sam` and `kim` hold the same value and `sam` stands first in
		// the receiver, so a stable sort leaves `sam` first in BOTH
		// directions. Descending turns the comparison around rather than
		// reversing the answer, which is the whole of what that costs.
		it("is stable in either direction", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(ages::sort(on .value)::keys()::toString())
					Terminal.inspect(
						ages::sort(on .value, in #Descending)::keys()::toString(),
					)
				}`),
			).toEqual([
				'"[\\"sam\\", \\"kim\\", \\"alex\\"]"',
				'"[\\"alex\\", \\"sam\\", \\"kim\\"]"',
			])
		})

		// NOTE: A reordering answers the entries it was handed, and equality
		// ignores order — so a sorted Dictionary is equal to the one it was
		// read off, whatever it did to the order.
		it("keeps every entry it was handed", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(ages::sort()::is(ages))
					Terminal.inspect(ages::sort(in #Descending)::is(ages))
					Terminal.inspect(ages::sort(on .value)::length())
				}`),
			).toEqual(["true", "true", "3"])
		})

		// NOTE: The answer carries each slot's ENCODING over rather than
		// spelling it again, and a Record key is where a mistake there would
		// show: a key found in one step before the sort has to be found in one
		// step after it.
		it("finds a Record key in the Dictionary it answered", async () => {
			expect(
				await run(`implementation {
					constant seats = [
						{ row = 4, seat = 1 } = "sam",
						{ row = 1, seat = 2 } = "alex",
					]
					constant ordered = seats::sort(on .value)

					Terminal.inspect(ordered::keys()::firstItem())
					Terminal.inspect(ordered::value(at { row = 4, seat = 1 }))
					Terminal.inspect(ordered::value(at { row = 9, seat = 9 }))
					Terminal.inspect(
						ordered::set({ row = 4, seat = 1 }, to "kim")::length(),
					)
				}`),
			).toEqual([
				"Optional#Value({ row = 1, seat = 2 })",
				'Optional#Value("sam")',
				"Optional#Empty",
				"2",
			])
		})

		// NOTE: A key of a kind with no canonical encoding takes the SCAN
		// path, and the count of such slots is what a lookup falls through to
		// it on. A sorted answer has to carry that count over with the slots,
		// or a lookup would answer nothing for a key standing right there.
		it("carries an unencodable key over", async () => {
			expect(
				await run(`implementation {
					constant runs = [[2, 1] = "second", [1, 3] = "first"]
					constant ordered = runs::sort()

					Terminal.inspect(ordered::values()::toString())
					Terminal.inspect(ordered::value(at [2, 1]))
					Terminal.inspect(ordered::hasKey([9]))
				}`),
			).toEqual([
				'"[\\"first\\", \\"second\\"]"',
				'Optional#Value("second")',
				"false",
			])
		})

		// NOTE: A reordering answers the entries it was handed, so a proven
		// receiver comes out proven and the total answers are in reach with no
		// `if` in front of them.
		it("carries the proof of a non-empty receiver", async () => {
			expect(
				await run(`implementation {
					constant proven: NonEmptyDictionary<String, Integer> = [
						"sam" = 25,
						"alex" = 39,
					]

					Terminal.inspect(proven::sort()::keys()::firstItem())
					Terminal.inspect(proven::sort()::length())
					Terminal.inspect(
						proven::sort(on .value, in #Descending)::values()::firstItem(),
					)
				}`),
			).toEqual(['"alex"', "2", "39"])
		})

		// NOTE: The two claims a sort makes, over a receiver built out of
		// order: the keys come out in order, and no entry is lost or gained.
		it("leaves the keys in order over a generated receiver", async () => {
			expect(
				await run(`implementation {
					constant pairs = List.of(integersFrom 1, through 120)
						::map((n) {
							<- {
								key = n::multiply(with 37)::remainder(dividingBy 101),
								value = n,
							}
						})
					constant sample = Dictionary.of(pairs)
					constant ordered = sample::sort()
					constant keys = ordered::keys()

					constant outOfOrder = keys
						::pair(with keys::removeFirst())
						::count(where ({ first, second }) {
							<- first::isGreaterThan(second)
						})

					Terminal.inspect(outOfOrder)
					Terminal.inspect(ordered::is(sample))
					Terminal.inspect(ordered::length()::is(sample::length()))
				}`),
			).toEqual(["0", "true", "true"])
		})
	})
})
