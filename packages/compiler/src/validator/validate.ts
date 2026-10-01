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
		// A dispatch branch's own copy of a contextually typed Argument is
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

	// A dispatched Invocation names no Namespace of its own — each branch
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

// The dispatch branches are the Cases of a Match nobody wrote — the
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
						// The Match clause is gone. A dispatch branch and a
						// Match Case are picked the same way, so a Match written
						// over these two member Types reports the very same
						// conflict one line further down — the reader followed
						// the Help and met it again wearing the Match's wording.
						// A Signature is not a runtime question anywhere, and
						// telling the members apart is the only answer there is.
						helps: [
							"Tell the two member Types apart by something that survives to runtime — a member whose Type is not a Function.",
						],
					},
				)

				return
			}

			if (overlapsAtRuntime(earlierType, laterType)) {
				// Which container's empty value crosses. The dispatch
				// question is `overlapsAtRuntime` and it is asked of every pair,
				// so a pair that crosses through neither container keeps the
				// List's wording it has always had — this only tells the reader
				// about a Dictionary where a Dictionary is what crosses.
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
						// A Match alone narrows nothing here — its Cases are
						// picked by the same erased question the branches were,
						// so the reader who wrote one met this report again in
						// the Match's own wording. What decides an empty
						// container is a GUARD, which is why the Help spells the
						// whole shape: guarded Cases, and a Case of its own for
						// the empty value that reaches none of them.
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

	// The callee is not walked as an Expression of its own — a static call
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

	// An Identifier callee names itself; a Lookup and an Expression that
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
		// Silent where the Enricher already refused this call. It reports the
		// same sentence at the callee's own name, which is the narrower span of the
		// two, and it answers the Invocation with an Error to say so — the ordinary
		// reading of a hole, and the one every other check here makes. Both stages
		// run on every file, so without this a reader met one mistake twice, a line
		// apart, with the Helps on only one of them.
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

	// And a SIGNATURE the Enricher could not establish measures nothing
	// either. A Method in a Namespace with no target Type is refused where it
	// is written and left carrying an Error receiver, so every call of it
	// counted one Parameter more than the reader can see and answered with
	// `argument-count-mismatch` — the Namespace's mistake, reported again as
	// something wrong with a call that is written exactly right.
	if (typeContainsError(functionType)) {
		return node
	}

	// An Argument the Enricher could not type is an Argument that fits
	// nothing, so measuring the call against its Signature answers the hole
	// rather than the call — and a hole in a POSITIONAL Argument moves every
	// Argument after it, so the whole call stands down rather than the position
	// that carries it. The mistake has been reported where the Argument was
	// written.
	//
	// A LABELLED Argument can not move anything: it is matched by its
	// label, so the Arguments around it line up whatever it came to. Where
	// every hole is labelled, the rest of the call is still measured, and the
	// second mistake in `f(first undeclared, second 99)` is reported in the same
	// run as the first.
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
		// Every other callee: a Method with a receiver called through
		// `.`, as `Namespace.method(…)`, and an Overload set, an `overload
		// function` called by its name among them. A `::` call is
		// `validateMethodInvocation`'s.
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
	// The hidden conformance Parameters this Function is emitted with —
	// the Simplifier reads them off these same Generic Declarations, so what a
	// witness inside the body may forward is exactly what is pushed here.
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

	// A body does not run where it is written — it runs when the Function
	// is called, which is at the earliest the statement that calls it — so
	// nothing inside it is a top-level use, however far above a Declaration it
	// stands. A Function literal written INSIDE a static Property's initialiser
	// is such a body too: what it names is read when it is called, by which time
	// every Property of its Namespace is bound.
	let enclosingIndex = executingTopLevelIndex
	let enclosingProperty = initialisingProperty

	executingTopLevelIndex = null
	initialisingProperty = null
	// The declared Type rather than the Parser's `completing` mark, which
	// says only that a `complete` is ALREADY written. A `-> Future<…>` body that
	// has not written its first one is exactly the body a report is most likely
	// to be offering the word to, and it may have it.
	waitingBodies.push(node.returnType.type === "Future" ? true : "plain-body")

	try {
		// A default runs when the Function is CALLED, in the frame the
		// body runs in — so it is held to everything the body is held to, under
		// the same suspended top-level index, and it is checked ahead of the
		// body because that is where it stands. Nothing inside a `= expression`
		// was checked at all while this walked only the body: a call with the
		// wrong Arguments, a Match missing a Case, a name read above its
		// Declaration.
		//
		// Everything but waiting: a default is filled in before any of the
		// body's own asynchrony begins, which is the Enricher's
		// `parameter-default` barrier, so `complete` is refused there however
		// the Function around it is declared.
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

// A native Method has no body, and the frame the Compiler synthesizes for
// its defaults is the only Essence it owns — so it is the only thing here to
// check, and checking it is what keeps a `declarations { … }` Program held to
// what every other Program is held to.
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

// A static Property read out of the initialiser of a Property of the SAME
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

// A name is nothing but a name in every other respect — the one thing it
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

// Whether anything this Match is judged BY is a hole — the value it
// matches, or a Matcher the Enricher could not resolve. Every verdict below is
// a comparison between the two, and a comparison against an Error answers the
// mistake that left it rather than the Cases the reader wrote: a Case naming a
// Choice whose Declaration went missing is not unreachable, it is unresolved,
// and calling it dead would grey out the four Cases beside it too.
//
// The SHAPE is a second way to be judging something that was not written, and
// it is a separate question: a Handler the Parser dropped leaves a Match that
// handles fewer Cases than the file does.
function matchIsJudgeable(node: common.typed.MatchNode): boolean {
	return (
		!typeContainsError(node.value.type) &&
		// The RUNTIME Matcher, which is the Matcher with the Handler's
		// payload requirements grafted onto it — that is the Type every verdict
		// below is computed from, and a requirement naming a member nothing
		// declares leaves its hole there rather than in the Matcher itself.
		// `case #Going({ missing as … })` really can never match, and saying so
		// answers the hole one column over from the report that explains it.
		!node.handlers.some((handler) =>
			typeContainsError(runtimeMatcherOf(handler)),
		) &&
		!partiallyRead(node.position)
	)
}

function validateMatch(node: common.typed.MatchNode): common.typed.MatchNode {
	validateExpression(node.value)

	if (!matchIsJudgeable(node)) {
		// The Handlers' BODIES are still walked — everything below the
		// early return covers them, and a mistake written inside a Handler is
		// its own, whatever the Match around it came to.
		validateMatchHandlers(node)

		return node
	}

	if (node.value.type.type === "UnionType") {
		// Flattened, so that a Union member that is itself a Union — a
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

		// One Diagnostic for the whole Match rather than one per
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
					// The same spellings once more, in declaration
					// order, for the Quick Fix that writes the Handlers out.
					data: { kind: "missing-case", unhandled: descriptions },
				},
			)
		}

		// Which Handler already answers for each member of the Union, by
		// index — a Handler is dead not only when its Matcher names a Type the
		// Union does not have, but also when every Type it could match was
		// already taken by an earlier Handler. A Handler takes one when its
		// emitted TEST accepts every value of it and nothing else of the
		// Handler could still decline — a payload requirement is part of that
		// test, so `case #Apply({ fn: IntFn })` claims exactly as its Record
		// spelling does, while a literal or a Guard declines after the test and
		// leaves the Type for whatever comes after it.
		let claimedBy: Array<number | null> = memberTypes.map(() => null)
		let runtimeMatchers = node.handlers.map(runtimeMatcherOf)

		for (
			let handlerIndex = 0;
			handlerIndex < node.handlers.length;
			handlerIndex++
		) {
			let handler = node.handlers[handlerIndex]
			let runtimeMatcher = runtimeMatchers[handlerIndex]
			// The members SOME value of which can take this Handler's
			// test — overlap, not acceptance, because a test that narrows (a
			// Record member, a payload requirement) still runs for the values
			// that pass it. Acceptance here called such a Handler dead while
			// the runtime took it.
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
				// Tagged `unnecessary` so that clients grey the case out
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
								handler.memberTypes === null
									? `${describeType(handler.matcher)} is not a member of the matched Union`
									: `no value of the matched Union passes ${describeType(runtimeMatcher)}`,
							),
							secondary(
								node.value.position,
								`this is ${withArticle(describeType(node.value.type))}`,
							),
						],
						// Removal is safe here and nowhere else in this
						// function: this Case overlaps NO member, so taking it
						// out changes nothing about what the Match answers for
						// — a Case the exhaustiveness check never counted can
						// not be the one holding exhaustiveness up. The Quick
						// Fix that removes it was already offered and the Help
						// naming it was not.
						//
						// The second clause is for the Matcher that names
						// something the Union does not hold, which is as often a
						// name written from memory as it is a Case nobody needs.
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

			// Every Type this Handler could match is spoken for, and the
			// first Handler that fits is the one that runs — so this one never
			// does, whether it is a duplicated `case Integer` or a Case written
			// below the `case _` that swallows it. Its own Guard or literal
			// makes no difference: the earlier Handler decides first.
			if (claimingHandlerIndices.length === matchedMemberIndices.length) {
				let claimingHandlerIndex = Math.min(...claimingHandlerIndices)
				let claimingHandler = node.handlers[claimingHandlerIndex]
				let claimingMatcher = runtimeMatchers[claimingHandlerIndex]

				// WHY the earlier Case answers for this one decides what
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
				// Reordering is only an answer where the covered Matcher
				// is NARROWER than the one covering it. Two Matchers that ask
				// the same question — a `case #Red` written twice — swallow each
				// other whichever way round they are written, so "write it above"
				// moved the report to the other Case and left the reader circling
				// between two spellings of one duplicate.
				let helps = [
					matchesType(runtimeMatcher, claimingMatcher)
						? "Remove this Case — the Case above answers for every value it would take, in whichever order the two are written."
						: "Remove this Case, or write it above the one that covers it.",
				]
				// The two reasons that are ERASURE rather than dead code.
				// A Case shadowed by a Type that covers it is a Case nobody
				// needed; a Case shadowed by a Type the source says it is
				// unrelated to is a Program answering with the wrong value —
				// `case Value` above `case String` returned the String where
				// the Signature promised a Value, and a Warning let that build.
				let erased = false

				if (claimingHandler.matcher.type === "GenericUse") {
					erased = true

					notes.push(
						`Types erase before a Match runs, so the Generic Case '${describeType(claimingHandler.matcher)}' narrows nothing and accepts every value that reaches it.`,
					)

					// Reordering is an answer only where THIS Case is
					// narrower than the one covering it. Where both Cases name
					// Type Parameters neither is narrower — both accept every
					// value that reaches them — so "write it above" moved the
					// report to the other Case, whose own Help moved it back,
					// and a reader could swap the two arms forever. What is
					// wrong there is the signature rather than the order of the
					// arms, and it is the same thing `undispatchable-method`
					// says about the call this Match was written to replace.
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
					// The earlier test does not accept this one's Type at
					// all, so what it claimed it claimed through erasure.
					// Reordering can not help here: whichever of the two is
					// written first swallows the other. WHICH erasure decides
					// the explanation — a refinement erases to its base, so
					// where the bases alone reconcile the two, that is the
					// whole story; anything else that claims without
					// assignability is a Function's Signature.
					erased = true

					notes.push(
						matchesType(
							eraseRefinements(claimingMatcher),
							eraseRefinements(runtimeMatcher),
						)
							? "A refinement's predicate erases before a Match runs, so a refined Type is only ever checked as its base — which makes these two Matchers ask the same question."
							: "A Function's Signature erases before a Match runs, so a Function-typed member is only ever checked for being callable — which makes these two Matchers ask the same question.",
					)

					// A Guard is no answer here, in either position, and
					// the clause offering one is gone. On THIS Case it changes
					// nothing — the earlier one decides first and never reaches
					// it, which is what the Label already says. On the Case
					// ABOVE it takes that Case's claim away and no Case is left
					// to make it: `missing-case`, whose own answers are a Case
					// for the Type (covered by the other one — this report
					// again) or a `case _` (covered by the other one — this
					// report again). Two Matchers asking one erased question
					// admit no exhaustive Match at all, so the only edit is to
					// make them ask two.
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
					// Tagged `unnecessary` so that clients grey the Case
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
				// The two forms that DO ask about a value with one shape,
				// which is what a reader reaching for `match` here wanted. Named
				// in the order they answer: a question with two answers is an
				// `if`, and one with several is a `define`. An Integer or a
				// String never reaches this — a Match that names a value is a
				// literal Match, and this is what is left.
				helps: [
					"Ask about the value with an 'if', or choose between answers with a 'define'.",
				],
			},
		)
	}

	validateMatchHandlers(node)

	return node
}

