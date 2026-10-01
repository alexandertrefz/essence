import { describe, expect, test } from "bun:test"

import { createInteger, type IntegerType } from "../Integer"
import {
	createList,
	type ListType,
	materialise,
	prepend__overload$1 as prepend,
} from "../List"
import {
	below,
	bigBetween,
	createRandomness,
	drawBoolean__overload$1,
	drawBoolean__overload$2,
	drawInteger__overload$1,
	drawInteger__overload$2,
	drawRational__overload$1,
	drawRational__overload$2,
	drawString,
	entropy,
	fraction,
	nextWord,
	pick__overload$1,
	pick__overload$2,
	pick__overload$3,
	type RandomnessType,
	seeded,
	seedOf,
	shuffle__overload$1,
} from "../Randomness"
import { createRational, type RationalType } from "../Rational"
import { createString, type StringType } from "../String"
import { typeKeySymbol } from "../type"

// `stdlibGolden.spec.ts` can not record random answers, so the natives are
// driven here over fixed seeds. Each answer is held to its range and its
// exactness, and one seed answers one sequence.

function sourceOf(seed = "beef"): RandomnessType {
	return createRandomness(seedOf(seed))
}

const TEAMS = ["Lions", "Tigers", "Bears", "Wolves"]

function teamsOf(): ListType<StringType> {
	return createList(TEAMS.map((team) => createString(team)))
}

