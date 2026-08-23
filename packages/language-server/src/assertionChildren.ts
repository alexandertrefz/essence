import type { common, parser } from "@essence-lang/interfaces"

import { matcherValueExpressions } from "./matchHandlerChildren"

// NOTE: `expect EXPR`, `require EXPR` and `require MATCHER = EXPR` are
// Statements, and every Expression they hold hangs off them directly — there is
// no body to descend into. So a walker that has no case for them descends into
// nothing at all, and the whole of a test body is invisible to it. This is the
// one answer to "what is written inside an assertion", asked the way
// `matchHandlerChildren` asks it of a Match Handler, so that the fourteen
// walkers below can not disagree about it.
//
// Returned in SOURCE order — the Matcher stands left of the `=` — so a walker
// searching for the first match in a document finds it where it lexically is.

type ParsedAssertion = parser.ExpectStatementNode | parser.RequireStatementNode

type TypedAssertion =
	| common.typed.ExpectStatementNode
	| common.typed.RequireStatementNode

// NOTE: A Matcher's own Expressions are the values it constrains members
// against — `require { points = total } = standing` — which is the same
// question a Match Handler asks, reached from the other side of the grammar.
export function assertionExpressions(
	node: ParsedAssertion,
): Array<parser.ExpressionNode> {
	return [
		...(node.matcher === null ? [] : matcherValueExpressions(node.matcher)),
		node.value,
	]
}

// NOTE: The typed side. Where a Matcher was written, `value` is the NAME of the
// Constant holding the asserted value rather than the Expression itself — that
// Expression is the Statement standing in front of this one, which every walker
// reaches on its own.
export function typedAssertionExpressions(
	node: TypedAssertion,
): Array<common.typed.ExpressionNode> {
	return [
		node.matcher?.literal ?? null,
		...Object.values(node.matcher?.memberLiterals ?? {}),
		node.value,
	].filter((expression) => expression !== null)
}
