import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteExpressions } from "../walk"

// NOTE: `{ base with x = 1 }` was `Object.assign({}, base, Record.createRecord({
// x: 1 }))` — an empty object, a Record built to be read once, and a copy of
// both into a third. JavaScript spells the whole of that as one object literal:
// `{ ...base, x: 1 }`.
//
// NOTE: The two are the same operation on the values this language has.
// `Object.assign` copies own enumerable properties, Symbol keys included, in
// their own order, with a later source overwriting an earlier one — and object
// spread copies exactly the same set in exactly the same order. Neither reaches
// a prototype, and no runtime value has a getter or a setter to tell the
// [[Set]] `Object.assign` uses from the plain definition a spread makes. So the
// combined Record holds the same members, keyed in the same order, and carries
// the hidden Type key it inherits from the left-hand side either way.

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

	// NOTE: A right-hand side written as a Record literal is inlined, member by
	// member. Both spellings of one are recognised — the Simplifier's own
	// `RecordValue` and the `direct-record` `collapse-construction` leaves —
	// because a pass may not assume another one ran, and this pass is registered
	// after that one only so that the common case is already in its collapsed
	// form.
	let members = membersOf(node.rhs)

	return {
		nodeType: "Intrinsic",
		kind: "spread-combination",
		lhs: node.lhs,
		members: members ?? {},
		rhs: members === null ? node.rhs : null,
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
