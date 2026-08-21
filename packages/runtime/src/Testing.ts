import { anyIs } from "./internalHelpers"
import { materialise } from "./List"
import type { StringType } from "./String"
import {
	getStringRepresentation,
	type OutputStream,
	withOutputSink,
} from "./Terminal"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: The test runtime. It is a runtime module rather than a standard library
// Namespace on purpose: nothing here has a spelling in Essence, and nothing a
// Program can write reaches it. The Compiler emits calls to these exports for a
// `tests { … }` section and for nothing else, so a Program compiled by `essence
// build` never names this module and esbuild shakes it away whole.
//
// NOTE: Everything a running test touches hangs off a CONTEXT object it is
// handed — the trace buffer, the captured output, the recorded expectations,
// what failed. There is no module-level "current test" anywhere below, so two
// tests running at once could not see each other's work even if the runner
// stopped running them one at a time. The one exception is the REGISTRY, which
// is state about the Modules a bundle holds rather than about a run, and is
// written exactly once per Module as that Module is evaluated.

// #region The manifest a Module registers

// NOTE: The Compiler's own Position, spelled here rather than imported: this
// module is inlined into a user's bundle and compiles under the runtime's
// tsconfig, which knows nothing of `@essence-lang/interfaces`. Lines are
// 1-based and columns are 1-based, which is the Essence convention everywhere.
export type Cursor = { line: number; column: number }
export type Range = { start: Cursor; end: Cursor }

// NOTE: One instrumented point: where the sub-expression stands, and its source
// text so a reader outside the Compiler — a `--json` consumer, an editor
// showing a value beside the line — can say what was recorded without going
// back to the file. Emitted once per Module, indexed by point id.
export type Span = Range & { source: string }

// NOTE: What a test IS, independently of what it does — the half of a test the
// runner can read without running anything. `id` is the STRUCTURAL identity
// (module path, suite path, name template); `name` is the template rather than
// the rendering, because an interpolated name is worked out where the test
// stands, and `TestContext.names` is where the rendering arrives.
export type TestManifestEntry = {
	id: string
	name: string
	// NOTE: Whether the template has a hole in it. It is the whole of what says
	// a Module has to be evaluated before anything runs — see `renderedNames` —
	// and it is recorded by the Compiler rather than guessed from the name here,
	// because a plain name may hold a brace of its own.
	interpolated: boolean
	// NOTE: Which row of a table test this is, and null for the ordinary test
	// that runs once. Everything a report groups by reads it: the rows of one
	// table share a template, and what they are shown under is that template.
	row: number | null
	suitePath: Array<string>
	tags: Array<string>
	focused: boolean
	skipped: string | null
	position: Range
	keywordPosition: Range
}

// NOTE: Where a test is REPORTED — its suite path, and for a row of a table
// test the template the rows share as one more step of it. So a table test
// reads as a group of its own wherever a suite does, in the terminal's tree and
// in an Editor's, and nothing that draws either had to learn what a row is.
export function pathOf(entry: TestManifestEntry): Array<string> {
	return entry.row === null
		? entry.suitePath
		: [...entry.suitePath, entry.name]
}

// NOTE: One Module's tests. `run` is the whole section as one Function: the
// setup Statements, the suites as nested scopes, and each test as an `entry`
// call standing where it was written. Calling it with a context whose `index`
// names a test runs the setup that test can see and then that test — which is
// what "a tests-section constant is indistinguishable from fresh evaluation per
// test" MEANS, realised literally.
export type TestModule = {
	module: string | null
	spans: Array<Span>
	tests: Array<TestManifestEntry>
	run: (context: TestContext) => void
}

// NOTE: The registry is per BUNDLE, not per process: esbuild inlines this
// module into each bundle it builds, so two bundles loaded in one process hold
// two of these. A Module registers as it is evaluated, dependencies first, so
// the entry Module's `$testRegistry` — which is a Function rather than a value,
// exactly so that WHEN it is asked matters as little as possible — answers with
// every Module of the graph.
const registered: Array<TestModule> = []

export function register(module: TestModule): TestModule {
	registered.push(module)

	return module
}

export type RegisteredTest = {
	module: TestModule
	entry: TestManifestEntry
	// NOTE: Which `entry` call inside `module.run` this is. The context carries
	// it to say which test to run.
	index: number
}

export type Registry = {
	modules: Array<TestModule>
	tests: Array<RegisteredTest>
	// NOTE: Keyed by structural id, which is what everything durable is keyed by
	// — a stored snapshot, a focus the editor remembers, a timing baseline. Two
	// tests sharing an id is a Compiler bug the Enricher already refuses as
	// `duplicate-test-name`; the LAST one registered wins here rather than
	// throwing, because a runner that can not build its index reports nothing at
	// all.
	byId: Map<string, RegisteredTest>
}

