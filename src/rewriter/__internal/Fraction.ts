import { Fraction, Irreducible } from "bigint-fraction"

import type { IntegerType } from "./Integer"

export type FractionType = { $type: "Fraction"; fraction: Fraction }

export function createFraction(numerator: bigint, denominator: bigint): FractionType {
	return { $type: "Fraction", fraction: new Fraction(numerator, denominator) }
}

export function divide__overload$1(numerator: FractionType, denominator: FractionType): FractionType {
	let numerator1 = numerator.fraction.numerator
	let denominator1 = numerator.fraction.denominator
	let numerator2 = denominator.fraction.numerator
	let denominator2 = denominator.fraction.denominator

	return createFraction(numerator1 * denominator2, denominator1 * numerator2)
}

export function divide__overload$2(numerator: FractionType, denominator: IntegerType): FractionType {
	let fraction = numerator.fraction.clone()

	fraction.divide(denominator.value)

	return { $type: "Fraction", fraction }
}
