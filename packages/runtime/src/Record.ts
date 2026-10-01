import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import { anyIs } from "./internalHelpers"
import type { ListType } from "./List"
import { createList } from "./List"
import { formatAsFraction } from "./Rational"
import type { StringType } from "./String"
import { createString } from "./String"
import { getStringRepresentation } from "./Terminal"
import type { AnyType } from "./type"
import { typeKeySymbol } from "./type"

export type RecordType = {
	[typeKeySymbol]: "Record"
	[key: string]: AnyType
}

export function createRecord(record: Record<string, AnyType>): RecordType {
	return { [typeKeySymbol]: "Record", ...record }
}

// Only `keys` is declared in `Record.es`. `entries` and `values` would answer
// a value of any Type, which no Type can be written for yet.
export function entries(recordInstance: RecordType): ListType<RecordType> {
	return createList(
		Object.entries(recordInstance).map(([key, value]) => {
			return createRecord({ key: createString(key), value })
		}),
	)
}

export function keys(recordInstance: RecordType): ListType<StringType> {
	return createList(
		Object.keys(recordInstance).map((key) => {
			return createString(key)
		}),
	)
}

export function values(recordInstance: RecordType): ListType<AnyType> {
	return createList(
		Object.values(recordInstance).map((value) => {
			return value
		}),
	)
}

// The same keys with equal values, in any order. The second key Array is only
// counted, but a `for…in` is slower: the Symbol key keeps a Record off the
// engine's fast enumeration path.
export function is(
	firstRecordInstance: RecordType,
	secondRecordInstance: RecordType,
): BooleanType {
	let firstKeys = Object.keys(firstRecordInstance)
	let secondKeys = Object.keys(secondRecordInstance)

	if (firstKeys.length !== secondKeys.length) {
		return createBoolean(false)
	}

	for (let key of firstKeys) {
		if (!Object.hasOwn(secondRecordInstance, key)) {
			return createBoolean(false)
		}

		if (!anyIs(firstRecordInstance[key], secondRecordInstance[key])) {
			return createBoolean(false)
		}
	}

	return createBoolean(true)
}

// The printable rendering. See "The structural rendering" in DEVELOPMENT.md.
export function toString(recordInstance: RecordType): StringType {
	return createString(
		getStringRepresentation(recordInstance, 0, formatAsFraction, ""),
	)
}
