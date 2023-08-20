import { typeKeySymbol } from "./type"

export type NothingType = { [typeKeySymbol]: "Nothing" }

let sharedNothingInstance: NothingType = { [typeKeySymbol]: "Nothing" }

export function createNothing(): NothingType {
	return sharedNothingInstance
}
