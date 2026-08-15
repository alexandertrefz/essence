import type { common } from "@essence-lang/interfaces"
import { reduced } from "@essence-lang/runtime/bigRational"

import type { OptimiserPass } from "../index"
import { isPureExpression, withoutOverloadSuffix } from "../purity"
import { rewriteExpressions } from "../walk"

// NOTE: An operation whose operands are written out in the source has one
// answer, and the Program computed it again at every evaluation: `60::multiply(
// with 60)::multiply(with 24)` allocated three Integers and made three calls to
// arrive at 86400, per turn of whatever loop it stood in, and `"a count: {7}"`
// rendered `7` through a witness to build a String that could have been written.
// So the answer is what is emitted, and the operation is not.
//
// NOTE: The whole of what makes it safe is that the Compiler computes the
// answer THE SAME WAY the Program would have. Essence arithmetic is exact —
// bigints and pairs of bigints, never a float — so there is no rounding to
// disagree about, and every fold below is the body of the Method it replaces
// carried out on the literals it was given. Where the body is a runtime
// native it is one bigint operation; where it is written in Essence it is
// followed statement by statement, because what a Rational STORES is decided by
// the Essence body and not by the value it stands for.
//
// NOTE: Which is the one thing about Rationals that has to be got exactly
// right. A Rational holds the parts it was BUILT with and reduces only what it
// ANSWERS with — `4/2` stores 4 and 2, prints `2/1` and answers 2 for its
// numerator — so `1/2::add(1/4)` may not be folded to the `3/4` it is worth. The
// Essence body reads both operands' lowest-terms parts, cross-multiplies them
// and hands the result to `Rational.of`, which stores 6 and 8; that is what is
// folded, and the value prints `3/4` exactly as the unfolded Program does.
//
// NOTE: Only LITERALS are folded, never a name a Program bound to a constant.
// A binding is a place a debugger stops and a name a reader looks for, and
// what is gained by folding through one is an allocation the pool already
// removes. What is asked of each operand is nevertheless `isPureExpression`,
// with the Program's shadowed Namespaces: the enumeration a fold rests on is
// read by NAME, and a Program may write a `namespace Integer for Integer` of
// its own in a block, whose `add` can print.

export const foldConstants: OptimiserPass = {
	name: "fold-constants",
	run: (program, namespaces) => {
		// NOTE: The same set `lower-scalar-operations` refuses to lower on, for
		// the same reason: a Namespace named after a builtin stands in front of
		// it for the rest of its block, and an `add` written there is a Method
		// the Program wrote. Refused for the whole Program rather than per
		// Scope — the Optimiser walks Expressions and not Scopes.
		let shadowed = namespaces.nested

		return rewriteExpressions(program, (node) => fold(node, shadowed))
	},
}

// NOTE: A deliberate ceiling on how large a folded number may be, in decimal
// digits. None of the operations folded here can reach it: addition and
// multiplication of bigints grow the answer by at most the digits of their
// operands, so a whole tree of them is bounded by the digits WRITTEN in the
// source, and a Program can not write more source than it has. What the cap is
// for is the operation that would break that argument — `raise`, whose answer's
// size is the exponent's VALUE rather than its length — so that folding one
// later is a decision about this number rather than an emission that quietly
// balloons. A fold that would exceed it is simply not taken, and the Program
// computes the answer as it always did.
//
// NOTE: Strings need none. Concatenation copies each operand once, so a folded
// text is never longer than the literals it was built from.
const MAXIMUM_FOLDED_DIGITS = 4096
const MAXIMUM_FOLDED_MAGNITUDE = 10n ** BigInt(MAXIMUM_FOLDED_DIGITS)

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

// NOTE: The shapes `lower-scalar-operations` leaves behind, folded as well as
// the Invocations below — because that pass runs FIRST and takes every Integer
// operation this one would otherwise have found. Neither pass may assume the
// other ran, so both forms are read: with the lowering off, `1::add(2)` is
// still a Method Invocation and is folded as one.
//
// NOTE: A RAW test is never folded, only an `essence-boolean` around one. A raw
// intrinsic stands where JavaScript says `if (…)` — a lowered Conditional's
// question, a Match Handler's test, a dispatch case's — and a `BooleanValue`
// there would be an object, which is true whatever it holds.
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

	// NOTE: Integers alone. Two Strings are equal when their CHARACTERS are,
	// which is a comparison of their canonically normalised forms — an answer
	// the JavaScript running the Compiler gives out of its own Unicode tables,
	// and not necessarily the ones the JavaScript running the Program has. The
	// call stays, and answers where the Program runs.
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
		case "Rational":
			return foldRational(node, member, shadowed)
		case "String":
			return foldString(node, member, shadowed)
		default:
			return node
	}
}

