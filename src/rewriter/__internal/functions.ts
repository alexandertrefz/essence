import type { BooleanType } from "./Boolean"
import type { FractionType } from "./Fraction"
import type { IntegerType } from "./Integer"
import type { ListType } from "./List"
import type { StringType } from "./String"

import * as boolean from "./Boolean"
import * as fraction from "./Fraction"
import * as integer from "./Integer"

// TODO: Move Record into own proper type
type RecordType = {
	$type: null
	[key: string]: any
}

function isRecord(obj: any): obj is RecordType {
	return obj.$type == null
}

function getStringRepresentation(
	obj:
		| ListType<any>
		| StringType
		| IntegerType
		| FractionType
		| BooleanType
		| RecordType,
	indentLevel = 0,
): string {
	const baseIndent = " ".repeat(4 * indentLevel)
	const contentIndent = " ".repeat(4 * (indentLevel + 1))

	if (isRecord(obj)) {
		let keyValuePairs: Array<string> = []

		for (let [key, value] of Object.entries(obj)) {
			keyValuePairs.push(
				`${key} = ${getStringRepresentation(value, indentLevel + 1)}`,
			)
		}

		if (keyValuePairs.length) {
			return `{\n${contentIndent}${keyValuePairs.join(
				`,\n${contentIndent}`,
			)}\n${baseIndent}}`
		} else {
			return "{}"
		}
	} else if (obj.$type === "List") {
		if (obj.value.length) {
			return `[\n${contentIndent}${obj.value
				.map((value) => getStringRepresentation(value, indentLevel + 1))
				.join(`,\n${contentIndent}`)}\n${baseIndent}]`
		} else {
			return "[]"
		}
	} else if (obj.$type === "Fraction") {
		return fraction.toString__overload$1(obj).value
	} else if (obj.$type === "Integer") {
		return integer.toString(obj).value
	} else if (obj.$type === "Boolean") {
		return boolean.toString(obj).value
	} else {
		return `"${obj.value}"`
	}
}

export function print(
	message:
		| ListType<any>
		| StringType
		| IntegerType
		| FractionType
		| BooleanType
		| RecordType,
) {
	console.log(getStringRepresentation(message))

	return message
}
