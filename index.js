"use strict";

let Lexer = require('./lib/Lexer')
let Parser = require('./lib/Parser')
let fs = require('fs')
let util = require('util')

let TokenType = Lexer.TokenType
Lexer = Lexer.Lexer

let fileName = 'HelloWorld'
let tokens = Lexer.lex(fs.readFileSync('./testFiles/' + fileName + '.es', 'utf-8'))

let program = Parser.parse(tokens)

program.nodes.forEach(function(node) {
	console.log(util.inspect(node, { showHidden: false, depth: null }))
	console.log()
})
