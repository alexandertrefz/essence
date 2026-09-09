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
})
