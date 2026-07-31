import type { common } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	primary,
	reportError,
	reportWarning,
	secondary,
} from "../diagnostics/index"
import { eraseRefinements } from "../helpers/eraseRefinements"
import {
	bodyDefinitelyReturns,
	isUnitType,
	conformanceParameterName,
	countOf,
	createFreshenedInference,
	describeParameter,
	describeSignature,
	describeType,
	flattenUnionMembers,
	type MatchableArgument,
	matchArguments,
	matchesType,
	typeContainsError,
	withArticle,
} from "../helpers/index"
import {
	admittedByEvaluation,
	describePredicate,
	refinementDecidedBy,
} from "../helpers/predicateEval"

type CurrentFunctionContext = common.typed.FunctionDefinitionNode | null

type MatchHandler = common.typed.MatchNode["handlers"][number]

// NOTE: The Protocol-bounded Type Parameters of every enclosing Function
// Definition, innermost last — one Set per Function, because a Function
// literal written inside a bounded one reaches the enclosing hidden
// conformance Parameter the way any closure reaches what encloses it, so a
// witness resolves against the whole stack rather than against its top.
// Module state for the reason the Diagnostic collection is: the alternative is
// threading it through every `validate…` function, and only one Program is
// validated at a time.
let witnessScopes: Array<Set<string>> = []

// NOTE: Where each top-level Namespace is declared — its index in the top-level
// statement list, and the Position of its name. A Namespace is emitted as a
// `class`, whose binding does not exist until the Declaration itself runs, so a
// use that RUNS above it compiles clean and then fails. Read off the typed
// statement list rather than out of a Scope: a hoisted Namespace never enters
// the Enricher's declarations, and its Type carries no Position.
// Module state for the reason `witnessScopes` is.
let topLevelNamespaces: Map<
	string,
	{ index: number; position: common.Position }
> = new Map()

// NOTE: The index of the top-level statement whose execution is being
// validated, or null where what is being validated does not run yet — a
// Function body, which is emitted hoisted and runs whenever it is called. A
// static Property's initialiser is not such a place: it runs when its
// Namespace's Declaration does, so it keeps the index it is written under.
let executingTopLevelIndex: number | null = null

// NOTE: The static Property initialiser being validated: its Namespace's name,
// and the Properties of that Namespace which have no value yet where it runs —
// itself and everything written below it, each with the Position it is declared
// at. Null anywhere else, including inside a Function literal written in such an
// initialiser, whose body runs when it is called like any other.
// Module state for the reason `witnessScopes` is.
let initialisingProperty: {
	namespaceName: string
	unbound: Map<string, common.Position>
} | null = null

export const validate = (
	program: common.typed.Program,
): Array<common.Diagnostic> => {
	// NOTE: A fresh stack per run. Each frame is popped in a `finally`, so this
	// is the guarantee rather than the mechanism: no Program is ever checked
	// against a Type Parameter that another Program declared.
	witnessScopes = []
	topLevelNamespaces = collectTopLevelNamespaces(program.implementation.nodes)
	executingTopLevelIndex = null
	initialisingProperty = null

	let { diagnostics } = collectDiagnostics(() => {
		for (let [index, node] of program.implementation.nodes.entries()) {
			executingTopLevelIndex = index

			// NOTE: Expected errors are reported as Diagnostics and recovered
			// from in place — anything thrown past this point is a Compiler
			// bug. It is reported as a Diagnostic as well, so that a single
			// broken statement can not take down the validation of the
			// remaining Program.
			try {
				validateImplementationNode(node, null)
			} catch (error) {
				reportError(
					`Internal Compiler Error: ${
						error instanceof Error ? error.message : String(error)
					}`,
					node.position,
					{
						code: "internal-error",
						labels: [
							primary(node.position, "the Compiler threw here"),
						],
						notes: [
							"This is a bug in the Compiler, not in the Program.",
						],
					},
				)
			}
		}
	})

	return diagnostics
}

function collectTopLevelNamespaces(
	nodes: Array<common.typed.ImplementationNode>,
): Map<string, { index: number; position: common.Position }> {
	let namespaces = new Map<
		string,
		{ index: number; position: common.Position }
	>()

	for (let [index, node] of nodes.entries()) {
		// NOTE: The FIRST Declaration of a name is the one recorded — a name
		// declared twice is the Enricher's report to make, and until the second
		// one is removed it is the first that a use between them reaches.
		if (
			node.nodeType === "NamespaceDefinitionStatement" &&
			!namespaces.has(node.name.content)
		) {
			namespaces.set(node.name.content, {
				index,
				position: node.name.position,
			})
		}
	}

	return namespaces
}

function validateImplementationNode(
	node: common.typed.ImplementationNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.ImplementationNode {
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
			return validateExpression(node)
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "ProtocolDeclarationStatement":
		case "NamespaceDefinitionStatement":
		case "IfElseStatement":
		case "IfStatement":
		case "ReturnStatement":
		case "FunctionStatement":
			return validateStatement(node, currentFunctionContext)
	}
}

// #region Expressions

function validateExpression(
	node: common.typed.ExpressionNode,
): common.typed.ExpressionNode {
	switch (node.nodeType) {
		case "MethodInvocation":
			return validateMethodInvocation(node)
		case "FunctionInvocation":
			return validateFunctionInvocation(node)
		case "Lookup":
			return validateLookup(node)
		case "Identifier":
			return validateIdentifier(node)
		case "Match":
			return validateMatch(node)
		case "CaseValue":
			return validateCaseValue(node)
		case "FunctionValue":
			return validateFunctionValue(node)
		case "RationalValue":
			return validateRationalValue(node)
		case "RecordValue":
			return validateRecordValue(node)
		case "ListValue":
			return validateListValue(node)
		case "InterpolatedStringValue":
			return validateInterpolatedStringValue(node)
		case "Combination":
			return validateCombination(node)
		case "StringValue":
		case "IntegerValue":
		case "BooleanValue":
		case "Self":
			// these nodes dont need any validation
			return node
	}
}

// NOTE: A value whose Type is a Function with Protocol-bounded Type
// Parameters can not travel — its hidden conformance parameters only exist
// at direct invocations, where the Enricher resolves them from the concrete
// bindings. A stored bounded Function would later be invoked without its
// conformances, so every value position rejects it.
function validateNoBoundFunctionValue(node: common.typed.ExpressionNode): void {
	// NOTE: An overloaded Function is a SET of signatures, not one Function value
	// — a bare reference (`constant f = someOverloadedFn`) names every overload
	// at once, and nothing downstream can pick which one a later invocation
	// meant. Refused in every value position, exactly like a bounded Function,
	// and for the same reason: resolution only happens at a direct call.
	if (
		node.type.type === "OverloadedMethod" ||
		node.type.type === "OverloadedStaticMethod"
	) {
		let count = node.type.overloads.length

		reportError(
			"An overloaded Function can not be used as a value",
			node.position,
			{
				code: "overloaded-function-value",
				labels: [
					primary(
						node.position,
						`this names all ${count} overloads at once`,
					),
				],
				helps: [
					"Invoke it, or wrap the overload you mean in a Function literal.",
				],
			},
		)

		return
	}

	if (isBoundFunctionType(node.type)) {
		reportError(
			"A Function with Protocol-bound Type Parameters can not be used as a value",
			node.position,
			{
				code: "protocol-bound-function-value",
				labels: [
					primary(
						node.position,
						"this Function is stored, not called",
					),
				],
				notes: [
					"A bounded Function carries hidden conformance Parameters that only exist at a direct invocation.",
				],
				helps: ["Call it directly instead of passing it around."],
			},
		)
	}
}

function isBoundFunctionType(type: common.Type): boolean {
	if (
		type.type === "Function" ||
		type.type === "SimpleMethod" ||
		type.type === "StaticMethod"
	) {
		return type.generics.some((generic) => generic.constraint != null)
	}

	if (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	) {
		return type.overloads.some((overload) =>
			overload.generics.some((generic) => generic.constraint != null),
		)
	}

	return false
}

// NOTE: The two checks below are about the COMPILER, not about the Program:
// each states an invariant the emitted JavaScript rests on, and each throws
// where it does not hold, which `validate` turns into the `internal-error`
// Diagnostic. They are safety nets — every hole they were written for is fixed
// — and what they buy is that the next one shows up as a Diagnostic naming the
// call it is about, rather than as a `ReferenceError` or a wrong answer out of
// the emitted Program.
//
// NOTE: The Language Server runs the Validator whenever the ENRICHER was
// clean, which a Program the Parser already broke can be — so one of these can
// report beside the Diagnostic that explains it. That is accepted: a
// double-report on a Program that does not compile costs a line of output,
// while gating the check on there being no other Diagnostic at all would take
// the net away from every Program that has one.

// NOTE: The Type Parameters of the Signature an Invocation resolved to — one
// entry per Overload, so a Method that has several is asked about the one the
// Arguments picked. Null where there is no Signature to count: a callee that is
// not a Function at all, or an overloaded one no index was settled on, both of
// which the Enricher has already reported.
function invokedSignatureGenerics(
	calleeType: common.Type,
	overloadedMethodIndex: number | null,
): Array<common.GenericDeclaration> | null {
	if (
		calleeType.type === "Function" ||
		calleeType.type === "SimpleMethod" ||
		calleeType.type === "StaticMethod"
	) {
		return calleeType.generics
	}

	if (
		calleeType.type === "OverloadedMethod" ||
		calleeType.type === "OverloadedStaticMethod"
	) {
		return overloadedMethodIndex === null
			? null
			: (calleeType.overloads[overloadedMethodIndex]?.generics ?? null)
	}

	return null
}

