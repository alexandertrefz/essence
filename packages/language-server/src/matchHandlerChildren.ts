import type { common } from "@essence-lang/interfaces"

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
