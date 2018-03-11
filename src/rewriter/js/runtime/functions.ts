import { ArrayType } from "./Array"
import { StringType } from "./String"
import { NumberType } from "./Number"
import { BooleanType } from "./Boolean"

// TODO: Move Record into own proper type
type RecordType = {
	$type: null
	[key: string]: any
}

function isRecord(obj: any): obj is RecordType {
	return obj.$type == null
}

function getNativeValue(obj: ArrayType<any> | StringType | NumberType | BooleanType): any {
	if (isRecord(obj)) {
		let result: { [key: string]: any } = {}

		for (let [key, value] of Object.entries(obj)) {
			result[key] = getNativeValue(value)
		}

		return result
	} else {
		if (obj.$type === "Array") {
			return obj.value.map(value => getNativeValue(value))
		} else {
			return obj.value
		}
	}
}

// TODO: Recursive type definitions?
export function print(message: ArrayType<any> | StringType | NumberType | BooleanType) {
	console.log(getNativeValue(message))

	return message
}