// NOTE: Everything registered so far, indexed. It is asked for AFTER a bundle
// has been loaded — a Module registers as it is evaluated, dependencies first —
// which is why what a bundle publishes is this Function rather than its answer.
export function registry(): Registry {
	return registryOf(registered)
}

// NOTE: The same answer over Modules a caller holds rather than over the ones
// this instance was told about. It is what makes the indexing testable without
// a bundle, and it is the whole of what `registry` does.
export function registryOf(modules: Array<TestModule>): Registry {
	let tests: Array<RegisteredTest> = []
	let byId = new Map<string, RegisteredTest>()

	for (let module of modules) {
		module.tests.forEach((entry, index) => {
			let test = { module, entry, index }

			tests.push(test)
			byId.set(entry.id, test)
		})
	}

	return { modules: [...modules], tests, byId }
}

// #endregion

// #region Coverage

// NOTE: What one counter counts, and everything a report needs to say so. It is
// the Compiler's `CoveragePoint`, spelled here because this module compiles
// under the runtime's own tsconfig and is inlined into a user's bundle.
export type CoveragePoint = {
	kind: "statement" | "branch" | "case" | "construction"
	label: string
	scope: string
	position: Range
	refinement: boolean
	tag: string | null
}

// NOTE: What a Choice DECLARES, so a report can say which of its Cases nothing
// ever built. A construction is counted where it happens, which may be any
// Module of the graph; what is declared is known only in the Module that
// declares it.
export type CoverageChoice = {
	name: string
	cases: Array<string>
	position: Range
}

export type CoverageModule = {
	module: string | null
	points: Array<CoveragePoint>
	choices: Array<CoverageChoice>
}

// NOTE: What the emitted JavaScript calls. Standing alone it counts; handed a
// value it counts and answers with that very value, so wrapping an Expression
// in one changes nothing about what it evaluates to.
export type CoverageCounter = {
	(point: number): void
	<Value extends AnyType>(point: number, value: Value): Value
}

type CoverageRecord = {
	module: CoverageModule
	counts: Array<number>
	// NOTE: What the counts were when the FIRST run began — which is what a
	// Module's top-level Statements had already added by simply being loaded.
	// A second run resets to this rather than to zero, because a Module is
	// evaluated once however many times its tests are run, and zeroing what it
	// did would report every top-level Statement as never executed.
	baseline: Array<number> | null
}

// NOTE: Per BUNDLE, exactly as the test registry beside it is: a bundle inlines
// this module, so two bundles loaded in one process count into two of these.
// That is what makes coverage isolated per run without anybody arranging it —
// a run loads its bundles, reads their counts and drops them.
const covered: Array<CoverageRecord> = []

// NOTE: Called once per instrumented Module, as the Module is evaluated. It
// answers with a closure over that Module's own counts, so a counter costs one
// call and one increment rather than a lookup by Module name.
export function counters(module: CoverageModule): CoverageCounter {
	let counts = module.points.map(() => 0)

	covered.push({ module, counts, baseline: null })

	return ((point: number, value?: AnyType) => {
		counts[point] = (counts[point] ?? 0) + 1

		return value
	}) as CoverageCounter
}

// NOTE: What a run counted, per Module — the table the Compiler emitted, with
// the count each point reached. Asked at the end of a run, and callable at any
// point during one: `TestContext.coverage` is this, offered to a test that
// wants to know what it has reached so far.
export type CoveredPoint = CoveragePoint & { count: number }

export type CoverageReport = {
	module: string | null
	points: Array<CoveredPoint>
	choices: Array<CoverageChoice>
}

export function coverage(): Array<CoverageReport> {
	return covered.map((record) => ({
		module: record.module.module,
		points: record.module.points.map((point, index) => ({
			...point,
			count: record.counts[index] ?? 0,
		})),
		choices: record.module.choices,
	}))
}

// NOTE: The line between one run and the next. The first call RECORDS what
// loading the bundle already counted; every call after it puts the counts back
// to exactly that. A watch session and the Language Server's session both run
// the same loaded bundle again and again, and without this each cycle would
// report the sum of every cycle before it.
export function beginCoverageRun(): void {
	for (let record of covered) {
		if (record.baseline === null) {
			record.baseline = [...record.counts]

			continue
		}

		for (let index = 0; index < record.counts.length; index += 1) {
			record.counts[index] = record.baseline[index] ?? 0
		}
	}
}

// #endregion

// #region The per-test context

// NOTE: One recorded value: the point it was recorded at, and what stood there.
export type Trace = { point: number; value: AnyType }

