import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { isPureExpression, withoutOverloadSuffix } from "../purity"
import { rewriteExpressions } from "../walk"

// Writes the primitive operations on exact `Integer`, `String` and `Boolean`
// operands as JavaScript operators, such as `a.value < b.value`. `and` and `or`
// lower only over a pure right operand, since `&&` may skip it. See
// "lower-scalar-operations" in DEVELOPMENT.md.

export const lowerScalarOperations: OptimiserPass = {
	name: "lower-scalar-operations",
	run: (program, namespaces) => {
		// A nested Namespace named after a builtin may answer anything, so its name is
		// refused for the whole Program, here and in the purity question.
		let shadowed = namespaces.nested

		return rewriteExpressions(program, (node) => lower(node, shadowed))
	},
}

function lower(
	node: common.typedSimple.ExpressionNode,
	shadowed: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "MethodInvocation") {
		return node
	}

	if (shadowed.has(node.base.name)) {
		return node
	}

	let member = withoutOverloadSuffix(node.member.name)

	// A provided Method is named by its conformer's Namespace, so only
	// `providedBy` says which Protocol wrote the body.
	if (node.providedBy !== undefined) {
		return node.providedBy === "Equatable"
			? lowerProvidedEquatable(node, member)
			: node
	}

	switch (node.base.name) {
		case "Integer":
			return lowerInteger(node, member)
		// A refinement's Method still carries its Namespace's name. Its `multiply` is
		// Integer's own product, and `scalarOperands` refuses the entries that scale
		// an irrational.
		case "NonZeroInteger":
			return member === "multiply" ? lowerInteger(node, member) : node
		// Their `add` and `multiply` are Integer's own sum and product.
		case "NonNegativeInteger":
		case "PositiveInteger":
			return member === "add" || member === "multiply"
				? lowerInteger(node, member)
				: node
		case "Boolean":
			return lowerBoolean(node, member, shadowed)
		case "String":
			return lowerString(node, member)
		default:
			return node
	}
}

// `Equatable`'s provided `isNot` calls the `is` lowered here. Its trailing
// witness is a method map, built rather than run, so dropping it is safe.
function lowerProvidedEquatable(
	node: common.typedSimple.MethodInvocationNode,
	member: string,
): common.typedSimple.ExpressionNode {
	if (member !== "isNot" || node.providedBy !== "Equatable") {
		return node
	}

	let kind = node.arguments[0]?.value.type.type

	if (kind !== "Integer" && kind !== "String") {
		return node
	}

	let operands = scalarOperands(node, kind, 3)

	return operands === null
		? node
		: equality(node, kind, operands[0], operands[1], true)
}

// Comparisons, equality and the exact operations. `divide` answers an
// Optional, and `quotient`, `remainder` and `raise` stay calls.
function lowerInteger(
	node: common.typedSimple.MethodInvocationNode,
	member: string,
): common.typedSimple.ExpressionNode {
	let operands = scalarOperands(node, "Integer")

	if (operands === null) {
		return node
	}

	let [left, right] = operands

	switch (member) {
		case "isLessThan":
			return comparison(node, "<", left, right)
		case "isGreaterThan":
			return comparison(node, ">", left, right)
		case "isLessThanOrEqualTo":
			return comparison(node, "<=", left, right)
		case "isGreaterThanOrEqualTo":
			return comparison(node, ">=", left, right)
		case "is":
			return equality(node, "Integer", left, right, false)
		case "isNot":
			return equality(node, "Integer", left, right, true)
		case "add":
			return arithmetic(node, "+", left, right)
		case "subtract":
			return arithmetic(node, "-", left, right)
		case "multiply":
			return arithmetic(node, "*", left, right)
		default:
			return node
	}
}

// Strings are equal when their NFC forms are, so equality calls one runtime
// helper rather than `===`.
function lowerString(
	node: common.typedSimple.MethodInvocationNode,
	member: string,
): common.typedSimple.ExpressionNode {
	let operands = scalarOperands(node, "String")

	if (operands === null) {
		return node
	}

	let [left, right] = operands

	switch (member) {
		case "is":
			return equality(node, "String", left, right, false)
		case "isNot":
			return equality(node, "String", left, right, true)
		default:
			return node
	}
}

function lowerBoolean(
	node: common.typedSimple.MethodInvocationNode,
	member: string,
	shadowed: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	if (node.type.type !== "Boolean") {
		return node
	}

	let booleanType = node.type

	// `negate` has only its receiver, which is always evaluated.
	if (member === "negate") {
		let [receiver] = node.arguments

		if (node.arguments.length !== 1 || receiver === undefined) {
			return node
		}

		if (receiver.name !== "@" || receiver.value.type.type !== "Boolean") {
			return node
		}

		return essenceBoolean(
			negated(rawBooleanOf(receiver.value, booleanType), booleanType),
			booleanType,
			node.position,
		)
	}

	if (member !== "and" && member !== "or") {
		return node
	}

	let operands = scalarOperands(node, "Boolean")

	if (operands === null) {
		return node
	}

	let [left, right] = operands

	// `a::and(b)` evaluates `b`, while `a && b` may skip it. So the whole right
	// operand has to be pure, or the call stays.
	if (!isPureExpression(right, shadowed)) {
		return node
	}

	return essenceBoolean(
		{
			nodeType: "Intrinsic",
			kind: "raw-boolean-op",
			operator: member,
			operand: rawBooleanOf(left, booleanType),
			other: rawBooleanOf(right, booleanType),
			type: booleanType,
			position: node.position,
		},
		booleanType,
		node.position,
	)
}

