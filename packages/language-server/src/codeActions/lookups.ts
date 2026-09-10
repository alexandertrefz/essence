import {
	caseDefaults,
	memberExpression,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { assertionExpressions } from "../assertionChildren"
import { defineExpressions } from "../defineArmChildren"
import { matcherValueExpressions } from "../matchHandlerChildren"
import { methodsOf, nativeSignaturesOf } from "../namespaceMembers"
import { isSamePosition } from "../positions"
import { programBodies } from "../sections"

// NOTE: Which Node of the Parser AST stands at a Position — the question every
// Quick Fix opens with, since a Diagnostic names the Node it was reported
// against — and the walk each of the answers is written over.

export type Handler = parser.MatchNode["handlers"][number]

export function handlerBodyEnd(handler: Handler): common.Cursor {
	let last = handler.body[handler.body.length - 1]

	if (last !== undefined) {
		return last.position.end
	}

	return (handler.guard ?? handler.matcher).position.end
}

export function bodyReturns(body: Array<parser.ImplementationNode>): boolean {
	return body.some(
		(node) =>
			node.nodeType === "ReturnStatement" ||
			(node.nodeType === "IfElseStatement" &&
				bodyReturns(node.trueBody) &&
				bodyReturns(node.falseBody)),
	)
}

export function findMatch(
	program: parser.Program,
	position: common.Position,
): parser.MatchNode | null {
	let found: parser.MatchNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType === "Match" &&
			isSamePosition(node.position, position)
		) {
			found = node
		}
	})

	return found
}

export function findHandler(
	program: parser.Program,
	matcherPosition: common.Position,
): Handler | null {
	let found: Handler | null = null

	walk(program, (node) => {
		if (node.nodeType !== "Match") {
			return
		}

		for (let handler of node.handlers) {
			if (isSamePosition(handler.matcher.position, matcherPosition)) {
				found = handler
			}
		}
	})

	return found
}

export function findConstantDeclaration(
	program: parser.Program,
	namePosition: common.Position,
): parser.ConstantDeclarationStatementNode | null {
	let found: parser.ConstantDeclarationStatementNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType === "ConstantDeclarationStatement" &&
			isSamePosition(node.name.position, namePosition)
		) {
			found = node
		}
	})

	return found
}

// NOTE: The Node standing at exactly this Position — matched by Position rather
// than by containment, as the finders beside it are, since what a fix reported
// against one Node needs is that Node and not whatever encloses it. Where two
// Nodes share a span the outer one answers, which is the first the walk reaches.
export function findNodeAt(
	program: parser.Program,
	position: common.Position,
): parser.ImplementationNode | null {
	let found: parser.ImplementationNode | null = null

	walk(program, (node) => {
		if (found === null && isSamePosition(node.position, position)) {
			found = node
		}
	})

	return found
}

// NOTE: Matched by Position exactly rather than by containment. A
// `missing-return` names the Node the Validator was looking at — a Function
// Statement, a Function literal, a Method — and a Match Handler that does not
// return reports under the Match's Position, which no Function ever shares.
// Containment would answer that one with the enclosing Function and offer an
// Else branch nowhere near the hole.
export function findFunctionDefinition(
	program: parser.Program,
	position: common.Position,
): parser.FunctionDefinitionNode | null {
	let found: parser.FunctionDefinitionNode | null = null

	walk(program, (node) => {
		if (!isSamePosition(node.position, position)) {
			return
		}

		if (node.nodeType === "FunctionStatement") {
			found = node.value
		} else if (node.nodeType === "FunctionValue") {
			found = node.value
		}
	})

	return found
}

// NOTE: Every Node of the Parser AST, in no particular order — the lookups
// above all ask "which Node is at this Position", which nothing about the
// shape of the tree helps answer faster. Written over the Parser AST rather
// than the typed one because a Quick Fix edits text: the typed AST erases
// annotations and rewrites Nodes the source never wrote.
export function walk(
	program: parser.Program,
	visit: (node: parser.ImplementationNode) => void,
) {
	for (let body of programBodies(program)) {
		walkBody(body, visit)
	}
}

