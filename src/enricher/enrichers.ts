import { parser, common, enricher } from "../interfaces"

import { resolveType, resolveArrayValueType, resolveMethodLookupBaseType } from "./resolvers"

export function enrichNode(node: parser.Node, scope: enricher.Scope): common.typed.Node {
	switch (node.nodeType) {
		case "NativeFunctionInvocation":
		case "MethodInvocation":
		case "FunctionInvocation":
		case "Combination":
		case "RecordValue":
		case "StringValue":
		case "NumberValue":
		case "BooleanValue":
		case "FunctionValue":
		case "ArrayValue":
		case "Lookup":
		case "Identifier":
		case "Self":
		case "MethodLookup":
			return enrichExpression(node, scope)
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "TypeDefinitionStatement":
		case "IfElseStatement":
		case "IfStatement":
		case "ReturnStatement":
		case "FunctionStatement":
			return enrichStatement(node, scope)
	}
}

/////////////////
/* Expressions */
/////////////////

export function enrichExpression(node: parser.ExpressionNode, scope: enricher.Scope): common.typed.ExpressionNode {
	switch (node.nodeType) {
		case "NativeFunctionInvocation":
			return enrichNativeFunctionInvocation(node, scope)
		case "MethodInvocation":
			return enrichMethodInvocation(node, scope)
		case "FunctionInvocation":
			return enrichFunctionInvocation(node, scope)
		case "Combination":
			return enrichCombination(node, scope)
		case "RecordValue":
			return enrichRecordValue(node, scope)
		case "StringValue":
			return enrichStringValue(node, scope)
		case "NumberValue":
			return enrichNumberValue(node, scope)
		case "BooleanValue":
			return enrichBooleanValue(node, scope)
		case "FunctionValue":
			return enrichFunctionValue(node, scope)
		case "ArrayValue":
			return enrichArrayValue(node, scope)
		case "Lookup":
			return enrichLookup(node, scope)
		case "Identifier":
			return enrichIdentifier(node, scope)
		case "Self":
			return enrichSelf(node, scope)
		case "MethodLookup":
			return enrichMethodLookup(node, scope)
	}
}

