import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"
import type { entryPoints, TestEvent } from "@essence-lang/runtime/Testing"
import { registry, registryOf } from "@essence-lang/runtime/Testing"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The everyday additions to `List`, `NonEmptyList` and the three
// `…List` Namespaces that read numbers — the checked ends of `firstItems`,
// `lastItems`, `removeFirst` and `removeLast`, the running fold `accumulate`
// and the `runningTotal` on top of it, the seedless `NonEmptyList::reduce`,
// the keyless extrema, `onlyItem`, `isSorted`, `indices(where:)`,
// `everyIndex(of:)`, the four end questions, the two new `partition` entries
// and the filter-map `everyValue`.
//
// NOTE: Every claim here is about a value a run answered, not about a Type the
// Enricher handed out. A boundary read one position out is a Program that
// prints the wrong List, and only running it says so. The Type-level claims —
// which rung a call lands on, and which proof it spends — are the last block,
// and each is written so that the WRONG answer would not print at all.

function generate(source: string, options: { tests?: boolean } = {}): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched =
		options.tests === true
			? enrich(parsed.program, { tests: true, source })
			: enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program, { source })))
}

async function run(source: string): Promise<Array<string>> {
	let javaScript = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-list-additions-"))
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

// NOTE: One Program per block rather than one per claim, because each call is
// a line of output and the pipeline runs once for all of them. Every Program
// opens with the same three Lists, so a reader compares the answers rather
// than the inputs.
async function answers(...calls: Array<string>): Promise<Array<string>> {
	return run(`implementation {
		constant numbers = [3, 1, 2, 1, 4]
		constant noNumbers: List<Integer> = []
		constant words = ["pear", "apple", "fig"]

		function small(_ item: Integer) -> Boolean {
			<- item::isLessThan(3)
		}

${calls.map((call) => `\t\tTerminal.inspect(${call}::toString())`).join("\n")}
	}`)
}

function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	return enrich(parsed.program).diagnostics
}

type Loaded = { $tests: typeof entryPoints }

// NOTE: The property runner, the shape `testingProperties.spec.ts` drives it
// in: the loaded Program's OWN `$tests`, because every Essence value carries a
// Type key belonging to the runtime instance that built it.
async function properties(source: string): Promise<Array<TestEvent>> {
	let javaScript = generate(source, { tests: true })
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
			seed: "deadbeef",
		})

		return events
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

function failedProperties(events: Array<TestEvent>): Array<string> {
	return events
		.filter((event) => event.kind === "test-fail")
		.map((event) => JSON.stringify(event))
}

