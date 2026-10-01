import type { common } from "@essence-lang/interfaces"

import { derivedEquatableNamespaceName } from "../../enricher/resolvers"
import type { OptimiserPass } from "../index"
import { rewriteExpressions } from "../walk"

// Lowers `is` and `isNot` between a Choice and one of its payload-less Cases to
// a tag comparison, `value[<Type key>] === "Ordering#Less"`, in place of the
// `choiceIs` call. That covers the prelude's comparisons, which end in
// `@::compare(to other)::is(Ordering#Less)`.
//
// A payload-less Case has nothing beyond its tag to compare, so the tag is the
// whole answer. A Function carries no Type key, so it compares false, as
// `anyIs` answers. A generic Choice's descriptor is checked to name no members
// for the tag. A comparison reached through a Union dispatch is a dispatch
// case, not an Invocation, and is left alone.

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

	// The Namespace the enricher fabricates for a Choice declaring `is
	// Equatable` without writing it, which the rewriter turns into the runtime
	// helper.
	if (node.base.name !== derivedEquatableNamespaceName) {
		return node
	}

	if (node.member.name !== "is" && node.member.name !== "isNot") {
		return node
	}

	// The replacement carries the Invocation's Type, which has to be Boolean.
	if (node.type.type !== "Boolean") {
		return node
	}

	// The simplifier's order: the receiver under `@`, the one Parameter, then
	// any conformance witnesses. Any other shape keeps the runtime helper.
	let [receiver, compared, ...witnesses] = node.arguments

	if (receiver === undefined || compared === undefined) {
		return node
	}

	if (receiver.name !== "@" || compared.name !== null) {
		return node
	}

	// The witnesses are dropped with the call, which is safe only for values
	// that are built rather than run.
	if (!witnesses.every((witness) => isConformanceArgument(witness.value))) {
		return node
	}

	let negated = node.member.name === "isNot"
	let comparedTag = unitCaseTagOf(compared.value, node.derivedDescriptor)

	if (comparedTag !== null) {
		return tagTest(node, node.type, receiver.value, comparedTag, negated)
	}

	// `#Less::is(ordering)` asks the same. A unit Case holds no Expression, so
	// dropping it loses no work.
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
	// The raw test wrapped in the interned Boolean the Invocation answered.
	// Both carry the Invocation's Position, the span of the whole comparison.
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

// A Case written without a payload, whose Type declares no members either.
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

	// A generic Choice compares the members its plan names for the tag, so a
	// plan naming any is refused.
	if (descriptor !== undefined) {
		let members = descriptor[node.tag]

		if (members !== undefined && Object.keys(members).length !== 0) {
			return null
		}
	}

	return node.tag
}

// A forwarded Parameter, or a method map whose conditions are witnesses too.
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