// The receiver and the one declared Parameter, both exactly of `kind`, or null.
// `arity` counts every Argument, a provided Method's trailing witness included.
function scalarOperands(
	node: common.typedSimple.MethodInvocationNode,
	kind: "Integer" | "String" | "Boolean",
	arity: number = 2,
):
	| [common.typedSimple.ExpressionNode, common.typedSimple.ExpressionNode]
	| null {
	if (node.arguments.length !== arity) {
		return null
	}

	let [receiver, other] = node.arguments

	if (receiver === undefined || other === undefined) {
		return null
	}

	if (receiver.name !== "@") {
		return null
	}

	if (
		receiver.value.type.type !== kind ||
		other.value.type.type !== kind //
	) {
		return null
	}

	return [receiver.value, other.value]
}

function comparison(
	node: common.typedSimple.MethodInvocationNode,
	operator: "<" | ">" | "<=" | ">=",
	left: common.typedSimple.ExpressionNode,
	right: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.type.type !== "Boolean") {
		return node
	}

	return essenceBoolean(
		{
			nodeType: "Intrinsic",
			kind: "raw-compare",
			operator,
			left,
			right,
			type: node.type,
			position: node.position,
		},
		node.type,
		node.position,
	)
}

function equality(
	node: common.typedSimple.MethodInvocationNode,
	scalar: "Integer" | "String",
	left: common.typedSimple.ExpressionNode,
	right: common.typedSimple.ExpressionNode,
	isNegated: boolean,
): common.typedSimple.ExpressionNode {
	if (node.type.type !== "Boolean") {
		return node
	}

	return essenceBoolean(
		{
			nodeType: "Intrinsic",
			kind: "raw-equals",
			scalar,
			left,
			right,
			negated: isNegated,
			type: node.type,
			position: node.position,
		},
		node.type,
		node.position,
	)
}

function arithmetic(
	node: common.typedSimple.MethodInvocationNode,
	operator: "+" | "-" | "*",
	left: common.typedSimple.ExpressionNode,
	right: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.type.type !== "Integer") {
		return node
	}

	return {
		nodeType: "Intrinsic",
		kind: "raw-arithmetic",
		operator,
		left,
		right,
		type: node.type,
		position: node.position,
	}
}

// A raw test as an Essence Boolean, carrying the whole operation's Position.
function essenceBoolean(
	value: common.typedSimple.ExpressionNode,
	type: common.BooleanType,
	position: common.Position | undefined,
): common.typedSimple.ExpressionNode {
	return {
		nodeType: "Intrinsic",
		kind: "essence-boolean",
		value,
		type,
		position,
	}
}

// A Boolean's raw value, or the test it was just built from, since the walk is
// bottom-up.
function rawBooleanOf(
	node: common.typedSimple.ExpressionNode,
	type: common.BooleanType,
): common.typedSimple.ExpressionNode {
	if (node.nodeType === "Intrinsic" && node.kind === "essence-boolean") {
		return node.value
	}

	return {
		nodeType: "Intrinsic",
		kind: "raw-boolean",
		value: node,
		type,
		position: node.position,
	}
}

// The opposite test where there is one: Integers are totally ordered, so
// `!(a < b)` is `a >= b`. Anything else gets `!`, and `!` over `!` cancels.
function negated(
	test: common.typedSimple.ExpressionNode,
	type: common.BooleanType,
): common.typedSimple.ExpressionNode {
	if (test.nodeType === "Intrinsic") {
		switch (test.kind) {
			case "raw-compare":
				return { ...test, operator: oppositeOf(test.operator) }
			case "raw-equals":
			case "tag-test":
				return { ...test, negated: !test.negated }
			case "raw-boolean-op":
				if (test.operator === "not") {
					return test.operand
				}

				break
			default:
				break
		}
	}

	return {
		nodeType: "Intrinsic",
		kind: "raw-boolean-op",
		operator: "not",
		operand: test,
		other: null,
		type,
		position: test.position,
	}
}

function oppositeOf(
	operator: "<" | ">" | "<=" | ">=",
): "<" | ">" | "<=" | ">=" {
	switch (operator) {
		case "<":
			return ">="
		case ">":
			return "<="
		case "<=":
			return ">"
		case ">=":
			return "<"
	}
}
