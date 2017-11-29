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
	  Statement
	| Expression
	| Program Statement  {% t => ([...t[0], t[1]]) %}
	| Program Expression {% t => ([...t[0], t[1]]) %}

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
		([keyword, type, name, _, value]) => generators.constantDeclarationStatement(name, type, value, keyword.position)
	%}

VariableDeclarationStatement ->
	VariableKeyword Type:? Identifier EqualSign Expression {%
		([keyword, type, name, _, value]) => generators.variableDeclarationStatement(name, type, value, keyword.position)
	%}

VariableAssignmentStatement ->
	Identifier EqualSign Expression {% ([name, _, value]) => generators.variableAssignmentStatement(name, value, name.position) %}

TypeDefinitionStatement ->
	TypeKeyword Identifier TypeDefinitionBody {% ([keyword, name, body]) => generators.typeDefinitionStatement(name, body, keyword.position) %}

IfElseStatement ->
	  IfStatement ElseKeyword Block           {% ([ifStatement, _, block]) => generators.ifElseStatementNode(ifStatement, block) %}
	| IfStatement ElseKeyword IfStatement     {% ([ifStatement, _, block]) => generators.ifElseStatementNode(ifStatement, block) %}
	| IfStatement ElseKeyword IfElseStatement {% ([ifStatement, _, block]) => generators.ifElseStatementNode(ifStatement, block) %}

IfStatement ->
	IfKeyword Expression Block {% ([keyword, condition, block]) => generators.ifStatement(condition, block, keyword.position) %}

ReturnStatement ->
	ReturnSymbol Expression {% ([symbol, value]) => generators.returnStatement(value, symbol.position) %}

FunctionStatement ->
	FunctionKeyword Identifier FunctionLiteral {% ([keyword, name, value]) => generators.functionStatement(name, value.value, keyword.position) %}

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
	NativeLookupSymbol Identifier ArgumentList {% ([symbol, name, args]) => generators.nativeFunctionInvocation(name, args, symbol.position) %}

MethodInvocation ->
	MethodLookup ArgumentList {% ([lookup, args]) => generators.methodInvocation(lookup, args, lookup.position) %}

FunctionInvocation ->
	ExpressionWithoutMethodLookup ArgumentList {% ([expression, args]) => generators.functionInvocation(expression, args, expression.position) %}

Combination ->
	Expression CombinationSymbol Expression {% ([lhs, _, rhs]) => generators.combination(lhs, rhs, lhs.position) %}

Value ->
	  TypedRecordLiteral     {% id %}
	| AnonymousRecordLiteral {% id %}
	| StringLiteral          {% id %}
	| NumberLiteral          {% id %}
	| BooleanLiteral         {% id %}
	| FunctionLiteral        {% id %}
	| ArrayLiteral           {% id %}

Lookup ->
	Expression Dot Identifier {% ([base, _, member]) => generators.lookup(base, member, base.position) %}

Identifier ->
	%Identifier {% ([identifierToken]) => generators.identifier(identifierToken.value, identifierToken.position) %}

Self ->
	AtSign {% ([symbol]) => generators.self(symbol.position) %}

MethodLookup ->
	ExpressionWithoutMethodLookup MethodLookupSymbol Identifier {% ([base, _, member]) => generators.methodLookup(base, member, base.position) %}

###########
# Helpers #
###########

# ------------------ #
# Partial Constructs #
# ------------------ #

Block ->
	LeftBrace (Statement | Expression):* RightBrace {% t => flatten(t[1]) %}

TypeDefinitionBody ->
	LeftBrace (TypeProperty | TypeMethod):* RightBrace {% ([_, body]) => flatten(body) %}

TypeProperty ->
	Identifier Colon Type {% ([name, _, type]) => ({ nodeType: "PropertyNode", name, type }) %}

TypeMethod ->
	  Identifier FunctionLiteral               {% ([name, method]) =>    ({ nodeType: "MethodNode", name, method, isStatic: false }) %}
	| StaticKeyword Identifier FunctionLiteral {% ([_, name, method]) => ({ nodeType: "MethodNode", name, method, isStatic: true }) %}

ReturnSymbol ->
	LeftAngle Dash {% symbol %}

#          #
# Literals #
#          #

TypedRecordLiteral ->
	TypeHeader AnonymousRecordLiteral {% ([type, record]) => generators.recordValueNode(type, record.members, type.position) %}

