import {
	decode,
	encode,
	type EncodedValue,
	type Generator,
	GenerationFailure,
	generate,
	shrink,
} from "./Generators"
import { anyIs } from "./internalHelpers"
import { materialise } from "./List"
import { createEntropy, createRandomness, nextWord, seedOf } from "./Randomness"
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
	// NOTE: Whether the item was written as a `benchmark` rather than as a
	// `test`. It is what says whether the entry runs at all: measuring a body
	// takes hundreds of runs of it, which is work no ordinary run asked for, so
	// a benchmark runs where a run said `bench` and where somebody named it.
	benchmark: boolean
	// NOTE: The identity WITHOUT the Module path, a row spelled as its last
	// step — what everything stored BESIDE the file is keyed by: a benchmark's
	// baseline, a property test's counterexamples. The Compiler spells it, so
	// the escaping exists once; nothing in here re-derives it.
	key: string
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
	// NOTE: What a snapshot assertion compared, as TEXT — a snapshot is two
	// strings by the time anything compares them, so there is no value to
	// render and no structure to walk. Null for every other assertion.
	snapshot: SnapshotComparison | null
}

export type SnapshotComparison = {
	name: string | null
	expected: string | null
	actual: string
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

// NOTE: The STORED snapshots of one Module, keyed by the name written after
// `matches snapshot from`. They are read off `__snapshots__/<File>.es.snap`
// beside the source and handed to the run, because the runtime is a bundle: it
// may be running in a browser, and nothing in it reads a file.
export type SnapshotStore = Record<string, string>

// NOTE: One Parameter of a stored counterexample. It is kept under the
// Parameter's NAME rather than at a position, because a property whose
// Parameters were reordered is one a stored tuple would otherwise be silently
// wrong about — and a name that is no longer there is what says the entry has
// gone stale.
export type StoredValue = { name: string; data: EncodedValue }

export type StoredCounterexample = { values: Array<StoredValue> }

// NOTE: The STORED counterexamples of one Module, keyed by the test's identity
// WITHOUT the Module step — the file they were read from is that Module's
// already. Every one of them is re-run before a single case is drawn, so a bug
// a search found once is caught by the run after it, and by every run after
// that, for as long as the entry lives. Like a snapshot they are read off a
// companion beside the source and handed to the run: the runtime is a bundle,
// it may be running in a browser, and nothing in it reads a file.
export type CorpusStore = Record<string, Array<StoredCounterexample>>

// NOTE: What `matches snapshot` compares against, as the emitted call hands it
// over. `slot` is the point of the Module's span table where a recorded value
// stands, or would stand — what a run writes one back into.
export type SnapshotSlot = {
	name: string | null
	recorded: string | null
	slot: number
}

// NOTE: What one snapshot assertion did. `written` is a snapshot that had none
// recorded, or one an updating run replaced — both a pass, and both something
// the runner has to write down somewhere. `mismatched` is the failure.
export type SnapshotStatus = "written" | "matched" | "mismatched"

export type RecordedSnapshot = {
	point: number
	slot: number
	name: string | null
	status: SnapshotStatus
	text: string
	recorded: string | null
}

// NOTE: The STORED baselines of one Module, keyed the way a stored snapshot is
// — by the entry a measurement is written under, which is the identity without
// the Module path and with a table row's number behind it. Read off
// `__benchmarks__/<File>.es.bench` beside the source and handed to the run,
// because the runtime is a bundle and nothing in it reads a file.
export type BenchmarkStore = Record<string, number>

// NOTE: What one measurement did against what was recorded. `written` is a
// benchmark that had no baseline, or one an updating run replaced — both a
// pass, and both something the runner has to write down. `regressed` is the
// failure; `improved` passes and says so, because a measurement that got faster
// is news rather than a problem, and the baseline is only replaced where
// somebody asked.
export type BenchmarkStatus = "written" | "matched" | "regressed" | "improved"

// NOTE: One measurement. `nanoseconds` is the time of ONE run of the body — the
// median sample's batch divided by the runs in it — in whole nanoseconds,
// because that is the unit at which the number stops being a float that reads
// differently every time it is printed. `iterations` and `samples` are what it
// was measured out of, which is what says how much to believe it.
export type BenchmarkResult = {
	key: string
	nanoseconds: number
	iterations: number
	samples: number
	baseline: number | null
	ratio: number | null
	status: BenchmarkStatus
}

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
	// NOTE: What the snapshot assertions of this test recorded, whether they
	// held or not: a run has to write a new one down, and an updating run has
	// to write a replaced one down too.
	snapshots: Array<RecordedSnapshot>
	// NOTE: The stored snapshots this Module's tests may name, read from disk
	// by whoever started the run, and whether a mismatch is to be REPLACED
	// rather than reported. Both belong to the context because a capability a
	// test can not reach is a capability it does not have.
	stored: SnapshotStore
	// NOTE: The stored baselines this Module's benchmarks are held to, read off
	// disk by whoever started the run. It is on the context for the same reason
	// the snapshots are: a capability a test can not reach is a capability it
	// does not have.
	benchStored: BenchmarkStore
	updating: boolean
	// NOTE: Which row of a table test is running, and null for the ordinary
	// test that runs once. A stored snapshot is keyed by it — every row of a
	// table runs the same body, so one name would be one entry the rows
	// overwrite in turn, and only the last of them could ever match.
	row: number | null
	// NOTE: The running entry's durable identity as the Compiler spelled it —
	// suite path and name, a row as its last step, the Module left off. It is
	// what a baseline is stored under, and it arrives through the manifest so
	// that the escaping exists in exactly one place.
	key: string
	// NOTE: Whether a benchmark of this run MEASURES. A coverage run does not:
	// its bundle counts every branch it takes, which makes the body slower by
	// an amount only the instrumentation knows — a number measured there is
	// about the counters, and a baseline recorded off it would fail the first
	// uninstrumented run. The body still runs once, so its lines are covered.
	measure: boolean
	// NOTE: Whether the recording primitives write anything down. The
	// measurement batches turn this off: a batch of sixty-five thousand runs
	// would otherwise record sixty-five thousand expectations, and the clock
	// would be timing the runner's own bookkeeping alongside the body. What a
	// `require` DOES — end the run where it failed — is not recording, and
	// never turns off.
	recording: boolean
	// NOTE: What a property test draws with, and how many cases it runs. The
	// seed is the RUN's, printed on a failure and read back by `--seed`; `word`
	// is that seed folded together with the test's own id, so replaying one
	// test with `-f` draws exactly the sequence the whole run drew for it.
	property: PropertySettings
	// NOTE: What the property test of THIS context did, and null for every
	// ordinary test. It is written by `properties` and read by the run, which
	// is what turns it into the one event that says how many cases held.
	propertyResult: PropertyResult | null
	// NOTE: What the benchmark of THIS context measured, and null for every
	// test that is not one — the same arrangement `propertyResult` has, and for
	// the same reason: the driver writes it and the run turns it into the one
	// event that says how long the body took.
	benchmarkResult: BenchmarkResult | null
	// NOTE: The clock a measurement is read off, in high-resolution
	// milliseconds. It is on the context rather than reached for so that a spec
	// can drive it: a measurement asserted against a real clock is a test whose
	// answer depends on the machine, which is a flake with a schedule.
	clock: () => number
	output: Array<OutputChunk>
	// NOTE: What has been counted so far, asked from inside a running test
	// rather than only read out at the end of a run. Coverage is a fact about
	// the BUNDLE and not about one test, so this is the same answer for every
	// context — it is offered here because the context is what a test holds,
	// and a capability a test can not reach is a capability it does not have.
	coverage: () => Array<CoverageReport>
}

