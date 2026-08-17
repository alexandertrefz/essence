import type { common } from "@essence-lang/interfaces"

import {
	bodyDefinitelyReturns,
	conformanceParameterName,
	openArgumentHoles,
	resolveOverloadedMethodName,
} from "../helpers/index"

export const simplify = (
	program: common.typed.Program,
): common.typedSimple.Program => {
	return {
		nodeType: "Program",
		imports: simplifyImportSection(program.imports),
		implementation: simplifyImplementationSection(program.implementation),
		exports: simplifyExportSection(program.exports),
	}
}

// NOTE: Both sections travel through untouched but for their Positions and the
// specifiers as written — neither survives simplification anywhere else, and
// nothing downstream reports about an entry. What emission needs is the
// canonical path and the `runtime` flag linking annotated each entry with.
function simplifyImportSection(
	section: common.typed.ImportSectionNode | null,
): common.typedSimple.ImportSectionNode | null {
	if (section === null) {
		return null
	}

	return {
		nodeType: "ImportSection",
		entries: section.entries.map((entry) => ({
			nodeType: "Import",
			name: entry.name,
			alias: entry.alias,
			modulePath: entry.modulePath,
			runtime: entry.runtime,
		})),
	}
}

function simplifyExportSection(
	section: common.typed.ExportSectionNode | null,
): common.typedSimple.ExportSectionNode | null {
	if (section === null) {
		return null
	}

	return {
		nodeType: "ExportSection",
		entries: section.entries.map((entry) => ({
			nodeType: "Export",
			name: entry.name,
			alias: entry.alias,
			modulePath: entry.modulePath,
			runtime: entry.runtime,
		})),
	}
}

function simplifyImplementationSection(
	implementation: common.typed.ImplementationSectionNode,
): common.typedSimple.ImplementationSectionNode {
	return {
		nodeType: "ImplementationSection",
		nodes: implementation.nodes.map((node) =>
			simplifyImplementationNode(node),
		),
	}
}

function simplifyImplementationNode(
	node: common.typed.ImplementationNode,
): common.typedSimple.ImplementationNode {
	switch (node.nodeType) {
		case "MethodInvocation":
		case "FunctionInvocation":
		case "Combination":
		case "RecordValue":
		case "StringValue":
		case "InterpolatedStringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "FunctionValue":
		case "ListValue":
		case "Lookup":
		case "Identifier":
		case "Self":
		case "Match":
		case "CaseValue":
			return simplifyExpression(node)
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
			return simplifyStatement(node)
	}
}

// #region Expressions

function simplifyExpression(
	node: common.typed.ExpressionNode,
): common.typedSimple.ExpressionNode {
	switch (node.nodeType) {
		case "MethodInvocation":
			return simplifyMethodInvocation(node)
		case "FunctionInvocation":
			return simplifyFunctionInvocation(node)
		case "Combination":
			return simplifyCombination(node)
		case "RecordValue":
			return simplifyRecordValue(node)
		case "StringValue":
			return simplifyStringValue(node)
		case "InterpolatedStringValue":
			return simplifyInterpolatedStringValue(node)
		case "IntegerValue":
			return simplifyIntegerValue(node)
		case "RationalValue":
			return simplifyRationalValue(node)
		case "BooleanValue":
			return simplifyBooleanValue(node)
		case "FunctionValue":
			return simplifyFunctionValue(node)
		case "ListValue":
			return simplifyListValue(node)
		case "Lookup":
			return simplifyLookup(node)
		case "Identifier":
			return simplifyIdentifier(node)
		case "Self":
			return simplifySelf(node)
		case "Match":
			return simplifyMatch(node)
		case "CaseValue":
			return simplifyCaseValue(node)
	}
}

