import type { common } from "@essence-lang/interfaces"

import { fitsWritten } from "../helpers/predicateEval"
import {
	measuredValue,
	returnedTypeOf,
	typeContainsError,
} from "../helpers/types"
import { undeclaredMembers } from "../helpers/undeclaredMembers"

// Whether a value fits where it was written. A written literal carries its
// own evidence for a refinement, so `constant d: NonZeroInteger = 3` fits. A
// hole fits, and so does a Function refused as a value, which a value holding
// one is measured around. See "Holes" in DEVELOPMENT.md.
export function fitsExpectedType(
	expected: common.Type,
	value: common.typed.ExpressionNode,
	// The Type as declared, whose members a Literal may name. Null where the
	// Type was worked out from the value, which declares nothing.
	declared: common.Type | null = expected,
): boolean {
	let measured = measuredValue(value)

	return (
		typeContainsError(expected) ||
		measured.type.type === "Error" ||
		(fitsWritten(expected, measured) &&
			(declared === null ||
				undeclaredMembers(declared, measured).length === 0))
	)
}

// The return Type a `<-` names members against: a written one, or the one an
// expected signature declared. A completing body's `<-` answers what its
// `Future` holds. See "Undeclared members" in
// packages/compiler/src/helpers/DEVELOPMENT.md.
export function declaredReturnType(
	definition: common.typed.FunctionDefinitionNode,
): common.Type | null {
	let declared =
		definition.inferredReturnType === null
			? definition.returnType
			: (definition.returnShape ?? null)

	return declared === null
		? null
		: returnedTypeOf(declared, definition.completing === true)
}
