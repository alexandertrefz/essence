import {
	argumentPairingInverse,
	pairArguments,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import type { common } from "@essence-lang/interfaces"

import { typedAssertionExpressions } from "./assertionChildren"
import { defineConditions, defineValues } from "./defineArmChildren"
import { typedHandlerExpressions } from "./matchHandlerChildren"
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
		visitBody(body, null, state)
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
			// An annotation names the Record Type a literal is written for.
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
		case "ProtocolDeclarationStatement":
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
		// An assertion holds its Expressions directly; see `assertionChildren.ts`.
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of typedAssertionExpressions(node)) {
				visitNode(expression, null, state)
			}

			return
		case "RecordValue":
			visitRecordValue(node, expected, state, true)
			return
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
			// No labels for Methods: overload resolution is often still open while
			// typing, so no single signature has them. Record Arguments still work.
			visitNode(node.base, null, state)
			visitArguments(node.arguments, null, state)
			return
		case "Lookup":
			visitNode(node.base, null, state)
			return
		// The operand is a Future or a Started, which expects no Record shape.
		case "Start":
		case "Complete":
			visitNode(node.expression, null, state)
			return
		case "RefusedValue":
			visitNode(node.base, null, state)
			return
		case "Combination": {
			visitNode(node.lhs, expected, state)

			// An update's right-hand side is held to the left side's Type: every member
			// it names must exist there, even in an unannotated Constant.
			let base = asRecordType(node.lhs.type) ?? expected

			if (node.rhs.nodeType === "RecordValue") {
				visitRecordValue(
					node.rhs,
					base,
					state,
					opensOnBrace(node.rhs, state),
				)

				return
			}

			visitNode(node.rhs, base, state)
			return
		}
		case "Match":
			visitNode(node.value, null, state)

			for (let handler of node.handlers) {
				// A Guard and a Matcher's literals expect no Record shape.
				for (let expression of typedHandlerExpressions(handler)) {
					visitNode(expression, null, state)
				}

				visitBody(handler.body, expected, state)
			}

			return
		// Every arm answers the whole `define`, so it is held to what the position
		// expects. A Condition, like a Guard, expects no Record shape.
		case "Define":
			for (let value of defineValues(node)) {
				visitNode(value, expected, state)
			}

			for (let condition of defineConditions(node)) {
				visitNode(condition, null, state)
			}

			return
		case "ListValue": {
			let itemType = expected?.type === "List" ? expected.itemType : null

			for (let value of node.values) {
				visitNode(value, itemType, state)
			}

			return
		}
		case "DictionaryValue": {
			let dictionary = expected?.type === "Dictionary" ? expected : null

			for (let entry of node.entries) {
				visitNode(entry.key, dictionary?.keyType ?? null, state)
				visitNode(entry.value, dictionary?.valueType ?? null, state)
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
				// The payload is expected to be the Case's Record.
				visitNode(
					node.value,
					node.type.type === "Case"
						? { type: "Record", members: node.type.members }
						: null,
					state,
				)
			}

			return
		case "ChoiceDeclarationStatement":
			// A payload default is held to the payload's own Record, as a construction's
			// payload is.
			for (let choiceCase of node.cases) {
				if (choiceCase.defaultValue !== null) {
					visitNode(
						choiceCase.defaultValue,
						{ type: "Record", members: choiceCase.type.members },
						state,
					)
				}
			}

			return
		case "TypeAliasStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return
	}
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

	for (let [name, member] of Object.entries(node.members)) {
		visitNode(member, recordType.members[name] ?? null, state)
	}
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

// A call in a Parameter default offers the same labels and members as one in
// a body.
function visitDefaults(
	parameters: Array<common.typed.ParameterNode>,
	state: State,
) {
	for (let defaultValue of parameterDefaults(parameters)) {
		visitNode(defaultValue, null, state)
	}
}

// Arguments pair with Parameters by label once any may be left out:
// `f(to 3)` belongs to the second. `pairArguments` is the Compiler's walk.
function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	parameterTypes: common.BaseFunction["parameterTypes"] | null,
	state: State,
) {
	let parameterForArgument = pairedParameters(nodeArguments, parameterTypes)

	nodeArguments.forEach((argument, argumentIndex) => {
		let parameter =
			parameterTypes?.[
				parameterForArgument[argumentIndex] ?? argumentIndex
			]
		let parameterType = parameter?.type ?? null
		let expected =
			parameterType !== null && parameterType.type !== "GenericUse"
				? parameterType
				: null

		// The only place a Record Literal learns which members a default fills: the
		// Argument's own Parameter.
		if (argument.value.nodeType === "RecordValue") {
			visitRecordValue(
				argument.value,
				expected,
				state,
				true,
				parameter?.defaultMembers ?? [],
			)

			return
		}

		visitNode(argument.value, expected, state)
	})
}

// Exported for the path-key probe, which needs an Argument's Parameter to
// know which Record a key reaches into.
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

function asRecordType(type: common.Type | null): common.RecordType | null {
	return type !== null && type.type === "Record" ? type : null
}
