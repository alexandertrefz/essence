import {
	collectDiagnostics,
	primary,
	reportError,
	secondary,
} from "../diagnostics/index"
import {
	applyGenericBindings,
	buildUnion,
	closestMatch,
	countOf,
	createInferenceContext,
	describeSignature,
	describeType,
	flattenUnionMembers,
	type GenericBindings,
	type MatchableArgument,
	matchArguments,
	matchesType,
	mergeUnionMembers,
	unionMembersKeepingNames,
	withArticle,
} from "../helpers/index"
import type { common, enricher, parser } from "../interfaces/index"
import {
	checkProtocolConformance,
	reportReservedTypeName,
	findTypeInScope,
	combinationTypeOf,
	invalidateNamespacesInScope,
	listItemTypeOf,
	lookupTypeOf,
	recordValueTypeOf,
	parameterDocumentation,
	resolveChoiceDeclarationStatementType,
	resolveConformances,
	resolveDeclaredType,
	resolveFunctionSignatureType,
	resolveGenericDeclarations,
	resolveIdentifierType,
	resolveMethodLookupNamespacesForReceiverType,
	resolveMethodType,
	resolveProtocolDeclarationStatementType,
	resolveSelfType,
	resolveType,
	resolveTypeAliasStatementType,
	scopeWithGenerics,
	suggestionHelps,
} from "./resolvers"
import { childScope } from "./scope"

// NOTE: Hoisting resolves each order-independent declaration's Type up front
// (see `hoistDeclarations`) and hands it back keyed by its Node. The in-order
// enrichment reuses that Type rather than resolving the same declaration a
// second time. A Node absent from the Map was not hoisted — it resolves in
// place, reporting its own Diagnostics.
export type HoistedTypes = Map<
	parser.ImplementationNode,
	common.Type | common.ProtocolType
>

export function enrichNode(
	node: parser.ImplementationNode,
	scope: enricher.Scope,
	hoistedTypes?: HoistedTypes,
): common.typed.ImplementationNode {
	switch (node.nodeType) {
		case "NativeFunctionInvocation":
		case "MethodInvocation":
		case "FunctionInvocation":
		case "Combination":
		case "RecordValue":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "NothingValue":
		case "FunctionValue":
		case "ListValue":
		case "Lookup":
		case "Identifier":
		case "Self":
		case "Match":
		case "CaseValue":
			return enrichExpression(node, scope)
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "NamespaceDefinitionStatement":
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "IfElseStatement":
		case "IfStatement":
		case "ReturnStatement":
		case "FunctionStatement":
			return enrichStatement(node, scope, hoistedTypes)
	}
}

// #region Expressions

// NOTE: `expectedType` is what the surrounding position wants the Expression
// to be — a Declaration's annotation, an Assignment's target, the declared
// return Type at a `<-`. Only bare Case Expressions consume it (they resolve
// against it before scanning the scope); everything else infers bottom-up.
export function enrichExpression(
	node: parser.ExpressionNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
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
		case "RationalValue":
			return enrichRationalValue(node, scope)
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
		case "CaseValue":
			return enrichCaseValue(node, scope, expectedType)
	}
}

export function enrichCaseValue(
	node: parser.CaseValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.CaseValueNode {
	let type = resolveCaseValueType(node, scope, expectedType)

	return {
		nodeType: "CaseValue",
		// NOTE: The Choice's name is a Type name, not a value — it is typed by
		// Type-scope lookup, so hovering it describes the Choice's Union.
		choice:
			node.choice === null
				? null
				: {
						nodeType: "Identifier",
						content: node.choice.content,
						position: node.choice.position,
						type: findTypeInScope(node.choice.content, scope) ?? {
							type: "Error",
						},
					},
		caseName: {
			nodeType: "Identifier",
			content: node.caseName.content,
			position: node.caseName.position,
			type,
		},
		value: node.value === null ? null : enrichExpression(node.value, scope),
		position: node.position,
		type,
	}
}

export function enrichNativeFunctionInvocation(
	node: parser.NativeFunctionInvocationNode,
	scope: enricher.Scope,
): common.typed.NativeFunctionInvocationNode {
	// NOTE: The name and every Argument are enriched exactly once — the typed
	// Nodes below and the Type resolution share them, rather than each walking
	// the same subtrees again.
	let typer = makeArgumentTyper(scope)
	let name = enrichIdentifier(node.name, scope)

	return {
		nodeType: "NativeFunctionInvocation",
		name,
		arguments: node.arguments.map((argument) =>
			typer.enrichArgumentNode(argument),
		),
		position: node.position,
		type: resolveNativeFunctionInvocationType(node, name.type, typer),
	}
}

export function enrichMethodInvocation(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): common.typed.MethodInvocationNode {
	// NOTE: The receiver is enriched once and its Type drives Method resolution
	// — the resolved Invocation reuses this same typed base. Each Argument is
	// likewise enriched once, by the typer, and reused for the final Node.
	let base = enrichExpression(node.base, scope)
	let typer = makeArgumentTyper(scope)
	let { namespace, type, overloadedMethodIndex, conformances, dispatch } =
		resolveMethodInvocation(node, base.type, scope, typer)

	return {
		nodeType: "MethodInvocation",
		base,
		member: {
			name: node.member.content,
			position: node.member.position,
		},
		arguments: node.arguments.map((argument) =>
			typer.enrichArgumentNode(argument),
		),
		position: node.position,
		namespace,
		type,
		overloadedMethodIndex,
		conformances,
		dispatch,
	}
}

export function enrichFunctionInvocation(
	node: parser.FunctionInvocationNode,
	scope: enricher.Scope,
): common.typed.FunctionInvocationNode {
	// NOTE: The callee and every Argument are enriched once — its Type drives
	// resolution and the same typed Nodes build the final Invocation.
	let name = enrichExpression(node.name, scope)
	let typer = makeArgumentTyper(scope)
	let { type, conformances } = resolveFunctionInvocation(
		node,
		name.type,
		scope,
		typer,
	)

	return {
		nodeType: "FunctionInvocation",
		name,
		arguments: node.arguments.map((argument) =>
			typer.enrichArgumentNode(argument),
		),
		position: node.position,
		type,
		overloadedMethodIndex: null,
		conformances,
	}
}

export function enrichCombination(
	node: parser.CombinationNode,
	scope: enricher.Scope,
): common.typed.CombinationNode {
	let lhs = enrichExpression(node.lhs, scope)
	let rhs = enrichExpression(node.rhs, scope)

	return {
		nodeType: "Combination",
		lhs,
		rhs,
		position: node.position,
		type: combinationTypeOf(
			lhs.type,
			rhs.type,
			node.lhs.position,
			node.rhs.position,
		),
	}
}

export function enrichMethodFunctionDefinition(
	method: parser.FunctionValueNode,
	scope: enricher.Scope,
	selfType: common.Type | null,
	// NOTE: The Method's already-resolved signature. Its Parameter and return
	// Types seed the typed Node so the annotations are resolved once — the
	// caller resolves the signature anyway, for the FunctionValue's own Type.
	signature: common.FunctionType,
	// NOTE: Constrained Namespace Generics threaded in for a conditional
	// conformance's fulfilling Method — bounded GenericUses in the body scope
	// (so it can call the Protocol's Methods on `Item` values), and leading the
	// typed Generics so their hidden conformance Parameters are emitted first.
	injectedGenerics: Array<common.typed.GenericDeclarationNode> = [],
): common.typed.FunctionDefinitionNode {
	// NOTE: `scope` and `selfType` already carry the injected bounds when this
	// is a fulfilling Method (the caller resolved the signature under them too),
	// so the body reads them consistently.
	// The Method's own Generics are registered as GenericUses so that Parameter
	// and Return Types as well as the body can reference them.
	let newScope = scopeWithGenerics(method.value.generics, scope)

	if (selfType !== null) {
		declareVariableInScope(
			"@",
			shadowSelfTypeGenerics(selfType, method.value.generics, newScope),
			newScope,
			true,
		)
	}

	// NOTE: Read from the signature before the body so that `<-` Expressions can
	// consult it — a bare Case resolves against the declared return Type first.
	let returnType = signature.returnType
	newScope.expectedReturnType = returnType

	return {
		nodeType: "FunctionDefinition",
		generics: [
			...injectedGenerics,
			...method.value.generics.map((generic) =>
				enrichGenericDeclarationNode(generic, scope),
			),
		],
		parameters: method.value.parameters.map((parameter, index) =>
			enrichParameter(
				parameter,
				newScope,
				signature.parameterTypes[index],
			),
		),
		body: method.value.body.map((node) => enrichNode(node, newScope)),
		returnType,
		// NOTE: A Method always writes its annotations — the Parser only
		// allows omitting them for a literal in expression position.
		inferredReturnType: null,
		parameterListPosition: method.value.parameterListPosition,
	}
}

// NOTE: A Method Generic SHADOWS a Namespace Generic of the same name — see
// `List.sorted<infer ItemType is Comparable>`, declared on a Namespace that
// already has an unbounded `ItemType`. The Method's Parameter and return Types
// are resolved in a Scope where the name is the Method's, so `@` has to agree:
// the receiver of `sorted` is a List of the BOUNDED ItemType, which is what
// lets `first::compareTo(second)` in the body resolve through the bound and
// reach the hidden conformance Argument. Left unshadowed, `@` would carry the
// Namespace's opaque Generic, an item read off it would have no bound, and the
// body could call nothing on it.
//
// This is the same substitution `withInjectedBounds` performs for a conditional
// conformance's injected Namespace Generics, applied to the Generics a Method
// declares for itself. Both are needed and neither subsumes the other: the
// injected ones are Namespace Generics the Method never names, these are names
// the Method takes over.
function shadowSelfTypeGenerics(
	selfType: common.Type,
	generics: Array<parser.GenericDeclarationNode>,
	scope: enricher.Scope,
): common.Type {
	if (generics.length === 0) {
		return selfType
	}

	// NOTE: Read back out of the Scope the Method's Generics were just
	// registered in, rather than rebuilt here, so the shadowing `@` sees is the
	// same object its Parameter Types see.
	let bindings: GenericBindings = new Map(
		generics.flatMap((generic) => {
			let shadowing = scope.types[generic.name.content]

			return shadowing === undefined
				? []
				: [[generic.name.content, shadowing] as const]
		}),
	)

	return applyGenericBindings(selfType, bindings)
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
		inferred: node.inferred,
		constraint: node.constraint?.content ?? null,
		position: node.position,
	}
}

