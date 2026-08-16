import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { memberReadOf } from "../reads"
import { type MatcherMemberTest, recordMatcherTests } from "../residual"
import { rewriteExpressions } from "../walk"

// NOTE: A Record's runtime tag says only that the value is a Record, so a Match
// distinguishing Records by their MEMBERS could be reduced no further than the
// general check — `$type.isValueOfType(_self, $pool_0)`, which walks a
// descriptor tree the Compiler wrote itself, asks `Object.entries` of it, and
// then asks the runtime about each member Type in turn. Where the members are
// what decide, the members are what is read:
//
//   _self.kind[$type.typeKeySymbol] === "String"
//
// NOTE: The saving is a call, a ladder of kind comparisons, an `Object.entries`
// array per test and a closure per member — and, where the member Types are
// Lists or Records themselves, the walk of those too. What is left is one
// property read and one comparison per member that still has something to say.
//
// NOTE: What decides is `residual.ts`, exactly as it decides a Matcher's own
// check: `recordMatcherTests` is the erasure argument and the plan, and this
// pass is the emission half. Nothing here asks a question about a Type; it takes
// a plan and writes it out.
//
// NOTE: ONE shape in, and that is the whole of what it looks for: an
// `Intrinsic` `type-test` whose descriptor is a Record Type. That Node stands in
// three places by the time this runs — a Match Handler's own check, a Case
// Matcher's payload requirement, and a compiled Union dispatch's case — and each
// of the three carries the Type of the value it asks about, which is the only
// thing the plan needs. So one rule retires the descriptor walk in all three,
// and a fourth site added later is served without this pass hearing about it.
//
// NOTE: Two passes leave that Node: `compile-type-tests` writes a Match
// Handler's check and a payload requirement into one, and `compile-union-dispatch`
// builds its own for a case. So turning either off still leaves the other's, and
// only the whole phase off leaves none — at which point there is nothing here to
// do and the general question is asked the general way. That is cooperation
// rather than dependence: this pass does more with a shape another pass leaves,
// and nothing at all without one, which is the same Program either way.
//
// NOTE: What this does NOT claim is that the Matcher is decided by a tag. A
// member test is exactly where a runtime answer and a static Type can part
// company, so `elide-final-match-test` and `compile-union-dispatch`'s last-case
// elision go on declining a Handler whose check this compiled, and the throw
// that names a Compiler bug stays. Where the tag DOES decide a Record Matcher —
// one claimant among what can arrive, implying the Matcher — `residual.ts`
// answers `tag` and those passes never reach this one.

export const compileRecordMembers: OptimiserPass = {
	name: "compile-record-members",
	run: (program) => rewriteExpressions(program, compile),
}

// NOTE: How many tests a tree may hold before the descriptor is left alone, and
// it is a SIZE rule rather than a soundness one — a plan is refused whole or
// taken whole, never truncated, because a truncated conjunction asks less than
// the walk it replaced. What it trades: the walk is one call against one pooled
// descriptor shared by every site that names the same Matcher, while a tree is
// written out at each site, so a Matcher of many members is cheaper to run and
// dearer to carry. The largest tree the fixtures produce holds two tests, so the
// number is a ceiling on a Program nobody has written rather than a line this
// was tuned against.
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

	// NOTE: The tested value is READ ONCE PER TEST, so it has to be something
	// re-reading can not change the meaning of: a name, or a member read down a
	// chain of names. That is what stands here today — `_self` for a Handler,
	// the dispatch's held receiver for a case, a spine off `_self` for a payload
	// requirement — and anything else keeps the single call it already is.
	if (!isRepeatableRead(node.value)) {
		return node
	}

	let tests = recordMatcherTests(descriptor.descriptor, node.value.type)

	// NOTE: A plan of nothing would be a claim that the check accepts every
	// value that can arrive, which is `residual.ts`' `always` and is not acted
	// on here — the Matcher would not have reached this Node if it were.
	if (tests === null || tests.length === 0 || tests.length > testBudget) {
		return node
	}

	return conjunctionOf(
		tests.map((test) => testExpression(node.value, test)),
		node.position,
	)
}

// NOTE: One test, over the member spine it reads. The read is built here rather
// than in the plan for the reason `compile-type-tests` builds its own: a
// descriptor that stands in an Expression position is one `pool-constants` can
// hoist, and a Type hanging off a plan is reachable by nothing.
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

// NOTE: `&&` over raw booleans, which is what every test in the tree is — and
// the short circuit is load-bearing rather than incidental: a test reads a
// member the tests before it proved is there, so one that ran anyway would read
// a member off a value that does not carry it. The rule that `and` may not take
// an operand that could be observed is what makes that safe to rely on: a tag
// comparison is a property read, and a `type-test` is a walk that reads only the
// value it is handed, so an operand the chain never reaches has nothing to say.
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

// NOTE: An Expression whose evaluation can be repeated without changing what the
// Program does or what it answers — a name, whose read observes nothing, or a
// member read off one, which is a property read of an immutable value. Every
// value in the language is immutable and nothing between two tests of one
// conjunction can run, so the second read of a name answers what the first did.
function isRepeatableRead(node: common.typedSimple.ExpressionNode): boolean {
	if (node.nodeType === "Identifier") {
		return true
	}

	return node.nodeType === "Lookup" && isRepeatableRead(node.base)
}
