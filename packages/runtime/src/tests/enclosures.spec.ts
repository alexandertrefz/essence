import { describe, expect, test } from "bun:test"

import { decimalExponentOnEnclosure, roundedOnDecimalGrid } from "../Algebraic"
import { createCase } from "../type"

// The refinement under both irrationals, driven over synthetic enclosures that
// count what they are asked for and reach the limit cheaply. `irrationals.spec.ts`
// covers the real ones. See "Reading digits off an enclosure" in
// packages/runtime/DEVELOPMENT.md.

const nearest = createCase("Rounding#Nearest") as never

// An enclosure of `numerator / denominator` scaled by 10^digits, one unit of the
// last place loose on each side. `taken` counts the enclosures asked for.
function enclosureOf(
	numerator: bigint,
	denominator: bigint,
): {
	at: (digits: bigint) => { low: bigint; high: bigint }
	taken: () => number
} {
	let taken = 0

	return {
		at: (digits: bigint) => {
			taken += 1

			let scaled = (numerator * 10n ** digits) / denominator

			return { low: scaled - 1n, high: scaled + 1n }
		},
		taken: () => taken,
	}
}

describe("rounding on a decimal grid", () => {
	test("the first enclosure decides an ordinary width", () => {
		let third = enclosureOf(1n, 3n)

		expect(roundedOnDecimalGrid(third.at, 4n, nearest, null)).toBe(3333n)
		expect(third.taken()).toBe(1)
	})

	test("a width inside the limit is answered", () => {
		let third = enclosureOf(1n, 3n)

		expect(roundedOnDecimalGrid(third.at, 4n, nearest, 16n)).toBe(3333n)
		expect(third.taken()).toBe(1)
	})

	// The limit is on the enclosure's width, not on how far the refinement went
	// past the grid. A grid whose first guard passes it takes no enclosure.
	test("a width past the limit is refused before any enclosure", () => {
		let third = enclosureOf(1n, 3n)

		expect(roundedOnDecimalGrid(third.at, 12n, nearest, 16n)).toBeNull()
		expect(third.taken()).toBe(0)
	})

	// A value on a step of the grid, here a half under a nearest rule, never
	// decides, so it reaches the limit by refining.
	test("a value on a step refines until the limit stops it", () => {
		let half = enclosureOf(1n, 2n)

		expect(roundedOnDecimalGrid(half.at, 0n, nearest, 16n)).toBeNull()
		expect(half.taken()).toBe(2)
	})
})

describe("reading a decimal exponent", () => {
	test("a value between one and ten falls on the zeroth power", () => {
		let value = enclosureOf(7n, 5n)

		expect(decimalExponentOnEnclosure(value.at, null)).toBe(0n)
		expect(value.taken()).toBe(1)
	})

	test("a value below one falls on a negative power", () => {
		expect(decimalExponentOnEnclosure(enclosureOf(1n, 3n).at, null)).toBe(
			-1n,
		)
		expect(decimalExponentOnEnclosure(enclosureOf(1n, 300n).at, null)).toBe(
			-3n,
		)
	})

	test("a value above ten falls on a positive power", () => {
		expect(decimalExponentOnEnclosure(enclosureOf(400n, 3n).at, null)).toBe(
			2n,
		)
	})

	test("a negative value answers the power its magnitude falls on", () => {
		expect(decimalExponentOnEnclosure(enclosureOf(-7n, 5n).at, null)).toBe(
			0n,
		)
		expect(
			decimalExponentOnEnclosure(enclosureOf(-1n, 300n).at, null),
		).toBe(-3n)
	})

	// A tiny value encloses zero at eight digits. One just under a power of ten
	// straddles two digit counts. Both ask for more digits.
	test("a value the first enclosure can not place asks for more digits", () => {
		let tiny = enclosureOf(3n, 10n ** 20n)

		expect(decimalExponentOnEnclosure(tiny.at, null)).toBe(-20n)
		expect(tiny.taken()).toBe(3)

		let underOne = enclosureOf(10n ** 12n - 1n, 10n ** 12n)

		expect(decimalExponentOnEnclosure(underOne.at, null)).toBe(-1n)
		expect(underOne.taken()).toBe(2)
	})

	// A power of ten never decides, so only the limit stops it.
	test("a value on a power of ten is refused at the limit", () => {
		let ten = enclosureOf(10n, 1n)

		expect(decimalExponentOnEnclosure(ten.at, 16n)).toBeNull()
		expect(ten.taken()).toBe(2)
	})
})