// NOTE: A bounded Type Parameter appends one hidden trailing Parameter to the
// emitted Function and one hidden trailing Argument to every call of it, so a
// call site that resolved a different NUMBER of witnesses than its callee
// declares bounds emits a call whose Arguments are shifted — the witness lands
// in a Parameter that expected a value, and the Program fails somewhere else
// entirely.
//
// NOTE: The callee Type is read BY REFERENCE at validation time, which is the
// point of the check rather than an implementation detail: a conditional
// conformance's bounds are woven into a Namespace's Method Types while the
// Namespace hoists, so a call enriched BEFORE the weave — a use site written
// above the Namespace — resolved its witnesses against a Signature that had no
// bounds yet, and only the finally-woven Type says so.
//
// NOTE: An Error anywhere in what the Invocation was resolved FROM is why a
// witness would be missing — a Type Parameter bound to an Error is skipped on
// purpose, so that the one mistake is reported once, where it was made — and
// the count says nothing then. The Validator only runs when the Enricher was
// clean, so this is reachable only for a Program the Parser already broke.
function checkConformanceArity(
	node:
		| common.typed.MethodInvocationNode
		| common.typed.FunctionInvocationNode,
	calleeType: common.Type | undefined,
	describeCallee: () => string,
): void {
	if (calleeType === undefined || typeContainsError(calleeType)) {
		return
	}

	if (
		typeContainsError(node.type) ||
		node.arguments.some((argumentNode) =>
			typeContainsError(argumentNode.type),
		) ||
		(node.nodeType === "MethodInvocation" &&
			typeContainsError(node.base.type))
	) {
		return
	}

	let generics = invokedSignatureGenerics(
		calleeType,
		node.overloadedMethodIndex,
	)

	if (generics === null) {
		return
	}

	let bounded = generics.filter(
		(generic) => generic.constraint != null,
	).length

	if (bounded === node.conformances.length) {
		return
	}

	throw new Error(
		`${describeCallee()} was given ${countOf(node.conformances.length, "conformance Argument")} for a Signature with ${countOf(bounded, "Protocol-bounded Type Parameter")}. This is a bug in the Compiler.`,
	)
}

// NOTE: WHICH Overload a call resolved to is settled once, by the Enricher, and
// the Validator only checks that the Signature it settled on still accepts the
// Arguments — it is a consumer of `overloadedMethodIndex`, never a second
// selector. Selecting again here would ask the question without what the
// Enricher had to answer it: an unannotated Function literal reads its
// Parameter Types off the Overload it is matched against, and a Protocol bound
// is solved against the bindings that Overload inferred, neither of which a
// typed Node carries. A different answer would not be a Diagnostic either — the
// Simplifier mangles the callee from this index, so the call would be EMITTED
// against an Overload the Program was never type-checked against.
//
// NOTE: The same Error rails as the checks above, and for the same reason: what
// the Arguments were matched with is what a missing index or an Error-tainted
// Argument says nothing about.
function checkCommittedOverload(
	node: common.typed.FunctionInvocationNode,
	functionType:
		| common.OverloadedMethodType
		| common.OverloadedStaticMethodType,
	describeCallee: () => string,
): void {
	if (
		node.overloadedMethodIndex === null ||
		typeContainsError(node.type) ||
		node.arguments.some((argumentNode) =>
			typeContainsError(argumentNode.type),
		)
	) {
		return
	}

	let overload = functionType.overloads[node.overloadedMethodIndex]

	if (overload === undefined) {
		throw new Error(
			`${describeCallee()} was committed to overload ${node.overloadedMethodIndex} of a callee that has ${countOf(functionType.overloads.length, "overload")}. This is a bug in the Compiler.`,
		)
	}

	let { parameterTypes, context } = createFreshenedInference(overload)

	if (
		matchArguments(
			parameterTypes,
			matchableArgumentsFromTypedNodes(node.arguments),
			{ inference: context },
		).type !== "Match"
	) {
		throw new Error(
			`${describeCallee()} was committed to the overload that ${describeSignature(overload.parameterTypes)}, which does not accept the Arguments it passes. This is a bug in the Compiler.`,
		)
	}
}

// NOTE: A `parameter` source forwards the enclosing bounded Function's own
// hidden conformance Parameter, which the Simplifier emits from that Function's
// constrained Generics — so the name has to be one of those, from this Function
// or from one it is written inside. Where it is not, the emitted call reads a
// binding nothing declares: a `ReferenceError` at run time out of a Program
// that compiled without a word. The names compared are the EMITTED ones on both
// sides, which is what keeps the check about the JavaScript rather than about
// the Type Parameter each side happens to call its own.
//
// NOTE: Conditions are walked alongside the conformance that carries them — a
// conditional conformance curries one witness per `where` condition, each
// solved the same way, so each can forward a Parameter just as the outer one
// can.
function checkWitnessScope(
	conformances: Array<common.Conformance>,
	describeSite: () => string,
): void {
	for (let conformance of conformances) {
		if (conformance.source.kind === "namespace") {
			checkWitnessScope(conformance.source.conditions, describeSite)

			continue
		}

		let name = conformance.source.name

		if (!witnessScopes.some((scope) => scope.has(name))) {
			throw new Error(
				`${describeSite()} forwards the conformance Parameter '${name}', which no enclosing Function declares. This is a bug in the Compiler.`,
			)
		}
	}
}

// NOTE: A `namespace` source is spelled into the Argument list of the CALL, not
// of the Declaration it comes from — `things::sort()` emits `{ compare:
// Thing.compare }` — so a call that RUNS above the conforming Namespace reads
// a `class` binding that holds nothing yet. The Namespace's name appears
// nowhere in the source, which is why the rails that check the names a call
// does spell walk straight past it; it is the same fault they report, one
// indirection further in.
//
// NOTE: Conditions are walked alongside the conformance that carries them, for
// the reason `checkWitnessScope` walks them: a conditional conformance names
// one more Namespace per `where` condition, and every one of them is spelled
// into the same Argument list. Each name is reported once, so a Signature that
// bounds two Type Parameters through the same Namespace does not say it twice.
function checkWitnessNamespacesAreDeclared(
	conformances: Array<common.Conformance>,
	position: common.Position,
	describeUse: (protocolName: string) => string,
): void {
	let protocolsByNamespace = new Map<string, string>()

	let collect = (candidates: Array<common.Conformance>): void => {
		for (let conformance of candidates) {
			if (conformance.source.kind !== "namespace") {
				continue
			}

			if (!protocolsByNamespace.has(conformance.source.name)) {
				protocolsByNamespace.set(
					conformance.source.name,
					conformance.protocolName,
				)
			}

			collect(conformance.source.conditions)
		}
	}

	collect(conformances)

	for (let [namespaceName, protocolName] of protocolsByNamespace) {
		checkNamespaceIsDeclared(
			namespaceName,
			position,
			describeUse(protocolName),
		)
	}
}

function validateMethodInvocation(
	node: common.typed.MethodInvocationNode,
): common.typed.MethodInvocationNode {
	for (let argumentNode of node.arguments) {
		validateExpression(argumentNode.value)
		validateNoBoundFunctionValue(argumentNode.value)
	}

	validateExpression(node.base)

	if (node.dispatch !== null) {
		// NOTE: A dispatch branch's own copy of a contextually typed Argument is
		// a whole Expression that reaches the emitted Program, and the shared
		// Argument walked above is a DIFFERENT compilation of the same source —
		// so every check the shared one gets, each copy has to get too, or a
		// fault the copies alone carry would be emitted unexamined.
		for (let dispatchCase of node.dispatch) {
			for (let { argument } of dispatchCase.contextualArguments) {
				validateExpression(argument.value)
				validateNoBoundFunctionValue(argument.value)
			}
		}

		validateDispatchCases(node, node.dispatch)
	}

	let describeCallee = () => `'${node.namespace.name}::${node.member.name}'`

	// NOTE: A dispatched Invocation names no Namespace of its own — each branch
	// carries its target by NAME, with no Type to read a Signature off — so the
	// arity of its witnesses is the one thing here that can not be cross-checked.
	// Their scopes still can be, and are, for every branch.
	if (node.dispatch === null) {
		checkConformanceArity(
			node,
			node.namespace.type.methods[node.member.name],
			describeCallee,
		)
		checkWitnessScope(node.conformances, describeCallee)
		checkNamespaceIsDeclared(
			node.namespace.name,
			node.member.position,
			"this Method comes from it",
		)
		checkWitnessNamespacesAreDeclared(
			node.conformances,
			node.member.position,
			(protocolName) =>
				`this call's ${protocolName} conformance comes from it`,
		)
	} else {
		for (let dispatchCase of node.dispatch) {
			checkWitnessScope(
				dispatchCase.conformances,
				() =>
					`'${dispatchCase.namespaceName}::${node.member.name}', the branch for ${describeType(dispatchCase.memberType)},`,
			)
			checkNamespaceIsDeclared(
				dispatchCase.namespaceName,
				node.member.position,
				`the branch for ${describeType(dispatchCase.memberType)} takes this Method from it`,
			)
			checkWitnessNamespacesAreDeclared(
				dispatchCase.conformances,
				node.member.position,
				(protocolName) =>
					`the branch for ${describeType(dispatchCase.memberType)} takes its ${protocolName} conformance from it`,
			)
		}
	}

	return node
}

