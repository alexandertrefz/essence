import type { common } from "../interfaces/index"
import { contains, isSmaller } from "./positions"
import { printType, withoutSelf } from "./printType"

// NOTE: Hovers are resolved on the enriched AST — every Expression carries
// its inferred Type there. The smallest typed node containing the cursor
// wins, so hovering an Identifier inside a larger Expression describes the
// Identifier, not the Expression around it.

export type HoverInfo = {
	position: common.Position
	content: string
}

type State = {
	cursor: common.Cursor
	best: HoverInfo | null
}

export function findHover(
	program: common.typed.Program,
	cursor: common.Cursor,
): HoverInfo | null {
	let state: State = { cursor, best: null }

	visitBody(program.implementation.nodes, state)

	return state.best
}

function consider(
	state: State,
	position: common.Position,
	type: common.Type,
	label: string | null,
) {
	if (!contains(position, state.cursor)) {
		return
	}

	// NOTE: Ties go to the newer candidate — children are visited after
	// their parents, so the deeper node wins.
	if (state.best !== null && isSmaller(state.best.position, position)) {
		return
	}

	state.best = {
		position,
		content:
			label === null ? printType(type) : `${label}: ${printType(type)}`,
	}
}

/***********/
/* Walkers */
/***********/

function visitBody(
	nodes: Array<common.typed.ImplementationNode>,
	state: State,
) {
	for (let node of nodes) {
		visitNode(node, state)
	}
}

function visitNode(node: common.typed.ImplementationNode, state: State) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			consider(state, node.position, node.type, node.name.content)
			visitIdentifier(node.name, state)
			visitNode(node.value, state)
			return
		case "VariableAssignmentStatement":
			visitIdentifier(node.name, state)
			visitNode(node.value, state)
			return
		case "FunctionStatement":
			consider(state, node.position, node.type, node.name.content)
			visitIdentifier(node.name, state)
			visitFunctionDefinition(node.value, state)
			return
		case "NamespaceDefinitionStatement":
			consider(state, node.position, node.type, node.name.content)
			visitIdentifier(node.name, state)

			for (let property of Object.values(node.properties)) {
				visitNode(property.value, state)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					consider(state, method.position, method.type, null)
					visitFunctionDefinition(method.value, state)
				}
			}

			return
		case "TypeAliasStatement":
			consider(state, node.position, node.type, node.name.content)
			visitIdentifier(node.name, state)
			return
		case "IfStatement":
			visitNode(node.condition, state)
			visitBody(node.body, state)
			return
		case "IfElseStatement":
			visitNode(node.condition, state)
			visitBody(node.trueBody, state)
			visitBody(node.falseBody, state)
			return
		case "ReturnStatement":
			visitNode(node.expression, state)
			return
		case "Identifier":
			visitIdentifier(node, state)
			return
		case "NativeFunctionInvocation":
			consider(state, node.position, node.type, null)
			visitIdentifier(node.name, state)
			visitArguments(node.arguments, state)
			return
		case "MethodInvocation": {
			consider(state, node.position, node.type, null)
			visitNode(node.base, state)

			// NOTE: The Method name resolves through the Namespace — with an
			// overload the invoked signature is picked out for the Hover.
			let memberType = methodType(node)

			if (memberType !== null) {
				consider(
					state,
					node.member.position,
					memberType,
					node.member.name,
				)
			}

			visitArguments(node.arguments, state)
			return
		}
		case "FunctionInvocation":
			consider(state, node.position, node.type, null)
			visitNode(node.name, state)
			visitArguments(node.arguments, state)
			return
		case "Lookup":
			consider(state, node.position, node.type, null)
			visitNode(node.base, state)
			visitIdentifier(node.member, state)
			return
		case "Combination":
			consider(state, node.position, node.type, null)
			visitNode(node.lhs, state)
			visitNode(node.rhs, state)
			return
		case "Match":
			consider(state, node.position, node.type, null)
			visitNode(node.value, state)

			for (let handler of node.handlers) {
				visitBody(handler.body, state)
			}

			return
		case "RecordValue":
			consider(state, node.position, node.type, null)

			for (let member of Object.values(node.members)) {
				visitNode(member, state)
			}

			return
		case "ListValue":
			consider(state, node.position, node.type, null)

			for (let value of node.values) {
				visitNode(value, state)
			}

			return
		case "FunctionValue":
			consider(state, node.position, node.type, null)
			visitFunctionDefinition(node.value, state)
			return
		case "Self":
			consider(state, node.position, node.type, "@")
			return
		case "StringValue":
		case "IntegerValue":
		case "FractionValue":
		case "BooleanValue":
		case "NothingValue":
			consider(state, node.position, node.type, null)
			return
	}
}

function visitIdentifier(node: common.typed.IdentifierNode, state: State) {
	consider(state, node.position, node.type, node.content)
}

function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	state: State,
) {
	for (let argument of nodeArguments) {
		visitNode(argument.value, state)
	}
}

function visitFunctionDefinition(
	definition: common.typed.FunctionDefinitionNode,
	state: State,
) {
	for (let parameter of definition.parameters) {
		if (
			parameter.externalName !== null &&
			parameter.externalName !== parameter.internalName
		) {
			visitIdentifier(parameter.externalName, state)
		}

		if (parameter.internalName !== null) {
			visitIdentifier(parameter.internalName, state)
		}
	}

	visitBody(definition.body, state)
}

function methodType(
	node: common.typed.MethodInvocationNode,
): common.Type | null {
	let memberType = node.namespace.type.methods[node.member.name]

	if (memberType === undefined) {
		return null
	}

	switch (memberType.type) {
		case "SimpleMethod":
			return { ...memberType, ...withoutSelf(memberType) }
		case "StaticMethod":
			return memberType
		case "OverloadedMethod":
		case "OverloadedStaticMethod": {
			let overloads =
				memberType.type === "OverloadedMethod"
					? memberType.overloads.map(withoutSelf)
					: memberType.overloads

			// NOTE: With a resolved overload only the invoked signature is
			// shown, packaged as a plain Function Type.
			if (node.overloadedMethodIndex !== null) {
				let overload = overloads[node.overloadedMethodIndex]

				if (overload !== undefined) {
					return { type: "Function", ...overload }
				}
			}

			return { ...memberType, overloads }
		}
	}
}
