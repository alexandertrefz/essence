import type { common, enricher, parser } from "../interfaces"

import {
	resolveFunctionValueType,
	resolveListValueType,
	resolveMatchType,
	resolveMethodInvocation,
	resolveNamespaceDefinitionStatementType,
	resolveType,
} from "./resolvers"

export function enrichNode(
	node: parser.ImplementationNode,
	scope: enricher.Scope,
): common.typed.ImplementationNode {
	switch (node.nodeType) {
		case "NativeFunctionInvocation":
		case "MethodInvocation":
		case "FunctionInvocation":
		case "Combination":
		case "RecordValue":
		case "StringValue":
		case "IntegerValue":
		case "FractionValue":
		case "BooleanValue":
		case "NothingValue":
		case "FunctionValue":
		case "ListValue":
		case "Lookup":
		case "Identifier":
		case "Self":
		case "Match":
			return enrichExpression(node, scope)
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "NamespaceDefinitionStatement":
		case "TypeAliasStatement":
		case "IfElseStatement":
		case "IfStatement":
		case "ReturnStatement":
		case "FunctionStatement":
			return enrichStatement(node, scope)
	}
}

// #region Expressions

export function enrichExpression(
	node: parser.ExpressionNode,
	scope: enricher.Scope,
): common.typed.ExpressionNode {
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
		case "IntegerValue":
			return enrichIntegerValue(node, scope)
		case "FractionValue":
			return enrichFractionValue(node, scope)
		case "BooleanValue":
			return enrichBooleanValue(node, scope)
		case "NothingValue":
			return enrichNothingValue(node, scope)
		case "FunctionValue":
			return enrichFunctionValue(node, scope)
		case "ListValue":
			return enrichListValue(node, scope)
		case "Lookup":
			return enrichLookup(node, scope)
		case "Identifier":
			return enrichIdentifier(node, scope)
		case "Self":
			return enrichSelf(node, scope)
		case "Match":
			return enrichMatch(node, scope)
	}
}