// NOTE: All the runtime needs is the tag the constructed value carries —
// `"CalculatorOperation#Add"` — and the payload it is built from. An Error
// Type never reaches this stage (Diagnostics gate codegen), so the empty tag
// fallback is purely for the type checker.
function simplifyCaseValue(
	node: common.typed.CaseValueNode,
): common.typedSimple.CaseValueNode {
	return {
		nodeType: "CaseValue",
		tag:
			node.type.type === "Case"
				? `${node.type.choice}#${node.type.name}`
				: "",
		value: node.value === null ? null : simplifyExpression(node.value),
		type: node.type,
		position: node.position,
	}
}

function simplifyMethodInvocation(
	node: common.typed.MethodInvocationNode,
):
	| common.typedSimple.MethodInvocationNode
	| common.typedSimple.UnionMethodInvocationNode {
	if (node.dispatch !== null) {
		return simplifyUnionMethodInvocation(node, node.dispatch)
	}

	if (node.overloadedMethodIndex !== null) {
		node.member.name = resolveOverloadedMethodName(
			node.member.name,
			node.overloadedMethodIndex,
		)
	}

	return {
		nodeType: "MethodInvocation",
		base: {
			nodeType: "Identifier",
			name: node.namespace.name,
			type: node.namespace.type,
			position: node.position,
		},
		member: { name: node.member.name },
		...(node.omittedParameterIndices.length === 0
			? {}
			: { omitsArguments: true as const }),
		arguments: expandOmittedArguments(
			[
				{
					nodeType: "Argument",
					name: "@",
					value: simplifyExpression(node.base),
				},
			],
			node.arguments.map((arg) => simplifyArgument(arg)),
			node.omittedParameterIndices,
			simplifyConformanceArguments(node.conformances),
		),
		derivedDescriptor: node.derivedDescriptor,
		type: node.type,
		position: node.position,
	}
}

// NOTE: A dispatched Invocation flattens into one statically resolved target
// per member Type — the receiver and the shared Arguments are emitted once,
// and each case carries its overload-mangled Method name, the hidden
// conformance Arguments that target requires, and any Argument that was
// compiled for this branch alone and stands in for a shared one.
function simplifyUnionMethodInvocation(
	node: common.typed.MethodInvocationNode,
	dispatch: Array<common.DispatchCase>,
): common.typedSimple.UnionMethodInvocationNode {
	return {
		nodeType: "UnionMethodInvocation",
		base: simplifyExpression(node.base),
		cases: dispatch.map((dispatchCase) => ({
			memberType: dispatchCase.memberType,
			namespaceName: dispatchCase.namespaceName,
			methodName:
				dispatchCase.overloadedMethodIndex !== null
					? resolveOverloadedMethodName(
							node.member.name,
							dispatchCase.overloadedMethodIndex,
						)
					: node.member.name,
			conformanceArguments: simplifyConformanceArguments(
				dispatchCase.conformances,
			),
			contextualArguments: dispatchCase.contextualArguments.map(
				(contextualArgument) => ({
					index: contextualArgument.index,
					argument: simplifyArgument(contextualArgument.argument),
				}),
			),
			omittedParameterIndices: dispatchCase.omittedParameterIndices,
			derivedDescriptor: dispatchCase.derivedDescriptor,
		})),
		arguments: node.arguments.map((arg) => simplifyArgument(arg)),
		type: node.type,
		position: node.position,
	}
}

function simplifyFunctionInvocation(
	node: common.typed.FunctionInvocationNode,
): common.typedSimple.FunctionInvocationNode {
	if (node.overloadedMethodIndex !== null) {
		if (node.name.nodeType === "Lookup") {
			// NOTE: A `Namespace.method(…)` call whose Method is overloaded — the
			// index names which Overload the Enricher picked.
			node.name.member.content = resolveOverloadedMethodName(
				node.name.member.content,
				node.overloadedMethodIndex,
			)
		} else if (node.name.nodeType === "Identifier") {
			// NOTE: A bare `loop(…)` call whose callee is an overloaded free
			// Function — same numbering, on the Identifier itself. The Rewriter
			// then reads `loop__overload$N` off the runtime `functions` module.
			node.name.content = resolveOverloadedMethodName(
				node.name.content,
				node.overloadedMethodIndex,
			)
		}
	}

	return {
		nodeType: "FunctionInvocation",
		name: simplifyExpression(node.name),
		...(node.omittedParameterIndices.length === 0
			? {}
			: { omitsArguments: true as const }),
		arguments: expandOmittedArguments(
			[],
			node.arguments.map((arg) => simplifyArgument(arg)),
			node.omittedParameterIndices,
			simplifyConformanceArguments(node.conformances),
		),
		type: node.type,
		position: node.position,
	}
}

