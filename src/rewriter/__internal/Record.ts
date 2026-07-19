import type { BooleanType } from "./Boolean"
import { createBoolean, negate } from "./Boolean"
import { anyIs } from "./internalHelpers"
import type { ListType } from "./List"
import { createList } from "./List"
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

// NOTE: Records are structurally equal when they hold the same keys with
// equal values — the order in which the keys were defined does not matter.
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
