import deepEqual from "deep-equal"

import { matchesType } from "../helpers"
import type { common, enricher, parser } from "../interfaces"

export function resolveType(
	node:
		| parser.ExpressionNode
		| parser.FunctionDefinitionNode
		| parser.TypeDeclarationNode
		| parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
): common.Type {
	switch (node.nodeType) {
		case "NativeFunctionInvocation":
			return resolveNativeFunctionInvocationType(node, scope)
		case "MethodInvocation":
			return resolveMethodInvocationType(node, scope)
		case "FunctionInvocation":
			return resolveFunctionInvocationType(node, scope)
		case "Combination":
			return resolveCombinationType(node, scope)
		case "RecordValue":
			return resolveRecordValueType(node, scope)
		case "ListValue":
			return resolveListValueType(node, scope)
		case "StringValue":
			return { type: "String" }
		case "IntegerValue":
			return { type: "Integer" }
		case "FractionValue":
			return { type: "Fraction" }
		case "BooleanValue":
			return { type: "Boolean" }
		case "NothingValue":
			return { type: "Nothing" }
		case "FunctionValue":
			return resolveFunctionValueType(node, scope)
		case "Lookup":
			return resolveLookupType(node, scope)
		case "Identifier":
			return resolveIdentifierType(node, scope)
		case "Self":
			return resolveSelfType(node, scope)
		case "FunctionDefinition":
			return resolveFunctionDefinitionType(node, scope)
		case "NamespaceDefinitionStatement":
			return resolveNamespaceDefinitionStatementType(node, scope)
		case "IdentifierTypeDeclaration":
			return resolveIdentifierTypeDeclarationType(node, scope)
		case "UnionTypeDeclaration":
			return resolveUnionTypeDeclarationType(node, scope)
		case "RecordTypeDeclaration":
			return resolveRecordTypeDeclarationType(node, scope)
		case "GenericTypeDeclaration":
			return resolveGenericTypeDeclarationType(node, scope)
		case "Match":
			return resolveMatchType(node, scope)
	}
}

export function resolveNativeFunctionInvocationType(
	node: parser.NativeFunctionInvocationNode,
	scope: enricher.Scope,
): common.Type {
	let type = resolveType(node.name, scope)

	if (type.type === "Function") {
		return type.returnType
	} else {
		throw new Error(`${node.name.content} is not a native function.`)
	}
}

export function resolveInvokedMethodInNamespace(
	node: parser.MethodInvocationNode,
	resolvedNamespace: common.NamespaceType,
	scope: enricher.Scope,
):
	| { returnType: common.Type; overloadedMethodIndex: number | null }
	| undefined {
	let methodType = resolvedNamespace.methods[node.member.content]

	let methodArguments: Array<parser.ArgumentNode> = [...node.arguments]

	if (
		methodType.type === "SimpleMethod" ||
		methodType.type === "OverloadedMethod"
	) {
		methodArguments = [
			{ nodeType: "Argument", name: null, value: node.base },
			...node.arguments,
		]
	}

	if (
		methodType.type === "SimpleMethod" ||
		methodType.type === "StaticMethod"
	) {
		if (methodType.parameterTypes.length !== methodArguments.length) {
			return
		}

		for (
			let parameterIndex = 0;
			parameterIndex < methodType.parameterTypes.length;
			parameterIndex++
		) {
			const parameter = methodType.parameterTypes[parameterIndex]
			const argument = methodArguments[parameterIndex]

			const parameterNameIsMatched =
				(parameter.name === null && argument.name === null) ||
				(parameter.name && argument.name?.content)

			if (
				!(
					parameterNameIsMatched &&
					matchesType(
						parameter.type,
						resolveType(argument.value, scope),
					)
				)
			) {
				return
			}
		}

		return {
			returnType: methodType.returnType,
			overloadedMethodIndex: null,
		}
	} else if (
		methodType.type === "OverloadedMethod" ||
		methodType.type === "OverloadedStaticMethod"
	) {
		overloadLoop: for (
			let overloadIndex = 0;
			overloadIndex < methodType.overloads.length;
			overloadIndex++
		) {
			let overload = methodType.overloads[overloadIndex]

			if (overload.parameterTypes.length !== methodArguments.length) {
				continue
			}

			for (
				let parameterIndex = 0;
				parameterIndex < overload.parameterTypes.length;
				parameterIndex++
			) {
				const parameter = overload.parameterTypes[parameterIndex]
				const argument = methodArguments[parameterIndex]

				const parameterNameIsMatched =
					(parameter.name === null && argument.name === null) ||
					(parameter.name && argument.name?.content)

				if (
					!(
						parameterNameIsMatched &&
						matchesType(
							parameter.type,
							resolveType(argument.value, scope),
						)
					)
				) {
					continue overloadLoop
				}
			}

			return {
				overloadedMethodIndex: overloadIndex,
				returnType: overload.returnType,
			}
		}

		return undefined
	} else {
		return undefined
	}
}

