import { isDeepStrictEqual } from "node:util"

import { reportError } from "../diagnostics/index"
import {
	applyGenericBindings,
	computeConformanceMethodMap,
	createInferenceContext,
	type GenericBindings,
	type MatchableArgument,
	matchArguments,
	matchesType,
	matchesTypeWithBindings,
} from "../helpers/index"
import type { common, enricher, parser } from "../interfaces/index"

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
		case "FunctionTypeDeclaration":
			return resolveFunctionTypeDeclarationType(node, scope)
		case "Match":
			return resolveMatchType(node, scope)
	}
}

export function resolveFunctionTypeDeclarationType(
	node: parser.FunctionTypeDeclarationNode,
	scope: enricher.Scope,
): common.FunctionType {
	return {
		type: "Function",
		generics: [],
		parameterTypes: node.parameterTypes.map((parameter) => ({
			name: parameter.externalName?.content ?? null,
			type: resolveType(parameter.type, scope),
		})),
		returnType: resolveType(node.returnType, scope),
	}
}

// NOTE: The result of inferring one invocation against one signature —
// `unboundGenerics` lists Type Parameters that neither a default, the
// receiver nor any Argument could bind. They are substituted as Error Types
// in `returnType`; the caller reports them once the candidate is selected.
type InferredInvocation = {
	returnType: common.Type
	unboundGenerics: Array<string>
	// NOTE: What the invocation bound each Type Parameter to — conformance
	// resolution for Protocol bounds reads the winning candidate's bindings.
	bindings: GenericBindings
}

// NOTE: Matches an invocation's Arguments left to right against a signature,
// binding `infer` Generics on their first occurrence (for Methods the
// receiver is the first Argument), and seeding plain Generics with their
// definition-time defaults. Returns undefined when the Arguments do not
// match; a fresh context per call keeps bindings from leaking between
// overload candidates.
function inferInvocation(
	signature: common.BaseFunction,
	matchableArguments: Array<MatchableArgument>,
): InferredInvocation | undefined {
	if (signature.generics.length === 0) {
		if (
			matchArguments(signature.parameterTypes, matchableArguments)
				.type !== "Match"
		) {
			return undefined
		}

		return {
			returnType: signature.returnType,
			unboundGenerics: [],
			bindings: new Map(),
		}
	}

	let context = createInferenceContext(signature.generics)

	if (
		matchArguments(signature.parameterTypes, matchableArguments, {
			inference: context,
		}).type !== "Match"
	) {
		return undefined
	}

	return substituteInferredReturnType(signature, context.bindings)
}

// NOTE: Substitutes the collected bindings into the return Type — Generics
// that stayed unbound are substituted as Error Types, so that a single
// "Could not infer" Diagnostic does not cascade.
function substituteInferredReturnType(
	signature: common.BaseFunction,
	bindings: GenericBindings,
): InferredInvocation {
	let originalBindings = bindings
	let unboundGenerics = signature.generics
		.filter((generic) => !bindings.has(generic.name))
		.map((generic) => generic.name)

	if (unboundGenerics.length > 0) {
		bindings = new Map(bindings)

		for (let name of unboundGenerics) {
			bindings.set(name, { type: "Error" })
		}
	}

	return {
		returnType: applyGenericBindings(signature.returnType, bindings),
		unboundGenerics,
		bindings: originalBindings,
	}
}

function reportUnboundGenerics(
	unboundGenerics: Array<string>,
	position: common.Position,
): void {
	for (let name of unboundGenerics) {
		reportError(`Could not infer Type Parameter '${name}'.`, position)
	}
}

export function resolveNativeFunctionInvocationType(
	node: parser.NativeFunctionInvocationNode,
	scope: enricher.Scope,
): common.Type {
	let type = resolveType(node.name, scope)

	if (type.type === "Function") {
		return resolveInferredReturnType(
			type,
			node.arguments,
			node.position,
			scope,
		)
	}

	if (type.type !== "Error") {
		reportError(
			`'${node.name.content}' is not a native function.`,
			node.name.position,
		)
	}

	return { type: "Error" }
}

// NOTE: Infers a Generic signature's return Type at an invocation whose
// Argument mismatches are reported by the Validator — a failed match still
// substitutes whatever could be bound, and "Could not infer" is only
// reported when the Arguments actually matched.
function resolveInferredReturnType(
	signature: common.BaseFunction,
	invocationArguments: Array<parser.ArgumentNode>,
	position: common.Position,
	scope: enricher.Scope,
): common.Type {
	if (signature.generics.length === 0) {
		return signature.returnType
	}

	let matchableArguments: Array<MatchableArgument> = invocationArguments.map(
		(argument) => ({
			name: argument.name?.content ?? null,
			getType: () => resolveType(argument.value, scope),
		}),
	)

	let context = createInferenceContext(signature.generics)
	let matchResult = matchArguments(
		signature.parameterTypes,
		matchableArguments,
		{ inference: context },
	)

	let inferred = substituteInferredReturnType(signature, context.bindings)

	if (matchResult.type === "Match") {
		reportUnboundGenerics(inferred.unboundGenerics, position)
	}

	return inferred.returnType
}