AnonymousRecordLiteral ->
	LeftBrace KeyValuePairList RightBrace {% ([symbol, kvpList]) => generators.recordValueNode(null, kvpList, symbol.position) %}

KeyValuePair ->
	Identifier EqualSign Expression {% ([identifer, _, value]) => generators.keyValuePair(identifer.content, value) %}

KeyValuePairList ->
	(KeyValuePair Comma):* KeyValuePair Comma:? {% ([kvpCommaList, kvp]) => generators.buildKeyValuePairList(kvpCommaList.map(first), kvp) %}

StringLiteral ->
	%LiteralString {% ([stringToken]) => generators.stringValueNode(stringToken.value, stringToken.position) %}

Integer ->
	  %LiteralNumber             {% id %}
	| Integer Underscore Integer {%
		([leftPartialNumber, _, rightPartialNumber]) => ({ value: leftPartialNumber.value + rightPartialNumber.value, position: leftPartialNumber.position })
	%}

NumberLiteral ->
	  Integer             {% ([integer]) =>           generators.numberValueNode(integer.value,                     integer.position) %}
	| Integer Dot Integer {% ([integer, _, float]) => generators.numberValueNode(integer.value + "." + float.value, integer.position) %}

BooleanLiteral ->
	  %LiteralTrue  {% ([booleanToken]) => generators.booleanValueNode(true,  booleanToken.position) %}
	| %LiteralFalse {% ([booleanToken]) => generators.booleanValueNode(false, booleanToken.position) %}

FunctionLiteral ->
	ParameterList ReturnType Block {%
		([paramList, returnType, block]) => generators.functionValueNode(generators.functionDefinition(paramList.parameters, returnType, block), paramList.position)
	%}

ArrayLiteral ->
	  LeftBracket RightBracket                {% ([symbol]) =>         generators.arrayValueNode([],     symbol.position) %}
	| LeftBracket ExpressionList RightBracket {% ([symbol, values]) => generators.arrayValueNode(values, symbol.position) %}

ExpressionList ->
	(Expression Comma):* Expression Comma:? {% ([list, expression]) => ([...list.map(first), expression]) %}

#           #
# Functions #
#           #

Parameter ->
	  Identifier Colon Type            {% ([name, _, type]) =>                       generators.parameter(name,         name,         type, name.position) %}
	| Identifier Identifier Colon Type {% ([externalName, internalName, _, type]) => generators.parameter(externalName, internalName, type, externalName.position) %}
	| Underscore Identifier Colon Type {% ([symbol, internalName, _, type]) =>       generators.parameter(null,         internalName, type, symbol.position) %}

ParameterList ->
	  LeftParen RightParen {% ([symbol]) => ({ parameters: [], position: symbol.position }) %}
	| LeftParen (Parameter Comma):* Parameter Comma:? RightParen {%
		([symbol, paramCommaList, param]) => ({ parameters: [...paramCommaList.map(first), param], position: symbol.position })
	%}

Argument ->
	  Expression            {% ([expression]) =>       generators.argument(null, expression) %}
	| Identifier Expression {% ([name, expression]) => generators.argument(name, expression) %}

ArgumentList ->
	  LeftParen RightParen {% () => ([]) %}
	| LeftParen (Argument Comma):* Argument Comma:? RightParen {% ([_, argumentCommaList, argument]) => ([...argumentCommaList.map(first), argument]) %}

#       #
# Types #
#       #

Type ->
	  Identifier {% ([identifer]) => generators.identifierTypeDeclaration(identifer, identifer.position) %}
	| LeftBracket Type RightBracket {% ([symbol, type, _]) => generators.arrayTypeDeclaration(type, symbol.position) %}

TypeHeader ->
	Type Tilde RightAngle {% first %}

ReturnType ->
	ReturnSymbol Type {% second %}

# -------- #
# Keywords #
# -------- #

TypeKeyword     -> %KeywordType     {% id %}
IfKeyword       -> %KeywordIf       {% id %}
ElseKeyword     -> %KeywordElse     {% id %}
VariableKeyword -> %KeywordVariable {% id %}
ConstantKeyword -> %KeywordConstant {% id %}
FunctionKeyword -> %KeywordFunction {% id %}
StaticKeyword   -> %KeywordStatic   {% id %}

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
