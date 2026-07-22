import type { Fraction } from "bigint-fraction"

import { is as algebraicIs } from "./Algebraic"
import { is as boolIs } from "./Boolean"
import type { IntegerType } from "./Integer"
import { is as integerIs } from "./Integer"
import { is as listIs } from "./List"
import { is as rationalIs } from "./Rational"
import type { RecordType } from "./Record"
import { is as recordIs } from "./Record"
import { is as stringIs } from "./String"
import { is as transcendentalIs } from "./Transcendental"
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
		return stringIs(a, b).value
	} else if (
		a[typeKeySymbol] === "Integer" &&
		b[typeKeySymbol] === "Integer"
	) {
		return integerIs(a, b).value
	} else if (
		a[typeKeySymbol] === "Rational" &&
		b[typeKeySymbol] === "Rational"
	) {
		return rationalIs(a, b).value
	} else if (
		a[typeKeySymbol] === "Algebraic" &&
		b[typeKeySymbol] === "Algebraic"
	) {
		return algebraicIs(a, b).value
	} else if (
		a[typeKeySymbol] === "Transcendental" &&
		b[typeKeySymbol] === "Transcendental"
	) {
		return transcendentalIs(a, b).value
	} else if (
		a[typeKeySymbol] === "Record" && //
		b[typeKeySymbol] === "Record"
	) {
		return recordIs(a, b).value
	} else if (
		a[typeKeySymbol] === "List" && //
		b[typeKeySymbol] === "List"
	) {
		return listIs(a, b).value
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
