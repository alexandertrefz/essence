import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { matcherResidual } from "../residual"
import { rewriteNodes } from "../walk"

// NOTE: The last Handler of a Match is tested like every other one, and then
// the chain ends in an `else` that throws — and both of those are answers to a
// question already settled. A Match that compiles is EXHAUSTIVE: the Validator
// refuses one leaving a member of its Union unhandled, and a Guarded Handler
// never counts toward that, so an unguarded last Handler is what runs when every
// Handler before it declined. Its test is a question with one possible answer,
// and the `else` after it is unreachable:
//
//   if (…) { … } else if (…) { … } else { <the last Handler's body> }
//
// NOTE: What is given up is a Compiler bug's name. `$type.noCaseMatched` is
// reached only when a Matcher's runtime check disagrees with the Type the
// Enricher gave it — never through a Program's own fault — and it throws
// naming the value that fell through. With the last test elided such a value
// takes the last Handler instead, silently. That is the trade, it is why this
// is a pass rather than the way a Match is emitted, and
// `--without-optimisation elide-final-match-test` is what a Compiler developer
// chasing one turns on.
//
// NOTE: So the elision is taken only where the last Handler's check is decided
// by TAGS — where it would be `value[<Type key>] === "…"`, or where it asks
// nothing at all (a wildcard). That is deliberately narrower than
// exhaustiveness allows, and it is where the disagreement above can not come
// from: a check the Compiler could not reduce to a tag is one that walks a
// payload or a List's items, which is exactly where erasure makes the runtime
// answer and the static Type part company. Leaving those chains ending in the
// throw keeps the one shape that can go wrong reporting itself.
//
// NOTE: A Guard, a literal Matcher (`case 0`) or member literals
// (`case { x = 0 }`) all leave a Handler that can decline for reasons no
// exhaustiveness argument covers — a Guard is a Program's own Boolean — so a
// last Handler carrying any of them is tested exactly as it was.
//
// NOTE: This pass may not assume `compile-type-tests` ran, so it asks
// `residual.ts` the same question rather than reading the test that pass leaves
// behind. With that pass off, what is dropped here is the descriptor check
// instead — the same Handler, decided the same way.
//
// NOTE: It may not assume `lower-matches-to-statements` did not run either, and
// that one runs FIRST — so a Match reaching here is either the Expression the
// Simplifier wrote or the Statement that pass lowered it to. Both carry the same
// Handlers, the same scrutinee and the same claim, and both are read here: a
// Match that stopped being elided because it was lowered would be one pass
// silently taking away another's work.

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

	if (
		final.guard !== null ||
		final.literal !== null ||
		final.memberLiterals !== null
	) {
		return node
	}

	if (matcherResidual(final.matcher, node.value.type).kind === "descriptor") {
		return node
	}

	return { ...node, finalHandlerIsElse: true }
}