// NOTE: What an `expect`/`require` recorded — whether it held, every
// sub-expression value evaluated on the way, and, where the assertion compared
// two values with `Equatable`, the two operands so the report can diff them.
export type Expectation = {
	form: "expect" | "require"
	point: number
	passed: boolean
	traces: Array<Trace>
	comparison: RecordedComparison | null
}

// NOTE: What the LOWERING says about an assertion whose top-level call is
// `Equatable::is`/`::isNot` — the two operands, named by the points they were
// traced at. It is written by the Compiler and read here, which is what keeps
// the diff a consequence of the general trace mechanism rather than a second
// capture beside it.
export type Comparison = { kind: "is" | "isNot"; left: number; right: number }

export type RecordedComparison = {
	kind: "is" | "isNot"
	left: AnyType | undefined
	right: AnyType | undefined
}

export type OutputChunk = { stream: OutputStream; text: string }

export type TestContext = {
	// NOTE: Which `entry` of the Module's `run` is the one to run. `-1` runs
	// none of them, which is how a run ENUMERATES: the setup evaluates once and
	// every interpolated name is worked out, and nothing else happens.
	index: number
	// NOTE: The rendered names, by entry index. An interpolated name reaches
	// here from the scope it was written in; a plain one is in the manifest
	// already and is never recorded.
	names: Map<number, string>
	// NOTE: What has been traced since the last assertion drained the buffer.
	// It is drained rather than cleared so that the values belong to the
	// assertion that evaluated them.
	traces: Array<Trace>
	// NOTE: What the `§?` value comments of this test recorded. Never drained:
	// a value comment asks a question no assertion asked, and its answer belongs
	// to the line it was written on for the whole of the test.
	probes: Array<Trace>
	expectations: Array<Expectation>
	output: Array<OutputChunk>
	// NOTE: What has been counted so far, asked from inside a running test
	// rather than only read out at the end of a run. Coverage is a fact about
	// the BUNDLE and not about one test, so this is the same answer for every
	// context — it is offered here because the context is what a test holds,
	// and a capability a test can not reach is a capability it does not have.
	coverage: () => Array<CoverageReport>
}

export function createContext(index: number): TestContext {
	return {
		index,
		names: new Map(),
		traces: [],
		probes: [],
		expectations: [],
		output: [],
		coverage,
	}
}

// #endregion

// #region What the emitted JavaScript calls

// NOTE: One test, standing where it was written — inside whatever setup it can
// see, which has just been evaluated afresh. The name is handed over only where
// it interpolates, because a plain one is a String the manifest carries and
// emitting it twice would be two spellings of one thing.
export function entry(
	context: TestContext,
	index: number,
	name: StringType | null,
	run: () => void,
): void {
	if (name !== null) {
		context.names.set(index, name.value)
	}

	if (context.index === index) {
		run()
	}
}

// NOTE: One table test's rows, standing where the test was written. Only the
// row that is running is built into anything: the name is worked out for the
// row being enumerated or run, and the body for the one selected. Everything
// else about a row — its identity, its Modifiers, where it was written — is in
// the manifest already.
export function rows<Value extends AnyType>(
	context: TestContext,
	first: number,
	values: Array<Value>,
	name: ((row: Value) => StringType) | null,
	run: (row: Value) => void,
): void {
	values.forEach((value, offset) => {
		let index = first + offset

		// NOTE: `-1` is the enumeration pass, which works out every rendered
		// name and runs nothing.
		if (context.index !== index && context.index !== -1) {
			return
		}

		if (name !== null) {
			context.names.set(index, name(value).value)
		}

		if (context.index === index) {
			run(value)
		}
	})
}

// NOTE: THE trace mechanism — record a value at an instrumented point,
// attributed to a source span, and answer with the very value so that wrapping
// an Expression in one changes nothing about what it evaluates to. `expect` and
// `require` are its first consumers; the `§?` value comment and coverage are
// the next two, and they record at points of their own against the same table.
export function trace<Value extends AnyType>(
	context: TestContext,
	point: number,
	value: Value,
): Value {
	context.traces.push({ point, value })

	return value
}

// NOTE: The `§?` value comment — the same recording as a trace, into the buffer
// no assertion drains, so what a line asked about survives to the end of the
// test whatever was asserted after it. A line inside a loop records once per
// turn and the last one is what is reported, for the same reason a traced
// sub-expression is: what a reader is looking at is the turn they can see.
export function probe<Value extends AnyType>(
	context: TestContext,
	point: number,
	value: Value,
): Value {
	context.probes.push({ point, value })

	return value
}

// NOTE: `expect` — record and carry on, so one test can report several failures
// at once. The traces the asserted Expression left are drained INTO the
// expectation: they are what that assertion evaluated, and the next one starts
// with an empty buffer.
export function expected(
	context: TestContext,
	point: number,
	passed: boolean,
	comparison: Comparison | null,
): void {
	record(context, "expect", point, passed, comparison)
}

