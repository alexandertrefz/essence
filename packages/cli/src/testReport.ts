import { Source } from "@essence-lang/ariadne"
import { primary, secondary } from "@essence-lang/compiler/diagnostics"
import {
	displayPath,
	renderDiagnostic,
} from "@essence-lang/compiler/diagnostics/render"
import type { common } from "@essence-lang/interfaces"
import type { OutputStream } from "@essence-lang/runtime/Terminal"
import type {
	DiffLine,
	FailureEvent,
	ProbedValue,
	TestEvent,
} from "@essence-lang/runtime/Testing"

import type { ReportContext } from "./report"
import { formatDuration } from "./report"

// NOTE: Everything a person reads about a test run is produced here, as
// strings, so that the shape of the report can be asserted on without a
// terminal — the same rule `report.ts` follows for a compilation.
//
// NOTE: The reporter reads EVENTS and nothing else. It never touches a value a
// Program built: a bundle inlines its own runtime, and a value carries a hidden
// Type key that is a Symbol of the instance that built it, so anything asked
// from out here would read `undefined` off it. Every event that carries a value
// carries it already rendered.

const INDENT = "  "

export type TestState =
	| "passed"
	| "failed"
	| "skipped"
	| "not-focused"
	| "deselected"

export type TestRecord = {
	id: string
	name: string
	module: string | null
	suitePath: Array<string>
	state: TestState
	// NOTE: Why it did not run — a skip's own reason, or the word for how it
	// was deselected. Null for a test that ran.
	reason: string | null
	duration: number
	expectations: number
	failures: Array<FailureEvent>
	// NOTE: A test body that threw, which is a Compiler or a runtime bug rather
	// than a failed assertion.
	error: string | null
	output: Array<{ stream: OutputStream; text: string }>
	// NOTE: What the test's `§?` value comments answered, in the order they
	// were written. Collected rather than printed: a value comment is a question
	// asked of an Editor, which draws it beside the line — the terminal report
	// says what held, and a reader looking at a terminal is looking at the
	// source anyway.
	probes: Array<ProbedValue>
}

export type TestCounts = {
	passed: number
	failed: number
	skipped: number
	notFocused: number
	deselected: number
}

export type TestRun = {
	tests: Array<TestRecord>
	counts: TestCounts
	duration: number
	focused: boolean
}

export const emptyRun: TestRun = {
	tests: [],
	counts: {
		passed: 0,
		failed: 0,
		skipped: 0,
		notFocused: 0,
		deselected: 0,
	},
	duration: 0,
	focused: false,
}

// NOTE: The event stream folded back into one record per test, in the order the
// tests started. `run-start` says nothing a reader needs; the counts are
// recomputed here rather than taken off `run-end`, because a run of several
// bundles has several of those and only the reporter sees the whole of it.
export function collectTestRun(events: Array<TestEvent>): TestRun {
	let byId = new Map<string, TestRecord>()
	let tests: Array<TestRecord> = []
	let duration = 0
	let focused = false

	let record = (
		id: string,
		name: string,
		state: TestState,
		details: Partial<TestRecord> = {},
	): TestRecord => {
		let existing = byId.get(id)

		if (existing === undefined) {
			existing = {
				id,
				name,
				module: null,
				suitePath: [],
				state,
				reason: null,
				duration: 0,
				expectations: 0,
				failures: [],
				error: null,
				output: [],
				probes: [],
			}
			byId.set(id, existing)
			tests.push(existing)
		}

		Object.assign(existing, { name, state }, details)

		return existing
	}

	for (let event of events) {
		switch (event.kind) {
			case "run-start":
				focused = focused || event.focused
				break
			case "test-start":
				record(event.id, event.name, "passed", {
					module: event.module,
					suitePath: event.suitePath,
				})
				break
			case "test-pass":
				record(event.id, event.name, "passed", {
					duration: event.duration,
					expectations: event.expectations,
				})
				break
			case "test-fail":
				record(event.id, event.name, "failed", {
					duration: event.duration,
					expectations: event.expectations,
					failures: event.failures,
					error: event.error,
				})
				break
			case "test-skip":
				record(event.id, event.name, "skipped", {
					module: event.module,
					suitePath: event.suitePath,
					reason: event.reason,
				})
				break
			case "test-deselected":
				record(
					event.id,
					event.name,
					event.reason === "not-focused"
						? "not-focused"
						: "deselected",
					{
						module: event.module,
						suitePath: event.suitePath,
						reason: event.reason,
					},
				)
				break
			case "output":
				byId.get(event.id)?.output.push({
					stream: event.stream,
					text: event.text,
				})
				break
			case "probe":
				byId.get(event.id)?.probes.push({
					point: event.point,
					span: event.span,
					value: event.value,
				})
				break
			case "run-end":
				duration += event.duration
				focused = focused || event.focused
				break
			default:
				break
		}
	}

	let counts: TestCounts = {
		passed: 0,
		failed: 0,
		skipped: 0,
		notFocused: 0,
		deselected: 0,
	}

	for (let test of tests) {
		switch (test.state) {
			case "passed":
				counts.passed += 1
				break
			case "failed":
				counts.failed += 1
				break
			case "skipped":
				counts.skipped += 1
				break
			case "not-focused":
				counts.notFocused += 1
				break
			case "deselected":
				counts.deselected += 1
				break
		}
	}

	return { tests, counts, duration, focused }
}

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

