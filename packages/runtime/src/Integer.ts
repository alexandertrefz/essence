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

// NOTE: An Integer is HYBRID. It holds a JavaScript number while its value is
// one a double holds exactly — `|value| ≤ 2⁵³ − 1` — and a bigint beyond that,
// so the ordinary Integer costs a double in a field rather than a heap bigint
// and the unbounded ones stay exact.
//
// NOTE: THE CANONICAL INVARIANT, which everything below and every emitted
// arithmetic site leans on: a value in safe range is ALWAYS a number and a
// value outside it is ALWAYS a bigint. One mathematical Integer therefore has
// exactly ONE representation — which is what lets the Compiler emit `===` for
// equality, what lets an operation check its own ANSWER rather than reason
// about its operands, and what makes `0` a number everywhere so that a test
// against zero can be written with one.
export type IntegerType = {
	[typeKeySymbol]: "Integer"
	value: number | bigint
}

// NOTE: `Number.MAX_SAFE_INTEGER`, spelled as itself so the bound is readable
// and as a bigint so the escaped side compares without converting. The
// Compiler writes the same bound into every emitted arithmetic guard;
// `src/tests/hybridIntegers.spec.ts` in the compiler holds the two to each
// other.
const SAFE = Number.MAX_SAFE_INTEGER
const SAFE_AS_BIG = 9007199254740991n
const LEAST_SAFE_AS_BIG = -9007199254740991n

// NOTE: THE one place the invariant is established. Everything that builds an
// Integer — a literal, a native, the client bridge, an escaped arithmetic
// result — comes through here, and hands over whichever representation it
// happened to compute in.
export function createInteger(value: number | bigint): IntegerType {
	return { [typeKeySymbol]: "Integer", value: canonical(value) }
}

// NOTE: `createInteger` for the client bridge, and through it every host that
// builds an Integer out of a JavaScript number of its own. `createInteger`
// establishes the canonical invariant but NOT integrality — nothing inside this
// package or in emitted code can reach it with a fraction, and the check would
// sit on the hottest construction path there is — so the door a host comes
// through is where a value from outside is asked to be an Integer at all. A
// `1.5` admitted here is an "Integer" that adds, prints and compares as a
// fraction until the numeric tower converts it and throws about a BigInt.
//
// NOTE: A number past safe range is refused rather than widened, which is what
// the marshaller's own door decides for the same value: `2 ** 53` is a double
// that has already lost whatever made it that, and a host that means an Integer
// that large has a bigint to say so with.
export function createIntegerFrom(value: number | bigint): IntegerType {
	if (typeof value === "number" && !Number.isSafeInteger(value)) {
		throw new Error(
			`${value} is not an Integer a number can hold. Pass a bigint for a value past 2^53 - 1.`,
		)
	}

	return createInteger(value)
}

// NOTE: Both directions. A bigint that fits becomes a number — an escaped
// subtraction landing back in range must not leave a second spelling of a value
// that already has one — and a number that does not fit becomes a bigint, which
// only a runtime handed a value from outside can produce (`2 ** 60` reaching
// `fromJS`), since every operation here checks its own answer.
//
// NOTE: Exported because an inlined counted walk reaches for it directly. Its
// counter is a raw value rather than an Integer wherever the body only reads
// what the Integer holds, and a walk whose bounds sent it to bigint counts
// through values a double holds exactly — so the turn's value is canonicalised
// here rather than by the `createInteger` the elision took away.
//
// NOTE: `BigInt(value)` can not throw on that arm: a double above 2⁵³ has no
// fractional part left to reject.
export function canonical(value: number | bigint): number | bigint {
	if (typeof value === "number") {
		return value >= -SAFE && value <= SAFE ? value : BigInt(value)
	}

	// NOTE: Written as the REFUSAL rather than as the acceptance, and with the
	// upper bound first, so that a value past safe range on the positive side —
	// which is nearly every value that reaches here, since escaping is what
	// growing does — is settled by ONE comparison. A bigint comparison is not
	// cheap: measured at about 8 ns on Bun and 1 ns on V8, and the pair of them
	// was most of what an escaped operation cost over the bigint-only
	// arithmetic it replaced.
	//
	// NOTE: The lower bound is a constant rather than a negation of the upper
	// one: negating a bigint ALLOCATES a bigint, and doing it here would do it
	// once per operation that escaped.
	return value > SAFE_AS_BIG || value < LEAST_SAFE_AS_BIG
		? value
		: Number(value)
}