// What every Handler is made of, judged whatever the Match around it came
// to. Split out because a Match nothing can be said ABOUT still holds Handlers
// whose bodies are ordinary Statements — the reader's own — and skipping them
// with the exhaustiveness verdict would take a whole branch of the Program out
// of the Validator's reach for want of one resolved Case name.
function validateMatchHandlers(node: common.typed.MatchNode): void {
	for (let handler of node.handlers) {
		// A Guard decides, per value, whether its Handler runs — it is a
		// Condition, and is held to what every other Condition is held to.
		if (handler.guard !== null) {
			validateCondition(handler.guard, "A Case Guard")
		}

		// A Matcher's literals are Expressions of their own — only a
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

		// Synthetic — a Match handler is validated as if it were a
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
}

// Nothing here walks sub-Expressions on its own — every Validator recurs
// by hand — so an arm this does not visit is an arm nothing validates at all.
// Both halves of every arm are Expressions the Program evaluates, and the
// `otherwise` arm's value is one as much as the rest.
function validateDefine(
	node: common.typed.DefineNode,
): common.typed.DefineNode {
	reportCaselessDefine(node)

	for (let arm of node.arms) {
		checkDefineAnswer(node, arm.value)
		validateExpression(arm.value)

		// An arm's Condition picks the path exactly as an `if` does, and
		// is held to what every other Condition is held to: Essence has no
		// truthiness, so only a Boolean may decide.
		validateCondition(arm.condition, "A Define Condition")
	}

	checkDefineAnswer(node, node.otherwise.value)
	validateExpression(node.otherwise.value)

	return node
}

// A `define` whose only arm is the `otherwise` one asks nothing. It is
// the value it answers with, written the long way round, and every reader who
// meets it has to read the braces before they find that out.
//
// A Warning, and never anything more: this is exactly the shape a ladder has
// while it is being written, and an Error here would refuse a file half way
// through the edit that fixes it. Tagged `unnecessary` so that clients grey the
// `define` out rather than underline it — what is wrong with it is that it does
// nothing, not that it is wrong.
//
// The Validator rather than the Parser, because the Node is perfectly
// well-formed: it has the one arm every `define` must have, and this is a
// judgment about what that arm is worth rather than about how it was written.
function reportCaselessDefine(node: common.typed.DefineNode): void {
	// And silent for a `define` the Parser did not read whole — see
	// `partiallyRead`. A ladder whose arms were dropped has no cases HERE and
	// every one of them in the file, which is the syntax error above wearing a
	// Warning's clothes.
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

// Every arm answers where the `define` stands, so every arm is held to
// the `define`'s answer Type. Asked of the Type whatever decided it: where the
// arms decided it themselves it is the Union of exactly these values and each
// of them fits by construction, so one check covers the arrow and the position
// around the `define` without the Node having to say which of them spoke.
//
// Reported at the arm's VALUE, which is the part a reader can change —
// the arrow's Type has no Position of its own, and the position around a
// `define` is a Declaration's annotation somewhere above it. Same reason a `<-`
// is reported where it is, and the same code: an arm is what a `define`
// returns.
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

// A Case that an earlier one takes the EMPTY VALUES of a container from
// without covering it: an empty List fits every List Matcher, so
// `case List<String>` above `case List<Integer>` answers for an empty
// `List<Integer>` and this Case never sees one. Nothing said so before, in
// either direction — the Validator called the two unrelated and the runtime took
// the earlier branch. Only that crossover is reported here: a Matcher that
// narrows a member by Type overlaps the Cases below it too, but the values it
// takes are exactly the ones it names, which is Cases being tried in order and
// nothing to warn about.
//
// The empty DICTIONARY crosses in exactly the same way and is reported in
// exactly the same place, under a Warning of its own — a Dictionary reader is
// told about its two slots and helped with `hasEntries()`, where a List reader
// is told about item Types and helped with `hasItems()`.
//
// One Diagnostic per Handler, on the first earlier Case that overlaps it.
// Members the earlier Case takes ENTIRELY are none of this: those are the
// dead-Case reports above, and this Handler still runs for the rest.
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

// A Match that takes a VALUE apart rather than a Type — `match n { case 0
// { … } case _ { … } }`. There is no Union here to be exhaustive over, so what
// stands in for exhaustiveness is the SHAPE: every Case names a value, and the
// last one answers for every value the Cases above it did not name.
//
// That last Case is also where evidence comes from. Reaching it proves the
// value is none of the values named above, which is the `isNot` a refinement is
// declared by — `refinedSelfType` in the Enricher is what reads it — so the
// shape is a rule about what the Program MEANS rather than a matter of style.
//
// Integer and String, and no other Type. They are the two whose literal
// Matcher asks exactly what their Namespace's `is` asks: `anyIs` compares
// Integers as bigints and Strings NFC-normalised, which is what `Integer.is`
// and `String.is` answer, so a Case that declined really does prove `isNot`.
// A Rational would carry the same argument — it is a refinable base too, and
// `anyIs` cross-multiplies its parts exactly as `Rational.is` does — but
// admitting a third scrutinee is a change to `match` that nobody has weighed.
// A Boolean's two values are an `if` written the long way, and everything else,
// a Rational included, keeps `match-on-non-union`.
//
// A Match on one of the two that names NO value at all is not one of
// these. It asks nothing about the value it was given, which is the one-outcome
// Match `match-on-non-union` has always been about, and it still reports.
function isLiteralMatch(node: common.typed.MatchNode): boolean {
	let scrutinee = eraseRefinements(node.value.type)

	return (
		(scrutinee.type === "Integer" || scrutinee.type === "String") &&
		node.handlers.some((handler) => handler.literal !== null)
	)
}

// One Diagnostic per Case that can not stand where it stands, and one more
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
	let last = node.handlers[lastIndex]
	// Whether the Match ALREADY ends in a Case for the rest, which is what
	// decides the Help below — the same question the final check asks, asked once
	// and read twice so the two can not disagree.
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
					// `'case 0'` was an example of a value, and it is a
					// dead end on a Match over Strings — a Case naming an
					// Integer there is refused two clauses down. And "move it to
					// the end" is only an edit where there is no end yet: a
					// Match that already closes with `case _` has this Case
					// moved BELOW it, which makes the `case _` the one that does
					// not name a value and reports in its place.
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

		// The Case is compared TO the matched value, so a Case naming a
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
					// The Type a value written here has to BE, which the
					// Label has just said this one is not. Removal is the other
					// answer and is always safe: a Case comparing across Types
					// is never true, so the Cases below it already answer for
					// everything it would have.
					helps: [
						`Name ${withArticle(describeType(scrutinee))}, or remove this Case.`,
					],
				},
			)
		}
	}

	// A Match with no Handlers at all is a Parser error, and this runs on a
	// tree the Parser accepted.
	//
	// `endsInACaseForTheRest` is the answer to "unconditional, and
	// accepting every value that can arrive" — `case _`, or a Case naming the
	// matched Type itself, which is the same question spelled out. Both are
	// indistinguishable by the time a Match is typed, and both are total, so
	// both are the end of a Match on values.
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

