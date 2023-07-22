import { common, parser } from "../interfaces"

// #region Program & Sections

export function program(
	implementation: parser.ImplementationSectionNode,
	position: common.Position,
): parser.Program {
	return {
		nodeType: "Program",
		implementation,
		position,
	}
}

export function implementationSection(
	nodes: Array<parser.ImplementationNode>,
	position: common.Position,
): parser.ImplementationSectionNode {
	return {
		nodeType: "ImplementationSection",
		nodes,
		position,
	}
}

// #endregion

// #region Expressions

export function nativeFunctionInvocation(
	name: parser.IdentifierNode,
	args: Array<parser.ArgumentNode>,
	position: common.Position,
): parser.NativeFunctionInvocationNode {
	return {
		nodeType: "NativeFunctionInvocation",
		name: {
			nodeType: "Identifier",
			content: `__${name.content}`,
			position: {
				start: {
					line: name.position.start.line,
					column: name.position.start.column - 2,
				},
				end: name.position.end,
			},
		},
		arguments: args,
		position,
	}
}

export function methodInvocation(
	name: parser.MethodLookupNode,
	args: Array<parser.ArgumentNode>,
	position: common.Position,
): parser.MethodInvocationNode {
	return { nodeType: "MethodInvocation", name, arguments: args, position }
}

export function functionInvocation(
	name: parser.ExpressionNode,
	args: Array<parser.ArgumentNode>,
	position: common.Position,
): parser.FunctionInvocationNode {
	return { nodeType: "FunctionInvocation", name, arguments: args, position }
}

export function methodLookup(
	base: parser.ExpressionNode,
	member: parser.IdentifierNode,
	position: common.Position,
): parser.MethodLookupNode {
	return { nodeType: "MethodLookup", base, member, position }
}

export function recordValueNode(
	type: parser.TypeDeclarationNode | null,
	members: {
		[key: string]: parser.ValueNode
	},
	position: common.Position,
): parser.RecordValueNode {
	return {
		nodeType: "RecordValue",
		type,
		members,
		position,
	}
}

export function stringValueNode(
	value: string,
	position: common.Position,
): parser.StringValueNode {
	return {
		nodeType: "StringValue",
		value,
		position,
	}
}

export function integerValueNode(
	value: string,
	position: common.Position,
): parser.IntegerValueNode {
	return {
		nodeType: "IntegerValue",
		value,
		position,
	}
}

export function fractionValueNode(
	numerator: string,
	denominator: string,
	position: common.Position,
): parser.FractionValueNode {
	return {
		nodeType: "FractionValue",
		numerator,
		denominator,
		position,
	}
}

export function booleanValueNode(
	value: boolean,
	position: common.Position,
): parser.BooleanValueNode {
	return {
		nodeType: "BooleanValue",
		value,
		position,
	}
}

export function functionValueNode(
	value: parser.FunctionDefinitionNode | parser.GenericFunctionDefinitionNode,
	position: common.Position,
): parser.FunctionValueNode {
	return {
		nodeType: "FunctionValue",
		value,
		position,
	}
}

export function listValueNode(
	values: Array<parser.ExpressionNode>,
	position: common.Position,
): parser.ListValueNode {
	return {
		nodeType: "ListValue",
		values,
		position,
	}
}

export function lookup(
	base: parser.ExpressionNode,
	member: parser.IdentifierNode,
	position: common.Position,
): parser.LookupNode {
	return { nodeType: "Lookup", base, member, position }
}

export function self(position: common.Position): parser.SelfNode {
	return {
		nodeType: "Self",
		position,
	}
}

export function identifier(
	content: string,
	position: common.Position,
): parser.IdentifierNode {
	return {
		nodeType: "Identifier",
		content,
		position,
	}
}

export function combination(
	lhs: parser.ExpressionNode,
	rhs: parser.ExpressionNode,
	position: common.Position,
): parser.CombinationNode {
	return {
		nodeType: "Combination",
		lhs,
		rhs,
		position,
	}
}

