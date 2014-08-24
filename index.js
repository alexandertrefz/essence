"use strict";

var fs = require("fs")
var util = require("util")

var Parser = require("./Parser/Parser.js")

var parser = new Parser()

var lexer = parser.parse(fs.readFileSync("./test/basic.es", "utf8"))

console.log(lexer.tokens.length)
console.log(util.inspect(lexer.tokens, { depth: null }))
