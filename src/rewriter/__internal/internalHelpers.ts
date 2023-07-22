import { IntegerType } from "./Integer"

export function getInt32(number: IntegerType): number {
	return Number(BigInt.asIntN(32, number.value))
}
