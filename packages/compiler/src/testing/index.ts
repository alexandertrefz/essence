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
import { printableText } from "../helpers/terminalText"

// A test run read back out of its event stream, and its Diagnostics. Both
// `essence test` and the language server use it, so they report alike. It reads
// only events: a Program's values carry another runtime's Type key.

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
	// Which row of a table test this is, from zero, or null for any other test.
	row: number | null
	state: TestState
	// Why it did not run, or null for a test that ran.
	reason: string | null
	duration: number
	expectations: number
	failures: Array<FailureEvent>
	// A test body that threw, which is a compiler or runtime bug, not a failure.
	error: string | null
	output: Array<{ stream: OutputStream; text: string }>
	// What the test's `§?` value comments answered, in written order, for an
	// editor to draw beside the lines.
	probes: Array<ProbedValue>
	// What the test's `matches snapshot` assertions recorded: new, matching or
	// different.
	snapshots: Array<SnapshotRecord>
	// A property test's run of cases, or null for any other test.
	property: PropertyRecord | null
	// What a benchmark measured and was held to. Null for any other test, and for a
	// benchmark whose body failed, which is never timed.
	benchmark: BenchmarkRecord | null
}

// One property test's run of cases, written whether it held or not, with the
// seed that repeats it.
export type PropertyRecord = {
	cases: number
	// How many cases the run was told to run. A replay must repeat it, since case
	// sizes grow with the case number over the whole run.
	requested: number
	seed: string
	shrinks: number
	counterexample: Array<PropertyCounterexample> | null
	// What the failing-example corpus did. A reader is told the entry key, how
	// many stored values re-ran first and which no longer read back. The runner
	// acts on whether one failed and on the shrunk value encoded for storing.
	key: string
	replayed: number
	stale: Array<number>
	fromCorpus: boolean
	encoded: Array<StoredValue> | null
}

// One benchmark as reported. `key` is its entry in `module`'s
// `__benchmarks__` companion, numbered by row for a table benchmark.
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

// Every measurement a run took, in test order. The CLI writes baselines from
// these, and the report reads the same events.
export function collectBenchmarks(
	events: Array<TestEvent>,
): Array<BenchmarkRecord> {
	let benchmarks: Array<BenchmarkRecord> = []
	// A measurement whose test then failed is no baseline. The failure is only known
	// once both events are in hand.
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

// A benchmark event's fields as a record, shared by the fold and the collection.
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

// One `matches snapshot` as reported. An inline snapshot has a null `name`, and
// its `span` is the source slot a rewrite replaces. A named one belongs to
// `module`'s `__snapshots__` companion.
export type SnapshotRecord = {
	id: string
	module: string | null
	name: string | null
	status: SnapshotStatus
	span: Span | null
	text: string
	recorded: string | null
}

// Every snapshot a run recorded, in test order, for the CLI to write and the
// language server to offer.
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
	// How many entries of the run were replayed from a result cache, reported
	// beside the tally, since a replayed test reads exactly as it ran.
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

// The event stream folded into one record per test, in start order. Counts are
// recomputed, since a run of several bundles has several `run-end` events.
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
			// Counted: the events after it are the cached entry's own, replayed verbatim.
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

// A comparison's difference as one multi-line note, which Ariadne indents as
// one block.
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

	// A snapshot's sides are text, so only the difference is shown.
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

	// Only a walk into a Record or a List adds to the note above it.
	if (comparison.diff.length > 2) {
		notes.push(diffNote(comparison.diff))
	}

	return notes
}

// A snapshot that differs is a bug or an intended change, and the Help gives
// the command that accepts it.
function comparisonHelps(failure: FailureEvent): Array<string> {
	return failure.comparison?.kind === "snapshot"
		? ["Accept this run with `essence test --update`"]
		: []
}

// A label for a table test row whose name has no hole, so every row renders
// alike. Null where the name already says which row it is.
export function rowLabel(
	test: Pick<TestRecord, "name" | "suitePath" | "row">,
): string | null {
	return test.row === null || test.name !== test.suitePath.at(-1)
		? null
		: `row ${test.row + 1}`
}

// A test's display path, with characters that act on the terminal spelled as
// escapes, shared by the reporter and the Problems panel.
export function testDisplayPath(steps: Array<string>): string {
	return steps.map(printableText).join(" › ")
}

// One failed assertion as an ordinary Diagnostic, rendered like any other: the
// assertion is the primary Label, each recorded sub-expression a secondary one.
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
		// A value rendered as its own source, or the assertion's own answer, explains
		// nothing.
		if (
			value.span === null ||
			value.value === value.span.source ||
			samePosition(value.span, span)
		) {
			continue
		}

		labels.push(secondary(value.span, value.value))
	}

	// The path without the template step a table test's rows share.
	let row = rowLabel(test)
	let path = row === null ? test.suitePath : test.suitePath.slice(0, -1)

	return {
		severity: "error",
		message: `'${testDisplayPath([...path, test.name])}'${
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

// A measurement in the largest unit that keeps it at least one. Nanoseconds are
// whole, and larger units keep two decimals.
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

// How far a measurement moved, as a multiple of its baseline, or null.
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

// A regressed benchmark's measurement and change, as a note.
export function benchmarkNotes(test: TestRecord): Array<string> {
	let benchmark = test.benchmark

	if (benchmark === null || benchmark.status !== "regressed") {
		return []
	}

	let change = benchmarkChange(benchmark)

	return change === null ? [] : [change]
}

// A regression is a bug or an intended change, and the Help gives the command
// that records the new time.
export function benchmarkHelps(test: TestRecord): Array<string> {
	return test.benchmark?.status === "regressed"
		? ["If the new time is right, record it: essence test --bench --update"]
		: []
}

// A property failure's cases and shrunk values, as a note. A stored
// counterexample ran no cases, so the note says it failed before.
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

// The command that draws these values again: each property test folds its own
// identity into the run's seed, so the filter keeps its draws.
export function propertyHelps(test: TestRecord): Array<string> {
	let property = test.property

	if (property === null || property.counterexample === null) {
		return []
	}

	// `--cases` only where it differs from the default.
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

// A focused test and its `test` keyword's Position, which the manifest carries.
export type FocusedTest = {
	module: string | null
	name: string
	suitePath: Array<string>
	keywordPosition: common.Position
}

// A focused run as a Diagnostic with a Label per focused test, so a reader
// sees which ones. One per file, since one excerpt reads one source.
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
		// Single quotes, as Helps spell keywords and flags for a terminal.
		helps: [
			"Remove 'focused' before this lands, or narrow the run with " +
				"'--filter' or '--tag' while you are iterating.",
		],
	}
}

// Coverage attribution, apart so the language server reaches it without the CLI.
export {
	attributionOf,
	coveringPoints,
	type ModuleAttribution,
} from "./attribution"
// Benchmark baselines, read and written as snapshots are.
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
// Coverage folding and reports.
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
// Staging, shared by the CLI and the language server.
export {
	removeStagingDirectory,
	stagingDirectoryIn,
	sweepStagingDirectories,
} from "./staging"
