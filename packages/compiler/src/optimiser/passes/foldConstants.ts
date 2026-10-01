import type { common } from "@essence-lang/interfaces"
import type { BigRational } from "@essence-lang/runtime/bigRational"
import {
	addRationals,
	multiplyRationals,
	reduced,
	subtractRationals,
} from "@essence-lang/runtime/bigRational"

import type { OptimiserPass } from "../index"
import {
	isPureExpression,
	printingNamespaceOf,
	withoutOverloadSuffix,
} from "../purity"
import { rewriteExpressions } from "../walk"

// Replaces an operation on literals with its answer, computed as the Program
// would compute it. A Rational keeps the parts the operation would store. See
// "fold-constants" in DEVELOPMENT.md.

export const foldConstants: OptimiserPass = {
	name: "fold-constants",
	run: (program, namespaces) => {
		// A nested Namespace named after a builtin may answer anything.
		let shadowed = namespaces.nested

		// A fold answers an Expression with an Expression, so defaults are safe.
		return rewriteExpressions(program, (node) => fold(node, shadowed), {
			parameterDefaults: true,
		})
	},
}

// The most decimal digits a folded number may have. A larger answer is left to
// run. Sums and products stay within the digits written. Concatenation never
// outgrows its literals.
const MAXIMUM_FOLDED_DIGITS = 4096
const MAXIMUM_FOLDED_MAGNITUDE = 10n ** BigInt(MAXIMUM_FOLDED_DIGITS)

// A known condition is folded, but its `define` or `if` keeps every arm, in
// which a coverage counter may stand.
function fold(
	node: common.typedSimple.ExpressionNode,
	shadowed: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	switch (node.nodeType) {
		case "MethodInvocation":
			return foldInvocation(node, shadowed)
		case "InterpolatedStringValue":
			return foldInterpolation(node, shadowed)
		case "Intrinsic":
			return foldIntrinsic(node)
		default:
			return node
	}
}

// The intrinsics `lower-scalar-operations` leaves. A raw test is never folded,
// since a `BooleanValue` in a JavaScript `if` is always true.
function foldIntrinsic(
	node: common.typedSimple.IntrinsicNode,
): common.typedSimple.ExpressionNode {
	if (node.kind === "raw-arithmetic") {
		let left = integerOf(node.left)
		let right = integerOf(node.right)

		if (left === null || right === null) {
			return node
		}

		return integerNode(arithmeticOf(node.operator, left, right), node)
	}

	if (node.kind !== "essence-boolean") {
		return node
	}

	let test = node.value

	if (test.nodeType !== "Intrinsic") {
		return node
	}

	if (test.kind === "raw-compare") {
		let left = integerOf(test.left)
		let right = integerOf(test.right)

		if (left === null || right === null) {
			return node
		}

		return booleanNode(comparisonOf(test.operator, left, right), node)
	}

	// Integers alone. String equality depends on Unicode tables, which the
	// compiler's JavaScript need not share with the Program's.
	if (test.kind === "raw-equals" && test.scalar === "Integer") {
		let left = integerOf(test.left)
		let right = integerOf(test.right)

		if (left === null || right === null) {
			return node
		}

		return booleanNode((left === right) !== test.negated, node)
	}

	return node
}

function foldInvocation(
	node: common.typedSimple.MethodInvocationNode,
	shadowed: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	if (shadowed.has(node.base.name)) {
		return node
	}

	let member = withoutOverloadSuffix(node.member.name)

	switch (node.base.name) {
		case "Integer":
			return foldInteger(node, member, shadowed)
		// A refinement's Method keeps its Namespace's name. These entries are one
		// bigint operation each, and `foldInteger` refuses the ones that scale an
		// irrational.
		case "NonZeroInteger":
			return member === "multiply" ||
				member === "negate" ||
				member === "absolute"
				? foldInteger(node, member, shadowed)
				: node
		// Their sums and products are Integer's own.
		case "NonNegativeInteger":
		case "PositiveInteger":
			return member === "add" || member === "multiply"
				? foldInteger(node, member, shadowed)
				: node
		case "Rational":
			return foldRational(node, member, shadowed)
		// A written `1/2` is a `NonZeroRational`. Its `negate` and `absolute` fold as
		// Rational's do. `reciprocal` is not folded.
		case "NonZeroRational":
			return member === "multiply" ||
				member === "negate" ||
				member === "absolute"
				? foldRational(node, member, shadowed)
				: node
		// Their sums and products are Rational's own.
		case "NonNegativeRational":
		case "PositiveRational":
			return member === "add" || member === "multiply"
				? foldRational(node, member, shadowed)
				: node
		case "String":
			return foldString(node, member, shadowed)
		default:
			return node
	}
}

