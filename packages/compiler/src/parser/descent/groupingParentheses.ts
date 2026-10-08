import { type common, lexer, type parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../../diagnostics/index"
import type { TokenStream } from "./tokenStream"

const TokenType = lexer.TokenType

// Whether the `(` ahead closes before nothing a Function literal goes on
// with, as its `->` or body, or another language's `=>` or `: Type`. Such a
// `(` is read as wrapping a value. One that never closes is left to the
// Function literal, whose report names the bracket.
export function wrapsAValue(tokens: TokenStream): boolean {
	let depth = 0

	for (let offset = 0; ; offset++) {
		let token = tokens.peek(offset)

		if (token === undefined) {
			return false
		}

		if (token.type === TokenType.SymbolLeftParen) {
			depth++
		} else if (token.type === TokenType.SymbolRightParen) {
			depth--
		}

		if (depth === 0) {
			let following = tokens.peek(offset + 1)?.type
			let chained =
				tokens.peek(offset + 2)?.type === TokenType.SymbolColon

			return (
				following !== TokenType.SymbolLeftBrace &&
				following !== TokenType.SymbolDash &&
				following !== TokenType.SymbolEqual &&
				(following !== TokenType.SymbolColon || chained)
			)
		}
	}
}

// `(value)`: the value is kept, so the Statement stands and this is its one
// report. See "Grouping parentheses" in DEVELOPMENT.md.
export function readGroup(
	tokens: TokenStream,
	parseExpression: () => parser.ExpressionNode,
): parser.ExpressionNode {
	let open = tokens.next()
	let value = parseExpression()
	let close = tokens.expect(TokenType.SymbolRightParen)
	let position: common.Position = {
		start: open.position.start,
		end: close.position.end,
	}

	reportError("Essence has no grouping parentheses", position, {
		code: "foreign-syntax",
		labels: [primary(position, "these parentheses group one value")],
		notes: [
			"A '(' in an Expression opens a Function literal's Parameter list. A value needs no grouping, since a Method chain reads left to right.",
		],
		helps: ["Remove the parentheses."],
		data: {
			kind: "grouping-parentheses",
			open: open.position,
			close: close.position,
		},
	})

	return value
}
