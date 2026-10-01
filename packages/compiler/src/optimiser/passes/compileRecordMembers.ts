import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { memberReadOf } from "../reads"
import { type MatcherMemberTest, recordMatcherTests } from "../residual"
import { rewriteExpressions } from "../walk"

// Writes a Record Matcher's check as the member tests `recordMatcherTests`
// plans, in place of the descriptor walk. It rewrites every `type-test` whose
// descriptor is a Record Type. See "compile-record-members" in DEVELOPMENT.md.

export const compileRecordMembers: OptimiserPass = {
	name: "compile-record-members",
	run: (program) => rewriteExpressions(program, compile),
}

// The most tests a tree may hold. A size rule: a plan is taken or refused
// whole, since a truncated conjunction asks less than the walk.
const testBudget = 8

function compile(
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "Intrinsic" || node.kind !== "type-test") {
		return node
	}

	let descriptor = node.descriptor

	if (
		descriptor.nodeType !== "Intrinsic" ||
		descriptor.kind !== "type-descriptor"
	) {
		return node
	}

	// The value is read once per test, so it must be one re-reading can not
	// change. Anything else keeps its single call.
	if (!isRepeatableRead(node.value)) {
		return node
	}

	let tests = recordMatcherTests(descriptor.descriptor, node.value.type)

	// An empty plan would mean `always`, which never reaches this Node.
	if (tests === null || tests.length === 0 || tests.length > testBudget) {
		return node
	}

	return conjunctionOf(
		tests.map((test) => testExpression(node.value, test)),
		node.position,
	)
}

// One test over the member path it reads. Its descriptor stands in an
// Expression position, where `pool-constants` can hoist it.
function testExpression(
	value: common.typedSimple.ExpressionNode,
	test: MatcherMemberTest,
): common.typedSimple.ExpressionNode {
	let read = memberReadOf(value, test.path)

	if (test.check.kind === "tag") {
		return {
			nodeType: "Intrinsic",
			kind: "tag-test",
			value: read,
			tag: test.check.tag,
			negated: false,
			optional: test.check.optional,
			type: { type: "Boolean" },
		}
	}

	return {
		nodeType: "Intrinsic",
		kind: "type-test",
		value: read,
		descriptor: {
			nodeType: "Intrinsic",
			kind: "type-descriptor",
			descriptor: test.check.matcher,
			type: { type: "Unknown" },
		},
		type: { type: "Boolean" },
	}
}

// `&&` over raw booleans. Its short circuit is relied on, since a test reads a
// member the tests before it proved present.
function conjunctionOf(
	tests: Array<common.typedSimple.ExpressionNode>,
	position: common.Position | undefined,
): common.typedSimple.ExpressionNode {
	let test = tests.reduce((left, right) => ({
		nodeType: "Intrinsic",
		kind: "raw-boolean-op",
		operator: "and",
		operand: left,
		other: right,
		type: { type: "Boolean" },
	}))

	return position === undefined ? test : { ...test, position }
}

// A name, or a member read off one, which reads the same every time.
function isRepeatableRead(node: common.typedSimple.ExpressionNode): boolean {
	if (node.nodeType === "Identifier") {
		return true
	}

	return node.nodeType === "Lookup" && isRepeatableRead(node.base)
}
