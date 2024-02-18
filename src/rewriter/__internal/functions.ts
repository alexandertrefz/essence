import type { BooleanType } from "./Boolean"
import type { FractionType } from "./Fraction"
import type { IntegerType } from "./Integer"
import type { ListType } from "./List"
import type { RecordType } from "./Record"
import type { StringType } from "./String"

import { toString as boolToString } from "./Boolean"
import { toString__overload$1 as fractionToString } from "./Fraction"
import { toString as integerToString } from "./Integer"
import { AnyType, typeKeySymbol } from "./type"

const singleLineMaxLength = 60

function getStringRepresentation(obj: AnyType, indentLevel = 0): string {
	const baseIndent = " ".repeat(4 * indentLevel)
	const contentIndent = " ".repeat(4 * (indentLevel + 1))

	if (obj[typeKeySymbol] === "Record") {
		let keyValuePairs: Array<string> = []

		if (Object.entries(obj).length > 0) {
			let singleLineString = ""

			for (let [key, value] of Object.entries(obj)) {
				keyValuePairs.push(
					`${key} = ${getStringRepresentation(value, 0)}`,
				)
			}

			singleLineString = `{ ${keyValuePairs.join(", ")} }`

			if (singleLineString.length < singleLineMaxLength) {
				return singleLineString
			} else {
				for (let [key, value] of Object.entries(obj)) {
					keyValuePairs.push(
						`${key} = ${getStringRepresentation(
							value,
							indentLevel + 1,
						)}`,
					)
				}

				return `{\n${contentIndent}${keyValuePairs.join(
					`,\n${contentIndent}`,
				)}\n${baseIndent}}`
			}
		} else {
			return "{}"
		}
	} else if (obj[typeKeySymbol] === "List") {
		if (obj.value.length > 0) {
			let singleLineString = `[ ${obj.value
				.map((value) => getStringRepresentation(value, 0))
				.join(", ")} ]`

			if (singleLineString.length < singleLineMaxLength) {
				return singleLineString
			} else {
				return `[\n${contentIndent}${obj.value
					.map((value) =>
						getStringRepresentation(value, indentLevel + 1),
					)
					.join(`,\n${contentIndent}`)}\n${baseIndent}]`
			}
		} else {
			return "[]"
		}
	} else if (obj[typeKeySymbol] === "Fraction") {
		return fractionToString(obj).value
	} else if (obj[typeKeySymbol] === "Integer") {
		return integerToString(obj).value
	} else if (obj[typeKeySymbol] === "Boolean") {
		return boolToString(obj).value
	} else if (obj[typeKeySymbol] === "String") {
		return `"${obj.value}"`
	} else {
		return "Nothing"
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