// NOTE: What a property test draws with. `word` is the state a source is built
// from and `seed` is what a reader types after `--seed` to get it back.
//
// NOTE: `replays` are the counterexamples THIS test has failed on before, run
// first and in the order they were stored. A run that finds one still failing
// never draws a case at all: the answer is already in hand, and a search that
// went looking for it again would report whatever it happened to find instead.
export type PropertySettings = {
	seed: string
	word: number
	cases: number
	replays: Array<StoredCounterexample>
}

export type PropertyCounterexample = { name: string; value: string }

export type PropertyResult = {
	// NOTE: How many cases RAN, which is every one of them where the property
	// held and the number it took to break it where it did not.
	cases: number
	// NOTE: How many the run was told to run, which is what a replay has to say
	// back: the size a case is drawn at grows with the case number over the
	// WHOLE run, so a hundred cases and four hundred draw two different
	// sequences from one seed.
	requested: number
	seed: string
	shrinks: number
	counterexample: Array<PropertyCounterexample> | null
	// NOTE: How many stored counterexamples were read back and re-run before
	// anything was drawn. It is counted APART from `cases` on purpose: a replay
	// takes no word from the source, so a run of ten replays and a hundred cases
	// draws exactly what a run of a hundred cases draws — which is what keeps
	// `--seed` reproducing a run whose corpus has grown since.
	replayed: number
	// NOTE: Which stored entries no longer read back, by their index in the
	// stored list. The Types changed under them, or a refinement stopped
	// admitting what it once did; the runner drops exactly these on the next
	// write.
	stale: Array<number>
	// NOTE: Whether the failure came from a replay rather than from a draw,
	// which is what a report says in place of "after N cases".
	fromCorpus: boolean
	// NOTE: The SHRUNK counterexample written down, ready to be stored — and
	// null where any Parameter refuses to be written down at all, because one
	// `Generatable` conformance anywhere inside a generator costs the whole test
	// its corpus.
	encoded: Array<StoredValue> | null
}

// NOTE: The cases a property runs where nobody said. A hundred is the number
// the design names, and it is the number every property testing library has
// settled on: enough that a shape-level mistake shows, few enough that a suite
// of them still runs while a reader waits.
export const DEFAULT_CASES = 100

// NOTE: `performance.now` where the host has one, and `Date.now` where it has
// not. A bundle is inlined wherever it is loaded, which is not always somewhere
// with a high-resolution clock — and a measurement read off a coarse one is
// still a measurement, taken over a batch big enough to show.
function defaultClock(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now()
}

export function createContext(
	index: number,
	options: {
		stored?: SnapshotStore
		benchmarks?: BenchmarkStore
		updating?: boolean
		row?: number | null
		key?: string
		measure?: boolean
		property?: PropertySettings
		clock?: () => number
	} = {},
): TestContext {
	return {
		index,
		names: new Map(),
		traces: [],
		probes: [],
		expectations: [],
		snapshots: [],
		stored: options.stored ?? {},
		benchStored: options.benchmarks ?? {},
		updating: options.updating ?? false,
		row: options.row ?? null,
		key: options.key ?? "",
		measure: options.measure ?? true,
		recording: true,
		property: options.property ?? {
			seed: "",
			word: 0,
			cases: DEFAULT_CASES,
			replays: [],
		},
		propertyResult: null,
		benchmarkResult: null,
		clock: options.clock ?? defaultClock,
		output: [],
		coverage,
	}
}

// #endregion

// #region What the emitted JavaScript calls

