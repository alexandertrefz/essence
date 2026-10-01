import type { AlgebraicType } from "./Algebraic"
import {
	dividedInto as algebraicDividedInto,
	squareRootOfRational,
} from "./Algebraic"
import { greatestCommonDivisor as greatestCommonDivisorOf } from "./bigRational"
import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { RationalType } from "./Rational"
import { createRational } from "./Rational"
import type { StringType } from "./String"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

// A number while a double holds the value exactly, and a bigint beyond that.
// INVARIANT: a value in the safe range is always a number. See "Integers" in
// DEVELOPMENT.md.
export type IntegerType = {
	[typeKeySymbol]: "Integer"
	value: number | bigint
}

// The safe bound, also as bigints so the escaped side compares without
// converting. The Compiler's emitted guards write the same bound.
const SAFE = Number.MAX_SAFE_INTEGER
const SAFE_AS_BIG = 9007199254740991n
const LEAST_SAFE_AS_BIG = -9007199254740991n

// Every Integer is built here, in whichever representation it was computed.
export function createInteger(value: number | bigint): IntegerType {
	return { [typeKeySymbol]: "Integer", value: canonical(value) }
}

// `createInteger` for a host, refusing a fraction and a number past the safe
// range. A host that means a larger Integer passes a bigint.
export function createIntegerFrom(value: number | bigint): IntegerType {
	if (typeof value === "number" && !Number.isSafeInteger(value)) {
		throw new Error(
			`${value} is not an Integer a number can hold. Pass a bigint for a value past 2^53 - 1.`,
		)
	}

	return createInteger(value)
}

// The value in its one representation, converting either way. An inlined
// counted walk calls it on its raw counter. `BigInt` can not throw here, since a
// double past 2⁵³ is whole.
export function canonical(value: number | bigint): number | bigint {
	if (typeof value === "number") {
		return value >= -SAFE && value <= SAFE ? value : BigInt(value)
	}

	// The upper bound first, since most values here have grown past it. The
	// lower bound is a constant, since negating a bigint allocates.
	return value > SAFE_AS_BIG || value < LEAST_SAFE_AS_BIG
		? value
		: Number(value)
}

// A value as a bigint. The engine does not fold away `BigInt` on a value that
// is one already.
function escaped(value: number | bigint): bigint {
	return typeof value === "bigint" ? value : BigInt(value)
}

// #region Emitted arithmetic

// The operations the Compiler emits inline, over raw values. A double answer
// inside the safe range is exact. See "Integer arithmetic" in DEVELOPMENT.md.
export function sum(
	left: number | bigint,
	right: number | bigint,
): IntegerType {
	if (typeof left === "number" && typeof right === "number") {
		let answer = left + right

		if (answer >= -SAFE && answer <= SAFE) {
			return { [typeKeySymbol]: "Integer", value: answer }
		}

		return {
			[typeKeySymbol]: "Integer",
			value: BigInt(left) + BigInt(right),
		}
	}

	// The operands may nearly cancel, so the answer is canonicalised.
	return createInteger(escaped(left) + escaped(right))
}

export function difference(
	left: number | bigint,
	right: number | bigint,
): IntegerType {
	if (typeof left === "number" && typeof right === "number") {
		let answer = left - right

		if (answer >= -SAFE && answer <= SAFE) {
			return { [typeKeySymbol]: "Integer", value: answer }
		}

		return {
			[typeKeySymbol]: "Integer",
			value: BigInt(left) - BigInt(right),
		}
	}

	return createInteger(escaped(left) - escaped(right))
}

export function product(
	left: number | bigint,
	right: number | bigint,
): IntegerType {
	if (typeof left === "number" && typeof right === "number") {
		let answer = left * right

		if (answer >= -SAFE && answer <= SAFE) {
			return { [typeKeySymbol]: "Integer", value: answer }
		}

		return {
			[typeKeySymbol]: "Integer",
			value: BigInt(left) * BigInt(right),
		}
	}

	// Zero is the one factor that brings a bigint product back into range.
	if (left === 0 || right === 0) {
		return { [typeKeySymbol]: "Integer", value: 0 }
	}

	return {
		[typeKeySymbol]: "Integer",
		value: escaped(left) * escaped(right),
	}
}

// #endregion

// #region Add

export function add__overload$1(
	originalNumber: IntegerType,
	other: IntegerType,
): IntegerType {
	return sum(originalNumber.value, other.value)
}

// #endregion

// #region Multiply

export function multiply__overload$1(
	originalNumber: IntegerType,
	other: IntegerType,
): IntegerType {
	return product(originalNumber.value, other.value)
}

// #endregion

// #region Everyday methods

// `0 - value`, since `-value` answers a negative zero for zero.
export function negate(integer: IntegerType): IntegerType {
	let value = integer.value

	return createInteger(typeof value === "number" ? 0 - value : -value)
}

// Native so that its Type can promise a `NonNegativeInteger`. A value that is
// not negative is answered as itself.
export function absolute(integer: IntegerType): IntegerType {
	return integer.value < 0 ? negate(integer) : integer
}

