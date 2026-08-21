import type { common } from "@essence-lang/interfaces"

import { testIdentityKey } from "../enricher/tests"
import {
	bodyDefinitelyReturns,
	conformanceParameterName,
	isMergedLevel,
	openArgumentHoles,
	recordDefaultMembers,
	recordDefaultNesting,
	resolveOverloadedMethodName,
} from "../helpers/index"
import { valueCommentLines } from "../valueComments"

// NOTE: What the Simplifier needs to know beyond the Program, which today is
// one thing and only for a test compile: the Module's own text. The span table
// a test lowering emits carries the SOURCE of every instrumented point, so that
// a reader of an event — a `--json` consumer, an editor showing a value beside
// a line — can say what was recorded without going back to the file. Slicing it
// here rather than once per reader is what keeps the readers from disagreeing
// about what was recorded.
export type SimplifyOptions = {
	source?: string
}

export const simplify = (
	program: common.typed.Program,
	options: SimplifyOptions = {},
): common.typedSimple.Program => {
	return {
		nodeType: "Program",
		imports: simplifyImportSection(program.imports),
		implementation: simplifyImplementationSection(program.implementation),
		tests:
			program.tests === null
				? null
				: simplifyTestsSection(program.tests, options),
		// NOTE: Always null here. Coverage is not a lowering of anything the
		// source wrote: it is instrumentation an Optimiser pass adds when the
		// caller asked to be told what ran, and `instrument-coverage` is the
		// one thing that fills this.
		coverage: null,
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
		// NOTE: An assertion can only be written in a test body, and a test
		// body only reaches here through a `tests` section, which no build
		// carries — so nothing an `essence build` emits comes through this
		// case.
		case "ExpectStatement":
		case "RequireStatement":
			return simplifyAssertion(node)
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
		value:
			node.value === null
				? null
				: fillCasePayloadDefault(
						simplifyExpression(node.value),
						node.value,
						node.type,
						node.position,
					),
		type: node.type,
		position: node.position,
	}
}

// NOTE: The members a payload left out, written into the Record the
// construction builds. Unlike a Parameter's default there is no callee to fill
// them in at — a Case is built where it is written — so the merge is spliced per
// site, and it allocates exactly the Record the author would have written out.
//
// A payload that is not a Record Literal is complete by rule (see
// `casePayloadIsPartial`), so this only ever meets one that is.
//
// NOTE: The values are COPIED per site. One default Node standing in several
// constructions — in several Modules, even — is one object several Optimiser
// passes would rewrite in place, and the copy is what keeps each site's Record
// its own. It carries the construction's Position while it is at it: the value
// appears where the Case is built, which is where a step and a source map should
// stop, and the declaration it was written at may be in another file entirely.
function fillCasePayloadDefault(
	value: common.typedSimple.ExpressionNode,
	written: common.typed.ExpressionNode,
	caseType: common.Type,
	position: common.Position,
): common.typedSimple.ExpressionNode {
	if (caseType.type !== "Case" || value.nodeType !== "RecordValue") {
		return value
	}

	let values = caseType.payloadDefault?.values

	if (values === undefined || values === null) {
		return value
	}

	return filledPayloadLevel(
		value,
		written,
		values,
		{ type: "Record", members: caseType.members },
		position,
	)
}

// NOTE: One level of the payload. A member a PATH KEY wrote is a level of its
// own — `#Get({ limits.calls = 2 })` writes only `calls` — and the default's
// Literal for that member fills the rest of it in, exactly as this level's
// default fills in this level. A member written WHOLE is complete by rule and
// is left alone, which is what keeps `limits = { … }` a replacement.
function filledPayloadLevel(
	value: common.typedSimple.RecordValueNode,
	written: common.typed.ExpressionNode,
	values: Record<string, common.typed.ExpressionNode>,
	type: common.RecordType,
	position: common.Position,
): common.typedSimple.RecordValueNode {
	let members = { ...value.members }
	let filled = false

	if (written.nodeType === "RecordValue") {
		for (let [name, member] of Object.entries(written.members)) {
			let inner = values[name]
			let innerType = type.members[name]
			let simplified = members[name]

			if (
				!isMergedLevel(member) ||
				inner === undefined ||
				inner.nodeType !== "RecordValue" ||
				innerType === undefined ||
				innerType.type !== "Record" ||
				simplified === undefined ||
				simplified.nodeType !== "RecordValue"
			) {
				continue
			}

			members[name] = filledPayloadLevel(
				simplified,
				member,
				inner.members,
				innerType,
				position,
			)
			filled = true
		}
	}

	for (let [name, member] of Object.entries(values)) {
		if (!Object.hasOwn(members, name)) {
			members[name] = writtenAt(simplifyExpression(member), position)
			filled = true
		}
	}

	return filled ? { ...value, members, type } : value
}