export function enrichFunctionDefinition(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.typed.FunctionDefinitionNode {
	// NOTE: Declared Generics are registered as GenericUses so that
	// Parameter and Return Types can reference them. They stay opaque
	// within the body; binding to concrete Types happens at each use site
	// via Generic Inference.
	let newScope = scopeWithGenerics(node.generics, scope)

	// NOTE: A literal that omitted its annotations was already resolved
	// against the expected signature while the invocation was matched; this
	// pass reads that back rather than re-deriving it, because here the
	// expected Type is gone.
	let contextualType = contextualFunctionTypeOf(node, scope)

	// NOTE: Resolved before the body so that `<-` Expressions can consult it
	// — a bare Case resolves against the declared return Type first.
	let returnType =
		contextualType?.returnType ??
		(node.returnType === null
			? { type: "Error" as const }
			: resolveType(node.returnType, newScope))

	newScope.expectedReturnType = returnType

	return {
		nodeType: "FunctionDefinition",
		parameters: node.parameters.map((parameter, index) =>
			enrichParameter(
				parameter,
				newScope,
				contextualType?.parameterTypes[index],
			),
		),
		generics: node.generics.map((generic) =>
			enrichGenericDeclarationNode(generic, scope),
		),
		body: node.body.map((node) => enrichNode(node, newScope)),
		returnType,
		inferredReturnType: node.returnType === null ? returnType : null,
		parameterListPosition: node.parameterListPosition,
	}
}

// NOTE: A Scope in which the injected Namespace Generics are their bounded
// GenericUses, so a fulfilling Method's signature and body resolve `Item` with
// its `where` bound — and the corresponding constraint-carrying selfType, so a
// Protocol-Method call on `@`'s members resolves through that bound too.
function withInjectedBounds(
	scope: enricher.Scope,
	selfType: common.Type | null,
	injectedGenerics: Array<common.typed.GenericDeclarationNode>,
): { scope: enricher.Scope; selfType: common.Type | null } {
	if (injectedGenerics.length === 0) {
		return { scope, selfType }
	}

	let boundedUses = injectedGenerics.map(
		(generic): common.GenericUse => ({
			type: "GenericUse",
			name: generic.name,
			...(generic.constraint !== null
				? { constraint: generic.constraint }
				: {}),
		}),
	)

	let boundedScope = childScope(scope, {
		types: Object.fromEntries(boundedUses.map((use) => [use.name, use])),
	})

	let bindings = new Map(boundedUses.map((use) => [use.name, use]))

	return {
		scope: boundedScope,
		selfType:
			selfType === null
				? null
				: applyGenericBindings(selfType, bindings),
	}
}

export function enrichMethodFunctionValue(
	node: parser.SimpleMethod | parser.StaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
	injectedGenerics: Array<common.typed.GenericDeclarationNode> = [],
): common.typed.FunctionValueNode {
	let bounded = withInjectedBounds(scope, selfType, injectedGenerics)

	// NOTE: The signature is resolved once and seeds the body enrichment, so the
	// Method's annotations are walked once rather than once here and once again
	// inside the definition.
	let type = resolveFunctionValueType(node.method, bounded.scope)

	return {
		nodeType: "FunctionValue",
		value: enrichMethodFunctionDefinition(
			node.method,
			bounded.scope,
			bounded.selfType,
			type,
			injectedGenerics,
		),
		position: node.method.position,
		type,
	}
}

export function enrichMethodsFunctionValue(
	node: parser.OverloadedMethod | parser.OverloadedStaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
	// NOTE: One list per Overload — an Overload's woven Generics are exactly
	// the ones its own entry in the resolved Method Type retained, so the two
	// views can not drift apart.
	injectedGenerics: Array<Array<common.typed.GenericDeclarationNode>> = [],
): Array<common.typed.FunctionValueNode> {
	let results: Array<common.typed.FunctionValueNode> = []

	for (let [index, method] of Object.values(node.methods).entries()) {
		let injected = injectedGenerics[index] ?? []
		let bounded = withInjectedBounds(scope, selfType, injected)
		let type = resolveFunctionValueType(method, bounded.scope)

		results.push({
			nodeType: "FunctionValue",
			value: enrichMethodFunctionDefinition(
				method,
				bounded.scope,
				bounded.selfType,
				type,
				injected,
			),
			position: method.position,
			type,
		})
	}

	return results
}

export function enrichRecordValue(
	node: parser.RecordValueNode,
	scope: enricher.Scope,
): common.typed.RecordValueNode {
	// NOTE: The annotation is resolved once here and handed to the core, which
	// is the single place that reports 'record-annotation-not-record'. The
	// enriched Record is reused wherever its Type is wanted — as an Argument the
	// invocation's typer caches it — so the annotation is not resolved again.
	let resolvedAnnotation =
		node.type !== null ? resolveType(node.type, scope) : null

	let members = enrichMembers(node.members, scope)

	let memberTypes: Record<string, common.Type> = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		memberTypes[memberKey] = memberValue.type
	}

	return {
		nodeType: "RecordValue",
		members,
		position: node.position,
		type: recordValueTypeOf(
			resolvedAnnotation,
			memberTypes,
			node.type?.position ?? null,
		),
		// NOTE: A valid Record annotation is the declared Type; anything else
		// (a non-Record annotation, an Error, or none) leaves it null.
		declaredType:
			resolvedAnnotation !== null && resolvedAnnotation.type === "Record"
				? resolvedAnnotation
				: null,
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

export function enrichRationalValue(
	node: parser.RationalValueNode,
	_scope: enricher.Scope,
): common.typed.RationalValueNode {
	return {
		nodeType: "RationalValue",
		numerator: node.numerator,
		denominator: node.denominator,
		position: node.position,
		type: { type: "Rational" },
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
	return {
		nodeType: "FunctionValue",
		value: enrichFunctionDefinition(node.value, scope),
		position: node.position,
		type: resolveFunctionValueType(node, scope),
	}
}

export function enrichListValue(
	node: parser.ListValueNode,
	scope: enricher.Scope,
): common.typed.ListValueNode {
	let values = node.values.map((expr) => enrichExpression(expr, scope))

	return {
		nodeType: "ListValue",
		values,
		position: node.position,
		type: {
			type: "List",
			itemType: listItemTypeOf(values.map((value) => value.type)),
		},
	}
}

export function enrichLookup(
	node: parser.LookupNode,
	scope: enricher.Scope,
): common.typed.LookupNode {
	let base = enrichExpression(node.base, scope)
	// NOTE: The Lookup and its member Identifier share one Type — the member's
	// Type *is* the Lookup's Type, so it is resolved once and handed to both.
	let type = lookupTypeOf(base.type, node.member.content, {
		member: node.member.position,
		base: node.base.position,
	})

	return {
		nodeType: "Lookup",
		base,
		member: {
			nodeType: "Identifier",
			content: node.member.content,
			position: node.member.position,
			type,
		},
		position: node.position,
		type,
	}
}

export function enrichIdentifier(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	type: common.Type = resolveIdentifierType(node, scope),
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
	type: common.Type = resolveSelfType(node, scope),
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

// NOTE: A wildcard Handler stands for whatever the Handlers before it have not
// already caught, so it resolves to the Union of the still-unhandled members.
// That is what lets `@` inside `case _` keep the matched Union's own member
// Type instead of degrading to Unknown — `case Nothing` followed by `case _`
// types `@` as the non-Nothing member. A wildcard with nothing left to catch
// falls back to Unknown, which matches anything, so a redundant `case _` stays
// harmless rather than becoming un-typeable.
function resolveWildcardMatcherType(
	valueType: common.Type,
	handledMatchers: Array<common.Type>,
): common.Type {
	let isHandled = (memberType: common.Type) =>
		handledMatchers.some((handledMatcher) =>
			matchesType(handledMatcher, memberType),
		)

	if (valueType.type !== "UnionType") {
		return isHandled(valueType) ? { type: "Unknown" } : valueType
	}

	// NOTE: Handling is checked member by member for the same reason the
	// Validator's exhaustiveness check flattens — but a named nested Union
	// (`Number`, a Choice) whose members are all still unhandled stays whole,
	// so `@` Hovers print its name. Once a Handler has taken some of its
	// members, only the remaining ones survive, and those are necessarily
	// spelled out.
	let remainingTypes: Array<common.Type> = []

	for (let memberType of unionMembersKeepingNames(valueType)) {
		if (memberType.type === "UnionType") {
			let flattened = flattenUnionMembers(memberType)
			let remaining = flattened.filter((member) => !isHandled(member))

			if (remaining.length === flattened.length) {
				remainingTypes.push(memberType)
			} else {
				remainingTypes.push(...remaining)
			}
		} else if (!isHandled(memberType)) {
			remainingTypes.push(memberType)
		}
	}

	if (remainingTypes.length === 0) {
		return { type: "Unknown" }
	}

	if (remainingTypes.length === 1) {
		return remainingTypes[0]
	}

	return buildUnion(remainingTypes)
}

export function enrichMatch(
	node: parser.MatchNode,
	scope: enricher.Scope,
): common.typed.MatchNode {
	let value = enrichExpression(node.value, scope)
	let returnType = resolveType(node.returnType, scope)
	let handledMatchers: Array<common.Type> = []

	return {
		nodeType: "Match",
		value,
		handlers: node.handlers.map((handler) => {
			// NOTE: `expectedReturnType` is what a Handler's `<-` yields — a
			// bare Case there resolves against the Match's declared return
			// Type first.
			let bodyScope = childScope(scope, {
				expectedReturnType: returnType,
			})

			let literal: common.typed.ExpressionNode | null = null
			let memberLiterals: Record<
				string,
				common.typed.ExpressionNode
			> | null = null
			let matcher: common.Type

			if (handler.matcher.nodeType === "LiteralMatcher") {
				// NOTE: A literal Matcher binds `@` to the literal's own Type —
				// inside `case 0` the value is known to be an Integer.
				literal = enrichExpression(handler.matcher.value, scope)
				matcher = literal.type
			} else if (handler.matcher.nodeType === "WildcardMatcher") {
				matcher = resolveWildcardMatcherType(
					value.type,
					handledMatchers,
				)
			} else if (handler.matcher.nodeType === "CaseMatcher") {
				matcher = resolveCaseMatcherType(
					handler.matcher,
					value.type,
					scope,
				)
			} else if (handler.matcher.nodeType === "RecordMatcher") {
				// NOTE: Both kinds of member contribute a Type, so `@` is a
				// Record either way and `@.name` works inside the Handler — a
				// value-constrained member simply takes its literal's Type.
				let members: Record<string, common.Type> = {}
				let literals: Record<string, common.typed.ExpressionNode> = {}

				for (let [name, member] of Object.entries(
					handler.matcher.members,
				)) {
					if (member.kind === "Value") {
						let enrichedValue = enrichExpression(
							member.value,
							scope,
						)

						literals[name] = enrichedValue
						members[name] = enrichedValue.type
					} else {
						members[name] = resolveType(member.type, scope)
					}
				}

				matcher = { type: "Record", members }
				memberLiterals =
					Object.keys(literals).length > 0 ? literals : null
			} else {
				matcher = resolveType(handler.matcher, scope)
			}

			// NOTE: Only an unconditional Handler retires a Type. A literal
			// Matcher, a value-constrained Record member or a Guard can all
			// decline a value whose Type they accepted, so a later wildcard
			// still has to account for that Type.
			if (
				literal === null &&
				memberLiterals === null &&
				handler.guard === null
			) {
				handledMatchers.push(matcher)
			}

			declareVariableInScope("@", matcher, bodyScope, true)

			// NOTE: The Guard is enriched in the body Scope so that it can use
			// `@` — narrowing is what makes a Guard worth writing.
			let guard =
				handler.guard === null
					? null
					: enrichExpression(handler.guard, bodyScope)

			return {
				body: handler.body.map((node) => enrichNode(node, bodyScope)),
				literal,
				memberLiterals,
				guard,
				matcher,
				matcherPosition: handler.matcher.position,
			}
		}),
		position: node.position,
		type: returnType,
	}
}

// #endregion

// #region Statements

export function enrichStatement(
	node: parser.StatementNode,
	scope: enricher.Scope,
	hoistedTypes?: HoistedTypes,
): common.typed.StatementNode {
	// NOTE: A hoisted declaration's Type is already resolved and in scope — the
	// enrichment reuses it rather than resolving the same Node again. The cast
	// is sound because the Map is keyed by Node and each entry was produced by
	// the very resolver the matching case reuses it in.
	let hoistedType = hoistedTypes?.get(node)

	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
			return enrichConstantDeclarationStatement(node, scope)
		case "VariableDeclarationStatement":
			return enrichVariableDeclarationStatement(node, scope)
		case "VariableAssignmentStatement":
			return enrichVariableAssignmentStatement(node, scope)
		case "NamespaceDefinitionStatement":
			return enrichNamespaceDefinitionStatement(
				node,
				scope,
				hoistedType as common.NamespaceType | undefined,
			)
		case "ProtocolDeclarationStatement":
			return enrichProtocolDeclarationStatement(
				node,
				scope,
				hoistedType as common.ProtocolType | undefined,
			)
		case "TypeAliasStatement":
			return enrichTypeAliasStatement(
				node,
				scope,
				hoistedType as common.Type | undefined,
			)
		case "ChoiceDeclarationStatement":
			return enrichChoiceDeclarationStatement(
				node,
				scope,
				hoistedType as common.UnionType | undefined,
			)
		case "IfElseStatement":
			return enrichIfElseStatementNode(node, scope)
		case "IfStatement":
			return enrichIfStatement(node, scope)
		case "ReturnStatement":
			return enrichReturnStatement(node, scope)
		case "FunctionStatement":
			return enrichFunctionStatement(
				node,
				scope,
				hoistedType as common.FunctionType | undefined,
			)
	}
}

export function enrichConstantDeclarationStatement(
	node: parser.ConstantDeclarationStatementNode,
	scope: enricher.Scope,
): common.typed.ConstantDeclarationStatementNode {
	// NOTE: The annotation is the value's expected Type — a bare Case in the
	// value resolves against it before the scope scan.
	let declaredType = node.type !== null ? resolveType(node.type, scope) : null
	let value = enrichExpression(node.value, scope, declaredType)

	declareVariableInScope(node.name, declaredType ?? value.type, scope, true)

	return {
		nodeType: "ConstantDeclarationStatement",
		name: enrichIdentifier(node.name, scope),
		value,
		position: node.position,
		type: value.type,
		declaredType,
		documentation: node.documentation,
	}
}

export function enrichVariableDeclarationStatement(
	node: parser.VariableDeclarationStatementNode,
	scope: enricher.Scope,
): common.typed.VariableDeclarationStatementNode {
	// NOTE: The annotation is the value's expected Type — a bare Case in the
	// value resolves against it before the scope scan.
	let declaredType = node.type !== null ? resolveType(node.type, scope) : null
	let value = enrichExpression(node.value, scope, declaredType)

	declareVariableInScope(node.name, declaredType ?? value.type, scope)

	return {
		nodeType: "VariableDeclarationStatement",
		name: enrichIdentifier(node.name, scope, value.type),
		value,
		position: node.position,
		type: value.type,
		declaredType,
		documentation: node.documentation,
	}
}

export function enrichVariableAssignmentStatement(
	node: parser.VariableAssignmentStatementNode,
	scope: enricher.Scope,
): common.typed.VariableAssignmentStatementNode {
	let declaringScope = findDeclaringScope(node.name.content, scope)

	let declarationPosition =
		declaringScope?.declarations[node.name.content] ?? null

	if (declaringScope?.constants.has(node.name.content)) {
		reportError(
			`'${node.name.content}' can not be reassigned`,
			node.name.position,
			{
				code: "constant-reassignment",
				labels: [
					primary(node.name.position, "assigned to here"),
					...(declarationPosition === null
						? []
						: [
								secondary(
									declarationPosition,
									"declared as a Constant here",
								),
							]),
				],
				helps: [
					"Declare it with 'variable' instead of 'constant' if it needs to change.",
				],
			},
		)
	}

	let name = enrichIdentifier(node.name, scope)

	return {
		nodeType: "VariableAssignmentStatement",
		name,
		// NOTE: The target Variable's Type is the value's expected Type — a
		// bare Case in the value resolves against it before the scope scan.
		value: enrichExpression(node.value, scope, name.type),
		declarationPosition,
		position: node.position,
	}
}

export function enrichNamespaceDefinitionStatement(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.NamespaceType,
): common.typed.NamespaceDefinitionStatementNode {
	function enrichProperties(
		properties: Record<string, parser.NamespacePropertyNode>,
		scope: enricher.Scope,
	): Record<string, common.typed.NamespaceProperty> {
		let result: Record<string, common.typed.NamespaceProperty> = {}

		for (let [propertyKey, propertyValue] of Object.entries(properties)) {
			// NOTE: A native static Property has no value to enrich, so there
			// is nothing for a typed Node to hold — it is in the Namespace
			// Type (that is what resolution reads) but not in the typed tree
			// the Rewriter emits from, exactly like a native Method.
			if (propertyValue.value === null) {
				continue
			}

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

			result[propertyKey] = {
				// NOTE: As with a Method, the name is a typed Identifier of
				// its own so that the cursor can land on it.
				name: {
					nodeType: "Identifier",
					content: propertyKey,
					position: propertyValue.name.position,
					type,
				},
				type,
				value,
				documentation: propertyValue.documentation,
			}
		}

		return result
	}

	// NOTE: When hoisted, the Namespace Type is reused from the hoist pass —
	// resolving it re-enriches every property value, so skipping that here is
	// the win. A non-hoisted Namespace (nested, or one that could not hoist)
	// still resolves in place.
	let type =
		hoistedType ?? resolveNamespaceDefinitionStatementType(node, scope)

	if (hoistedType === undefined) {
		declareVariableInScope(node.name, type, scope, true)
	}

	let checkedConformances = checkProtocolConformance(node, type, scope)

	// NOTE: A bound on a Namespace's own Type Parameter is still rejected — a
	// conditional conformance (`is Comparable where Item is Comparable`) is
	// where a Namespace-level bound belongs, so its conformance parameter can
	// be threaded into exactly the fulfilling Methods rather than all of them.
	for (let generic of node.generics) {
		if (generic.constraint !== null) {
			reportError(
				"A Namespace's Type Parameters can not carry Protocol bounds",
				generic.constraint.position,
				{
					code: "protocol-bound-namespace-generic",
					labels: [
						primary(
							generic.constraint.position,
							"this bound is not supported here",
						),
					],
					helps: [
						`Bound it per conformance: 'is ${generic.constraint.content} where ${generic.name.content} is ${generic.constraint.content}'.`,
					],
				},
			)
		}
	}

	// NOTE: Which Namespace Generic each fulfilling Method must treat as bound,
	// gathered from every conditional conformance clause. A Method fulfilling
	// two clauses that bound the same Generic to different Protocols is a
	// conflict — one hidden conformance Parameter can not be two things.
	let methodBounds = new Map<string, Map<string, string>>()

	for (let conformance of checkedConformances) {
		if (conformance.conditions.length === 0) {
			continue
		}

		// NOTE: The map's VALUES are the fulfilling Methods' emitted names; an
		// overloaded fulfiller carries a `__overload$N` suffix, stripped here
		// to recover the Namespace Method's own name.
		let fulfillingMethods = new Set(
			Object.values(conformance.methodMap).map((emittedName) =>
				emittedName.replace(/__overload\$\d+$/, ""),
			),
		)

		for (let methodName of fulfillingMethods) {
			let bounds = methodBounds.get(methodName)

			if (bounds === undefined) {
				bounds = new Map()
				methodBounds.set(methodName, bounds)
			}

			for (let condition of conformance.conditions) {
				let existing = bounds.get(condition.generic)

				if (existing !== undefined && existing !== condition.protocol) {
					let clause = node.conformsTo.find(
						(candidate) =>
							candidate.protocol.content ===
							conformance.protocolName,
					)

					reportError(
						`Method '${methodName}' can not satisfy conflicting conformance conditions`,
						clause?.position ?? node.name.position,
						{
							code: "conflicting-where-condition",
							labels: [
								primary(
									clause?.position ?? node.name.position,
									`Method '${methodName}' would need both '${condition.generic} is ${existing}' and '${condition.generic} is ${condition.protocol}'`,
								),
							],
						},
					)

					continue
				}

				bounds.set(condition.generic, condition.protocol)
			}
		}
	}

	// NOTE: The constrained Namespace Generics to weave into each fulfilling
	// Method, as typed Generic Declarations, ONE LIST PER OVERLOAD (a
	// non-overloaded Method has exactly one). They lead the Method's own
	// Generics so `simplifyFunctionDefinition` emits their hidden conformance
	// Parameters first, in Namespace declaration order.
	//
	// INVARIANT (the three views of a Method's Type Parameters must agree, per
	// Overload): the resolved Method Type, the typed Node the Rewriter emits
	// from, and the witnesses `$type.boundConformance` curries onto a
	// conformance value are all derived from ONE retained list. A Namespace
	// Generic is retained on an Overload when its signature mentions it OR when
	// a conditional conformance this Method fulfils bounds it — the latter is
	// what makes the hidden conformance Parameter honest, because
	// `boundConformance` curries a witness for every `where` condition onto
	// EVERY fulfilling Method uniformly, whatever each Overload happens to
	// mention. Pruning a bound Generic from one Overload would leave that
	// Overload's emitted signature and its call sites disagreeing about how
	// many hidden Arguments there are.
	//
	// NOTE: A NATIVE Method has only TWO of those three views — there is no
	// typed Node, because there is no body to emit. The retention below still
	// runs over it (it is keyed off the parser Node, which exists either way),
	// so its resolved Method Type carries the bound Namespace Generics exactly
	// as a bodied one does; the typed-Node half is simply absent, and
	// `enrichMethods` drops the corresponding injected list on the floor. That
	// is the whole difference: the Type view and the witness view still agree,
	// which is what call sites and `boundConformance` read.
	let injectedGenerics = new Map<
		string,
		Array<Array<common.typed.GenericDeclarationNode>>
	>()

	for (let [methodName, bounds] of methodBounds) {
		let methodNode = node.methods[methodName]
		let methodType = type.methods[methodName]

		if (methodNode === undefined || methodType === undefined) {
			continue
		}

		// NOTE: The Generics each form declares for itself, per Overload — what
		// tells a retained Namespace Generic apart from a Method Generic that
		// shadows its name, which no amount of inspecting the merged list can.
		let ownGenerics = ownGenericNames(methodNode)

		// NOTE: Force the bound Namespace Generics back onto every Overload the
		// signature-driven merge pruned them from, and retrofit the bound onto
		// the entries that survived — on fresh Generic objects, so the shared
		// unbounded Namespace Generics (and every other Method) stay untouched.
		// Idempotent: re-running retains and bounds exactly the same set.
		methodType = retainNamespaceBounds(
			methodType,
			ownGenerics,
			bounds,
			type.generics,
		)

		type.methods[methodName] = methodType

		// NOTE: The typed Node's Generics are READ BACK OFF the retained Type,
		// per Overload, rather than derived a second way — that is what keeps
		// the two views in step by construction.
		let retained =
			methodType.type === "SimpleMethod" ||
			methodType.type === "StaticMethod"
				? [methodType.generics]
				: methodType.overloads.map((overload) => overload.generics)

		let injected = retained.map((generics, index) =>
			node.generics
				.filter(
					(generic) =>
						bounds.has(generic.name.content) &&
						!(ownGenerics[index] ?? new Set()).has(
							generic.name.content,
						) &&
						generics.some(
							(candidate) =>
								candidate.name === generic.name.content,
						),
				)
				.map(
					(generic): common.typed.GenericDeclarationNode => ({
						nodeType: "GenericDeclaration",
						name: generic.name.content,
						inferred: generic.inferred,
						defaultType: generic.defaultType
							? resolveType(generic.defaultType, scope)
							: null,
						constraint: bounds.get(generic.name.content)!,
						position: generic.position,
					}),
				),
		)

		if (injected.some((list) => list.length > 0)) {
			injectedGenerics.set(methodName, injected)
		}
	}

	// NOTE: Namespace Generics are visible in every Method — bodies reference
	// them as opaque GenericUses.
	let methodScope = scopeWithGenerics(node.generics, scope)

	return {
		nodeType: "NamespaceDefinitionStatement",
		targetType: type.targetType,
		conformsTo: node.conformsTo.map((clause) => ({
			name: clause.protocol.content,
			position: clause.protocol.position,
			conditions: clause.conditions.map((condition) => ({
				generic: condition.generic.content,
				protocol: condition.protocol.content,
			})),
		})),
		name: enrichIdentifier(node.name, scope),
		properties: enrichProperties(node.properties, scope),
		methods: enrichMethods(
			node.methods,
			methodScope,
			type.targetType,
			type.methods,
			injectedGenerics,
		),
		position: node.position,
		type,
		documentation: node.documentation,
	}
}

// NOTE: The Type Parameter names each form of a Namespace Method declares for
// ITSELF, one Set per Overload. A Method Generic shadows a Namespace Generic of
// the same name, and once the two are merged into one list the entry no longer
// says which it came from — this is what remembers.
function ownGenericNames(
	method: parser.NamespaceMethods[string],
): Array<Set<string>> {
	let namesOf = (generics: Array<parser.GenericDeclarationNode>) =>
		new Set(generics.map((generic) => generic.name.content))

	if (
		method.nodeType === "SimpleMethod" ||
		method.nodeType === "StaticMethod"
	) {
		return [namesOf(method.method.value.generics)]
	}

	if (
		method.nodeType === "SimpleMethodSignature" ||
		method.nodeType === "StaticMethodSignature"
	) {
		return [namesOf(method.signature.generics)]
	}

	return method.methods.map((overload) =>
		namesOf(
			overload.nodeType === "NativeMethodSignature"
				? overload.generics
				: overload.value.generics,
		),
	)
}

// NOTE: Returns a copy of a Method Type whose every Overload carries the bound
// Namespace Generics — re-adding the ones the signature-driven merge pruned
// because that Overload's signature never mentions them, and retrofitting the
// bound onto the ones that survived. A conditional conformance's witnesses are
// curried onto every fulfilling Method uniformly, so an Overload that drops one
// would emit a signature its call sites do not agree with; retaining them is
// what keeps the arity honest (and, as at HEAD, is what makes an unbindable
// Type Parameter the reportable error it should be).
// Fresh Generic objects throughout, so the shared unbounded Namespace Generics
// are never mutated. Idempotent: re-running retains and bounds the same set.
function retainNamespaceBounds(
	method: common.MethodType,
	ownGenerics: Array<Set<string>>,
	bounds: Map<string, string>,
	namespaceGenerics: Array<common.GenericDeclaration>,
): common.MethodType {
	let apply = (
		generics: Array<common.GenericDeclaration>,
		own: Set<string>,
	): Array<common.GenericDeclaration> => {
		let leading: Array<common.GenericDeclaration> = []

		for (let namespaceGeneric of namespaceGenerics) {
			// NOTE: A Method Generic of the same name shadows this one
			// outright — it is the Method's entry that is in the list, and
			// re-adding would duplicate the name.
			if (own.has(namespaceGeneric.name)) {
				continue
			}

			let existing = generics.find(
				(generic) => generic.name === namespaceGeneric.name,
			)
			let constraint = bounds.get(namespaceGeneric.name)

			if (existing === undefined && constraint === undefined) {
				continue
			}

			let base = existing ?? namespaceGeneric

			leading.push(
				constraint === undefined ? base : { ...base, constraint },
			)
		}

		return [
			...leading,
			...generics.filter((generic) => own.has(generic.name)),
		]
	}

	if (method.type === "SimpleMethod" || method.type === "StaticMethod") {
		return {
			...method,
			generics: apply(method.generics, ownGenerics[0] ?? new Set()),
		}
	}

	return {
		...method,
		overloads: method.overloads.map((overload, index) => ({
			...overload,
			generics: apply(overload.generics, ownGenerics[index] ?? new Set()),
		})),
	}
}

export function enrichProtocolDeclarationStatement(
	node: parser.ProtocolDeclarationStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.ProtocolType,
): common.typed.ProtocolDeclarationStatementNode {
	let protocolType =
		hoistedType ?? resolveProtocolDeclarationStatementType(node, scope)

	if (hoistedType === undefined) {
		declareProtocolInScope(node.name, protocolType, scope)
	}

	return {
		nodeType: "ProtocolDeclarationStatement",
		// NOTE: A Protocol is not a Type, so its name carries no Type of its
		// own — Unknown, rather than misleadingly borrowing one.
		name: enrichIdentifier(node.name, scope, { type: "Unknown" }),
		protocolType,
		position: node.position,
		documentation: node.documentation,
	}
}

export function enrichTypeAliasStatement(
	node: parser.TypeAliasStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.Type,
): common.typed.TypeAliasStatementNode {
	let type = hoistedType ?? resolveTypeAliasStatementType(node, scope)

	if (hoistedType === undefined) {
		declareTypeInScope(node.name, type, scope)
	}

	return {
		nodeType: "TypeAliasStatement",
		name: enrichIdentifier(node.name, scope, type),
		type,
		position: node.position,
		documentation: node.documentation,
	}
}

export function enrichChoiceDeclarationStatement(
	node: parser.ChoiceDeclarationStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.UnionType,
): common.typed.ChoiceDeclarationStatementNode {
	let type = hoistedType ?? resolveChoiceDeclarationStatementType(node, scope)

	if (hoistedType === undefined) {
		declareTypeInScope(node.name, type, scope)
	}

	let caseTypes = type.types.filter(
		(member): member is common.CaseType => member.type === "Case",
	)

	return {
		nodeType: "ChoiceDeclarationStatement",
		name: enrichIdentifier(node.name, scope, type),
		// NOTE: A duplicate Case was already diagnosed and dropped from the
		// Union — its name Identifier borrows the surviving Case's Type so the
		// typed tree stays complete.
		cases: node.cases.map((choiceCase) => {
			let caseType = caseTypes.find(
				(candidate) => candidate.name === choiceCase.name.content,
			) ?? {
				type: "Case" as const,
				choice: node.name.content,
				name: choiceCase.name.content,
				members: {},
			}

			return {
				name: {
					nodeType: "Identifier" as const,
					content: choiceCase.name.content,
					position: choiceCase.name.position,
					type: caseType,
				},
				type: caseType,
			}
		}),
		type,
		position: node.position,
		documentation: node.documentation,
	}
}

export function enrichIfElseStatementNode(
	node: parser.IfElseStatementNode,
	scope: enricher.Scope,
): common.typed.IfElseStatementNode {
	let trueScope = childScope(scope)
	let falseScope = childScope(scope)

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
	let bodyScope = childScope(scope)

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
		// NOTE: The nearest declared return Type is the expected Type — the
		// enclosing Function's, or the Match's for a Handler body.
		expression: enrichExpression(
			node.expression,
			scope,
			findExpectedReturnType(scope),
		),
		position: node.position,
	}
}

function findExpectedReturnType(scope: enricher.Scope): common.Type | null {
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		if (searchScope.expectedReturnType !== undefined) {
			return searchScope.expectedReturnType
		}

		searchScope = searchScope.parent
	}

	return null
}

export function enrichFunctionStatement(
	node: parser.FunctionStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.FunctionType,
): common.typed.FunctionStatementNode {
	let type = hoistedType ?? resolveFunctionSignatureType(node.value, scope)

	if (hoistedType === undefined) {
		declareVariableInScope(node.name, type, scope, true)
	}

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

// NOTE: A name declared by the Compiler rather than in Essence — `@`, the
// builtins — is passed as a bare string and has no Position to point at. The
// Diagnostic is still worth reporting; it just has nothing to underline.
function reportDuplicateDeclaration(
	identifier: parser.IdentifierNode | string,
	name: string,
	firstDeclarationPosition: common.Position | null,
	code: common.DiagnosticCode,
	kind: string,
): void {
	let message = `${kind} '${name}' is already declared`

	if (typeof identifier === "string") {
		reportError(message, null, { code, labels: [] })

		return
	}

	reportError(message, identifier.position, {
		code,
		labels: [
			primary(identifier.position, "declared a second time here"),
			...(firstDeclarationPosition === null
				? []
				: [secondary(firstDeclarationPosition, "first declared here")]),
		],
	})
}

function declareVariableInScope(
	identifier: parser.IdentifierNode | string,
	type: common.Type,
	scope: enricher.Scope,
	isConstant = false,
): enricher.Scope {
	const variableName =
		typeof identifier === "string" ? identifier : identifier.content

	if (scope.members[variableName] != null) {
		reportDuplicateDeclaration(
			identifier,
			variableName,
			scope.declarations[variableName] ?? null,
			"duplicate-variable",
			"Variable",
		)
	}

	scope.members[variableName] = type

	invalidateNamespacesInScope(scope, variableName, type)

	if (typeof identifier !== "string") {
		scope.declarations[variableName] = identifier.position
	}

	if (isConstant) {
		scope.constants.add(variableName)
	} else {
		scope.constants.delete(variableName)
	}

	return scope
}

function findDeclaringScope(
	name: string,
	scope: enricher.Scope,
): enricher.Scope | null {
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		if (searchScope.members[name] != null) {
			return searchScope
		}

		searchScope = searchScope.parent
	}

	return null
}

// NOTE: Where the name a use refers to was declared, or null when it was
// declared by the Compiler rather than in this file. What lets a Diagnostic
// about a use point back at the declaration that constrains it.
export function findDeclarationPosition(
	name: string,
	scope: enricher.Scope,
): common.Position | null {
	return findDeclaringScope(name, scope)?.declarations[name] ?? null
}

function declareTypeInScope(
	identifier: parser.IdentifierNode | string,
	type: common.Type,
	scope: enricher.Scope,
): enricher.Scope {
	const variableName =
		typeof identifier === "string" ? identifier : identifier.content

	if (variableName === "Self") {
		reportReservedTypeName(
			typeof identifier === "string" ? null : identifier.position,
		)
	} else if (scope.types[variableName] != null) {
		reportDuplicateDeclaration(
			identifier,
			variableName,
			null,
			"duplicate-type",
			"Type",
		)
	}

	scope.types[variableName] = type

	return scope
}

function declareProtocolInScope(
	identifier: parser.IdentifierNode,
	protocolType: common.ProtocolType,
	scope: enricher.Scope,
): enricher.Scope {
	if (scope.protocols[identifier.content] != null) {
		reportDuplicateDeclaration(
			identifier,
			identifier.content,
			null,
			"duplicate-protocol",
			"Protocol",
		)
	}

	scope.protocols[identifier.content] = protocolType

	return scope
}

function enrichMembers(
	members: Record<string, parser.RecordValueMemberNode>,
	scope: enricher.Scope,
): Record<string, common.typed.ExpressionNode> {
	let result: Record<string, common.typed.ExpressionNode> = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		result[memberKey] = enrichExpression(memberValue.value, scope)
	}

	return result
}

