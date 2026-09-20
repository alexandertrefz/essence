// NOTE: `1.5/2` — a Rational written as a fraction and a decimal at once, and
// the value the two spellings say between them, written back each way.
//
// This lives in the Compiler rather than beside the Quick Fix it was first
// written for, because the Help and the fix have to offer the SAME number. The
// Help printed `'3/4'` and `'0.75'` whatever was written, so `2.5/3` — which is
// five sixths — was answered with a Help that quietly changed the value while
// the fix standing beside it offered `5/6`.

const decimalOverFractionPattern =
	/^(-?[0-9][0-9_]*)\.([0-9][0-9_]*)\/([0-9][0-9_]*)$/
const fractionOverDecimalPattern =
	/^(-?[0-9][0-9_]*)\/([0-9][0-9_]*)\.([0-9][0-9_]*)$/

type Rational = { numerator: bigint; denominator: bigint }

// NOTE: Both spellings of the written value, the fraction first. A value with no
// terminating decimal — `1.5/7` — is one spelling alone: there is no decimal
// that says it, and a rounded one would answer with a different number.
//
// Empty where the text is not a mixed Literal at all, which is what lets a
// caller ask this of whatever it is holding.
export function mixedRationalSpellings(written: string): Array<string> {
	let value =
		rationalOf(decimalOverFractionPattern.exec(written), "decimal") ??
		rationalOf(fractionOverDecimalPattern.exec(written), "fraction")

	if (value === null) {
		return []
	}

	let decimal = decimalSpelling(value)

	return [
		`${value.numerator}/${value.denominator}`,
		...(decimal === null ? [] : [decimal]),
	]
}

// NOTE: The two mixed spellings read as one value. `A.B/C` is `AB` over
// `10^len(B) · C`, and `A/B.C` is `A · 10^len(C)` over `BC` — the same
// arithmetic either way round, with the power of ten on the side the decimal was
// written on. Reduced to lowest terms, so that what is offered back is the
// number rather than the digits it was typed as.
function rationalOf(
	written: RegExpExecArray | null,
	side: "decimal" | "fraction",
): Rational | null {
	if (written === null) {
		return null
	}

	let [whole, fraction, third] = [
		digitsOf(written[1] as string),
		digitsOf(written[2] as string),
		digitsOf(written[3] as string),
	]

	let scale = 10n ** BigInt((side === "decimal" ? fraction : third).length)
	let numerator =
		side === "decimal"
			? BigInt(`${whole}${fraction}`)
			: BigInt(whole) * scale
	let denominator =
		side === "decimal"
			? scale * BigInt(third)
			: BigInt(`${fraction}${third}`)

	if (denominator === 0n) {
		return null
	}

	let divisor = greatestCommonDivisor(
		numerator < 0n ? -numerator : numerator,
		denominator,
	)

	return {
		numerator: numerator / divisor,
		denominator: denominator / divisor,
	}
}

// NOTE: Euclid's, over a magnitude that may be zero and a denominator that is
// not — `gcd(0, d)` is `d`, which is what canonicalises every zero as `0/1`.
function greatestCommonDivisor(magnitude: bigint, denominator: bigint): bigint {
	while (denominator !== 0n) {
		;[magnitude, denominator] = [denominator, magnitude % denominator]
	}

	return magnitude
}

// NOTE: A decimal is a fraction over a power of ten, so a value has one exactly
// where its reduced denominator divides one — which is to say where it is built
// of twos and fives and nothing else. Null for every other value, since a
// rounded decimal would be a different number than the one that was written.
//
// A whole value keeps one place — `2.0/2` is written back as `1.0` rather than
// as `1`, which is an Integer and no longer the Rational the Literal was.
function decimalSpelling({ numerator, denominator }: Rational): string | null {
	let remaining = denominator
	let twos = 0
	let fives = 0

	while (remaining % 2n === 0n) {
		remaining /= 2n
		twos += 1
	}

	while (remaining % 5n === 0n) {
		remaining /= 5n
		fives += 1
	}

	if (remaining !== 1n) {
		return null
	}

	let places = Math.max(twos, fives, 1)
	let scaled = (numerator * 10n ** BigInt(places)) / denominator
	let negative = scaled < 0n
	let digits = `${negative ? -scaled : scaled}`.padStart(places + 1, "0")

	return `${negative ? "-" : ""}${digits.slice(0, -places)}.${digits.slice(-places)}`
}

function digitsOf(run: string): string {
	return run.replaceAll("_", "")
}
