"use strict";

var Chunk = require("./Chunk.js")

var Lexer = function() {
	this.collumn = 1
	this.line = 1
	this.tokens = []
	this.code = ""
}

Lexer.prototype._insertChunk = function(i) {
	var tmpChunk = new Chunk(this)
	tmpChunk.add(this.code[i])
	if (tmpChunk.attemptTokenComplete()) {
		tmpChunk.completeToken()
	} else {
		throw new Error("Found Invalid Token at line: " + tmpChunk.line + " collumn: " + tmpChunk.collumn)
	}
	this.tokens.push(tmpChunk.token)
}

Lexer.prototype._createBasicTokens = function() {
	var i = 0
	var chunk = new Chunk(this)

	while (this.code.length > i) {
		chunk.add(this.code[i])

		if (chunk.attemptTokenComplete()) {
			if (chunk.token.type !== "linebreak" && chunk.token.type !== "delimiter" && chunk.token.type !== "operator") {
				chunk.completeToken()
				this.tokens.push(chunk.token)
				chunk = new Chunk(this)
			}
		}

		if (Chunk.prototype._isOperator(this.code[i])) {
			this._insertChunk(i)
			chunk = new Chunk(this)
		}

		if (Chunk.prototype._isDelimiter(this.code[i])) {
			this._insertChunk(i)
			chunk = new Chunk(this)
		}

		if (Chunk.prototype._isLinebreak(this.code[i])) {
			this._insertChunk(i)

			this.collumn = 1
			this.line++

			chunk = new Chunk(this) // update line and collumn inside Chunk
		} else {
			this.collumn++
		}

		i++
	}
}

Lexer.prototype._normalizeLinebreaks = function(tokens) {
	var normalizedTokens = []

	var i = 1
	while (tokens.length) {
		if (tokens[0].type === "linebreak" && tokens.length > 1) {
			while (tokens.length > i && tokens[i].type === "linebreak") {
				i++
			}

			if (i > 1) {
				tokens = tokens.slice(i - 1)
				i = 1
			}

			normalizedTokens.push(tokens.shift())
		} else {
			normalizedTokens.push(tokens.shift())
		}
	}

	return normalizedTokens
}

Lexer.prototype._normalizeBraces = function(tokens) {
	var normalizedTokens = []

	var i = 1
	var token
	while (tokens.length) {
		if (tokens[0].type === "delimiter" && tokens[0].value === "{") {
			token = tokens.shift()
			token.type = "startblock"
			normalizedTokens.push(token)
		} else if (tokens[0].type === "delimiter" && tokens[0].value === "}") {
			token = tokens.shift()
			token.type = "endblock"
			normalizedTokens.push(token)
		} else {
			normalizedTokens.push(tokens.shift())
		}
	}

	return normalizedTokens
}

Lexer.prototype._normalizeBlocks = function(tokens) {
	var normalizedTokens = []

	var i = 1
	while (tokens.length) {
		if (tokens[0].type === "linebreak" && tokens.length > 1) {
			if (tokens[i].type === "startblock" || tokens[i].type === "endblock") {
				tokens.shift()
				normalizedTokens.push(tokens.shift())
			}
		}

		if ((tokens[0].type === "linebreak" ||
			 tokens[0].type === "startblock" ||
			 tokens[0].type === "endblock")
			&& tokens.length > 1) {
			while (tokens.length > i && tokens[i].type === "linebreak") {
				i++
			}

			normalizedTokens.push(tokens.shift())

			if (i > 1) {
				tokens = tokens.slice(i - 1)
				i = 1
			}
		} else if ((tokens[0].type === "startblock" || tokens[0].type === "endblock") && tokens.length > 1) {
			if (tokens[i].type === "linebreak") {
				while (tokens[i].type === "linebreak") {
					i++
				}

				normalizedTokens.push(tokens.shift())

				if (i > 1) {
					tokens = tokens.slice(i - 1)
					i = 1
				}
			} else {
				normalizedTokens.push(tokens.shift())
			}
		} else {
			normalizedTokens.push(tokens.shift())
		}
	}

	return normalizedTokens
}

Lexer.prototype.tokenize = function(code) {
	this.code = code

	this._createBasicTokens()
	this.tokens = this._normalizeLinebreaks(this.tokens)
	this.tokens = this._normalizeBraces(this.tokens)
	this.tokens = this._normalizeBlocks(this.tokens)
}

module.exports = Lexer