describe("The leading and trailing runs a check accepts", () => {
	it("keeps the leading run, and drops it", async () => {
		expect(
			await answers(
				"numbers::firstItems(while small)",
				"numbers::removeFirst(while small)",
				"[1, 2, 3, 1]::firstItems(while small)",
				"[1, 2, 3, 1]::removeFirst(while small)",
			),
		).toEqual(['"[]"', '"[3, 1, 2, 1, 4]"', '"[1, 2]"', '"[3, 1]"'])
	})

	it("keeps the trailing run, and drops it", async () => {
		expect(
			await answers(
				"[1, 3, 2, 1]::lastItems(while small)",
				"[1, 3, 2, 1]::removeLast(while small)",
				"numbers::lastItems(while small)",
				"numbers::removeLast(while small)",
			),
		).toEqual(['"[2, 1]"', '"[1, 3]"', '"[]"', '"[3, 1, 2, 1, 4]"'])
	})

	// NOTE: The two ends of the range of checks. A check that accepts every
	// item takes the whole List one way and leaves nothing the other, and a
	// check that accepts none does the opposite. Both are what an off-by-one
	// boundary gets wrong.
	it("answers both ends for a check that accepts everything or nothing", async () => {
		expect(
			await answers(
				"numbers::firstItems(while (item) { <- true })",
				"numbers::removeFirst(while (item) { <- true })",
				"numbers::lastItems(while (item) { <- true })",
				"numbers::removeLast(while (item) { <- true })",
				"numbers::firstItems(while (item) { <- false })",
				"numbers::removeFirst(while (item) { <- false })",
				"numbers::lastItems(while (item) { <- false })",
				"numbers::removeLast(while (item) { <- false })",
			),
		).toEqual([
			'"[3, 1, 2, 1, 4]"',
			'"[]"',
			'"[3, 1, 2, 1, 4]"',
			'"[]"',
			'"[]"',
			'"[3, 1, 2, 1, 4]"',
			'"[]"',
			'"[3, 1, 2, 1, 4]"',
		])
	})

	it("answers the empty List for the empty List", async () => {
		expect(
			await answers(
				"noNumbers::firstItems(while small)",
				"noNumbers::removeFirst(while small)",
				"noNumbers::lastItems(while small)",
				"noNumbers::removeLast(while small)",
			),
		).toEqual(['"[]"', '"[]"', '"[]"', '"[]"'])
	})

	// NOTE: The counted entries stand beside the checked ones under one name,
	// so a call that writes a count has to keep reaching the entry it always
	// did — the default on `removeFirst` and `removeLast` included.
	it("leaves the counted entries where they were", async () => {
		expect(
			await answers(
				"numbers::firstItems(2)",
				"numbers::lastItems(2)",
				"numbers::removeFirst()",
				"numbers::removeLast()",
				"numbers::removeFirst(2)",
				"numbers::removeLast(2)",
			),
		).toEqual([
			'"[3, 1]"',
			'"[1, 4]"',
			'"[1, 2, 1, 4]"',
			'"[3, 1, 2, 1]"',
			'"[2, 1, 4]"',
			'"[3, 1, 2]"',
		])
	})
})

describe("The running fold", () => {
	it("answers the seed and every value the combiner builds", async () => {
		expect(
			await answers(
				"numbers::accumulate(startingWith 0, (total, item) { <- total::add(item) })",
				"noNumbers::accumulate(startingWith 0, (total, item) { <- total::add(item) })",
				"[5]::accumulate(startingWith 1, (total, item) { <- total::multiply(with item) })",
			),
		).toEqual(['"[0, 3, 4, 6, 7, 11]"', '"[0]"', '"[1, 5]"'])
	})

	// NOTE: The proof, read where it is spent. `firstItem` on a
	// `NonEmptyList` answers the item, so adding to it is only a Program at
	// all when the answer carried the promise — and the empty receiver is the
	// case that promise is about.
	it("promises an answer with something in it, whatever the receiver", async () => {
		expect(
			await answers(
				"noNumbers::accumulate(startingWith 7, (total, item) { <- total::add(item) })::firstItem()::add(1)",
				"numbers::accumulate(startingWith 0, (total, item) { <- total::add(item) })::lastItem()::add(1)",
			),
		).toEqual(['"8"', '"12"'])
	})
})

describe("The running total", () => {
	it("answers every total the items build", async () => {
		expect(
			await answers(
				"numbers::runningTotal()",
				"noNumbers::runningTotal()",
			),
		).toEqual(['"[0, 3, 4, 6, 7, 11]"', '"[0]"'])
	})

	// NOTE: One Namespace per item Type, so the receiver decides which entry
	// answers and which zero it opens with. The mixed entry leaves a whole
	// total as the Rational the fold built, which prints as the Integer it
	// equals — the difference the entry documents at its own site.
	it("opens with the zero of the receiver's own kind", async () => {
		expect(
			await run(`implementation {
				constant rationals = [3/2, 1/2, 5/2]
				constant mixed = [3, 1/2, 2]
				constant noRationals: List<Rational> = []

				Terminal.inspect(rationals::runningTotal()::toString())
				Terminal.inspect(mixed::runningTotal()::toString())
				Terminal.inspect(noRationals::runningTotal()::toString())
			}`),
		).toEqual(['"[0, 3/2, 2, 9/2]"', '"[0, 3, 7/2, 11/2]"', '"[0]"'])
	})

	// NOTE: The proof `accumulate` hands on. Adding to `firstItem()` is only
	// a Program at all where the answer carries it, and the empty receiver is
	// the case the promise is about.
	it("promises a total whatever the receiver", async () => {
		expect(
			await answers("noNumbers::runningTotal()::firstItem()::add(1)"),
		).toEqual(['"1"'])
	})
})

