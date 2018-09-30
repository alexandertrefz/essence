import deepEqual = require("deep-equal")

import { parser, enricher, common } from "../interfaces"

import stringType from "./types/String"
import booleanType from "./types/Boolean"
import numberType from "./types/Number"
import generateListType from "./types/List"

export function resolveType(
	node:
		| parser.ExpressionNode
		| parser.FunctionDefinitionNode
		| parser.TypeDefinitionStatementNode
		| parser.TypeDeclarationNode,
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
		case "StringValue":
			return { type: "Primitive", primitive: "String" }
		case "NumberValue":
			return { type: "Primitive", primitive: "Number" }
		case "BooleanValue":
			return { type: "Primitive", primitive: "Boolean" }
		case "FunctionValue":
			return resolveFunctionDefinitionType(node.value, scope)
		case "ListValue":
			return resolveListValueType(node, scope)
		case "Lookup":
			return resolveLookupType(node, scope)
		case "Identifier":
			return resolveIdentifierType(node, scope)
		case "Self":
			return resolveSelfType(node, scope)
		case "MethodLookup":
			return resolveMethodLookupType(node, scope)
		case "FunctionDefinition":
			return resolveFunctionDefinitionType(node, scope)
		case "TypeDefinitionStatement":
			return resolveTypeDefinitionStatementType(node, scope)
		case "IdentifierTypeDeclaration":
			return resolveIdentifierTypeDeclarationType(node, scope)
		case "ListTypeDeclaration":
			return resolveListTypeDeclarationType(node, scope)
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

export function resolveMethodInvocationType(node: parser.MethodInvocationNode, scope: enricher.Scope): common.Type {
	let type = resolveMethodLookupType(node.name, scope)

	if (type.type === "Method") {
		return type.returnType
	} else {
		throw new Error(
			`${node.name.member.content} is not a function on Type at ${node.name.base.position.start.line}:${
				node.name.base.position.start.column
			}.`,
		)
	}
}

export function resolveFunctionInvocationType(node: parser.FunctionInvocationNode, scope: enricher.Scope): common.Type {
	const type = resolveType(node.name, scope)

	if (type.type === "Function") {
		return type.returnType
	} else if (type.type === "Method") {
		return type.returnType
	} else {
		throw new Error(
			`Expression at ${node.name.position.start.line}:${node.name.position.start.column} is not a function.`,
		)
	}
}

export function resolveCombinationType(node: parser.CombinationNode, scope: enricher.Scope): common.Type {
	function isSubType(lhs: common.RecordType | common.TypeType, rhs: common.RecordType | common.TypeType): boolean {
		if (lhs.type === "Type") {
			if (lhs.definition.type === "Primitive" || lhs.definition.type === "BuiltIn") {
				throw new Error(`You can not combine ${lhs.name} with other Types.`)
			} else {
				lhs = lhs.definition
			}
		}

		if (rhs.type === "Type") {
			if (rhs.definition.type === "Primitive" || rhs.definition.type === "BuiltIn") {
				throw new Error(`You can not combine ${rhs.name} with other Types.`)
			} else {
				rhs = rhs.definition
			}
		}

		for (let [rhsName, rhsType] of Object.entries(rhs.members)) {
			if (rhsType.type === "Primitive") {
				rhsType = resolvePrimitiveTypeType(rhsType, scope)
			}

			if (!deepEqual(lhs.members[rhsName], rhsType)) {
				return false
			}
		}

		return true
	}

	let lhsType = resolveType(node.lhs, scope)
	let rhsType = resolveType(node.rhs, scope)

	switch (lhsType.type) {
		case "Method":
		case "Function":
			throw new Error("You can not combine Functions.")
		case "List":
			throw new Error("You can not combine Lists.")
		case "Primitive":
			throw new Error("You can not combine Primitives.")
		case "Never":
			throw new Error("You can not combine Nevers.")
	}

	switch (rhsType.type) {
		case "Method":
		case "Function":
			throw new Error("You can not combine Functions.")
		case "List":
			throw new Error("You can not combine Lists.")
		case "Primitive":
			throw new Error("You can not combine Primitives.")
		case "Never":
			throw new Error("You can not combine Nevers.")
	}

	if (deepEqual(lhsType, rhsType)) {
		return lhsType
	} else {
		if (isSubType(lhsType, rhsType)) {
			return lhsType
		} else {
			throw new Error("The right hand side Type must be a Partial of the left hand side Type.")
		}
	}
}

export function resolveRecordValueType(node: parser.RecordValueNode, scope: enricher.Scope): common.Type {
	if (node.type !== null) {
		return resolveType(node.type, scope)
	} else {
		let members: { [key: string]: common.Type } = {}

		for (let [memberKey, memberValue] of Object.entries(node.members)) {
			members[memberKey] = resolveType(memberValue, scope)
		}

		return {
			type: "Record",
			members,
		}
	}
}

export function resolveFunctionValueType(node: parser.FunctionValueNode, scope: enricher.Scope): common.FunctionType {
	return resolveFunctionDefinitionType(node.value, scope)
}

export function resolveListValueType(node: parser.ListValueNode, scope: enricher.Scope): common.ListType {
	if (node.values.length === 0) {
		return {
			type: "List",
			itemType: { type: "Never" },
		}
	} else {
		let itemType = resolveType(node.values[0], scope)

		for (let expression of node.values) {
			if (!deepEqual(itemType, resolveType(expression, scope))) {
				// TODO: Implement Union Types
				throw new Error("Union Types are not implemented yet.")
			}
		}

		return {
			type: "List",
			itemType,
		}
	}
}

export function resolveLookupType(node: parser.LookupNode, scope: enricher.Scope): common.Type {
	let baseType = resolveType(node.base, scope)

	if (baseType.type !== "Record" && baseType.type !== "Type") {
		throw new Error(
			`Node starting at ${node.base.position.start.line}:${
				node.base.position.start.column
			} is not a Record or Type.`,
		)
	} else {
		if (baseType.type === "Type") {
			if (baseType.definition.type === "Record") {
				if (baseType.definition.members[node.member.content] != null) {
					return baseType.definition.members[node.member.content]
				} else if (baseType.methods[node.member.content] != null) {
					return baseType.methods[node.member.content]
				} else {
					throw new Error(
						`Object starting at ${node.base.position.start.line}:${
							node.base.position.start.column
						} has no member '${node.member.content}'.`,
					)
				}
			} else {
				if (baseType.methods[node.member.content] != null) {
					return baseType.methods[node.member.content]
				} else {
					throw new Error(`Access to properties of Primitive Types is not allowed.`)
				}
			}
		} else {
			if (baseType.members[node.member.content] !== null) {
				return baseType.members[node.member.content]
			} else {
				throw new Error(
					`Object starting at ${node.base.position.start.line}:${
						node.base.position.start.column
					} has no member '${node.member.content}'.`,
				)
			}
		}
	}
}

export function resolveIdentifierType(node: parser.IdentifierNode, scope: enricher.Scope): common.Type {
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

export function resolveSelfType(node: parser.SelfNode, scope: enricher.Scope): common.Type {
	let result = findVariableInScope("@", scope)

	if (result === null) {
		throw new Error(`@-Expressions can not be used outside of methods.`)
	} else {
		return result
	}
}

export function resolveMethodLookupType(node: parser.MethodLookupNode, scope: enricher.Scope): common.MethodType {
	let baseType = resolveMethodLookupBaseType(node.base, scope)
	let result = baseType.methods[node.member.content]

	if (result == null) {
		throw new Error(
			`Could not resolve Method ${node.member.content} on Type of Expression at ${
				node.base.position.start.line
			}:${node.base.position.start.column}.`,
		)
	}

	return result
}

export function resolveFunctionDefinitionType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.FunctionType {
	return {
		type: "Function",
		parameterTypes: node.parameters.map(parameter => {
			let name = null

			if (parameter.externalName !== null) {
				name = parameter.externalName.content
			}

			return {
				name,
				type: resolveType(parameter.type, scope),
			}
		}),
		returnType: resolveType(node.returnType, scope),
	}
}

export function resolveTypeDefinitionStatementType(
	node: parser.TypeDefinitionStatementNode,
	scope: enricher.Scope,
): common.TypeType {
	// TODO: Find a better way of implementing this without depending on object reference behaviour & type forcing
	let resultType: common.TypeType = {
		type: "Type",
		name: node.name.content,
	} as common.TypeType

	let definitionMembers: { [key: string]: common.Type } = {}
	let methods: { [key: string]: common.MethodType } = {}

	for (let [memberKey, memberValue] of Object.entries(node.properties)) {
		definitionMembers[memberKey] = resolveType(memberValue, scope)
	}

	for (let [methodName, methodValue] of Object.entries(node.methods)) {
		methods[methodName] = resolveMethodType(
			methodValue,
			{ parent: scope, members: { [node.name.content]: resultType } },
			resultType,
		)
	}

	resultType.definition = {
		type: "Record",
		members: definitionMembers,
	}

	resultType.methods = methods

	return resultType
}

export function resolveIdentifierTypeDeclarationType(
	node: parser.IdentifierTypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	let name = node.type.content
	let result = findVariableInScope(name, scope)

	if (result === null) {
		throw new Error(
			`Variable '${name}' at ${node.position.start.line}:${node.position.start.column} is not declared.`,
		)
	} else {
		return result
	}
}

export function resolveListTypeDeclarationType(
	node: parser.ListTypeDeclarationNode,
	scope: enricher.Scope,
): common.ListType {
	const itemType = resolveType(node.type, scope)

	if (itemType.type === "Method") {
		throw new Error("Methods can not be List Item Types.")
	}

	return { type: "List", itemType }
}

/***********/
/* Helpers */
/***********/

export function findVariableInScope(name: string, scope: enricher.Scope): common.Type | null {
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

export function resolveMethodLookupBaseType(node: parser.ExpressionNode, scope: enricher.Scope): common.TypeType {
	let baseType = resolveType(node, scope)

	switch (baseType.type) {
		case "Primitive":
			return resolvePrimitiveTypeType(baseType, scope)
		case "List":
			return generateListType(baseType.itemType)
		case "Type":
			return baseType
		default:
			throw new Error(
				`Could not resolve Member on a Type at ${node.position.start.line}:${node.position.start.column}.`,
			)
	}
}

export function resolveMethodType(
	node: parser.Method | parser.OverloadedMethod,
	scope: enricher.Scope,
	selfType: common.TypeType,
): common.MethodType {
	if (node.isOverloaded) {
		const returnType = node.methods.reduce<common.Type | null>((prev, curr) => {
			let currType = resolveType(curr.value.returnType, scope)

			if (prev === null) {
				return currType
			} else if (deepEqual(prev, currType)) {
				return currType
			} else {
				return null
			}
		}, null)

		if (returnType === null) {
			throw new Error("Overloaded Methods need to have the same return type")
		}

		if (node.isStatic) {
			return {
				type: "Method",
				parameterTypes: node.methods.map(method =>
					method.value.parameters.map(parameter => {
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
				),
				returnType,
				isStatic: true,
				isOverloaded: true,
			}
		} else {
			return {
				type: "Method",
				parameterTypes: node.methods.map(method => [
					{ name: null, type: selfType },
					...method.value.parameters.map(parameter => {
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
				]),
				returnType,
				isStatic: node.isStatic,
				isOverloaded: node.isOverloaded,
			}
		}
	} else {
		if (node.isStatic) {
			return {
				type: "Method",
				parameterTypes: node.method.value.parameters.map(param => {
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
				isStatic: node.isStatic,
				isOverloaded: node.isOverloaded,
			}
		} else {
			return {
				type: "Method",
				parameterTypes: [
					{ name: null, type: selfType },
					...node.method.value.parameters.map(param => {
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
				isStatic: node.isStatic,
				isOverloaded: node.isOverloaded,
			}
		}
	}
}

export function resolvePrimitiveTypeType(type: common.PrimitiveType, scope: enricher.Scope): common.TypeType {
	switch (type.primitive) {
		case "Number":
			return numberType
		case "Boolean":
			return booleanType
		case "String":
			return stringType
	}
}
