import type { Fraction } from "bigint-fraction"

import type { BooleanType } from "./Boolean"
import { is as boolIs, createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { RecordType } from "./Record"
import { is as recordIs } from "./Record"
import type { AnyType } from "./type"
import { typeKeySymbol } from "./type"

export function getInt32(number: IntegerType): number {
	return Number(BigInt.asIntN(32, number.value))
}

export function isFirstRationalBigger(
	firstRational: Fraction,
	secondRational: Fraction,
): boolean {
	if (firstRational.denominator === secondRational.denominator) {
		return firstRational.numerator > secondRational.numerator
	} else {
		return (
			firstRational.numerator * secondRational.denominator >
			secondRational.numerator * firstRational.denominator
		)
	}
}

export function anyIs(a: AnyType, b: AnyType): boolean {
	// NOTE: A Function is the one runtime value carrying no Type key — it is
	// emitted as a bare JavaScript function, not a tagged object — so it is
	// answered before anything reads that key. Without this, comparing a
	// Record that merely HOLDS a Function threw on the missing key rather than
	// answering, which made `value is value` a crash instead of `true`.
	//
	// NOTE: Identity, not structure. Two Functions written the same are still
	// two Functions, and deciding otherwise is not decidable — but a Function
	// IS equal to itself, which is the promise `is` makes everywhere else.
	if (typeof a === "function" || typeof b === "function") {
		return a === b
	}

	if (
		a[typeKeySymbol] === "Nothing" && //
		b[typeKeySymbol] === "Nothing"
	) {
		return true
	} else if (
		a[typeKeySymbol] === "Boolean" &&
		b[typeKeySymbol] === "Boolean"
	) {
		return boolIs(a, b).value
	} else if (
		a[typeKeySymbol] === "String" && //
		b[typeKeySymbol] === "String"
	) {
		// NOTE: String.is is written in Essence now — it reads `compareTo`,
		// which is lexicographic by code point and answers `Equal` exactly for
		// two Strings of the same code points. Compare the runtime
		// representation directly rather than importing the deleted native.
		return a.value === b.value
	} else if (
		a[typeKeySymbol] === "Integer" &&
		b[typeKeySymbol] === "Integer"
	) {
		// NOTE: Integer.is is written in Essence now; compare the runtime
		// representation directly rather than importing the deleted native.
		return a.value === b.value
	} else if (
		a[typeKeySymbol] === "Rational" &&
		b[typeKeySymbol] === "Rational"
	) {
		// NOTE: Rational.is is written in Essence now — it reads `compareTo`,
		// which cross-multiplies. Compare the runtime representation the same
		// way rather than importing the deleted native; cross-multiplication
		// answers for unreduced Fractions too, and denominators are kept
		// positive by `createRational`.
		return (
			a.rational.numerator * b.rational.denominator ===
			b.rational.numerator * a.rational.denominator
		)
	} else if (
		a[typeKeySymbol] === "Algebraic" &&
		b[typeKeySymbol] === "Algebraic"
	) {
		// NOTE: Algebraic.is is written in Essence now — it reads `compareTo`,
		// which decides the sign of the difference symbolically. Normal forms
		// make that the same answer as comparing the representation directly,
		// which is what the deleted native did.
		return (
			a.radicand === b.radicand &&
			a.rationalPartNumerator === b.rationalPartNumerator &&
			a.rationalPartDenominator === b.rationalPartDenominator &&
			a.radicalCoefficientNumerator === b.radicalCoefficientNumerator &&
			a.radicalCoefficientDenominator === b.radicalCoefficientDenominator
		)
	} else if (
		a[typeKeySymbol] === "Transcendental" &&
		b[typeKeySymbol] === "Transcendental"
	) {
		// NOTE: Transcendental.is is written in Essence now — it reads the
		// `Number` Union's `is`, whose Transcendental/Transcendental cell is
		// exact. Canonical forms make that the same answer as comparing the
		// representation directly, which is what the deleted native did.
		return (
			a.rationalPartNumerator === b.rationalPartNumerator &&
			a.rationalPartDenominator === b.rationalPartDenominator &&
			a.piCoefficientNumerator === b.piCoefficientNumerator &&
			a.piCoefficientDenominator === b.piCoefficientDenominator
		)
	} else if (
		a[typeKeySymbol] === "Record" && //
		b[typeKeySymbol] === "Record"
	) {
		return recordIs(a, b).value
	} else if (
		a[typeKeySymbol] === "List" && //
		b[typeKeySymbol] === "List"
	) {
		// NOTE: List.is takes a conformance witness now — equality of a List is
		// its items' own equality — and there is no witness to hand it here.
		// Recurse through this same universal comparison instead, which is what
		// the native did before the witness arrived.
		if (a.value.length !== b.value.length) {
			return false
		}

		for (let index = 0; index < a.value.length; index++) {
			if (!anyIs(a.value[index], b.value[index])) {
				return false
			}
		}

		return true
	} else if (
		a[typeKeySymbol].includes("#") &&
		a[typeKeySymbol] === b[typeKeySymbol]
	) {
		// NOTE: Case values (`Ordering#Less`, `CalculatorOperation#Add`) —
		// the tag decides the Case (nominal), the payload members compare
		// structurally like a Record's.
		return recordIs(a as unknown as RecordType, b as unknown as RecordType)
			.value
	} else {
		return false
	}
}

export function anyIsNot(a: AnyType, b: AnyType): boolean {
	return !anyIs(a, b)
}

// NOTE: The runtime half of a Choice's derived `Equatable` conformance — what
// `Colour::is` compiles to when no Namespace writes one. `anyIs` already
// answers exactly what a derived equality should: the tag decides the Case
// nominally, and a payload compares as the Record it is. These two exist so
// the derived Methods have something with a Method's shape to bind to —
// `anyIs` answers a raw JavaScript boolean, and an Essence `-> Boolean` has to
// hand back a Boolean value.
export function choiceIs(a: AnyType, b: AnyType): BooleanType {
	return createBoolean(anyIs(a, b))
}

export function choiceIsNot(a: AnyType, b: AnyType): BooleanType {
	return createBoolean(!anyIs(a, b))
}
