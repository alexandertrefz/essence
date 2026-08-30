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

// NOTE: `NonEmptyDictionary` and the two bridges from a List, end to end. A
// refinement erases before anything runs, so half of what is claimed here is
// about which Method a call REACHES — a question about compiling — and half is
// about what that Method then answers. Both halves are asked the same way: the
// Program is compiled and run, and a Method only a proven receiver can reach is
// called where the proof is meant to be.
//
// NOTE: `raise(to -1)` is the discriminator throughout. `Integer::raise` answers
// an Optional, because zero has no negative power, and `NonZeroInteger::raise`
// answers the power bare — so a count that prints `1/2` was answered by the
// proven entry and one that prints `Optional#Value(1/2)` was not. Nothing else
// in the standard library tells a NonZeroInteger from an Integer at run time,
// because a refinement is not there at run time to be told from anything.
//
// NOTE: `packages/compiler/src/tests/dictionaries.spec.ts` asks the same
// questions of the unrefined Namespace, and
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

// NOTE: Every Diagnostic the front end has about a Program, from all three of
// the stages that report one — a value that does not answer a refinement's
// predicate is refused by the Validator, and a spec reading only the Enricher's
// would pass on a Program the Compiler refuses.
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
		// NOTE: The three routes the Alias' own note names, asked one after
		// another: a Dictionary written down with an entry, an update that set
		// one into a base, and `set`, which answers the proof whatever it was
		// handed.
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

		// NOTE: The same refusal an empty `[]` gets against `NonEmptyList`, and
		// it has to be the same one: the empty Dictionary answers the predicate
		// `false`, so the value does not fit where it stands and there is
		// nothing else to say about it.
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

		// NOTE: An update whose right side is one whole Dictionary says nothing
		// about how many entries the answer holds — both halves can be empty —
		// so the brackets prove nothing there.
		it("proves nothing for an update that merges a whole Dictionary", () => {
			expect(
				codesFor(`implementation {
					constant base: Dictionary<String, Integer> = [=]
					constant refused: NonEmptyDictionary<String, Integer> = [base with base]
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		// NOTE: The `if` route. A Dictionary a Program was handed carries no
		// proof, and asking `hasEntries` is what puts one in its hand — the
		// `else` of `isEmpty` proves the same thing, because a predicate written
		// as one call on `@` IS that call.
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
		// NOTE: The plainest of the five. A proven count is a `NonZeroInteger`,
		// which is what reaches `raise`'s bare entry; an unproven one is an
		// Integer, and the same call answers an Optional.
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

		// NOTE: There is one key, one value and one entry for every entry the
		// receiver holds, so each of the three answers a List with something in
		// it — which a total `firstItem` is what reads off.
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

		// NOTE: One transformed value for every entry, so a Dictionary with
		// something in it still has something in it — and the proof survives a
		// chain of them.
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

		// NOTE: `set` answers the proof on `Dictionary` itself, so a proven
		// receiver reaches that entry and this Namespace declares no `set` at
		// all. What is under test is that the answer is still proven when the
		// receiver already was.
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

		// NOTE: Written on `reduce`'s early-stopping entry, so the walk stops at
		// the entry that decides the answer rather than offering the check
		// every entry. The check prints the key it was handed, so what it was
		// offered is in the output beside the answer: the first entry decides
		// the first call and the second entry is never reached, and the second
		// call is offered both because neither decides it.
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
	describe("groupedBy", () => {
		it("groups in the order the keys first appear", async () => {
			expect(
				await run(`implementation {
					constant fixtures = [
						{ name = "alex", home = "north" },
						{ name = "sam", home = "south" },
						{ name = "kim", home = "north" },
					]
					constant groups = fixtures::groupedBy(key (f) { <- f.home })

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

		// NOTE: THE promise only a native can make. Every group holds the item
		// that opened it, so a group answers a first item bare rather than in an
		// Optional.
		it("answers groups with something in them", async () => {
			expect(
				await run(`implementation {
					constant votes = ["a", "b", "a"]

					Terminal.inspect(
						votes::groupedBy(key (vote) { <- vote })::map(
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

					Terminal.inspect(none::groupedBy(key (vote) { <- vote }))
					Terminal.inspect(
						none::groupedBy(key (vote) { <- vote })::isEmpty(),
					)
				}`),
			).toEqual(["[=]", "true"])
		})

		// NOTE: A key is any Equatable value, and one with no canonical
		// encoding is found by asking its own `is` — the scan path, which is
		// invisible from here apart from the answer being right.
		it("groups under a key with no canonical encoding", async () => {
			expect(
				await run(`implementation {
					constant seats = [
						{ row = 1, seat = 1 },
						{ row = 2, seat = 1 },
						{ row = 1, seat = 2 },
					]

					Terminal.inspect(
						seats
							::groupedBy(key (seat) { <- { row = seat.row } })
							::map(({ key, value }) { <- value::length() }),
					)
				}`),
			).toEqual(["[ { row = 1 } = 2, { row = 2 } = 1 ]"])
		})
	})

	describe("tallied", () => {
		it("counts each item, in the order the items first appear", async () => {
			expect(
				await run(`implementation {
					constant votes = ["a", "b", "a", "c", "a"]
					constant none: List<String> = []

					Terminal.inspect(votes::tallied())
					Terminal.inspect(none::tallied())
				}`),
			).toEqual(['[ "a" = 3, "b" = 1, "c" = 1 ]', "[=]"])
		})

		// NOTE: THE promise only a native can make here. A count is a
		// `PositiveInteger`, so it reaches an entry a bare Integer does not —
		// and a fallback that is not above zero is refused where it stands,
		// which is the other half of the same claim.
		it("counts to a PositiveInteger", async () => {
			expect(
				await run(`implementation {
					constant votes = ["a", "b", "a"]

					Terminal.inspect(
						votes::tallied()::values()::map((count) {
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

					Terminal.inspect(votes::tallied()::value(at "x", defaultingTo 0))
				}`),
			).toEqual(["no-matching-overload"])
		})
	})

	// NOTE: The refined twins. A List with an item in it puts that item in a
	// group, so the Dictionary either answers holds an entry — and a receiver
	// nothing proved anything about reaches the base pair instead, whose answer
	// can be the empty Dictionary.
	describe("A proven receiver", () => {
		it("answers a NonEmptyDictionary from both", async () => {
			expect(
				await run(`implementation {
					constant proven: NonEmptyList<String> = ["a", "b", "a"]

					Terminal.inspect(
						proven
							::groupedBy(key (vote) { <- vote })
							::length()
							::raise(to -1),
					)
					Terminal.inspect(
						proven::tallied()::length()::raise(to -1),
					)
					Terminal.inspect(proven::tallied()::keys()::firstItem())
				}`),
			).toEqual(["1/2", "1/2", '"a"'])
		})

		it("refuses the proof for a List nothing proved anything about", () => {
			expect(
				codesFor(`implementation {
					constant votes = ["a", "b"]
					constant refused: NonEmptyDictionary<String, PositiveInteger> =
						votes::tallied()
				}`),
			).toEqual(["assignment-type-mismatch"])
		})
	})
})

// NOTE: `writtenValueType` in `simplifier/index.ts` takes the proof a written
// value carries back off it, so the simplified Node keeps saying what it holds.
// Six Node kinds carry one, and the update of a Dictionary is the one that is
// not a Literal — the one to hold to the rule, because a Rewriter that told a
// Dictionary update from a Record one by its Type would misread a refined
// Combination as neither.
describe("The simplified update", () => {
	// NOTE: Every Node of a kind, found reflectively, because where the one this
	// test wants stands in the tree is an accident and not the point.
	function nodesOfKind(
		root: unknown,
		nodeType: string,
	): Array<Record<string, unknown>> {
		let found: Array<Record<string, unknown>> = []
		let seen = new Set<unknown>()
		let pending: Array<unknown> = [root]

		while (pending.length > 0) {
			let value = pending.pop()

			if (typeof value !== "object" || value === null || seen.has(value)) {
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

		let combinations = nodesOfKind(simplify(enriched.program), "Combination")

		expect(combinations).toHaveLength(1)
		expect((combinations[0]!.type as common.Type).type).toBe("Dictionary")
	})
})