// NOTE: One suite's Scope, holding the tests `first` up to `last`. A run is one
// test, and the setup that test must see is the section's and that of the suites
// it is written IN — so a Scope holding no part of the run is stepped over
// whole. Without that, every test of a file evaluated every suite's setup: work
// nobody asked for, and, where a suite printed something, output attributed to
// tests written beside it rather than in it.
//
// NOTE: `-1` is the enumeration pass, which walks the section to work out every
// rendered name and runs no test. It enters every Scope, because a name it did
// not reach is a name nothing can report.
export function scope(
	context: TestContext,
	first: number,
	last: number,
	run: () => void,
): void {
	if (
		context.index === -1 ||
		(context.index >= first && context.index < last)
	) {
		run()
	}
}

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

// NOTE: One benchmark, standing where it was written. It is the `entry` call
// with the driver wrapped round the body: which entry is selected, and what its
// rendered name is, are the same questions for both forms, and answering them
// twice is how the two would come to disagree.
export function benchmark(
	context: TestContext,
	index: number,
	name: StringType | null,
	run: () => void,
): void {
	entry(context, index, name, () => runBenchmark(context, run))
}

export function benchmarkRows<Value extends AnyType>(
	context: TestContext,
	first: number,
	values: Array<Value>,
	name: ((row: Value) => StringType) | null,
	run: (row: Value) => void,
): void {
	rows(context, first, values, name, (value) =>
		runBenchmark(context, () => run(value)),
	)
}

// NOTE: One property test, standing where it was written. The body is run once
// per generated case rather than once, and what a reader is shown when it fails
// is the SMALLEST case that still fails — everything a run records about the
// cases that held is rolled back, so a hundred passing cases leave exactly
// nothing behind.
export type PropertyParameter = { name: string; generator: Generator }

export function properties(
	context: TestContext,
	index: number,
	name: StringType | null,
	parameters: Array<PropertyParameter>,
	run: (...values: Array<AnyType>) => void,
): void {
	if (name !== null) {
		context.names.set(index, name.value)
	}

	if (context.index !== index) {
		return
	}

	runProperty(context, parameters, run)
}

// NOTE: What a case may leave on the context. A case that held leaves none of
// it: the buffers are cut back to these lengths, so what a report reads is the
// FAILING case's recordings and nothing from the ninety-nine before it.
type ContextMark = {
	traces: number
	probes: number
	expectations: number
	snapshots: number
	output: number
}

function markOf(context: TestContext): ContextMark {
	return {
		traces: context.traces.length,
		probes: context.probes.length,
		expectations: context.expectations.length,
		snapshots: context.snapshots.length,
		output: context.output.length,
	}
}

function rewind(context: TestContext, mark: ContextMark): void {
	context.traces.length = mark.traces
	context.probes.length = mark.probes
	context.expectations.length = mark.expectations
	context.snapshots.length = mark.snapshots
	context.output.length = mark.output
}

// NOTE: How many candidates a shrink is allowed to try before it answers with
// the smallest thing it has. A pass over one Parameter is cheap; a property
// whose body is slow is what this bounds.
const SHRINK_ATTEMPTS = 400

function runProperty(
	context: TestContext,
	parameters: Array<PropertyParameter>,
	run: (...values: Array<AnyType>) => void,
): void {
	let settings = context.property
	let source = createRandomness(settings.word)
	let mark = markOf(context)
	let stale: Array<number> = []
	let failing: Array<AnyType> | null = null
	let fromCorpus = false
	let replayed = 0
	let ran = 0

	// NOTE: The corpus BEFORE the search, in the order it was stored, newest
	// first. What it holds is every value this test has ever failed on, so a
	// regression on an old bug is caught before a single word is drawn — and
	// found in the one case that is known to have found it, rather than in
	// whatever a hundred fresh draws happen to turn up.
	for (let [index, replay] of settings.replays.entries()) {
		let values = decodeReplay(parameters, replay)

		// NOTE: An entry the generators no longer read back — the Types moved
		// under it. It is recorded rather than dropped here, because a bundle
		// writes no file: what happens to the entry is the runner's to decide.
		if (values === null) {
			stale.push(index)

			continue
		}

		replayed += 1

		if (!holds(context, mark, run, values)) {
			failing = values
			fromCorpus = true

			break
		}
	}

	// NOTE: Only where every stored case held. A replay that failed IS the
	// counterexample, and drawing a hundred more would report whichever value
	// the search happened to reach first in place of the one already in hand.
	for (let index = 0; failing === null && index < settings.cases; index++) {
		// NOTE: The size grows with the case number, so the early cases are
		// small — a failure found among them is nearly minimal already — and
		// the late ones are big enough to break an assumption a short List
		// never would.
		let size =
			1 + Math.floor((index * 48) / Math.max(settings.cases - 1, 1))
		let values: Array<AnyType>

		try {
			values = parameters.map((parameter) =>
				generate(parameter.generator, source, size),
			)
		} catch (thrown) {
			// NOTE: A refinement nothing could satisfy. The result is recorded
			// FIRST so the report still says how many cases held, and then the
			// failure ends the test the way any other thrown error does.
			context.propertyResult = {
				cases: ran,
				requested: settings.cases,
				seed: settings.seed,
				shrinks: 0,
				counterexample: null,
				replayed,
				stale,
				fromCorpus: false,
				encoded: null,
			}

			throw thrown
		}

		ran += 1

		if (!holds(context, mark, run, values)) {
			failing = values

			break
		}
	}

	if (failing === null) {
		context.propertyResult = {
			cases: ran,
			requested: settings.cases,
			seed: settings.seed,
			shrinks: 0,
			counterexample: null,
			replayed,
			stale,
			fromCorpus: false,
			encoded: null,
		}

		return
	}

	// NOTE: A replayed failure is shrunk as well, rather than reported as it
	// was stored: the code has changed since it was written down, and it may
	// now fail on something smaller than what broke it the first time.
	let shrunk = shrinkCase(context, mark, run, parameters, failing)

	context.propertyResult = {
		cases: ran,
		requested: settings.cases,
		seed: settings.seed,
		shrinks: shrunk.shrinks,
		counterexample: parameters.map((parameter, index) => ({
			name: parameter.name,
			value: render(shrunk.values[index]!),
		})),
		replayed,
		stale,
		fromCorpus,
		encoded: encodeCase(parameters, shrunk.values),
	}

	// NOTE: The last run is the one whose recordings the report is built from,
	// and it is NOT guarded: a body that throws has to end the test the way it
	// would have ended an ordinary one, and a failed `require` has to unwind
	// exactly as far as it always does.
	rewind(context, mark)
	run(...shrunk.values)
}

