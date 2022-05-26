import type { NumberType } from "./Number"

export function getRawNumber(number: NumberType): number {
	return +number.value
}