function walkBody(
	nodes: Array<parser.ImplementationNode>,
	visit: (node: parser.ImplementationNode) => void,
) {
	for (let node of nodes) {
		walkNode(node, visit)
	}
}

// NOTE: A Parameter's `= expression` default holds Expressions the same Quick
// Fixes apply to as any body's — an unknown name inside one has the same
// suggestion, an auto-import the same edit. Silently missed otherwise: the walk
// below descends into bodies, and a default is not one.
function walkDefaults(
	parameters: Array<parser.ParameterNode>,
	visit: (node: parser.ImplementationNode) => void,
) {
	for (let defaultValue of parameterDefaults(parameters)) {
		walkNode(defaultValue, visit)
	}
}

export function walkNode(
	node: parser.ImplementationNode,
	visit: (node: parser.ImplementationNode) => void,
) {
	visit(node)

	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			walkNode(node.value, visit)
			return
		case "FunctionStatement":
			walkDefaults(node.value.parameters, visit)
			walkBody(node.value.body, visit)
			return
		case "ChoiceDeclarationStatement":
			// NOTE: A Case payload's default holds the Expressions the same
			// Quick Fixes apply to as any body's — an unknown name in one takes
			// the same suggestion, an auto-import the same edit.
			for (let defaultValue of caseDefaults(node.cases)) {
				walkNode(defaultValue, visit)
			}

			return
		case "NamespaceDefinitionStatement": {
			for (let property of Object.values(node.properties)) {
				if (property.value !== null) {
					walkNode(property.value, visit)
				}
			}

			for (let member of Object.values(node.methods)) {
				for (let method of methodsOf(member)) {
					walkNode(method, visit)
				}

				// NOTE: A native signature has no body, but it may carry a
				// default, which is Essence written in a `declarations` Program
				// like any other.
				for (let signature of nativeSignaturesOf(member)) {
					walkDefaults(signature.parameters, visit)
				}
			}

			return
		}
		case "IfStatement":
			walkNode(node.condition, visit)
			walkBody(node.body, visit)
			return
		case "IfElseStatement":
			walkNode(node.condition, visit)
			walkBody(node.trueBody, visit)
			walkBody(node.falseBody, visit)
			return
		case "ReturnStatement":
			walkNode(node.expression, visit)
			return
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of assertionExpressions(node)) {
				walkNode(expression, visit)
			}

			return
		case "Match":
			walkNode(node.value, visit)

			for (let handler of node.handlers) {
				for (let value of matcherValueExpressions(handler.matcher)) {
					walkNode(value, visit)
				}

				if (handler.guard !== null) {
					walkNode(handler.guard, visit)
				}

				walkBody(handler.body, visit)
			}

			return
		// NOTE: An arm holds the Expressions the same Quick Fixes apply to as
		// any body's — an unknown name in one takes the same suggestion, an
		// auto-import the same edit.
		case "Define":
			for (let expression of defineExpressions(node)) {
				walkNode(expression, visit)
			}

			return
		case "FunctionValue":
			walkDefaults(node.value.parameters, visit)
			walkBody(node.value.body, visit)
			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				walkNode(memberExpression(member), visit)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				walkNode(value, visit)
			}

			return
		case "DictionaryValue":
			for (let entry of node.entries) {
				walkNode(entry.key, visit)
				walkNode(entry.value, visit)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					walkNode(segment.expression, visit)
				}
			}

			return
		case "MethodInvocation":
			walkNode(node.base, visit)
			walkArguments(node.arguments, visit)
			return
		case "FunctionInvocation":
			walkNode(node.name, visit)
			walkArguments(node.arguments, visit)
			return
		case "Combination":
			walkNode(node.lhs, visit)
			walkNode(node.rhs, visit)
			return
		case "Lookup":
			walkNode(node.base, visit)
			return
		case "CaseValue":
			if (node.value !== null) {
				walkNode(node.value, visit)
			}

			return
		// NOTE: A path holds no Expression of its own — its steps are member
		// names, and the Function it stands for is the Enricher's.
		case "MemberPath":
			return
	}
}

function walkArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	visit: (node: parser.ImplementationNode) => void,
) {
	for (let argument of nodeArguments) {
		walkNode(argument.value, visit)
	}
}
