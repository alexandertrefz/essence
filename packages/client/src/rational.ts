import { reduced } from "@essence-lang/runtime/bigRational"

// NOTE: A Rational as JavaScript holds it. `1/3` has no JavaScript number, so
// what crosses the boundary is the pair the runtime itself holds — two bigints,
// in lowest terms with the sign on the numerator. `reduced` is the runtime's own
// canonicaliser rather than a second copy of it, so `2/4`, `1/2` and `-1/-2` are
// one value here for exactly the reasons they are one value in Essence.
//
// NOTE: A class rather than a plain pair, because `fromJS` has to tell a
// Rational apart from a Record that happens to have a `numerator` and a
// `denominator`, and `instanceof` is the only test that does not confuse the
// two. The cost is realms: two copies of this package in one process mint two
// classes, and a Rational built by one is not `instanceof` the other. That is
// the same rule every `instanceof` in JavaScript is read under.
export class EssenceRational {
	readonly numerator: bigint
	readonly denominator: bigint

	constructor(numerator: bigint, denominator: bigint = 1n) {
		if (denominator === 0n) {
			throw new RangeError(
				"A Rational can not have a denominator of zero.",
			)
		}

		let parts = reduced(numerator, denominator)

		this.numerator = parts.numerator
		this.denominator = parts.denominator
	}

	// NOTE: The EXACT value of a double, not the value its decimal spelling
	// suggests. Every finite double IS a dyadic rational — a significand times a
	// power of two — so reading its bits apart answers with no rounding at all,
	// where `0.1` by way of `"0.1"` would answer `1/10` and quietly claim a
	// precision the number never had. What `0.1` holds is
	// `3602879701896397/36028797018963968`, and that is what comes back.
	static fromNumber(value: number): EssenceRational {
		if (!Number.isFinite(value)) {
			throw new RangeError(
				`'${value}' has no Rational value — a Rational is finite.`,
			)
		}

		let bits = new DataView(new ArrayBuffer(8))

		bits.setFloat64(0, value)

		let raw = bits.getBigUint64(0)
		let exponent = Number((raw >> 52n) & 0x7ffn)
		let mantissa = raw & 0xf_ffff_ffff_ffffn
		// NOTE: A subnormal carries no implicit leading bit and shares the
		// smallest normal's exponent, which is what the zero case is.
		let significand = exponent === 0 ? mantissa : mantissa | (1n << 52n)
		// NOTE: 1075 is the 52 bits of the fraction plus the 1023 the exponent
		// is biased by — the power of two the significand, read as an integer,
		// has to be scaled by.
		let scale = (exponent === 0 ? 1 : exponent) - 1075
		let signed = raw >> 63n === 1n ? -significand : significand

		return scale >= 0
			? new EssenceRational(signed << BigInt(scale), 1n)
			: new EssenceRational(signed, 1n << BigInt(-scale))
	}

	// NOTE: The nearest double, which is an approximation by definition — this
	// is the lossy door, offered because a host that wants one usually knows it.
	// The division is done on the parts where a double holds them EXACTLY, and
	// on a scaled quotient everywhere else — parts that are merely finite as
	// doubles have already been rounded by the reading, and dividing two
	// roundings misrounds the quotient by an ulp often enough to matter.
	toNumber(): number {
		if (this.numerator === 0n) {
			return 0
		}

		let negative = this.numerator < 0n
		let magnitude = dividedMagnitude(
			negative ? -this.numerator : this.numerator,
			this.denominator,
		)

		return negative ? -magnitude : magnitude
	}

	// NOTE: How Essence itself prints a Rational — `1/3`, and a whole one as
	// `2/1` rather than as `2`, because the Type is what the spelling says.
	toString(): string {
		return `${this.numerator}/${this.denominator}`
	}

	// NOTE: Both sides are in lowest terms with the sign on the numerator, so
	// equality is the pair — no cross-multiplication, and no pair of unequal
	// spellings of one value to be caught out by.
	equals(other: EssenceRational): boolean {
		return (
			this.numerator === other.numerator &&
			this.denominator === other.denominator
		)
	}
}

