import { collectDiagnostics, reportError } from "../diagnostics/index"
import { flattenUnionMembers, matchesType } from "../helpers/index"
import type { common, enricher, parser } from "../interfaces/index"
import {
	checkProtocolConformance,
	findTypeInScope,
	resolveCaseMatcherType,
	resolveCaseValueType,
	resolveChoiceDeclarationStatementType,
	resolveCombinationType,
	resolveFunctionInvocation,
	contextualFunctionTypeOf,
	registerBodyReturnTypeInference,
	resolveDeclaredType,
	resolveFunctionValueType,
	resolveListValueType,
	resolveMethodInvocation,
	resolveNamespaceDefinitionStatementType,
	resolveProtocolDeclarationStatementType,
	resolveRecordValueType,
	resolveType,
	resolveTypeAliasStatementType,
} from "./resolvers"

export function enrichNode(
	node: parser.ImplementationNode,
	scope: enricher.Scope,
	hoistedNodes?: Set<parser.ImplementationNode>,
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
			return enrichStatement(node, scope, hoistedNodes)
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
	return {
		nodeType: "NativeFunctionInvocation",
		name: enrichIdentifier(node.name, scope),
		arguments: node.arguments.map((argument) =>
			enrichArgument(argument, scope),
		),
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichMethodInvocation(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): common.typed.MethodInvocationNode {
	let { namespace, type, overloadedMethodIndex, conformances, dispatch } =
		resolveMethodInvocation(node, scope)

	return {
		nodeType: "MethodInvocation",
		base: enrichExpression(node.base, scope),
		member: {
			name: node.member.content,
			position: node.member.position,
		},
		arguments: node.arguments.map((argument) =>
			enrichArgument(argument, scope),
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
	let { type, conformances } = resolveFunctionInvocation(node, scope)

	return {
		nodeType: "FunctionInvocation",
		name: enrichExpression(node.name, scope),
		arguments: node.arguments.map((argument) =>
			enrichArgument(argument, scope),
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
	return {
		nodeType: "Combination",
		lhs: enrichExpression(node.lhs, scope),
		rhs: enrichExpression(node.rhs, scope),
		position: node.position,
		type: resolveCombinationType(node, scope),
	}
}

export function enrichMethodFunctionDefinition(
	method: parser.FunctionValueNode,
	scope: enricher.Scope,
	selfType: common.Type | null,
): common.typed.FunctionDefinitionNode {
	// NOTE: The Method's own Generics are registered as GenericUses so that
	// Parameter and Return Types as well as the body can reference them.
	let types: Record<string, common.Type> = {}
	for (let generic of method.value.generics) {
		types[generic.name.content] = {
			type: "GenericUse",
			name: generic.name.content,
			...(generic.constraint !== null
				? { constraint: generic.constraint.content }
				: {}),
		}
	}

	let newScope: enricher.Scope = {
		parent: scope,
		members: {},
		constants: new Set(),
		types,
		protocols: {},
	}

	if (selfType !== null) {
		declareVariableInScope("@", selfType, newScope, true)
	}

	// NOTE: Resolved before the body so that `<-` Expressions can consult it
	// — a bare Case resolves against the declared return Type first.
	let returnType = resolveDeclaredType(method.value.returnType, newScope)
	newScope.expectedReturnType = returnType

	return {
		nodeType: "FunctionDefinition",
		generics: method.value.generics.map((generic) =>
			enrichGenericDeclarationNode(generic, scope),
		),
		parameters: method.value.parameters.map((parameter) =>
			enrichParameter(parameter, newScope),
		),
		body: method.value.body.map((node) => enrichNode(node, newScope)),
		returnType,
		// NOTE: A Method always writes its annotations — the Parser only
		// allows omitting them for a literal in expression position.
		inferredReturnType: null,
		parameterListPosition: method.value.parameterListPosition,
	}
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
	let types: Record<string, common.Type> = {}
	for (let generic of node.generics) {
		types[generic.name.content] = {
			type: "GenericUse",
			name: generic.name.content,
			...(generic.constraint !== null
				? { constraint: generic.constraint.content }
				: {}),
		}
	}

	let newScope: enricher.Scope = {
		parent: scope,
		members: {},
		constants: new Set<string>(),
		types,
		protocols: {},
	}

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

export function enrichMethodFunctionValue(
	node: parser.SimpleMethod | parser.StaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
): common.typed.FunctionValueNode {
	return {
		nodeType: "FunctionValue",
		value: enrichMethodFunctionDefinition(node.method, scope, selfType),
		position: node.method.position,
		type: resolveFunctionValueType(node.method, scope),
	}
}

export function enrichMethodsFunctionValue(
	node: parser.OverloadedMethod | parser.OverloadedStaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
): Array<common.typed.FunctionValueNode> {
	let results: Array<common.typed.FunctionValueNode> = []

	for (let method of Object.values(node.methods)) {
		results.push({
			nodeType: "FunctionValue",
			value: enrichMethodFunctionDefinition(method, scope, selfType),
			position: method.position,
			type: resolveFunctionValueType(method, scope),
		})
	}

	return results
}

export function enrichRecordValue(
	node: parser.RecordValueNode,
	scope: enricher.Scope,
): common.typed.RecordValueNode {
	let declaredType: common.Type | null = null
	if (node.type !== null) {
		let resolvedType = resolveType(node.type, scope)

		if (resolvedType.type === "Record") {
			declaredType = resolvedType
		} else if (resolvedType.type !== "Error") {
			reportError(
				"Type Annotations for Records must be Record Types.",
				node.type.position,
			)
		}
	}

	return {
		nodeType: "RecordValue",
		members: enrichMembers(node.members, scope),
		position: node.position,
		type: resolveRecordValueType(node, scope),
		declaredType: declaredType,
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
	return {
		nodeType: "ListValue",
		values: node.values.map((expr) => enrichExpression(expr, scope)),
		position: node.position,
		type: resolveListValueType(node, scope),
	}
}

export function enrichLookup(
	node: parser.LookupNode,
	scope: enricher.Scope,
): common.typed.LookupNode {
	return {
		nodeType: "Lookup",
		base: enrichExpression(node.base, scope),
		member: enrichMember(node, scope),
		position: node.position,
		type: resolveType(node, scope),
	}
}

export function enrichIdentifier(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	type: common.Type = resolveType(node, scope),
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
	type: common.Type = resolveType(node, scope),
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

	// NOTE: Flattened for the same reason the Validator's exhaustiveness
	// check flattens — a nested Union member (`Number`, a Choice) is handled
	// member by member.
	let remainingTypes = flattenUnionMembers(valueType).filter(
		(memberType) => !isHandled(memberType),
	)

	if (remainingTypes.length === 0) {
		return { type: "Unknown" }
	}

	if (remainingTypes.length === 1) {
		return remainingTypes[0]
	}

	return { type: "UnionType", types: remainingTypes }
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
			let bodyScope = {
				parent: scope,
				members: {},
				constants: new Set(),
				types: {},
				protocols: {},
				expectedReturnType: returnType,
			} satisfies enricher.Scope

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
	hoistedNodes?: Set<parser.ImplementationNode>,
): common.typed.StatementNode {
	let isHoisted = hoistedNodes?.has(node) === true

	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
			return enrichConstantDeclarationStatement(node, scope)
		case "VariableDeclarationStatement":
			return enrichVariableDeclarationStatement(node, scope)
		case "VariableAssignmentStatement":
			return enrichVariableAssignmentStatement(node, scope)
		case "NamespaceDefinitionStatement":
			return enrichNamespaceDefinitionStatement(node, scope, isHoisted)
		case "ProtocolDeclarationStatement":
			return enrichProtocolDeclarationStatement(node, scope, isHoisted)
		case "TypeAliasStatement":
			return enrichTypeAliasStatement(node, scope, isHoisted)
		case "ChoiceDeclarationStatement":
			return enrichChoiceDeclarationStatement(node, scope, isHoisted)
		case "IfElseStatement":
			return enrichIfElseStatementNode(node, scope)
		case "IfStatement":
			return enrichIfStatement(node, scope)
		case "ReturnStatement":
			return enrichReturnStatement(node, scope)
		case "FunctionStatement":
			return enrichFunctionStatement(node, scope, isHoisted)
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

	if (declaringScope?.constants.has(node.name.content)) {
		reportError(
			`Constant '${node.name.content}' can not be reassigned.`,
			node.name.position,
		)
	}

	let name = enrichIdentifier(node.name, scope)

	return {
		nodeType: "VariableAssignmentStatement",
		name,
		// NOTE: The target Variable's Type is the value's expected Type — a
		// bare Case in the value resolves against it before the scope scan.
		value: enrichExpression(node.value, scope, name.type),
		position: node.position,
	}
}

export function enrichNamespaceDefinitionStatement(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
	isHoisted = false,
): common.typed.NamespaceDefinitionStatementNode {
	function enrichProperties(
		properties: Record<string, parser.NamespacePropertyNode>,
		scope: enricher.Scope,
	): Record<string, common.typed.NamespaceProperty> {
		let result: Record<string, common.typed.NamespaceProperty> = {}

		for (let [propertyKey, propertyValue] of Object.entries(properties)) {
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

	let type = resolveNamespaceDefinitionStatementType(node, scope)

	if (!isHoisted) {
		declareVariableInScope(node.name, type, scope, true)
	}

	checkProtocolConformance(node, type, scope)

	// NOTE: Method definitions only carry their own Generics, so a
	// Namespace-level bound has no way to thread its conformance parameter
	// into the Methods — rejected until conditional conformance lands.
	for (let generic of node.generics) {
		if (generic.constraint !== null) {
			reportError(
				"Namespace Type Parameters can not have Protocol bounds (yet).",
				generic.constraint.position,
			)
		}
	}

	// NOTE: Namespace Generics are visible in every Method — bodies reference
	// them as opaque GenericUses.
	let genericTypes: Record<string, common.Type> = {}
	for (let generic of node.generics) {
		genericTypes[generic.name.content] = {
			type: "GenericUse",
			name: generic.name.content,
		}
	}

	let methodScope = {
		parent: scope,
		members: {},
		constants: new Set(),
		types: genericTypes,
		protocols: {},
	} satisfies enricher.Scope

	return {
		nodeType: "NamespaceDefinitionStatement",
		targetType: type.targetType,
		conformsTo: node.conformsTo.map((identifier) => ({
			name: identifier.content,
			position: identifier.position,
		})),
		name: enrichIdentifier(node.name, scope),
		properties: enrichProperties(node.properties, scope),
		methods: enrichMethods(
			node.methods,
			methodScope,
			type.targetType,
			type.methods,
		),
		position: node.position,
		type,
		documentation: node.documentation,
	}
}

export function enrichProtocolDeclarationStatement(
	node: parser.ProtocolDeclarationStatementNode,
	scope: enricher.Scope,
	isHoisted = false,
): common.typed.ProtocolDeclarationStatementNode {
	const protocolType = resolveProtocolDeclarationStatementType(node, scope)

	if (!isHoisted) {
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
	isHoisted = false,
): common.typed.TypeAliasStatementNode {
	const type = resolveTypeAliasStatementType(node, scope)

	if (!isHoisted) {
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
	isHoisted = false,
): common.typed.ChoiceDeclarationStatementNode {
	const type = resolveChoiceDeclarationStatementType(node, scope)

	if (!isHoisted) {
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
	let trueScope = {
		parent: scope,
		members: {},
		constants: new Set(),
		types: {},
		protocols: {},
	} satisfies enricher.Scope
	let falseScope = {
		parent: scope,
		members: {},
		constants: new Set(),
		types: {},
		protocols: {},
	} satisfies enricher.Scope

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
	let bodyScope = {
		parent: scope,
		members: {},
		constants: new Set(),
		types: {},
		protocols: {},
	} satisfies enricher.Scope

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
	isHoisted = false,
): common.typed.FunctionStatementNode {
	let type = resolveType(node.value, scope)

	if (!isHoisted) {
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

function declareVariableInScope(
	identifier: parser.IdentifierNode | string,
	type: common.Type,
	scope: enricher.Scope,
	isConstant = false,
): enricher.Scope {
	const variableName =
		typeof identifier === "string" ? identifier : identifier.content

	if (scope.members[variableName] != null) {
		reportError(
			`Variable '${variableName}' is already declared.`,
			typeof identifier === "string" ? null : identifier.position,
		)
	}

	scope.members[variableName] = type

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

function declareTypeInScope(
	identifier: parser.IdentifierNode | string,
	type: common.Type,
	scope: enricher.Scope,
): enricher.Scope {
	const variableName =
		typeof identifier === "string" ? identifier : identifier.content

	if (variableName === "Self") {
		reportError(
			"'Self' is a reserved Type name.",
			typeof identifier === "string" ? null : identifier.position,
		)
	} else if (scope.types[variableName] != null) {
		reportError(
			`Type '${variableName}' is already declared.`,
			typeof identifier === "string" ? null : identifier.position,
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
		reportError(
			`Protocol '${identifier.content}' is already declared.`,
			identifier.position,
		)
	}

	scope.protocols[identifier.content] = protocolType

	return scope
}

function enrichArgument(
	node: parser.ArgumentNode,
	scope: enricher.Scope,
): common.typed.ArgumentNode {
	return {
		nodeType: "Argument",
		name: node.name ? node.name.content : null,
		value: enrichExpression(node.value, scope),
		type: resolveType(node.value, scope),
	}
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
): common.typed.Methods {
	let result: common.typed.Methods = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		// NOTE: The name is typed as the Method itself, so that whatever
		// resolves a Type at the cursor describes the Method when the cursor
		// is on its name.
		let name: common.typed.IdentifierNode = {
			nodeType: "Identifier",
			content: memberKey,
			position: memberValue.name.position,
			type: methodTypes[memberKey] ?? { type: "Unknown" },
		}

		if (memberValue.nodeType === "SimpleMethod") {
			result[memberKey] = {
				nodeType: "SimpleMethod",
				name,
				method: enrichMethodFunctionValue(memberValue, scope, selfType),
			}
		} else if (memberValue.nodeType === "StaticMethod") {
			result[memberKey] = {
				nodeType: "StaticMethod",
				name,
				method: enrichMethodFunctionValue(memberValue, scope, selfType),
			}
		} else if (memberValue.nodeType === "OverloadedMethod") {
			result[memberKey] = {
				nodeType: "OverloadedMethod",
				name,
				methods: enrichMethodsFunctionValue(
					memberValue,
					scope,
					selfType,
				),
			}
		} else {
			result[memberKey] = {
				nodeType: "OverloadedStaticMethod",
				name,
				methods: enrichMethodsFunctionValue(
					memberValue,
					scope,
					selfType,
				),
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

function enrichMember(
	node: parser.LookupNode,
	scope: enricher.Scope,
): common.typed.IdentifierNode {
	return {
		nodeType: "Identifier",
		content: node.member.content,
		position: node.member.position,
		type: resolveType(node, scope),
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
	let distinct: Array<common.Type> = []

	for (let type of types) {
		let members =
			type.type === "UnionType" ? flattenUnionMembers(type) : [type]

		for (let member of members) {
			if (!distinct.some((existing) => matchesType(existing, member))) {
				distinct.push(member)
			}
		}
	}

	if (distinct.length === 0) {
		return null
	}

	if (distinct.length === 1) {
		return distinct[0]
	}

	return { type: "UnionType", types: distinct }
}

// NOTE: Installed into the Resolver, which needs a body enriched to know what
// the literal returns but can not import this module. The body is enriched
// twice as a result — once here to find the Type, once for real once it is
// known — so this pass's Diagnostics are collected and dropped rather than
// reported. `collectDiagnostics` exists for exactly this.
registerBodyReturnTypeInference((node, parameterTypes, scope) => {
	let { result } = collectDiagnostics(() => {
		let inferenceScope: enricher.Scope = {
			parent: scope,
			members: {},
			constants: new Set<string>(),
			types: {},
			protocols: {},
		}

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
})

// #endregion
