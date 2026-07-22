import type { common, parser } from "../interfaces/index"

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
	nodes: Array<parser.ImplementationNode> | null,
	position: common.Position,
): parser.ImplementationSectionNode {
	return {
		nodeType: "ImplementationSection",
		nodes: nodes ?? [],
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
	base: parser.ExpressionNode,
	member: parser.IdentifierNode,
	namespaceSpecifier: parser.IdentifierNode | null,
	args: Array<parser.ArgumentNode>,
	position: common.Position,
): parser.MethodInvocationNode {
	return {
		nodeType: "MethodInvocation",
		base,
		member,
		namespaceSpecifier,
		arguments: args,
		position,
	}
}

export function functionInvocation(
	name: parser.ExpressionNode,
	args: Array<parser.ArgumentNode>,
	position: common.Position,
): parser.FunctionInvocationNode {
	return { nodeType: "FunctionInvocation", name, arguments: args, position }
}

export function recordValueNode(
	type: parser.TypeDeclarationNode | null,
	members: Record<string, parser.RecordValueMemberNode>,
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

export function rationalValueNode(
	numerator: string,
	denominator: string,
	position: common.Position,
): parser.RationalValueNode {
	return {
		nodeType: "RationalValue",
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

export function nothingValueNode(
	position: common.Position,
): parser.NothingValueNode {
	return {
		nodeType: "NothingValue",
		position,
	}
}

export function functionValueNode(
	value: parser.FunctionDefinitionNode,
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

export function caseValueNode(
	choice: parser.IdentifierNode | null,
	caseName: parser.IdentifierNode,
	value: parser.ExpressionNode | null,
	position: common.Position,
): parser.CaseValueNode {
	return {
		nodeType: "CaseValue",
		choice,
		caseName,
		value,
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
	returnType: parser.TypeDeclarationNode,
	handlers: Array<{
		matcher: parser.MatcherNode
		guard: parser.ExpressionNode | null
		body: Array<parser.ImplementationNode>
	}>,
	position: common.Position,
): parser.MatchNode {
	return {
		nodeType: "Match",
		value,
		returnType,
		handlers,
		position,
	}
}

export function wildcardMatcher(
	position: common.Position,
): parser.WildcardMatcherNode {
	return {
		nodeType: "WildcardMatcher",
		position,
	}
}

export function literalMatcher(
	value: parser.LiteralMatcherValueNode,
	position: common.Position,
): parser.LiteralMatcherNode {
	return {
		nodeType: "LiteralMatcher",
		value,
		position,
	}
}

export function caseMatcher(
	choice: parser.IdentifierNode | null,
	caseName: parser.IdentifierNode,
	position: common.Position,
): parser.CaseMatcherNode {
	return {
		nodeType: "CaseMatcher",
		choice,
		caseName,
		position,
	}
}

export function recordMatcher(
	members: Record<string, parser.RecordMatcherMemberNode>,
	position: common.Position,
): parser.RecordMatcherNode {
	return {
		nodeType: "RecordMatcher",
		members,
		position,
	}
}

// #endregion

// #region Statements

export function constantDeclarationStatement(
	name: parser.IdentifierNode,
	type: parser.TypeDeclarationNode | null,
	value: parser.ExpressionNode,
	position: common.Position,
	documentation: common.Documentation | null = null,
): parser.ConstantDeclarationStatementNode {
	return {
		nodeType: "ConstantDeclarationStatement",
		type,
		name,
		value,
		position,
		documentation,
	}
}

export function variableDeclarationStatement(
	name: parser.IdentifierNode,
	type: parser.TypeDeclarationNode | null,
	value: parser.ExpressionNode,
	position: common.Position,
	documentation: common.Documentation | null = null,
): parser.VariableDeclarationStatementNode {
	return {
		nodeType: "VariableDeclarationStatement",
		type,
		name,
		value,
		position,
		documentation,
	}
}

export function variableAssignmentStatement(
	name: parser.IdentifierNode,
	value: parser.ExpressionNode,
	position: common.Position,
): parser.VariableAssignmentStatementNode {
	return { nodeType: "VariableAssignmentStatement", name, value, position }
}

export function namespaceDefinitionStatement(
	name: parser.IdentifierNode,
	generics: Array<parser.GenericDeclarationNode>,
	targetType: parser.TypeDeclarationNode | null,
	conformsTo: Array<parser.IdentifierNode>,
	body: Array<NamespaceProperty | NamespaceMethod>,
	position: common.Position,
	documentation: common.Documentation | null = null,
): parser.NamespaceDefinitionStatementNode {
	const properties = body.reduce<NamespaceProperties>((prev, curr) => {
		if (curr.nodeType === "NamespacePropertyNode") {
			prev[curr.name.content] = {
				name: curr.name,
				documentation: curr.documentation,
				type: curr.type,
				value: curr.value,
			}
		}

		return prev
	}, {})

	const methods = body.reduce<parser.NamespaceMethods>((prev, curr) => {
		if (curr.nodeType !== "NamespacePropertyNode") {
			if (curr.nodeType === "SimpleMethodNode") {
				prev[curr.name.content] = {
					nodeType: "SimpleMethod",
					name: curr.name,
					method: curr.method,
				}
			} else if (curr.nodeType === "StaticMethodNode") {
				prev[curr.name.content] = {
					nodeType: "StaticMethod",
					name: curr.name,
					method: curr.method,
				}
			} else if (curr.nodeType === "OverloadedMethodNode") {
				prev[curr.name.content] = {
					nodeType: "OverloadedMethod",
					name: curr.name,
					methods: curr.methods,
					documentation: curr.documentation,
				}
			} else if (curr.nodeType === "OverloadedStaticMethodNode") {
				prev[curr.name.content] = {
					nodeType: "OverloadedStaticMethod",
					name: curr.name,
					methods: curr.methods,
					documentation: curr.documentation,
				}
			}
		}

		return prev
	}, {})

	return {
		nodeType: "NamespaceDefinitionStatement",
		targetType,
		conformsTo,
		name,
		generics,
		position,
		documentation,
		properties,
		methods,
	}
}

export function protocolDeclarationStatement(
	name: parser.IdentifierNode,
	body: Array<parser.ProtocolMethods[string]>,
	position: common.Position,
	documentation: common.Documentation | null = null,
): parser.ProtocolDeclarationStatementNode {
	const methods = body.reduce<parser.ProtocolMethods>((prev, curr) => {
		prev[curr.name.content] = curr

		return prev
	}, {})

	return {
		nodeType: "ProtocolDeclarationStatement",
		name,
		methods,
		position,
		documentation,
	}
}

export function protocolMethodSignature(
	parameters: Array<parser.ParameterNode>,
	returnType: parser.TypeDeclarationNode,
	position: common.Position,
	documentation: common.Documentation | null = null,
): parser.ProtocolMethodSignatureNode {
	return {
		nodeType: "ProtocolMethodSignature",
		parameters,
		returnType,
		position,
		documentation,
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
	body: Array<parser.ImplementationNode>,
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

export function choiceDeclarationStatement(
	name: parser.IdentifierNode,
	cases: Array<parser.ChoiceCaseNode>,
	position: common.Position,
	documentation: common.Documentation | null = null,
): parser.ChoiceDeclarationStatementNode {
	return {
		nodeType: "ChoiceDeclarationStatement",
		name,
		cases,
		position,
		documentation,
	}
}

export function typeAliasStatement(
	name: parser.IdentifierNode,
	generics: Array<parser.GenericDeclarationNode>,
	type: parser.TypeDeclarationNode,
	position: common.Position,
	documentation: common.Documentation | null = null,
): parser.TypeAliasStatementNode {
	return {
		nodeType: "TypeAliasStatement",
		name,
		generics,
		type,
		position,
		documentation,
	}
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

type KeyTypePair = {
	name: parser.IdentifierNode
	type: parser.TypeDeclarationNode
	position: common.Position
}

type KeyTypePairObject = {
	data: Record<string, parser.RecordTypeMemberNode>
	position: common.Position
}

export function keyTypePair(
	name: parser.IdentifierNode,
	type: parser.TypeDeclarationNode,
	position: common.Position,
): KeyTypePair {
	return { name, type, position }
}

export function buildKeyTypePairList(
	ktpList: Array<KeyTypePair>,
	ktp: KeyTypePair,
): KeyTypePairObject {
	const keyTypePairList = [...ktpList, ktp]

	return {
		data: keyTypePairList.reduce<KeyTypePairObject["data"]>(
			(prev, curr) => {
				prev[curr.name.content] = { name: curr.name, type: curr.type }
				return prev
			},
			{},
		),
		position: {
			start: keyTypePairList[0].position.start,
			end: keyTypePairList[keyTypePairList.length - 1].position.end,
		},
	}
}

export function recordTypeDeclaration(
	members: Record<string, parser.RecordTypeMemberNode>,
	position: common.Position,
): parser.RecordTypeDeclarationNode {
	return {
		nodeType: "RecordTypeDeclaration",
		members,
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

export function functionTypeParameter(
	externalName: parser.IdentifierNode | null,
	type: parser.TypeDeclarationNode,
	position: common.Position,
): parser.FunctionTypeParameterNode {
	return {
		nodeType: "FunctionTypeParameter",
		externalName,
		type,
		position,
	}
}

export function functionTypeDeclaration(
	parameterTypes: Array<parser.FunctionTypeParameterNode>,
	returnType: parser.TypeDeclarationNode,
	position: common.Position,
): parser.FunctionTypeDeclarationNode {
	return {
		nodeType: "FunctionTypeDeclaration",
		parameterTypes,
		returnType,
		position,
	}
}

export function genericTypeDeclaration(
	baseType: parser.UngenericTypeDeclarationNode,
	generics: Array<parser.TypeDeclarationNode>,
	position: common.Position,
): parser.GenericTypeDeclarationNode {
	return {
		nodeType: "GenericTypeDeclaration",
		baseType,
		generics,
		position,
	}
}

export function genericDeclarationNode(
	name: parser.IdentifierNode,
	defaultType: parser.TypeDeclarationNode | null,
	inferred: boolean,
	constraint: parser.IdentifierNode | null,
	position: common.Position,
): parser.GenericDeclarationNode {
	return {
		nodeType: "GenericDeclarationNode",
		name,
		defaultType,
		inferred,
		constraint,
		position,
	}
}

export function genericFunctionDefinition(
	generics: Array<parser.GenericDeclarationNode>,
	parameters: Array<parser.ParameterNode>,
	returnType: parser.TypeDeclarationNode,
	body: Array<parser.ImplementationNode>,
	parameterListPosition: common.Position,
	documentation: common.Documentation | null = null,
): parser.FunctionDefinitionNode {
	return {
		nodeType: "FunctionDefinition",
		generics,
		parameters,
		returnType,
		body,
		documentation,
		parameterListPosition,
	}
}

export function functionDefinition(
	parameters: Array<parser.ParameterNode>,
	returnType: parser.TypeDeclarationNode | null,
	body: Array<parser.ImplementationNode>,
	parameterListPosition: common.Position,
	documentation: common.Documentation | null = null,
): parser.FunctionDefinitionNode {
	return {
		nodeType: "FunctionDefinition",
		generics: [],
		parameters,
		returnType,
		body,
		documentation,
		parameterListPosition,
	}
}

export function parameter(
	externalName: parser.IdentifierNode | null,
	internalName: parser.IdentifierNode | null,
	type: parser.TypeDeclarationNode | null,
	position: common.Position,
	documentation: common.Documentation | null = null,
): parser.ParameterNode {
	return {
		nodeType: "Parameter",
		externalName,
		internalName,
		type,
		position,
		documentation,
	}
}

type KeyValuePair = {
	name: parser.IdentifierNode
	value: parser.ExpressionNode
	position: common.Position
}

type KeyValuePairObject = {
	data: Record<string, parser.RecordValueMemberNode>
	position: common.Position
}

export function keyValuePair(
	name: parser.IdentifierNode,
	value: parser.ExpressionNode,
	position: common.Position,
): KeyValuePair {
	return { name, value, position }
}

export function buildKeyValuePairList(
	kvpList: Array<KeyValuePair>,
	kvp: KeyValuePair,
): KeyValuePairObject {
	const keyValuePairList = [...kvpList, kvp]

	return {
		data: keyValuePairList.reduce<KeyValuePairObject["data"]>(
			(prev, curr) => {
				prev[curr.name.content] = { name: curr.name, value: curr.value }
				return prev
			},
			{},
		),
		position: {
			start: keyValuePairList[0].position.start,
			end: keyValuePairList[keyValuePairList.length - 1].position.end,
		},
	}
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
	methods: Array<parser.FunctionValueNode>
	documentation: common.Documentation | null
}

type OverloadedStaticMethodNode = {
	nodeType: "OverloadedStaticMethodNode"
	name: parser.IdentifierNode
	methods: Array<parser.FunctionValueNode>
	documentation: common.Documentation | null
}

type NamespaceProperty = {
	nodeType: "NamespacePropertyNode"
	name: parser.IdentifierNode
	documentation: common.Documentation | null
	type: parser.TypeDeclarationNode | null
	value: parser.ExpressionNode
}

type NamespaceProperties = Record<string, parser.NamespacePropertyNode>

type NamespaceMethod =
	| SimpleMethodNode
	| StaticMethodNode
	| OverloadedMethodNode
	| OverloadedStaticMethodNode

// #endregion
