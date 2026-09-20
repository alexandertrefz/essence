import type { common } from "@essence-lang/interfaces"

import { analyseSource } from "../analysis"
import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { parseWithDiagnostics } from "../parser/index"

// NOTE: A Help is a promise that what it prints works when it is followed, and a
// report that breaks that promise is worse than one that says nothing. These are
// what a spec keeps that promise with: write the Help's own spelling into the
// probe it came from, and ask whether the result compiles.
//
// Shared rather than owned by one spec because the promise is made by reporters
// in three stages — `knownAnswers.spec.ts` was the first to check it and held
// `compiles` privately, and a Help printed by the Validator can not be compiled
// with a harness that stops after the Enricher.

// NOTE: Through the Enricher, which is as far as a Diagnostic about Types goes.
// Moved here verbatim from `knownAnswers.spec.ts`, which still calls it.
export function compiles(source: string): boolean {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return false
	}

	return !containsErrors(enrich(parsed.program).diagnostics)
}

// NOTE: And through every stage, for the Helps the Validator prints — a body
// that returns from every path, a Condition that answers a Boolean and a call
// that is a call are all things only the Validator has an opinion about, so a
// Help of its own that stopped at the Enricher would be checked against a stage
// that never reads it.
export function compilesCompletely(source: string): boolean {
	return !containsErrors(analyseSource(source).diagnostics)
}

// NOTE: What every stage says about one source, in the order a reader meets it —
// the same list `esc` prints and the editor underlines.
export function analysedDiagnostics(source: string): Array<common.Diagnostic> {
	return analyseSource(source).diagnostics
}

export function codesOfSource(source: string): Array<common.DiagnosticCode> {
	return analysedDiagnostics(source).map((diagnostic) => diagnostic.code)
}

// NOTE: The Helps of the FIRST report carrying this code. Throws where the code
// was not reported at all, naming what was — a spec that silently asserts the
// Helps of nothing is a spec that passes when the reporter stops running.
export function helpsOfCode(
	source: string,
	code: common.DiagnosticCode,
): Array<string> {
	let diagnostics = analysedDiagnostics(source)
	let found = diagnostics.find((diagnostic) => diagnostic.code === code)

	if (found === undefined) {
		throw new Error(
			`No '${code}' reported; got ${diagnostics
				.map((diagnostic) => diagnostic.code)
				.join(", ")}.`,
		)
	}

	return found.helps ?? []
}
