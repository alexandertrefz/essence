import { isDeepStrictEqual } from "node:util"

import type { common, enricher, parser } from "@essence/interfaces"

import {
	primary,
	reportError,
	reportWarning,
	secondary,
} from "../diagnostics/index"
import {
	applyGenericBindings,
	buildUnion,
	computeConformanceMethodMap,
	closestMatch,
	conformanceKey,
	conformanceParameterName,
	countOf,
	createInferenceContext,
	describeType,
	flattenUnionMembers,
	type GenericBindings,
	matchesType,
	matchesTypeWithBindings,
	typeContainsError,
	typeMentionsGeneric,
	withArticle,
} from "../helpers/index"
import { recordAnnotation } from "./annotations"
import { childScope } from "./scope"

// NOTE: Type-declaration and signature resolution. Expressions are no longer
// typed here — enrichment is the only Expression walker, and a Node's Type is
// read off its enriched children. What remains resolves the Types written in
// annotations, plus a fully annotated Function signature.
//
// NOTE: THE choke point where a written annotation meets the Type it resolves
// to, which is why the annotation index is recorded here and nowhere else. The
// switch below recurses back through this function for a Generic's Arguments, a
// Union's members, a Record's member Types and a Function Type's Parameters and
// return — so recording once covers every nested sub-annotation for free, and
// the cursor on `Item` inside `List<Item>` is answered by `Item`. Deliberately
// NOT also recorded in `resolveDeclaredType`, which is a null guard that
// forwards here; recording there would file every annotation twice.
export function resolveType(
	node: parser.TypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	let type = resolveTypeDeclaration(node, scope)

	recordAnnotation(node, type)

	return type
}

function resolveTypeDeclaration(
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
			// NOTE: `Object.hasOwn` before the read — a member named after one
			// of `Object.prototype`'s would otherwise be compared against a
			// JavaScript function the Record does not have.
			if (
				!Object.hasOwn(lhs.members, rhsName) ||
				!isDeepStrictEqual(lhs.members[rhsName], rhsMemberType)
			) {
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

// NOTE: Every Type name a Type declaration Node mentions, as the Identifier
// Nodes that spell them so a Diagnostic can point at one, in written order —
// walking Records, Lists / applications, Unions and Functions. The scan is
// SYNTACTIC and runs before any of the Nodes is resolved, which is what the
// recursion checks need: a Declaration that names itself can not be resolved
// first and inspected afterwards.
export function referencedTypeNames(
	node: parser.TypeDeclarationNode,
): Array<parser.IdentifierNode> {
	switch (node.nodeType) {
		case "IdentifierTypeDeclaration":
			return [node.type]
		case "GenericTypeDeclaration":
			return [
				...referencedTypeNames(node.baseType),
				...node.generics.flatMap((argument) =>
					referencedTypeNames(argument),
				),
			]
		case "UnionTypeDeclaration":
			return node.types.flatMap((member) => referencedTypeNames(member))
		case "RecordTypeDeclaration":
			return Object.values(node.members).flatMap((member) =>
				referencedTypeNames(member.type),
			)
		case "FunctionTypeDeclaration":
			return [
				...node.parameterTypes.flatMap((parameter) =>
					referencedTypeNames(parameter.type),
				),
				...referencedTypeNames(node.returnType),
			]
	}
}

// NOTE: The first mention of `choiceName` in a payload's Type declaration, for
// the recursion restriction below, or null when the payload does not name the
// Choice. Name-based on purpose: during speculative hoisting the Choice's own
// name is not yet in scope, so a resolved-Type check could not see it.
function typeDeclarationNamesChoice(
	node: parser.TypeDeclarationNode,
	choiceName: string,
): parser.IdentifierNode | null {
	return (
		referencedTypeNames(node).find(
			(reference) => reference.content === choiceName,
		) ?? null
	)
}

// NOTE: A generic Choice's Case payload, resolved with the Choice's Type
// Parameters in scope so a member may mention them (`Done { value: Result }`).
// The recursion restriction (decision e) is applied member by member and
// syntactically: a member that names the Choice being declared would, when
// substituted eagerly at a use site, never finish substituting, so it is
// diagnosed and resolved to Error rather than to a real Type. This owns the
// DIRECT self-naming of a generic Choice and nothing else — every other
// recursive shape is caught before the hoist rounds by the cycle pre-pass in
// `enricher/index.ts`, which reports `recursive-type-declaration` and leaves
// this one shape alone.
function resolveGenericCaseMembers(
	payload: parser.RecordTypeDeclarationNode | null,
	choiceName: string,
	genericScope: enricher.Scope,
): Record<string, common.Type> {
	if (payload === null) {
		return {}
	}

	let members: Record<string, common.Type> = {}

	for (let [name, member] of Object.entries(payload.members)) {
		let selfReference = typeDeclarationNamesChoice(member.type, choiceName)

		if (selfReference !== null) {
			reportError(
				"A generic Choice can not name itself in a payload",
				selfReference.position,
				{
					code: "recursive-generic-choice",
					labels: [
						primary(
							selfReference.position,
							"this names the Choice being declared",
						),
					],
					notes: [
						"A generic Choice's payloads are substituted eagerly at each use, so a self-reference would never finish substituting.",
					],
					helps: [
						"Introduce a separate non-generic Choice or Type for the recursive part.",
					],
				},
			)

			members[name] = { type: "Error" }
		} else {
			members[name] = resolveType(member.type, genericScope)
		}
	}

	return members
}

// NOTE: Each Case becomes a nominal Record Type, and a plain Choice is declared
// as the *named* Union of them — every existing Union mechanism
// (exhaustiveness, dispatch, `|` composition) applies to a Choice unchanged. A
// *generic* Choice instead becomes a Generic Alias over the ANONYMOUS Union of
// its Cases (mirroring `resolveTypeAliasStatementType`): the body stays
// anonymous so an application heals `alias: { name, typeArguments }` onto it and
// `printType` renders `Step<Integer, String>` for free, the Generics stay
// GenericUses in the Cases' members until a use site binds them, and every Case
// records the Choice's Generics so an application can substitute and stamp the
// applied spelling.
export function resolveChoiceDeclarationStatementType(
	node: parser.ChoiceDeclarationStatementNode,
	scope: enricher.Scope,
): common.UnionType | common.GenericAliasType {
	if (node.cases.length === 0) {
		reportError("A Choice must declare at least one Case", node.position, {
			code: "empty-choice",
			labels: [primary(node.position, "this Choice declares none")],
		})
	}

	let isGeneric = node.generics.length > 0
	let genericScope = isGeneric
		? scopeWithGenerics(node.generics, scope)
		: scope
	let generics = isGeneric
		? resolveGenericDeclarations(node.generics, scope)
		: []

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

		if (isGeneric) {
			caseTypes.push({
				type: "Case",
				choice: node.name.content,
				name: choiceCase.name.content,
				members: resolveGenericCaseMembers(
					choiceCase.type,
					node.name.content,
					genericScope,
				),
				choiceGenerics: generics,
			})
		} else {
			caseTypes.push({
				type: "Case",
				choice: node.name.content,
				name: choiceCase.name.content,
				members:
					choiceCase.type === null
						? {}
						: resolveRecordTypeDeclarationType(
								choiceCase.type,
								scope,
							).members,
			})
		}
	}

	if (isGeneric) {
		return {
			type: "GenericAlias",
			name: node.name.content,
			generics,
			aliasedType: { type: "UnionType", types: caseTypes },
		}
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
				...suggestionData(suggestionInScope(name, scope, "members")),
			})
		}

		return { type: "Error" }
	} else {
		return result
	}
}

// NOTE: What `@` refers to at this point in the Program, walking outwards: the
// nearest binding wins, and a static Method's body stops the walk. The barrier
// is the whole point — a static Method is declared inside a `namespace … for
// Type` whose instance Methods bind `@` all around it, and letting one of those
// answer would type-check a body the Rewriter emits without a receiver.
function findSelfBinding(
	scope: enricher.Scope,
): { type: common.Type } | "static" | null {
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		if (Object.hasOwn(searchScope.members, "@")) {
			return { type: searchScope.members["@"] }
		}

		if (searchScope.isStaticMethodBody) {
			return "static"
		}

		searchScope = searchScope.parent
	}

	return null
}

