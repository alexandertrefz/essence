import type { common, parser } from "@essence-lang/interfaces"

// NOTE: A typed Match Handler holds Expressions outside its body — the value a
// literal Matcher compares against, one per by-value member of a Record
// Matcher, and the Guard. They are ordinary Expressions with ordinary
// Positions, so every walker that descends into `body` has to descend into
// them as well or the whole of `case 1 where …` is invisible to Hovers,
// Completion, Inlay Hints and the rename index.
//
// Returned in source order — the Matcher's own Expressions first, then the
// Guard — so that a walker searching for the first match in a document finds
// it where it lexically is.

type Handler = common.typed.MatchNode["handlers"][number]

export function typedHandlerExpressions(
	handler: Handler,
): Array<common.typed.ExpressionNode> {
	return [
		handler.literal,
		...Object.values(handler.memberLiterals ?? {}),
		handler.guard,
	].filter((expression) => expression !== null)
}

// NOTE: The same question asked of a PARSED Matcher: the written values its
// Pattern constrains members against, in source order, however deeply nested
// and whether the Pattern stands in the Matcher itself or in a Case payload.
// They are the only part of a Matcher smaller than the Matcher — a literal
// Matcher's value spans the whole of it — so they are what a walker looking for
// the innermost thing under a cursor has to descend into.
export function matcherValueExpressions(
	matcher: parser.MatcherNode,
): Array<parser.ExpressionNode> {
	if (matcher.nodeType === "Pattern") {
		return patternValueExpressions(matcher)
	}

	if (
		matcher.nodeType === "CaseMatcher" &&
		matcher.binding?.nodeType === "Pattern"
	) {
		return patternValueExpressions(matcher.binding)
	}

	return []
}

function patternValueExpressions(
	pattern: parser.PatternNode,
): Array<parser.ExpressionNode> {
	let values: Array<parser.ExpressionNode> = []

	for (let member of Object.values(pattern.members)) {
		if (member.kind === "Value") {
			values.push(member.value)

			continue
		}

		if (member.binder?.nodeType === "Pattern") {
			values.push(...patternValueExpressions(member.binder))
		}
	}

	return values
}
