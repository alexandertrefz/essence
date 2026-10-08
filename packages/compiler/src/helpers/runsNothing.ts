import type { common } from "@essence-lang/interfaces"

type Expression =
	| common.typed.ExpressionNode
	| common.typedSimple.ExpressionNode

// Whether evaluating an Expression runs nothing whose order a reader could
// see. That holds for a literal, a name, a Function value, and a member read,
// List, Record or Case built of those. A typed Expression and a simplified one
// agree on these nodes, so the Validator and the Simplifier ask the same.
export function runsNothing(node: Expression): boolean {
	switch (node.nodeType) {
		case "Identifier":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "FunctionValue":
			return true
		case "Lookup":
			return runsNothing(node.base)
		case "RecordValue":
			return Object.values<Expression>(node.members).every(runsNothing)
		case "ListValue":
			return (node.values as Array<Expression>).every(runsNothing)
		case "CaseValue":
			return node.value === null || runsNothing(node.value)
		default:
			return false
	}
}
