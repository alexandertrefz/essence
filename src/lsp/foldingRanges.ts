import type { common, parser } from "../interfaces/index"

// NOTE: Folding is derived from the Parser AST, so it keeps working while the
// Program has Type errors. Only constructs that span more than one line are
// worth folding, and the last line is excluded so that the closing brace
// stays visible when the range is collapsed.

export type FoldingRange = {
	startLine: number
	endLine: number
}

export function findFoldingRanges(
	program: parser.Program,
): Array<FoldingRange> {
	let ranges: Array<FoldingRange> = []

	// NOTE: The `implementation { … }` block itself is foldable too.
	addRange(ranges, program.implementation.position)
	collectFromBody(program.implementation.nodes, ranges)

	return ranges
}

function addRange(ranges: Array<FoldingRange>, position: common.Position) {
	if (position.end.line <= position.start.line) {
		return
	}

	ranges.push({
		startLine: position.start.line,
		endLine: position.end.line - 1,
	})
}

function collectFromBody(
	nodes: Array<parser.ImplementationNode>,
	ranges: Array<FoldingRange>,
) {
	for (let node of nodes) {
		collectFromNode(node, ranges)
	}
}

function collectFromNode(
	node: parser.ImplementationNode,
	ranges: Array<FoldingRange>,
) {
	switch (node.nodeType) {
		case "FunctionStatement":
			addRange(ranges, node.position)
			collectFromBody(node.value.body, ranges)
			return
		case "NamespaceDefinitionStatement": {
			addRange(ranges, node.position)

			for (let property of Object.values(node.properties)) {
				collectFromNode(property.value, ranges)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					addRange(ranges, method.position)
					collectFromBody(method.value.body, ranges)
				}
			}

			return
		}
		case "TypeAliasStatement":
			addRange(ranges, node.position)
			return
		case "ProtocolDeclarationStatement":
			addRange(ranges, node.position)
			return
		case "IfStatement":
			addRange(ranges, node.position)
			collectFromNode(node.condition, ranges)
			collectFromBody(node.body, ranges)
			return
		case "IfElseStatement":
			// NOTE: One range for the whole Statement — the Parser keeps no
			// Position for the `else` keyword, so the branches cannot be
			// folded separately.
			addRange(ranges, node.position)
			collectFromNode(node.condition, ranges)
			collectFromBody(node.trueBody, ranges)
			collectFromBody(node.falseBody, ranges)
			return
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			collectFromNode(node.value, ranges)
			return
		case "ReturnStatement":
			collectFromNode(node.expression, ranges)
			return
		case "Match":
			addRange(ranges, node.position)
			collectFromNode(node.value, ranges)

			for (let handler of node.handlers) {
				collectFromBody(handler.body, ranges)
			}

			return
		case "FunctionValue":
			addRange(ranges, node.position)
			collectFromBody(node.value.body, ranges)
			return
		case "RecordValue":
			addRange(ranges, node.position)

			for (let member of Object.values(node.members)) {
				collectFromNode(member.value, ranges)
			}

			return
		case "ListValue":
			addRange(ranges, node.position)

			for (let value of node.values) {
				collectFromNode(value, ranges)
			}

			return
		case "MethodInvocation":
			addRange(ranges, node.position)
			collectFromNode(node.base, ranges)
			collectFromArguments(node.arguments, ranges)
			return
		case "FunctionInvocation":
			addRange(ranges, node.position)
			collectFromNode(node.name, ranges)
			collectFromArguments(node.arguments, ranges)
			return
		case "NativeFunctionInvocation":
			addRange(ranges, node.position)
			collectFromArguments(node.arguments, ranges)
			return
		case "Combination":
			collectFromNode(node.lhs, ranges)
			collectFromNode(node.rhs, ranges)
			return
		case "Lookup":
			collectFromNode(node.base, ranges)
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

function collectFromArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	ranges: Array<FoldingRange>,
) {
	for (let argument of nodeArguments) {
		collectFromNode(argument.value, ranges)
	}
}