// Operations whose body is one bigint operation. `divide` and `quotient`
// answer an Optional, `compare` a Case, and `raise` may outgrow the Program.
function foldInteger(
	node: common.typedSimple.MethodInvocationNode,
	member: string,
	shadowed: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	if (member === "negate" || member === "absolute") {
		let receiver = foldableOperands(node, "Integer", 1, shadowed)?.[0]
		let value = receiver === undefined ? null : integerOf(receiver)

		if (value === null) {
			return node
		}

		return integerNode(
			member === "negate" ? -value : value < 0n ? -value : value,
			node,
		)
	}

	let operands = foldableOperands(node, "Integer", 2, shadowed)

	if (operands === null) {
		return node
	}

	let left = integerOf(operands[0]!)
	let right = integerOf(operands[1]!)

	if (left === null || right === null) {
		return node
	}

	switch (member) {
		case "add":
			return integerNode(left + right, node)
		case "subtract":
			return integerNode(left - right, node)
		case "multiply":
			return integerNode(left * right, node)
		case "is":
			return booleanNode(left === right, node)
		case "isNot":
			return booleanNode(left !== right, node)
		case "isLessThan":
			return booleanNode(left < right, node)
		case "isGreaterThan":
			return booleanNode(left > right, node)
		case "isLessThanOrEqualTo":
			return booleanNode(left <= right, node)
		case "isGreaterThanOrEqualTo":
			return booleanNode(left >= right, node)
		default:
			return node
	}
}

// Two Rationals only. Each fold is what the Method does to the stored parts:
// the arithmetic through the natives' own functions, `negate` and `absolute`
// as their Essence bodies.
function foldRational(
	node: common.typedSimple.MethodInvocationNode,
	member: string,
	shadowed: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	if (member === "negate" || member === "absolute") {
		let receiver = foldableOperands(node, "Rational", 1, shadowed)?.[0]
		let value = receiver === undefined ? null : rationalOf(receiver)

		if (value === null) {
			return node
		}

		// `absolute` answers a non-negative Rational itself, keeping `4/2` as 4 over
		// 2. `negate` goes through the lowest-terms parts.
		if (member === "absolute" && value.numerator >= 0n) {
			return rationalNode(value, node)
		}

		return rationalNode(negatedRational(value), node)
	}

	let operands = foldableOperands(node, "Rational", 2, shadowed)

	if (operands === null) {
		return node
	}

	let left = rationalOf(operands[0]!)
	let right = rationalOf(operands[1]!)

	if (left === null || right === null) {
		return node
	}

	// As `Rational.compare` cross-multiplies. Denominators are positive, so the
	// difference's sign is the answer.
	let ordering =
		left.numerator * right.denominator - right.numerator * left.denominator

	switch (member) {
		case "add":
			return rationalNode(
				foldedRationalArithmetic(addRationals, left, right),
				node,
			)
		case "subtract":
			return rationalNode(
				foldedRationalArithmetic(subtractRationals, left, right),
				node,
			)
		case "multiply":
			return rationalNode(
				foldedRationalArithmetic(multiplyRationals, left, right),
				node,
			)
		case "is":
			return booleanNode(ordering === 0n, node)
		case "isNot":
			return booleanNode(ordering !== 0n, node)
		case "isLessThan":
			return booleanNode(ordering < 0n, node)
		case "isGreaterThan":
			return booleanNode(ordering > 0n, node)
		case "isLessThanOrEqualTo":
			return booleanNode(ordering <= 0n, node)
		case "isGreaterThanOrEqualTo":
			return booleanNode(ordering >= 0n, node)
		default:
			return node
	}
}

