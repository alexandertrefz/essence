import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	primary,
	reportError,
	reportInformation,
	reportWarning,
	secondary,
} from "../diagnostics/index"
import { caseDefaults, parameterDefaults } from "../helpers/defaults"
import {
	asynchronyData,
	asynchronyHelps,
	booleanQuestionFor,
	countOf,
	describeParameter,
	describeSignature,
	describeType,
	displayProtocolName,
	recordMismatchEvidence,
	returnAsynchronyHelps,
	undecidedSlotEvidence,
	undispatchableHelps,
	withArticle,
} from "../helpers/describe"
import { eraseRefinements } from "../helpers/eraseRefinements"
import { conformanceParameterName } from "../helpers/names"
import {
	admittedTypeOf,
	describePredicate,
	fitsWritten,
	unadmittedWrittenItem,
} from "../helpers/predicateEval"
import { bodyDefinitelyReturns } from "../helpers/returns"
import {
	applyGenericBindings,
	createFreshenedInference,
	flattenUnionMembers,
	isMergedLevel,
	isPartialOf,
	isUnitType,
	matchArguments,
	matchesType,
	matchesTypeWithBindings,
	returnedTypeOf,
	type ArgumentMatchResult,
	type GenericBindings,
	mergedRecordType,
	missingRecordMembers,
	type MatchableArgument,
	typeContainsError,
	typeContainsUnknown,
} from "../helpers/types"

type CurrentFunctionContext = common.typed.FunctionDefinitionNode | null

type MatchHandler = common.typed.MatchNode["handlers"][number]

// The Protocol-bounded Type Parameters of every enclosing Function, innermost
// last. A closure reaches an enclosing hidden conformance Parameter, so a
// witness resolves against the whole stack.
// See "Compiler invariant rails" in DEVELOPMENT.md.
let witnessScopes: Array<Set<string>> = []

// The bounds of every enclosing Function Definition's Type Parameters as
// its source spells them, innermost last, for a Help that writes one. A
// provided Method's `Self` holds an identity and shows its name.
let writtenBounds: Array<Map<string, string>> = []

// Whether each enclosing body may write `complete`, innermost last, or why
// it may not. See "Completing bodies" in DEVELOPMENT.md.
let waitingBodies: Array<true | enricher.CompletionBarrier | "plain-body"> = []

function bodyCanWait(): boolean {
	return (waitingBodies.at(-1) ?? true) === true
}

// The barrier that refused, for a Help naming the edit it leaves. Null for a
// body that answers something other than a Future.
function completionBarrier(): enricher.CompletionBarrier | null {
	let top = waitingBodies.at(-1)

	return top === undefined || top === true || top === "plain-body"
		? null
		: top
}

// Runs `walk` with one more body on `waitingBodies`, popped in a `finally`.
function insideBody(
	state: true | enricher.CompletionBarrier | "plain-body",
	walk: () => void,
): void {
	waitingBodies.push(state)

	try {
		walk()
	} finally {
		waitingBodies.pop()
	}
}

// Each top-level Namespace's index in the Statement list and its name's
// Position. A Namespace is emitted as a `class`, so a use that runs before its
// Declaration fails. See "Use before declaration" in DEVELOPMENT.md.
let topLevelNamespaces: Map<
	string,
	{ index: number; position: common.Position }
> = new Map()

// The index of the top-level Statement being validated, or null inside a
// Function body, which runs when called. A static Property's initialiser keeps
// its index, since it runs with its Namespace's Declaration.
let executingTopLevelIndex: number | null = null

// The static Property initialiser being validated: its Namespace's name and
// the Properties not yet bound where it runs, itself included. Null elsewhere,
// including in a Function literal inside it.
let initialisingProperty: {
	namespaceName: string
	unbound: Map<string, common.Position>
} | null = null

// The lines the parser abandoned text on. See "After a parse recovery" in
// DEVELOPMENT.md.
let abandonedLines: ReadonlySet<number> = new Set()

// The lines of the abandoned runs that could have opened a body. See
// `parser.Recovery.headLines`.
let abandonedHeadLines: ReadonlySet<number> = new Set()

// The line the last top-level Statement other than a `<-` ended on.
// See "Top-level returns" in DEVELOPMENT.md.
let topLevelStatementFloor = 0

// Whether an earlier stage reported an Error about this Program, which
// stands the invariant rails down. See "Compiler invariant rails" in
// DEVELOPMENT.md.
let alreadyReported = false

export type ValidateOptions = {
	// What the parser abandoned on its way to this Program. The typed Program
	// does not carry it.
	recovery?: parser.Recovery
	// Whether the parser or the enricher reported an Error about this Program.
	reported?: boolean
}

export const validate = (
	program: common.typed.Program,
	options: ValidateOptions = {},
): Array<common.Diagnostic> => {
	// Fresh state per run. See "Module state" in DEVELOPMENT.md.
	witnessScopes = []
	writtenBounds = []
	topLevelNamespaces = collectTopLevelNamespaces(program.implementation.nodes)
	executingTopLevelIndex = null
	initialisingProperty = null
	abandonedLines = new Set(options.recovery?.lines ?? [])
	abandonedHeadLines = new Set(options.recovery?.headLines ?? [])
	topLevelStatementFloor = 0
	alreadyReported = options.reported === true

	let { diagnostics } = collectDiagnostics(() => {
		for (let [index, node] of program.implementation.nodes.entries()) {
			executingTopLevelIndex = index

			// A throw here is a compiler bug, reported at the Statement so the
			// rest of the Program is still validated.
			try {
				validateImplementationNode(node, null)
			} catch (error) {
				reportInternalError(error, node.position)
			}

			raiseTopLevelStatementFloor(node)
		}

		// Only a compile that asked for the tests carries a section here. A
		// test's body stands in no Function, so a `<-` there is a
		// `top-level-return`.
		for (let node of program.tests?.nodes ?? []) {
			try {
				validateTestsNode(node)
			} catch (error) {
				reportInternalError(error, node.position)
			}

			raiseTopLevelStatementFloor(node)
		}
	})

	return diagnostics
}

// Raises `topLevelStatementFloor` past a walked Statement other than a `<-`.
function raiseTopLevelStatementFloor(
	node: common.typed.ImplementationNode | common.typed.TestsNode,
): void {
	if (node.nodeType === "ReturnStatement") {
		return
	}

	topLevelStatementFloor = Math.max(
		topLevelStatementFloor,
		node.position.end.line,
	)
}

// Whether the parser abandoned text on any line the construct spans. Asked
// by every check about a construct being whole. See "After a parse recovery" in
// DEVELOPMENT.md.
function partiallyRead(position: common.Position): boolean {
	if (abandonedLines.size === 0) {
		return false
	}

	for (let line = position.start.line; line <= position.end.line; line++) {
		if (abandonedLines.has(line)) {
			return true
		}
	}

	return false
}

function reportInternalError(error: unknown, position: common.Position): void {
	reportError(
		`Internal Compiler Error: ${
			error instanceof Error ? error.message : String(error)
		}`,
		position,
		{
			code: "internal-error",
			labels: [primary(position, "the Compiler threw here")],
			notes: ["This is a bug in the Compiler, not in the Program."],
		},
	)
}

function validateTestsNode(node: common.typed.TestsNode): void {
	if (node.nodeType === "Test") {
		// The rows and what a Pattern Parameter binds off them are part of
		// the test like its body.
		for (let row of node.table?.rows ?? []) {
			validateExpression(row)
		}

		for (let binding of node.table?.bindings ?? []) {
			validateImplementationNode(binding, null)
		}

		// A generator's own Expressions are emitted into this test too,
		// though the compiler wrote them.
		for (let parameter of node.properties?.parameters ?? []) {
			validateGenerator(parameter.generator)
		}

		// A `test` body may wait. A property body and a benchmark body may
		// not, as the enricher's barriers say.
		insideBody(
			node.form === "benchmark"
				? "benchmark-body"
				: node.properties === null
					? true
					: "property-body",
			() => {
				for (let child of node.body) {
					validateImplementationNode(child, null)
				}
			},
		)

		return
	}

	if (node.nodeType === "Suite") {
		for (let child of node.nodes) {
			validateTestsNode(child)
		}

		return
	}

	validateImplementationNode(node, null)
}

function validateGenerator(generator: common.typed.TestGenerator): void {
	switch (generator.kind) {
		case "list":
			validateGenerator(generator.item)

			return
		case "dictionary":
			validateGenerator(generator.key)
			validateGenerator(generator.value)

			return
		case "record":
		case "case":
			for (let member of generator.members) {
				validateGenerator(member.generator)
			}

			return
		case "union":
			for (let member of generator.members) {
				validateGenerator(member)
			}

			return
		case "refined":
			validateGenerator(generator.base)

			for (let check of generator.checks) {
				validateExpression(check)
			}

			return
		case "generated":
			validateExpression(generator.call)
			validateExpression(generator.shrink)

			return
		default:
			return
	}
}

function collectTopLevelNamespaces(
	nodes: Array<common.typed.ImplementationNode>,
): Map<string, { index: number; position: common.Position }> {
	let namespaces = new Map<
		string,
		{ index: number; position: common.Position }
	>()

	for (let [index, node] of nodes.entries()) {
		// The first Declaration of a name is recorded. The enricher reports
		// the second.
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
		case "DictionaryValue":
		case "Lookup":
		case "Identifier":
		case "Self":
		case "Match":
		case "Define":
		case "CaseValue":
		case "Start":
		case "Complete":
		// Only in a Program the parser already reported on.
		case "RefusedValue":
			// A Statement drops its Expression's value, which is a mistake for
			// work. The same Expression inside another one is fine.
			reportDiscardedWork(node)

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
		case "ExpectStatement":
		case "RequireStatement":
			return validateAssertion(node)
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
		case "Define":
			return validateDefine(node)
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
		case "DictionaryValue":
			return validateDictionaryValue(node)
		case "InterpolatedStringValue":
			return validateInterpolatedStringValue(node)
		case "Combination":
			return validateCombination(node)
		case "Start":
		case "Complete":
			validateExpression(node.expression)

			return node
		case "StringValue":
		case "IntegerValue":
		case "BooleanValue":
		case "Self":
		// Refused where it was written, so there is nothing to validate.
		case "RefusedValue":
			return node
	}
}

// A Union holding work is work, one level deep, as `unwrapWork` in the
// enricher reads it.
function holdsWork(type: common.Type, kind: "Future" | "Started"): boolean {
	return (
		type.type === kind ||
		(type.type === "UnionType" &&
			type.types.some((member) => member.type === kind))
	)
}

