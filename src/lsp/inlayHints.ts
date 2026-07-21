import type { common } from "../interfaces/index"
import { printType } from "./printType"

// NOTE: Inlay Hints annotate Constant and Variable declarations that carry no
// Type annotation with the Type they were inferred as.
//
// Parameter name hints — the other common use of Inlay Hints — would be dead
// weight in Essence: a Parameter either declares a label, which the call site
// is then required to write out, or it is declared label-less with `_` and has
// no name to show. Either way the call site already reads correctly.

export type InlayHint = {
	position: common.Cursor
	label: string
	kind: "type"
}

export function findInlayHints(
	program: common.typed.Program,
	range: common.Position | null = null,
): Array<InlayHint> {
	let hints: Array<InlayHint> = []

	visitBody(program.implementation.nodes, hints)

	if (range === null) {
		return hints
	}

	return hints.filter(
		(hint) =>
			hint.position.line >= range.start.line &&
			hint.position.line <= range.end.line,
	)
}

function visitBody(
	nodes: Array<common.typed.ImplementationNode>,
	hints: Array<InlayHint>,
) {
	for (let node of nodes) {
		visitNode(node, hints)
	}
}

function visitNode(
	node: common.typed.ImplementationNode,
	hints: Array<InlayHint>,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			// NOTE: `declaredType` is set exactly when the source spelled the
			// Type out — annotating an annotated declaration would be noise.
			// A failed inference is left alone rather than shown as `Error`.
			if (node.declaredType === null && node.type.type !== "Error") {
				hints.push({
					position: node.name.position.end,
					label: `: ${printType(node.type)}`,
					kind: "type",
				})
			}

			visitNode(node.value, hints)
			return
		case "VariableAssignmentStatement":
			visitNode(node.value, hints)
			return
		case "FunctionStatement":
			visitBody(node.value.body, hints)
			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				visitNode(property.value, hints)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					visitBody(method.value.body, hints)
				}
			}

			return
		case "IfStatement":
			visitNode(node.condition, hints)
			visitBody(node.body, hints)
			return
		case "IfElseStatement":
			visitNode(node.condition, hints)
			visitBody(node.trueBody, hints)
			visitBody(node.falseBody, hints)
			return
		case "ReturnStatement":
			visitNode(node.expression, hints)
			return
		case "FunctionInvocation":
			visitNode(node.name, hints)
			visitArguments(node.arguments, hints)
			return
		case "MethodInvocation":
			visitNode(node.base, hints)
			visitArguments(node.arguments, hints)
			return
		case "NativeFunctionInvocation":
			visitArguments(node.arguments, hints)
			return
		case "Lookup":
			visitNode(node.base, hints)
			return
		case "Combination":
			visitNode(node.lhs, hints)
			visitNode(node.rhs, hints)
			return
		case "Match":
			visitNode(node.value, hints)

			for (let handler of node.handlers) {
				visitBody(handler.body, hints)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				visitNode(member, hints)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				visitNode(value, hints)
			}

			return
		case "FunctionValue":
			visitBody(node.value.body, hints)
			return
		case "CaseValue":
			if (node.value !== null) {
				visitNode(node.value, hints)
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
		case "NothingValue":
			return
	}
}

function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	hints: Array<InlayHint>,
) {
	for (let argument of nodeArguments) {
		visitNode(argument.value, hints)
	}
}
