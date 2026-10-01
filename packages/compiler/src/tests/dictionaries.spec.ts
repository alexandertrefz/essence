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

// A Dictionary shares a store between every box written from one, and none of
// that may show from Essence. See "Dictionaries" in
// packages/runtime/DEVELOPMENT.md.
//
// These specs compile and run Programs that ask through the Namespace.
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
	let directory = mkdtempSync(join(tmpdir(), "essence-dictionary-"))
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

// Stops at the first stage that reports an Error.
function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return parsed.diagnostics
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		return enriched.diagnostics
	}

	return validate(enriched.program)
}

// The receiver most groups read, built with `Dictionary.of` from entry
// Records. `Dictionary.of` reads both Type Arguments off the entries.
const ages = `constant ages = Dictionary.of([
		{ key = "alex", value = 39 },
		{ key = "sam", value = 25 },
	])`

const noPairs = `constant noPairs: List<{ key: String, value: Integer }> = []`

describe("Dictionary", () => {
	describe("Building", () => {
		it("holds the entries it was given, in the order they were written", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(ages::toString())
					Terminal.inspect(ages::length())
				}`),
			).toEqual(['"[\\"alex\\" = 39, \\"sam\\" = 25]"', "2"])
		})

		// The later value wins in the first occurrence's place, as an overwrite
		// does.
		it("collapses a duplicate key onto its first position", async () => {
			expect(
				await run(`implementation {
					constant ages = Dictionary.of([
						{ key = "alex", value = 39 },
						{ key = "sam", value = 25 },
						{ key = "alex", value = 40 },
					])

					Terminal.inspect(ages::toString())
					Terminal.inspect(ages::length())
				}`),
			).toEqual(['"[\\"alex\\" = 40, \\"sam\\" = 25]"', "2"])
		})

		it("builds the empty Dictionary from an empty List of entries", async () => {
			expect(
				await run(`implementation {
					${noPairs}
					constant empty = Dictionary.of(noPairs)

					Terminal.inspect(empty::toString())
					Terminal.inspect(empty::isEmpty())
					Terminal.inspect(empty::hasEntries())
					Terminal.inspect(empty::length())
				}`),
			).toEqual(['"[=]"', "true", "false", "0"])
		})
	})

	describe("Looking a key up", () => {
		it("answers a value for a key it holds and nothing for one it does not", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(ages::value(at "alex"))
					Terminal.inspect(ages::value(at "kim"))
					Terminal.inspect(ages::hasKey("alex"))
					Terminal.inspect(ages::hasKey("kim"))
				}`),
			).toEqual(["Optional#Value(39)", "Optional#Empty", "true", "false"])
		})

		it("collapses the lookup to a bare value with a fallback", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(ages::value(at "alex", defaultingTo 0))
					Terminal.inspect(ages::value(at "kim", defaultingTo 0))
				}`),
			).toEqual(["39", "0"])
		})
	})

	describe("Order", () => {
		// Short names keep each `Terminal.inspect` answer on one line.
		it("answers its keys, values and entries in one order", async () => {
			expect(
				await run(`implementation {
					${ages}

					constant tally = Dictionary.of([
						{ key = "a", value = 1 },
						{ key = "b", value = 2 },
					])

					Terminal.inspect(ages::keys())
					Terminal.inspect(ages::values())
					Terminal.inspect(tally::entries())
				}`),
			).toEqual([
				'[ "alex", "sam" ]',
				"[ 39, 25 ]",
				'[ { key = "a", value = 1 }, { key = "b", value = 2 } ]',
			])
		})

		// An overwritten key keeps its place. A removed key is new when it comes
		// back, so it lands at the end.
		it("keeps a key's place when its value is overwritten", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(ages::set("alex", to 40)::keys())
					Terminal.inspect(ages::set("alex", to 40)::toString())
				}`),
			).toEqual([
				'[ "alex", "sam" ]',
				'"[\\"alex\\" = 40, \\"sam\\" = 25]"',
			])
		})

		it("puts a removed key at the end when it is set again", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(ages::remove(at "alex")::set("alex", to 40)::keys())
					Terminal.inspect(ages::remove(at "alex")::set("alex", to 40)::toString())
				}`),
			).toEqual([
				'[ "sam", "alex" ]',
				'"[\\"sam\\" = 25, \\"alex\\" = 40]"',
			])
		})

		it("adds a key it does not hold at the end", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(ages::set("kim", to 7)::keys())
				}`),
			).toEqual(['[ "alex", "sam", "kim" ]'])
		})

		// The receiver of a write still answers what it answered.
		it("leaves the Dictionary a write was made from untouched", async () => {
			expect(
				await run(`implementation {
					${ages}

					constant older = ages::set("alex", to 40)::remove(at "sam")

					Terminal.inspect(older::toString())
					Terminal.inspect(ages::toString())
				}`),
			).toEqual([
				'"[\\"alex\\" = 40]"',
				'"[\\"alex\\" = 39, \\"sam\\" = 25]"',
			])
		})
	})

	describe("Transforming", () => {
		// Every callback is handed the entry Record, so a Pattern can take it
		// apart in the Parameter list.
		it("hands each entry to 'map' and keeps the keys", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(
						ages::map(({ key, value }) { <- "{key}:{value}" })::toString(),
					)
				}`),
			).toEqual([
				'"[\\"alex\\" = \\"alex:39\\", \\"sam\\" = \\"sam:25\\"]"',
			])
		})

		it("filters with 'everyEntry' and its complement 'removeEvery'", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(
						ages::everyEntry(where ({ key, value }) {
							<- value::isGreaterThan(30)
						})::toString(),
					)
					Terminal.inspect(
						ages::removeEvery(where ({ key, value }) {
							<- value::isGreaterThan(30)
						})::toString(),
					)
					Terminal.inspect(
						ages::everyEntry(where ({ key, value }) {
							<- key::is("nobody")
						})::toString(),
					)
				}`),
			).toEqual(['"[\\"alex\\" = 39]"', '"[\\"sam\\" = 25]"', '"[=]"'])
		})

		// Keeping some of the receiver's keys can not make two collide, so
		// neither filter asks for an `Equatable` bound. The Function holds an
		// unbounded Dictionary.
		it("filters a Dictionary of any keys without asking for a bound", async () => {
			expect(
				await run(`implementation {
					choice Colour { Red, Green, Blue }

					function evens<infer Key>(
						_ counts: Dictionary<Key, Integer>,
					) -> Dictionary<Key, Integer> {
						<- counts::everyEntry(where ({ value }) { <- value::isEven() })
					}

					constant noColours: Dictionary<Colour, Integer> = [=]
					constant colours = noColours
						::set(#Red, to 1)
						::set(#Green, to 2)
						::set(#Blue, to 4)
					constant seats = Dictionary.of([
						{ key = { row = 1, seat = 2 }, value = 1 },
						{ key = { row = 4, seat = 1 }, value = 2 },
					])

					Terminal.inspect(evens(colours)::keys())
					Terminal.inspect(evens(colours)::value(at #Blue))
					Terminal.inspect(evens(colours)::removeEvery(where ({ key }) {
						<- key::is(#Green)
					})::keys())
					Terminal.inspect(evens(seats)::value(at { seat = 1, row = 4 }))
					Terminal.inspect(evens(seats)::hasKey({ row = 1, seat = 2 }))
				}`),
			).toEqual([
				"[ Colour#Green, Colour#Blue ]",
				"Optional#Value(4)",
				"[ Colour#Blue ]",
				"Optional#Value(2)",
				"false",
			])
		})

		it("transforms a key's value, or leaves the Dictionary alone", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(
						ages::update(at "alex", with (age) { <- age::add(1) })::toString(),
					)
					Terminal.inspect(
						ages::update(at "kim", with (age) { <- age::add(1) })::toString(),
					)
				}`),
			).toEqual([
				'"[\\"alex\\" = 40, \\"sam\\" = 25]"',
				'"[\\"alex\\" = 39, \\"sam\\" = 25]"',
			])
		})

		it("starts an update from a given value where the key holds none", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(
						ages::update(at "alex", defaultingTo 0, with (age) {
							<- age::add(1)
						})::toString(),
					)
					Terminal.inspect(
						ages::update(at "kim", defaultingTo 0, with (age) {
							<- age::add(1)
						})::toString(),
					)
				}`),
			).toEqual([
				'"[\\"alex\\" = 40, \\"sam\\" = 25]"',
				'"[\\"alex\\" = 39, \\"sam\\" = 25, \\"kim\\" = 1]"',
			])
		})

		it("removes a key, and answers the same entries for one it does not hold", async () => {
			expect(
				await run(`implementation {
					${ages}

					Terminal.inspect(ages::remove(at "alex")::toString())
					Terminal.inspect(ages::remove(at "kim")::toString())
				}`),
			).toEqual([
				'"[\\"sam\\" = 25]"',
				'"[\\"alex\\" = 39, \\"sam\\" = 25]"',
			])
		})

		// The Argument wins on a shared key. The `choosing:` entry hands the
		// receiver's value first and the Argument's second.
		it("merges, letting the Argument win or the caller decide", async () => {
			expect(
				await run(`implementation {
					${ages}

					constant raises = Dictionary.of([
						{ key = "sam", value = 1 },
						{ key = "kim", value = 2 },
					])

					Terminal.inspect(ages::merge(with raises)::toString())
					Terminal.inspect(
						ages::merge(with raises, choosing (mine, theirs) {
							<- mine::add(theirs)
						})::toString(),
					)
				}`),
			).toEqual([
				'"[\\"alex\\" = 39, \\"sam\\" = 1, \\"kim\\" = 2]"',
				'"[\\"alex\\" = 39, \\"sam\\" = 26, \\"kim\\" = 2]"',
			])
		})
	})

	describe("Equality and printing", () => {
		// Equal means the same keys, each with an equal value, in any order.
		it("compares by entries rather than by order", async () => {
			expect(
				await run(`implementation {
					${ages}

					constant reordered = Dictionary.of([
						{ key = "sam", value = 25 },
						{ key = "alex", value = 39 },
					])
					constant changed = Dictionary.of([
						{ key = "alex", value = 39 },
						{ key = "sam", value = 26 },
					])

					Terminal.inspect(ages::is(reordered))
					Terminal.inspect(ages::isNot(reordered))
					Terminal.inspect(ages::is(changed))
					Terminal.inspect(ages::isNot(changed))
				}`),
			).toEqual(["true", "false", "false", "true"])
		})

		// `[=]` rather than `[]`, so the empty Dictionary is told apart from the
		// empty List.
		it("writes itself the way a Program writes one down", async () => {
			expect(
				await run(`implementation {
					${noPairs}

					constant codes = Dictionary.of([{ key = "a", value = "b" }])
					constant counts = Dictionary.of([{ key = "a", value = 1 }])

					Terminal.inspect(Dictionary.of(noPairs)::toString())
					Terminal.inspect(codes::toString())
					Terminal.inspect(counts::toString())
				}`),
			).toEqual(['"[=]"', '"[\\"a\\" = \\"b\\"]"', '"[\\"a\\" = 1]"'])
		})
	})

	describe("Keys of any Type", () => {
		// `Record::is` compares members structurally, so its witness is
		// branded and a Record key is found by its encoded members, in either
		// order. See `compositeText` in `packages/runtime/src/keyEncoding.ts`.
		it("finds a Record key by its members, on the encoded path", async () => {
			let source = `implementation {
				constant seats = Dictionary.of([
					{ key = { row = 1, seat = 2 }, value = "alex" },
					{ key = { row = 4, seat = 1 }, value = "sam" },
				])

				Terminal.inspect(seats::value(at { row = 4, seat = 1 }))
				Terminal.inspect(seats::value(at { seat = 1, row = 4 }))
				Terminal.inspect(seats::value(at { row = 9, seat = 9 }))
				Terminal.inspect(seats::hasKey({ row = 1, seat = 2 }))
				Terminal.inspect(
					seats::set({ row = 1, seat = 2 }, to "kim")::length(),
				)
			}`

			expect(generate(source)).toContain(
				"is: Record.is,\n\tstructural: true",
			)
			expect(await run(source)).toEqual([
				'Optional#Value("sam")',
				'Optional#Value("sam")',
				"Optional#Empty",
				"true",
				"2",
			])
		})

		// A Choice's derived equality reads the tag and the payload, so its
		// witness is branded like `Record`'s and a Case is found by its encoding.
		it("finds a Choice key by its tag, on the encoded path", async () => {
			let source = `implementation {
				choice Colour { Red, Green, Blue }

				constant none: Dictionary<Colour, Integer> = [=]
				constant counts = none::set(#Red, to 1)::set(#Blue, to 2)

				Terminal.inspect(counts::value(at #Red))
				Terminal.inspect(counts::value(at #Green))
				Terminal.inspect(counts::hasKey(#Blue))
				Terminal.inspect(counts::set(#Red, to 3)::length())
			}`

			expect(generate(source)).toContain(
				"is: $helpers.choiceIs,\n\tisNot: $helpers.choiceIsNot,\n\tstructural: true",
			)
			expect(await run(source)).toEqual([
				"Optional#Value(1)",
				"Optional#Empty",
				"true",
				"2",
			])
		})

		// A payload spelled two ways is one key where the derived `is` calls
		// them equal. A whole Rational is its Integer, and members stand in any
		// order.
		it("finds a Choice key with a payload through every member", async () => {
			expect(
				await run(`implementation {
					choice Box { Full { item: Number, label: String }, Empty }

					constant none: Dictionary<Box, Integer> = [=]
					constant boxes = none
						::set(#Full({ item = 3, label = "three" }), to 1)
						::set(#Empty, to 2)

					Terminal.inspect(
						boxes::value(at #Full({ label = "three", item = 3/1 })),
					)
					Terminal.inspect(
						boxes::value(at #Full({ item = 3, label = "four" })),
					)
					Terminal.inspect(boxes::value(at #Empty))
					Terminal.inspect(
						boxes::set(#Full({ item = 6/2, label = "three" }), to 9)
							::length(),
					)
				}`),
			).toEqual([
				"Optional#Value(1)",
				"Optional#Empty",
				"Optional#Value(2)",
				"2",
			])
		})

		// A written `is` replaces the derived one, so its witness is not
		// branded and every lookup asks it. Here every Colour is one key.
		it("finds a Choice key through a written 'is' rather than by its tag", async () => {
			let source = `implementation {
				choice Colour { Red, Green, Blue }

				namespace Colour for Colour is Equatable {
					is(_ other: Colour) -> Boolean {
						<- true
					}
				}

				constant none: Dictionary<Colour, Integer> = [=]
				constant counts = none::set(#Red, to 1)::set(#Blue, to 2)

				Terminal.inspect(counts::length())
				Terminal.inspect(counts::value(at #Green))
				Terminal.inspect(counts::remove(at #Green)::isEmpty())
			}`

			expect(generate(source)).not.toContain("structural")
			expect(await run(source)).toEqual([
				"1",
				"Optional#Value(2)",
				"true",
			])
		})

		// A generic Choice's witness is branded at run time by
		// `boundConformance`, only where every condition is branded. The scan
		// cases are under "Keys of a generic Choice".
		it("finds a generic Choice key in one step under branded Arguments", async () => {
			let source = `implementation {
				choice Wrap<Item> { Some { item: Item }, None }

				constant none: Dictionary<Wrap<Integer>, Integer> = [=]
				constant wrapped = none::set(#Some({ item = 1 }), to 1)

				Terminal.inspect(wrapped::value(at #Some({ item = 1 })))
				Terminal.inspect(wrapped::value(at #None))
			}`
			let generated = generate(source)
			let witness = generated.slice(
				generated.indexOf("$type.boundConformance({"),
				generated.indexOf(
					"}, [",
					generated.indexOf("$type.boundConformance({"),
				),
			)

			expect(witness).toContain("boundChoiceIs")
			expect(witness).toContain("structural: true")
			expect(await run(source)).toEqual([
				"Optional#Value(1)",
				"Optional#Empty",
			])
		})

		// `Number.is` answers by value across the numeric kinds, so `3` and
		// `3/1` are one key. The Dictionary keeps the key that arrived first.
		it("holds one key where two spellings are one Number", async () => {
			expect(
				await run(`implementation {
					constant noPairs: List<{ key: Number, value: String }> = []
					constant marks = Dictionary.of(noPairs)
						::set(3, to "whole")
						::set(3/1, to "the same three")
						::set(1/2, to "half")
						::set(2/4, to "the same half")

					Terminal.inspect(marks::length())
					Terminal.inspect(marks::keys())
					Terminal.inspect(marks::value(at 3))
					Terminal.inspect(marks::value(at 3/1))
					Terminal.inspect(marks::hasKey(6/2))
					Terminal.inspect(marks::hasKey(4))
				}`),
			).toEqual([
				"2",
				"[ 3, 1/2 ]",
				'Optional#Value("the same three")',
				'Optional#Value("the same three")',
				"true",
				"false",
			])
		})

		// A written `is` for a refined String makes "Ada" and "ada" one key,
		// which the encoding would not. An unbranded witness takes the scan path.
		// See `encodeKey` in `packages/runtime/src/keyEncoding.ts`.
		//
		// The sides are compared as plain Strings, since a lower-cased
		// `NonEmptyString` would reach this Method again.
		it("finds a refined String key through a written 'is'", async () => {
			expect(
				await run(`implementation {
					namespace Loose for NonEmptyString is Equatable {
						is(_ other: NonEmptyString) -> Boolean {
							constant mine: String   = @::lowercase()
							constant theirs: String = other::lowercase()

							<- mine::is(theirs)
						}
					}

					constant a: NonEmptyString = "Ada"
					constant b: NonEmptyString = "ada"
					constant c: NonEmptyString = "ADA"
					constant loans = Dictionary.of([
						{ key = a, value = 1 },
						{ key = b, value = 2 },
					])

					Terminal.inspect(loans::length())
					Terminal.inspect(loans::keys())
					Terminal.inspect(loans::hasKey(c))
					Terminal.inspect(loans::value(at c))
					Terminal.inspect(loans::remove(at a)::hasKey(b))
				}`),
			).toEqual(["1", '[ "Ada" ]', "true", "Optional#Value(2)", "false"])
		})

		// The same rule over a refined Integer.
		it("finds a refined Integer key through a written 'is'", async () => {
			expect(
				await run(`implementation {
					§ Two Integers are one key when they share a parity.
					namespace Parity for PositiveInteger is Equatable {
						is(_ other: PositiveInteger) -> Boolean {
							<- @::remainder(dividingBy 2)
								::is(other::remainder(dividingBy 2))
						}
					}

					constant one: PositiveInteger = 1
					constant three: PositiveInteger = 3
					constant odds = Dictionary.of([
						{ key = one, value = "first" },
						{ key = three, value = "second" },
					])

					Terminal.inspect(odds::length())
					Terminal.inspect(odds::keys())
					Terminal.inspect(odds::value(at three))
				}`),
			).toEqual(["1", "[ 1 ]", 'Optional#Value("second")'])
		})

		// A user Namespace may shadow a branded name inside a Function. The
		// brand follows the lexical answer, so the shadowing `is` finds the keys.
		// Inside that scope `String` is the shadowing Namespace.
		it("finds a key through a written 'is' in a Namespace shadowing 'String'", async () => {
			let source = `implementation {
				function borrowers() -> Integer {
					namespace String for NonEmptyString is Equatable {
						is(_ other: NonEmptyString) -> Boolean {
							<- true
						}
					}

					constant a: NonEmptyString = "Ada"
					constant b: NonEmptyString = "ada"
					constant loans = Dictionary.of([
						{ key = a, value = 1 },
						{ key = b, value = 2 },
					])

					<- loans::length()
				}

				Terminal.inspect(borrowers())
			}`

			expect(generate(source)).not.toContain("structural")
			expect(await run(source)).toEqual(["1"])
		})

		// A List's conformance is conditional, so `boundConformance` brands its
		// witness only where the item witness is branded. A List key encodes as
		// its count and its items.
		it("finds a List key by its items, on the encoded path", async () => {
			let source = `implementation {
				constant none: Dictionary<List<Integer>, String> = [=]
				constant visited = none
					::set([1, 2], to "start")
					::set([12, 3], to "corner")

				Terminal.inspect(visited::value(at [1, 2]))
				Terminal.inspect(visited::value(at [1, 23]))
				Terminal.inspect(visited::hasKey([12, 3]))
				Terminal.inspect(visited::set([1, 2], to "again")::length())
			}`

			expect(generate(source)).toContain("structural: true")
			expect(await run(source)).toEqual([
				'Optional#Value("start")',
				"Optional#Empty",
				"true",
				"2",
			])
		})

		// The brand is recursive. The count in each head keeps `[[1], [2]]` and
		// `[[1, 2]]` apart, and `[[]]` and `[]`.
		it("finds a nested List key, counts and all", async () => {
			expect(
				await run(`implementation {
					constant none: Dictionary<List<List<Integer>>, String> = [=]
					constant paths = none
						::set([[1], [2]], to "split")
						::set([[1, 2]], to "joined")
						::set([[]], to "one empty")
						::set([], to "none at all")

					Terminal.inspect(paths::length())
					Terminal.inspect(paths::value(at [[1], [2]]))
					Terminal.inspect(paths::value(at [[]]))
					Terminal.inspect(paths::value(at []))
				}`),
			).toEqual([
				"4",
				'Optional#Value("split")',
				'Optional#Value("one empty")',
				'Optional#Value("none at all")',
			])
		})

		// A written item `is` makes the two Lists one key, which only the scan
		// path can find. The List's map carries the brand, and `boundConformance`
		// withholds it because the `Loose` item witness has none.
		it("leaves a List key on the scan path under a written item 'is'", async () => {
			let source = `implementation {
				function names() -> Integer {
					namespace Loose for NonEmptyString is Equatable {
						is(_ other: NonEmptyString) -> Boolean {
							<- true
						}
					}

					constant a: NonEmptyString = "Ada"
					constant b: NonEmptyString = "bob"
					constant seen = Dictionary.of([
						{ key = [a], value = 1 },
						{ key = [b], value = 2 },
					])

					<- seen::length()
				}

				Terminal.inspect(names())
			}`

			expect(generate(source)).toContain("{ is: Loose.is }")
			expect(await run(source)).toEqual(["1"])
		})

		// A refinement's conformance resolves to its base Namespace's, so a
		// refined List of refined items is branded as the unrefined pair is.
		it("finds a refined List key of refined items on the encoded path", async () => {
			let source = `implementation {
				constant words: NonEmptyList<NonEmptyString> = ["ada", "bob"]
				constant rows = Dictionary.of([{ key = words, value = 1 }])

				Terminal.inspect(rows::value(at ["ada", "bob"]))
				Terminal.inspect(rows::value(at ["ada"]))
			}`

			expect(generate(source)).toContain("structural: true")
			expect(await run(source)).toEqual([
				"Optional#Value(1)",
				"Optional#Empty",
			])
		})
	})

	// A generic Choice key follows a List's rule: its witness is branded only
	// where every Type Argument's witness is. Each scan case hides a written
	// `is` that calls all values equal, so only the scan path finds one key.
	describe("Keys of a generic Choice", () => {
		const loose = `namespace Loose for NonEmptyString is Equatable {
						is(_ other: NonEmptyString) -> Boolean {
							<- true
						}
					}

					constant a: NonEmptyString = "Ada"
					constant b: NonEmptyString = "bob"`

		it("leaves an Optional key on the scan path under a written payload 'is'", async () => {
			let source = `implementation {
				function names() -> Integer {
					${loose}

					constant seen: Dictionary<Optional<NonEmptyString>, Integer> = [=]

					<- seen::set(#Value(a), to 1)::set(#Value(b), to 2)::length()
				}

				Terminal.inspect(names())
			}`

			expect(generate(source)).toContain("{ is: Loose.is }")
			expect(await run(source)).toEqual(["1"])
		})

		// The written `is` one container further in, so the List's witness
		// arrives at the Optional unbranded.
		it("leaves an Optional key on the scan path under a written item 'is' inside a List", async () => {
			let source = `implementation {
				function names() -> Integer {
					${loose}

					constant seen: Dictionary<Optional<List<NonEmptyString>>, Integer> = [=]

					<- seen::set(#Value([a]), to 1)::set(#Value([b]), to 2)::length()
				}

				Terminal.inspect(names())
			}`

			expect(await run(source)).toEqual(["1"])
		})

		// A Result's second condition: the value Type is branded and the
		// failure Type is not.
		it("leaves a Result key on the scan path under a written failure 'is'", async () => {
			let source = `implementation {
				function names() -> Integer {
					${loose}

					constant seen: Dictionary<Result<Integer, NonEmptyString>, Integer> = [=]

					<- seen::set(#Failure(a), to 1)::set(#Failure(b), to 2)::length()
				}

				Terminal.inspect(names())
			}`

			expect(await run(source)).toEqual(["1"])
		})

		// And its first condition.
		it("leaves a Result key on the scan path under a written value 'is'", async () => {
			let source = `implementation {
				function names() -> Integer {
					${loose}

					constant seen: Dictionary<Result<NonEmptyString, Integer>, Integer> = [=]

					<- seen::set(#Value(a), to 1)::set(#Value(b), to 2)::length()
				}

				Terminal.inspect(names())
			}`

			expect(await run(source)).toEqual(["1"])
		})

		// A Program's own Choice derives `boundChoiceIs` over a descriptor, which
		// asks the Type Arguments' witnesses at the members naming them.
		it("leaves a user generic Choice key on the scan path under a written 'is'", async () => {
			let source = `implementation {
				choice Pair<LeftType, RightType> {
					Both { left: LeftType, right: RightType },
					Neither,
				}

				function names() -> Integer {
					${loose}

					constant seen: Dictionary<Pair<NonEmptyString, Integer>, Integer> = [=]

					<- seen
						::set(Pair<NonEmptyString, Integer>#Both({ left = a, right = 1 }), to 1)
						::set(Pair<NonEmptyString, Integer>#Both({ left = b, right = 1 }), to 2)
						::length()
				}

				Terminal.inspect(names())
			}`

			expect(await run(source)).toEqual(["1"])
		})

		// A generic Choice whose own Namespace writes the `is`: its witness is
		// not branded, whatever its conditions. The written `is` calls every
		// Wrap equal, so the table holds one key.
		it("leaves a generic Choice key on the scan path under its own written 'is'", async () => {
			let source = `implementation {
				choice Wrap<ItemType> {
					Some { item: ItemType },
					None,
				}

				namespace Wrap<infer ItemType> for Wrap<ItemType>
					is Equatable where ItemType is Equatable
				{
					is(_ other: Wrap<ItemType>) -> Boolean {
						<- true
					}
				}

				constant empty: Dictionary<Wrap<Integer>, Integer> = [=]
				constant table = empty
					::set(Wrap<Integer>#Some({ item = 1 }), to 1)
					::set(Wrap<Integer>#Some({ item = 2 }), to 2)

				Terminal.inspect(table::length())
			}`

			// The method map is read by name, since the Integer witness beside
			// it is branded.
			expect(generate(source)).toContain(
				"$type.boundConformance({ is: Wrap.is }, [",
			)
			expect(await run(source)).toEqual(["1"])
		})

		// The witness forwarded through generic Functions, one hop and two, is
		// settled by `boundConformance` at run time. The second hop reuses the
		// Type Parameter's name, as in `genericWitnessArity.spec.ts`.
		it("leaves a forwarded generic Choice key on the scan path under a written 'is'", async () => {
			let source = `implementation {
				function counted<infer KeyType is Equatable>(
					_ first: Optional<KeyType>,
					_ second: Optional<KeyType>,
				) -> Integer {
					constant seen: Dictionary<Optional<KeyType>, Integer> = [=]

					<- seen::set(first, to 1)::set(second, to 2)::length()
				}

				function forwarded<infer KeyType is Equatable>(
					_ first: Optional<KeyType>,
					_ second: Optional<KeyType>,
				) -> Integer {
					<- counted(first, second)
				}

				function again<infer ItemType is Equatable>(
					_ first: Optional<ItemType>,
					_ second: Optional<ItemType>,
				) -> Integer {
					<- forwarded(first, second)
				}

				function names() -> {} {
					${loose}

					constant looseA = Optional<NonEmptyString>#Value(a)
					constant looseB = Optional<NonEmptyString>#Value(b)
					constant plainA = Optional<Integer>#Value(1)
					constant plainB = Optional<Integer>#Value(2)

					Terminal.inspect(counted(looseA, looseB))
					Terminal.inspect(forwarded(looseA, looseB))
					Terminal.inspect(again(looseA, looseB))
					Terminal.inspect(counted(plainA, plainB))
					Terminal.inspect(forwarded(plainA, plainB))
					Terminal.inspect(again(plainA, plainB))
				}

				names()
			}`

			expect(await run(source)).toEqual(["1", "1", "1", "2", "2", "2"])
		})
	})

	// A Dictionary is printable exactly when its keys and values are. The
	// failure one level deep is `unsatisfied-bound`, and two levels deep it
	// reports the condition that failed.
	describe("Conditional conformance", () => {
		const handlers = `constant handlers = Dictionary.of([
				{ key = "a", value = (_ n: Integer) -> Integer { <- n } },
			])`

		it("refuses 'toString' where the values are not Printable", () => {
			let diagnostics = diagnosticsOf(`implementation {
				${handlers}

				Terminal.inspect(handlers::toString())
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unsatisfied-bound",
			])
		})

		it("names the condition that failed where the whole Dictionary is bound", () => {
			let diagnostics = diagnosticsOf(`implementation {
				${handlers}

				Terminal.inspect([handlers]::toString())
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unsatisfied-conformance-condition",
			])
			// The head of the because-chain repeats the message, so it is
			// dropped. No Help follows, since no `for` clause names a Function Type.
			expect(diagnostics[0]!.notes).toEqual([
				"(_: Integer) -> Integer does not conform to 'Printable'.",
				"No Namespace can be declared for (_: Integer) -> Integer — a 'for' clause takes a named Type.",
			])
		})

		it("refuses equality where the values are not Equatable", () => {
			let diagnostics = diagnosticsOf(`implementation {
				${handlers}

				Terminal.inspect(handlers::is(handlers))
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unsatisfied-bound",
			])
		})
	})
})
