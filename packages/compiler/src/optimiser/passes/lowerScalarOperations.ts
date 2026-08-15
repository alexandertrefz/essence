import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { isPureExpression, withoutOverloadSuffix } from "../purity"
import { rewriteExpressions } from "../walk"

// NOTE: The primitive operations of the language, written out where they were
// called. `a::isLessThan(b)` on two Integers is `a.value < b.value`, and it was
// a call into a Namespace whose Method called `Integer.compare`, which built an
// `Ordering` Case, which was compared against `#Less` — three calls and an
// allocation to decide something JavaScript decides with one `<`, on the
// bigints both values were holding all along.
//
// NOTE: It matters far past the sites a Program writes, because the standard
// library's own bodies are optimised alongside it and this is what THEY are
// made of: `isLessThanOrEqualTo` is `@::isGreaterThan(other)::negate()`,
// `subtract` is `@::add(other::negate())`, `isNot` is `@::is(other)::negate()`.
// Inside those bodies the receiver is `_self`, typed exactly `Integer`, so they
// lower like any other site and every Program is compiled against the lowered
// ones.
//
// NOTE: What makes it safe is that the Types are EXACT. `Integer` means an
// Integer and nothing else — not a Union it is a member of, not a Type
// Parameter that could be one — so the value at run time is the branded object
// the runtime's own constructor built, holding a number or a bigint under
// `value` and holding whichever of the two the canonical invariant gives that
// value. Every operation below is then what the runtime Method does to what is
// under there, with the call taken out: exact arithmetic, a total order, and
// structural equality. Equality is `===` because the invariant leaves one
// spelling per value; the arithmetic carries the guard that keeps it that way.
// Mixed kinds are left alone — an Integer beside a Rational is a widening the
// covering Namespace decides, and cross-multiplication is not `===`.
//
// NOTE: And that ARGUMENT ORDER survives. Essence evaluates every Argument
// before the call, so a lowering may not put one behind a JavaScript operator
// that might skip it: `&&` and `||` are used only over an operand that can be
// proven to observe nothing, and otherwise the call stays exactly as it was.
// `not` has one operand and is always evaluated, so it is never in question.

export const lowerScalarOperations: OptimiserPass = {
	name: "lower-scalar-operations",
	run: (program, namespaces) => {
		// NOTE: A Program may write `namespace Integer for Integer` in a block
		// of its own and give it an `isLessThan` that answers whatever it likes
		// — the name is free there, and it stands in front of the builtin for
		// the rest of the block. Such an Invocation carries the same Namespace
		// name and the same Types as the one this pass is written for, and the
		// only thing telling them apart is that the standard library's own
		// Namespaces are declared at a Program's top level and a Program's are
		// not. So a name a Program declares below its top level is refused for
		// the whole Program, which costs a Program that writes one nothing it
		// can measure.
		//
		// NOTE: The same set answers the purity question, and has to. Refusing
		// to LOWER `5::isLessThan(3)` says nothing about whether that call may
		// be skipped where it stands as the Argument of an `and` — and it may
		// not, for exactly the reason it may not be lowered.
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

	switch (node.base.name) {
		case "Integer":
			return lowerInteger(node, member)
		// NOTE: A refinement is erased before the first pass runs, so both
		// operands and the answer are plain Integers by the time this reads them
		// — but the Method the Simplifier emitted is still the refined
		// Namespace's, and a name is all this pass has to go by. `NonZeroInteger`
		// answers one Method, `multiply`, by re-exporting Integer's own product:
		// the same bigints, the same operator, and evidence that was spent while
		// compiling. So the one Method the two Namespaces share is asked of
		// Integer's own entry, and everything a Namespace of proven Integers might
		// grow later is left alone until somebody weighs it.
		case "NonZeroInteger":
			return member === "multiply" ? lowerInteger(node, member) : node
		case "Boolean":
			return lowerBoolean(node, member, shadowed)
		case "String":
			return lowerString(node, member)
		default:
			return node
	}
}

// NOTE: The comparison family, equality, and the three exact operations.
// `divide` is absent because it answers an Optional — dividing by zero is
// empty — and `quotient`, `remainder` and `raise` for the same reason or
// because their cost is in the answer's size rather than in the call.
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

// NOTE: Equality of two Strings is NOT `===` on what they hold. A String
// compares by its characters after canonical normalisation, so an accent
// written as one code point equals the same accent written as two — which is
// what `String.compare` decides and what `String.is` is written on. The
// lowering calls one runtime helper that decides exactly that, rather than
// writing the double normalisation out at every site: it is two allocations
// where the Strings differ, and worth one call to keep in one place.
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

	// NOTE: `negate` is the language's `not`, and it takes only the receiver —
	// which is evaluated wherever the answer comes from, so there is no
	// Argument to skip and nothing to prove about one.
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

	// NOTE: THE ONE PLACE THIS PASS CAN BE WRONG, and the reason
	// `isPureExpression` exists. `a::and(b)` evaluates `b` and then calls; `a &&
	// b` evaluates `b` only when `a` is true. Where `b` prints, assigns, or is a
	// call that might do either — or might not come back at all — the two are
	// different Programs, and this one stays the call it was. Lowering it
	// instead would need both operands in temporaries, which is a Statement,
	// which is a shape this pass does not produce.
	//
	// NOTE: The whole SUBTREE is asked, not the Node standing at its top. What
	// `and` skips is everything the Argument would have evaluated, so an
	// Invocation on a shadowed Namespace nested three Expressions down is as
	// much a reason to leave the call alone as one written directly.
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

// NOTE: The receiver and the one declared Parameter, both of EXACTLY the named
// kind — and null for anything else, which is where every Type question this
// pass rests on is asked. A Union-typed operand, a Type Parameter, a second
// Parameter (`is(_ other, comparing sensitivity)` is a different Method) or an
// Invocation shape the Simplifier did not produce all answer null and are left
// to the Namespace that understands them.
function scalarOperands(
	node: common.typedSimple.MethodInvocationNode,
	kind: "Integer" | "String" | "Boolean",
):
	| [common.typedSimple.ExpressionNode, common.typedSimple.ExpressionNode]
	| null {
	if (node.arguments.length !== 2) {
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

// NOTE: A raw test as an Essence Boolean. Both Nodes carry the Invocation's
// Position, which is the span of the whole operation as it was written — there
// is no smaller piece of source for the test alone to point at.
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

// NOTE: A Boolean value as the JavaScript boolean inside it — and, where the
// value is one this pass just built, the test it was built from. The walk is
// bottom-up, so `@::isGreaterThan(other)::negate()` reaches `negate` with its
// operand already lowered: unwrapping is what keeps the answer one comparison
// rather than a comparison, an interned Boolean, and a read back off it.
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

// NOTE: The opposite of a raw test, asked rather than negated wherever the test
// has an opposite to ask. Each rewrite below is an identity over the values
// that can reach it: the Integers a `raw-compare` reads are totally ordered
// whichever of their two representations each is holding, with no value unequal
// to itself the way a floating-point NaN is, so `!(a < b)` and `a >= b` decide
// the same thing; `!(a === b)` is
// `a !== b`; and a tag either is the tag or is not. What is left over —
// anything else — becomes JavaScript's own `!`, and `!` over a `!` is the
// operand again.
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
