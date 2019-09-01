import { NumberType } from "./Number"

export function getRawNumber(number: NumberType): number {
	return +number.value
}