export function resolveMethodInvocation(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): {
	namespace: { name: string; type: common.NamespaceType }
	type: common.Type
	overloadedMethodIndex: number | null
} {
	let namespaces = resolveMethodLookupBaseNamespaces(node, scope)
	let resolvedNamespace: { name: string; type: common.NamespaceType }

	if (namespaces.size === 0) {
		throw new Error(
			`Could not find a Namespace for the value at ${node.base.position.start.line}:${node.base.position.start.column} (method '${node.member.content}').`,
		)
	} else {
		let matchingNamespaces = new Map<string, common.NamespaceType>()
		for (let [name, namespace] of namespaces) {
			if (Object.hasOwn(namespace.methods, node.member.content)) {
				matchingNamespaces.set(name, namespace)
			}
		}

		if (matchingNamespaces.size === 0) {
			throw `Could not find a method with name ${node.member.content} in the namespaces matching the type of the left hand side expression.`
		} else {
			if (matchingNamespaces.size === 1) {
				resolvedNamespace = {
					name: Array.from(matchingNamespaces.entries())[0][0],
					type: Array.from(matchingNamespaces.entries())[0][1],
				}

				let resolvedMethod = resolveInvokedMethodInNamespace(
					node,
					resolvedNamespace.type,
					scope,
				)

				if (resolvedMethod) {
					return {
						namespace: resolvedNamespace,
						overloadedMethodIndex:
							resolvedMethod.overloadedMethodIndex,
						type: resolvedMethod.returnType,
					}
				} else {
					throw new Error(
						"MethodInvocation: Passed arguments do not match any overload",
					)
				}
			} else {
				let resolvedMethods = []

				for (let [namespaceName, namespaceType] of matchingNamespaces) {
					let resolvedMethod = resolveInvokedMethodInNamespace(
						node,
						namespaceType,
						scope,
					)

					if (resolvedMethod) {
						resolvedMethods.push({
							namespace: {
								name: namespaceName,
								type: namespaceType,
							},
							overloadedMethodIndex:
								resolvedMethod.overloadedMethodIndex,
							type: resolvedMethod.returnType,
						})
					}
				}

				if (resolvedMethods.length === 0) {
					throw new Error(
						"MethodInvocation: Passed arguments do not match any overload",
					)
				} else if (resolvedMethods.length === 1) {
					return resolvedMethods[0]
				} else {
					throw new Error(
						`MethodInvocation: Passed arguments matched more than 1 namespace, please disambiguate.

The Matching namespaces are:
${resolvedMethods
	.map((method) => {
		return `    - ${method.namespace.name}`
	})
	.join("\n")}
`,
					)
				}
			}
		}
	}
}

export function resolveMethodInvocationType(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): common.Type {
	return resolveMethodInvocation(node, scope).type
}

