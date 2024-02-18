import deepEqual from "deep-equal"

import { matchesType } from "../helpers"
import { common, enricher, parser } from "../interfaces"

import booleanType from "./types/Boolean"
import fractionType from "./types/Fraction"
import integerType from "./types/Integer"
import listType from "./types/List"
import nothingType from "./types/Nothing"
import recordType from "./types/Record"
import stringType from "./types/String"

export function resolveType(
	node:
		| parser.ExpressionNode
		| parser.FunctionDefinitionNode
		| parser.TypeDefinitionStatementNode
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
		case "StringValue":
			return { type: "Primitive", primitive: "String" }
		case "IntegerValue":
			return { type: "Primitive", primitive: "Integer" }
		case "FractionValue":
			return { type: "Primitive", primitive: "Fraction" }
		case "BooleanValue":
			return { type: "Primitive", primitive: "Boolean" }
		case "NothingValue":
			return { type: "Primitive", primitive: "Nothing" }
		case "FunctionValue":
			return resolveFunctionValueType(node, scope)
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
		case "NamespaceDefinitionStatement":
			return resolveNamespaceDefinitionStatementType(node, scope)
		case "IdentifierTypeDeclaration":
			return resolveIdentifierTypeDeclarationType(node, scope)
		case "ListTypeDeclaration":
			return resolveListTypeDeclarationType(node, scope)
		case "UnionTypeDeclaration":
			return resolveUnionTypeDeclarationType(node, scope)
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
	} else if (type.type === "GenericFunction") {
		let inferredType = inferGenericFunctionInvocation(
			type,
			node.arguments,
			scope,
		)

		return inferredType.returnType
	} else {
		throw new Error(`${node.name.content} is not a native function.`)
	}
}

function deeplyResolveGenerics(
	type: common.Type,
	inferredGenerics: Record<string, common.Type>,
): common.Type {
	if (type.type === "Generic") {
		return inferredGenerics[type.name]
	} else if (type.type === "UnionType") {
		return deeplyResolveGenericsForUnion(type, inferredGenerics)
	} else if (type.type === "Record") {
		return deeplyResolveGenericsForRecord(type, inferredGenerics)
	} else if (type.type === "List") {
		return {
			type: "List",
			itemType: deeplyResolveGenerics(type.itemType, inferredGenerics),
		}
	} else {
		return type
	}
}

function deeplyResolveGenericsForUnion(
	union: common.UnionType,
	inferredGenerics: Record<string, common.Type>,
): common.UnionType {
	union = structuredClone(union)

	for (let i = 0; i < union.types.length; i++) {
		union.types[i] = deeplyResolveGenerics(union.types[i], inferredGenerics)
	}

	return union
}

function deeplyResolveGenericsForRecord(
	record: common.RecordType,
	inferredGenerics: Record<string, common.Type>,
): common.RecordType {
	record = structuredClone(record)

	let entries = Object.entries(record.members)

	for (let i = 0; i < entries.length; i++) {
		entries[i][1] = deeplyResolveGenerics(entries[i][1], inferredGenerics)
	}

	record.members = Object.fromEntries(entries)

	return record
}

function deeplyInferGenericsForFunction(
	functionType: common.FunctionType,
	inferredGenerics: Record<string, common.Type>,
): common.FunctionType {
	for (let i = 0; i < functionType.parameterTypes.length; i++) {
		functionType.parameterTypes[i].type = deeplyResolveGenerics(
			functionType.parameterTypes[i].type,
			inferredGenerics,
		)
	}

	functionType.returnType = deeplyResolveGenerics(
		functionType.returnType,
		inferredGenerics,
	)

	return functionType
}

