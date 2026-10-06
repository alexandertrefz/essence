import type { common } from "@essence-lang/interfaces"

import { typeContainsUnknown } from "../helpers/types"

// The undecided Types a refused capture handed out, and every undecided part
// of them. A value read out of one, such as `complete work` of a refused
// `work`, carries the same blank. Its call has no Type Parameter left to
// report, since the capture's refusal names the annotation that decides it.
let undecidedByRefusals = new WeakSet<common.Type>()

// A bare blank is left out, since it may be one object every blank shares.
export function noteRefusedCapture(type: common.Type): void {
	if (
		type.type === "Unknown" ||
		!typeContainsUnknown(type) ||
		undecidedByRefusals.has(type)
	) {
		return
	}

	undecidedByRefusals.add(type)

	switch (type.type) {
		case "List":
			return noteRefusedCapture(type.itemType)
		case "Future":
		case "Started":
			return noteRefusedCapture(type.valueType)
		case "Dictionary":
			noteRefusedCapture(type.keyType)

			return noteRefusedCapture(type.valueType)
		case "Record":
			return Object.values(type.members).forEach(noteRefusedCapture)
		case "UnionType":
			return type.types.forEach(noteRefusedCapture)
		case "Refinement":
			return noteRefusedCapture(type.base)
	}
}

export function carriesRefusedCapture(type: common.Type): boolean {
	return undecidedByRefusals.has(type)
}