// NOTE: What a failed `require` unwinds with. It is thrown rather than
// returned, because "ends the test" has to hold WHEREVER the assertion was
// written: a `match` used as an Expression is emitted as a call to an arrow
// Function, and an early `return` inside one of its Handlers would end that
// arrow and leave the test running on with a value it never computed. A throw
// leaves no shape of the lowering able to swallow it. It is a private object
// rather than an Error so that `runOne` can tell "the test ended itself" from
// "the test threw", and no stack is built for something nobody reads.
const requirementFailed = { requirementFailed: true }

// NOTE: `require` — the same recording as an `expect`, and then a failure ends
// the test where it stands. What ended it is already on the context, so the
// unwinding carries nothing.
export function required(
	context: TestContext,
	point: number,
	passed: boolean,
	comparison: Comparison | null,
): void {
	record(context, "require", point, passed, comparison)

	if (!passed) {
		throw requirementFailed
	}
}

function record(
	context: TestContext,
	form: "expect" | "require",
	point: number,
	passed: boolean,
	comparison: Comparison | null,
): void {
	let traces = context.traces

	context.traces = []
	context.expectations.push({
		form,
		point,
		passed,
		traces,
		comparison:
			comparison === null
				? null
				: {
						kind: comparison.kind,
						left: valueAt(traces, comparison.left),
						right: valueAt(traces, comparison.right),
					},
	})
}

// NOTE: The LAST value traced at a point, because a point inside a loop — which
// a test body may hold — records once per turn, and what a failure is about is
// the turn that failed.
function valueAt(traces: Array<Trace>, point: number): AnyType | undefined {
	for (let index = traces.length - 1; index >= 0; index -= 1) {
		if (traces[index]!.point === point) {
			return traces[index]!.value
		}
	}

	return undefined
}

// #endregion

// #region The structural diff

// NOTE: One line of a rendered difference. `same` is context, `left` is what
// the receiver held and `right` what it was compared against — the reporter
// decides how to mark them, because a terminal, an editor hover and a JSON
// consumer each want something different.
export type DiffLine = { kind: "same" | "left" | "right"; text: string }

// NOTE: What `Equatable::is` compared, written out as a difference rather than
// as two dumps. A Record is walked member by member and a List index by index,
// so what a reader sees is the ONE member that differs surrounded by the ones
// that do not — which is the whole reason the lowering keeps both operands.
// Anything else is answered as the pair it is.
export function structuralDiff(
	left: AnyType | undefined,
	right: AnyType | undefined,
): Array<DiffLine> {
	if (left === undefined || right === undefined || anyIs(left, right)) {
		return []
	}

	return diffValue(left, right, "", "", "")
}

function diffValue(
	left: AnyType,
	right: AnyType,
	indent: string,
	label: string,
	// NOTE: What follows the value — the comma of the member it stands for, or
	// nothing at the top. It is handed IN rather than appended afterwards
	// because an unequal pair of values is TWO lines, both of which end a
	// member, and appending to the last of them commas only one.
	suffix: string,
): Array<DiffLine> {
	if (anyIs(left, right)) {
		return [
			{ kind: "same", text: `${indent}${label}${render(left)}${suffix}` },
		]
	}

	if (isRecord(left) && isRecord(right)) {
		return diffEntries(
			recordEntries(left),
			recordEntries(right),
			indent,
			`${label}{`,
			`}${suffix}`,
		)
	}

	if (isList(left) && isList(right)) {
		return diffEntries(
			listEntries(left),
			listEntries(right),
			indent,
			`${label}[`,
			`]${suffix}`,
			false,
		)
	}

	if (isCase(left) && isCase(right) && sameTag(left, right)) {
		let tag = String(left[typeKeySymbol])

		return diffEntries(
			recordEntries(left),
			recordEntries(right),
			indent,
			`${label}${tag} {`,
			`}${suffix}`,
		)
	}

	return [
		{ kind: "left", text: `${indent}${label}${render(left)}${suffix}` },
		{ kind: "right", text: `${indent}${label}${render(right)}${suffix}` },
	]
}

