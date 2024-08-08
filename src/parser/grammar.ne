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
	| TypeAliasStatement           {% id %}
	| NamespaceDefinitionStatement {% id %}
	| IfElseStatement              {% id %}
	| IfStatement                  {% id %}
	| ReturnStatement              {% id %}
	| FunctionStatement            {% id %}

ConstantDeclarationStatement ->
	ConstantKeyword Identifier DeclarationType:? EqualSign Expression {%
		([keyword, name, type, _, value]) => generators.constantDeclarationStatement(name, type, value, { start: keyword.position.start, end: value.position.end })
	%}

VariableDeclarationStatement ->
	VariableKeyword Identifier DeclarationType:? EqualSign Expression {%
		([keyword, name, type, _, value]) => generators.variableDeclarationStatement(name, type, value, { start: keyword.position.start, end: value.position.end })
	%}

VariableAssignmentStatement ->
	Identifier EqualSign Expression {% ([name, _, value]) => generators.variableAssignmentStatement(name, value, { start: name.position.start, end: value.position.end }) %}

TypeAliasStatement ->
	TypeKeyword Identifier EqualSign Type {% ([keyword, name, _, type]) => generators.typeAliasStatement(name, type, { start: keyword.position.start, end: type.position.end }) %}

NamespaceDefinitionStatement ->
	  NamespaceKeyword Identifier NamespaceBody                 {% ([keyword, name, body]) =>          generators.namespaceDefinitionStatement(name, null, body.body, { start: keyword.position.start, end: body.position.end }) %}
	| NamespaceKeyword Identifier ForKeyword Type NamespaceBody {% ([keyword, name, _, type, body]) => generators.namespaceDefinitionStatement(name, type, body.body, { start: keyword.position.start, end: body.position.end }) %}

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
	  NativeFunctionInvocation {% id %}
	| MethodInvocation         {% id %}
	| FunctionInvocation       {% id %}
	| Combination              {% id %}
	| Value                    {% id %}
	| Lookup                   {% id %}
	| Identifier               {% id %}
	| Self                     {% id %}
	| Match                    {% id %}

NativeFunctionInvocation ->
	NativeLookupSymbol Identifier ArgumentList {%
		([symbol, name, args]) => generators.nativeFunctionInvocation(name, args.args, { start: symbol.position.start, end: args.position.end })
	%}


NamespaceSpecifier ->
	LeftAngle Identifier RightAngle {% second %}

MethodInvocation ->
	Expression MethodLookupSymbol NamespaceSpecifier:? Identifier ArgumentList {%
		([base, _, namespaceSpecifier, name, args]) => {
			return generators.methodInvocation(
				base,
				name,
				namespaceSpecifier,
				args.args,
				{ start: base.position.start, end: args.position.end }
			)
		}
	%}

FunctionInvocation ->
	Expression ArgumentList {% ([expression, args]) => generators.functionInvocation(expression, args.args, { start: expression.position.start, end: args.position.end }) %}

Combination ->
	  LeftBrace Expression WithKeyword KeyValuePairList RightBrace {% ([lbrace, lhs, withKeyword, rhs, rbrace]) => generators.combination(lhs, generators.recordValueNode(null, rhs.data, rhs.position), { start: lhs.position.start, end: rhs.position.end }) %}
	| LeftBrace Expression WithKeyword Expression RightBrace       {% ([lbrace, lhs, withKeyword, rhs, rbrace]) => generators.combination(lhs, rhs, { start: lhs.position.start, end: rhs.position.end }) %}

Value ->
	  TypedRecordLiteral     {% id %}
	| AnonymousRecordLiteral {% id %}
	| StringLiteral          {% id %}
	| FractionLiteral        {% id %}
	| IntegerLiteral         {% id %}
	| BooleanLiteral         {% id %}
	| NothingLiteral         {% id %}
	| GenericFunctionLiteral {% id %}
	| FunctionLiteral        {% id %}
	| ListLiteral            {% id %}

Lookup ->
	Expression Dot Identifier {% ([base, _, member]) => generators.lookup(base, member, { start: base.position.start, end: member.position.end }) %}

Identifier ->
	  %Identifier   {% ([identifierToken]) => generators.identifier(identifierToken.value, identifierToken.position) %}
	| WithKeyword   {% ([keywordToken]) =>    generators.identifier(keywordToken.value,    keywordToken.position) %}
	| StaticKeyword {% ([keywordToken]) =>    generators.identifier(keywordToken.value,    keywordToken.position) %}
	| CaseKeyword   {% ([keywordToken]) =>    generators.identifier(keywordToken.value,    keywordToken.position) %}

Self ->
	AtSign {% ([symbol]) => generators.self(symbol.position) %}

Match ->
	MatchKeyword Expression ReturnType LeftBrace (MatchHandler):* RightBrace {%
		([keyword, expression, returnType, lbrace, handlers, rbrace]) => generators.match(expression, returnType, flatten(handlers), { start: keyword.position.start, end: rbrace.position.end })
	%}