// NOTE: The hidden trailing Arguments matching a bounded signature's hidden
// trailing Parameters — a forwarded conformance parameter stays an
// Identifier, a resolved Namespace becomes a ConformanceValue that the
// Rewriter emits as a method-map object.
function simplifyConformanceArguments(
	conformances: Array<common.Conformance>,
): Array<common.typedSimple.ArgumentNode> {
	return conformances.map((conformance) => ({
		nodeType: "Argument",
		name: null,
		value: conformanceExpression(conformance),
	}))
}

// NOTE: One conformance witness — a forwarded parameter stays an Identifier; a
// resolved Namespace becomes a ConformanceValue whose own `where` conditions
// are witnessed recursively, in the order the Enricher fixed to match the
// fulfilling Methods' hidden conformance Parameters.
function conformanceExpression(
	conformance: common.Conformance,
): common.typedSimple.ExpressionNode {
	if (conformance.source.kind === "parameter") {
		return {
			nodeType: "Identifier",
			name: conformance.source.name,
			type: { type: "Unknown" },
		}
	}

	return {
		nodeType: "ConformanceValue",
		namespaceName: conformance.source.name,
		methodMap: conformance.source.methodMap,
		conditions: conformance.source.conditions.map(conformanceExpression),
		derivedDescriptor: conformance.source.derivedDescriptor,
		type: { type: "Unknown" },
	}
}

function simplifyCombination(
	node: common.typed.CombinationNode,
): common.typedSimple.CombinationNode {
	return {
		nodeType: "Combination",
		lhs: simplifyExpression(node.lhs),
		rhs: simplifyExpression(node.rhs),
		type: node.type,
		position: node.position,
	}
}

function simplifyRecordValue(
	node: common.typed.RecordValueNode,
): common.typedSimple.RecordValueNode {
	return {
		nodeType: "RecordValue",
		type: node.declaredType !== null ? node.declaredType : node.type,
		members: simplifyMembers(node.members),
		position: node.position,
	}
}

function simplifyStringValue(
	node: common.typed.StringValueNode,
): common.typedSimple.StringValueNode {
	return {
		nodeType: "StringValue",
		value: node.value,
		type: node.type,
		position: node.position,
	}
}

// NOTE: Each hole's resolved `Printable` Conformance becomes its witness
// Expression through the same `conformanceExpression` a bounded call's hidden
// Arguments go through — a method-map object for a Namespace source, a
// forwarded Identifier for a parameter source. The Rewriter reads
// `witness.toString(expression)` off it.
function simplifyInterpolatedStringValue(
	node: common.typed.InterpolatedStringValueNode,
): common.typedSimple.InterpolatedStringValueNode {
	return {
		nodeType: "InterpolatedStringValue",
		segments: node.segments.map((segment) => {
			if (segment.kind === "text") {
				return segment
			}

			return {
				kind: "expression",
				expression: simplifyExpression(segment.expression),
				witness: conformanceExpression(segment.conformance),
			}
		}),
		type: node.type,
		position: node.position,
	}
}

function simplifyIntegerValue(
	node: common.typed.IntegerValueNode,
): common.typedSimple.IntegerValueNode {
	return {
		nodeType: "IntegerValue",
		value: node.value,
		type: node.type,
		position: node.position,
	}
}

function simplifyRationalValue(
	node: common.typed.RationalValueNode,
): common.typedSimple.RationalValueNode {
	return {
		nodeType: "RationalValue",
		numerator: node.numerator,
		denominator: node.denominator,
		type: node.type,
		position: node.position,
	}
}