// NOTE: Keys in the LEFT's order, then whatever only the right side has — so a
// difference reads down the value the test computed, and a member that was
// never there arrives at the end rather than in a place it never had.
function diffEntries(
	left: Array<[string, AnyType]>,
	right: Array<[string, AnyType]>,
	indent: string,
	open: string,
	close: string,
	// NOTE: Whether an entry is written under its key. A Record's members are;
	// a List's items are not — its keys are the indices this walk pairs the two
	// sides up by, and printing them would show a List as something no source
	// can write.
	keyed = true,
): Array<DiffLine> {
	let inner = `${indent}    `
	let labelled = (key: string): string => (keyed ? `${key} = ` : "")
	let leftByKey = new Map(left)
	let rightByKey = new Map(right)
	let keys = [
		...left.map(([key]) => key),
		...right.map(([key]) => key).filter((key) => !leftByKey.has(key)),
	]
	let lines: Array<DiffLine> = [{ kind: "same", text: `${indent}${open}` }]

	for (let key of keys) {
		if (!leftByKey.has(key)) {
			lines.push({
				kind: "right",
				text: `${inner}${labelled(key)}${render(rightByKey.get(key)!)},`,
			})

			continue
		}

		if (!rightByKey.has(key)) {
			lines.push({
				kind: "left",
				text: `${inner}${labelled(key)}${render(leftByKey.get(key)!)},`,
			})

			continue
		}

		lines.push(
			...diffValue(
				leftByKey.get(key)!,
				rightByKey.get(key)!,
				inner,
				labelled(key),
				",",
			),
		)
	}

	lines.push({ kind: "same", text: `${indent}${close}` })

	return lines
}

function render(value: AnyType): string {
	return getStringRepresentation(value)
}

function isRecord(value: AnyType): boolean {
	return typeof value !== "function" && value[typeKeySymbol] === "Record"
}

function isList(value: AnyType): boolean {
	return typeof value !== "function" && value[typeKeySymbol] === "List"
}

function isCase(value: AnyType): boolean {
	return (
		typeof value !== "function" &&
		String(value[typeKeySymbol]).includes("#")
	)
}

function sameTag(left: AnyType, right: AnyType): boolean {
	return (
		(left as { [typeKeySymbol]: string })[typeKeySymbol] ===
		(right as { [typeKeySymbol]: string })[typeKeySymbol]
	)
}

function recordEntries(value: AnyType): Array<[string, AnyType]> {
	return Object.entries(value as object) as Array<[string, AnyType]>
}

// NOTE: A List holds its items in two runs with a view into each, so what is
// diffed is the LOGICAL items rather than whatever the backing Array holds —
// the same reading `Terminal.inspect` does.
function listEntries(value: AnyType): Array<[string, AnyType]> {
	return materialise(value as never).map(
		(item, index) => [String(index), item] as [string, AnyType],
	)
}

// #endregion

// #region Events

// NOTE: ONE stream, newline-delimited JSON, every event carrying `schema` and
// `kind`. A consumer that meets a kind it does not know must ignore it: later
// phases add `probe`, `coverage`, `snapshot` and `property` to this list, and
// nothing that reads the stream today may have to change for them.
export type TestEvent =
	| { schema: 1; kind: "run-start"; tests: number; focused: boolean }
	| {
			schema: 1
			kind: "test-start"
			id: string
			name: string
			suitePath: Array<string>
			module: string | null
	  }
	| {
			schema: 1
			kind: "test-pass"
			id: string
			name: string
			duration: number
			expectations: number
	  }
	| {
			schema: 1
			kind: "test-fail"
			id: string
			name: string
			duration: number
			expectations: number
			failures: Array<FailureEvent>
			// NOTE: A test body that threw, rendered. It is a Compiler or a
			// runtime bug rather than a failed assertion, and it ends the test
			// where it stands.
			error: string | null
	  }
	| {
			schema: 1
			kind: "test-skip"
			id: string
			name: string
			suitePath: Array<string>
			module: string | null
			reason: string
	  }
	// NOTE: `suitePath` and `module` on a test that never started, for the same
	// reason `test-start` carries them: a report groups by where a test was
	// written, and a skip is reported in its place in that tree rather than in a
	// list of its own. Nothing can derive them from the id — the id escapes its
	// steps, and a reader would be parsing an identity it is meant to treat as
	// opaque.
	| {
			schema: 1
			kind: "test-deselected"
			id: string
			name: string
			suitePath: Array<string>
			module: string | null
			reason: DeselectionReason
	  }
	| {
			schema: 1
			kind: "expect"
			id: string
			form: "expect" | "require"
			passed: boolean
			span: Span | null
			values: Array<TracedValue>
			comparison: ComparisonEvent | null
	  }
	// NOTE: What a `§?` value comment recorded. It is not a failure and not an
	// assertion — it is the answer to a question a reader wrote into the source,
	// which an Editor draws beside the line and a `--json` consumer may ignore.
	| ({ schema: 1; kind: "probe"; id: string } & ProbedValue)
	| {
			schema: 1
			kind: "output"
			id: string
			stream: OutputStream
			text: string
	  }
	// NOTE: What one Module's counters counted, written once per instrumented
	// Module at the end of a run. Only a run that ASKED for coverage carries
	// these; every other stream has none, which is what "a consumer ignores
	// what it does not know" is for.
	| {
			schema: 1
			kind: "coverage"
			module: string | null
			points: Array<CoveredPoint>
			choices: Array<CoverageChoice>
	  }
	| {
			schema: 1
			kind: "run-end"
			passed: number
			failed: number
			skipped: number
			deselected: number
			duration: number
			focused: boolean
	  }