// Concatenation, the one String operation that is JavaScript's `+` on what the
// values hold.
function foldString(
	node: common.typedSimple.MethodInvocationNode,
	member: string,
	shadowed: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	if (member !== "append" && member !== "prepend") {
		return node
	}

	let operands = foldableOperands(node, "String", 2, shadowed)

	if (operands === null) {
		return node
	}

	let receiver = operands[0]!
	let other = operands[1]!

	if (
		receiver.nodeType !== "StringValue" ||
		other.nodeType !== "StringValue"
	) {
		return node
	}

	return stringNode(
		member === "append"
			? receiver.value + other.value
			: other.value + receiver.value,
		node,
	)
}

// A hole whose value is a literal and whose `toString` can be carried out
// becomes text. All text is a String literal.
function foldInterpolation(
	node: common.typedSimple.InterpolatedStringValueNode,
	shadowed: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	let changed = false
	let segments: Array<common.typedSimple.InterpolationSegmentNode> = []

	for (let segment of node.segments) {
		let text =
			segment.kind === "text"
				? segment.value
				: renderedHole(segment, shadowed)

		if (text === null) {
			segments.push(segment)

			continue
		}

		if (segment.kind === "expression") {
			changed = true
		}

		// Adjacent text pieces are joined.
		let previous = segments.at(-1)

		if (previous !== undefined && previous.kind === "text") {
			changed = true
			segments[segments.length - 1] = {
				kind: "text",
				value: previous.value + text,
			}

			continue
		}

		segments.push({ kind: "text", value: text })
	}

	if (!changed) {
		return node
	}

	let only = segments[0]

	if (segments.length <= 1 && (only === undefined || only.kind === "text")) {
		return stringNode(only?.value ?? "", node)
	}

	return { ...node, segments }
}

// What one hole renders to, or null, following each standard library
// `toString` body.
function renderedHole(
	segment: {
		kind: "expression"
		expression: common.typedSimple.ExpressionNode
		witness: common.typedSimple.ExpressionNode
	},
	shadowed: ReadonlySet<string>,
): string | null {
	let namespaceName = printingNamespaceOf(segment.witness)

	if (namespaceName === null || shadowed.has(namespaceName)) {
		return null
	}

	let value = segment.expression

	if (value.type.type !== namespaceName) {
		return null
	}

	if (!isPureExpression(value, shadowed)) {
		return null
	}

	switch (namespaceName) {
		// A bigint's own decimal spelling.
		case "Integer": {
			let integer = integerOf(value)

			return integer === null ? null : integer.toString()
		}
		// `String::toString` answers the String itself.
		case "String":
			return value.nodeType === "StringValue" ? value.value : null
		// `Boolean::toString` spells out its two answers.
		case "Boolean":
			return value.nodeType === "BooleanValue"
				? value.value
					? "true"
					: "false"
				: null
		// Lowest terms, the numerator alone where the denominator is one, so `4/2`
		// renders `2`.
		case "Rational": {
			let rational = rationalOf(value)

			if (rational === null) {
				return null
			}

			let parts = reduced(rational.numerator, rational.denominator)

			return parts.denominator === 1n
				? `${parts.numerator}`
				: `${parts.numerator}/${parts.denominator}`
		}
		default:
			return null
	}
}

// The receiver and Parameters, all exactly of `kind`, as
// `lower-scalar-operations` asks.
function foldableOperands(
	node: common.typedSimple.MethodInvocationNode,
	kind: "Integer" | "Rational" | "String",
	count: number,
	shadowed: ReadonlySet<string>,
): Array<common.typedSimple.ExpressionNode> | null {
	if (node.arguments.length !== count) {
		return null
	}

	let [receiver] = node.arguments

	if (receiver === undefined || receiver.name !== "@") {
		return null
	}

	for (let argument of node.arguments) {
		if (argument.value.type.type !== kind) {
			return null
		}

		if (!isPureExpression(argument.value, shadowed)) {
			return null
		}
	}

	return node.arguments.map((argument) => argument.value)
}

