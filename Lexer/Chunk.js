"use strict";

var Chunk = function(lexer) {
	this.text = ""
	this.token = {
		line: lexer.line,
		collumn: lexer.collumn,
		type: "",
		value: ""
	}
	this.delimiterChunk
}

Chunk.prototype._isOperator = function(text) {
	return !!(new RegExp(/^[=\.\,~\+\-*\\/\^?!]$/).exec(text))
}

Chunk.prototype._isDelimiter = function(text) {
	return !!~["(", ")", "[", "]", "{", "}", ":"].indexOf(text)
}

Chunk.prototype._isFullOutdent = function(text) {
	return text === "\n"
}

Chunk.prototype._isIndent = function(text) {
	return text === "\t"
}

Chunk.prototype._isKeyword = function(text) {
	return !!~["new", "func", "block", "if", "else", "and", "or", "namespace", "class", "return", "null"].indexOf(text)
}

Chunk.prototype._isString = function(text) {
	return text[0] === "\"" && text[text.length - 1] === "\"" && text.length > 1
}

Chunk.prototype._isNumber = function(text) {
	return !!(new RegExp(/^[0123456789_]+\.?[01234567890_]*$/).exec(text))
}

Chunk.prototype.add = function(text) {
	this.text += text
}

Chunk.prototype.attemptTokenComplete = function() {
	if (this._isFullOutdent(this.text)) {
		this.token.type = "fulloutdent"
		return true
	}

	if (this._isIndent(this.text)) {
		this.token.type = "indent"
		return true
	}

	if (this._isDelimiter(this.text.trim())) {
		this.token.type = "delimiter"
		return true
	}

	if (this._isOperator(this.text.trim())) {
		this.token.type = "operator"
		return true
	}

	if (this._isKeyword(this.text.trim())) {
		this.token.type = "keyword"
		return true
	}

	if (this._isString(this.text.trim())) {
		this.token.type = "string"
		this.text = this.text.slice(1, -1)
		return true
	}

	if (this._isNumber(this.text.trim())) {
		this.token.type = "number"
		return true
	}

	var lastChar = this.text[this.text.length - 1]
	if ((lastChar === " " ||
		this._isIndent(lastChar) ||
		this._isDelimiter(lastChar) ||
		this._isOperator(lastChar) ||
		this._isFullOutdent(lastChar)
		) && this.text.trim().length > 0) {
		this.token.type = "symbol"
		return true
	}

	return false
}

Chunk.prototype.completeToken = function() {
	var lastChar = this.text[this.text.length - 1]
	if (this.token.type === "symbol" && (this._isDelimiter(lastChar) || this._isOperator(lastChar))) {
		this.text = this.text.slice(0, -1)
	}

	this.token.value = this.text.trim()
}

module.exports = Chunk
