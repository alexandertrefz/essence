import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { entryPoints, TestEvent } from "@essence-lang/runtime/Testing"
import { registry, registryOf } from "@essence-lang/runtime/Testing"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The set-shaped List Methods — `removeDuplicates`, `hasDuplicates`,
// `contains(everyItemOf:)`, `everyItem(alsoIn:)` and
// `removeEvery(contentsOf:)`. Every claim here is about a value a compiled
// Program answered, because what each of these promises is about the answer
// and nothing but running one shows it.
//
// NOTE: The set-shaped five hold their seen keys in a Map keyed by the
// canonical encoding `Dictionary` finds a slot by, which is why the equality
// tests below matter more than the ordering ones: an encoding that disagrees
// with a Type's own `is` answers a wrong List quietly. The scan path — a
// witness a Namespace wrote, which the Compiler does not brand — is exercised
// on its own, and so is the cross-kind case where one of two equal keys
// encodes and the other does not.

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(enriched.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
		[],
	)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let javaScript = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-list-structure-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

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

// NOTE: One Program per block rather than one per claim: each call is a line of
// output, and the pipeline runs once for all of them.
async function answers(...calls: Array<string>): Promise<Array<string>> {
	return run(`implementation {
${calls.map((call) => `\tTerminal.inspect(${call}::toString())`).join("\n")}
}`)
}

// NOTE: A `for any` run of the Program's own `tests { … }` section, driven
// through the loaded Program's OWN `$tests` — every Essence value carries a
// hidden Type key belonging to the runtime instance that built it, so the
// registry the Program filled is the one that has to run it. Mirrored from
// `randomness.spec.ts`, which states the rule.
type Loaded = { $tests: typeof entryPoints }

