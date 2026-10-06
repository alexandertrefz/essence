import type { common } from "@essence-lang/interfaces"

import {
	pairArguments,
	typeContainsError,
	withoutHoles,
} from "../helpers/types"

// Whether a positional Argument is a hole, which shifts the Arguments after
// it. A labelled hole shifts nothing. A hole is still one Argument with its
// label. A call whose Arguments do not pair, by count or by label, is measured
// whatever its holes. See "Holes" in DEVELOPMENT.md.
export function holesShiftTheCall(
	argumentNodes: Array<common.typed.ArgumentNode>,
	functionType: common.Type,
): boolean {
	if (
		(functionType.type === "Function" ||
			functionType.type === "SimpleMethod" ||
			functionType.type === "StaticMethod") &&
		pairArguments(
			functionType.parameterTypes,
			argumentNodes.map((argumentNode) => ({
				name: argumentNode.name,
				getType: () => argumentNode.type,
			})),
		) === null
	) {
		return false
	}

	// A written Union holding a hole is measured by its known members.
	return argumentNodes.some(
		(argumentNode) =>
			argumentNode.name === null &&
			typeContainsError(withoutHoles(argumentNode.value.type)),
	)
}