// WHY the last Handler is not the end of a Match on values — the three ways
// it can fail to answer for everything the Cases above it left, each underlining
// the part of the Handler that decides.
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

// A Handler with a literal Matcher, a value-constrained Record member or
// a Guard covers only part of its Matcher's Type — `case 0` leaves every other
// Integer, and a Guard can decline outright. So only an unconditional Handler
// discharges a member of the Union, and only an unconditional Handler takes a
// Type away from the Handlers below it.
function isUnconditionalHandler(handler: MatchHandler): boolean {
	return (
		handler.literal === null &&
		handler.memberLiterals === null &&
		handler.memberTypes === null &&
		handler.guard === null
	)
}

// Whether the Handler's emitted TEST is its whole question — nothing left
// that could decline a value the test accepted. Payload requirements stay in:
// they are part of the test itself, which `runtimeMatcherOf` folds into the
// Matcher, so a requirement that erases at runtime claims the Cases below it
// exactly as the equivalent Record Matcher does. A literal, a member literal or
// a Guard decides AFTER the test, and takes nothing from anyone.
function claimsWhatItsTestAccepts(handler: MatchHandler): boolean {
	return (
		handler.literal === null &&
		handler.memberLiterals === null &&
		handler.guard === null
	)
}

// The question a Handler's emitted test asks, as ONE Type — the Matcher
// with the payload requirements grafted onto the members their spines reach.
// `case #Apply({ fn: IntFn })` and `case { fn: IntFn }` are two spellings of
// one test, and reachability has to read them as one: a requirement kept
// beside the Matcher was invisible here, and a requirement whose check erases
// (a Function's Signature) claimed nothing while the runtime took everything.
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

	// A grafted Record is built fresh rather than spread over, because a
	// member narrowed by a requirement is a shape no Alias declared: a
	// `Standing` whose `points` a Pattern requires to be a `NonZeroInteger` is
	// not what `Standing` says, and this Type is PRINTED — the reachability
	// report reads it through `describeType`. A Case keeps its own name, which
	// is not a spelling of its members but WHICH Case a value is, and is what
	// the emitted tag asks about.
	return type.type === "Record"
		? { type: "Record", members }
		: { ...type, members }
}

