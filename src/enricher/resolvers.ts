import { isDeepStrictEqual } from "node:util"

import { primary, reportError, secondary } from "../diagnostics/index"
import {
	applyGenericBindings,
	buildUnion,
	computeConformanceMethodMap,
	closestMatch,
	countOf,
	createInferenceContext,
	describeType,
	type GenericBindings,
	matchesType,
	matchesTypeWithBindings,
	withArticle,
} from "../helpers/index"
import type { common, enricher, parser } from "../interfaces/index"
import { childScope } from "./scope"

// NOTE: Type-declaration and signature resolution. Expressions are no longer
// typed here — enrichment is the only Expression walker, and a Node's Type is
// read off its enriched children. What remains resolves the Types written in
// annotations, plus a fully annotated Function signature.
export function resolveType(
	node: parser.TypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	switch (node.nodeType) {
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
			type: resolveDeclaredType(parameter.type, scope),
		})),
		returnType: resolveType(node.returnType, scope),
	}
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
		case "Rational":
			return "Rationals"
		case "Algebraic":
			return "Algebraics"
		case "Transcendental":
			return "Transcendentals"
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

// NOTE: The result Type of a Combination, computed from its operands' already
// enriched Types. It only needs the operand Positions, to point the Diagnostics
// at.
export function combinationTypeOf(
	lhsType: common.Type,
	rhsType: common.Type,
	lhsPosition: common.Position,
	rhsPosition: common.Position,
): common.Type {
	function isSubType(
		lhs: common.RecordType,
		rhs: common.RecordType,
	): boolean {
		for (let [rhsName, rhsMemberType] of Object.entries(rhs.members)) {
			if (!isDeepStrictEqual(lhs.members[rhsName], rhsMemberType)) {
				return false
			}
		}

		return true
	}

	if (lhsType.type === "Error" || rhsType.type === "Error") {
		return { type: "Error" }
	}

	if (lhsType.type !== "Record") {
		reportError(
			`${describeTypesForCombination(lhsType)} can not be combined`,
			lhsPosition,
			{
				code: "uncombinable-types",
				labels: [
					primary(
						lhsPosition,
						`this is ${withArticle(describeType(lhsType))}`,
					),
				],
				notes: ["Only Records and Namespaces can be combined."],
			},
		)

		return { type: "Error" }
	}

	if (rhsType.type !== "Record") {
		reportError(
			`${describeTypesForCombination(rhsType)} can not be combined`,
			rhsPosition,
			{
				code: "uncombinable-types",
				labels: [
					primary(
						rhsPosition,
						`this is ${withArticle(describeType(rhsType))}`,
					),
				],
				notes: ["Only Records and Namespaces can be combined."],
			},
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
				"This is not a Partial of the value it updates",
				rhsPosition,
				{
					code: "partial-type-mismatch",
					labels: [
						primary(
							rhsPosition,
							`this is ${withArticle(describeType(rhsType))}`,
						),
						secondary(
							lhsPosition,
							`this is ${withArticle(describeType(lhsType))}`,
						),
					],
					notes: [
						"An update may only set members the original already has, with the Types it declared for them.",
					],
				},
			)

			return lhsType
		}
	}
}

