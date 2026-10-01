import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// `NonEmptyDictionary` and the bridges from a List, end to end. A refinement
// erases before anything runs. So half of these specs ask which Method a call
// reaches, and half ask what that Method answers. Both compile and run the
// Program, and call a Method only a proven receiver reaches where the proof is
// meant to be.
//
// `raise(to -1)` tells the two apart. `Integer::raise` answers an Optional,
// since zero has no negative power, and `NonZeroInteger::raise` answers the
// power bare. So `1/2` comes from the proven entry and `Optional#Value(1/2)`
// does not.
//
// `packages/compiler/src/tests/dictionaries.spec.ts` asks the same questions
// of the unrefined Namespace, and
// `packages/runtime/src/tests/dictionaries.spec.ts` drives the store itself.
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
	let directory = mkdtempSync(join(tmpdir(), "essence-refinements-"))
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

// Every Diagnostic the front end has about a Program. The Validator refuses a
// value that does not answer a refinement's predicate, so the Enricher's alone
// would pass a Program the Compiler refuses.
function diagnosticsFor(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)
	let enriched = enrich(parsed.program)

	return [
		...parsed.diagnostics,
		...enriched.diagnostics,
		...validate(enriched.program),
	]
}

function codesFor(source: string): Array<string> {
	return diagnosticsFor(source).map((diagnostic) => diagnostic.code)
}