export function resolveFunctionInvocationType(
	node: parser.FunctionInvocationNode,
	scope: enricher.Scope,
): common.Type {
	const type = resolveType(node.name, scope)

	if (
		type.type === "Function" ||
		type.type === "SimpleMethod" ||
		type.type === "StaticMethod"
	) {
		return type.returnType
	} else if (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	) {
		const methodArguments = node.arguments

		overloadLoop: for (let overload of type.overloads) {
			if (overload.parameterTypes.length !== methodArguments.length) {
				continue
			}

			for (let i = 0; i < overload.parameterTypes.length; i++) {
				const parameter = overload.parameterTypes[i]
				const argument = methodArguments[i]

				if (
					!(
						((parameter.name === null && argument.name === null) ||
							(parameter.name && argument.name?.content)) &&
						matchesType(
							parameter.type,
							resolveType(argument.value, scope),
						)
					)
				) {
					continue overloadLoop
				}
			}

			return overload.returnType
		}

		throw new Error(
			"MethodInvocation: Passed arguments do not match any overload",
		)
	} else {
		throw new Error(
			`Expression at ${node.name.position.start.line}:${node.name.position.start.column} is not a function.`,
		)
	}
}

export function resolveCombinationType(
	node: parser.CombinationNode,
	scope: enricher.Scope,
): common.RecordType {
	function isSubType(
		lhs: common.RecordType,
		rhs: common.RecordType,
	): boolean {
		for (let [rhsName, rhsType] of Object.entries(rhs.members)) {
			if (!deepEqual(lhs.members[rhsName], rhsType)) {
				return false
			}
		}

		return true
	}

	let lhsType = resolveType(node.lhs, scope)
	let rhsType = resolveType(node.rhs, scope)

	switch (lhsType.type) {
		case "GenericList":
		case "AppliedType":
		case "GenericUse":
			throw new Error("You can not combine Generic Types.")
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			throw new Error("You can not combine Functions.")
		case "Namespace":
			throw new Error("You can not combine Namespaces.")
		case "List":
			throw new Error("You can not combine Lists.")
		case "Boolean":
			throw new Error("You can not combine Booleans.")
		case "Integer":
			throw new Error("You can not combine Integers.")
		case "Fraction":
			throw new Error("You can not combine Fractions.")
		case "Nothing":
			throw new Error("You can not combine Nothings.")
		case "String":
			throw new Error("You can not combine Strings.")
		case "Unknown":
			throw new Error("You can not combine Unknowns.")
		case "UnionType":
			throw new Error("You can not combine Unions.")
	}

	switch (rhsType.type) {
		case "GenericList":
		case "AppliedType":
		case "GenericUse":
			throw new Error("You can not combine Generic Types.")
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			throw new Error("You can not combine Functions.")
		case "Namespace":
			throw new Error("You can not combine Namespaces.")
		case "List":
			throw new Error("You can not combine Lists.")
		case "Boolean":
			throw new Error("You can not combine Booleans.")
		case "Integer":
			throw new Error("You can not combine Integers.")
		case "Fraction":
			throw new Error("You can not combine Fractions.")
		case "Nothing":
			throw new Error("You can not combine Nothings.")
		case "String":
			throw new Error("You can not combine Strings.")
		case "Unknown":
			throw new Error("You can not combine Unknowns.")
		case "UnionType":
			throw new Error("You can not combine Unions.")
	}

	// TODO: Resolve Applied Types and check wether they are Records

	if (deepEqual(lhsType, rhsType)) {
		return lhsType
	} else {
		if (isSubType(lhsType, rhsType)) {
			return lhsType
		} else {
			throw new Error(
				"The right hand side Type must be a Partial of the left hand side Type.",
			)
		}
	}
}

export function resolveRecordValueType(
	node: parser.RecordValueNode,
	scope: enricher.Scope,
): common.RecordType {
	if (node.type !== null) {
		const resolvedType = resolveType(node.type, scope)

		if (resolvedType.type === "Record") {
			return resolvedType
		} else {
			throw new Error(
				"Record Type Annotations have to be of a Record Type!",
			)
		}
	} else {
		let members: Record<string, common.Type> = {}

		for (let [memberKey, memberValue] of Object.entries(node.members)) {
			members[memberKey] = resolveType(memberValue, scope)
		}

		return {
			type: "Record",
			members,
		}
	}
}