function simplifyBooleanValue(
	node: common.typed.BooleanValueNode,
): common.typedSimple.BooleanValueNode {
	return {
		nodeType: "BooleanValue",
		value: node.value,
		type: node.type,
		position: node.position,
	}
}

function simplifyFunctionValue(
	node: common.typed.FunctionValueNode,
): common.typedSimple.FunctionValueNode {
	return {
		nodeType: "FunctionValue",
		value: simplifyFunctionDefinition(node.value),
		type: node.type,
		position: node.position,
	}
}

function simplifyListValue(
	node: common.typed.ListValueNode,
): common.typedSimple.ListValueNode {
	return {
		nodeType: "ListValue",
		values: node.values.map((expr) => simplifyExpression(expr)),
		type: node.type,
		position: node.position,
	}
}

function simplifyLookup(
	node: common.typed.LookupNode,
): common.typedSimple.LookupNode {
	return {
		nodeType: "Lookup",
		base: simplifyExpression(node.base),
		member: simplifyIdentifier(node.member),
		type: node.type,
		position: node.position,
	}
}

function simplifyIdentifier(
	node: common.typed.IdentifierNode,
): common.typedSimple.IdentifierNode {
	return {
		nodeType: "Identifier",
		name: node.content,
		type: node.type,
		position: node.position,
	}
}

// NOTE: `@` lowers to the receiver Parameter every INSTANCE Method is emitted
// with — `simplifyMethods` unshifts `_self` for exactly those. A static Method
// is emitted without one, so an `@` reaching here from a static body would name
// a Variable nothing declares and the emitted Program would throw on first
// call. The Enricher refuses `@` there (`at-in-static-method`) and the Rewriter
// never runs on a Program with Errors, so this can only be a Compiler bug —
// which is worth a throw rather than JavaScript that dies at runtime.
function simplifySelf(
	node: common.typed.SelfNode,
): common.typedSimple.IdentifierNode {
	if (staticMethodDepth > 0) {
		throw new Error(
			"'@' reached the Simplifier inside a static Method, which is emitted without a receiver",
		)
	}

	return {
		nodeType: "Identifier",
		name: "_self",
		type: node.type,
		position: node.position,
	}
}

// NOTE: Module state rather than a parameter threaded through every simplify
// function — the check above is an invariant guard, and paying for it at each
// of the ~40 hand-offs between a Method and the Expressions in its body would
// cost more than the guard is worth. Counted rather than set, so that nesting
// restores the outer state exactly.
let staticMethodDepth = 0

function withinStaticMethod<Result>(run: () => Result): Result {
	staticMethodDepth += 1

	try {
		return run()
	} finally {
		staticMethodDepth -= 1
	}
}

function withoutStaticMethodBarrier<Result>(run: () => Result): Result {
	let outerDepth = staticMethodDepth
	staticMethodDepth = 0

	try {
		return run()
	} finally {
		staticMethodDepth = outerDepth
	}
}

