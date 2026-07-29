import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { matcherResidual } from "../residual"
import { rewriteExpressions } from "../walk"

// NOTE: A Match asks the runtime which Type a value has, and it asked in the
// most general way there is: `$type.isValueOfType(_self, { type: "Case",
// choice: "Optional", name: "Value", members: { value: { type: "Integer" } } })`
// builds a descriptor tree at every test, hands it to a function that walks its
// ladder of kind tests to find the arm to take, reads the tag — and then walks
// the payload comparing member Types that the Compiler chose the descriptor
// from in the first place. Where the tag is the whole of what decides it, the
// tag is what is emitted:
//
//   _self[$type.typeKeySymbol] === "Optional#Value"
//
// NOTE: The saving is not only the call. A List Matcher's descriptor check
// walks EVERY ITEM of the List — `isValueOfType` is what a `List<Integer>`
// descriptor means — so `case List` over a ten thousand item List was ten
// thousand Type checks to answer a question the tag answers in one. That is the
// difference between O(n) and O(1) per Handler tested, and a Match inside a loop
// pays it per turn.
//
// NOTE: What decides is `residual.ts`, which is where the erasure rules live and
// which `elide-final-match-test` and (later) `compile-union-dispatch` ask as
// well. This pass is the emission half: it takes a residual of `tag` and writes
// the test, and leaves every other answer exactly as the Simplifier stated it.
//
// NOTE: A Handler with a LITERAL Matcher (`case 0`) is untouched, because there
// is no Type check to replace — `anyIs(_self, 0)` is the whole test, and it
// answers false across differing Types on its own. Member literals and Guards
// are untouched for the opposite reason: they are ANDed onto whichever test the
// Matcher produced, so replacing the Matcher's half leaves them saying what they
// said.

export const compileTypeTests: OptimiserPass = {
	name: "compile-type-tests",
	run: (program) => rewriteExpressions(program, compile),
}

function compile(
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "Match") {
		return node
	}

	let handlers = node.handlers.map((handler) => {
		if (handler.literal !== null || handler.typeTest !== null) {
			return handler
		}

		let residual = matcherResidual(handler.matcher, node.value.type)

		if (residual.kind !== "tag") {
			return handler
		}

		return { ...handler, typeTest: tagTest(node.value.type, residual.tag) }
	})

	if (handlers.every((handler, index) => handler === node.handlers[index])) {
		return node
	}

	return { ...node, handlers }
}

// NOTE: `_self` is the name the Rewriter binds the matched value to, and the
// name `@` lowers to inside a Handler's body — one value under one name, so a
// test written here reads what the body reads.
//
// NOTE: No Position, deliberately. A Handler's Type check is not a thing anyone
// wrote: the source says `case #Value(count)`, and the span of that is the
// Handler, whose body carries its own Positions. Mapping the test to the whole
// Match — the only Position in reach — would put every Handler's `if` on the
// Match's first line for a debugger, where today they map to nothing and are
// stepped over.
function tagTest(
	valueType: common.Type,
	tag: string,
): common.typedSimple.ExpressionNode {
	return {
		nodeType: "Intrinsic",
		kind: "tag-test",
		value: { nodeType: "Identifier", name: "_self", type: valueType },
		tag,
		negated: false,
		type: { type: "Boolean" },
	}
}