export function remainder__overload$1(
	integer: IntegerType,
	divisor: IntegerType,
): OptionalType<IntegerType> {
	// Zero is always the number `0`, so `0n` would never match.
	if (divisor.value === 0) {
		return createEmpty()
	}

	return createValue(remainder__overload$2(integer, divisor))
}

// The divisor is a proven `NonZeroInteger`, so there is no empty arm.
export function remainder__overload$2(
	integer: IntegerType,
	divisor: IntegerType,
): IntegerType {
	let value = integer.value
	let by = divisor.value

	// Euclidean: `0 ≤ r < |divisor|`. `%` on two whole doubles is exact.
	if (typeof value === "number" && typeof by === "number") {
		let remainder = value % by

		return createInteger(
			remainder < 0 ? remainder + (by < 0 ? -by : by) : remainder,
		)
	}

	let left = escaped(value)
	let right = escaped(by)
	let remainder = left % right

	if (remainder < 0n) {
		remainder += right < 0n ? -right : right
	}

	return createInteger(remainder)
}

// The quotient that pairs with the Euclidean remainder, so `(-7) ÷ 3` is `-3`
// rather than JavaScript's `-2`.
export function quotient__overload$1(
	integer: IntegerType,
	divisor: IntegerType,
): OptionalType<IntegerType> {
	// Zero is always the number `0`.
	if (divisor.value === 0) {
		return createEmpty()
	}

	return createValue(quotient__overload$2(integer, divisor))
}

// The divisor is a proven `NonZeroInteger`, so there is no empty arm.
export function quotient__overload$2(
	integer: IntegerType,
	divisor: IntegerType,
): IntegerType {
	let value = integer.value
	let by = divisor.value

	// `Math.trunc(a / b)` is exact for two safe integers. See "Integer
	// arithmetic" in DEVELOPMENT.md.
	if (typeof value === "number" && typeof by === "number") {
		let truncated = Math.trunc(value / by)
		let remainder = value % by

		return createInteger(
			remainder < 0 ? truncated + (by < 0 ? 1 : -1) : truncated,
		)
	}

	let left = escaped(value)
	let right = escaped(by)
	let truncated = left / right
	let remainder = left % right

	// A negative remainder means truncation rounded the wrong way for a
	// Euclidean pairing.
	if (remainder < 0n) {
		truncated += right < 0n ? 1n : -1n
	}

	return createInteger(truncated)
}

// The divisor is a proven `NonZeroInteger`, so there is no empty arm.
export function divide__overload$4(
	integer: IntegerType,
	divisor: IntegerType,
): RationalType {
	return createRational(escaped(integer.value), escaped(divisor.value))
}

// Raised in bigint, since `**` on doubles need only approximate. A negative
// exponent answers the exact reciprocal. Each caller rules out zero to a
// negative exponent first.
export function power(
	base: IntegerType,
	exponent: IntegerType,
): IntegerType | RationalType {
	return exponent.value >= 0
		? raise__overload$3(base, exponent)
		: createRational(1n, escaped(base.value) ** -escaped(exponent.value))
}

export function raise__overload$1(
	base: IntegerType,
	exponent: IntegerType,
): OptionalType<IntegerType | RationalType> {
	if (base.value === 0 && exponent.value < 0) {
		return createEmpty()
	}

	return createValue(power(base, exponent))
}

// The exponent is a proven `NonNegativeInteger`, so the power is whole.
export function raise__overload$3(
	base: IntegerType,
	exponent: IntegerType,
): IntegerType {
	return createInteger(escaped(base.value) ** escaped(exponent.value))
}

// #endregion

// A number switches to exponential notation only at 1e21, far past the safe
// range.
export function toString__overload$1(integer: IntegerType): StringType {
	return createString(integer.value.toString())
}

// #region Radix

// The digits of every base in value order, as `Number.prototype.toString`
// writes them. Their count fixes the highest base.
const RADIX_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"

const LOWEST_RADIX = 2
const HIGHEST_RADIX = 36

// A base outside 2 to 36 is clamped to the nearest edge. Printing and parsing
// both clamp here, so the pair round-trips at every base.
function radixOf(base: IntegerType): number {
	const value = Number(base.value)

	if (value < LOWEST_RADIX) {
		return LOWEST_RADIX
	}

	return value > HIGHEST_RADIX ? HIGHEST_RADIX : value
}

// `toString(radix)` is exact for both representations, since a number here is
// a safe integer.
export function toString__overload$8(
	integer: IntegerType,
	base: IntegerType,
): StringType {
	return createString(integer.value.toString(radixOf(base)))
}