describe("The fold with no starting value", () => {
	// NOTE: A written receiver is its own proof, so these reach the entry a
	// `NonEmptyList` unlocks. The same call on a List nothing proved anything
	// about is refused, which the last block pins.
	it("opens the fold with the first item", async () => {
		expect(
			await answers(
				"[3, 1, 2]::reduce((running, item) { <- running::add(item) })",
				"[7]::reduce((running, item) { <- running::add(item) })",
				'["a", "b"]::reduce((running, item) { <- running::append(item) })',
			),
		).toEqual(['"6"', '"7"', '"ab"'])
	})

	it("leaves the seeded entries on the base Namespace", async () => {
		expect(
			await answers(
				"[3, 1, 2]::reduce(startingWith 100, (running, item) { <- running::add(item) })",
				"[3, 1, 2]::reduce(startingWith 0, step (running, item) { <- #Done(running::add(item)) })",
			),
		).toEqual(['"106"', '"3"'])
	})
})

describe("The extrema with no key", () => {
	it("answers the lowest and highest item", async () => {
		expect(
			await answers(
				"words::lowestItem()",
				"words::highestItem()",
				"noNumbers::lowestItem()",
				"noNumbers::highestItem()",
				'words::lowestItem(defaultingTo "zzz")',
				"noNumbers::highestItem(defaultingTo 0)",
			),
		).toEqual([
			'"Value(\\"apple\\")"',
			'"Value(\\"pear\\")"',
			'"Empty"',
			'"Empty"',
			'"apple"',
			'"0"',
		])
	})

	// NOTE: Ties keep the earlier item, which is what the keyed entries below
	// them promise and what the identity key carries up unchanged.
	it("keeps the earlier item of a tie", async () => {
		expect(
			await run(`implementation {
				constant tied: List<{ tag: String, n: Integer }> = [
					{ tag = "a", n = 1 },
					{ tag = "b", n = 1 },
				]

				Terminal.inspect(tied::lowestItem(on .n)::toString())
				Terminal.inspect(tied::highestItem(on .n)::toString())
			}`),
		).toEqual([
			'"Value({ tag = \\"a\\", n = 1 })"',
			'"Value({ tag = \\"a\\", n = 1 })"',
		])
	})

	it("answers bare where the receiver carries the proof", async () => {
		expect(
			await run(`implementation {
				constant proven: NonEmptyList<String> = ["pear", "apple"]

				Terminal.inspect(proven::lowestItem()::length()::toString())
				Terminal.inspect(proven::highestItem()::length()::toString())
			}`),
		).toEqual(['"5"', '"4"'])
	})
})

describe("The only item, and the ordering", () => {
	it("answers an item only for a List of one", async () => {
		expect(
			await answers(
				"[7]::onlyItem()",
				"numbers::onlyItem()",
				"noNumbers::onlyItem()",
				"[7]::onlyItem(defaultingTo 0)",
				"numbers::onlyItem(defaultingTo 0)",
			),
		).toEqual(['"Value(7)"', '"Empty"', '"Empty"', '"7"', '"0"'])
	})

	it("asks whether the items are in order", async () => {
		expect(
			await answers(
				"[1, 2, 2, 3]::isSorted()",
				"numbers::isSorted()",
				"[3, 2, 1]::isSorted(in #Descending)",
				"[1, 2]::isSorted(in #Descending)",
				"[2, 2]::isSorted()",
				"[2, 2]::isSorted(in #Descending)",
				"noNumbers::isSorted()",
				"[7]::isSorted()",
				'["a", "b"]::isSorted()',
			),
		).toEqual([
			'"true"',
			'"false"',
			'"true"',
			'"false"',
			'"true"',
			'"true"',
			'"true"',
			'"true"',
			'"true"',
		])
	})
})

