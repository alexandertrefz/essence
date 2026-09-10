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
import { containsRange } from "./geometry"

// NOTE: Which Node of the Parser AST stands at — or around — a Position. The
// finders a Quick Fix starts from ask the first question, since a Diagnostic
// names the Node it was reported against; the two a refactoring starts from
// ask the second, since a selection sits inside what it selects.

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

// NOTE: The smallest Node whose Position CONTAINS the range, where every
// finder above matches a Position exactly. A Diagnostic names the Node it was
// reported against and a SELECTION does not: what a reader drags over is a
// span inside an Expression, or one that covers it and a little whitespace
// besides, and what an extraction lifts is the Node around it.
//
// The last containing Node the walk reaches is the innermost one. A Node is
// visited before the Nodes it holds, so a container is passed on the way in;
// everything visited after a Node that is not inside it stands BESIDE it,
// where a range inside it can not also be. The one range that is inside two
// such neighbours is one of no width sitting exactly between them, and the
// later of the two answers for it.
export function findInnermostNodeContaining(
	program: parser.Program,
	range: common.Position,
): parser.ImplementationNode | null {
	let found: parser.ImplementationNode | null = null

	walk(program, (node) => {
		if (containsRange(node.position, range)) {
			found = node
		}
	})

	return found
}

// NOTE: The Statement a range sits in, and the body it is one of. A refactoring
// that writes a Statement — a Constant lifted out of an Expression, a Function
// extracted from a body — has to write it SOMEWHERE, and where is always
// "beside this one, in the body it stands in". The index is handed over with
// it so that "above this Statement" is a lookup rather than a second search.
export type EnclosingStatement = {
	statement: parser.ImplementationNode
	body: Array<parser.ImplementationNode>
	index: number
}

// NOTE: Innermost, on the same reading of the walk order that
// `findInnermostNodeContaining` takes: the bodies come outermost first, so the
// last one holding a Statement over the range is the one no other body of the
// list is nested in.
export function enclosingStatementOf(
	program: parser.Program,
	range: common.Position,
): EnclosingStatement | null {
	let found: EnclosingStatement | null = null

	for (let body of allBodies(program)) {
		let index = body.findIndex((statement) =>
			containsRange(statement.position, range),
		)

		if (index !== -1) {
			found = { statement: body[index], body, index }
		}
	}

	return found
}

// NOTE: Every body of the Program, outermost first. `programSections` is depth
// first and in source order, and the walk visits a Node before the Nodes it
// holds, so a body written inside another is always collected after it.
function allBodies(
	program: parser.Program,
): Array<Array<parser.ImplementationNode>> {
	let bodies = programBodies(program)

	walk(program, (node) => {
		bodies.push(...bodiesOf(node))
	})

	return bodies
}

// NOTE: The bodies one Node OWNS — a body being the one place a Statement can
// be written, which an Expression holding other Expressions is not. A
// Namespace's Methods are absent because the walk reaches each of them as a
// Function value of its own, and answers for it there.
function bodiesOf(
	node: parser.ImplementationNode,
): Array<Array<parser.ImplementationNode>> {
	switch (node.nodeType) {
		case "FunctionStatement":
		case "FunctionValue":
			return [node.value.body]
		case "IfStatement":
			return [node.body]
		case "IfElseStatement":
			return [node.trueBody, node.falseBody]
		case "Match":
			return node.handlers.map((handler) => handler.body)
		default:
			return []
	}
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