function inferGenericFunctionInvocation(
	genericFunctionType: common.GenericFunctionType,
	argumentTypes: parser.ArgumentNode[],
	scope: enricher.Scope,
): common.FunctionType {
	let inferredGenerics: Record<string, common.Type> = {}

	let inferredFunctionType: common.FunctionType = {
		type: "Function",
		parameterTypes: structuredClone(genericFunctionType.parameterTypes),
		returnType: structuredClone(genericFunctionType.returnType),
	}

	for (let i = 0; i < genericFunctionType.parameterTypes.length; i++) {
		let parameter = genericFunctionType.parameterTypes[i]
		if (parameter.type.type === "Generic") {
			if (!(parameter.type.name in inferredGenerics)) {
				inferredGenerics[parameter.type.name] = resolveType(
					argumentTypes[i].value,
					scope,
				)
			}
		}
	}

	if (
		Object.entries(inferredGenerics).length !==
		genericFunctionType.generics.length
	) {
		throw new Error("Mismatch in amount of defined and declared Generics.")
	}

	for (let i = 0; i < inferredFunctionType.parameterTypes.length; i++) {
		inferredFunctionType.parameterTypes[i].type = deeplyResolveGenerics(
			inferredFunctionType.parameterTypes[i].type,
			inferredGenerics,
		)
	}

	inferredFunctionType.returnType = deeplyResolveGenerics(
		inferredFunctionType.returnType,
		inferredGenerics,
	)

	return inferredFunctionType
}

