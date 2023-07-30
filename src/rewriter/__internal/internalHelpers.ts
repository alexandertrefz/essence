import { Fraction } from "bigint-fraction"

import { IntegerType } from "./Integer"

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
