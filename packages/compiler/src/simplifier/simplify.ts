import type { common } from "@essence-lang/interfaces"

import { relativeIdentityKey, testIdentityKey } from "../enricher/tests"
import {
	openArgumentHoles,
	recordDefaultMembers,
	recordDefaultNesting,
} from "../helpers/defaults"
import { conformanceParameterName } from "../helpers/names"
import { bodyDefinitelyReturns } from "../helpers/returns"
import { isMergedLevel, resolveOverloadedMethodName } from "../helpers/types"
import { valueCommentLines } from "../valueComments"

// `source` is the Module's text, read only by a test compile. Its span table
// carries the source of every instrumented point, sliced once here so every
// reader of an event agrees on what was recorded.
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
		implementation: withExposedMethods(
			simplifyImplementationSection(program.implementation),
			program.exports,
		),
		tests:
			program.tests === null
				? null
				: simplifyTestsSection(program.tests, options),
		// Coverage is instrumentation, not a lowering: only the
		// `instrument-coverage` pass fills this.
		coverage: null,
		exports: simplifyExportSection(program.exports),
	}
}

// Both sections keep only what emission reads: names, the canonical path and
// the `runtime` flag the linker set. Positions and written specifiers go.
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

// Each provided Method an exported Namespace offers a host becomes one of its
// emitted Methods. Its Type is left alone, so Essence still reaches the Method
// as provided. See "Provided Methods" in
// packages/compiler/src/embed/DEVELOPMENT.md.
function withExposedMethods(
	implementation: common.typedSimple.ImplementationSectionNode,
	exports: common.typed.ExportSectionNode | null,
): common.typedSimple.ImplementationSectionNode {
	let exposed = new Map<string, Array<common.ExposedMethod>>()

	for (let entry of exports?.entries ?? []) {
		if (entry.exposed !== undefined) {
			exposed.set(entry.name, entry.exposed)
		}
	}

	if (exposed.size === 0) {
		return implementation
	}

	return {
		...implementation,
		nodes: implementation.nodes.map((node) => {
			if (
				node.nodeType !== "NamespaceDefinitionStatement" ||
				!exposed.has(node.name.name)
			) {
				return node
			}

			let added: common.typedSimple.Methods = {}

			for (let method of exposed.get(node.name.name)!) {
				added[method.name] = exposedMethod(node, method)
			}

			return { ...node, methods: { ...node.methods, ...added } }
		}),
	}
}

// `(_self, _1, …) { <- Namespace.member(_self, _1, …) }`, handed the witness the
// linker solved for the Namespace.
function exposedMethod(
	namespace: common.typedSimple.NamespaceDefinitionStatementNode,
	exposed: common.ExposedMethod,
): common.typedSimple.Method {
	let parameters = exposed.type.parameterTypes.map(
		(parameter, index): common.typedSimple.ParameterNode => ({
			nodeType: "Parameter",
			externalName: null,
			internalName: {
				nodeType: "Identifier",
				name: index === 0 ? "_self" : `_${index}`,
				type: parameter.type,
			},
			defaultValue: null,
		}),
	)

	return {
		method: {
			nodeType: "FunctionValue",
			value: {
				nodeType: "FunctionDefinition",
				parameters,
				body: [
					{
						nodeType: "ReturnStatement",
						expression: {
							nodeType: "MethodInvocation",
							base: namespace.name,
							member: { name: exposed.name },
							arguments: [
								...parameters.map(
									(
										parameter,
									): common.typedSimple.ArgumentNode => ({
										nodeType: "Argument",
										name: null,
										value: parameter.internalName,
									}),
								),
								...simplifyConformanceArguments([
									exposed.conformance,
								]),
							],
							providedBy: exposed.providedBy,
							type: exposed.type.returnType,
						},
					},
				],
				returnType: exposed.type.returnType,
			},
			type: { ...exposed.type, type: "Function" },
		},
		isStatic: false,
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
		case "DictionaryValue":
		case "Lookup":
		case "Identifier":
		case "Self":
		case "Match":
		case "Define":
		case "CaseValue":
		case "Start":
		case "Complete":
		case "RefusedValue":
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
		// Only a test body holds an assertion, and only a test compile
		// carries a `tests` section.
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
		case "DictionaryValue":
			return simplifyDictionaryValue(node)
		case "Lookup":
			return simplifyLookup(node)
		case "Identifier":
			return simplifyIdentifier(node)
		case "Self":
			return simplifySelf(node)
		case "Match":
			return simplifyMatch(node)
		case "Define":
			return simplifyDefine(node)
		case "CaseValue":
			return simplifyCaseValue(node)
		// Both survive whole. What each becomes depends on the run's context
		// in the emitted JavaScript, which only the Rewriter knows.
		case "Start":
			return {
				nodeType: "Start",
				expression: simplifyExpression(node.expression),
				type: node.type,
				position: node.position,
			}
		case "Complete":
			return {
				nodeType: "Complete",
				expression: simplifyExpression(node.expression),
				type: node.type,
				position: node.position,
			}
		// Never reached, since an Error Type stops code generation. The arm
		// answers with what the refusal wraps rather than throw.
		case "RefusedValue":
			return simplifyExpression(node.base)
	}
}

