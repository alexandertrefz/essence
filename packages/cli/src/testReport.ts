import { Source } from "@essence-lang/ariadne"
import {
	displayPath,
	renderDiagnostic,
} from "@essence-lang/compiler/diagnostics/render"
import {
	type FocusedTest,
	focusedTestsDiagnostic,
	type TestRecord,
	type TestRun,
	testFailureDiagnostic,
} from "@essence-lang/compiler/testing"

import type { ReportContext } from "./report"
import { formatDuration } from "./report"

// NOTE: Everything a person READS about a test run is produced here, as
// strings, so that the shape of the report can be asserted on without a
// terminal — the same rule `report.ts` follows for a compilation. What a run IS
// — the fold of the event stream, and the Diagnostics a failure produces — is
// the Compiler's, because the Language Server publishes the same ones.

// NOTE: Re-exported so that everything about a test RUN is still reached
// through one name from inside the command line, wherever it is defined.
export {
	collectTestRun,
	emptyRun,
	type FocusedTest,
	focusedTestsDiagnostic,
	type TestCounts,
	type TestRecord,
	type TestRun,
	type TestState,
	testFailureDiagnostic,
} from "@essence-lang/compiler/testing"

const INDENT = "  "

// #region The tree

function moduleLabel(module: string | null): string {
	return module === null ? "(no module)" : displayPath(module)
}

function symbolFor(test: TestRecord, context: ReportContext): string {
	let { palette, theme } = context

	switch (test.state) {
		case "passed":
			return palette.success(theme.symbols.pass)
		case "failed":
			return palette.error(theme.symbols.fail)
		default:
			return palette.muted(theme.symbols.skip)
	}
}

function deselectionWord(reason: string | null): string {
	switch (reason) {
		case "not-focused":
			return "not focused"
		case "tag":
			return "left out by tag"
		default:
			return "filtered out"
	}
}

function testLine(test: TestRecord, context: ReportContext): string {
	let { palette } = context
	let symbol = symbolFor(test, context)
	let name =
		test.state === "passed" || test.state === "failed"
			? test.name
			: palette.muted(test.name)
	let detail = ""

	if (test.state === "skipped") {
		detail = palette.muted(`  skipped: ${test.reason ?? "no reason given"}`)
	} else if (test.state === "not-focused" || test.state === "deselected") {
		detail = palette.muted(`  ${deselectionWord(test.reason)}`)
	} else if (context.verbose) {
		detail = palette.faint(`  ${formatDuration(test.duration)}`)
	}

	return `${symbol} ${name}${detail}`
}

// NOTE: What the tree shows without being asked. A deselected test is counted
// in the summary rather than listed: a focused run silences everything else by
// design, and printing forty lines saying so buries the two that ran.
function isListed(test: TestRecord, context: ReportContext): boolean {
	if (test.state === "not-focused" || test.state === "deselected") {
		return context.verbose
	}

	return true
}

function commonPrefix(left: Array<string>, right: Array<string>): number {
	let index = 0

	while (
		index < left.length &&
		index < right.length &&
		left[index] === right[index]
	) {
		index += 1
	}

	return index
}

// NOTE: Suites are printed as they are entered rather than collected into a
// tree first — the tests of one Module arrive in source order, so a suite's
// heading is due exactly where the path stops matching the previous test's.
export function renderTestTree(
	run: TestRun,
	context: ReportContext,
): Array<string> {
	let { palette } = context
	let lines: Array<string> = []
	let modules = new Map<string, Array<TestRecord>>()

	for (let test of run.tests) {
		if (!isListed(test, context)) {
			continue
		}

		let key = moduleLabel(test.module)
		let existing = modules.get(key)

		if (existing === undefined) {
			modules.set(key, [test])
		} else {
			existing.push(test)
		}
	}

	for (let [module, tests] of modules) {
		lines.push(` ${palette.path(module)}`)

		let path: Array<string> = []

		for (let test of tests) {
			let shared = commonPrefix(path, test.suitePath)

			for (
				let depth = shared;
				depth < test.suitePath.length;
				depth += 1
			) {
				lines.push(
					`${" ".repeat(1 + INDENT.length * (depth + 1))}${palette.strong(
						test.suitePath[depth],
					)}`,
				)
			}

			path = test.suitePath
			lines.push(
				`${" ".repeat(
					1 + INDENT.length * (test.suitePath.length + 1),
				)}${testLine(test, context)}`,
			)
		}
	}

	return lines
}

// #endregion

// #region The summary

export function renderTestSummary(
	run: TestRun,
	context: ReportContext,
): string {
	let { palette, theme } = context
	let { counts } = run
	let parts: Array<string> = []

	if (counts.passed > 0 || counts.failed === 0) {
		parts.push(palette.success(`${counts.passed} passed`))
	}

	if (counts.failed > 0) {
		parts.push(palette.error(`${counts.failed} failed`))
	}

	if (counts.skipped > 0) {
		parts.push(palette.muted(`${counts.skipped} skipped`))
	}

	if (counts.notFocused > 0) {
		parts.push(palette.muted(`${counts.notFocused} not focused`))
	}

	if (counts.deselected > 0) {
		parts.push(palette.muted(`${counts.deselected} deselected`))
	}

	return ` ${parts.join("  ")}  ${palette.faint(
		theme.symbols.bullet,
	)}  ${palette.number(formatDuration(run.duration))}`
}