// NOTE: `not-focused` and `tag` are the spec's two; `filter` is the third a
// `--filter` needs, and is why a consumer is told to tolerate what it does not
// know rather than to switch exhaustively.
export type DeselectionReason = "not-focused" | "tag" | "filter"

export type TracedValue = { point: number; span: Span | null; value: string }

// NOTE: What one `§?` line answered — the same three fields a traced value
// carries, named apart because a consumer keeps them apart: a traced value
// explains an assertion that failed, and a probed one answers a question that
// was asked whether or not anything failed.
export type ProbedValue = { point: number; span: Span | null; value: string }

export type ComparisonEvent = {
	kind: "is" | "isNot"
	left: string | null
	right: string | null
	diff: Array<DiffLine>
}

export type FailureEvent = {
	form: "expect" | "require"
	span: Span | null
	values: Array<TracedValue>
	comparison: ComparisonEvent | null
}

export type EventSink = (event: TestEvent) => void

// #endregion

// #region Selection

export type Filters = {
	// NOTE: A substring of the test's name. An interpolated name is matched on
	// its TEMPLATE, because selection happens before anything has run and a
	// rendering is worked out where the test stands.
	filter?: string | null
	tags?: Array<string>
	skipTags?: Array<string>
	// NOTE: Structural ids. Where any are named, ONLY those run — which is what
	// an Editor's "run this test" asks for, and the one selection a name can not
	// express: two tests may render the same name and never share an id.
	ids?: Array<string>
	// NOTE: Whether a registry BESIDE this one holds a focused test. Focus is
	// decided across a whole run rather than per bundle — the design's
	// "focusing one test in Standings.es also silences Season.tests.es" — and a
	// registry can not see the bundles loaded next to it. Told so, one that
	// holds no focused test of its own deselects everything as `not-focused`,
	// through the same selection and the same rendered names as any other run,
	// so a runner never has to write those events itself.
	focusedElsewhere?: boolean
}

export type Selection =
	| { test: RegisteredTest; state: "run" }
	| { test: RegisteredTest; state: "skip"; reason: string }
	| { test: RegisteredTest; state: "deselected"; reason: DeselectionReason }

// NOTE: What runs, what is reported skipped, and what was deselected and by
// what — one answer, so that the command line, the Language Server's session
// and any other runner all select the same way. `focused` says whether the
// registry holds a focused test at all, which is what a plain run exits
// non-zero about.
export function selectTests(
	registry: Registry,
	filters: Filters = {},
): { selections: Array<Selection>; focused: boolean } {
	let focused =
		(filters.focusedElsewhere ?? false) ||
		registry.tests.some(
			(test) => test.entry.focused && test.entry.skipped === null,
		)
	let tags = filters.tags ?? []
	let skipTags = filters.skipTags ?? []
	let filter = filters.filter ?? null
	let ids = filters.ids ?? []

	let selections = registry.tests.map((test): Selection => {
		let entry = test.entry

		if (entry.skipped !== null) {
			return { test, state: "skip", reason: entry.skipped }
		}

		// NOTE: Before focus, deliberately. Naming a test IS the narrowing, and
		// a run somebody asked for by id is not the run a leftover `focused`
		// was meant to narrow.
		if (ids.length > 0) {
			return ids.includes(entry.id)
				? { test, state: "run" }
				: { test, state: "deselected", reason: "filter" }
		}

		if (focused && !entry.focused) {
			return { test, state: "deselected", reason: "not-focused" }
		}

		// NOTE: `--skip-tag` wins over `--tag`, per the spec: a tag a run is
		// told to leave out is left out however it was also named.
		if (skipTags.some((tag) => entry.tags.includes(tag))) {
			return { test, state: "deselected", reason: "tag" }
		}

		if (tags.length > 0 && !tags.some((tag) => entry.tags.includes(tag))) {
			return { test, state: "deselected", reason: "tag" }
		}

		if (filter !== null && !entry.name.includes(filter)) {
			return { test, state: "deselected", reason: "filter" }
		}

		return { test, state: "run" }
	})

	return { selections, focused }
}

// #endregion

// #region The run