// NOTE: One stored counterexample read back as the values to run the body with,
// and nothing where it no longer describes this property. The Parameters are
// matched by NAME and the name set has to be exactly the generators' — a
// Parameter that was added, removed or renamed makes the entry a claim about a
// test that no longer exists.
function decodeReplay(
	parameters: Array<PropertyParameter>,
	replay: StoredCounterexample,
): Array<AnyType> | null {
	let stored = replay.values

	if (!Array.isArray(stored) || stored.length !== parameters.length) {
		return null
	}

	let byName = new Map(stored.map((value) => [value?.name, value?.data]))

	if (byName.size !== parameters.length) {
		return null
	}

	let values: Array<AnyType> = []

	for (let parameter of parameters) {
		let data = byName.get(parameter.name)

		if (data === undefined) {
			return null
		}

		let value = decode(parameter.generator, data)

		if (value === null) {
			return null
		}

		values.push(value)
	}

	return values
}

// NOTE: The whole case written down, or nothing at all. One Parameter that can
// not be written down costs the test its corpus: half a case is not a case, and
// storing it would replay a property with a value nobody chose in the hole.
function encodeCase(
	parameters: Array<PropertyParameter>,
	values: Array<AnyType>,
): Array<StoredValue> | null {
	let stored: Array<StoredValue> = []

	for (let [index, parameter] of parameters.entries()) {
		let data = encode(parameter.generator, values[index]!)

		if (data === null) {
			return null
		}

		stored.push({ name: parameter.name, data })
	}

	return stored
}

// NOTE: One case, rolled back where it held. A case FAILS when it recorded a
// failed assertion or when it threw — a failed `require` throws the runtime's
// own sentinel, which is a failure like any other here rather than the end of
// the test.
function holds(
	context: TestContext,
	mark: ContextMark,
	run: (...values: Array<AnyType>) => void,
	values: Array<AnyType>,
): boolean {
	rewind(context, mark)

	try {
		run(...values)
	} catch (thrown) {
		if (thrown === requirementFailed) {
			return false
		}

		// NOTE: A generation failure inside a body is nobody's counterexample —
		// it says the run could not ask the question at all.
		if (thrown instanceof GenerationFailure) {
			throw thrown
		}

		return false
	}

	for (
		let index = mark.expectations;
		index < context.expectations.length;
		index++
	) {
		if (!context.expectations[index]!.passed) {
			return false
		}
	}

	return true
}

// NOTE: The smallest failing case this can reach: one Parameter at a time,
// keeping every candidate that still fails, and starting over whenever one did
// — so a List that shrinks to three items has its items shrunk afterwards.
function shrinkCase(
	context: TestContext,
	mark: ContextMark,
	run: (...values: Array<AnyType>) => void,
	parameters: Array<PropertyParameter>,
	failing: Array<AnyType>,
): { values: Array<AnyType>; shrinks: number } {
	let values = [...failing]
	let shrinks = 0
	let attempts = 0
	let improved = true

	while (improved && attempts < SHRINK_ATTEMPTS) {
		improved = false

		for (let [index, parameter] of parameters.entries()) {
			for (let candidate of shrink(parameter.generator, values[index]!)) {
				if (attempts >= SHRINK_ATTEMPTS) {
					break
				}

				attempts += 1

				let attempt = [...values]

				attempt[index] = candidate

				if (holds(context, mark, run, attempt)) {
					continue
				}

				values = attempt
				shrinks += 1
				improved = true

				break
			}
		}
	}

	return { values, shrinks }
}

// NOTE: How a measurement is taken. A single run of a fast body is mostly the
// clock's own resolution, so the body is run in BATCHES big enough to take a
// few milliseconds, and the batch is timed rather than the run. Several batches
// are taken and the MIDDLE one answers: a mean is dragged by the one batch the
// machine was busy through, and the fastest is the one nothing interrupted
// rather than the one a reader will meet.
const BENCHMARK_SAMPLES = 7
const BENCHMARK_BATCH_MILLISECONDS = 5
// NOTE: What the calibration stops at, whatever the body costs. A body fast
// enough to want more than this is measured well enough already, and one that
// is not is a body a reader would rather see the answer for than wait out.
const BENCHMARK_MAX_ITERATIONS = 65536
// NOTE: The batch times behind the sample tiers — see the note where the tier
// is chosen. Two hundred milliseconds is a body no batching helped; a second
// is a body whose one run is the measurement.
const BENCHMARK_STEADY_BATCH_MILLISECONDS = 200
const BENCHMARK_SLOW_BATCH_MILLISECONDS = 1000
// NOTE: The band a measurement is allowed to move in before it is news. A
// quarter slower is a regression a reader has to look at; a fifth faster is an
// improvement worth recording. Everything between the two is the machine.
const REGRESSION_RATIO = 1.25
const IMPROVEMENT_RATIO = 0.8

