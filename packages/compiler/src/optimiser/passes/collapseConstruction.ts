import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteExpressions } from "../walk"

// Builds a Record, a List or a Case as the object literal the runtime's
// constructor would return, saving a copy and a call. The members, their order,
// the Type key and the evaluation order stay the same. A unit Case keeps its
// `createCase` call, which hands out one shared instance per tag.

export const collapseConstruction: OptimiserPass = {
	name: "collapse-construction",
	run: (program) => rewriteExpressions(program, collapse),
}

function collapse(
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	switch (node.nodeType) {
		case "RecordValue":
			return {
				nodeType: "Intrinsic",
				kind: "direct-record",
				members: node.members,
				type: node.type,
				position: node.position,
			}
		case "ListValue":
			return {
				nodeType: "Intrinsic",
				kind: "direct-list",
				values: node.values,
				type: node.type,
				position: node.position,
			}
		case "CaseValue":
			return collapseCase(node)
		default:
			return node
	}
}

function collapseCase(
	node: common.typedSimple.CaseValueNode,
): common.typedSimple.ExpressionNode {
	// A unit Case is its tag alone, and `createCase` interns it.
	if (node.value === null) {
		return node
	}

	// A payload Record literal is already a `direct-record` here, since the
	// walk is bottom-up. Any other payload is spread, as `createCase` spreads
	// it.
	if (
		node.value.nodeType === "Intrinsic" &&
		node.value.kind === "direct-record"
	) {
		return {
			nodeType: "Intrinsic",
			kind: "direct-case",
			tag: node.tag,
			members: node.value.members,
			payload: null,
			type: node.type,
			position: node.position,
		}
	}

	return {
		nodeType: "Intrinsic",
		kind: "direct-case",
		tag: node.tag,
		members: {},
		payload: node.value,
		type: node.type,
		position: node.position,
	}
}