// NOTE: The dispatch branches are the Cases of a Match nobody wrote — the
// receiver's runtime Type picks one, the first that fits wins, and the same two
// things that let a Case swallow the Case below it let a branch swallow the
// branch below it. The Enricher orders them most specific first, so a branch
// still covering another after that is covering it through something that does
// not survive to runtime, which no order can fix.
function validateDispatchCases(
	node: common.typed.MethodInvocationNode,
	dispatchCases: Array<common.DispatchCase>,
): void {
	for (let index = 0; index < dispatchCases.length; index++) {
		for (let later = index + 1; later < dispatchCases.length; later++) {
			let earlierType = dispatchCases[index].memberType
			let laterType = dispatchCases[later].memberType

			if (acceptsAllAtRuntime(earlierType, laterType)) {
				reportError(
					`The branch for ${describeType(laterType)} can never run`,
					node.member.position,
					{
						code: "erased-case-conflict",
						labels: [
							primary(
								node.member.position,
								`${describeType(earlierType)} answers for every value it would take`,
							),
							secondary(
								node.base.position,
								`this is ${withArticle(describeType(node.base.type))}`,
							),
						],
						notes: [
							"A branch is picked by the receiver's Type at runtime, and the first one that fits wins.",
							"A Function's Signature does not survive to be checked — a member Type naming a callback is only ever asked whether the value is callable, which makes two of them ask the same question.",
						],
						helps: [
							"Tell the two member Types apart by something that survives to runtime, or narrow the value with a Match Expression before calling the Method.",
						],
					},
				)

				return
			}

			if (overlapsAtRuntime(earlierType, laterType)) {
				reportWarning(
					`The branch for ${describeType(laterType)} never sees an empty List`,
					node.member.position,
					{
						code: "empty-list-overlap",
						labels: [
							primary(
								node.member.position,
								`an empty List fits ${describeType(earlierType)} too, and that branch is tried first`,
							),
							secondary(
								node.base.position,
								`this is ${withArticle(describeType(node.base.type))}`,
							),
						],
						notes: [
							"Item Types erase before a branch is picked, so a List is placed by the items it holds — and an empty List holds none, which makes it a value of every List Type there is.",
						],
						helps: [
							"Narrow the value with a Match Expression before calling the Method.",
						],
					},
				)

				return
			}
		}
	}
}

function validateFunctionInvocation(
	node: common.typed.FunctionInvocationNode,
): common.typed.FunctionInvocationNode {
	const functionType = node.name.type

	for (let argumentNode of node.arguments) {
		validateExpression(argumentNode.value)
		validateNoBoundFunctionValue(argumentNode.value)
	}

	// NOTE: The callee is not walked as an Expression of its own — a static call
	// (`Namespace.method(…)`) is the one shape whose callee names something that
	// can be too early, so it is asked about here rather than through
	// `validateIdentifier`, which would never see it. The Property behind the
	// call is asked about for the same reason: a static Property holding a
	// Function is CALLED through the very Lookup that reads it, so the read
	// would go unexamined.
	if (
		node.name.nodeType === "Lookup" &&
		node.name.base.nodeType === "Identifier" &&
		node.name.base.type.type === "Namespace"
	) {
		checkNamespaceIsDeclared(
			node.name.base.content,
			node.name.base.position,
			"this names it",
		)
		checkPropertyIsBound(node.name)
	}

	// NOTE: An Identifier callee names itself; a Lookup and an Expression that
	// answers with a Function have no one name to give, and the Position the
	// Diagnostic carries says which call is meant either way.
	let describeCallee = () =>
		node.name.nodeType === "Identifier"
			? `'${node.name.content}'`
			: "This call"

	checkConformanceArity(node, functionType, describeCallee)
	checkWitnessScope(node.conformances, describeCallee)
	checkWitnessNamespacesAreDeclared(
		node.conformances,
		node.name.position,
		(protocolName) =>
			`this call's ${protocolName} conformance comes from it`,
	)

	if (
		functionType.type !== "Function" &&
		functionType.type !== "SimpleMethod" &&
		functionType.type !== "StaticMethod" &&
		functionType.type !== "OverloadedMethod" &&
		functionType.type !== "OverloadedStaticMethod"
	) {
		if (functionType.type !== "Error") {
			reportError("This Expression is not a Function", node.position, {
				code: "not-a-function",
				labels: [
					primary(
						node.position,
						`this is ${withArticle(describeType(functionType))}`,
					),
				],
			})
		}

		return node
	}

	if (
		functionType.type === "Function" ||
		functionType.type === "StaticMethod"
	) {
		validateSimpleFunctionInvocation(
			functionType,
			node.arguments,
			node.position,
		)
	} else {
		// Dynamic methods, being called in a manually via `.` are being validated here,
		// as opposed to methods that are being called with `::` which get validated by `validateMethodInvocation`
		if (
			functionType.type === "OverloadedMethod" ||
			functionType.type === "OverloadedStaticMethod"
		) {
			checkCommittedOverload(node, functionType, describeCallee)
		} else {
			let { parameterTypes, context } =
				createFreshenedInference(functionType)
			let matchResult = matchArguments(
				parameterTypes,
				matchableArgumentsFromTypedNodes(node.arguments),
				{
					collectAllMismatches: true,
					inference: context,
				},
			)

			if (matchResult.type === "ArityMismatch") {
				reportArityMismatch(
					functionType.parameterTypes,
					node.arguments.length,
					node.position,
				)

				return node
			}

			if (matchResult.type === "ArgumentMismatch") {
				for (let i of matchResult.mismatchedArgumentIndices) {
					reportArgumentMismatch(
						functionType.parameterTypes,
						i,
						node.arguments[i],
					)
				}
			}
		}
	}

	return node
}

function validateFunctionDefinition(
	node: common.typed.FunctionDefinitionNode,
	position: common.Position,
): common.typed.FunctionDefinitionNode {
	// NOTE: The hidden conformance Parameters this Function is emitted with —
	// the Simplifier reads them off these same Generic Declarations, so what a
	// witness inside the body may forward is exactly what is pushed here.
	witnessScopes.push(
		new Set(
			node.generics
				.filter((generic) => generic.constraint !== null)
				.map((generic) => conformanceParameterName(generic.name)),
		),
	)

	// NOTE: A body does not run where it is written — it runs when the Function
	// is called, which is at the earliest the statement that calls it — so
	// nothing inside it is a top-level use, however far above a Declaration it
	// stands. A Function literal written INSIDE a static Property's initialiser
	// is such a body too: what it names is read when it is called, by which time
	// every Property of its Namespace is bound.
	let enclosingIndex = executingTopLevelIndex
	let enclosingProperty = initialisingProperty

	executingTopLevelIndex = null
	initialisingProperty = null

	try {
		node.body.map((bodyNode) => validateImplementationNode(bodyNode, node))
	} finally {
		executingTopLevelIndex = enclosingIndex
		initialisingProperty = enclosingProperty
		witnessScopes.pop()
	}

	validateDefiniteReturn(node, position)

	return node
}

function validateLookup(
	node: common.typed.LookupNode,
): common.typed.LookupNode {
	validateExpression(node.base)
	checkPropertyIsBound(node)

	return node
}

// NOTE: A static Property read out of the initialiser of a Property of the SAME
// Namespace, where the one being read is written at or below the one reading it.
// The Namespace is emitted as a `class` and its Properties as static fields,
// which are initialised in the order they are written, so the read answers
// `undefined` — a value of no Type at all, out of a Program that compiled green.
//
// It is the same fault `checkNamespaceIsDeclared` reports one level up, and
// carries the same code: something that runs above a Declaration reaches for
// what that Declaration binds. A Method is not among them — it is installed with
// the class, ahead of every initialiser — and neither is a body, which runs when
// it is called.
function checkPropertyIsBound(node: common.typed.LookupNode): void {
	if (
		initialisingProperty === null ||
		node.base.nodeType !== "Identifier" ||
		node.base.type.type !== "Namespace" ||
		node.base.content !== initialisingProperty.namespaceName
	) {
		return
	}

	let declaration = initialisingProperty.unbound.get(node.member.content)

	if (declaration === undefined) {
		return
	}

	reportError(
		`Property '${initialisingProperty.namespaceName}.${node.member.content}' is read before it has a value`,
		node.member.position,
		{
			code: "use-before-declaration",
			labels: [
				primary(node.member.position, "this reads it"),
				secondary(declaration, "it is given its value here"),
			],
			notes: [
				"A static Property is given its value where it is written, in order, so one written above it has nothing to read yet.",
			],
			helps: ["Move this Declaration below the one it reads."],
		},
	)
}

// NOTE: A name is nothing but a name in every other respect — the one thing it
// can be wrong about on its own is naming a Namespace from above the Declaration
// of it. A static Method call and a static Property read both reach here through
// the base of their Lookup, which is where the Namespace is written.
function validateIdentifier(
	node: common.typed.IdentifierNode,
): common.typed.IdentifierNode {
	if (node.type.type === "Namespace") {
		checkNamespaceIsDeclared(node.content, node.position, "this names it")
	}

	return node
}

