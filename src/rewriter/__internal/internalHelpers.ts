import { Fraction } from "bigint-fraction"

import type { IntegerType } from "./Integer"
import type { AnyType } from "./type"

import { typeKeySymbol } from "./type"

import { is as boolIs } from "./Boolean"
import { is as fractionIs } from "./Fraction"
import { is as integerIs } from "./Integer"
import { is as listIs } from "./List"
import { is as recordIs } from "./Record"
import { is as stringIs } from "./String"

export function getInt32(number: IntegerType): number {
	return Number(BigInt.asIntN(32, number.value))
}

export function isFirstFractionBigger(
	firstFraction: Fraction,
	secondFraction: Fraction,
): boolean {
	if (firstFraction.denominator === secondFraction.denominator) {
		return firstFraction.numerator > secondFraction.numerator
	} else {
		return (
			firstFraction.numerator * secondFraction.denominator >
			secondFraction.numerator * firstFraction.denominator
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
		a[typeKeySymbol] === "Fraction" &&
		b[typeKeySymbol] === "Fraction"
	) {
		return fractionIs(a, b).value
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
	} else {
		return false
	}
}

export function anyIsNot(a: AnyType, b: AnyType): boolean {
	return !anyIs(a, b)
}
