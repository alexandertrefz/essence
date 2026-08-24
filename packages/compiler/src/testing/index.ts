import type { common } from "@essence-lang/interfaces"
import type { OutputStream } from "@essence-lang/runtime/Terminal"
import type {
	BenchmarkStatus,
	DiffLine,
	FailureEvent,
	ProbedValue,
	PropertyCounterexample,
	SnapshotStatus,
	Span,
	StoredValue,
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
	// NOTE: Which row of a table test this is, counting from zero, and null for
	// a test that is not one. What it labels is the row a name did not: a
	// template with a hole in it renders differently per row and says which one
	// by itself, and one without a hole renders the same N times.
	row: number | null
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
	// NOTE: What a benchmark measured, and what it was held to. Null for every
	// test that is not one — and for a benchmark whose body did not hold, which
	// is reported as the failure it is and never timed.
	benchmark: BenchmarkRecord | null
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
	// NOTE: What the test's failing-example corpus did — the entry it is stored
	// under, how many stored values were re-run before anything was drawn, which
	// of them no longer read back, whether the failure came from one of them,
	// and the shrunk value written down ready to store. A reader is told the
	// first three; the runner acts on the last two.
	key: string
	replayed: number
	stale: Array<number>
	fromCorpus: boolean
	encoded: Array<StoredValue> | null
}

// NOTE: One benchmark as the run reported it — what it measured, what it was
// measured out of, and what it was held to. `key` is the entry of `module`'s
// own `__benchmarks__` companion, numbered by the row that recorded it where
// the benchmark takes rows.
export type BenchmarkRecord = {
	id: string
	module: string | null
	key: string
	nanoseconds: number
	iterations: number
	samples: number
	baseline: number | null
	ratio: number | null
	status: BenchmarkStatus
}

// NOTE: Every measurement a run took, in the order the tests ran. The command
// line writes the new baselines down out of these; the report reads the same
// events, so what one of them writes is what the other says was written.
export function collectBenchmarks(
	events: Array<TestEvent>,
): Array<BenchmarkRecord> {
	let benchmarks: Array<BenchmarkRecord> = []
	// NOTE: A measurement whose test then FAILED is not a baseline — the run it
	// reports on ended wrong, and a number recorded off it would be exactly the
	// "number about nothing" the driver's own guard exists to refuse. The
	// measurement is taken before the reported run, so the failure is only
	// known here, where both events are in hand.
	let failed = new Set<string>()

	for (let event of events) {
		if (event.kind === "test-fail") {
			failed.add(event.id)
		}
	}

	for (let event of events) {
		if (event.kind === "benchmark" && !failed.has(event.id)) {
			benchmarks.push(benchmarkRecordOf(event))
		}
	}

	return benchmarks
}

// NOTE: The record IS the event's fields — spelled once, here, so the fold the
// report reads and the collection the baseline writer reads can never carry
// two different ideas of what a measurement said.
function benchmarkRecordOf(
	event: Extract<TestEvent, { kind: "benchmark" }>,
): BenchmarkRecord {
	return {
		id: event.id,
		module: event.module,
		key: event.key,
		nanoseconds: event.nanoseconds,
		iterations: event.iterations,
		samples: event.samples,
		baseline: event.baseline,
		ratio: event.ratio,
		status: event.status,
	}
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
	// NOTE: How many ENTRIES of the run were replayed out of a result cache
	// rather than run. It is a fact about the stream rather than about a test —
	// every test in a replayed entry reads exactly as it did when it ran — so it
	// is counted here and reported beside the tally rather than against any
	// record.
	cached: number
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
	cached: 0,
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
	let cached = 0

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
				row: null,
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
				benchmark: null,
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
					row: event.row,
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
					row: event.row,
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
						row: event.row,
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
						key: event.key,
						replayed: event.replayed,
						stale: event.stale,
						fromCorpus: event.fromCorpus,
						encoded: event.encoded,
					}
				}

				break
			}
			case "benchmark": {
				let held = byId.get(event.id)

				if (held !== undefined) {
					held.benchmark = benchmarkRecordOf(event)
				}

				break
			}
			// NOTE: Counted rather than skipped. The events after it are an
			// entry's own, replayed verbatim, so every record they fold into is
			// the record that entry produced — what this adds to the fold is only
			// that the run did not have to produce it again.
			case "results-cached":
				cached += 1
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

	return { tests, counts, duration, focused, cached }
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

// NOTE: What to DO about it, which is a help rather than a note — a snapshot
// that differs is either a bug or a change somebody meant, and the second is
// one command away.
function comparisonHelps(failure: FailureEvent): Array<string> {
	return failure.comparison?.kind === "snapshot"
		? ["Accept this run with `essence test --update`"]
		: []
}