export function resolveInvokedMethodInNamespace(
	node: parser.MethodInvocationNode,
	resolvedNamespace: common.NamespaceType,
	scope: enricher.Scope,
):
	| {
			returnType: common.Type
			overloadedMethodIndex: number | null
			unboundGenerics: Array<string>
			signatureGenerics: Array<common.GenericDeclaration>
			bindings: GenericBindings
	  }
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

	let matchableArguments: Array<MatchableArgument> = methodArguments.map(
		(argument) => ({
			name: argument.name?.content ?? null,
			getType: () => resolveType(argument.value, scope),
		}),
	)

	if (
		methodType.type === "SimpleMethod" ||
		methodType.type === "StaticMethod"
	) {
		let inferred = inferInvocation(methodType, matchableArguments)

		if (inferred === undefined) {
			return
		}

		return {
			returnType: inferred.returnType,
			overloadedMethodIndex: null,
			unboundGenerics: inferred.unboundGenerics,
			signatureGenerics: methodType.generics,
			bindings: inferred.bindings,
		}
	} else if (
		methodType.type === "OverloadedMethod" ||
		methodType.type === "OverloadedStaticMethod"
	) {
		for (
			let overloadIndex = 0;
			overloadIndex < methodType.overloads.length;
			overloadIndex++
		) {
			let overload = methodType.overloads[overloadIndex]
			let inferred = inferInvocation(overload, matchableArguments)

			if (inferred !== undefined) {
				return {
					overloadedMethodIndex: overloadIndex,
					returnType: inferred.returnType,
					unboundGenerics: inferred.unboundGenerics,
					signatureGenerics: overload.generics,
					bindings: inferred.bindings,
				}
			}
		}

		return undefined
	} else {
		return undefined
	}
}

// NOTE: Failed Method Invocations resolve to a placeholder Namespace and an
// Error Type — the Diagnostic has already been reported, and later stages
// only run when there are no Error Diagnostics.
function resolveFailedMethodInvocation(): {
	namespace: { name: string; type: common.NamespaceType }
	type: common.Type
	overloadedMethodIndex: number | null
	conformances: Array<common.Conformance>
} {
	return {
		namespace: {
			name: "",
			type: {
				type: "Namespace",
				targetType: null,
				name: "",
				generics: [],
				properties: {},
				methods: {},
			},
		},
		type: { type: "Error" },
		overloadedMethodIndex: null,
		conformances: [],
	}
}

export function resolveMethodInvocation(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): {
	namespace: { name: string; type: common.NamespaceType }
	type: common.Type
	overloadedMethodIndex: number | null
	conformances: Array<common.Conformance>
} {
	let namespaces = resolveMethodLookupBaseNamespaces(node, scope)

	if (namespaces.size === 0) {
		if (resolveType(node.base, scope).type !== "Error") {
			reportError(
				`Could not find a Namespace for this value (method '${node.member.content}').`,
				node.base.position,
			)
		}

		return resolveFailedMethodInvocation()
	}

	let matchingNamespaces = new Map<string, common.NamespaceType>()
	for (let [name, namespace] of namespaces) {
		if (Object.hasOwn(namespace.methods, node.member.content)) {
			matchingNamespaces.set(name, namespace)
		}
	}

	if (matchingNamespaces.size === 0) {
		reportError(
			`Could not find a method named '${node.member.content}' in the Namespaces matching this value.`,
			node.member.position,
		)

		return resolveFailedMethodInvocation()
	}

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
				overloadedMethodIndex: resolvedMethod.overloadedMethodIndex,
				type: resolvedMethod.returnType,
				unboundGenerics: resolvedMethod.unboundGenerics,
				signatureGenerics: resolvedMethod.signatureGenerics,
				bindings: resolvedMethod.bindings,
			})
		}
	}

	if (resolvedMethods.length === 0) {
		reportError(
			"Passed arguments do not match any overload.",
			node.position,
		)

		return resolveFailedMethodInvocation()
	} else if (resolvedMethods.length === 1) {
		let resolvedMethod = resolvedMethods[0]

		// NOTE: Unbound Type Parameters are only reported for the selected
		// candidate — losing overloads and Namespaces must not leak
		// Diagnostics.
		reportUnboundGenerics(resolvedMethod.unboundGenerics, node.position)

		return {
			namespace: resolvedMethod.namespace,
			type: resolvedMethod.type,
			overloadedMethodIndex: resolvedMethod.overloadedMethodIndex,
			conformances: resolveConformances(
				resolvedMethod.signatureGenerics,
				resolvedMethod.bindings,
				scope,
				node.position,
			),
		}
	} else {
		reportError(
			`Passed arguments matched more than 1 Namespace, please disambiguate.

The matching Namespaces are:
${resolvedMethods
	.map((method) => {
		return `    - ${method.namespace.name}`
	})
	.join("\n")}
`,
			node.position,
		)

		return resolveFailedMethodInvocation()
	}
}