export function resolveSelfType(
	node: parser.SelfNode,
	scope: enricher.Scope,
): common.Type {
	let binding = findSelfBinding(scope)

	if (binding === "static") {
		reportError("There is no '@' in a static Method", node.position, {
			code: "at-in-static-method",
			labels: [
				primary(
					node.position,
					"this Method is called on the Namespace",
				),
			],
			notes: [
				"'@' is the receiver of an instance Method, and a static Method is called without one.",
			],
			helps: [
				"Take the value as a Parameter, or drop 'static' to make this an instance Method.",
			],
		})

		return { type: "Error" }
	}

	let result = binding === null ? null : binding.type

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
					...suggestionData(
						suggestionInScope(
							generic.constraint.content,
							scope,
							"protocols",
						),
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

// NOTE: One free-Function signature — a bodied Function literal or a body-less
// native signature, read through the same `methodSignatureEntry` a Namespace
// Method uses so the two forms never fork. Free Functions inject no receiver
// and carry no Namespace Generics, so this is `resolveFunctionSignatureType`
// over a signature entry rather than a whole Definition.
function resolveFreeFunctionEntry(
	entry: parser.FunctionValueNode | parser.NativeMethodSignatureNode,
	scope: enricher.Scope,
): common.BaseFunction {
	let signature = methodSignatureEntry(entry)
	let functionScope = scopeWithGenerics(signature.generics, scope)

	return {
		generics: resolveGenericDeclarations(signature.generics, scope),
		parameterTypes: resolveParameterTypes(signature, functionScope),
		returnType: resolveDeclaredType(signature.returnType, functionScope),
		documentation: signature.documentation ?? undefined,
	}
}

// NOTE: A body-less native free Function resolves to the same `Function` Type a
// bodied one would — the missing block is a binding-by-name to the runtime, not
// a difference in the signature the Enricher reads. `__print` is exactly this.
export function resolveNativeFunctionStatementType(
	node: parser.NativeFunctionStatementNode,
	scope: enricher.Scope,
): common.FunctionType {
	return {
		type: "Function",
		...resolveFreeFunctionEntry(node.signature, scope),
	}
}

// NOTE: An overloaded free Function resolves to an `OverloadedStaticMethod` — a
// free Function is static by nature (no receiver), and `resolveFunctionInvocation`
// already resolves that callee Type by matching Arguments against each overload.
// The overloads keep their written order, which is the `__overload$N` index.
export function resolveOverloadedFunctionStatementType(
	node: parser.OverloadedFunctionStatementNode,
	scope: enricher.Scope,
): common.OverloadedStaticMethodType {
	reportUnknownDocumentationParameters(
		node.documentation,
		node.methods.map((entry) => methodSignatureEntry(entry).parameters),
	)

	return {
		type: "OverloadedStaticMethod",
		overloads: node.methods.map((entry) =>
			resolveFreeFunctionEntry(entry, scope),
		),
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
		reportUnknownDocumentationParameters(
			node.documentation,
			node.signatures.map((signature) => signature.parameters),
		)

		return {
			type: "OverloadedMethod",
			overloads: node.signatures.map((signature) =>
				resolveProtocolSignature(signature, scope, selfType),
			),
			documentation: node.documentation ?? undefined,
		}
	} else {
		reportUnknownDocumentationParameters(
			node.documentation,
			node.signatures.map((signature) => signature.parameters),
		)

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

// NOTE: The outcome of solving one (binding, Protocol) conformance. A success
// carries the witness source (recursively including its own `where`
// conditions); a failure carries the because-chain, outermost first, or an
// empty chain when the failure was already reported (ambiguity, a
// nonconforming Namespace) and must stay silent.
export type ConformanceSolveResult =
	| { ok: true; source: common.ConformanceSource }
	| { ok: false; chain: Array<string> }

type ScopeConformanceState = {
	memo: Map<string, ConformanceSolveResult>
	inProgress: Set<string>
	// NOTE: The Scope versions the memo was filled under — the same snapshot
	// `getAllNamespacesInScope` validates its own answer against.
	versions: Array<{ scope: enricher.Scope; version: number }>
}

// NOTE: Memoised per exact Scope, not per root Scope (R3): `where` conditions
// are solved against whatever Namespaces are visible, and
// `getAllNamespacesInScope` walks the parent chain — a function-local
// Namespace is visible only in its own subtree, so two Scopes can legitimately
// solve the same (Type, Protocol) differently. The Scope is constant down one
// recursion tree, so the `inProgress` set still guards cycles within it.
let conformanceStates = new WeakMap<enricher.Scope, ScopeConformanceState>()

// NOTE: One Scope's visible Namespaces change over the course of enrichment as
// its own Statements declare them — a Namespace written half way down a
// Function body is not visible to the Statements above it and IS to the ones
// below. The memo is therefore version-guarded exactly like the Namespace
// enumeration cache: a declaration that adds or shadows a Namespace anywhere on
// the chain bumps a version, and the memo is dropped rather than answering a
// later solve with what an earlier one could see. Without this, a first
// invocation's witness is reused after a second Namespace joins the ambiguity.
function conformanceStateFor(scope: enricher.Scope): ScopeConformanceState {
	let state = conformanceStates.get(scope)

	if (state === undefined) {
		state = {
			memo: new Map(),
			inProgress: new Set(),
			versions: scopeVersionSnapshot(scope),
		}

		conformanceStates.set(scope, state)
	} else if (!namespaceCacheIsCurrent(state, scope)) {
		state.memo.clear()
		state.versions = scopeVersionSnapshot(scope)
	}

	return state
}

// NOTE: The Namespace name the derived equality answers to. It contains a `_`,
// which the Lexer reads as a Symbol rather than an Identifier character, so no
// Essence source can spell this name and it can never collide with a written
// Namespace. The Rewriter recognises it and emits the runtime helpers instead
// of a member read — there is no object anywhere with this name.
export const derivedEquatableNamespaceName = "Choice_Equatable"

// NOTE: The name of the Choice a receiver belongs to, or null when it belongs
// to none — a single Case names its own Choice, and a Union names one only when
// every member is a Case of it.
function choiceNameOf(baseType: common.Type): string | null {
	if (baseType.type === "Case") {
		return baseType.choice
	}

	if (baseType.type === "UnionType") {
		let members = flattenUnionMembers(baseType)
		let first = members[0]

		if (first === undefined || first.type !== "Case") {
			return null
		}

		if (
			!members.every(
				(member) =>
					member.type === "Case" && member.choice === first.choice,
			)
		) {
			return null
		}

		return first.choice
	}

	return null
}

// NOTE: The Type Arguments a receiver of a generic Choice was instantiated with
// — declaration order — read off the receiver itself (a single Case carries
// them, a Union reads its first member's). Empty for a receiver that somehow
// carries none, which reconstructs the Choice with its defaults.
function choiceTypeArgumentsOf(baseType: common.Type): Array<common.Type> {
	if (baseType.type === "Case") {
		return baseType.typeArguments ?? []
	}

	if (baseType.type === "UnionType") {
		let first = flattenUnionMembers(baseType)[0]

		if (first !== undefined && first.type === "Case") {
			return first.typeArguments ?? []
		}
	}

	return []
}

// NOTE: The whole applied Union of a generic Choice, rebuilt from its Generic
// Alias and one receiver's Type Arguments — mirrors `applyGenericAlias`'s
// substitution and display-alias stamping, but never reports (the Arguments
// came from a receiver the Enricher already accepted).
function instantiateChoiceAlias(
	alias: common.GenericAliasType,
	typeArguments: Array<common.Type>,
): common.Type {
	let bindings: GenericBindings = new Map()

	for (let index = 0; index < alias.generics.length; index++) {
		let generic = alias.generics[index]

		bindings.set(
			generic.name,
			typeArguments[index] ??
				generic.defaultType ??
				({ type: "Error" } as const),
		)
	}

	let applied = applyGenericBindings(alias.aliasedType, bindings)

	if (
		applied.type === "UnionType" &&
		applied.name === undefined &&
		applied.alias === undefined
	) {
		return {
			...applied,
			alias: {
				name: alias.name,
				typeArguments: alias.generics.map(
					(generic) =>
						bindings.get(generic.name) ?? { type: "Error" },
				),
			},
		}
	}

	return applied
}

// NOTE: The declared Generic Alias a generic Choice's name resolves to, once it
// is confirmed to name that Choice's own Cases — null for a name that no longer
// resolves to the Choice (shadowed), or for a non-generic Choice.
function declaredChoiceAliasOf(
	baseType: common.Type,
	scope: enricher.Scope,
): common.GenericAliasType | null {
	let choiceName = choiceNameOf(baseType)

	if (choiceName === null) {
		return null
	}

	let declared = findTypeInScope(choiceName, scope)

	if (declared === null || declared.type !== "GenericAlias") {
		return null
	}

	let body = declared.aliasedType

	if (body.type !== "UnionType") {
		return null
	}

	let bodyMembers = flattenUnionMembers(body)

	if (
		bodyMembers.length === 0 ||
		!bodyMembers.every(
			(member) => member.type === "Case" && member.choice === choiceName,
		)
	) {
		return null
	}

	return declared
}

// NOTE: The Choice a receiver belongs to, or null when it belongs to none. A
// single Case (a receiver narrowed by a Handler) answers with its whole Choice,
// so `is` reads the same inside a `case #Red` as outside it. A *generic*
// Choice's name resolves to a Generic Alias rather than a Union, so the answer
// is the receiver's own APPLIED Union — rebuilt from the Alias so a receiver
// narrowed to one instantiated Case still compares against the whole applied
// Choice.
function choiceTypeOf(
	baseType: common.Type,
	scope: enricher.Scope,
): common.Type | null {
	let choiceName = choiceNameOf(baseType)

	if (choiceName === null) {
		return null
	}

	// NOTE: The DECLARED Choice, not the receiver — a receiver narrowed to one
	// Case still compares against the whole Choice, so `case #Red { @::is(c) }`
	// takes any Colour rather than only another `#Red`. A Choice whose name no
	// longer resolves to it has been shadowed; deriving off the wrong Type
	// would be worse than not deriving, so it answers null.
	let declared = findTypeInScope(choiceName, scope)

	if (declared === null) {
		return null
	}

	// NOTE: A generic Choice resolves to a Generic Alias over the anonymous
	// Union of its Cases — the receiver names its Type Arguments, so the answer
	// is that Alias applied to them.
	if (declared.type === "GenericAlias") {
		let alias = declaredChoiceAliasOf(baseType, scope)

		if (alias === null) {
			return null
		}

		return instantiateChoiceAlias(alias, choiceTypeArgumentsOf(baseType))
	}

	if (declared.type !== "UnionType") {
		return null
	}

	let declaredMembers = flattenUnionMembers(declared)

	if (
		declaredMembers.length === 0 ||
		!declaredMembers.every(
			(member) => member.type === "Case" && member.choice === choiceName,
		)
	) {
		return null
	}

	return declared
}

// NOTE: Whether a Type mentions any of the named Type Parameters — a bare
// GenericUse of one, or one buried in a List item, Record member, Case payload
// or Union arm. Decides whether a payload member compares structurally or
// routes through a witness.
function typeMentionsGenerics(
	type: common.Type,
	generics: Set<string>,
): boolean {
	switch (type.type) {
		case "GenericUse":
			return generics.has(type.name)
		case "List":
			return typeMentionsGenerics(type.itemType, generics)
		case "Record":
		case "Case":
			return Object.values(type.members).some((member) =>
				typeMentionsGenerics(member, generics),
			)
		case "UnionType":
			return type.types.some((member) =>
				typeMentionsGenerics(member, generics),
			)
		default:
			return false
	}
}

// NOTE: The Cases of a Choice's Generic Alias — its body is the anonymous
// Union of them, so a non-Union body (never produced for a real Choice) simply
// has none.
function choiceAliasCases(alias: common.GenericAliasType): Array<common.Type> {
	return alias.aliasedType.type === "UnionType"
		? flattenUnionMembers(alias.aliasedType)
		: []
}

// NOTE: The Type Parameters some Case payload of the Choice actually mentions,
// as a set — a Parameter no payload names needs neither a bound nor a witness.
function mentionedGenerics(alias: common.GenericAliasType): Set<string> {
	let genericNames = new Set(alias.generics.map((generic) => generic.name))
	let mentioned = new Set<string>()

	for (let caseType of choiceAliasCases(alias)) {
		if (caseType.type !== "Case") {
			continue
		}

		for (let member of Object.values(caseType.members)) {
			for (let name of genericNames) {
				if (typeMentionsGenerics(member, new Set([name]))) {
					mentioned.add(name)
				}
			}
		}
	}

	return mentioned
}

// NOTE: The Parameters some payload mentions, in Choice declaration order — the
// order the fabricated Methods take their bounds in and the order
// `resolveConformances` hands the witnesses over, so a descriptor's `w` index
// selects the right one.
function constrainedGenericOrder(
	alias: common.GenericAliasType,
): Array<string> {
	let mentioned = mentionedGenerics(alias)

	return alias.generics
		.map((generic) => generic.name)
		.filter((name) => mentioned.has(name))
}

// NOTE: The runtime `typeKeySymbol` tag a concrete Type's values carry, or null
// for a Type with no single tag (a bare Union). Lets a `union` descriptor node
// discriminate a Union payload's concrete arms at runtime.
function runtimeTagOf(type: common.Type): string | null {
	switch (type.type) {
		case "Nothing":
			return "Nothing"
		case "Boolean":
			return "Boolean"
		case "String":
			return "String"
		case "Integer":
			return "Integer"
		case "Rational":
			return "Rational"
		case "Algebraic":
			return "Algebraic"
		case "Transcendental":
			return "Transcendental"
		case "Record":
			return "Record"
		case "List":
		case "GenericList":
			return "List"
		case "Case":
			return `${type.choice}#${type.name}`
		default:
			return null
	}
}

// NOTE: How one payload member is compared — structurally when it names no Type
// Parameter, through the witness at its declaration-order index when it is a
// bare Parameter, and recursively for the composites (a List itemwise, a Record
// or Case member by member, a Union by claiming each arm's values and falling
// back to the generic one). `bindings` are the receiver's Type Arguments, which
// the Union case needs to see which arms have to be told apart from a
// Parameter's values, and by what.
function describeMember(
	type: common.Type,
	constrainedOrder: Array<string>,
	generics: Set<string>,
	bindings: GenericBindings,
	position: common.Position | null,
): common.DescriptorNode {
	if (!typeMentionsGenerics(type, generics)) {
		return { k: "eq" }
	}

	switch (type.type) {
		case "GenericUse":
			return { k: "w", i: constrainedOrder.indexOf(type.name) }
		case "List":
			return {
				k: "list",
				of: describeMember(
					type.itemType,
					constrainedOrder,
					generics,
					bindings,
					position,
				),
			}
		case "Record":
			return {
				k: "record",
				m: describeMembers(
					type.members,
					constrainedOrder,
					generics,
					bindings,
					position,
				),
			}
		case "Case":
			return {
				k: "case",
				m: describeMembers(
					type.members,
					constrainedOrder,
					generics,
					bindings,
					position,
				),
			}
		case "UnionType":
			return describeUnion(
				type,
				constrainedOrder,
				generics,
				bindings,
				position,
			)
		default:
			return { k: "eq" }
	}
}

// NOTE: One arm of a `union` descriptor node while it is being built — the
// claim it makes at runtime, alongside the Type that claim is read off.
type UnionArm = {
	// NOTE: The arm as written. For a Parameter-naming arm this still mentions
	// the Parameter; `applied` is what it stands for at this receiver.
	type: common.Type
	// NOTE: The Type a Parameter-naming arm stands for once the receiver's Type
	// Arguments are substituted in, and null for every other arm — a concrete
	// one, and one whose Parameters this receiver does not bind.
	applied: common.Type | null
	claim: {
		tag: string | null
		shape?: common.Type
		node: common.DescriptorNode
	} | null
}

// NOTE: A Union-typed payload member. Which arm a value belongs to is a runtime
// question, and the descriptor answers it with the two checks the runtime has:
// the value's `typeKeySymbol` tag, and — for the arms one tag can not tell apart
// — the structural `isValueOfType` a Match narrows with.
//
// NOTE: A tag says which KIND a value is, not which Type: every Record carries
// "Record", every List "List". So a concrete `{ code: Integer }` arm and a `T`
// bound to `{ name: String }` claim the same tag, and left at that the concrete
// arm claims the Parameter's values too and compares them structurally,
// overruling the witness the conformance solve chose for them. Both arms keep
// claiming — the concrete one only for the values its SHAPE accepts, which the
// Parameter's do not fit, so they fall through to the witness. Dropping either
// arm is not a resolution: dropping the concrete one sends its own values to a
// witness written for a Type they are not.
function describeUnion(
	type: common.UnionType,
	constrainedOrder: Array<string>,
	generics: Set<string>,
	bindings: GenericBindings,
	position: common.Position | null,
): common.DescriptorNode {
	let arms: Array<UnionArm> = flattenUnionMembers(type).map((armType) => ({
		type: armType,
		applied: appliedArmType(armType, generics, bindings),
		claim: null,
	}))

	// NOTE: The arms that stand for a Type Parameter's values. ONE of them is
	// the fallback the rest of this function is written around; two of them
	// are two fallbacks, and the runtime takes the first it finds — a
	// `T | List<T>` payload compared every List through T's witness, so
	// `#Val([2]) is #Val([10])` answered true and `#Val([2]) is #Val(2)`
	// answered true as well. What tells them apart is what this receiver's
	// Type Arguments made of them, which is what they are shaped by below.
	let parameterArms = arms.filter((arm) =>
		typeMentionsGenerics(arm.type, generics),
	)

	// NOTE: And where the receiver is generic over the very Parameters its
	// payload names, there are no Type Arguments to shape them with and both
	// arms are whatever the eventual Argument turns out to be. No descriptor
	// can be right about that, so the comparison is refused instead of being
	// emitted wrong.
	if (
		position !== null &&
		parameterArms.length > 1 &&
		parameterArms.some((arm) => arm.applied === null)
	) {
		reportError(
			"This Choice's payload can not be compared here",
			position,
			{
				code: "indistinguishable-union-arms",
				labels: [
					primary(
						position,
						"two arms of a payload Union are one Type at runtime",
					),
				],
				notes: [
					`'${describeType(type)}' names ${countOf(parameterArms.length, "arm")} standing for a Type Parameter's values: ${parameterArms
						.map((arm) => `'${describeType(arm.type)}'`)
						.join(", ")}.`,
					"Type Parameters erase, so which arm a value belongs to is decided by the Type Arguments the receiver was applied to — and here they are Parameters themselves.",
				],
				helps: [
					"Compare the value where its Type Arguments are known, or write the arms so that something other than a Type Parameter tells them apart.",
				],
			},
		)
	}

	// NOTE: What the Parameter-naming arms' values look like at this receiver —
	// the values a concrete arm must not claim. A Union Argument is flattened:
	// each of its members carries its own tag.
	let witnessTypes = arms.flatMap((arm) =>
		arm.applied === null
			? []
			: arm.applied.type === "UnionType"
				? flattenUnionMembers(arm.applied)
				: [arm.applied],
	)

	for (let arm of arms) {
		let node = describeMember(
			arm.type,
			constrainedOrder,
			generics,
			bindings,
			position,
		)

		// NOTE: An arm mentioning a Parameter is the fallback (`null`) — no
		// fixed tag is its own, so everything no arm claims is compared through
		// its witness. Where there are several, only the one the receiver could
		// not apply stays the fallback; the rest take the shape their Type
		// Argument gave them, which is what the runtime tells them apart by.
		if (typeMentionsGenerics(arm.type, generics)) {
			arm.claim =
				parameterArms.length === 1 || arm.applied === null
					? { tag: null, node }
					: {
							tag: null,
							shape: runtimeShapeOf(arm.applied),
							node,
						}

			continue
		}

		let tag = runtimeTagOf(arm.type)
		let collisions =
			tag === null
				? []
				: witnessTypes.filter(
						(witnessType) => runtimeTagOf(witnessType) === tag,
					)

		if (collisions.length === 0) {
			arm.claim = { tag, node }
			continue
		}

		// NOTE: Mutually assignable — the arm and the Argument accept exactly
		// the same values, so no runtime check tells them apart. The witness is
		// the more specific of the two answers, and it also answers for this
		// arm's own values (they are values of its Type too), so the arm stops
		// claiming altogether.
		if (
			collisions.some(
				(witnessType) =>
					matchesType(arm.type, witnessType) &&
					matchesType(witnessType, arm.type),
			)
		) {
			continue
		}

		arm.claim = { tag, shape: runtimeShapeOf(arm.type), node }
	}

	// NOTE: An Argument that is a strict REFINEMENT of a concrete arm — every
	// one of its values fits that arm's shape, while the arm has values it does
	// not — is the one case where a shape alone still claims wrongly. The
	// Parameter's arm takes a shape of its own, and the ordering below puts the
	// more specific claim first, so its values reach its witness and the arm
	// keeps the rest.
	for (let arm of arms) {
		let applied = arm.applied

		if (applied === null || arm.claim === null) {
			continue
		}

		let refinesAnArm = arms.some(
			(other) =>
				other.applied === null &&
				other.claim?.shape !== undefined &&
				matchesType(other.type, applied),
		)

		if (refinesAnArm) {
			arm.claim.shape = runtimeShapeOf(applied)
		}
	}

	return {
		k: "union",
		arms: orderClaims(
			arms.flatMap((arm) => (arm.claim === null ? [] : [arm.claim])),
		),
	}
}

// NOTE: The Type a Parameter-naming arm stands for once the receiver's Type
// Arguments are substituted in — null for a concrete arm, for a descriptor built
// without a receiver, and for an arm whose Parameters this receiver leaves
// unbound: those values carry whatever tag the eventual Argument does, which is
// unknown here.
function appliedArmType(
	arm: common.Type,
	generics: Set<string>,
	bindings: GenericBindings,
): common.Type | null {
	if (bindings.size === 0 || !typeMentionsGenerics(arm, generics)) {
		return null
	}

	let applied = applyGenericBindings(arm, bindings)

	return typeMentionsGenerics(applied, generics) ? null : applied
}

// NOTE: Most specific claim first, so an arm whose values are all values of
// another claims them before that other one does — Record shapes are OPEN, so
// `{ code: Integer }` accepts a `{ name: String, code: Integer }` too, and only
// the order keeps the more specific arm's values off it. Ties go to the
// Parameter's arm, whose witness is the more specific answer. Only the shaped
// arms are ordered, and they never compete with the rest: a shape is carried by
// exactly the arms of one colliding tag, so every other claim is decided by a
// tag none of them can answer to.
function orderClaims<Claim extends { tag: string | null; shape?: common.Type }>(
	claims: Array<Claim>,
): Array<Claim> {
	let shaped = claims.flatMap((claim, position) =>
		claim.shape === undefined
			? []
			: [{ claim, shape: claim.shape, position }],
	)

	if (shaped.length < 2) {
		return claims
	}

	let ordered = [...shaped].sort((left, right) => {
		let leftFitsRight = matchesType(right.shape, left.shape)
		let rightFitsLeft = matchesType(left.shape, right.shape)

		if (leftFitsRight !== rightFitsLeft) {
			return leftFitsRight ? -1 : 1
		}

		// NOTE: Two shapes accepting exactly each other's values — only reached
		// between two concrete arms, since an arm tied with a Parameter's
		// Argument stopped claiming above.
		if (leftFitsRight) {
			return left.claim.tag === null
				? -1
				: right.claim.tag === null
					? 1
					: 0
		}

		return 0
	})

	let claimed = [...claims]

	for (let [index, entry] of ordered.entries()) {
		claimed[shaped[index]!.position] = entry.claim
	}

	return claimed
}

// NOTE: The part of a Type the runtime can actually check — what `isValueOfType`
// consults and nothing more, which is why a descriptor carries a SHAPE rather
// than a Type. A Union's alias spelling and Type Arguments say nothing about a
// value, so they go. Every one of these is emitted into the Program that needs
// it, so what is left out is bytes no Program pays for.
//
// NOTE: A Case keeps its payload — its tag is shared by every instantiation of
// it, so `Box<Integer>#Full` and `Box<String>#Full` are told apart by their
// members or not at all. The members are shaped in turn, and the ones that are
// still Type Parameters answer true at runtime, which is the tag-only check
// back again where nothing more is known.
function runtimeShapeOf(type: common.Type): common.Type {
	switch (type.type) {
		case "Record":
			return {
				type: "Record",
				members: Object.fromEntries(
					Object.entries(type.members).map(([name, memberType]) => [
						name,
						runtimeShapeOf(memberType),
					]),
				),
			}
		case "List":
			return { type: "List", itemType: runtimeShapeOf(type.itemType) }
		case "Case":
			return {
				type: "Case",
				choice: type.choice,
				name: type.name,
				members: Object.fromEntries(
					Object.entries(type.members).map(([name, memberType]) => [
						name,
						runtimeShapeOf(memberType),
					]),
				),
			}
		case "UnionType":
			return { type: "UnionType", types: type.types.map(runtimeShapeOf) }
		default:
			return type
	}
}

function describeMembers(
	members: Record<string, common.Type>,
	constrainedOrder: Array<string>,
	generics: Set<string>,
	bindings: GenericBindings,
	position: common.Position | null,
): Record<string, common.DescriptorNode> {
	let described: Record<string, common.DescriptorNode> = {}

	for (let [name, memberType] of Object.entries(members)) {
		described[name] = describeMember(
			memberType,
			constrainedOrder,
			generics,
			bindings,
			position,
		)
	}

	return described
}

// NOTE: The compile-time plan the widened runtime helper follows for a generic
// Choice — one entry per Case tag mapping each payload member to how it is
// compared. Read off the DECLARED Alias (its Cases still carry GenericUse
// members the applied form erases), so the same plan is reachable at every
// emission site that has the receiver's Choice in hand. `typeArguments` are the
// receiver's, and only decide which arms of a Union payload can still be told
// apart from the Parameter's own values — how a member is compared is decided by
// the Alias alone.
//
// NOTE: `position` is where a payload no descriptor can be right about is
// reported, and null says to build it silently. Only a settled call site passes
// one: a conformance solve reaches here speculatively and memoised, and the
// Diagnostic it would report belongs to whatever call the witness is for.
export function derivedEquatableDescriptor(
	alias: common.GenericAliasType,
	typeArguments: Array<common.Type>,
	position: common.Position | null,
): common.DerivedEquatableDescriptor {
	let generics = new Set(alias.generics.map((generic) => generic.name))
	let constrainedOrder = constrainedGenericOrder(alias)
	let bindings: GenericBindings = new Map()
	let descriptor: common.DerivedEquatableDescriptor = {}

	for (let [index, generic] of alias.generics.entries()) {
		let typeArgument = typeArguments[index]

		if (typeArgument !== undefined) {
			bindings.set(generic.name, typeArgument)
		}
	}

	for (let caseType of choiceAliasCases(alias)) {
		if (caseType.type !== "Case") {
			continue
		}

		descriptor[`${caseType.choice}#${caseType.name}`] = describeMembers(
			caseType.members,
			constrainedOrder,
			generics,
			bindings,
			position,
		)
	}

	return descriptor
}

// NOTE: The descriptor for a receiver's Choice, or null when the Choice is not
// generic (a non-generic Choice keeps emitting the plain `choiceIs`). The Scope
// recovers the DECLARED Alias the applied receiver Type erased.
export function derivedEquatableDescriptorFor(
	baseType: common.Type,
	scope: enricher.Scope,
	position: common.Position,
): common.DerivedEquatableDescriptor | null {
	let alias = declaredChoiceAliasOf(baseType, scope)

	if (alias === null || alias.generics.length === 0) {
		return null
	}

	return derivedEquatableDescriptor(
		alias,
		choiceTypeArgumentsOf(baseType),
		position,
	)
}

// NOTE: Every Choice is Equatable without being written as such — a Case is
// decided by its tag, and its payload is a Record, which the language already
// compares structurally. This is the Namespace that says so: fabricated on
// demand for a Choice receiver, exactly like the `T__conformance` pseudo
// Namespace below is fabricated for a Protocol-bounded one.
//
// NOTE: It is a FALLBACK, never an override. Both callers reach for it only
// once no written Namespace has answered, so a Namespace with its own `is`
// keeps deciding equality for its own Choice.
export function derivedEquatableNamespace(
	baseType: common.Type,
	scope: enricher.Scope,
): common.NamespaceType | null {
	let choiceType = choiceTypeOf(baseType, scope)

	if (choiceType === null) {
		return null
	}

	return derivedEquatableNamespaceForChoice(
		choiceType,
		declaredChoiceAliasOf(baseType, scope),
		choiceTypeArgumentsOf(baseType),
	)
}

// NOTE: The same Namespace, built from a Choice that is already in hand. The
// Language Server has the Choice but no Scope to look one up in, and building
// the Methods twice is how the two would drift.
//
// NOTE: For a *generic* Choice the Methods are conditional: each takes the
// payload-mentioned Parameters as `infer … is Equatable` bounds and the
// UNAPPLIED body Union as its Parameters, so invocation inference binds the
// Parameters from the receiver and the existing conformance rail produces the
// per-Parameter witnesses. A non-generic Choice (or a call with no Alias in
// hand) keeps the flat Methods, whose emission never widens.
//
// NOTE: `typeArguments` are the receiver's own, when the caller has a receiver
// — they PIN the Parameters instead of leaving them to be inferred. A receiver
// narrowed to one Case (`case #First { @::is(@) }`) only matches that Case's arm
// of the body Union, which mentions the Parameters ITS payload names and no
// others, so inference alone would leave the rest unbound and misreport them as
// uninferable — even though the receiver spells every one of them out. Pinned
// Parameters are still checked against the Arguments: a pin is a binding made
// up front, not a Parameter withdrawn from matching.
export function derivedEquatableNamespaceForChoice(
	choiceType: common.Type,
	declaredAlias: common.GenericAliasType | null = null,
	typeArguments: Array<common.Type> = [],
): common.NamespaceType {
	let isGeneric = declaredAlias !== null && declaredAlias.generics.length > 0

	// NOTE: R4 — a fresh bound list per Method, never the singleton Alias'
	// Declarations. Only the mentioned Parameters are bounded; an unmentioned
	// one would stay unbound at inference and misreport as uninferable.
	let boundGenerics: Array<common.GenericDeclaration> =
		isGeneric && declaredAlias !== null
			? constrainedGenericOrder(declaredAlias).map((name) => {
					// NOTE: A Parameter the receiver spells out is declared as a
					// default rather than as `infer`, which is what pre-binds it
					// — inference seeds the defaults of the Parameters it is not
					// asked to infer, and checks the Arguments against them.
					let pinned =
						typeArguments[
							declaredAlias.generics.findIndex(
								(generic) => generic.name === name,
							)
						]

					return {
						name,
						infer: pinned === undefined,
						defaultType: pinned ?? null,
						constraint: "Equatable",
					}
				})
			: []

	// NOTE: The Parameters are the UNAPPLIED body Union for a generic Choice, so
	// its GenericUse members give inference something to bind the bounds to.
	let parameterType =
		isGeneric && declaredAlias !== null
			? declaredAlias.aliasedType
			: choiceType

	let method = (
		description: string,
		returns: string,
	): common.SimpleMethodType => ({
		type: "SimpleMethod",
		generics: boundGenerics.map((generic) => ({ ...generic })),
		parameterTypes: [
			{ name: null, type: parameterType },
			{
				name: null,
				type: parameterType,
				documentation: "the Choice to compare with",
			},
		],
		returnType: { type: "Boolean" },
		documentation: {
			description,
			parameters: { other: "the Choice to compare with" },
			returns,
			position: null,
		},
	})

	return {
		type: "Namespace",
		name: derivedEquatableNamespaceName,
		targetType: choiceType,
		generics: [],
		properties: {},
		methods: {
			is: method(
				"Answers whether both are the same Case, carrying equal payloads.",
				"`true` when both are the same Case and their payloads are equal.",
			),
			isNot: method(
				"Answers whether the two are different Cases, or carry differing payloads.",
				"`true` when the Cases differ, or their payloads do.",
			),
		},
		conformsTo: ["Equatable"],
	}
}

// NOTE: The witness the derived equality provides for a Choice, or null when
// it provides none. `written` is the Namespace that claimed the conformance, if
// one did — the derive fills in for it only when it declares NONE of the
// Protocol's Methods. All or nothing, because a witness names ONE Namespace:
// half-written equality can not be half-derived, and a Namespace writing its
// own `is` beside a derived `isNot` would answer the same question two
// different ways. Written through the same method map as any other candidate,
// so the derived Methods are checked against the Protocol rather than assumed
// to fit it.
function derivedConformanceSource(
	binding: common.Type,
	protocolName: string,
	written: common.NamespaceType | null,
	scope: enricher.Scope,
	position: common.Position,
): common.ConformanceSource | null {
	let choiceType = choiceTypeOf(binding, scope)

	if (choiceType === null) {
		return null
	}

	// NOTE: The conformance is CHECKED against the flat Methods — their
	// Parameters are the applied Choice, so they line up with the Protocol's
	// `Self` under plain assignability. The bounded Methods
	// `derivedEquatableNamespace` builds are for the direct-call rail, where
	// invocation inference binds their Parameters; here the witnesses are solved
	// by hand below instead.
	let derived = derivedEquatableNamespaceForChoice(choiceType)

	if (!derived.conformsTo?.includes(protocolName)) {
		return null
	}

	let protocol = findProtocolInScope(protocolName, scope)

	if (protocol === null) {
		return null
	}

	if (
		written !== null &&
		Object.keys(protocol.methods).some((methodName) =>
			Object.hasOwn(written.methods, methodName),
		)
	) {
		return null
	}

	let result = computeConformanceMethodMap(
		protocol,
		derived,
		binding,
		new Map(),
	)

	if (result.kind !== "conforms") {
		return null
	}

	// NOTE: A non-generic Choice derives unconditionally — no witnesses, no
	// descriptor, so its witness emission stays byte-identical to what it was
	// before generic Choices existed.
	let alias = declaredChoiceAliasOf(binding, scope)

	if (alias === null || alias.generics.length === 0) {
		return {
			kind: "namespace",
			name: derivedEquatableNamespaceName,
			methodMap: result.methodMap,
			conditions: [],
		}
	}

	// NOTE: A generic Choice conforms only where each payload-mentioned
	// Parameter's Type Argument does — solved recursively, in declaration order
	// (R7) so the witnesses line up with the descriptor's `w` indices. Any
	// failure withholds the derive, and the caller surfaces the because-chain.
	let genericNames = alias.generics.map((generic) => generic.name)
	let typeArguments = choiceTypeArgumentsOf(binding)
	let conditions: Array<common.Conformance> = []

	for (let name of constrainedGenericOrder(alias)) {
		let typeArgument = typeArguments[genericNames.indexOf(name)] ?? {
			type: "Error" as const,
		}

		let solved = solveConformance(
			typeArgument,
			protocolName,
			scope,
			position,
		)

		if (!solved.ok) {
			return null
		}

		conditions.push({
			genericName: name,
			protocolName,
			source: solved.source,
		})
	}

	return {
		kind: "namespace",
		name: derivedEquatableNamespaceName,
		methodMap: result.methodMap,
		conditions,
		// NOTE: Silent — this is the witness a bounded call is handed, solved
		// speculatively and memoised, so the call site is where a payload that
		// can not be compared is reported.
		derivedDescriptor: derivedEquatableDescriptor(
			alias,
			typeArguments,
			null,
		),
	}
}

// NOTE: Solves whether `binding` conforms to `protocolName` in `scope`,
// producing the witness the codegen needs. A GenericUse forwards the enclosing
// bounded Function's own conformance parameter; a concrete Type selects the one
// conforming Namespace and recursively solves that Namespace's `where`
// conditions. Cycle-guarded and memoised per Scope.
export function solveConformance(
	binding: common.Type,
	protocolName: string,
	scope: enricher.Scope,
	position: common.Position,
): ConformanceSolveResult {
	if (binding.type === "GenericUse") {
		if (binding.constraint === protocolName) {
			return {
				ok: true,
				source: {
					kind: "parameter",
					name: conformanceParameterName(binding.name),
				},
			}
		}

		return {
			ok: false,
			chain: [
				`Type Parameter '${binding.name}' does not conform to '${protocolName}'.`,
			],
		}
	}

	// NOTE: An Error binding was already diagnosed — stay silent.
	if (binding.type === "Error") {
		return { ok: false, chain: [] }
	}

	let protocol = findProtocolInScope(protocolName, scope)

	// NOTE: An unknown Protocol was already diagnosed at the declaration.
	if (protocol === null) {
		return { ok: false, chain: [] }
	}

	let key = conformanceKey(protocolName, binding)
	let state = conformanceStateFor(scope)

	let cached = state.memo.get(key)
	if (cached !== undefined) {
		return cached
	}

	if (state.inProgress.has(key)) {
		return {
			ok: false,
			chain: [
				`${describeType(binding)} conforming to '${protocolName}' depends on itself.`,
			],
		}
	}

	state.inProgress.add(key)

	try {
		let result = solveNamespaceConformance(
			binding,
			protocol,
			protocolName,
			scope,
			position,
		)

		// NOTE: Only successes are memoised — a failure reached through a cycle
		// is tainted by whatever else was in progress, so caching it could
		// poison an independent later query for the same key.
		if (result.ok) {
			state.memo.set(key, result)
		}

		return result
	} finally {
		state.inProgress.delete(key)
	}
}

function solveNamespaceConformance(
	binding: common.Type,
	protocol: common.ProtocolType,
	protocolName: string,
	scope: enricher.Scope,
	position: common.Position,
): ConformanceSolveResult {
	let candidates: Array<{
		name: string
		type: common.NamespaceType
		isGeneric: boolean
		// NOTE: The Namespace's own `where` conditions for this Protocol, and
		// the bindings that map each condition's Generic to a concrete Type, so
		// the conditions can be solved recursively. Ordered by the Namespace's
		// Generic declaration order to line the witnesses up with the hidden
		// conformance Parameters.
		conditions: Array<{ generic: string; protocol: string }>
		conditionBindings: GenericBindings
	}> = []

	for (let [name, namespace] of getAllNamespacesInScope(scope, null)) {
		if (
			namespace.conformsTo === undefined ||
			!namespace.conformsTo.includes(protocolName) ||
			namespace.targetType === null
		) {
			continue
		}

		let orderedConditions = orderConditions(
			namespace.conformanceConditions?.[protocolName] ?? [],
			namespace.generics,
		)

		if (namespace.generics.length === 0) {
			if (matchesType(namespace.targetType, binding)) {
				candidates.push({
					name,
					type: namespace,
					isGeneric: false,
					conditions: orderedConditions,
					conditionBindings: new Map(),
				})
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

		if (matchesTypeWithBindings(namespace.targetType, binding, context)) {
			candidates.push({
				name,
				type: specializeNamespace(namespace, context.bindings),
				isGeneric: true,
				conditions: orderedConditions,
				conditionBindings: context.bindings,
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
	let isStrictlyMoreSpecific = (a: common.Type, b: common.Type): boolean =>
		matchesType(b, a) && !matchesType(a, b)

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
		// NOTE: No written Namespace conforms — a Choice still does, through
		// the derived equality.
		let derived = derivedConformanceSource(
			binding,
			protocolName,
			null,
			scope,
			position,
		)

		if (derived !== null) {
			return { ok: true, source: derived }
		}

		return {
			ok: false,
			chain: [
				`${describeType(binding)} does not conform to '${protocolName}'.`,
			],
		}
	}

	if (candidates.length > 1) {
		reportError(
			`More than one Namespace makes ${describeType(binding)} conform to '${protocolName}'`,
			position,
			{
				code: "ambiguous-conformance",
				labels: [
					primary(position, "the conformance can not be chosen here"),
				],
				notes: candidates.map(
					(candidate) =>
						`'${candidate.name}' conforms to '${protocolName}'.`,
				),
			},
		)

		return { ok: false, chain: [] }
	}

	let candidate = candidates[0]

	// NOTE: The candidate conforms only under its own `where` conditions — feed
	// them in as assumptions so a fulfilling Method carrying that same bound
	// (List's `compareTo`) is accepted here, then verify the assumptions hold
	// by solving the conditions recursively below.
	let assumptions = new Map(
		candidate.conditions.map((condition) => [
			condition.generic,
			condition.protocol,
		]),
	)

	let result = computeConformanceMethodMap(
		protocol,
		candidate.type,
		binding,
		assumptions,
	)

	if (result.kind !== "conforms") {
		// NOTE: The Namespace DECLARED the conformance and wrote none of it —
		// for a Choice that is not a mistake, it is a statement of intent the
		// derived equality fulfills. The declaration site accepts the same
		// pairing, so the two agree on which Namespaces conform.
		let derived = derivedConformanceSource(
			binding,
			protocolName,
			candidate.type,
			scope,
			position,
		)

		if (derived !== null) {
			return { ok: true, source: derived }
		}

		// NOTE: Reachable when the Namespace covers the binding through a wider
		// target Type (a Union) but a `Self` position makes the signatures
		// incompatible for this narrower binding, or a fulfilling Method still
		// carries an unassumed bound. Reported here; the caller stays silent.
		let label =
			result.kind === "needs-condition"
				? `Method '${result.methodName}' needs '${result.genericName} is ${result.protocolName}'`
				: `this needs ${describeType(binding)} to conform`

		reportError(
			`Namespace '${candidate.name}' does not conform to '${protocolName}'`,
			position,
			{
				code: "nonconforming-namespace",
				labels: [primary(position, label)],
			},
		)

		return { ok: false, chain: [] }
	}

	// NOTE: Recursively solve the chosen Namespace's own `where` conditions —
	// their bindings come from the unification above. A failure bubbles up as
	// a because-chain with this level prepended.
	let conditions: Array<common.Conformance> = []

	for (let condition of candidate.conditions) {
		let conditionBinding = candidate.conditionBindings.get(
			condition.generic,
		)

		// NOTE: The unification above reached the candidate without pinning this
		// condition's Generic, which an empty List Literal does: `List<ItemType>`
		// accepts a `List<Unknown>` receiver outright, binding nothing. There is
		// no witness to hand over — skipping the condition used to emit a plain
		// method map where the fulfilling Method expects a curried one, and the
		// Program died reading `compareTo` off `undefined`. Binding the Generic
		// to Unknown instead would only move the lie one level down.
		if (conditionBinding === undefined) {
			return {
				ok: false,
				// NOTE: An Error somewhere in the binding was reported where it
				// went wrong — that is why nothing pinned the Generic, and a
				// second Diagnostic about it would only repeat the first.
				chain: typeContainsError(binding)
					? []
					: [
							`${describeType(binding)} does not conform to '${protocolName}'.`,
							`Its '${condition.generic}' is not determined here — an empty List Literal leaves the item Type unknown until something pins it down.`,
						],
			}
		}

		let solved = solveConformance(
			conditionBinding,
			condition.protocol,
			scope,
			position,
		)

		if (!solved.ok) {
			return {
				ok: false,
				chain:
					solved.chain.length === 0
						? []
						: [
								`${describeType(binding)} does not conform to '${protocolName}'.`,
								...solved.chain,
							],
			}
		}

		conditions.push({
			genericName: condition.generic,
			protocolName: condition.protocol,
			source: solved.source,
		})
	}

	return {
		ok: true,
		source: {
			kind: "namespace",
			name: candidate.name,
			methodMap: result.methodMap,
			conditions,
		},
	}
}

// NOTE: Orders a Protocol's `where` conditions by the Namespace's Generic
// declaration order — the invariant that lines each witness up with its hidden
// conformance Parameter, which the simplifier emits in that same order.
function orderConditions(
	conditions: Array<{ generic: string; protocol: string }>,
	generics: Array<common.GenericDeclaration>,
): Array<{ generic: string; protocol: string }> {
	let order = generics.map((generic) => generic.name)

	return [...conditions].sort(
		(a, b) => order.indexOf(a.generic) - order.indexOf(b.generic),
	)
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

		// NOTE: An unknown Protocol was already diagnosed at the declaration.
		if (findProtocolInScope(generic.constraint, scope) === null) {
			continue
		}

		// NOTE: A GenericUse binding keeps its own tailored Diagnostic — the
		// bound was carried by an unbounded Type Parameter, which is a distinct
		// mistake from a Type that simply has no conforming Namespace.
		if (binding.type === "GenericUse") {
			if (binding.constraint === generic.constraint) {
				conformances.push({
					genericName: generic.name,
					protocolName: generic.constraint,
					source: {
						kind: "parameter",
						name: conformanceParameterName(binding.name),
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

		let result = solveConformance(
			binding,
			generic.constraint,
			scope,
			position,
		)

		if (result.ok) {
			conformances.push({
				genericName: generic.name,
				protocolName: generic.constraint,
				source: result.source,
			})

			continue
		}

		// NOTE: An empty chain means the failure (ambiguity, a nonconforming
		// Namespace) was already reported — stay silent.
		if (result.chain.length === 0) {
			continue
		}

		// NOTE: A single-level chain is the plain "no Namespace conforms" case
		// and keeps the `unsatisfied-bound` Diagnostic. A multi-level chain is
		// a conditional conformance whose `where` condition failed — its
		// because-chain becomes the notes of `unsatisfied-conformance-condition`.
		if (result.chain.length === 1) {
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
		} else {
			reportError(
				`${describeType(binding)} does not conform to '${generic.constraint}'`,
				position,
				{
					code: "unsatisfied-conformance-condition",
					labels: [
						primary(
							position,
							`this binds a Type Parameter bound to '${generic.constraint}'`,
						),
					],
					notes: result.chain,
					helps: [
						`Declare a Namespace 'for ${describeType(binding)} is ${generic.constraint}'.`,
					],
				},
			)
		}
	}

	return conformances
}

// NOTE: The result of checking one conformance clause that holds — its
// Protocol, the validated `where` conditions, and the map from each Protocol
// Method to the fulfilling Namespace Method. Handed back to the Enricher so it
// can thread each conditional clause's bounds into the fulfilling Methods.
export type CheckedConformance = {
	protocolName: string
	conditions: Array<{ generic: string; protocol: string }>
	methodMap: Record<string, string>
}

// NOTE: Why a `where` condition can not become an assumption, or null when it
// can. The two conformance checks — the reporting one below and the silent twin
// hoisting runs — share this so they can not drift into disagreeing about which
// conditions a clause carries: the bounds woven into the fulfilling Methods are
// read off exactly that list, and a Method bound in one pass and not the other
// would emit a hidden conformance Parameter its call sites do not fill.
type WhereConditionRejection =
	| { kind: "unknown-generic" }
	| { kind: "unwitnessable" }
	| { kind: "unknown-protocol" }
	| { kind: "already-bound"; protocol: string }

function whereConditionRejection(
	condition: parser.WhereConditionNode,
	targetType: common.Type,
	declaredGenerics: ReadonlySet<string>,
	assumptions: ReadonlyMap<string, string>,
	scope: enricher.Scope,
): WhereConditionRejection | null {
	if (!declaredGenerics.has(condition.generic.content)) {
		return { kind: "unknown-generic" }
	}

	// NOTE: A condition is proven at the use site by unifying the target Type
	// against the receiver — a Generic the target never mentions can never be
	// bound there, so its witness could never be produced and the hidden
	// conformance Parameter would arrive as `undefined` at runtime.
	if (!typeMentionsGeneric(targetType, condition.generic.content)) {
		return { kind: "unwitnessable" }
	}

	if (findProtocolInScope(condition.protocol.content, scope) === null) {
		return { kind: "unknown-protocol" }
	}

	let existing = assumptions.get(condition.generic.content)

	if (existing !== undefined) {
		return { kind: "already-bound", protocol: existing }
	}

	return null
}

// NOTE: What `checkProtocolConformance` would find, with nothing reported and
// nothing derived. Hoisting needs the clauses that HOLD — they are what says
// which Methods carry a conditional conformance's bound — and can not report
// while it looks: a Diagnostic during speculative resolution keeps the whole
// Namespace out of Scope. A clause a Choice's derived equality fulfils names no
// Namespace Method, so leaving the derive out costs no bound.
// `computeConformanceMethodMap` is pure, so running it here declares nothing.
export function silentCheckedConformances(
	node: parser.NamespaceDefinitionStatementNode,
	namespaceType: common.NamespaceType,
	scope: enricher.Scope,
	// NOTE: The Protocol names still waiting to hoist. A clause naming one can
	// not be checked yet, and checking it anyway would silently drop its bounds
	// — so the Namespace is thrown back to the hoist loop, which retries it a
	// round later, the same way a Type Alias naming a later declaration waits.
	pendingProtocols: ReadonlySet<string>,
): Array<CheckedConformance> {
	let checked: Array<CheckedConformance> = []
	let declaredGenerics = new Set(
		node.generics.map((generic) => generic.name.content),
	)

	for (let clause of node.conformsTo) {
		for (let name of [
			clause.protocol.content,
			...clause.conditions.map((condition) => condition.protocol.content),
		]) {
			if (
				findProtocolInScope(name, scope) === null &&
				pendingProtocols.has(name)
			) {
				throw new Error(
					`Protocol '${name}' has not been hoisted yet — deferring Namespace '${node.name.content}'`,
				)
			}
		}

		let protocol = findProtocolInScope(clause.protocol.content, scope)

		if (protocol === null || namespaceType.targetType === null) {
			continue
		}

		let conditions: Array<{ generic: string; protocol: string }> = []
		let assumptions = new Map<string, string>()

		for (let condition of clause.conditions) {
			if (
				whereConditionRejection(
					condition,
					namespaceType.targetType,
					declaredGenerics,
					assumptions,
					scope,
				) !== null
			) {
				continue
			}

			assumptions.set(
				condition.generic.content,
				condition.protocol.content,
			)
			conditions.push({
				generic: condition.generic.content,
				protocol: condition.protocol.content,
			})
		}

		let result = computeConformanceMethodMap(
			protocol,
			namespaceType,
			namespaceType.targetType,
			assumptions,
		)

		if (result.kind === "conforms") {
			checked.push({
				protocolName: protocol.name,
				conditions,
				methodMap: result.methodMap,
			})
		}
	}

	return checked
}

// NOTE: The reporting check, called from the Enricher and never from
// speculative hoisting — a Namespace with a broken conformance clause is still a
// perfectly usable Namespace and must hoist, so hoisting reads the silent twin
// above and leaves every Diagnostic to this pass. The Namespace Type checked
// here is the one the hoist already wove its bounds into, which is what makes an
// unconditional clause fulfilled by a Method a conditional clause bounds the
// error it always was, wherever the use sites happen to sit.
export function checkProtocolConformance(
	node: parser.NamespaceDefinitionStatementNode,
	namespaceType: common.NamespaceType,
	scope: enricher.Scope,
): Array<CheckedConformance> {
	let checked: Array<CheckedConformance> = []
	let declaredGenerics = new Set(
		node.generics.map((generic) => generic.name.content),
	)

	for (let clause of node.conformsTo) {
		let identifier = clause.protocol
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
					...suggestionData(
						suggestionInScope(
							identifier.content,
							scope,
							"protocols",
						),
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

		// NOTE: Validate each `where` condition before it becomes an
		// assumption — the LHS has to name one of this Namespace's own Type
		// Parameters, the RHS a real Protocol, and no Generic may be bound
		// twice in one clause.
		let conditions: Array<{ generic: string; protocol: string }> = []
		let assumptions = new Map<string, string>()

		for (let condition of clause.conditions) {
			let rejection = whereConditionRejection(
				condition,
				namespaceType.targetType,
				declaredGenerics,
				assumptions,
				scope,
			)

			if (rejection !== null) {
				if (rejection.kind === "unknown-generic") {
					reportError(
						`'${condition.generic.content}' is not a Type Parameter of this Namespace`,
						condition.generic.position,
						{
							code: "unknown-where-generic",
							labels: [
								primary(
									condition.generic.position,
									"no such Type Parameter",
								),
							],
							helps: [
								`Declare it in the Namespace's Generic list: '<infer ${condition.generic.content}>'.`,
							],
						},
					)
				} else if (rejection.kind === "unwitnessable") {
					reportError(
						`'${condition.generic.content}' does not appear in this Namespace's target Type`,
						condition.generic.position,
						{
							code: "unwitnessable-where-condition",
							labels: [
								primary(
									condition.generic.position,
									"not part of the target Type",
								),
							],
							notes: [
								"A condition is proven by the target Type at each use site — a Type Parameter the target never mentions has nothing to prove it with.",
							],
							helps: [
								`Mention '${condition.generic.content}' in the target Type, or drop the condition.`,
							],
						},
					)
				} else if (rejection.kind === "unknown-protocol") {
					reportError(
						`Protocol '${condition.protocol.content}' is not declared`,
						condition.protocol.position,
						{
							code: "unknown-protocol",
							labels: [
								primary(
									condition.protocol.position,
									"no such Protocol",
								),
							],
							helps: suggestionHelps(
								condition.protocol.content,
								scope,
								"protocols",
							),
							...suggestionData(
								suggestionInScope(
									condition.protocol.content,
									scope,
									"protocols",
								),
							),
						},
					)
				} else {
					reportError(
						`'${condition.generic.content}' is bound twice in this conformance`,
						condition.generic.position,
						{
							code: "conflicting-where-condition",
							labels: [
								primary(
									condition.generic.position,
									`already bound to '${rejection.protocol}'`,
								),
							],
							notes: [
								`'${condition.generic.content}' is already required to conform to '${rejection.protocol}'.`,
							],
						},
					)
				}

				continue
			}

			assumptions.set(
				condition.generic.content,
				condition.protocol.content,
			)
			conditions.push({
				generic: condition.generic.content,
				protocol: condition.protocol.content,
			})
		}

		let result = computeConformanceMethodMap(
			protocol,
			namespaceType,
			namespaceType.targetType,
			assumptions,
		)

		// NOTE: `namespace Colour for Colour is Equatable { }` writes no `is`
		// and is still right — the Choice derives one. Accepted here rather
		// than diagnosed, with the same all-or-nothing rule the use site
		// applies, so declaring the conformance a Choice already has is a way
		// of SAYING so rather than an error to work around by deleting the
		// clause.
		if (
			result.kind !== "conforms" &&
			derivedConformanceSource(
				namespaceType.targetType,
				protocol.name,
				namespaceType,
				scope,
				identifier.position,
			) !== null
		) {
			checked.push({
				protocolName: protocol.name,
				conditions,
				methodMap: {},
			})

			continue
		}

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
					helps: [
						`Add 'where ${result.genericName} is ${result.protocolName}' to this conformance.`,
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
		} else {
			checked.push({
				protocolName: protocol.name,
				conditions,
				methodMap: result.methodMap,
			})
		}
	}

	return checked
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
	scope: enricher.Scope,
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

	// NOTE: A bound is a promise the APPLICATION has to keep — nothing below
	// this point ever asks again, so `Box<Function>` used to substitute a Type
	// with no equality into a payload declared Equatable and only fall over when
	// something reached for the witness. Solved for the Diagnostic alone: the
	// witnesses a call needs are solved at the call, against the Types the
	// arguments actually have. An Alias whose Generics carry no bound at all —
	// every one the standard library declares — pays nothing for this, because
	// `resolveConformances` returns before it looks at any of them.
	resolveConformances(aliasType.generics, bindings, scope, position)

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
				...suggestionData(suggestionInScope(name, scope, "types")),
			})
		}

		return { type: "Error" }
	}

	// NOTE: A bare use of a Generic Type Alias applies the defaults — without
	// a full set of defaults it is missing Type Arguments.
	if (result.type === "GenericAlias") {
		return applyGenericAlias(result, [], scope, node.position)
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
					...suggestionData(suggestionInScope(name, scope, "types")),
				},
			)

			return { type: "Error" }
		}

		baseType = result
	} else {
		baseType = resolveType(node.baseType, scope)
	}

	return applyTypeArguments(baseType, node.generics, scope, node.position)
}

// NOTE: The whole of what applying Type Arguments to a base Type means — the
// arity check, the bounds, the List normalisation and the refusal of a Type
// that takes none. An annotation's `Holder<Integer>` and a value's
// `Holder<Integer>#Full` are the same application, and reaching this from both
// is what keeps them held to the same promises rather than to two
// implementations that drift.
export function applyTypeArguments(
	baseType: common.Type,
	typeArguments: Array<parser.TypeDeclarationNode>,
	scope: enricher.Scope,
	position: common.Position,
): common.Type {
	if (baseType.type === "Error") {
		return baseType
	}

	// NOTE: Applied Lists are normalized into plain List Types right away, so
	// that inferred and declared List Types share a single representation.
	if (baseType.type === "GenericList") {
		if (typeArguments.length !== 1) {
			reportError("List takes exactly 1 Type Argument", position, {
				code: "wrong-type-argument-count",
				labels: [
					primary(
						position,
						`${countOf(typeArguments.length, "Type Argument")} given`,
					),
				],
			})

			return {
				type: "List",
				itemType:
					typeArguments.length > 0
						? resolveType(typeArguments[0], scope)
						: { type: "Error" },
			}
		}

		return {
			type: "List",
			itemType: resolveType(typeArguments[0], scope),
		}
	}

	if (baseType.type === "GenericAlias") {
		return applyGenericAlias(
			baseType,
			typeArguments.map((argument) => resolveType(argument, scope)),
			scope,
			position,
		)
	}

	reportError("This Type takes no Type Arguments", position, {
		code: "type-not-generic",
		labels: [primary(position, "the Type Arguments have nowhere to go")],
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
			...suggestionData(suggestion),
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

export function suggestionInScope(
	name: string,
	scope: enricher.Scope,
	kind: "members" | "types" | "protocols",
): string | null {
	let suggestion = closestMatch(name, namesInScope(scope, kind))

	return suggestion === null || suggestion === name ? null : suggestion
}

// NOTE: A near miss is a Help rather than part of the message — it is a
// suggestion, and a message that states one as fact reads as though the
// Compiler knows something it does not.
export function suggestionHelps(
	name: string,
	scope: enricher.Scope,
	kind: "members" | "types" | "protocols",
): Array<string> {
	let suggestion = suggestionInScope(name, scope, kind)

	return suggestion === null ? [] : [`Did you mean '${suggestion}'?`]
}

// NOTE: The same near miss again, for the Quick Fix that applies it. Spread
// rather than assigned, so a Diagnostic that has no suggestion carries no
// `data` key at all rather than one holding `undefined`.
export function suggestionData(suggestion: string | null): {
	data?: common.DiagnosticData
} {
	return suggestion === null
		? {}
		: { data: { kind: "suggestion", suggestion } }
}

// NOTE: `Object.hasOwn`, not a plain index — as in `findTypeInScope` below.
// A name that happens to spell a member of `Object.prototype` (`toString`,
// `valueOf`, `constructor`) would otherwise resolve to a JavaScript function
// nobody declared, and an undeclared `toString` would type-check.
export function findVariableInScope(
	name: string,
	scope: enricher.Scope,
): common.Type | null {
	let searchScope: enricher.Scope | null = scope

	while (true) {
		if (searchScope === null) {
			return null
		}

		if (Object.hasOwn(searchScope.members, name)) {
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

// NOTE: Method resolution asks which Namespaces a Scope can see once per
// Method invocation, and the answer only changes when a name is declared into
// one of the Scopes on the chain. Each Scope therefore carries a version that
// its own declarations bump, and the memoised answer records the versions it
// was computed from — revalidating costs a walk up the chain comparing
// numbers, instead of enumerating every member of every Scope.
let scopeVersions = new WeakMap<enricher.Scope, number>()
let namespacesInScopeCache = new WeakMap<
	enricher.Scope,
	{
		versions: Array<{ scope: enricher.Scope; version: number }>
		namespaces: Map<string, common.NamespaceType>
	}
>()

// NOTE: Every name ever declared as a Namespace. A declaration only changes
// what `getAllNamespacesInScope` answers if it declares a Namespace or
// shadows one — declaring an ordinary Constant leaves every cached answer
// intact, and Constants are the overwhelming majority of declarations.
let namespaceNames = new Set<string>()

export function invalidateNamespacesInScope(
	scope: enricher.Scope,
	name: string,
	type: common.Type,
): void {
	if (type.type === "Namespace") {
		namespaceNames.add(name)
	} else if (!namespaceNames.has(name)) {
		return
	}

	scopeVersions.set(scope, (scopeVersions.get(scope) ?? 0) + 1)
}

// NOTE: The version of every Scope on the chain, innermost first — what a
// memoised answer records so that `namespaceCacheIsCurrent` can revalidate it
// by comparing numbers instead of enumerating members.
function scopeVersionSnapshot(
	scope: enricher.Scope,
): Array<{ scope: enricher.Scope; version: number }> {
	let versions: Array<{ scope: enricher.Scope; version: number }> = []
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		versions.push({
			scope: searchScope,
			version: scopeVersions.get(searchScope) ?? 0,
		})

		searchScope = searchScope.parent
	}

	return versions
}

function namespaceCacheIsCurrent(
	cached: { versions: Array<{ scope: enricher.Scope; version: number }> },
	scope: enricher.Scope,
): boolean {
	let searchScope: enricher.Scope | null = scope
	let index = 0

	while (searchScope !== null) {
		let entry = cached.versions[index]

		if (
			entry === undefined ||
			entry.scope !== searchScope ||
			entry.version !== (scopeVersions.get(searchScope) ?? 0)
		) {
			return false
		}

		searchScope = searchScope.parent
		index++
	}

	return index === cached.versions.length
}

// NOTE: `::<Name>method()` where `Name` means something other than a Namespace
// here. Reported rather than skipped past: the call site named ONE Namespace,
// and answering with a Namespace of that name from further out would type-check
// the call against something the emitted code can not reach — the nearer
// binding is what the name compiles to.
function reportSpecifierIsNotANamespace(
	identifier: parser.IdentifierNode,
	value: common.Type,
	declarationPosition: common.Position | null,
): void {
	reportError(
		`'${identifier.content}' is not a Namespace`,
		identifier.position,
		{
			code: "not-a-namespace",
			labels: [
				primary(
					identifier.position,
					`this is ${withArticle(describeType(value))}`,
				),
				...(declarationPosition === null
					? []
					: [secondary(declarationPosition, "declared here")]),
			],
			notes: [
				`A Method can only be looked up in a Namespace, and '${identifier.content}' names ${withArticle(describeType(value))} here.`,
			],
			helps: [
				"Drop the Namespace specifier, or rename whatever shadows the Namespace.",
			],
		},
	)
}

export function getAllNamespacesInScope(
	scope: enricher.Scope,
	identifier: parser.IdentifierNode | null,
): Map<string, common.NamespaceType> {
	// NOTE: A named lookup only ever wants one Namespace, so it walks the
	// Scope chain asking for that one name instead of enumerating members.
	// It stops at the NEAREST binding of the name, whatever that binding is —
	// the same shadowing rule the enumeration below implements ("a member that
	// is anything else shadows one away"). Walking past a Constant to a
	// Namespace of the same name further out would validate the call against a
	// Namespace that is not what the name means where the call is emitted.
	if (identifier) {
		let namespaces: Map<string, common.NamespaceType> = new Map()
		let name = identifier.content
		let searchScope: enricher.Scope | null = scope

		while (searchScope !== null) {
			if (Object.hasOwn(searchScope.members, name)) {
				let value = searchScope.members[name]

				if (value.type === "Namespace") {
					namespaces.set(name, value)
				} else {
					reportSpecifierIsNotANamespace(
						identifier,
						value,
						Object.hasOwn(searchScope.declarations, name)
							? searchScope.declarations[name]
							: null,
					)
				}

				break
			}

			searchScope = searchScope.parent
		}

		return namespaces
	}

	let cached = namespacesInScopeCache.get(scope)

	if (cached !== undefined && namespaceCacheIsCurrent(cached, scope)) {
		return cached.namespaces
	}

	// NOTE: What a Scope can see is what its parent can see, amended by its
	// own members: a member that is a Namespace adds one, and a member that
	// is anything else shadows one away. Asking the parent — whose answer is
	// itself memoised — costs a walk of this Scope's own members instead of
	// every member of every Scope above it.
	let parentNamespaces =
		scope.parent === null
			? EMPTY_NAMESPACES
			: getAllNamespacesInScope(scope.parent, null)

	let amends = false

	for (let key in scope.members) {
		if (
			scope.members[key]!.type === "Namespace" ||
			parentNamespaces.has(key)
		) {
			amends = true

			break
		}
	}

	// NOTE: Most Scopes declare no Namespace and shadow none, so they share
	// their parent's answer *by identity* — which is what lets everything
	// derived from it, the candidate index below above all, be computed once
	// for a whole subtree instead of once per Scope.
	let result = amends ? new Map(parentNamespaces) : parentNamespaces

	if (amends) {
		for (let key in scope.members) {
			let value = scope.members[key]!

			if (value.type === "Namespace") {
				result.set(key, value)
			} else {
				result.delete(key)
			}
		}
	}

	namespacesInScopeCache.set(scope, {
		versions: scopeVersionSnapshot(scope),
		namespaces: result,
	})

	return result
}

// NOTE: The answer for a rootless Scope — shared so that it, too, is one
// identity rather than one per Scope.
const EMPTY_NAMESPACES: Map<string, common.NamespaceType> = new Map()

// NOTE: Method resolution asks "which of the visible Namespaces target this
// receiver?" once per invocation, and answered it by matching the receiver
// against every Namespace in Scope — linear in the size of the program, on
// every Method call in the program. `matchTypes` can only ever say yes to a
// pair whose Types have the same kind, plus three blanket cases (a Union
// target tries its members, an Unknown target accepts anything, a bindable
// Generic target binds anything), so bucketing the Namespaces by the kind
// they target lets a receiver skip every bucket that could not match it.
type IndexedNamespace = {
	order: number
	name: string
	namespace: common.NamespaceType
}

type NamespaceIndex = {
	// NOTE: Targets that can match a receiver of any kind, so every lookup
	// pays for them.
	always: Array<IndexedNamespace>
	byKind: Map<common.Type["type"], Array<IndexedNamespace>>
	// NOTE: A Record target matches only a receiver carrying every one of its
	// members, so it is filed under whichever of its member names is rarest
	// among the Record targets — the name that rules out the most Namespaces
	// for the fewest lookups.
	recordsByMember: Map<string, Array<IndexedNamespace>>
	// NOTE: `for {}` targets every Record, so no member name can file them.
	recordsWithoutMembers: Array<IndexedNamespace>
}

let namespaceIndexes = new WeakMap<
	Map<string, common.NamespaceType>,
	NamespaceIndex
>()

function pushInto<Key>(
	map: Map<Key, Array<IndexedNamespace>>,
	key: Key,
	entry: IndexedNamespace,
): void {
	let bucket = map.get(key)

	if (bucket === undefined) {
		map.set(key, [entry])
	} else {
		bucket.push(entry)
	}
}

function buildNamespaceIndex(
	namespaces: Map<string, common.NamespaceType>,
): NamespaceIndex {
	let index: NamespaceIndex = {
		always: [],
		byKind: new Map(),
		recordsByMember: new Map(),
		recordsWithoutMembers: [],
	}

	let entries: Array<IndexedNamespace> = []
	let memberCounts: Map<string, number> = new Map()
	let order = 0

	for (let [name, namespace] of namespaces) {
		let entry = { order: order++, name, namespace }

		entries.push(entry)

		if (namespace.targetType?.type === "Record") {
			for (let memberName in namespace.targetType.members) {
				memberCounts.set(
					memberName,
					(memberCounts.get(memberName) ?? 0) + 1,
				)
			}
		}
	}

	for (let entry of entries) {
		let targetType = entry.namespace.targetType

		// NOTE: A Namespace with no target Type is a Namespace of Static
		// Methods — never a Method receiver, so it is indexed nowhere.
		if (targetType === null || targetType === undefined) {
			continue
		}

		if (
			targetType.type === "UnionType" ||
			targetType.type === "Unknown" ||
			targetType.type === "GenericUse"
		) {
			index.always.push(entry)
		} else if (
			targetType.type === "List" ||
			targetType.type === "GenericList"
		) {
			// NOTE: The two List spellings match each other, so they share a
			// bucket rather than being told apart here.
			pushInto(index.byKind, "List", entry)
		} else if (targetType.type === "Record") {
			let rarest: string | null = null
			let rarestCount = Infinity

			for (let memberName in targetType.members) {
				let count = memberCounts.get(memberName) ?? 0

				if (count < rarestCount) {
					rarest = memberName
					rarestCount = count
				}
			}

			if (rarest === null) {
				index.recordsWithoutMembers.push(entry)
			} else {
				pushInto(index.recordsByMember, rarest, entry)
			}
		} else {
			pushInto(index.byKind, targetType.type, entry)
		}
	}

	return index
}

// NOTE: The Namespaces worth matching against `baseType`, in the order they
// are visible in — a superset of those that can match, never a subset, so the
// matching below decides exactly what it decided when it saw all of them.
function namespaceCandidatesFor(
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
): Array<IndexedNamespace> {
	let index = namespaceIndexes.get(namespaces)

	if (index === undefined) {
		index = buildNamespaceIndex(namespaces)
		namespaceIndexes.set(namespaces, index)
	}

	let candidates = index.always

	if (baseType.type === "Record") {
		candidates = candidates.concat(index.recordsWithoutMembers)

		for (let memberName in baseType.members) {
			let bucket = index.recordsByMember.get(memberName)

			if (bucket !== undefined) {
				candidates = candidates.concat(bucket)
			}
		}
	} else if (baseType.type === "List" || baseType.type === "GenericList") {
		candidates = candidates.concat(index.byKind.get("List") ?? [])
	} else {
		candidates = candidates.concat(index.byKind.get(baseType.type) ?? [])
	}

	return candidates.sort((lhs, rhs) => lhs.order - rhs.order)
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
			let conformanceName = conformanceParameterName(baseType.name)
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
	for (let { name, namespace } of namespaceCandidatesFor(
		namespaces,
		baseType,
	)) {
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
	reportUnknownDocumentationParameters(definition.documentation, [
		definition.parameters,
	])

	return definition.parameters.map((parameter) => ({
		name: parameter.externalName?.content ?? null,
		type: resolveDeclaredType(parameter.type, scope),
		documentation: parameterDocumentation(
			parameter,
			definition.documentation,
		),
	}))
}

// NOTE: A `@param` naming neither the external nor the internal name of any
// Parameter describes nothing. It attaches to nothing and is rendered into
// every Hover regardless — a description of a Parameter the reader then goes
// looking for and cannot find, which is the failure mode a rename leaves
// behind. The Warning is what makes it visible; the rendering is unchanged,
// since dropping the section would take the text away from the one person who
// can still fix it.
//
// `signatures` is a list rather than one Parameter list because a `§§` block
// above an `overload` keyword documents the set as a whole: a name any one of
// its Overloads takes is a name that exists. Each Overload's own block is
// checked against its own Parameters separately.
export function reportUnknownDocumentationParameters(
	documentation: common.Documentation | null | undefined,
	signatures: Array<Array<parser.ParameterNode>>,
): void {
	let tags = documentation?.parameterTags

	// NOTE: Absent both when the block writes no `@param` and when there is no
	// block to point at — a builtin Namespace documents itself in TypeScript,
	// and the standard library's Positions are stripped as it loads.
	if (tags === undefined) {
		return
	}

	let names: Array<string> = []

	for (let parameters of signatures) {
		for (let parameter of parameters) {
			// NOTE: A `_` label leaves the external name null, so only the
			// internal one can be written about. Both are collected in the
			// order `parameterDocumentation` looks them up.
			for (let name of [parameter.externalName, parameter.internalName]) {
				if (name !== null && !names.includes(name.content)) {
					names.push(name.content)
				}
			}
		}
	}

	for (let [written, tag] of Object.entries(tags)) {
		if (names.includes(written)) {
			continue
		}

		let suggestion = closestMatch(written, names)
		let notes = [
			names.length === 0
				? "A '§§' block documents whatever is declared below it. A '@param' belongs above something that takes Parameters — a Function, a Method, or a Declaration holding a Function literal."
				: "A '@param' is matched against each Parameter's external name first and then its internal one — 'startingWith initial: Result' is documented as '@param startingWith'.",
		]

		if (signatures.length > 1) {
			notes.push(
				"An 'overload' block's own Documentation may name a Parameter of any of its Overloads.",
			)
		}

		reportWarning(
			"This '@param' names a Parameter that does not exist",
			tag.position,
			{
				code: "unknown-documentation-parameter",
				labels: [
					primary(
						tag.position,
						names.length === 0
							? "what this documents takes no Parameters"
							: `no Parameter is named '${written}'`,
					),
				],
				notes,
				helps: [
					suggestion !== null
						? `Did you mean '${suggestion}'?`
						: names.length === 0
							? "Remove the tag — there is no Parameter for it to describe."
							: `The Parameters are '${names.join("', '")}'.`,
				],
			},
		)
	}
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

		// NOTE: An own property, because a Parameter may be named after a
		// member of `Object.prototype` — `toString`, `valueOf`, `constructor`.
		// Asked without the guard, a Parameter named `toString` is handed the
		// inherited native function as its description, which then reaches an
		// Editor as the Parameter's documentation.
		if (
			tagged !== undefined &&
			Object.hasOwn(documentation?.parameters ?? {}, name?.content ?? "")
		) {
			return tagged
		}
	}

	return undefined
}

// NOTE: Which Namespace Generics belong on one Method signature, ahead of the
// Method's own. A Namespace Generic is merged in only when the resolved
// signature — the injected `self` Parameter, the declared Parameters and the
// return Type — actually mentions it: a Generic nothing in the signature names
// could never be bound by inference at a call site, so carrying it would leave
// a phantom Type Parameter (and, under a `where` clause, a hidden conformance
// Parameter with nothing to prove it). A Method Generic of the same name
// shadows the Namespace one outright — the Method's own declaration wins,
// constraint, `infer` and default included, and it appears exactly once.
// The retained Namespace Generics keep their declaration order and LEAD the
// Method's own, because hidden conformance Parameters, witness Arguments and
// `boundConformance` conditions are all emitted in that order.
function mergeNamespaceGenerics(
	namespaceGenerics: Array<common.GenericDeclaration>,
	methodGenerics: Array<common.GenericDeclaration>,
	signature: {
		parameterTypes: Array<common.Parameter>
		returnType: common.Type
	},
): Array<common.GenericDeclaration> {
	if (namespaceGenerics.length === 0) {
		return methodGenerics
	}

	let shadowed = new Set(methodGenerics.map((generic) => generic.name))

	let signatureTypes = [
		...signature.parameterTypes.map((parameter) => parameter.type),
		signature.returnType,
	]

	let used = namespaceGenerics.filter(
		(generic) =>
			!shadowed.has(generic.name) &&
			signatureTypes.some((type) =>
				typeMentionsGeneric(type, generic.name),
			),
	)

	return [...used, ...methodGenerics]
}

// NOTE: One signature of a Namespace Method, in the shape resolution actually
// reads. A bodied Method and a body-less native signature differ only in
// whether a block follows — everything the Method's *Type* is made of
// (Generics, Parameters, return Type, documentation) is written the same way
// in both — so both are read through this and the resolution below never forks
// on nativeness.
type MethodSignatureEntry = {
	generics: Array<parser.GenericDeclarationNode>
	parameters: Array<parser.ParameterNode>
	returnType: parser.TypeDeclarationNode | null
	documentation: common.Documentation | null
	position: common.Position
	native: boolean
}

function methodSignatureEntry(
	node: parser.FunctionValueNode | parser.NativeMethodSignatureNode,
): MethodSignatureEntry {
	if (node.nodeType === "NativeMethodSignature") {
		return {
			generics: node.generics,
			parameters: node.parameters,
			returnType: node.returnType,
			documentation: node.documentation,
			position: node.position,
			native: true,
		}
	}

	return {
		generics: node.value.generics,
		parameters: node.value.parameters,
		returnType: node.value.returnType,
		documentation: node.value.documentation,
		// NOTE: The FunctionValue's Position, not the Definition's — it is what
		// the bodied path has always pointed its Diagnostics at.
		position: node.position,
		native: false,
	}
}

// NOTE: A Namespace Method reduced to the four shapes resolution
// distinguishes, with bodied and native entries already flattened into one
// list. An Overload block may MIX the two, so the list is per entry and keeps
// the WRITTEN ORDER — the index of an Overload is load-bearing, it picks the
// `__overload$N` name the Simplifier emits and the runtime export it binds to.
type NormalizedMethod = {
	kind: common.MethodType["type"]
	// NOTE: Exactly one entry for the two non-overloaded forms.
	entries: Array<MethodSignatureEntry>
	// NOTE: The `overload` block's own documentation, which the entries'
	// individual ones sit under. Always null for a non-overloaded Method.
	documentation: common.Documentation | null
}

function normalizeMethod(
	node: parser.NamespaceMethods[string],
): NormalizedMethod {
	switch (node.nodeType) {
		case "SimpleMethod":
			return {
				kind: "SimpleMethod",
				entries: [methodSignatureEntry(node.method)],
				documentation: null,
			}
		case "StaticMethod":
			return {
				kind: "StaticMethod",
				entries: [methodSignatureEntry(node.method)],
				documentation: null,
			}
		case "SimpleMethodSignature":
			return {
				kind: "SimpleMethod",
				entries: [methodSignatureEntry(node.signature)],
				documentation: null,
			}
		case "StaticMethodSignature":
			return {
				kind: "StaticMethod",
				entries: [methodSignatureEntry(node.signature)],
				documentation: null,
			}
		case "OverloadedMethod":
		case "OverloadedMethodSignatures":
			return {
				kind: "OverloadedMethod",
				entries: node.methods.map(methodSignatureEntry),
				documentation: node.documentation,
			}
		default:
			return {
				kind: "OverloadedStaticMethod",
				entries: node.methods.map(methodSignatureEntry),
				documentation: node.documentation,
			}
	}
}

// NOTE: Which entries of a Namespace Method are bound to the runtime rather
// than implemented in Essence, in written order — one flag for a
// non-overloaded Method, one per Overload otherwise. The standard library
// loader records these so that the runtime-export check knows which Methods it
// must find an implementation for, and which must NOT have one.
export function nativeMethodEntries(
	node: parser.NamespaceMethods[string],
): Array<boolean> {
	return normalizeMethod(node).entries.map((entry) => entry.native)
}

export function resolveMethodType(
	node: parser.NamespaceMethods[string],
	scope: enricher.Scope,
	selfType: common.Type | null,
	namespaceGenerics: Array<common.GenericDeclaration> = [],
): common.MethodType {
	let normalized = normalizeMethod(node)
	let isStatic =
		normalized.kind === "StaticMethod" ||
		normalized.kind === "OverloadedStaticMethod"

	if (!isStatic && selfType === null) {
		let message =
			"A Namespace without a target Type can only hold static Methods"

		if (normalized.kind === "SimpleMethod") {
			let position = normalized.entries[0]!.position

			reportError(message, position, {
				code: "untyped-namespace-method",
				labels: [primary(position, "this Method is not static")],
				helps: [
					"Give the Namespace a target Type with 'for …', or make the Method static.",
				],
			})
		} else {
			let helps = [
				"Give the Namespace a target Type with 'for …', or make the Methods static.",
			]
			let firstEntry = normalized.entries[0]

			if (firstEntry === undefined) {
				reportError(message, null, {
					code: "untyped-namespace-method",
					labels: [],
					helps,
				})
			} else {
				reportError(message, firstEntry.position, {
					code: "untyped-namespace-method",
					labels: [
						primary(
							firstEntry.position,
							"these overloads are not static",
						),
					],
					helps,
				})
			}
		}

		selfType = { type: "Error" }
	}

	// NOTE: The receiver Parameter every non-static signature is prefixed with.
	// Null exactly when the Method is static, which is when it is not injected.
	const receiverType: common.Type | null = isStatic ? null : selfType

	// NOTE: Resolved per entry — Overloads differ in what they mention, so each
	// gets the Namespace Generics its own signature actually uses. The Generics
	// are resolved BEFORE the signature, as the object literal this replaced
	// did: both report Diagnostics, and they are reported in the order the
	// Method reads.
	let resolveEntry = (entry: MethodSignatureEntry) => {
		let methodScope = scopeWithGenerics(entry.generics, scope)
		let entryGenerics = resolveGenericDeclarations(entry.generics, scope)

		let signature = {
			parameterTypes: [
				...(receiverType === null
					? []
					: [{ name: null, type: receiverType }]),
				...resolveParameterTypes(entry, methodScope),
			],
			returnType: resolveDeclaredType(entry.returnType, methodScope),
		}

		return {
			generics: mergeNamespaceGenerics(
				namespaceGenerics,
				entryGenerics,
				signature,
			),
			...signature,
			documentation: entry.documentation ?? undefined,
		}
	}

	if (normalized.kind === "SimpleMethod") {
		return { type: "SimpleMethod", ...resolveEntry(normalized.entries[0]!) }
	}

	if (normalized.kind === "StaticMethod") {
		return { type: "StaticMethod", ...resolveEntry(normalized.entries[0]!) }
	}

	reportUnknownDocumentationParameters(
		normalized.documentation,
		normalized.entries.map((entry) => entry.parameters),
	)

	return {
		type: normalized.kind,
		overloads: normalized.entries.map(resolveEntry),
		documentation: normalized.documentation ?? undefined,
	}
}