function simplifyMatch(
	node: common.typed.MatchNode,
): common.typedSimple.MatchNode {
	// NOTE: The matched value is still the enclosing Method's business — `@`
	// written there is the receiver — so it is simplified before the Handlers
	// lift the static barrier.
	let value = simplifyExpression(node.value)

	return {
		nodeType: "Match",
		value,
		// NOTE: A Handler is emitted as a Function of its own taking `_self`,
		// the value that matched, so `@` inside one is bound however the
		// Handler was reached — including inside a static Method, where the
		// receiver `@` is refused. The barrier is lifted for the Handlers and
		// restored afterwards, exactly as the Enricher's Scope does it.
		handlers: withoutStaticMethodBarrier(() =>
			node.handlers.map((handler) => {
				return {
					matcher: handler.matcher,
					// NOTE: The Matcher's own descriptor check, until an
					// Optimiser pass finds something cheaper that answers the
					// same — the Simplifier states what the Program says and
					// nothing about how it is tested.
					typeTest: null,
					literal:
						handler.literal === null
							? null
							: simplifyExpression(handler.literal),
					memberLiterals:
						handler.memberLiterals === null
							? null
							: Object.fromEntries(
									Object.entries(handler.memberLiterals).map(
										([name, literal]) => [
											name,
											simplifyExpression(literal),
										],
									),
								),
					// NOTE: Types, not Expressions — nothing to simplify.
					memberTypes: handler.memberTypes,
					// NOTE: Filled by `compile-type-tests`, like `typeTest`.
					memberTests: null,
					guard:
						handler.guard === null
							? null
							: simplifyExpression(handler.guard),
					body: simplifyBody(handler.body),
				}
			}),
		),
		// NOTE: Every Handler is tested, and the chain ends in the
		// fall-through that names a Compiler bug — until an Optimiser pass can
		// say which Handler the end of the chain IS.
		finalHandlerIsElse: false,
		type: node.type,
		position: node.position,
	}
}

// #endregion

// #region Statements

function simplifyStatement(
	node: common.typed.StatementNode,
): common.typedSimple.StatementNode {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
			return simplifyConstantDeclarationStatement(node)
		case "VariableDeclarationStatement":
			return simplifyVariableDeclarationStatement(node)
		case "VariableAssignmentStatement":
			return simplifyVariableAssignmentStatement(node)
		case "NamespaceDefinitionStatement":
			return simplifyNamespaceDefinitionStatement(node)
		case "ProtocolDeclarationStatement":
			return simplifyProtocolDeclarationStatement(node)
		case "TypeAliasStatement":
			return simplifyTypeAliasStatement(node)
		case "ChoiceDeclarationStatement":
			return simplifyChoiceDeclarationStatement(node)
		case "IfElseStatement":
			return simplifyConditional(node)
		case "IfStatement":
			return simplifyConditional(node)
		case "ReturnStatement":
			return simplifyReturnStatement(node)
		case "FunctionStatement":
			return simplifyFunctionStatement(node)
	}
}

function simplifyConstantDeclarationStatement(
	node: common.typed.ConstantDeclarationStatementNode,
): common.typedSimple.VariableDeclarationStatementNode {
	return {
		nodeType: "VariableDeclarationStatement",
		name: simplifyIdentifier(node.name),
		value: simplifyExpression(node.value),
		type: node.type,
		isConstant: true,
		// NOTE: Every Constant keeps its Position, the base a Pattern
		// Declaration reads its members off included. It is synthesized in the
		// sense that no source wrote its NAME, but what it holds is the
		// Declaration's own value Expression — real source, on the line the
		// author wrote it — and it is the statement a debugger should stop on
		// for that line.
		//
		// Dropping it was tried and is wrong: an unmapped statement is how the
		// debug adapter recognises Compiler glue, so it answers a Step Over
		// there with a step OUT, and a single step across a Pattern Declaration
		// abandoned the rest of the function.
		position: node.position,
	}
}

function simplifyVariableDeclarationStatement(
	node: common.typed.VariableDeclarationStatementNode,
): common.typedSimple.VariableDeclarationStatementNode {
	return {
		nodeType: "VariableDeclarationStatement",
		name: simplifyIdentifier(node.name),
		value: simplifyExpression(node.value),
		type: node.type,
		isConstant: false,
		position: node.position,
	}
}

function simplifyVariableAssignmentStatement(
	node: common.typed.VariableAssignmentStatementNode,
): common.typedSimple.VariableAssignmentStatementNode {
	return {
		nodeType: "VariableAssignmentStatement",
		name: simplifyIdentifier(node.name),
		value: simplifyExpression(node.value),
		position: node.position,
	}
}

