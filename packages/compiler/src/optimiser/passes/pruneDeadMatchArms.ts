import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { matcherIsRefuted } from "../residual"
import { rewriteNodes } from "../walk"

// NOTE: A Match Handler whose Matcher can not accept anything that reaches it is
// a test that always answers false, and a body nothing runs. The Compiler
// already knows: the Validator reports exactly this Handler as
// `unreachable-case` before the Optimiser sees the Program, and a Program that
// builds with a Warning standing is one where the Handler is emitted, tested at
// every evaluation, and declined.
//
// NOTE: So it is dropped, and the test with it. What it costs a Program is
// nothing at all — a Handler that can never run has no behavior to preserve —
// and what it saves is the test, per evaluation, plus the body's own emission.
//
// NOTE: The survivors are never REORDERED. A Match is first-match-wins, so the
// order the Handlers are written in is the whole of what decides which one
// answers; dropping one changes nothing about the rest, and moving one would
// change everything.
//
// NOTE: What is dropped is decided by `residual.ts`, from the other side of the
// question the rest of the Optimiser asks it — `matcherIsRefuted` proves the
// Matcher's check FALSE for every member of the scrutinee's Type, which it can
// only do where the tags differ. That is a strictly narrower rule than the
// Validator's, which also reports a Handler every earlier Handler already
// answers for: those are dropped by nobody, because deciding it needs the order
// as well as the Types, and a Handler kept is only a Handler tested.

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
		// NOTE: The last Handler stays where the chain has already been
		// promised to end in it. `elide-final-match-test` runs after this one
		// and would not have made that promise about a refuted Handler — but a
		// pass may not assume the order it happens to run in, and a chain whose
		// `else` was taken away would answer nothing where it used to answer.
		if (node.finalHandlerIsElse && index === last) {
			return true
		}

		return !matcherIsRefuted(handler.matcher, node.value.type)
	})

	// NOTE: Every Handler refuted is a Match the Compiler has misread rather
	// than a Program with nothing to say — the Validator would have reported it
	// as missing every Case of its Union — so nothing is dropped and the chain
	// is emitted as it was written.
	if (handlers.length === node.handlers.length || handlers.length === 0) {
		return node
	}

	return { ...node, handlers }
}