describe("The positions, and the ends", () => {
	it("answers the positions a check accepts and an item stands at", async () => {
		expect(
			await answers(
				"numbers::indices(where (item) { <- item::isEven() })",
				"numbers::indices(where (item) { <- item::isGreaterThan(9) })",
				"noNumbers::indices(where (item) { <- item::isEven() })",
				"numbers::everyIndex(of 1)",
				"numbers::everyIndex(of 9)",
				"numbers::indices()",
			),
		).toEqual([
			'"[2, 4]"',
			'"[]"',
			'"[]"',
			'"[1, 3]"',
			'"[]"',
			'"[0, 1, 2, 3, 4]"',
		])
	})

	it("asks what a List begins and ends with", async () => {
		expect(
			await answers(
				"numbers::starts(with [3, 1])",
				"numbers::starts(with [1])",
				"numbers::starts(with noNumbers)",
				"[1]::starts(with numbers)",
				"numbers::doesNotStart(with [1])",
				"numbers::ends(with [1, 4])",
				"numbers::ends(with [1])",
				"numbers::ends(with noNumbers)",
				"[1]::ends(with numbers)",
				"numbers::doesNotEnd(with [1])",
				"noNumbers::starts(with noNumbers)",
			),
		).toEqual([
			'"true"',
			'"false"',
			'"true"',
			'"false"',
			'"true"',
			'"true"',
			'"false"',
			'"true"',
			'"false"',
			'"true"',
			'"true"',
		])
	})
})

describe("The two new cuts, and the filter-map", () => {
	it("cuts at the end of a leading run, and at a position", async () => {
		expect(
			await run(`implementation {
				constant numbers = [3, 1, 2, 1, 4]
				constant noNumbers: List<Integer> = []

				function small(_ item: Integer) -> Boolean {
					<- item::isLessThan(3)
				}

				constant leadingRun = [1, 2, 3, 1]::partition(while small)
				constant atTwo = numbers::partition(at 2)
				constant atMinusOne = numbers::partition(at -1)
				constant pastTheEnd = numbers::partition(at 99)
				constant nothing = noNumbers::partition(while small)

				Terminal.inspect(leadingRun.leading::toString())
				Terminal.inspect(leadingRun.trailing::toString())
				Terminal.inspect(atTwo.leading::toString())
				Terminal.inspect(atTwo.trailing::toString())
				Terminal.inspect(atMinusOne.leading::toString())
				Terminal.inspect(atMinusOne.trailing::toString())
				Terminal.inspect(pastTheEnd.leading::toString())
				Terminal.inspect(pastTheEnd.trailing::toString())
				Terminal.inspect(nothing.leading::toString())
				Terminal.inspect(nothing.trailing::toString())
			}`),
		).toEqual([
			'"[1, 2]"',
			'"[3, 1]"',
			'"[3, 1]"',
			'"[2, 1, 4]"',
			'"[3, 1, 2, 1]"',
			'"[4]"',
			'"[3, 1, 2, 1, 4]"',
			'"[]"',
			'"[]"',
			'"[]"',
		])
	})

	// NOTE: The first entry keeps its own halves and its own names. Adding two
	// entries above it would have renumbered the native it binds to, and this
	// is what would print the wrong Record if it had.
	it("leaves the checked partition answering accepted and refused", async () => {
		expect(
			await run(`implementation {
				constant sorted = [3, 1, 2, 1, 4]::partition(where (item) {
					<- item::isEven()
				})

				Terminal.inspect(sorted.accepted::toString())
				Terminal.inspect(sorted.refused::toString())
			}`),
		).toEqual(['"[2, 4]"', '"[3, 1, 1]"'])
	})

	it("keeps every value a transform answers", async () => {
		expect(
			await run(`implementation {
				constant numbers = [3, 1, 2, 1, 4]
				constant noNumbers: List<Integer> = []
				constant texts = ["1", "x", "22"]

				function evenAsText(_ item: Integer) -> Optional<String> {
					if item::isEven() {
						<- #Value(item::toString())
					} else {
						<- #Empty
					}
				}

				function noValue(_ item: Integer) -> Optional<String> {
					<- #Empty
				}

				Terminal.inspect(numbers::everyValue(from evenAsText)::toString())
				Terminal.inspect(numbers::everyValue(from noValue)::toString())
				Terminal.inspect(noNumbers::everyValue(from evenAsText)::toString())
				Terminal.inspect(texts::everyValue(from (text) { <- Integer.parse(text) })::toString())
			}`),
		).toEqual(['"[\\"2\\", \\"4\\"]"', '"[]"', '"[]"', '"[1, 22]"'])
	})
})