// NOTE: A value as the escaped arm needs it. `BigInt(value)` would answer the
// same thing, but it is a call the engine does not fold away when the value is
// already a bigint — measured at ~5 ns a side, which is the second largest of
// the things an escaped operation pays over the bigint-only arithmetic it
// replaced. The largest is the range test above.
function escaped(value: number | bigint): bigint {
	return typeof value === "bigint" ? value : BigInt(value)
}

// #region Emitted arithmetic

// NOTE: The three operations the Compiler emits inline. Each is reached two
// ways: as the whole operation, where the operands are expressions the emitted
// guard may not read twice, and as the escape arm of an inlined guard that
// already decided the fast path did not apply. Both hand over the two RAW
// values rather than the Integers holding them, because the inline site has
// them already and neither wants the Integer back.
//
// NOTE: The fast path is the same shape in all three: both operands are
// numbers, the operation is performed as doubles, and the ANSWER is checked
// against safe range. That check is exact rather than approximate. IEEE 754
// `+`, `-` and `*` are correctly rounded, so the double answer is the nearest
// double to the true result; rounding is monotone and 2⁵³ is representable, so
// a true result of magnitude ≥ 2⁵³ can only round to a double of magnitude
// ≥ 2⁵³, which fails the check. A true result inside safe range is exactly
// representable and rounds to itself. So the check passes exactly when the
// double IS the true result — including for a product, where two small factors
// can leave safe range and the rounded product can not sneak back in.
//
// NOTE: Neither arm below canonicalises where the answer is already known to be
// outside safe range, because asking costs two bigint comparisons and asking is
// what an escaped operation spends most of its extra time on. Two arguments say
// when it is known. A pair of NUMBER operands whose double answer failed the
// check had a true answer of magnitude ≥ 2⁵³ — that is the exactness argument
// above, read the other way round — so the bigint answer is outside safe range
// by construction. And a bigint operand is outside safe range by the canonical
// invariant, so a PRODUCT with one can only be `|left · right| ≥ |the bigger|`
// unless the other operand is zero.
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

	// NOTE: A sum with an escaped operand CAN come back inside — the two may
	// very nearly cancel — so this one is asked.
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

	// NOTE: Zero is the number `0` by the invariant and never `0n`, so the one
	// case that CAN answer inside safe range is asked with two comparisons
	// against a double rather than with a range test over a bigint.
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

// NOTE: `0 - value` rather than `-value`, which is the same negation without
// the negative zero: `-0` is a number in safe range and so canonical, and it
// compares and prints as `0` everywhere — but there is no reason to make a
// reader prove that, and no cost to not making one.
export function negate(integer: IntegerType): IntegerType {
	let value = integer.value

	return createInteger(typeof value === "number" ? 0 - value : -value)
}

// NOTE: Native so that the answer can be declared a `NonNegativeInteger`: a
// refinement erases before anything runs, and an Essence body could only
// answer a bare Integer for the arm that negates. The value itself is handed
// back where it is not negative — the same object, since an Integer is never
// changed in place — so the ordinary call allocates nothing. `NonZeroInteger`
// declares this Function again under its own name, where the same answer is a
// `PositiveInteger`.
//
// NOTE: `0` rather than `0n`: an ordering comparison is exact across the two
// representations, so one spelling asks both.
export function absolute(integer: IntegerType): IntegerType {
	return integer.value < 0 ? negate(integer) : integer
}

export function remainder__overload$1(
	integer: IntegerType,
	divisor: IntegerType,
): OptionalType<IntegerType> {
	// NOTE: Zero is in safe range, so by the canonical invariant it is the
	// number `0` and never `0n` — which is why this asks with a number. `0n`
	// would answer `false` for the very value it is looking for.
	if (divisor.value === 0) {
		return createEmpty()
	}

	return createValue(remainder__overload$2(integer, divisor))
}

