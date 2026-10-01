import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteExpressions } from "../walk"

// Writes `{ base with x = 1 }` as the object literal `{ ...base, x: 1 }`, which
// copies the same members in the same order. See "collapse-combinations" in
// DEVELOPMENT.md.

export const collapseCombinations: OptimiserPass = {
	name: "collapse-combinations",
	run: (program) => rewriteExpressions(program, collapse),
}

function collapse(
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "Combination") {
		return node
	}

	// A spread takes the left-hand side's brand, so a left-hand side that is
	// not statically a Record keeps the `Object.assign` emission.
	if (node.lhs.type.type !== "Record") {
		return node
	}

	// A Record literal on the right is inlined member by member, in either the
	// simplifier's spelling or the one `collapse-construction` leaves.
	let members = membersOf(node.rhs)

	if (members !== null) {
		return {
			nodeType: "Intrinsic",
			kind: "spread-combination",
			lhs: node.lhs,
			members,
			rhs: null,
			rhsMembers: null,
			type: node.type,
			position: node.position,
		}
	}

	// Any other right-hand side is projected to the members its Record Type
	// names.
	if (node.rhs.type.type !== "Record") {
		return node
	}

	return {
		nodeType: "Intrinsic",
		kind: "spread-combination",
		lhs: node.lhs,
		members: {},
		rhs: node.rhs,
		rhsMembers: Object.keys(node.rhs.type.members),
		type: node.type,
		position: node.position,
	}
}

function membersOf(
	node: common.typedSimple.ExpressionNode,
): Record<string, common.typedSimple.ExpressionNode> | null {
	if (node.nodeType === "RecordValue") {
		return node.members
	}

	if (node.nodeType === "Intrinsic" && node.kind === "direct-record") {
		return node.members
	}

	return null
}