// NOTE: The line a run with nothing to do ends on. It is not a failure — a
// directory with no tests in it has answered the question — but it says what
// was searched so that a mistyped path is visible.
export function renderNoTests(
	patterns: Array<string>,
	context: ReportContext,
): string {
	let { palette, theme } = context
	let where =
		patterns.length === 0
			? "under the working directory"
			: patterns.map((pattern) => palette.path(pattern)).join(", ")

	return ` ${palette.muted(theme.symbols.info)} ${palette.muted(
		`no tests ${patterns.length === 0 ? where : `in ${where}`}`,
	)}`
}

// #endregion

// #region Failures

function indented(text: string, prefix: string): Array<string> {
	return text
		.replace(/\n$/, "")
		.split("\n")
		.map((line) => `${prefix}${line}`)
}

// NOTE: What a test wrote while it ran, shown WITH the failure rather than
// interleaved with the reporter's own lines — which is the whole reason the
// runtime captures it.
function renderOutput(test: TestRecord, context: ReportContext): Array<string> {
	if (test.output.length === 0) {
		return []
	}

	let { palette } = context
	let text = test.output.map((chunk) => chunk.text).join("")

	return [
		`${INDENT}${palette.muted("output")}`,
		...indented(text, `${INDENT}${INDENT}`).map((line) =>
			palette.faint(line),
		),
		"",
	]
}

export type SourceLookup = (module: string | null) => string | null

// NOTE: Every failure of a run, rendered. A test whose module's source is not
// in reach — nothing in a CLI run, but a caller driving the reporter with
// events alone — still reports, without the excerpt.
export function renderTestFailures(
	run: TestRun,
	context: ReportContext,
	sourceOf: SourceLookup,
): Array<string> {
	let { palette, theme } = context
	let lines: Array<string> = []

	for (let test of run.tests) {
		if (test.state !== "failed") {
			continue
		}

		let sourceText = sourceOf(test.module)

		for (let failure of test.failures) {
			let diagnostic = testFailureDiagnostic(test, failure)

			if (diagnostic === null || sourceText === null) {
				lines.push(
					`${INDENT}${palette.error(theme.symbols.fail)} ${[
						...test.suitePath,
						test.name,
					].join(" › ")}`,
				)

				continue
			}

			lines.push(
				renderDiagnostic(
					diagnostic,
					new Source(sourceText),
					moduleLabel(test.module),
					{ color: context.theme.color },
				).replace(/\n$/, ""),
			)
		}

		if (test.error !== null) {
			lines.push(
				`${INDENT}${palette.error(theme.symbols.fail)} ${palette.error(
					[...test.suitePath, test.name].join(" › "),
				)} ${palette.muted("stopped with an error")}`,
			)
			lines.push(
				...indented(test.error, `${INDENT}${INDENT}`).map((line) =>
					palette.faint(line),
				),
			)
			lines.push("")
		}

		lines.push(...renderOutput(test, context))
	}

	return lines
}

// #endregion

// #region Focus

// NOTE: Grouped by the file each test was written in, in the order the runner
// met them, so the report reads in the order the tree above it did.
export function renderFocusedTests(
	tests: Array<FocusedTest>,
	context: ReportContext,
	sourceOf: SourceLookup,
): Array<string> {
	let byModule = new Map<string | null, Array<FocusedTest>>()

	for (let test of tests) {
		let existing = byModule.get(test.module)

		if (existing === undefined) {
			byModule.set(test.module, [test])
		} else {
			existing.push(test)
		}
	}

	let lines: Array<string> = []

	for (let [module, focused] of byModule) {
		let diagnostic = focusedTestsDiagnostic(focused)
		let sourceText = sourceOf(module)

		if (diagnostic === null || sourceText === null) {
			lines.push(
				`${INDENT}${context.palette.error(
					context.theme.symbols.fail,
				)} ${focused
					.map((test) => [...test.suitePath, test.name].join(" › "))
					.join(", ")} ${context.palette.muted("is focused")}`,
			)

			continue
		}

		lines.push(
			renderDiagnostic(
				diagnostic,
				new Source(sourceText),
				moduleLabel(module),
				{ color: context.theme.color },
			).replace(/\n$/, ""),
		)
	}

	return lines
}

// #endregion

// NOTE: The whole human-facing report, in the order it is read: what ran, what
// failed, and the tally. Returned as two blocks rather than one string because
// the failures are Diagnostics and go to stderr, exactly as a compilation's do,
// while the tree and the tally are the report and go to stdout.
export function renderTestReport(
	run: TestRun,
	context: ReportContext,
	sourceOf: SourceLookup,
): { tree: string; failures: string; summary: string } {
	return {
		tree: renderTestTree(run, context).join("\n"),
		failures: renderTestFailures(run, context, sourceOf).join("\n"),
		summary: renderTestSummary(run, context),
	}
}
