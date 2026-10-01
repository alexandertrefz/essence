import type { common } from "@essence-lang/interfaces"

// Fills the required fields of a `common.Diagnostic` for specs that care about
// one field at a time. Code outside the tests must not use it, so every report
// site still decides each field.
//
// The parameter is not `Partial<common.Diagnostic>`: that distributes over the
// union and rejects the `Position | null` a spec of both halves passes.
export function testDiagnostic(partial: {
	severity: common.DiagnosticSeverity
	message: string
	position?: common.Position | null
	labels?: Array<common.DiagnosticLabel>
	notes?: Array<string>
	helps?: Array<string>
	code?: common.DiagnosticCode
	tags?: Array<common.DiagnosticTag>
}): common.Diagnostic {
	let { position = null, labels, ...rest } = partial

	return {
		code: "internal-error",
		notes: [],
		helps: [],
		...rest,
		position,
		labels: labels ?? [],
	} as common.Diagnostic
}
