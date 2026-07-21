import { isDeepStrictEqual } from "node:util"

import { reportError } from "../diagnostics/index"
import {
	applyGenericBindings,
	computeConformanceMethodMap,
	createInferenceContext,
	flattenUnionMembers,
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
		case "CaseValue":
			return resolveCaseValueType(node, scope)
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
	receiverType: common.Type | null = null,
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

	let matchableArguments: Array<MatchableArgument> = node.arguments.map(
		(argument) => ({
			name: argument.name?.content ?? null,
			getType: () => resolveType(argument.value, scope),
		}),
	)

	if (
		methodType.type === "SimpleMethod" ||
		methodType.type === "OverloadedMethod"
	) {
		// NOTE: Union dispatch resolves the Method once per member Type — the
		// override stands in for the receiver so each member is matched as if
		// the receiver had that Type.
		matchableArguments.unshift({
			name: null,
			getType: () => receiverType ?? resolveType(node.base, scope),
		})
	}

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
// only run when there are no Error Diagnostics. Dispatched Invocations reuse
// the placeholder Namespace: their targets live in `dispatch` instead.
function placeholderNamespace(): { name: string; type: common.NamespaceType } {
	return {
		name: "",
		type: {
			type: "Namespace",
			targetType: null,
			name: "",
			generics: [],
			properties: {},
			methods: {},
		},
	}
}

type ResolvedMethodInvocation = {
	namespace: { name: string; type: common.NamespaceType }
	type: common.Type
	overloadedMethodIndex: number | null
	conformances: Array<common.Conformance>
	dispatch: Array<common.DispatchCase> | null
}

function resolveFailedMethodInvocation(): ResolvedMethodInvocation {
	return {
		namespace: placeholderNamespace(),
		type: { type: "Error" },
		overloadedMethodIndex: null,
		conformances: [],
		dispatch: null,
	}
}

export function resolveMethodInvocation(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): ResolvedMethodInvocation {
	let baseType = resolveType(node.base, scope)
	let namespaces = resolveMethodLookupNamespacesForReceiverType(
		baseType,
		node.namespaceSpecifier,
		scope,
	)

	// NOTE: A Union-typed receiver falls back to per-member dispatch whenever
	// no Namespace covering the whole Union can resolve the Method — a
	// covering Namespace that can (`Ordering`) keeps taking precedence.
	if (namespaces.size === 0) {
		if (baseType.type === "UnionType") {
			return resolveUnionMethodDispatch(node, baseType, scope)
		}

		if (baseType.type !== "Error") {
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
		if (baseType.type === "UnionType") {
			return resolveUnionMethodDispatch(node, baseType, scope)
		}

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

	if (resolvedMethods.length > 1) {
		resolvedMethods = filterMostSpecificByTarget(
			resolvedMethods,
			(candidate) => candidate.namespace.type.targetType,
		)
	}

	if (resolvedMethods.length === 0) {
		// NOTE: The covering Namespace has the Method but its overloads
		// reject the Arguments — per-member dispatch may still accept them,
		// since each member is matched with its own receiver Type.
		if (baseType.type === "UnionType") {
			return resolveUnionMethodDispatch(node, baseType, scope)
		}

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
			dispatch: null,
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

// NOTE: Per-member dispatch for a Union-typed receiver — the Method is
// resolved statically for every member Type, and the Invocation is only
// valid when every member resolves unambiguously. Its Type is the Union of
// the branch return Types. The receiver's actual Type picks the branch at
// runtime, so more specific member Types are ordered first — an open Record
// member would otherwise swallow values of any member assignable to it.
function resolveUnionMethodDispatch(
	node: parser.MethodInvocationNode,
	unionType: common.UnionType,
	scope: enricher.Scope,
): ResolvedMethodInvocation {
	let members = flattenUnionMembers(unionType)
	let dispatchCases: Array<common.DispatchCase> = []
	let caseReturnTypes: Array<common.Type> = []

	for (let [memberIndex, memberType] of members.entries()) {
		let namespaces = resolveMethodLookupNamespacesForReceiverType(
			memberType,
			node.namespaceSpecifier,
			scope,
		)

		let matchingNamespaces = new Map<string, common.NamespaceType>()
		for (let [name, namespace] of namespaces) {
			if (Object.hasOwn(namespace.methods, node.member.content)) {
				matchingNamespaces.set(name, namespace)
			}
		}

		if (matchingNamespaces.size === 0) {
			reportError(
				`Could not find a method named '${node.member.content}' for Type '${describeTypeForDiagnostic(memberType)}', a member of this value's Union Type.`,
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
				memberType,
			)

			if (resolvedMethod) {
				resolvedMethods.push({
					namespaceName,
					namespaceType,
					...resolvedMethod,
				})
			}
		}

		if (resolvedMethods.length > 1) {
			resolvedMethods = filterMostSpecificByTarget(
				resolvedMethods,
				(candidate) => candidate.namespaceType.targetType,
			)
		}

		if (resolvedMethods.length === 0) {
			reportError(
				`Passed arguments do not match any overload for Type '${describeTypeForDiagnostic(memberType)}', a member of this value's Union Type.`,
				node.position,
			)

			return resolveFailedMethodInvocation()
		}

		if (resolvedMethods.length > 1) {
			reportError(
				`Passed arguments matched more than 1 Namespace for Type '${describeTypeForDiagnostic(memberType)}', a member of this value's Union Type, please disambiguate.

The matching Namespaces are:
${resolvedMethods
	.map((method) => {
		return `    - ${method.namespaceName}`
	})
	.join("\n")}
`,
				node.position,
			)

			return resolveFailedMethodInvocation()
		}

		let resolvedMethod = resolvedMethods[0]

		// NOTE: Unbound Type Parameters depend on the Arguments, which every
		// branch shares — reporting them for the first member only keeps the
		// Diagnostic from repeating per member.
		if (memberIndex === 0) {
			reportUnboundGenerics(resolvedMethod.unboundGenerics, node.position)
		}

		dispatchCases.push({
			memberType,
			namespaceName: resolvedMethod.namespaceName,
			overloadedMethodIndex: resolvedMethod.overloadedMethodIndex,
			conformances: resolveConformances(
				resolvedMethod.signatureGenerics,
				resolvedMethod.bindings,
				scope,
				node.position,
			),
		})
		caseReturnTypes.push(resolvedMethod.returnType)
	}

	let catchAllCases = dispatchCases.filter((dispatchCase) =>
		isRuntimeCatchAllType(dispatchCase.memberType),
	)

	if (catchAllCases.length > 1) {
		reportError(
			`This method can not be dispatched — ${catchAllCases.length} member Types of this value's Union Type are indistinguishable at runtime.`,
			node.position,
		)

		return resolveFailedMethodInvocation()
	}

	let sortedCases = [...dispatchCases].sort((a, b) => {
		let aCatchAll = isRuntimeCatchAllType(a.memberType)
		let bCatchAll = isRuntimeCatchAllType(b.memberType)

		if (aCatchAll !== bCatchAll) {
			return aCatchAll ? 1 : -1
		}

		let aIsMoreSpecific =
			matchesType(b.memberType, a.memberType) &&
			!matchesType(a.memberType, b.memberType)
		let bIsMoreSpecific =
			matchesType(a.memberType, b.memberType) &&
			!matchesType(b.memberType, a.memberType)

		if (aIsMoreSpecific) {
			return -1
		} else if (bIsMoreSpecific) {
			return 1
		} else {
			return 0
		}
	})

	let returnTypes: Array<common.Type> = []

	for (let returnType of caseReturnTypes) {
		let flattened =
			returnType.type === "UnionType"
				? flattenUnionMembers(returnType)
				: [returnType]

		for (let member of flattened) {
			if (
				!returnTypes.some(
					(existing) =>
						matchesType(existing, member) &&
						matchesType(member, existing),
				)
			) {
				returnTypes.push(member)
			}
		}
	}

	return {
		namespace: placeholderNamespace(),
		type:
			returnTypes.length === 1
				? returnTypes[0]
				: { type: "UnionType", types: returnTypes },
		overloadedMethodIndex: null,
		conformances: [],
		dispatch: sortedCases,
	}
}

// NOTE: `isValueOfType` answers true for every value on these — such a
// member can only ever be the last dispatch branch, and two of them can not
// coexist in one dispatched Union.
function isRuntimeCatchAllType(type: common.Type): boolean {
	return type.type === "GenericUse" || type.type === "Unknown"
}

// NOTE: The same specificity rule conformance resolution uses, applied to
// Method resolution: when several Namespaces resolve a Method, one whose
// target Type is strictly more specific by assignability wins (`Integer`
// beats `Integer | Fraction` for an Integer receiver). This is what lets a
// Namespace covering a Union carry the Union-level behaviour without making
// every member-typed invocation ambiguous. Remaining ties stay a hard error.
function filterMostSpecificByTarget<Candidate>(
	candidates: Array<Candidate>,
	targetOf: (candidate: Candidate) => common.Type | null,
): Array<Candidate> {
	function isStrictlyMoreSpecific(
		target: common.Type | null,
		other: common.Type | null,
	): boolean {
		if (target === null || other === null) {
			return false
		}

		return matchesType(other, target) && !matchesType(target, other)
	}

	return candidates.filter(
		(candidate) =>
			!candidates.some(
				(other) =>
					other !== candidate &&
					isStrictlyMoreSpecific(
						targetOf(other),
						targetOf(candidate),
					),
			),
	)
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
		case "Case":
			return "Cases"
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

// NOTE: Resolves `ChoiceName#CaseName` to the Case's Type. The Choice's name
// resolves through the ordinary Type scope, so a Type Alias of a Choice works
// too (`type Op = CalculatorOperation` admits `Op#Add`).
export function resolveCaseReference(
	choice: parser.IdentifierNode,
	caseName: parser.IdentifierNode,
	scope: enricher.Scope,
): common.CaseType | common.ErrorType {
	let choiceType = findTypeInScope(choice.content, scope)

	if (choiceType === null) {
		reportError(
			`Type '${choice.content}' is not declared.`,
			choice.position,
		)

		return { type: "Error" }
	}

	if (choiceType.type === "Error") {
		return { type: "Error" }
	}

	let members =
		choiceType.type === "UnionType"
			? flattenUnionMembers(choiceType)
			: [choiceType]

	let caseType = members.find(
		(member): member is common.CaseType =>
			member.type === "Case" && member.name === caseName.content,
	)

	if (caseType === undefined) {
		reportError(
			`Type '${choice.content}' has no Case '#${caseName.content}'.`,
			caseName.position,
		)

		return { type: "Error" }
	}

	return caseType
}

// NOTE: The bare form (`#Add({ … })`) resolves the way Method lookup
// resolves its Namespace — every Choice in Type scope is scanned for the
// Case, and only actual ambiguity asks for the prefix. Shadowed Type names
// are skipped, mirroring `getAllNamespacesInScope`.
function findCaseTypesInScope(
	name: string,
	scope: enricher.Scope,
): Array<common.CaseType> {
	let seenTypeNames = new Set<string>()
	let cases = new Map<string, common.CaseType>()
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		for (let [typeName, type] of Object.entries(searchScope.types)) {
			if (seenTypeNames.has(typeName)) {
				continue
			}

			seenTypeNames.add(typeName)

			let members =
				type.type === "UnionType" ? flattenUnionMembers(type) : [type]

			for (let member of members) {
				if (member.type === "Case" && member.name === name) {
					cases.set(`${member.choice}#${member.name}`, member)
				}
			}
		}

		searchScope = searchScope.parent
	}

	return [...cases.values()]
}

export function resolveBareCaseReference(
	caseName: parser.IdentifierNode,
	scope: enricher.Scope,
): common.CaseType | common.ErrorType {
	let candidates = findCaseTypesInScope(caseName.content, scope)

	if (candidates.length === 1) {
		return candidates[0]
	}

	if (candidates.length === 0) {
		reportError(
			`No Choice in scope declares a Case '#${caseName.content}'.`,
			caseName.position,
		)
	} else {
		reportError(
			`Case '#${caseName.content}' is ambiguous — it is declared by the Choices ${candidates
				.map((candidate) => `'${candidate.choice}'`)
				.join(", ")}. Prefix it with its Choice's name.`,
			caseName.position,
		)
	}

	return { type: "Error" }
}

// NOTE: Contextual resolution for the bare form — the expected Type of the
// position (a Declaration's annotation, an Assignment's target, the declared
// return Type at a `<-`) is consulted before the scope scan, exactly like a
// Matcher consults the scrutinee. `null` means the context does not pin the
// Case down, and the scan decides.
function resolveCaseInExpectedType(
	caseName: parser.IdentifierNode,
	expectedType: common.Type,
): common.CaseType | common.ErrorType | null {
	let members =
		expectedType.type === "UnionType"
			? flattenUnionMembers(expectedType)
			: [expectedType]

	let candidates = members.filter(
		(member): member is common.CaseType =>
			member.type === "Case" && member.name === caseName.content,
	)

	if (candidates.length === 0) {
		return null
	}

	if (candidates.length > 1) {
		reportError(
			`Case '#${caseName.content}' is ambiguous — ${candidates.length} Choices in the expected Type declare it. Prefix it with its Choice's name.`,
			caseName.position,
		)

		return { type: "Error" }
	}

	return candidates[0]
}

export function resolveCaseValueType(
	node: parser.CaseValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.CaseType | common.ErrorType {
	if (node.choice === null) {
		if (expectedType !== null) {
			let contextual = resolveCaseInExpectedType(
				node.caseName,
				expectedType,
			)

			if (contextual !== null) {
				return contextual
			}
		}

		return resolveBareCaseReference(node.caseName, scope)
	}

	return resolveCaseReference(node.choice, node.caseName, scope)
}

// NOTE: A bare Case Matcher (`case #Add`) resolves against the matched
// value's own Union — the Case's name never has to be in scope by itself.
// Ambiguity (two Choices in one Union sharing a Case name) asks for the
// prefixed form instead of guessing.
export function resolveCaseMatcherType(
	node: parser.CaseMatcherNode,
	valueType: common.Type,
	scope: enricher.Scope,
): common.Type {
	if (node.choice !== null) {
		return resolveCaseReference(node.choice, node.caseName, scope)
	}

	if (valueType.type === "Error") {
		return { type: "Error" }
	}

	let members =
		valueType.type === "UnionType"
			? flattenUnionMembers(valueType)
			: [valueType]

	let candidates = members.filter(
		(member): member is common.CaseType =>
			member.type === "Case" && member.name === node.caseName.content,
	)

	if (candidates.length === 1) {
		return candidates[0]
	}

	if (candidates.length === 0) {
		reportError(
			`The matched value's Type has no Case '#${node.caseName.content}'.`,
			node.position,
		)
	} else {
		reportError(
			`Case '#${node.caseName.content}' is ambiguous — ${candidates.length} Choices in the matched Union declare it. Prefix it with its Choice's name.`,
			node.position,
		)
	}

	return { type: "Error" }
}

// NOTE: Each Case becomes a nominal Record Type, and the Choice's name is
// declared as the *named* Union of them — every existing Union mechanism
// (exhaustiveness, dispatch, `|` composition) applies to a Choice unchanged.
export function resolveChoiceDeclarationStatementType(
	node: parser.ChoiceDeclarationStatementNode,
	scope: enricher.Scope,
): common.UnionType {
	if (node.cases.length === 0) {
		reportError("A Choice must declare at least one Case.", node.position)
	}

	let caseTypes: Array<common.CaseType> = []

	for (let choiceCase of node.cases) {
		if (
			caseTypes.some(
				(existing) => existing.name === choiceCase.name.content,
			)
		) {
			reportError(
				`Case '#${choiceCase.name.content}' is declared more than once.`,
				choiceCase.name.position,
			)

			continue
		}

		caseTypes.push({
			type: "Case",
			choice: node.name.content,
			name: choiceCase.name.content,
			members:
				choiceCase.type === null
					? {}
					: resolveRecordTypeDeclarationType(choiceCase.type, scope)
							.members,
		})
	}

	return { type: "UnionType", name: node.name.content, types: caseTypes }
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
	} else if (baseType.type === "Case") {
		// NOTE: A Case *is* a Record with a nominal identity — its payload
		// members are read exactly like a Record's.
		if (Object.hasOwn(baseType.members, node.member.content)) {
			return baseType.members[node.member.content]
		} else {
			reportError(
				`Case '${baseType.choice}#${baseType.name}' has no member '${node.member.content}'.`,
				node.member.position,
			)

			return { type: "Error" }
		}
	} else {
		reportError(
			"Only Records, Cases and Namespaces have members.",
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
			if (type.name !== undefined) {
				return type.name
			}

			return type.types
				.map((memberType) => describeTypeForDiagnostic(memberType))
				.join(" | ")
		case "Case":
			return `${type.choice}#${type.name}`
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

		// NOTE: Specificity by assignability — a candidate whose target Type
		// is assignable to another candidate's (but not the other way around)
		// is the more specific one and wins. This is what lets a Namespace for
		// a concrete Record shape beat the builtin Record Namespace's blanket
		// conformance, and an exact target beat a covering Union.
		let isStrictlyMoreSpecific = (
			a: common.Type,
			b: common.Type,
		): boolean => matchesType(b, a) && !matchesType(a, b)

		let mostSpecificCandidates = candidates.filter(
			(candidate) =>
				!candidates.some(
					(other) =>
						other !== candidate &&
						other.type.targetType !== null &&
						candidate.type.targetType !== null &&
						isStrictlyMoreSpecific(
							other.type.targetType,
							candidate.type.targetType,
						),
				),
		)

		if (mostSpecificCandidates.length > 0) {
			candidates = mostSpecificCandidates
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
	return resolveMethodLookupNamespacesForReceiverType(
		resolveType(node.base, scope),
		node.namespaceSpecifier,
		scope,
	)
}

export function resolveMethodLookupNamespacesForReceiverType(
	baseType: common.Type,
	namespaceSpecifier: parser.MethodInvocationNode["namespaceSpecifier"],
	scope: enricher.Scope,
): Map<string, common.NamespaceType> {
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

	let namespaces = getAllNamespacesInScope(scope, namespaceSpecifier)

	// NOTE: Generic Namespaces match their target Type by binding the
	// Namespace's Generics against the receiver — the bindings are only used
	// for the selection here, Method resolution re-binds them from the
	// receiver Argument.
	for (let [name, namespace] of namespaces) {
		if (namespace.targetType) {
			if (namespace.targetType.type === "UnionType") {
				// NOTE: A Union-typed receiver (`Ordering`, `Number`) matches
				// the Union target as a whole — the per-member loop below only
				// covers receivers of a single member Type.
				if (
					matchesTypeWithBindings(
						namespace.targetType,
						baseType,
						createInferenceContext(namespace.generics),
					)
				) {
					matchingNamespaces.set(name, namespace)
					continue
				}

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
