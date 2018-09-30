@preprocessor typescript
@{%

import { lexer as lexerInterfaces, parser as parserInterfaces } from "../interfaces"
import { Lexer } from "../lexer"
import * as generators from "./nodeGenerators"
import { first, second, third, symbol, flatten } from "../helpers"

const lexer = new Lexer()

lexer.ignore(lexerInterfaces.TokenType.Comment)
lexer.ignore(lexerInterfaces.TokenType.Linebreak)

%}

@lexer lexer

Program ->
	ImplementationSection {% ([implementation]) => generators.program(implementation, implementation.position) %}

ImplementationSection ->
	ImplementationKeyword LeftBrace ImplementationNodes:? RightBrace {%
		([keyword, lbrace, implementationNodes, rbrace]) => generators.implementationSection(implementationNodes, { start: keyword.position.start, end: rbrace.position.end })
	%}

ImplementationNodes ->
	  Statement
	| Expression
	| ImplementationNodes Statement  {% t => ([...t[0], t[1]]) %}
	| ImplementationNodes Expression {% t => ([...t[0], t[1]]) %}

# --------- #
# Statement #
# --------- #

Statement ->
	  ConstantDeclarationStatement {% id %}
	| VariableDeclarationStatement {% id %}
	| VariableAssignmentStatement  {% id %}
	| TypeDefinitionStatement      {% id %}
	| IfElseStatement              {% id %}
	| IfStatement                  {% id %}
	| ReturnStatement              {% id %}
	| FunctionStatement            {% id %}

ConstantDeclarationStatement ->
	ConstantKeyword Type:? Identifier EqualSign Expression {%
		([keyword, type, name, _, value]) => generators.constantDeclarationStatement(name, type, value, { start: keyword.position.start, end: value.position.end })
	%}

VariableDeclarationStatement ->
	VariableKeyword Type:? Identifier EqualSign Expression {%
		([keyword, type, name, _, value]) => generators.variableDeclarationStatement(name, type, value, { start: keyword.position.start, end: value.position.end })
	%}

VariableAssignmentStatement ->
	Identifier EqualSign Expression {% ([name, _, value]) => generators.variableAssignmentStatement(name, value, { start: name.position.start, end: value.position.end }) %}

TypeDefinitionStatement ->
	TypeKeyword Identifier TypeDefinitionBody {% ([keyword, name, body]) => generators.typeDefinitionStatement(name, body.body, { start: keyword.position.start, end: body.position.end }) %}

IfElseStatement ->
	  IfStatement ElseKeyword Block           {% ([ifStatement, _, block]) => generators.ifElseStatementNode(ifStatement, block.body, { start: ifStatement.position.start, end: block.position.end }) %}
	| IfStatement ElseKeyword IfStatement     {% ([ifStatement, _, block]) => generators.ifElseStatementNode(ifStatement, block,      { start: ifStatement.position.start, end: block.position.end }) %}
	| IfStatement ElseKeyword IfElseStatement {% ([ifStatement, _, block]) => generators.ifElseStatementNode(ifStatement, block,      { start: ifStatement.position.start, end: block.position.end }) %}

IfStatement ->
	IfKeyword Expression Block {% ([keyword, condition, block]) => generators.ifStatement(condition, block.body, { start: keyword.position.start, end: block.position.end }) %}

ReturnStatement ->
	ReturnSymbol Expression {% ([symbol, value]) => generators.returnStatement(value, { start: symbol.position.start, end: value.position.end }) %}

FunctionStatement ->
	FunctionKeyword Identifier FunctionLiteral {% ([keyword, name, value]) => generators.functionStatement(name, value.value, { start: keyword.position.start, end: value.position.end }) %}

# ---------- #
# Expression #
# ---------- #

Expression ->
	  ExpressionWithoutMethodLookup {% id %}
	| MethodLookup                  {% id %}

ExpressionWithoutMethodLookup ->
	  NativeFunctionInvocation {% id %}
	| MethodInvocation         {% id %}
	| FunctionInvocation       {% id %}
	| Combination              {% id %}
	| Value                    {% id %}
	| Lookup                   {% id %}
	| Identifier               {% id %}
	| Self                     {% id %}


NativeFunctionInvocation ->
	NativeLookupSymbol Identifier ArgumentList {%
		([symbol, name, args]) => generators.nativeFunctionInvocation(name, args.args, { start: symbol.position.start, end: args.position.end })
	%}

MethodInvocation ->
	MethodLookup ArgumentList {% ([lookup, args]) => generators.methodInvocation(lookup, args.args, { start: lookup.position.start, end: args.position.end }) %}

