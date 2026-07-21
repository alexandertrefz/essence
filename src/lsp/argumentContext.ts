import type { common } from "../interfaces/index"
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
		case "NativeFunctionInvocation":
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
		case "FunctionValue":
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
		case "FractionValue":
		case "BooleanValue":
		case "NothingValue":
			return
	}
}

function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	parameterTypes: common.BaseFunction["parameterTypes"] | null,
	state: State,
) {
	nodeArguments.forEach((argument, argumentIndex) => {
		let parameterType = parameterTypes?.[argumentIndex]?.type ?? null

		visitNode(
			argument.value,
			parameterType !== null && parameterType.type !== "GenericUse"
				? parameterType
				: null,
			state,
		)
	})
}

function asRecordType(type: common.Type | null): common.RecordType | null {
	return type !== null && type.type === "Record" ? type : null
}