// NOTE: The operations whose bodies are one bigint operation — the same
// enumeration `lower-scalar-operations` writes out, plus the two that take only
// the receiver. `divide` and `quotient` answer an Optional and `raise` is the
// one whose answer can be larger than the Program that asks for it; `compare`
// answers an `Ordering` Case, which is a value to build rather than a literal to
// write.
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

// NOTE: Two Rationals, and no other pair. The Essence bodies for a Rational
// beside an Integer are three further bodies to follow exactly, for an operand
// pair nobody writes as two literals — and mixed kinds are left to the general
// path here for the same reason `lower-scalar-operations` leaves them there.
//
// NOTE: Each of these IS the Essence body, carried out. The arithmetic reads
// both operands in LOWEST TERMS, because that is what `numerator()` and
// `denominator()` answer, and hands the result to `Rational.of`, which stores it
// as it is given — so the folded parts are the parts the Program would have
// stored, unreduced, and print in lowest terms exactly as they would have.
// The comparisons cross-multiply the STORED parts, which is what
// `Rational.compare` does, and answer the same for either spelling of a value.
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

		// NOTE: `absolute` answers the Rational ITSELF where it is not negative
		// — `<- @` — so a `4/2` stays 4 over 2 rather than turning into its own
		// lowest-terms form. `negate` goes through `Rational.of` on the
		// lowest-terms parts, so it does not.
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

	// NOTE: The cross-multiplication `Rational.compare` performs, on the parts
	// as stored. Denominators are positive — `createRational` puts the sign on
	// the numerator — so the sign of the difference is the sign of the
	// comparison.
	let ordering =
		left.numerator * right.denominator - right.numerator * left.denominator

	switch (member) {
		case "add":
			return rationalNode(addedRationals(left, right), node)
		case "subtract":
			return rationalNode(
				addedRationals(left, negatedRational(right)),
				node,
			)
		case "multiply":
			return rationalNode(multipliedRationals(left, right), node)
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

// NOTE: Concatenation, which is the one String operation that is JavaScript's
// own `+` on what the two values hold — `append` is `createString(a.value +
// b.value)` and `prepend` is `append` with the operands the other way round.
// Every other String Method either normalises, segments or allocates by a rule
// the Compiler's own JavaScript would answer with its Unicode tables rather
// than the Program's.
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

// NOTE: A hole whose value is written out and whose witness names a Method the
// Compiler can carry out is TEXT, and text is what the segment becomes. The
// Rewriter renders a hole as `<witness>.toString(<value>).value` and
// concatenates the pieces, so a hole that folds costs the Program nothing at
// all: no witness, no call, no String built to be read back out of.
//
// NOTE: And where every hole folds, the interpolation is a String literal — one
// the pool then declares once, where the unfolded form built it at every
// evaluation.
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

		// NOTE: Runs of text are joined as they are folded. The Rewriter emits
		// each segment as a piece of one `+` chain, so two text pieces beside
		// each other are two literals JavaScript would concatenate at run time
		// to no purpose.
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

// NOTE: What one hole renders to, or null wherever the Compiler can not say.
// `toString` is the one Method `Printable` declares and the one the Rewriter
// calls, and the four entries below are the standard library's own — each read
// off the source of the Method it stands for, each an operation on the literal
// and nothing else.
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
		// NOTE: `Integer.toString` is `createString(value.toString())`, which is
		// what a bigint's own decimal spelling is.
		case "Integer": {
			let integer = integerOf(value)

			return integer === null ? null : integer.toString()
		}
		// NOTE: `String::toString` answers the String itself.
		case "String":
			return value.nodeType === "StringValue" ? value.value : null
		// NOTE: `Boolean::toString` is written as the Conditional that spells
		// the two answers out.
		case "Boolean":
			return value.nodeType === "BooleanValue"
				? value.value
					? "true"
					: "false"
				: null
		// NOTE: The no-Argument `Rational::toString` is the numerator, a slash
		// and the denominator — the lowest-terms accessors, which is why a
		// Rational storing 4 and 2 renders `2/1`.
		case "Rational": {
			let rational = rationalOf(value)

			if (rational === null) {
				return null
			}

			let parts = reduced(rational.numerator, rational.denominator)

			return `${parts.numerator}/${parts.denominator}`
		}
		default:
			return null
	}
}