describe("Randomness", () => {
	// A bound wider than a word has no whole multiple inside one, so the
	// rejection loop would reject every draw.
	test("answers a bound wider than a word rather than looping", () => {
		let source = sourceOf()
		let bound = 4294967296 * 4

		for (let index = 0; index < 20; index++) {
			let drawn = below(source, bound)

			expect(drawn).toBeGreaterThanOrEqual(0)
			expect(drawn).toBeLessThan(bound)
		}
	})

	test("answers the same sequence for one seed", () => {
		let first = Array.from({ length: 64 }, () => below(sourceOf(), 1000))
		let second = Array.from({ length: 64 }, () => below(sourceOf(), 1000))

		expect(first).toEqual(second)

		let one = sourceOf()
		let other = sourceOf()

		expect(Array.from({ length: 64 }, () => below(one, 1000))).toEqual(
			Array.from({ length: 64 }, () => below(other, 1000)),
		)
	})

	test("answers a different sequence for a different seed", () => {
		let one = sourceOf("beef")
		let other = sourceOf("cafe")

		let drawn = Array.from({ length: 32 }, () => below(one, 1_000_000))
		let others = Array.from({ length: 32 }, () => below(other, 1_000_000))

		expect(drawn).not.toEqual(others)
	})

	test("advances the source with every answer", () => {
		let source = sourceOf()
		let first = drawBoolean__overload$1(source)
		let drawn = [first]

		for (let index = 0; index < 32; index++) {
			drawn.push(drawBoolean__overload$1(source))
		}

		// Two reads of one source answer two values.
		expect(drawn.some((value) => value.value !== first.value)).toBe(true)
	})

	test("carries the Randomness tag", () => {
		expect(sourceOf()[typeKeySymbol]).toBe("Randomness")
	})

	describe("seeded", () => {
		test("answers the same sequence for the same text", () => {
			let one = seeded(createString("beef"))
			let other = seeded(createString("beef"))

			expect(Array.from({ length: 64 }, () => below(one, 1000))).toEqual(
				Array.from({ length: 64 }, () => below(other, 1000)),
			)
		})

		test("answers a different sequence for different text", () => {
			let one = seeded(createString("beef"))
			let other = seeded(createString("cafe"))

			expect(
				Array.from({ length: 32 }, () => below(one, 1_000_000)),
			).not.toEqual(
				Array.from({ length: 32 }, () => below(other, 1_000_000)),
			)
		})

		// The test runtime builds a run's source through `seedOf`, so a Program
		// replaying a seed draws as `--seed` does.
		test("answers what the seeded door answers", () => {
			let named = seeded(createString("41c37ea3"))
			let built = createRandomness(seedOf("41c37ea3"))

			expect(
				Array.from({ length: 32 }, () => below(named, 1000)),
			).toEqual(Array.from({ length: 32 }, () => below(built, 1000)))
		})

		test("takes any text at all as a seed", () => {
			expect(seeded(createString(""))[typeKeySymbol]).toBe("Randomness")
			expect(seeded(createString("👋 a seed"))[typeKeySymbol]).toBe(
				"Randomness",
			)
		})
	})

	describe("drawBoolean", () => {
		test("answers each of the two about half the time", () => {
			let source = sourceOf()
			let trues = 0

			for (let index = 0; index < 4000; index++) {
				if (drawBoolean__overload$1(source).value) {
					trues += 1
				}
			}

			expect(trues).toBeGreaterThan(1800)
			expect(trues).toBeLessThan(2200)
		})

		test("answers false for a chance of zero and true for a chance of one", () => {
			let source = sourceOf()

			for (let index = 0; index < 200; index++) {
				expect(
					drawBoolean__overload$2(source, createRational(0n, 1n))
						.value,
				).toBe(false)
				expect(
					drawBoolean__overload$2(source, createRational(1n, 1n))
						.value,
				).toBe(true)
			}
		})

		// The entry answers no Optional, so clamping is all it can do.
		test("clamps a chance outside the unit range", () => {
			let source = sourceOf()

			expect(
				drawBoolean__overload$2(source, createRational(-3n, 2n)).value,
			).toBe(false)
			expect(
				drawBoolean__overload$2(source, createRational(5n, 2n)).value,
			).toBe(true)
		})

		// Drawn over the chance's own denominator, so a third is a third of the
		// draws rather than a rounded third of a word.
		test("answers true as often as the chance says", () => {
			let source = sourceOf()
			let trues = 0

			for (let index = 0; index < 6000; index++) {
				if (
					drawBoolean__overload$2(source, createRational(1n, 3n))
						.value
				) {
					trues += 1
				}
			}

			expect(trues).toBeGreaterThan(1850)
			expect(trues).toBeLessThan(2150)
		})

		test("reads an unreduced chance as the point it names", () => {
			let source = sourceOf()
			let trues = 0

			for (let index = 0; index < 2000; index++) {
				if (
					drawBoolean__overload$2(source, createRational(500n, 1000n))
						.value
				) {
					trues += 1
				}
			}

			expect(trues).toBeGreaterThan(900)
			expect(trues).toBeLessThan(1100)
		})
	})

	describe("below", () => {
		test("stays inside the bound", () => {
			let source = sourceOf()

			for (let index = 0; index < 2000; index++) {
				let drawn = below(source, 7)

				expect(drawn).toBeGreaterThanOrEqual(0)
				expect(drawn).toBeLessThan(7)
			}
		})

		test("answers zero for a bound of one or less", () => {
			let source = sourceOf()

			expect(below(source, 1)).toBe(0)
			expect(below(source, 0)).toBe(0)
			expect(below(source, -3)).toBe(0)
		})

		test("reaches every value of a small bound", () => {
			let source = sourceOf()
			let seen = new Set<number>()

			for (let index = 0; index < 400; index++) {
				seen.add(below(source, 6))
			}

			expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5])
		})
	})

	describe("fraction", () => {
		test("stays in the half open unit range", () => {
			let source = sourceOf()

			for (let index = 0; index < 1000; index++) {
				let drawn = fraction(source)

				expect(drawn).toBeGreaterThanOrEqual(0)
				expect(drawn).toBeLessThan(1)
			}
		})
	})

	describe("bigBetween", () => {
		test("includes both bounds", () => {
			let source = sourceOf()
			let seen = new Set<bigint>()

			for (let index = 0; index < 400; index++) {
				seen.add(bigBetween(source, -2n, 2n))
			}

			expect([...seen].sort((a, b) => Number(a - b))).toEqual([
				-2n,
				-1n,
				0n,
				1n,
				2n,
			])
		})

		test("draws a span wider than a word", () => {
			let source = sourceOf()
			let low = -(10n ** 30n)
			let high = 10n ** 30n

			for (let index = 0; index < 200; index++) {
				let drawn = bigBetween(source, low, high)

				expect(drawn >= low && drawn <= high).toBe(true)
			}
		})

		test("answers the lower bound for a range that encloses nothing", () => {
			expect(bigBetween(sourceOf(), 5n, 3n)).toBe(5n)
			expect(bigBetween(sourceOf(), 5n, 5n)).toBe(5n)
		})
	})

	describe("drawInteger", () => {
		test("includes both bounds", () => {
			let source = sourceOf()
			let seen = new Set<number | bigint>()

			for (let index = 0; index < 400; index++) {
				seen.add(
					drawInteger__overload$1(
						source,
						createInteger(1),
						createInteger(4),
					).value,
				)
			}

			expect([...seen].sort()).toEqual([1, 2, 3, 4])
		})

		test("reads the bounds as the same range either way round", () => {
			let source = sourceOf()
			let seen = new Set<number | bigint>()

			for (let index = 0; index < 400; index++) {
				seen.add(
					drawInteger__overload$1(
						source,
						createInteger(4),
						createInteger(1),
					).value,
				)
			}

			expect([...seen].sort()).toEqual([1, 2, 3, 4])
		})

		test("draws past the safe range as a bigint", () => {
			let source = sourceOf()
			let low = 10n ** 30n
			let drawn = drawInteger__overload$1(
				source,
				createInteger(low),
				createInteger(low + 10n ** 20n),
			)

			expect(typeof drawn.value).toBe("bigint")
			expect(drawn.value >= low).toBe(true)
		})

		// The half open entry, whose bound is outside the range. Some value
		// goes unseen in 400 draws with odds below 10^-49.
		test("counts from zero and stops below the bound", () => {
			let source = sourceOf()
			let seen = new Set<number | bigint>()

			for (let index = 0; index < 400; index++) {
				seen.add(
					drawInteger__overload$2(source, createInteger(4)).value,
				)
			}

			expect([...seen].sort()).toEqual([0, 1, 2, 3])
		})

		test("answers zero for a bound of one", () => {
			let source = sourceOf()

			expect(
				drawInteger__overload$2(source, createInteger(1)).value,
			).toBe(0)
		})

		// The proof that the bound is above zero erases, so a computed zero
		// meets the guard.
		test("answers zero for a bound the proof would refuse", () => {
			let source = sourceOf()

			expect(
				drawInteger__overload$2(source, createInteger(0)).value,
			).toBe(0)
			expect(
				drawInteger__overload$2(source, createInteger(-7)).value,
			).toBe(0)
		})

		test("draws a bound wider than the safe range", () => {
			let source = sourceOf()
			let bound = 10n ** 30n

			for (let index = 0; index < 100; index++) {
				let drawn = drawInteger__overload$2(
					source,
					createInteger(bound),
				)
				let value = BigInt(drawn.value)

				expect(value >= 0n && value < bound).toBe(true)
			}
		})
	})

	describe("drawRational", () => {
		test("stays inside the bounds", () => {
			let source = sourceOf()
			let low = createRational(-3n, 2n)
			let high = createRational(7n, 2n)

			for (let index = 0; index < 500; index++) {
				let drawn = drawRational__overload$1(source, low, high)
				let scaled = drawn.numerator * 2n

				expect(scaled >= -3n * drawn.denominator).toBe(true)
				expect(scaled <= 7n * drawn.denominator).toBe(true)
			}
		})

		test("answers exact fractions with small denominators", () => {
			let source = sourceOf()
			let denominators = new Set<bigint>()

			for (let index = 0; index < 500; index++) {
				denominators.add(
					drawRational__overload$1(
						source,
						createRational(0n, 1n),
						createRational(1n, 1n),
					).denominator,
				)
			}

			// Every denominator comes from the table, so a drawn Rational reads
			// as a plain fraction rather than a scaled double.
			expect(
				[...denominators].every((denominator) =>
					[1n, 2n, 3n, 4n, 5n, 6n, 8n, 10n, 12n, 16n, 100n, 1000n]
						.map((entry) => entry)
						.includes(denominator),
				),
			).toBe(true)
		})

		test("answers the lower bound for a range too narrow to hold a multiple", () => {
			let drawn = drawRational__overload$1(
				sourceOf(),
				createRational(1n, 7n),
				createRational(1n, 7n),
			)

			expect(drawn.numerator).toBe(1n)
			expect(drawn.denominator).toBe(7n)
		})

		test("reads the bounds as the same range either way round", () => {
			let source = sourceOf()
			let low = createRational(-3n, 2n)
			let high = createRational(7n, 2n)

			for (let index = 0; index < 500; index++) {
				let drawn = drawRational__overload$1(source, high, low)
				let scaled = drawn.numerator * 2n

				expect(scaled >= -3n * drawn.denominator).toBe(true)
				expect(scaled <= 7n * drawn.denominator).toBe(true)
			}
		})

		// The range starts at one so that no draw is zero, which
		// `createRational` writes over a denominator of one.
		test("answers over the denominator it is given", () => {
			let source = sourceOf()
			let low = createRational(1n, 1n)
			let high = createRational(2n, 1n)
			let seen = new Set<bigint>()

			for (let index = 0; index < 400; index++) {
				let drawn = drawRational__overload$2(
					source,
					low,
					high,
					createInteger(7),
				)

				expect(drawn.denominator).toBe(7n)
				expect(drawn.numerator >= 7n).toBe(true)
				expect(drawn.numerator <= 14n).toBe(true)
				seen.add(drawn.numerator)
			}

			expect(seen.size).toBe(8)
		})

		test("reads the bounds as the same range either way round", () => {
			let source = sourceOf()

			for (let index = 0; index < 200; index++) {
				let drawn = drawRational__overload$2(
					source,
					createRational(2n, 1n),
					createRational(1n, 1n),
					createInteger(7),
				)

				expect(drawn.numerator >= 7n).toBe(true)
				expect(drawn.numerator <= 14n).toBe(true)
			}
		})

		test("answers the lower bound for a range too narrow to hold a multiple", () => {
			let drawn = drawRational__overload$2(
				sourceOf(),
				createRational(1n, 7n),
				createRational(1n, 7n),
				createInteger(2),
			)

			expect(drawn.numerator).toBe(1n)
			expect(drawn.denominator).toBe(7n)
		})

		// The proof that the denominator is above zero erases, so a computed
		// zero meets the guard, which draws over one whole.
		test("draws over one whole for a denominator the proof would refuse", () => {
			let drawn = drawRational__overload$2(
				sourceOf(),
				createRational(3n, 1n),
				createRational(3n, 1n),
				createInteger(0),
			)

			expect(drawn.numerator).toBe(3n)
			expect(drawn.denominator).toBe(1n)
		})
	})

	describe("drawString", () => {
		test("answers no more characters than asked for", () => {
			let source = sourceOf()

			for (let index = 0; index < 400; index++) {
				let drawn = drawString(source, createInteger(6))

				expect([...drawn.value].length).toBeLessThanOrEqual(8)
			}
		})

		test("answers the empty String for a bound of zero or less", () => {
			expect(drawString(sourceOf(), createInteger(0)).value).toBe("")
			expect(drawString(sourceOf(), createInteger(-4)).value).toBe("")
		})

		test("answers the empty String sometimes and a full one sometimes", () => {
			let source = sourceOf()
			let lengths = new Set<number>()

			for (let index = 0; index < 400; index++) {
				lengths.add(drawString(source, createInteger(3)).value.length)
			}

			expect(lengths.has(0)).toBe(true)
			expect(lengths.size).toBeGreaterThan(1)
		})
	})

	describe("pick", () => {
		test("answers an item of the List", () => {
			let source = sourceOf()
			let items = createList([
				createString("Lions"),
				createString("Tigers"),
				createString("Bears"),
			])
			let seen = new Set<string>()

			for (let index = 0; index < 300; index++) {
				seen.add(pick__overload$1(source, items).value)
			}

			expect([...seen].sort()).toEqual(["Bears", "Lions", "Tigers"])
		})

		test("answers the one item of a List that holds one", () => {
			let items = createList([createString("Wolves")])

			expect(pick__overload$1(sourceOf(), items).value).toBe("Wolves")
		})

		// Drawn without replacement.
		test("answers as many items as asked for, none of them twice", () => {
			let source = sourceOf()

			for (let index = 0; index < 200; index++) {
				let drawn = materialise(
					pick__overload$2(source, createInteger(3), teamsOf()),
				).map((team) => team.value)

				expect(drawn.length).toBe(3)
				expect(new Set(drawn).size).toBe(3)
				expect(
					drawn.every((team) => TEAMS.includes(team as string)),
				).toBe(true)
			}
		})

		test("answers every item for a count above the length", () => {
			let drawn = materialise(
				pick__overload$2(sourceOf(), createInteger(40), teamsOf()),
			).map((team) => team.value)

			expect([...drawn].sort()).toEqual([...TEAMS].sort())
		})

		// The proof that the count is above zero erases, so a computed zero
		// meets the guard.
		test("answers one item for a count the proof would refuse", () => {
			let drawn = materialise(
				pick__overload$2(sourceOf(), createInteger(0), teamsOf()),
			)

			expect(drawn.length).toBe(1)
		})

		// A count up to a twenty-fifth of the length draws through a Map of
		// displaced positions, and a larger one through a copy. Both issue the
		// same draws in order, so 200 and 201 of 5,000 agree item for item.
		test("draws the same items on either side of the sparse line", () => {
			let items = createList(
				Array.from({ length: 5_000 }, (_, index) =>
					createInteger(index),
				),
			)
			let drawnAt = (count: number): Array<number> =>
				materialise(
					pick__overload$2(
						sourceOf("either side"),
						createInteger(count),
						items,
					),
				).map((item) => Number(item.value))
			let sparse = drawnAt(200)
			let copied = drawnAt(201)

			expect(sparse.length).toBe(200)
			expect(copied.length).toBe(201)
			expect(new Set(sparse).size).toBe(200)
			expect(copied.slice(0, 200)).toEqual(sparse)
		})

		// A List built from the front holds its items in a reversed run, which
		// the sparse draw must index backwards.
		test("draws the same items out of a front-built List", () => {
			let flat = createList(
				Array.from({ length: 400 }, (_, index) => createInteger(index)),
			)
			let front = createList<IntegerType>([])

			for (let index = 399; index >= 0; index--) {
				front = prepend(front, createInteger(index))
			}

			let drawnFrom = (items: ListType<IntegerType>): Array<number> =>
				materialise(
					pick__overload$2(
						sourceOf("front run"),
						createInteger(4),
						items,
					),
				).map((item) => Number(item.value))

			expect(drawnFrom(front)).toEqual(drawnFrom(flat))
		})

		// A draw costs the count, not the length. A Proxy counts the positions
		// read, since a wall-clock ceiling fails on a loaded machine.
		test("draws a few items without reading the whole List", () => {
			let reads = 0
			let counted = new Proxy(
				Array.from({ length: 200_000 }, (_, index) =>
					createInteger(index),
				),
				{
					get(target, key, receiver) {
						if (typeof key === "string" && key !== "length") {
							reads++
						}

						return Reflect.get(target, key, receiver)
					},
				},
			)
			let items = createList(counted)
			let source = sourceOf("a few")
			let drawn = 0

			for (let turn = 0; turn < 200; turn++) {
				drawn += materialise(
					pick__overload$2(source, createInteger(10), items),
				).length
			}

			expect(drawn).toBe(2_000)
			expect(reads).toBe(2_000)
		})

		test("leaves the List it was given as it was", () => {
			let items = teamsOf()

			pick__overload$2(sourceOf(), createInteger(3), items)

			expect(materialise(items).map((team) => team.value)).toEqual([
				...TEAMS,
			])
		})

		test("answers the one item of every weighted draw over a List of one", () => {
			let items = createList([createString("Wolves")])

			expect(
				pick__overload$3(sourceOf(), items, () =>
					createRational(0n, 1n),
				).value,
			).toBe("Wolves")
		})

		test("answers only the item a weight is on", () => {
			let source = sourceOf()
			let items = createList([
				createString("Lions"),
				createString("Tigers"),
				createString("Bears"),
			])

			for (let index = 0; index < 200; index++) {
				expect(
					pick__overload$3(source, items, (team) =>
						team.value === "Tigers"
							? createRational(1n, 1n)
							: createRational(0n, 1n),
					).value,
				).toBe("Tigers")
			}
		})

		// Over a common denominator the weights are 3, 3 and 2 parts of eight.
		// So 8000 draws land near 3000, 3000 and 2000.
		test("weighs the items against each other exactly", () => {
			let source = sourceOf()
			let items = createList([
				createString("Lions"),
				createString("Tigers"),
				createString("Bears"),
			])
			let weights: { [team: string]: RationalType } = {
				Lions: createRational(1n, 2n),
				Tigers: createRational(1n, 2n),
				Bears: createRational(1n, 3n),
			}
			let counts: { [team: string]: number } = {
				Lions: 0,
				Tigers: 0,
				Bears: 0,
			}

			for (let index = 0; index < 8000; index++) {
				let drawn = pick__overload$3(
					source,
					items,
					(team) => weights[team.value] ?? createRational(0n, 1n),
				)

				counts[drawn.value] = (counts[drawn.value] ?? 0) + 1
			}

			expect(counts.Lions).toBeGreaterThan(2800)
			expect(counts.Lions).toBeLessThan(3200)
			expect(counts.Tigers).toBeGreaterThan(2800)
			expect(counts.Tigers).toBeLessThan(3200)
			expect(counts.Bears).toBeGreaterThan(1800)
			expect(counts.Bears).toBeLessThan(2200)
		})

		test("draws a negative weight as zero", () => {
			let source = sourceOf()
			let items = createList([
				createString("Lions"),
				createString("Tigers"),
			])

			for (let index = 0; index < 200; index++) {
				expect(
					pick__overload$3(source, items, (team) =>
						team.value === "Lions"
							? createRational(-5n, 1n)
							: createRational(1n, 4n),
					).value,
				).toBe("Tigers")
			}
		})

		test("draws evenly where every weight is zero", () => {
			let source = sourceOf()
			let items = createList([
				createString("Lions"),
				createString("Tigers"),
				createString("Bears"),
			])
			let seen = new Set<string>()

			for (let index = 0; index < 300; index++) {
				seen.add(
					pick__overload$3(source, items, () =>
						createRational(0n, 1n),
					).value,
				)
			}

			expect([...seen].sort()).toEqual(["Bears", "Lions", "Tigers"])
		})
	})

	describe("shuffle", () => {
		test("answers the same items in some order", () => {
			let source = sourceOf()

			for (let index = 0; index < 200; index++) {
				let drawn = materialise(
					shuffle__overload$1(source, teamsOf()),
				).map((team) => team.value)

				expect([...drawn].sort()).toEqual([...TEAMS].sort())
			}
		})

		test("leaves the List it was given as it was", () => {
			let items = teamsOf()

			shuffle__overload$1(sourceOf(), items)

			expect(materialise(items).map((team) => team.value)).toEqual([
				...TEAMS,
			])
		})

		// Four items have 24 orders, and 200 seeded draws reach them all.
		test("reaches every order of four items", () => {
			let source = sourceOf()
			let seen = new Set<string>()

			for (let index = 0; index < 200; index++) {
				seen.add(
					materialise(shuffle__overload$1(source, teamsOf()))
						.map((team) => team.value)
						.join(" "),
				)
			}

			expect(seen.size).toBe(24)
		})

		test("answers the empty List and the List of one unchanged", () => {
			let source = sourceOf()
			let none = createList<StringType>([])
			let one = createList([createString("Wolves")])

			expect(materialise(shuffle__overload$1(source, none)).length).toBe(
				0,
			)
			expect(
				materialise(shuffle__overload$1(source, one)).map(
					(team) => team.value,
				),
			).toEqual(["Wolves"])
		})
	})

	describe("seedOf", () => {
		test("answers the same word for the same text", () => {
			expect(seedOf("41c37ea3")).toBe(seedOf("41c37ea3"))
		})

		test("answers a different word for different text", () => {
			expect(seedOf("41c37ea3")).not.toBe(seedOf("41c37ea4"))
		})
	})

	// An entropy source has no seed, so only its ranges and its variety are
	// asserted. Where a test counts on chance, its odds of a miss are below
	// 10^-30, so a failure is a broken source.
	describe("entropy", () => {
		test("carries the Randomness tag", () => {
			expect(entropy()[typeKeySymbol]).toBe("Randomness")
		})

		test("answers THE one source from every call", () => {
			expect(entropy()).toBe(entropy())
		})

		// Two runs of 64 words agree with odds of one in 2^2048.
		test("never answers the same run of words twice", () => {
			let source = entropy()
			let first = Array.from({ length: 64 }, () => nextWord(source))
			let second = Array.from({ length: 64 }, () => nextWord(source))

			expect(first).not.toEqual(second)
		})

		// 2000 draws cross the edge of the 256-word buffer several times, so the
		// refill is walked too.
		test("stays inside the bound", () => {
			let source = entropy()

			for (let index = 0; index < 2000; index++) {
				let drawn = below(source, 7)

				expect(drawn).toBeGreaterThanOrEqual(0)
				expect(drawn).toBeLessThan(7)
			}
		})

		// Some value goes unseen in 400 draws with odds below 10^-30.
		test("reaches every value of a small bound", () => {
			let source = entropy()
			let seen = new Set<number>()

			for (let index = 0; index < 400; index++) {
				seen.add(below(source, 6))
			}

			expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5])
		})

		// Every native draws through `nextWord`, so one over entropy stands for
		// all. Some value goes unseen in 400 draws with odds below 10^-49.
		test("drives the natives as the seeded kind does", () => {
			let source = entropy()
			let seen = new Set<number | bigint>()

			for (let index = 0; index < 400; index++) {
				seen.add(
					drawInteger__overload$1(
						source,
						createInteger(1),
						createInteger(4),
					).value,
				)
			}

			expect([...seen].sort()).toEqual([1, 2, 3, 4])
		})
	})
})