function simplifyNamespaceDefinitionStatement(
	node: common.typed.NamespaceDefinitionStatementNode,
): common.typedSimple.NamespaceDefinitionStatementNode {
	return {
		nodeType: "NamespaceDefinitionStatement",
		name: simplifyIdentifier(node.name),
		properties: Object.fromEntries(
			Object.entries(node.properties).map(([key, value]) => {
				return [key, simplifyExpression(value.value)]
			}),
		),
		methods: simplifyMethods(node.methods, node.type),
		nativeShims: node.nativeShims.map((shim) =>
			simplifyNativeShim(
				shim,
				node.type.targetType ?? { type: "Unknown" },
			),
		),
		type: node.type,
		position: node.position,
	}
}

// NOTE: The same two things `simplifyMethods` does to a bodied Method, done to
// the frame a native's default needs: the name is mangled with the Overload slot
// it was declared in, and the receiver `_self` is unshifted onto an instance
// Method's Parameters. Both have to agree with what the call site resolved to,
// and they do because both go through the one `resolveOverloadedMethodName` and
// the one `_self`.
function simplifyNativeShim(
	shim: common.typed.NativeShimNode,
	targetType: common.Type,
): common.typedSimple.NativeShimNode {
	let parameters = shim.parameters.map((parameter, index) =>
		simplifyParameter(parameter, index),
	)

	if (!shim.isStatic) {
		parameters.unshift({
			nodeType: "Parameter",
			externalName: null,
			internalName: {
				nodeType: "Identifier",
				name: "_self",
				type: targetType,
			},
			defaultValue: null,
		})
	}

	return {
		memberName:
			shim.overloadIndex === null
				? shim.memberName
				: resolveOverloadedMethodName(
						shim.memberName,
						shim.overloadIndex,
					),
		isStatic: shim.isStatic,
		parameters,
	}
}

// NOTE: Protocols are contracts only — they are erased here and emit no
// JavaScript. Conformance values passed at call sites are their only runtime
// footprint.
function simplifyProtocolDeclarationStatement(
	node: common.typed.ProtocolDeclarationStatementNode,
): common.typedSimple.ProtocolDeclarationStatementNode {
	return {
		nodeType: "ProtocolDeclarationStatement",
		name: simplifyIdentifier(node.name),
		position: node.position,
	}
}

function simplifyTypeAliasStatement(
	node: common.typed.TypeAliasStatementNode,
): common.typedSimple.TypeAliasStatementNode {
	return {
		nodeType: "TypeAliasStatement",
		name: simplifyIdentifier(node.name),
		type: node.type,
		position: node.position,
	}
}

// NOTE: A Choice Declaration is purely a Type-level construct — like a Type
// Alias it erases to nothing; only Case *constructions* have a runtime
// footprint.
function simplifyChoiceDeclarationStatement(
	node: common.typed.ChoiceDeclarationStatementNode,
): common.typedSimple.TypeAliasStatementNode {
	return {
		nodeType: "TypeAliasStatement",
		name: simplifyIdentifier(node.name),
		type: node.type,
		position: node.position,
	}
}

function simplifyConditional(
	node: common.typed.IfElseStatementNode | common.typed.IfStatementNode,
): common.typedSimple.ConditionalStatementNode {
	let convertedNode: common.typed.IfElseStatementNode
	if (node.nodeType === "IfStatement") {
		convertedNode = {
			nodeType: "IfElseStatement",
			condition: node.condition,
			trueBody: node.body,
			falseBody: [],
			position: node.position,
		}
	} else {
		convertedNode = node
	}

	return {
		nodeType: "ConditionalStatement",
		condition: simplifyExpression(convertedNode.condition),
		// NOTE: An Essence Boolean, which the Rewriter reads the JavaScript one
		// out of — until an Optimiser pass finds the question already asked in
		// JavaScript's terms. The Simplifier states what the Program says and
		// nothing about how it is tested.
		conditionIsRaw: false,
		trueBody: convertedNode.trueBody.map((node) =>
			simplifyImplementationNode(node),
		),
		falseBody: convertedNode.falseBody.map((node) =>
			simplifyImplementationNode(node),
		),
		position: node.position,
	}
}

