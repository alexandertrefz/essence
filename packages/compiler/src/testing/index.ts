import type { common } from "@essence-lang/interfaces"
import type { OutputStream } from "@essence-lang/runtime/Terminal"
import type {
	DiffLine,
	FailureEvent,
	ProbedValue,
	TestEvent,
} from "@essence-lang/runtime/Testing"

import { primary, secondary } from "../diagnostics/index"

// NOTE: What a test RUN is, read back out of the event stream, and the
// Diagnostics a run produces. It lives in the Compiler rather than in the
// command line because two things consume it — `essence test`'s reporter and
// the Language Server's live session — and a failed assertion has to be the
// same Diagnostic in the terminal and in the Problems panel, with the same
// labels at the same spans.
//
// NOTE: Everything here reads EVENTS and nothing else. It never touches a value
// a Program built: a bundle inlines its own runtime, and a value carries a
// hidden Type key that is a Symbol of the instance that built it, so anything
// asked from out here would read `undefined` off it. Every event that carries a
// value carries it already rendered.

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

function samePosition(left: common.Position, right: common.Position): boolean {
	return (
		left.start.line === right.start.line &&
		left.start.column === right.start.column &&
		left.end.line === right.end.line &&
		left.end.column === right.end.column
	)
}

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

// NOTE: Coverage is folded, weighed and written out next door, and re-exported
// here so that everything about a test run is still reached through one name.
export {
	caseNameOf,
	type ChoiceCoverage,
	collectCoverage,
	type CoverageRatio,
	type CoverageSummary,
	type CoveredPointRecord,
	emptyCoverage,
	type FileCoverage,
	fileCoverageOf,
	hasCoverage,
	isReported,
	mergeCoverage,
	type MissedPoint,
	neverConstructed,
	percentageOf,
} from "./coverage"
export {
	type CoverageReportFormat,
	coverageReportFileName,
	coverageReportFormats,
	isCoverageReportFormat,
	toCoverageJson,
	toLcov,
} from "./coverageReports"