// Whether the check emitted for `matcher` answers TRUE for EVERY value of
// `memberType` — which decides reachability, and is a WIDER question than
// assignability. Some of what a Matcher names does not survive to runtime, and
// what does not survive can not narrow: assignability answers what a Case may
// assume about the values it accepts, this answers which values reach it at all.
//
// Two things erase, and each one is a Case that swallowed everything below
// it with nothing here to say so. A Generic Matcher (and the wildcard's Unknown,
// which is the same answer spelled differently) has no Type left to check, so
// `isValueOfType` returns true unconditionally — `case Value` above `case
// String` left the second Case dead, and the Program answered the String where
// its own Signature promised a `Value`. A Function's Signature is equally gone:
// the emitted check can only ask whether the value is callable, so a Record
// Matcher naming a callback member accepts every Record carrying one, whatever
// that callback's Parameters and Return Type were declared as.
//
// Exported so the agreement between this and the runtime can be tested
// directly — every value this accepts, `isValueOfType` has to accept too, and
// `overlapsAtRuntime` below is the other side of the same sandwich.
export function acceptsAllAtRuntime(
	matcher: common.Type,
	memberType: common.Type,
): boolean {
	// A checked refinement is the third thing that erases, and the most
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

	// A Union is decided member by member, on whichever side it stands:
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

	// Structural and open, exactly as the runtime check is — the value
	// has to carry every member the Matcher names, and may carry more besides.
	if (matcher.type === "Record" && memberType.type === "Record") {
		return membersAcceptAllAtRuntime(matcher.members, memberType.members)
	}

	// The Record check with the tag in front of it, which is what the
	// runtime does for a Case — the tag is shared by every instantiation, so
	// the payload is what tells `Box<Integer>#Full` from `Box<String>#Full`.
	if (matcher.type === "Case" && memberType.type === "Case") {
		return (
			matcher.choice === memberType.choice &&
			matcher.name === memberType.name &&
			membersAcceptAllAtRuntime(matcher.members, memberType.members)
		)
	}

	// A List Matcher is answered by the items the value HOLDS, so it takes
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

	// A Dictionary Matcher is answered by the entries the value HOLDS, as
	// a List Matcher is answered by its items — the tag first, then each slot on
	// its own terms.
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

// Whether the check emitted for `matcher` can answer TRUE for SOME value
// of `memberType`. It differs from `acceptsAllAtRuntime` in exactly one place,
// and that place is the whole reason it exists: an empty List holds no item to
// disagree about, so it is a value of every List Type there is and every List
// Matcher takes it. `case List<String>` above `case List<Integer>` therefore
// runs for an empty `List<Integer>`, which assignability — and so the Validator
// — used to call impossible while the runtime did it.
//
// Conservative everywhere else: an answer of false is a promise that no
// value of `memberType` reaches this Matcher, so anything not known to overlap
// is answered exactly as `acceptsAllAtRuntime` answers it.
export function overlapsAtRuntime(
	matcher: common.Type,
	memberType: common.Type,
): boolean {
	// Unwrapped for the reason its sibling above unwraps.
	if (matcher.type === "Refinement" || memberType.type === "Refinement") {
		return overlapsAtRuntime(
			eraseRefinements(matcher),
			eraseRefinements(memberType),
		)
	}

	if (acceptsAllAtRuntime(matcher, memberType)) {
		return true
	}

	// A member Type that is still a Type Parameter is NOT counted as an
	// overlap, though its Argument could be anything: every Match over a
	// `Value | String` would report one, and a Type Parameter's values are
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

	// The empty List, whatever the two item Types are.
	if (isRuntimeList(matcher) && isRuntimeList(memberType)) {
		return true
	}

	// And the empty Dictionary, which holds no entry to disagree about
	// either of its slots over.
	if (isRuntimeDictionary(matcher) && isRuntimeDictionary(memberType)) {
		return true
	}

	return false
}

// Whether the values that cross from `memberType` into `matcher` are the
// EMPTY ones of a container — a Matcher somewhere in the overlap whose own slots
// do not take the member's. That crossover is the one `overlapsAtRuntime` exists
// to see, and the one worth a warning: every other partial overlap is a Matcher
// taking exactly the values it names, in order, as Matchers do.
//
// The empty DICTIONARY crosses in exactly the same way, and is asked about
// under its own `kind` rather than folded into the List's answer. The two
// Warnings are not one Warning — a List reader is told about item Types and
// helped with `hasItems()`, and a Dictionary reader about its two slots and
// `hasEntries()` — so what is shared is the WALK and not the text. One walk,
// two leaves, and no way for the pair to drift apart.
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

// Which container's empty value crosses, or null where nothing does. A
// List is asked about FIRST, so a Program that crosses through both — a Record
// holding one of each — reports the List's Warning it has always reported.
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
	// `Object.hasOwn` before the read — a member named after one of
	// `Object.prototype`'s would otherwise be checked against a JavaScript
	// function the value does not carry.
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

// The two Types the runtime answers its List check for — a `List<X>` and
// the bare `List` a Generic List annotation resolves to, which names no item
// Type of its own.
function isRuntimeList(type: common.Type): boolean {
	return type.type === "List" || type.type === "GenericList"
}

function runtimeItemType(type: common.Type): common.Type {
	return type.type === "List" ? type.itemType : { type: "Unknown" }
}

// The same pair for the Dictionary, whose bare spelling names neither of
// its slots — so both read as Unknown, which is what the checks above ask for
// when they mean "this says nothing about that half".
function isRuntimeDictionary(type: common.Type): boolean {
	return type.type === "Dictionary" || type.type === "GenericDictionary"
}

function runtimeKeyType(type: common.Type): common.Type {
	return type.type === "Dictionary" ? type.keyType : { type: "Unknown" }
}

function runtimeValueType(type: common.Type): common.Type {
	return type.type === "Dictionary" ? type.valueType : { type: "Unknown" }
}

// One slot of a Dictionary, asked exactly as `acceptsAllAtRuntime` asks a
// List's items — the Matcher naming nothing there takes every value, and a
// member whose own slot is undecided could hold anything, so it is not all of
// anything. The two slots are asked SEPARATELY and both have to answer, which is
// what keeps `Dictionary<String, Unknown>` from passing for `Dictionary<String,
// Integer>` on the strength of its keys.
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

// Whether the payload is present and matches is checked here rather
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

	// A payload judged against a Case whose own members the Enricher could
	// not establish — or a payload VALUE it could not — is judged against a hole,
	// and every answer that comes back names Types the reader never wrote. The
	// two shape checks above it stand down with it: which of them applies is
	// decided by the very members that are missing.
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
				// A bare `#Case` is a UNIT Case's spelling and stays one,
				// however much of a payload is defaulted — which is what keeps
				// a bare Case name meaning exactly one thing on both sides of
				// the JavaScript boundary. So a fully defaulted Case has an
				// empty payload to write, and this is where to say so.
				//
				// Every other one gets the SHAPE, spelled with the member
				// names the Note has just named the Types of — the two halves of
				// one answer, and a reader holding both writes the payload
				// without looking the Case up. The values are the reader's, so
				// they stand as the `…` this says it is.
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
		// Reported already — a path key the payload's default does not
		// reach into is what made the payload not fit, and naming the whole Type
		// under it would name everything but the mistake.
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
		// A generic Choice applied to a blank carries one: a `step` body
		// over a seed nothing decided constructs `#Continue` out of a
		// `{ state: List<Unknown> }`, and what refuses the payload is the blank
		// rather than anything the payload holds.
		let undecided = undecidedSlotEvidence(
			payloadType,
			casePayloadType(node.type, node.value),
			null,
		)
		// A payload shape is a Record nobody declared under a name, so
		// the sentences call it what the rest of this report calls it — the
		// Case whose payload it is.
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
					// A single-member Case would have accepted the value
					// through the shorthand, so the hint only helps where it can
					// not: a multi-member Case needs the whole Record spelled out.
					// And only where the payload was not ALREADY written
					// as that Record. `#Rectangle({ width = "wide", height = 2 })`
					// spells every member the Case declares and got one value
					// wrong; telling its author that the shorthand does not apply
					// answers a question nobody asked. The guard counted members
					// and looked at nothing else, so the sentence came out for
					// every multi-member mismatch there is.
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

// Whether the payload names the Case's own members — which is what tells a
// payload that tried the one-member shorthand from one that wrote the Record out
// and got a value wrong. Names only: the Types are exactly what disagreed, and a
// payload that spells `width` and `height` at a Case declaring `width` and
// `height` is a payload nobody took a shortcut with.
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

// A payload written as a Record Literal for a Case that defaults its
// payload is measured as a PARTIAL — every member it writes is one the payload
// declares, carrying a value that member's Type admits — and what is left is
// only ever the question of which members it should have written. A payload that
// is not a Literal carries whatever its value holds, which width subtyping lets
// be more than its Type names, so it is held to the payload whole: the same
// split, for the same reason, that a Record Argument is held to.
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

// What the payload comes to once the default has filled it in — the Type
// a path key's member stands for, rather than the partial it wrote. The
// payload's own Type wherever no path key was written, which is every payload
// but one.
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
			// As for an Argument — a payload is a Record Literal measured
			// against a default, and the same scaffold answers both.
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

// A member is an Expression like any other — a Match, an Invocation, a
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

// Both halves of every entry, on the same terms a List's items are held
// to: a value whose Type carries hidden conformance Parameters can not be
// stored, because storing it is what makes it travel away from the call that
// filled them.
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

// Each hole is an Expression of its own — `"total: {price::add(tax)}"`
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

// Both sides are Expressions of their own — `{ makeBase(1) with x =
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

// The two assertions are NOT among these — nothing about them depends on
// the Function they stand in, so `validateImplementationNode` answers for them
// before they get here. Excluding them from the parameter Type rather than
// leaving unreachable cases in the switch is what keeps that routing a fact
// TypeScript checks.
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

// A Declaration's Type Annotation carries no Position of its own, so
// the Type it demands is stated as a note rather than pointed at. The value
// is what gets the arrow — it is the part that can be changed.
// `name` is null for the Constant a Pattern Declaration holds its value
// in. That Constant is real and its annotation is the author's, but its NAME is
// the Compiler's — unspellable on purpose — so the report names the Pattern
// instead of a `$pattern_2_11` no reader has ever seen.
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
		// The one mismatch a reader can meet whose EXPECTED side is the
		// Enricher's own answer rather than something written down. Every other
		// Type a value is judged against is an annotation, and `Unknown` is
		// unspellable — so `List<Unknown>` can only stand here, where the
		// Variable was declared from an empty Literal and no assignment has
		// decided it yet. Naming a blank explains nothing on its own; these two
		// sentences are what make the refusal answerable. `partial-type-mismatch`
		// says the same about a member, one level in.
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
					// Null for a builtin, which was declared in
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

// A Method whose every returning path hands back a direct call to
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
	// Null for a non-overloaded Method, matching the `null`
	// `overloadedMethodIndex` its call sites carry; an Overload carries its
	// index in the Method Type, so a call to a *sibling* Overload (a different
	// index) is not self-recursion and is left alone.
	overloadIndex: number | null
}