// NOTE: A deep copy of a simplified Expression with one Position stamped
// throughout. `type` is stepped over rather than walked — a Type holds no
// Positions and is shared by reference everywhere else too — and nothing else in
// a payload default is anything but a literal, so the walk is over a value the
// author wrote by hand.
function writtenAt<Node>(node: Node, position: common.Position): Node {
	if (Array.isArray(node)) {
		return node.map((entry) => writtenAt(entry, position)) as Node
	}

	if (node === null || typeof node !== "object") {
		return node
	}

	let copy: Record<string, unknown> = {}

	for (let [key, entry] of Object.entries(node)) {
		copy[key] =
			key === "position"
				? position
				: key === "type"
					? entry
					: writtenAt(entry, position)
	}

	return copy as Node
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
		// NOTE: Read off the resolved Namespace, which is the Protocol's pseudo
		// Namespace for a provided Method and carries the Protocol's name. The
		// Rewriter needs it because the Namespace NAME does not say whether a
		// Protocol or a Namespace answered.
		providedBy: node.namespace.type.providedBy,
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
			providedBy: dispatchCase.providedBy,
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
		...(conformance.source.providedMethods === undefined
			? {}
			: { providedMethods: conformance.source.providedMethods }),
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
		// NOTE: Carried for the same reason a Method Invocation carries it: the
		// member name alone can not say whether the Namespace declares it or a
		// Protocol provided it.
		...(node.providedBy === undefined
			? {}
			: { providedBy: node.providedBy }),
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

// NOTE: The two assertions are NOT among these — an `expect` is no Statement
// once it is lowered, it is what it asserted — so `simplifyImplementationNode`
// answers for them before they get here. Excluding them from the parameter Type
// rather than leaving unreachable cases in the switch is what keeps that
// routing a fact TypeScript checks.
function simplifyStatement(
	node: Exclude<
		common.typed.StatementNode,
		common.typed.ExpectStatementNode | common.typed.RequireStatementNode
	>,
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
		// NOTE: A Matcher's subject is INSTRUMENTED, the whole of it — every
		// sub-expression that computes and the value itself. It is what
		// `require MATCHER = EXPR` has to explain a failure out of: the
		// assertion behind this
		// Statement drains what was recorded here, so a report says what
		// `rows()::firstItem()` answered rather than only that an expect
		// failed. Every other synthesized Constant is glue nobody is shown.
		value:
			node.synthesized === "subject"
				? instrumentAssertion(
						simplifyExpression(node.value),
						null,
						true,
					).value
				: simplifyExpression(node.value),
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
		// NOTE: The frame a native's default is evaluated in is a Function like
		// any other, so a Record default is merged in it the same way — and the
		// native still receives a whole Record, which is the whole point of the
		// shim. `_self` is unshifted above, so the Parameter list this is built
		// against is the one the shim emits.
		prologue: recordDefaultPrologue(
			shim.isStatic
				? shim.parameters
				: [receiverPlaceholder(targetType), ...shim.parameters],
			parameters,
		),
	}
}

// NOTE: The typed counterpart of the `_self` Parameter unshifted above — the
// prologue reads a Parameter's Type and its default off the TYPED list and its
// emitted name off the simplified one, so the two lists have to line up. A
// receiver carries no default and so contributes nothing.
function receiverPlaceholder(
	targetType: common.Type,
): common.typed.ParameterNode {
	return {
		nodeType: "Parameter",
		externalName: null,
		internalName: null,
		position: {
			start: { line: 0, column: 0 },
			end: { line: 0, column: 0 },
		},
		type: targetType,
		inferredType: null,
		defaultValue: null,
	}
}

// NOTE: A Protocol's REQUIREMENTS are a contract only — they are erased here
// and emit no JavaScript, and the conformance values passed at call sites are
// their whole runtime footprint. Its PROVIDED Methods are bodies, and go
// through the very `simplifyMethods` a Namespace's do: `_self` unshifted onto
// each, and the hidden `Self__conformance` Parameter appended by the bounded
// Generic rail, because `Self` is a bounded Type Parameter of every one of them.
function simplifyProtocolDeclarationStatement(
	node: common.typed.ProtocolDeclarationStatementNode,
): common.typedSimple.ProtocolDeclarationStatementNode {
	return {
		nodeType: "ProtocolDeclarationStatement",
		name: simplifyIdentifier(node.name),
		// NOTE: `_self` is typed as the bounded `Self` — the receiver of a
		// provided Method is not one Type but whichever conformer called it.
		methods: simplifyMethods(node.methods, {
			type: "GenericUse",
			name: "Self",
			constraint: node.name.content,
		}),
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
			narrows: node.narrows,
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
		// NOTE: Carried through untouched — what a branch established was
		// decided by the Enricher, and the evidence it decided from does not
		// survive simplification.
		narrows: convertedNode.narrows,
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
		//
		// NOTE: A RECORD default is the one that model can not name. A
		// JavaScript default fires only where the Argument came in `undefined`,
		// and what a Record default has to do is fill in the MEMBERS a caller
		// left out of an Argument it did write. So it carries no JavaScript
		// default at all and is rebuilt by the prologue `recordDefaultPrologue`
		// puts at the head of the body.
		defaultValue:
			node.defaultValue === null || hasRecordDefault(node)
				? null
				: simplifyExpression(node.defaultValue),
	}
}

