import type { common } from "@essence-lang/interfaces"
import type { OutputStream } from "@essence-lang/runtime/Terminal"
import type {
	DiffLine,
	FailureEvent,
	ProbedValue,
	PropertyCounterexample,
	SnapshotStatus,
	Span,
	TestEvent,
} from "@essence-lang/runtime/Testing"
import { DEFAULT_CASES } from "@essence-lang/runtime/Testing"

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
	// NOTE: What the test's `matches snapshot` assertions recorded — a new one
	// to be written, a stored one that still matches, or the difference that
	// failed. A reporter shows the counts, a rewrite acts on them, and an
	// Editor offers "Accept snapshot" where one is pending.
	snapshots: Array<SnapshotRecord>
	// NOTE: What a property test's run of cases did — how many held, the seed
	// they were drawn from, and the smallest failing value the shrink reached.
	// Null for every test that is not a property test.
	property: PropertyRecord | null
}

// NOTE: One property test's run of cases, as the report reads it. It is written
// whether the property held or not: "a hundred cases held" is an answer, and
// the seed is what makes today's run repeatable tomorrow.
export type PropertyRecord = {
	cases: number
	// NOTE: How many cases the run was TOLD to run. A replay has to say it back:
	// the size a case is drawn at grows with the case number over the whole run,
	// so a hundred cases and four hundred draw two different sequences from one
	// seed.
	requested: number
	seed: string
	shrinks: number
	counterexample: Array<PropertyCounterexample> | null
}

// NOTE: One `matches snapshot` as the run reported it. `name` is null for an
// inline snapshot, whose `span` is the slot of the source a recorded value
// stands in — that is what a rewrite replaces. A named one belongs to
// `module`'s own `__snapshots__` companion.
export type SnapshotRecord = {
	id: string
	module: string | null
	name: string | null
	status: SnapshotStatus
	span: Span | null
	text: string
	recorded: string | null
}

// NOTE: Every snapshot a run recorded, in the order the tests ran. The command
// line writes the new ones down and the Language Server offers them; both read
// the same events, so what one of them writes is what the other would have.
export function collectSnapshots(
	events: Array<TestEvent>,
): Array<SnapshotRecord> {
	let snapshots: Array<SnapshotRecord> = []

	for (let event of events) {
		if (event.kind === "snapshot") {
			snapshots.push({
				id: event.id,
				module: event.module,
				name: event.name,
				status: event.status,
				span: event.span,
				text: event.text,
				recorded: event.recorded,
			})
		}
	}

	return snapshots
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
				snapshots: [],
				property: null,
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
			case "snapshot":
				byId.get(event.id)?.snapshots.push({
					id: event.id,
					module: event.module,
					name: event.name,
					status: event.status,
					span: event.span,
					text: event.text,
					recorded: event.recorded,
				})
				break
			case "property": {
				let held = byId.get(event.id)

				if (held !== undefined) {
					held.property = {
						cases: event.cases,
						requested: event.requested,
						seed: event.seed,
						shrinks: event.shrinks,
						counterexample: event.counterexample,
					}
				}

				break
			}
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

	// NOTE: A snapshot's two sides are TEXT, and often several lines of it —
	// what says how they differ is the difference itself, whatever its length,
	// and never the two of them written out side by side.
	if (comparison.kind === "snapshot") {
		return [
			comparison.left === null
				? "nothing was recorded for this snapshot"
				: "the recorded snapshot and this run differ",
			diffNote(comparison.diff),
			"Accept this run with `essence test --update`.",
		]
	}

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
		notes: [...propertyNotes(test), ...comparisonNotes(failure)],
		helps: propertyHelps(test),
	}
}

// NOTE: What a property test's failure adds to the report: how many cases ran
// before one failed, and the smallest values the shrink could reach. It reads
// above the comparison, because what the assertion says is about THESE values
// and a reader has to be told which ones first.
export function propertyNotes(test: TestRecord): Array<string> {
	let property = test.property

	if (property === null || property.counterexample === null) {
		return []
	}

	let values = property.counterexample
		.map((entry) => `${entry.name} = ${entry.value}`)
		.join("  ")

	return [
		property.shrinks === 0
			? `after ${countOf(property.cases, "case")}: ${values}`
			: `after ${countOf(property.cases, "case")}, shrunk to: ${values}`,
	]
}

// NOTE: The command that draws exactly these values again. The seed pins the
// whole run and the filter narrows it to this test, which still draws what this
// test drew — every property test folds its own identity into the run's seed.
export function propertyHelps(test: TestRecord): Array<string> {
	let property = test.property

	if (property === null || property.counterexample === null) {
		return []
	}

	// NOTE: `--cases` only where it differs from the default, because a command
	// naming a default is a command a reader has to check.
	let cases =
		property.requested === DEFAULT_CASES
			? ""
			: ` --cases ${property.requested}`

	return [
		`Run it again: essence test --seed ${property.seed}${cases} -f ${JSON.stringify(test.name)}`,
	]
}

function countOf(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`
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
export {
	type InlineUpdate,
	type InlineWrite,
	type InlineWriter,
	noWrites,
	parseSnapshotFile,
	printSnapshotFile,
	readSnapshots,
	SNAPSHOT_DIRECTORY,
	type SnapshotStore,
	type SnapshotWrites,
	snapshotFileOf,
	type SourceRewrite,
	writeSnapshots,
} from "./snapshots"