FunctionInvocation ->
	ExpressionWithoutMethodLookup ArgumentList {% ([expression, args]) => generators.functionInvocation(expression, args.args, { start: expression.position.start, end: args.position.end }) %}

Combination ->
	Expression CombinationSymbol Expression {% ([lhs, _, rhs]) => generators.combination(lhs, rhs, { start: lhs.position.start, end: rhs.position.end }) %}

Value ->
	  TypedRecordLiteral     {% id %}
	| AnonymousRecordLiteral {% id %}
	| StringLiteral          {% id %}
	| NumberLiteral          {% id %}
	| BooleanLiteral         {% id %}
	| FunctionLiteral        {% id %}
	| ListLiteral           {% id %}

Lookup ->
	Expression Dot Identifier {% ([base, _, member]) => generators.lookup(base, member, { start: base.position.start, end: member.position.end }) %}

Identifier ->
	%Identifier {% ([identifierToken]) => generators.identifier(identifierToken.value, identifierToken.position) %}

Self ->
	AtSign {% ([symbol]) => generators.self(symbol.position) %}

MethodLookup ->
	ExpressionWithoutMethodLookup MethodLookupSymbol Identifier {% ([base, , member]) => generators.methodLookup(base, member, { start: base.position.start, end: member.position.end }) %}

###########
# Helpers #
###########

# ------------------ #
# Partial Constructs #
# ------------------ #

Block ->
	LeftBrace (Statement | Expression):* RightBrace {% ([lbrace, body, rbrace]) => ({ body: flatten(body), position: { start: lbrace.position.start, end: rbrace.position.end } }) %}

TypeDefinitionBody ->
	LeftBrace (TypeProperty | TypeMethod):* RightBrace {% ([lbrace, body, rbrace]) => ({ body: flatten(body), position: { start: lbrace.position.start, end: rbrace.position.end } }) %}

TypeProperty ->
	Identifier Colon Type {% ([name, _, type]) => ({ nodeType: "PropertyNode", name, type }) %}

TypeMethod ->
	  Identifier FunctionLiteral                               {% ([   name, method]) => ({ nodeType: "MethodNode", name, method, isStatic: false }) %}
	| StaticKeyword Identifier FunctionLiteral                 {% ([,  name, method]) => ({ nodeType: "MethodNode", name, method, isStatic: true  }) %}
	| OverloadKeyword Identifier FunctionLiteral               {% ([,  name, method]) => ({ nodeType: "MethodNode", name, method, isStatic: false }) %}
	| OverloadKeyword StaticKeyword Identifier FunctionLiteral {% ([,, name, method]) => ({ nodeType: "MethodNode", name, method, isStatic: true  }) %}

ReturnSymbol ->
	LeftAngle Dash {% symbol %}

# -------- #
# Literals #
# -------- #

TypedRecordLiteral ->
	TypeHeader AnonymousRecordLiteral {% ([type, record]) => generators.recordValueNode(type, record.members, { start: type.position.start, end: record.position.end }) %}

AnonymousRecordLiteral ->
	LeftBrace KeyValuePairList RightBrace {% ([lbrace, kvpList, rbrace]) => generators.recordValueNode(null, kvpList, { start: lbrace.position.start, end: rbrace.position.end }) %}

KeyValuePair ->
	Identifier EqualSign Expression {% ([identifer, _, value]) => generators.keyValuePair(identifer.content, value) %}

KeyValuePairList ->
	(KeyValuePair Comma):* KeyValuePair Comma:? {% ([kvpCommaList, kvp]) => generators.buildKeyValuePairList(kvpCommaList.map(first), kvp) %}

StringLiteral ->
	%LiteralString {% ([stringToken]) => generators.stringValueNode(stringToken.value, stringToken.position) %}

Integer ->
	  %LiteralNumber             {% id %}
	| Integer Underscore Integer {%
		([leftPartialNumber, _, rightPartialNumber]) => ({ value: leftPartialNumber.value + rightPartialNumber.value, position: { start: leftPartialNumber.position.start, end: rightPartialNumber.position.end } })
	%}

NumberLiteral ->
	  Integer             {% ([integer]) =>           generators.numberValueNode(integer.value,                     integer.position) %}
	| Integer Dot Integer {% ([integer, _, float]) => generators.numberValueNode(integer.value + "." + float.value, { start: integer.position.start, end: float.position.end }) %}

BooleanLiteral ->
	  %LiteralTrue  {% ([booleanToken]) => generators.booleanValueNode(true,  booleanToken.position) %}
	| %LiteralFalse {% ([booleanToken]) => generators.booleanValueNode(false, booleanToken.position) %}

FunctionLiteral ->
	ParameterList ReturnType Block {%
		([paramList, returnType, block]) => generators.functionValueNode(generators.functionDefinition(paramList.parameters, returnType, block.body), { start: paramList.position.start, end: block.position.end })
	%}

