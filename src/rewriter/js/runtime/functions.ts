import { ArrayType } from "./Array"
import { StringType } from "./String"
import { NumberType } from "./Number"
import { BooleanType } from "./Boolean"

function isRecord(obj: any): obj is object {
	return obj.$type == null
}

function getNativeValue(obj: any) {
	if (isRecord(obj)) {
		let result: { [key: string]: any } = {}

		for (let [key, value] of Object.entries(obj)) {
			result[key] = getNativeValue(value)
		}

		return result
	} else {
		if (obj.$type === "Array") {
			return obj.value.map((value: any) => getNativeValue(value))
		} else {
			return obj.value
		}
	}
}

export function print(message: any) {
	console.log(getNativeValue(message))

	return message
}
