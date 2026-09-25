import type { common } from "@essence-lang/interfaces"

import { type AnalysisOptions, analyseSource } from "../analysis"
import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { parse, parseWithDiagnostics } from "../parser/index"

// NOTE: The three things a test about a Help does — report a probe, read the
// Help off it, and COMPILE what it printed. They were written inside
// `knownAnswers.spec.ts`, which is where the first reporters to earn them were
// tested; the Help audit needs the same three from every spec it wrote, so they
// moved here rather than being written a second way.
//
// A Help is a promise that what it prints works when it is followed, and a
// report that breaks that promise is worse than one that says nothing — so the
// spellings a Help spells are compiled here rather than compared as text.
//
// ONE file, because two of them is two answers to "does this compile?": the
// audit briefly had a second harness whose `compiles` stopped after the
// Enricher, and a Help followed into a Validator refusal read there as a
// success. `compiles` runs every stage, through `analyseSource`, while
// `firstOf` and `enrichedDiagnosticsFor` stop after the Enricher.

// NOTE: Not exported: `firstOf` below is what a spec reaches for, and an export
// nobody imports is a promise to keep a reader for.
function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrich(parse(source)).diagnostics
}

// NOTE: Throws rather than answering null, and names every code that WAS
// reported: a probe that stopped reporting what it was written for is a test
// that has to say what it got instead, or the next reader spends the afternoon
// finding out.
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

// NOTE: What a Help promises, checked by compiling it. A test passes here its
// own probe with the Help's spelling written into it, so a Help that stops
// compiling fails the test that prints it rather than a reader's afternoon.
//
// The whole pipeline, so that a Help followed into a Validator refusal fails
// here rather than reading as a success — `analyseSource` is the one
// description of what every stage has to say about one source.
export function compiles(
	source: string,
	options: AnalysisOptions = {},
): boolean {
	return !containsErrors(analysedDiagnosticsFor(source, options))
}

// NOTE: The Parser and the Enricher, for the reports that never reach the
// Validator: a probe whose point is a Type error stops there, and running the
// Validator over a Program the Enricher gave up on only adds what it could not
// judge.
export function enrichedDiagnosticsFor(
	source: string,
): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	return [...parsed.diagnostics, ...enrich(parsed.program).diagnostics]
}

// NOTE: Every stage, for the Helps the VALIDATOR writes — a Match's Cases, a
// bounded Function stored as a value. The Enricher reports none of them, so a
// test that asked it alone would find nothing and say the reporter had stopped.
//
// `tests` is off unless a probe asks for it, the way `esc check` has it off: a
// `tests { … }` section is walked only where something is going to run it, and a
// spec about a report inside one has to say so or find an empty list.
export function analysedDiagnosticsFor(
	source: string,
	options: AnalysisOptions = {},
): Array<common.Diagnostic> {
	return analyseSource(source, undefined, options).diagnostics
}

// NOTE: `firstOf` over the whole pipeline, with the same insistence on naming
// what WAS reported when the probe stops reporting what it was written for.
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

// NOTE: Every code one source is refused with, in the order a reader meets them
// — the same list `esc` prints and the editor underlines. A cascade is tested by
// writing the whole list down, so a report that comes back is a failure rather
// than something the next reader finds.
export function codesOfSource(
	source: string,
	options: AnalysisOptions = {},
): Array<common.DiagnosticCode> {
	return analysedDiagnosticsFor(source, options).map(
		(diagnostic) => diagnostic.code,
	)
}

// NOTE: The Helps of the first report carrying this code, which is `firstAnalysed`
// with the one thing a spec about a Help wants off it.
export function helpsOfCode(
	source: string,
	code: common.DiagnosticCode,
): Array<string> {
	return firstAnalysed(source, code).helps ?? []
}

// NOTE: The codes whose Helps are COMPILED somewhere — the registry the Help
// specs maintain between them, and the one thing `helpCoverage.spec.ts` can not
// work out for itself. A Help that spells an edit the reader is told to WRITE is
// a promise, and the only way to keep it is to write that spelling into the
// probe and compile the result; a Help nobody compiles is a Help that goes stale
// the next time the spelling it names changes.
//
// Added to by the spec that starts compiling one. `helpCoverage.spec.ts` holds
// it to the docs page both ways: an entry here that the page shows no "Write
// '…'" Help for is an entry that has lost its subject, and the codes on the page
// that are NOT here are printed as the list still to do.
export const COMPILE_CHECKED_HELP_CODES: ReadonlyArray<common.DiagnosticCode> =
	[
		"ambiguous-case",
		"dictionary-entry-syntax",
		"duplicate-type-parameter",
		"foreign-syntax",
		"incomplete-record-argument",
		"invalid-escape",
		"malformed-unicode-escape",
		"method-called-with-dot",
		"missing-documentation-separator",
		"nonconforming-namespace",
		"operator-not-supported",
		"redundant-pattern-binder",
		"surrogate-unicode-escape",
		"unbraced-unicode-escape",
		"unicode-escape-out-of-range",
		"unknown-name",
		"wrong-type-argument-count",
	]