export function resolveMethodInvocationType(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): common.Type {
	return resolveMethodInvocation(node, scope).type
}

export function resolveFunctionInvocation(
	node: parser.FunctionInvocationNode,
	scope: enricher.Scope,
): { type: common.Type; conformances: Array<common.Conformance> } {
	const type = resolveType(node.name, scope)

	if (
		type.type === "Function" ||
		type.type === "SimpleMethod" ||
		type.type === "StaticMethod"
	) {
		if (type.generics.length === 0) {
			return { type: type.returnType, conformances: [] }
		}

		// NOTE: Mirrors resolveInferredReturnType, additionally keeping the
		// bindings — conformance resolution for Protocol bounds needs to know
		// what each Type Parameter was bound to. Argument mismatches are the
		// Validator's to report; "Could not infer" and conformance Diagnostics
		// only fire when the Arguments actually matched.
		let matchableArguments: Array<MatchableArgument> = node.arguments.map(
			(argument) => ({
				name: argument.name?.content ?? null,
				getType: () => resolveType(argument.value, scope),
			}),
		)

		let context = createInferenceContext(type.generics)
		let matchResult = matchArguments(
			type.parameterTypes,
			matchableArguments,
			{ inference: context },
		)

		let inferred = substituteInferredReturnType(type, context.bindings)
		let conformances: Array<common.Conformance> = []

		if (matchResult.type === "Match") {
			reportUnboundGenerics(inferred.unboundGenerics, node.position)

			conformances = resolveConformances(
				type.generics,
				inferred.bindings,
				scope,
				node.position,
			)
		}

		return { type: inferred.returnType, conformances }
	} else if (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	) {
		const matchableArguments: Array<MatchableArgument> = node.arguments.map(
			(argument) => ({
				name: argument.name?.content ?? null,
				getType: () => resolveType(argument.value, scope),
			}),
		)

		for (let overload of type.overloads) {
			let inferred = inferInvocation(overload, matchableArguments)

			if (inferred !== undefined) {
				reportUnboundGenerics(inferred.unboundGenerics, node.position)

				return {
					type: inferred.returnType,
					conformances: resolveConformances(
						overload.generics,
						inferred.bindings,
						scope,
						node.position,
					),
				}
			}
		}

		reportError(
			"Passed arguments do not match any overload.",
			node.position,
		)

		return { type: { type: "Error" }, conformances: [] }
	} else {
		if (type.type !== "Error") {
			reportError(
				"This expression is not a Function.",
				node.name.position,
			)
		}

		return { type: { type: "Error" }, conformances: [] }
	}
}

export function resolveFunctionInvocationType(
	node: parser.FunctionInvocationNode,
	scope: enricher.Scope,
): common.Type {
	return resolveFunctionInvocation(node, scope).type
}

function describeTypesForCombination(type: common.Type): string {
	switch (type.type) {
		case "Error":
			return "Error Types"
		case "GenericList":
		case "GenericAlias":
		case "GenericUse":
			return "Generic Types"
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return "Functions"
		case "Namespace":
			return "Namespaces"
		case "List":
			return "Lists"
		case "Boolean":
			return "Booleans"
		case "Integer":
			return "Integers"
		case "Fraction":
			return "Fractions"
		case "Nothing":
			return "Nothings"
		case "String":
			return "Strings"
		case "Unknown":
			return "Unknowns"
		case "UnionType":
			return "Unions"
		case "Record":
			return "Records"
	}
}

