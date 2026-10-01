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
	// An interpolated String lexes into the text before its first hole, the
	// text between holes and the text after its last hole. Each hole's own
	// Tokens stand between them. A String without holes is one `LiteralString`.
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
	KeywordDefine = "KeywordDefine",
	KeywordOtherwise = "KeywordOtherwise",
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
	KeywordTests = "KeywordTests",
	KeywordTest = "KeywordTest",
	KeywordSuite = "KeywordSuite",
	KeywordBenchmark = "KeywordBenchmark",
	KeywordExpect = "KeywordExpect",
	KeywordRequire = "KeywordRequire",
	KeywordStart = "KeywordStart",
	KeywordComplete = "KeywordComplete",
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
	// The span of `position` as absolute offsets, so `source.slice(start, end)`
	// is the Token as written.
	start: number
	end: number
}

export interface SimpleToken {
	type: TokenType
	value: string
}
