import {
	argumentPairingInverse,
	bindNamespaceTarget,
	pairArguments,
} from "@essence-lang/compiler/helpers"
import {
	forEachTypedChild,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common } from "@essence-lang/interfaces"

import { contains, isSmaller } from "./positions"
import { typedProgramBodies } from "./sections"

// What is expected at the cursor: inside a Record literal, the members of its
// Record Type; inside a Function Invocation, the callee's labels. Found by
// walking the enriched Program with each Expression's expected Type.

export type ArgumentContext =
	| {
			kind: "record"
			memberTypes: Record<string, common.Type>
			presentMembers: Array<string>
			// The members the Parameter's own default fills in, so Completion can say
			// which a call may leave out. Empty outside a call.
			omittableMembers: ReadonlyArray<string>
			// Whether a bare name is a whole member here: true in a Record Literal, where
			// `{ x }` is `{ x = x }`; false in an update's key list.
			shorthand: boolean
	  }
	| {
			kind: "arguments"
			parameters: common.BaseFunction["parameterTypes"]
			usedLabels: Array<string>
	  }

type State = {
	cursor: common.Cursor
	best: ArgumentContext | null
	bestPosition: common.Position | null
	// The document's lines. `{ base with a = 1 }` and `{ base with { a = 1 } }`
	// enrich to the same node, so only the opening character tells them apart.
	// Empty without a source, and then no shorthand is offered.
	lines: Array<string>
}

export function findArgumentContext(
	program: common.typed.Program,
	cursor: common.Cursor,
	lines: Array<string> = [],
): ArgumentContext | null {
	let state: State = {
		cursor,
		best: null,
		bestPosition: null,
		lines,
	}

	for (let body of typedProgramBodies(program)) {
		for (let node of body) {
			visitNode(node, null, state)
		}
	}

	return state.best
}

function consider(
	position: common.Position,
	context: ArgumentContext,
	state: State,
) {
	if (!contains(position, state.cursor)) {
		return
	}

	if (
		state.bestPosition !== null &&
		!isSmaller(position, state.bestPosition)
	) {
		return
	}

	state.best = context
	state.bestPosition = position
}

function visitNode(
	node: TypedNode,
	expected: common.Type | null,
	state: State,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			// An annotation names the Record Type a literal is written for.
			visitExpecting(node, "value", node.declaredType ?? node.type, state)
			return
		case "VariableAssignmentStatement":
			visitExpecting(node, "value", node.value.type, state)
			return
		case "ReturnStatement":
			visitExpecting(node, "expression", expected, state)
			return
		case "RecordValue":
			visitRecordValue(node, expected, state, true)
			return
		// Only a Function Invocation offers labels. A Method's overload resolution
		// is often still open while typing, so no single signature has them.
		case "FunctionInvocation":
			visitFunctionInvocation(node, state)
			return
		case "Combination": {
			// An update's right-hand side is held to the left side's Type: every member
			// it names must exist there, even in an unannotated Constant.
			let base = asRecordType(node.lhs.type) ?? expected

			forEachTypedChild(
				node,
				(child, state, field) => {
					if (field !== "rhs") {
						visitNode(
							child,
							field === "lhs" ? expected : null,
							state,
						)
					} else if (child.nodeType === "RecordValue") {
						visitRecordValue(
							child,
							base,
							state,
							opensOnBrace(child, state),
						)
					} else {
						visitNode(child, base, state)
					}
				},
				state,
			)

			return
		}
		// A Handler's body answers the whole `match`. A Guard and a Matcher's
		// literals expect no Record shape.
		case "Match":
			visitExpecting(node, "body", expected, state)
			return
		// Every arm answers the whole `define`, so it is held to what the position
		// expects. A Condition, like a Guard, expects no Record shape.
		case "Define":
			visitExpecting(node, "value", expected, state)
			return
		case "ListValue":
			visitExpecting(
				node,
				"values",
				expected?.type === "List" ? expected.itemType : null,
				state,
			)

			return
		case "DictionaryValue": {
			let dictionary = expected?.type === "Dictionary" ? expected : null

			forEachTypedChild(
				node,
				(child, state, field) =>
					visitNode(
						child,
						field === "key"
							? (dictionary?.keyType ?? null)
							: (dictionary?.valueType ?? null),
						state,
					),
				state,
			)

			return
		}
		// The payload is expected to be the Case's Record.
		case "CaseValue":
			visitExpecting(
				node,
				"value",
				node.type.type === "Case"
					? { type: "Record", members: node.type.members }
					: null,
				state,
			)

			return
		// A payload default is held to the payload's own Record, as a construction's
		// payload is.
		case "ChoiceDeclarationStatement":
			forEachTypedChild(
				node,
				(child, state, field, key) =>
					visitNode(
						child,
						field === "defaultValue"
							? {
									type: "Record",
									members:
										node.cases[key as number]!.type.members,
								}
							: null,
						state,
					),
				state,
			)

			return
	}

	forEachTypedChild(node, visitExpectingNothing, state)
}

function visitExpectingNothing(child: TypedNode, state: State) {
	visitNode(child, null, state)
}

// The children in `field` are held to `expected`; the rest expect nothing.
function visitExpecting(
	node: TypedNode,
	field: string,
	expected: common.Type | null,
	state: State,
) {
	forEachTypedChild(
		node,
		(child, state, childField) =>
			visitNode(child, childField === field ? expected : null, state),
		state,
	)
}