// NOTE: The largest integer every one of whose neighbours a double still tells
// apart. Two parts at most this large divide in ONE hardware rounding, which
// IEEE 754 requires to be correct — the fast path.
const EXACT_LIMIT = 1n << 53n

// NOTE: `numerator / denominator` for positive parts, correctly rounded to
// nearest-even. Everything past the fast path rounds exactly once: the
// quotient is taken to 64 bits with the truncated remainder folded into the
// low bit — round-to-odd, which any later rounding of 53 bits or fewer reads
// as "not exactly halfway" precisely when the true quotient is not — and the
// power of two it is scaled back by is exact. A subnormal answer has fewer
// bits than the conversion to a double would keep, so IT would round twice;
// the rounding is done in bigint instead, at the one width that counts.
function dividedMagnitude(numerator: bigint, denominator: bigint): number {
	if (numerator <= EXACT_LIMIT && denominator <= EXACT_LIMIT) {
		return Number(numerator) / Number(denominator)
	}

	let shift = bitLength(denominator) - bitLength(numerator) + 64
	let scaled: bigint

	if (shift >= 0) {
		let widened = numerator << BigInt(shift)

		scaled = widened / denominator

		if (scaled * denominator !== widened) {
			scaled |= 1n
		}
	} else {
		let widened = denominator << BigInt(-shift)

		scaled = numerator / widened

		if (scaled * widened !== numerator) {
			scaled |= 1n
		}
	}

	// NOTE: The floor of the answer's exponent. At `-1023` and below the answer
	// is subnormal — its ulp is `2 ** -1074` however few bits that leaves — so
	// the 64-bit quotient is rounded to multiples of that ulp here, half to
	// even, and what remains converts and scales exactly.
	let exponent = bitLength(scaled) - 1 - shift

	if (exponent < -1022) {
		return scaledByPowerOfTwo(
			Number(roundedShift(scaled, shift - 1074)),
			-1074,
		)
	}

	return scaledByPowerOfTwo(Number(scaled), -shift)
}

// NOTE: `value >> shift`, rounded to nearest with ties to even — the rounding
// `Number(…)` would have done, at a coarser width than it would have done it.
// The tie can not lie: a truncated quotient was already marked odd, so an
// exact-looking half really is one.
function roundedShift(value: bigint, shift: number): bigint {
	let half = 1n << BigInt(shift - 1)
	let rest = value & ((1n << BigInt(shift)) - 1n)
	let whole = value >> BigInt(shift)

	if (rest > half || (rest === half && (whole & 1n) === 1n)) {
		return whole + 1n
	}

	return whole
}

function bitLength(value: bigint): number {
	return (value < 0n ? -value : value).toString(2).length
}

// NOTE: The largest power of two a double holds. `2 ** 1024` is `Infinity` and
// `2 ** -1075` is `0`, so anything past this has to be applied in more than one
// multiplication.
const POWER_STEP = 1023

// NOTE: `value * 2 ** exponent`, in steps a double's own exponent can hold.
// Done in one multiplication it is wrong at both ends: `1/2 ** 1024` scales back
// by `2 ** -1088`, which IS `0` — so the answer is `0` rather than the perfectly
// ordinary subnormal `5.56e-309` the Rational actually is. Stepping keeps every
// intermediate in range, and each step is exact until the last one, which is the
// single rounding a conversion to a double is allowed.
//
// NOTE: The loop stops early on `0` and on `Infinity` because both are fixed
// points — a Rational of a million-bit numerator would otherwise multiply
// `Infinity` by `2 ** 1023` a thousand times to reach the same answer.
function scaledByPowerOfTwo(value: number, exponent: number): number {
	let scaled = value
	let remaining = exponent

	while (remaining !== 0 && scaled !== 0 && Number.isFinite(scaled)) {
		let step = Math.max(-POWER_STEP, Math.min(POWER_STEP, remaining))

		scaled *= 2 ** step
		remaining -= step
	}

	return scaled
}