function validateMatch(node: common.typed.MatchNode): common.typed.MatchNode {
	validateExpression(node.value)

	if (node.value.type.type === "UnionType") {
		// NOTE: Flattened, so that a Union member that is itself a Union — a
		// Choice composed as `CalculatorOperation | String`, or `Number |
		// String` — is discharged by Handlers for its *members* rather than
		// demanding one Handler for the nested Union as a whole.
		let memberTypes = flattenUnionMembers(node.value.type)
		let unhandledTypes: Array<common.Type> = []

		for (let memberType of memberTypes) {
			let isHandled = node.handlers.some(
				(handler) =>
					isUnconditionalHandler(handler) &&
					matchesType(handler.matcher, memberType),
			)

			if (!isHandled) {
				unhandledTypes.push(memberType)
			}
		}

		// NOTE: One Diagnostic for the whole Match rather than one per
		// unhandled member — they all have the same cause and the same fix,
		// and a Union of six unhandled members would otherwise bury the rest
		// of the output.
		if (unhandledTypes.length > 0) {
			let descriptions = unhandledTypes.map(describeType)

			reportError(
				`This Match Expression does not handle every Case`,
				node.position,
				{
					code: "missing-case",
					labels: [
						primary(
							node.value.position,
							`this is ${withArticle(describeType(node.value.type))}`,
						),
					],
					notes: [
						`Unhandled: ${descriptions.map((description) => `'${description}'`).join(", ")}.`,
					],
					helps: [
						`Add ${descriptions.map((description) => `'case ${description}'`).join(", ")}, or a 'case _' that covers the rest.`,
					],
					// NOTE: The same spellings once more, in declaration
					// order, for the Quick Fix that writes the Handlers out.
					data: { kind: "missing-case", unhandled: descriptions },
				},
			)
		}

		// NOTE: Which Handler already answers for each member of the Union, by
		// index — a Handler is dead not only when its Matcher names a Type the
		// Union does not have, but also when every Type it could match was
		// already taken by an earlier Handler. Only an unconditional Handler
		// takes one: a Handler that can decline a value it accepted by Type
		// leaves that Type for whatever comes after it.
		let claimedBy: Array<number | null> = memberTypes.map(() => null)

		for (
			let handlerIndex = 0;
			handlerIndex < node.handlers.length;
			handlerIndex++
		) {
			let handler = node.handlers[handlerIndex]
			let matchedMemberIndices: Array<number> = []

			for (
				let memberIndex = 0;
				memberIndex < memberTypes.length;
				memberIndex++
			) {
				if (
					acceptsAllAtRuntime(
						handler.matcher,
						memberTypes[memberIndex],
					)
				) {
					matchedMemberIndices.push(memberIndex)
				}
			}

			if (matchedMemberIndices.length === 0) {
				// NOTE: Tagged `unnecessary` so that clients grey the case out
				// instead of underlining it — it is dead, not wrong. The
				// Position is the Matcher's, so only the dead Handler is
				// greyed out rather than the whole Match.
				reportWarning(
					`This Case can never match`,
					handler.matcherPosition,
					{
						code: "unreachable-case",
						tags: ["unnecessary"],
						labels: [
							primary(
								handler.matcherPosition,
								`${describeType(handler.matcher)} is not a member of the matched Union`,
							),
							secondary(
								node.value.position,
								`this is ${withArticle(describeType(node.value.type))}`,
							),
						],
					},
				)

				continue
			}

			let claimingHandlerIndices: Array<number> = []

			for (let memberIndex of matchedMemberIndices) {
				let claimingHandlerIndex = claimedBy[memberIndex]

				if (claimingHandlerIndex !== null) {
					claimingHandlerIndices.push(claimingHandlerIndex)
				}
			}

			// NOTE: Every Type this Handler could match is spoken for, and the
			// first Handler that fits is the one that runs — so this one never
			// does, whether it is a duplicated `case Integer` or a Case written
			// below the `case _` that swallows it. Its own Guard or literal
			// makes no difference: the earlier Handler decides first.
			if (claimingHandlerIndices.length === matchedMemberIndices.length) {
				let claimingHandler =
					node.handlers[Math.min(...claimingHandlerIndices)]

				// NOTE: WHY the earlier Case answers for this one decides what
				// there is to say about it, and two of the three reasons are
				// nowhere in the source. A Generic Matcher covers its members
				// because there is nothing left to check by the time it runs,
				// and a Function-typed member covers a differently-signed one
				// because a Signature is not a runtime question — in both cases
				// the Diagnostic names two Types that look unrelated, and
				// without the reason it reads like a mistake.
				let notes = [
					"Cases are tried in order, and the first one that fits wins.",
				]
				let helps = [
					"Remove this Case, or write it above the one that covers it.",
				]
				// NOTE: The two reasons that are ERASURE rather than dead code.
				// A Case shadowed by a Type that covers it is a Case nobody
				// needed; a Case shadowed by a Type the source says it is
				// unrelated to is a Program answering with the wrong value —
				// `case Value` above `case Nothing` returned the Nothing where
				// the Signature promised a Value, and a Warning let that build.
				let erased = false

				if (claimingHandler.matcher.type === "GenericUse") {
					erased = true

					notes.push(
						`Types erase before a Match runs, so the Generic Case '${describeType(claimingHandler.matcher)}' narrows nothing and accepts every value that reaches it.`,
					)

					helps = [
						`Write this Case above 'case ${describeType(claimingHandler.matcher)}', which can only ever be the last one.`,
					]
				} else if (
					!matchesType(claimingHandler.matcher, handler.matcher)
				) {
					// NOTE: The earlier Matcher does not accept this one's Type
					// at all, so what it claimed it claimed through erasure —
					// which is only ever a Function-typed member. Reordering can
					// not help here: whichever of the two is written first
					// swallows the other.
					erased = true

					notes.push(
						"A Function's Signature erases before a Match runs, so a Function-typed member is only ever checked for being callable — which makes these two Matchers ask the same question.",
					)

					helps = [
						"Tell the two Cases apart by a member that survives to runtime, or give this one a Guard.",
					]
				}

				let labels: [
					common.DiagnosticLabel,
					...Array<common.DiagnosticLabel>,
				] = [
					primary(
						handler.matcherPosition,
						"an earlier Case already answers for every Type this one matches",
					),
					secondary(
						claimingHandler.matcherPosition,
						"this Case runs first",
					),
				]

				if (erased) {
					reportError(
						`This Case can never match`,
						handler.matcherPosition,
						{
							code: "erased-case-conflict",
							labels,
							notes,
							helps,
						},
					)
				} else {
					// NOTE: Tagged `unnecessary` so that clients grey the Case
					// out instead of underlining it — it is dead, not wrong,
					// which is exactly what the erased pair above is not.
					reportWarning(
						`This Case can never match`,
						handler.matcherPosition,
						{
							code: "unreachable-case",
							tags: ["unnecessary"],
							labels,
							notes,
							helps,
						},
					)
				}
			} else {
				reportEmptyListOverlap(
					node,
					handlerIndex,
					matchedMemberIndices,
					memberTypes,
				)

				if (isUnconditionalHandler(handler)) {
					for (let memberIndex of matchedMemberIndices) {
						if (claimedBy[memberIndex] === null) {
							claimedBy[memberIndex] = handlerIndex
						}
					}
				}
			}
		}
	} else if (isLiteralMatch(node)) {
		validateLiteralMatchShape(node)
	} else if (node.value.type.type !== "Error") {
		reportError(
			"Match Expressions require a Union Type",
			node.value.position,
			{
				code: "match-on-non-union",
				labels: [
					primary(
						node.value.position,
						`this is ${withArticle(describeType(node.value.type))}`,
					),
				],
				notes: [
					"Matching a Type with only one possible shape has only one outcome.",
				],
			},
		)
	}

	for (let handler of node.handlers) {
		// NOTE: A Guard decides, per value, whether its Handler runs — it is a
		// Condition, and is held to what every other Condition is held to.
		if (handler.guard !== null) {
			validateCondition(handler.guard, "A Case Guard")
		}

		// NOTE: A Matcher's literals are Expressions of their own — only a
		// Literal can stand there, so in practice this is `case 1/0`'s
		// denominator, but a Matcher is no more exempt from the walk than any
		// other place a value is written.
		if (handler.literal !== null) {
			validateExpression(handler.literal)
		}

		if (handler.memberLiterals !== null) {
			for (let memberLiteral of Object.values(handler.memberLiterals)) {
				validateExpression(memberLiteral)
			}
		}

		// NOTE: Synthetic — a Match handler is validated as if it were a
		// Function body so that its `<-` Statements are checked against the
		// Match's Type. It has no Parameter list of its own, so nothing here
		// is ever inferred or hinted.
		let handlerContext: common.typed.FunctionDefinitionNode = {
			nodeType: "FunctionDefinition",
			generics: [],
			parameters: [],
			body: handler.body,
			returnType: node.type,
			inferredReturnType: null,
			parameterListPosition: node.position,
			headPosition: node.position,
		}

		for (let bodyNode of handler.body) {
			validateImplementationNode(bodyNode, handlerContext)
		}

		validateDefiniteReturn(handlerContext, node.position)
	}

	return node
}

// NOTE: A Case that an earlier one takes values from without covering it — the
// two Matchers are told apart by something that does not survive to runtime.
// Only one thing overlaps that way: an empty List fits every List Matcher, so
// `case List<String>` above `case List<Integer>` answers for an empty
// `List<Integer>` and this Case never sees one. Nothing said so before, in
// either direction — the Validator called the two unrelated and the runtime
// took the earlier branch.
//
// NOTE: One Diagnostic per Handler, on the first earlier Case that overlaps it.
// Members the earlier Case takes ENTIRELY are none of this: those are the
// dead-Case reports above, and this Handler still runs for the rest.
function reportEmptyListOverlap(
	node: common.typed.MatchNode,
	handlerIndex: number,
	matchedMemberIndices: Array<number>,
	memberTypes: Array<common.Type>,
): void {
	let handler = node.handlers[handlerIndex]

	for (let earlierIndex = 0; earlierIndex < handlerIndex; earlierIndex++) {
		let earlierHandler = node.handlers[earlierIndex]

		if (!isUnconditionalHandler(earlierHandler)) {
			continue
		}

		for (let memberIndex of matchedMemberIndices) {
			let memberType = memberTypes[memberIndex]

			if (
				acceptsAllAtRuntime(earlierHandler.matcher, memberType) ||
				!overlapsAtRuntime(earlierHandler.matcher, memberType)
			) {
				continue
			}

			reportWarning(
				"This Case never sees an empty List",
				handler.matcherPosition,
				{
					code: "empty-list-overlap",
					labels: [
						primary(
							handler.matcherPosition,
							`an empty ${describeType(memberType)} fits the Case above too`,
						),
						secondary(
							earlierHandler.matcherPosition,
							"this Case runs first",
						),
					],
					notes: [
						"Cases are tried in order, and the first one that fits wins.",
						"Item Types erase before a Match runs, so a List Matcher asks about the items the value holds — and an empty List holds none, which makes it a value of every List Type there is.",
					],
					helps: [
						"Guard the Cases with 'where @::hasItems()' and answer for the empty List in a Case of its own.",
					],
				},
			)

			return
		}
	}
}

