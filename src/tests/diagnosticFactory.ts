import type { common } from "../interfaces/index"

// NOTE: `common.Diagnostic` requires a code, a labelled span and explicit
// notes and helps — deliberately, so that no Diagnostic in the Compiler can
// skip them. Tests about *rendering* and *plumbing* care about one field at a
// time, so they build theirs through this instead of restating the whole
// shape. Nothing in `src` outside the tests may use it: the point of the
// required fields is that a report site has to make each decision.
// NOTE: The parameter is spelled out rather than `Partial<common.Diagnostic>`
// — `Partial` of a union distributes, and the distributed form rejects a
// `Position | null` for `position`, which is exactly what a test that covers
// both halves needs to pass.
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
