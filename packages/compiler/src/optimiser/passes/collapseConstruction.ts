import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteExpressions } from "../walk"

// NOTE: Building a Record, a Case or a List costs two allocations and a call
// where it can cost one allocation. `Record.createRecord({ x: 1 })` allocates
// the literal, calls out to the runtime, and there allocates a SECOND object
// that copies the first and adds the hidden Type key; `List.createList([…])`
// allocates the array and then a wrapper around it; `$type.createCase(tag,
// payload)` allocates the payload Record — through `createRecord`, so two
// already — and then copies it once more to stamp the tag. Every one of them
// ends in an object literal whose shape the Compiler knows in full, so the
// Compiler writes that literal instead.
//
// NOTE: Nothing about the value changes. The runtime's constructors are exactly
// these literals: `createRecord` spreads its argument after the brand,
// `createList` stores the array it is handed without copying it, `createCase`
// spreads the payload and writes the tag over it — so the emitted object holds
// the same members in the same order, under the same hidden key, and every
// Argument is evaluated where it was evaluated before. What is gone is the copy
// and the call.
//
// NOTE: The constructors stay in the runtime and stay reachable. They are what
// this pass turned OFF emits, they are what the runtime's own Methods build
// their answers with, and `createCase` is where the interning of unit Cases
// lives — which is why a unit Case is left alone here. One shared instance per
// tag is a better answer than a fresh literal per construction, and the two
// would be indistinguishable anyway.

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
	// NOTE: A unit Case keeps its `createCase` call, which hands out ONE
	// instance per tag rather than building a literal per construction. There is
	// nothing to inline into it either: a unit Case is its tag and nothing else.
	if (node.value === null) {
		return node
	}

	// NOTE: The walk is bottom-up, so a payload written as a Record literal has
	// already become a `direct-record` by the time the Case is offered — that,
	// and not `RecordValue`, is the shape to recognise. A payload that is
	// anything else is spread, exactly as `createCase` spreads it, so the
	// members of a Record a Program is holding elsewhere are copied rather than
	// shared.
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
