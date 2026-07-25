import { typeKeySymbol } from "./type"

export type NothingType = { [typeKeySymbol]: "Nothing" }

let sharedNothingInstance: NothingType = { [typeKeySymbol]: "Nothing" }

export function createNothing(): NothingType {
	return sharedNothingInstance
}

// NOTE: `is`, `isNot` and `toString` are implemented in Essence — see
// `packages/stdlib/sources/Nothing.es`. Only the value constructor stays native.
