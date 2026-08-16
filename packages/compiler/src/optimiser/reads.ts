import type { common } from "@essence-lang/interfaces"

import { declaredMemberOf, unionMembersOf } from "./residual"

// NOTE: Reading a member off a value, as a pass builds one — the Node and the
// Type it carries. Two passes build such reads: `compile-type-tests` writes out
// what a Case Matcher's payload Pattern requires of a member, and
// `compile-record-members` writes out the members a Record Matcher's decision
// tree reads. One reading of "what is at this spine", so the two can not
// disagree about a Node they both hand to the Rewriter.

// NOTE: The read itself — `_self.payload.origin`, built one step at a time off
// whatever the caller is reading FROM. No Position: a read a pass builds is not
// a thing anyone wrote, and mapping it onto the Expression it was derived from
// would put a debugger somewhere its author never asked to stop.
export function memberReadOf(
	base: common.typedSimple.ExpressionNode,
	steps: ReadonlyArray<string>,
): common.typedSimple.ExpressionNode {
	let node = base
	let type = base.type

	for (let step of steps) {
		type = memberTypeAt(type, step)
		node = {
			nodeType: "Lookup",
			base: node,
			member: { nodeType: "Identifier", name: step, type },
			type,
		}
	}

	return node
}

// NOTE: Silent, and `Unknown` where the Compiler can not name ONE Type at the
// spine — because nothing carries the member, or because what can arrive
// carries it under more than one Type. The Enricher has already reported
// anything worth reporting about a Pattern's members, and an Optimiser pass says
// nothing about a Program either way.
export function memberTypeAt(type: common.Type, name: string): common.Type {
	let found = unionMembersOf(type).flatMap((member: common.Type) =>
		member.type === "Record" || member.type === "Case"
			? (declaredMemberOf(member.members, name) ?? [])
			: [],
	)

	return found.length === 1 ? found[0]! : { type: "Unknown" }
}
