import { type common, lexer } from "@essence-lang/interfaces"

import { primary, reportError } from "../../diagnostics/index"
import { describeToken, ParseError } from "./tokenStream"

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

// The failure of an Expression position at a Token that opens none. A `_`
// gets its own account, since a Parameter written `_` or `on _` binds nothing
// its body can read.
export function expressionExpected(token: lexer.Token): ParseError {
	let found = `Expected an Expression but found ${describeToken(token)}.`

	if (token.type !== lexer.TokenType.SymbolUnderscore) {
		return new ParseError(found, token.position)
	}

	return new ParseError(found, token.position, "'_' names no value", {
		notes: ["A '_' leaves a name out, so there is nothing to read."],
		helps: [
			"To read a Parameter that binds no name, give it one: '_: Integer' becomes '_ value: Integer', and 'on _: Integer' becomes 'on value: Integer'.",
		],
	})
}