export function resolveCombinationType(
	node: parser.CombinationNode,
	scope: enricher.Scope,
): common.Type {
	function isSubType(
		lhs: common.RecordType,
		rhs: common.RecordType,
	): boolean {
		for (let [rhsName, rhsType] of Object.entries(rhs.members)) {
			if (!isDeepStrictEqual(lhs.members[rhsName], rhsType)) {
				return false
			}
		}

		return true
	}

	let lhsType = resolveType(node.lhs, scope)
	let rhsType = resolveType(node.rhs, scope)

	if (lhsType.type === "Error" || rhsType.type === "Error") {
		return { type: "Error" }
	}

	if (lhsType.type !== "Record") {
		reportError(
			`You can not combine ${describeTypesForCombination(lhsType)}.`,
			node.lhs.position,
		)

		return { type: "Error" }
	}

	if (rhsType.type !== "Record") {
		reportError(
			`You can not combine ${describeTypesForCombination(rhsType)}.`,
			node.rhs.position,
		)

		return { type: "Error" }
	}

	// TODO: Resolve Applied Types and check wether they are Records

	if (isDeepStrictEqual(lhsType, rhsType)) {
		return lhsType
	} else {
		if (isSubType(lhsType, rhsType)) {
			return lhsType
		} else {
			reportError(
				"The right hand side Type must be a Partial of the left hand side Type.",
				node.rhs.position,
			)

			return lhsType
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
		}

		if (resolvedType.type !== "Error") {
			reportError(
				"Type Annotations for Records must be Record Types.",
				node.type.position,
			)
		}
	}

	// NOTE: Missing or invalid Type Annotations fall back to the
	// structural Type of the Record Literal itself.
	let members: Record<string, common.Type> = {}

	for (let [memberKey, memberValue] of Object.entries(node.members)) {
		members[memberKey] = resolveType(memberValue.value, scope)
	}

	return {
		type: "Record",
		members,
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
			if (!isDeepStrictEqual(itemType, expressionType)) {
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

	if (baseType.type === "Error") {
		return baseType
	}

	if (baseType.type === "Namespace") {
		if (Object.hasOwn(baseType.properties, node.member.content)) {
			return baseType.properties[node.member.content]
		} else if (Object.hasOwn(baseType.methods, node.member.content)) {
			return baseType.methods[node.member.content]
		} else {
			reportError(
				`Namespace '${baseType.name}' has no member '${node.member.content}'.`,
				node.member.position,
			)

			return { type: "Error" }
		}
	} else if (baseType.type === "Record") {
		if (Object.hasOwn(baseType.members, node.member.content)) {
			return baseType.members[node.member.content]
		} else {
			reportError(
				`This Record has no member '${node.member.content}'.`,
				node.member.position,
			)

			return { type: "Error" }
		}
	} else {
		reportError(
			"Only Records and Namespaces have members.",
			node.base.position,
		)

		return { type: "Error" }
	}
}

export function resolveIdentifierType(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
): common.Type {
	let name = node.content
	let result = findVariableInScope(name, scope)

	if (result === null) {
		if (findProtocolInScope(name, scope) !== null) {
			reportError(
				`Protocol '${name}' can not be used as a value. Protocols are only usable as Generic bounds ('<infer T is ${name}>') and Namespace conformance clauses ('is ${name}').`,
				node.position,
			)
		} else {
			reportError(`Variable '${name}' is not declared.`, node.position)
		}

		return { type: "Error" }
	} else {
		return result
	}
}

export function resolveSelfType(
	node: parser.SelfNode,
	scope: enricher.Scope,
): common.Type {
	let result = findVariableInScope("@", scope)

	if (result === null) {
		reportError(
			"@-Expressions can not be used outside of Methods and Match Expressions.",
			node.position,
		)

		return { type: "Error" }
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

		if (generic.name.content === "Self") {
			reportError(
				"'Self' is a reserved Type name.",
				generic.name.position,
			)
		}

		if (generic.defaultType) {
			defaultType = resolveType(generic.defaultType, scope)
		}

		if (
			generic.constraint !== null &&
			findProtocolInScope(generic.constraint.content, scope) === null
		) {
			reportError(
				`Protocol '${generic.constraint.content}' is not declared.`,
				generic.constraint.position,
			)
		}

		return {
			name: generic.name.content,
			infer: generic.inferred,
			defaultType,
			constraint: generic.constraint?.content ?? null,
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
			...(generic.constraint !== null
				? { constraint: generic.constraint.content }
				: {}),
		}
	}

	return {
		parent: scope,
		members: {},
		constants: new Set(),
		types,
		protocols: {},
	}
}

export function resolveFunctionDefinitionType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.FunctionType {
	let functionScope = scopeWithGenerics(node.generics, scope)

	return {
		type: "Function",
		generics: resolveGenericDeclarations(node.generics, scope),
		parameterTypes: resolveParameterTypes(node, functionScope),
		returnType: resolveType(node.returnType, functionScope),
		documentation: node.documentation ?? undefined,
	}
}

export function resolveNamespaceDefinitionStatementType(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
): common.NamespaceType {
	// NOTE: Namespace Generics are visible in the target Type and in every
	// Method signature — `namespace Boxes<infer Item> for List<Item>`.
	let genericScope = scopeWithGenerics(node.generics, scope)

	let resultType: common.NamespaceType = {
		type: "Namespace",
		targetType:
			node.targetType === null
				? null
				: resolveType(node.targetType, genericScope),
		name: node.name.content,
		generics: resolveGenericDeclarations(node.generics, scope),
		properties: {},
		methods: {},
		conformsTo: node.conformsTo.map((identifier) => identifier.content),
	}

	let properties: Record<string, common.Type> = {}
	let methods: Record<string, common.MethodType> = {}

	for (let [memberKey, memberValue] of Object.entries(node.properties)) {
		properties[memberKey] = resolveType(memberValue.value, scope)
	}

	for (let [methodName, methodValue] of Object.entries(node.methods)) {
		// NOTE: The Namespace is only injected as a member for
		// self-reference — injecting it as a type would shadow a
		// same-named Type Alias (`namespace Event for Event`).
		methods[methodName] = resolveMethodType(
			methodValue,
			{
				parent: genericScope,
				members: { [node.name.content]: resultType },
				constants: new Set([node.name.content]),
				types: {},
				protocols: {},
			},
			resultType.targetType,
			resultType.generics,
		)
	}

	resultType.properties = properties
	resultType.methods = methods

	return resultType
}

export function resolveProtocolDeclarationStatementType(
	node: parser.ProtocolDeclarationStatementNode,
	scope: enricher.Scope,
): common.ProtocolType {
	// NOTE: `Self` stands for the conforming Namespace's target Type — inside
	// the signatures it is an ordinary GenericUse, substituted wherever the
	// Protocol is used against a concrete Type.
	let selfType: common.GenericUse = { type: "GenericUse", name: "Self" }
	let signatureScope: enricher.Scope = {
		parent: scope,
		members: {},
		constants: new Set(),
		types: { Self: selfType },
		protocols: {},
	}

	let methods: Record<string, common.MethodType> = {}

	for (let [methodName, methodValue] of Object.entries(node.methods)) {
		methods[methodName] = resolveProtocolMethodType(
			methodValue,
			signatureScope,
			selfType,
		)
	}

	return {
		type: "Protocol",
		name: node.name.content,
		methods,
		documentation: node.documentation ?? undefined,
	}
}

function resolveProtocolSignature(
	signature: parser.ProtocolMethodSignatureNode,
	scope: enricher.Scope,
	selfType: common.GenericUse | null,
): common.BaseFunction {
	let parameterTypes = resolveParameterTypes(signature, scope)

	if (selfType !== null) {
		parameterTypes = [{ name: null, type: selfType }, ...parameterTypes]
	}

	return {
		generics: [],
		parameterTypes,
		returnType: resolveType(signature.returnType, scope),
		documentation: signature.documentation ?? undefined,
	}
}

function resolveProtocolMethodType(
	node: parser.ProtocolMethods[string],
	scope: enricher.Scope,
	selfType: common.GenericUse,
): common.MethodType {
	if (node.nodeType === "SimpleProtocolMethod") {
		return {
			type: "SimpleMethod",
			...resolveProtocolSignature(node.signature, scope, selfType),
		}
	} else if (node.nodeType === "StaticProtocolMethod") {
		return {
			type: "StaticMethod",
			...resolveProtocolSignature(node.signature, scope, null),
		}
	} else if (node.nodeType === "OverloadedProtocolMethod") {
		return {
			type: "OverloadedMethod",
			overloads: node.signatures.map((signature) =>
				resolveProtocolSignature(signature, scope, selfType),
			),
			documentation: node.documentation ?? undefined,
		}
	} else {
		return {
			type: "OverloadedStaticMethod",
			overloads: node.signatures.map((signature) =>
				resolveProtocolSignature(signature, scope, null),
			),
			documentation: node.documentation ?? undefined,
		}
	}
}

// NOTE: A compact, one-line description of a Type for Diagnostics — enough
// to tell the reader which Type failed a Protocol bound.
function describeTypeForDiagnostic(type: common.Type): string {
	switch (type.type) {
		case "UnionType":
			return type.types
				.map((memberType) => describeTypeForDiagnostic(memberType))
				.join(" | ")
		case "GenericUse":
			return type.name
		case "GenericAlias":
			return type.name
		case "List":
			return `List<${describeTypeForDiagnostic(type.itemType)}>`
		case "Namespace":
			return `Namespace '${type.name}'`
		default:
			return type.type
	}
}

// NOTE: Resolves how each Protocol-bounded Type Parameter of an invocation's
// signature is fulfilled, given what the invocation bound it to. A binding
// that is itself a bounded Type Parameter forwards the enclosing Function's
// conformance parameter; a concrete binding requires exactly one conforming
// Namespace in scope — the exact-target ones win over covering ones, and
// anything else is a Diagnostic. Failures report and yield no source; the
// Diagnostic gates codegen, so a missing source never reaches the Rewriter.
export function resolveConformances(
	generics: Array<common.GenericDeclaration>,
	bindings: GenericBindings,
	scope: enricher.Scope,
	position: common.Position,
): Array<common.Conformance> {
	if (!generics.some((generic) => generic.constraint != null)) {
		return []
	}

	let conformances: Array<common.Conformance> = []

	for (let generic of generics) {
		if (generic.constraint == null) {
			continue
		}

		let binding = bindings.get(generic.name)

		// NOTE: An unbound Type Parameter or an Error binding has already
		// been diagnosed — stay silent to avoid cascades.
		if (binding === undefined || binding.type === "Error") {
			continue
		}

		let protocol = findProtocolInScope(generic.constraint, scope)

		// NOTE: An unknown Protocol was already diagnosed at the declaration.
		if (protocol === null) {
			continue
		}

		if (binding.type === "GenericUse") {
			if (binding.constraint === generic.constraint) {
				conformances.push({
					genericName: generic.name,
					protocolName: generic.constraint,
					source: {
						kind: "parameter",
						name: `${binding.name}__conformance`,
					},
				})
			} else {
				reportError(
					`Type Parameter '${binding.name}' does not conform to Protocol '${generic.constraint}' — it carries no such bound.`,
					position,
				)
			}

			continue
		}

		let candidates: Array<{ name: string; type: common.NamespaceType }> = []

		for (let [name, namespace] of getAllNamespacesInScope(scope, null)) {
			if (
				namespace.conformsTo === undefined ||
				!namespace.conformsTo.includes(generic.constraint) ||
				namespace.targetType === null ||
				namespace.generics.length > 0
			) {
				continue
			}

			if (matchesType(namespace.targetType, binding)) {
				candidates.push({ name, type: namespace })
			}
		}

		let exactCandidates = candidates.filter((candidate) =>
			isDeepStrictEqual(candidate.type.targetType, binding),
		)

		if (exactCandidates.length > 0) {
			candidates = exactCandidates
		}

		if (candidates.length === 0) {
			reportError(
				`Type '${describeTypeForDiagnostic(binding)}' does not conform to Protocol '${generic.constraint}': no conforming Namespace is in scope.`,
				position,
			)

			continue
		}

		if (candidates.length > 1) {
			reportError(
				`Multiple Namespaces conform to Protocol '${generic.constraint}' for Type '${describeTypeForDiagnostic(binding)}', please disambiguate.

The matching Namespaces are:
${candidates.map((candidate) => `    - ${candidate.name}`).join("\n")}
`,
				position,
			)

			continue
		}

		let candidate = candidates[0]
		let result = computeConformanceMethodMap(
			protocol,
			candidate.type,
			binding,
		)

		if (result.kind !== "conforms") {
			// NOTE: Reachable when the Namespace covers the binding through a
			// wider target Type (a Union) but a `Self` position makes the
			// signatures incompatible for this narrower binding.
			reportError(
				`Namespace '${candidate.name}' does not conform to Protocol '${generic.constraint}' for Type '${describeTypeForDiagnostic(binding)}'.`,
				position,
			)

			continue
		}

		conformances.push({
			genericName: generic.name,
			protocolName: generic.constraint,
			source: {
				kind: "namespace",
				name: candidate.name,
				methodMap: result.methodMap,
			},
		})
	}

	return conformances
}

// NOTE: Called from the Enricher, never from speculative hoisting — a
// Namespace with a broken conformance clause is still a perfectly usable
// Namespace and must hoist; only the clause itself is diagnosed.
export function checkProtocolConformance(
	node: parser.NamespaceDefinitionStatementNode,
	namespaceType: common.NamespaceType,
	scope: enricher.Scope,
): void {
	for (let identifier of node.conformsTo) {
		let protocol = findProtocolInScope(identifier.content, scope)

		if (protocol === null) {
			reportError(
				`Protocol '${identifier.content}' is not declared.`,
				identifier.position,
			)

			continue
		}

		if (namespaceType.targetType === null) {
			reportError(
				"Only Namespaces with a target Type ('for …') can conform to a Protocol.",
				identifier.position,
			)

			continue
		}

		if (namespaceType.generics.length > 0) {
			reportError(
				"Generic Namespaces can not declare Protocol conformance (yet).",
				identifier.position,
			)

			continue
		}

		let result = computeConformanceMethodMap(
			protocol,
			namespaceType,
			namespaceType.targetType,
		)

		if (result.kind === "missing") {
			reportError(
				`Namespace '${namespaceType.name}' does not conform to Protocol '${protocol.name}': it is missing Method '${result.methodName}'.`,
				identifier.position,
			)
		} else if (result.kind === "mismatched") {
			reportError(
				`Namespace '${namespaceType.name}' does not conform to Protocol '${protocol.name}': Method '${result.methodName}' does not match the Protocol's signature.`,
				identifier.position,
			)
		}
	}
}

export function resolveTypeAliasStatementType(
	node: parser.TypeAliasStatementNode,
	scope: enricher.Scope,
): common.Type {
	// NOTE: Checked here as well as in declareTypeInScope — hoisting resolves
	// speculatively and would otherwise register the reserved name without
	// ever reaching the declaration check.
	if (node.name.content === "Self") {
		reportError("'Self' is a reserved Type name.", node.name.position)
	}

	if (node.generics.length === 0) {
		return resolveType(node.type, scope)
	}

	// NOTE: Generic Type Aliases keep their body unapplied — the Generics
	// stay GenericUses until a use site applies Type Arguments, which
	// substitutes them into the body.
	let genericScope = scopeWithGenerics(node.generics, scope)

	return {
		type: "GenericAlias",
		name: node.name.content,
		generics: resolveGenericDeclarations(node.generics, scope),
		aliasedType: resolveType(node.type, genericScope),
	}
}

// NOTE: Applies Type Arguments to a Generic Type Alias by substituting them
// into the alias body — missing Arguments fall back to the Generic's default
// Type, and to an Error Type (after a Diagnostic) without one.
function applyGenericAlias(
	aliasType: common.GenericAliasType,
	typeArguments: Array<common.Type>,
	position: common.Position,
): common.Type {
	let generics = aliasType.generics
	let requiredCount = generics.filter(
		(generic) => generic.defaultType === null,
	).length

	if (
		typeArguments.length > generics.length ||
		typeArguments.length < requiredCount
	) {
		reportError(
			`Wrong number of Type Arguments for Type '${aliasType.name}'.`,
			position,
		)
	}

	let bindings: GenericBindings = new Map()

	for (let i = 0; i < generics.length; i++) {
		let generic = generics[i]
		let argument =
			i < typeArguments.length
				? typeArguments[i]
				: (generic.defaultType ?? { type: "Error" as const })

		bindings.set(generic.name, argument)
	}

	return applyGenericBindings(aliasType.aliasedType, bindings)
}

export function resolveIdentifierTypeDeclarationType(
	node: parser.IdentifierTypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	let name = node.type.content
	let result = findTypeInScope(name, scope)

	if (result === null) {
		if (findProtocolInScope(name, scope) !== null) {
			reportError(
				`Protocol '${name}' can not be used as a Type. Protocols are only usable as Generic bounds ('<infer T is ${name}>') and Namespace conformance clauses ('is ${name}').`,
				node.position,
			)
		} else {
			reportError(`Type '${name}' is not declared.`, node.position)
		}

		return { type: "Error" }
	}

	// NOTE: A bare use of a Generic Type Alias applies the defaults — without
	// a full set of defaults it is missing Type Arguments.
	if (result.type === "GenericAlias") {
		return applyGenericAlias(result, [], node.position)
	}

	return result
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
				return [key, resolveType(value.type, scope)]
			}),
		),
	}
}

