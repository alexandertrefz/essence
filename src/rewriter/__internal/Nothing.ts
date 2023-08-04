export type NothingType = { $type: "Nothing" }

let sharedNothingInstance: NothingType = { $type: "Nothing" }

export function createNothing(): NothingType {
	return sharedNothingInstance
}
