import type { common, parser } from "@essence-lang/interfaces"

// A typed Match Handler's Expressions outside its body: a literal Matcher's
// value, each by-value member of a Record Matcher, and the Guard, in source
// order. Every walker into `body` must reach these too.

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

// The written values a parsed Matcher's Pattern constrains members against,
// in source order at any depth. They are the only part of a Matcher smaller
// than the Matcher.
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