function enrichMethods(
	members: parser.NamespaceMethods,
	scope: enricher.Scope,
	selfType: common.Type | null,
	methodTypes: Record<string, common.MethodType>,
	// NOTE: The constrained Namespace Generics to weave into each conditional
	// conformance's fulfilling Methods, one list per Overload — empty for every
	// other Method.
	injectedGenerics: Map<
		string,
		Array<Array<common.typed.GenericDeclarationNode>>
	> = new Map(),
): common.typed.Methods {
	let result: common.typed.Methods = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		// NOTE: A native Method has no body, so there is nothing to enrich and
		// nothing for the Rewriter to emit — the runtime already implements
		// it. It stays in the Namespace Type (which is what resolution,
		// Completion and Hover read) and is simply absent here.
		if (
			memberValue.nodeType === "SimpleMethodSignature" ||
			memberValue.nodeType === "StaticMethodSignature"
		) {
			continue
		}

		// NOTE: The name is typed as the Method itself, so that whatever
		// resolves a Type at the cursor describes the Method when the cursor
		// is on its name.
		let name: common.typed.IdentifierNode = {
			nodeType: "Identifier",
			content: memberKey,
			position: memberValue.name.position,
			type: methodTypes[memberKey] ?? { type: "Unknown" },
		}

		let injected = injectedGenerics.get(memberKey) ?? []

		if (memberValue.nodeType === "SimpleMethod") {
			result[memberKey] = {
				nodeType: "SimpleMethod",
				name,
				method: enrichMethodFunctionValue(
					memberValue,
					scope,
					selfType,
					injected[0] ?? [],
				),
			}
		} else if (memberValue.nodeType === "StaticMethod") {
			result[memberKey] = {
				nodeType: "StaticMethod",
				name,
				method: enrichMethodFunctionValue(
					memberValue,
					scope,
					selfType,
					injected[0] ?? [],
				),
			}
		} else if (memberValue.nodeType === "OverloadedMethod") {
			result[memberKey] = {
				nodeType: "OverloadedMethod",
				name,
				methods: enrichMethodsFunctionValue(
					memberValue,
					scope,
					selfType,
					injected,
				),
				// NOTE: Every Overload is bodied here, so the Node's order and
				// the Type's are the identity.
				overloadIndices: memberValue.methods.map((_, index) => index),
			}
		} else if (memberValue.nodeType === "OverloadedStaticMethod") {
			result[memberKey] = {
				nodeType: "OverloadedStaticMethod",
				name,
				methods: enrichMethodsFunctionValue(
					memberValue,
					scope,
					selfType,
					injected,
				),
				overloadIndices: memberValue.methods.map((_, index) => index),
			}
		} else {
			// NOTE: An Overload block in a `declarations { … }` Program may MIX
			// bodied and native entries. Only the bodied ones have anything to
			// emit, so only they reach the typed Node — together with the
			// Generics that were woven into THEIR entry of the resolved Type,
			// picked out by the original Overload index so the two views stay
			// aligned even when a native sits between them.
			// NOTE: Each survivor's ORIGINAL index travels with it in
			// `overloadIndices`. That index — its position in the Method
			// Type's `overloads`, not in this filtered list — is what the
			// `__overload$N` name is built from, both where a call site
			// resolves it and where the Simplifier emits the definition. A
			// native occupies its slot in that numbering even though nothing
			// is emitted for it, because the runtime export it binds to
			// already answers to that name.
			let bodied: Array<parser.FunctionValueNode> = []
			let bodiedIndices: Array<number> = []
			let bodiedInjected: Array<
				Array<common.typed.GenericDeclarationNode>
			> = []

			for (let [index, overload] of memberValue.methods.entries()) {
				if (overload.nodeType === "NativeMethodSignature") {
					continue
				}

				bodied.push(overload)
				bodiedIndices.push(index)
				bodiedInjected.push(injected[index] ?? [])
			}

			if (bodied.length === 0) {
				continue
			}

			let nodeType =
				memberValue.nodeType === "OverloadedMethodSignatures"
					? ("OverloadedMethod" as const)
					: ("OverloadedStaticMethod" as const)

			result[memberKey] = {
				nodeType,
				name,
				methods: enrichMethodsFunctionValue(
					{
						nodeType,
						name: memberValue.name,
						methods: bodied,
						documentation: memberValue.documentation,
					},
					scope,
					selfType,
					bodiedInjected,
				),
				overloadIndices: bodiedIndices,
			}
		}
	}

	return result
}