// NOTE: Each Case becomes a nominal Record Type, and the Choice's name is
// declared as the *named* Union of them — every existing Union mechanism
// (exhaustiveness, dispatch, `|` composition) applies to a Choice unchanged.
export function resolveChoiceDeclarationStatementType(
	node: parser.ChoiceDeclarationStatementNode,
	scope: enricher.Scope,
): common.UnionType {
	if (node.cases.length === 0) {
		reportError("A Choice must declare at least one Case", node.position, {
			code: "empty-choice",
			labels: [primary(node.position, "this Choice declares none")],
		})
	}

	let caseTypes: Array<common.CaseType> = []

	for (let choiceCase of node.cases) {
		if (
			caseTypes.some(
				(existing) => existing.name === choiceCase.name.content,
			)
		) {
			reportError(
				`Case '#${choiceCase.name.content}' is declared more than once`,
				choiceCase.name.position,
				{
					code: "duplicate-case",
					labels: [
						primary(
							choiceCase.name.position,
							"declared a second time here",
						),
					],
				},
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

// NOTE: The Type of a Record Literal, computed from its members' already
// enriched Types. A valid Record annotation wins; anything else reports and
// falls back to the members' structural Type. `annotationPosition` is only read
// when there is an annotation to point the Diagnostic at.
export function recordValueTypeOf(
	resolvedAnnotation: common.Type | null,
	memberTypes: Record<string, common.Type>,
	annotationPosition: common.Position | null,
): common.RecordType {
	if (resolvedAnnotation !== null) {
		if (resolvedAnnotation.type === "Record") {
			return resolvedAnnotation
		}

		if (
			resolvedAnnotation.type !== "Error" &&
			annotationPosition !== null
		) {
			reportError(
				"A Record Literal must be annotated with a Record Type",
				annotationPosition,
				{
					code: "record-annotation-not-record",
					labels: [
						primary(
							annotationPosition,
							"this is not a Record Type",
						),
					],
				},
			)
		}
	}

	// NOTE: Missing or invalid Type Annotations fall back to the
	// structural Type of the Record Literal itself.
	return {
		type: "Record",
		members: memberTypes,
	}
}

// NOTE: The item Type of a List Literal from its elements' already enriched
// Types. An empty List has an Unknown item Type; otherwise the item Type is the
// Union of the distinct element Types, in first-seen order.
export function listItemTypeOf(valueTypes: Array<common.Type>): common.Type {
	if (valueTypes.length === 0) {
		return { type: "Unknown" }
	}

	let itemTypes = [valueTypes[0]]

	for (let valueType of valueTypes.slice(1)) {
		if (
			!itemTypes.some((existing) =>
				isDeepStrictEqual(existing, valueType),
			)
		) {
			itemTypes.push(valueType)
		}
	}

	return buildUnion(itemTypes)
}

// NOTE: The result Type of a Lookup, computed from its base's already enriched
// Type. The member and base Positions are all it needs to point the Diagnostics.
export function lookupTypeOf(
	baseType: common.Type,
	memberName: string,
	positions: { member: common.Position; base: common.Position },
): common.Type {
	if (baseType.type === "Error") {
		return baseType
	}

	if (baseType.type === "Namespace") {
		if (Object.hasOwn(baseType.properties, memberName)) {
			return baseType.properties[memberName]
		} else if (Object.hasOwn(baseType.methods, memberName)) {
			return baseType.methods[memberName]
		} else {
			reportUnknownMember(
				memberName,
				positions.member,
				`Namespace '${baseType.name}'`,
				[
					...Object.keys(baseType.properties),
					...Object.keys(baseType.methods),
				],
			)

			return { type: "Error" }
		}
	} else if (baseType.type === "Record") {
		if (Object.hasOwn(baseType.members, memberName)) {
			return baseType.members[memberName]
		} else {
			reportUnknownMember(
				memberName,
				positions.member,
				describeType(baseType),
				Object.keys(baseType.members),
			)

			return { type: "Error" }
		}
	} else if (baseType.type === "Case") {
		// NOTE: A Case *is* a Record with a nominal identity — its payload
		// members are read exactly like a Record's.
		if (Object.hasOwn(baseType.members, memberName)) {
			return baseType.members[memberName]
		} else {
			reportUnknownMember(
				memberName,
				positions.member,
				`Case '${baseType.choice}#${baseType.name}'`,
				Object.keys(baseType.members),
			)

			return { type: "Error" }
		}
	} else {
		reportError("This value has no members to look up", positions.base, {
			code: "type-without-members",
			labels: [
				primary(
					positions.base,
					`this is ${withArticle(describeType(baseType))}`,
				),
			],
			notes: ["Only Records, Cases and Namespaces have members."],
		})

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
				`Protocol '${name}' can not be used as a value`,
				node.position,
				{
					code: "protocol-as-value",
					labels: [primary(node.position, "this names a Protocol")],
					notes: [
						`A Protocol is only usable as a Generic bound ('<infer T is ${name}>') or in a conformance clause ('is ${name}').`,
					],
				},
			)
		} else {
			reportError(`'${name}' is not declared`, node.position, {
				code: "unknown-name",
				labels: [
					primary(node.position, "no such Variable or Constant"),
				],
				helps: suggestionHelps(name, scope, "members"),
			})
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
		reportError("There is no '@' here to refer to", node.position, {
			code: "at-outside-method",
			labels: [
				primary(node.position, "this is outside any Method or Handler"),
			],
			notes: [
				"'@' is the receiver of a Method or the value a Match Handler matched.",
			],
		})

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
			reportReservedTypeName(generic.name.position)
		}

		if (generic.defaultType) {
			defaultType = resolveType(generic.defaultType, scope)
		}

		if (
			generic.constraint !== null &&
			findProtocolInScope(generic.constraint.content, scope) === null
		) {
			reportError(
				`Protocol '${generic.constraint.content}' is not declared`,
				generic.constraint.position,
				{
					code: "unknown-protocol",
					labels: [
						primary(
							generic.constraint.position,
							"no such Protocol",
						),
					],
					helps: suggestionHelps(
						generic.constraint.content,
						scope,
						"protocols",
					),
				},
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
// and Return Types can reference them. They stay opaque within the
// declaration; binding them to concrete Types happens at each use site,
// where Generic Inference substitutes the Arguments' Types.
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

	return childScope(scope, { types })
}

// NOTE: Only a Function literal in Argument position can omit an annotation,
// and it is resolved through the contextual path below. Every Declaration
// still parses its annotations, so a null reaching a Declaration would mean
// the Parser produced something it has no rule for.
export function resolveDeclaredType(
	node: parser.TypeDeclarationNode | null,
	scope: enricher.Scope,
): common.Type {
	if (node === null) {
		return { type: "Error" }
	}

	return resolveType(node, scope)
}

// NOTE: A fully annotated Function signature — every Parameter and the return
// Type are written, so there is no body to walk. A literal that omitted an
// annotation is resolved contextually on the enrichment side instead, which is
// the only place a body can be enriched to infer what it leaves out.
export function resolveFunctionSignatureType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.FunctionType {
	let functionScope = scopeWithGenerics(node.generics, scope)

	return {
		type: "Function",
		generics: resolveGenericDeclarations(node.generics, scope),
		parameterTypes: resolveParameterTypes(node, functionScope),
		returnType: resolveDeclaredType(node.returnType, functionScope),
		documentation: node.documentation ?? undefined,
	}
}

export function resolveProtocolDeclarationStatementType(
	node: parser.ProtocolDeclarationStatementNode,
	scope: enricher.Scope,
): common.ProtocolType {
	// NOTE: `Self` stands for the conforming Namespace's target Type — inside
	// the signatures it is an ordinary GenericUse, substituted wherever the
	// Protocol is used against a concrete Type.
	let selfType: common.GenericUse = { type: "GenericUse", name: "Self" }
	let signatureScope = childScope(scope, { types: { Self: selfType } })

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

// NOTE: Resolves how each Protocol-bounded Type Parameter of an invocation's
// signature is fulfilled, given what the invocation bound it to. A binding
// that is itself a bounded Type Parameter forwards the enclosing Function's
// conformance parameter; a concrete binding requires exactly one conforming
// Namespace in scope — the exact-target ones win over covering ones, and
// anything else is a Diagnostic. Failures report and yield no source; the
// Diagnostic gates codegen, so a missing source never reaches the Rewriter.
// NOTE: A generic Namespace specialized against the bindings that unified its
// target Type with a receiver — its target Type and every Method signature are
// rewritten through those bindings so it reads as a concrete Namespace from the
// selection point on. Fresh objects throughout: the builtin table singletons
// must never be mutated.
function specializeNamespace(
	namespace: common.NamespaceType,
	bindings: GenericBindings,
): common.NamespaceType {
	let methods: Record<string, common.MethodType> = {}

	for (let [name, method] of Object.entries(namespace.methods)) {
		methods[name] = applyGenericBindings(
			method,
			bindings,
		) as common.MethodType
	}

	return {
		...namespace,
		targetType:
			namespace.targetType === null
				? null
				: applyGenericBindings(namespace.targetType, bindings),
		methods,
		generics: [],
	}
}

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
					`Type Parameter '${binding.name}' does not conform to '${generic.constraint}'`,
					position,
					{
						code: "unsatisfied-bound",
						labels: [
							primary(
								position,
								"bound here to an unbounded Type Parameter",
							),
						],
						notes: [
							`'${binding.name}' carries no '${generic.constraint}' bound of its own, so it can not satisfy one.`,
						],
						helps: [
							`Declare it as '<infer ${binding.name} is ${generic.constraint}>'.`,
						],
					},
				)
			}

			continue
		}

		let candidates: Array<{
			name: string
			type: common.NamespaceType
			isGeneric: boolean
		}> = []

		for (let [name, namespace] of getAllNamespacesInScope(scope, null)) {
			if (
				namespace.conformsTo === undefined ||
				!namespace.conformsTo.includes(generic.constraint) ||
				namespace.targetType === null
			) {
				continue
			}

			if (namespace.generics.length === 0) {
				if (matchesType(namespace.targetType, binding)) {
					candidates.push({ name, type: namespace, isGeneric: false })
				}

				continue
			}

			// NOTE: A generic Namespace (`List<Item>`) conforms to the binding
			// when its target Type unifies with it — `List<Item>` binds `Item`
			// to `Integer` against a `List<Integer>` receiver. The Namespace is
			// then specialized against those bindings, so its target Type and
			// Method signatures read concretely from here on. The builtin table
			// singleton is never mutated — `specializeNamespace` builds fresh
			// objects.
			let context = createInferenceContext(namespace.generics)

			if (
				matchesTypeWithBindings(namespace.targetType, binding, context)
			) {
				candidates.push({
					name,
					type: specializeNamespace(namespace, context.bindings),
					isGeneric: true,
				})
			}
		}

		// NOTE: A concrete Namespace always beats a generic one's blanket
		// conformance — a hand-written `for List<Integer> is Equatable` wins
		// over `List<Item> is Equatable`. This runs before the assignability
		// filter below: a specialized generic target (`List<Integer>`) is
		// structurally identical to a concrete one, so without this they would
		// tie and spuriously read as ambiguous.
		if (candidates.some((candidate) => !candidate.isGeneric)) {
			candidates = candidates.filter((candidate) => !candidate.isGeneric)
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
				`${describeType(binding)} does not conform to '${generic.constraint}'`,
				position,
				{
					code: "unsatisfied-bound",
					labels: [
						primary(
							position,
							`this binds a Type Parameter bound to '${generic.constraint}'`,
						),
					],
					notes: [
						`No Namespace in scope makes ${describeType(binding)} conform to '${generic.constraint}'.`,
					],
					helps: [
						`Declare a Namespace 'for ${describeType(binding)} is ${generic.constraint}'.`,
					],
				},
			)

			continue
		}

		if (candidates.length > 1) {
			reportError(
				`More than one Namespace makes ${describeType(binding)} conform to '${generic.constraint}'`,
				position,
				{
					code: "ambiguous-conformance",
					labels: [
						primary(
							position,
							"the conformance can not be chosen here",
						),
					],
					notes: candidates.map(
						(candidate) =>
							`'${candidate.name}' conforms to '${generic.constraint}'.`,
					),
				},
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
			// NOTE: `needs-condition` is reachable when a generic Namespace's
			// blanket conformance is fulfilled by a Method carrying its own
			// Protocol bound — the conformance holds only under a `where` clause
			// supplying it, which this commit has no syntax for yet. The other
			// failures are reachable when the Namespace covers the binding
			// through a wider target Type (a Union) but a `Self` position makes
			// the signatures incompatible for this narrower binding.
			let label =
				result.kind === "needs-condition"
					? `Method '${result.methodName}' needs '${result.genericName} is ${result.protocolName}'`
					: `this needs ${describeType(binding)} to conform`

			reportError(
				`Namespace '${candidate.name}' does not conform to '${generic.constraint}'`,
				position,
				{
					code: "nonconforming-namespace",
					labels: [primary(position, label)],
				},
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
				`Protocol '${identifier.content}' is not declared`,
				identifier.position,
				{
					code: "unknown-protocol",
					labels: [primary(identifier.position, "no such Protocol")],
					helps: suggestionHelps(
						identifier.content,
						scope,
						"protocols",
					),
				},
			)

			continue
		}

		if (namespaceType.targetType === null) {
			reportError(
				"Only a Namespace with a target Type can conform to a Protocol",
				identifier.position,
				{
					code: "conformance-needs-target-type",
					labels: [
						primary(
							identifier.position,
							"this Namespace has no 'for …'",
						),
					],
					notes: [
						"A conformance says what a Type can do, so there has to be a Type.",
					],
				},
			)

			continue
		}

		let result = computeConformanceMethodMap(
			protocol,
			namespaceType,
			namespaceType.targetType,
		)

		if (result.kind === "needs-condition") {
			reportError(
				`Namespace '${namespaceType.name}' does not conform to '${protocol.name}'`,
				identifier.position,
				{
					code: "nonconforming-namespace",
					labels: [
						primary(
							identifier.position,
							`Method '${result.methodName}' needs '${result.genericName} is ${result.protocolName}'`,
						),
					],
				},
			)
		} else if (result.kind === "missing") {
			reportError(
				`Namespace '${namespaceType.name}' does not conform to '${protocol.name}'`,
				identifier.position,
				{
					code: "nonconforming-namespace",
					labels: [
						primary(
							identifier.position,
							`Method '${result.methodName}' is missing`,
						),
					],
				},
			)
		} else if (result.kind === "mismatched") {
			reportError(
				`Namespace '${namespaceType.name}' does not conform to '${protocol.name}'`,
				identifier.position,
				{
					code: "nonconforming-namespace",
					labels: [
						primary(
							identifier.position,
							`Method '${result.methodName}' does not match the Protocol's signature`,
						),
					],
				},
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
		reportReservedTypeName(node.name.position)
	}

	if (node.generics.length === 0) {
		let resolvedType = resolveType(node.type, scope)

		// NOTE: An anonymous Union takes the Alias's name, so Hovers and
		// Diagnostics print `Coordinate` rather than spelling the members out.
		// A copy, not a mutation — the resolved Type may be a shared Scope
		// object. An already named or aliased Union (a Choice, `Number`,
		// `Optional<Integer>`, another Alias) keeps its original spelling.
		if (
			resolvedType.type === "UnionType" &&
			resolvedType.name === undefined &&
			resolvedType.alias === undefined
		) {
			return { ...resolvedType, name: node.name.content }
		}

		return resolvedType
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
			`Type '${aliasType.name}' was given the wrong number of Type Arguments`,
			position,
			{
				code: "wrong-type-argument-count",
				labels: [
					primary(
						position,
						`${countOf(typeArguments.length, "Type Argument")} given`,
					),
				],
				notes: [
					`'${aliasType.name}' takes ${countOf(aliasType.generics.length, "Type Parameter")}.`,
				],
			},
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

	let appliedType = applyGenericBindings(aliasType.aliasedType, bindings)

	// NOTE: An applied alias whose body is an anonymous Union carries the
	// applied spelling as its display alias, so `Optional<Integer>` prints as
	// written rather than as `Integer | Nothing`. The Type Arguments are kept
	// as Types — a later substitution rewrites them alongside the members, so
	// the spelling never goes stale. Display-only, like every Union name. A
	// body that is already named or aliased keeps its own spelling, the way
	// `type Sure = Number` keeps printing `Number`.
	if (
		appliedType.type === "UnionType" &&
		appliedType.name === undefined &&
		appliedType.alias === undefined
	) {
		return {
			...appliedType,
			alias: {
				name: aliasType.name,
				typeArguments: generics.map(
					(generic) =>
						bindings.get(generic.name) ?? { type: "Error" },
				),
			},
		}
	}

	return appliedType
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
				`Protocol '${name}' can not be used as a Type`,
				node.position,
				{
					code: "protocol-as-type",
					labels: [primary(node.position, "this names a Protocol")],
					notes: [
						`A Protocol is only usable as a Generic bound ('<infer T is ${name}>') or in a conformance clause ('is ${name}').`,
					],
				},
			)
		} else {
			reportError(`Type '${name}' is not declared`, node.position, {
				code: "unknown-type",
				labels: [primary(node.position, "no such Type")],
				helps: suggestionHelps(name, scope, "types"),
			})
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

// NOTE: Built canonical — `Integer | Rational | Nothing` becomes
// `(Integer | Rational) | Nothing`, still printing exactly as written. See
// `buildUnion`.
export function resolveUnionTypeDeclarationType(
	node: parser.UnionTypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	let resolvedTypes = []

	for (let type of node.types) {
		resolvedTypes.push(resolveType(type, scope))
	}

	return buildUnion(resolvedTypes)
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
				`Type '${name}' is not declared`,
				node.baseType.position,
				{
					code: "unknown-type",
					labels: [primary(node.baseType.position, "no such Type")],
					helps: suggestionHelps(name, scope, "types"),
				},
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
			reportError("List takes exactly 1 Type Argument", node.position, {
				code: "wrong-type-argument-count",
				labels: [
					primary(
						node.position,
						`${countOf(node.generics.length, "Type Argument")} given`,
					),
				],
			})

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

	reportError("This Type takes no Type Arguments", node.position, {
		code: "type-not-generic",
		labels: [
			primary(node.position, "the Type Arguments have nowhere to go"),
		],
	})

	return { type: "Error" }
}

/***********/
/* Helpers */
/***********/

// NOTE: `Self` is what a Protocol calls its conforming Type; the two other
// places that reject the name report it identically, so they share this.
export function reportReservedTypeName(position: common.Position | null): void {
	let notes = [
		"'Self' is what a Protocol calls the Type conforming to it, so no declaration may take it.",
	]

	if (position === null) {
		reportError("'Self' is a reserved Type name", null, {
			code: "reserved-type-name",
			labels: [],
			notes,
		})

		return
	}

	reportError("'Self' is a reserved Type name", position, {
		code: "reserved-type-name",
		labels: [primary(position, "this name is taken")],
		notes,
	})
}

// NOTE: The members the base actually has are listed rather than left for the
// reader to go and look up — a Lookup fails most often because the member is
// spelled differently, not because it is absent.
function reportUnknownMember(
	memberName: string,
	memberPosition: common.Position,
	baseDescription: string,
	memberNames: Array<string>,
): void {
	let suggestion = closestMatch(memberName, memberNames)

	reportError(
		`${baseDescription} has no member '${memberName}'`,
		memberPosition,
		{
			code: "unknown-member",
			labels: [primary(memberPosition, "no such member")],
			notes:
				memberNames.length === 0
					? [`${baseDescription} has no members.`]
					: [
							`${baseDescription} has ${memberNames
								.map((memberName) => `'${memberName}'`)
								.join(", ")}.`,
						],
			helps: suggestion === null ? [] : [`Did you mean '${suggestion}'?`],
		},
	)
}

// NOTE: Every name of one kind that is visible from `scope`, innermost first
// — what a "did you mean" is drawn from, so that a suggestion is always a
// name the reader could actually have written here.
function namesInScope(
	scope: enricher.Scope,
	kind: "members" | "types" | "protocols",
): Array<string> {
	let names: Array<string> = []
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		names.push(...Object.keys(searchScope[kind]))
		searchScope = searchScope.parent
	}

	return names
}

// NOTE: A near miss is a Help rather than part of the message — it is a
// suggestion, and a message that states one as fact reads as though the
// Compiler knows something it does not.
export function suggestionHelps(
	name: string,
	scope: enricher.Scope,
	kind: "members" | "types" | "protocols",
): Array<string> {
	let suggestion = closestMatch(name, namesInScope(scope, kind))

	return suggestion === null || suggestion === name
		? []
		: [`Did you mean '${suggestion}'?`]
}

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

	// NOTE: An unbounded Type Parameter has no Methods — it resolves only
	// through a Protocol bound, handled above. Without this cut, a Namespace
	// whose target Union carries a bindable Generic member (`Optional`) would
	// bind the bare Parameter and offer its Methods on every `T`.
	if (baseType.type === "GenericUse") {
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
		type: resolveDeclaredType(parameter.type, scope),
		documentation: parameterDocumentation(
			parameter,
			definition.documentation,
		),
	}))
}