export type RunOptions = {
	sink: EventSink
	filters?: Filters
	// NOTE: Handed in so a spec can run the clock itself. `Date.now` otherwise.
	now?: () => number
	// NOTE: Whether to write a `coverage` event per instrumented Module when
	// the run ends, and to put the counts back to what loading the bundle left
	// them at before it starts. A bundle compiled without `--coverage` has no
	// counters at all and the events are empty, so asking costs nothing; a
	// runner that did not ask is not told.
	coverage?: boolean
}

export type RunSummary = {
	passed: number
	failed: number
	skipped: number
	deselected: number
	duration: number
	focused: boolean
	failedIds: Array<string>
}

export function runTests(registry: Registry, options: RunOptions): RunSummary {
	let now = options.now ?? (() => Date.now())
	let sink = options.sink
	let { selections, focused } = selectTests(registry, options.filters)
	let running = selections.filter((selection) => selection.state === "run")
	let started = now()

	sink({ schema: 1, kind: "run-start", tests: running.length, focused })

	let summary: RunSummary = {
		passed: 0,
		failed: 0,
		skipped: 0,
		deselected: 0,
		duration: 0,
		focused,
		failedIds: [],
	}

	// NOTE: The rendered names, worked out ONCE per Module by running its
	// section with a context that selects no test. It is what an interpolated
	// name needs — the scope it was written in — and it costs one evaluation of
	// the setup rather than one per test.
	let names = renderedNames(registry)

	// NOTE: After the enumeration, which evaluates a Module's setup and would
	// otherwise be counted into the run that follows it.
	if (options.coverage === true) {
		beginCoverageRun()
	}

	for (let selection of selections) {
		let entry = selection.test.entry
		let name = names.get(entry.id) ?? entry.name

		if (selection.state === "skip") {
			summary.skipped += 1
			sink({
				schema: 1,
				kind: "test-skip",
				id: entry.id,
				name,
				suitePath: pathOf(entry),
				module: selection.test.module.module,
				reason: selection.reason,
			})

			continue
		}

		if (selection.state === "deselected") {
			summary.deselected += 1
			sink({
				schema: 1,
				kind: "test-deselected",
				id: entry.id,
				name,
				suitePath: pathOf(entry),
				module: selection.test.module.module,
				reason: selection.reason,
			})

			continue
		}

		runOne(selection.test, name, sink, now, summary)
	}

	summary.duration = now() - started

	// NOTE: Before `run-end`, so that a consumer folding the stream has every
	// Module's counts in hand by the time the run is declared over.
	if (options.coverage === true) {
		for (let report of coverage()) {
			sink({
				schema: 1,
				kind: "coverage",
				module: report.module,
				points: report.points,
				choices: report.choices,
			})
		}
	}

	sink({
		schema: 1,
		kind: "run-end",
		passed: summary.passed,
		failed: summary.failed,
		skipped: summary.skipped,
		deselected: summary.deselected,
		duration: summary.duration,
		focused,
	})

	return summary
}

// NOTE: One evaluation of every Module's setup with `index: -1`, which runs no
// test and records every interpolated name. A Module whose setup throws gets no
// names and nothing else: the failure surfaces per test, where a reader can see
// which test it stopped.
//
// NOTE: Only for a Module that HAS an interpolated name — a template with no
// hole in it is what the test will be called, and running a section to be told
// so would make every run pay for the one shape that needs it. Whatever the
// setup writes on the way is dropped: the output a reader is shown belongs to a
// test, and no test is running here.
function renderedNames(registry: Registry): Map<string, string> {
	let names = new Map<string, string>()

	for (let module of registry.modules) {
		if (!module.tests.some((entry) => entry.interpolated)) {
			continue
		}

		let context = createContext(-1)

		try {
			withOutputSink(
				(text, stream) => context.output.push({ stream, text }),
				() => module.run(context),
			)
		} catch {
			continue
		}

		module.tests.forEach((entry, index) => {
			let rendered = context.names.get(index)

			if (rendered !== undefined) {
				names.set(entry.id, rendered)
			}
		})
	}

	return names
}

