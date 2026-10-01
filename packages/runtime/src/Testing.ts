import {
	decode,
	encode,
	type EncodedValue,
	type Generator,
	GenerationFailure,
	generate,
	mutate,
	shrink,
} from "./Generators"
import { anyIs } from "./internalHelpers"
import { materialise } from "./List"
import {
	type RandomnessType,
	below,
	createRandomness,
	entropy,
	fraction,
	hasDrawnEntropy,
	nextWord,
	seedOf,
} from "./Randomness"
import { caseText, kindOf } from "./registry"
import type { StringType } from "./String"
import {
	getStringRepresentation,
	hasReadHostInput,
	type OutputStream,
	withInputSource,
	withOutputSink,
} from "./Terminal"
import { type AnyType, typeKeySymbol } from "./type"

// The test runtime, which the Compiler calls for a `tests { … }` section and
// nothing else. See "The test runtime" in DEVELOPMENT.md.

// #region The manifest a Module registers

// The Compiler's Position, spelled here since the runtime does not depend on
// `@essence-lang/interfaces`. Lines and columns are 1-based.
export type Cursor = { line: number; column: number }
export type Range = { start: Cursor; end: Cursor }

// An instrumented point and its source text, so a reader can name what was
// recorded without the file. Emitted once per Module, indexed by point id.
export type Span = Range & { source: string }

// What the runner can read of a test without running it. `id` is the
// structural identity, and `name` the template. A rendered name arrives in
// `TestContext.names`.
export type TestManifestEntry = {
	id: string
	name: string
	// Whether the name has a hole, so the Module must run to render it. The
	// Compiler records it, since a plain name may hold a brace.
	interpolated: boolean
	// The row of a table test, or null for a test that runs once.
	row: number | null
	suitePath: Array<string>
	tags: Array<string>
	focused: boolean
	skipped: string | null
	// A benchmark runs only under `bench` or when named, since it runs its
	// body hundreds of times.
	benchmark: boolean
	// A synthesized contract goal's case budget, and null for a written test.
	// An explicit `--cases` wins.
	cases: number | null
	// The identity without the Module path, which keys what is stored beside
	// the file. The Compiler spells it.
	key: string
	position: Range
	keywordPosition: Range
}

// Where a test is reported. A table test's rows group under its template, as
// under a suite.
export function pathOf(entry: TestManifestEntry): Array<string> {
	return entry.row === null
		? entry.suitePath
		: [...entry.suitePath, entry.name]
}

// One Module's tests. `run` runs the setup a test can see and then the test
// its context names. See "Running a test without waiting" in DEVELOPMENT.md.
export type TestModule = {
	module: string | null
	spans: Array<Span>
	tests: Array<TestManifestEntry>
	run: (context: TestContext) => Ran
}

// A promise where a body completes something, and `undefined` otherwise. See
// "Running a test without waiting" in DEVELOPMENT.md.
export type Ran = void | Promise<void>

// Per bundle, filled as each Module is evaluated. See "The test runtime" in
// DEVELOPMENT.md.
const registered: Array<TestModule> = []

export function register(module: TestModule): TestModule {
	registered.push(module)

	return module
}

export type RegisteredTest = {
	module: TestModule
	entry: TestManifestEntry
	// Which `entry` call inside `module.run` this is.
	index: number
}

export type Registry = {
	modules: Array<TestModule>
	tests: Array<RegisteredTest>
	// By structural id. The last of two tests sharing an id wins rather than
	// throwing.
	byId: Map<string, RegisteredTest>
}

// Everything registered so far, asked after the bundle has loaded.
export function registry(): Registry {
	return registryOf(registered)
}

// The same index over Modules a caller holds.
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

// What one counter counts: the Compiler's `CoveragePoint`, spelled here.
export type CoveragePoint = {
	kind: "statement" | "branch" | "case" | "construction"
	label: string
	scope: string
	position: Range
	refinement: boolean
	tag: string | null
}

// A Choice's declared Cases, so a report can name the ones nothing built.
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

// Counts a point, and answers the value it is handed.
export type CoverageCounter = {
	(point: number): void
	<Value extends AnyType>(point: number, value: Value): Value
}

type CoverageRecord = {
	module: CoverageModule
	counts: Array<number>
	// The counts loading left, which each later run resets to. See "Counting
	// coverage" in DEVELOPMENT.md.
	baseline: Array<number> | null
	// The span each point was last touched in.
	marks: Array<number>
}

// Per bundle, as the test registry is.
const covered: Array<CoverageRecord> = []

// The current span, one test long, and the points first touched in it. See
// "Counting coverage" in DEVELOPMENT.md.
let epoch = 0
let touched: Array<{ record: CoverageRecord; point: number }> = []

export function beginCoverageSpan(): void {
	epoch += 1
	touched.length = 0
}

export function touchedGround(): number {
	return touched.length
}

// The span's touches, which a reader never changes.
function coverageTouches(): Array<{ record: CoverageRecord; point: number }> {
	return touched
}

