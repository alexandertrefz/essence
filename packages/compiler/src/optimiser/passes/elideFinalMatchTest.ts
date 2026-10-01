import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { matcherResidual } from "../residual"
import { rewriteNodes } from "../walk"

// Emits an exhaustive Match's last Handler as the chain's `else`, dropping the
// throw after it. Only a check that reduces to a tag comparison or nothing,
// with nothing else that could decline, is elided. See "elide-final-match-test" in DEVELOPMENT.md.

export const elideFinalMatchTest: OptimiserPass = {
	name: "elide-final-match-test",
	run: (program) =>
		rewriteNodes(program, { expression: elide, statement: elide }),
}

function elide<
	Node extends
		| common.typedSimple.ExpressionNode
		| common.typedSimple.ImplementationNode,
>(node: Node): Node {
	if (
		node.nodeType !== "Match" &&
		!(
			node.nodeType === "IntrinsicStatement" &&
			node.kind === "statement-match"
		)
	) {
		return node
	}

	if (node.finalHandlerIsElse) {
		return node
	}

	let final = node.handlers.at(-1)

	if (final === undefined) {
		return node
	}

	// Everything that can make a Handler decline a value its Matcher accepted.
	// `memberTypes` belongs here as `memberLiterals` does, though the validator
	// already refuses such a Match as inexhaustive.
	if (
		final.guard !== null ||
		final.literal !== null ||
		final.memberLiterals !== null ||
		final.memberTypes !== null
	) {
		return node
	}

	if (matcherResidual(final.matcher, node.value.type).kind === "descriptor") {
		return node
	}

	return { ...node, finalHandlerIsElse: true }
}
