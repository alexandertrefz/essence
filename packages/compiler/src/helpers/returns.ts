import type { common } from "@essence-lang/interfaces"

// NOTE: Whether every path through a body reaches a `<-`. Two stages need the
// same answer and must never disagree: the Validator refuses a body that
// promises a value and can fall off its end, and the Simplifier gives the
// bodies that may fall off — the ones returning unit — the `return` that says
// so, because JavaScript would otherwise answer `undefined`, which is not an
// Essence value at all. Conservative on purpose: only a `<-` and an
// `if`/`else` whose both halves return count, so anything it can not see
// through is treated as falling through.
export function bodyDefinitelyReturns(
	body: Array<common.typed.ImplementationNode>,
): boolean {
	return body.some(nodeDefinitelyReturns)
}

function nodeDefinitelyReturns(node: common.typed.ImplementationNode): boolean {
	if (node.nodeType === "ReturnStatement") {
		return true
	}

	if (node.nodeType === "IfElseStatement") {
		return (
			bodyDefinitelyReturns(node.trueBody) &&
			bodyDefinitelyReturns(node.falseBody)
		)
	}

	return false
}