// The returns reachable at the body's own control-flow level — through
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
	position: common.Position,
	identity: MethodIdentity,
): void {
	let returns = collectTopLevelReturns(definition.body)

	// No return of its own — a native Method, or one that answers only
	// from inside a `match` — says nothing here.
	//
	// And neither does a Method the Parser did not read whole — see
	// `partiallyRead`. "Every returning path" is a claim about the paths that
	// were WRITTEN, and the base case may well be the Statement that was
	// dropped; `position` is the Method's own span, because a path that went
	// missing leaves no Node behind to ask about.
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

// A Choice declaration is Types, with one Expression in it: the `= { … }`
// a payload shape may carry. It is held to what every other Expression is held
// to — an Argument that does not fit, a bound Method handed on as a value —
// which is what keeps a default from being the one place those go unchecked.
function validateChoiceDeclarationStatement(
	node: common.typed.ChoiceDeclarationStatementNode,
): common.typed.ChoiceDeclarationStatementNode {
	for (let defaultValue of caseDefaults(node.cases)) {
		validateExpression(defaultValue)
		validateNoBoundFunctionValue(defaultValue)
	}

	return node
}

// A Protocol's requirements are signatures and carry nothing to check.
// Its PROVIDED Methods are bodies, held to what a Namespace's Methods are held
// to — every returning path fits the declared return Type, and a Method whose
// every path calls itself is the same mistake wherever it is written.
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
	// A static Property's initialiser is an Expression that runs when the
	// Program loads, so it is held to what a Constant Declaration is held to —
	// it is the same Declaration, written in a Namespace. A native Property has
	// no value to check and is not in the typed tree at all.
	//
	// The Properties are walked in the order they are written, which is
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

// Whether a run that could have opened a body was abandoned in the window
// a `<-` on `line` could have been orphaned from: below everything the Parser
// read at the top level, and at or above the `<-` itself. Both ends matter — a
// head dropped BELOW the `<-` orphans nothing above it, and a head dropped above
// a top-level Statement the Parser read whole left that Statement standing at
// the top level, so the `<-` under it is at the top level too.
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
		// Silent where a dropped HEAD above this `<-` could have taken
		// the body it belongs in down with it — see `aHeadWasAbandonedAbove`.
		// A `<-` stands outside a Function only because the head that opened
		// one is missing, and the head is dropped a LINE ABOVE the `<-` it
		// orphans, so asking about the Statement's own span answers no.
		//
		// And silent where the `<-` itself stands on a line the Parser
		// did not read whole, which is the question every other check here
		// asks. That is the OTHER way a `<-` ends up at the top level: a
		// Function literal written `(n) { <- … }` with its `{` dropped leaves
		// the Return where the Statement around it was, and the run that was
		// abandoned opens with whatever that Statement opens with.
		//
		// It used to be silent wherever the Parser abandoned ANYTHING,
		// which stood the check down for the whole file: a `constant limit 10`
		// dropped two lines above a `<- 42` the reader really did write at the
		// top level took the report with it, though a dropped Constant can not
		// leave a body without a head. One mistake was hiding a second.
		if (
			!partiallyRead(node.position) &&
			!aHeadWasAbandonedAbove(node.position.start.line)
		) {
			reportError("There is nothing here to return from", node.position, {
				code: "top-level-return",
				labels: [
					primary(node.position, "this is outside any Function"),
				],
				// Both ends, because which one is meant is the reader's
				// to say: a `<-` written at the top level is either a value the
				// Program wanted to keep — a Declaration — or a body that lost
				// its head.
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
		// A completing body is written as though it answered the VALUE —
		// the future is what the emission wraps around it — so what a `<-` is
		// held to is the inner Type of the declared `Future<T>`. Everything
		// below reads that same Type, so the message names what the reader has
		// to write rather than the future they never spell in a `<-`.
		let expected = returnedTypeOf(
			currentFunctionContext.returnType,
			currentFunctionContext.completing === true,
		)
		let evidence = refinementEvidence(expected, node.expression)
		// A Function literal's return Type is inferred rather than
		// written, so this is the second place a blank can be the EXPECTED
		// side of a refusal: a combiner whose accumulator nothing decided
		// returns `List<Unknown>`, and every `<-` writing into it is refused
		// against a Type the reader can not act on or even spell.
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
			// The member that was refused, where the value is a written
			// Record Literal and one member is what refused it — an Editor
			// underlines the `points = "0"` rather than the two hundred
			// characters around it. The whole value where there is no such
			// member to name.
			record.lead?.position ?? node.expression.position,
			{
				code: "return-type-mismatch",
				// The declared return Type has no Position of its own —
				// only the Parameter list does, which is where an omitted
				// `-> Type` would have gone — so it is stated as a note
				// rather than pointed at.
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
				// The word is offered here even in a body that can not
				// yet wait, unlike every other position. `<- Async.deferred(…)`
				// in a `-> Integer` body is a body that has not decided to be
				// asynchronous at all, and writing the word is the first of
				// three steps that converge — `complete-outside-future` next,
				// then `unused-future`, then a clean Program. That chain is
				// tested; the other positions have no such chain, and offering
				// the word there simply ended in a refusal.
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

// One check for every way a Namespace can be named — a Method's home, a
// dispatch branch's target, a static member's base, a bare reference, a
// conformance witness a call curries in — because what makes them wrong is the
// same thing: the Declaration is BELOW the statement that runs the use.
// `useLabel` is what the arrow at the use says.
//
// Silent for a Namespace that is not top-level (nothing records where a
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

// The `require` line that takes THIS value apart, or null where there is
// nothing to take apart. The first Case of the Choice or Union, because any of
// them is a shape the line could ask for and the first is the one a reader
// reads first; a payload is bound only where the Case declares members, since
// `#Empty(item)` is refused. The value is NAMED where a name is what was
// written — the one spelling a reader reads straight back — and written as a
// schematic otherwise, because this stage holds Nodes rather than the text they
// were read from.
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

// `expect EXPR` asks the same question an `if` does — is this true — and
// is refused for the same reason where the answer is not a Boolean: Essence has
// no truthiness, so there is nothing for an assertion over a Standing to mean.
//
// `require MATCHER = EXPR` asks a different question and is not checked here:
// what a Matcher may be written against was settled where it was resolved,
// exactly as a Match Handler's is.
function validateAssertion(
	node: common.typed.ExpectStatementNode | common.typed.RequireStatementNode,
): common.typed.ImplementationNode {
	// A snapshot asserts nothing of its own — what it compares is the
	// value RENDERED, which the Enricher already demanded be Printable.
	if (
		node.matcher === null &&
		node.snapshot === null &&
		node.value.type.type !== "Boolean" &&
		node.value.type.type !== "Error"
	) {
		// Taking a value apart is an answer only where it HAS parts. An
		// Integer has no Cases, and the Help sent a reader to
		// `require #Value(item) = value` — which answers `unknown-case` about
		// `#Value` and `unknown-name` about `item`, two reports for a line the
		// Help itself wrote. So it is offered only for a Choice or a Union, and
		// spelled with a Case the value really holds, binding a payload only
		// where that Case carries one.
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

// An `if`, an `else if` and a Match Handler's Guard all pick a path from
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
			helps: [booleanQuestionHelp(condition.type)],
		})
	}

	validateExpression(condition)
}

// The Help a Condition that is not a Boolean gets. `booleanQuestionFor`
// lives beside the other Diagnostic vocabulary, because the refinement clause in
// the Enricher asks the same question of the same Types.
function booleanQuestionHelp(type: common.Type): string {
	return `Ask a question that answers a Boolean — '::${booleanQuestionFor(type)}' reads ${withArticle(describeType(type))}.`
}

function validateDefiniteReturn(
	definition: common.typed.FunctionDefinitionNode,
	position: common.Position,
): void {
	// The inner Type for a completing body, for the reason a `<-` is held
	// to it: `-> Future<{}>` is a body that answers nothing, and asking it for a
	// `<-` would refuse every `complete Async.sleep(…)` written on its own line.
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

	// A body the Parser did not read whole is a body whose `<-` may be
	// exactly what went missing — see `partiallyRead`. Falling off the end is a
	// claim about every path through what was WRITTEN, and this is not that.
	if (partiallyRead(position)) {
		return
	}

	if (!bodyDefinitelyReturns(definition.body)) {
		reportError("Not every path through this Function returns", position, {
			code: "missing-return",
			labels: [primary(position, "this path falls off the end")],
			// A completing body is not described as DECLARING the Type its
			// `<-` answers with, because it does not: the signature says
			// `Future<Integer>` and the body answers `Integer`, and a note about
			// the declaration would name a Type the reader can not find in it.
			notes: [
				definition.completing === true
					? `This body waits, so its '<-' answers with ${describeType(returnType)}; every path must yield one.`
					: `The declared return Type is ${describeType(returnType)}, so every path must yield one.`,
			],
			// A path that falls off the end is answered either by giving
			// it a value or by giving the branching an `else`, and the two are
			// different Programs — an `if` with no `else` returns from one path
			// and walks out of the other, and which of those the reader meant is
			// theirs to say. Both are named; neither is spelled with a value,
			// because what to answer with is the judgement this can not make.
			helps: [
				`Write a '<-' answering ${withArticle(describeType(returnType))} at the end of the body.`,
				"Or give every branch one — an 'if' with no 'else' leaves the path around it falling through.",
			],
		})
	}
}

// Whether a value fits where it was written — assignability, plus the one
// thing assignability alone can not see. A refinement demands evidence, and a
// value written DOWN carries its own: its predicate is decided while compiling,
// so `constant d: NonZeroInteger = 3` needs no branch in front of it while `= 0`
// is still refused. The Enricher admits the same literals as it matches
// Arguments, and this is that question asked again over the finished tree, at
// every position the Enricher does not resolve one against the other.
// A hole on either side is answered as a FIT, which is the whole of how
// this Validator stays quiet about mistakes it has already been told about. The
// Enricher writes an Error wherever it could not establish a Type and reports
// why, once, where the reading failed; a value of that Type then fits nothing,
// and every position it travels to would refuse it again in words about Types
// the reader never wrote. One hole, one Diagnostic.
//
// Asked here rather than at the six positions that call this, because they all
// want the same answer: a Constant's annotation, a Variable's, a Property's, an
// assignment, a `<-` and a `define` arm each measure a written value against a
// written Type, and none of them has anything to say when one of the two is a
// hole.
//
// The two sides are asked DIFFERENT questions, and the difference is what
// keeps this from swallowing mismatches that are real. An Error anywhere in the
// EXPECTED Type means the annotation did not resolve, so there is nothing left
// to hold the value to. On the VALUE's side only a Type that IS an Error
// counts: an Error buried inside one is a slot nothing bound, which
// `Result::flatten` leaves behind on a Program the Enricher had no complaint
// about — the value is a Union of Results either way, and a `String` annotation
// over it is a mismatch the Error has no part in.
function fitsExpectedType(
	expected: common.Type,
	value: common.typed.ExpressionNode,
): boolean {
	if (typeContainsError(expected) || value.type.type === "Error") {
		return true
	}

	return fitsWritten(expected, value)
}

// What a mismatch against a refinement has to say beyond naming the two
// Types. A base value arriving where evidence is demanded is not a spelling
// mistake — the value may well satisfy the predicate, and nothing has asked —
// so the Diagnostic names the question that went unanswered and the two places
// an answer comes from. Empty for every other Type, which is what lets the sites
// below spread it without asking first.
//
// Named as it was APPLIED, because a generic refined Alias' bare name is not
// a Type anything can be written as — a help offering to pass a value of
// 'NonEmptyList' names something the Program would refuse for taking no Arguments. A
// refinement carrying none spells as its name alone, which is every non-generic
// one.
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

// An Argument is asked the same question the Enricher asked it, and for a
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