// An Expression Statement whose value is work. A dropped `Future` runs
// nothing, so it is an Error. A dropped `Started` runs unobserved, which may be
// meant, so it is an Information. The Type decides, not the Keywords.
function reportDiscardedWork(node: common.typed.ExpressionNode): void {
	let type = node.type

	if (holdsWork(type, "Future")) {
		reportError("Nothing here runs", node.position, {
			code: "unused-future",
			labels: [
				primary(
					node.position,
					`this is ${withArticle(describeType(type))}, and its value goes nowhere`,
				),
			],
			notes: [
				"A Future describes work. Building one runs none of it — 'start' puts it in flight and 'complete' waits for what it answers with.",
			],
			// A call written for its effect, such as `Terminal.inspect(work)`,
			// wants a name rather than a Keyword.
			helps: [
				"Did you mean 'complete', to wait for it — or 'start', to put it in flight and carry on?",
				"Or, where the call was written for what it does rather than for what it answers, hold its answer in a Constant.",
			],
		})

		return
	}

	if (holdsWork(type, "Started")) {
		// The label tells a `start` from a call that answered a Started.
		let started = node.nodeType === "Start"

		reportInformation("Nothing waits for this", node.position, {
			code: "unobserved-started",
			labels: [
				primary(
					node.position,
					started
						? "this runs, and nobody reads its answer"
						: "this answers a run, and nobody reads what it answers with",
				),
			],
			notes: [
				"A Started can be completed any number of times, from anywhere — holding it under a name is what makes that possible later.",
			],
			helps: [
				"Hold it in a Constant and 'complete' it where the answer is wanted, if the answer is wanted at all.",
			],
		})
	}
}

