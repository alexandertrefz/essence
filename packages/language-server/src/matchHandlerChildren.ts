import type { common } from "@essence-lang/interfaces"

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