export function resolveGenericTypeDeclarationType(
	node: parser.GenericTypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	let baseType: common.Type

	// NOTE: The base Type is looked up raw — `resolveIdentifierTypeDeclarationType`
	// would already apply a Generic Alias' defaults before the Type Arguments
	// get a chance to.
	if (node.baseType.nodeType === "IdentifierTypeDeclaration") {
		let name = node.baseType.type.content
		let result = findTypeInScope(name, scope)

		if (result === null) {
			reportError(
				`Type '${name}' is not declared.`,
				node.baseType.position,
			)

			return { type: "Error" }
		}

		baseType = result
	} else {
		baseType = resolveType(node.baseType, scope)
	}

	if (baseType.type === "Error") {
		return baseType
	}

	// NOTE: Applied Lists are normalized into plain List Types right away, so
	// that inferred and declared List Types share a single representation.
	if (baseType.type === "GenericList") {
		if (node.generics.length !== 1) {
			reportError("List requires exactly 1 Type Argument.", node.position)

			return {
				type: "List",
				itemType:
					node.generics.length > 0
						? resolveType(node.generics[0], scope)
						: { type: "Error" },
			}
		}

		return {
			type: "List",
			itemType: resolveType(node.generics[0], scope),
		}
	}

	if (baseType.type === "GenericAlias") {
		return applyGenericAlias(
			baseType,
			node.generics.map((generic) => resolveType(generic, scope)),
			node.position,
		)
	}

	reportError("This Type is not generic.", node.position)

	return { type: "Error" }
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

export function findProtocolInScope(
	name: string,
	scope: enricher.Scope,
): common.ProtocolType | null {
	let searchScope: enricher.Scope | null = scope

	while (true) {
		if (searchScope === null) {
			return null
		}

		if (Object.hasOwn(searchScope.protocols, name)) {
			return searchScope.protocols[name]
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
	let matchingNamespaces: Map<string, common.NamespaceType> = new Map()

	// NOTE: Error Types match any targetType — instead of every Namespace,
	// they match none, so that a broken base expression does not produce
	// follow-up Diagnostics.
	if (baseType.type === "Error") {
		return matchingNamespaces
	}

	// NOTE: A receiver whose Type is a Protocol-bounded Type Parameter
	// resolves ONLY through its Protocol — a pseudo-Namespace named after the
	// hidden conformance parameter, with `Self` substituted by the Type
	// Parameter itself. The Simplifier emits the Namespace name as the call
	// base, so bodies compile to `Item__conformance.method(item, …)` without
	// any further machinery.
	if (baseType.type === "GenericUse" && baseType.constraint !== undefined) {
		let protocol = findProtocolInScope(baseType.constraint, scope)

		if (protocol !== null) {
			let conformanceName = `${baseType.name}__conformance`
			let selfBindings: GenericBindings = new Map([["Self", baseType]])
			let methods: Record<string, common.MethodType> = {}

			for (let [methodName, method] of Object.entries(protocol.methods)) {
				methods[methodName] = applyGenericBindings(
					method,
					selfBindings,
				) as common.MethodType
			}

			matchingNamespaces.set(conformanceName, {
				type: "Namespace",
				name: conformanceName,
				targetType: baseType,
				generics: [],
				properties: {},
				methods,
			})
		}

		return matchingNamespaces
	}

	let namespaces = getAllNamespacesInScope(scope, node.namespaceSpecifier)

	// NOTE: Generic Namespaces match their target Type by binding the
	// Namespace's Generics against the receiver — the bindings are only used
	// for the selection here, Method resolution re-binds them from the
	// receiver Argument.
	for (let [name, namespace] of namespaces) {
		if (namespace.targetType) {
			if (namespace.targetType.type === "UnionType") {
				for (let type of namespace.targetType.types) {
					if (
						matchesTypeWithBindings(
							type,
							baseType,
							createInferenceContext(namespace.generics),
						)
					) {
						matchingNamespaces.set(name, namespace)
						break
					}
				}
			} else if (
				matchesTypeWithBindings(
					namespace.targetType,
					baseType,
					createInferenceContext(namespace.generics),
				)
			) {
				matchingNamespaces.set(name, namespace)
			}
		}
	}

	return matchingNamespaces
}

// NOTE: The enclosing Namespace's Generics are merged into every Method
// signature, so that each signature is self-contained for inference — the
// receiver Argument re-binds them on every invocation.
// NOTE: The Parameter Types of a signature, carrying whatever documents each
// Parameter. A Parameter is described either by a `§§` block of its own or by
// an `@param` in the Declaration's — the tag is looked up under both names,
// since a call site writes the external one and the body reads the internal
// one.
function resolveParameterTypes(
	definition: {
		parameters: Array<parser.ParameterNode>
		documentation: common.Documentation | null
	},
	scope: enricher.Scope,
): Array<common.Parameter> {
	return definition.parameters.map((parameter) => ({
		name: parameter.externalName?.content ?? null,
		type: resolveType(parameter.type, scope),
		documentation: parameterDocumentation(
			parameter,
			definition.documentation,
		),
	}))
}

function parameterDocumentation(
	parameter: parser.ParameterNode,
	documentation: common.Documentation | null,
): string | undefined {
	if (parameter.documentation !== null) {
		return parameter.documentation.description
	}

	for (let name of [parameter.externalName, parameter.internalName]) {
		let tagged = documentation?.parameters[name?.content ?? ""]

		if (tagged !== undefined) {
			return tagged
		}
	}

	return undefined
}

export function resolveMethodType(
	node:
		| parser.SimpleMethod
		| parser.StaticMethod
		| parser.OverloadedMethod
		| parser.OverloadedStaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
	namespaceGenerics: Array<common.GenericDeclaration> = [],
): common.MethodType {
	if (node.nodeType === "SimpleMethod") {
		if (selfType === null) {
			reportError(
				"Using Non-Static Methods in Untyped Namespaces is not supported.",
				node.method.position,
			)

			selfType = { type: "Error" }
		}

		let methodScope = scopeWithGenerics(node.method.value.generics, scope)

		return {
			type: "SimpleMethod",
			generics: [
				...namespaceGenerics,
				...resolveGenericDeclarations(
					node.method.value.generics,
					scope,
				),
			],
			parameterTypes: [
				{ name: null, type: selfType },
				...resolveParameterTypes(node.method.value, methodScope),
			],
			returnType: resolveType(node.method.value.returnType, methodScope),
			documentation: node.method.value.documentation ?? undefined,
		}
	} else if (node.nodeType === "StaticMethod") {
		let methodScope = scopeWithGenerics(node.method.value.generics, scope)

		return {
			type: "StaticMethod",
			generics: [
				...namespaceGenerics,
				...resolveGenericDeclarations(
					node.method.value.generics,
					scope,
				),
			],
			parameterTypes: resolveParameterTypes(
				node.method.value,
				methodScope,
			),
			returnType: resolveType(node.method.value.returnType, methodScope),
			documentation: node.method.value.documentation ?? undefined,
		}
	} else if (node.nodeType === "OverloadedMethod") {
		if (selfType === null) {
			reportError(
				"Using Non-Static Methods in Untyped Namespaces is not supported.",
				node.methods[0]?.position ?? null,
			)

			selfType = { type: "Error" }
		}

		const methodSelfType = selfType

		return {
			type: "OverloadedMethod",
			overloads: node.methods.map((method) => {
				let methodScope = scopeWithGenerics(
					method.value.generics,
					scope,
				)

				return {
					generics: [
						...namespaceGenerics,
						...resolveGenericDeclarations(
							method.value.generics,
							scope,
						),
					],
					parameterTypes: [
						{ name: null, type: methodSelfType },
						...resolveParameterTypes(method.value, methodScope),
					],
					returnType: resolveType(
						method.value.returnType,
						methodScope,
					),
					documentation: method.value.documentation ?? undefined,
				}
			}),
			documentation: node.documentation ?? undefined,
		}
	} else {
		return {
			type: "OverloadedStaticMethod",
			overloads: node.methods.map((method) => {
				let methodScope = scopeWithGenerics(
					method.value.generics,
					scope,
				)

				return {
					generics: [
						...namespaceGenerics,
						...resolveGenericDeclarations(
							method.value.generics,
							scope,
						),
					],
					parameterTypes: resolveParameterTypes(
						method.value,
						methodScope,
					),
					returnType: resolveType(
						method.value.returnType,
						methodScope,
					),
					documentation: method.value.documentation ?? undefined,
				}
			}),
			documentation: node.documentation ?? undefined,
		}
	}
}
