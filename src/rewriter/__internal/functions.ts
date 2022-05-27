import type { ListType } from "./List"
import type { StringType } from "./String"
import type { IntegerType } from "./Integer"
import type { BooleanType } from "./Boolean"

// TODO: Move Record into own proper type
type RecordType = {
	$type: null
	[key: string]: any
}

function isRecord(obj: any): obj is RecordType {
	return obj.$type == null
}

function getNativeValue(obj: ListType<any> | StringType | IntegerType | BooleanType | RecordType): any {
	if (isRecord(obj)) {
		let result: { [key: string]: any } = {}

		for (let [key, value] of Object.entries(obj)) {
			result[key] = getNativeValue(value)
		}

		return result
	} else if (obj.$type === "List") {
		return obj.value.map((value) => getNativeValue(value))
	} else if (obj.$type === "Integer") {
		return obj.value.toString()
	} else {
		return obj.value
	}
}

// TODO: Recursive type definitions?
export function print(message: ListType<any> | StringType | IntegerType | BooleanType | RecordType) {
	console.log(getNativeValue(message))

	return message
}
