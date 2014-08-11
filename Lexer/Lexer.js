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
	tmpChunk.attemptTokenComplete()
	tmpChunk.completeToken()
	this.tokens.push(tmpChunk.token)
}

Lexer.prototype._createBasicTokens = function() {
	var i = 0
	var chunk = new Chunk(this)

	while (this.code.length > i) {
		chunk.add(this.code[i])

		if (chunk.attemptTokenComplete()) {
			// single character tokens can delimit a symbol,
			// so they need to be handled again - prevent double insertion
			if (chunk.token.type !== "fulloutdent" && chunk.token.type !== "delimiter" && chunk.token.type !== "operator") {
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

		if (Chunk.prototype._isFullOutdent(this.code[i])) {
			this._insertChunk(i)

			this.collumn = 1
			this.line++

			chunk = new Chunk(this)
		} else {
			this.collumn++
		}

		i++
	}
}

Lexer.prototype._normalizeOutdents = function(tokens) {
	var normalizedTokens = []

	var i = 1
	while (tokens.length) {
		if (tokens[0].type === "fulloutdent" && tokens.length > 1) {
			while (tokens[i].type === "fulloutdent") {
				i++
			}

			if (i > 1) {
				tokens = tokens.slice(i - 1)
				i = 1
			}
		}

		normalizedTokens.push(tokens.shift())
	}

	return normalizedTokens
}

Lexer.prototype._convertIndents = function(tokens) {
	var normalizedTokens = []

	var i, j
	var indentLevel = 0
	var isOutdent = false
	while (tokens.length) {
		if (tokens[0].type === "indent") {
			indentLevel++
			normalizedTokens.push({
				type: "startblock"
			})
			tokens.shift()
		} else if (tokens[0].type === "fulloutdent") {
			if (indentLevel !== 0 && tokens.length > 1) {
				for (i = 1; i <= indentLevel; i++) {
					if (tokens[i].type !== "indent") {
						j = indentLevel - (i - 1)
						indentLevel = i - 1

						while (j--) {
							normalizedTokens.push({
								type: "endblock"
							})
						}

						break;
					}
				}

				if (i > indentLevel) {
					normalizedTokens.push({
						type: "linebreak"
					})
				}

				tokens = tokens.slice(i)
			} else {
				tokens.shift()
				normalizedTokens.push({
					type: "linebreak"
				})
			}
		} else {
			normalizedTokens.push(tokens.shift())
		}
	}

	while (indentLevel--) {
		normalizedTokens.push({
			type: "endblock"
		})
	}

	return normalizedTokens
}

Lexer.prototype._normalizeLinebreaks = function(tokens) {
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
			 tokens[0].type === "endblock"
			) && tokens.length > 1) {
			while (tokens[i].type === "linebreak") {
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
	this.tokens = this._normalizeOutdents(this.tokens)
	this.tokens = this._convertIndents(this.tokens)
	this.tokens = this._normalizeLinebreaks(this.tokens)
}

module.exports = Lexer