export function enrichNativeFunctionInvocation(
	node: parser.NativeFunctionInvocationNode,
	scope: enricher.Scope,
): common.typed.NativeFunctionInvocationNode {
	return {
		nodeType: "NativeFunctionInvocation",
		name: enrichIdentifier(node.name, scope),
		arguments: node.arguments.map(argument => enrichArgument(argument, scope)),
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichMethodInvocation(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): common.typed.MethodInvocationNode {
	return {
		nodeType: "MethodInvocation",
		name: enrichMethodLookup(node.name, scope),
		arguments: node.arguments.map(argument => enrichArgument(argument, scope)),
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichFunctionInvocation(
	node: parser.FunctionInvocationNode,
	scope: enricher.Scope,
): common.typed.FunctionInvocationNode {
	return {
		nodeType: "FunctionInvocation",
		name: enrichExpression(node.name, scope),
		arguments: node.arguments.map(argument => enrichArgument(argument, scope)),
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichCombination(node: parser.CombinationNode, scope: enricher.Scope): common.typed.CombinationNode {
	return {
		nodeType: "Combination",
		lhs: enrichExpression(node.lhs, scope),
		rhs: enrichExpression(node.rhs, scope),
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichMethodFunctionDefinition(
	node: { method: parser.FunctionValueNode; isStatic: boolean },
	scope: enricher.Scope,
	selfType: common.Type,
): common.typed.FunctionDefinitionNode {
	let newScope = { parent: scope, members: {} }

	if (!node.isStatic) {
		declareVariableInScope("@", selfType, newScope)
	}

	return {
		nodeType: "FunctionDefinition",
		parameters: node.method.value.parameters.map(parameter => enrichParameter(parameter, newScope)),
		body: node.method.value.body.map(node => enrichNode(node, newScope)),
	}
}

export function enrichFunctionDefinition(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.typed.FunctionDefinitionNode {
	let newScope = { parent: scope, members: {} }

	return {
		nodeType: "FunctionDefinition",
		parameters: node.parameters.map(parameter => enrichParameter(parameter, newScope)),
		body: node.body.map(node => enrichNode(node, newScope)),
	}
}

export function enrichMethodFunctionValue(
	node: { method: parser.FunctionValueNode; isStatic: boolean },
	scope: enricher.Scope,
	selfType: common.Type,
): common.typed.FunctionValueNode {
	return {
		nodeType: "FunctionValue",
		value: enrichMethodFunctionDefinition(node, scope, selfType),
		position: node.method.position,
		type: resolveType(node.method, scope),
	}
}

export function enrichRecordValue(node: parser.RecordValueNode, scope: enricher.Scope): common.typed.RecordValueNode {
	return {
		nodeType: "RecordValue",
		members: enrichMembers(node.members, scope),
		position: node.position,
		type: resolveType(node, scope),
		declaredType: node.type !== null ? resolveType(node.type, scope) : null,
	}
}

export function enrichStringValue(node: parser.StringValueNode, scope: enricher.Scope): common.typed.StringValueNode {
	return {
		nodeType: "StringValue",
		value: node.value,
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichNumberValue(node: parser.NumberValueNode, scope: enricher.Scope): common.typed.NumberValueNode {
	return {
		nodeType: "NumberValue",
		value: node.value,
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichBooleanValue(
	node: parser.BooleanValueNode,
	scope: enricher.Scope,
): common.typed.BooleanValueNode {
	return {
		nodeType: "BooleanValue",
		value: node.value,
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichFunctionValue(
	node: parser.FunctionValueNode,
	scope: enricher.Scope,
): common.typed.FunctionValueNode {
	return {
		nodeType: "FunctionValue",
		value: enrichFunctionDefinition(node.value, scope),
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichArrayValue(node: parser.ArrayValueNode, scope: enricher.Scope): common.typed.ArrayValueNode {
	return {
		nodeType: "ArrayValue",
		values: node.values.map(expr => enrichExpression(expr, scope)),
		position: node.position,
		type: resolveArrayValueType(node, scope),
	}
}

export function enrichLookup(node: parser.LookupNode, scope: enricher.Scope): common.typed.LookupNode {
	return {
		nodeType: "Lookup",
		base: enrichExpression(node.base, scope),
		member: enrichMember(node, scope),
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichIdentifier(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	type: common.Type = resolveType(node, scope),
): common.typed.IdentifierNode {
	return {
		nodeType: "Identifier",
		content: node.content,
		position: node.position,
		type,
	}
}

export function enrichSelf(
	node: parser.SelfNode,
	scope: enricher.Scope,
	type: common.Type = resolveType(node, scope),
): common.typed.SelfNode {
	return {
		nodeType: "Self",
		position: node.position,
		type,
	}
}

export function enrichMethodLookup(
	node: parser.MethodLookupNode,
	scope: enricher.Scope,
): common.typed.MethodLookupNode {
	return {
		nodeType: "MethodLookup",
		base: enrichExpression(node.base, scope),
		baseType: resolveMethodLookupBaseType(node.base, scope),
		member: methodMember(node, scope),
		position: node.position,
		type: resolveType(node, scope),
	}
}

////////////////
/* Statements */
////////////////

export function enrichStatement(node: parser.StatementNode, scope: enricher.Scope): common.typed.StatementNode {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
			return enrichConstantDeclarationStatement(node, scope)
		case "VariableDeclarationStatement":
			return enrichVariableDeclarationStatement(node, scope)
		case "VariableAssignmentStatement":
			return enrichVariableAssignmentStatement(node, scope)
		case "TypeDefinitionStatement":
			return enrichTypeDefinitionStatement(node, scope)
		case "IfElseStatement":
			return enrichIfElseStatementNode(node, scope)
		case "IfStatement":
			return enrichIfStatement(node, scope)
		case "ReturnStatement":
			return enrichReturnStatement(node, scope)
		case "FunctionStatement":
			return enrichFunctionStatement(node, scope)
	}
}

export function enrichConstantDeclarationStatement(
	node: parser.ConstantDeclarationStatementNode,
	scope: enricher.Scope,
): common.typed.ConstantDeclarationStatementNode {
	let type

	if (node.type === null) {
		type = resolveType(node.value, scope)
	} else {
		type = resolveType(node.type, scope)
	}

	let newScope = declareVariableInScope(node.name, type, scope)

	return {
		nodeType: "ConstantDeclarationStatement",
		name: enrichIdentifier(node.name, scope),
		value: enrichExpression(node.value, scope),
		position: node.position,
		type: resolveType(node.value, scope),
		declaredType: node.type !== null ? resolveType(node.type, scope) : null,
	}
}

export function enrichVariableDeclarationStatement(
	node: parser.VariableDeclarationStatementNode,
	scope: enricher.Scope,
): common.typed.VariableDeclarationStatementNode {
	let type

	if (node.type === null) {
		type = resolveType(node.value, scope)
	} else {
		type = resolveType(node.type, scope)
	}

	let newScope = declareVariableInScope(node.name, type, scope)

	return {
		nodeType: "VariableDeclarationStatement",
		name: enrichIdentifier(node.name, scope),
		value: enrichExpression(node.value, scope),
		position: node.position,
		type: resolveType(node.value, scope),
		declaredType: node.type !== null ? resolveType(node.type, scope) : null,
	}
}

export function enrichVariableAssignmentStatement(
	node: parser.VariableAssignmentStatementNode,
	scope: enricher.Scope,
): common.typed.VariableAssignmentStatementNode {
	return {
		nodeType: "VariableAssignmentStatement",
		name: enrichIdentifier(node.name, scope),
		value: enrichExpression(node.value, scope),
		position: node.position,
	}
}

export function enrichTypeDefinitionStatement(
	node: parser.TypeDefinitionStatementNode,
	scope: enricher.Scope,
): common.typed.TypeDefinitionStatementNode {
	function enrichProperties(
		properties: {
			[key: string]: parser.TypeDeclarationNode
		},
		scope: enricher.Scope,
	): {
		[key: string]: common.Type
	} {
		let result: { [key: string]: common.Type } = {}

		for (let [propertyKey, propertyValue] of Object.entries(properties)) {
			result[propertyKey] = resolveType(propertyValue, scope)
		}

		return result
	}

	let type = resolveType(node, scope)

	scope = declareVariableInScope(node.name, type, scope)

	return {
		nodeType: "TypeDefinitionStatement",
		name: enrichIdentifier(node.name, scope),
		properties: enrichProperties(node.properties, scope),
		methods: enrichMethods(node.methods, scope, type),
		position: node.position,
		type,
	}
}

export function enrichIfElseStatementNode(
	node: parser.IfElseStatementNode,
	scope: enricher.Scope,
): common.typed.IfElseStatementNode {
	let trueScope = { parent: scope, members: {} }
	let falseScope = { parent: scope, members: {} }

	return {
		nodeType: "IfElseStatement",
		condition: enrichExpression(node.condition, scope),
		trueBody: node.trueBody.map(node => enrichNode(node, trueScope)),
		falseBody: node.falseBody.map(node => enrichNode(node, falseScope)),
		position: node.position,
	}
}

export function enrichIfStatement(node: parser.IfStatementNode, scope: enricher.Scope): common.typed.IfStatementNode {
	let bodyScope = { parent: scope, members: {} }

	return {
		nodeType: "IfStatement",
		condition: enrichExpression(node.condition, scope),
		body: node.body.map(node => enrichNode(node, bodyScope)),
		position: node.position,
	}
}

export function enrichReturnStatement(
	node: parser.ReturnStatementNode,
	scope: enricher.Scope,
): common.typed.ReturnStatementNode {
	return {
		nodeType: "ReturnStatement",
		expression: enrichExpression(node.expression, scope),
		position: node.position,
	}
}

export function enrichFunctionStatement(
	node: parser.FunctionStatementNode,
	scope: enricher.Scope,
): common.typed.FunctionStatementNode {
	let type = resolveType(node.value, scope)
	let newScope = declareVariableInScope(node.name, type, scope)

	return {
		nodeType: "FunctionStatement",
		name: enrichIdentifier(node.name, scope, type),
		value: enrichFunctionDefinition(node.value, scope),
		position: node.position,
		type,
	}
}

/////////////
/* Helpers */
/////////////

function declareVariableInScope(
	identifier: parser.IdentifierNode | string,
	type: common.Type,
	scope: enricher.Scope,
): enricher.Scope {
	const variableName = typeof identifier === "string" ? identifier : identifier.content

	if (scope.members[variableName] != null) {
		throw new Error(`Variable ${variableName} is already declared.`)
	}

	scope.members[variableName] = type

	return scope
}

function enrichArgument(node: parser.ArgumentNode, scope: enricher.Scope): common.typed.ArgumentNode {
	return {
		nodeType: "Argument",
		name: node.name ? node.name.content : null,
		value: enrichExpression(node.value, scope),
		type: resolveType(node.value, scope),
	}
}

function methodMember(node: parser.MethodLookupNode, scope: enricher.Scope): common.typed.IdentifierNode {
	return {
		nodeType: "Identifier",
		content: node.member.content,
		position: node.member.position,
		type: resolveType(node, scope),
	}
}

function enrichMembers(
	members: { [key: string]: parser.ExpressionNode },
	scope: enricher.Scope,
): { [key: string]: common.typed.ExpressionNode } {
	let result: { [key: string]: common.typed.ExpressionNode } = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		result[memberKey] = enrichExpression(memberValue, scope)
	}

	return result
}

function enrichMethods(
	members: { [key: string]: { method: parser.FunctionValueNode; isStatic: boolean } },
	scope: enricher.Scope,
	selfType: common.Type,
): { [key: string]: { method: common.typed.FunctionValueNode; isStatic: boolean } } {
	let result: { [key: string]: { method: common.typed.FunctionValueNode; isStatic: boolean } } = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		result[memberKey] = {
			method: enrichMethodFunctionValue(memberValue, scope, selfType),
			isStatic: memberValue.isStatic,
		}
	}

	return result
}

function enrichParameter(node: parser.ParameterNode, scope: enricher.Scope): common.typed.ParameterNode {
	let type = resolveType(node.type, scope)

	declareVariableInScope(node.internalName, type, scope)

	return {
		nodeType: "Parameter",
		externalName: node.externalName ? enrichIdentifier(node.externalName, scope, type) : null,
		internalName: enrichIdentifier(node.internalName, scope),
		position: node.position,
	}
}

function enrichMember(node: parser.LookupNode, scope: enricher.Scope): common.typed.IdentifierNode {
	return {
		nodeType: "Identifier",
		content: node.member.content,
		position: node.member.position,
		type: resolveType(node, scope),
	}
}
