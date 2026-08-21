import { type common, lexer } from "@essence-lang/interfaces"

import { Lexer } from "./lexer/index"

// NOTE: A VALUE COMMENT — `§?` written at the end of a Statement. To a build it
// is an ordinary Comment and costs a shipped Program nothing; to a test compile
// it asks for the value of the Statement it ends, recorded at a point of the
// same trace mechanism `expect` and `require` record at, and reported as a
// `probe` event the Editor draws beside the line.
//
// NOTE: It is READ OFF THE SOURCE rather than carried on the AST. The Parser
// puts Comments on the Lexer's ignore list — they are not Tokens and they are
// not Nodes — and a field on the tree holding a Comment's Position would have to
// survive the Formatter's AST-equality gate, which compares two parses of text
// the Formatter is allowed to move. A line number is the whole of what a probe
// needs, and the line is where the writer put it.
export const VALUE_COMMENT = "§?"

// NOTE: Every line that ENDS in a value comment, and where that comment stands.
// A Comment runs to its line break, so one line holds at most one — which is
// what makes a line the key.
//
// NOTE: Lexed rather than searched for. `§?` inside a String Literal is text
// and asks for nothing, and a search would have no way to tell the two apart.
// The lex is skipped outright for a source that does not hold the two
// characters at all, which is nearly every file ever compiled.
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
		// NOTE: The Lexer throws on an unterminated String Literal, which the
		// Parser has already reported by the time anything asks for probes.
		// What was read before it stands.
	}

	return lines
}