// NOTE: A Parameter whose Argument is merged into its default at the callee's
// entry rather than replaced by it. Asked of the Parameter's TYPE and not of
// what the default supplies: a COMPLETE Record default is merged too, because
// the Argument a caller writes against one may itself be partial, and because
// the merge is also what projects a whole Argument to the members the Type
// declares — the same soundness Step 0 buys a `with`, at the one other place a
// value of one Record Type is built out of another.
function hasRecordDefault(node: common.typed.ParameterNode): boolean {
	return node.defaultValue !== null && node.type.type === "Record"
}

// NOTE: The Statements a body opens with, one Parameter at a time:
//
//   options = Record.createRecord({
//     host: options.host,
//     retries: options.retries ?? 3,
//   })
//
// The Record is built fresh rather than merged into the Argument, which is what
// makes the whole thing sound in the other direction too: a caller reaching this
// Function through a VALUE dropped its defaults and wrote a whole Record, and
// width subtyping means that Record may carry members of its own. Reading the
// members the TYPE declares takes exactly what was promised and nothing else.
//
// NOTE: One allocation per call — the very allocation a caller writing the whole
// Record would have made — so there is nothing here for the Optimiser to skip.
// `collapse-construction` turns the `RecordValue` into a `direct-record` like
// any other.
//
// NOTE: A default written as a LITERAL is taken apart, so each member's
// expression is evaluated only where the caller left THAT member out. Any other
// expression is hoisted into one `const` and read per member, which evaluates it
// once per call, unconditionally — there is no way to take an expression apart
// without evaluating it.
function recordDefaultPrologue(
	parameters: Array<common.typed.ParameterNode>,
	simplified: Array<common.typedSimple.ParameterNode>,
): Array<common.typedSimple.ImplementationNode> {
	if (!parameters.some(hasRecordDefault)) {
		return []
	}

	let prologue: Array<common.typedSimple.ImplementationNode> = []

	for (let [index, parameter] of parameters.entries()) {
		if (!hasRecordDefault(parameter)) {
			continue
		}

		let recordType = parameter.type as common.RecordType
		let defaultValue = parameter.defaultValue!
		let position = parameter.position
		let argument = (): common.typedSimple.IdentifierNode => ({
			nodeType: "Identifier",
			name: simplified[index]!.internalName.name,
			type: recordType,
		})
		// NOTE: The Argument's own value for a member the default does not
		// supply — a plain read, because the Argument is then required and
		// every member of it is written.
		//
		// Only ever asked at the TOP level, since a level the merge reaches
		// into is one the default writes out in full and every member of one is
		// therefore supplied. Written over a path all the same, so that a level
		// which somehow is not still reads the member it means rather than one
		// of the Argument's own.
		let read = (path: Array<string>): common.typedSimple.ExpressionNode => {
			let type: common.Type = recordType
			let node: common.typedSimple.ExpressionNode = argument()

			for (let member of path) {
				let memberType: common.Type = (type as common.RecordType)
					.members[member]!

				node = {
					nodeType: "Lookup",
					base: node,
					member: {
						nodeType: "Identifier",
						name: member,
						type: memberType,
					},
					type: memberType,
				}
				type = memberType
			}

			return node
		}

		// NOTE: `recordDefaultMembers` and nothing local, because this has to be
		// the very set the Parameter's TYPE carries as `defaultMembers` — what a
		// call may leave out and what the prologue fills in are one answer, and
		// two spellings of it would be two answers waiting to disagree. The same
		// goes for the members it reaches INTO, which the Parameter's Type
		// carries as `defaultNesting` and a path key in an Argument is admitted
		// by.
		let supplied = new Set(
			recordDefaultMembers(recordType, defaultValue) ?? [],
		)
		let nesting = recordDefaultNesting(recordType, defaultValue) ?? {}
		let fallbackFor: (
			path: Array<string>,
		) => common.typedSimple.ExpressionNode

		if (defaultValue.nodeType === "RecordValue") {
			fallbackFor = (path) =>
				simplifyExpression(defaultMemberAt(defaultValue, path))
		} else {
			let hoisted: common.typedSimple.IdentifierNode = {
				nodeType: "Identifier",
				name: `_default${index}`,
				type: defaultValue.type,
			}

			prologue.push({
				nodeType: "VariableDeclarationStatement",
				name: hoisted,
				value: simplifyExpression(defaultValue),
				type: defaultValue.type,
				isConstant: true,
				position,
			})

			// NOTE: One step only — a default that is not a Literal can not be
			// taken apart, so `recordDefaultNesting` names nothing under it and
			// no path ever reaches past its first member.
			fallbackFor = (path) => ({
				nodeType: "Lookup",
				base: { ...hoisted },
				member: {
					nodeType: "Identifier",
					name: path[0]!,
					type: recordType.members[path[0]!]!,
				},
				type: recordType.members[path[0]!]!,
			})
		}

		// NOTE: The base may be `undefined` exactly where the whole Argument
		// may be left out, which is where the default supplies every member —
		// the same answer `hasDefault` carries on the Parameter's Type. Every
		// step PAST the first reads optionally whatever this says: a level the
		// Argument left out is a level that is not there.
		let optional = supplied.size === declared(recordType).length

		// NOTE: One level of the Record the callee rebuilds. A member the
		// default writes as a Record LITERAL is rebuilt one level further in
		// rather than taken whole, which is what makes a path key MERGE: the
		// Argument carries only the members the path wrote, and every other one
		// falls through to the default's, exactly as it does at the top level.
		// A member written WHOLE is complete by rule, so the same rebuild hands
		// back the value the caller passed — one spelling, two readings, and
		// the same answer for both.
		let rebuild = (
			type: common.RecordType,
			levelSupplied: Set<string>,
			levelNesting: common.DefaultNesting,
			path: Array<string>,
		): common.typedSimple.RecordValueNode => ({
			nodeType: "RecordValue",
			type,
			members: Object.fromEntries(
				declared(type).map((member) => {
					let memberType = type.members[member]!
					let memberPath = [...path, member]

					if (!levelSupplied.has(member)) {
						return [member, read(memberPath)]
					}

					if (Object.hasOwn(levelNesting, member)) {
						let nested = memberType as common.RecordType

						return [
							member,
							rebuild(
								nested,
								new Set(declared(nested)),
								levelNesting[member]!,
								memberPath,
							),
						]
					}

					return [
						member,
						{
							nodeType: "Intrinsic",
							kind: "member-or-default",
							base: argument(),
							path: memberPath,
							fallback: fallbackFor(memberPath),
							optional,
							type: memberType,
							position,
						} satisfies common.typedSimple.MemberOrDefaultNode,
					]
				}),
			),
			position,
		})

		prologue.push({
			nodeType: "VariableAssignmentStatement",
			name: { ...simplified[index]!.internalName },
			value: rebuild(recordType, supplied, nesting, []),
			position,
		})
	}

	return prologue
}