export function parameterDocumentation(
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
				"A Namespace without a target Type can only hold static Methods",
				node.method.position,
				{
					code: "untyped-namespace-method",
					labels: [
						primary(
							node.method.position,
							"this Method is not static",
						),
					],
					helps: [
						"Give the Namespace a target Type with 'for …', or make the Method static.",
					],
				},
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
			returnType: resolveDeclaredType(
				node.method.value.returnType,
				methodScope,
			),
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
			returnType: resolveDeclaredType(
				node.method.value.returnType,
				methodScope,
			),
			documentation: node.method.value.documentation ?? undefined,
		}
	} else if (node.nodeType === "OverloadedMethod") {
		if (selfType === null) {
			let message =
				"A Namespace without a target Type can only hold static Methods"
			let helps = [
				"Give the Namespace a target Type with 'for …', or make the Methods static.",
			]
			let firstMethod = node.methods[0]

			if (firstMethod === undefined) {
				reportError(message, null, {
					code: "untyped-namespace-method",
					labels: [],
					helps,
				})
			} else {
				reportError(message, firstMethod.position, {
					code: "untyped-namespace-method",
					labels: [
						primary(
							firstMethod.position,
							"these overloads are not static",
						),
					],
					helps,
				})
			}

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
					returnType: resolveDeclaredType(
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
					returnType: resolveDeclaredType(
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