function runOne(
	test: RegisteredTest,
	name: string,
	sink: EventSink,
	now: () => number,
	summary: RunSummary,
): void {
	let entry = test.entry
	let spans = test.module.spans
	let context = createContext(test.index)

	sink({
		schema: 1,
		kind: "test-start",
		id: entry.id,
		name,
		suitePath: pathOf(entry),
		module: test.module.module,
	})

	let started = now()
	let error: string | null = null

	try {
		withOutputSink(
			(text, stream) => context.output.push({ stream, text }),
			() => test.module.run(context),
		)
	} catch (thrown) {
		// NOTE: A failed `require` unwinds the test on purpose and is not an
		// error — what it recorded is on the context already, and the report is
		// about the assertion rather than about the way the test ended.
		if (thrown !== requirementFailed) {
			error =
				thrown instanceof Error
					? (thrown.stack ?? thrown.message)
					: String(thrown)
		}
	}

	let duration = now() - started

	for (let chunk of context.output) {
		sink({
			schema: 1,
			kind: "output",
			id: entry.id,
			stream: chunk.stream,
			text: chunk.text,
		})
	}

	// NOTE: One event per PROBED POINT rather than per recording, carrying the
	// last value that point held — a `§?` on a line inside a loop is one
	// question, asked once, and an Editor draws one answer beside it.
	for (let point of probedPoints(context.probes)) {
		sink({
			schema: 1,
			kind: "probe",
			id: entry.id,
			point,
			span: spans[point] ?? null,
			value: render(valueAt(context.probes, point)!),
		})
	}

	let failures: Array<FailureEvent> = []

	for (let expectation of context.expectations) {
		// NOTE: Only a FAILED assertion has its values rendered. A run that
		// passes records as many values as it evaluated and needs none of
		// them, and rendering a Record is a walk of the whole Record.
		let event = expectation.passed
			? {
					form: expectation.form,
					span: spans[expectation.point] ?? null,
					values: [],
					comparison: null,
				}
			: failureOf(expectation, spans)

		sink({
			schema: 1,
			kind: "expect",
			id: entry.id,
			form: expectation.form,
			passed: expectation.passed,
			span: event.span,
			values: event.values,
			comparison: event.comparison,
		})

		if (!expectation.passed) {
			failures.push(event)
		}
	}

	if (failures.length === 0 && error === null) {
		summary.passed += 1
		sink({
			schema: 1,
			kind: "test-pass",
			id: entry.id,
			name,
			duration,
			expectations: context.expectations.length,
		})

		return
	}

	summary.failed += 1
	summary.failedIds.push(entry.id)
	sink({
		schema: 1,
		kind: "test-fail",
		id: entry.id,
		name,
		duration,
		expectations: context.expectations.length,
		failures,
		error,
	})
}

// NOTE: The points a test probed, in the order they were first recorded at —
// which is the order the value comments were written in, so an Editor drawing
// them reads down the file.
function probedPoints(probes: Array<Trace>): Array<number> {
	let points: Array<number> = []

	for (let entry of probes) {
		if (!points.includes(entry.point)) {
			points.push(entry.point)
		}
	}

	return points
}

// NOTE: One recorded assertion, rendered — every value as the text a reader
// sees, every point resolved against the Module's span table, and the two
// operands of an `Equatable` comparison diffed. Rendering happens HERE rather
// than at the sink so that a JSON consumer and a terminal reporter are shown
// the same thing.
function failureOf(expectation: Expectation, spans: Array<Span>): FailureEvent {
	return {
		form: expectation.form,
		span: spans[expectation.point] ?? null,
		values: expectation.traces.map((entry) => ({
			point: entry.point,
			span: spans[entry.point] ?? null,
			value: render(entry.value),
		})),
		comparison:
			expectation.comparison === null
				? null
				: {
						kind: expectation.comparison.kind,
						left:
							expectation.comparison.left === undefined
								? null
								: render(expectation.comparison.left),
						right:
							expectation.comparison.right === undefined
								? null
								: render(expectation.comparison.right),
						diff: structuralDiff(
							expectation.comparison.left,
							expectation.comparison.right,
						),
					},
	}
}

// #endregion

// #region The way in

// NOTE: What a bundle publishes, under `$tests` on its entry Module — the one
// name a runner looks up, and the reason the runner does not reach for this
// module itself. Every value an Essence Program builds carries a hidden Type
// key that is a `Symbol` of the runtime instance that built it, and a bundle
// inlines its OWN runtime: a diff, a rendering or an equality asked from
// outside would be asking a different runtime about values it has never seen,
// and would read `undefined` off every one of them. So everything that touches
// a value runs in here, and what crosses the boundary is events — plain data,
// already rendered.
//
// NOTE: An object rather than three exports, so that a later phase adding
// coverage or snapshots to the contract adds a member rather than a name the
// Rewriter has to learn.
export const entryPoints = {
	registry,
	// NOTE: Offered here as well as exported, for a runner that can not import
	// this module at all — the Language Server's session runs a bundle inside a
	// Worker, whose only way to reach anything is the bundle it was handed. It
	// indexes what it is given and reads no value, so unlike everything beside
	// it, it is safe to call from either side of the boundary.
	registryOf,
	run: runTests,
	select: selectTests,
	// NOTE: What a Module's counters have counted, read from INSIDE the bundle
	// like everything else here. The report is plain data — numbers and the
	// table the Compiler emitted — so it crosses the boundary safely once it
	// has been asked for in here.
	coverage,
}

// #endregion
