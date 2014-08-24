"use strict";

var Lexer = require("../Lexer/Lexer.js")

var Parser = function () {

}

Parser.prototype.parse = function(code) {
	var lexer = new Lexer()

	lexer.tokenize(code)
	this._parseFunctions(lexer)
	return lexer
}

Parser.prototype._parseArgumentList = function(tokens) {


	return tokens
}

Parser.prototype._parseFunction = function(tokens) {
	var argumentListTokens = []
	var bodyTokens = []
	var i, blockLevel = 1

	i = 1
	while(tokens[i].type !== "startblock") {
		argumentListTokens.push(tokens[i])
		i++
	}

	i++ // skip initial startBlock token
	while(i < tokens.length - 1) { // skip final endblock token
		bodyTokens.push(tokens[i])
		i++
	}

	return {
		type: "function",
		line: tokens[0].line,
		collumn: tokens[0].collumn,
		value: "", // satisfy original token interface
		argumentList: this._parseArgumentList(argumentListTokens),
		body: bodyTokens
	}
}

Parser.prototype._parseFunctions = function(lexer) {
	var tokens = []
	var blockLevel = 0
	var functionTokens = []
	var i, hasStarted

	while (lexer.tokens.length) {
		if (lexer.tokens[0].type === "keyword" && lexer.tokens[0].value === "func") {
			functionTokens = []
			functionTokens.push(lexer.tokens[0])

			blockLevel = 0
			i = 1
			hasStarted = false
			while(!hasStarted || blockLevel > 0) {
				if (lexer.tokens[i].type === "startblock") {
					hasStarted = true
					blockLevel++
				}

				if (lexer.tokens[i].type === "endblock") {
					blockLevel--
				}

				functionTokens.push(lexer.tokens[i])
				i++
			}

			lexer.tokens = lexer.tokens.slice(functionTokens.length)

			for (i = 0; i < functionTokens.length; i++) {

			}

			tokens.push(this._parseFunction(functionTokens))
		}

		tokens.push(lexer.tokens.shift())
	}

	lexer.tokens = tokens
}

module.exports = Parser
