"use strict";

var fs = require("fs")

var Lexer = require("./Lexer/Lexer.js")

var lexer = new Lexer()

lexer.tokenize(fs.readFileSync("./test/basic.es", "utf8"))

console.log(lexer.tokens.length)
console.log(lexer.tokens)