function simplifyReturnStatement(
	node: common.typed.ReturnStatementNode,
): common.typedSimple.ReturnStatementNode {
	return {
		nodeType: "ReturnStatement",
		expression: simplifyExpression(node.expression),
		position: node.position,
	}
}

function simplifyFunctionStatement(
	node: common.typed.FunctionStatementNode,
): common.typedSimple.FunctionStatementNode {
	return {
		nodeType: "FunctionStatement",
		name: simplifyIdentifier(node.name),
		value: simplifyFunctionDefinition(node.value),
		position: node.position,
	}
}

// #endregion

// #region Helpers

function simplifyMembers(
	members: Record<string, common.typed.ExpressionNode>,
): Record<string, common.typedSimple.ExpressionNode> {
	let result: Record<string, common.typedSimple.ExpressionNode> = {}

	for (let [memberKey, memberExpression] of Object.entries(members)) {
		result[memberKey] = simplifyExpression(memberExpression)
	}

	return result
}

function simplifyMethods(
	methods: common.typed.Methods,
	type: common.Type,
): common.typedSimple.Methods {
	let result: common.typedSimple.Methods = {}

	for (let [memberKey, memberValue] of Object.entries(methods)) {
		if (
			memberValue.nodeType === "OverloadedMethod" ||
			memberValue.nodeType === "OverloadedStaticMethod"
		) {
			if (
				memberValue.overloadIndices.length !==
				memberValue.methods.length
			) {
				throw new Error(
					`Overloaded Method '${memberKey}' carries ${memberValue.overloadIndices.length} Overload indices for ${memberValue.methods.length} Overloads`,
				)
			}

			memberValue.methods.forEach((method, index) => {
				// NOTE: INVARIANT — the `__overload$N` suffix is derived from
				// the Overload's position in the Method TYPE's `overloads`
				// array, NEVER from its position in this Node's `methods`. The
				// two differ when the Method Type holds Overloads the Node does
				// not: a `declarations { … }` block may bind some Overloads to
				// the runtime and write the rest in Essence, and only the
				// bodied ones are here. A call site resolves its
				// `overloadedMethodIndex` against the full Type, so emitting
				// under a filtered index would define a name nobody calls and
				// clobber the native export that legitimately owns it. The
				// lengths are checked above rather than falling back to
				// `index`, which would quietly reinstate exactly that bug.
				let overloadIndex = memberValue.overloadIndices[index]!
				let newMethod =
					memberValue.nodeType === "OverloadedStaticMethod"
						? withinStaticMethod(() =>
								simplifyFunctionValue(method),
							)
						: simplifyFunctionValue(method)

				if (memberValue.nodeType === "OverloadedMethod") {
					newMethod.value.parameters.unshift({
						nodeType: "Parameter",
						externalName: null,
						internalName: {
							nodeType: "Identifier",
							name: "_self",
							type,
						},
						defaultValue: null,
					})
				}

				result[resolveOverloadedMethodName(memberKey, overloadIndex)] =
					{
						method: newMethod,
						isStatic:
							memberValue.nodeType === "OverloadedStaticMethod",
					}
			})
		} else {
			let method =
				memberValue.nodeType === "StaticMethod"
					? withinStaticMethod(() =>
							simplifyFunctionValue(memberValue.method),
						)
					: simplifyFunctionValue(memberValue.method)

			if (memberValue.nodeType === "SimpleMethod") {
				method.value.parameters.unshift({
					nodeType: "Parameter",
					externalName: null,
					internalName: {
						nodeType: "Identifier",
						name: "_self",
						type,
					},
					defaultValue: null,
				})
			}

			result[memberKey] = {
				method,
				isStatic: memberValue.nodeType === "StaticMethod",
			}
		}
	}

	return result
}