// One member list, a Record Literal or an update's key list. Only a Literal
// takes the shorthand, which the caller decides.
function visitRecordValue(
	node: common.typed.RecordValueNode,
	expected: common.Type | null,
	state: State,
	shorthand: boolean,
	omittableMembers: ReadonlyArray<string> = [],
) {
	let recordType = node.declaredType ?? asRecordType(expected) ?? node.type

	consider(
		node.position,
		{
			kind: "record",
			memberTypes: recordType.members,
			presentMembers: Object.keys(node.members),
			shorthand,
			omittableMembers,
		},
		state,
	)

	forEachTypedChild(
		node,
		(member, state, _field, name) =>
			visitNode(
				member,
				recordType.members[name as string] ?? null,
				state,
			),
		state,
	)
}

// Whether a member list is its own Record Literal, read off the character its
// Position opens on. A Literal opens on its `{` or on the Type it names, a key
// list on its first key. The text before the cursor matches the probe's.
function opensOnBrace(
	node: common.typed.RecordValueNode,
	state: State,
): boolean {
	if (node.declaredType !== null) {
		return true
	}

	let line = state.lines[node.position.start.line - 1]

	return line?.[node.position.start.column - 1] === "{"
}

// Arguments pair with Parameters by label once any may be left out:
// `f(to 3)` belongs to the second. `pairArguments` is the Compiler's walk.
function visitFunctionInvocation(
	node: common.typed.FunctionInvocationNode,
	state: State,
) {
	let calleeType = node.name.type
	let parameterTypes =
		calleeType.type === "Function" ? calleeType.parameterTypes : null

	if (parameterTypes !== null) {
		consider(
			node.position,
			{
				kind: "arguments",
				parameters: parameterTypes,
				usedLabels: node.arguments
					.map((argument) => argument.name)
					.filter((name): name is string => name !== null),
			},
			state,
		)
	}

	let parameterForArgument = pairedParameters(node.arguments, parameterTypes)

	forEachTypedChild(
		node,
		(child, state, field, index) => {
			if (field !== "arguments" || child.nodeType !== "Argument") {
				visitNode(child, null, state)
				return
			}

			let argumentIndex = index as number

			visitArgument(
				child,
				parameterTypes?.[
					parameterForArgument[argumentIndex] ?? argumentIndex
				],
				state,
			)
		},
		state,
	)
}

// The only place a Record Literal learns which members a default fills: the
// Argument's own Parameter.
function visitArgument(
	argument: common.typed.ArgumentNode,
	parameter: common.Parameter | undefined,
	state: State,
) {
	let parameterType = parameter?.type ?? null
	let expected =
		parameterType !== null && parameterType.type !== "GenericUse"
			? parameterType
			: null

	forEachTypedChild(
		argument,
		(value, state) => {
			if (value.nodeType === "RecordValue") {
				visitRecordValue(
					value,
					expected,
					state,
					true,
					parameter?.defaultMembers ?? [],
				)
			} else {
				visitNode(value, expected, state)
			}
		},
		state,
	)
}

// Which Parameter each Argument fills, by the Compiler's walk. Empty where
// no Parameter has a default, since each Argument then fills its place.
export function pairedParameters(
	nodeArguments: Array<common.typed.ArgumentNode>,
	parameterTypes: common.BaseFunction["parameterTypes"] | null,
): Array<number | undefined> {
	if (
		parameterTypes === null ||
		!parameterTypes.some((parameter) => parameter.hasDefault)
	) {
		return []
	}

	let pairing = pairArguments(
		parameterTypes,
		nodeArguments.map((argument) => ({
			name: argument.name,
			getType: () => argument.value.type,
		})),
	)

	// Inverted by the Compiler's helper, as `matchArguments` does, so the two
	// agree on which Parameter an Argument answers.
	return pairing === null ? [] : argumentPairingInverse(pairing)
}

// The signature a call resolved to, with its Parameters as its Arguments see
// them and what the receiver bound. A Method's receiver is its first
// Parameter.
export function calledSignature(invocation: TypedNode | undefined): {
	signature: common.BaseFunction
	parameters: Array<common.Parameter>
	bindings: Map<string, common.Type>
} | null {
	if (invocation?.nodeType === "FunctionInvocation") {
		let signature = signatureOf(
			invocation.name.type,
			invocation.overloadedMethodIndex,
		)

		return signature === null
			? null
			: {
					signature,
					parameters: signature.parameterTypes,
					bindings: new Map(),
				}
	}

	if (invocation?.nodeType !== "MethodInvocation" || invocation.dispatch) {
		return null
	}

	let namespace = invocation.namespace.type
	let signature = signatureOf(
		namespace.methods[invocation.member.name],
		invocation.overloadedMethodIndex,
	)

	if (signature === null) {
		return null
	}

	return {
		signature,
		parameters: signature.parameterTypes.slice(1),
		bindings:
			bindNamespaceTarget(
				{
					targetType: namespace.targetType,
					generics: namespace.generics,
				},
				invocation.base.type,
			) ?? new Map(),
	}
}

function signatureOf(
	type: common.Type | common.MethodType | undefined,
	overload: number | null,
): common.BaseFunction | null {
	switch (type?.type) {
		case "Function":
		case "StaticMethod":
		case "SimpleMethod":
			return type
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return overload === null ? null : (type.overloads[overload] ?? null)
		default:
			return null
	}
}

function asRecordType(type: common.Type | null): common.RecordType | null {
	return type !== null && type.type === "Record" ? type : null
}