export function resolveFunctionValueType(
	node: parser.FunctionValueNode,
	scope: enricher.Scope,
): common.FunctionType {
	return resolveFunctionDefinitionType(node.value, scope)
}

export function resolveListValueType(
	node: parser.ListValueNode,
	scope: enricher.Scope,
): common.ListType {
	if (node.values.length === 0) {
		return {
			type: "List",
			itemType: { type: "Unknown" },
		}
	} else {
		let itemType = resolveType(node.values[0], scope)
		let isUnion = false

		for (let expression of node.values) {
			let expressionType = resolveType(expression, scope)
			if (!deepEqual(itemType, expressionType)) {
				if (!isUnion) {
					isUnion = true

					itemType = {
						type: "UnionType",
						types: [itemType, expressionType],
					}
				} else {
					;(itemType as common.UnionType).types.push(expressionType)
				}
			}
		}

		return {
			type: "List",
			itemType,
		}
	}
}

export function resolveLookupType(
	node: parser.LookupNode,
	scope: enricher.Scope,
): common.Type {
	let baseType = resolveType(node.base, scope)

	if (baseType.type !== "Record" && baseType.type !== "Namespace") {
		throw new Error(
			`Node starting at ${node.base.position.start.line}:${node.base.position.start.column} is neither a Record, Namespace, Type, or GenericType.`,
		)
	} else {
		if (baseType.type === "Namespace") {
			if (Object.hasOwn(baseType.properties, node.member.content)) {
				return baseType.properties[node.member.content]
			} else if (Object.hasOwn(baseType.methods, node.member.content)) {
				return baseType.methods[node.member.content]
			} else {
				throw new Error(
					`Object starting at ${node.base.position.start.line}:${node.base.position.start.column} has no member '${node.member.content}'.`,
				)
			}
		} else {
			if (Object.hasOwn(baseType.members, node.member.content)) {
				return baseType.members[node.member.content]
			} else {
				throw new Error(
					`Object starting at ${node.base.position.start.line}:${node.base.position.start.column} has no member '${node.member.content}'.`,
				)
			}
		}
	}
}

export function resolveIdentifierType(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
): common.Type {
	let name = node.content
	let result = findVariableInScope(name, scope)

	if (result === null) {
		throw new Error(
			`Variable '${name}' at ${node.position.start.line}:${node.position.start.column} is not declared.`,
		)
	} else {
		return result
	}
}

export function resolveSelfType(
	_node: parser.SelfNode,
	scope: enricher.Scope,
): common.Type {
	let result = findVariableInScope("@", scope)

	if (result === null) {
		throw new Error(
			"@-Expressions can not be used outside of methods and match expressions.",
		)
	} else {
		return result
	}
}

export function resolveGenericDeclarations(
	generics: Array<parser.GenericDeclarationNode>,
	scope: enricher.Scope,
): Array<common.GenericDeclaration> {
	return generics.map((generic) => {
		let defaultType = null

		if (generic.defaultType) {
			defaultType = resolveType(generic.defaultType, scope)
		}

		return {
			name: generic.name.content,
			infer: false,
			defaultType,
		}
	})
}

// NOTE: Declared Generics are registered as GenericUses so that Parameter
// and Return Types can reference them. Binding them to concrete Types
// happens once Generic Inference is implemented.
export function scopeWithGenerics(
	generics: Array<parser.GenericDeclarationNode>,
	scope: enricher.Scope,
): enricher.Scope {
	let types: Record<string, common.Type> = {}

	for (let generic of generics) {
		types[generic.name.content] = {
			type: "GenericUse",
			name: generic.name.content,
		}
	}

	return { parent: scope, members: {}, types }
}

export function resolveFunctionDefinitionType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.FunctionType {
	let functionScope = scopeWithGenerics(node.generics, scope)

	return {
		type: "Function",
		generics: resolveGenericDeclarations(node.generics, scope),
		parameterTypes: node.parameters.map((parameter) => {
			let name = null

			if (parameter.externalName !== null) {
				name = parameter.externalName.content
			}

			return {
				name,
				type: resolveType(parameter.type, functionScope),
			}
		}),
		returnType: resolveType(node.returnType, functionScope),
	}
}

