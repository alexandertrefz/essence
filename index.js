"use strict";

var fs = require("fs")
var util = require("util")

var Parser = require("./Parser/Parser.js")

var parser = new Parser()

var tokens = parser.parse(fs.readFileSync("./test/basic.es", "utf8"))

console.log(tokens.length)
console.log(util.inspect(tokens, { depth: null }))