function runBenchmark(context: TestContext, run: () => void): void {
	// NOTE: A run that is not measuring — a coverage run — takes the body the
	// way it takes a test's: once, unguarded, nothing recorded about time.
	// Measuring an instrumented body would time the counters, and a baseline
	// recorded off one would fail the first uninstrumented run.
	if (!context.measure) {
		run()

		return
	}

	let mark = markOf(context)

	// NOTE: A body that does not hold is REPORTED and never timed. Timing
	// something that is wrong measures the wrong thing, and the number would go
	// into a baseline as if it meant something. The last run is unguarded, so
	// exactly one execution's recordings are left behind — the move
	// `runProperty` makes after a shrink, for the same reason.
	if (!holds(context, mark, run, [])) {
		rewind(context, mark)
		run()

		return
	}

	let iterations = 1
	let elapsed: number
	let perRun: Array<number> = []
	let samples: number

	// NOTE: Nothing is recorded while the clock runs — see
	// `TestContext.recording`. The flag comes back on whatever the body does,
	// because the run below it is the one the report is built from.
	context.recording = false

	try {
		elapsed = timeBatch(context, mark, run, iterations)

		while (
			elapsed < BENCHMARK_BATCH_MILLISECONDS &&
			iterations < BENCHMARK_MAX_ITERATIONS
		) {
			iterations *= 2
			elapsed = timeBatch(context, mark, run, iterations)
		}

		// NOTE: Fewer samples the slower the body. Seven batches of a body that
		// takes seconds is a minute a reader did not ask to wait — and the
		// editor's run-by-id door has a session deadline behind it — while a
		// slow body's batches barely jitter: one long run IS its own average.
		samples =
			elapsed >= BENCHMARK_SLOW_BATCH_MILLISECONDS
				? 1
				: elapsed >= BENCHMARK_STEADY_BATCH_MILLISECONDS
					? 3
					: BENCHMARK_SAMPLES

		for (let sample = 0; sample < samples; sample++) {
			perRun.push(timeBatch(context, mark, run, iterations) / iterations)
		}
	} finally {
		context.recording = true
	}

	// NOTE: At least one nanosecond. A body the clock can not tell from nothing
	// is not free, and a baseline of zero is a number every later run is
	// infinitely slower than.
	let nanoseconds = Math.max(1, Math.round(median(perRun) * 1_000_000))
	// NOTE: The entry a stored baseline is kept under is the one durable
	// identity the Compiler spelled for this entry — a table row's key already
	// carries the row as its last step, so the rows of one table never share
	// an entry they would overwrite in turn.
	let storedKey = context.key
	let stored = context.benchStored[storedKey]
	// NOTE: A baseline of nothing is not a baseline. No measurement writes one
	// — the driver floors at a nanosecond — so a zero can only be a hand-edited
	// or merge-mangled file, and holding a run to it would report every later
	// measurement as infinitely slower. It is re-recorded instead.
	let baseline = stored !== undefined && stored > 0 ? stored : null
	let ratio = baseline === null ? null : nanoseconds / baseline
	let status: BenchmarkStatus =
		ratio === null
			? "written"
			: ratio <= REGRESSION_RATIO && ratio >= IMPROVEMENT_RATIO
				? "matched"
				: context.updating
					? "written"
					: ratio > REGRESSION_RATIO
						? "regressed"
						: "improved"

	context.benchmarkResult = {
		key: storedKey,
		nanoseconds,
		iterations,
		samples,
		baseline,
		ratio,
		status,
	}

	// NOTE: The run whose recordings the report is built from, and it is NOT
	// guarded — a body that throws has to end the test the way it always would,
	// exactly as the last run of a shrunk property does.
	rewind(context, mark)
	run()
}

// NOTE: One batch, timed. The context is rewound BEFORE the clock is read and
// never inside it: a batch of a thousand runs records a thousand times over,
// and clearing that between them would be timing the runner's bookkeeping
// alongside the body.
function timeBatch(
	context: TestContext,
	mark: ContextMark,
	run: () => void,
	iterations: number,
): number {
	rewind(context, mark)

	let started = context.clock()

	for (let index = 0; index < iterations; index++) {
		run()
	}

	return context.clock() - started
}

