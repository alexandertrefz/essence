import type { common, parser } from "../interfaces"
import { contains } from "./positions"

// NOTE: "Expand selection" wants the chain of ever-larger constructs
// containing the cursor. Collecting every Position on the path down the
// Parser AST gives exactly that, innermost first — the client turns the chain
// into nested ranges and steps through them.

export function findSelectionRanges(
	program: parser.Program,
	cursor: common.Cursor,
): Array<common.Position> {
	let chain: Array<common.Position> = []

	if (contains(program.implementation.position, cursor)) {
		chain.push(program.implementation.position)
		collectFromBody(program.implementation.nodes, cursor, chain)
	}

	// NOTE: Innermost first, and duplicates dropped — a Statement wrapping a
	// single Expression often shares its Position exactly.
	return dropRepeats(chain.reverse())
}

function dropRepeats(
	positions: Array<common.Position>,
): Array<common.Position> {
	return positions.filter((position, positionIndex) => {
		let previous = positions[positionIndex - 1]

		return (
			previous === undefined ||
			previous.start.line !== position.start.line ||
			previous.start.column !== position.start.column ||
			previous.end.line !== position.end.line ||
			previous.end.column !== position.end.column
		)
	})
}

function collectFromBody(
	nodes: Array<parser.ImplementationNode>,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	for (let node of nodes) {
		if (contains(node.position, cursor)) {
			chain.push(node.position)
			collectFromNode(node, cursor, chain)
			return
		}
	}
}

function collectFromNode(
	node: parser.ImplementationNode,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			descend(node.value, cursor, chain)
			return
		case "FunctionStatement":
			collectFromBody(node.value.body, cursor, chain)
			return
		case "NamespaceDefinitionStatement": {
			for (let property of Object.values(node.properties)) {
				descend(property.value, cursor, chain)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					if (contains(method.position, cursor)) {
						chain.push(method.position)
						collectFromBody(method.value.body, cursor, chain)
						return
					}
				}
			}

			return
		}
		case "IfStatement":
			descend(node.condition, cursor, chain)
			collectFromBody(node.body, cursor, chain)
			return
		case "IfElseStatement":
			descend(node.condition, cursor, chain)
			collectFromBody(node.trueBody, cursor, chain)
			collectFromBody(node.falseBody, cursor, chain)
			return
		case "ReturnStatement":
			descend(node.expression, cursor, chain)
			return
		case "Match":
			descend(node.value, cursor, chain)

			for (let handler of node.handlers) {
				collectFromBody(handler.body, cursor, chain)
			}

			return
		case "FunctionValue":
			collectFromBody(node.value.body, cursor, chain)
			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				descend(member.value, cursor, chain)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				descend(value, cursor, chain)
			}

			return
		case "MethodInvocation":
			descend(node.base, cursor, chain)
			descendArguments(node.arguments, cursor, chain)
			return
		case "FunctionInvocation":
			descend(node.name, cursor, chain)
			descendArguments(node.arguments, cursor, chain)
			return
		case "NativeFunctionInvocation":
			descendArguments(node.arguments, cursor, chain)
			return
		case "Combination":
			descend(node.lhs, cursor, chain)
			descend(node.rhs, cursor, chain)
			return
		case "Lookup":
			descend(node.base, cursor, chain)
			return
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

function descend(
	node: parser.ImplementationNode,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	if (!contains(node.position, cursor)) {
		return
	}

	chain.push(node.position)
	collectFromNode(node, cursor, chain)
}

function descendArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	cursor: common.Cursor,
	chain: Array<common.Position>,
) {
	for (let argument of nodeArguments) {
		descend(argument.value, cursor, chain)
	}
}
