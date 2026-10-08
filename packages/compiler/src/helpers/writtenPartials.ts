import type { common } from "@essence-lang/interfaces"

import { type RecordMismatchEvidence, recordMismatchEvidence } from "./describe"
import { isPartialOf } from "./types"
import { undeclaredMembers } from "./undeclaredMembers"

// What refuses an update's right-hand side, or null where it is a partial of
// what it updates. No Literal written inside it may name a member its Type
// does not declare. See "Undeclared members" in DEVELOPMENT.md.
export function updateRefusal(
	whole: common.RecordType,
	part: common.RecordType,
	written: common.typed.ExpressionNode | null | undefined,
): RecordMismatchEvidence | null {
	if (
		isPartialOf(whole, part) &&
		undeclaredMembers(whole, written).length === 0
	) {
		return null
	}

	// Removing every member an update writes would leave no update to write, so
	// no removal is offered there.
	let emptied =
		written?.nodeType === "RecordValue" &&
		Object.keys(written.members).every(
			(name) => !Object.hasOwn(whole.members, name),
		)

	return recordMismatchEvidence(whole, part, written ?? null, {
		partial: true,
		offersRemoval: !emptied,
		subject: "the value it updates",
	})
}