// NOTE: What to call a row that its own name did not name. A table test's suite
// path ends in the template its rows share, so a name with no hole in it
// renders as that template for every row: N lines reading the same thing, under
// a heading reading it once more. Where the rendering DOES say which row it is
// — which is what interpolating the row's fields is for — nothing is added.
export function rowLabel(
	test: Pick<TestRecord, "name" | "suitePath" | "row">,
): string | null {
	return test.row === null || test.name !== test.suitePath.at(-1)
		? null
		: `row ${test.row + 1}`
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

	// NOTE: The path without the step the name repeats, which is the template a
	// table test's rows share — said once, with the row beside it.
	let row = rowLabel(test)
	let path = row === null ? test.suitePath : test.suitePath.slice(0, -1)

	return {
		severity: "error",
		message: `'${[...path, test.name].join(" › ")}'${
			row === null ? "" : ` (${row})`
		} failed`,
		position: span,
		code: "test-failed",
		labels: labels as [
			common.DiagnosticLabel,
			...Array<common.DiagnosticLabel>,
		],
		notes: [
			...propertyNotes(test),
			...benchmarkNotes(test),
			...comparisonNotes(failure),
		],
		helps: [
			...propertyHelps(test),
			...benchmarkHelps(test),
			...comparisonHelps(failure),
		],
	}
}

// NOTE: A measurement, in the largest unit it still reads as a number in.
// Nanoseconds are whole — a fraction of one says nothing anybody can act on —
// and everything above them keeps two decimals, so two runs of one benchmark
// are told apart by the digits rather than by the unit.
export function formatNanoseconds(nanoseconds: number): string {
	if (nanoseconds < 1_000) {
		return `${nanoseconds} ns`
	}

	if (nanoseconds < 1_000_000) {
		return `${(nanoseconds / 1_000).toFixed(2)} µs`
	}

	if (nanoseconds < 1_000_000_000) {
		return `${(nanoseconds / 1_000_000).toFixed(2)} ms`
	}

	return `${(nanoseconds / 1_000_000_000).toFixed(2)} s`
}

// NOTE: How far a measurement moved, as the multiple a reader compares against
// the band rather than as two numbers they have to divide. Null where there was
// nothing to move from.
function benchmarkChange(benchmark: BenchmarkRecord): string | null {
	let ratio = benchmark.ratio

	if (ratio === null || benchmark.baseline === null) {
		return null
	}

	return ratio >= 1
		? `${ratio.toFixed(1)}× slower than its baseline (${formatNanoseconds(
				benchmark.nanoseconds,
			)}, was ${formatNanoseconds(benchmark.baseline)})`
		: `${(1 / ratio).toFixed(1)}× faster than its baseline (${formatNanoseconds(
				benchmark.nanoseconds,
			)}, was ${formatNanoseconds(benchmark.baseline)})`
}

// NOTE: What a benchmark adds to a failure: the measurement, and how far it is
// from what was recorded. It reads beside a property test's counterexample and
// for the same reason — what the assertions below say is about a run whose cost
// the reader has just been told.
export function benchmarkNotes(test: TestRecord): Array<string> {
	let benchmark = test.benchmark

	if (benchmark === null || benchmark.status !== "regressed") {
		return []
	}

	let change = benchmarkChange(benchmark)

	return change === null ? [] : [change]
}

// NOTE: The one thing to DO about a measurement that moved — a benchmark that
// got slower is either a regression or a change somebody meant, and the second
// is one command away. The same sentence a snapshot that differs is answered
// with, because it is the same question.
export function benchmarkHelps(test: TestRecord): Array<string> {
	return test.benchmark?.status === "regressed"
		? ["If the new time is right, record it: essence test --bench --update"]
		: []
}

// NOTE: What a property test's failure adds to the report: how many cases ran
// before one failed, and the smallest values the shrink could reach. It reads
// above the comparison, because what the assertion says is about THESE values
// and a reader has to be told which ones first.
//
// NOTE: A failure a STORED counterexample found ran no case at all, so "after N
// cases" would be a sentence about nothing. What a reader needs to be told is
// that the property has broken on this value before — which is different news
// from a search having just turned one up.
export function propertyNotes(test: TestRecord): Array<string> {
	let property = test.property

	if (property === null || property.counterexample === null) {
		return []
	}

	let values = property.counterexample
		.map((entry) => `${entry.name} = ${entry.value}`)
		.join("  ")
	let found = property.fromCorpus
		? `failed on a stored counterexample (${countOf(property.replayed, "re-run")})`
		: `after ${countOf(property.cases, "case")}`

	return [
		property.shrinks === 0
			? `${found}: ${values}`
			: `${found}, shrunk to: ${values}`,
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

// NOTE: A benchmark's baselines are read and written next door, exactly as
// snapshots are, and re-exported here for the same reason.
export {
	BENCHMARK_DIRECTORY,
	benchmarkFileOf,
	type BenchmarkStore,
	type BenchmarkWrites,
	noBenchmarkWrites,
	parseBenchmarkFile,
	printBenchmarkFile,
	readBenchmarks,
	writeBenchmarks,
} from "./benchmarks"
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
	collectCorpusChanges,
	CORPUS_DIRECTORY,
	CORPUS_LIMIT,
	CORPUS_SCHEMA,
	type CorpusAddition,
	type CorpusChanges,
	type CorpusFile,
	type CorpusRemoval,
	type CorpusStore,
	type CorpusWrites,
	corpusFileOf,
	noCorpusWrites,
	parseCorpusFile,
	printCorpusFile,
	readCorpus,
	type StoredCounterexample,
	type StoredValue,
	writeCorpus,
} from "./corpus"
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