// NOTE: The members a Record Type declares, in one spelling, because the
// prologue asks for them at every level it rebuilds.
function declared(type: common.RecordType): Array<string> {
	return Object.keys(type.members)
}

// NOTE: The Expression a Record default writes at one path — `server.port`'s
// `8080`. Every step but the last is a Record Literal by `recordDefaultNesting`,
// which is the only thing that ever hands a path longer than one step in.
function defaultMemberAt(
	value: common.typed.ExpressionNode,
	path: Array<string>,
): common.typed.ExpressionNode {
	let node = value

	for (let member of path) {
		node = (node as common.typed.RecordValueNode).members[member]!
	}

	return node
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

	let parameters = node.parameters.map((param, index) =>
		simplifyParameter(param, index),
	)

	return {
		nodeType: "FunctionDefinition",
		parameters: [...parameters, ...conformanceParameters],
		// NOTE: The prologue goes before the body and not inside `simplifyBody`,
		// because what `simplifyBody` adds is a Return at the END — the two are
		// the two ends of the same Function and neither knows about the other.
		body: [
			...recordDefaultPrologue(node.parameters, parameters),
			...simplifyBody(node.body),
		],
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

// #region Tests

// NOTE: The lowering of a `tests { … }` block, and the one place instrumented
// points are handed out. It is Simplifier work rather than a stage of its own
// because what a test IS by the time it is emitted is Statements: the setup
// where it was written, the suites as nested Scopes, and each test as a closure
// registered from inside whatever setup it can see.
//
// NOTE: The state below stands for one Module's lowering and is installed for
// the length of `simplifyTestsSection` — the same discipline the Rewriter's
// `withEmission` keeps, and for the same reason: a throw out of one Module's
// lowering must not leave the next one handing out points against a span table
// it is not part of.
type TestLowering = {
	spans: Array<common.typedSimple.TestSpan>
	lines: Array<string>
	// NOTE: The lines that END in a `§?` value comment, and the Position of the
	// comment itself — read off the source once per Module rather than at each
	// Statement, because a value comment is a fact about the text and the text
	// does not change while a section is lowered.
	valueComments: Map<number, common.Position>
	// NOTE: The lines a probe has already been handed out for. One value
	// comment asks one question: a Statement the Enricher desugared into
	// several — `require MATCHER = EXPR` is a Constant and an assertion — must
	// not answer it once per piece.
	probed: Set<number>
}

let testLowering: TestLowering | null = null

function simplifyTestsSection(
	section: common.typed.TestsSectionNode,
	options: SimplifyOptions,
): common.typedSimple.TestsSectionNode {
	let previous = testLowering
	let lowering: TestLowering = {
		spans: [],
		lines: options.source === undefined ? [] : options.source.split("\n"),
		valueComments:
			options.source === undefined
				? new Map()
				: valueCommentLines(options.source),
		probed: new Set(),
	}

	testLowering = lowering

	try {
		let tests: Array<common.typedSimple.TestManifestEntry> = []
		let nodes = simplifyTestsNodes(section.nodes, tests)

		return {
			nodeType: "TestsSection",
			module: modulePathOfTests(section.nodes),
			spans: lowering.spans,
			tests,
			nodes,
		}
	} finally {
		testLowering = previous
	}
}

// NOTE: The path every identity in the section is spelled against, read off the
// first item rather than threaded in — the Enricher put it on every one of them
// and they can not disagree, since one section is one Module. Null where the
// section holds no item at all, and where the Program is no Module.
function modulePathOfTests(
	nodes: Array<common.typed.TestsNode>,
): string | null {
	for (let node of nodes) {
		if (node.nodeType === "Test") {
			return node.identity.modulePath
		}

		if (node.nodeType === "Suite") {
			return node.identity.modulePath
		}
	}

	return null
}

// NOTE: One Scope's run of Nodes. A test becomes an entry — numbered by its
// place in the manifest, which is the number the context selects by — and a
// suite becomes a Scope holding its own, so that what a suite declares is gone
// outside it and may shadow what the section declares. Everything else is an
// ordinary Statement and is simplified as one.
function simplifyTestsNodes(
	nodes: Array<common.typed.TestsNode>,
	tests: Array<common.typedSimple.TestManifestEntry>,
): Array<common.typedSimple.TestsNode> {
	return nodes.map((node) => {
		if (node.nodeType === "Test") {
			let index = tests.length
			let interpolated = node.name.nodeType === "InterpolatedStringValue"

			// NOTE: A table test is N entries of the manifest and ONE emitted
			// body: each row is a test in its own right, carrying its row
			// number as the last step of its identity, and the body they share
			// reads whichever row is running.
			if (node.table !== null) {
				for (let row = 0; row < node.table.rows.length; row++) {
					tests.push({
						...manifestEntry(node, interpolated),
						id: testIdentityKey(node.identity, row),
						row,
					})
				}

				return {
					nodeType: "TestRows" as const,
					first: index,
					binding: node.table.binding,
					rows: node.table.rows.map((row) => simplifyExpression(row)),
					bindings: node.table.bindings.map((binding) =>
						simplifyImplementationNode(binding),
					),
					name: interpolated ? simplifyExpression(node.name) : null,
					body: node.body.map((child) =>
						probeStatement(
							simplifyImplementationNode(child),
							child.nodeType === "ConstantDeclarationStatement" &&
								child.synthesized === undefined,
						),
					),
					position: node.position,
				}
			}

			tests.push({
				...manifestEntry(node, interpolated),
				id: testIdentityKey(node.identity),
				row: null,
			})

			// NOTE: A property test is ONE entry of the manifest and one body,
			// like a plain test — what differs is that the runtime runs the
			// body once per generated case rather than once, which is a fact
			// about the call and not about the identity.
			if (node.properties !== null) {
				return {
					nodeType: "TestProperties" as const,
					index,
					name: interpolated ? simplifyExpression(node.name) : null,
					parameters: node.properties.parameters.map((parameter) => ({
						name: parameter.name,
						generator: simplifyTestGenerator(parameter.generator),
					})),
					body: node.body.map((child) =>
						probeStatement(
							simplifyImplementationNode(child),
							child.nodeType === "ConstantDeclarationStatement" &&
								child.synthesized === undefined,
						),
					),
					position: node.position,
				}
			}

			return {
				nodeType: "TestEntry" as const,
				index,
				// NOTE: Only where the name INTERPOLATES. A plain one is in the
				// manifest already, and emitting it a second time would be two
				// spellings of one thing that could come to disagree.
				name: interpolated ? simplifyExpression(node.name) : null,
				// NOTE: A Constant a test WROTE is probed whether or not a `§?`
				// asked for it. What a reader wants beside a test body is the
				// value of every step of it, which is what an Editor draws from
				// these — and a Constant is a step the author named, so the
				// name and the value read together. A Constant the Enricher
				// synthesized is not one: it stands for a Matcher's subject,
				// which the assertion beside it already reports.
				body: node.body.map((child) =>
					probeStatement(
						simplifyImplementationNode(child),
						child.nodeType === "ConstantDeclarationStatement" &&
							child.synthesized === undefined,
					),
				),
				position: node.position,
			}
		}

		if (node.nodeType === "Suite") {
			// NOTE: Read off the manifest as it fills rather than counted out
			// of the tree: a table test is N entries for one written item, and
			// the run a Scope holds is whatever its own items pushed.
			let first = tests.length
			let nodes = simplifyTestsNodes(node.nodes, tests)

			return {
				nodeType: "TestScope" as const,
				first,
				last: tests.length,
				nodes,
				position: node.position,
			}
		}

		return probeStatement(simplifyImplementationNode(node))
	})
}

// NOTE: A generator with its two Expression leaves lowered — a refinement's
// checks and a `Generatable` call. Everything else is data the Enricher settled
// and nothing here decides.
function simplifyTestGenerator(
	generator: common.typed.TestGenerator,
): common.typedSimple.TestGenerator {
	switch (generator.kind) {
		case "list":
			return {
				kind: "list",
				item: simplifyTestGenerator(generator.item),
			}
		case "record":
			return {
				kind: "record",
				members: simplifyGeneratorMembers(generator.members),
			}
		case "case":
			return {
				kind: "case",
				tag: generator.tag,
				members: simplifyGeneratorMembers(generator.members),
			}
		case "union":
			return {
				kind: "union",
				members: generator.members.map((member) =>
					simplifyTestGenerator(member),
				),
			}
		case "refined":
			return {
				kind: "refined",
				name: generator.name,
				base: simplifyTestGenerator(generator.base),
				binding: generator.binding,
				checks: generator.checks.map((check) =>
					simplifyExpression(check),
				),
				narrowing: generator.narrowing,
			}
		case "generated":
			return {
				kind: "generated",
				name: generator.name,
				binding: generator.binding,
				call: simplifyExpression(generator.call),
			}
		default:
			return generator
	}
}

function simplifyGeneratorMembers(
	members: Array<common.typed.TestGeneratorMember>,
): Array<common.typedSimple.TestGeneratorMember> {
	return members.map((member) => ({
		name: member.name,
		generator: simplifyTestGenerator(member.generator),
	}))
}

// NOTE: Everything a manifest entry says about a test that is not its identity.
// A table test's rows differ in the id and the row number and in nothing else —
// they share the template, the Modifiers and the span they were written at.
function manifestEntry(
	node: common.typed.TestNode,
	interpolated: boolean,
): Omit<common.typedSimple.TestManifestEntry, "id" | "row"> {
	return {
		name: node.identity.name,
		interpolated,
		suitePath: node.identity.suitePath,
		tags: node.tags,
		focused: node.focused !== null,
		skipped: node.skipped === null ? null : node.skipped.reason,
		position: node.position,
		keywordPosition: node.keywordPosition,
	}
}

// NOTE: The `§?` value comments of this Module, applied to Statements that have
// already been simplified — so that what a probe records is the Expression as it
// will be emitted, wrapped where every other instrumented point is wrapped.
//
// NOTE: A Conditional's two bodies are descended into, because a value comment
// inside an `if` is the case a reader most wants an answer for. A Function
// literal's body is NOT: it is a closure the test builds, and what a probe
// promises is the value of the line, once, in the test that ran.
function probeStatements(
	nodes: Array<common.typedSimple.ImplementationNode>,
): Array<common.typedSimple.ImplementationNode> {
	return nodes.map((node) => probeStatement(node))
}

// NOTE: `always` is what a test BODY asks for: every Constant of one is probed
// whether or not a value comment named it. Everywhere else a probe is what a
// `§?` asked for and nothing more.
function probeStatement(
	node: common.typedSimple.ImplementationNode,
	always = false,
): common.typedSimple.ImplementationNode {
	let lowering = testLowering

	if (lowering === null || (!always && lowering.valueComments.size === 0)) {
		return node
	}

	if (node.nodeType === "ConditionalStatement") {
		return {
			...node,
			trueBody: probeStatements(node.trueBody),
			falseBody: probeStatements(node.falseBody),
		}
	}

	// NOTE: The line the Statement ENDS on, which is the line the comment that
	// asks about it was written on — a Statement spanning several lines is
	// answered by a `§?` behind its last one.
	let line = node.position?.end.line

	if (line === undefined || !(always || lowering.valueComments.has(line))) {
		return node
	}

	if (
		node.nodeType === "VariableDeclarationStatement" ||
		node.nodeType === "VariableAssignmentStatement"
	) {
		let point = probePoint(lowering, line, node.value.position)

		return point === null
			? node
			: {
					...node,
					value: {
						nodeType: "TestTrace",
						kind: "probe",
						point,
						value: node.value,
						type: node.value.type,
						position: node.value.position,
					},
				}
	}

	// NOTE: Everything else is only probed where it IS an Expression — a bare
	// Expression Statement, which is the other half of what the spec says a
	// value comment answers. A Return, a Namespace, an assertion and a Type
	// alias have no value a line could be asking about.
	if (isSimpleExpression(node)) {
		let point = probePoint(lowering, line, node.position)

		return point === null
			? node
			: {
					nodeType: "TestTrace",
					kind: "probe",
					point,
					value: node,
					type: node.type,
					position: node.position,
				}
	}

	return node
}

// NOTE: One point per value comment, whoever asks first. The Enricher desugars
// `require MATCHER = EXPR` into a Constant and an assertion that stand on one
// line, and a reader who wrote one `§?` asked one question.
function probePoint(
	lowering: TestLowering,
	line: number,
	position: common.Position | undefined,
): number | null {
	if (position === undefined || lowering.probed.has(line)) {
		return null
	}

	lowering.probed.add(line)

	return testPoint(position)
}

function isSimpleExpression(
	node: common.typedSimple.ImplementationNode,
): node is common.typedSimple.ExpressionNode {
	switch (node.nodeType) {
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "NamespaceDefinitionStatement":
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "ConditionalStatement":
		case "ReturnStatement":
		case "FunctionStatement":
		case "TestAssertionStatement":
		case "IntrinsicStatement":
			return false
		default:
			return true
	}
}

// NOTE: One instrumented point, handed out against the Module's span table. The
// source is sliced HERE, where the text is, so that everything downstream of
// the Compiler can say what stood at a point without reading the file again.
function testPoint(position: common.Position): number {
	let lowering = testLowering

	// NOTE: Unreachable — an assertion only reaches this file through a tests
	// section — and answered rather than thrown so that a Compiler bug costs a
	// point with no span instead of the whole compile.
	if (lowering === null) {
		return -1
	}

	lowering.spans.push({
		position,
		source: sourceOfSpan(lowering.lines, position),
	})

	return lowering.spans.length - 1
}

// NOTE: Essence Positions are 1-based on both axes and the end column stands
// one PAST the last character, which is what makes a single-line slice the
// plain `slice(start - 1, end - 1)` below.
function sourceOfSpan(lines: Array<string>, position: common.Position): string {
	let { start, end } = position

	if (start.line === end.line) {
		return (lines[start.line - 1] ?? "").slice(
			start.column - 1,
			end.column - 1,
		)
	}

	return [
		(lines[start.line - 1] ?? "").slice(start.column - 1),
		...lines.slice(start.line, end.line - 1),
		(lines[end.line - 1] ?? "").slice(0, end.column - 1),
	].join("\n")
}

// NOTE: `expect EXPR` / `require EXPR`, and both `is MATCHER` forms.
//
// The Boolean form is INSTRUMENTED: every sub-expression that computes
// something — a call, a member read — is wrapped in a point that records what
// stood there, so a failure explains itself out of the values it was built
// from rather than out of a re-run. `require MATCHER = EXPR` is not: what it
// asserts is a Matcher's test over a value the Statement in front of it
// already holds under a name, and there is no expression tree there to take
// apart.
function simplifyAssertion(
	node: common.typed.ExpectStatementNode | common.typed.RequireStatementNode,
): common.typedSimple.TestAssertionStatementNode {
	let form =
		node.nodeType === "ExpectStatement"
			? ("expect" as const)
			: ("require" as const)
	// NOTE: Asked of the TYPED Node, before anything is simplified: the
	// Simplifier mangles an overloaded Method's name in place, so `is` is only
	// called `is` on this side of it.
	let operands = comparedOperands(node.value)
	// NOTE: What a failure UNDERLINES. For the Boolean form that is the whole
	// asserted Expression; for `require MATCHER = EXPR` it runs from the
	// Matcher to the end of the value — the value alone would leave a reader
	// looking at `lions` and wondering what it was supposed to be. The value's
	// Position is the one the written Expression had, because the Constant the
	// Enricher put in front of the assertion carries it.
	let point = testPoint(
		node.matcher !== null
			? {
					start: node.matcher.matcherPosition.start,
					end: node.value.position.end,
				}
			: node.snapshot !== null
				? {
						start: node.value.position.start,
						end: node.snapshot.position.end,
					}
				: node.value.position,
	)

	// NOTE: A snapshot asserts nothing of its own — what it records is the
	// value RENDERED, which the Enricher already turned into the interpolation
	// an author could have written. The point behind it is the slot a run
	// writes a recorded value into.
	if (node.snapshot !== null) {
		return {
			nodeType: "TestAssertionStatement",
			form,
			point,
			value: simplifyExpression(node.value),
			matcher: null,
			snapshot: {
				name: node.snapshot.name,
				recorded: node.snapshot.recorded,
				slot: testPoint(node.snapshot.valuePosition),
			},
			comparison: null,
			position: node.position,
		}
	}

	if (node.matcher !== null) {
		return {
			nodeType: "TestAssertionStatement",
			form,
			point,
			value: simplifyExpression(node.value),
			matcher: assertionHandler(node.matcher),
			snapshot: null,
			comparison: null,
			position: node.position,
		}
	}

	let instrumented = instrumentAssertion(
		simplifyExpression(node.value),
		operands,
	)

	return {
		nodeType: "TestAssertionStatement",
		form,
		point,
		value: instrumented.value,
		matcher: null,
		snapshot: null,
		comparison: instrumented.comparison,
		position: node.position,
	}
}

// NOTE: The test half of one `match` Handler, built from an assertion's Matcher
// — the same shape, so the same emission answers both. `typeTest` and
// `memberTests` are what `compile-type-tests` leaves where it has found
// something cheaper, and are null here for the same reason they are null on a
// Handler: the Simplifier states what the Program says and nothing about how it
// is tested.
function assertionHandler(
	matcher: common.typed.AssertionMatcherNode,
): common.typedSimple.MatchHandler {
	return {
		matcher: matcher.matcher,
		typeTest: null,
		literal:
			matcher.literal === null
				? null
				: simplifyExpression(matcher.literal),
		memberLiterals:
			matcher.memberLiterals === null
				? null
				: Object.fromEntries(
						Object.entries(matcher.memberLiterals).map(
							([name, literal]) => [
								name,
								simplifyExpression(literal),
							],
						),
					),
		memberTypes: matcher.memberTypes,
		memberTests: null,
		guard: null,
		body: [],
	}
}

// NOTE: Whether the asserted Expression IS a comparison of two values, and
// where each of them was written. `is` and `isNot` are `Equatable`'s, and a
// one-Argument call of either answering a Boolean is one wherever it came
// from: a Namespace that declares an `is` of its own with that shape is
// declaring an equality, and a report that diffs its two operands is right
// about it.
function comparedOperands(
	node: common.typed.ExpressionNode,
): TestOperands | null {
	if (
		node.nodeType !== "MethodInvocation" ||
		(node.member.name !== "is" && node.member.name !== "isNot") ||
		node.type.type !== "Boolean" ||
		node.arguments.length !== 1
	) {
		return null
	}

	return {
		kind: node.member.name,
		left: node.base.position,
		right: node.arguments[0]!.value.position,
	}
}

type TestOperands = {
	kind: "is" | "isNot"
	left: common.Position
	right: common.Position
}

// NOTE: The power-assert half. Every sub-expression that COMPUTES — a call and
// a member read — is wrapped in a point, so the report can say what each part
// of the assertion answered. A literal and a bare name are left alone: what
// they hold is what the source says they hold.
//
// NOTE: The outermost Expression is not wrapped. Its value is the assertion's
// own answer, which the assertion records — a point there would say the same
// thing twice.
//
// NOTE: The two operands of a comparison ARE wrapped, whatever kind they are,
// because a structural difference needs both values and one of them is often a
// literal Record. That is the whole of what the diff costs: no second capture,
// no second traversal, two points off the same table everything else uses.
function instrumentAssertion(
	value: common.typedSimple.ExpressionNode,
	operands: TestOperands | null,
	// NOTE: Whether the outermost Expression is recorded too. It is not for an
	// asserted Boolean — its value is the assertion's own answer, which the
	// assertion records — and it is for a Matcher's subject, whose value is
	// exactly what the reader was not told.
	traceRoot = false,
): {
	value: common.typedSimple.ExpressionNode
	comparison: common.typedSimple.TestComparison | null
} {
	let left: number | null = null
	let right: number | null = null

	let walk = (
		node: common.typedSimple.ExpressionNode,
		isRoot: boolean,
	): common.typedSimple.ExpressionNode => {
		let walked = instrumentChildren(node, (child) => walk(child, false))
		let side =
			operands === null || node.position === undefined
				? null
				: samePosition(node.position, operands.left)
					? "left"
					: samePosition(node.position, operands.right)
						? "right"
						: null

		if (
			side === null &&
			((isRoot && !traceRoot) || (!isRoot && !isTraceable(node)))
		) {
			return walked
		}

		let point = testPoint(node.position ?? emptyPosition)

		if (side === "left") {
			left = point
		} else if (side === "right") {
			right = point
		}

		return {
			nodeType: "TestTrace",
			kind: "trace",
			point,
			value: walked,
			type: node.type,
			position: node.position,
		}
	}

	let instrumented = walk(value, true)

	return {
		value: instrumented,
		comparison:
			operands === null || left === null || right === null
				? null
				: { kind: operands.kind, left, right },
	}
}

const emptyPosition: common.Position = {
	start: { line: 0, column: 0 },
	end: { line: 0, column: 0 },
}

function samePosition(left: common.Position, right: common.Position): boolean {
	return (
		left.start.line === right.start.line &&
		left.start.column === right.start.column &&
		left.end.line === right.end.line &&
		left.end.column === right.end.column
	)
}

// NOTE: What is worth recording: a call's answer and a member read. A literal
// holds what the source says, a bare name is a binding the reader can see, and
// neither tells anybody anything a report does not already show.
function isTraceable(node: common.typedSimple.ExpressionNode): boolean {
	return (
		node.nodeType === "MethodInvocation" ||
		node.nodeType === "UnionMethodInvocation" ||
		node.nodeType === "FunctionInvocation" ||
		node.nodeType === "Lookup"
	)
}

// NOTE: The Expression positions an asserted Expression EVALUATES, and only
// those. A Function literal's body is not among them — it is a closure the
// assertion builds and does not run — and neither is a Match Handler's, which
// is Statements. A witness is references to Methods and never a call of one.
function instrumentChildren(
	node: common.typedSimple.ExpressionNode,
	walk: (
		child: common.typedSimple.ExpressionNode,
	) => common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	switch (node.nodeType) {
		case "MethodInvocation":
			return { ...node, arguments: walkArguments(node.arguments, walk) }
		case "UnionMethodInvocation":
			return {
				...node,
				base: walk(node.base),
				arguments: walkArguments(node.arguments, walk),
			}
		case "FunctionInvocation":
			return {
				...node,
				name: walk(node.name),
				arguments: walkArguments(node.arguments, walk),
			}
		case "Lookup":
			return { ...node, base: walk(node.base) }
		case "Combination":
			return { ...node, lhs: walk(node.lhs), rhs: walk(node.rhs) }
		case "RecordValue":
			return {
				...node,
				members: Object.fromEntries(
					Object.entries(node.members).map(([name, member]) => [
						name,
						walk(member),
					]),
				),
			}
		case "ListValue":
			return { ...node, values: node.values.map((value) => walk(value)) }
		case "CaseValue":
			return node.value === null
				? node
				: { ...node, value: walk(node.value) }
		case "InterpolatedStringValue":
			return {
				...node,
				segments: node.segments.map((segment) =>
					segment.kind === "expression"
						? { ...segment, expression: walk(segment.expression) }
						: segment,
				),
			}
		default:
			return node
	}
}

function walkArguments(
	args: Array<common.typedSimple.ArgumentNode>,
	walk: (
		child: common.typedSimple.ExpressionNode,
	) => common.typedSimple.ExpressionNode,
): Array<common.typedSimple.ArgumentNode> {
	return args.map((argument) => ({
		...argument,
		value: walk(argument.value),
	}))
}

// #endregion