// The runtime needs only the tag, such as `"CalculatorOperation#Add"`, and the
// payload. The empty tag is for the type checker: no Error Type gets here.
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

// Writes the members a payload left out into the Record Literal itself, since
// a Case has no callee to fill them in. A payload that is not a Literal is
// complete by rule. See "Payload defaults" in DEVELOPMENT.md.
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

// One level of the payload. A member a path key wrote, as in
// `#Get({ limits.calls = 2 })`, is filled in as a level of its own. A member
// written whole is a replacement and is left alone.
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

	let defaulted = new Set<string>()

	for (let [name, member] of Object.entries(values)) {
		if (!Object.hasOwn(members, name)) {
			members[name] = writtenAt(simplifyExpression(member), position)
			defaulted.add(name)
			filled = true
		}
	}

	return filled
		? { ...value, members: inDeclaredOrder(members, defaulted, type), type }
		: value
}

// A defaulted member stands before the first written member declared after
// it, so a payload written in declared order prints in it. The written members
// keep their order, since a Record Literal evaluates its members as written.
// See "Payload defaults" in DEVELOPMENT.md.
function inDeclaredOrder<Member>(
	members: Record<string, Member>,
	defaulted: Set<string>,
	type: common.RecordType,
): Record<string, Member> {
	let order = declared(type)
	let rank = (name: string) =>
		order.includes(name) ? order.indexOf(name) : order.length
	let pending = order.filter((name) => defaulted.has(name))
	let entries: Array<[string, Member]> = []

	for (let [name, member] of Object.entries(members)) {
		if (defaulted.has(name)) {
			continue
		}

		while (pending.length > 0 && rank(pending[0]!) < rank(name)) {
			let next = pending.shift()!

			entries.push([next, members[next]!])
		}

		entries.push([name, member])
	}

	for (let name of pending) {
		entries.push([name, members[name]!])
	}

	return Object.fromEntries(entries)
}

// A deep copy of a simplified Expression with one Position stamped
// throughout. A `type` is shared rather than copied, since it holds no Position.
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

	// The mangled name goes into the new node only. The typed Program is
	// simplified again elsewhere, and a second suffix would name nothing.
	let memberName =
		node.overloadedMethodIndex === null
			? node.member.name
			: resolveOverloadedMethodName(
					node.member.name,
					node.overloadedMethodIndex,
				)

	return {
		nodeType: "MethodInvocation",
		base: {
			nodeType: "Identifier",
			name: node.namespace.name,
			type: node.namespace.type,
			position: node.position,
		},
		member: { name: memberName },
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
		// The routed member names of a Record receiver. They tell the Rewriter
		// to call the member-routing helper rather than the flat native.
		...(node.derivedMembers === undefined
			? {}
			: { derivedMembers: node.derivedMembers }),
		// Set when a Protocol's provided Method answered, which the
		// Namespace's name alone can not tell.
		providedBy: node.namespace.type.providedBy,
		type: node.type,
		position: node.position,
	}
}