// Called as each instrumented Module is evaluated, answering a closure over
// its own counts.
export function counters(module: CoverageModule): CoverageCounter {
	let counts = module.points.map(() => 0)
	let marks = module.points.map(() => 0)
	let record: CoverageRecord = { module, counts, baseline: null, marks }

	covered.push(record)

	return ((point: number, value?: AnyType) => {
		// The first touch in this span.
		if (marks[point] !== epoch) {
			marks[point] = epoch
			touched.push({ record, point })
		}

		counts[point] = (counts[point] ?? 0) + 1

		return value
	}) as CoverageCounter
}

// What a run counted, per Module, at any moment of the run.
export type CoveredPoint = CoveragePoint & { count: number }

export type CoverageReport = {
	module: string | null
	points: Array<CoveredPoint>
	choices: Array<CoverageChoice>
	// The points that ran while the Module loaded, which no test's span holds.
	loaded: Array<number>
}

export function coverage(): Array<CoverageReport> {
	return covered.map((record) => ({
		module: record.module.module,
		points: record.module.points.map((point, index) => ({
			...point,
			count: record.counts[index] ?? 0,
		})),
		choices: record.module.choices,
		// A point counted in the baseline ran at load.
		loaded:
			record.baseline === null
				? []
				: record.baseline.flatMap((count, index) =>
						count > 0 ? [index] : [],
					),
	}))
}

// The first call records the baseline, and every later call resets to it.
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

// One recorded value: the point it was recorded at, and what stood there.
export type Trace = { point: number; value: AnyType }

// What an `expect` or `require` recorded: whether it held, the values traced
// on the way, and the operands of an `is` to diff.
export type Expectation = {
	form: "expect" | "require"
	point: number
	passed: boolean
	traces: Array<Trace>
	comparison: RecordedComparison | null
	// A snapshot assertion's two texts, and null for any other assertion.
	snapshot: SnapshotComparison | null
}

export type SnapshotComparison = {
	name: string | null
	expected: string | null
	actual: string
}

// The operands of an assertion's top-level `is` or `isNot`, named by the
// points the Compiler traced them at.
export type Comparison = { kind: "is" | "isNot"; left: number; right: number }

export type RecordedComparison = {
	kind: "is" | "isNot"
	left: AnyType | undefined
	right: AnyType | undefined
}

export type OutputChunk = { stream: OutputStream; text: string }

// One Module's stored snapshots, by name. See "What a test keeps beside its
// file" in DEVELOPMENT.md.
export type SnapshotStore = Record<string, string>

// A stored value, under its Parameter's name rather than its position.
export type StoredValue = { name: string; data: EncodedValue }

export type StoredCounterexample = { values: Array<StoredValue> }

// One Module's stored counterexamples, by test key.
export type CorpusStore = Record<string, Array<StoredCounterexample>>

// What `matches snapshot` compares against. `slot` is the point a recorded
// value is written back into.
export type SnapshotSlot = {
	name: string | null
	recorded: string | null
	slot: number
}

// `written` passes, and the runner must write the snapshot down.
export type SnapshotStatus = "written" | "matched" | "mismatched"

export type RecordedSnapshot = {
	point: number
	slot: number
	name: string | null
	status: SnapshotStatus
	text: string
	recorded: string | null
}

// One Module's stored benchmark baselines, by test key.
export type BenchmarkStore = Record<string, number>

// `regressed` fails. `written` and `improved` pass.
export type BenchmarkStatus = "written" | "matched" | "regressed" | "improved"

// One measurement. `nanoseconds` is one run of the body in the median batch,
// rounded so it prints the same each time.
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
	// The `entry` to run. `-1` runs none, which renders the names.
	index: number
	// The rendered interpolated names, by entry index.
	names: Map<number, string>
	// The traces since the last assertion took them.
	traces: Array<Trace>
	// What the `§?` value comments recorded, kept for the whole test.
	probes: Array<Trace>
	expectations: Array<Expectation>
	// Every snapshot assertion, held or not, since a run may write one down.
	snapshots: Array<RecordedSnapshot>
	// The stores, and whether a mismatch replaces rather than fails. See
	// "What a test keeps beside its file" in DEVELOPMENT.md.
	stored: SnapshotStore
	benchStored: BenchmarkStore
	updating: boolean
	row: number | null
	key: string
	// A coverage run does not measure, since its counters slow the body. The
	// body still runs once.
	measure: boolean
	// Off during measured batches, so the clock times the body alone. A failed
	// `require` still ends the run.
	recording: boolean
	// The run's seed, and `word`, the seed folded with the test's id. A test
	// replayed alone draws what the whole run drew for it.
	property: PropertySettings
	// What this context's property test did, or null.
	propertyResult: PropertyResult | null
	// What this context's benchmark measured, or null.
	benchmarkResult: BenchmarkResult | null
	// The clock in milliseconds, on the context so that a spec can drive it.
	clock: () => number
	output: Array<OutputChunk>
	// The bundle's coverage so far, the same for every context.
	coverage: () => Array<CoverageReport>
}

// `replays` are this test's stored counterexamples, run first. One that
// still fails ends the test before any case is drawn.
export type PropertySettings = {
	seed: string
	word: number
	cases: number
	replays: Array<StoredCounterexample>
}

