import {
	applyGenericBindings,
	genericNamesMentioned,
	isFunctionRefusedAsValue,
	matchesType,
	typeContainsError,
	typeContainsRefinement,
	typeContainsUnknown,
} from "@essence-lang/compiler/helpers"
import {
	findParserChild,
	findTypedChild,
	forEachTypedChild,
	type ParserNode,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

import { calledSignature, pairedParameters } from "../argumentContext"
import { isSamePosition } from "../positions"
import { typedProgramBodies } from "../sections"
import { spellTypeAt } from "../spellableTypes"

// Whether a Constant holding an Expression means what the Expression meant
// where it stood, and the Type it must write for that. See "The Type the
// Constant holds" in DEVELOPMENT.md.

// Null for a Constant that needs no annotation.
export type ConstantAnnotation = { annotation: string | null }

// What the position asks of a value. `none` types it bottom-up, as an
// unannotated Constant does. `own` is a Parameter the value's own Type decides,
// which a call's position may still decide for a value that reads it. `unknown`
// is a position the typed tree does not say enough about.
type Expectation = common.Type | "none" | "own" | "unknown"

// A typed Node with the field of its parent it was reached through.
type Step = { node: TypedNode; field: string; key: unknown }

// Null where the extraction would change what the value means and no
// annotation keeps it.
export function constantAnnotation(
	program: common.typed.Program,
	expression: parser.ExpressionNode,
	insertion: common.Cursor,
): ConstantAnnotation | null {
	let path = typedPathTo(program, expression)

	if (path === null) {
		return null
	}

	let typed = path[path.length - 1]!.node as common.typed.ExpressionNode
	let parent = path[path.length - 2]
	let field = path[path.length - 1]!.field

	if (typeContainsError(typed.type) || needsAPosition(expression)) {
		return null
	}

	if (parent?.node.nodeType === "FunctionInvocation" && field === "name") {
		return isFunctionValue(typed) ? { annotation: null } : null
	}

	// A written receiver proves a refinement, which a name holding it does
	// not. See "Written receivers" in packages/compiler/src/enricher/DEVELOPMENT.md.
	if (parent?.node.nodeType === "MethodInvocation" && field === "base") {
		return isWritten(expression) && typed.type.type === "Refinement"
			? spelled(typed.type, path, program, insertion)
			: { annotation: null }
	}

	let expected = expectationAt(path, path.length - 1)

	if (expected === "none") {
		return { annotation: null }
	}

	let reads = readsItsPosition(expression, typedCasesIn(typed))

	if (expected === "own") {
		return reads ? null : { annotation: null }
	}

	if (expected === "unknown") {
		return reads || isWritten(expression) ? null : { annotation: null }
	}

	if (
		!reads &&
		(!isWritten(expression) || matchesType(expected, typed.type))
	) {
		return { annotation: null }
	}

	// A Record Literal leaving members to a default is merged into it, and
	// an annotated Constant merges nothing.
	if (
		expression.nodeType === "RecordValue" &&
		!sameMembers(typed, expected)
	) {
		return null
	}

	return spelled(expected, path, program, insertion)
}

// A Function taken as a value loses its defaults, so a partial Record
// Argument has nothing to merge into. An overloaded or a Protocol-bound one is
// refused as a value.
function isFunctionValue(callee: common.typed.ExpressionNode): boolean {
	return (
		(callee.type.type === "Function" ||
			callee.type.type === "StaticMethod") &&
		!isFunctionRefusedAsValue(callee.type) &&
		callee.type.parameterTypes.every(
			(parameter) =>
				parameter.hasDefault !== true &&
				parameter.defaultMembers === undefined,
		)
	)
}

function spelled(
	type: common.Type,
	path: Array<Step>,
	program: common.typed.Program,
	cursor: common.Cursor,
): ConstantAnnotation | null {
	if (
		typeContainsUnknown(type) ||
		(type.type === "Refinement" && type.receiverConjunction === true)
	) {
		return null
	}

	let annotation = spellTypeAt(type, {
		program,
		cursor,
		typeParameters: typeParametersAlong(path),
	})

	return annotation === null ? null : { annotation }
}

// The Type Parameters the Functions and Namespaces around the Expression
// declare, which are in scope where the Constant stands too.
function typeParametersAlong(path: Array<Step>): Set<string> {
	let names = new Set<string>()

	for (let { node } of path) {
		if (
			node.nodeType === "FunctionDefinition" ||
			node.nodeType === "NamespaceDefinitionStatement"
		) {
			for (let generic of node.generics) {
				names.add(generic.name)
			}
		}
	}

	return names
}

function sameMembers(
	typed: common.typed.ExpressionNode,
	expected: common.Type,
): boolean {
	let record = expected.type === "Refinement" ? expected.base : expected

	if (typed.type.type !== "Record" || record.type !== "Record") {
		return false
	}

	let written = Object.keys(typed.type.members).sort()
	let wanted = Object.keys(record.members).sort()

	return written.join(",") === wanted.join(",")
}

// The written kinds a position may admit to a refinement, or merge into a
// default, on what their text proves.
function isWritten(expression: parser.ExpressionNode): boolean {
	switch (expression.nodeType) {
		case "IntegerValue":
		case "RationalValue":
		case "StringValue":
		case "ListValue":
		case "DictionaryValue":
		case "RecordValue":
		case "Combination":
		case "CaseValue":
			return true
		default:
			return false
	}
}

// Whether the value takes its Type from the position it stands in. A call is
// searched only for an empty List or Dictionary, since an Argument resolves
// against its Parameter. See "The Type the Constant holds" in DEVELOPMENT.md.
function readsItsPosition(node: ParserNode, cases: TypedCases): boolean {
	switch (node.nodeType) {
		case "CaseValue":
			if (
				node.choice === null ||
				(node.typeArguments === null && isGenericCase(node, cases))
			) {
				return true
			}

			break
		case "RefusedValue":
			return true
		case "ListValue":
			if (node.values.length === 0) {
				return true
			}

			break
		case "DictionaryValue":
			if (node.entries.length === 0) {
				return true
			}

			break
		case "Define":
			return node.returnType === null
		case "MethodInvocation":
		case "FunctionInvocation":
			return holdsEmptyCollection(node)
		// Typed without the position: a scrutinee, an update's base, a
		// member's base, an interpolated value, a written Function's body.
		case "Match":
		case "Combination":
		case "Lookup":
		case "InterpolatedStringValue":
		case "FunctionValue":
			return false
	}

	return (
		findParserChild(node, (child) =>
			readsItsPosition(child, cases) ? true : undefined,
		) === true
	)
}

// A Function literal or a member path without written Types takes them from
// its position, and a Constant's declared Type does not type its Parameters.
// One passed to a call reads the call's Parameter, which stays where it is.
function needsAPosition(node: ParserNode): boolean {
	switch (node.nodeType) {
		case "FunctionValue":
			return (
				node.value.returnType === null ||
				node.value.parameters.some(
					(parameter) => parameter.type === null,
				)
			)
		case "MemberPath":
			return true
		case "MethodInvocation":
		case "FunctionInvocation":
		case "Match":
		case "Combination":
		case "Lookup":
		case "InterpolatedStringValue":
			return false
		case "Define":
			if (node.returnType !== null) {
				return false
			}

			break
	}

	return (
		findParserChild(node, (child) =>
			needsAPosition(child) ? true : undefined,
		) === true
	)
}

function holdsEmptyCollection(node: ParserNode): boolean {
	if (
		(node.nodeType === "ListValue" && node.values.length === 0) ||
		(node.nodeType === "DictionaryValue" && node.entries.length === 0)
	) {
		return true
	}

	return (
		findParserChild(node, (child) =>
			holdsEmptyCollection(child) ? true : undefined,
		) === true
	)
}

// The Case constructions under a typed Node, by where each was written, so
// the value's own Cases are read off the subtree found once.
type TypedCases = Map<string, common.typed.CaseValueNode>

function typedCasesIn(node: TypedNode): TypedCases {
	let cases: TypedCases = new Map()

	let visit = (node: TypedNode) => {
		if (node.nodeType === "CaseValue") {
			cases.set(positionKey(node.position), node)
		}

		forEachTypedChild(node, visit)
	}

	visit(node)

	return cases
}

function positionKey({ start, end }: common.Position): string {
	return `${start.line}:${start.column}:${end.line}:${end.column}`
}

// A Case the typed tree does not show is taken as generic.
function isGenericCase(node: parser.CaseValueNode, cases: TypedCases): boolean {
	let typed = cases.get(positionKey(node.position))

	return (
		typed === undefined ||
		typed.type.type !== "Case" ||
		(typed.type.typeArguments?.length ?? 0) > 0
	)
}

// What the position asks of the Node at `index`, read off its parent. A
// member or an item asks what its container's position asks of it.
function expectationAt(path: Array<Step>, index: number): Expectation {
	let { field, key } = path[index]!
	let parent = path[index - 1]?.node

	// A Statement of a body, whose value nothing reads.
	if (parent === undefined || statementFields.has(field)) {
		return "none"
	}

	switch (parent.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			return parent.declaredType ?? "none"
		case "ReturnStatement":
			return answerAt(path, index - 1)
		case "Argument":
			return parameterAt(path, index - 1)
		case "RecordValue":
		case "ListValue":
		case "DictionaryValue": {
			let container = expectationAt(path, index - 1)

			return typeof container === "string"
				? container
				: heldBy(parent.nodeType, container, field, key)
		}
		case "CaseValue":
			return parent.type.type === "Case"
				? { type: "Record", members: parent.type.members }
				: "unknown"
		// An update's key list is held to the value it updates.
		case "Combination":
			return field === "lhs" ? "none" : parent.lhs.type
		case "Define":
			return field === "condition" ? "none" : parent.type
		case "Match":
			return field === "value" || field === "guard" ? "none" : "unknown"
		case "MethodInvocation":
		case "FunctionInvocation":
		case "IfStatement":
		case "IfElseStatement":
		case "ExpectStatement":
		case "RequireStatement":
		case "Start":
		case "Complete":
		case "InterpolatedStringValue":
		case "Lookup":
			return "none"
		default:
			return "unknown"
	}
}

const statementFields = new Set(["body", "trueBody", "falseBody", "nodes"])

// What the Type a Literal is expected to have asks of the member, item, key
// or value at `field` and `key`. A refinement holds what its base holds.
function heldBy(
	literal: "RecordValue" | "ListValue" | "DictionaryValue",
	container: common.Type,
	field: string,
	key: unknown,
): Expectation {
	let base = container.type === "Refinement" ? container.base : container

	if (literal === "RecordValue" && base.type === "Record") {
		return base.members[key as string] ?? "unknown"
	}

	if (literal === "ListValue" && base.type === "List") {
		return base.itemType
	}

	if (literal === "DictionaryValue" && base.type === "Dictionary") {
		return field === "key" ? base.keyType : base.valueType
	}

	return "unknown"
}

// What a `<-` answers: the Match whose Handler holds it, or the Function. A
// Function that did not write its return Type took it from its body or its
// position. A completing one answers the value its Future completes with.
function answerAt(path: Array<Step>, index: number): Expectation {
	for (let at = index - 1; at >= 0; at--) {
		let node = path[at]!.node

		if (node.nodeType === "Match" && path[at + 1]!.field === "body") {
			return node.type
		}

		if (node.nodeType === "FunctionDefinition") {
			let answer = node.returnType

			if (node.inferredReturnType !== null) {
				return "unknown"
			}

			if (node.completing !== true) {
				return answer
			}

			return answer.type === "Future" ? answer.valueType : "unknown"
		}
	}

	return "unknown"
}

// The Parameter an Argument fills, with what the call bound substituted. Type
// Parameters only this Argument mentions take its own Type, so a Parameter
// holding no refinement and no default asks nothing more of it. The call's
// position may still decide them for a value that reads its position.
function parameterAt(path: Array<Step>, index: number): Expectation {
	let invocation = path[index - 1]?.node
	let position = path[index]!.key as number
	let call = calledSignature(invocation)

	if (call === null) {
		return "unknown"
	}

	let { signature, parameters, bindings } = call
	let paired = pairedParameters(
		(invocation as common.typed.FunctionInvocationNode).arguments,
		parameters,
	)
	let parameter = parameters[paired[position] ?? position]

	if (parameter === undefined) {
		return "unknown"
	}

	let declared = applyGenericBindings(parameter.type, bindings)
	let open = [...genericNamesMentioned(declared)].filter((name) =>
		signature.generics.some((generic) => generic.name === name),
	)

	if (open.length === 0) {
		return declared
	}

	let decidedHere =
		!typeContainsRefinement(declared) &&
		parameter.defaultMembers === undefined &&
		signature.parameterTypes.every(
			(other) =>
				other === parameter ||
				open.every(
					(name) =>
						!genericNamesMentioned(
							applyGenericBindings(other.type, bindings),
						).has(name),
				),
		)

	if (!decidedHere) {
		return "unknown"
	}

	// Where the call's own position expects nothing, nothing else decides.
	return expectationAt(path, index - 1) === "none" ? "none" : "own"
}

// The typed Node written where the parser Node is, with every Node around it.
// Where two Nodes of its kind share the span, as a one-member payload wrapped
// in its Record, the inner one is the written one. A desugared Node may hold
// Nodes outside its own span, so no subtree is skipped.
function typedPathTo(
	program: common.typed.Program,
	node: parser.ExpressionNode,
): Array<Step> | null {
	let path: Array<Step> = []

	let search = (step: Step): Array<Step> | undefined => {
		path.push(step)

		let found =
			findTypedChild(step.node, (child, _state, field, key) =>
				search({ node: child, field, key }),
			) ??
			(step.node.nodeType === node.nodeType &&
			"position" in step.node &&
			isSamePosition(step.node.position, node.position)
				? [...path]
				: undefined)

		path.pop()

		return found
	}

	for (let body of typedProgramBodies(program)) {
		for (let statement of body) {
			let found = search({ node: statement, field: "body", key: 0 })

			if (found !== undefined) {
				return found
			}
		}
	}

	return null
}

// Whether the condition of the `if` or `define` written at `position` proves
// something about a name, where it holds or where it fails. One the typed tree
// does not show is taken to.
export function conditionNarrows(
	program: common.typed.Program,
	position: common.Position,
): boolean {
	let visit = (node: TypedNode): boolean | undefined => {
		if ("position" in node && isSamePosition(node.position, position)) {
			switch (node.nodeType) {
				case "IfStatement":
					return node.narrows
				case "IfElseStatement":
					return node.narrows || node.narrowsFalse
				case "Define": {
					let [first] = node.arms

					return (
						first === undefined ||
						first.narrows ||
						first.narrowsBelow
					)
				}
			}
		}

		return findTypedChild(node, visit)
	}

	for (let body of typedProgramBodies(program)) {
		for (let statement of body) {
			let narrows = visit(statement)

			if (narrows !== undefined) {
				return narrows
			}
		}
	}

	return true
}
