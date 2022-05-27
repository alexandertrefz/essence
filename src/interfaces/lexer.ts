import { Position } from "./common"

export enum TokenType {
	SymbolAt = "SymbolAt",
	SymbolEqual = "SymbolEqual",
	SymbolColon = "SymbolColon",
	SymbolTilde = "SymbolTilde",
	SymbolDot = "SymbolDot",
	SymbolComma = "SymbolComma",
	SymbolUnderscore = "SymbolUnderscore",
	SymbolDash = "SymbolDash",
	SymbolPipe = "SymbolPipe",
	SymbolSlash = "SymbolSlash",
	SymbolLeftParen = "SymbolLeftParen",
	SymbolRightParen = "SymbolRightParen",
	SymbolLeftBrace = "SymbolLeftBrace",
	SymbolRightBrace = "SymbolRightBrace",
	SymbolLeftBracket = "SymbolLeftBracket",
	SymbolRightBracket = "SymbolRightBracket",
	SymbolLeftAngle = "SymbolLeftAngle",
	SymbolRightAngle = "SymbolRightAngle",

	LiteralTrue = "LiteralTrue",
	LiteralFalse = "LiteralFalse",
	LiteralString = "LiteralString",
	LiteralNumber = "LiteralNumber",

	KeywordType = "KeywordType",
	KeywordIf = "KeywordIf",
	KeywordElse = "KeywordElse",
	KeywordStatic = "KeywordStatic",
	KeywordConstant = "KeywordConstant",
	KeywordVariable = "KeywordVariable",
	KeywordFunction = "KeywordFunction",
	KeywordImplementation = "KeywordImplementation",
	KeywordOverload = "KeywordOverload",

	Identifier = "Identifier",
	Linebreak = "Linebreak",
	Comment = "Comment",
}

export interface Token {
	value: string
	type: TokenType
	position: Position
}

export interface SimpleToken {
	type: TokenType
	value: string
}
