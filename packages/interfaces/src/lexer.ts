import type { Position } from "./common/index"

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
	SymbolHash = "SymbolHash",
	//
	LiteralTrue = "LiteralTrue",
	LiteralFalse = "LiteralFalse",
	LiteralString = "LiteralString",
	// NOTE: The three pieces an interpolated String Literal lexes into — the
	// text before the first hole (`Start`), the text between two holes
	// (`Middle`) and the text after the last hole (`End`), with the hole's own
	// Tokens lexed in place between them. A String with no holes stays a single
	// `LiteralString`, so nothing that reads a plain String has to change.
	LiteralStringStart = "LiteralStringStart",
	LiteralStringMiddle = "LiteralStringMiddle",
	LiteralStringEnd = "LiteralStringEnd",
	LiteralNumber = "LiteralNumber",
	//
	KeywordType = "KeywordType",
	KeywordIf = "KeywordIf",
	KeywordElse = "KeywordElse",
	KeywordStatic = "KeywordStatic",
	KeywordConstant = "KeywordConstant",
	KeywordVariable = "KeywordVariable",
	KeywordFunction = "KeywordFunction",
	KeywordImplementation = "KeywordImplementation",
	KeywordOverload = "KeywordOverload",
	KeywordMatch = "KeywordMatch",
	KeywordCase = "KeywordCase",
	KeywordWith = "KeywordWith",
	KeywordNamespace = "KeywordNamespace",
	KeywordProtocol = "KeywordProtocol",
	KeywordFor = "KeywordFor",
	KeywordInfer = "KeywordInfer",
	KeywordChoice = "KeywordChoice",
	KeywordImport = "KeywordImport",
	KeywordExport = "KeywordExport",
	KeywordFrom = "KeywordFrom",
	KeywordAs = "KeywordAs",
	//
	Identifier = "Identifier",
	Linebreak = "Linebreak",
	Comment = "Comment",
	DocComment = "DocComment",
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
