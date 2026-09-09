import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import { createDictionary } from "../Dictionary"
import {
	decode,
	encode,
	type EncodedValue,
	generate,
	GenerationFailure,
	type Generator,
	minimal,
	mutate,
	type Narrowing,
	shrink,
} from "../Generators"
import { createInteger } from "../Integer"
import { anyIs } from "../internalHelpers"
import { createList, viewOf } from "../List"
import { createRandomness, type RandomnessType, seedOf } from "../Randomness"
import { createRational } from "../Rational"
import { createRecord } from "../Record"
import { createString } from "../String"
import { type AnyType, createCase, liveEntriesOf, typeKeySymbol } from "../type"

// NOTE: The generator interpreter as a unit — what it BUILDS and what it makes
// smaller — driven directly rather than through a compile. What the Compiler
// derives from a Type is `testingProperties.spec.ts`; what the descriptions it
// derives MEAN is here.
//
// NOTE: Every draw is over a fixed seed, so every assertion below is about a
// sequence that is the same on every machine and in every run.

function sourceOf(seed = "beef"): RandomnessType {
	return createRandomness(seedOf(seed))
}

function draw(
	generator: Generator,
	count: number,
	options: { seed?: string; size?: number } = {},
): Array<AnyType> {
	let source = sourceOf(options.seed)
	let drawn: Array<AnyType> = []

	for (let index = 0; index < count; index++) {
		drawn.push(generate(generator, source, options.size ?? 12))
	}

	return drawn
}

function wholeOf(value: AnyType): bigint {
	return BigInt((value as unknown as { value: number | bigint }).value)
}

function textOf(value: AnyType): string {
	return (value as unknown as { value: string }).value
}

// NOTE: What `Generatable` provides as `shrink`, which is what the Compiler
// emits for a conformance whose Namespace writes none of its own.
function noCandidates(): AnyType {
	return createList([])
}

function itemsOf(value: AnyType): Array<AnyType> {
	let view = viewOf(value as Parameters<typeof viewOf>[0])
	let items: Array<AnyType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		items.push(view.front[index]!)
	}

	for (let index = 0; index < view.backCount; index++) {
		items.push(view.back[index]!)
	}

	return items
}

function tagOf(value: AnyType): string {
	return (value as unknown as Record<symbol, string>)[typeKeySymbol]!
}

// NOTE: The witness a Dictionary built here is handed. `Generators.ts` builds
// its own drawn Dictionaries through the same universal comparison, so this is
// what a drawn one was keyed by and what a hand-built one has to agree with.
const anyEquatable = {
	is: (a: AnyType, b: AnyType) => createBoolean(anyIs(a, b)),
}

function dictionaryOf(entries: Array<[AnyType, AnyType]>): AnyType {
	return createDictionary(entries, anyEquatable) as AnyType
}

function entriesOf(value: AnyType): Array<[AnyType, AnyType]> {
	return liveEntriesOf(value as Parameters<typeof liveEntriesOf>[0])
}

const integers: Generator = { kind: "integer" }
const strings: Generator = { kind: "string" }
const booleans: Generator = { kind: "boolean" }
const rationals: Generator = { kind: "rational" }

// NOTE: What a checked refinement's description looks like once the Compiler
// has lowered it: a base, whatever the narrowing holds by construction, and the
// predicate as a check over the value.
function refined(
	name: string,
	base: Generator,
	narrowing: Narrowing,
	checks: Array<(value: AnyType) => { value: boolean }> = [],
): Generator {
	return { kind: "refined", name, base, checks, narrowing }
}