// NOTE: A Match that takes a VALUE apart rather than a Type — `match n { case 0
// { … } case _ { … } }`. There is no Union here to be exhaustive over, so what
// stands in for exhaustiveness is the SHAPE: every Case names a value, and the
// last one answers for every value the Cases above it did not name.
//
// NOTE: That last Case is also where evidence comes from. Reaching it proves the
// value is none of the values named above, which is the `isNot` a refinement is
// declared by — `refinedSelfType` in the Enricher is what reads it — so the
// shape is a rule about what the Program MEANS rather than a matter of style.
//
// NOTE: Integer and String, and no other Type. They are the two refinable scalar
// bases, and they are the two whose literal Matcher asks exactly what their
// Namespace's `is` asks: `anyIs` compares Integers as bigints and Strings
// NFC-normalised, which is what `Integer.is` and `String.is` answer, so a Case
// that declined really does prove `isNot`. A Boolean's two values are an `if`
// written the long way, and everything else keeps `match-on-non-union`.
//
// NOTE: A Match on one of the two that names NO value at all is not one of
// these. It asks nothing about the value it was given, which is the one-outcome
// Match `match-on-non-union` has always been about, and it still reports.
function isLiteralMatch(node: common.typed.MatchNode): boolean {
	let scrutinee = eraseRefinements(node.value.type)

	return (
		(scrutinee.type === "Integer" || scrutinee.type === "String") &&
		node.handlers.some((handler) => handler.literal !== null)
	)
}

// NOTE: One Diagnostic per Case that can not stand where it stands, and one more
// for a Match that does not end in a Case for the rest — each is a mistake of
// its own at a Position of its own, which is why they are not merged the way
// `missing-case` merges the members of a Union.
function validateLiteralMatchShape(node: common.typed.MatchNode): void {
	let scrutinee = eraseRefinements(node.value.type)
	let matchedValue = () =>
		secondary(
			node.value.position,
			`this is ${withArticle(describeType(node.value.type))}`,
		)
	let takesValuesApart = `A Match on ${withArticle(describeType(scrutinee))} takes the VALUE apart: every Case names a value, and the last one answers for every value the Cases above it did not name.`
	let lastIndex = node.handlers.length - 1

	for (let index = 0; index < lastIndex; index++) {
		let handler = node.handlers[index]

		if (handler.literal === null) {
			reportError(
				"This Case does not name a value",
				handler.matcherPosition,
				{
					code: "literal-match-shape",
					labels: [
						primary(
							handler.matcherPosition,
							"only a written value can stand here",
						),
						matchedValue(),
					],
					notes: [takesValuesApart],
					helps: [
						"Write the value this Case is about — 'case 0' — or move it to the end, where 'case _' answers for the rest.",
					],
				},
			)

			continue
		}

		if (handler.guard !== null) {
			reportError(
				"This Case names a value and can still decline it",
				handler.matcherPosition,
				{
					code: "literal-match-shape",
					labels: [
						primary(
							handler.guard.position,
							"this decides after the value already matched",
						),
						secondary(
							handler.matcherPosition,
							"this Case names the value",
						),
					],
					notes: [
						takesValuesApart,
						"So the last Case is reached only by a value none of the Cases above named — and a Guard would let one of them through, which makes that untrue.",
					],
					helps: [
						"Take the Guard off, and ask its question inside the Handler with an 'if'.",
					],
				},
			)

			continue
		}

		// NOTE: The Case is compared TO the matched value, so a Case naming a
		// value of another Type is a comparison that is false however it is
		// written — the same mistake `n::is("zero")` is, in the one place the
		// Types were never checked against each other.
		if (!matchesType(scrutinee, handler.literal.type)) {
			reportError(
				"This Case names a value the Match can never be given",
				handler.matcherPosition,
				{
					code: "literal-match-shape",
					labels: [
						primary(
							handler.matcherPosition,
							`this is ${withArticle(describeType(handler.literal.type))}`,
						),
						matchedValue(),
					],
					notes: [
						"A Case of such a Match is compared to the matched value, and a comparison across Types can never be true.",
					],
				},
			)
		}
	}

	let last = node.handlers[lastIndex]

	// NOTE: A Match with no Handlers at all is a Parser error, and this runs on a
	// tree the Parser accepted.
	if (last === undefined) {
		return
	}

	// NOTE: Unconditional, and accepting every value that can arrive — `case _`,
	// or a Case naming the matched Type itself, which is the same question spelled
	// out. Both are indistinguishable by the time a Match is typed, and both are
	// total, so both are the end of a Match on values.
	if (
		isUnconditionalHandler(last) &&
		acceptsAllAtRuntime(last.matcher, node.value.type)
	) {
		return
	}

	reportError(
		"This Match has no Case for the rest of the values",
		node.position,
		{
			code: "literal-match-shape",
			labels: [finalHandlerLabel(last), matchedValue()],
			notes: [
				takesValuesApart,
				`There are more values of ${describeType(scrutinee)} than a Match can write down, so the last Case is what makes it answer for all of them.`,
			],
			helps: [
				"Add a 'case _' below, for every value the Cases above miss.",
			],
		},
	)
}

// NOTE: WHY the last Handler is not the end of a Match on values — the three ways
// it can fail to answer for everything the Cases above it left, each underlining
// the part of the Handler that decides.
function finalHandlerLabel(handler: MatchHandler): common.DiagnosticLabel {
	if (handler.literal !== null || handler.memberLiterals !== null) {
		return primary(
			handler.matcherPosition,
			"this Case names a value, not the rest of them",
		)
	}

	if (handler.guard !== null) {
		return primary(
			handler.guard.position,
			"this decides after the value already matched",
		)
	}

	return primary(
		handler.matcherPosition,
		"this Case does not accept every value that reaches it",
	)
}

// NOTE: A Handler with a literal Matcher, a value-constrained Record member or
// a Guard covers only part of its Matcher's Type — `case 0` leaves every other
// Integer, and a Guard can decline outright. So only an unconditional Handler
// discharges a member of the Union, and only an unconditional Handler takes a
// Type away from the Handlers below it.
function isUnconditionalHandler(handler: MatchHandler): boolean {
	return (
		handler.literal === null &&
		handler.memberLiterals === null &&
		handler.guard === null
	)
}

// NOTE: Whether the check emitted for `matcher` answers TRUE for EVERY value of
// `memberType` — which decides reachability, and is a WIDER question than
// assignability. Some of what a Matcher names does not survive to runtime, and
// what does not survive can not narrow: assignability answers what a Case may
// assume about the values it accepts, this answers which values reach it at all.
//
// NOTE: Two things erase, and each one is a Case that swallowed everything below
// it with nothing here to say so. A Generic Matcher (and the wildcard's Unknown,
// which is the same answer spelled differently) has no Type left to check, so
// `isValueOfType` returns true unconditionally — `case Value` above `case
// Nothing` left the second Case dead, and the Program answered the Nothing where
// its own Signature promised a `Value`. A Function's Signature is equally gone:
// the emitted check can only ask whether the value is callable, so a Record
// Matcher naming a callback member accepts every Record carrying one, whatever
// that callback's Parameters and Return Type were declared as.
//
// NOTE: Exported so the agreement between this and the runtime can be tested
// directly — every value this accepts, `isValueOfType` has to accept too, and
// `overlapsAtRuntime` below is the other side of the same sandwich.
export function acceptsAllAtRuntime(
	matcher: common.Type,
	memberType: common.Type,
): boolean {
	// NOTE: A checked refinement is the third thing that erases, and the most
	// completely: its predicate is not a check the runtime declines to make, it
	// is a check the runtime never hears of. So both sides are unwrapped before
	// anything else is asked, and a refinement answers exactly as its base does
	// — which is what the emitted check will do.
	if (matcher.type === "Refinement" || memberType.type === "Refinement") {
		return acceptsAllAtRuntime(
			eraseRefinements(matcher),
			eraseRefinements(memberType),
		)
	}

	if (matcher.type === "GenericUse" || matcher.type === "Unknown") {
		return true
	}

	if (matchesType(matcher, memberType)) {
		return true
	}

	// NOTE: A Union is decided member by member, on whichever side it stands:
	// every value of a matched Union has to pass, and a Matcher that is a Union
	// passes a value as soon as one of its arms does.
	if (memberType.type === "UnionType") {
		return flattenUnionMembers(memberType).every((armType) =>
			acceptsAllAtRuntime(matcher, armType),
		)
	}

	if (matcher.type === "UnionType") {
		return flattenUnionMembers(matcher).some((armType) =>
			acceptsAllAtRuntime(armType, memberType),
		)
	}

	if (matcher.type === "Function") {
		return memberType.type === "Function"
	}

	// NOTE: Structural and open, exactly as the runtime check is — the value
	// has to carry every member the Matcher names, and may carry more besides.
	if (matcher.type === "Record" && memberType.type === "Record") {
		return membersAcceptAllAtRuntime(matcher.members, memberType.members)
	}

	// NOTE: The Record check with the tag in front of it, which is what the
	// runtime does for a Case — the tag is shared by every instantiation, so
	// the payload is what tells `Box<Integer>#Full` from `Box<String>#Full`.
	if (matcher.type === "Case" && memberType.type === "Case") {
		return (
			matcher.choice === memberType.choice &&
			matcher.name === memberType.name &&
			membersAcceptAllAtRuntime(matcher.members, memberType.members)
		)
	}

	// NOTE: A List Matcher is answered by the items the value HOLDS, so it takes
	// every List whose item Type its own accepts — and one naming no item Type
	// at all (a bare `List`) takes every List there is. A member Type whose own
	// items are undecided could hold anything, so it is not all of anything.
	if (isRuntimeList(matcher) && isRuntimeList(memberType)) {
		let matcherItemType = runtimeItemType(matcher)
		let memberItemType = runtimeItemType(memberType)

		if (matcherItemType.type === "Unknown") {
			return true
		}

		return (
			memberItemType.type !== "Unknown" &&
			acceptsAllAtRuntime(matcherItemType, memberItemType)
		)
	}

	return false
}