ListLiteral ->
	  LeftBracket RightBracket                {% ([lbracket,         rbracket]) => generators.listValueNode([],     { start: lbracket.position.start, end: rbracket.position.end }) %}
	| LeftBracket ExpressionList RightBracket {% ([lbracket, values, rbracket]) => generators.listValueNode(values, { start: lbracket.position.start, end: rbracket.position.end }) %}

ExpressionList ->
	(Expression Comma):* Expression Comma:? {% ([list, expression]) => ([...list.map(first), expression]) %}

#           #
# Functions #
#           #

Parameter ->
	  Identifier Colon Type            {% ([name, _, type]) =>                       generators.parameter(name,         name,         type, { start: name.position.start, end: type.position.end }) %}
	| Identifier Identifier Colon Type {% ([externalName, internalName, _, type]) => generators.parameter(externalName, internalName, type, { start: externalName.position.start, end: type.position.end }) %}
	| Underscore Identifier Colon Type {% ([symbol, internalName, _, type]) =>       generators.parameter(null,         internalName, type, { start: symbol.position.start, end: type.position.end }) %}

ParameterList ->
	  LeftParen RightParen {% ([symbol]) => ({ parameters: [], position: symbol.position }) %}
	| LeftParen (Parameter Comma):* Parameter Comma:? RightParen {%
		([symbol, paramCommaList, param]) => ({ parameters: [...paramCommaList.map(first), param], position: symbol.position })
	%}

Argument ->
	  Expression            {% ([expression]) =>       generators.argument(null, expression) %}
	| Identifier Expression {% ([name, expression]) => generators.argument(name, expression) %}

ArgumentList ->
	  LeftParen RightParen {% ([leftParen, rightParen]) => ({ args: [], position: { start: leftParen.position.start, end: rightParen.position.end } }) %}
	| LeftParen (Argument Comma):* Argument Comma:? RightParen {%
		([leftParen, argumentCommaList, argument, _, rightParen]) => ({
			args: [...argumentCommaList.map(first), argument],
			position: { start: leftParen.position.start, end: rightParen.position.end }
		})
	%}

# ----- #
# Types #
# ----- #

Type ->
	  Identifier {% ([identifer]) => generators.identifierTypeDeclaration(identifer, identifer.position) %}
	| LeftBracket Type RightBracket {% ([lbracket, type, rbracket]) => generators.listTypeDeclaration(type, { start: lbracket.position.start, end: rbracket.position.end }) %}

TypeHeader ->
	Type Tilde RightAngle {% first %}

ReturnType ->
	ReturnSymbol Type {% second %}

# -------- #
# Keywords #
# -------- #

TypeKeyword           -> %KeywordType           {% id %}
IfKeyword             -> %KeywordIf             {% id %}
ElseKeyword           -> %KeywordElse           {% id %}
VariableKeyword       -> %KeywordVariable       {% id %}
ConstantKeyword       -> %KeywordConstant       {% id %}
FunctionKeyword       -> %KeywordFunction       {% id %}
StaticKeyword         -> %KeywordStatic         {% id %}
ImplementationKeyword -> %KeywordImplementation {% id %}
OverloadKeyword       -> %KeywordOverload       {% id %}

# ---------------- #
# Compound Symbols #
# ---------------- #

NativeLookupSymbol ->
	Underscore Underscore {% symbol %}

MethodLookupSymbol ->
	Colon Colon {% symbol %}

ReturnSymbol ->
	Dash RightAngle {% symbol %}

CombinationSymbol ->
	LeftAngle Pipe {% symbol %}

# ------- #
# Symbols #
# ------- #

AtSign       -> %SymbolAt           {% id %}
EqualSign    -> %SymbolEqual        {% id %}
Colon        -> %SymbolColon        {% id %}
Dot          -> %SymbolDot          {% id %}
Comma        -> %SymbolComma        {% id %}
Tilde        -> %SymbolTilde        {% id %}
Underscore   -> %SymbolUnderscore   {% id %}
Dash         -> %SymbolDash         {% id %}
Pipe         -> %SymbolPipe         {% id %}
LeftBrace    -> %SymbolLeftBrace    {% id %}
RightBrace   -> %SymbolRightBrace   {% id %}
LeftBracket  -> %SymbolLeftBracket  {% id %}
RightBracket -> %SymbolRightBracket {% id %}
LeftParen    -> %SymbolLeftParen    {% id %}
RightParen   -> %SymbolRightParen   {% id %}
LeftAngle    -> %SymbolLeftAngle    {% id %}
RightAngle   -> %SymbolRightAngle   {% id %}