// NOTE: The Namespace whose `toString` a hole's witness names — and only where
// the witness says so outright. `devirtualise-witnesses` runs first and leaves a
// `direct-method` at every hole it could name a Function for; a witness that is
// still a `ConformanceValue` is one that pass refused, or one it never saw
// because it was turned off, and it is read here the same way. A CONDITIONAL
// conformance is refused by both: the Function behind its `toString` is one the
// call curries rather than one anybody declared.
//
// NOTE: The name is the standard library's only where the Program has not taken
// it, which is the caller's question — and it is a Namespace's own name rather
// than the conforming Type's, so a `namespace Loud for Integer is Printable`
// answers `"Loud"` here and is left alone.
function printingNamespaceOf(
	witness: common.typedSimple.ExpressionNode,
): string | null {
	if (witness.nodeType === "Intrinsic" && witness.kind === "direct-method") {
		if (witness.derivedDescriptor !== undefined) {
			return null
		}

		return withoutOverloadSuffix(witness.memberName) === "toString"
			? witness.namespaceName
			: null
	}

	if (witness.nodeType !== "ConformanceValue") {
		return null
	}

	if (witness.conditions.length !== 0 || witness.derivedDescriptor) {
		return null
	}

	let memberName = witness.methodMap["toString"]

	if (memberName === undefined) {
		return null
	}

	return withoutOverloadSuffix(memberName) === "toString"
		? witness.namespaceName
		: null
}

// NOTE: The receiver and the Method's own Parameters, all of EXACTLY the named
// kind — the same question `lower-scalar-operations` asks, for the same reason:
// a Union-typed operand or a Type Parameter reaches a different Method, and a
// second Parameter means a different entry of the Overload.
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

// NOTE: The literal readers, and the whole of what makes a fold possible: a
// value written in the source, read as the number the Rewriter would have
// emitted. A spelling that is not plain digits is refused rather than coerced —
// the Lexer can not produce one, and a fold is not the place to find out
// otherwise.
const decimalDigits = /^-?[0-9]+$/

function integerOf(node: common.typedSimple.ExpressionNode): bigint | null {
	if (node.nodeType !== "IntegerValue" || !decimalDigits.test(node.value)) {
		return null
	}

	return BigInt(node.value)
}

// NOTE: A Rational literal as the parts the value HOLDS, which is what
// `Rational.createRational` stores rather than what was written: the sign moves
// onto the numerator and a zero is `0/1`. A zero denominator is refused — the
// value it makes is one no operation here has an answer for.
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

// NOTE: What `Rational.createRational` makes of two bigints — the single
// gateway every Rational in a running Program is built through, written out
// here because a folded Rational has to hold what one built there would.
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

// NOTE: `Rational::add`, statement for statement — both operands' lowest-terms
// parts cross-multiplied onto the shared denominator, handed to `Rational.of`.
function addedRationals(
	left: { numerator: bigint; denominator: bigint },
	right: { numerator: bigint; denominator: bigint },
): { numerator: bigint; denominator: bigint } {
	let first = reduced(left.numerator, left.denominator)
	let second = reduced(right.numerator, right.denominator)

	return storedRational(
		first.numerator * second.denominator +
			second.numerator * first.denominator,
		first.denominator * second.denominator,
	)
}

// NOTE: `Rational::subtract` is `@::add(other::negate())`, and `negate` is
// `Rational.of` over the lowest-terms parts with the numerator flipped — so the
// operand the addition above is given is this, and not the operand's own stored
// parts.
function negatedRational(value: { numerator: bigint; denominator: bigint }): {
	numerator: bigint
	denominator: bigint
} {
	let parts = reduced(value.numerator, value.denominator)

	return storedRational(-parts.numerator, parts.denominator)
}

// NOTE: `Rational::multiply` — the lowest-terms numerators and denominators
// multiplied, handed to `Rational.of`.
function multipliedRationals(
	left: { numerator: bigint; denominator: bigint },
	right: { numerator: bigint; denominator: bigint },
): { numerator: bigint; denominator: bigint } {
	let first = reduced(left.numerator, left.denominator)
	let second = reduced(right.numerator, right.denominator)

	return storedRational(
		first.numerator * second.numerator,
		first.denominator * second.denominator,
	)
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

// NOTE: The written-out answers. Each carries the Type and the Position of the
// Node it replaces — the Position above all, because the operation is where the
// author wrote it and a debugger stopping there should still say so.
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