export function resolveNamespaceDefinitionStatementType(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
): common.NamespaceType {
	let resultType: common.NamespaceType = {
		type: "Namespace",
		targetType:
			node.targetType === null
				? null
				: resolveType(node.targetType, scope),
		name: node.name.content,
		generics: [],
		properties: {},
		methods: {},
	}

	let properties: Record<string, common.Type> = {}
	let methods: Record<string, common.MethodType> = {}

	for (let [memberKey, memberValue] of Object.entries(node.properties)) {
		properties[memberKey] = resolveType(memberValue.value, scope)
	}

	for (let [methodName, methodValue] of Object.entries(node.methods)) {
		methods[methodName] = resolveMethodType(
			methodValue,
			{
				parent: scope,
				members: { [node.name.content]: resultType },
				types: { [node.name.content]: resultType },
			},
			resultType.targetType,
		)
	}

	resultType.properties = properties
	resultType.methods = methods

	return resultType
}

export function resolveIdentifierTypeDeclarationType(
	node: parser.IdentifierTypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	let name = node.type.content
	let result = findTypeInScope(name, scope)

	if (result === null) {
		throw new Error(
			`Type '${name}' at ${node.position.start.line}:${node.position.start.column} is not declared.`,
		)
	} else {
		return result
	}
}

export function resolveUnionTypeDeclarationType(
	node: parser.UnionTypeDeclarationNode,
	scope: enricher.Scope,
): common.UnionType {
	let resolvedTypes = []

	for (let type of node.types) {
		resolvedTypes.push(resolveType(type, scope))
	}

	return { type: "UnionType", types: resolvedTypes }
}

export function resolveRecordTypeDeclarationType(
	node: parser.RecordTypeDeclarationNode,
	scope: enricher.Scope,
): common.RecordType {
	return {
		type: "Record",
		members: Object.fromEntries(
			Object.entries(node.members).map(([key, value]) => {
				return [key, resolveType(value, scope)]
			}),
		),
	}
}

export function resolveGenericTypeDeclarationType(
	node: parser.GenericTypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	let baseType = resolveType(node.baseType, scope)

	// NOTE: List is the only Generic Type so far. Applied Lists are
	// normalized into plain List Types right away, so that inferred and
	// declared List Types share a single representation.
	if (baseType.type === "GenericList") {
		if (node.generics.length !== 1) {
			throw new Error(
				`List requires exactly 1 Type Argument at ${node.position.start.line}:${node.position.start.column}.`,
			)
		}

		return {
			type: "List",
			itemType: resolveType(node.generics[0], scope),
		}
	}

	throw new Error(
		`Type at ${node.position.start.line}:${node.position.start.column} is not generic.`,
	)
}

export function resolveMatchType(
	node: parser.MatchNode,
	scope: enricher.Scope,
): common.Type {
	return resolveType(node.returnType, scope)
}

/***********/
/* Helpers */
/***********/

export function findVariableInScope(
	name: string,
	scope: enricher.Scope,
): common.Type | null {
	let searchScope: enricher.Scope | null = scope

	while (true) {
		if (searchScope === null) {
			return null
		}

		if (searchScope.members[name] != null) {
			return searchScope.members[name]
		} else {
			searchScope = searchScope.parent
		}
	}
}

export function findTypeInScope(
	name: string,
	scope: enricher.Scope,
): common.Type | null {
	let searchScope: enricher.Scope | null = scope

	while (true) {
		if (searchScope === null) {
			return null
		}

		if (Object.hasOwn(searchScope.types, name)) {
			return searchScope.types[name]
		} else {
			searchScope = searchScope.parent
		}
	}
}

