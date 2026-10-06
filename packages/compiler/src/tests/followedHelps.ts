import type { common } from "@essence-lang/interfaces"

import { type AnalysisOptions, analyseSource } from "../analysis"
import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { parse, parseWithDiagnostics } from "../parser/index"

// The shared harness for specs about Helps: report a probe, read the Help off
// it, and compile what it printed. A Help promises that following it works, so
// its spelling is compiled rather than compared as text. One harness gives one
// answer to "does this compile?". `compiles` runs every stage through
// `analyseSource`, while `firstOf` and `enrichedDiagnosticsFor` stop after the
// Enricher.

// Not exported, since specs reach for `firstOf`.
function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrich(parse(source)).diagnostics
}

// Throws rather than answering null, naming every code that was reported, so
// a probe that stops reporting its code says what it got instead.
export function firstOf(
	source: string,
	code: common.DiagnosticCode,
): common.Diagnostic {
	let found = diagnosticsFor(source).find(
		(diagnostic) => diagnostic.code === code,
	)

	if (found === undefined) {
		throw new Error(
			`No '${code}' reported; got ${diagnosticsFor(source)
				.map((diagnostic) => diagnostic.code)
				.join(", ")}.`,
		)
	}

	return found
}

// A spec passes its probe with the Help's spelling written in, so a Help that
// stops compiling fails the spec that prints it. Every stage runs, so a Help
// followed into a Validator refusal fails too.
export function compiles(
	source: string,
	options: AnalysisOptions = {},
): boolean {
	return !containsErrors(analysedDiagnosticsFor(source, options))
}

// The Parser and the Enricher alone, for a probe whose point is a Type error.
// The Validator would only add what it could not judge in such a Program.
export function enrichedDiagnosticsFor(
	source: string,
): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	return [...parsed.diagnostics, ...enrich(parsed.program).diagnostics]
}

// Every stage, for the Helps the Validator writes, such as a Match's Cases or
// a bounded Function stored as a value. The `tests` mode is off unless a probe
// asks for it, so a report inside a `tests { … }` section needs that option.
export function analysedDiagnosticsFor(
	source: string,
	options: AnalysisOptions = {},
): Array<common.Diagnostic> {
	return analyseSource(source, undefined, options).diagnostics
}

// `firstOf` over every stage.
export function firstAnalysed(
	source: string,
	code: common.DiagnosticCode,
): common.Diagnostic {
	let all = analysedDiagnosticsFor(source)
	let found = all.find((diagnostic) => diagnostic.code === code)

	if (found === undefined) {
		throw new Error(
			`No '${code}' reported; got ${all
				.map((diagnostic) => diagnostic.code)
				.join(", ")}.`,
		)
	}

	return found
}

// Every code a source is refused with, in the order a reader meets them. A
// spec of a cascade writes the whole list down, so a returning report fails it.
export function codesOfSource(
	source: string,
	options: AnalysisOptions = {},
): Array<common.DiagnosticCode> {
	return analysedDiagnosticsFor(source, options).map(
		(diagnostic) => diagnostic.code,
	)
}

// The Helps of the first report carrying this code.
export function helpsOfCode(
	source: string,
	code: common.DiagnosticCode,
): Array<string> {
	return firstAnalysed(source, code).helps ?? []
}

// The codes whose Helps some spec compiles through `compiles`. A spec that
// starts compiling one adds it. `helpCoverage.spec.ts` holds this list to the
// diagnostics reference page both ways and prints the codes still to do.
export const COMPILE_CHECKED_HELP_CODES: ReadonlyArray<common.DiagnosticCode> =
	[
		"ambiguous-case",
		"at-in-static-method",
		"dictionary-entry-syntax",
		"duplicate-type-parameter",
		"expect-not-boolean",
		"expect-outside-test",
		"foreign-syntax",
		"incompatible-restatement",
		"incomplete-record-argument",
		"invalid-escape",
		"literal-in-require",
		"malformed-unicode-escape",
		"method-called-with-dot",
		"misnamed-documentation-parameter",
		"misplaced-tests-section",
		"missing-documentation-separator",
		"namespace-as-value",
		"nested-example",
		"nonconforming-namespace",
		"operator-not-supported",
		"path-without-context",
		"picked-requirement",
		"protocol-bound-namespace-generic",
		"provided-method-out-of-reach",
		"redundant-interpolation-to-string",
		"redundant-pattern-binder",
		"restated-inferred-parameter",
		"snapshot-not-printable",
		"surrogate-unicode-escape",
		"table-not-written",
		"table-parameters",
		"unbraced-unicode-escape",
		"undocumented-parameter",
		"unicode-escape-out-of-range",
		"uninferable-item-type",
		"uninferable-property-type",
		"uninferable-return-type",
		"unknown-name",
		"unknown-where-generic",
		"unsatisfied-bound",
		"unsatisfied-conformance-condition",
		"unwritable-provided-method",
		"where-on-protocol-extension",
		"wrong-type-argument-count",
	]
