import type { AnyType } from "./type"
import { typeKeySymbol } from "./type"

export type RecordType = {
	[typeKeySymbol]: "Record"
	[key: string]: AnyType
}

export function createRecord(record: Record<string, AnyType>) {
	return { [typeKeySymbol]: "Record", ...record }
}
