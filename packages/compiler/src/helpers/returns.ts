import type { common } from "@essence-lang/interfaces"

// Whether every path through a body reaches a `<-`. The Validator refuses a body
// that promises a value and can fall off its end. The Simplifier ends any other
// body with a unit `return`, since JavaScript would answer `undefined`. Only a
// `<-` and an `if`/`else` whose halves both return count.
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
