import { type common, lexer, type parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../../diagnostics/index"
import { describeToken, ParseError, type TokenStream } from "./tokenStream"

const TokenType = lexer.TokenType

// `(on value)` in a Function literal. An unannotated Parameter takes its label
// from the expected signature, so the written one is dropped. `binder` is the
// name the Help keeps, `_` where none is bound.
export function reportRedundantLabel(
	position: common.Position,
	binder: string,
): void {
	reportError("A Parameter without a Type can not carry a label", position, {
		code: "redundant-parameter-label",
		labels: [primary(position, "two names, no Type")],
		notes: [
			"Such a Parameter takes its label from the expected Function Type.",
		],
		helps: [`Write only '${binder}'.`],
	})
}

// `start` and `complete` can not be a Parameter's label, since no call
// could pass one. See "Asynchrony keywords" in DEVELOPMENT.md. The label is
// dropped and the Parameter keeps its name.
export function parameterLabel(
	name: parser.IdentifierNode,
): parser.IdentifierNode | null {
	if (name.content !== "start" && name.content !== "complete") {
		return name
	}

	reportError(
		`A Parameter's label can not be spelled '${name.content}'`,
		name.position,
		{
			code: "reserved-parameter-label",
			labels: [primary(name.position, "this word opens an Expression")],
			notes: [
				`An Argument written '${name.content} value' reads as a '${name.content}' of the value, so no call could pass this Parameter by name.`,
			],
			helps: [
				"Name the label another word.",
				"Or write '_' in its place, so the Parameter takes no label at all.",
			],
		},
	)

	return null
}

// The failure of an Expression position at a Token that opens none. A `_` on
// its own, in a body under a Parameter written `_`, gets the Help that names
// that Parameter. Such a Parameter binds nothing its body can read.
export function expressionExpected(
	tokens: TokenStream,
	namelessParameter: boolean,
): ParseError {
	let token = tokens.peek()!
	let found = `Expected an Expression but found ${describeToken(token)}.`

	if (
		token.type !== TokenType.SymbolUnderscore ||
		!namelessParameter ||
		glued(tokens.peek(-1), token) ||
		glued(token, tokens.peek(1))
	) {
		return new ParseError(found, token.position)
	}

	return new ParseError(found, token.position, "'_' names no value", {
		notes: ["A '_' leaves a name out, so there is nothing to read."],
		helps: [
			"To read a Parameter that binds no name, give it one: '_: Integer' becomes '_ value: Integer', and 'on _: Integer' becomes 'on value: Integer'.",
		],
	})
}

// Whether two Tokens touch and both belong to one spelling, as `my_value`,
// `__print` and `1_` do. A `_` there is part of a name or a Number.
function glued(left: lexer.Token | undefined, right: lexer.Token | undefined) {
	return (
		left !== undefined &&
		right !== undefined &&
		spellsAWord(left) &&
		spellsAWord(right) &&
		left.position.end.line === right.position.start.line &&
		left.position.end.column === right.position.start.column
	)
}

function spellsAWord(token: lexer.Token): boolean {
	return (
		token.type === TokenType.Identifier ||
		token.type === TokenType.LiteralNumber ||
		token.type === TokenType.SymbolUnderscore ||
		token.type.startsWith("Keyword")
	)
}
