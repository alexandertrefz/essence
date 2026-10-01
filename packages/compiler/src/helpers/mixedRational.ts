// `1.5/2`, a Rational written as a fraction and a decimal at once, and the value
// the two spellings say together, written back each way. The Parser's Help and
// the language server's Quick Fix both ask here, so they offer the same number.

const decimalOverFractionPattern =
	/^(-?[0-9][0-9_]*)\.([0-9][0-9_]*)\/([0-9][0-9_]*)$/
const fractionOverDecimalPattern =
	/^(-?[0-9][0-9_]*)\/([0-9][0-9_]*)\.([0-9][0-9_]*)$/

type Rational = { numerator: bigint; denominator: bigint }

// Both spellings of the written value, the fraction first. A value with no
// terminating decimal, such as `1.5/7`, has only the fraction. Empty where the
// text is not a mixed Literal.
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

// `A.B/C` is `AB` over `10^len(B) · C`, and `A/B.C` is `A · 10^len(C)` over
// `BC`. Reduced to lowest terms, so what is offered back is the number rather
// than the digits it was typed as.
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

// `gcd(0, d)` is `d`, so every zero reduces to `0/1`.
function greatestCommonDivisor(magnitude: bigint, denominator: bigint): bigint {
	while (denominator !== 0n) {
		;[magnitude, denominator] = [denominator, magnitude % denominator]
	}

	return magnitude
}

// A value has a decimal exactly where its reduced denominator holds no prime
// but two and five. Null for every other value, since a rounded decimal is a
// different number. A whole value keeps one place: `2.0/2` is `1.0`, not the
// Integer `1`.
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
