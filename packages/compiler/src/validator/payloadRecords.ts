import type { common } from "@essence-lang/interfaces"

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
