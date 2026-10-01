import { type common, lexer } from "@essence-lang/interfaces"

import { Lexer } from "./lexer/index"

// A value comment, `§?` at the end of a Statement, asks a test compile for the
// Statement's value. It reaches the editor as a `probe` event. To a build it
// is an ordinary Comment.
//
// It is read off the source, since the parser drops Comments and a tree field
// would have to survive the formatter's tree comparison. A probe needs only
// the line.
export const VALUE_COMMENT = "§?"

// Every line that ends in a value comment, which a Comment's running to the
// line break makes unique. Lexed, so a `§?` inside a String is not one.
export function valueCommentLines(
	source: string,
): Map<number, common.Position> {
	let lines = new Map<number, common.Position>()

	if (!source.includes(VALUE_COMMENT)) {
		return lines
	}

	let sourceLexer = new Lexer()

	sourceLexer.ignore(lexer.TokenType.Linebreak)
	sourceLexer.reset(source)

	try {
		let token = sourceLexer.next()

		while (token !== undefined) {
			if (
				token.type === lexer.TokenType.Comment &&
				token.value.startsWith(VALUE_COMMENT)
			) {
				lines.set(token.position.start.line, token.position)
			}

			token = sourceLexer.next()
		}
	} catch {
		// The lexer throws on an unterminated String, which the parser has
		// reported. What was read before it stands.
	}

	return lines
}