// NOTE: The lower middle of the samples, which for an odd count is the middle.
function median(values: Array<number>): number {
	let sorted = [...values].sort((left, right) => left - right)

	return sorted[(sorted.length - 1) >> 1] ?? 0
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
	if (context.recording) {
		context.traces.push({ point, value })
	}

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
	if (context.recording) {
		context.probes.push({ point, value })
	}

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

// NOTE: `matches snapshot`. What it is handed is the value already RENDERED —
// `Printable::toString`, which the Compiler lowers as the interpolation an
// author could have written — so the whole of the comparison here is two
// strings, and a Type that says what it looks like is recorded in that form.
//
// A snapshot nothing has recorded PASSES and is written down: the first run of
// a new snapshot is what records it, and a run that refused it would refuse
// every new test. An updating run treats a difference the same way. Everything
// recorded is handed back through the context, because writing a file is the
// runner's business and not a bundle's.
export function snapshotted(
	context: TestContext,
	point: number,
	form: "expect" | "require",
	snapshot: SnapshotSlot,
	text: StringType,
): void {
	let actual = text.value
	let name = storedName(snapshot.name, context.row)
	let expected =
		name === null ? snapshot.recorded : (context.stored[name] ?? null)
	let status: SnapshotStatus =
		expected === null
			? "written"
			: expected === actual
				? "matched"
				: context.updating
					? "written"
					: "mismatched"

	if (context.recording) {
		context.snapshots.push({
			point,
			slot: snapshot.slot,
			name,
			status,
			text: actual,
			recorded: expected,
		})
	}

	record(context, form, point, status !== "mismatched", null, {
		name,
		expected,
		actual,
	})

	if (status === "mismatched" && form === "require") {
		throw requirementFailed
	}
}

// NOTE: The entry a stored snapshot is kept under. A row of a table test gets
// one per row, spelled with the row number, because the rows share a body and
// would otherwise share the entry: the first run would store the last row's
// value and every run after would report the others as differing, for ever.
function storedName(name: string | null, row: number | null): string | null {
	if (name === null) {
		return null
	}

	return row === null ? name : `${name} [${row}]`
}

function record(
	context: TestContext,
	form: "expect" | "require",
	point: number,
	passed: boolean,
	comparison: Comparison | null,
	snapshot: SnapshotComparison | null = null,
): void {
	if (!context.recording) {
		return
	}

	let traces = context.traces

	context.traces = []
	context.expectations.push({
		form,
		point,
		passed,
		traces,
		snapshot,
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

// NOTE: What a snapshot's difference reads as: the lines the two texts share,
// and the ones only one of them has. It is the plainest correct answer — a
// common-prefix and common-suffix walk, with whatever is left in the middle
// reported whole — because a snapshot is text a reader wrote or a Program
// printed, and a minimal edit script over lines would only ever say the same
// thing in a way that is harder to read.
export function lineDiff(left: string, right: string): Array<DiffLine> {
	let leftLines = left.split("\n")
	let rightLines = right.split("\n")
	let head = 0

	while (
		head < leftLines.length &&
		head < rightLines.length &&
		leftLines[head] === rightLines[head]
	) {
		head += 1
	}

	let tail = 0

	while (
		tail < leftLines.length - head &&
		tail < rightLines.length - head &&
		leftLines[leftLines.length - 1 - tail] ===
			rightLines[rightLines.length - 1 - tail]
	) {
		tail += 1
	}

	return [
		...leftLines.slice(0, head).map((text) => same(text)),
		...leftLines
			.slice(head, leftLines.length - tail)
			.map((text): DiffLine => ({ kind: "left", text })),
		...rightLines
			.slice(head, rightLines.length - tail)
			.map((text): DiffLine => ({ kind: "right", text })),
		...leftLines.slice(leftLines.length - tail).map((text) => same(text)),
	]
}

function same(text: string): DiffLine {
	return { kind: "same", text }
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
			// NOTE: Which row of a table test this is, counting from zero, and
			// null for every test that is not one. The id ends in it already —
			// this is the same fact where a reporter can read it without
			// taking a name apart.
			row: number | null
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
			row: number | null
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
			row: number | null
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
	// NOTE: What one `matches snapshot` did. It is written whether the snapshot
	// held or not, because a runner needs the text of a new one and the span to
	// write it into as much as it needs to know a stored one still matches.
	// `span` is where a recorded value stands or would stand, and `module` says
	// which file's `__snapshots__` a named one belongs to.
	| {
			schema: 1
			kind: "snapshot"
			id: string
			module: string | null
			name: string | null
			status: SnapshotStatus
			span: Span | null
			text: string
			recorded: string | null
	  }
	// NOTE: What one property test's run of cases did. It is written whether the
	// property held or not, because "a hundred cases held" is the answer a
	// reader wants as much as the counterexample is — and the seed is on it
	// either way, so a run that passed today can be run again tomorrow.
	//
	// NOTE: `module` and `key` say where a counterexample belongs, exactly as a
	// snapshot event's `module` and `name` do. The key is the test's identity
	// without the Module step, worked out HERE so that no consumer has to spell
	// the escaping a second time and risk spelling it differently.
	| {
			schema: 1
			kind: "property"
			id: string
			name: string
			module: string | null
			key: string
			cases: number
			requested: number
			seed: string
			shrinks: number
			counterexample: Array<PropertyCounterexample> | null
			replayed: number
			stale: Array<number>
			fromCorpus: boolean
			encoded: Array<StoredValue> | null
	  }
	// NOTE: What one benchmark measured. It is written whether the measurement
	// held to its baseline or not, because a runner needs the number of a new
	// one to write down as much as it needs to know an old one still holds —
	// and `module` says which file's `__benchmarks__` the entry belongs to.
	| {
			schema: 1
			kind: "benchmark"
			id: string
			name: string
			module: string | null
			key: string
			nanoseconds: number
			iterations: number
			samples: number
			baseline: number | null
			ratio: number | null
			status: BenchmarkStatus
	  }
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
	// NOTE: That the events which follow were REPLAYED rather than run — one
	// compiled entry whose answer a runner already held, under a name that can
	// only mean the code, the stores and the filters this run has. It carries the
	// entry it stands for and how many tests that entry planned, so a reader is
	// told what was skipped and a summary can count it.
	//
	// NOTE: Written by the COMMAND LINE and never by the runtime. It lives in
	// this union because this union IS the stream's schema, and a consumer that
	// meets it has to read it the way it reads every other kind — which for this
	// one, per the stream's own contract at the top of the union, is to ignore it.
	| { schema: 1; kind: "results-cached"; entry: string; tests: number }
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
// `--filter` needs, and `bench` the fourth — which together are why a consumer
// is told to tolerate what it does not know rather than to switch exhaustively.
export type DeselectionReason = "not-focused" | "tag" | "filter" | "bench"

export type TracedValue = { point: number; span: Span | null; value: string }

// NOTE: What one `§?` line answered — the same three fields a traced value
// carries, named apart because a consumer keeps them apart: a traced value
// explains an assertion that failed, and a probed one answers a question that
// was asked whether or not anything failed.
export type ProbedValue = { point: number; span: Span | null; value: string }

export type ComparisonEvent = {
	// NOTE: `snapshot` is the third: what an `is` compares are two values, and
	// what a snapshot compares are two texts, which a reader wants shown as
	// lines rather than as a structure.
	kind: "is" | "isNot" | "snapshot"
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
	// NOTE: A substring of the test's name, matched against what a reader SEES —
	// the rendered name — and against the template it was written as. An
	// interpolated name has to be rendered before it can be matched, which means
	// evaluating each Module's setup: `selectTests` does that once, and only
	// where a filter was given and some name of the registry interpolates.
	filter?: string | null
	tags?: Array<string>
	skipTags?: Array<string>
	// NOTE: Structural ids. Where any are named, ONLY those run — which is what
	// an Editor's "run this test" asks for, and the one selection a name can not
	// express: two tests may render the same name and never share an id.
	ids?: Array<string>
	// NOTE: Whether the benchmarks of the run are to be MEASURED. Measuring a
	// body takes hundreds of runs of it, which is not what somebody waiting on
	// `essence test` asked for — so a benchmark is deselected as `bench` unless
	// this says otherwise, and it ADDS to a run rather than replacing it: a run
	// that measures still judges everything beside the measurements.
	bench?: boolean
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
	// NOTE: The rendered names, where the caller holds them already — `runTests`
	// works them out for the report and hands them down rather than paying for
	// them twice.
	rendered?: Map<string, string>,
): {
	selections: Array<Selection>
	focused: boolean
	// NOTE: How many tests the FILTER matched, whatever narrowed them
	// afterwards. A run that selected nothing because no test is called that is
	// worth saying out loud, and a run that selected nothing because a tag took
	// them is a different sentence.
	matched: number
} {
	let bench = filters.bench === true
	// NOTE: A focused BENCHMARK narrows nothing while the run is not measuring
	// — it does not run either way, and counting it would silence every test of
	// the project because somebody left a focus on something nobody is running.
	let focused =
		(filters.focusedElsewhere ?? false) ||
		registry.tests.some(
			(test) =>
				test.entry.focused &&
				test.entry.skipped === null &&
				(bench || !test.entry.benchmark),
		)
	let tags = filters.tags ?? []
	let skipTags = filters.skipTags ?? []
	let filter = filters.filter ?? null
	let ids = filters.ids ?? []
	let names =
		filter === null
			? new Map<string, string>()
			: (rendered ?? renderedNames(registry))
	let matches = (entry: TestManifestEntry): boolean =>
		filter === null ||
		entry.name.includes(filter) ||
		(names.get(entry.id) ?? "").includes(filter)

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

		// NOTE: After the ids branch, deliberately: naming a benchmark IS asking
		// for it to be measured, which is what an Editor's "run this one" sends
		// and the one door a measurement has without a flag. Before focus,
		// because a benchmark nobody asked to measure did not run for a reason
		// of its own, and "only with --bench" is what says so.
		if (entry.benchmark && !bench) {
			return { test, state: "deselected", reason: "bench" }
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

		if (!matches(entry)) {
			return { test, state: "deselected", reason: "filter" }
		}

		return { test, state: "run" }
	})

	return {
		selections,
		focused,
		matched:
			filter === null
				? registry.tests.length
				: registry.tests.filter((test) => matches(test.entry)).length,
	}
}

// #endregion

// #region The run

export type RunOptions = {
	sink: EventSink
	filters?: Filters
	// NOTE: Handed in so a spec can run the clock itself. `Date.now` otherwise.
	now?: () => number
	// NOTE: The stored snapshots of every Module in the run, keyed by the
	// Module's canonical path and then by the name written after `from`. Read
	// off disk by whoever started the run; a bundle reads nothing.
	snapshots?: Record<string, SnapshotStore>
	// NOTE: The stored baselines of every Module in the run, keyed by the
	// Module's canonical path and then by the entry a measurement is written
	// under — the same shape `snapshots` takes, read off disk by whoever
	// started the run.
	benchmarks?: Record<string, BenchmarkStore>
	// NOTE: The clock every measurement of the run is read off. Handed in so a
	// spec can measure a body without measuring the machine; `performance.now`
	// otherwise.
	clock?: () => number
	// NOTE: The stored counterexamples of every Module in the run, keyed the
	// same way the snapshots beside them are: the Module's canonical path, and
	// then the test's identity without that path in it. Read off disk by
	// whoever started the run; a bundle reads nothing. A runner that hands none
	// over simply replays nothing, which is what the Language Server's session
	// does today.
	counterexamples?: Record<string, CorpusStore>
	// NOTE: Whether a snapshot that differs is REPLACED rather than reported —
	// `essence test --update`, and the Editor's "Accept snapshot". A benchmark
	// reads it too: a measurement outside its band is recorded rather than
	// reported, which is how a baseline is moved on purpose.
	update?: boolean
	// NOTE: What every property test of the run draws from, spelled as the
	// hexadecimal a reader types after `--seed`. One is made up where none was
	// handed over, and it is on every `property` event either way, so a failure
	// says how to see it again. Each test folds its own id into it, which is
	// what makes replaying ONE test with a filter draw what the whole run drew.
	seed?: string
	// NOTE: How many cases each property test runs. `DEFAULT_CASES` otherwise.
	cases?: number
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

// NOTE: A seed nobody asked for, as the eight hexadecimal characters `--seed`
// reads back. It is made HERE rather than left empty so that every run of a
// property test is a different run, and so that the one that failed can be run
// again exactly. It is an entropy word rather than `Math.random` so the runtime
// reads the machine through one door.
export function randomSeed(): string {
	return nextWord(createEntropy()).toString(16).padStart(8, "0")
}

export function runTests(registry: Registry, options: RunOptions): RunSummary {
	let now = options.now ?? (() => Date.now())
	let sink = options.sink

	if (options.seed === undefined) {
		options = { ...options, seed: randomSeed() }
	}

	// NOTE: The rendered names, worked out ONCE per Module by running its
	// section with a context that selects no test. It is what an interpolated
	// name needs — the scope it was written in — and it costs one evaluation of
	// the setup rather than one per test. Before the selection, because a
	// `--filter` matches what a reader sees.
	let names = renderedNames(registry)
	let { selections, focused } = selectTests(registry, options.filters, names)
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
				row: entry.row,
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
				row: entry.row,
			})

			continue
		}

		runOne(selection.test, name, sink, now, summary, options)
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
	options: RunOptions,
): void {
	let entry = test.entry
	let spans = test.module.spans
	let seed = options.seed ?? ""
	let context = createContext(test.index, {
		stored: (options.snapshots ?? {})[test.module.module ?? ""] ?? {},
		benchmarks: (options.benchmarks ?? {})[test.module.module ?? ""] ?? {},
		clock: options.clock,
		updating: options.update ?? false,
		row: entry.row,
		key: entry.key,
		// NOTE: A coverage run counts, and a counted body must not be timed —
		// see `TestContext.measure`.
		measure: options.coverage !== true,
		property: {
			seed,
			// NOTE: The run's seed folded together with the test's own id. Two
			// property tests of one run therefore draw two unrelated sequences,
			// and running either of them ALONE draws exactly what the whole run
			// drew for it — which is what makes the replay a report prints work
			// with the filter beside it.
			word: seedOf(`${seed}/${entry.id}`),
			cases: options.cases ?? DEFAULT_CASES,
			replays:
				((options.counterexamples ?? {})[test.module.module ?? ""] ??
					{})[entry.key] ?? [],
		},
	})

	sink({
		schema: 1,
		kind: "test-start",
		id: entry.id,
		name,
		suitePath: pathOf(entry),
		module: test.module.module,
		row: entry.row,
	})

	let started = now()
	let error: string | null = null

	try {
		withOutputSink(
			(text, stream) => {
				if (context.recording) {
					context.output.push({ stream, text })
				}
			},
			() => test.module.run(context),
		)
	} catch (thrown) {
		// NOTE: A failed `require` unwinds the test on purpose and is not an
		// error — what it recorded is on the context already, and the report is
		// about the assertion rather than about the way the test ended.
		if (thrown !== requirementFailed) {
			// NOTE: A GenerationFailure is the one thrown value the test
			// runtime raises ON PURPOSE, and its message is already written for
			// a reader — everything under it is frames inside a staged bundle
			// and the paths of the machinery that staged it, which is noise in
			// a report a person reads and a CI log keeps. Anything else that
			// throws is a bug in a Program or in the Compiler, where the frames
			// are the evidence.
			error =
				thrown instanceof GenerationFailure
					? thrown.message
					: thrown instanceof Error
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

	// NOTE: Before the assertions, because what a property test's assertions say
	// is about ONE case — the smallest one that failed — and a reader has to be
	// told that before being shown it.
	if (context.propertyResult !== null) {
		sink({
			schema: 1,
			kind: "property",
			id: entry.id,
			name,
			module: test.module.module,
			key: entry.key,
			cases: context.propertyResult.cases,
			requested: context.propertyResult.requested,
			seed: context.propertyResult.seed,
			shrinks: context.propertyResult.shrinks,
			counterexample: context.propertyResult.counterexample,
			replayed: context.propertyResult.replayed,
			stale: context.propertyResult.stale,
			fromCorpus: context.propertyResult.fromCorpus,
			encoded: context.propertyResult.encoded,
		})
	}

	// NOTE: Beside the property event and for the same reason: what a benchmark
	// says is about the whole of the test, and the assertions below it are what
	// the ONE reported run left behind rather than what was measured.
	if (context.benchmarkResult !== null) {
		let measured = context.benchmarkResult

		sink({
			schema: 1,
			kind: "benchmark",
			id: entry.id,
			name,
			module: test.module.module,
			key: measured.key,
			nanoseconds: measured.nanoseconds,
			iterations: measured.iterations,
			samples: measured.samples,
			baseline: measured.baseline,
			ratio: measured.ratio,
			status: measured.status,
		})
	}

	// NOTE: Before the assertions, because a snapshot event carries what has to
	// be WRITTEN and a reader of the stream acts on it whether the test passed
	// or not.
	for (let recorded of context.snapshots) {
		sink({
			schema: 1,
			kind: "snapshot",
			id: entry.id,
			module: test.module.module,
			name: recorded.name,
			status: recorded.status,
			span: spans[recorded.slot] ?? null,
			text: recorded.text,
			recorded: recorded.recorded,
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

	// NOTE: A measurement outside its band is a FAILED test and not a note
	// beside a passing one. A benchmark says what a body is allowed to cost,
	// the way an assertion says what it is allowed to answer — and the run that
	// silently reported "slower, but passing" is the run nobody reads.
	let regressed = context.benchmarkResult?.status === "regressed"

	if (failures.length === 0 && error === null && !regressed) {
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

	// NOTE: A regression failed no assertion and threw nothing, so without
	// this the failure event would carry an empty `failures` and a null
	// `error` — and a consumer of the stream, which the contract tells to
	// ignore the `benchmark` kind it may not know, would see a failure with no
	// stated reason. The sentence is rendered here for the same reason every
	// failure is: so a JSON consumer and a terminal reporter are shown the
	// same thing. The terminal writes its own richer block off the `benchmark`
	// event and skips this one.
	if (regressed && error === null && context.benchmarkResult !== null) {
		let measured = context.benchmarkResult

		error = `${(measured.ratio ?? 0).toFixed(1)}× slower than its baseline (${
			measured.nanoseconds
		} ns, was ${measured.baseline} ns) — if the new time is right, record it: essence test --bench --update`
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
	// NOTE: A snapshot failure has no traced values and no structure — two
	// texts, and the lines that differ between them.
	if (expectation.snapshot !== null) {
		let snapshot = expectation.snapshot

		return {
			form: expectation.form,
			span: spans[expectation.point] ?? null,
			values: [],
			comparison: {
				kind: "snapshot",
				left: snapshot.expected,
				right: snapshot.actual,
				diff: lineDiff(snapshot.expected ?? "", snapshot.actual),
			},
		}
	}

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