async function outcomesOf(source: string): Promise<Array<string>> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program, { tests: true, source })

	expect(enriched.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
		[],
	)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	let javaScript = rewrite(optimise(simplify(enriched.program, { source })))
	let directory = mkdtempSync(join(tmpdir(), "essence-list-properties-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let before = registry().modules.length
	let loaded = (await import(file)) as Loaded
	let scoped = registryOf(loaded.$tests.registry().modules.slice(before))
	let events: Array<TestEvent> = []

	try {
		loaded.$tests.run(scoped, {
			sink: (event) => events.push(event),
			now: () => 0,
			seed: "structure",
		})
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}

	return events
		.filter(
			(event) =>
				event.kind === "test-pass" ||
				event.kind === "test-fail" ||
				event.kind === "test-skip",
		)
		.map(
			(event) =>
				`${event.kind}: ${(event as { name: string }).name}${
					event.kind === "test-fail"
						? ` — ${JSON.stringify((event as { failures: unknown }).failures)}`
						: ""
				}`,
		)
}

describe("the set-shaped Methods", () => {
	it("keeps the first occurrence of each item, in order", async () => {
		expect(
			await answers(
				'["b", "a", "b", "c", "a"]::removeDuplicates()',
				"[1, 1, 1]::removeDuplicates()",
				"[3, 1, 2]::removeDuplicates()",
			),
		).toEqual(['"[\\"b\\", \\"a\\", \\"c\\"]"', '"[1]"', '"[3, 1, 2]"'])
	})

	// NOTE: The first item met at a key survives, whatever the rest of it
	// holds — which is what makes this the one-row-per-id Method rather than a
	// key-flavoured `index(on:)`, whose later item wins.
	it("keeps the first item met at each key", async () => {
		expect(
			await run(`implementation {
				constant rows = [
					{ id = 1, name = "first" },
					{ id = 2, name = "second" },
					{ id = 1, name = "third" },
				]

				Terminal.inspect(rows::removeDuplicates(on .id)::map(.name)::toString())
				Terminal.inspect(rows::removeDuplicates(on .name)::length()::toString())
			}`),
		).toEqual(['"[\\"first\\", \\"second\\"]"', '"3"'])
	})

	it("answers whether anything occurs twice, by item and by key", async () => {
		expect(
			await run(`implementation {
				constant rows = [{ sku = "a" }, { sku = "b" }, { sku = "a" }]
				constant none: List<Integer> = []

				Terminal.inspect([1, 2, 1]::hasDuplicates()::toString())
				Terminal.inspect([1, 2, 3]::hasDuplicates()::toString())
				Terminal.inspect([1]::hasDuplicates()::toString())
				Terminal.inspect(none::hasDuplicates()::toString())
				Terminal.inspect(rows::hasDuplicates(on .sku)::toString())
				Terminal.inspect(rows::hasDuplicates(on (row) { <- row })::toString())
			}`),
		).toEqual([
			'"true"',
			'"false"',
			'"false"',
			'"false"',
			'"true"',
			'"true"',
		])
	})

	// NOTE: The subset question counts nothing, so a receiver holding one `1`
	// contains every item of a List holding two — and every List contains the
	// items of the empty one.
	it("answers whether every item of another List occurs", async () => {
		expect(
			await run(`implementation {
				constant none: List<Integer> = []

				Terminal.inspect([1, 2, 3]::contains(everyItemOf [3, 1])::toString())
				Terminal.inspect([1, 2, 3]::contains(everyItemOf [3, 9])::toString())
				Terminal.inspect([1]::contains(everyItemOf [1, 1])::toString())
				Terminal.inspect([1, 2]::contains(everyItemOf none)::toString())
				Terminal.inspect(none::contains(everyItemOf none)::toString())
				Terminal.inspect(none::contains(everyItemOf [1])::toString())
			}`),
		).toEqual([
			'"true"',
			'"false"',
			'"true"',
			'"true"',
			'"true"',
			'"false"',
		])
	})

	// NOTE: Both are FILTERS over the receiver rather than set operations, so
	// an item is kept or dropped every time it occurs and the receiver's order
	// is what the answer stands in.
	it("intersects and subtracts as a filter does", async () => {
		expect(
			await run(`implementation {
				constant none: List<Integer> = []

				Terminal.inspect([3, 1, 2, 1]::everyItem(alsoIn [1, 3])::toString())
				Terminal.inspect([3, 1]::everyItem(alsoIn none)::toString())
				Terminal.inspect([3, 1, 2, 1]::removeEvery(contentsOf [1])::toString())
				Terminal.inspect([3, 1]::removeEvery(contentsOf [9])::toString())
				Terminal.inspect([3, 1]::removeEvery(contentsOf none)::toString())
				Terminal.inspect(none::everyItem(alsoIn [1])::toString())
			}`),
		).toEqual([
			'"[3, 1, 1]"',
			'"[]"',
			'"[3, 2]"',
			'"[3, 1]"',
			'"[3, 1]"',
			'"[]"',
		])
	})

	// NOTE: The union has no name of its own, and this is the spelling the
	// `§§` block of `removeDuplicates` points a reader at.
	it("spells the union as an append and a deduplication", async () => {
		expect(
			await answers(
				"[3, 1]::append(contentsOf [1, 2])::removeDuplicates()",
			),
		).toEqual(['"[3, 1, 2]"'])
	})

	// NOTE: The proof, spent on the proven Namespace's own entries. A List
	// with something in it deduplicates to one with something in it, whichever
	// entry answers.
	it("carries a receiver's proof through both entries", async () => {
		expect(
			await run(`implementation {
				constant proven: NonEmptyList<Integer> = [3, 1, 3]
				constant rows: NonEmptyList<{ id: Integer }> = [{ id = 1 }, { id = 1 }]

				Terminal.inspect(proven::removeDuplicates()::lastItem()::toString())
				Terminal.inspect(rows::removeDuplicates(on .id)::firstItem()::toString())
			}`),
		).toEqual(['"1"', '"{ id = 1 }"'])
	})
})

describe("what decides that two items are one", () => {
	// NOTE: The encoding is the standard library's own `is` in another
	// spelling, so a Rational and the whole Integer it equals are one item
	// under a covering `Number` item Type — and `1/2` and `2/4` are one item
	// whichever way either was written.
	it("reads two spellings of one number as one item", async () => {
		expect(
			await run(`implementation {
				constant spellings: List<Number> = [3, 3/1, 1/2, 2/4]
				constant fractions: List<Rational> = [1/2, 2/4, 3/4]

				Terminal.inspect(spellings::removeDuplicates()::toString())
				Terminal.inspect(fractions::removeDuplicates()::toString())
				Terminal.inspect(spellings::hasDuplicates()::toString())
			}`),
		).toEqual(['"[3, 1/2]"', '"[1/2, 3/4]"', '"true"'])
	})

	// NOTE: A String is compared in its NFC form, so an accent written as one
	// code point and the same accent written as a base and a combining mark
	// are one item — exactly as `is` says they are.
	it("reads two normalizations of one String as one item", async () => {
		expect(
			await run(`implementation {
				constant composed = "é"
				constant decomposed = composed::normalize(as #DecomposedCanonical)
				constant both: List<String> = [composed, decomposed]

				Terminal.inspect(both::removeDuplicates()::length()::toString())
				Terminal.inspect(composed::is(decomposed)::toString())
			}`),
		).toEqual(['"1"', '"true"'])
	})

	// NOTE: A Record and a Case are spelled into a text from their parts, and
	// the members are read in sorted name order because `Record::is` is
	// order-insensitive.
	it("reads a Record and a Case by their parts", async () => {
		expect(
			await run(`implementation {
				constant rows = [{ a = 1, b = "x" }, { b = "x", a = 1 }, { a = 2, b = "x" }]
				constant sides: List<Side> = [#Start, #End, #Start]

				Terminal.inspect(rows::removeDuplicates()::length()::toString())
				Terminal.inspect(sides::removeDuplicates()::toString())
			}`),
		).toEqual(['"2"', '"[Start, End]"'])
	})

	// NOTE: A List key has no encoding at all, so every lookup walks the keys
	// and asks the witness. It is invisible apart from the time it costs,
	// which is the whole claim.
	it("answers for items of a kind that does not encode", async () => {
		expect(
			await run(`implementation {
				constant nested: List<List<Integer>> = [[1], [2], [1]]

				Terminal.inspect(nested::removeDuplicates()::toString())
				Terminal.inspect(nested::hasDuplicates()::toString())
				Terminal.inspect(nested::everyItem(alsoIn [[1]])::toString())
			}`),
		).toEqual(['"[[1], [2]]"', '"true"', '"[[1], [1]]"'])
	})

	// NOTE: THE SCAN PATH, and the whole of what keeps a user-written `is`
	// from being ignored. This Namespace calls two Strings equal when they
	// differ only in case; the Compiler brands no witness it wrote, so the
	// encoding is never asked and every comparison is this body.
	it("obeys an equality a Namespace wrote rather than the encoding", async () => {
		expect(
			await run(`implementation {
				namespace Loose for NonEmptyString is Equatable {
					is(_ other: NonEmptyString) -> Boolean {
						constant mine: String   = @::lowercase()
						constant theirs: String = other::lowercase()

						<- mine::is(theirs)
					}
				}

				constant names: List<NonEmptyString> = ["Ada", "ada", "Bob"]

				Terminal.inspect(names::removeDuplicates()::toString())
				Terminal.inspect(names::hasDuplicates()::toString())
				Terminal.inspect(names::contains(everyItemOf ["ADA"])::toString())
				Terminal.inspect(names::removeEvery(contentsOf ["ADA"])::toString())
			}`),
		).toEqual([
			'"[\\"Ada\\", \\"Bob\\"]"',
			'"true"',
			'"true"',
			'"[\\"Bob\\"]"',
		])
	})
})

// NOTE: What each Method promises over EVERY input rather than over the ones a
// case happened to write down. `for any` draws the Lists; what is asserted is a
// relation between two calls, never a value.
describe("properties", () => {
	it("keeps an intersection inside both Lists", async () => {
		expect(
			await outcomesOf(`implementation {
				function shared(_ first: List<Integer>, _ second: List<Integer>) -> List<Integer> {
					<- first::everyItem(alsoIn second)
				}
			}

			tests {
				test "an intersection is in both" for any (first: List<Integer>, second: List<Integer>) {
					expect first::contains(everyItemOf shared(first, second))
					expect second::contains(everyItemOf shared(first, second))
				}
			}`),
		).toEqual(["test-pass: an intersection is in both"])
	})

	it("leaves nothing of the other List in a difference", async () => {
		expect(
			await outcomesOf(`implementation {
				function without(_ first: List<Integer>, _ second: List<Integer>) -> List<Integer> {
					<- first::removeEvery(contentsOf second)
				}
			}

			tests {
				test "a difference shares nothing with what it removed" for any (first: List<Integer>, second: List<Integer>) {
					expect without(first, second)::everyItem(alsoIn second)::isEmpty()
					expect first::contains(everyItemOf without(first, second))
				}
			}`),
		).toEqual([
			"test-pass: a difference shares nothing with what it removed",
		])
	})

	it("deduplicates to a List with nothing twice in it", async () => {
		expect(
			await outcomesOf(`implementation {}

			tests {
				test "deduplicating leaves no duplicate" for any (items: List<Integer>) {
					expect items::removeDuplicates()::hasDuplicates()::negate()
					expect items::removeDuplicates()::removeDuplicates()
						::is(items::removeDuplicates())
					expect items::contains(everyItemOf items::removeDuplicates())
					expect items::removeDuplicates()::contains(everyItemOf items)
				}
			}`),
		).toEqual(["test-pass: deduplicating leaves no duplicate"])
	})
})