describe("NonEmptyDictionary", () => {
	describe("Reaching the proof", () => {
		it("proves a written Dictionary, an update and a 'set'", () => {
			expect(
				codesFor(`implementation {
					constant base: Dictionary<String, Integer> = [=]
					constant written: NonEmptyDictionary<String, Integer> = ["a" = 1]
					constant updated: NonEmptyDictionary<String, Integer> = [base with "a" = 1]
					constant grown: NonEmptyDictionary<String, Integer> = base::set("a", to 1)

					Terminal.inspect([written, updated, grown]::length())
				}`),
			).toEqual([])
		})

		it("refuses the empty Dictionary, as it refuses the empty List", () => {
			expect(
				codesFor(`implementation {
					constant refused: NonEmptyDictionary<String, Integer> = [=]
				}`),
			).toEqual(["assignment-type-mismatch"])

			expect(
				codesFor(`implementation {
					constant refused: NonEmptyList<Integer> = []
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		// Both halves of `[base with base]` can be empty, so the brackets prove
		// nothing.
		it("proves nothing for an update that merges a whole Dictionary", () => {
			expect(
				codesFor(`implementation {
					constant base: Dictionary<String, Integer> = [=]
					constant refused: NonEmptyDictionary<String, Integer> = [base with base]
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		// `hasEntries` is written as `@::isEmpty()::negate()`, so the `else` of
		// an `if` asking `isEmpty` proves the same thing.
		it("narrows a Dictionary through 'hasEntries' and through 'isEmpty'", async () => {
			expect(
				await run(`implementation {
					function counted(_ d: Dictionary<String, Integer>) -> String {
						if d::hasEntries() {
							<- d::keys()::firstItem()
						} else {
							<- "nothing"
						}
					}

					function inverted(_ d: Dictionary<String, Integer>) -> String {
						if d::isEmpty() {
							<- "nothing"
						} else {
							<- d::keys()::firstItem()
						}
					}

					constant held: Dictionary<String, Integer> = ["a" = 1]
					constant none: Dictionary<String, Integer> = [=]

					Terminal.inspect(counted(held))
					Terminal.inspect(counted(none))
					Terminal.inspect(inverted(held))
					Terminal.inspect(inverted(none))
				}`),
			).toEqual(['"a"', '"nothing"', '"a"', '"nothing"'])
		})
	})

	describe("What the proof changes", () => {
		// A proven count is a `PositiveInteger`, so `raise(to -1)` reaches
		// `NonZeroInteger`'s bare answer. An unproven count answers an Optional.
		it("counts to a NonZeroInteger, where a bare Dictionary counts to an Integer", async () => {
			expect(
				await run(`implementation {
					constant none: Dictionary<String, Integer> = [=]

					Terminal.inspect(["a" = 1]::length()::raise(to -1))
					Terminal.inspect(none::length()::raise(to -1))
				}`),
			).toEqual(["1/1", "Optional#Empty"])
		})

		it("refuses a NonZeroInteger read off a Dictionary nothing proved", () => {
			expect(
				codesFor(`implementation {
					constant none: Dictionary<String, Integer> = [=]
					constant refused: NonZeroInteger = none::length()
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		// Only a List proven to have an item answers `firstItem` bare.
		it("answers its three halves as Lists with something in them", async () => {
			expect(
				await run(`implementation {
					constant proven: NonEmptyDictionary<String, Integer> = [
						"a" = 1,
						"b" = 2,
					]

					Terminal.inspect(proven::keys()::firstItem())
					Terminal.inspect(proven::values()::lastItem())
					Terminal.inspect(proven::entries()::firstItem().key)
				}`),
			).toEqual(['"a"', "2", '"a"'])
		})

		// One transformed value per entry, so the proof survives a chain.
		it("carries the proof through 'map'", async () => {
			expect(
				await run(`implementation {
					constant proven: NonEmptyDictionary<String, Integer> = ["a" = 1]

					Terminal.inspect(
						proven
							::map(({ key, value }) { <- value::add(1) })
							::map(({ key, value }) { <- value::add(1) })
							::length()
							::raise(to -1),
					)
				}`),
			).toEqual(["1/1"])
		})

		// A proven receiver reaches `Dictionary::set`, which answers the proof
		// whatever it was handed.
		it("keeps the proof through 'set' on a proven receiver", async () => {
			expect(
				await run(`implementation {
					constant proven: NonEmptyDictionary<String, Integer> = ["a" = 1]

					Terminal.inspect(
						proven::set("b", to 2)::length()::raise(to -1),
					)
				}`),
			).toEqual(["1/2"])
		})
	})

	describe("hasEntries(where:)", () => {
		it("answers whether the check accepts an entry", async () => {
			expect(
				await run(`implementation {
					constant ages: Dictionary<String, Integer> = [
						"alex" = 39,
						"sam" = 25,
					]
					constant none: Dictionary<String, Integer> = [=]

					Terminal.inspect(
						ages::hasEntries(where ({ key, value }) {
							<- value::isGreaterThan(30)
						}),
					)
					Terminal.inspect(
						ages::hasEntries(where ({ key, value }) {
							<- key::is("kim")
						}),
					)
					Terminal.inspect(
						none::hasEntries(where ({ key, value }) {
							<- value::isGreaterThan(0)
						}),
					)
				}`),
			).toEqual(["true", "false", "false"])
		})

		// The check prints each key it is offered. The first entry decides the
		// first call, and neither decides the second.
		it("offers the check no entry past the one that decides the answer", async () => {
			expect(
				await run(`implementation {
					constant ages: Dictionary<String, Integer> = [
						"alex" = 39,
						"sam" = 25,
					]

					Terminal.inspect(
						ages::hasEntries(where ({ key, value }) {
							Terminal.inspect(key)
							<- value::isGreaterThan(30)
						}),
					)
					Terminal.inspect(
						ages::hasEntries(where ({ key, value }) {
							Terminal.inspect(key)
							<- value::isGreaterThan(99)
						}),
					)
				}`),
			).toEqual(['"alex"', "true", '"alex"', '"sam"', "false"])
		})
	})
})

describe("The bridges from a List", () => {
	describe("group(on:)", () => {
		it("groups in the order the keys first appear", async () => {
			expect(
				await run(`implementation {
					constant fixtures = [
						{ name = "alex", home = "north" },
						{ name = "sam", home = "south" },
						{ name = "kim", home = "north" },
					]
					constant groups = fixtures::group(on (f) { <- f.home })

					Terminal.inspect(groups::keys())
					Terminal.inspect(
						groups::map(({ key, value }) {
							<- value::map((f) { <- f.name })
						}),
					)
				}`),
			).toEqual([
				'[ "north", "south" ]',
				'[ "north" = [ "alex", "kim" ], "south" = [ "sam" ] ]',
			])
		})

		// Every group holds the item that opened it, so its first item is bare.
		it("answers groups with something in them", async () => {
			expect(
				await run(`implementation {
					constant votes = ["a", "b", "a"]

					Terminal.inspect(
						votes::group(on (vote) { <- vote })::map(
							({ key, value }) { <- value::firstItem() },
						),
					)
				}`),
			).toEqual(['[ "a" = "a", "b" = "b" ]'])
		})

		it("answers the empty Dictionary for the empty List", async () => {
			expect(
				await run(`implementation {
					constant none: List<String> = []

					Terminal.inspect(none::group(on (vote) { <- vote }))
					Terminal.inspect(
						none::group(on (vote) { <- vote })::isEmpty(),
					)
				}`),
			).toEqual(["[=]", "true"])
		})

		it("groups under a Record key", async () => {
			expect(
				await run(`implementation {
					constant seats = [
						{ row = 1, seat = 1 },
						{ row = 2, seat = 1 },
						{ row = 1, seat = 2 },
					]

					Terminal.inspect(
						seats
							::group(on (seat) { <- { row = seat.row } })
							::map(({ key, value }) { <- value::length() }),
					)
				}`),
			).toEqual(["[ { row = 1 } = 2, { row = 2 } = 1 ]"])
		})

		// An Algebraic has no canonical encoding, so each key is found through
		// `Number`'s `is` on the scan path.
		it("groups under a key with no canonical encoding", async () => {
			expect(
				await run(`implementation {
					constant roots: List<Number> = [2::squareRoot(), 3::squareRoot(), 2::squareRoot()]

					Terminal.inspect(
						roots
							::group(on (root) { <- root })
							::map(({ key, value }) { <- value::length() }),
					)
				}`),
			).toEqual(["[ √2 = 2, √3 = 1 ]"])
		})

		// A List of groups is one `entries()` away, and each group is a
		// NonEmptyList there too.
		it("recovers the List of groups through entries", async () => {
			expect(
				await run(`implementation {
					constant votes = ["a", "b", "a"]

					Terminal.inspect(
						votes::group(on (vote) { <- vote })::entries()::map(
							({ key, value }) { <- { key, first = value::firstItem() } },
						),
					)
				}`),
			).toEqual([
				'[ { key = "a", first = "a" }, { key = "b", first = "b" } ]',
			])
		})
	})

	describe("tally()", () => {
		it("counts each item, in the order the items first appear", async () => {
			expect(
				await run(`implementation {
					constant votes = ["a", "b", "a", "c", "a"]
					constant none: List<String> = []

					Terminal.inspect(votes::tally())
					Terminal.inspect(none::tally())
				}`),
			).toEqual(['[ "a" = 3, "b" = 1, "c" = 1 ]', "[=]"])
		})

		// A count is a `PositiveInteger`, so `raise(to -1)` answers bare.
		it("counts to a PositiveInteger", async () => {
			expect(
				await run(`implementation {
					constant votes = ["a", "b", "a"]

					Terminal.inspect(
						votes::tally()::values()::map((count) {
							<- count::raise(to -1)
						}),
					)
				}`),
			).toEqual(["[ 1/2, 1/1 ]"])
		})

		it("refuses a fallback of zero for a count", () => {
			expect(
				codesFor(`implementation {
					constant votes = ["a", "b", "a"]

					Terminal.inspect(votes::tally()::value(at "x", defaultingTo 0))
				}`),
			).toEqual(["no-matching-overload"])
		})
	})

	// A key met again keeps its place and takes the later item, as
	// `Dictionary.of` and `set` do with a repeated key.
	describe("index(on:)", () => {
		it("keeps the last item under a key that keeps its first place", async () => {
			expect(
				await run(`implementation {
					constant fixtures = [
						{ name = "alex", home = "north" },
						{ name = "sam", home = "south" },
						{ name = "kim", home = "north" },
					]
					constant byHome = fixtures::index(on .home)

					Terminal.inspect(byHome::keys())
					Terminal.inspect(byHome::map(({ key, value }) { <- value.name }))
					Terminal.inspect(fixtures::index(on .name)::keys())
				}`),
			).toEqual([
				'[ "north", "south" ]',
				'[ "north" = "kim", "south" = "sam" ]',
				'[ "alex", "sam", "kim" ]',
			])
		})

		it("answers the empty Dictionary for the empty List", async () => {
			expect(
				await run(`implementation {
					constant none: List<String> = []

					Terminal.inspect(none::index(on (vote) { <- vote }))
				}`),
			).toEqual(["[=]"])
		})

		it("answers the item under its key", async () => {
			expect(
				await run(`implementation {
					constant products = [
						{ sku = "a1", price = 3 },
						{ sku = "b2", price = 5 },
					]

					Terminal.inspect(
						products::index(on .sku)::value(at "b2")::map((p) { <- p.price }),
					)
					Terminal.inspect(products::index(on .sku)::hasKey("c3"))
				}`),
			).toEqual(["Optional#Value(5)", "false"])
		})
	})

	// `removeDuplicates` answers what `tally()::keys()` answers, so it is
	// asked about first-met order, the item's own `is` and the proof.
	describe("removeDuplicates()", () => {
		it("keeps the first of every group of equal items", async () => {
			expect(
				await run(`implementation {
					constant numbers: List<Integer> = [3, 1, 2, 1, 4, 3]
					constant none: List<Integer> = []

					Terminal.inspect(numbers::removeDuplicates())
					Terminal.inspect(none::removeDuplicates())
				}`),
			).toEqual(["[ 3, 1, 2, 4 ]", "[]"])
		})

		// `Loose` writes its own `is`, so its witness carries no brand and the
		// items are scanned through that `is` rather than encoded. Both sides
		// are declared `String`: a lower-cased NonEmptyString is a
		// NonEmptyString, and its `is` would be this very Method.
		it("honours a written 'is' through the scan path", async () => {
			expect(
				await run(`implementation {
					namespace Loose for NonEmptyString is Equatable {
						is(_ other: NonEmptyString) -> Boolean {
							constant mine: String   = @::lowercase()
							constant theirs: String = other::lowercase()

							<- mine::is(theirs)
						}
					}

					constant names: List<NonEmptyString> = ["Ada", "ada", "Grace", "ADA", "grace"]

					Terminal.inspect(names::removeDuplicates())
					Terminal.inspect(names::contains("ADA"))
				}`),
			).toEqual(['[ "Ada", "Grace" ]', "true"])
		})

		it("honours a written 'is' over a refined Integer", async () => {
			expect(
				await run(`implementation {
					§ Two Integers are one item when they share a parity.
					namespace Parity for PositiveInteger is Equatable {
						is(_ other: PositiveInteger) -> Boolean {
							<- @::remainder(dividingBy 2)
								::is(other::remainder(dividingBy 2))
						}
					}

					constant numbers: List<PositiveInteger> = [1, 4, 3, 2, 5]

					Terminal.inspect(numbers::removeDuplicates())
				}`),
			).toEqual(["[ 1, 4 ]"])
		})

		it("carries the proof of a NonEmptyList across and back", async () => {
			expect(
				await run(`implementation {
					constant proven: NonEmptyList<String> = ["a", "b", "a"]

					Terminal.inspect(proven::removeDuplicates()::lastItem())
					Terminal.inspect(proven::removeDuplicates()::length()::raise(to -1))
				}`),
			).toEqual(['"b"', "1/2"])
		})
	})

	// A List with an item puts it in a group, under a count or at a key, so
	// each answer holds an entry. An unproven receiver reaches the base entries.
	describe("A proven receiver", () => {
		it("answers a NonEmptyDictionary from all three", async () => {
			expect(
				await run(`implementation {
					constant proven: NonEmptyList<String> = ["a", "b", "a"]

					Terminal.inspect(
						proven
							::group(on (vote) { <- vote })
							::length()
							::raise(to -1),
					)
					Terminal.inspect(
						proven::tally()::length()::raise(to -1),
					)
					Terminal.inspect(
						proven::index(on (vote) { <- vote })::length()::raise(to -1),
					)
					Terminal.inspect(proven::tally()::keys()::firstItem())
				}`),
			).toEqual(["1/2", "1/2", "1/2", '"a"'])
		})

		it("refuses the proof for a List nothing proved anything about", () => {
			expect(
				codesFor(`implementation {
					constant votes = ["a", "b"]
					constant refused: NonEmptyDictionary<String, PositiveInteger> =
						votes::tally()
				}`),
			).toEqual(["assignment-type-mismatch"])
		})
	})
})

// `writtenValueType` in `simplifier/simplify.ts` takes a written value's
// refinement back off its Type. A Dictionary update is the written value that
// is not a Literal, and a refined one would read as neither update kind.
describe("The simplified update", () => {
	// Every Node of a kind, found by walking every object, since where the
	// wanted one stands in the tree does not matter.
	function nodesOfKind(
		root: unknown,
		nodeType: string,
	): Array<Record<string, unknown>> {
		let found: Array<Record<string, unknown>> = []
		let seen = new Set<unknown>()
		let pending: Array<unknown> = [root]

		while (pending.length > 0) {
			let value = pending.pop()

			if (
				typeof value !== "object" ||
				value === null ||
				seen.has(value)
			) {
				continue
			}

			seen.add(value)

			let record = value as Record<string, unknown>

			if (record.nodeType === nodeType) {
				found.push(record)
			}

			for (let held of Object.values(record)) {
				pending.push(held)
			}
		}

		return found
	}

	it("takes the written proof back off a simplified Dictionary update", () => {
		let parsed = parseWithDiagnostics(`implementation {
			constant base: Dictionary<String, Integer> = [=]
			constant counted = [base with "a" = 1]::length()

			Terminal.print(counted::toString())
		}`)
		let enriched = enrich(parsed.program)

		validate(enriched.program)

		let combinations = nodesOfKind(
			simplify(enriched.program),
			"Combination",
		)

		expect(combinations).toHaveLength(1)
		expect((combinations[0]!.type as common.Type).type).toBe("Dictionary")
	})
})