function enrichParameter(
	node: parser.ParameterNode,
	scope: enricher.Scope,
	// NOTE: Set for an unannotated Parameter, whose Type and label both came
	// from the expected signature rather than from anything written here.
	contextualParameter?: common.Parameter,
): common.typed.ParameterNode {
	let type =
		contextualParameter?.type ??
		(node.type === null
			? { type: "Error" as const }
			: resolveType(node.type, scope))

	// NOTE: `_: Type` binds no name, so there is nothing to declare — leaving
	// it out of Scope is what makes the Parameter unreferenceable rather than
	// merely unused.
	if (node.internalName !== null) {
		declareVariableInScope(node.internalName, type, scope, true)
	}

	return {
		nodeType: "Parameter",
		externalName: node.externalName
			? enrichIdentifier(node.externalName, scope, type)
			: null,
		internalName: node.internalName
			? enrichIdentifier(node.internalName, scope)
			: null,
		position: node.position,
		inferredType: node.type === null ? type : null,
	}
}

// #endregion

// #region Body Return Type Inference

// NOTE: Every `<-` the body reaches, ignoring those belonging to a nested
// Function literal — those return out of their own literal, not this one.
function collectReturnedTypes(
	nodes: Array<common.typed.ImplementationNode>,
	types: Array<common.Type>,
): void {
	for (let node of nodes) {
		switch (node.nodeType) {
			case "ReturnStatement":
				types.push(node.expression.type)
				break
			case "IfElseStatement":
				collectReturnedTypes(node.trueBody, types)
				collectReturnedTypes(node.falseBody, types)
				break
			case "IfStatement":
				collectReturnedTypes(node.body, types)
				break
			default:
				break
		}
	}
}

