import { tmpdir } from "node:os"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"

import {
	type AnalysisOptions,
	analyseLinkedModules,
	analyseSource,
} from "../analysis"
import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { loadModuleGraph } from "../modules/graph"
import { linkModuleGraph } from "../modules/link"
import { canonicalPath } from "../modules/resolve"
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
// followed into a Validator refusal fails too. A Help about imports is
// followed in a Program of several Modules, which compiles when every one
// does.
export function compiles(
	source: string | ModuleFiles,
	options: AnalysisOptions = {},
): boolean {
	return !containsErrors(
		typeof source === "string"
			? analysedDiagnosticsFor(source, options)
			: graphDiagnosticsFor(source, options),
	)
}

// A Program's Modules by file name, entered at the first. They are read from
// memory under a directory that need not exist, so no file is written or read.
// Only that directory's path is resolved.
export type ModuleFiles = Record<string, string>

function graphDiagnosticsFor(
	files: ModuleFiles,
	options: AnalysisOptions,
): Array<common.Diagnostic> {
	let directory = canonicalPath(path.join(tmpdir(), "essence-followed-helps"))
	let entry = Object.keys(files)[0] ?? "Main.es"
	let graph = loadModuleGraph(path.join(directory, entry), {
		readFile: (filePath) => files[path.relative(directory, filePath)],
	})
	let linked = linkModuleGraph(graph, { tests: options.tests })
	let analyses = analyseLinkedModules([...linked.modules.values()])

	return [...linked.diagnostics, ...[...(analyses?.values() ?? [])].flat()]
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
		"ambiguous-namespace",
		"ambiguous-nesting-level",
		"ambiguous-overload-answer",
		"at-in-static-method",
		"case-application-across-lines",
		"case-default-without-payload",
		"complete-outside-future",
		"condition-not-boolean",
		"cyclic-constant-import",
		"declarations-outside-stdlib",
		"define-without-answer-type",
		"define-without-otherwise",
		"dictionary-entry-syntax",
		"duplicate-import",
		"duplicate-type-parameter",
		"empty-dictionary-overlap",
		"empty-list-overlap",
		"empty-path-group",
		"expect-not-boolean",
		"expect-outside-test",
		"foreign-syntax",
		"incompatible-restatement",
		"incomplete-record-argument",
		"invalid-escape",
		"invalid-module-specifier",
		"literal-in-require",
		"malformed-unicode-escape",
		"matcher-after-value",
		"matcher-on-expect",
		"method-called-with-dot",
		"misnamed-documentation-parameter",
		"misplaced-module-section",
		"misplaced-tests-section",
		"missing-case",
		"missing-documentation-separator",
		"missing-payload",
		"missing-return",
		"mixed-rational-literal",
		"namespace-as-value",
		"nested-example",
		"no-namespace-for-value",
		"nonconforming-namespace",
		"not-a-function",
		"not-exported",
		"operator-not-supported",
		"partial-decimal-literal",
		"path-is-members-only",
		"path-key-outside-combination",
		"path-key-without-default",
		"path-without-context",
		"picked-requirement",
		"predicate-not-boolean",
		"property-parameters",
		"protocol-bound-namespace-generic",
		"provided-method-out-of-reach",
		"redundant-interpolation-to-string",
		"redundant-key-check",
		"redundant-pattern-binder",
		"reserved-parameter-label",
		"restated-inferred-parameter",
		"self-import",
		"shorthand-in-combination",
		"shorthand-on-path-key",
		"snapshot-after-matcher",
		"snapshot-not-printable",
		"static-method-on-value",
		"surrogate-unicode-escape",
		"table-not-written",
		"table-parameters",
		"test-outside-tests",
		"top-level-return",
		"type-argument-overlap",
		"type-without-members",
		"unbindable-case-payload",
		"unbraced-unicode-escape",
		"unclosed-block",
		"unclosed-string",
		"undecided-receiver-type",
		"undecided-type-arguments",
		"undispatchable-method",
		"undocumented-parameter",
		"unexpected-payload",
		"unexpected-token",
		"ungeneratable-type",
		"unicode-escape-out-of-range",
		"uninferable-item-type",
		"uninferable-property-type",
		"uninferable-return-type",
		"uninferable-type-parameter",
		"uninferred-type-parameter",
		"unknown-case",
		"unknown-method",
		"unknown-name",
		"unknown-where-generic",
		"unsatisfied-bound",
		"unsatisfied-conformance-condition",
		"unwritable-provided-method",
		"value-comment-outside-tests",
		"where-on-protocol-extension",
		"wrong-type-argument-count",
		"wrong-update-brackets",
	]
