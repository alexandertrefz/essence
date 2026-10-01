import type { lexer, parser } from "@essence-lang/interfaces"

export function stripPositionFromArray(
	tokens: Array<lexer.Token | undefined>,
): Array<lexer.SimpleToken | undefined> {
	return tokens.map((value) => stripPosition(value))
}

// A Token without its Position and offsets, for a spec that compares what was
// lexed. The lexer spec asserts offsets only where they are the point.
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

// The one Node a Record Literal's member holds: its value, or the braced descend
// written in its place. Every walk over a Literal's members asks here, so none
// skips a descend.
export function memberExpression(
	member: parser.RecordValueMemberNode,
): parser.ExpressionNode {
	return member.value ?? member.group!
}