###########
# Helpers #
###########

# ------------------ #
# Partial Constructs #
# ------------------ #

Block ->
	LeftBrace (Statement | Expression):* RightBrace {% ([lbrace, body, rbrace]) => ({ body: flatten(body), position: { start: lbrace.position.start, end: rbrace.position.end } }) %}

MatchHandler ->
	CaseKeyword Type Block {% ([_, matcher, block]) => ({ matcher, body: block.body }) %}

NamespaceBody ->
	LeftBrace (NamespaceProperty | NamespaceMethod):* RightBrace {% ([lbrace, body, rbrace]) => ({ body: flatten(body), position: { start: lbrace.position.start, end: rbrace.position.end } }) %}

NamespaceProperty ->
	StaticKeyword Identifier DeclarationType:? EqualSign Expression {% ([keyword, name, type, , value]) => ({ nodeType: "NamespacePropertyNode", name, type, value }) %}

NamespaceMethod ->
	  Identifier FunctionLiteral                               {% ([   name, method]) => ({ nodeType: "SimpleMethodNode",           name, method }) %}
	| StaticKeyword Identifier FunctionLiteral                 {% ([,  name, method]) => ({ nodeType: "StaticMethodNode",           name, method }) %}
	| OverloadKeyword Identifier FunctionLiteral               {% ([,  name, method]) => ({ nodeType: "OverloadedMethodNode",       name, method }) %}
	| OverloadKeyword StaticKeyword Identifier FunctionLiteral {% ([,, name, method]) => ({ nodeType: "OverloadedStaticMethodNode", name, method }) %}

DeclarationType ->
	Colon Type {% second %}

# -------- #
# Literals #
# -------- #

TypedRecordLiteral ->
	TypeHeader AnonymousRecordLiteral {% ([type, record]) => generators.recordValueNode(type, record.members, { start: type.position.start, end: record.position.end }) %}

AnonymousRecordLiteral ->
	  LeftBrace RightBrace                  {% ([lbrace,          rbrace]) => generators.recordValueNode(null, {},           { start: lbrace.position.start, end: rbrace.position.end }) %}
	| LeftBrace KeyValuePairList RightBrace {% ([lbrace, kvpList, rbrace]) => generators.recordValueNode(null, kvpList.data, { start: lbrace.position.start, end: rbrace.position.end }) %}

KeyValuePair ->
	Identifier EqualSign Expression {% ([identifier, _, value]) => generators.keyValuePair(identifier.content, value, { start: identifier.position.start, end: value.position.end }) %}

KeyValuePairList ->
	(KeyValuePair Comma):* KeyValuePair Comma:? {% ([kvpCommaList, kvp]) => generators.buildKeyValuePairList(kvpCommaList.map(first), kvp) %}

StringLiteral ->
	%LiteralString {% ([stringToken]) => generators.stringValueNode(stringToken.value, stringToken.position) %}

Integer ->
	Dash:? %LiteralNumber (Underscore %LiteralNumber):* {%
		([dash, leftPartialNumber, otherPartialNumbers]) => {
			let end
			let start
			let value = [leftPartialNumber, ...otherPartialNumbers.map(second)].map(partial => partial.value).join("")

			if (dash) {
				value = "-" + value
				start = dash.position.start
			} else {
				start = leftPartialNumber.position.start
			}

			if (otherPartialNumbers.length > 0) {
				end = otherPartialNumbers[otherPartialNumbers.length - 1][1].position.end;
			} else {
				end = leftPartialNumber.position.end;
			}

			return {
				value: value,
				position: { start: start, end: end }
			}
		}
	%}

IntegerLiteral ->
	  Integer {% ([integer]) => generators.integerValueNode(integer.value, integer.position) %}

FractionLiteral ->
	  Integer Slash Integer {% ([numerator, _, denominator]) => generators.fractionValueNode(numerator.value, denominator.value, { start: numerator.position.start, end: denominator.position.end }) %}

BooleanLiteral ->
	  %LiteralTrue  {% ([booleanToken]) => generators.booleanValueNode(true,  booleanToken.position) %}
	| %LiteralFalse {% ([booleanToken]) => generators.booleanValueNode(false, booleanToken.position) %}

NothingLiteral ->
	  %LiteralNothing {% ([nothingToken]) => generators.nothingValueNode(nothingToken.position) %}

FunctionLiteral ->
	ParameterList ReturnType Block {%
		([paramList, returnType, block]) => generators.functionValueNode(generators.functionDefinition(paramList.parameters, returnType, block.body), { start: paramList.position.start, end: block.position.end })
	%}

GenericFunctionLiteral ->
	GenericList ParameterList ReturnType Block {%
		([genericList, paramList, returnType, block]) => generators.functionValueNode(
			generators.genericFunctionDefinition(genericList.generics, paramList.parameters, returnType, block.body), { start: paramList.position.start, end: block.position.end }
		)
	%}

