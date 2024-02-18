import type { BooleanType } from "./Boolean"
import type { FractionType } from "./Fraction"
import type { IntegerType } from "./Integer"
import type { ListType } from "./List"
import type { NothingType } from "./Nothing"
import type { RecordType } from "./Record"
import type { StringType } from "./String"

import { common } from "../../interfaces"

export const typeKeySymbol = Symbol("$type")

export type AnyType =
	| RecordType
	| ListType<any>
	| StringType
	| IntegerType
	| FractionType
	| BooleanType
	| NothingType

// TODO: Handle Record Types
export function isValueOfType(value: AnyType, type: common.Type) {
	if (type.type === "Primitive") {
		return value[typeKeySymbol] === type.primitive
	} else {
		console.log("Complex type checking has yet to be implemented!")
		return false
	}
}
