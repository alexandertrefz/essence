import type { ListType } from "./List";
import type { StringType } from "./String";
import type { IntegerType } from "./Integer";
import type { FractionType } from "./Fraction";
import type { BooleanType } from "./Boolean";
import { common } from "../../interfaces";

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
	if ("$type" in value) {
		if (type.type === "Primitive") {
			return value.$type === type.primitive;
		} else {
			console.log("Complex type checking has yet to be implemented!");
		}
	} else {
		console.log("Complex type checking has yet to be implemented!");
	}
}
