"use strict";

var Lexer = require("../Lexer/Lexer.js")

var Parser = function () {

}

Parser.prototype._parse = function(tokens) {
	tokens = this._parseSpecialOperators(tokens)
	tokens = this._parseFunctions(tokens)
	return tokens
}

Parser.prototype.parse = function(code) {
	var lexer = new Lexer()

	lexer.tokenize(code)
	return this._parse(lexer.tokens)
}

Parser.prototype._checkOperatorCombination = function(tokens, value, op1, op2) {
	var newToken
	if (tokens[0].value === op1 && tokens[1].value === op2) {
		newToken = {
			line: tokens[0].line,
			collumn: tokens[0].collumn,
			type: "operator",
			value: value
		}
		tokens = tokens.slice(2)
		tokens.unshift(newToken)
	}

	return tokens
}

Parser.prototype._parseSpecialOperators = function(tokens) {
	var parsedTokens = []
	while (tokens.length) {
		if (tokens[0].type === "keyword" && tokens[0].value === "and") {
			tokens.shift()
			tokens.unshift({
				line: tokens[0].line,
				collumn: tokens[0].collumn,
				type: "operator",
				value: "and"
			})
		}

		if (tokens[0].type === "keyword" && tokens[0].value === "or") {
			tokens.shift()
			tokens.unshift({
				line: tokens[0].line,
				collumn: tokens[0].collumn,
				type: "operator",
				value: "or"
			})
		}

		tokens = this._checkOperatorCombination(tokens, "equals", "=", "=")
		tokens = this._checkOperatorCombination(tokens, "unequals", "!", "=")
		tokens = this._checkOperatorCombination(tokens, "lessOrEqual", "<", "=")
		tokens = this._checkOperatorCombination(tokens, "moreOrEqual", ">", "=")
		parsedTokens.push(tokens.shift())
	}

	return parsedTokens
}

Parser.prototype._parseIdentifier = function(tokens) {
	if (tokens.length === 1) {
		return tokens[0]
	}

	// TODO: Handle MemberExpr a.b
}

Parser.prototype._parseReturnType = function(tokens) {
	var returnType, errorToken
	var tmpLength = tokens.length;
	if (tokens[tmpLength - 1].type === "symbol") {
		if (tokens[tmpLength - 2].value === ">" && tokens[tmpLength - 3].value === "-") {
			returnType = tokens[tmpLength - 1].value
		} else {
			errorToken = tokens[tmpLength - 2]
			throw new Error("Expected '->' Operator or '{' Operator but found: " + errorToken.value + " at " + errorToken.line + ":" + errorToken.collumn)
		}
	} else {
		returnType = "Any"
	}

	return returnType
}

Parser.prototype._parseFunctionArgument = function(tokens) {
	var name, type, defaultValue, i

	if (tokens.length === 1) {
		return {
			line: tokens[0].line,
			collumn: tokens[0].collumn,
			name: tokens[0].value,
			type: "Any"
		}
	}

	if (tokens.length === 2) {
		throw new Error("Invalid Function Argument Description at " + tokens[0].line + ":" + tokens[0].collumn)
	}

	if (tokens.length === 3 && tokens[1].value === ":") {
		return {
			line: tokens[0].line,
			collumn: tokens[0].collumn,
			name: tokens[0].value,
			type: tokens[2].value
		}
	}

	// TODO: Implement default parameters
}

Parser.prototype._parseArgumentList = function(tokens) {
	var i, blockLevel, hasStarted, argumentTokens, tmpArr

	argumentTokens = []
	blockLevel = 0
	i = 0
	hasStarted = false
	while(!hasStarted || blockLevel > 0) {
		if (tokens[i].value === "(") {
			hasStarted = true
			blockLevel++
		}

		if (tokens[i].value === ")") {
			blockLevel--
		}

		argumentTokens.push(tokens[i])
		i++
	}

	argumentTokens = argumentTokens.slice(1, -1)

	tokens = []
 	tmpArr = []
	for (i = 0; i < argumentTokens.length; i++) {
		if (argumentTokens[i].value === ",") {
			tokens.push(this._parseFunctionArgument(tmpArr))
			tmpArr = []
			continue
		}

		tmpArr.push(argumentTokens[i])
	}

	tokens.push(this._parseFunctionArgument(tmpArr)) // handle last argument

	return tokens
}

Parser.prototype._parseFunction = function(tokens) {
	var headerTokens = []
	var bodyTokens = []
	var i, blockLevel = 1

	i = 1
	while(tokens[i].type !== "startblock") {
		headerTokens.push(tokens[i])
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
		returnType: this._parseReturnType(headerTokens),
		value: "", // satisfy original token interface
		argumentList: this._parseArgumentList(headerTokens),
		body: this._parse(bodyTokens)
	}
}

Parser.prototype._parseFunctions = function(tokens) {
	var parsedTokens = []
	var blockLevel = 0
	var functionTokens = []
	var i, hasStarted

	while (tokens.length) {
		if (tokens[0].type === "keyword" && tokens[0].value === "func") {
			functionTokens = []
			functionTokens.push(tokens[0])

			blockLevel = 0
			i = 1
			hasStarted = false
			while(!hasStarted || blockLevel > 0) {
				if (tokens[i].type === "startblock") {
					hasStarted = true
					blockLevel++
				}

				if (tokens[i].type === "endblock") {
					blockLevel--
				}

				functionTokens.push(tokens[i])
				i++
			}

			tokens = tokens.slice(functionTokens.length)

			parsedTokens.push(this._parseFunction(functionTokens))
		}

		parsedTokens.push(tokens.shift())
	}

	return parsedTokens
}

module.exports = Parser
