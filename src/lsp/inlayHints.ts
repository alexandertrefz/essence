import type { common } from "../interfaces/index"
import { printType } from "./printType"

// NOTE: Inlay Hints annotate whatever carries no Type annotation with the Type
// it was inferred as — Constant and Variable declarations, and the Parameters
// and return Type of a contextually typed Function literal, which take their
// Types from the signature they are passed to and so show them nowhere in the
// source.
//
// Parameter *name* hints — the other common use of Inlay Hints — would be dead
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
			if (
				node.declaredType === null &&
				node.type.type !== "Error" &&
				!writesItsOwnType(node.value)
			) {
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
			visitFunctionDefinition(node.value, hints)
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
					visitFunctionDefinition(method.value, hints)
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
			visitFunctionDefinition(node.value, hints)
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

// NOTE: A Function literal that annotates itself in full already shows its
// whole Type at the declaration — repeating that Type beside the name says
// nothing the line does not already say, and says it at the width of a
// signature. A literal that left an annotation out is the opposite case: the
// hint beside the name is then the only place the Type appears, so it stays.
function writesItsOwnType(value: common.typed.ExpressionNode): boolean {
	if (value.nodeType !== "FunctionValue") {
		return false
	}

	return (
		value.value.inferredReturnType === null &&
		value.value.parameters.every(
			(parameter) => parameter.inferredType === null,
		)
	)
}

// NOTE: `inferredType` and `inferredReturnType` are set exactly when the
// source left the annotation out, mirroring `declaredType` on a Constant.
// A failed inference is left alone rather than shown as `Error`.
//
// The Parameter hint sits at the end of the Parameter, which for an
// unannotated one is the end of its name; the return hint sits at the end of
// the Parameter list, where the `-> Type` would have been written.
function visitFunctionDefinition(
	definition: common.typed.FunctionDefinitionNode,
	hints: Array<InlayHint>,
) {
	for (let parameter of definition.parameters) {
		if (
			parameter.inferredType !== null &&
			parameter.inferredType.type !== "Error"
		) {
			hints.push({
				position: parameter.position.end,
				label: `: ${printType(parameter.inferredType)}`,
				kind: "type",
			})
		}
	}

	if (
		definition.inferredReturnType !== null &&
		definition.inferredReturnType.type !== "Error"
	) {
		hints.push({
			position: definition.parameterListPosition.end,
			label: ` -> ${printType(definition.inferredReturnType)}`,
			kind: "type",
		})
	}

	visitBody(definition.body, hints)
}

function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	hints: Array<InlayHint>,
) {
	for (let argument of nodeArguments) {
		visitNode(argument.value, hints)
	}
}