// A Function with Protocol-bounded Type Parameters can not be a value: its
// hidden conformance Parameters exist only at a direct call.
function validateNoBoundFunctionValue(node: common.typed.ExpressionNode): void {
	// An overloaded Function names every overload at once, and only a direct
	// call picks one.
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
				// Wrapping the call in a literal keeps a value, and the call
				// inside it is direct.
				helps: [
					"Invoke it, or wrap the call in a Function literal written for the Types you mean.",
				],
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

// Whether the invariant rails stand down. See "Compiler invariant rails" in
// DEVELOPMENT.md.
function railsStandDown(): boolean {
	return alreadyReported
}

// The Type Parameters of the Signature an Invocation resolved to, or null
// where there is none, which the enricher has already reported.
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

// INVARIANT: a call passes one witness per bounded Type Parameter of its
// callee. See "Compiler invariant rails" in DEVELOPMENT.md.
function checkConformanceArity(
	node:
		| common.typed.MethodInvocationNode
		| common.typed.FunctionInvocationNode,
	calleeType: common.Type | undefined,
	describeCallee: () => string,
): void {
	if (
		railsStandDown() ||
		calleeType === undefined ||
		typeContainsError(calleeType)
	) {
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

	// A Record routing declared members passes one witness per member in
	// `derivedMembers`, which the Signature does not count.
	let expected =
		node.nodeType === "MethodInvocation" &&
		node.derivedMembers !== undefined
			? node.derivedMembers.length
			: bounded

	if (expected === node.conformances.length) {
		return
	}

	throw new Error(
		`${describeCallee()} was given ${countOf(node.conformances.length, "conformance Argument")} for a Signature with ${countOf(expected, "Protocol-bounded Type Parameter")}. This is a bug in the Compiler.`,
	)
}

// INVARIANT: the Overload the enricher committed to accepts the call's
// Arguments. See "Compiler invariant rails" in DEVELOPMENT.md.
function checkCommittedOverload(
	node: common.typed.FunctionInvocationNode,
	functionType:
		| common.OverloadedMethodType
		| common.OverloadedStaticMethodType,
	describeCallee: () => string,
): void {
	if (
		railsStandDown() ||
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

	let matched = matchCommittedArguments(
		overload,
		node.arguments,
		node.type,
		false,
	)

	if (matched.type !== "Match") {
		throw new Error(
			`${describeCallee()} was committed to the overload that ${describeSignature(overload.parameterTypes)}, which does not accept the Arguments it passes. This is a bug in the Compiler.`,
		)
	}

	// The omitted Parameters must agree too, since the simplifier places the
	// emitted Arguments by them. `defaultMembers` moves no position.
	if (
		matched.omittedParameterIndices.join() !==
		node.omittedParameterIndices.join()
	) {
		throw new Error(
			`${describeCallee()} was committed to the overload that ${describeSignature(overload.parameterTypes)}, leaving out different Parameters than a re-match of its Arguments does. This is a bug in the Compiler.`,
		)
	}
}

// INVARIANT: a `parameter` witness names a hidden conformance Parameter of an
// enclosing Function, by its emitted name. See "Compiler invariant rails" in
// DEVELOPMENT.md.
function checkWitnessScope(
	conformances: Array<common.Conformance>,
	describeSite: () => string,
): void {
	if (railsStandDown()) {
		return
	}

	for (let conformance of conformances) {
		if (conformance.source.kind === "namespace") {
			checkWitnessScope(
				witnessConditionsOf(conformance.source),
				describeSite,
			)

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

// The conditions of a witness and of every witness built together with it.
function witnessConditionsOf(
	source: Extract<common.ConformanceSource, { kind: "namespace" }>,
): Array<common.Conformance> {
	return [...source.conditions, ...(source.groupConditions ?? [])]
}

// A `namespace` witness is spelled into the call, as `things::sort()` emits
// `{ compare: Thing.compare }`, so the call must not run before that Namespace
// is declared. Each Namespace is reported once.
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

			collect(witnessConditionsOf(conformance.source))
		}
	}

	collect(conformances)

	for (let [namespaceName, protocolName] of protocolsByNamespace) {
		checkNamespaceIsDeclared(
			namespaceName,
			position,
			describeUse(displayProtocolName(protocolName)),
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
		// Each dispatch branch carries its own compilation of a contextually
		// typed Argument, which is emitted, so each copy is checked too.
		for (let dispatchCase of node.dispatch) {
			for (let { argument } of dispatchCase.contextualArguments) {
				validateExpression(argument.value)
				validateNoBoundFunctionValue(argument.value)
			}
		}

		validateDispatchCases(node, node.dispatch)
	}

	let describeCallee = () => `'${node.namespace.name}::${node.member.name}'`

	// A dispatch branch names its target without a Type to read a Signature
	// off, so only its witnesses' scopes are checked, not their count.
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

// Dispatch branches are picked like Match Cases, so a branch can swallow a
// later one through what the runtime can not see. See "Runtime overlap" in
// DEVELOPMENT.md.
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
						// A Match would meet the same conflict, so the Help asks
						// for member Types the runtime can tell apart.
						helps: [
							"Tell the two member Types apart by something that survives to runtime — a member whose Type is not a Function.",
						],
					},
				)

				return
			}

			if (overlapsAtRuntime(earlierType, laterType)) {
				// The List wording, unless a Dictionary is what crosses.
				let dictionary =
					emptyCrossoverKind(earlierType, laterType) === "Dictionary"

				reportWarning(
					dictionary
						? `The branch for ${describeType(laterType)} never sees an empty Dictionary`
						: `The branch for ${describeType(laterType)} never sees an empty List`,
					node.member.position,
					{
						code: dictionary
							? "empty-dictionary-overlap"
							: "empty-list-overlap",
						labels: [
							primary(
								node.member.position,
								dictionary
									? `an empty Dictionary fits ${describeType(earlierType)} too, and that branch is tried first`
									: `an empty List fits ${describeType(earlierType)} too, and that branch is tried first`,
							),
							secondary(
								node.base.position,
								`this is ${withArticle(describeType(node.base.type))}`,
							),
						],
						notes: [
							dictionary
								? "Key and value Types erase before a branch is picked, so a Dictionary is placed by the entries it holds — and an empty Dictionary holds none, which makes it a value of every Dictionary Type there is."
								: "Item Types erase before a branch is picked, so a List is placed by the items it holds — and an empty List holds none, which makes it a value of every List Type there is.",
						],
						// A Match alone meets the same overlap. A Guard decides
						// an empty container, so the Help spells guarded Cases.
						helps: [
							dictionary
								? "Guard the Cases of a Match with 'where @::hasEntries()', answer for the empty Dictionary in a Case of its own, and call the Method inside each arm."
								: "Guard the Cases of a Match with 'where @::hasItems()', answer for the empty List in a Case of its own, and call the Method inside each arm.",
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

	// The callee is not walked as an Expression, so a static call's Namespace
	// and the static Property it calls through are checked here.
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

	// Only an Identifier callee has a name to give.
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
		// Silent where the enricher already refused this call and typed it
		// an Error.
		if (functionType.type !== "Error" && node.type.type !== "Error") {
			reportError("This Expression is not a Function", node.position, {
				code: "not-a-function",
				labels: [
					primary(
						node.position,
						`this is ${withArticle(describeType(functionType))}`,
					),
				],
				helps: [
					"Remove the '()' — the name already reads the value.",
					"Or call a Method on it with '::', which is how a Method is reached.",
				],
			})
		}

		return node
	}

	// A Signature holding an Error measures nothing. See "Holes" in
	// DEVELOPMENT.md.
	if (typeContainsError(functionType)) {
		return node
	}

	// A hole in a positional Argument moves every Argument after it, so the
	// call stands down. A labelled hole moves nothing, and the rest is measured.
	if (holesShiftTheCall(node.arguments)) {
		return node
	}

	if (
		functionType.type === "Function" ||
		functionType.type === "StaticMethod"
	) {
		validateSimpleFunctionInvocation(
			functionType,
			node.arguments,
			node.type,
			node.position,
		)
	} else {
		// A Method called through `.`, as `Namespace.method(…)`, or an
		// Overload set.
		if (
			functionType.type === "OverloadedMethod" ||
			functionType.type === "OverloadedStaticMethod"
		) {
			checkCommittedOverload(node, functionType, describeCallee)
		} else {
			let matchResult = matchCommittedArguments(
				functionType,
				node.arguments,
				node.type,
				true,
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
						matchResult.parameterForArgument[i],
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
	// The hidden conformance Parameters this Function is emitted with, read off
	// the Generics as the simplifier reads them.
	witnessScopes.push(
		new Set(
			node.generics
				.filter((generic) => generic.constraint !== null)
				.map((generic) => conformanceParameterName(generic.name)),
		),
	)
	writtenBounds.push(
		new Map(
			node.generics.flatMap((generic) =>
				generic.constraint === null
					? []
					: [
							[
								generic.name,
								generic.spelling ??
									displayProtocolName(generic.constraint),
							],
						],
			),
		),
	)

	// A body runs when called, so nothing in it is a top-level use. See "Use
	// before declaration" in DEVELOPMENT.md.
	let enclosingIndex = executingTopLevelIndex
	let enclosingProperty = initialisingProperty

	executingTopLevelIndex = null
	initialisingProperty = null
	// The declared Type rather than the parser's `completing` mark, so a
	// `-> Future<…>` body that has not written a `complete` yet may.
	waitingBodies.push(node.returnType.type === "Future" ? true : "plain-body")

	try {
		// A default runs in the body's frame when the Function is called, so it
		// is held to the body's rules, except that it may not wait.
		insideBody("parameter-default", () => {
			for (let defaultValue of parameterDefaults(node.parameters)) {
				validateExpression(defaultValue)
			}
		})

		node.body.map((bodyNode) => validateImplementationNode(bodyNode, node))
	} finally {
		executingTopLevelIndex = enclosingIndex
		initialisingProperty = enclosingProperty
		waitingBodies.pop()
		witnessScopes.pop()
		writtenBounds.pop()
	}

	validateDefiniteReturn(node, position)

	return node
}

function writtenBoundOf(
	parameter: common.GenericUse & { constraint: string },
): string {
	for (let index = writtenBounds.length - 1; index >= 0; index -= 1) {
		let written = writtenBounds[index].get(parameter.name)

		if (written !== undefined) {
			return written
		}
	}

	return displayProtocolName(parameter.constraint)
}

// A native Method has no body, so only its synthesized frame for defaults is
// checked.
function validateNativeShim(shim: common.typed.NativeShimNode): void {
	let enclosingIndex = executingTopLevelIndex
	let enclosingProperty = initialisingProperty

	executingTopLevelIndex = null
	initialisingProperty = null
	witnessScopes.push(new Set())

	try {
		for (let defaultValue of parameterDefaults(shim.parameters)) {
			validateExpression(defaultValue)
		}
	} finally {
		executingTopLevelIndex = enclosingIndex
		initialisingProperty = enclosingProperty
		witnessScopes.pop()
	}
}

function validateLookup(
	node: common.typed.LookupNode,
): common.typed.LookupNode {
	validateExpression(node.base)
	checkPropertyIsBound(node)

	return node
}

// A static Property initialiser reading a Property of its own Namespace not
// yet bound. See "Use before declaration" in DEVELOPMENT.md.
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

// The one thing a name can be wrong about on its own is naming a Namespace
// before its Declaration.
function validateIdentifier(
	node: common.typed.IdentifierNode,
): common.typed.IdentifierNode {
	if (node.type.type === "Namespace") {
		checkNamespaceIsDeclared(node.content, node.position, "this names it")
	}

	return node
}

// Whether a verdict about this Match means anything: neither its value nor a
// runtime Matcher is a hole, and the parser read it whole. See "Holes" in
// DEVELOPMENT.md.
function matchIsJudgeable(node: common.typed.MatchNode): boolean {
	return (
		!typeContainsError(node.value.type) &&
		// The runtime Matcher, where a requirement naming an undeclared
		// member leaves its hole.
		!node.handlers.some((handler) =>
			typeContainsError(runtimeMatcherOf(handler)),
		) &&
		!partiallyRead(node.position)
	)
}

function validateMatch(node: common.typed.MatchNode): common.typed.MatchNode {
	validateExpression(node.value)

	if (!matchIsJudgeable(node)) {
		// The Handlers' bodies are still walked.
		validateMatchHandlers(node)

		return node
	}

	if (node.value.type.type === "UnionType") {
		// Flattened, so a nested Union is discharged by Handlers for its
		// members. See "Match" in DEVELOPMENT.md.
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

		// One Diagnostic for every unhandled member, which share a cause and
		// a fix.
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
					// The same spellings, for the Quick Fix that writes the
					// Handlers.
					data: { kind: "missing-case", unhandled: descriptions },
				},
			)
		}

		// The index of the Handler that claimed each Union member.
		// See "Match" in DEVELOPMENT.md.
		let claimedBy: Array<number | null> = memberTypes.map(() => null)
		let runtimeMatchers = node.handlers.map(runtimeMatcherOf)

		for (
			let handlerIndex = 0;
			handlerIndex < node.handlers.length;
			handlerIndex++
		) {
			let handler = node.handlers[handlerIndex]
			let runtimeMatcher = runtimeMatchers[handlerIndex]
			// The members some value of which passes this Handler's test.
			// Overlap, since a narrowing test still runs for what passes it.
			let matchedMemberIndices: Array<number> = []

			for (
				let memberIndex = 0;
				memberIndex < memberTypes.length;
				memberIndex++
			) {
				if (
					overlapsAtRuntime(runtimeMatcher, memberTypes[memberIndex])
				) {
					matchedMemberIndices.push(memberIndex)
				}
			}

			if (matchedMemberIndices.length === 0) {
				// Tagged `unnecessary`, so editors grey out the dead Matcher.
				reportWarning(
					`This Case can never match`,
					handler.matcherPosition,
					{
						code: "unreachable-case",
						tags: ["unnecessary"],
						labels: [
							primary(
								handler.matcherPosition,
								handler.memberTypes === null
									? `${describeType(handler.matcher)} is not a member of the matched Union`
									: `no value of the matched Union passes ${describeType(runtimeMatcher)}`,
							),
							secondary(
								node.value.position,
								`this is ${withArticle(describeType(node.value.type))}`,
							),
						],
						// Removal is safe, since the Case overlaps no member. A
						// Matcher naming something the Union lacks may be misspelt.
						helps: [
							handler.memberTypes === null
								? `Remove this Case, or name a member of ${describeType(node.value.type)}.`
								: "Remove this Case — no value this Match can be given passes it.",
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

			// Every Type this Handler could match is claimed, so it never runs.
			if (claimingHandlerIndices.length === matchedMemberIndices.length) {
				let claimingHandlerIndex = Math.min(...claimingHandlerIndices)
				let claimingHandler = node.handlers[claimingHandlerIndex]
				let claimingMatcher = runtimeMatchers[claimingHandlerIndex]

				// Why the earlier Case covers this one decides the Notes. See
				// "Runtime overlap" in DEVELOPMENT.md.
				let notes = [
					"Cases are tried in order, and the first one that fits wins.",
				]
				// Reordering helps only where this Matcher is narrower than the
				// one covering it.
				let helps = [
					matchesType(runtimeMatcher, claimingMatcher)
						? "Remove this Case — the Case above answers for every value it would take, in whichever order the two are written."
						: "Remove this Case, or write it above the one that covers it.",
				]
				// Covered through erasure, the Program answers with the wrong
				// value, so the report is an Error.
				let erased = false

				if (claimingHandler.matcher.type === "GenericUse") {
					erased = true

					notes.push(
						`Types erase before a Match runs, so the Generic Case '${describeType(claimingHandler.matcher)}' narrows nothing and accepts every value that reaches it.`,
					)

					// Two Generic Cases accept the same values in either order,
					// so the Help addresses the signature, as `undispatchable-method`
					// does.
					helps =
						handler.matcher.type === "GenericUse"
							? undispatchableHelps(
									[claimingHandler.matcher, handler.matcher],
									node.value.nodeType === "Identifier"
										? node.value.content
										: null,
									writtenBoundOf,
								)
							: [
									`Write this Case above 'case ${describeType(claimingHandler.matcher)}', which can only ever be the last one.`,
								]
				} else if (!matchesType(claimingMatcher, runtimeMatcher)) {
					// Claimed through erasure: a refinement's, where the bases
					// reconcile the two, and otherwise a Function's Signature.
					erased = true

					notes.push(
						matchesType(
							eraseRefinements(claimingMatcher),
							eraseRefinements(runtimeMatcher),
						)
							? "A refinement's predicate erases before a Match runs, so a refined Type is only ever checked as its base — which makes these two Matchers ask the same question."
							: "A Function's Signature erases before a Match runs, so a Function-typed member is only ever checked for being callable — which makes these two Matchers ask the same question.",
					)

					// A Guard helps on neither Case. Two Matchers asking one
					// erased question admit no exhaustive Match.
					helps = [
						"Tell the two Cases apart by a member that survives to runtime — a member whose Type is not a Function.",
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
					// Tagged `unnecessary`: dead, not wrong.
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
				reportEmptyContainerOverlap(
					node,
					handlerIndex,
					matchedMemberIndices,
					memberTypes,
					runtimeMatchers,
				)

				if (claimsWhatItsTestAccepts(handler)) {
					for (let memberIndex of matchedMemberIndices) {
						if (
							claimedBy[memberIndex] === null &&
							acceptsAllAtRuntime(
								runtimeMatcher,
								memberTypes[memberIndex],
							)
						) {
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
				// The forms that ask about a value with one shape.
				helps: [
					"Ask about the value with an 'if', or choose between answers with a 'define'.",
				],
			},
		)
	}

	validateMatchHandlers(node)

	return node
}

// Validates every Handler's Guard, literals and body, whatever the verdict on
// the Match.
function validateMatchHandlers(node: common.typed.MatchNode): void {
	for (let handler of node.handlers) {
		// A Guard is a Condition like any other.
		if (handler.guard !== null) {
			validateCondition(handler.guard, "A Case Guard")
		}

		// A Matcher's literals are Expressions too, such as `case 1/0`.
		if (handler.literal !== null) {
			validateExpression(handler.literal)
		}

		if (handler.memberLiterals !== null) {
			for (let memberLiteral of Object.values(handler.memberLiterals)) {
				validateExpression(memberLiteral)
			}
		}

		// A Handler is validated as a Function body, so its `<-` Statements
		// are checked against the Match's Type.
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
}

// Validates both halves of every arm. The validator recurs by hand, so an arm
// not visited here is not validated at all.
function validateDefine(
	node: common.typed.DefineNode,
): common.typed.DefineNode {
	reportCaselessDefine(node)

	for (let arm of node.arms) {
		checkDefineAnswer(node, arm.value)
		validateExpression(arm.value)

		// An arm's Condition must be a Boolean, as an `if`'s must.
		validateCondition(arm.condition, "A Define Condition")
	}

	checkDefineAnswer(node, node.otherwise.value)
	validateExpression(node.otherwise.value)

	return node
}

// A `define` whose only arm is the `otherwise` one asks nothing. A Warning
// tagged `unnecessary`, since a ladder being written has this shape.
function reportCaselessDefine(node: common.typed.DefineNode): void {
	// Silent where the parser dropped the arms. See `partiallyRead`.
	if (node.arms.length > 0 || partiallyRead(node.position)) {
		return
	}

	reportWarning("This 'define' has no cases", node.position, {
		code: "define-without-cases",
		labels: [primary(node.position, "nothing here is decided by cases")],
		tags: ["unnecessary"],
		notes: [
			"A 'define' answers with the value of the first arm whose Condition holds — and the 'otherwise' arm is the one that holds when none of them did.",
		],
		helps: [
			"Write the 'otherwise' value on its own, or add the arms this 'define' was going to ask.",
		],
	})
}

// Every arm is held to the `define`'s answer Type, and reported at its value
// with the code a `<-` gets.
function checkDefineAnswer(
	node: common.typed.DefineNode,
	value: common.typed.ExpressionNode,
): void {
	if (fitsExpectedType(node.type, value)) {
		return
	}

	let evidence = refinementEvidence(node.type, value)
	let undecided = undecidedSlotEvidence(node.type, value.type, null)
	let record = recordMismatchEvidence(node.type, value.type, value, {
		subject: "the Type this 'define' has",
	})

	reportError(
		"This arm does not answer with the Type this 'define' has",
		record.lead?.position ?? value.position,
		{
			code: "return-type-mismatch",
			labels: [
				record.lead ??
					primary(
						value.position,
						`this is ${withArticle(describeType(value.type))}`,
					),
				...record.labels,
				...evidence.labels,
			],
			notes: [
				`This 'define' answers ${describeType(node.type)}.`,
				...record.notes,
				...evidence.notes,
				...undecided.notes,
			],
			helps: [
				...asynchronyHelps(
					node.type,
					value.type,
					bodyCanWait(),
					completionBarrier(),
				),
				...record.helps,
				...evidence.helps,
				...undecided.helps,
			],
			data:
				asynchronyData(node.type, value.type, bodyCanWait()) ??
				record.data,
		},
	)
}

// A Case whose empty container values an earlier Case takes. One Diagnostic
// per Handler. See "Runtime overlap" in DEVELOPMENT.md.
function reportEmptyContainerOverlap(
	node: common.typed.MatchNode,
	handlerIndex: number,
	matchedMemberIndices: Array<number>,
	memberTypes: Array<common.Type>,
	runtimeMatchers: Array<common.Type>,
): void {
	let handler = node.handlers[handlerIndex]

	for (let earlierIndex = 0; earlierIndex < handlerIndex; earlierIndex++) {
		let earlierHandler = node.handlers[earlierIndex]
		let earlierMatcher = runtimeMatchers[earlierIndex]

		if (!claimsWhatItsTestAccepts(earlierHandler)) {
			continue
		}

		for (let memberIndex of matchedMemberIndices) {
			let memberType = memberTypes[memberIndex]

			let crossover =
				acceptsAllAtRuntime(earlierMatcher, memberType) ||
				!overlapsAtRuntime(earlierMatcher, memberType)
					? null
					: emptyCrossoverKind(earlierMatcher, memberType)

			if (crossover === null) {
				continue
			}

			reportWarning(
				crossover === "List"
					? "This Case never sees an empty List"
					: "This Case never sees an empty Dictionary",
				handler.matcherPosition,
				{
					code:
						crossover === "List"
							? "empty-list-overlap"
							: "empty-dictionary-overlap",
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
						crossover === "List"
							? "Item Types erase before a Match runs, so a List Matcher asks about the items the value holds — and an empty List holds none, which makes it a value of every List Type there is."
							: "Key and value Types erase before a Match runs, so a Dictionary Matcher asks about the entries the value holds — and an empty Dictionary holds none, which makes it a value of every Dictionary Type there is.",
					],
					helps: [
						crossover === "List"
							? "Guard the Cases with 'where @::hasItems()' and answer for the empty List in a Case of its own."
							: "Guard the Cases with 'where @::hasEntries()' and answer for the empty Dictionary in a Case of its own.",
					],
				},
			)

			return
		}
	}
}

// A Match on an Integer or a String whose Cases name values.
// See "Literal Matches" in DEVELOPMENT.md.
function isLiteralMatch(node: common.typed.MatchNode): boolean {
	let scrutinee = eraseRefinements(node.value.type)

	return (
		(scrutinee.type === "Integer" || scrutinee.type === "String") &&
		node.handlers.some((handler) => handler.literal !== null)
	)
}

// One Diagnostic per misplaced Case, and one for a missing last Case.
function validateLiteralMatchShape(node: common.typed.MatchNode): void {
	let scrutinee = eraseRefinements(node.value.type)
	let matchedValue = () =>
		secondary(
			node.value.position,
			`this is ${withArticle(describeType(node.value.type))}`,
		)
	let takesValuesApart = `A Match on ${withArticle(describeType(scrutinee))} takes the VALUE apart: every Case names a value, and the last one answers for every value the Cases above it did not name.`
	let lastIndex = node.handlers.length - 1
	let last = node.handlers[lastIndex]
	// Asked once, for the Help and the final check alike.
	let endsInACaseForTheRest =
		last !== undefined &&
		isUnconditionalHandler(last) &&
		acceptsAllAtRuntime(last.matcher, node.value.type)

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
					// Moving it to the end helps only where no last Case exists.
					helps: [
						endsInACaseForTheRest
							? "Write the value this Case is about, or remove it — the last Case already answers for every value the Cases above it do not name."
							: "Write the value this Case is about, or move it to the end, where it answers for every value the Cases above it do not name.",
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

		// A Case naming a value of another Type is a comparison that is never
		// true.
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
					// Removal is always safe, since the Case is never true.
					helps: [
						`Name ${withArticle(describeType(scrutinee))}, or remove this Case.`,
					],
				},
			)
		}
	}

	// A `case _`, or a Case naming the matched Type, ends a Match on values.
	if (last === undefined || endsInACaseForTheRest) {
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

// Why the last Handler does not end a Match on values, underlining the part
// that decides.
function finalHandlerLabel(handler: MatchHandler): common.DiagnosticLabel {
	if (handler.literal !== null || handler.memberLiterals !== null) {
		return primary(
			handler.matcherPosition,
			"this Case names a value, not the rest of them",
		)
	}

	if (handler.memberTypes !== null) {
		return primary(
			handler.matcherPosition,
			"this Case asks something of the payload, so it can decline one",
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

// Whether a Handler covers its Matcher's whole Type: no literal, member
// literal, payload requirement or Guard.
function isUnconditionalHandler(handler: MatchHandler): boolean {
	return (
		handler.literal === null &&
		handler.memberLiterals === null &&
		handler.memberTypes === null &&
		handler.guard === null
	)
}

// Whether the Handler's emitted test is its whole question. A payload
// requirement is part of the test; a literal or a Guard decides after it.
function claimsWhatItsTestAccepts(handler: MatchHandler): boolean {
	return (
		handler.literal === null &&
		handler.memberLiterals === null &&
		handler.guard === null
	)
}

// The question a Handler's emitted test asks, as one Type: the Matcher with
// its payload requirements grafted on.
function runtimeMatcherOf(handler: MatchHandler): common.Type {
	if (handler.memberTypes === null) {
		return handler.matcher
	}

	let matcher = handler.matcher

	for (let [path, requiredType] of Object.entries(handler.memberTypes)) {
		matcher = graftRequirement(matcher, path.split("."), requiredType)
	}

	return matcher
}

function graftRequirement(
	type: common.Type,
	path: Array<string>,
	requiredType: common.Type,
): common.Type {
	let step = path[0]

	if (step === undefined) {
		return requiredType
	}

	if (type.type !== "Record" && type.type !== "Case") {
		return type
	}

	let members = {
		...type.members,
		[step]: graftRequirement(
			Object.hasOwn(type.members, step)
				? type.members[step]!
				: { type: "Unknown" },
			path.slice(1),
			requiredType,
		),
	}

	// A grafted Record drops its Alias name, since its shape is no longer the
	// Alias's and it is printed. A Case keeps its name, which the tag asks.
	return type.type === "Record"
		? { type: "Record", members }
		: { ...type, members }
}

// Whether the check emitted for `matcher` accepts every value of
// `memberType`. See "Runtime overlap" in DEVELOPMENT.md. Exported for the spec
// that holds it to the runtime's `isValueOfType`.
export function acceptsAllAtRuntime(
	matcher: common.Type,
	memberType: common.Type,
): boolean {
	// A refinement's predicate never reaches the runtime, so both sides are
	// unwrapped first.
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

	// Every arm of a matched Union has to pass. A Union Matcher passes a value
	// as soon as one of its arms does.
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

	// Structural and open: the value carries every member the Matcher names.
	if (matcher.type === "Record" && memberType.type === "Record") {
		return membersAcceptAllAtRuntime(matcher.members, memberType.members)
	}

	// The Record check after the tag. The payload tells `Box<Integer>#Full`
	// from `Box<String>#Full`.
	if (matcher.type === "Case" && memberType.type === "Case") {
		return (
			matcher.choice === memberType.choice &&
			matcher.name === memberType.name &&
			membersAcceptAllAtRuntime(matcher.members, memberType.members)
		)
	}

	// A List Matcher is answered by the items a value holds. A bare `List`
	// takes every List, and a List of undecided items is not all of anything.
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

	// A Dictionary Matcher is answered by the entries a value holds, slot by
	// slot.
	if (isRuntimeDictionary(matcher) && isRuntimeDictionary(memberType)) {
		return (
			slotAcceptsAllAtRuntime(
				runtimeKeyType(matcher),
				runtimeKeyType(memberType),
			) &&
			slotAcceptsAllAtRuntime(
				runtimeValueType(matcher),
				runtimeValueType(memberType),
			)
		)
	}

	return false
}

// Whether the check emitted for `matcher` accepts some value of
// `memberType`, empty containers included. See "Runtime overlap" in
// DEVELOPMENT.md.
export function overlapsAtRuntime(
	matcher: common.Type,
	memberType: common.Type,
): boolean {
	// Unwrapped as in `acceptsAllAtRuntime`.
	if (matcher.type === "Refinement" || memberType.type === "Refinement") {
		return overlapsAtRuntime(
			eraseRefinements(matcher),
			eraseRefinements(memberType),
		)
	}

	if (acceptsAllAtRuntime(matcher, memberType)) {
		return true
	}

	// A Type Parameter member is not counted as an overlap; sorting its values
	// out is what the Handlers are for.
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

	// The empty List, whatever the two item Types are.
	if (isRuntimeList(matcher) && isRuntimeList(memberType)) {
		return true
	}

	// And the empty Dictionary.
	if (isRuntimeDictionary(matcher) && isRuntimeDictionary(memberType)) {
		return true
	}

	return false
}

// Whether the values crossing from `memberType` into `matcher` are the empty
// ones of a container of `kind`.
function overlapsThroughEmptyContainer(
	matcher: common.Type,
	memberType: common.Type,
	kind: EmptyCrossover,
): boolean {
	if (matcher.type === "Refinement" || memberType.type === "Refinement") {
		return overlapsThroughEmptyContainer(
			eraseRefinements(matcher),
			eraseRefinements(memberType),
			kind,
		)
	}

	let isContainer = kind === "List" ? isRuntimeList : isRuntimeDictionary

	if (isContainer(matcher) && isContainer(memberType)) {
		return !acceptsAllAtRuntime(matcher, memberType)
	}

	if (memberType.type === "UnionType") {
		return flattenUnionMembers(memberType).some((armType) =>
			overlapsThroughEmptyContainer(matcher, armType, kind),
		)
	}

	if (matcher.type === "UnionType") {
		return flattenUnionMembers(matcher).some((armType) =>
			overlapsThroughEmptyContainer(armType, memberType, kind),
		)
	}

	if (
		(matcher.type === "Record" && memberType.type === "Record") ||
		(matcher.type === "Case" && memberType.type === "Case")
	) {
		return Object.entries(matcher.members).some(
			([name, memberMatcher]) =>
				Object.hasOwn(memberType.members, name) &&
				overlapsThroughEmptyContainer(
					memberMatcher,
					memberType.members[name],
					kind,
				),
		)
	}

	return false
}

// Which container's empty value crosses, or null. A List is asked about first.
type EmptyCrossover = "List" | "Dictionary"

function emptyCrossoverKind(
	matcher: common.Type,
	memberType: common.Type,
): EmptyCrossover | null {
	if (overlapsThroughEmptyContainer(matcher, memberType, "List")) {
		return "List"
	}

	if (overlapsThroughEmptyContainer(matcher, memberType, "Dictionary")) {
		return "Dictionary"
	}

	return null
}

function membersAcceptAllAtRuntime(
	matcherMembers: Record<string, common.Type>,
	memberTypes: Record<string, common.Type>,
): boolean {
	// `Object.hasOwn`, so a member named like an `Object.prototype` property
	// is not read off the prototype.
	return Object.entries(matcherMembers).every(
		([name, memberMatcher]) =>
			Object.hasOwn(memberTypes, name) &&
			acceptsAllAtRuntime(memberMatcher, memberTypes[name]),
	)
}

function membersOverlapAtRuntime(
	matcherMembers: Record<string, common.Type>,
	memberTypes: Record<string, common.Type>,
): boolean {
	return Object.entries(matcherMembers).every(
		([name, memberMatcher]) =>
			Object.hasOwn(memberTypes, name) &&
			overlapsAtRuntime(memberMatcher, memberTypes[name]),
	)
}

// The Types the runtime's List check answers: `List<X>` and the bare `List`,
// which names no item Type.
function isRuntimeList(type: common.Type): boolean {
	return type.type === "List" || type.type === "GenericList"
}

function runtimeItemType(type: common.Type): common.Type {
	return type.type === "List" ? type.itemType : { type: "Unknown" }
}

// The same for the Dictionary, whose bare spelling reads both slots as
// Unknown.
function isRuntimeDictionary(type: common.Type): boolean {
	return type.type === "Dictionary" || type.type === "GenericDictionary"
}

function runtimeKeyType(type: common.Type): common.Type {
	return type.type === "Dictionary" ? type.keyType : { type: "Unknown" }
}

function runtimeValueType(type: common.Type): common.Type {
	return type.type === "Dictionary" ? type.valueType : { type: "Unknown" }
}

// One slot of a Dictionary, asked as a List's items are. Both slots must
// answer, so the keys alone never decide.
function slotAcceptsAllAtRuntime(
	matcherSlot: common.Type,
	memberSlot: common.Type,
): boolean {
	if (matcherSlot.type === "Unknown") {
		return true
	}

	return (
		memberSlot.type !== "Unknown" &&
		acceptsAllAtRuntime(matcherSlot, memberSlot)
	)
}

// The payload is checked here rather than in the enricher, since the Case's
// Type resolves either way and a wrong payload stays one Diagnostic.
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

	// A hole in the Case's members or the payload stands every check down.
	if (
		typeContainsError(node.type) ||
		(node.value !== null && typeContainsError(node.value.type))
	) {
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
				// A bare `#Case` always spells a unit Case, so a fully defaulted
				// payload is written `({})`. Otherwise the Help spells the shape.
				helps:
					node.type.payloadDefault?.members.length ===
					Object.keys(node.type.members).length
						? [
								`Its default fills every member in — write '#${node.type.name}({})'.`,
							]
						: [
								`Write the payload, filling each member in: '#${node.type.name}({ ${Object.keys(
									node.type.members,
								)
									.map((member) => `${member} = …`)
									.join(", ")} })'.`,
							],
			},
		)
	} else if (
		reportUnmergedPayloadPathKey(payloadType, node.type, node.value)
	) {
		// Reported already, at the path key the default does not reach.
	} else if (casePayloadIsPartial(node.type, node.value)) {
		let missing = missingRecordMembers(
			payloadType,
			node.type.payloadDefault!.members,
			casePayloadType(node.type, node.value) as common.RecordType,
		)

		if (missing.length > 0) {
			reportIncompleteCasePayload(node.type, missing, node.value)
		}
	} else if (
		!matchesType(payloadType, casePayloadType(node.type, node.value))
	) {
		// An undecided Type Argument can be what refuses the payload.
		let undecided = undecidedSlotEvidence(
			payloadType,
			casePayloadType(node.type, node.value),
			null,
		)
		// The payload shape is named after its Case.
		let record = recordMismatchEvidence(
			payloadType,
			casePayloadType(node.type, node.value),
			node.value,
			{ subject: `'#${node.type.name}'` },
		)

		reportError(
			`This payload does not fit Case '#${node.type.name}'`,
			record.lead?.position ?? node.value.position,
			{
				code: "payload-type-mismatch",
				labels: [
					record.lead ??
						primary(
							node.value.position,
							`this is ${withArticle(describeType(node.value.type))}`,
						),
					...record.labels,
				],
				notes: [
					`'#${node.type.name}' carries ${withArticle(describeType(payloadType))}.`,
					...record.notes,
					...undecided.notes,
				],
				helps: [
					...record.helps,
					// The shorthand hint, only for a multi-member Case whose
					// payload does not already spell its members.
					...(Object.keys(node.type.members).length > 1 &&
					!payloadSpellsTheCasesMembers(node.type, node.value)
						? [
								"The one-member shorthand '#Case(value)' only applies to single-member Cases.",
							]
						: []),
					...undecided.helps,
				],
				data: record.data,
			},
		)
	}

	return node
}

// Whether the payload names exactly the Case's members, which tells a written
// Record from a tried shorthand. Names only, since the Types disagreed.
function payloadSpellsTheCasesMembers(
	caseType: common.CaseType,
	value: common.typed.ExpressionNode,
): boolean {
	if (value.type.type !== "Record") {
		return false
	}

	let declared = Object.keys(caseType.members)
	let written = Object.keys(value.type.members)

	return (
		declared.length === written.length &&
		declared.every((name) => written.includes(name))
	)
}

// A Record Literal payload for a Case with a payload default is measured as a
// partial. Any other payload may carry more than its Type names, so it is held
// to the whole payload, as a Record Argument is.
function casePayloadIsPartial(
	caseType: common.CaseType,
	value: common.typed.ExpressionNode,
): boolean {
	return (
		caseType.payloadDefault !== undefined &&
		value.nodeType === "RecordValue" &&
		value.type.type === "Record" &&
		isPartialOf(
			{ type: "Record", members: caseType.members },
			casePayloadType(caseType, value) as common.RecordType,
		)
	)
}

// The payload's Type once the default fills in what a path key reaches, or
// its own Type where it wrote no path key.
function casePayloadType(
	caseType: common.CaseType,
	value: common.typed.ExpressionNode,
): common.Type {
	return (
		mergedRecordType(
			{ type: "Record", members: caseType.members },
			caseType.payloadDefault?.nesting,
			value,
		) ?? value.type
	)
}

function reportIncompleteCasePayload(
	caseType: common.CaseType,
	missing: Array<string>,
	value: common.typed.ExpressionNode,
): void {
	let filled = caseType.payloadDefault?.members ?? []

	reportError(
		`This payload is missing ${countOf(missing.length, "member")} the default does not fill in`,
		value.position,
		{
			code: "incomplete-record-argument",
			labels: [
				primary(
					value.position,
					`${quotedNames(missing)} not written here`,
				),
			],
			notes: [
				`'#${caseType.name}' carries ${withArticle(describeType({ type: "Record", members: caseType.members }))}.`,
				filled.length === 0
					? "Its default fills in nothing; every member must be written."
					: `Its default fills in ${quotedNames(filled)}; every other member must be written.`,
			],
			helps: [`Write ${quotedNames(missing)} into this payload.`],
			// The data an incomplete Record Argument carries.
			data: { kind: "missing-members", names: missing },
		},
	)
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

// Each member is walked as an Expression. The Record's shape is the
// enricher's business.
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

// Both halves of every entry, held to what a List's items are.
function validateDictionaryValue(
	node: common.typed.DictionaryValueNode,
): common.typed.DictionaryValueNode {
	for (let entry of node.entries) {
		validateExpression(entry.key)
		validateNoBoundFunctionValue(entry.key)
		validateExpression(entry.value)
		validateNoBoundFunctionValue(entry.value)
	}

	return node
}

// Each hole is walked as an Expression. A Function value in a hole is
// refused by the enricher as not Printable.
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

// Both sides are walked as Expressions. Whether the shapes combine is the
// enricher's business.
function validateCombination(
	node: common.typed.CombinationNode,
): common.typed.CombinationNode {
	validateExpression(node.lhs)
	validateExpression(node.rhs)

	return node
}

// #endregion

// #region Statements

// The assertions are excluded from the parameter Type, since
// `validateImplementationNode` routes them to `validateAssertion`.
function validateStatement(
	node: Exclude<
		common.typed.StatementNode,
		common.typed.ExpectStatementNode | common.typed.RequireStatementNode
	>,
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
			return node
		case "ChoiceDeclarationStatement":
			return validateChoiceDeclarationStatement(node)
		case "ProtocolDeclarationStatement":
			return validateProtocolDeclarationStatement(node)
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
				node.synthesized === "base" || node.synthesized === "subject"
					? null
					: node.name.content,
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

// A Type Annotation has no Position, so the declared Type is a Note and the
// value gets the arrow. `name` is null for the hidden Constant of a Pattern
// Declaration, and the report names the Pattern.
function reportDeclarationMismatch(
	kind: "Constant" | "Variable" | "Property",
	name: string | null,
	declaredType: common.Type,
	value: common.typed.ExpressionNode,
): void {
	let evidence = refinementEvidence(declaredType, value)
	let subject = name === null ? "the Pattern" : `${kind} '${name}'`
	let record = recordMismatchEvidence(declaredType, value.type, value, {
		subject: "the declared Type",
	})

	reportError(
		`This value does not fit the declared Type of ${subject}`,
		record.lead?.position ?? value.position,
		{
			code: "assignment-type-mismatch",
			labels: [
				record.lead ??
					primary(
						value.position,
						`this is ${withArticle(describeType(value.type))}`,
					),
				...record.labels,
				...evidence.labels,
			],
			notes: [
				`${name === null ? "The Pattern" : `'${name}'`} is declared as ${describeType(declaredType)}.`,
				...record.notes,
				...evidence.notes,
			],
			helps: [
				...asynchronyHelps(
					declaredType,
					value.type,
					bodyCanWait(),
					completionBarrier(),
				),
				...record.helps,
				...evidence.helps,
			],
			data:
				asynchronyData(declaredType, value.type, bodyCanWait()) ??
				record.data,
		},
	)
}

function validateVariableAssignmentStatement(
	node: common.typed.VariableAssignmentStatementNode,
): common.typed.VariableAssignmentStatementNode {
	if (!fitsExpectedType(node.name.type, node.value)) {
		let declaredType = describeType(node.name.type)
		let evidence = refinementEvidence(node.name.type, node.value)
		// A Variable declared from an empty Literal can be undecided, as in
		// `List<Unknown>`, which the report explains.
		let undecided = undecidedSlotEvidence(
			node.name.type,
			node.value.type,
			node.name.content,
		)

		let record = recordMismatchEvidence(
			node.name.type,
			node.value.type,
			node.value,
			{ subject: `Variable '${node.name.content}'` },
		)

		reportError(
			`This value does not fit Variable '${node.name.content}'`,
			record.lead?.position ?? node.value.position,
			{
				code: "assignment-type-mismatch",
				labels: [
					record.lead ??
						primary(
							node.value.position,
							`this is ${withArticle(describeType(node.value.type))}`,
						),
					...record.labels,
					// Null for a builtin, which has no Essence source.
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
					...record.notes,
					...undecided.notes,
					...evidence.notes,
				],
				helps: [
					...asynchronyHelps(
						node.name.type,
						node.value.type,
						bodyCanWait(),
						completionBarrier(),
					),
					...record.helps,
					...undecided.helps,
					...evidence.helps,
				],
				data:
					asynchronyData(
						node.name.type,
						node.value.type,
						bodyCanWait(),
					) ?? record.data,
			},
		)
	}

	validateExpression(node.value)
	validateNoBoundFunctionValue(node.value)

	return node
}

// A Method whose every returning path returns a direct call to itself has no
// base case and never returns. A call that only might recurse is not judged.
type MethodIdentity = {
	namespaceName: string
	methodName: string
	// Null for a non-overloaded Method. A call to a sibling Overload is not
	// self-recursion.
	overloadIndex: number | null
}

// The returns at the body's own level, through `if` and `else`. A `match`
// Case or a nested literal may resolve `@::method()` to another Method.
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
	position: common.Position,
	identity: MethodIdentity,
): void {
	let returns = collectTopLevelReturns(definition.body)

	// Silent without returns of its own, or where the parser dropped part of
	// the Method, which may have been the base case.
	if (returns.length === 0 || partiallyRead(position)) {
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

// A Choice's only Expressions are its payload defaults, held to what every
// Expression is.
function validateChoiceDeclarationStatement(
	node: common.typed.ChoiceDeclarationStatementNode,
): common.typed.ChoiceDeclarationStatementNode {
	for (let defaultValue of caseDefaults(node.cases)) {
		validateExpression(defaultValue)
		validateNoBoundFunctionValue(defaultValue)
	}

	return node
}

// A Protocol's provided Methods are held to what a Namespace's Methods are.
function validateProtocolDeclarationStatement(
	node: common.typed.ProtocolDeclarationStatementNode,
): common.typed.ProtocolDeclarationStatementNode {
	for (let methodName in node.methods) {
		let method = node.methods[methodName]

		if (
			method.nodeType !== "SimpleMethod" &&
			method.nodeType !== "StaticMethod"
		) {
			continue
		}

		validateFunctionDefinition(method.method.value, method.method.position)
		checkInfiniteRecursion(
			method.name,
			method.method.value,
			method.method.position,
			{
				namespaceName: node.name.content,
				methodName: method.name.content,
				overloadIndex: null,
			},
		)
	}

	return node
}

function validateNamespaceDefinitionStatement(
	node: common.typed.NamespaceDefinitionStatementNode,
): common.typed.NamespaceDefinitionStatementNode {
	// A static Property's initialiser is held to what a Constant's value is.
	// Walked in written order, so `unbound` shrinks as each is passed.
	// See "Use before declaration" in DEVELOPMENT.md.
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
			checkInfiniteRecursion(
				method.name,
				method.method.value,
				method.method.position,
				{
					namespaceName: node.name.content,
					methodName: method.name.content,
					overloadIndex: null,
				},
			)
		} else {
			for (let index = 0; index < method.methods.length; index++) {
				let overloadedMethod = method.methods[index]

				validateFunctionDefinition(
					overloadedMethod.value,
					overloadedMethod.position,
				)
				checkInfiniteRecursion(
					method.name,
					overloadedMethod.value,
					overloadedMethod.position,
					{
						namespaceName: node.name.content,
						methodName: method.name.content,
						overloadIndex: method.overloadIndices[index],
					},
				)
			}
		}
	}

	for (let shim of node.nativeShims) {
		validateNativeShim(shim)
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

// Whether a head was abandoned after `topLevelStatementFloor` and at or
// before `line`. See "Top-level returns" in DEVELOPMENT.md.
function aHeadWasAbandonedAbove(line: number): boolean {
	for (let headLine of abandonedHeadLines) {
		if (headLine > topLevelStatementFloor && headLine <= line) {
			return true
		}
	}

	return false
}

function validateReturnStatement(
	node: common.typed.ReturnStatementNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.ReturnStatementNode {
	if (currentFunctionContext === null) {
		// Silent where the parser could have dropped the body this `<-`
		// belongs in. See "Top-level returns" in DEVELOPMENT.md.
		if (
			!partiallyRead(node.position) &&
			!aHeadWasAbandonedAbove(node.position.start.line)
		) {
			reportError("There is nothing here to return from", node.position, {
				code: "top-level-return",
				labels: [
					primary(node.position, "this is outside any Function"),
				],
				// A top-level `<-` is a value to keep or a body without a head.
				helps: [
					"Drop the '<-' and write the value on its own, or as a 'constant'.",
					"Or move the Statement into a Function, which is the only thing a '<-' answers for.",
				],
			})
		}
	} else if (
		!fitsExpectedType(
			returnedTypeOf(
				currentFunctionContext.returnType,
				currentFunctionContext.completing === true,
			),
			node.expression,
		)
	) {
		// A completing body's `<-` is held to the inner Type of its declared
		// `Future<T>`, which the emission wraps.
		let expected = returnedTypeOf(
			currentFunctionContext.returnType,
			currentFunctionContext.completing === true,
		)
		let evidence = refinementEvidence(expected, node.expression)
		// An inferred return Type can be undecided, as in `List<Unknown>`,
		// which the report explains.
		let undecided = undecidedSlotEvidence(
			expected,
			node.expression.type,
			null,
		)
		let record = recordMismatchEvidence(
			expected,
			node.expression.type,
			node.expression,
			{ subject: "the declared return Type" },
		)

		reportError(
			"This value does not fit the declared return Type",
			// The refused member of a written Record Literal, or the whole
			// value.
			record.lead?.position ?? node.expression.position,
			{
				code: "return-type-mismatch",
				// The declared return Type has no Position, so it is a Note.
				labels: [
					record.lead ??
						primary(
							node.expression.position,
							`this is ${withArticle(describeType(node.expression.type))}`,
						),
					...record.labels,
					...evidence.labels,
				],
				notes: [
					`The Function returns ${describeType(expected)}.`,
					...record.notes,
					...evidence.notes,
					...undecided.notes,
				],
				helps: [
					...returnAsynchronyHelps(
						expected,
						node.expression.type,
						currentFunctionContext.completing === true,
					),
					...record.helps,
					...evidence.helps,
					...undecided.helps,
				],
				// Unlike elsewhere, `complete` is offered even where the body
				// can not wait yet: the fixes that follow converge.
				data:
					asynchronyData(expected, node.expression.type) ??
					record.data,
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

// Reports a use of a top-level Namespace that runs before its Declaration.
// `useLabel` is the use's Label. See "Use before declaration" in DEVELOPMENT.md.
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

// The `require` line that takes this value apart by its first Case, or null
// where it holds none. A name is spelled back, anything else as `…`.
function takingItApart(value: common.typed.ExpressionNode): string | null {
	let members =
		value.type.type === "UnionType"
			? flattenUnionMembers(value.type)
			: [value.type]
	let first = members.find((member) => member.type === "Case")

	if (first === undefined || first.type !== "Case") {
		return null
	}

	let matcher =
		Object.keys(first.members).length === 0
			? `#${first.name}`
			: `#${first.name}(…)`
	let named = value.nodeType === "Identifier" ? value.content : "…"

	return `Or take it apart instead: 'require ${matcher} = ${named}'.`
}

// An assertion without a Matcher or a snapshot must be a Boolean, as an `if`
// Condition must. A Matcher was checked where it was resolved.
function validateAssertion(
	node: common.typed.ExpectStatementNode | common.typed.RequireStatementNode,
): common.typed.ImplementationNode {
	// A snapshot compares the rendered value, which the enricher required to
	// be Printable.
	if (
		node.matcher === null &&
		node.snapshot === null &&
		node.value.type.type !== "Boolean" &&
		node.value.type.type !== "Error"
	) {
		// Taking the value apart is offered only where it holds a Case.
		let taking = takingItApart(node.value)

		reportError("An assertion has to be a Boolean", node.value.position, {
			code: "expect-not-boolean",
			labels: [
				primary(
					node.value.position,
					`this is ${withArticle(describeType(node.value.type))}`,
				),
			],
			notes: [
				"Essence has no truthiness — an assertion is a Boolean Expression, and the standard library's own Methods are the vocabulary it is written in.",
			],
			helps: [
				"Ask a question of it: '::is(…)', '::isGreaterThan(…)', '::hasItems()'.",
				...(taking === null ? [] : [taking]),
			],
		})
	}

	validateExpression(node.value)

	if (node.matcher !== null) {
		if (node.matcher.literal !== null) {
			validateExpression(node.matcher.literal)
		}

		for (let literal of Object.values(node.matcher.memberLiterals ?? {})) {
			validateExpression(literal)
		}
	}

	return node
}

// Every Condition must be a Boolean, since Essence has no truthiness.
// `description` names the Condition in the message.
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
			helps: [booleanQuestionHelp(condition.type)],
		})
	}

	validateExpression(condition)
}

// The Help for a Condition that is not a Boolean.
function booleanQuestionHelp(type: common.Type): string {
	return `Ask a question that answers a Boolean — '::${booleanQuestionFor(type)}' reads ${withArticle(describeType(type))}.`
}

function validateDefiniteReturn(
	definition: common.typed.FunctionDefinitionNode,
	position: common.Position,
): void {
	// The inner Type for a completing body, so `-> Future<{}>` needs no `<-`.
	let returnType = returnedTypeOf(
		definition.returnType,
		definition.completing === true,
	)

	if (
		isUnitType(returnType) ||
		returnType.type === "Unknown" ||
		returnType.type === "Error"
	) {
		return
	}

	// A body the parser did not read whole may have lost its `<-`.
	if (partiallyRead(position)) {
		return
	}

	if (!bodyDefinitelyReturns(definition.body)) {
		reportError("Not every path through this Function returns", position, {
			code: "missing-return",
			labels: [primary(position, "this path falls off the end")],
			// A completing body answers its Future's inner Type, which its
			// signature does not spell.
			notes: [
				definition.completing === true
					? `This body waits, so its '<-' answers with ${describeType(returnType)}; every path must yield one.`
					: `The declared return Type is ${describeType(returnType)}, so every path must yield one.`,
			],
			// A final `<-` or an `else`, which are different Programs.
			helps: [
				`Write a '<-' answering ${withArticle(describeType(returnType))} at the end of the body.`,
				"Or give every branch one — an 'if' with no 'else' leaves the path around it falling through.",
			],
		})
	}
}

// Whether a value fits where it was written. A written literal carries its
// own evidence for a refinement, so `constant d: NonZeroInteger = 3` fits. A
// hole fits. See "Holes" in DEVELOPMENT.md.
function fitsExpectedType(
	expected: common.Type,
	value: common.typed.ExpressionNode,
): boolean {
	if (typeContainsError(expected) || value.type.type === "Error") {
		return true
	}

	return fitsWritten(expected, value)
}

// What a mismatch against a refinement adds: the unasked predicate and where
// an answer comes from. Empty for other Types. The refinement is named as
// applied, with its Type Arguments.
function refinementEvidence(
	expected: common.Type | undefined,
	value?: common.typed.ExpressionNode,
): {
	labels: Array<common.DiagnosticLabel>
	notes: Array<string>
	helps: Array<string>
} {
	if (expected !== undefined && value !== undefined) {
		let refused = unadmittedWrittenItem(expected, value)

		if (refused !== null) {
			let predicate = describePredicate(refused.refinement)
			let spelling = describeType(refused.refinement)

			return {
				labels: [
					secondary(
						refused.value.position,
						`this ${refused.part} is ${withArticle(describeType(refused.value.type))}`,
					),
				],
				notes: [
					`Every ${refused.part} has to be ${withArticle(spelling)}, and every value of that Type has been proven to answer '${predicate}'.`,
				],
				helps: [
					`Check '${predicate}' on the ${refused.part} in an 'if' or a 'match', or write ${refused.part === "item" ? "an item" : `a ${refused.part}`} that already has Type '${spelling}'.`,
				],
			}
		}
	}

	if (expected === undefined || expected.type !== "Refinement") {
		return { labels: [], notes: [], helps: [] }
	}

	let predicate = describePredicate(expected)
	let spelling = describeType(expected)

	return {
		labels: [],
		notes: [
			`Every value of '${spelling}' has been proven to answer '${predicate}'.`,
		],
		helps: [
			`Check '${predicate}' on the value in an 'if' or a 'match', or pass a value that already has Type '${spelling}'.`,
		],
	}
}

// Arguments are asked exactly what the enricher asked them, literals and
// `refinementDecidedBy` included. A committed Overload that fails to match is
// an internal error here.
function matchableArgumentsFromTypedNodes(
	argumentNodes: Array<common.typed.ArgumentNode>,
): Array<MatchableArgument> {
	return argumentNodes.map((argumentNode) => ({
		name: argumentNode.name,
		mergedValue: () => argumentNode.value,
		spellsItsMembers: argumentNode.value.nodeType === "RecordValue",
		// An Argument carrying a slot nobody decided binds no Type
		// Parameter, so it is matched after every Argument that can decide one —
		// the holding-back a prefixed Case construction gets, for the same reason
		// and one Argument kind over. A blank is bottom to READ and nothing to
		// bind: binding `T` to the `List<Unknown>` an empty `[]` left turned
		// every Argument after it into a write into a blank, and `pair(empty,
		// ["a"], "two")` was refused for the `["a"]` that DECIDES `T` beside the
		// `"two"` that is genuinely wrong. Deferred, the `["a"]` binds `T` and
		// the blank is read against it, which is what the Enricher made of the
		// same call.
		bindsNothing: typeContainsUnknown(argumentNode.type),
		getType: (expectedType) =>
			admittedTypeOf(expectedType, argumentNode.value) ??
			argumentNode.type,
	}))
}

// The Arguments matched against the Signature the Enricher committed to —
// and, where that fails while an Argument still carries an undecided slot,
// matched a SECOND time with the Type Parameters the Enricher decided read back
// off the Type it recorded for the call.
//
// A decision made from the Arguments TOGETHER can not be re-derived from them
// one at a time. `invocationWithDecidedSeeds` fills a Type Parameter bound to an
// undecided slot from the call's expected Type, from the Arguments that were
// only checked against it, or from what a Function literal's body answers — and
// a NAME standing at an Argument position keeps the undecided Type its own
// Declaration wrote, deliberately, because what an empty `[]` bound to a name
// decides is that Declaration's business. Re-deriving the bindings from those
// Nodes alone binds the Parameter to the blank all over again, and every
// Argument that reacted to the decision then fits nothing: the combiner of a
// `loop(startingWith seed, …)` is resolved against `List<Integer>`, and the seed
// it is re-matched beside says `List<Unknown>`.
//
// What the Enricher decided is written down, though — it is substituted into the
// Type of the call itself — so reading the bindings back off that Type asks the
// re-match with the answer the Enricher had. Which is what the re-match is for:
// it CHECKS a commitment, it does not make one again.
//
// Only a GENERIC call carrying an undecided slot pays for the second attempt,
// and only the first attempt's answer is ever reported: nothing a seeded match
// says can hide a mismatch the plain one found. A signature with no Type
// Parameter has nothing to seed, so the blank an Argument carries is measured
// against a written Type and the two attempts would be the same one.
//
// Seeding from the call's own Type is unification, and unification can fail
// halfway — leaving some Parameters seeded and others not. Safe, because a seed
// is never a verdict: a wrong or missing one makes the second attempt FAIL, and
// a failed second attempt is the first attempt's answer.
//
// It is the deferral above that keeps this rare. An Argument carrying a blank
// binds nothing, so the Arguments that decide a Type Parameter bind it first and
// the blank is read against what they decided — which is every call whose blank
// stands beside an Argument of the same Parameter. What is left for the rescue is
// a call whose decision came from somewhere the Arguments can not be asked
// again: a callback's body, or the position the whole call stands in.
function matchCommittedArguments(
	signature: common.BaseFunction,
	argumentNodes: Array<common.typed.ArgumentNode>,
	recordedType: common.Type,
	collectAllMismatches: boolean,
): ArgumentMatchResult {
	let matchableArguments = matchableArgumentsFromTypedNodes(argumentNodes)
	let first = createFreshenedInference(signature)
	let matched = matchArguments(first.parameterTypes, matchableArguments, {
		collectAllMismatches,
		inference: first.context,
	})

	if (
		matched.type === "Match" ||
		signature.generics.length === 0 ||
		!argumentNodes.some((argumentNode) =>
			typeContainsUnknown(argumentNode.type),
		)
	) {
		return matched
	}

	let second = createFreshenedInference(signature)
	let rename: GenericBindings = new Map()

	for (let [fresh, original] of second.freshToOriginal) {
		rename.set(original, { type: "GenericUse", name: fresh })
	}

	matchesTypeWithBindings(
		applyGenericBindings(signature.returnType, rename),
		recordedType,
		second.context,
	)

	let seeded = matchArguments(second.parameterTypes, matchableArguments, {
		collectAllMismatches,
		inference: second.context,
	})

	return seeded.type === "Match" ? seeded : matched
}

// Whether an Argument the Enricher could not type stands where it moves
// the ones around it — which is every POSITIONAL one. A labelled Argument is
// matched by its label before its Type is looked at, so a hole under a label
// leaves every other Argument exactly where it was and the call can still be
// judged on them.
function holesShiftTheCall(
	argumentNodes: Array<common.typed.ArgumentNode>,
): boolean {
	return argumentNodes.some(
		(argumentNode) =>
			argumentNode.name === null &&
			typeContainsError(argumentNode.value.type),
	)
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

// A LABEL is what an Argument is matched by before its Type is looked at
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
			// Both halves, because which of the three edits the mismatch
			// asks for is decided by the PAIR — a label written where none is
			// declared is dropped, one written where another is declared is
			// changed, and one that was never written is inserted. The Help
			// leads with the second half of that and the Quick Fix needs the
			// first as well.
			data: {
				kind: "expected-label",
				label: parameter.name,
				written: argumentNode.name,
			},
		},
	)
}

// A Record Argument written against a Parameter whose default fills some
// of its members in, missing members the default does NOT fill in — and missing
// nothing else. Null where the Argument failed for any other reason: a member
// with the wrong Type, a member the Parameter does not declare, a Parameter
// that is not a Record, or no default at all. Each of those is
// `argument-type-mismatch`, which names the whole Type, and this one names the
// members instead.
//
// And null for an Argument that is not WRITTEN as a Record literal, which
// may not be a partial at all: naming the members it is missing would be advice
// it can not take, since writing them means writing a literal. That refusal is
// `argument-type-mismatch` with `partialSpellingEvidence`'s note.
function missingMembersOf(
	parameter: common.Parameter,
	argumentNode: common.typed.ArgumentNode,
): Array<string> | null {
	let argumentType = argumentRecordType(parameter, argumentNode)

	if (
		parameter.defaultMembers === undefined ||
		parameter.type.type !== "Record" ||
		argumentType.type !== "Record" ||
		argumentNode.value.nodeType !== "RecordValue" ||
		!isPartialOf(parameter.type, argumentType)
	) {
		return null
	}

	let missing = missingRecordMembers(
		parameter.type,
		parameter.defaultMembers,
		argumentType,
	)

	return missing.length === 0 ? null : missing
}

// What the Argument comes to once the default has filled it in — a member
// a path key wrote stands for the whole member the merge rebuilds. The
// Argument's own Type wherever no path key was written, which is every Argument
// but one.
function argumentRecordType(
	parameter: common.Parameter,
	argumentNode: common.typed.ArgumentNode,
): common.Type {
	return (
		mergedRecordType(
			parameter.type,
			parameter.defaultNesting,
			argumentNode.value,
		) ?? argumentNode.value.type
	)
}

function reportIncompleteRecordArgument(
	parameter: common.Parameter,
	name: string,
	missing: Array<string>,
	argumentNode: common.typed.ArgumentNode,
): void {
	let filled = parameter.defaultMembers ?? []

	reportError(
		`This Argument is missing ${countOf(missing.length, "member")} the default does not fill in`,
		argumentNode.value.position,
		{
			code: "incomplete-record-argument",
			labels: [
				primary(
					argumentNode.value.position,
					`${quotedNames(missing)} not written here`,
				),
			],
			notes: [
				`${name} is ${describeType(parameter.type)}.`,
				filled.length === 0
					? "Its default fills in nothing; every member must be written."
					: `Its default fills in ${quotedNames(filled)}; every other member must be written.`,
			],
			helps: [`Write ${quotedNames(missing)} into this Record.`],
			// In the Parameter's declaration order, which is the order
			// the label and the Help name them in — a scaffold that wrote them
			// in any other reads as though the Compiler shuffled the Record.
			data: { kind: "missing-members", names: missing },
		},
	)
}

// "'host', 'retries'" — the spelling every Diagnostic that lists names
// uses, so a reader meets one shape wherever a set of members is named.
function quotedNames(names: ReadonlyArray<string>): string {
	return names.map((name) => `'${name}'`).join(", ")
}

// A path key in a Literal that is merged into a default reaches into a
// member the merge REBUILDS — the callee writes that member out one level down,
// taking each of ITS members from the Argument or from the default. A member the
// merge does not rebuild is one the Argument replaces whole, and a path key into
// one would quietly drop every member it did not write. That is the hole this
// refuses, and it refuses it by name: the Argument does not fit its position
// either way, and `argument-type-mismatch` would name the whole Type under the
// one step that is wrong.
//
// The first refusal is the one reported. A path is walked from its root, and a
// step that reaches nowhere makes every step after it a question about a value
// that is not there.
function reportUnmergedPathKey(
	into: common.Type | common.GenericUse,
	filled: ReadonlyArray<string> | undefined,
	nesting: common.DefaultNesting | undefined,
	value: common.typed.ExpressionNode,
	subject: string,
): boolean {
	if (into.type !== "Record" || value.nodeType !== "RecordValue") {
		return false
	}

	for (let [name, member] of Object.entries(value.members)) {
		if (!isMergedLevel(member)) {
			continue
		}

		let position = value.memberPositions?.[name] ?? member.position

		// A step the position does not declare at all is a member nobody
		// has, which `argument-type-mismatch` and `payload-type-mismatch` name
		// as they name every other one. This is about a member that IS there.
		if (!Object.hasOwn(into.members, name)) {
			continue
		}

		let declaredType = into.members[name]!

		if (declaredType.type !== "Record") {
			reportError("A path key steps through Records only", position, {
				code: "path-step-not-a-record",
				labels: [
					primary(
						position,
						`this is ${withArticle(describeType(declaredType))}`,
					),
				],
				notes: [
					"Every step but the last names the value the step after it reaches into, and only a Record has members to reach.",
				],
				helps: [`Set '${name}' as a whole instead.`],
			})

			return true
		}

		if (!(filled ?? []).includes(name)) {
			reportError(
				"A path key reaches into a member no default fills in",
				position,
				{
					code: "path-key-without-default",
					labels: [primary(position, `nothing fills in '${name}'`)],
					notes: [
						`${subject} is ${describeType(into)}.`,
						(filled ?? []).length === 0
							? "Its default fills in nothing, so every member has to be written out here."
							: `Its default fills in ${quotedNames(filled!)}, and '${name}' is not one of them — so there is nothing under this key to merge with.`,
					],
					helps: [`Write the whole member: '${name} = { … }'.`],
				},
			)

			return true
		}

		if (!Object.hasOwn(nesting ?? {}, name)) {
			reportError(
				"A path key reaches into a member the default does not write out",
				position,
				{
					code: "path-key-without-default",
					labels: [primary(position, `'${name}' is filled in whole`)],
					notes: [
						`The default names a value for '${name}' rather than writing its members out, and a value can not be taken apart without being worked out — so '${name}' is filled in whole or not at all.`,
					],
					helps: [
						`Write the whole member: '${name} = { … }'.`,
						`Or write the default's '${name}' out as a Record Literal, member by member.`,
					],
				},
			)

			return true
		}

		// One level down, where every member of the default's Literal is
		// written out — so a step is refused there for the same reasons and
		// under the same names.
		if (
			reportUnmergedPathKey(
				declaredType,
				Object.keys(declaredType.members),
				nesting?.[name],
				member,
				`'${name}'`,
			)
		) {
			return true
		}
	}

	return false
}

// The same question about a Case's payload, which is merged into its
// payload default exactly as an Argument is merged into a Parameter's.
function reportUnmergedPayloadPathKey(
	payloadType: common.RecordType,
	caseType: common.CaseType,
	value: common.typed.ExpressionNode,
): boolean {
	return reportUnmergedPathKey(
		payloadType,
		caseType.payloadDefault?.members,
		caseType.payloadDefault?.nesting,
		value,
		`Case '#${caseType.name}'`,
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

	if (parameter !== undefined) {
		// Before the missing-member reading and before the Type is named:
		// a path key the default does not reach into is the ONE thing wrong
		// with this Argument, and the whole Type is what every other reading
		// names.
		if (
			reportUnmergedPathKey(
				parameter.type,
				parameter.defaultMembers,
				parameter.defaultNesting,
				argumentNode.value,
				name,
			)
		) {
			return
		}

		let missing = missingMembersOf(parameter, argumentNode)

		if (missing !== null) {
			reportIncompleteRecordArgument(
				parameter,
				name,
				missing,
				argumentNode,
			)

			return
		}
	}

	let evidence = refinementEvidence(parameter?.type, argumentNode.value)
	let spelling = partialSpellingEvidence(parameter, argumentNode)
	// The members a partial default fills in are not missing from this
	// Argument, however little it writes — the merge supplies them. Which is
	// the same list `missingMembersOf` read a moment ago, asked here of the
	// Argument that got PAST that reading and is refused for what it wrote.
	let record =
		parameter === undefined
			? null
			: recordMismatchEvidence(
					parameter.type,
					argumentNode.value.type,
					argumentNode.value,
					{
						filled: parameter.defaultMembers,
						subject: "the Parameter's Type",
					},
				)

	reportError(
		`This Argument does not fit ${name}`,
		record?.lead?.position ?? argumentNode.value.position,
		{
			code: "argument-type-mismatch",
			labels: [
				record?.lead ??
					primary(
						argumentNode.value.position,
						`this is ${withArticle(describeType(argumentNode.value.type))}`,
					),
				...(record?.labels ?? []),
				...evidence.labels,
			],
			notes: [
				...(parameter === undefined
					? []
					: [`${name} is ${describeType(parameter.type)}.`]),
				...(record?.notes ?? []),
				...spelling.notes,
				...evidence.notes,
			],
			helps: [
				...spelling.helps,
				...(parameter === undefined
					? []
					: asynchronyHelps(
							parameter.type,
							argumentNode.value.type,
							bodyCanWait(),
							completionBarrier(),
						)),
				...(record?.helps ?? []),
				...evidence.helps,
			],
			data:
				parameter === undefined
					? undefined
					: (asynchronyData(
							parameter.type,
							argumentNode.value.type,
							bodyCanWait(),
						) ?? record?.data),
		},
	)
}

// An Argument the default's members WOULD have covered, refused only for
// being written as something other than a Record literal. Its Type reads like a
// perfectly good partial, so nothing the Diagnostic says about Types can explain
// the refusal — the rule has to be named.
function partialSpellingEvidence(
	parameter: common.Parameter | undefined,
	argumentNode: common.typed.ArgumentNode,
): { notes: Array<string>; helps: Array<string> } {
	let argumentType =
		parameter === undefined
			? argumentNode.value.type
			: argumentRecordType(parameter, argumentNode)

	if (
		parameter?.defaultMembers === undefined ||
		parameter.type.type !== "Record" ||
		argumentType.type !== "Record" ||
		argumentNode.value.nodeType === "RecordValue" ||
		!isPartialOf(parameter.type, argumentType) ||
		missingRecordMembers(
			parameter.type,
			parameter.defaultMembers,
			argumentType,
		).length !== 0
	) {
		return { notes: [], helps: [] }
	}

	return {
		notes: [
			`Its default fills in ${quotedNames(parameter.defaultMembers)}, which only an Argument WRITTEN as a Record literal may leave out — every other Record carries whatever its value holds, not only what its Type names.`,
		],
		helps: [
			`Write the Record at the call, or pass a value of Type ${describeType(parameter.type)}.`,
		],
	}
}

function validateSimpleFunctionInvocation(
	functionType: common.FunctionType | common.StaticMethodType,
	argumentNodes: Array<common.typed.ArgumentNode>,
	recordedType: common.Type,
	position: common.Position,
) {
	for (let argumentNode of argumentNodes) {
		validateExpression(argumentNode.value)
	}

	let matchResult = matchCommittedArguments(
		functionType,
		argumentNodes,
		recordedType,
		true,
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
				matchResult.parameterForArgument[i],
				argumentNodes[i],
			)
		}
	}
}

// #endregion
