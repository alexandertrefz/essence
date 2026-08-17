import {
	argumentPairingInverse,
	pairArguments,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import type { common } from "@essence-lang/interfaces"

import { typedHandlerExpressions } from "./matchHandlerChildren"
import { contains, isSmaller } from "./positions"

// NOTE: Two completion contexts need to know what is *expected* at the
// cursor rather than what is in Scope:
//
// - Inside a Record literal, the members of the Record Type it is being
//   written for.
// - Inside a Function Invocation, the Parameter labels of the callee.
//
// Both are found by walking the enriched Program while carrying the Type
// each Expression is expected to have — a Record literal picks it up from
// its own annotation, from the declaration it is assigned to, or from the
// Parameter it is passed as. The innermost construct containing the cursor
// wins, so `greet({ … })` offers Record members inside the braces and
// Argument labels outside them.

export type ArgumentContext =
	| {
			kind: "record"
			memberTypes: Record<string, common.Type>
			presentMembers: Array<string>
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
}

export function findArgumentContext(
	program: common.typed.Program,
	cursor: common.Cursor,
): ArgumentContext | null {
	let state: State = { cursor, best: null, bestPosition: null }

	visitBody(program.implementation.nodes, null, state)

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

function visitBody(
	nodes: Array<common.typed.ImplementationNode>,
	expected: common.Type | null,
	state: State,
) {
	for (let node of nodes) {
		visitNode(node, expected, state)
	}
}

function visitNode(
	node: common.typed.ImplementationNode,
	expected: common.Type | null,
	state: State,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			// NOTE: An annotated declaration is what tells a Record literal
			// which Record Type it is written for.
			visitNode(node.value, node.declaredType ?? node.type, state)
			return
		case "VariableAssignmentStatement":
			visitNode(node.value, node.value.type, state)
			return
		case "FunctionStatement":
			visitDefaults(node.value.parameters, state)
			visitBody(node.value.body, null, state)
			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				visitNode(property.value, null, state)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					visitDefaults(method.value.parameters, state)
					visitBody(method.value.body, null, state)
				}
			}

			for (let shim of node.nativeShims) {
				visitDefaults(shim.parameters, state)
			}

			return
		case "IfStatement":
			visitNode(node.condition, null, state)
			visitBody(node.body, null, state)
			return
		case "IfElseStatement":
			visitNode(node.condition, null, state)
			visitBody(node.trueBody, null, state)
			visitBody(node.falseBody, null, state)
			return
		case "ReturnStatement":
			visitNode(node.expression, expected, state)
			return
		case "RecordValue": {
			let recordType =
				node.declaredType ?? asRecordType(expected) ?? node.type

			consider(
				node.position,
				{
					kind: "record",
					memberTypes: recordType.members,
					presentMembers: Object.keys(node.members),
				},
				state,
			)

			for (let [name, member] of Object.entries(node.members)) {
				visitNode(member, recordType.members[name] ?? null, state)
			}

			return
		}
		case "FunctionInvocation": {
			let calleeType = node.name.type

			if (calleeType.type === "Function") {
				consider(
					node.position,
					{
						kind: "arguments",
						parameters: calleeType.parameterTypes,
						usedLabels: node.arguments
							.map((argument) => argument.name)
							.filter((name): name is string => name !== null),
					},
					state,
				)
			}

			visitNode(node.name, null, state)
			visitArguments(
				node.arguments,
				calleeType.type === "Function"
					? calleeType.parameterTypes
					: null,
				state,
			)
			return
		}
		case "MethodInvocation":
			// NOTE: No Argument labels for Methods — the receiver occupies the
			// first Parameter slot and overload resolution is often still
			// ambiguous while typing, so there is no single signature to read
			// labels off. Record literals passed as Arguments still work.
			visitNode(node.base, null, state)
			visitArguments(node.arguments, null, state)
			return
		case "Lookup":
			visitNode(node.base, null, state)
			return
		case "Combination":
			visitNode(node.lhs, expected, state)
			visitNode(node.rhs, expected, state)
			return
		case "Match":
			visitNode(node.value, null, state)

			for (let handler of node.handlers) {
				// NOTE: A Guard is a Boolean and a Matcher's literals are plain
				// values — neither expects a Record shape of its own, so what
				// the Match is expected to produce says nothing about them.
				for (let expression of typedHandlerExpressions(handler)) {
					visitNode(expression, null, state)
				}

				visitBody(handler.body, expected, state)
			}

			return
		case "ListValue": {
			let itemType = expected?.type === "List" ? expected.itemType : null

			for (let value of node.values) {
				visitNode(value, itemType, state)
			}

			return
		}
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					visitNode(segment.expression, null, state)
				}
			}

			return
		case "FunctionValue":
			visitDefaults(node.value.parameters, state)
			visitBody(node.value.body, null, state)
			return
		case "CaseValue":
			if (node.value !== null) {
				// NOTE: The payload's expected shape is the Case's Record —
				// that is what makes labels complete inside the payload.
				visitNode(
					node.value,
					node.type.type === "Case"
						? { type: "Record", members: node.type.members }
						: null,
					state,
				)
			}

			return
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return
	}
}

// NOTE: A call written inside a Parameter's `= expression` default offers the
// same labels and the same Record members a call in a body does — the walk below
// reaches bodies, and a default is not one.
function visitDefaults(
	parameters: Array<common.typed.ParameterNode>,
	state: State,
) {
	for (let defaultValue of parameterDefaults(parameters)) {
		visitNode(defaultValue, null, state)
	}
}

// NOTE: An Argument is paired with a Parameter by its LABEL once anything may be
// left out — `f(to 3)` writes one Argument and it belongs to the SECOND
// Parameter — so the Types a Record literal is read against are handed over
// through that pairing rather than by index. `pairArguments` is the Compiler's
// own walk, and using it here is what keeps Completion agreeing with what the
// call will actually resolve to.
function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	parameterTypes: common.BaseFunction["parameterTypes"] | null,
	state: State,
) {
	let parameterForArgument = pairedParameters(nodeArguments, parameterTypes)

	nodeArguments.forEach((argument, argumentIndex) => {
		let parameterType =
			parameterTypes?.[
				parameterForArgument[argumentIndex] ?? argumentIndex
			]?.type ?? null

		visitNode(
			argument.value,
			parameterType !== null && parameterType.type !== "GenericUse"
				? parameterType
				: null,
			state,
		)
	})
}

function pairedParameters(
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

	// NOTE: Inverted by the Compiler's own helper, which is the same inversion
	// `matchArguments` performs to name the Parameter a mismatching Argument was
	// held to — one walk, so the two can not disagree about which Parameter an
	// Argument answers.
	return pairing === null ? [] : argumentPairingInverse(pairing)
}

function asRecordType(type: common.Type | null): common.RecordType | null {
	return type !== null && type.type === "Record" ? type : null
}
