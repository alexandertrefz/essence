import { findTypedChild, type TypedNode } from "@essence-lang/compiler/visitor"
import type { common } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import { typedProgramBodies } from "../sections"

// What the typed Program says about a span of the source. Other lookups read
// the Parser AST, which matches the text, but spelling a Type needs the typed
// tree. Both keep the source's Positions.

export function typedExpressionAt(
	program: common.typed.Program,
	position: common.Position,
): common.typed.ExpressionNode | null {
	for (let body of typedProgramBodies(program)) {
		for (let node of body) {
			let found = findExpression(node, position)

			if (found !== undefined) {
				return found
			}
		}
	}

	return null
}

// The first match is the outermost Node of a span. A call without a written
// receiver shares its Position with its base Identifier.
function findExpression(
	node: TypedNode,
	position: common.Position,
): common.typed.ExpressionNode | undefined {
	if (isExpression(node) && isSamePosition(node.position, position)) {
		return node
	}

	return findInside(node, position)
}

function findInside(
	node: TypedNode,
	position: common.Position,
): common.typed.ExpressionNode | undefined {
	return findTypedChild(
		node,
		node.nodeType === "FunctionInvocation" ? findExpression : findInValue,
		position,
	)
}

// A name a node declares or looks up is no Expression of its own, so it has
// no Type to spell. Only a Function Invocation's `name` is its callee. A
// Method's Function is the declaration itself, searched for its body.
function findInValue(
	child: TypedNode,
	position: common.Position,
	field: string,
): common.typed.ExpressionNode | undefined {
	if (namingFields.has(field)) {
		return undefined
	}

	if (field === "method" || field === "methods") {
		return findInside(child, position)
	}

	return findExpression(child, position)
}

const namingFields = new Set([
	"name",
	"member",
	"choice",
	"caseName",
	"externalName",
	"internalName",
])

function isExpression(node: TypedNode): node is common.typed.ExpressionNode {
	return Object.hasOwn(expressionKinds, node.nodeType)
}

// Keyed by every Expression kind, so the type checker names a new one.
const expressionKinds: Record<common.typed.ExpressionNode["nodeType"], true> = {
	MethodInvocation: true,
	FunctionInvocation: true,
	RecordValue: true,
	StringValue: true,
	InterpolatedStringValue: true,
	IntegerValue: true,
	RationalValue: true,
	BooleanValue: true,
	FunctionValue: true,
	ListValue: true,
	DictionaryValue: true,
	Lookup: true,
	Identifier: true,
	Self: true,
	Combination: true,
	Match: true,
	Define: true,
	CaseValue: true,
	Start: true,
	Complete: true,
	RefusedValue: true,
}