export function getAllNamespacesInScope(
	scope: enricher.Scope,
	identifier: parser.IdentifierNode | null,
): Map<string, common.NamespaceType> {
	let searchScope: enricher.Scope | null = scope
	let variableNames: Array<string> = []
	let namespaces: Map<string, common.NamespaceType> = new Map()

	scopeLoop: while (true) {
		if (searchScope === null) {
			break
		}

		for (let [key, value] of Object.entries(searchScope.members)) {
			if (identifier) {
				if (value.type === "Namespace" && identifier.content === key) {
					namespaces.set(key, value)
					break scopeLoop
				}
			} else {
				// NOTE: Since we are resolving bottom up, we need to exclude any shadowed variables
				if (!variableNames.includes(key)) {
					variableNames.push(key)

					if (value.type === "Namespace") {
						namespaces.set(key, value)
					}
				}
			}
		}

		searchScope = searchScope.parent
	}

	return namespaces
}

export function resolveMethodLookupBaseNamespaces(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): Map<string, common.NamespaceType> {
	let baseType = resolveType(node.base, scope)
	let namespaces = getAllNamespacesInScope(scope, node.namespaceSpecifier)
	let matchingNamespaces: Map<string, common.NamespaceType> = new Map()

	for (let [name, namespace] of namespaces) {
		if (namespace.targetType) {
			if (namespace.targetType.type === "UnionType") {
				for (let type of namespace.targetType.types) {
					if (matchesType(type, baseType)) {
						matchingNamespaces.set(name, namespace)
						break
					}
				}
			} else if (matchesType(namespace.targetType, baseType)) {
				matchingNamespaces.set(name, namespace)
			}
		}
	}

	return matchingNamespaces
}

export function resolveMethodType(
	node:
		| parser.SimpleMethod
		| parser.StaticMethod
		| parser.OverloadedMethod
		| parser.OverloadedStaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
): common.MethodType {
	if (node.nodeType === "SimpleMethod") {
		if (selfType === null) {
			throw new Error(
				"Using Non-Static Methods in Untyped Namespaces is not supported.",
			)
		}

		return {
			type: "SimpleMethod",
			generics: resolveGenericDeclarations(
				node.method.value.generics,
				scope,
			),
			parameterTypes: [
				{ name: null, type: selfType },
				...node.method.value.parameters.map((param) => {
					let name = null

					if (param.externalName !== null) {
						name = param.externalName.content
					}

					return {
						name,
						type: resolveType(param.type, scope),
					}
				}),
			],
			returnType: resolveType(node.method.value.returnType, scope),
		}
	} else if (node.nodeType === "StaticMethod") {
		return {
			type: "StaticMethod",
			generics: resolveGenericDeclarations(
				node.method.value.generics,
				scope,
			),
			parameterTypes: node.method.value.parameters.map((param) => {
				let name = null

				if (param.externalName !== null) {
					name = param.externalName.content
				}

				return {
					name,
					type: resolveType(param.type, scope),
				}
			}),
			returnType: resolveType(node.method.value.returnType, scope),
		}
	} else if (node.nodeType === "OverloadedMethod") {
		if (selfType === null) {
			throw new Error(
				"Using Non-Static Methods in Untyped Namespaces is not supported.",
			)
		}

		return {
			type: "OverloadedMethod",
			overloads: node.methods.map((method) => {
				return {
					generics: resolveGenericDeclarations(
						method.value.generics,
						scope,
					),
					parameterTypes: [
						{ name: null, type: selfType },
						...method.value.parameters.map((parameter) => {
							let name: string | null

							if (parameter.externalName !== null) {
								name = parameter.externalName.content
							} else {
								name = null
							}

							return {
								name,
								type: resolveType(parameter.type, scope),
							}
						}),
					],
					returnType: resolveType(method.value.returnType, scope),
				}
			}),
		}
	} else {
		return {
			type: "OverloadedStaticMethod",
			overloads: node.methods.map((method) => {
				return {
					generics: resolveGenericDeclarations(
						method.value.generics,
						scope,
					),
					parameterTypes: [
						...method.value.parameters.map((parameter) => {
							let name: string | null

							if (parameter.externalName !== null) {
								name = parameter.externalName.content
							} else {
								name = null
							}

							return {
								name,
								type: resolveType(parameter.type, scope),
							}
						}),
					],
					returnType: resolveType(method.value.returnType, scope),
				}
			}),
		}
	}
}