describe("Which rung a call lands on", () => {
	// NOTE: The seedless fold is the proof spent, so a List nothing proved
	// anything about has no entry to reach. The Diagnostic names the two
	// entries `List` does declare, which is the whole of what falls through.
	// The two Parameters of the refused Function are then Types nothing
	// decides, which is the cascade every unmatched call carries.
	it("refuses the seedless fold on a List with no proof", () => {
		let diagnostics = diagnosticsOf(`implementation {
			constant handed: List<Integer> = [1, 2]

			Terminal.inspect(handed::reduce((running, item) {
				<- running::add(item)
			})::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
			"uninferable-parameter-type",
			"uninferable-parameter-type",
		])
		expect(diagnostics[0]!.notes?.length).toBe(2)
	})

	// NOTE: An `if` asking `hasItems` mints the proof, and the two Methods
	// only a proven List answers are what read it back.
	it("reaches the proven entries through a narrowing check", async () => {
		expect(
			await run(`implementation {
				constant handed: List<Integer> = [4, 5, 6]

				if handed::hasItems() {
					Terminal.inspect(handed::reduce((running, item) {
						<- running::add(item)
					})::toString())
					Terminal.inspect(handed::lowestItem()::add(0)::toString())
				} else {
					Terminal.inspect("nothing")
				}
			}`),
		).toEqual(['"15"', '"4"'])
	})

	// NOTE: A `defaultingTo:` call on a proven receiver finds no entry on
	// `NonEmptyList` and falls to `List`'s rung. The fallback can never be
	// read there, which the library reports rather than runs.
	it("warns where a proven receiver writes a fallback that can never be read", () => {
		let diagnostics = diagnosticsOf(`implementation {
			constant proven: NonEmptyList<String> = ["a"]

			Terminal.inspect(proven::lowestItem(defaultingTo "z"))
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"fallback-never-used",
		])
	})
})