export function match(
	value: parser.ExpressionNode,
	handlers: Array<{
		matcher: parser.TypeDeclarationNode
		returnType: parser.TypeDeclarationNode
		body: Array<parser.ImplementationNode>
	}>,
	position: common.Position,
): parser.MatchNode {
	return {
		nodeType: "Match",
		value,
		handlers,
		position,
	}
}

// #endregion

// #region Statements

export function constantDeclarationStatement(
	name: parser.IdentifierNode,
	type: parser.TypeDeclarationNode,
	value: parser.ExpressionNode,
	position: common.Position,
): parser.ConstantDeclarationStatementNode {
	return {
		nodeType: "ConstantDeclarationStatement",
		type,
		name,
		value,
		position,
	}
}

export function variableDeclarationStatement(
	name: parser.IdentifierNode,
	type: parser.TypeDeclarationNode,
	value: parser.ExpressionNode,
	position: common.Position,
): parser.VariableDeclarationStatementNode {
	return {
		nodeType: "VariableDeclarationStatement",
		type,
		name,
		value,
		position,
	}
}

export function variableAssignmentStatement(
	name: parser.IdentifierNode,
	value: parser.ExpressionNode,
	position: common.Position,
): parser.VariableAssignmentStatementNode {
	return { nodeType: "VariableAssignmentStatement", name, value, position }
}

export function typeDefinitionStatement(
	name: parser.IdentifierNode,
	body: Array<TypeProperty | TypeMethod>,
	position: common.Position,
): parser.TypeDefinitionStatementNode {
	const properties = body.reduce<TypeProperties>((prev, curr) => {
		if (curr.nodeType === "PropertyNode") {
			prev[curr.name.content] = curr.type
		}

		return prev
	}, {})

	const methods = body.reduce<parser.Methods>((prev, curr) => {
		if (curr.nodeType !== "PropertyNode") {
			const overloadedMethod = prev[curr.name.content]

			if (overloadedMethod) {
				if (overloadedMethod.nodeType === "OverloadedMethod") {
					prev[curr.name.content] = {
						nodeType: "OverloadedMethod",
						methods: [...overloadedMethod.methods, curr.method],
					}
				} else if (overloadedMethod.nodeType === "OverloadedStaticMethod") {
					prev[curr.name.content] = {
						nodeType: "OverloadedStaticMethod",
						methods: [...overloadedMethod.methods, curr.method],
					}
				}
			} else {
				if (curr.nodeType === "SimpleMethodNode") {
					prev[curr.name.content] = {
						nodeType: "SimpleMethod",
						method: curr.method,
					}
				} else if (curr.nodeType === "StaticMethodNode") {
					prev[curr.name.content] = {
						nodeType: "StaticMethod",
						method: curr.method,
					}
				} else if (curr.nodeType === "OverloadedMethodNode") {
					prev[curr.name.content] = {
						nodeType: "OverloadedMethod",
						methods: [curr.method],
					}
				} else if (curr.nodeType === "OverloadedStaticMethodNode") {
					prev[curr.name.content] = {
						nodeType: "OverloadedStaticMethod",
						methods: [curr.method],
					}
				}
			}
		}

		return prev
	}, {})

	return {
		nodeType: "TypeDefinitionStatement",
		name,
		position,
		properties,
		methods,
	}
}

export function ifElseStatementNode(
	ifStatement: parser.IfStatementNode,
	falseBody:
		| Array<parser.ImplementationNode>
		| parser.IfStatementNode
		| parser.IfElseStatementNode,
	position: common.Position,
): parser.IfElseStatementNode {
	if (!Array.isArray(falseBody)) {
		falseBody = [falseBody]
	}

	return {
		nodeType: "IfElseStatement",
		condition: ifStatement.condition,
		trueBody: ifStatement.body,
		falseBody,
		position,
	}
}

export function ifStatement(
	condition: parser.ExpressionNode,
	body: parser.ImplementationNode[],
	position: common.Position,
): parser.IfStatementNode {
	return { nodeType: "IfStatement", condition, body, position }
}

export function returnStatement(
	expression: parser.ExpressionNode,
	position: common.Position,
): parser.ReturnStatementNode {
	return { nodeType: "ReturnStatement", expression, position }
}