export function enrichNativeFunctionInvocation(
	node: parser.NativeFunctionInvocationNode,
	scope: enricher.Scope,
): common.typed.NativeFunctionInvocationNode {
	return {
		nodeType: "NativeFunctionInvocation",
		name: enrichIdentifier(node.name, scope),
		arguments: node.arguments.map((argument) =>
			enrichArgument(argument, scope),
		),
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichMethodInvocation(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): common.typed.MethodInvocationNode {
	let { namespace, type, overloadedMethodIndex } = resolveMethodInvocation(
		node,
		scope,
	)

	return {
		nodeType: "MethodInvocation",
		base: enrichExpression(node.base, scope),
		member: {
			name: node.member.content,
			position: node.member.position,
		},
		arguments: node.arguments.map((argument) =>
			enrichArgument(argument, scope),
		),
		position: node.position,
		namespace,
		type,
		overloadedMethodIndex,
	}
}

export function enrichFunctionInvocation(
	node: parser.FunctionInvocationNode,
	scope: enricher.Scope,
): common.typed.FunctionInvocationNode {
	return {
		nodeType: "FunctionInvocation",
		name: enrichExpression(node.name, scope),
		arguments: node.arguments.map((argument) =>
			enrichArgument(argument, scope),
		),
		position: node.position,
		type: resolveType(node, scope),
		overloadedMethodIndex: null,
	}
}

export function enrichCombination(
	node: parser.CombinationNode,
	scope: enricher.Scope,
): common.typed.CombinationNode {
	return {
		nodeType: "Combination",
		lhs: enrichExpression(node.lhs, scope),
		rhs: enrichExpression(node.rhs, scope),
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichMethodFunctionDefinition(
	method: parser.FunctionValueNode,
	scope: enricher.Scope,
	selfType: common.Type | null,
): common.typed.FunctionDefinitionNode {
	let newScope = {
		parent: scope,
		members: {},
		types: {},
	} satisfies enricher.Scope

	if (selfType !== null) {
		declareVariableInScope("@", selfType, newScope)
	}

	return {
		nodeType: "FunctionDefinition",
		parameters: method.value.parameters.map((parameter) =>
			enrichParameter(parameter, newScope),
		),
		body: method.value.body.map((node) => enrichNode(node, newScope)),
		returnType: resolveType(method.value.returnType, scope),
	}
}

export function enrichGenericFunctionDefinition(
	node: parser.GenericFunctionDefinitionNode,
	scope: enricher.Scope,
): common.typed.GenericFunctionDefinitionNode {
	let newScope = {
		parent: scope,
		members: {},
		types: {},
	} satisfies enricher.Scope

	return {
		nodeType: "GenericFunctionDefinition",
		parameters: node.parameters.map((parameter) =>
			enrichParameter(parameter, newScope),
		),
		generics: node.generics.map((generic) =>
			enrichGenericDeclarationNode(generic, scope),
		),
		body: node.body.map((node) => enrichNode(node, newScope)),
		returnType: resolveType(node.returnType, scope),
	}
}

export function enrichGenericDeclarationNode(
	node: parser.GenericDeclarationNode,
	scope: enricher.Scope,
): common.typed.GenericDeclarationNode {
	return {
		nodeType: "GenericDeclaration",
		defaultType: node.defaultType
			? resolveType(node.defaultType, scope)
			: null,
		name: node.name.content,
		position: node.position,
	}
}

export function enrichFunctionDefinition(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.typed.FunctionDefinitionNode {
	let newScope = {
		parent: scope,
		members: {},
		types: {},
	} satisfies enricher.Scope

	return {
		nodeType: "FunctionDefinition",
		parameters: node.parameters.map((parameter) =>
			enrichParameter(parameter, newScope),
		),
		body: node.body.map((node) => enrichNode(node, newScope)),
		returnType: resolveType(node.returnType, scope),
	}
}

export function enrichMethodFunctionValue(
	node: parser.SimpleMethod | parser.StaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
): common.typed.FunctionValueNode {
	return {
		nodeType: "FunctionValue",
		value: enrichMethodFunctionDefinition(node.method, scope, selfType),
		position: node.method.position,
		type: resolveFunctionValueType(node.method, scope),
	}
}

export function enrichMethodsFunctionValue(
	node: parser.OverloadedMethod | parser.OverloadedStaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
): Array<common.typed.FunctionValueNode> {
	let results: Array<common.typed.FunctionValueNode> = []

	for (let method of Object.values(node.methods)) {
		results.push({
			nodeType: "FunctionValue",
			value: enrichMethodFunctionDefinition(method, scope, selfType),
			position: method.position,
			type: resolveFunctionValueType(method, scope),
		})
	}

	return results
}

export function enrichRecordValue(
	node: parser.RecordValueNode,
	scope: enricher.Scope,
): common.typed.RecordValueNode {
	return {
		nodeType: "RecordValue",
		members: enrichMembers(node.members, scope),
		position: node.position,
		type: resolveType(node, scope),
		declaredType: node.type !== null ? resolveType(node.type, scope) : null,
	}
}

export function enrichStringValue(
	node: parser.StringValueNode,
	_scope: enricher.Scope,
): common.typed.StringValueNode {
	return {
		nodeType: "StringValue",
		value: node.value,
		position: node.position,
		type: { type: "String" },
	}
}

export function enrichIntegerValue(
	node: parser.IntegerValueNode,
	_scope: enricher.Scope,
): common.typed.IntegerValueNode {
	return {
		nodeType: "IntegerValue",
		value: node.value,
		position: node.position,
		type: { type: "Integer" },
	}
}

export function enrichFractionValue(
	node: parser.FractionValueNode,
	_scope: enricher.Scope,
): common.typed.FractionValueNode {
	return {
		nodeType: "FractionValue",
		numerator: node.numerator,
		denominator: node.denominator,
		position: node.position,
		type: { type: "Fraction" },
	}
}

export function enrichBooleanValue(
	node: parser.BooleanValueNode,
	_scope: enricher.Scope,
): common.typed.BooleanValueNode {
	return {
		nodeType: "BooleanValue",
		value: node.value,
		position: node.position,
		type: { type: "Boolean" },
	}
}

export function enrichNothingValue(
	node: parser.NothingValueNode,
	_scope: enricher.Scope,
): common.typed.NothingValueNode {
	return {
		nodeType: "NothingValue",
		position: node.position,
		type: { type: "Nothing" },
	}
}

export function enrichFunctionValue(
	node: parser.FunctionValueNode,
	scope: enricher.Scope,
): common.typed.FunctionValueNode {
	let value:
		| common.typed.FunctionDefinitionNode
		| common.typed.GenericFunctionDefinitionNode

	if (node.value.nodeType === "FunctionDefinition") {
		value = enrichFunctionDefinition(node.value, scope)
	} else {
		value = enrichGenericFunctionDefinition(node.value, scope)
	}

	return {
		nodeType: "FunctionValue",
		value,
		position: node.position,
		type: resolveFunctionValueType(node, scope),
	}
}

export function enrichListValue(
	node: parser.ListValueNode,
	scope: enricher.Scope,
): common.typed.ListValueNode {
	return {
		nodeType: "ListValue",
		values: node.values.map((expr) => enrichExpression(expr, scope)),
		position: node.position,
		type: resolveListValueType(node, scope),
	}
}

export function enrichLookup(
	node: parser.LookupNode,
	scope: enricher.Scope,
): common.typed.LookupNode {
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
	// TODO: Can a namespace ever be a valid Type for Self?
	if (type.type === "Namespace") {
		if (type.targetType) {
			type = type.targetType
		}
	}

	return {
		nodeType: "Self",
		position: node.position,
		type,
	}
}

export function enrichMatch(
	node: parser.MatchNode,
	scope: enricher.Scope,
): common.typed.MatchNode {
	return {
		nodeType: "Match",
		value: enrichExpression(node.value, scope),
		handlers: node.handlers.map((handler) => {
			let bodyScope = {
				parent: scope,
				members: {},
				types: {},
			} satisfies enricher.Scope
			let matcher = resolveType(handler.matcher, scope)

			declareVariableInScope("@", matcher, bodyScope)

			return {
				body: handler.body.map((node) => enrichNode(node, bodyScope)),
				matcher,
			}
		}),
		position: node.position,
		type: resolveType(node.returnType, scope),
	}
}

// #endregion

// #region Statements

export function enrichStatement(
	node: parser.StatementNode,
	scope: enricher.Scope,
): common.typed.StatementNode {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
			return enrichConstantDeclarationStatement(node, scope)
		case "VariableDeclarationStatement":
			return enrichVariableDeclarationStatement(node, scope)
		case "VariableAssignmentStatement":
			return enrichVariableAssignmentStatement(node, scope)
		case "NamespaceDefinitionStatement":
			return enrichNamespaceDefinitionStatement(node, scope)
		case "TypeAliasStatement":
			return enrichTypeAliasStatement(node, scope)
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
	let type: common.Type

	if (node.type === null) {
		type = resolveType(node.value, scope)
	} else {
		type = resolveType(node.type, scope)
	}

	declareVariableInScope(node.name, type, scope)

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
	let type: common.Type

	if (node.type === null) {
		type = resolveType(node.value, scope)
	} else {
		type = resolveType(node.type, scope)
	}

	declareVariableInScope(node.name, type, scope)

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

export function enrichNamespaceDefinitionStatement(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
): common.typed.NamespaceDefinitionStatementNode {
	function enrichProperties(
		properties: Record<
			string,
			{
				type: parser.TypeDeclarationNode | null
				value: parser.ExpressionNode
			}
		>,
		scope: enricher.Scope,
	): Record<
		string,
		{ type: common.Type; value: common.typed.ExpressionNode }
	> {
		let result: Record<
			string,
			{ type: common.Type; value: common.typed.ExpressionNode }
		> = {}

		for (let [propertyKey, propertyValue] of Object.entries(properties)) {
			let type: common.Type
			let value: common.typed.ExpressionNode = enrichExpression(
				propertyValue.value,
				scope,
			)

			if (propertyValue.type === null) {
				type = value.type
			} else {
				type = resolveType(propertyValue.type, scope)
			}

			result[propertyKey] = { type, value }
		}

		return result
	}

	let type = resolveNamespaceDefinitionStatementType(node, scope)

	declareVariableInScope(node.name, type, scope)

	return {
		nodeType: "NamespaceDefinitionStatement",
		targetType: type.targetType,
		name: enrichIdentifier(node.name, scope),
		properties: enrichProperties(node.properties, scope),
		methods: enrichMethods(node.methods, scope, type.targetType),
		position: node.position,
		type,
	}
}

export function enrichTypeAliasStatement(
	node: parser.TypeAliasStatementNode,
	scope: enricher.Scope,
): common.typed.TypeAliasStatementNode {
	const type = resolveType(node.type, scope)

	declareTypeInScope(node.name.content, type, scope)

	return {
		nodeType: "TypeAliasStatement",
		name: enrichIdentifier(node.name, scope, type),
		type,
		position: node.position,
	}
}

export function enrichIfElseStatementNode(
	node: parser.IfElseStatementNode,
	scope: enricher.Scope,
): common.typed.IfElseStatementNode {
	let trueScope = {
		parent: scope,
		members: {},
		types: {},
	} satisfies enricher.Scope
	let falseScope = {
		parent: scope,
		members: {},
		types: {},
	} satisfies enricher.Scope

	return {
		nodeType: "IfElseStatement",
		condition: enrichExpression(node.condition, scope),
		trueBody: node.trueBody.map((node) => enrichNode(node, trueScope)),
		falseBody: node.falseBody.map((node) => enrichNode(node, falseScope)),
		position: node.position,
	}
}

export function enrichIfStatement(
	node: parser.IfStatementNode,
	scope: enricher.Scope,
): common.typed.IfStatementNode {
	let bodyScope = {
		parent: scope,
		members: {},
		types: {},
	} satisfies enricher.Scope

	return {
		nodeType: "IfStatement",
		condition: enrichExpression(node.condition, scope),
		body: node.body.map((node) => enrichNode(node, bodyScope)),
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
	declareVariableInScope(node.name, type, scope)

	return {
		nodeType: "FunctionStatement",
		name: enrichIdentifier(node.name, scope, type),
		value: enrichFunctionDefinition(node.value, scope),
		position: node.position,
		type,
	}
}

// #endregion

// #region Helpers

function declareVariableInScope(
	identifier: parser.IdentifierNode | string,
	type: common.Type,
	scope: enricher.Scope,
): enricher.Scope {
	const variableName =
		typeof identifier === "string" ? identifier : identifier.content

	if (scope.members[variableName] != null) {
		throw new Error(`Variable ${variableName} is already declared.`)
	}

	scope.members[variableName] = type

	return scope
}

function declareTypeInScope(
	identifier: parser.IdentifierNode | string,
	type: common.Type,
	scope: enricher.Scope,
): enricher.Scope {
	const variableName =
		typeof identifier === "string" ? identifier : identifier.content

	if (scope.types[variableName] != null) {
		throw new Error(`Type ${variableName} is already declared.`)
	}

	scope.types[variableName] = type

	return scope
}

function enrichArgument(
	node: parser.ArgumentNode,
	scope: enricher.Scope,
): common.typed.ArgumentNode {
	return {
		nodeType: "Argument",
		name: node.name ? node.name.content : null,
		value: enrichExpression(node.value, scope),
		type: resolveType(node.value, scope),
	}
}

function enrichMembers(
	members: Record<string, parser.ExpressionNode>,
	scope: enricher.Scope,
): Record<string, common.typed.ExpressionNode> {
	let result: Record<string, common.typed.ExpressionNode> = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		result[memberKey] = enrichExpression(memberValue, scope)
	}

	return result
}

function enrichMethods(
	members: parser.NamespaceMethods,
	scope: enricher.Scope,
	selfType: common.Type | null,
): common.typed.Methods {
	let result: common.typed.Methods = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		if (memberValue.nodeType === "SimpleMethod") {
			result[memberKey] = {
				nodeType: "SimpleMethod",
				method: enrichMethodFunctionValue(memberValue, scope, selfType),
			}
		} else if (memberValue.nodeType === "StaticMethod") {
			result[memberKey] = {
				nodeType: "StaticMethod",
				method: enrichMethodFunctionValue(memberValue, scope, selfType),
			}
		} else if (memberValue.nodeType === "OverloadedMethod") {
			result[memberKey] = {
				nodeType: "OverloadedMethod",
				methods: enrichMethodsFunctionValue(
					memberValue,
					scope,
					selfType,
				),
			}
		} else {
			result[memberKey] = {
				nodeType: "OverloadedStaticMethod",
				methods: enrichMethodsFunctionValue(
					memberValue,
					scope,
					selfType,
				),
			}
		}
	}

	return result
}

function enrichParameter(
	node: parser.ParameterNode,
	scope: enricher.Scope,
): common.typed.ParameterNode {
	let type = resolveType(node.type, scope)

	declareVariableInScope(node.internalName, type, scope)

	return {
		nodeType: "Parameter",
		externalName: node.externalName
			? enrichIdentifier(node.externalName, scope, type)
			: null,
		internalName: enrichIdentifier(node.internalName, scope),
		position: node.position,
	}
}

function enrichMember(
	node: parser.LookupNode,
	scope: enricher.Scope,
): common.typed.IdentifierNode {
	return {
		nodeType: "Identifier",
		content: node.member.content,
		position: node.member.position,
		type: resolveType(node, scope),
	}
}
// #endregion