// NOTE: A Parameter that binds no name still occupies a position in the
// emitted Function, so it needs *some* name to be generated. Any unique one
// will do, precisely because nothing can reference it — and `_0` can not
// collide with a user Identifier, since `_` lexes as a Symbol and so can never
// start one.
function simplifyParameter(
	node: common.typed.ParameterNode,
	index: number,
): common.typedSimple.ParameterNode {
	return {
		nodeType: "Parameter",
		externalName: node.externalName
			? simplifyIdentifier(node.externalName)
			: null,
		internalName: node.internalName
			? simplifyIdentifier(node.internalName)
			: {
					nodeType: "Identifier",
					name: `_${index}`,
					type: { type: "Unknown" },
				},
		// NOTE: Lowered to a JavaScript default parameter by the Rewriter,
		// whose semantics are the ones the language declares term for term:
		// evaluated per call, only when the Argument came in `undefined`, left
		// to right, able to read the Parameters before it, and a temporal
		// dead-zone Error on one after it. We are not building an evaluation
		// model; we are naming one the target already has.
		defaultValue:
			node.defaultValue === null
				? null
				: simplifyExpression(node.defaultValue),
	}
}

// NOTE: The hole a call leaves where a Parameter took its default. See
// `openArgumentHoles`, which is the walk this and the emitted dispatch branch
// share, and `OmittedArgumentNode` for what a hole is.
function expandOmittedArguments(
	leading: Array<common.typedSimple.ArgumentNode>,
	written: Array<common.typedSimple.ArgumentNode>,
	omittedParameterIndices: Array<number>,
	trailing: Array<common.typedSimple.ArgumentNode>,
): Array<common.typedSimple.ArgumentNode> {
	return openArgumentHoles(
		leading,
		written,
		omittedParameterIndices,
		trailing,
		() => ({
			nodeType: "Argument" as const,
			name: null,
			value: {
				nodeType: "Intrinsic" as const,
				kind: "omitted-argument" as const,
				type: { type: "Unknown" as const },
			},
		}),
	)
}

// NOTE: A body that can fall off its end is only legal when it promises unit —
// for every other Return Type the Validator has already reported
// `missing-return` — but falling off the end of an emitted JavaScript Function
// answers `undefined`, which carries no hidden Type key and so is not an
// Essence value at all. The empty Record that was promised is spelled out here
// instead, at the one place a Function body and a Match Handler body both pass
// through; without it the failure surfaced somewhere else entirely, as a
// `TypeError` out of whatever read the missing Type key next.
function simplifyBody(
	body: Array<common.typed.ImplementationNode>,
): Array<common.typedSimple.ImplementationNode> {
	let simplifiedBody = body.map((node) => simplifyImplementationNode(node))

	if (bodyDefinitelyReturns(body)) {
		return simplifiedBody
	}

	return [
		...simplifiedBody,
		{
			nodeType: "ReturnStatement",
			expression: {
				nodeType: "RecordValue",
				type: { type: "Record", members: {} },
				members: {},
			},
		},
	]
}

function simplifyFunctionDefinition(
	node: common.typed.FunctionDefinitionNode,
): common.typedSimple.FunctionDefinitionNode {
	// NOTE: Every Protocol-bounded Type Parameter appends one hidden trailing
	// Parameter (`Item__conformance`) — call sites append the matching
	// conformance values in the same Generic declaration order.
	let conformanceParameters: Array<common.typedSimple.ParameterNode> =
		node.generics
			.filter((generic) => generic.constraint !== null)
			.map((generic) => ({
				nodeType: "Parameter",
				externalName: null,
				internalName: {
					nodeType: "Identifier",
					name: conformanceParameterName(generic.name),
					type: { type: "Unknown" },
				},
				defaultValue: null,
			}))

	return {
		nodeType: "FunctionDefinition",
		parameters: [
			...node.parameters.map((param, index) =>
				simplifyParameter(param, index),
			),
			...conformanceParameters,
		],
		body: simplifyBody(node.body),
		returnType: node.returnType,
	}
}

function simplifyArgument(
	node: common.typed.ArgumentNode,
): common.typedSimple.ArgumentNode {
	return {
		nodeType: "Argument",
		name: node.name,
		value: simplifyExpression(node.value),
	}
}
// #endregion
