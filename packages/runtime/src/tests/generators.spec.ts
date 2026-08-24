import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import {
	decode,
	encode,
	type EncodedValue,
	generate,
	GenerationFailure,
	type Generator,
	minimal,
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
import { type AnyType, createCase, typeKeySymbol } from "../type"

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
		// what meets an assumption a small number never breaks.
		test("draws an Integer past what a small window holds", () => {
			let drawn = draw(integers, 200).map(wholeOf)

			expect(drawn.some((value) => value > 1_000_000n)).toBe(true)
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

		test("asks a Namespace's own generator and nothing else", () => {
			let asked: Array<RandomnessType> = []
			let generator: Generator = {
				kind: "generated",
				name: "Team",
				generate: (source) => {
					asked.push(source)

					return createString("Lions")
				},
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

		// NOTE: A Namespace that declares its own generator declares that the
		// structure is nobody else's business — including a shrink's.
		test("answers no candidate for a Namespace's own generator", () => {
			let generator: Generator = {
				kind: "generated",
				name: "Team",
				generate: () => createString("Lions"),
			}

			expect(shrink(generator, createString("Lions"))).toEqual([])
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
