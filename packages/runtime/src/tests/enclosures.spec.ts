import { describe, expect, test } from "bun:test"

import {
	decimalExponentOnEnclosure,
	roundedOnDecimalGrid,
} from "../Algebraic"
import { createCase } from "../type"

// NOTE: The refinement both irrationals hand a reader digits through, driven
// over a SYNTHETIC enclosure rather than over π or √2. What is asserted here is
// the contract of the refinement itself — when it decides, when it refuses, and
// how many enclosures it asked for before either — and a synthetic one is the
// only way to count those and to reach the cutoff without a 32,768-digit
// enclosure. What the real enclosures answer is `irrationals.spec.ts`.

const nearest = createCase("Rounding#Nearest") as never

// NOTE: An enclosure of `numerator / denominator` scaled by 10^digits, one unit
// of the last place loose on each side, which is the shape both real ones have.
// The counter is what the refusal tests read: the point of an absolute cutoff is
// that a width already past it costs no enclosure at all.
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

	// NOTE: The limit is on the WIDTH of the enclosure, not on how far past the
	// requested grid the refinement was pushed — which is what `Number.es`
	// documents the cutoff as, and what the two sign decisions in
	// `Transcendental.ts` test the same way. So a caller asking for a grid whose
	// first guard already lands past it is refused before an enclosure is taken,
	// and the message it reports says which width it asked for rather than
	// claiming two values agreed to a depth.
	test("a width past the limit is refused before any enclosure", () => {
		let third = enclosureOf(1n, 3n)

		expect(roundedOnDecimalGrid(third.at, 12n, nearest, 16n)).toBeNull()
		expect(third.taken()).toBe(0)
	})

	// NOTE: A value sitting exactly on a step of the grid is what a refinement
	// can not decide — a half for the nearest rules — so this is the one shape
	// that reaches the limit by refining rather than by asking for too much. A
	// real irrational never takes this path, which is why every caller but the
	// several-base Transcendental passes no limit at all.
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

	// NOTE: The sign is read off the far end of the interval, so a negative
	// value answers the power its distance from zero falls on, exactly as the
	// positive one does.
	test("a negative value answers the power its magnitude falls on", () => {
		expect(decimalExponentOnEnclosure(enclosureOf(-7n, 5n).at, null)).toBe(
			0n,
		)
		expect(decimalExponentOnEnclosure(enclosureOf(-1n, 300n).at, null)).toBe(
			-3n,
		)
	})

	// NOTE: A value far below the first enclosure's width encloses zero at
	// eight digits, and one just under a power of ten straddles the band, so
	// both ask for more digits before they decide. Neither can loop forever on
	// a real receiver: an irrational is neither zero nor a power of ten.
	test("a value the first enclosure can not place asks for more digits", () => {
		let tiny = enclosureOf(3n, 10n ** 20n)

		expect(decimalExponentOnEnclosure(tiny.at, null)).toBe(-20n)
		expect(tiny.taken()).toBe(3)

		let underOne = enclosureOf(10n ** 12n - 1n, 10n ** 12n)

		expect(decimalExponentOnEnclosure(underOne.at, null)).toBe(-1n)
		expect(underOne.taken()).toBe(2)
	})

	// NOTE: The same absolute cutoff the grid reading takes, for the same
	// caller — a Transcendental over several bases sitting exactly on a power
	// of ten would settle the same open problem.
	test("a value on a power of ten is refused at the limit", () => {
		let ten = enclosureOf(10n, 1n)

		expect(decimalExponentOnEnclosure(ten.at, 16n)).toBeNull()
		expect(ten.taken()).toBe(2)
	})
})
