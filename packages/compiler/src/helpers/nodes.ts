import type { lexer, parser } from "@essence-lang/interfaces"

export function stripPositionFromArray(
	tokens: Array<lexer.Token | undefined>,
): Array<lexer.SimpleToken | undefined> {
	return tokens.map((value) => stripPosition(value))
}

// NOTE: A Token with everything that says WHERE it is taken off it, leaving the
// Token itself — which is what a test about what was lexed wants to compare.
// The absolute offsets go with the Position they duplicate; lexer.spec.ts
// asserts them where they are the point, and everywhere else they would only be
// the same fact written twice in every expected Token.
export function stripPosition(
	token: lexer.Token | undefined,
): lexer.SimpleToken | undefined {
	let tokenCopy: lexer.SimpleToken | undefined = structuredClone(token)
	if (tokenCopy) {
		;(tokenCopy as any).position = undefined
		;(tokenCopy as any).start = undefined
		;(tokenCopy as any).end = undefined
		return tokenCopy
	}

	return undefined
}

// NOTE: The one Node a Record Literal's member holds — the value it was
// written with, or the braced descend that stands in place of one. Exactly one
// of the two is always there, and a descend is a Record Literal in its own
// right, so every walk over a Literal's members asks this instead of choosing
// between them: a walker that forgot the descend would silently skip a whole
// member list, which is the failure mode a shared enumeration exists to make
// impossible.
export function memberExpression(
	member: parser.RecordValueMemberNode,
): parser.ExpressionNode {
	return member.value ?? member.group!
}