export function resolveMethodInvocationType(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): common.Type {
	let type = resolveMethodLookupType(node.name, scope)

	if (type.type === "SimpleMethod" || type.type === "StaticMethod") {
		return type.returnType
	} else if (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	) {
		const methodArguments = [
			{ name: null, value: node.name.base },
			...node.arguments,
		]

		overloadLoop: for (let overload of type.overloads) {
			if (overload.parameterTypes.length !== methodArguments.length) {
				continue
			}

			for (let i = 1; i < overload.parameterTypes.length; i++) {
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

		console.log("Arguments")
		console.log("=========")
		console.log(Bun.inspect(methodArguments))
		console.log()

		console.log("Overloads")
		console.log("=========")
		console.log(Bun.inspect(type.overloads))

		throw new Error(
			"MethodInvocation: Passed arguments do not match any overload",
		)
	} else {
		throw new Error(
			`${node.name.member.content} is not a function on Type at ${node.name.base.position.start.line}:${node.name.base.position.start.column}.`,
		)
	}
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

		console.log("Arguments")
		console.log("=========")
		console.log(Bun.inspect(methodArguments))
		console.log()

		console.log("Overloads")
		console.log("=========")
		console.log(Bun.inspect(type.overloads))

		throw new Error(
			"MethodInvocation: Passed arguments do not match any overload",
		)
	} else if (type.type === "GenericFunction") {
		let inferredType = inferGenericFunctionInvocation(
			type,
			node.arguments,
			scope,
		)

		return inferredType.returnType
	} else {
		throw new Error(
			`Expression at ${node.name.position.start.line}:${node.name.position.start.column} is not a function.`,
		)
	}
}

export function resolveCombinationType(
	node: parser.CombinationNode,
	scope: enricher.Scope,
): common.Type {
	function isSubType(
		lhs: common.RecordType | common.TypeType | common.GenericTypeType,
		rhs: common.RecordType | common.TypeType | common.GenericTypeType,
	): boolean {
		if (lhs.type === "Type") {
			if (
				lhs.definition.type === "Primitive" ||
				lhs.definition.type === "BuiltIn"
			) {
				throw new Error(
					`You can not combine ${lhs.name} with other Types.`,
				)
			} else {
				lhs = lhs.definition
			}
		}

		if (rhs.type === "Type") {
			if (
				rhs.definition.type === "Primitive" ||
				rhs.definition.type === "BuiltIn"
			) {
				throw new Error(
					`You can not combine ${rhs.name} with other Types.`,
				)
			} else {
				rhs = rhs.definition
			}
		}

		// TODO: Check if this is enough checking - shouldnt we compare the generics as well, at least in Number?

		if (lhs.type === "GenericType") {
			if (
				lhs.definition.type === "Primitive" ||
				lhs.definition.type === "BuiltIn"
			) {
				throw new Error(
					`You can not combine ${lhs.name} with other Types.`,
				)
			} else {
				lhs = lhs.definition
			}
		}

		if (rhs.type === "GenericType") {
			if (
				rhs.definition.type === "Primitive" ||
				rhs.definition.type === "BuiltIn"
			) {
				throw new Error(
					`You can not combine ${rhs.name} with other Types.`,
				)
			} else {
				rhs = rhs.definition
			}
		}

		for (let [rhsName, rhsType] of Object.entries(rhs.members)) {
			if (
				rhsType.type === "Primitive" &&
				rhsType.primitive !== "Nothing"
			) {
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
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
		case "Function":
		case "GenericFunction":
			throw new Error("You can not combine Functions.")
		case "Namespace":
			throw new Error("You can not combine Namespaces.")
		case "List":
			throw new Error("You can not combine Lists.")
		case "Primitive":
			throw new Error("You can not combine Primitives.")
		case "Unknown":
			throw new Error("You can not combine Unknowns.")
		case "Generic":
			throw new Error("You can not combine Generics.")
		case "UnionType":
			throw new Error("You can not combine Unions.")
	}

	switch (rhsType.type) {
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
		case "Function":
		case "GenericFunction":
			throw new Error("You can not combine Functions.")
		case "Namespace":
			throw new Error("You can not combine Namespaces.")
		case "List":
			throw new Error("You can not combine Lists.")
		case "Primitive":
			throw new Error("You can not combine Primitives.")
		case "Unknown":
			throw new Error("You can not combine Unknowns.")
		case "Generic":
			throw new Error("You can not combine Generics.")
		case "UnionType":
			throw new Error("You can not combine Unions.")
	}

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
): common.Type {
	if (node.type !== null) {
		return resolveType(node.type, scope)
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
): common.FunctionType | common.GenericFunctionType {
	if (node.value.nodeType === "FunctionDefinition") {
		return resolveFunctionDefinitionType(node.value, scope)
	} else {
		return resolveGenericFunctionDefinitionType(node.value, scope)
	}
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

	if (
		baseType.type !== "Record" &&
		baseType.type !== "Namespace" &&
		baseType.type !== "Type" &&
		baseType.type !== "GenericType"
	) {
		throw new Error(
			`Node starting at ${node.base.position.start.line}:${node.base.position.start.column} is neither a Record, Type, or GenericType.`,
		)
	} else {
		if (
			baseType.type === "Type" ||
			baseType.type === "GenericType" ||
			baseType.type === "Namespace"
		) {
			if (baseType.definition.type === "Record") {
				if (baseType.definition.members[node.member.content] != null) {
					return baseType.definition.members[node.member.content]
				} else if (baseType.methods[node.member.content] != null) {
					return baseType.methods[node.member.content]
				} else {
					throw new Error(
						`Object starting at ${node.base.position.start.line}:${node.base.position.start.column} has no member '${node.member.content}'.`,
					)
				}
			} else {
				if (baseType.methods[node.member.content] != null) {
					return baseType.methods[node.member.content]
				} else {
					throw new Error(
						"Access to properties of Primitive Types is not allowed.",
					)
				}
			}
		} else {
			if (baseType.members[node.member.content] !== null) {
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

export function resolveMethodLookupType(
	node: parser.MethodLookupNode,
	scope: enricher.Scope,
): common.MethodType {
	let baseType = resolveMethodLookupBaseType(node.base, scope)

	// Check wether the called Method exists on the Record Base Type
	if (
		baseType.definition.type === "Record" &&
		recordType.methods[node.member.content]
	) {
		return recordType.methods[node.member.content]
	} else {
		let result = baseType.methods[node.member.content]

		if (result == null) {
			throw new Error(
				`Could not resolve Method ${node.member.content} on Type of Expression at ${node.base.position.start.line}:${node.base.position.start.column}.`,
			)
		}

		return result
	}
}

export function resolveGenericFunctionDefinitionType(
	node: parser.GenericFunctionDefinitionNode,
	scope: enricher.Scope,
): common.GenericFunctionType {
	return {
		type: "GenericFunction",
		generics: node.generics.map((generic) => {
			let defaultType = null

			if (generic.defaultType) {
				defaultType = resolveType(generic.defaultType, scope)
			}

			return {
				name: generic.name.content,
				defaultType,
			}
		}),
		parameterTypes: node.parameters.map((parameter) => {
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

export function resolveFunctionDefinitionType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.FunctionType {
	return {
		type: "Function",
		parameterTypes: node.parameters.map((parameter) => {
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
	let resultType: common.TypeType = {
		type: "Type",
		name: node.name.content,
		definition: { type: "Record", members: {} },
		methods: {},
	}

	let definitionMembers: Record<string, common.Type> = {}
	let methods: Record<string, common.MethodType> = {}

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

export function resolveNamespaceDefinitionStatementType(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
): common.NamespaceType {
	let resultType: common.NamespaceType = {
		type: "Namespace",
		name: node.name.content,
		definition: { type: "Record", members: {} },
		methods: {},
	}

	let definitionMembers: Record<string, common.Type> = {}
	let methods: Record<string, common.NamespaceMethodType> = {}

	for (let [memberKey, memberValue] of Object.entries(node.properties)) {
		definitionMembers[memberKey] = resolveType(memberValue.value, scope)
	}

	for (let [methodName, methodValue] of Object.entries(node.methods)) {
		methods[methodName] = resolveNamespaceMethodType(methodValue, {
			parent: scope,
			members: { [node.name.content]: resultType },
		})
	}

	resultType.definition = {
		type: "Record",
		members: definitionMembers,
	}

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

	if (
		itemType.type === "SimpleMethod" ||
		itemType.type === "StaticMethod" ||
		itemType.type === "OverloadedMethod" ||
		itemType.type === "OverloadedStaticMethod"
	) {
		throw new Error("Methods can not be List Item Types.")
	}

	return { type: "List", itemType }
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

export function resolveMatchType(
	node: parser.MatchNode,
	scope: enricher.Scope,
): common.Type {
	let returnTypes = []

	for (let handler of node.handlers) {
		const resolvedReturnType = resolveType(handler.returnType, scope)

		if (returnTypes.length === 0) {
			returnTypes.push(resolvedReturnType)
		} else {
			let typeAlreadyNoted = false

			for (let returnType of returnTypes) {
				if (matchesType(returnType, resolvedReturnType)) {
					typeAlreadyNoted = true
					break
				}
			}

			if (!typeAlreadyNoted) {
				returnTypes.push(resolvedReturnType)
			}
		}
	}

	if (returnTypes.length === 0) {
		return { type: "Unknown" }
	} else if (returnTypes.length === 1) {
		return returnTypes[0]
	} else {
		return { type: "UnionType", types: returnTypes }
	}
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

export function resolveMethodLookupBaseType(
	node: parser.ExpressionNode,
	scope: enricher.Scope,
): common.TypeType {
	let baseType = resolveType(node, scope)

	switch (baseType.type) {
		case "List":
			return resolveGenericType(listType, { ItemType: baseType.itemType })
		case "Type":
			return baseType
		case "Primitive":
			if (baseType.primitive !== "Nothing") {
				return resolvePrimitiveTypeType(baseType, scope)
			} else {
				throw new Error(
					`Could not resolve Member on a Type at ${node.position.start.line}:${node.position.start.column}.\nLeft hand side is Nothing.`,
				)
			}
		case "Record":
			return recordType
		default:
			throw new Error(
				`Could not resolve Member on a Type at ${node.position.start.line}:${node.position.start.column}.`,
			)
	}
}

export function resolveMethodType(
	node:
		| parser.SimpleMethod
		| parser.StaticMethod
		| parser.OverloadedMethod
		| parser.OverloadedStaticMethod,
	scope: enricher.Scope,
	selfType: common.TypeType,
): common.MethodType {
	if (node.nodeType === "SimpleMethod") {
		return {
			type: "SimpleMethod",
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
		return {
			type: "OverloadedMethod",
			overloads: node.methods.map((method) => {
				return {
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

export function resolveNamespaceMethodType(
	node: parser.StaticMethod | parser.OverloadedStaticMethod,
	scope: enricher.Scope,
): common.NamespaceMethodType {
	if (node.nodeType === "StaticMethod") {
		return {
			type: "StaticMethod",
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
	} else {
		return {
			type: "OverloadedStaticMethod",
			overloads: node.methods.map((method) => {
				return {
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

export function resolvePrimitiveTypeType(
	type: Exclude<common.PrimitiveType, common.NothingPrimitiveType>,
	_scope: enricher.Scope,
): common.TypeType {
	switch (type.primitive) {
		case "Integer":
			return integerType
		case "Fraction":
			return fractionType
		case "Boolean":
			return booleanType
		case "String":
			return stringType
		case "Record":
			return recordType
	}
}

export function resolveGenericType(
	type: common.GenericTypeType,
	types: Record<string, common.Type>,
): common.TypeType {
	let resolvedType: common.TypeType = {
		type: "Type",
		name: type.name,
		definition: structuredClone(type.definition),
		methods: structuredClone(type.methods),
	}
	const passedTypes = Object.entries(types)

	if (type.generics.length !== passedTypes.length) {
		// TODO: Throw error, declaring which generics are missing
	}

	if (resolvedType.definition.type === "Record") {
		for (let [propertyKey, propertyValue] of Object.entries(
			resolvedType.definition.members,
		)) {
			if (propertyValue.type === "Generic") {
				if (propertyValue.name in types) {
					resolvedType.definition.members[propertyKey] =
						types[propertyValue.name]
				}
			} else if (propertyValue.type === "UnionType") {
				resolvedType.definition.members[propertyKey] =
					deeplyResolveGenericsForUnion(propertyValue, types)
			}
		}
	}

	// TODO: Figure out if we can generalise the case for ListType
	for (let [methodName, methodValue] of Object.entries(
		resolvedType.methods,
	)) {
		if (
			methodValue.type === "SimpleMethod" ||
			methodValue.type === "StaticMethod"
		) {
			for (let parameter of methodValue.parameterTypes) {
				if (parameter.type.type === "Function") {
					parameter.type = deeplyInferGenericsForFunction(
						parameter.type,
						types,
					)
				}

				if (parameter.type.type === "Generic") {
					if (parameter.type.name in types) {
						parameter.type = types[parameter.type.name]
					}
				}

				if (parameter.type.type === "UnionType") {
					parameter.type = deeplyResolveGenericsForUnion(
						parameter.type,
						types,
					)
				}

				if (
					parameter.type.type === "List" &&
					parameter.type.itemType.type === "Generic"
				) {
					if (parameter.type.itemType.name in types) {
						parameter.type.itemType =
							types[parameter.type.itemType.name]
					}
				}
			}

			if (methodValue.returnType.type === "Generic") {
				if (methodValue.returnType.name in types) {
					methodValue.returnType = types[methodValue.returnType.name]
				}
			}

			if (methodValue.returnType.type === "UnionType") {
				methodValue.returnType = deeplyResolveGenericsForUnion(
					methodValue.returnType,
					types,
				)
			}

			if (
				methodValue.returnType.type === "List" &&
				methodValue.returnType.itemType.type === "Generic"
			) {
				if (methodValue.returnType.itemType.name in types) {
					methodValue.returnType.itemType =
						types[methodValue.returnType.itemType.name]
				}
			}
		}

		if (
			methodValue.type === "OverloadedMethod" ||
			methodValue.type === "OverloadedStaticMethod"
		) {
			for (let overload of methodValue.overloads) {
				for (let parameter of overload.parameterTypes) {
					// TODO: Infer genericFunction as well

					if (parameter.type.type === "Function") {
						parameter.type = deeplyInferGenericsForFunction(
							parameter.type,
							types,
						)
					}

					if (parameter.type.type === "Generic") {
						if (parameter.type.name in types) {
							parameter.type = types[parameter.type.name]
						}
					}

					if (parameter.type.type === "UnionType") {
						parameter.type = deeplyResolveGenericsForUnion(
							parameter.type,
							types,
						)
					}

					if (
						parameter.type.type === "List" &&
						parameter.type.itemType.type === "Generic"
					) {
						if (parameter.type.itemType.name in types) {
							parameter.type.itemType =
								types[parameter.type.itemType.name]
						}
					}
				}

				if (overload.returnType.type === "Generic") {
					if (overload.returnType.name in types) {
						overload.returnType = types[overload.returnType.name]
					}
				}

				if (overload.returnType.type === "UnionType") {
					overload.returnType = deeplyResolveGenericsForUnion(
						overload.returnType,
						types,
					)
				}

				if (
					overload.returnType.type === "List" &&
					overload.returnType.itemType.type === "Generic"
				) {
					if (overload.returnType.itemType.name in types) {
						overload.returnType.itemType =
							types[overload.returnType.itemType.name]
					}
				}
			}
		}

		resolvedType.methods[methodName] = methodValue
	}

	return resolvedType
}
