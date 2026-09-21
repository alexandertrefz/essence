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

// NOTE: A Dictionary is a generation-stamped store shared between every box
// that was ever written from one — see `packages/runtime/src/Dictionary.ts` —
// and the promise the design rests on is that nothing of that is visible from
// Essence. What a box answers, what order it answers it in, and which two keys
// are one key are all claims about a Program that RUNS, so every one of them is
// compiled and executed here rather than only type-checked.
//
// NOTE: `packages/runtime/src/tests/dictionaries.spec.ts` drives the store
// itself — the repack rules, the generations, the encodings. This file asks the
// language the same questions through the Namespace, which is the only door a
// Program has.
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

// NOTE: A conformance condition is the Enricher's answer, so this stops where
// the failure is reported rather than running the Validator over a Program the
// Enricher already refused.
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

// NOTE: The receiver every group below reads, written once. There is no
// Dictionary literal in this slice, so a Dictionary is built from a List of
// entry Records and the empty one from an annotated empty List — `Dictionary.of`
// reads both Type Arguments off the entries it is handed, and no entry carries
// either.
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

		// NOTE: The later value wins and the key keeps the place its FIRST
		// occurrence gave it, which is the same rule an overwrite follows.
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
		// NOTE: The entries are read off a Dictionary of short names, because
		// `Terminal.inspect` wraps a structure whose single line reaches sixty
		// characters and this asserts on one line per call.
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

		// NOTE: The two halves of one design rule. An overwrite is not a
		// removal followed by an insertion — the key keeps the place it had —
		// and a key that was genuinely REMOVED is new when it comes back, so it
		// lands at the end. `keys()` is what says which of the two happened.
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

		// NOTE: The receiver of a write still answers what it answered. Every
		// box is a view of the shared store at its own generation, and this is
		// the claim that says so from the language's side.
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
		// NOTE: Every callback a Dictionary Method takes is handed the ENTRY
		// Record, which is what lets a Pattern take it apart in the Parameter
		// list rather than reading two members out of a name inside the body.
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

		// NOTE: Both filters are native and share the receiver's key encodings,
		// so a filtered Dictionary answers a lookup the way the receiver did,
		// whatever its keys are — and neither asks for an `Equatable` bound,
		// since keeping some of the receiver's keys can not make two collide.
		// The Function below holds an UNBOUNDED Dictionary, on which
		// `remove(at:)` is `unsatisfied-bound`.
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

		// NOTE: The Argument wins on a key both hold, and the `choosing:` entry
		// hands the receiver's value first and the Argument's second.
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
		// NOTE: Order-INSENSITIVE, which is what the design says two
		// Dictionaries mean by equal: the same keys, each with an equal value.
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

		// NOTE: `[=]` rather than `[]`, which is the whole reason the empty
		// Dictionary is spelled with the `=` a Program writes an entry with: a
		// reader has to be able to tell it from the empty List.
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
		// NOTE: `Record::is` is the universal structural comparison over the
		// members — it never asks a member's own Namespace, which is what
		// `Record.es` says of it — so its witness carries the `structural`
		// brand and a Record whose members all encode is found in one step,
		// under a text spelled from those members. The members can arrive in
		// either order and spell one key. See `compositeText` in
		// `packages/runtime/src/Dictionary.ts`.
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

		// NOTE: The equality the language derives for a Choice is its own —
		// the tag decides the Case and the payload compares as a Record — so
		// the derived witness is branded like `Record`'s, and a Case is found
		// under a text spelled from its tag and its payload. A Dictionary keyed
		// by a payload-free Choice is the most ordinary Dictionary there is,
		// and this is what keeps it off the scan path.
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

		// NOTE: A payload spelled two ways is one key exactly where the derived
		// `is` calls the two equal: a whole Rational is the Integer it equals,
		// and the members of a payload stand in any order.
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

		// NOTE: A Namespace that writes an `is` for its Choice REPLACES the
		// derivation, and its witness arrives under the Namespace's own name
		// rather than the derived one — so it is not branded, and every lookup
		// asks the written `is`. Every Colour is one key here, which no tag
		// encoding could have said.
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

		// NOTE: A generic Choice's derived witness is CONDITIONAL on its Type
		// Arguments' witnesses, so the brand rides on its method map and
		// `boundConformance` settles it at run time, branding the witness it
		// builds only where every condition arrived branded. Here the one Type
		// Argument is an Integer, so the key is found in one step. The scan
		// cases live under "Keys of a generic Choice" below, where a Type
		// Argument carries an `is` a Program wrote.
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

		// NOTE: `Number.is` answers by VALUE across the numeric kinds, so `3`
		// and `3/1` have to be one key under a covering key Type, and `1/2` and
		// `2/4` have to be one under any. The key box the Dictionary keeps is
		// the one that arrived FIRST, which is why the keys read back as they
		// were written rather than as the encoding they share.
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

		// NOTE: A Namespace may write its own `is` for a refinement of a key
		// kind the store knows how to encode, and then the encoding is WRONG
		// about which two keys are one key — `"Ada"` and `"ada"` encode apart
		// and this witness calls them equal. So the Compiler brands the
		// witnesses whose `is` is the standard library's own structural one,
		// the store takes its one-lookup fast path only for a branded witness,
		// and everything else walks the entries asking the witness. See
		// `encodeKey` in `packages/runtime/src/Dictionary.ts` and
		// `isStructurallyEquatable` in the Rewriter.
		//
		// NOTE: The two sides are read as plain Strings before they are
		// compared. `namespace NonEmptyString` carries the proof through
		// `lowercase`, so a lower-cased NonEmptyString is a NonEmptyString
		// again — and asking IT `is` would reach this very Method, which
		// answers by asking `is` once more. Declaring the Type the comparison
		// is made at is what stops the witness from being written in terms of
		// itself.
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

		// NOTE: The same rule over a refined Integer, so the branding is not
		// something only String's witness happens to get right.
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

		// NOTE: A user Namespace may SHADOW one of the branded names inside a
		// Function, and it arrives at the Rewriter under that name. The brand
		// is decided by the same lexical answer every member read is decided
		// by, so the shadowing Namespace's own `is` is what finds the keys —
		// branding it would have put "Ada" and "ada" in two slots. The body
		// reaches no String Method, because inside that scope `String` IS the
		// shadowing Namespace.
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

		// NOTE: `List<ItemType> is Equatable where ItemType is Equatable` is
		// conditional, and a conditional conformance carries the brand only
		// where its conditions do — which `boundConformance` settles, so the
		// brand stands in the emitted map and the witness built from it is the
		// one that has it. A List key is found under `l<count>:` and its items'
		// own texts, which is what makes the obvious memo table for a pair of
		// coordinates flat rather than quadratic.
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

		// NOTE: The brand is recursive, because the condition it is asked of is
		// itself a List's. A `List<List<Integer>>` key is branded exactly when
		// the Integer witness at the bottom is, and the count in each head is
		// what keeps `[[1], [2]]` and `[[1, 2]]` two keys — and `[[]]` and `[]`
		// two more.
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

		// NOTE: THE CASE THE BRAND EXISTS FOR. A Namespace that writes an `is`
		// for the ITEM Type is handed to `List::is` as the item witness, so two
		// Lists are equal exactly where that `is` says their items are — and
		// the canonical encoding would have said something else. Here every
		// NonEmptyString is every other one, so the two Lists are ONE key, and
		// only the scan path can say that: the answer below is the assertion.
		//
		// NOTE: The brand does stand in the emitted map, because a List's is
		// CONDITIONAL and the map is what carries it to `boundConformance` —
		// which is where it is refused, the `Loose` witness curried onto it
		// having none. So what is asserted of the emitted text is that the item
		// witness arrives unbranded; the rest of the claim is the run.
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

		// NOTE: A refinement declares no `is` of its own, so its conformance
		// resolves to the base Namespace's and arrives under the base's name —
		// which holds at both ends of a List key: `NonEmptyList<T>` emits
		// `List`'s witness and `NonEmptyString` items emit `String`'s, so the
		// pair is branded exactly as the unrefined pair is.
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

	// NOTE: A GENERIC CHOICE'S KEYS, which is the same rule as a List's met on
	// the other kind of container. `Optional<ItemType> is Equatable where
	// ItemType is Equatable` compares two Cases by their tag and then their
	// payload through the ITEM's own witness — so the canonical text may stand
	// in for it exactly when that witness is branded, and never otherwise.
	// `Result` carries two conditions and a user Choice carries one per Type
	// Parameter; the rule is the same and the answer is `every`.
	//
	// NOTE: THE SCAN CASES STAND FIRST, and they are the ones that matter. A
	// branded witness is a claim that the encoding says what the Program's own
	// `is` says, and the way to get that wrong is to brand where a Namespace
	// wrote an `is` of its own. Each of these puts a written `is` somewhere
	// inside a generic Choice key and asserts the ANSWER — every `Loose`
	// receiver below calls its values equal, so the Dictionary holds ONE key
	// and only the scan path can say so.
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

		// NOTE: The written `is` one container further in, so the refusal is the
		// recursion rather than a single lookup: the List's own witness is
		// conditional, carries `Loose`, and arrives at the Optional unbranded.
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

		// NOTE: A Result's SECOND condition, which is the one a witness asking
		// `some` where it should ask `every` would let through: the value Type
		// is branded and the failure Type is not.
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

		// NOTE: And its FIRST condition, so neither order of the two is the one
		// that happens to be read.
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

		// NOTE: A Choice the PROGRAM declares, whose equality is derived rather
		// than written — the witness is `boundChoiceIs` over a descriptor, which
		// asks the Type Arguments' witnesses at the members that name a Type
		// Parameter and compares the rest structurally. Same rule, same answer.
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

		// NOTE: A GENERIC CHOICE WHOSE OWN NAMESPACE WRITES THE `is`, which is
		// the rule that already held for a Choice with no Type Parameters, met
		// where the conformance is conditional. `Wrap`'s witness arrives under
		// its own name rather than the derived one and is on neither list, so
		// the conditions are never even asked — and here the written `is` calls
		// every Wrap every other one, so the table holds ONE key.
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

			// NOTE: The method map is read by name rather than the whole
			// emitted text, because the Integer witness beside it IS branded
			// and would answer the broader question for it.
			expect(generate(source)).toContain(
				"$type.boundConformance({ is: Wrap.is }, [",
			)
			expect(await run(source)).toEqual(["1"])
		})

		// NOTE: The witness FORWARDED through generic Functions rather than
		// built where the Dictionary is, one hop and two — which is the shape
		// the Rewriter has no name for and `boundConformance` settles at run
		// time. The second pair spells the callee's Type Parameter the same as
		// the caller's, which is the name collision `genericWitnessArity.spec.ts`
		// is about: the witness that arrives a level too deep would be branded
		// on the strength of the wrong conditions.
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

	// NOTE: Both conformances are conditional, so a Dictionary is printable
	// exactly when its keys and its values are. The two Diagnostics below are
	// the same failure met at two depths, and the Enricher tells them apart by
	// the length of the because-chain: `toString`'s own bound is one level and
	// reports `unsatisfied-bound`, while a Type Parameter bound to the whole
	// Dictionary is two and reports the condition that failed underneath it.
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
			// NOTE: The head of the because-chain is dropped where it only
			// repeats the message above it, so every Note says something the
			// reader has not been told. The last one is why no Help follows:
			// no `for` clause can name a Function Type.
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