// A literal read as the number the rewriter would emit. Any spelling but plain
// digits is refused.
const decimalDigits = /^-?[0-9]+$/

function integerOf(node: common.typedSimple.ExpressionNode): bigint | null {
	if (node.nodeType !== "IntegerValue" || !decimalDigits.test(node.value)) {
		return null
	}

	return BigInt(node.value)
}

// The parts `Rational.createRational` would store: the sign on the numerator,
// and zero as `0/1`. A zero denominator is refused.
function rationalOf(
	node: common.typedSimple.ExpressionNode,
): { numerator: bigint; denominator: bigint } | null {
	if (
		node.nodeType !== "RationalValue" ||
		!decimalDigits.test(node.numerator) ||
		!decimalDigits.test(node.denominator)
	) {
		return null
	}

	if (BigInt(node.denominator) === 0n) {
		return null
	}

	return storedRational(BigInt(node.numerator), BigInt(node.denominator))
}

// What `Rational.createRational` makes of two bigints.
function storedRational(
	numerator: bigint,
	denominator: bigint,
): { numerator: bigint; denominator: bigint } {
	if (denominator < 0n) {
		numerator = -numerator
		denominator = -denominator
	}

	if (numerator === 0n && denominator !== 0n) {
		denominator = 1n
	}

	return { numerator, denominator }
}

// Through the functions the natives call, so there is one definition of
// Rational arithmetic.
function foldedRationalArithmetic(
	operation: (first: BigRational, second: BigRational) => BigRational,
	left: { numerator: bigint; denominator: bigint },
	right: { numerator: bigint; denominator: bigint },
): { numerator: bigint; denominator: bigint } {
	let answer = operation(
		reduced(left.numerator, left.denominator),
		reduced(right.numerator, right.denominator),
	)

	return storedRational(answer.numerator, answer.denominator)
}

// `Rational::negate` is an Essence body, followed exactly.
function negatedRational(value: { numerator: bigint; denominator: bigint }): {
	numerator: bigint
	denominator: bigint
} {
	let parts = reduced(value.numerator, value.denominator)

	return storedRational(-parts.numerator, parts.denominator)
}

function arithmeticOf(
	operator: "+" | "-" | "*",
	left: bigint,
	right: bigint,
): bigint {
	switch (operator) {
		case "+":
			return left + right
		case "-":
			return left - right
		case "*":
			return left * right
	}
}

function comparisonOf(
	operator: "<" | ">" | "<=" | ">=",
	left: bigint,
	right: bigint,
): boolean {
	switch (operator) {
		case "<":
			return left < right
		case ">":
			return left > right
		case "<=":
			return left <= right
		case ">=":
			return left >= right
	}
}

function withinCap(value: bigint): boolean {
	let magnitude = value < 0n ? -value : value

	return magnitude < MAXIMUM_FOLDED_MAGNITUDE
}

// Each answer keeps the Type and Position of the Node it replaces.
function integerNode(
	value: bigint,
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.type.type !== "Integer" || !withinCap(value)) {
		return node
	}

	return {
		nodeType: "IntegerValue",
		value: value.toString(),
		type: node.type,
		position: node.position,
	}
}

function rationalNode(
	value: { numerator: bigint; denominator: bigint },
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (
		node.type.type !== "Rational" ||
		!withinCap(value.numerator) ||
		!withinCap(value.denominator)
	) {
		return node
	}

	return {
		nodeType: "RationalValue",
		numerator: value.numerator.toString(),
		denominator: value.denominator.toString(),
		type: node.type,
		position: node.position,
	}
}

function booleanNode(
	value: boolean,
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.type.type !== "Boolean") {
		return node
	}

	return {
		nodeType: "BooleanValue",
		value,
		type: node.type,
		position: node.position,
	}
}

function stringNode(
	value: string,
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.type.type !== "String") {
		return node
	}

	return {
		nodeType: "StringValue",
		value,
		type: node.type,
		position: node.position,
	}
}