describe("What holds for every List", () => {
	// NOTE: One Program of properties rather than one per claim: the runner
	// draws a hundred cases for each, and the pipeline runs once for all of
	// them. Each claim is one of the laws the new entries have to keep, and a
	// failure names the property and the smallest List that breaks it.
	it("keeps the laws the new entries promise", async () => {
		let events = await properties(`implementation {
			function small(_ item: Integer) -> Boolean {
				<- item::isLessThan(0)
			}

			function onlySmall(_ item: Integer) -> Optional<Integer> {
				if small(item) {
					<- #Value(item)
				} else {
					<- #Empty
				}
			}
		}

		tests {
			test "a leading run and what follows it are the List" for any (
				items: List<Integer>,
			) {
				expect items
					::firstItems(while small)
					::append(contentsOf items::removeFirst(while small))
					::is(items)
			}

			test "a trailing run and what precedes it are the List" for any (
				items: List<Integer>,
			) {
				expect items
					::removeLast(while small)
					::append(contentsOf items::lastItems(while small))
					::is(items)
			}

			test "both halves of a checked cut are the List" for any (
				items: List<Integer>,
			) {
				constant halves = items::partition(while small)

				expect halves.leading
					::append(contentsOf halves.trailing)
					::is(items)
			}

			test "both halves of a positional cut are the List" for any (
				items: List<Integer>,
				at: Integer,
			) {
				constant halves = items::partition(at at)

				expect halves.leading
					::append(contentsOf halves.trailing)
					::is(items)
			}

			test "a running fold is one longer than the List" for any (
				items: List<Integer>,
			) {
				expect items
					::accumulate(startingWith 0, (total, item) {
						<- total::add(item)
					})
					::length()
					::is(items::length()::add(1))
			}

			test "a running fold ends where the fold ends" for any (
				items: List<Integer>,
			) {
				expect items
					::accumulate(startingWith 0, (total, item) {
						<- total::add(item)
					})
					::lastItem()
					::is(items::reduce(startingWith 0, (total, item) {
						<- total::add(item)
					}))
			}

			test "a running total ends at the sum" for any (
				items: List<Integer>,
			) {
				expect items::runningTotal()::lastItem()::is(items::sum())
			}

			test "each running total sums the items before it" for any (
				items: List<Integer>,
			) {
				constant totals = items::runningTotal()

				expect totals::length()::is(items::length()::add(1))
				expect totals::enumerate()::hasOnlyItems(where (entry) {
					<- entry.item::is(items::firstItems(entry.index)::sum())
				})
			}

			test "the lowest item is in the List and below every item" for any (
				items: NonEmptyList<Integer>,
			) {
				constant lowest = items::lowestItem()

				expect items::contains(lowest)
				expect items::hasOnlyItems(where (item) {
					<- item::isGreaterThanOrEqualTo(lowest)
				})
			}

			test "the highest item is in the List and above every item" for any (
				items: NonEmptyList<Integer>,
			) {
				constant highest = items::highestItem()

				expect items::contains(highest)
				expect items::hasOnlyItems(where (item) {
					<- item::isLessThanOrEqualTo(highest)
				})
			}

			test "an empty List has no lowest item" for any (
				items: List<Integer>,
			) {
				expect items::lowestItem()::hasValue()::is(items::hasItems())
				expect items::highestItem()::hasValue()::is(items::hasItems())
			}

			test "an only item is the one item of a List of one" for any (
				items: List<Integer>,
			) {
				expect items::onlyItem()::hasValue()::is(items::length()::is(1))
			}

			test "a sorted List is in order" for any (items: List<Integer>) {
				expect items::sort()::isSorted()
				expect items::sort(in #Descending)::isSorted(in #Descending)
			}

			test "every position of an item holds it" for any (
				items: List<Integer>,
				item: Integer,
			) {
				constant positions = items::everyIndex(of item)

				expect positions::length()::is(items::count(of item))
				expect positions::hasOnlyItems(where (position) {
					<- items::item(at position)::is(item)
				})
			}

			test "the positions a check accepts are its own" for any (
				items: List<Integer>,
			) {
				constant positions = items::indices(where small)

				expect positions::length()::is(items::count(where small))
				expect positions::isSorted()
			}

			test "a List starts with its own leading items" for any (
				items: List<Integer>,
				count: Integer,
			) {
				expect items::starts(with items::firstItems(count))
				expect items::ends(with items::lastItems(count))
			}

			test "a filter-map is no longer than the List" for any (
				items: List<Integer>,
			) {
				expect items
					::everyValue(from onlySmall)
					::length()
					::isLessThanOrEqualTo(items::length())
			}

			test "a seedless fold is the seeded one from the first item" for any (
				items: NonEmptyList<Integer>,
			) {
				expect items
					::reduce((running, item) { <- running::add(item) })
					::is(items::removeFirst()::reduce(
						startingWith items::firstItem(),
						(running, item) { <- running::add(item) },
					))
			}
		}`)

		expect(failedProperties(events)).toEqual([])
		expect(
			events.filter((event) => event.kind === "test-pass").length,
		).toBe(18)
	})
})