// NOTE: Whether the check emitted for `matcher` can answer TRUE for SOME value
// of `memberType`. It differs from `acceptsAllAtRuntime` in exactly one place,
// and that place is the whole reason it exists: an empty List holds no item to
// disagree about, so it is a value of every List Type there is and every List
// Matcher takes it. `case List<String>` above `case List<Integer>` therefore
// runs for an empty `List<Integer>`, which assignability — and so the Validator
// — used to call impossible while the runtime did it.
//
// NOTE: Conservative everywhere else: an answer of false is a promise that no
// value of `memberType` reaches this Matcher, so anything not known to overlap
// is answered exactly as `acceptsAllAtRuntime` answers it.
export function overlapsAtRuntime(
	matcher: common.Type,
	memberType: common.Type,
): boolean {
	// NOTE: Unwrapped for the reason its sibling above unwraps.
	if (matcher.type === "Refinement" || memberType.type === "Refinement") {
		return overlapsAtRuntime(
			eraseRefinements(matcher),
			eraseRefinements(memberType),
		)
	}

	if (acceptsAllAtRuntime(matcher, memberType)) {
		return true
	}

	// NOTE: A member Type that is still a Type Parameter is NOT counted as an
	// overlap, though its Argument could be anything: every Match over a
	// `Value | Nothing` would report one, and a Type Parameter's values are
	// exactly what the Handlers around it are written to sort out. What this
	// answers about is the values a Type NAMES, which is what the emitted
	// check is written from.
	if (memberType.type === "UnionType") {
		return flattenUnionMembers(memberType).some((armType) =>
			overlapsAtRuntime(matcher, armType),
		)
	}

	if (matcher.type === "UnionType") {
		return flattenUnionMembers(matcher).some((armType) =>
			overlapsAtRuntime(armType, memberType),
		)
	}

	if (matcher.type === "Function") {
		return memberType.type === "Function"
	}

	if (matcher.type === "Record" && memberType.type === "Record") {
		return membersOverlapAtRuntime(matcher.members, memberType.members)
	}

	if (matcher.type === "Case" && memberType.type === "Case") {
		return (
			matcher.choice === memberType.choice &&
			matcher.name === memberType.name &&
			membersOverlapAtRuntime(matcher.members, memberType.members)
		)
	}

	// NOTE: The empty List, whatever the two item Types are.
	if (isRuntimeList(matcher) && isRuntimeList(memberType)) {
		return true
	}

	return false
}

function membersAcceptAllAtRuntime(
	matcherMembers: Record<string, common.Type>,
	memberTypes: Record<string, common.Type>,
): boolean {
	return Object.entries(matcherMembers).every(
		([name, memberMatcher]) =>
			name in memberTypes &&
			acceptsAllAtRuntime(memberMatcher, memberTypes[name]),
	)
}

function membersOverlapAtRuntime(
	matcherMembers: Record<string, common.Type>,
	memberTypes: Record<string, common.Type>,
): boolean {
	return Object.entries(matcherMembers).every(
		([name, memberMatcher]) =>
			name in memberTypes &&
			overlapsAtRuntime(memberMatcher, memberTypes[name]),
	)
}

// NOTE: The two Types the runtime answers its List check for — a `List<X>` and
// the bare `List` a Generic List annotation resolves to, which names no item
// Type of its own.
function isRuntimeList(type: common.Type): boolean {
	return type.type === "List" || type.type === "GenericList"
}

function runtimeItemType(type: common.Type): common.Type {
	return type.type === "List" ? type.itemType : { type: "Unknown" }
}

// NOTE: Whether the payload is present and matches is checked here rather
// than in the Enricher — the Case's Type resolves either way, so a wrong
// payload stays a single Diagnostic instead of poisoning the whole
// Expression.
function validateCaseValue(
	node: common.typed.CaseValueNode,
): common.typed.CaseValueNode {
	if (node.value !== null) {
		validateExpression(node.value)
		validateNoBoundFunctionValue(node.value)
	}

	if (node.type.type !== "Case") {
		return node
	}

	let payloadType: common.RecordType = {
		type: "Record",
		members: node.type.members,
	}

	if (Object.keys(node.type.members).length === 0) {
		if (node.value !== null) {
			reportError(
				`Case '#${node.type.name}' does not carry a payload`,
				node.value.position,
				{
					code: "unexpected-payload",
					labels: [primary(node.value.position, "nothing goes here")],
					helps: [`Write '#${node.type.name}' on its own.`],
				},
			)
		}
	} else if (node.value === null) {
		reportError(
			`Case '#${node.type.name}' requires a payload`,
			node.position,
			{
				code: "missing-payload",
				labels: [primary(node.position, "no payload was given")],
				notes: [
					`'#${node.type.name}' carries ${withArticle(describeType(payloadType))}.`,
				],
			},
		)
	} else if (!matchesType(payloadType, node.value.type)) {
		reportError(
			`This payload does not fit Case '#${node.type.name}'`,
			node.value.position,
			{
				code: "payload-type-mismatch",
				labels: [
					primary(
						node.value.position,
						`this is ${withArticle(describeType(node.value.type))}`,
					),
				],
				notes: [
					`'#${node.type.name}' carries ${withArticle(describeType(payloadType))}.`,
				],
				// NOTE: A single-member Case would have accepted the value
				// through the shorthand, so the hint only helps where it can not:
				// a multi-member Case needs the whole Record spelled out.
				helps:
					Object.keys(node.type.members).length > 1
						? [
								"The one-member shorthand '#Case(value)' only applies to single-member Cases.",
							]
						: [],
			},
		)
	}

	return node
}

function validateFunctionValue(
	node: common.typed.FunctionValueNode,
): common.typed.FunctionValueNode {
	validateFunctionDefinition(node.value, node.position)

	return node
}

function validateRationalValue(
	node: common.typed.RationalValueNode,
): common.typed.RationalValueNode {
	if (BigInt(node.denominator) === 0n) {
		reportError(
			"A Rational can not have a denominator of zero",
			node.position,
			{
				code: "zero-denominator",
				labels: [primary(node.position, "this divides by zero")],
			},
		)
	}

	return node
}

// NOTE: A member is an Expression like any other — a Match, an Invocation, a
// Function literal — so it is walked rather than only checked for the values
// that can not travel. The Record's own shape is the Enricher's business; what
// is checked here is what the members are made of.
function validateRecordValue(
	node: common.typed.RecordValueNode,
): common.typed.RecordValueNode {
	for (let member of Object.values(node.members)) {
		validateExpression(member)
		validateNoBoundFunctionValue(member)
	}

	return node
}

function validateListValue(
	node: common.typed.ListValueNode,
): common.typed.ListValueNode {
	for (let value of node.values) {
		validateExpression(value)
		validateNoBoundFunctionValue(value)
	}

	return node
}

// NOTE: Each hole is an Expression of its own — `"total: {price::add(tax)}"`
// holds an Invocation — so each is walked. A hole can not itself be a bound
// Function value (the Enricher already refused it as not Printable), so unlike
// a List there is no `validateNoBoundFunctionValue` guard to add.
function validateInterpolatedStringValue(
	node: common.typed.InterpolatedStringValueNode,
): common.typed.InterpolatedStringValueNode {
	for (let segment of node.segments) {
		if (segment.kind === "expression") {
			validateExpression(segment.expression)
		}
	}

	return node
}

// NOTE: Both sides are Expressions of their own — `{ makeBase(1) with x =
// compute("2") }` holds two Invocations — so both are walked. Whether the two
// shapes combine at all is the Enricher's business
// (`partial-type-mismatch`); what is checked here is what they are made of.
function validateCombination(
	node: common.typed.CombinationNode,
): common.typed.CombinationNode {
	validateExpression(node.lhs)
	validateExpression(node.rhs)

	return node
}

// #endregion

// #region Statements

function validateStatement(
	node: common.typed.StatementNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.StatementNode {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
			return validateConstantDeclarationStatement(node)
		case "VariableDeclarationStatement":
			return validateVariableDeclarationStatement(node)
		case "VariableAssignmentStatement":
			return validateVariableAssignmentStatement(node)
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "ProtocolDeclarationStatement":
			return node
		case "NamespaceDefinitionStatement":
			return validateNamespaceDefinitionStatement(node)
		case "IfElseStatement":
			return validateIfElseStatementNode(node, currentFunctionContext)
		case "IfStatement":
			return validateIfStatement(node, currentFunctionContext)
		case "ReturnStatement":
			return validateReturnStatement(node, currentFunctionContext)
		case "FunctionStatement":
			return validateFunctionStatement(node)
	}
}

function validateConstantDeclarationStatement(
	node: common.typed.ConstantDeclarationStatementNode,
): common.typed.ConstantDeclarationStatementNode {
	if (node.declaredType !== null) {
		if (!fitsExpectedType(node.declaredType, node.value)) {
			reportDeclarationMismatch(
				"Constant",
				node.name.content,
				node.declaredType,
				node.value,
			)
		}
	}

	validateExpression(node.value)
	validateNoBoundFunctionValue(node.value)

	return node
}