export function functionStatement(
	name: parser.IdentifierNode,
	value: parser.FunctionDefinitionNode,
	position: common.Position,
): parser.FunctionStatementNode {
	return { nodeType: "FunctionStatement", name, value, position }
}

// #endregion

// #region Helpers

export function identifierTypeDeclaration(
	type: parser.IdentifierNode,
	position: common.Position,
): parser.IdentifierTypeDeclarationNode {
	return {
		nodeType: "IdentifierTypeDeclaration",
		type,
		position,
	}
}

export function listTypeDeclaration(
	type: parser.TypeDeclarationNode,
	position: common.Position,
): parser.ListTypeDeclarationNode {
	return {
		nodeType: "ListTypeDeclaration",
		type,
		position,
	}
}

export function unionTypeDeclaration(
	types: Array<parser.TypeDeclarationNode>,
	position: common.Position,
): parser.UnionTypeDeclarationNode {
	return {
		nodeType: "UnionTypeDeclaration",
		types,
		position,
	}
}

export function genericDeclarationNode(
	name: parser.IdentifierNode,
	defaultType: parser.TypeDeclarationNode | null,
	position: common.Position,
): parser.GenericDeclarationNode {
	return {
		nodeType: "GenericDeclarationNode",
		name,
		defaultType,
		position,
	}
}

export function genericFunctionDefinition(
	generics: Array<parser.GenericDeclarationNode>,
	parameters: Array<parser.ParameterNode>,
	returnType: parser.TypeDeclarationNode,
	body: Array<parser.ImplementationNode>,
): parser.GenericFunctionDefinitionNode {
	return {
		nodeType: "GenericFunctionDefinition",
		generics,
		parameters,
		returnType,
		body,
	}
}

export function functionDefinition(
	parameters: Array<parser.ParameterNode>,
	returnType: parser.TypeDeclarationNode,
	body: Array<parser.ImplementationNode>,
): parser.FunctionDefinitionNode {
	return {
		nodeType: "FunctionDefinition",
		parameters,
		returnType,
		body,
	}
}

export function parameter(
	externalName: parser.IdentifierNode | null,
	internalName: parser.IdentifierNode,
	type: parser.TypeDeclarationNode,
	position: common.Position,
): parser.ParameterNode {
	return {
		nodeType: "Parameter",
		externalName,
		internalName,
		type,
		position,
	}
}

type KeyValuePair = { key: string; value: parser.ExpressionNode }
type KeyValuePairObject = { [key: string]: parser.ExpressionNode }

export function keyValuePair(
	key: string,
	value: parser.ExpressionNode,
): KeyValuePair {
	return { key, value }
}

export function buildKeyValuePairList(
	kvpList: KeyValuePair[],
	kvp: KeyValuePair,
): KeyValuePairObject {
	const keyValuePairList = [...kvpList, kvp]
	return keyValuePairList.reduce<KeyValuePairObject>((prev, curr) => {
		prev[curr.key] = curr.value
		return prev
	}, {})
}

export function argument(
	name: parser.IdentifierNode | null,
	value: parser.ExpressionNode,
): parser.ArgumentNode {
	return {
		nodeType: "Argument",
		name,
		value,
	}
}

type SimpleMethodNode = {
	nodeType: "SimpleMethodNode"
	name: parser.IdentifierNode
	method: parser.FunctionValueNode
}

type StaticMethodNode = {
	nodeType: "StaticMethodNode"
	name: parser.IdentifierNode
	method: parser.FunctionValueNode
}

type OverloadedMethodNode = {
	nodeType: "OverloadedMethodNode"
	name: parser.IdentifierNode
	method: parser.FunctionValueNode
}

type OverloadedStaticMethodNode = {
	nodeType: "OverloadedStaticMethodNode"
	name: parser.IdentifierNode
	method: parser.FunctionValueNode
}

type TypeProperty = {
	nodeType: "PropertyNode"
	name: parser.IdentifierNode
	type: parser.TypeDeclarationNode
}
type TypeMethod =
	| SimpleMethodNode
	| StaticMethodNode
	| OverloadedMethodNode
	| OverloadedStaticMethodNode

type TypeProperties = { [key: string]: parser.TypeDeclarationNode }
// #endregion