// A dispatched Invocation becomes one resolved target per member Type. The
// receiver and shared Arguments are emitted once; each case carries its mangled
// name, its witnesses and any Argument compiled for that branch alone.
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
			...(dispatchCase.derivedMembers === undefined
				? {}
				: { derivedMembers: dispatchCase.derivedMembers }),
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
	// Mangled on the simplified callee, a fresh node, because the typed
	// Program is simplified again elsewhere.
	let name = simplifyExpression(node.name)

	if (node.overloadedMethodIndex !== null) {
		if (name.nodeType === "Lookup") {
			// A `Namespace.method(…)` call to the Overload the Enricher picked.
			name.member.name = resolveOverloadedMethodName(
				name.member.name,
				node.overloadedMethodIndex,
			)
		} else if (name.nodeType === "Identifier") {
			// A bare call to an overloaded free Function, such as `loop(…)`,
			// mangled on the Identifier itself.
			name.name = resolveOverloadedMethodName(
				name.name,
				node.overloadedMethodIndex,
			)
		}
	}

	return {
		nodeType: "FunctionInvocation",
		name,
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

// The hidden trailing Arguments that match a bounded signature's hidden
// trailing Parameters.
function simplifyConformanceArguments(
	conformances: Array<common.Conformance>,
): Array<common.typedSimple.ArgumentNode> {
	return conformances.map((conformance) => ({
		nodeType: "Argument",
		name: null,
		value: conformanceExpression(conformance),
	}))
}

// One conformance witness. A forwarded parameter stays an Identifier; a
// resolved Namespace becomes a `ConformanceValue`, whose `where` conditions are
// witnessed recursively in the order the Enricher fixed.
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
		...(conformance.source.curriedWith === undefined
			? {}
			: { curriedWith: conformance.source.curriedWith }),
		...(conformance.source.providedWitnesses === undefined
			? {}
			: {
					providedWitnesses: conformance.source.providedWitnesses.map(
						(witness): common.typedSimple.ConformanceValueNode => ({
							nodeType: "ConformanceValue",
							namespaceName: witness.name,
							methodMap: witness.methodMap,
							...(witness.providedMethods === undefined
								? {}
								: { providedMethods: witness.providedMethods }),
							...(witness.curriedWith === undefined
								? {}
								: { curriedWith: witness.curriedWith }),
							conditionIndices: witness.conditionIndices,
							conditions: [],
							derivedDescriptor: witness.derivedDescriptor,
							type: { type: "Unknown" },
						}),
					),
				}),
		...(conformance.source.groupConditions === undefined
			? {}
			: {
					groupConditions: conformance.source.groupConditions.map(
						conformanceExpression,
					),
				}),
		...(conformance.source.sharedConditions === undefined
			? {}
			: { sharedConditions: conformance.source.sharedConditions }),
		conditions: conformance.source.conditions.map(conformanceExpression),
		derivedDescriptor: conformance.source.derivedDescriptor,
		// The routed member names of a Record's conditional witness. The
		// method map names `Record.is`, and only this says to route instead.
		...(conformance.source.derivedMembers === undefined
			? {}
			: { derivedMembers: conformance.source.derivedMembers }),
		// The Case tags of a derived `Enumerable` witness, whose Method no
		// Namespace holds.
		...(conformance.source.derivedCases === undefined
			? {}
			: { derivedCases: conformance.source.derivedCases }),
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
		// A Dictionary update's key witness. A Record update has none.
		...(node.keyConformance === undefined
			? {}
			: {
					keyConformance: conformanceExpression(node.keyConformance),
				}),
		type: writtenValueType(node.type),
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

// A literal's Type without the refinement `writtenReceiver` gave it as a
// receiver. The Invocation already records what that refinement chose; the
// Optimiser erases every other refinement.
function writtenValueType<Kind extends common.Type>(
	type: Kind | common.RefinementType,
): Kind {
	return type.type === "Refinement" ? (type.base as Kind) : type
}

function simplifyStringValue(
	node: common.typed.StringValueNode,
): common.typedSimple.StringValueNode {
	return {
		nodeType: "StringValue",
		value: node.value,
		type: writtenValueType(node.type),
		position: node.position,
	}
}

// Each hole's `Printable` Conformance becomes a witness Expression, which the
// Rewriter calls as `witness.toString(expression)`.
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
		type: writtenValueType(node.type),
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
		type: writtenValueType(node.type),
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
		type: writtenValueType(node.type),
		position: node.position,
	}
}