// NOTE: The divisor of this entry is a `NonZeroInteger` in the source — proven
// while compiling, erased to an Integer here — so there is no empty arm to
// build.
export function remainder__overload$2(
	integer: IntegerType,
	divisor: IntegerType,
): IntegerType {
	let value = integer.value
	let by = divisor.value

	// NOTE: Euclidean remainder — the result is always in
	// `0 ≤ r < |divisor|`, whatever the signs of the operands.
	//
	// NOTE: JavaScript's `%` on doubles is EXACT for integer operands — it is
	// fmod, which is defined as the exact remainder and needs no rounding —
	// so the number arm answers what the bigint arm would.
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

// NOTE: The other half of the same division, and it has to agree with
// `remainder` exactly: `quotient · divisor + remainder` must be the original
// Integer. Since the remainder is Euclidean — never negative — the quotient is
// floored towards negative infinity for a positive divisor rather than
// truncated towards zero, which is where it parts company with JavaScript's
// `/`. `(-7) ÷ 3` is `-3` remainder `2`, not `-2` remainder `-1`.
export function quotient__overload$1(
	integer: IntegerType,
	divisor: IntegerType,
): OptionalType<IntegerType> {
	// NOTE: The number `0`, for the reason `remainder` asks with one.
	if (divisor.value === 0) {
		return createEmpty()
	}

	return createValue(quotient__overload$2(integer, divisor))
}

// NOTE: The divisor of this entry is a `NonZeroInteger` in the source — proven
// while compiling, erased to an Integer here — so there is no empty arm to
// build.
export function quotient__overload$2(
	integer: IntegerType,
	divisor: IntegerType,
): IntegerType {
	let value = integer.value
	let by = divisor.value

	// NOTE: `Math.trunc(a / b)` is EXACT for two safe integers, which is not
	// obvious and is what this arm rests on. The double quotient `x = a/b`
	// carries an error of at most `|x|·2⁻⁵³`, while a non-integer `a/b` sits at
	// least `1/|b|` away from the nearest integer — and `|x|·2⁻⁵³ < 1/|b|` is
	// exactly `|a| < 2⁵³`, which holds for every safe integer. So the rounding
	// can never carry the quotient across an integer boundary, and a quotient
	// that IS an integer is representable and rounds to itself.
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

	// NOTE: A negative remainder means the truncation rounded the wrong way for
	// a Euclidean pairing; step the quotient one towards the divisor's sign.
	if (remainder < 0n) {
		truncated += right < 0n ? 1n : -1n
	}

	return createInteger(truncated)
}

// NOTE: Division by a divisor the Types have already proven not to be zero —
// `NonZeroInteger` erases to an Integer, so the Parameter reads as one here —
// which is why there is no empty arm to build: the check the sibling entries
// open with was made while compiling.
export function divide__overload$4(
	integer: IntegerType,
	divisor: IntegerType,
): RationalType {
	return createRational(escaped(integer.value), escaped(divisor.value))
}

// NOTE: Raised in bigint whatever the operands hold. `**` on doubles is
// `Math.pow`, which the specification only requires to be APPROXIMATED — the
// correctly-rounded argument the three inlined operations rest on does not
// cover it, so a double power can not be checked after the fact the way a
// product can.
//
// NOTE: The power itself, for every pair it is defined at — a non-negative
// exponent answers a whole number and a negative one the exact reciprocal. The
// one pair with no power at all, zero to a negative exponent, is decided by
// each entry before it reads this. `NonZeroInteger.raise` is this Function
// under that Namespace's name: a base that is not zero has every power.
export function power(
	base: IntegerType,
	exponent: IntegerType,
): IntegerType | RationalType {
	// NOTE: `0` rather than `0n`: an ordering comparison is exact across the
	// two representations, so one spelling asks both.
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

// NOTE: The exponent of this entry is a `NonNegativeInteger` in the source —
// proven while compiling, erased to an Integer here — so the reciprocal arm
// above is unreachable and the answer is always whole. It holds the whole power
// rather than reading it back out of the Optional entry, which is the direction
// `remainder` and `quotient` pair their two entries in as well.
export function raise__overload$3(
	base: IntegerType,
	exponent: IntegerType,
): IntegerType {
	return createInteger(escaped(base.value) ** escaped(exponent.value))
}

// #endregion

// NOTE: A number's own `toString` reaches for exponential notation at 1e21,
// which would spell an Integer in a way the language never writes — but a
// number-held Integer is at most 2⁵³ − 1, five orders of magnitude below that,
// so the decimal spelling is the only one either representation produces.
export function toString__overload$1(integer: IntegerType): StringType {
	return createString(integer.value.toString())
}

// #region Radix

// NOTE: The digits every base writes, in value order: `0` through `9` and then
// `a` through `z`, which is the alphabet `Number.prototype.toString` and every
// peer's radix printer already agree on. Thirty-six of them is what fixes the
// highest base.
const RADIX_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"

const LOWEST_RADIX = 2
const HIGHEST_RADIX = 36

// NOTE: The base is read as a count rather than as a mode, so a value outside
// what any positional notation can write is brought to the nearest edge rather
// than refused. Both entries clamp through here, which is what keeps the pair
// a round trip at every base a Program can write down.
function radixOf(base: IntegerType): number {
	const value = Number(base.value)

	if (value < LOWEST_RADIX) {
		return LOWEST_RADIX
	}

	return value > HIGHEST_RADIX ? HIGHEST_RADIX : value
}

// NOTE: `value.toString(radix)` is exact for both representations: a bigint
// converts digit by digit, and a number-held Integer is a safe integer, which
// has no fractional part for the conversion to approximate.
export function toString__overload$8(
	integer: IntegerType,
	base: IntegerType,
): StringType {
	return createString(integer.value.toString(radixOf(base)))
}

// NOTE: Native, because the digits have to be read at the base the call names
// and accumulated in bigint. `parseInt` reads a radix and answers a double, so
// it loses every Integer past 2⁵³ — which is exactly the range this Type is
// unbounded for.
//
// NOTE: The same shape the base-less entry reads, at every base: a sign in
// front, and an underscore between two digits and nowhere else. A capital digit
// reads as its lowercase besides, since the printer writes lowercase and a
// Program pasting a hexadecimal constant from anywhere else has capitals in it.
// The two entries of one Overload reading one text two ways is what this
// avoids. Nothing else is lenient: a sign anywhere but the front, a digit the
// base has no room for, and the empty text each answer nothing.
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

// NOTE: Euclid's algorithm, imported from `bigRational.ts` rather than written
// again: the reduction every Rational runs is the same walk, and the sign is
// taken off both operands there. A gcd is never negative, which is the promise
// `NonNegativeInteger` carries in the declaration.
export function greatestCommonDivisor(
	integer: IntegerType,
	other: IntegerType,
): IntegerType {
	return createInteger(
		greatestCommonDivisorOf(escaped(integer.value), escaped(other.value)),
	)
}

// NOTE: `|a · b| / gcd(a, b)`, with the gcd divided out of the product rather
// than out of an operand first. Both operands are bigints here, so the product
// can not overflow, and dividing after keeps the one division exact.
//
// NOTE: Zero has no multiple above zero, so a zero operand answers zero. That
// is the value every peer answers, and it keeps `lcm · gcd = |a · b|` true for
// every pair.
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
	// NOTE: `0` rather than `0n`, for the reason `remainder` asks with one.
	if (integer.value < 0) {
		return createEmpty()
	}

	return createValue(createInteger(factorialOf(escaped(integer.value))))
}

// NOTE: The product built upwards, one multiplication per step. A halving
// product tree is asymptotically faster and is what a factorial big enough to
// notice would want; the crossover is past what a Program that calls this
// waits for, and the loop is what a reader checks in one breath.
function factorialOf(value: bigint): bigint {
	let product = 1n

	for (let factor = 2n; factor <= value; factor++) {
		product *= factor
	}

	return product
}

// NOTE: The first twelve primes, which are the witnesses a deterministic
// Miller-Rabin test needs to decide every Integer below
// 3,317,044,064,679,887,385,961,981 — the bound Sorenson and Webster proved
// for this set. Above it the test is a strong probable-prime test over the
// same twelve, and the declaration says so.
const PRIME_WITNESSES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]

