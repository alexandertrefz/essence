import { reduced } from "@essence-lang/runtime/bigRational"

// A Rational as JavaScript holds it: two bigints in lowest terms with the sign
// on the numerator, reduced by the runtime's own `reduced`. It is a class so
// that `fromJS` can tell it from a Record with the same members by `instanceof`.
// Two copies of this package in one process mint two classes.
export class EssenceRational {
	readonly numerator: bigint
	readonly denominator: bigint

	// The parts are checked before `reduced` sees them, since it trusts typed
	// code. A number part would throw from inside it or stay a number.
	constructor(numerator: bigint | number, denominator: bigint | number = 1n) {
		let top = rationalPart(numerator, "numerator")
		let bottom = rationalPart(denominator, "denominator")

		if (bottom === 0n) {
			throw new RangeError(
				"A Rational can not have a denominator of zero.",
			)
		}

		let parts = reduced(top, bottom)

		this.numerator = parts.numerator
		this.denominator = parts.denominator
	}

	// The exact value of a double, read from its bits, rather than the value
	// its decimal spelling suggests: `0.1` answers
	// `3602879701896397/36028797018963968`, not `1/10`.
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
		// A subnormal has no implicit leading bit and the smallest normal's
		// exponent.
		let significand = exponent === 0 ? mantissa : mantissa | (1n << 52n)
		// 1075 is the 52 fraction bits plus the exponent bias of 1023.
		let scale = (exponent === 0 ? 1 : exponent) - 1075
		let signed = raw >> 63n === 1n ? -significand : significand

		return scale >= 0
			? new EssenceRational(signed << BigInt(scale), 1n)
			: new EssenceRational(signed, 1n << BigInt(-scale))
	}

	// The nearest double, which loses precision. See "Rounding a Rational to a
	// double" in DEVELOPMENT.md.
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

	// As Essence prints a Rational: `1/3`, and a whole one as its numerator.
	toString(): string {
		return this.denominator === 1n
			? `${this.numerator}`
			: `${this.numerator}/${this.denominator}`
	}

	// Both sides are in lowest terms with the sign on the numerator, so equal
	// values have equal parts.
	equals(other: EssenceRational): boolean {
		return (
			this.numerator === other.numerator &&
			this.denominator === other.denominator
		)
	}
}

// One part as a bigint. A safe integer is admitted, so a host may write
// `new EssenceRational(1, 2)`. Any other number is refused rather than rounded,
// and the message names `fromNumber`, which answers what a double holds.
function rationalPart(value: bigint | number, role: string): bigint {
	if (typeof value === "bigint") {
		return value
	}

	if (typeof value === "number") {
		if (Number.isSafeInteger(value)) {
			return BigInt(value)
		}

		// `NaN` and the infinities have no Rational, so they get the
		// `RangeError` that `fromNumber` throws for them rather than a pointer to it.
		if (!Number.isFinite(value)) {
			throw new RangeError(
				`A Rational's ${role} has to be finite, and '${value}' is not.`,
			)
		}

		throw new TypeError(
			`A Rational's ${role} has to be a whole number a double holds exactly, and '${value}' is not — 'EssenceRational.fromNumber' is what answers the exact value of a double.`,
		)
	}

	throw new TypeError(
		`A Rational's ${role} has to be a bigint or a whole number, and this is ${kindOf(value)}.`,
	)
}

// The value's kind and never the value, which may be huge or a Symbol that
// throws when converted to a string.
function kindOf(value: unknown): string {
	if (value === undefined) {
		return "nothing"
	}

	if (value === null) {
		return "null"
	}

	return /^[aeiou]/.test(typeof value)
		? `an ${typeof value}`
		: `a ${typeof value}`
}

// Parts at most this large convert to doubles exactly, so one division
// rounds correctly.
const EXACT_LIMIT = 1n << 53n

// `numerator / denominator` for positive parts, rounded to nearest, ties to
// even. See "Rounding a Rational to a double" in DEVELOPMENT.md.
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

	// The floor of the answer's exponent. Under -1022 the answer is subnormal,
	// so the quotient is rounded to a multiple of `2 ** -1074` here.
	let exponent = bitLength(scaled) - 1 - shift

	if (exponent < -1022) {
		return scaledByPowerOfTwo(
			Number(roundedShift(scaled, shift - 1074)),
			-1074,
		)
	}

	return scaledByPowerOfTwo(Number(scaled), -shift)
}

// `value >> shift`, rounded to nearest with ties to even. An inexact quotient
// already has its low bit set, so a tie seen here is a true tie.
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

// The largest power of two a double holds.
const POWER_STEP = 1023

// `value * 2 ** exponent`, in steps that keep every intermediate in range. See
// "Rounding a Rational to a double" in DEVELOPMENT.md.
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
