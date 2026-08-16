import type { common } from "@essence-lang/interfaces"

import { derivedEquatableNamespaceName } from "../../enricher/resolvers"
import type { OptimiserPass } from "../index"
import { rewriteExpressions } from "../walk"

// NOTE: Comparing a Choice with one of its payload-less Cases is a question
// about a tag and nothing else, and it was answered by a call into the runtime
// that worked that out again at every comparison: `$helpers.choiceIs(value,
// $type.createCase("Ordering#Less"))` looked the interned Case up in a Map,
// called `anyIs`, walked its ladder of kind tests, reached the Case arm, read
// both tags — and then compared the payloads neither of them has. What decides
// it is `value[<Type key>] === "Ordering#Less"`, so that is what is emitted.
//
// NOTE: This is the standard library's whole comparison family. `isLessThan` is
// `@::compare(to other)::is(#Less)`, and `isGreaterThanOrEqualTo`,
// `isLessThanOrEqualTo` and `isGreaterThan` are written on those — every one of
// them ends in this shape, inside the prelude, which the Optimiser runs over
// alongside the Program. So the Method a loop's `a <= b` reaches is lowered
// once and every Program is compiled against the lowered one.
//
// NOTE: Tag equality is the whole answer, not an approximation of it. `anyIs`
// decides a Case nominally — same tag, then payloads compared as a Record's —
// and a Case declaring no payload members has none to compare, so the tag
// alone is what it was ever going to answer. A value that is not a Case at all
// answers `false` both ways: a Function carries no Type key, so the read gives
// `undefined` and the comparison is false rather than a crash, exactly as
// `anyIs` answers `false` for a Function beside a Case.
//
// NOTE: A *generic* Choice compares through a descriptor instead
// (`boundChoiceIs`), which reads the same tags first and then the plan for that
// tag's payload members. The plan for a unit Case names no members, so the two
// agree — but the pass checks the descriptor rather than trusting that, because
// the descriptor is what the runtime will read.
//
// NOTE: What is NOT lowered here: a Choice equality reached through a Union
// dispatch. It is the same comparison and it will be lowered where dispatch is
// (`compile-union-dispatch`), because the shape to rewrite there is the dispatch
// case rather than the Invocation.

export const lowerUnitCaseEquality: OptimiserPass = {
	name: "lower-unit-case-equality",
	run: (program) => rewriteExpressions(program, lower),
}

function lower(
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "MethodInvocation") {
		return node
	}

	// NOTE: The Namespace no Namespace is — the Enricher fabricates one of
	// these per receiver for a Choice that declares `is Equatable` without
	// writing it, and the Rewriter turns the one reference to it into the
	// runtime helper. Matching it here is matching exactly the Invocations that
	// reach `choiceIs`/`choiceIsNot`, and no Method a user wrote.
	if (node.base.name !== derivedEquatableNamespaceName) {
		return node
	}

	if (node.member.name !== "is" && node.member.name !== "isNot") {
		return node
	}

	// NOTE: What it answers, asked rather than assumed — the intrinsic that
	// replaces this Invocation carries the Invocation's own Type, and it is a
	// Boolean the interned instances stand for.
	if (node.type.type !== "Boolean") {
		return node
	}

	// NOTE: The Simplifier's own Argument order — the receiver under `@`, then
	// the one declared Parameter, then the hidden conformance witnesses a
	// generic Choice's equality is given. Anything else is a shape this pass was
	// not written against, and is left to the runtime helper that understands
	// it.
	let [receiver, compared, ...witnesses] = node.arguments

	if (receiver === undefined || compared === undefined) {
		return node
	}

	if (receiver.name !== "@" || compared.name !== null) {
		return node
	}

	// NOTE: The witnesses are dropped along with the call, so what they are
	// matters: a conformance Argument is either a forwarded Parameter or a
	// method map, both of which are built rather than run — no Method is called
	// to make one, and nothing observable happens when one is not made. Checked
	// rather than assumed, because "the Simplifier only puts witnesses here" is
	// a fact about another file.
	if (!witnesses.every((witness) => isConformanceArgument(witness.value))) {
		return node
	}

	let negated = node.member.name === "isNot"
	let comparedTag = unitCaseTagOf(compared.value, node.derivedDescriptor)

	if (comparedTag !== null) {
		return tagTest(node, node.type, receiver.value, comparedTag, negated)
	}

	// NOTE: The other way round — `#Less::is(ordering)` asks the same question
	// of the same two values. Dropping the receiver drops nothing: a unit Case
	// is written as a tag and holds no Expression to evaluate, so there is no
	// work and no order to preserve.
	let receiverTag = unitCaseTagOf(receiver.value, node.derivedDescriptor)

	if (receiverTag !== null) {
		return tagTest(node, node.type, compared.value, receiverTag, negated)
	}

	return node
}

function tagTest(
	node: common.typedSimple.MethodInvocationNode,
	type: common.BooleanType,
	value: common.typedSimple.ExpressionNode,
	tag: string,
	negated: boolean,
): common.typedSimple.ExpressionNode {
	// NOTE: The test answers a raw JavaScript boolean and the Invocation
	// answered a Boolean, so the test is wrapped in the one that hands back an
	// interned Boolean instance — which is what `choiceIs` did with `anyIs`'s
	// answer, minus the call.
	//
	// NOTE: Both carry the Invocation's Position, which is the span of the whole
	// comparison — the two are one Expression written one way, and there is no
	// smaller piece of source for the test alone to point at.
	return {
		nodeType: "Intrinsic",
		kind: "essence-boolean",
		value: {
			nodeType: "Intrinsic",
			kind: "tag-test",
			value,
			tag,
			negated,
			optional: false,
			type,
			position: node.position,
		},
		type,
		position: node.position,
	}
}

// NOTE: A Case written with no payload, of a Case that declares no members to
// carry. Both halves are asked: the Node says how it was constructed and the
// Type says what a value of it can ever hold, and it is the second that makes
// the tag sufficient.
function unitCaseTagOf(
	node: common.typedSimple.ExpressionNode,
	descriptor: common.DerivedEquatableDescriptor | undefined,
): string | null {
	if (node.nodeType !== "CaseValue" || node.value !== null) {
		return null
	}

	if (node.type.type !== "Case") {
		return null
	}

	if (Object.keys(node.type.members).length !== 0) {
		return null
	}

	// NOTE: And what the runtime would read for that tag, when there is a plan
	// to read: a generic Choice's equality compares the members the plan names
	// for the tag, so a plan naming any is a comparison a tag can not answer.
	// A tag the plan does not name at all is compared structurally, which for a
	// payload-less Case is the tag again.
	if (descriptor !== undefined) {
		let members = descriptor[node.tag]

		if (members !== undefined && Object.keys(members).length !== 0) {
			return null
		}
	}

	return node.tag
}

// NOTE: The two shapes the Simplifier gives a conformance witness — a
// forwarded Parameter, and a Namespace's method map whose own `where`
// conditions are witnessed the same way.
function isConformanceArgument(
	node: common.typedSimple.ExpressionNode,
): boolean {
	if (node.nodeType === "Identifier") {
		return true
	}

	return (
		node.nodeType === "ConformanceValue" &&
		node.conditions.every((condition) => isConformanceArgument(condition))
	)
}