// Accumulates in bigint, since `parseInt` answers a double. It reads what the
// base-less entry reads: a sign in front and an underscore between two digits.
// A capital digit reads as lowercase. Anything else answers nothing.
export function parse__overload$3(
	text: StringType,
	base: IntegerType,
): OptionalType<IntegerType> {
	const radix = BigInt(radixOf(base))
	const signed = text.value
	const negative = signed.startsWith("-")
	const digits = negative || signed.startsWith("+") ? signed.slice(1) : signed

	if (
		digits.length === 0 ||
		digits.startsWith("_") ||
		digits.endsWith("_") ||
		digits.includes("__")
	) {
		return createEmpty()
	}

	let magnitude = 0n

	for (const character of digits) {
		if (character === "_") {
			continue
		}

		const digit = RADIX_DIGITS.indexOf(character.toLowerCase())

		if (digit < 0 || BigInt(digit) >= radix) {
			return createEmpty()
		}

		magnitude = magnitude * radix + BigInt(digit)
	}

	return createValue(createInteger(negative ? -magnitude : magnitude))
}

// #endregion

// #region Number theory

// The walk every Rational's reduction runs. It is never negative, as its Type
// promises.
export function greatestCommonDivisor(
	integer: IntegerType,
	other: IntegerType,
): IntegerType {
	return createInteger(
		greatestCommonDivisorOf(escaped(integer.value), escaped(other.value)),
	)
}

// `|a · b| / gcd(a, b)` in bigint. A zero operand answers zero, which keeps
// `lcm · gcd = |a · b|` for every pair.
export function leastCommonMultiple(
	integer: IntegerType,
	other: IntegerType,
): IntegerType {
	const left = escaped(integer.value)
	const right = escaped(other.value)

	if (left === 0n || right === 0n) {
		return createInteger(0)
	}

	const product = left * right

	return createInteger(
		(product < 0n ? -product : product) /
			greatestCommonDivisorOf(left, right),
	)
}

export function factorial__overload$1(
	integer: IntegerType,
): OptionalType<IntegerType> {
	if (integer.value < 0) {
		return createEmpty()
	}

	return createValue(createInteger(factorialOf(escaped(integer.value))))
}

// The product built upwards, one multiplication per step.
function factorialOf(value: bigint): bigint {
	let product = 1n

	for (let factor = 2n; factor <= value; factor++) {
		product *= factor
	}

	return product
}

// The witnesses of the Miller-Rabin test. See "Integer arithmetic" in
// DEVELOPMENT.md.
const PRIME_WITNESSES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]

// Trial division by the witnesses settles a small composite first.
export function isPrime(integer: IntegerType): BooleanType {
	const value = escaped(integer.value)

	if (value < 2n) {
		return createBoolean(false)
	}

	for (const witness of PRIME_WITNESSES) {
		if (value === witness) {
			return createBoolean(true)
		}

		if (value % witness === 0n) {
			return createBoolean(false)
		}
	}

	// `value - 1 = odd · 2^exponent`. The value is odd, since 2 divides none
	// that reach here.
	let odd = value - 1n
	let exponent = 0n

	while (odd % 2n === 0n) {
		odd /= 2n
		exponent++
	}

	for (const witness of PRIME_WITNESSES) {
		if (!isStrongProbablePrime(value, witness, odd, exponent)) {
			return createBoolean(false)
		}
	}

	return createBoolean(true)
}

function isStrongProbablePrime(
	value: bigint,
	witness: bigint,
	odd: bigint,
	exponent: bigint,
): boolean {
	let residue = modularPower(witness, odd, value)

	if (residue === 1n || residue === value - 1n) {
		return true
	}

	for (let step = 1n; step < exponent; step++) {
		residue = (residue * residue) % value

		if (residue === value - 1n) {
			return true
		}
	}

	return false
}

// Square-and-multiply, rather than building the whole power first.
function modularPower(base: bigint, exponent: bigint, modulus: bigint): bigint {
	let result = 1n
	let factor = base % modulus
	let remaining = exponent

	while (remaining > 0n) {
		if (remaining % 2n === 1n) {
			result = (result * factor) % modulus
		}

		factor = (factor * factor) % modulus
		remaining /= 2n
	}

	return result
}

// #endregion

// #region Irrational operands

export function divide__overload$3(
	integer: IntegerType,
	algebraic: AlgebraicType,
): AlgebraicType | RationalType {
	return algebraicDividedInto(algebraic, integer)
}

export function squareRoot__overload$1(
	integer: IntegerType,
): OptionalType<IntegerType | AlgebraicType> {
	const root = squareRootOfRational({
		numerator: escaped(integer.value),
		denominator: 1n,
	})

	// A negative has no real root.
	if (root[typeKeySymbol] === "Optional#Empty") {
		return root
	}

	const value = root.item

	if (value[typeKeySymbol] === "Rational") {
		// A whole number's exact root is whole.
		return createValue(createInteger(value.numerator))
	}

	return createValue(value)
}

// #endregion

// `<` and `>` compare a number and a bigint exactly. Native rather than
// `Number.compare`, which would bring in the whole numeric tower.
export function compare(
	originalInteger: IntegerType,
	otherInteger: IntegerType,
): OrderingType {
	if (originalInteger.value < otherInteger.value) {
		return less
	} else if (originalInteger.value > otherInteger.value) {
		return greater
	} else {
		return equal
	}
}