// NOTE: One `<-` gives its Type outright; several give the Union of the
// distinct ones, which is what a Function returning either a value or
// `nothing` needs.
function unionOfTypes(types: Array<common.Type>): common.Type | null {
	let distinct = mergeUnionMembers(types)

	if (distinct.length === 0) {
		return null
	}

	if (distinct.length === 1) {
		return distinct[0]
	}

	return buildUnion(distinct)
}

// NOTE: Working out what a Function literal returns means enriching its body —
// the Type of `<- total` can not be known without the Constants the body itself
// declares. The body is enriched twice as a result — once here to find the Type,
// once for real once it is known — so this pass's Diagnostics are collected and
// dropped rather than reported. `collectDiagnostics` exists for exactly this.
function inferReturnTypeFromBody(
	node: parser.FunctionDefinitionNode,
	parameterTypes: Array<common.Parameter>,
	scope: enricher.Scope,
): common.Type | null {
	let { result } = collectDiagnostics(() => {
		let inferenceScope = childScope(scope)

		node.parameters.forEach((parameter, index) => {
			let type = parameterTypes[index]?.type ?? { type: "Error" as const }

			if (parameter.internalName !== null) {
				declareVariableInScope(
					parameter.internalName,
					type,
					inferenceScope,
					true,
				)
			}
		})

		// NOTE: No `expectedReturnType` is seeded — there is none yet, which
		// is the whole reason this runs. A bare Case in return position has
		// nothing to resolve against and stays unresolved, so a literal
		// returning one still has to write its `-> Type`.
		let types: Array<common.Type> = []

		collectReturnedTypes(
			node.body.map((bodyNode) => enrichNode(bodyNode, inferenceScope)),
			types,
		)

		// NOTE: A body that returns nothing at all is left to the Validator,
		// which reports the missing return against the Function itself.
		if (types.some((type) => type.type === "Error")) {
			return null
		}

		return unionOfTypes(types)
	})

	return result
}