function validateVariableDeclarationStatement(
	node: common.typed.VariableDeclarationStatementNode,
): common.typed.VariableDeclarationStatementNode {
	if (node.declaredType !== null) {
		if (!fitsExpectedType(node.declaredType, node.value)) {
			reportDeclarationMismatch(
				"Variable",
				node.name.content,
				node.declaredType,
				node.value,
			)
		}
	}

	validateExpression(node.value)
	validateNoBoundFunctionValue(node.value)

	return node
}

// NOTE: A Declaration's Type Annotation carries no Position of its own, so
// the Type it demands is stated as a note rather than pointed at. The value
// is what gets the arrow — it is the part that can be changed.
function reportDeclarationMismatch(
	kind: "Constant" | "Variable" | "Property",
	name: string,
	declaredType: common.Type,
	value: common.typed.ExpressionNode,
): void {
	let evidence = refinementEvidence(declaredType)

	reportError(
		`This value does not fit the declared Type of ${kind} '${name}'`,
		value.position,
		{
			code: "assignment-type-mismatch",
			labels: [
				primary(
					value.position,
					`this is ${withArticle(describeType(value.type))}`,
				),
			],
			notes: [
				`'${name}' is declared as ${describeType(declaredType)}.`,
				...evidence.notes,
			],
			helps: evidence.helps,
		},
	)
}

function validateVariableAssignmentStatement(
	node: common.typed.VariableAssignmentStatementNode,
): common.typed.VariableAssignmentStatementNode {
	if (!fitsExpectedType(node.name.type, node.value)) {
		let declaredType = describeType(node.name.type)
		let evidence = refinementEvidence(node.name.type)

		reportError(
			`This value does not fit Variable '${node.name.content}'`,
			node.value.position,
			{
				code: "assignment-type-mismatch",
				labels: [
					primary(
						node.value.position,
						`this is ${withArticle(describeType(node.value.type))}`,
					),
					// NOTE: Null for a builtin, which was declared in
					// TypeScript and has no Essence source to point at.
					...(node.declarationPosition === null
						? []
						: [
								secondary(
									node.declarationPosition,
									`declared as ${declaredType} here`,
								),
							]),
				],
				notes: [
					...(node.declarationPosition === null
						? [
								`'${node.name.content}' is declared as ${declaredType}.`,
							]
						: []),
					...evidence.notes,
				],
				helps: evidence.helps,
			},
		)
	}

	validateExpression(node.value)
	validateNoBoundFunctionValue(node.value)

	return node
}

// NOTE: A Method whose every returning path hands back a direct call to
// ITSELF can never produce a value — each call only defers to another call of
// the same Method, and no branch returns anything else, so the recursion has
// no base case to stop it. This is the decidable core of infinite recursion:
// it says nothing about a call that MIGHT recurse (a `match` that dispatches
// per member Type, a guarded base case), only about one that ALWAYS does.
// `Number.toString` collapsed to `<- @::toString()` was exactly this — on a
// `Number` that Method IS `Number.toString`, so every path returned itself.
type MethodIdentity = {
	namespaceName: string
	methodName: string
	// NOTE: Null for a non-overloaded Method, matching the `null`
	// `overloadedMethodIndex` its call sites carry; an Overload carries its
	// index in the Method Type, so a call to a *sibling* Overload (a different
	// index) is not self-recursion and is left alone.
	overloadIndex: number | null
}

// NOTE: The returns reachable at the body's own control-flow level — through
// `if`/`else`, but NOT into a `match` Case or a nested Function literal, where
// `@::method()` resolves against a narrowed receiver or a different `@`, and
// so is a different Method than the one being defined.
function collectTopLevelReturns(
	body: Array<common.typed.ImplementationNode>,
): Array<common.typed.ReturnStatementNode> {
	let returns: Array<common.typed.ReturnStatementNode> = []

	for (let node of body) {
		if (node.nodeType === "ReturnStatement") {
			returns.push(node)
		} else if (node.nodeType === "IfStatement") {
			returns.push(...collectTopLevelReturns(node.body))
		} else if (node.nodeType === "IfElseStatement") {
			returns.push(...collectTopLevelReturns(node.trueBody))
			returns.push(...collectTopLevelReturns(node.falseBody))
		}
	}

	return returns
}

function isDirectSelfCall(
	expression: common.typed.ExpressionNode,
	identity: MethodIdentity,
): boolean {
	return (
		expression.nodeType === "MethodInvocation" &&
		expression.base.nodeType === "Self" &&
		expression.member.name === identity.methodName &&
		expression.namespace.name === identity.namespaceName &&
		expression.overloadedMethodIndex === identity.overloadIndex
	)
}

function checkInfiniteRecursion(
	name: common.typed.IdentifierNode,
	definition: common.typed.FunctionDefinitionNode,
	identity: MethodIdentity,
): void {
	let returns = collectTopLevelReturns(definition.body)

	// NOTE: No return of its own — a native Method, or one that answers only
	// from inside a `match` — says nothing here.
	if (returns.length === 0) {
		return
	}

	let selfCalls = returns.filter((returnNode) =>
		isDirectSelfCall(returnNode.expression, identity),
	)

	if (selfCalls.length !== returns.length) {
		return
	}

	reportError(
		"This Method calls itself on every path, so it can never return",
		name.position,
		{
			code: "infinite-recursion",
			labels: [
				primary(name.position, "this Method"),
				...selfCalls.map((returnNode) =>
					secondary(
						returnNode.expression.position,
						"returns a call to the same Method",
					),
				),
			],
			notes: [
				"Every returning path hands back another call to it, so there is no base case to stop the recursion.",
			],
			helps: [
				"Give it a path that returns without calling itself — a 'match' Case that dispatches to a different Method, or a guard that answers a base value.",
			],
		},
	)
}

function validateNamespaceDefinitionStatement(
	node: common.typed.NamespaceDefinitionStatementNode,
): common.typed.NamespaceDefinitionStatementNode {
	// NOTE: A static Property's initialiser is an Expression that runs when the
	// Program loads, so it is held to what a Constant Declaration is held to —
	// it is the same Declaration, written in a Namespace. A native Property has
	// no value to check and is not in the typed tree at all.
	//
	// NOTE: The Properties are walked in the order they are written, which is
	// the order their initialisers run in, so the ones still without a value
	// where one of them runs are itself and everything below it — which is what
	// `unbound` holds, shrinking as each is left behind. A native is not among
	// them for the same reason it is not walked here: the runtime answers it,
	// wherever it is written.
	let unbound = new Map(
		Object.entries(node.properties).map(([name, property]) => [
			name,
			property.name.position,
		]),
	)

	for (let propertyName in node.properties) {
		let property = node.properties[propertyName]

		if (!fitsExpectedType(property.type, property.value)) {
			reportDeclarationMismatch(
				"Property",
				`${node.name.content}.${property.name.content}`,
				property.type,
				property.value,
			)
		}

		initialisingProperty = { namespaceName: node.name.content, unbound }

		try {
			validateExpression(property.value)
			validateNoBoundFunctionValue(property.value)
		} finally {
			initialisingProperty = null
		}

		unbound.delete(propertyName)
	}

	for (let methodName in node.methods) {
		let method = node.methods[methodName]

		if (
			method.nodeType === "SimpleMethod" ||
			method.nodeType === "StaticMethod"
		) {
			validateFunctionDefinition(
				method.method.value,
				method.method.position,
			)
			checkInfiniteRecursion(method.name, method.method.value, {
				namespaceName: node.name.content,
				methodName: method.name.content,
				overloadIndex: null,
			})
		} else {
			for (let index = 0; index < method.methods.length; index++) {
				let overloadedMethod = method.methods[index]

				validateFunctionDefinition(
					overloadedMethod.value,
					overloadedMethod.position,
				)
				checkInfiniteRecursion(method.name, overloadedMethod.value, {
					namespaceName: node.name.content,
					methodName: method.name.content,
					overloadIndex: method.overloadIndices[index],
				})
			}
		}
	}

	return node
}

