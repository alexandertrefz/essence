import { describe, expect, test } from "bun:test"

import { roundedOnDecimalGrid } from "../Algebraic"
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