// #endregion

// #region Invocation, contextual Function & CaseValue resolution
//
// NOTE: Typing an invocation, a contextually typed Function literal, a
// CaseValue Expression, or a Namespace's property values all needs to enrich
// Expressions — so it lives here, on the enrichment side, rather than in the
// Resolver. Enrichment imports the Resolver, never the other way round.

// NOTE: Enriches each Argument value at most once per invocation resolution.
// The typed Node is reused for every overload probe and, afterwards, for the
// final typed Invocation. A Function literal that omitted its annotations is the
// exception: it reacts to the expected Type, so it is re-resolved against each
// probe's Parameter Type — its final typed Node is built later from the
// resolution the winning probe recorded.
type ArgumentTyper = {
	getType: (
		value: parser.ExpressionNode,
		expectedType: common.Type,
	) => common.Type
	enrichArgumentNode: (
		argument: parser.ArgumentNode,
	) => common.typed.ArgumentNode
}

function makeArgumentTyper(scope: enricher.Scope): ArgumentTyper {
	let cache = new Map<parser.ExpressionNode, common.typed.ExpressionNode>()

	function enrichOnce(
		value: parser.ExpressionNode,
	): common.typed.ExpressionNode {
		let cached = cache.get(value)

		if (cached === undefined) {
			cached = enrichExpression(value, scope)
			cache.set(value, cached)
		}

		return cached
	}

	return {
		getType(value, expectedType) {
			// NOTE: Only a Function literal with omitted annotations reacts to
			// the expected Type, and it may resolve differently per probe — so it
			// is resolved fresh here rather than enriched once.
			// `resolveFunctionValueType` records the resolution, which the final
			// enriched Node reads back. Every other Expression ignores the
			// expected Type, so its one enriched Type serves every probe.
			if (
				value.nodeType === "FunctionValue" &&
				needsContext(value.value)
			) {
				return resolveFunctionValueType(value, scope, expectedType)
			}

			return enrichOnce(value).type
		},
		enrichArgumentNode(argument) {
			let value = enrichOnce(argument.value)

			return {
				nodeType: "Argument",
				name: argument.name ? argument.name.content : null,
				value,
				type: value.type,
			}
		},
	}
}

// NOTE: A Function literal's Type. Every annotation present makes it a plain
// signature (resolved on the Resolver side); an omitted one is worked out
// contextually — from the expected Type while an invocation is matched, or from
// the body when the expected Type leaves it Generic. The result is recorded per
// Node so the separate enrichment pass, which has no expected Type left, reads
// it back rather than re-deriving it.
function resolveFunctionDefinitionType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.FunctionType {
	if (!needsContext(node)) {
		return resolveFunctionSignatureType(node, scope)
	}

	let recorded = contextualFunctionTypes.get(node)

	if (expectedType === null && recorded !== undefined) {
		return recorded
	}

	let functionScope = scopeWithGenerics(node.generics, scope)
	let expectedFunction =
		expectedType !== null && expectedType.type === "Function"
			? expectedType
			: null

	let parameterTypes = resolveContextualParameterTypes(
		node,
		functionScope,
		expectedFunction,
	)

	let resolved: common.FunctionType = {
		type: "Function",
		generics: resolveGenericDeclarations(node.generics, scope),
		parameterTypes,
		returnType: resolveContextualReturnType(
			node,
			functionScope,
			parameterTypes,
			expectedFunction,
		),
		documentation: node.documentation ?? undefined,
	}

	contextualFunctionTypes.set(node, resolved)

	return resolved
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
		reportError(
			`Type Parameter '${name}' could not be inferred`,
			position,
			{
				code: "uninferable-type-parameter",
				labels: [
					primary(
						position,
						"nothing here determines what it binds to",
					),
				],
				helps: ["Write the Type Argument explicitly."],
			},
		)
	}
}