describe("Generators", () => {
	describe("what a draw answers", () => {
		test("answers an Integer, and the same one for the same seed", () => {
			let first = draw(integers, 20, { seed: "one" }).map(wholeOf)
			let again = draw(integers, 20, { seed: "one" }).map(wholeOf)
			let other = draw(integers, 20, { seed: "two" }).map(wholeOf)

			expect(first).toEqual(again)
			expect(first).not.toEqual(other)
		})

		test("draws Integers on both sides of zero", () => {
			let drawn = draw(integers, 200).map(wholeOf)

			expect(drawn.some((value) => value < 0n)).toBe(true)
			expect(drawn.some((value) => value > 0n)).toBe(true)
			expect(drawn.some((value) => value === 0n)).toBe(true)
		})

		// NOTE: One draw in eight is taken from a far wider window, which is
		// what meets an assumption a small number never breaks. The window has a
		// ceiling as well, a hundred spans, because what a draw is fed to can
		// grow far faster than the draw — a power's digits, a range's items.
		test("draws an Integer past what a small window holds", () => {
			let drawn = draw(integers, 200).map(wholeOf)

			expect(drawn.some((value) => value > 1_000n)).toBe(true)
		})

		test("draws no Integer past a hundred spans", () => {
			let drawn = draw(integers, 2_000, { size: 49 }).map(wholeOf)
			let span = 49n * 4n + 8n

			for (let value of drawn) {
				expect(value >= -span * 100n && value <= span * 100n).toBe(true)
			}
		})

		test("answers both Booleans", () => {
			let drawn = draw(booleans, 40).map(
				(value) => (value as unknown as { value: boolean }).value,
			)

			expect(drawn.some((value) => value)).toBe(true)
			expect(drawn.some((value) => !value)).toBe(true)
		})

		test("answers exact Rationals over small denominators", () => {
			let drawn = draw(rationals, 60) as unknown as Array<{
				numerator: bigint
				denominator: bigint
			}>

			for (let value of drawn) {
				expect(value.denominator).toBeLessThanOrEqual(100n)
				expect(value.denominator).toBeGreaterThan(0n)
			}

			expect(drawn.some((value) => value.denominator !== 1n)).toBe(true)
		})

		test("answers Strings of varying length, empty among them", () => {
			let drawn = draw(strings, 60).map(textOf)

			expect(drawn.some((value) => value === "")).toBe(true)
			expect(drawn.some((value) => value.length > 3)).toBe(true)
		})

		test("answers Lists of varying length, empty among them", () => {
			let drawn = draw({ kind: "list", item: integers }, 60).map(itemsOf)

			expect(drawn.some((items) => items.length === 0)).toBe(true)
			expect(drawn.some((items) => items.length > 3)).toBe(true)
		})

		test("answers a Record with every member filled in", () => {
			let generator: Generator = {
				kind: "record",
				members: [
					{ name: "name", generator: strings },
					{ name: "count", generator: integers },
				],
			}

			for (let value of draw(generator, 20)) {
				let record = value as unknown as Record<string, AnyType>

				expect(tagOf(value)).toBe("Record")
				expect(tagOf(record["name"]!)).toBe("String")
				expect(tagOf(record["count"]!)).toBe("Integer")
			}
		})

		test("answers every Case of a Union", () => {
			let generator: Generator = {
				kind: "union",
				members: [
					{ kind: "case", tag: "Shade#Light", members: [] },
					{
						kind: "case",
						tag: "Shade#Dark",
						members: [{ name: "level", generator: integers }],
					},
				],
			}
			let tags = new Set(draw(generator, 60).map(tagOf))

			expect(tags).toEqual(new Set(["Shade#Light", "Shade#Dark"]))
		})

		test("stamps a payload-free Case with its own tag", () => {
			let value = generate(
				{ kind: "case", tag: "Ordering#Equal", members: [] },
				sourceOf(),
				4,
			)

			expect(value).toBe(
				createCase("Ordering#Equal") as unknown as AnyType,
			)
		})

		// NOTE: The two slots drawn apart, and the one thing collapsing a
		// repeated key does to a draw: what comes out may hold FEWER entries
		// than were drawn for it, so the count is never asserted — only that
		// every entry is a key and a value of the Types the slots named.
		test("draws a Dictionary of the two slots it was given", () => {
			let generator: Generator = {
				kind: "dictionary",
				key: strings,
				value: integers,
			}
			let drawn = draw(generator, 12)

			expect(drawn.every((value) => tagOf(value) === "Dictionary")).toBe(
				true,
			)
			expect(
				drawn.every((value) =>
					entriesOf(value).every(
						([key, held]) =>
							tagOf(key) === "String" &&
							tagOf(held) === "Integer",
					),
				),
			).toBe(true)
			expect(drawn.some((value) => entriesOf(value).length > 0)).toBe(
				true,
			)
		})

		test("asks a Namespace's own generator and nothing else", () => {
			let asked: Array<RandomnessType> = []
			let generator: Generator = {
				kind: "generated",
				name: "Team",
				generate: (source) => {
					asked.push(source)

					return createString("Lions")
				},
				shrink: noCandidates,
			}

			expect(draw(generator, 3).map(textOf)).toEqual([
				"Lions",
				"Lions",
				"Lions",
			])
			expect(asked).toHaveLength(3)
		})
	})

	describe("what a refinement holds", () => {
		// NOTE: THE claim a property test over `NonEmptyList<…>` rests on.
		test("never draws an empty List for a non-empty one", () => {
			let generator = refined(
				"NonEmptyList",
				{ kind: "list", item: strings },
				{ minimumLength: 1 },
			)

			for (let value of draw(generator, 200)) {
				expect(itemsOf(value).length).toBeGreaterThanOrEqual(1)
			}
		})

		test("never draws zero for a non-zero Integer", () => {
			let generator = refined("NonZeroInteger", integers, {
				notEqualTo: ["0"],
			})

			for (let value of draw(generator, 300)) {
				expect(wholeOf(value)).not.toBe(0n)
			}
		})

		test("keeps every bound a narrowing states", () => {
			let generator = refined("Small", integers, {
				atLeast: "3",
				atMost: "9",
			})

			for (let value of draw(generator, 200)) {
				expect(wholeOf(value)).toBeGreaterThanOrEqual(3n)
				expect(wholeOf(value)).toBeLessThanOrEqual(9n)
			}
		})

		test("keeps a minimum length a narrowing states", () => {
			let generator = refined("Wordy", strings, { minimumLength: 2 })

			for (let value of draw(generator, 100)) {
				expect([...textOf(value)].length).toBeGreaterThanOrEqual(2)
			}
		})

		// NOTE: A predicate the narrowing does not hold is the FILTER: values
		// are drawn and refused until one is admitted.
		test("draws only what every check admits", () => {
			let generator = refined("EvenInteger", integers, {}, [
				(value) => ({ value: wholeOf(value) % 2n === 0n }),
			])

			for (let value of draw(generator, 200)) {
				expect(wholeOf(value) % 2n).toBe(0n)
			}
		})

		// NOTE: A narrowing that holds the whole predicate leaves no check to
		// run, so nothing else would notice a draw or a shrink answering a bound
		// it could not honour.
		test("refuses a value the narrowing itself forbids", () => {
			let generator = refined("Nothing", integers, {
				atLeast: "5",
				atMost: "5",
				notEqualTo: ["5"],
			})

			expect(() => generate(generator, sourceOf(), 4)).toThrow(
				GenerationFailure,
			)
			expect(minimal(generator)).toBeNull()
		})

		test("refuses a predicate nothing satisfies rather than answering", () => {
			let generator = refined("Impossible", integers, {}, [
				() => ({ value: false }),
			])

			expect(() => generate(generator, sourceOf(), 4)).toThrow(
				GenerationFailure,
			)
		})
	})

	describe("what a shrink answers", () => {
		test("walks an Integer towards zero", () => {
			let candidates = shrink(integers, createInteger(64n)).map(wholeOf)

			expect(candidates[0]).toBe(0n)
			expect(candidates).toContain(63n)
			expect(candidates.every((value) => value < 64n)).toBe(true)
		})

		test("answers nothing for an Integer already at zero", () => {
			expect(shrink(integers, createInteger(0n))).toEqual([])
		})

		test("walks a negative Integer up towards zero", () => {
			let candidates = shrink(integers, createInteger(-9n)).map(wholeOf)

			expect(candidates[0]).toBe(0n)
			expect(candidates.every((value) => value > -9n)).toBe(true)
		})

		test("keeps a narrowing while it shrinks", () => {
			let generator = refined("NonZeroInteger", integers, {
				notEqualTo: ["0"],
			})
			let candidates = shrink(generator, createInteger(50n)).map(wholeOf)

			expect(candidates).not.toContain(0n)
			expect(candidates).toContain(1n)
		})

		test("shortens a String and simplifies what is left", () => {
			let candidates = shrink(strings, createString("kQ9x")).map(textOf)

			expect(candidates).toContain("")
			expect(candidates).toContain("kQ9")
			expect(candidates).toContain("aQ9x")
		})

		test("never shrinks a String below the length a narrowing states", () => {
			let generator = refined("Wordy", strings, { minimumLength: 2 })

			for (let candidate of shrink(generator, createString("abcd"))) {
				expect([...textOf(candidate)].length).toBeGreaterThanOrEqual(2)
			}
		})

		test("drops items from a List and shrinks the ones that stay", () => {
			let value = createList([createInteger(4n), createInteger(9n)])
			let candidates = shrink(
				{ kind: "list", item: integers },
				value,
			).map((candidate) => itemsOf(candidate).map(wholeOf))

			expect(candidates).toContainEqual([])
			expect(candidates).toContainEqual([9n])
			expect(candidates).toContainEqual([4n])
			expect(candidates).toContainEqual([0n, 9n])
		})

		test("never shrinks a non-empty List to an empty one", () => {
			let generator = refined(
				"NonEmptyList",
				{ kind: "list", item: integers },
				{ minimumLength: 1 },
			)
			let value = createList([createInteger(4n), createInteger(9n)])

			for (let candidate of shrink(generator, value)) {
				expect(itemsOf(candidate).length).toBeGreaterThanOrEqual(1)
			}
		})

		test("shrinks one member of a Record at a time", () => {
			let generator: Generator = {
				kind: "record",
				members: [
					{ name: "name", generator: strings },
					{ name: "count", generator: integers },
				],
			}
			let value = createRecord({
				name: createString("xy"),
				count: createInteger(6n),
			})
			let candidates = shrink(generator, value).map((candidate) => {
				let record = candidate as unknown as Record<string, AnyType>

				return [textOf(record["name"]!), wholeOf(record["count"]!)]
			})

			expect(candidates).toContainEqual(["", 6n])
			expect(candidates).toContainEqual(["xy", 0n])
		})

		test("shrinks a Union towards its simplest arm", () => {
			let generator: Generator = {
				kind: "union",
				members: [
					{
						kind: "case",
						tag: "Optional#Value",
						members: [{ name: "item", generator: integers }],
					},
					{ kind: "case", tag: "Optional#Empty", members: [] },
				],
			}
			let value = createCase("Optional#Value", {
				item: createInteger(7n),
			}) as unknown as AnyType
			let candidates = shrink(generator, value)

			expect(candidates.map(tagOf)).toContain("Optional#Empty")
			expect(candidates.map(tagOf)).toContain("Optional#Value")
		})

		test("shrinks a Rational towards zero and towards a whole number", () => {
			let candidates = shrink(
				rationals,
				createRational(7n, 4n),
			) as unknown as Array<{ numerator: bigint; denominator: bigint }>

			expect(candidates[0]).toEqual(createRational(0n, 1n))
			expect(candidates).toContainEqual(createRational(7n, 1n))
		})

		test("shrinks true to false and false to nothing", () => {
			expect(shrink(booleans, createBoolean(true))).toEqual([
				createBoolean(false),
			])
			expect(shrink(booleans, createBoolean(false))).toEqual([])
		})

		// NOTE: A Namespace that writes no `shrink` keeps the one `Generatable`
		// provides, which answers no candidates at all — so a value its
		// generator drew is reported as it was drawn.
		test("answers no candidate where the conformance answers none", () => {
			let generator: Generator = {
				kind: "generated",
				name: "Team",
				generate: () => createString("Lions"),
				shrink: noCandidates,
			}

			expect(shrink(generator, createString("Lions"))).toEqual([])
		})

		// NOTE: And a Namespace that writes one is asked, with the failing
		// value in hand. The candidates are answered in the body's own order,
		// which is the order the runner tries them in, so a body that writes
		// its smallest first is shrunk to it first.
		test("answers what the conformance's own shrink answers, in order", () => {
			let asked: Array<string> = []
			let generator: Generator = {
				kind: "generated",
				name: "Team",
				generate: () => createString("Lions"),
				shrink: (value) => {
					asked.push(textOf(value))

					return createList([
						createString("Li"),
						createString("Lion"),
					])
				},
			}

			expect(
				shrink(generator, createString("Lions")).map(textOf),
			).toEqual(["Li", "Lion"])
			expect(asked).toEqual(["Lions"])
		})

		// NOTE: A body answering the value it was handed is answering that it
		// can go no smaller. Trying it would re-run the property on the value
		// the shrink already has, once for every attempt the budget allows.
		test("drops a candidate that is the failing value itself", () => {
			let generator: Generator = {
				kind: "generated",
				name: "Team",
				generate: () => createString("Lions"),
				shrink: (value) =>
					createList([value, createString("Li"), value]),
			}

			expect(
				shrink(generator, createString("Lions")).map(textOf),
			).toEqual(["Li"])
		})

		// NOTE: A refinement of a Type a Namespace generates is the one place
		// the two kinds of shrink meet: the conformance says what the smaller
		// values are, and the predicate says which of them the refined Type
		// admits at all.
		test("holds a conformance's candidates to the refinement over it", () => {
			let generator = refined(
				"LongName",
				{
					kind: "generated",
					name: "Team",
					generate: () => createString("Lions"),
					shrink: () =>
						createList([createString("Li"), createString("Lion")]),
				},
				{},
				[(value) => ({ value: textOf(value).length > 2 })],
			)

			expect(
				shrink(generator, createString("Lions")).map(textOf),
			).toEqual(["Lion"])
		})
	})

	describe("what a Dictionary shrinks to", () => {
		const ages: Generator = {
			kind: "dictionary",
			key: strings,
			value: integers,
		}

		function named(value: AnyType): Array<string> {
			return entriesOf(value).map(([key]) => textOf(key))
		}

		test("drops entries and shrinks the values it keeps", () => {
			let value = dictionaryOf([
				[createString("alex"), createInteger(39n)],
				[createString("sam"), createInteger(25n)],
			])
			let candidates = shrink(ages, value)

			expect(
				candidates.some((candidate) => named(candidate).length === 0),
			).toBe(true)
			expect(
				candidates.some((candidate) => named(candidate).length === 1),
			).toBe(true)
			expect(
				candidates.some((candidate) =>
					entriesOf(candidate).some(
						([, held]) => wholeOf(held) === 0n,
					),
				),
			).toBe(true)
		})

		// NOTE: THE claim a shrunk Dictionary rests on. Two keys shrinking
		// towards one key would collapse into a single entry, so a candidate
		// would be a Dictionary of another LENGTH than the shrink meant to
		// answer — a report about a value the property never saw.
		test("never rewrites a key", () => {
			let value = dictionaryOf([
				[createString("alex"), createInteger(39n)],
				[createString("sam"), createInteger(25n)],
			])

			for (let candidate of shrink(ages, value)) {
				for (let key of named(candidate)) {
					expect(["alex", "sam"]).toContain(key)
				}
			}
		})

		test("answers nothing for a Dictionary already empty", () => {
			expect(shrink(ages, dictionaryOf([]))).toEqual([])
		})
	})

	// NOTE: WHICH KEYS ARE ONE KEY is not a question a generator can answer out
	// of the shape it was told to draw: a Namespace may write an `is` for the
	// key Type, and two keys it calls equal are one entry however they are
	// spelled. So the plan carries the key Type's own Equatable witness, and
	// everything here that builds a Dictionary builds through it.
	describe("the witness a drawn Dictionary is built by", () => {
		// NOTE: A key generator that answers the two spellings of one name in
		// turn, and a witness that calls them equal — the shape a user
		// Namespace `for NonEmptyString is Equatable` leaves behind. It counts
		// rather than draws so that the two spellings are what a draw of two
		// keys meets, whatever the source answers.
		let spelling = 0

		const spellings: Generator = {
			kind: "generated",
			name: "Name",
			generate: () => createString(spelling++ % 2 === 0 ? "Ada" : "ada"),
			shrink: noCandidates,
		}

		const looseText = {
			is: (first: AnyType, second: AnyType) =>
				createBoolean(
					textOf(first).toLowerCase() ===
						textOf(second).toLowerCase(),
				),
		}

		test("two keys the witness calls equal are one entry", () => {
			spelling = 0

			let withWitness = generate(
				{
					kind: "dictionary",
					key: spellings,
					value: integers,
					keyConformance: looseText,
				},
				sourceOf(),
				8,
				{ minimumLength: 2, maximumLength: 2 },
			)

			expect(entriesOf(withWitness).length).toBe(1)

			spelling = 0

			let withoutWitness = generate(
				{ kind: "dictionary", key: spellings, value: integers },
				sourceOf(),
				8,
				{ minimumLength: 2, maximumLength: 2 },
			)

			expect(entriesOf(withoutWitness).length).toBe(2)
		})

		test("a shrunk and a moved Dictionary are built through it too", () => {
			let generator: Generator = {
				kind: "dictionary",
				key: strings,
				value: integers,
				keyConformance: looseText,
			}
			let value = createDictionary(
				[
					[createString("Ada"), createInteger(1n)],
					[createString("Bob"), createInteger(2n)],
				],
				looseText,
			) as AnyType

			for (let candidate of shrink(generator, value)) {
				expect(
					entriesOf(candidate).map(([key]) =>
						textOf(key).toLowerCase(),
					),
				).toEqual([
					...new Set(
						entriesOf(candidate).map(([key]) =>
							textOf(key).toLowerCase(),
						),
					),
				])
			}

			let moved = mutate(generator, value, sourceOf(), 8)

			expect(entriesOf(moved).length).toBeGreaterThan(0)
		})
	})

	describe("the smallest value a generator can build", () => {
		test("answers zero, the empty String and the empty List", () => {
			expect(minimal(integers)).toEqual(createInteger(0n))
			expect(minimal(strings)).toEqual(createString(""))
			expect(itemsOf(minimal({ kind: "list", item: integers })!)).toEqual(
				[],
			)
		})

		// NOTE: An empty Dictionary needs no key at all, which is why the
		// smallest one can always be built while the smallest NON-empty one
		// needs both slots to have a smallest value of their own.
		test("answers the empty Dictionary", () => {
			expect(
				entriesOf(
					minimal({
						kind: "dictionary",
						key: strings,
						value: integers,
					})!,
				),
			).toEqual([])
		})

		// NOTE: A length above one is a length in DISTINCT keys, which is what
		// a `NonEmptyDictionary` of more than one entry asks for. The smallest
		// key is one of them and the rest are drawn, because "smaller" is an
		// ordering the language owns for numbers and not for keys.
		test("answers as many distinct keys as a minimum length asks for", () => {
			for (let length of [1, 2, 5]) {
				let smallest = minimal(
					{ kind: "dictionary", key: strings, value: integers },
					{ minimumLength: length },
				)

				expect(smallest).not.toBeNull()

				let entries = entriesOf(smallest!)

				expect(entries.length).toBe(length)
				expect(new Set(entries.map(([key]) => textOf(key))).size).toBe(
					length,
				)
				expect(entries.every(([, held]) => wholeOf(held) === 0n)).toBe(
					true,
				)
			}
		})

		// NOTE: And where the key Type has too few values to make that many, it
		// answers nothing rather than a Dictionary shorter than it promised. A
		// Boolean has two.
		test("answers nothing where the key Type has too few values", () => {
			expect(
				minimal(
					{ kind: "dictionary", key: booleans, value: integers },
					{ minimumLength: 2 },
				),
			).not.toBeNull()
			expect(
				minimal(
					{ kind: "dictionary", key: booleans, value: integers },
					{ minimumLength: 3 },
				),
			).toBeNull()
		})

		test("answers the shortest value a narrowing admits", () => {
			expect(
				minimal(refined("Small", integers, { atLeast: "3" })),
			).toEqual(createInteger(3n))
			expect(
				itemsOf(
					minimal(
						refined(
							"NonEmptyList",
							{ kind: "list", item: integers },
							{ minimumLength: 1 },
						),
					)!,
				),
			).toEqual([createInteger(0n)])
		})

		test("steps past an excluded value", () => {
			expect(
				minimal(refined("NonZero", integers, { notEqualTo: ["0"] })),
			).toEqual(createInteger(1n))
		})

		test("answers the simplest arm of a Union", () => {
			let generator: Generator = {
				kind: "union",
				members: [
					{
						kind: "case",
						tag: "Optional#Value",
						members: [{ name: "item", generator: integers }],
					},
					{ kind: "case", tag: "Optional#Empty", members: [] },
				],
			}

			expect(tagOf(minimal(generator)!)).toBe("Optional#Empty")
		})

		test("answers nothing where a check refuses the smallest value", () => {
			expect(
				minimal(
					refined("Impossible", integers, {}, [
						() => ({ value: false }),
					]),
				),
			).toBeNull()
		})
	})

	// NOTE: What the coverage-guided search moves with. A neighbour is ONE step
	// from a value rather than a fresh case, so what is asserted below is
	// STRUCTURAL — which part moved and which parts did not — and every count is
	// over a pinned seed, so the sequence is the same on every machine.
	describe("what a neighbour of a value is", () => {
		function neighbours(
			generator: Generator,
			value: AnyType,
			count: number,
			options: {
				seed?: string
				size?: number
				narrowing?: Narrowing
			} = {},
		): Array<AnyType> {
			let source = sourceOf(options.seed)
			let moved: Array<AnyType> = []

			for (let index = 0; index < count; index++) {
				moved.push(
					mutate(
						generator,
						value,
						source,
						options.size ?? 12,
						options.narrowing,
					),
				)
			}

			return moved
		}

		test("answers the other Boolean", () => {
			expect(
				mutate(booleans, createBoolean(true), sourceOf(), 4),
			).toEqual(createBoolean(false))
			expect(
				mutate(booleans, createBoolean(false), sourceOf(), 4),
			).toEqual(createBoolean(true))
		})

		// NOTE: A leaf is redrawn rather than nudged — see the NOTE on
		// `mutate`. What is asserted is that the redraw HAPPENS and stays a
		// value of the Type, not which number came out.
		test("redraws an Integer, a Rational and a String", () => {
			let whole = neighbours(integers, createInteger(0n), 40)
			let text = neighbours(strings, createString(""), 40)
			let ratio = neighbours(rationals, createRational(0n, 1n), 40)

			expect(whole.every((value) => tagOf(value) === "Integer")).toBe(
				true,
			)
			expect(whole.some((value) => wholeOf(value) !== 0n)).toBe(true)
			expect(text.every((value) => tagOf(value) === "String")).toBe(true)
			expect(text.some((value) => textOf(value) !== "")).toBe(true)
			expect(ratio.every((value) => tagOf(value) === "Rational")).toBe(
				true,
			)
		})

		// NOTE: The three moves a List has, and the bounds a narrowing puts on
		// which of them are available at all.
		test("moves a List's length by one, and never past a bound", () => {
			let generator: Generator = { kind: "list", item: integers }
			let value = createList([
				createInteger(1n),
				createInteger(2n),
				createInteger(3n),
			])
			let lengths = neighbours(generator, value, 60).map(
				(moved) => itemsOf(moved).length,
			)

			expect(lengths.every((length) => Math.abs(length - 3) <= 1)).toBe(
				true,
			)
			expect(lengths).toContain(2)
			expect(lengths).toContain(3)
			expect(lengths).toContain(4)
		})

		test("keeps a List inside the lengths a narrowing admits", () => {
			let generator: Generator = { kind: "list", item: integers }
			let value = createList([createInteger(1n), createInteger(2n)])
			let lengths = neighbours(generator, value, 60, {
				narrowing: { minimumLength: 2, maximumLength: 3 },
			}).map((moved) => itemsOf(moved).length)

			expect(lengths.every((length) => length >= 2 && length <= 3)).toBe(
				true,
			)
			expect(lengths).toContain(3)
		})

		// NOTE: A narrowing that admits exactly one length leaves an empty List
		// with no neighbour at all, and the function still has to answer.
		test("answers the value itself where no move is available", () => {
			let generator: Generator = { kind: "list", item: integers }
			let moved = mutate(generator, createList([]), sourceOf(), 4, {
				minimumLength: 0,
				maximumLength: 0,
			})

			expect(itemsOf(moved)).toEqual([])
		})

		// NOTE: THE property a Record's neighbour rests on: everything the case
		// already reached is kept, one member excepted. The members that did not
		// move are the very objects the value held — values are immutable, so
		// sharing them is what "did not move" MEANS.
		test("moves exactly one member of a Record", () => {
			let generator: Generator = {
				kind: "record",
				members: [
					{ name: "name", generator: strings },
					{ name: "count", generator: integers },
					{ name: "ready", generator: booleans },
				],
			}
			let value = createRecord({
				name: createString("a"),
				count: createInteger(1n),
				ready: createBoolean(false),
			}) as unknown as Record<string, AnyType>
			let names = ["name", "count", "ready"]
			let untouched = new Set<string>()

			for (let moved of neighbours(generator, value as AnyType, 60)) {
				let holder = moved as unknown as Record<string, AnyType>
				let kept = names.filter((name) => holder[name] === value[name])

				expect(kept.length).toBeGreaterThanOrEqual(names.length - 1)

				for (let name of kept) {
					untouched.add(name)
				}
			}

			// NOTE: Every member is the moved one sometimes, so the choice is a
			// choice rather than a fixed member the search never leaves.
			expect(untouched).toEqual(new Set(names))
		})

		test("moves one member of a Case and keeps its tag", () => {
			let generator: Generator = {
				kind: "case",
				tag: "Shade#Dark",
				members: [
					{ name: "level", generator: integers },
					{ name: "warm", generator: booleans },
				],
			}
			let value = createCase("Shade#Dark", {
				level: createInteger(1n),
				warm: createBoolean(false),
			}) as unknown as Record<string, AnyType>

			for (let moved of neighbours(generator, value as AnyType, 40)) {
				let holder = moved as unknown as Record<string, AnyType>

				expect(tagOf(moved)).toBe("Shade#Dark")
				expect(
					(holder["level"] === value["level"] ? 1 : 0) +
						(holder["warm"] === value["warm"] ? 1 : 0),
				).toBeGreaterThanOrEqual(1)
			}
		})

		// NOTE: A step that ADDS has to draw a key the Dictionary does not
		// already hold. A key it holds is an overwrite, which leaves the length
		// where it was — so the move would have been the redraw move under
		// another name, and the search would grow a Dictionary half as often as
		// it means to. A Boolean key has two values, so a one-entry Dictionary
		// collides on every second draw; over ninety neighbours at this seed
		// twenty-three grow, where taking the first draw whatever it was grew
		// eleven and turned the other twenty into a second way of redrawing a
		// value.
		test("a step that adds an entry draws a key the Dictionary lacks", () => {
			let generator: Generator = {
				kind: "dictionary",
				key: booleans,
				value: integers,
			}
			let value = dictionaryOf([[createBoolean(true), createInteger(1n)]])
			let lengths = neighbours(generator, value, 90).map(
				(moved) => entriesOf(moved).length,
			)

			expect(
				lengths.filter((length) => length === 2).length,
			).toBeGreaterThan(18)
			expect(
				lengths.filter((length) => length === 0).length,
			).toBeGreaterThan(0)
			expect(
				lengths.filter((length) => length === 1).length,
			).toBeGreaterThan(0)
		})

		// NOTE: And where the key Type has no value left to draw, the step
		// falls back to a move that is available rather than answering the
		// value it was handed. Both Booleans are held here and the length is
		// pinned from below, so every neighbour is a redrawn value under a key
		// that was already there.
		test("a step falls back where every key its Type has is held", () => {
			let generator: Generator = {
				kind: "dictionary",
				key: booleans,
				value: integers,
			}
			let value = dictionaryOf([
				[createBoolean(true), createInteger(1n)],
				[createBoolean(false), createInteger(2n)],
			])
			let moved = neighbours(generator, value, 90, {
				narrowing: { minimumLength: 2, maximumLength: 3 },
			})

			expect(
				moved.every((each) => entriesOf(each).length === 2),
			).toBeTrue()
			expect(
				moved.some((each) =>
					entriesOf(each).some(([, held]) => wholeOf(held) !== 1n),
				),
			).toBeTrue()
		})

		// NOTE: A payload-free Case is the only value of its own shape, so its
		// neighbour is itself — built afresh rather than handed back.
		test("answers a payload-free Case with its own tag", () => {
			let generator: Generator = {
				kind: "case",
				tag: "Ordering#Equal",
				members: [],
			}

			expect(
				mutate(
					generator,
					createCase("Ordering#Equal") as unknown as AnyType,
					sourceOf(),
					4,
				),
			).toEqual(createCase("Ordering#Equal") as unknown as AnyType)
		})

		// NOTE: One time in four, which at this seed is what the counts below
		// say. A neighbour that never left its arm would leave the search unable
		// to cross a Union at all; one that left it half the time would not be a
		// neighbour.
		test("usually stays in the arm the value inhabits", () => {
			let generator: Generator = {
				kind: "union",
				members: [
					{
						kind: "case",
						tag: "Optional#Value",
						members: [{ name: "item", generator: integers }],
					},
					{ kind: "case", tag: "Optional#Empty", members: [] },
				],
			}
			let value = createCase("Optional#Value", {
				item: createInteger(1n),
			}) as unknown as AnyType
			let tags = neighbours(generator, value, 200).map(tagOf)
			let crossed = tags.filter((tag) => tag === "Optional#Empty").length

			expect(crossed).toBeGreaterThan(0)
			expect(crossed).toBeLessThan(tags.length / 2)
		})

		// NOTE: The claims question, sharpened: the runtime key alone reads
		// every Record as the FIRST Record arm, and a neighbour rebuilt under
		// the wrong arm drops the very members the kept case held. The member
		// names are what tell two Record arms apart.
		test("holds a value inside its own Record arm of a Union", () => {
			let generator: Generator = {
				kind: "union",
				members: [
					{
						kind: "record",
						members: [{ name: "name", generator: strings }],
					},
					{
						kind: "record",
						members: [{ name: "count", generator: integers }],
					},
				],
			}
			let value = createRecord({
				count: createInteger(5n),
			}) as unknown as AnyType
			let kept = neighbours(generator, value, 60).filter((moved) =>
				Object.keys(moved as unknown as object).includes("count"),
			)

			// NOTE: Most neighbours stay in the value's own arm — the cross-arm
			// coin is one in four — and every one that stayed still holds the
			// arm's own member rather than the first arm's.
			expect(kept.length).toBeGreaterThan(30)
		})

		// NOTE: Two refinements of one base share a key too, and there the
		// predicate is what claims — a positive Integer mutated under the
		// negative arm's generator would answer values the kept case's arm
		// refuses.
		test("tells two refined arms of one base apart by their predicates", () => {
			let positive: Generator = {
				kind: "refined",
				name: "Positive",
				base: integers,
				checks: [
					(value) => ({
						value: wholeOf(value) > 0n,
					}),
				],
				narrowing: { atLeast: "1" },
			}
			let negative: Generator = {
				kind: "refined",
				name: "Negative",
				base: integers,
				checks: [
					(value) => ({
						value: wholeOf(value) < 0n,
					}),
				],
				narrowing: { atMost: "-1" },
			}
			let generator: Generator = {
				kind: "union",
				members: [positive, negative],
			}
			let moved = neighbours(generator, createInteger(-7n), 60).map(
				wholeOf,
			)

			// NOTE: The cross-arm coin still crosses — what may never happen is
			// a "stay" that lands in the other arm because the first one
			// claimed a value its own predicate refuses.
			expect(moved.filter((value) => value < 0n).length).toBeGreaterThan(
				30,
			)
		})

		// NOTE: A value no arm claims is a value the Union never built, and a
		// draw is the only honest answer to it.
		test("draws afresh for a value no arm of a Union claims", () => {
			let generator: Generator = {
				kind: "union",
				members: [
					{ kind: "case", tag: "Shade#Light", members: [] },
					{ kind: "case", tag: "Shade#Dark", members: [] },
				],
			}
			let tags = new Set(
				neighbours(generator, createInteger(1n), 40).map(tagOf),
			)

			expect(tags).toEqual(new Set(["Shade#Light", "Shade#Dark"]))
		})

		// NOTE: THE law a refinement's neighbour rests on: the answer is always
		// one the refinement ADMITS, whether the mutation found it or the fresh
		// draw behind it did. The checks are run again here rather than trusted.
		test("answers only what a refinement admits", () => {
			let generator = refined("EvenInteger", integers, {}, [
				(value) => ({ value: wholeOf(value) % 2n === 0n }),
			])

			for (let moved of neighbours(generator, createInteger(0n), 200)) {
				expect(wholeOf(moved) % 2n).toBe(0n)
			}
		})

		test("keeps every bound a refinement's narrowing states", () => {
			let generator = refined(
				"NonEmptyList",
				{ kind: "list", item: integers },
				{ minimumLength: 1, maximumLength: 3 },
			)
			let value = createList([createInteger(1n), createInteger(2n)])

			for (let moved of neighbours(generator, value, 100)) {
				expect(itemsOf(moved).length).toBeGreaterThanOrEqual(1)
				expect(itemsOf(moved).length).toBeLessThanOrEqual(3)
			}
		})

		// NOTE: A refinement no neighbour of this value satisfies. The draw
		// behind the attempts is what still answers an admitted value, and it
		// raises the run's own failure where nothing satisfies the predicate at
		// all — the same answer `generate` gives.
		test("refuses a predicate nothing satisfies rather than answering", () => {
			let generator = refined("Impossible", integers, {}, [
				() => ({ value: false }),
			])

			expect(() =>
				mutate(generator, createInteger(0n), sourceOf(), 4),
			).toThrow(GenerationFailure)
		})

		// NOTE: A Namespace's own generator says how to BUILD a value and
		// nothing about what one is made of, so a neighbour of one is another
		// value it built.
		test("asks a Namespace's own generator afresh", () => {
			let asked = 0
			let generator: Generator = {
				kind: "generated",
				name: "Team",
				generate: () => {
					asked += 1

					return createString("Lions")
				},
				shrink: noCandidates,
			}

			expect(
				neighbours(generator, createString("Bears"), 3).map(textOf),
			).toEqual(["Lions", "Lions", "Lions"])
			expect(asked).toBe(3)
		})

		// NOTE: Everything above draws from the source and from nothing else,
		// which is what makes the whole guided search replay under one seed.
		test("answers the same sequence for the same seed", () => {
			let generator: Generator = {
				kind: "record",
				members: [
					{ name: "name", generator: strings },
					{ name: "count", generator: integers },
				],
			}
			let value = createRecord({
				name: createString("a"),
				count: createInteger(1n),
			})
			let first = neighbours(generator, value, 20, { seed: "one" })
			let again = neighbours(generator, value, 20, { seed: "one" })
			let other = neighbours(generator, value, 20, { seed: "two" })

			expect(first).toEqual(again)
			expect(first).not.toEqual(other)
		})
	})

	// NOTE: THE law every stored counterexample rests on — what is written down
	// reads back as the very value that was written. A kind that round-trips for
	// nothing is a corpus entry that quietly stops replaying, so every kind but
	// a Namespace's own is asked here.
	describe("what a value written down reads back as", () => {
		const optionals: Generator = {
			kind: "union",
			members: [
				{
					kind: "case",
					tag: "Optional#Value",
					members: [{ name: "item", generator: integers }],
				},
				{ kind: "case", tag: "Optional#Empty", members: [] },
			],
		}
		const standings: Generator = {
			kind: "record",
			members: [
				{ name: "team", generator: strings },
				{ name: "form", generator: { kind: "list", item: booleans } },
				{
					name: "best",
					generator: {
						kind: "record",
						members: [{ name: "goals", generator: integers }],
					},
				},
			],
		}
		const evens = refined("EvenInteger", integers, { atLeast: "0" }, [
			(value) => ({ value: wholeOf(value) % 2n === 0n }),
		])

		const written: Array<[string, Generator, AnyType]> = [
			["true", booleans, createBoolean(true)],
			["false", booleans, createBoolean(false)],
			["zero", integers, createInteger(0n)],
			["a negative Integer", integers, createInteger(-19n)],
			[
				"an Integer no double holds",
				integers,
				createInteger(9_007_199_254_740_993n),
			],
			[
				"an Integer of eighty digits",
				integers,
				createInteger(10n ** 80n + 7n),
			],
			["a negative Rational", rationals, createRational(-7n, 4n)],
			["a whole Rational", rationals, createRational(6n, 1n)],
			["the empty String", strings, createString("")],
			["a String past the basic plane", strings, createString("é🐈")],
			[
				"the empty List",
				{ kind: "list", item: integers },
				createList([]),
			],
			[
				"a List of Lists",
				{ kind: "list", item: { kind: "list", item: integers } },
				createList([createList([createInteger(1n)]), createList([])]),
			],
			[
				"a nested Record",
				standings,
				createRecord({
					team: createString("Lions"),
					form: createList([
						createBoolean(true),
						createBoolean(false),
					]),
					best: createRecord({ goals: createInteger(3n) }),
				}),
			],
			[
				"a Case carrying a payload",
				optionals,
				createCase("Optional#Value", {
					item: createInteger(7n),
				}) as unknown as AnyType,
			],
			[
				"a Case carrying none",
				optionals,
				createCase("Optional#Empty") as unknown as AnyType,
			],
			[
				"the empty Dictionary",
				{ kind: "dictionary", key: strings, value: integers },
				dictionaryOf([]),
			],
			[
				"a Dictionary of several entries",
				{ kind: "dictionary", key: strings, value: integers },
				dictionaryOf([
					[createString("alex"), createInteger(39n)],
					[createString("sam"), createInteger(25n)],
				]),
			],
			["a refined Integer", evens, createInteger(12n)],
			[
				"a refined List",
				refined(
					"NonEmptyList",
					{ kind: "list", item: strings },
					{ minimumLength: 1 },
				),
				createList([createString("only")]),
			],
		]

		for (let [what, generator, value] of written) {
			// NOTE: Through JSON rather than straight back, because a corpus is
			// a file: a value that only survives while it stays an object
			// survives nothing at all.
			test(`reads ${what} back as the very value`, () => {
				let data = encode(generator, value)

				expect(data).toBeTruthy()

				let read = decode(
					generator,
					JSON.parse(JSON.stringify(data)) as EncodedValue,
				)

				expect(read).toBeTruthy()
				expect(anyIs(read!, value)).toBe(true)
			})
		}

		test("writes the same data down every time", () => {
			let value = createRecord({
				team: createString("Lions"),
				form: createList([createBoolean(true)]),
				best: createRecord({ goals: createInteger(3n) }),
			})

			expect(JSON.stringify(encode(standings, value))).toBe(
				JSON.stringify(encode(standings, value)),
			)
		})

		test("names the arm of the Union a value belongs to", () => {
			expect(
				encode(
					optionals,
					createCase("Optional#Empty") as unknown as AnyType,
				),
			).toEqual({
				kind: "union",
				member: 1,
				value: { kind: "case", tag: "Optional#Empty", members: {} },
			})
		})
	})

	describe("what a stored value is refused over", () => {
		test("writes nothing down for a Namespace's own generator", () => {
			let generator: Generator = {
				kind: "generated",
				name: "Team",
				generate: () => createString("Lions"),
				shrink: noCandidates,
			}

			expect(encode(generator, createString("Lions"))).toBeNull()
			expect(
				decode(generator, { kind: "string", value: "Lions" }),
			).toBeNull()
		})

		// NOTE: One Parameter is enough to cost the whole test its corpus, so a
		// generator holding one anywhere inside it has to say so from the top.
		test("writes nothing down where one is nested inside a Record", () => {
			let generator: Generator = {
				kind: "record",
				members: [
					{ name: "name", generator: strings },
					{
						name: "team",
						generator: {
							kind: "generated",
							name: "Team",
							generate: () => createString("Lions"),
							shrink: noCandidates,
						},
					},
				],
			}

			expect(
				encode(
					generator,
					createRecord({
						name: createString("Rae"),
						team: createString("Lions"),
					}),
				),
			).toBeNull()
		})

		test("writes nothing down for a value of another shape", () => {
			expect(encode(integers, createString("12"))).toBeNull()
			expect(encode(strings, createInteger(12n))).toBeNull()
		})

		test("refuses data of another kind", () => {
			expect(decode(integers, { kind: "string", value: "12" })).toBeNull()
			expect(decode(strings, { kind: "integer", value: "12" })).toBeNull()
			expect(
				decode({ kind: "list", item: integers }, {
					kind: "list",
					items: "nothing",
				} as unknown as EncodedValue),
			).toBeNull()
		})

		test("refuses digits that spell no Integer", () => {
			expect(decode(integers, { kind: "integer", value: "" })).toBeNull()
			expect(
				decode(integers, { kind: "integer", value: " 12 " }),
			).toBeNull()
			expect(
				decode(integers, { kind: "integer", value: "twelve" }),
			).toBeNull()
			expect(decode(integers, { kind: "integer", value: "-12" })).toEqual(
				createInteger(-12n),
			)
		})

		test("refuses a Rational over nothing", () => {
			expect(
				decode(rationals, {
					kind: "rational",
					numerator: "1",
					denominator: "0",
				}),
			).toBeNull()
		})

		test("refuses a member set the Record no longer has", () => {
			let generator: Generator = {
				kind: "record",
				members: [
					{ name: "team", generator: strings },
					{ name: "points", generator: integers },
				],
			}
			let team: EncodedValue = { kind: "string", value: "Lions" }
			let points: EncodedValue = { kind: "integer", value: "19" }

			expect(
				decode(generator, { kind: "record", members: { team } }),
			).toBeNull()
			expect(
				decode(generator, {
					kind: "record",
					members: { team, points, goals: points },
				}),
			).toBeNull()
			expect(
				decode(generator, {
					kind: "record",
					members: { team, scored: points },
				}),
			).toBeNull()
			expect(
				decode(generator, {
					kind: "record",
					members: { team, points },
				}),
			).not.toBeNull()
		})

		test("refuses a tag the Case no longer carries", () => {
			let generator: Generator = {
				kind: "case",
				tag: "Optional#Empty",
				members: [],
			}

			expect(
				decode(generator, {
					kind: "case",
					tag: "Optional#Nothing",
					members: {},
				}),
			).toBeNull()
		})

		test("refuses an arm the Union no longer has", () => {
			let generator: Generator = {
				kind: "union",
				members: [{ kind: "case", tag: "Shade#Light", members: [] }],
			}

			expect(
				decode(generator, {
					kind: "union",
					member: 1,
					value: { kind: "case", tag: "Shade#Dark", members: {} },
				}),
			).toBeNull()
		})

		// NOTE: A refinement that has NARROWED since a counterexample was stored
		// no longer admits it, and a value the Type says is impossible is not a
		// counterexample — it is an entry to drop.
		test("refuses a value the narrowing no longer admits", () => {
			let generator = refined("BigEnough", integers, { atLeast: "10" })
			let small: EncodedValue = {
				kind: "refined",
				value: { kind: "integer", value: "4" },
			}
			let big: EncodedValue = {
				kind: "refined",
				value: { kind: "integer", value: "11" },
			}

			expect(decode(generator, small)).toBeNull()
			expect(decode(generator, big)).toEqual(createInteger(11n))
		})

		test("refuses a value a check no longer admits", () => {
			let generator = refined("EvenInteger", integers, {}, [
				(value) => ({ value: wholeOf(value) % 2n === 0n }),
			])

			expect(
				decode(generator, {
					kind: "refined",
					value: { kind: "integer", value: "7" },
				}),
			).toBeNull()
			expect(
				decode(generator, {
					kind: "refined",
					value: { kind: "integer", value: "8" },
				}),
			).toEqual(createInteger(8n))
		})

		test("refuses anything that is not data at all", () => {
			expect(decode(integers, null as unknown as EncodedValue)).toBeNull()
			expect(decode(integers, "12" as unknown as EncodedValue)).toBeNull()
		})
	})
})
