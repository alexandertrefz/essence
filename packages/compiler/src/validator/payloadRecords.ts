import type { common } from "@essence-lang/interfaces"

import { undeclaredMembers } from "../helpers/undeclaredMembers"

// Whether the payload is a Record naming one of the Case's members, which
// tells a written Record from a tried shorthand. A partial payload and one
// with an extra member are written Records too. Names only, since the Types
// disagreed.
export function payloadWritesTheCasesRecord(
	caseType: common.CaseType,
	value: common.typed.ExpressionNode,
): boolean {
	if (value.type.type !== "Record") {
		return false
	}

	return Object.keys(value.type.members).some((name) =>
		Object.hasOwn(caseType.members, name),
	)
}

// Whether a payload Literal names a member its Case does not declare. A
// generic Case's payload is measured where a Type is declared for it, which
// knows the Type Arguments, so it is not measured twice. See "Undeclared
// members" in packages/compiler/src/helpers/DEVELOPMENT.md.
export function payloadNamesUndeclared(
	caseType: common.CaseType,
	value: common.typed.ExpressionNode,
): boolean {
	return (
		(caseType.choiceGenerics ?? []).length === 0 &&
		undeclaredMembers({ type: "Record", members: caseType.members }, value)
			.length > 0
	)
}