function resolveNativeFunctionInvocationType(
	node: parser.NativeFunctionInvocationNode,
	nameType: common.Type,
	typer: ArgumentTyper,
): common.Type {
	let type = nameType

	if (type.type === "Function") {
		return resolveInferredReturnType(
			type,
			node.arguments,
			node.position,
			typer,
		)
	}

	if (type.type !== "Error") {
		reportError(
			`'${node.name.content}' is not a native Function`,
			node.name.position,
			{
				code: "unknown-native-function",
				labels: [
					primary(
						node.name.position,
						"the Compiler provides no such native Function",
					),
				],
			},
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
	typer: ArgumentTyper,
): common.Type {
	if (signature.generics.length === 0) {
		return signature.returnType
	}

	let matchableArguments: Array<MatchableArgument> = invocationArguments.map(
		(argument) => ({
			name: argument.name?.content ?? null,
			getType: (expectedType) =>
				typer.getType(argument.value, expectedType),
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

function resolveInvokedMethodInNamespace(
	node: parser.MethodInvocationNode,
	resolvedNamespace: common.NamespaceType,
	baseType: common.Type,
	typer: ArgumentTyper,
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
			getType: (expectedType) =>
				typer.getType(argument.value, expectedType),
		}),
	)

	if (
		methodType.type === "SimpleMethod" ||
		methodType.type === "OverloadedMethod"
	) {
		// NOTE: Union dispatch resolves the Method once per member Type — the
		// override stands in for the receiver so each member is matched as if
		// the receiver had that Type. Otherwise the receiver is the Type the
		// base was already enriched to.
		matchableArguments.unshift({
			name: null,
			getType: () => receiverType ?? baseType,
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

// NOTE: The Namespaces that were searched are the useful half of "no such
// Method" — without them the reader can not tell whether they misspelled the
// Method or the value is not the Type they thought it was. The near miss is
// offered from the same set, so a suggestion is always a Method that would
// actually resolve.
function reportUnknownMethod(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	namespaces: Map<string, common.NamespaceType>,
): void {
	let methodNames = new Set<string>()

	for (let namespace of namespaces.values()) {
		for (let methodName of Object.keys(namespace.methods)) {
			methodNames.add(methodName)
		}
	}

	let suggestion = closestMatch(node.member.content, [...methodNames])
	let namespaceNames = [...namespaces.keys()]

	reportError(
		`No Method named '${node.member.content}' for this value`,
		node.member.position,
		{
			code: "unknown-method",
			labels: [
				primary(node.member.position, "no Method of this name"),
				secondary(
					node.base.position,
					`this is ${withArticle(describeType(baseType))}`,
				),
			],
			notes:
				namespaceNames.length === 0
					? []
					: [
							`Searched ${namespaceNames.length === 1 ? "Namespace" : "Namespaces"} ${namespaceNames
								.map((name) => `'${name}'`)
								.join(", ")}.`,
						],
			helps: suggestion === null ? [] : [`Did you mean '${suggestion}'?`],
		},
	)
}

// NOTE: The receiver occupies the first Parameter of every non-static Method
// signature, but it is written to the left of the `::` rather than inside the
// parentheses — listing it among the Arguments would describe a call nobody
// can write.
function describeMethodOverloads(
	methodType: common.Type | undefined,
): Array<Array<common.Parameter>> {
	if (methodType === undefined) {
		return []
	}

	let dropsReceiver =
		methodType.type === "SimpleMethod" ||
		methodType.type === "OverloadedMethod"

	switch (methodType.type) {
		case "SimpleMethod":
		case "StaticMethod":
			return [
				dropsReceiver
					? methodType.parameterTypes.slice(1)
					: methodType.parameterTypes,
			]
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return methodType.overloads.map((overload) =>
				dropsReceiver
					? overload.parameterTypes.slice(1)
					: overload.parameterTypes,
			)
		default:
			return []
	}
}

function reportNoMatchingOverload(
	node: parser.MethodInvocationNode,
	candidates: Array<{
		namespaceName: string
		methodType: common.Type | undefined
	}>,
): void {
	let notes: Array<string> = []

	for (let candidate of candidates) {
		for (let parameterTypes of describeMethodOverloads(
			candidate.methodType,
		)) {
			notes.push(
				`'${candidate.namespaceName}::${node.member.content}' ${describeSignature(parameterTypes)}.`,
			)
		}
	}

	reportError(
		`No overload of '${node.member.content}' accepts these Arguments`,
		node.position,
		{
			code: "no-matching-overload",
			labels: [
				primary(
					node.position,
					`this call passes ${countOf(node.arguments.length, "Argument")}`,
				),
			],
			notes,
		},
	)
}

function reportAmbiguousNamespace(
	node: parser.MethodInvocationNode,
	namespaceNames: Array<string>,
): void {
	reportError(
		`'${node.member.content}' is provided by more than one Namespace`,
		node.position,
		{
			code: "ambiguous-namespace",
			labels: [
				primary(
					node.member.position,
					"these Arguments match all of them",
				),
			],
			notes: namespaceNames.map(
				(name) => `'${name}' declares '${node.member.content}'.`,
			),
			helps: [
				`Name the Namespace at the call, e.g. '${namespaceNames[0]}::${node.member.content}(…)'.`,
			],
		},
	)
}

function resolveMethodInvocation(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
): ResolvedMethodInvocation {
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
			return resolveUnionMethodDispatch(node, baseType, scope, typer)
		}

		if (baseType.type !== "Error") {
			reportError(
				`No Namespace provides Methods for this value`,
				node.base.position,
				{
					code: "no-namespace-for-value",
					labels: [
						primary(
							node.base.position,
							`this is ${withArticle(describeType(baseType))}`,
						),
						secondary(
							node.member.position,
							`'${node.member.content}' is looked up in its Namespaces`,
						),
					],
					notes: [
						`No Namespace in scope targets ${describeType(baseType)}.`,
					],
				},
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
			return resolveUnionMethodDispatch(node, baseType, scope, typer)
		}

		reportUnknownMethod(node, baseType, namespaces)

		return resolveFailedMethodInvocation()
	}

	let resolvedMethods = []

	for (let [namespaceName, namespaceType] of matchingNamespaces) {
		let resolvedMethod = resolveInvokedMethodInNamespace(
			node,
			namespaceType,
			baseType,
			typer,
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
			return resolveUnionMethodDispatch(node, baseType, scope, typer)
		}

		reportNoMatchingOverload(
			node,
			[...matchingNamespaces.entries()].map(
				([namespaceName, namespaceType]) => ({
					namespaceName,
					methodType: namespaceType.methods[node.member.content],
				}),
			),
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
		reportAmbiguousNamespace(
			node,
			resolvedMethods.map((method) => method.namespace.name),
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
	typer: ArgumentTyper,
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
				`No Method named '${node.member.content}' for ${describeType(memberType)}`,
				node.member.position,
				{
					code: "unknown-method",
					labels: [
						primary(
							node.member.position,
							`${describeType(memberType)} has no Method of this name`,
						),
						secondary(
							node.base.position,
							`this is ${withArticle(describeType(unionType))}`,
						),
					],
					notes: [
						`Every member of the Union must provide '${node.member.content}' — the receiver's Type is only known at runtime.`,
					],
				},
			)

			return resolveFailedMethodInvocation()
		}

		let resolvedMethods = []

		for (let [namespaceName, namespaceType] of matchingNamespaces) {
			let resolvedMethod = resolveInvokedMethodInNamespace(
				node,
				namespaceType,
				unionType,
				typer,
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
				`No overload of '${node.member.content}' accepts these Arguments for ${describeType(memberType)}`,
				node.position,
				{
					code: "no-matching-overload",
					labels: [
						primary(
							node.position,
							`this call passes ${countOf(node.arguments.length, "Argument")}`,
						),
						secondary(
							node.base.position,
							`${describeType(memberType)} is a member of this Union`,
						),
					],
					notes: [...matchingNamespaces.entries()].flatMap(
						([namespaceName, namespaceType]) =>
							describeMethodOverloads(
								namespaceType.methods[node.member.content],
							).map(
								(parameterTypes) =>
									`'${namespaceName}::${node.member.content}' ${describeSignature(parameterTypes)}.`,
							),
					),
				},
			)

			return resolveFailedMethodInvocation()
		}

		if (resolvedMethods.length > 1) {
			reportError(
				`'${node.member.content}' is provided by more than one Namespace for ${describeType(memberType)}`,
				node.position,
				{
					code: "ambiguous-namespace",
					labels: [
						primary(
							node.member.position,
							"these Arguments match all of them",
						),
					],
					notes: resolvedMethods.map(
						(method) =>
							`'${method.namespaceName}' declares '${node.member.content}'.`,
					),
					helps: [
						`Name the Namespace at the call, e.g. '${resolvedMethods[0].namespaceName}::${node.member.content}(…)'.`,
					],
				},
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
			`'${node.member.content}' can not be dispatched on this value`,
			node.position,
			{
				code: "undispatchable-method",
				labels: [
					primary(
						node.base.position,
						`this is ${withArticle(describeType(unionType))}`,
					),
				],
				notes: [
					`${countOf(catchAllCases.length, "member Type")} of the Union are indistinguishable at runtime: ${catchAllCases
						.map((dispatchCase) =>
							describeType(dispatchCase.memberType),
						)
						.join(", ")}.`,
				],
				helps: [
					"Narrow the value with a Match Expression before calling the Method.",
				],
			},
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

	return {
		namespace: placeholderNamespace(),
		type: buildUnion(mergeUnionMembers(caseReturnTypes)),
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
// beats `Integer | Rational` for an Integer receiver). This is what lets a
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

function resolveFunctionInvocation(
	node: parser.FunctionInvocationNode,
	nameType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
): { type: common.Type; conformances: Array<common.Conformance> } {
	const type = nameType

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
				getType: (expectedType) =>
					typer.getType(argument.value, expectedType),
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
				getType: (expectedType) =>
					typer.getType(argument.value, expectedType),
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

		reportError("No overload accepts these Arguments", node.position, {
			code: "no-matching-overload",
			labels: [
				primary(
					node.position,
					`this call passes ${countOf(node.arguments.length, "Argument")}`,
				),
			],
		})

		return { type: { type: "Error" }, conformances: [] }
	} else {
		if (type.type !== "Error") {
			reportError(
				"This Expression is not a Function",
				node.name.position,
				{
					code: "not-a-function",
					labels: [
						primary(
							node.name.position,
							`this is ${withArticle(describeType(type))}`,
						),
					],
				},
			)
		}

		return { type: { type: "Error" }, conformances: [] }
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
			`Type '${choice.content}' is not declared`,
			choice.position,
			{
				code: "unknown-type",
				labels: [primary(choice.position, "no such Type")],
				helps: suggestionHelps(choice.content, scope, "types"),
			},
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
		reportUnknownCase(
			caseName,
			`'${choice.content}'`,
			members.flatMap((member) =>
				member.type === "Case" ? [member.name] : [],
			),
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
			`No Choice in scope declares a Case '#${caseName.content}'`,
			caseName.position,
			{
				code: "unknown-case",
				labels: [primary(caseName.position, "no such Case")],
			},
		)
	} else {
		reportAmbiguousCase(
			caseName,
			candidates.map((candidate) => candidate.choice),
			"in scope",
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
		reportAmbiguousCase(
			caseName,
			candidates.map((candidate) => candidate.choice),
			"in the expected Type",
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
			`The matched value has no Case '#${node.caseName.content}'`,
			node.position,
			{
				code: "unknown-case",
				labels: [primary(node.position, "no such Case in this Union")],
			},
		)
	} else {
		reportAmbiguousCase(
			node.caseName,
			candidates.map((candidate) => candidate.choice),
			"in the matched Union",
		)
	}

	return { type: "Error" }
}

export function resolveFunctionValueType(
	node: parser.FunctionValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.FunctionType {
	return resolveFunctionDefinitionType(node.value, scope, expectedType)
}

// NOTE: The Enricher builds a Function literal's typed Nodes in a separate
// pass from the one that matched it against a signature, so the Types its
// omitted annotations resolved to have to be read back rather than worked out
// again — there is no expected Type left to work them out from.
//
// A literal that is not an Argument was never matched against anything, so
// nothing recorded it. Its annotations can only have come from its own body,
// and this is the first and last chance to work them out.
export function contextualFunctionTypeOf(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.FunctionType | undefined {
	let recorded = contextualFunctionTypes.get(node)

	if (recorded !== undefined) {
		return recorded
	}

	if (!needsContext(node)) {
		return undefined
	}

	return resolveFunctionDefinitionType(node, scope)
}

// NOTE: What a contextually typed Function literal resolved to. It is worked
// out while the invocation's signature is being matched — the only moment the
// expected Type is known — and read back when the same Node is enriched, which
// happens separately and without that context. Keyed by the Node, so a
// re-parse starts empty and nothing has to be invalidated.
const contextualFunctionTypes = new WeakMap<
	parser.FunctionDefinitionNode,
	common.FunctionType
>()

function needsContext(node: parser.FunctionDefinitionNode): boolean {
	return (
		node.returnType === null ||
		node.parameters.some((parameter) => parameter.type === null)
	)
}

// NOTE: An unannotated Parameter takes its Type *and* its label from the
// expected signature, positionally — which is why the Parser records no
// external name for one. An annotated Parameter is resolved exactly as it
// always was, so the two forms can be mixed across a Parameter list.
function resolveContextualParameterTypes(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
	expectedFunction: common.FunctionType | null,
): Array<common.Parameter> {
	return node.parameters.map((parameter, index) => {
		let documentation = parameterDocumentation(
			parameter,
			node.documentation,
		)

		if (parameter.type !== null) {
			return {
				name: parameter.externalName?.content ?? null,
				type: resolveDeclaredType(parameter.type, scope),
				documentation,
			}
		}

		let expectedParameter = expectedFunction?.parameterTypes[index]

		if (expectedParameter === undefined) {
			reportError(
				`The Type of Parameter '${parameterLabel(parameter)}' could not be inferred`,
				parameter.position,
				{
					code: "uninferable-parameter-type",
					labels: [
						primary(
							parameter.position,
							"this Parameter has no Type",
						),
					],
					notes: [
						expectedFunction === null
							? "Only a Function passed as an Argument takes its Types from the surrounding context."
							: `The expected Function Type takes ${countOf(expectedFunction.parameterTypes.length, "Parameter")}, so there is nothing for Parameter ${index + 1} to infer from.`,
					],
					helps: ["Write the Parameter's Type explicitly."],
				},
			)

			return { name: null, type: { type: "Error" }, documentation }
		}

		return {
			name: expectedParameter.name,
			type: expectedParameter.type,
			documentation,
		}
	})
}

function resolveContextualReturnType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
	parameterTypes: Array<common.Parameter>,
	expectedFunction: common.FunctionType | null,
): common.Type {
	if (node.returnType !== null) {
		return resolveType(node.returnType, scope)
	}

	// NOTE: A Parameter that could not be inferred has already been reported,
	// and its Error Type poisons whatever the body returns — a second
	// Diagnostic here would only restate the first in vaguer terms.
	if (parameterTypes.some((parameter) => parameter.type.type === "Error")) {
		return { type: "Error" }
	}

	// NOTE: With no expected signature the body is the only thing that could
	// say what this Function returns, and reading a Type off a body that
	// nothing else constrains is exactly the inference that is hard to follow
	// across a whole Program. A literal in Argument position is the one place
	// the Type is still written down — just elsewhere — so it is the one place
	// an omitted `-> Type` is allowed.
	if (expectedFunction === null) {
		reportError(
			"This Function must write its return Type",
			node.parameterListPosition,
			{
				code: "missing-return-type",
				labels: [
					primary(node.parameterListPosition, "no '-> Type' here"),
				],
				notes: [
					"Only a Function passed as an Argument takes its Types from the surrounding context.",
				],
			},
		)

		return { type: "Error" }
	}

	// NOTE: An expected return Type that is still an unbound Generic says
	// nothing — in `map`'s `(_ item: ItemType) -> Result` nothing binds
	// `Result` but this literal's own body, so the body is what it is read off.
	if (containsGenericUse(expectedFunction.returnType)) {
		let inferred = inferReturnTypeFromBody(node, parameterTypes, scope)

		if (inferred !== null) {
			return inferred
		}

		let position = functionLiteralPosition(node)
		let message = "The return Type could not be inferred from the body"
		let helps = ["Give the Function an explicit '-> Type'."]

		if (position === null) {
			reportError(message, null, {
				code: "uninferable-return-type",
				labels: [],
				helps,
			})
		} else {
			reportError(message, position, {
				code: "uninferable-return-type",
				labels: [
					primary(position, "the body's Type is not determined here"),
				],
				helps,
			})
		}

		return { type: "Error" }
	}

	return expectedFunction.returnType
}

function parameterLabel(parameter: parser.ParameterNode): string {
	return (
		parameter.internalName?.content ??
		parameter.externalName?.content ??
		"_"
	)
}

function functionLiteralPosition(
	node: parser.FunctionDefinitionNode,
): common.Position | null {
	return node.parameters[0]?.position ?? null
}

function containsGenericUse(type: common.Type): boolean {
	switch (type.type) {
		case "GenericUse":
			return true
		case "UnionType":
			return type.types.some(containsGenericUse)
		case "List":
			return containsGenericUse(type.itemType)
		case "Function":
			return (
				type.parameterTypes.some((parameter) =>
					containsGenericUse(parameter.type),
				) || containsGenericUse(type.returnType)
			)
		case "Record":
			return Object.values(type.members).some(containsGenericUse)
		default:
			return false
	}
}

export function resolveNamespaceDefinitionStatementType(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
): common.NamespaceType {
	// NOTE: Namespace Generics are visible in the target Type and in every
	// Method signature — `namespace Boxes<infer Item> for List<Item>`.
	let genericScope = scopeWithGenerics(node.generics, scope)

	let conformanceConditions: Record<
		string,
		Array<{ generic: string; protocol: string }>
	> = {}

	for (let clause of node.conformsTo) {
		if (clause.conditions.length > 0) {
			conformanceConditions[clause.protocol.content] =
				clause.conditions.map((condition) => ({
					generic: condition.generic.content,
					protocol: condition.protocol.content,
				}))
		}
	}

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
		conformsTo: node.conformsTo.map((clause) => clause.protocol.content),
		conformanceConditions,
	}

	let properties: Record<string, common.Type> = {}
	let methods: Record<string, common.MethodType> = {}

	for (let [memberKey, memberValue] of Object.entries(node.properties)) {
		// NOTE: A native static Property declares its Type instead of carrying
		// a value — `static PI: Transcendental` — so the annotation IS the
		// Type. Resolved in the outer Scope, like the bodied form's value.
		if (memberValue.value === null) {
			// NOTE: With neither a value nor an annotation there is nothing
			// left to say what the Property is. Silently resolving to Error
			// would let a Namespace ship a Property of no Type at all, and the
			// standard library's zero-Diagnostic gate would wave it through.
			if (memberValue.type === null) {
				reportError(
					`Native Property '${memberKey}' declares no Type`,
					memberValue.name.position,
					{
						code: "native-property-without-type",
						labels: [
							primary(
								memberValue.name.position,
								"no Type and no value",
							),
						],
						helps: [
							`Annotate it: 'static ${memberKey}: Type'.`,
						],
					},
				)
			}

			properties[memberKey] = resolveDeclaredType(memberValue.type, scope)

			continue
		}

		// NOTE: A property's Type is its value's, read off the enriched
		// Expression — the same walk the Node build uses, so the two agree.
		// Enriching an Expression declares nothing, so this is safe under the
		// speculative resolution hoisting runs.
		properties[memberKey] = enrichExpression(memberValue.value, scope).type
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
				declarations: { [node.name.content]: node.name.position },
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

// NOTE: The qualified spelling is shown rather than described — "prefix it
// with its Choice's name" leaves the reader to work out what that looks like,
// and the whole point of the Diagnostic is that they can not tell the two
// Choices apart.
function reportAmbiguousCase(
	caseName: parser.IdentifierNode,
	choiceNames: Array<string>,
	where: string,
): void {
	reportError(
		`Case '#${caseName.content}' is declared by more than one Choice`,
		caseName.position,
		{
			code: "ambiguous-case",
			labels: [
				primary(
					caseName.position,
					`${countOf(choiceNames.length, "Choice")} ${where} declare${choiceNames.length === 1 ? "s" : ""} it`,
				),
			],
			notes: choiceNames.map(
				(choiceName) =>
					`'${choiceName}' declares '#${caseName.content}'.`,
			),
			helps: [
				`Write '${choiceNames[0]}#${caseName.content}' to pick one.`,
			],
		},
	)
}

function reportUnknownCase(
	caseName: parser.IdentifierNode,
	choiceDescription: string,
	declaredCaseNames: Array<string>,
): void {
	let suggestion = closestMatch(caseName.content, declaredCaseNames)

	reportError(
		`${choiceDescription} has no Case '#${caseName.content}'`,
		caseName.position,
		{
			code: "unknown-case",
			labels: [primary(caseName.position, "no such Case")],
			notes:
				declaredCaseNames.length === 0
					? []
					: [
							`${choiceDescription} declares ${declaredCaseNames
								.map((name) => `'#${name}'`)
								.join(", ")}.`,
						],
			helps:
				suggestion === null ? [] : [`Did you mean '#${suggestion}'?`],
		},
	)
}
// #endregion
