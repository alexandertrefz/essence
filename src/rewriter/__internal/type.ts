import { common } from "../../interfaces"
import type { BooleanType } from "./Boolean"
import type { FractionType } from "./Fraction"
import type { IntegerType } from "./Integer"
import type { ListType } from "./List"
import type { StringType } from "./String"

export const typeKeySymbol = Symbol("$type")

// TODO: Handle Record Types
export function isValueOfType(
	value:
		| common.Type
		| ListType<unknown>
		| StringType
		| IntegerType
		| FractionType
		| BooleanType,
	type: common.Type,
) {
	if (typeKeySymbol in value) {
		if (type.type === "Primitive") {
			return value[typeKeySymbol] === type.primitive
		} else {
			console.log("Complex type checking has yet to be implemented!")
		}
	} else {
		console.log("Complex type checking has yet to be implemented!")
	}
}
