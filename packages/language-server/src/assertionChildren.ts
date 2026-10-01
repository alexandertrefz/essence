import type { common, parser } from "@essence-lang/interfaces"

import { matcherValueExpressions } from "./matchHandlerChildren"

// What is written inside an assertion, which holds its Expressions directly,
// in source order with the Matcher first, as `matchHandlerChildren` answers
// for a Match Handler.

type ParsedAssertion = parser.ExpectStatementNode | parser.RequireStatementNode

type TypedAssertion =
	| common.typed.ExpectStatementNode
	| common.typed.RequireStatementNode

// A Matcher's own Expressions are the values it constrains members against,
// the `3` of `require { points = 3 } = standing`.
export function assertionExpressions(
	node: ParsedAssertion,
): Array<parser.ExpressionNode> {
	return [
		...(node.matcher === null ? [] : matcherValueExpressions(node.matcher)),
		node.value,
	]
}

// The typed side. With a Matcher, `value` names the Constant holding the
// asserted value, whose Statement stands before this one.
export function typedAssertionExpressions(
	node: TypedAssertion,
): Array<common.typed.ExpressionNode> {
	return [
		node.matcher?.literal ?? null,
		...Object.values(node.matcher?.memberLiterals ?? {}),
		node.value,
	].filter((expression) => expression !== null)
}