export type PropertyCounterexample = { name: string; value: string }

export type PropertyResult = {
	// How many cases ran.
	cases: number
	// How many cases were asked for. Sizes grow over the whole run, so a replay
	// needs this as well as the seed.
	requested: number
	seed: string
	shrinks: number
	counterexample: Array<PropertyCounterexample> | null
	// Counted apart from `cases`, since a replay draws nothing.
	replayed: number
	// The stored entries that no longer decode, which the runner drops.
	stale: Array<number>
	// Whether the failure came from a replay rather than a draw.
	fromCorpus: boolean
	// The shrunk counterexample, encoded to store, or null where a Parameter
	// can not be written down.
	encoded: Array<StoredValue> | null
}

// The cases a property runs where nobody said.
export const DEFAULT_CASES = 100

// `performance.now`, or `Date.now` on a host without it.
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

// One suite's Scope over the tests `first` up to `last`. A Scope that holds no
// part of the run is stepped over, so a test runs only the setup it can see.
// The enumeration pass, `-1`, enters every Scope to render every name.
export function scope(
	context: TestContext,
	first: number,
	last: number,
	run: () => Ran,
): Ran {
	if (
		context.index === -1 ||
		(context.index >= first && context.index < last)
	) {
		return run()
	}
}

// One test, where it was written. Only an interpolated name is handed over.
export function entry(
	context: TestContext,
	index: number,
	name: StringType | null,
	run: () => Ran,
): Ran {
	if (name !== null) {
		context.names.set(index, name.value)
	}

	if (context.index === index) {
		return run()
	}
}

// One table test's rows. A row's name is rendered when it is enumerated or run,
// and only the selected row runs.
export function rows<Value extends AnyType>(
	context: TestContext,
	first: number,
	values: Array<Value>,
	name: ((row: Value) => StringType) | null,
	run: (row: Value) => Ran,
): Ran {
	// At most one row runs, so there is at most one answer.
	let answered: Ran = undefined

	values.forEach((value, offset) => {
		let index = first + offset

		// The enumeration pass renders every name.
		if (context.index !== index && context.index !== -1) {
			return
		}

		if (name !== null) {
			context.names.set(index, name(value).value)
		}

		if (context.index === index) {
			answered = run(value)
		}
	})

	return answered
}

// One benchmark: `entry` with the measuring driver around the body.
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

// One property test, its body run once per generated case. See "Running a
// property test" in DEVELOPMENT.md.
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

// The buffer lengths a case that held is cut back to.
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

// How many candidates a shrink may try, which bounds a slow body.
const SHRINK_ATTEMPTS = 400

