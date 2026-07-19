import type { BooleanType } from "./Boolean"
import { and, negate } from "./Boolean"
import type { ListType } from "./List"
import { createList, is as listIs } from "./List"
import type { StringType } from "./String"
import { createString } from "./String"
import type { AnyType } from "./type"
import { typeKeySymbol } from "./type"

export type RecordType = {
	[typeKeySymbol]: "Record"
	[key: string]: AnyType
}

export function createRecord(record: Record<string, AnyType>): RecordType {
	return { [typeKeySymbol]: "Record", ...record }
}

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

export function is(
	firstRecordInstance: RecordType,
	secondRecordInstance: RecordType,
): BooleanType {
	let keysAreEqual = listIs(
		keys(firstRecordInstance),
		keys(secondRecordInstance),
	)

	let valuesAreEqual = listIs(
		values(firstRecordInstance),
		values(secondRecordInstance),
	)

	return and(keysAreEqual, valuesAreEqual)
}

export function isNot(
	firstRecordInstance: RecordType,
	secondRecordInstance: RecordType,
): BooleanType {
	return negate(is(firstRecordInstance, secondRecordInstance))
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: This is a runtime function
export function toString(recordInstance: RecordType) {
	// TODO
	console.log("toString", recordInstance)
	return createString("Record")
}