ListLiteral ->
	  LeftBracket RightBracket                {% ([lbracket,         rbracket]) => generators.listValueNode([],     { start: lbracket.position.start, end: rbracket.position.end }) %}
	| LeftBracket ExpressionList RightBracket {% ([lbracket, values, rbracket]) => generators.listValueNode(values, { start: lbracket.position.start, end: rbracket.position.end }) %}

ExpressionList ->
	(Expression Comma):* Expression Comma:? {% ([list, expression]) => ([...list.map(first), expression]) %}

# --------- #
# Functions #
# --------- #

Parameter ->
	  Identifier Colon Type            {% ([name, _, type]) =>                       generators.parameter(name,         name,         type, { start: name.position.start, end: type.position.end }) %}
	| Identifier Identifier Colon Type {% ([externalName, internalName, _, type]) => generators.parameter(externalName, internalName, type, { start: externalName.position.start, end: type.position.end }) %}
	| Underscore Identifier Colon Type {% ([symbol, internalName, _, type]) =>       generators.parameter(null,         internalName, type, { start: symbol.position.start, end: type.position.end }) %}

ParameterList ->
	  LeftParen RightParen {% ([leftParen, rightParen]) => ({ parameters: [], position: { start: leftParen.position.start, end: rightParen.position.end } }) %}
	| LeftParen (Parameter Comma):* Parameter Comma:? RightParen {%
		([leftParen, paramCommaList, param, _, rightParen]) => ({
			parameters: [...paramCommaList.map(first), param],
			position: { start: leftParen.position.start, end: rightParen.position.end }
		})
	%}

GenericDeclaration ->
	  Identifier                {% ([name]) =>          generators.genericDeclarationNode(name, null, name.position) %}
	| Identifier EqualSign Type {% ([name, _, type]) => generators.genericDeclarationNode(name, type, { start: name.position.start, end: type.position.end }) %}

GenericList ->
	LeftAngle (GenericDeclaration Comma):* GenericDeclaration Comma:? RightAngle {%
		([leftAngle, genericCommaList, generic, _, rightAngle]) => ({ generics: [...genericCommaList.map(first), generic], position: { start: leftAngle.position.start, end: rightAngle.position.end } })
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
	  SimpleType {% id %}
	| UnionType  {% id %}

SimpleType ->
	  IdentifierType {% id %}
	| RecordType     {% id %}

IdentifierType ->
	Identifier {% ([identifier]) => generators.identifierTypeDeclaration(identifier, identifier.position) %}

RecordType ->
	  LeftBrace RightBrace                 {% ([leftBrace,          rightBrace]) => generators.recordTypeDeclaration({},           { start: leftBrace.position.start, end: rightBrace.position.end }) %}
	| LeftBrace KeyTypePairList RightBrace {% ([leftBrace, kvtList, rightBrace]) => generators.recordTypeDeclaration(kvtList.data, { start: leftBrace.position.start, end: rightBrace.position.end }) %}

KeyTypePairList ->
	(KeyTypePair Comma):* KeyTypePair Comma:? {% ([kvtCommaList, kvt]) => generators.buildKeyTypePairList(kvtCommaList.map(first), kvt) %}

KeyTypePair ->
	Identifier Colon Type {% ([identifier, _, value]) => generators.keyTypePair(identifier.content, value, { start: identifier.position.start, end: value.position.end }) %}

UnionType ->
	SimpleType (Pipe SimpleType):+ {% ([leftType, otherTypes]) => generators.unionTypeDeclaration([leftType, ...otherTypes.map(second)], { start: leftType.position.start, end: otherTypes[otherTypes.length - 1][1].position.end }) %}

TypeHeader ->
	Type Tilde RightAngle {% first %}

ReturnType ->
	Dash RightAngle Type {% third %}

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
MatchKeyword          -> %KeywordMatch          {% id %}
CaseKeyword           -> %KeywordCase           {% id %}
WithKeyword           -> %KeywordWith           {% id %}
NamespaceKeyword      -> %KeywordNamespace      {% id %}
ForKeyword            -> %KeywordFor            {% id %}

# ---------------- #
# Compound Symbols #
# ---------------- #

NativeLookupSymbol ->
	Underscore Underscore {% symbol %}

MethodLookupSymbol ->
	Colon Colon {% symbol %}

CombinationSymbol ->
	LeftAngle Pipe {% symbol %}

ReturnSymbol ->
	LeftAngle Dash {% symbol %}

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
Slash        -> %SymbolSlash        {% id %}
LeftBrace    -> %SymbolLeftBrace    {% id %}
RightBrace   -> %SymbolRightBrace   {% id %}
LeftBracket  -> %SymbolLeftBracket  {% id %}
RightBracket -> %SymbolRightBracket {% id %}
LeftParen    -> %SymbolLeftParen    {% id %}
RightParen   -> %SymbolRightParen   {% id %}
LeftAngle    -> %SymbolLeftAngle    {% id %}
RightAngle   -> %SymbolRightAngle   {% id %}
