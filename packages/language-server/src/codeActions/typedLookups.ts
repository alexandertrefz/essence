import { caseDefaults } from "@essence-lang/compiler/helpers"
import type { common } from "@essence-lang/interfaces"

import { typedAssertionExpressions } from "../assertionChildren"
import { defineExpressions } from "../defineArmChildren"
import { typedHandlerExpressions } from "../matchHandlerChildren"
import { isSamePosition } from "../positions"
import { typedProgramBodies } from "../sections"

// NOTE: What the TYPED Program says about a span the source wrote. Every lookup
// beside this one reads the Parser AST, because an edit is written into text
// and the typed tree erases and rewrites what the text says — but a refactoring
// that has to SPELL a Type has nowhere else to ask, and the Positions are the
// source's own either way.

export function typedExpressionAt(
	program: common.typed.Program,
	position: common.Position,
): common.typed.ExpressionNode | null {
	let found: common.typed.ExpressionNode | null = null

	for (let body of typedProgramBodies(program)) {
		visitBody(body, (node) => {
			// NOTE: The FIRST match wins, which is the outermost of the Nodes
			// sharing a span — a Method Invocation and its base Identifier
			// stand at the same Position when the call has no receiver written
			// in front of it, and what a caller asking about a span means is
			// the whole of what stands there.
			if (found === null && isSamePosition(node.position, position)) {
				found = node
			}
		})
	}

	return found
}

function visitBody(
	nodes: Array<common.typed.ImplementationNode>,
	visit: (node: common.typed.ExpressionNode) => void,
) {
	for (let node of nodes) {
		visitNode(node, visit)
	}
}

// NOTE: The same walk `findInlayHints` makes, which is the one that reaches
// every Expression of a typed Program — a form missing from it is a form this
// answers nothing about.
function visitNode(
	node: common.typed.ImplementationNode,
	visit: (node: common.typed.ExpressionNode) => void,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			visitNode(node.value, visit)
			return
		case "FunctionStatement":
			visitFunctionDefinition(node.value, visit)
			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				visitNode(property.value, visit)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					visitFunctionDefinition(method.value, visit)
				}
			}

			return
		case "IfStatement":
			visitNode(node.condition, visit)
			visitBody(node.body, visit)
			return
		case "IfElseStatement":
			visitNode(node.condition, visit)
			visitBody(node.trueBody, visit)
			visitBody(node.falseBody, visit)
			return
		case "ReturnStatement":
			visitNode(node.expression, visit)
			return
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of typedAssertionExpressions(node)) {
				visitNode(expression, visit)
			}

			return
		case "ChoiceDeclarationStatement":
			for (let defaultValue of caseDefaults(node.cases)) {
				visitNode(defaultValue, visit)
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
					visitFunctionDefinition(method.value, visit)
				}
			}

			return
		case "TypeAliasStatement":
			return
	}

	visit(node)

	switch (node.nodeType) {
		case "FunctionInvocation":
			visitNode(node.name, visit)
			visitArguments(node.arguments, visit)
			return
		case "MethodInvocation":
			visitNode(node.base, visit)
			visitArguments(node.arguments, visit)
			return
		case "Lookup":
			visitNode(node.base, visit)
			return
		case "Start":
		case "Complete":
			visitNode(node.expression, visit)
			return
		case "RefusedValue":
			visitNode(node.base, visit)
			return
		case "Combination":
			visitNode(node.lhs, visit)
			visitNode(node.rhs, visit)
			return
		case "Match":
			visitNode(node.value, visit)

			for (let handler of node.handlers) {
				for (let expression of typedHandlerExpressions(handler)) {
					visitNode(expression, visit)
				}

				visitBody(handler.body, visit)
			}

			return
		case "Define":
			for (let expression of defineExpressions(node)) {
				visitNode(expression, visit)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				visitNode(member, visit)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				visitNode(value, visit)
			}

			return
		case "DictionaryValue":
			for (let entry of node.entries) {
				visitNode(entry.key, visit)
				visitNode(entry.value, visit)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					visitNode(segment.expression, visit)
				}
			}

			return
		case "FunctionValue":
			visitFunctionDefinition(node.value, visit)
			return
		case "CaseValue":
			if (node.value !== null) {
				visitNode(node.value, visit)
			}

			return
		default:
			return
	}
}

function visitFunctionDefinition(
	definition: common.typed.FunctionDefinitionNode,
	visit: (node: common.typed.ExpressionNode) => void,
) {
	for (let parameter of definition.parameters) {
		if (parameter.defaultValue !== null) {
			visitNode(parameter.defaultValue, visit)
		}
	}

	visitBody(definition.body, visit)
}

function visitArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	visit: (node: common.typed.ExpressionNode) => void,
) {
	for (let argument of nodeArguments) {
		visitNode(argument.value, visit)
	}
}