// The coverage-guided search. See "Running a property test" in
// DEVELOPMENT.md.
//
// How many cases are kept. A small pool follows where coverage went rather
// than mutating whatever was found first.
const GUIDED_POOL = 8
// The share of cases after the warm-up that step to a neighbour.
const GUIDED_SHARE = 0.5
// The share of the run drawn blind first, and at least one case.
const GUIDED_WARMUP = 0.25

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
	// The cases that reached new points, newest last. Empty for an
	// uninstrumented bundle.
	let pool: Array<Array<AnyType>> = []
	let warmup = Math.max(1, Math.floor(settings.cases * GUIDED_WARMUP))
	// Runs one case, and keeps it when it reached new points. Replays count
	// too, since a stored counterexample's neighbourhood is worth searching.
	let asked = (values: Array<AnyType>): boolean => {
		let reached = touchedGround()
		let outcome = holds(context, mark, run, values)

		if (touchedGround() > reached) {
			pool.push(values)

			if (pool.length > GUIDED_POOL) {
				pool.shift()
			}
		}

		return outcome
	}

	// The stored counterexamples first, in their stored order.
	for (let [index, replay] of settings.replays.entries()) {
		let values = decodeReplay(parameters, replay)

		// A stale entry is reported, since the runner writes the file.
		if (values === null) {
			stale.push(index)

			continue
		}

		replayed += 1

		if (!asked(values)) {
			failing = values
			fromCorpus = true

			break
		}
	}

	// Drawn only when every stored case held.
	for (let index = 0; failing === null && index < settings.cases; index++) {
		// The size grows with the case number, so an early failure is nearly
		// minimal already.
		let size =
			1 + Math.floor((index * 48) / Math.max(settings.cases - 1, 1))
		let values: Array<AnyType>

		try {
			// The coin is drawn only where the pool could serve, so an
			// unguided run draws what a blind search draws.
			values =
				index >= warmup &&
				pool.length > 0 &&
				fraction(source) < GUIDED_SHARE
					? neighbourOf(parameters, pool, source, size)
					: parameters.map((parameter) =>
							generate(parameter.generator, source, size),
						)
		} catch (thrown) {
			// A refinement nothing satisfies. The result is recorded first, so
			// the report still counts the cases that held.
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

		if (!asked(values)) {
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

	// A replayed failure is shrunk too, since the code may now fail on
	// something smaller.
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

	// The report is built from this last, unguarded run, so a throw or a
	// failed `require` ends the test as in any other.
	rewind(context, mark)
	run(...shrunk.values)
}

// A kept case with one Parameter moved to a neighbouring value, and the rest
// shared.
function neighbourOf(
	parameters: Array<PropertyParameter>,
	pool: Array<Array<AnyType>>,
	source: RandomnessType,
	size: number,
): Array<AnyType> {
	let values = [...(pool[below(source, pool.length)] ?? [])]
	let index = below(source, parameters.length)
	let parameter = parameters[index]
	let held = values[index]

	// A property without Parameters has no neighbour.
	if (parameter === undefined || held === undefined) {
		return values
	}

	values[index] = mutate(parameter.generator, held, source, size)

	return values
}

// A stored counterexample as values, matched by name. Any Parameter added,
// removed or renamed makes it stale.
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

// The whole case written down, or nothing when one Parameter can not be.
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

// One case, rewound first. It fails when an assertion failed or it threw,
// including a failed `require`.
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

		// A generation failure means no question was asked.
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

// The smallest failing case it can reach, one Parameter at a time. After each
// candidate that still fails it starts over, so a shrunk List's items shrink too.
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

// How a measurement is taken. See "Measuring a benchmark" in DEVELOPMENT.md.
const BENCHMARK_SAMPLES = 7
const BENCHMARK_BATCH_MILLISECONDS = 5
const BENCHMARK_MAX_ITERATIONS = 65536
const BENCHMARK_STEADY_BATCH_MILLISECONDS = 200
const BENCHMARK_SLOW_BATCH_MILLISECONDS = 1000
// The band a measurement may move in before it is reported.
const REGRESSION_RATIO = 1.25
const IMPROVEMENT_RATIO = 0.8

function runBenchmark(context: TestContext, run: () => void): void {
	// A coverage run takes the body once, unmeasured.
	if (!context.measure) {
		run()

		return
	}

	let mark = markOf(context)

	// A body that does not hold is reported, not timed. Its last run is
	// unguarded, as in `runProperty`.
	if (!holds(context, mark, run, [])) {
		rewind(context, mark)
		run()

		return
	}

	let iterations = 1
	let elapsed: number
	let perRun: Array<number> = []
	let samples: number

	// Nothing is recorded while the clock runs, whatever the body does.
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

		// Fewer samples for a slower body, whose batches barely jitter.
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

	// At least one nanosecond, since no later run can be held to zero.
	let nanoseconds = Math.max(1, Math.round(median(perRun) * 1_000_000))
	// A table row's key already ends with its row.
	let storedKey = context.key
	let stored = context.benchStored[storedKey]
	// A stored zero can only be a damaged file, so it is recorded again.
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

	// The unguarded run the report is built from.
	rewind(context, mark)
	run()
}

// One batch, timed, with the context rewound before the clock starts.
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

// The lower middle of the samples, which for an odd count is the middle.
function median(values: Array<number>): number {
	let sorted = [...values].sort((left, right) => left - right)

	return sorted[(sorted.length - 1) >> 1] ?? 0
}

// THE trace mechanism — record a value at an instrumented point,
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

// The `§?` value comment — the same recording as a trace, into the buffer
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

// `expect` — record and carry on, so one test can report several failures
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

// What a failed `require` unwinds with. It is thrown rather than
// returned, because "ends the test" has to hold WHEREVER the assertion was
// written: a `match` used as an Expression is emitted as a call to an arrow
// Function, and an early `return` inside one of its Handlers would end that
// arrow and leave the test running on with a value it never computed. A throw
// leaves no shape of the lowering able to swallow it. It is a private object
// rather than an Error so that `runOne` can tell "the test ended itself" from
// "the test threw", and no stack is built for something nobody reads.
const requirementFailed = { requirementFailed: true }

// `require` — the same recording as an `expect`, and then a failure ends
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

// `matches snapshot`. What it is handed is the value already RENDERED —
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

// The entry a stored snapshot is kept under. A row of a table test gets
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

// The LAST value traced at a point, because a point inside a loop — which
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

// One line of a rendered difference. `same` is context, `left` is what
// the receiver held and `right` what it was compared against — the reporter
// decides how to mark them, because a terminal, an editor hover and a JSON
// consumer each want something different.
export type DiffLine = { kind: "same" | "left" | "right"; text: string }

// What `Equatable::is` compared, written out as a difference rather than
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
	// What follows the value — the comma of the member it stands for, or
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

	// A kind neither arm above names may still have said how it is taken
	// apart — the registry in `registry.ts` is where a container's own module
	// leaves that, and probing it here rather than writing an arm is what keeps
	// a container's difference in the container's module. A Dictionary is one
	// such kind: it is walked BY ITS KEYS, which is what it is read by — so a
	// difference shows the one entry that moved surrounded by the ones that did
	// not, and an entry only one side holds arrives on a line of its own.
	if (sameTag(left, right)) {
		let kind = kindOf(String(left[typeKeySymbol]))

		if (kind !== undefined) {
			return diffEntries(
				kind.parts(left, render),
				kind.parts(right, render),
				indent,
				`${label}${kind.open}`,
				`${kind.close}${suffix}`,
			)
		}
	}

	if (isCase(left) && isCase(right) && sameTag(left, right)) {
		// The rendered text rather than the tag — `Door#Open`, not the
		// Module the tag also carries. A failure report is read by a person, and
		// `caseText` in `registry.ts` says why a path is no part of what they
		// need; the two sides are already known to carry the SAME tag here, so
		// nothing is being told apart by what is cut off.
		let tag = caseText(String(left[typeKeySymbol]))

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

// Keys in the LEFT's order, then whatever only the right side has — so a
// difference reads down the value the test computed, and a member that was
// never there arrives at the end rather than in a place it never had.
function diffEntries(
	left: Array<[string, AnyType]>,
	right: Array<[string, AnyType]>,
	indent: string,
	open: string,
	close: string,
	// Whether an entry is written under its key. A Record's members are;
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

// What a snapshot's difference reads as: the lines the two texts share,
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

// A List holds its items in two runs with a view into each, so what is
// diffed is the LOGICAL items rather than whatever the backing Array holds —
// the same reading `Terminal.inspect` does.
function listEntries(value: AnyType): Array<[string, AnyType]> {
	return materialise(value as never).map(
		(item, index) => [String(index), item] as [string, AnyType],
	)
}

// #endregion

// #region Events

// ONE stream, newline-delimited JSON, every event carrying `schema` and
// `kind`. A consumer that meets a kind it does not know must ignore it, so that
// a kind added to this list changes nothing that reads the stream.
export type TestEvent =
	| { schema: 1; kind: "run-start"; tests: number; focused: boolean }
	| {
			schema: 1
			kind: "test-start"
			id: string
			name: string
			suitePath: Array<string>
			module: string | null
			// Which row of a table test this is, counting from zero, and
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
			// A test body that threw, rendered. It is a Compiler or a
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
	// `suitePath` and `module` on a test that never started, for the same
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
	// What a `§?` value comment recorded. It is not a failure and not an
	// assertion — it is the answer to a question a reader wrote into the source,
	// which an Editor draws beside the line and a `--json` consumer may ignore.
	| ({ schema: 1; kind: "probe"; id: string } & ProbedValue)
	// What one `matches snapshot` did. It is written whether the snapshot
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
	// What one property test's run of cases did. It is written whether the
	// property held or not, because "a hundred cases held" is the answer a
	// reader wants as much as the counterexample is — and the seed is on it
	// either way, so a run that passed today can be run again tomorrow.
	//
	// `module` and `key` say where a counterexample belongs, exactly as a
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
	// What one benchmark measured. It is written whether the measurement
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
	// What one Module's counters counted, written once per instrumented
	// Module at the end of a run. Only a run that ASKED for coverage carries
	// these; every other stream has none, which is what "a consumer ignores
	// what it does not know" is for.
	| {
			schema: 1
			kind: "coverage"
			module: string | null
			points: Array<CoveredPoint>
			choices: Array<CoverageChoice>
			// The indices of points executed at LOAD, credited to no test
			// — see `CoverageReport.loaded`. Optional so a stream written before
			// it existed, or a report built by hand, still reads: absent means
			// "not told", which a consumer treats as none.
			loaded?: Array<number>
	  }
	// The points ONE test touched in one instrumented Module, by index
	// into that Module's coverage table — written per test, and only where the
	// run asked to attribute. The inverse of the affected-set map: a consumer
	// folding these knows, for every point, which tests cover it.
	| {
			schema: 1
			kind: "test-coverage"
			id: string
			module: string | null
			points: Array<number>
	  }
	// That the events which follow were REPLAYED rather than run — one
	// compiled entry whose answer a runner already held, under a name that can
	// only mean the code, the stores and the filters this run has. It carries the
	// entry it stands for and how many tests that entry planned, so a reader is
	// told what was skipped and a summary can count it.
	//
	// Written by the COMMAND LINE and never by the runtime. It lives in
	// this union because this union IS the stream's schema, and a consumer that
	// meets it has to read it the way it reads every other kind — which for this
	// one, per the stream's own contract at the top of the union, is to ignore it.
	| { schema: 1; kind: "results-cached"; entry: string; tests: number }
	// What ONE deliberate lie about the code did — the site it was told
	// at, the sentence the Compiler's own walker spells for it, and whether any
	// test noticed. `killedBy` is the id of the first test that failed, null for
	// every other status; `tests` is how many tests reach the site at all, which
	// is what makes a survivor readable: a mutant no test covers and a mutant
	// twelve tests miss are different findings.
	//
	// The five statuses, and the line each of them draws. `killed` is a
	// test that failed — and a mutant that CRASHED, whether it would not load or
	// threw as it ran, because a program that comes apart is a program the world
	// notices. `hung` is a mutant whose run never came back and was stopped,
	// which is a failure a reader would see too. `survived` is the finding.
	// `uncovered` is a site no test reaches. `invalid` means one thing only: the
	// mutant DID NOT COMPILE, which is the walker's own shortfall rather than
	// anything the tests did or did not do.
	//
	// Written by the COMMAND LINE and never by the runtime, exactly as
	// `results-cached` is, and here for exactly the same reason — this union IS
	// the stream's schema, and a consumer that meets one of these reads it the
	// way it reads every other kind it does not know, which is to ignore it.
	| {
			schema: 1
			kind: "mutant"
			module: string | null
			position: Range
			operator: string
			description: string
			status: "killed" | "survived" | "uncovered" | "invalid" | "hung"
			killedBy: string | null
			tests: number
	  }
	// The tally of a mutation run, written once where a `run-end` would
	// stand. `sites` counts every mutant the walker found, whatever became of
	// it, so the five statuses below it add up to it — and where a
	// `--mutation-limit` stopped the judging early, the remainder a consumer
	// derives from them is what the limit left unjudged.
	| {
			schema: 1
			kind: "mutation-end"
			sites: number
			killed: number
			survived: number
			uncovered: number
			invalid: number
			hung: number
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

// `not-focused` and `tag` are the spec's two; `filter` is the third a
// `--filter` needs, and `bench` the fourth — which together are why a consumer
// is told to tolerate what it does not know rather than to switch exhaustively.
export type DeselectionReason = "not-focused" | "tag" | "filter" | "bench"

export type TracedValue = { point: number; span: Span | null; value: string }

// What one `§?` line answered — the same three fields a traced value
// carries, named apart because a consumer keeps them apart: a traced value
// explains an assertion that failed, and a probed one answers a question that
// was asked whether or not anything failed.
export type ProbedValue = { point: number; span: Span | null; value: string }

export type ComparisonEvent = {
	// `snapshot` is the third: what an `is` compares are two values, and
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
	// A substring of the test's suites and name joined by `/`, the name as
	// rendered and as written, or the whole `key` a stored baseline is headed
	// with. Rendering an interpolated name evaluates its Module's setup, which
	// `selectTests` does once, and only under a filter.
	filter?: string | null
	tags?: Array<string>
	skipTags?: Array<string>
	// Structural ids. Where any are named, ONLY those run — which is what
	// an Editor's "run this test" asks for, and the one selection a name can not
	// express: two tests may render the same name and never share an id.
	ids?: Array<string>
	// Whether the benchmarks of the run are to be MEASURED. Measuring a
	// body takes hundreds of runs of it, which is not what somebody waiting on
	// `essence test` asked for — so a benchmark is deselected as `bench` unless
	// this says otherwise, and it ADDS to a run rather than replacing it: a run
	// that measures still judges everything beside the measurements.
	bench?: boolean
	// Whether a registry BESIDE this one holds a focused test. Focus is
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

// What runs, what is reported skipped, and what was deselected and by
// what — one answer, so that the command line, the Language Server's session
// and any other runner all select the same way. `focused` says whether the
// registry holds a focused test at all, which is what a plain run exits
// non-zero about.
// Asynchronous for one reason: a `--filter` matches what a READER sees,
// which for an interpolated name means rendering it, which means evaluating the
// Module's setup — and a setup that completes something can only be evaluated
// by waiting for it. A caller that holds the rendered names already, or that
// passes no filter, waits for nothing.
export async function selectTests(
	registry: Registry,
	filters: Filters = {},
	// The rendered names, where the caller holds them already — `runTests`
	// works them out for the report and hands them down rather than paying for
	// them twice.
	rendered?: Map<string, string>,
): Promise<{
	selections: Array<Selection>
	focused: boolean
	// How many tests the FILTER matched, whatever narrowed them
	// afterwards. A run that selected nothing because no test is called that is
	// worth saying out loud, and a run that selected nothing because a tag took
	// them is a different sentence.
	matched: number
}> {
	let bench = filters.bench === true
	// A focused BENCHMARK narrows nothing while the run is not measuring
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
			: (rendered ?? (await renderedNames(registry)))
	// The key is compared whole because a table's rows differ only in its
	// last step, and row 1's key is the start of row 10's.
	let matches = (entry: TestManifestEntry): boolean =>
		filter === null ||
		entry.key === filter ||
		[entry.name, names.get(entry.id)].some(
			(name) =>
				name !== undefined &&
				[...entry.suitePath, name].join("/").includes(filter),
		)

	let selections = registry.tests.map((test): Selection => {
		let entry = test.entry

		if (entry.skipped !== null) {
			return { test, state: "skip", reason: entry.skipped }
		}

		// Before focus, deliberately. Naming a test IS the narrowing, and
		// a run somebody asked for by id is not the run a leftover `focused`
		// was meant to narrow.
		if (ids.length > 0) {
			return ids.includes(entry.id)
				? { test, state: "run" }
				: { test, state: "deselected", reason: "filter" }
		}

		// After the ids branch, deliberately: naming a benchmark IS asking
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

		// `--skip-tag` wins over `--tag`, per the spec: a tag a run is
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
	// Handed in so a spec can run the clock itself. `Date.now` otherwise.
	now?: () => number
	// The stored snapshots of every Module in the run, keyed by the
	// Module's canonical path and then by the name written after `from`. Read
	// off disk by whoever started the run; a bundle reads nothing.
	snapshots?: Record<string, SnapshotStore>
	// The stored baselines of every Module in the run, keyed by the
	// Module's canonical path and then by the entry a measurement is written
	// under — the same shape `snapshots` takes, read off disk by whoever
	// started the run.
	benchmarks?: Record<string, BenchmarkStore>
	// The clock every measurement of the run is read off. Handed in so a
	// spec can measure a body without measuring the machine; `performance.now`
	// otherwise.
	clock?: () => number
	// The stored counterexamples of every Module in the run, keyed the
	// same way the snapshots beside them are: the Module's canonical path, and
	// then the test's identity without that path in it. Read off disk by
	// whoever started the run; a bundle reads nothing. A runner that hands none
	// over simply replays nothing, which is what the Language Server's session
	// does today.
	counterexamples?: Record<string, CorpusStore>
	// Whether a snapshot that differs is REPLACED rather than reported —
	// `essence test --update`, and the Editor's "Accept snapshot". A benchmark
	// reads it too: a measurement outside its band is recorded rather than
	// reported, which is how a baseline is moved on purpose.
	update?: boolean
	// What every property test of the run draws from, spelled as the
	// hexadecimal a reader types after `--seed`. One is made up where none was
	// handed over, and it is on every `property` event either way, so a failure
	// says how to see it again. Each test folds its own id into it, which is
	// what makes replaying ONE test with a filter draw what the whole run drew.
	seed?: string
	// How many cases each property test runs. `DEFAULT_CASES` otherwise.
	cases?: number
	// Whether to write a `coverage` event per instrumented Module when
	// the run ends, and to put the counts back to what loading the bundle left
	// them at before it starts. A bundle compiled without `--coverage` has no
	// counters at all and the events are empty, so asking costs nothing; a
	// runner that did not ask is not told.
	coverage?: boolean
	// Whether each TEST also says which points IT touched — a
	// `test-coverage` event per instrumented Module the test reached, worked
	// out by diffing the counts around the test's run. It is the inverse of
	// the affected-set map: which tests cover this line. Apart from
	// `coverage` deliberately — this is what a mutation run and an editor's
	// "covered by" ask for, and neither wants the run-end tables; it costs a
	// copy of every counter per test, so nobody pays who did not ask.
	coverageByTest?: boolean
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

// A seed nobody asked for, as the eight hexadecimal characters `--seed`
// reads back. It is made HERE rather than left empty so that every run of a
// property test is a different run, and so that the one that failed can be run
// again exactly. It is an entropy word rather than `Math.random` so the runtime
// reads the machine through one door.
export function randomSeed(): string {
	return nextWord(entropy()).toString(16).padStart(8, "0")
}

// One test at a time, each awaited before the next is started. Nothing
// about a run is concurrent: the output sink, the coverage span and the
// recordings a report is built from are all per test and all dynamically
// scoped, so two tests in flight at once would be two tests writing into one
// set of buffers. What a test may wait for is its OWN work, and the runner
// waits with it.
export async function runTests(
	registry: Registry,
	options: RunOptions,
): Promise<RunSummary> {
	let now = options.now ?? (() => Date.now())
	let sink = options.sink

	if (options.seed === undefined) {
		options = { ...options, seed: randomSeed() }
	}

	// The rendered names, worked out ONCE per Module by running its
	// section with a context that selects no test. It is what an interpolated
	// name needs — the scope it was written in — and it costs one evaluation of
	// the setup rather than one per test. Before the selection, because a
	// `--filter` matches what a reader sees.
	let names = await renderedNames(registry)
	let { selections, focused } = await selectTests(
		registry,
		options.filters,
		names,
	)
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

	// After the enumeration, which evaluates a Module's setup and would
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

		await runOne(selection.test, name, sink, now, summary, options)
	}

	summary.duration = now() - started

	// Before `run-end`, so that a consumer folding the stream has every
	// Module's counts in hand by the time the run is declared over.
	if (options.coverage === true) {
		for (let report of coverage()) {
			sink({
				schema: 1,
				kind: "coverage",
				module: report.module,
				points: report.points,
				choices: report.choices,
				loaded: report.loaded,
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

// One evaluation of every Module's setup with `index: -1`, which runs no
// test and records every interpolated name. A Module whose setup throws gets no
// names and nothing else: the failure surfaces per test, where a reader can see
// which test it stopped.
//
// Only for a Module that HAS an interpolated name — a template with no
// hole in it is what the test will be called, and running a section to be told
// so would make every run pay for the one shape that needs it. Whatever the
// setup writes on the way is dropped: the output a reader is shown belongs to a
// test, and no test is running here. It reads an empty input, as a test does.
async function renderedNames(registry: Registry): Promise<Map<string, string>> {
	let names = new Map<string, string>()

	for (let module of registry.modules) {
		if (!module.tests.some((entry) => entry.interpolated)) {
			continue
		}

		let context = createContext(-1)

		try {
			// Awaited, because a section whose SETUP completes something
			// is `async` whole — the names it renders are written on the
			// context after the wait, and reading them before it would answer
			// with the manifest's templates.
			await withOutputSink(
				(text, stream) => context.output.push({ stream, text }),
				() => withInputSource("", () => module.run(context)),
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

async function runOne(
	test: RegisteredTest,
	name: string,
	sink: EventSink,
	now: () => number,
	summary: RunSummary,
	options: RunOptions,
): Promise<void> {
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
		// A coverage run counts, and a counted body must not be timed —
		// see `TestContext.measure`.
		measure: options.coverage !== true,
		property: {
			seed,
			// The run's seed folded together with the test's own id. Two
			// property tests of one run therefore draw two unrelated sequences,
			// and running either of them ALONE draws exactly what the whole run
			// drew for it — which is what makes the replay a report prints work
			// with the filter beside it.
			word: seedOf(`${seed}/${entry.id}`),
			cases: options.cases ?? entry.cases ?? DEFAULT_CASES,
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

	// The test's own coverage span opens here, unconditionally — it is
	// one increment and a truncation, and it is what makes a guided property's
	// "new ground" a fact about THIS test rather than about whichever tests
	// happened to run before it.
	beginCoverageSpan()

	let started = now()
	let error: string | null = null

	try {
		// Awaited INSIDE the `try`, so that a test which waits reports a
		// failure the same way one that does not does: what a body throws after
		// its first `complete` arrives here as a rejection, and the arm below
		// is what turns either of them into the one error a report carries.
		//
		// The input is empty whatever the host holds, so what a test
		// answers does not depend on it, and a runner's own input, a terminal
		// or an editor's protocol, is never read.
		await withOutputSink(
			(text, stream) => {
				if (context.recording) {
					context.output.push({ stream, text })
				}
			},
			() => withInputSource("", () => test.module.run(context)),
		)
	} catch (thrown) {
		// A failed `require` unwinds the test on purpose and is not an
		// error — what it recorded is on the context already, and the report is
		// about the assertion rather than about the way the test ended.
		if (thrown !== requirementFailed) {
			// A GenerationFailure is the one Error the test runtime
			// raises ON PURPOSE, and its message is already written for
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

	// The points this one test touched, per instrumented Module — read
	// off the span's own list, so the cost is the points actually touched
	// rather than a copy of every counter per test. Written before the verdict
	// events, the way every other fact about the run is; the points are sorted
	// so two runs of one test write one event.
	if (options.coverageByTest === true && touchedGround() > 0) {
		let byRecord = new Map<CoverageRecord, Array<number>>()

		for (let entry of coverageTouches()) {
			let points = byRecord.get(entry.record)

			if (points === undefined) {
				byRecord.set(entry.record, [entry.point])
			} else {
				points.push(entry.point)
			}
		}

		for (let record of covered) {
			let points = byRecord.get(record)

			if (points !== undefined) {
				sink({
					schema: 1,
					kind: "test-coverage",
					id: entry.id,
					module: record.module.module,
					points: points.sort((left, right) => left - right),
				})
			}
		}
	}

	// One event per PROBED POINT rather than per recording, carrying the
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

	// Before the assertions, because what a property test's assertions say
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

	// Beside the property event and for the same reason: what a benchmark
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

	// Before the assertions, because a snapshot event carries what has to
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
		// Only a FAILED assertion has its values rendered. A run that
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

	// A measurement outside its band is a FAILED test and not a note
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

	// A regression failed no assertion and threw nothing, so without
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

// The points a test probed, in the order they were first recorded at —
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

// One recorded assertion, rendered — every value as the text a reader
// sees, every point resolved against the Module's span table, and the two
// operands of an `Equatable` comparison diffed. Rendering happens HERE rather
// than at the sink so that a JSON consumer and a terminal reporter are shown
// the same thing.
function failureOf(expectation: Expectation, spans: Array<Span>): FailureEvent {
	// A snapshot failure has no traced values and no structure — two
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

// What a bundle publishes, under `$tests` on its entry Module — the one
// name a runner looks up, and the reason the runner does not reach for this
// module itself. Every value an Essence Program builds carries a hidden Type
// key that is a `Symbol` of the runtime instance that built it, and a bundle
// inlines its OWN runtime: a diff, a rendering or an equality asked from
// outside would be asking a different runtime about values it has never seen,
// and would read `undefined` off every one of them. So everything that touches
// a value runs in here, and what crosses the boundary is events — plain data,
// already rendered.
//
// An object rather than an export per member, so that adding to the
// contract adds a member rather than a name the Rewriter has to learn.
export const entryPoints = {
	registry,
	// Offered here as well as exported, for a runner that can not import
	// this module at all — the Language Server's session runs a bundle inside a
	// Worker, whose only way to reach anything is the bundle it was handed. It
	// indexes what it is given and reads no value, so unlike everything beside
	// it, it is safe to call from either side of the boundary.
	registryOf,
	run: runTests,
	select: selectTests,
	// What a Module's counters have counted, read from INSIDE the bundle
	// like everything else here. The report is plain data — numbers and the
	// table the Compiler emitted — so it crosses the boundary safely once it
	// has been asked for in here.
	coverage,
	// Whether this bundle read the host's input. Every test reads an
	// empty one, so the reads it reports are a Module's own statements, run as
	// the bundle loaded.
	hasReadHostInput,
	// Whether this bundle drew from the machine's entropy, in a test or
	// as it loaded. A `run` handed no seed draws one here too, so a runner that
	// asks this hands it one.
	hasDrawnEntropy,
}

// #endregion
