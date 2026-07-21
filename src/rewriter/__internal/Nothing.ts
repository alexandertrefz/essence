import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { StringType } from "./String"
import { createString } from "./String"
import { typeKeySymbol } from "./type"

export type NothingType = { [typeKeySymbol]: "Nothing" }

let sharedNothingInstance: NothingType = { [typeKeySymbol]: "Nothing" }

export function createNothing(): NothingType {
	return sharedNothingInstance
}

export function is(
	_originalNothing: NothingType,
	_otherNothing: NothingType,
): BooleanType {
	// NOTE: There is only one Nothing value — two Nothings are always the same.
	return createBoolean(true)
}

export function isNot(
	_originalNothing: NothingType,
	_otherNothing: NothingType,
): BooleanType {
	return createBoolean(false)
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: This is a runtime function
export function toString(_nothing: NothingType): StringType {
	return createString("Nothing")
}