// The key witness travels with the literal. The empty Dictionary has none,
// since it holds no key to compare.
function simplifyDictionaryValue(
	node: common.typed.DictionaryValueNode,
): common.typedSimple.DictionaryValueNode {
	return {
		nodeType: "DictionaryValue",
		entries: node.entries.map((entry) => ({
			key: simplifyExpression(entry.key),
			value: simplifyExpression(entry.value),
		})),
		keyConformance:
			node.keyConformance === null
				? null
				: conformanceExpression(node.keyConformance),
		type: writtenValueType(node.type),
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
		// Set when a Protocol provided the member, which its name can not tell.
		...(node.providedBy === undefined
			? {}
			: { providedBy: node.providedBy }),
		// For a member the base does not spell. These are the tags of a
		// derived `cases`, the hidden Parameter a bounded Type Parameter's
		// member comes from, and the Namespace of a written `cases`.
		...(node.derivedCases === undefined
			? {}
			: { derivedCases: node.derivedCases }),
		...(node.conformanceName === undefined
			? {}
			: { conformanceName: node.conformanceName }),
		...(node.namespaceName === undefined
			? {}
			: { namespaceName: node.namespaceName }),
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

// `@` lowers to `_self`, the receiver of an instance Method. The Enricher
// refuses `@` in a static Method (`at-in-static-method`), so one here is a
// compiler bug, thrown rather than emitted as a dangling name.
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

// Module state, so the guard in `simplifySelf` needs no parameter threaded
// through every simplify function. A count, so nesting restores exactly.
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
	// `@` in the matched value is the enclosing Method's receiver, so it is
	// simplified before the Handlers lift the static barrier.
	let value = simplifyExpression(node.value)

	return {
		nodeType: "Match",
		value,
		// A Handler is a Function taking the matched value as `_self`, so
		// `@` inside it is bound even within a static Method. The Enricher's
		// Scope lifts the barrier the same way.
		handlers: withoutStaticMethodBarrier(() =>
			node.handlers.map((handler) => {
				return {
					matcher: handler.matcher,
					// The Matcher's own descriptor check, until an Optimiser
					// pass finds a cheaper test.
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
					// Types, so nothing to simplify.
					memberTypes: handler.memberTypes,
					// Filled by `compile-type-tests`, like `typeTest`.
					memberTests: null,
					guard:
						handler.guard === null
							? null
							: simplifyExpression(handler.guard),
					body: simplifyBody(handler.body),
				}
			}),
		),
		// Every Handler is tested, and the chain ends in a fall-through that
		// reports a compiler bug, until `elide-final-match-test` proves the last.
		finalHandlerIsElse: false,
		type: node.type,
		position: node.position,
	}
}

// Unlike a Match, no barrier is lifted: `@` in an arm is the surrounding
// receiver. The arms are fresh, since the Simplifier never writes into the
// typed Program; `simplifierInput.spec.ts` checks this.
function simplifyDefine(
	node: common.typed.DefineNode,
): common.typedSimple.DefineNode {
	return {
		nodeType: "Define",
		arms: node.arms.map((arm) => ({
			value: simplifyExpression(arm.value),
			condition: simplifyExpression(arm.condition),
			// An Essence Boolean, until `unbox-conditions` finds a raw
			// JavaScript one.
			conditionIsRaw: false,
			// Only the Enricher can tell whether a Condition narrowed
			// anything, and the refinement is erased by now, so the claim rides
			// on the node.
			narrows: arm.narrows,
			narrowsBelow: arm.narrowsBelow,
		})),
		otherwise: simplifyExpression(node.otherwise.value),
		type: node.type,
		position: node.position,
	}
}

// #endregion

// #region Statements

// The assertions are excluded from the parameter Type, so TypeScript checks
// that `simplifyImplementationNode` routes them to `simplifyAssertion`.
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
		// A Matcher's subject is instrumented whole, so a failing
		// `require MATCHER = EXPR` can report what each step of it answered.
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
		// Every Constant keeps its Position, a Pattern's base included: its
		// value is source the author wrote. The debug adapter steps out of an
		// unmapped statement, so dropping it would end a Step Over early.
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

// The frame a native's default is evaluated in. Like `simplifyMethods`, it
// mangles the name with the Overload slot and gives an instance Method `_self`.
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

	// A Record default is merged here as in any Function, so the native gets
	// a whole Record. Built before the witnesses are appended, because the
	// prologue pairs typed and simplified Parameters by position.
	let prologue = recordDefaultPrologue(
		shim.isStatic
			? shim.parameters
			: [receiverPlaceholder(targetType), ...shim.parameters],
		parameters,
	)

	// The hidden trailing witness Parameters, as `simplifyFunctionDefinition`
	// appends them. A call passes its witnesses after the hole it left.
	for (let name of shim.conformances) {
		parameters.push({
			nodeType: "Parameter",
			externalName: null,
			internalName: {
				nodeType: "Identifier",
				name: conformanceParameterName(name),
				type: { type: "Unknown" },
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
		prologue,
	}
}

// The typed counterpart of the unshifted `_self`, so the typed and the
// simplified Parameter lists line up for `recordDefaultPrologue`.
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

// A Protocol's requirements erase; the witnesses passed at call sites are
// their whole runtime footprint. Its provided Methods go through
// `simplifyMethods`, which also appends their hidden `Self__conformance`.
function simplifyProtocolDeclarationStatement(
	node: common.typed.ProtocolDeclarationStatementNode,
): common.typedSimple.ProtocolDeclarationStatementNode {
	return {
		nodeType: "ProtocolDeclarationStatement",
		name: simplifyIdentifier(node.name),
		identity: node.protocolType.identity,
		// `_self` is the bounded `Self`: whichever conformer called.
		methods: simplifyMethods(node.methods, {
			type: "GenericUse",
			name: "Self",
			constraint: node.protocolType.identity,
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

// A Choice Declaration erases like a Type Alias; only a Case construction
// reaches the runtime.
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
			// No false body, so nothing reads under the complement and the
			// Enricher never works it out.
			narrowsFalse: false,
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
		// The Enricher's verdicts, whose evidence does not survive
		// simplification.
		narrows: convertedNode.narrows,
		narrowsFalse: convertedNode.narrowsFalse,
		// An Essence Boolean, until `unbox-conditions` finds a raw
		// JavaScript one.
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
				// INVARIANT: the `__overload$N` suffix comes from the
				// Overload's slot in the Method Type, not in `methods`, which
				// holds only the bodied Overloads. Call sites resolve against
				// the Type. See "Overload slots" in DEVELOPMENT.md.
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

// A Parameter that binds no name still needs one in the emitted Function.
// `_0` can not collide with a user Identifier, which never contains `_`.
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
		// A JavaScript default parameter, whose semantics are the language's
		// own. A Record default fills in members of a written Argument, which
		// JavaScript can not, so `recordDefaultPrologue` handles it instead.
		defaultValue:
			node.defaultValue === null || hasRecordDefault(node)
				? null
				: simplifyExpression(node.defaultValue),
	}
}

// A Parameter whose Argument is merged into its default at the callee's
// entry. Asked of the Type, so a complete Record default merges too. See
// "Record defaults" in DEVELOPMENT.md.
function hasRecordDefault(node: common.typed.ParameterNode): boolean {
	return node.defaultValue !== null && node.type.type === "Record"
}

// The Statements a body opens with, one per Parameter with a Record default:
//
//   options = Record.createRecord({
//     host: options.host,
//     retries: options.retries ?? 3,
//   })
//
// See "Record defaults" in DEVELOPMENT.md.
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
		// The Parameter and its default, so a coverage point at the merge holds
		// what the default writes.
		let position: common.Position = {
			start: parameter.position.start,
			end: defaultValue.position.end,
		}
		let argument = (): common.typedSimple.IdentifierNode => ({
			nodeType: "Identifier",
			name: simplified[index]!.internalName.name,
			type: recordType,
		})
		// The Argument's own value for a member the default does not supply,
		// which the caller must have written. Only the top level asks, but the
		// path keeps a deeper read correct.
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

		// The same helpers that give the Parameter's Type its `defaultMembers`
		// and `defaultNesting`, so what a call may leave out and what is filled
		// in agree.
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

			// One step only: `recordDefaultNesting` names nothing under a
			// default that is not a Literal.
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

		// The Argument itself may be `undefined` only where the default
		// supplies every member. Deeper steps always read optionally.
		let optional = supplied.size === declared(recordType).length

		// One level of the rebuilt Record. A member the default writes as a
		// Record Literal is rebuilt one level in, so a path key merges. See
		// "Record defaults" in DEVELOPMENT.md.
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

// The members a Record Type declares.
function declared(type: common.RecordType): Array<string> {
	return Object.keys(type.members)
}

// The Expression a Record default writes at one path, such as `server.port`.
// `recordDefaultNesting` makes every step but the last a Record Literal.
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

// The holes a call leaves where Parameters took their defaults, through the
// `openArgumentHoles` walk the Rewriter's dispatch branch shares.
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

// A body that can fall off its end promises unit, or the Validator reported
// `missing-return`. JavaScript would answer `undefined`, which is no Essence
// value, so the empty Record is returned explicitly.
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
	// Each Protocol-bounded Type Parameter appends a hidden trailing
	// Parameter, such as `Item__conformance`, in declaration order.
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
		// The prologue opens the body; `simplifyBody` only adds a closing
		// Return.
		body: [
			...recordDefaultPrologue(node.parameters, parameters),
			...simplifyBody(node.body),
		],
		returnType: node.returnType,
		...(node.completing === true ? { completing: true as const } : {}),
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

// One Module's test lowering, installed for the length of
// `simplifyTestsSection` and restored in `finally`. See "Test lowering" in
// DEVELOPMENT.md.
type TestLowering = {
	spans: Array<common.typedSimple.TestSpan>
	lines: Array<string>
	// The lines that end in a `§?` value comment, with the comment's
	// Position, read once per Module.
	valueComments: Map<number, common.Position>
	// The lines already probed, so a Statement the Enricher desugared into
	// several, such as `require MATCHER = EXPR`, answers its comment once.
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

// The Module path the section's identities are spelled against, read off the
// first item, since all of them carry the same one. Null when there is none.
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

// One Scope's run of Nodes. A test becomes an entry numbered by its place in
// the manifest, and a suite becomes a Scope of its own.
function simplifyTestsNodes(
	nodes: Array<common.typed.TestsNode>,
	tests: Array<common.typedSimple.TestManifestEntry>,
): Array<common.typedSimple.TestsNode> {
	return nodes.map((node) => {
		if (node.nodeType === "Test") {
			let index = tests.length
			let interpolated = node.name.nodeType === "InterpolatedStringValue"

			// A table test is one manifest entry per row and one emitted body,
			// which reads whichever row is running.
			if (node.table !== null) {
				for (let row = 0; row < node.table.rows.length; row++) {
					tests.push({
						...manifestEntry(node, interpolated),
						id: testIdentityKey(node.identity, row),
						key: relativeIdentityKey(node.identity, row),
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
					benchmark: node.form === "benchmark",
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
				key: relativeIdentityKey(node.identity),
				row: null,
			})

			// A property test is one manifest entry and one body, which the
			// runtime runs once per generated case.
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
				// Only an interpolated name; a plain one is in the manifest.
				name: interpolated ? simplifyExpression(node.name) : null,
				benchmark: node.form === "benchmark",
				// A Constant the test wrote is probed even without a `§?`, so
				// an editor can show each named step's value. A synthesized
				// Constant is a Matcher's subject, which its assertion reports.
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
			// Read off the manifest as it fills, since a table test pushes
			// one entry per row.
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

// A generator with its Expression leaves lowered: a refinement's checks and
// a `Generatable` call.
function simplifyTestGenerator(
	generator: common.typed.TestGenerator,
): common.typedSimple.TestGenerator {
	switch (generator.kind) {
		case "list":
			return {
				kind: "list",
				item: simplifyTestGenerator(generator.item),
			}
		case "dictionary":
			return {
				kind: "dictionary",
				key: simplifyTestGenerator(generator.key),
				value: simplifyTestGenerator(generator.value),
				...(generator.keyConformance === undefined
					? {}
					: {
							keyConformance: conformanceExpression(
								generator.keyConformance,
							),
						}),
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
				shrinkBinding: generator.shrinkBinding,
				shrink: simplifyExpression(generator.shrink),
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

// Everything a manifest entry says about a test but its identity, which is
// all a table test's rows share.
function manifestEntry(
	node: common.typed.TestNode,
	interpolated: boolean,
): Omit<common.typedSimple.TestManifestEntry, "id" | "key" | "row"> {
	return {
		name: node.identity.name,
		interpolated,
		suitePath: node.identity.suitePath,
		tags: node.tags,
		focused: node.focused !== null,
		skipped: node.skipped === null ? null : node.skipped.reason,
		benchmark: node.form === "benchmark",
		cases: node.cases,
		position: node.position,
		keywordPosition: node.keywordPosition,
	}
}

// Applies the Module's `§?` value comments to simplified Statements. A probe
// reaches into a Conditional's bodies but not a Function literal's, since it
// promises one value per line.
function probeStatements(
	nodes: Array<common.typedSimple.ImplementationNode>,
): Array<common.typedSimple.ImplementationNode> {
	return nodes.map((node) => probeStatement(node))
}

// `always` probes a written Constant of a test body even without a value
// comment.
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

	// A `§?` stands behind a Statement's last line.
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

	// Otherwise only an Expression Statement has a value to probe.
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

// One point per value comment, for whichever piece of the line asks first.
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

// One instrumented point in the Module's span table, with the source it
// covers, so no reader has to open the file again.
function testPoint(position: common.Position): number {
	let lowering = testLowering

	// Unreachable outside a tests section. A compiler bug here costs a point
	// with no span rather than the compile.
	if (lowering === null) {
		return -1
	}

	lowering.spans.push({
		position,
		source: sourceOfSpan(lowering.lines, position),
	})

	return lowering.spans.length - 1
}

// Essence Positions are 1-based, and the end column is one past the last
// character.
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

// `expect EXPR`, `require EXPR` and the Matcher and snapshot forms. Only the
// Boolean form is instrumented here; a Matcher's subject was instrumented as
// the Constant in front of it.
function simplifyAssertion(
	node: common.typed.ExpectStatementNode | common.typed.RequireStatementNode,
): common.typedSimple.TestAssertionStatementNode {
	let form =
		node.nodeType === "ExpectStatement"
			? ("expect" as const)
			: ("require" as const)
	// Asked of the typed node, where an overloaded `is` is not yet mangled.
	let operands = comparedOperands(node.value)
	// What a failure underlines: the asserted Expression, or the span from
	// the Matcher or the value to the end of the assertion.
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

	// A snapshot records the rendered value, which the Enricher already
	// built. Its `slot` point is where a run writes the recorded value.
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

// An assertion's Matcher as a `match` Handler, so one emission serves both.
// `compile-type-tests` fills `typeTest` and `memberTests` later.
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

// Where the two operands of an asserted comparison were written. Any
// one-Argument `is` or `isNot` that answers a Boolean counts as an equality.
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

// Wraps every call and member read in a point, so a failure reports what each
// part answered. A comparison's operands are wrapped whatever they are, since
// the diff needs both values.
function instrumentAssertion(
	value: common.typedSimple.ExpressionNode,
	operands: TestOperands | null,
	// Whether the outermost Expression gets a point. An asserted Boolean's
	// value is the assertion's own answer; a Matcher's subject needs one.
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

// A call's answer, a completed one included, and a member read are worth a
// point. A literal or a bare name shows nothing a report does not.
function isTraceable(node: common.typedSimple.ExpressionNode): boolean {
	return (
		node.nodeType === "MethodInvocation" ||
		node.nodeType === "UnionMethodInvocation" ||
		node.nodeType === "FunctionInvocation" ||
		node.nodeType === "Lookup" ||
		node.nodeType === "Complete"
	)
}

// The Expression positions an asserted Expression evaluates, and only those.
// A `match` is left whole. See "Assertion tracing" in DEVELOPMENT.md.
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
		case "DictionaryValue":
			return {
				...node,
				entries: node.entries.map((entry) => ({
					key: walk(entry.key),
					value: walk(entry.value),
				})),
			}
		case "CaseValue":
			return node.value === null
				? node
				: { ...node, value: walk(node.value) }
		// A `define` is Expressions throughout, so each Condition and answer
		// is traced. An arm that was not taken records nothing.
		case "Define":
			return {
				...node,
				arms: node.arms.map((arm) => ({
					...arm,
					condition: walk(arm.condition),
					value: walk(arm.value),
				})),
				otherwise: walk(node.otherwise),
			}
		case "InterpolatedStringValue":
			return {
				...node,
				segments: node.segments.map((segment) =>
					segment.kind === "expression"
						? { ...segment, expression: walk(segment.expression) }
						: segment,
				),
			}
		// The operand answers a Future, which a report can not show, so only
		// what it is built from is traced.
		case "Start":
		case "Complete":
			return {
				...node,
				expression: instrumentChildren(node.expression, walk),
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
