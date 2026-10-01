import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteNodes } from "../walk"

// An Essence Boolean is an object, so a lowered test is wrapped in one and read
// back with `.value`. Where a condition is an `essence-boolean`, this asks the
// raw test it was built from instead. Any other condition is an Essence value
// and keeps its `.value` read. It covers `if` conditions and `define` arms
// alike, and with it off the Program only allocates more.

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

// Rebuilt only where an arm changed.
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

// The test a condition was built from, or null, including for a condition
// already asked raw.
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
