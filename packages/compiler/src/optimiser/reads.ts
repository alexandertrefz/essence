import type { common } from "@essence-lang/interfaces"

import { declaredMemberOf, unionMembersOf } from "./residual"

// The member reads that `compile-type-tests` and `compile-record-members`
// build, so the two agree on the Node and its Type.

// A read such as `_self.payload.origin`, built step by step. It has no
// Position, so a debugger never stops on it.
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

// `Unknown` where no single Type is at the member, which the enricher has
// already reported if it matters.
export function memberTypeAt(type: common.Type, name: string): common.Type {
	let found = unionMembersOf(type).flatMap((member: common.Type) =>
		member.type === "Record" || member.type === "Case"
			? (declaredMemberOf(member.members, name) ?? [])
			: [],
	)

	return found.length === 1 ? found[0]! : { type: "Unknown" }
}
