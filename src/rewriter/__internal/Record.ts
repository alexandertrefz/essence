import type { BooleanType } from "./Boolean"
import { createBoolean, negate } from "./Boolean"
import { getStringRepresentation } from "./functions"
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

// NOTE: `keys` is declared on the Namespace; `entries` and `values` are
// runtime-only for now — their honest return Types need an `Anything` Type
// (a Record's values have no common Type), which arrives with the JSON
// design. They stay implemented and tested so the Dictionary work can pick
// them up.
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
export function toString(recordInstance: RecordType): StringType {
	return createString(getStringRepresentation(recordInstance))
}
