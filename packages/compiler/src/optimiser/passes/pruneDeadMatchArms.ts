import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { matcherIsRefuted } from "../residual"
import { rewriteNodes } from "../walk"

// Drops a Match Handler whose Matcher `matcherIsRefuted` proves false for every
// value that can arrive, which the validator reports as `unreachable-case`. A
// Handler that earlier ones already answer for is kept, since deciding that
// needs the order. The survivors keep their order, which decides who answers.

export const pruneDeadMatchArms: OptimiserPass = {
	name: "prune-dead-match-arms",
	run: (program) =>
		rewriteNodes(program, { expression: prune, statement: prune }),
}

function prune<
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

	let last = node.handlers.length - 1
	let handlers = node.handlers.filter((handler, index) => {
		// A final Handler written as the `else` stays, since a pass may not assume
		// `elide-final-match-test` would not have chosen it.
		if (node.finalHandlerIsElse && index === last) {
			return true
		}

		return !matcherIsRefuted(handler.matcher, node.value.type)
	})

	// Every Handler refuted means the compiler misread the Match, since the
	// validator would have reported it. The chain is left as written.
	if (handlers.length === node.handlers.length || handlers.length === 0) {
		return node
	}

	return { ...node, handlers }
}