// NOTE: The difference between what a comparison held and what it was compared
// with, as one multi-line note — Ariadne indents a note's continuation lines
// under its prefix, so the whole difference stays one block rather than
// becoming one `Note N:` per line.
function diffNote(diff: Array<DiffLine>): string {
	let lines = diff.map((line) => {
		switch (line.kind) {
			case "left":
				return `- ${line.text}`
			case "right":
				return `+ ${line.text}`
			default:
				return `  ${line.text}`
		}
	})

	return [
		"the difference, - what it held, + what it was compared with:",
		...lines,
	].join("\n")
}

function comparisonNotes(failure: FailureEvent): Array<string> {
	let comparison = failure.comparison

	if (comparison === null) {
		return []
	}

	let notes: Array<string> = []

	if (comparison.left !== null && comparison.right !== null) {
		notes.push(
			`\`${comparison.kind}\` compared ${comparison.left} with ${comparison.right}`,
		)
	}

	// NOTE: A difference over two scalars is the two of them, which the note
	// above has already said in one line. Only a walk INTO a Record or a List
	// says something a reader could not have worked out.
	if (comparison.diff.length > 2) {
		notes.push(diffNote(comparison.diff))
	}

	return notes
}

function samePosition(left: common.Position, right: common.Position): boolean {
	return (
		left.start.line === right.start.line &&
		left.start.column === right.start.column &&
		left.end.line === right.end.line &&
		left.end.column === right.end.column
	)
}

// NOTE: One failed assertion as an ordinary Essence Diagnostic, so that a test
// failure is rendered by the very pipeline every other Diagnostic is — same
// excerpt, same colours, same margin, in the terminal and in an editor alike.
// The asserted Expression is the primary Label; every sub-expression the
// lowering recorded is a secondary one at its own span.
export function testFailureDiagnostic(
	test: TestRecord,
	failure: FailureEvent,
): common.Diagnostic | null {
	if (failure.span === null) {
		return null
	}

	let span = failure.span
	let labels: Array<common.DiagnosticLabel> = [
		primary(span, `this ${failure.form} failed`),
	]

	for (let value of failure.values) {
		// NOTE: A value whose rendering IS its own source explains nothing — a
		// literal traced as an operand of a comparison is what produces one —
		// and neither does the assertion's own answer, which a failed assertion
		// already says. Both would be a label the reader has to look past.
		if (
			value.span === null ||
			value.value === value.span.source ||
			samePosition(value.span, span)
		) {
			continue
		}

		labels.push(secondary(value.span, value.value))
	}

	return {
		severity: "error",
		message: `'${[...test.suitePath, test.name].join(" › ")}' failed`,
		position: span,
		code: "test-failed",
		labels: labels as [
			common.DiagnosticLabel,
			...Array<common.DiagnosticLabel>,
		],
		notes: comparisonNotes(failure),
		helps: [],
	}
}

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

// NOTE: A test the run was narrowed to, and where its `test` keyword stands.
// The Position is the keyword rather than the `focused` Modifier because the
// manifest carries the keyword — and because what has to go is a property of
// the test, which is what a reader looks at to decide whether it still needs
// the focus.
export type FocusedTest = {
	module: string | null
	name: string
	suitePath: Array<string>
	keywordPosition: common.Position
}

// NOTE: A run that silenced everything else is reported as a Diagnostic like
// any other refusal, rather than as a line saying so: what a person needs is
// not the news that a focus was left behind, it is WHICH ones — and that is an
// excerpt per file with a Label per test, which the Diagnostic pipeline already
// draws. One Diagnostic per file, because one excerpt reads one Source.
export function focusedTestsDiagnostic(
	tests: Array<FocusedTest>,
): common.Diagnostic | null {
	let [first, ...rest] = tests

	if (first === undefined) {
		return null
	}

	return {
		severity: "error",
		message:
			tests.length === 1
				? "This test is still focused"
				: "These tests are still focused",
		position: first.keywordPosition,
		code: "focused-tests-remain",
		labels: [
			primary(first.keywordPosition, "only focused tests ran"),
			...rest.map((test) =>
				secondary(test.keywordPosition, "and this one"),
			),
		] as [common.DiagnosticLabel, ...Array<common.DiagnosticLabel>],
		notes: [
			"A focused test silences every other test of the run, so a run " +
				"nobody narrowed has not answered the question it was asked.",
		],
		helps: [
			"Remove `focused` before this lands, or narrow the run with " +
				"--filter or --tag while you are iterating.",
		],
	}
}

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
