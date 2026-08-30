import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteNodes } from "../walk"

// NOTE: The one place a lowered Boolean is built only to be read back. Essence
// has no truthiness — a condition is a Boolean and nothing else — and an Essence
// Boolean is an OBJECT, so every question a Program asks is emitted as the
// `value` that object holds:
//
//   if ((a.value < b.value ? Boolean.trueInstance : Boolean.falseInstance).value)
//
// The comparison in the middle is one `lower-scalar-operations` already asked in
// JavaScript's own terms; the Boolean around it exists so that the Node it
// replaced still ANSWERS a Boolean, which is right everywhere but here, where
// the very next thing done with it is to take it apart again. Where a condition
// IS such a lowering, the test it was built from is what is asked and the
// Boolean between them is never built:
//
//   if (a.value < b.value)
//
// NOTE: The `essence-boolean` intrinsic and NOTHING else. A condition that is
// anything at all besides that — a Method a Namespace wrote, a name, a Record
// member — is an Essence value, and its `value` is what JavaScript has to be
// asked. Setting the raw flag over one of those would read `.value` off a
// primitive, answer `undefined`, and quietly make every such condition false.
//
// NOTE: TWO Nodes, because a condition is a condition wherever it is written. A
// Conditional Statement holds one; a `define` holds one per arm, and an arm's is
// the same Boolean built for the same reason — `rewriteDefine` reads `.value`
// off it exactly as an `if` does. They were one rewrite spelled once from the
// start rather than a second answer over here waiting to disagree with the
// first, which is the whole reason this is a pass of its own and not a case in
// the one that lowers Matches.
//
// NOTE: Nothing here is REQUIRED for a correct emission — the flag is false
// until something sets it, and false is the reading that builds the Boolean and
// takes it apart. So the registry's rule holds: with this pass off, the Program
// says what it always said, one allocation per question the worse for it.

export const unboxConditions: OptimiserPass = {
	name: "unbox-conditions",
	run: (program) =>
		rewriteNodes(program, {
			statement: (node) =>
				node.nodeType === "ConditionalStatement"
					? unboxedStatement(node)
					: node,
			expression: (node) =>
				node.nodeType === "Define" ? unboxedDefine(node) : node,
		}),
}

function unboxedStatement(
	node: common.typedSimple.ConditionalStatementNode,
): common.typedSimple.ConditionalStatementNode {
	let test = rawTest(node.condition, node.conditionIsRaw)

	return test === null
		? node
		: { ...node, condition: test, conditionIsRaw: true }
}

// NOTE: Every arm asked on its own, and the Node rebuilt only where one of them
// answered — the structural sharing the walk keeps rests on a pass answering
// with the very Node it was given wherever it changed nothing.
function unboxedDefine(
	node: common.typedSimple.DefineNode,
): common.typedSimple.DefineNode {
	let changed = false
	let arms = node.arms.map((arm) => {
		let test = rawTest(arm.condition, arm.conditionIsRaw)

		if (test === null) {
			return arm
		}

		changed = true

		return { ...arm, condition: test, conditionIsRaw: true }
	})

	return changed ? { ...node, arms } : node
}

// NOTE: The test a condition was BUILT from, and null wherever there is nothing
// to take apart — a condition already asked raw among them, which is a question
// this pass has answered once already and must not answer twice.
function rawTest(
	condition: common.typedSimple.ExpressionNode,
	isRaw: boolean,
): common.typedSimple.ExpressionNode | null {
	if (isRaw) {
		return null
	}

	if (
		condition.nodeType !== "Intrinsic" ||
		condition.kind !== "essence-boolean"
	) {
		return null
	}

	return condition.value
}