// NOTE: Trial division decides the small cases the witnesses would otherwise
// have to be run for, and it is what makes the common answer — a small
// composite — cost one or two remainders rather than twelve modular
// exponentiations.
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

	// NOTE: `value - 1 = odd · 2^exponent`, the decomposition every witness is
	// tested against. The value is odd here, since 2 is a witness above.
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

// NOTE: Square-and-multiply, which is what keeps the test logarithmic in the
// exponent. `base ** exponent % modulus` would build the whole power first, and
// for a value of any size that is a bigint with more digits than memory holds.
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

	// NOTE: A negative has no real root, and `squareRootOfRational` has already
	// said so — this hands its answer on rather than deciding again.
	if (root[typeKeySymbol] === "Optional#Empty") {
		return root
	}

	const value = root.item

	if (value[typeKeySymbol] === "Rational") {
		// NOTE: A whole number's exact root is whole — surface it as one.
		return createValue(createInteger(value.numerator))
	}

	return createValue(value)
}

// #endregion

// NOTE: `<` and `>` are defined across a number and a bigint and decide the
// MATHEMATICAL order, without converting either side — so one pair of tests
// answers for all four pairings of the two representations.
//
// NOTE: Same-kind ordering stays native deliberately. Routing it through the
// covering `Number.compare` reads better, but that Method decides every
// cross-kind cell, so comparing two Integers would drag the Algebraic,
// Transcendental and Rational machinery into any Program that compares two
// Integers, which is nearly all of them. `is` and the inequalities are still
// written in Essence on top of this.
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