function validateIfElseStatementNode(
	node: common.typed.IfElseStatementNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.IfElseStatementNode {
	validateCondition(node.condition, "An If Condition")

	node.trueBody.map((node) =>
		validateImplementationNode(node, currentFunctionContext),
	)
	node.falseBody.map((node) =>
		validateImplementationNode(node, currentFunctionContext),
	)

	return node
}

function validateIfStatement(
	node: common.typed.IfStatementNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.IfStatementNode {
	validateCondition(node.condition, "An If Condition")

	node.body.map((node) =>
		validateImplementationNode(node, currentFunctionContext),
	)

	return node
}

function validateReturnStatement(
	node: common.typed.ReturnStatementNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.ReturnStatementNode {
	if (currentFunctionContext === null) {
		reportError("There is nothing here to return from", node.position, {
			code: "top-level-return",
			labels: [primary(node.position, "this is outside any Function")],
		})
	} else if (
		!fitsExpectedType(currentFunctionContext.returnType, node.expression)
	) {
		let evidence = refinementEvidence(currentFunctionContext.returnType)

		reportError(
			"This value does not fit the declared return Type",
			node.expression.position,
			{
				code: "return-type-mismatch",
				// NOTE: The declared return Type has no Position of its own —
				// only the Parameter list does, which is where an omitted
				// `-> Type` would have gone — so it is stated as a note
				// rather than pointed at.
				labels: [
					primary(
						node.expression.position,
						`this is ${withArticle(describeType(node.expression.type))}`,
					),
				],
				notes: [
					`The Function returns ${describeType(currentFunctionContext.returnType)}.`,
					...evidence.notes,
				],
				helps: evidence.helps,
			},
		)
	}

	validateExpression(node.expression)
	validateNoBoundFunctionValue(node.expression)

	return node
}

function validateFunctionStatement(
	node: common.typed.FunctionStatementNode,
): common.typed.FunctionStatementNode {
	validateFunctionDefinition(node.value, node.position)

	return node
}

// #endregion

// #region Helpers

// NOTE: One check for every way a Namespace can be named — a Method's home, a
// dispatch branch's target, a static member's base, a bare reference, a
// conformance witness a call curries in — because what makes them wrong is the
// same thing: the Declaration is BELOW the statement that runs the use.
// `useLabel` is what the arrow at the use says.
//
// NOTE: Silent for a Namespace that is not top-level (nothing records where a
// nested one is declared) and for every builtin, none of which is in the map at
// all — so a name the standard library owns is only ever reported where the
// Program itself declares it, which is exactly where it can be too late.
function checkNamespaceIsDeclared(
	namespaceName: string,
	position: common.Position,
	useLabel: string,
): void {
	if (executingTopLevelIndex === null) {
		return
	}

	let declaration = topLevelNamespaces.get(namespaceName)

	if (
		declaration === undefined ||
		declaration.index <= executingTopLevelIndex
	) {
		return
	}

	reportError(
		`Namespace '${namespaceName}' is used before it is declared`,
		position,
		{
			code: "use-before-declaration",
			labels: [
				primary(position, useLabel),
				secondary(declaration.position, "declared here, below the use"),
			],
			notes: [
				"A Namespace comes into being where it is written, so nothing that runs above it can reach it.",
				"A Function's or a Method's body is not run where it is written, so a body may name a Namespace declared below it.",
			],
			helps: ["Move the use below the Declaration."],
		},
	)
}

// NOTE: An `if`, an `else if` and a Match Handler's Guard all pick a path from
// a value, and Essence has no truthiness — only a Boolean can decide. One
// check for all of them, so the rule can not hold in one place and lapse in
// another; `description` is what names the Condition in the message.
function validateCondition(
	condition: common.typed.ExpressionNode,
	description: string,
): void {
	if (condition.type.type !== "Boolean" && condition.type.type !== "Error") {
		reportError(`${description} has to be a Boolean`, condition.position, {
			code: "condition-not-boolean",
			labels: [
				primary(
					condition.position,
					`this is ${withArticle(describeType(condition.type))}`,
				),
			],
			notes: [
				"Essence has no truthiness — only a Boolean can be a Condition.",
			],
		})
	}

	validateExpression(condition)
}

function validateDefiniteReturn(
	definition: common.typed.FunctionDefinitionNode,
	position: common.Position,
): void {
	let returnType = definition.returnType

	if (
		isUnitType(returnType) ||
		returnType.type === "Unknown" ||
		returnType.type === "Error"
	) {
		return
	}

	if (!bodyDefinitelyReturns(definition.body)) {
		reportError("Not every path through this Function returns", position, {
			code: "missing-return",
			labels: [primary(position, "this path falls off the end")],
			notes: [
				`The declared return Type is ${describeType(returnType)}, so every path must yield one.`,
			],
		})
	}
}

// NOTE: Whether a value fits where it was written — assignability, plus the one
// thing assignability alone can not see. A refinement demands evidence, and a
// value written DOWN carries its own: its predicate is decided while compiling,
// so `constant d: NonZeroInteger = 3` needs no branch in front of it while `= 0`
// is still refused. The Enricher admits the same literals as it matches
// Arguments, and this is that question asked again over the finished tree, at
// every position the Enricher does not resolve one against the other.
function fitsExpectedType(
	expected: common.Type,
	value: common.typed.ExpressionNode,
): boolean {
	return (
		matchesType(expected, value.type) ||
		(expected.type === "Refinement" &&
			admittedByEvaluation(expected, value))
	)
}

// NOTE: What a mismatch against a refinement has to say beyond naming the two
// Types. A base value arriving where evidence is demanded is not a spelling
// mistake — the value may well satisfy the predicate, and nothing has asked —
// so the Diagnostic names the question that went unanswered and the two places
// an answer comes from. Empty for every other Type, which is what lets the sites
// below spread it without asking first.
//
// NOTE: Named as it was APPLIED, because a generic refined Alias' bare name is not
// a Type anything can be written as — a help offering to pass a value of
// 'NonEmptyList' names something the Program would refuse for taking no Arguments. A
// refinement carrying none spells as its name alone, which is every non-generic
// one.
function refinementEvidence(expected: common.Type | undefined): {
	notes: Array<string>
	helps: Array<string>
} {
	if (expected === undefined || expected.type !== "Refinement") {
		return { notes: [], helps: [] }
	}

	let predicate = describePredicate(expected)
	let spelling = describeType(expected)

	return {
		notes: [
			`Every value of '${spelling}' has been proven to answer '${predicate}'.`,
		],
		helps: [
			`Check '${predicate}' on the value in an 'if' or a 'match', or pass a value that already has Type '${spelling}'.`,
		],
	}
}

// NOTE: An Argument is asked the same question the Enricher asked it, and for a
// reason beyond the Diagnostic: a committed Overload whose Arguments do not
// match is an ICE here, so a call the Enricher admitted a literal into would
// fail the compile outright if this asked only about assignability.
//
// Which is why the question is asked in full, `refinementDecidedBy` and all: a
// Parameter whose Type Arguments the call worked out is a refinement nothing
// spelled, and asking about it as it STANDS would refuse the very literal the
// Enricher admitted — an ICE out of a Program that is perfectly well typed.
function matchableArgumentsFromTypedNodes(
	argumentNodes: Array<common.typed.ArgumentNode>,
): Array<MatchableArgument> {
	return argumentNodes.map((argumentNode) => ({
		name: argumentNode.name,
		getType: (expectedType) => {
			let asked =
				expectedType.type === "Refinement"
					? refinementDecidedBy(expectedType, argumentNode.value.type)
					: null

			return asked !== null &&
				admittedByEvaluation(asked, argumentNode.value)
				? asked
				: argumentNode.type
		},
	}))
}

function reportArityMismatch(
	parameterTypes: Array<common.Parameter>,
	argumentCount: number,
	position: common.Position,
): void {
	reportError("This call passes the wrong number of Arguments", position, {
		code: "argument-count-mismatch",
		labels: [
			primary(position, `passes ${countOf(argumentCount, "Argument")}`),
		],
		notes: [`The signature ${describeSignature(parameterTypes)}.`],
	})
}

// NOTE: A LABEL is what an Argument is matched by before its Type is looked at
// — a free Function's Arguments carry them exactly as a Method's do, `loop(
// startingWith 1, …)` as much as `things::sort(by …)` — so a label that does
// not agree leaves `matchArguments` with the same mismatching index a wrong
// Type does. Reported as a Type mismatch it said "this is an Integer" under
// "Parameter 'around' is Integer", which names nothing the call did wrong; the
// label is what it did. An overloaded callee is told the same thing by
// `no-matching-overload`'s per-candidate notes, so the signature is the note
// here too.
function reportArgumentLabelMismatch(
	parameterTypes: Array<common.Parameter>,
	parameter: common.Parameter,
	index: number,
	argumentNode: common.typed.ArgumentNode,
): void {
	let carried =
		argumentNode.name === null
			? "this Argument carries no label"
			: `this is labelled '${argumentNode.name}'`

	reportError(
		parameter.name === null
			? `This Argument is labelled where ${describeParameter(parameter, index)} takes no label`
			: `This Argument is not labelled '${parameter.name}'`,
		argumentNode.value.position,
		{
			code: "argument-label-mismatch",
			labels: [primary(argumentNode.value.position, carried)],
			notes: [`The signature ${describeSignature(parameterTypes)}.`],
			helps: [
				parameter.name === null
					? "Pass the value with no label."
					: `Write '${parameter.name}' before the value.`,
			],
		},
	)
}

function reportArgumentMismatch(
	parameterTypes: Array<common.Parameter>,
	index: number,
	argumentNode: common.typed.ArgumentNode,
): void {
	let parameter = parameterTypes[index]

	if (parameter !== undefined && parameter.name !== argumentNode.name) {
		reportArgumentLabelMismatch(
			parameterTypes,
			parameter,
			index,
			argumentNode,
		)

		return
	}

	let name = describeParameter(parameter, index)
	let evidence = refinementEvidence(parameter?.type)

	reportError(
		`This Argument does not fit ${name}`,
		argumentNode.value.position,
		{
			code: "argument-type-mismatch",
			labels: [
				primary(
					argumentNode.value.position,
					`this is ${withArticle(describeType(argumentNode.value.type))}`,
				),
			],
			notes: [
				...(parameter === undefined
					? []
					: [`${name} is ${describeType(parameter.type)}.`]),
				...evidence.notes,
			],
			helps: evidence.helps,
		},
	)
}

function validateSimpleFunctionInvocation(
	functionType: common.FunctionType | common.StaticMethodType,
	argumentNodes: Array<common.typed.ArgumentNode>,
	position: common.Position,
) {
	for (let argumentNode of argumentNodes) {
		validateExpression(argumentNode.value)
	}

	let { parameterTypes, context } = createFreshenedInference(functionType)
	let matchResult = matchArguments(
		parameterTypes,
		matchableArgumentsFromTypedNodes(argumentNodes),
		{
			collectAllMismatches: true,
			inference: context,
		},
	)

	if (matchResult.type === "ArityMismatch") {
		reportArityMismatch(
			functionType.parameterTypes,
			argumentNodes.length,
			position,
		)

		return
	}

	if (matchResult.type === "ArgumentMismatch") {
		for (let i of matchResult.mismatchedArgumentIndices) {
			reportArgumentMismatch(
				functionType.parameterTypes,
				i,
				argumentNodes[i],
			)
		}
	}
}

// #endregion
