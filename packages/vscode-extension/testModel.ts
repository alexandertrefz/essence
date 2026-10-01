// Everything the Test Explorer knows, as plain data. Nothing here imports
// `vscode`, so what an `essence/testRun` batch means is tested without an
// extension host. `testView.js` is the thin half that talks to VS Code.
//
// It is TypeScript so the Types write the protocol down. It does not use the
// compiler's own fold in `@essence-lang/compiler/testing`, which would ship a
// compiler inside the extension. It is the reference client of the protocol.

import path from "node:path"

// The payload version this client understands. The protocol says a
// notification of any other version is ignored.
export const TEST_RUN_VERSION = 3

// #region What arrives on the wire

// Positions are the compiler's: 1-based line and column. Only `testView.js`
// converts them to VS Code's 0-based pair.
export type Cursor = { line: number; column: number }
export type Range = { start: Cursor; end: Cursor }
export type Span = Range & { source: string }

export type TracedValue = { point: number; span: Span | null; value: string }
export type DiffLine = { kind: "same" | "left" | "right"; text: string }

export type Comparison = {
	// A snapshot holds the recording and what this run produced.
	kind: "is" | "isNot" | "snapshot"
	left: string | null
	right: string | null
	diff: Array<DiffLine>
}

export type Failure = {
	form: "expect" | "require"
	span: Span | null
	values: Array<TracedValue>
	comparison: Comparison | null
}

export type OutputChunk = { stream: string; text: string }

// What this client reads off an event of any kind. Events carry their own
// `schema`, so a batch may hold a kind this client does not know. Every event
// is about one test; a batch carries no `run-start` or `run-end`.
export type TestEvent = {
	schema: number
	kind: string
	id: string
	name?: string
	suitePath?: Array<string>
	module?: string | null
	// The row of a table test, or null for another test.
	row?: number | null
	duration?: number
	expectations?: number
	failures?: Array<Failure>
	error?: string | null
	reason?: string
	stream?: string
	text?: string
	cases?: number
	requested?: number
	seed?: string
	shrinks?: number
	counterexample?: Array<PropertyCounterexample> | null
}

// One test as the compiled Module's manifest lists it, whatever running it
// said. A test a filter left out is here too, so the tree can be drawn.
export type TestSite = {
	id: string
	// The name template. A run reports the rendered name, which differs only
	// where the name interpolates.
	name: string
	// The row of a table test, or null. `suitePath` already ends in the shared
	// template; this labels a row before a run renders its name.
	row?: number | null
	suitePath: Array<string>
	file: string
	range: Range
	keywordRange: Range
	// The test's own tags and every enclosing suite's.
	tags: Array<string>
	focused: boolean
	skipped: string | null
	// Whether the item was written as a `benchmark`. The session runs without
	// `--bench`, so a benchmark arrives deselected for the reason `bench`.
	benchmark?: boolean
}

// One coverage point and how often control reached it. `scope` is the Method
// or Function it is in, so a "never taken" line reads without the file.
export type CoveragePoint = {
	kind: "statement" | "branch" | "case" | "construction"
	label: string
	scope: string
	position: Range
	// A branch whose condition establishes a refinement, such as the guard
	// before a division.
	refinement: boolean
	// `Choice#Case` on a construction point, null on every other kind.
	tag: string | null
	count: number
}

export type CoverageRatio = { covered: number; total: number }

export type MissedPoint = {
	kind: "branch" | "case"
	scope: string
	label: string
	refinement: boolean
	position: Range
}

// One source file's coverage. The tests in `Foo.tests.es` mostly count
// `Foo.es`.
export type FileCoverage = {
	module: string | null
	lines: CoverageRatio
	branches: CoverageRatio
	cases: CoverageRatio
	missed: Array<MissedPoint>
	points: Array<CoveragePoint>
}

// A declared Choice and which of its Cases anything built. A Choice may be
// constructed in any Module, so the Server sends the session's merged answer.
export type ChoiceCoverage = {
	name: string
	module: string | null
	position: Range
	cases: Array<{ tag: string; constructed: boolean }>
}

export type CoverageSummary = {
	files: Array<FileCoverage>
	choices: Array<ChoiceCoverage>
}

// `essence/testRun` as a client reads it. `version` is any number, since a
// client must be able to read the one it refuses.
export type TestRunNotification = {
	version: number
	run: number
	kind: "start" | "end"
	reason: "open" | "change" | "settings" | "request"
	files: Array<string>
	ids: Array<string>
	events: Array<TestEvent>
	sites: Array<TestSite>
	counts: {
		passed: number
		failed: number
		skipped: number
		deselected: number
	}
	duration: number
	compiled: boolean
	// `files` is this cycle's count, laid over what the client holds by
	// module. `choices` is the session's whole answer. Absent without
	// coverage.
	coverage?: CoverageSummary
}

// #endregion

// #region Identity

// The compiler's escaping for a structural id, so a suite's key is the prefix
// of every id under it. A suite has no id of its own, since the runner never
// selects one.
function identityKey(steps: Array<string>): string {
	return steps
		.map((step) => step.replaceAll("\\", "\\\\").replaceAll("/", "\\/"))
		.join("/")
}

export function fileKey(file: string): string {
	return identityKey([file])
}

export function suiteKey(file: string, suitePath: Array<string>): string {
	return identityKey([file, ...suitePath])
}

// #endregion

// #region Folding a batch into records

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
	reason: string | null
	duration: number
	expectations: number
	failures: Array<Failure>
	error: string | null
	output: Array<OutputChunk>
	// What a property test's cases did, or null. The runner makes up the
	// values, so only this says which ones failed.
	property: PropertyRecord | null
}

export type PropertyCounterexample = { name: string; value: string }

export type PropertyRecord = {
	cases: number
	// How many cases the run was asked for, which a replay repeats, since a
	// case's size grows over the whole run.
	requested: number
	seed: string
	shrinks: number
	counterexample: Array<PropertyCounterexample> | null
}

function emptyRecord(id: string, name: string): TestRecord {
	return {
		id,
		name,
		module: null,
		suitePath: [],
		state: "passed",
		reason: null,
		duration: 0,
		expectations: 0,
		failures: [],
		error: null,
		output: [],
		property: null,
	}
}

// The event stream folded into one record per test, in the order the tests
// started. Unknown kinds are skipped, so a newer event costs no batch.
//
// `probe` events are dropped, since the Server shows recorded values as inlay
// hints. `benchmark` events are dropped too: a benchmark run by id still
// reports its pass or fail through the ordinary events.
export function foldEvents(events: Array<TestEvent>): Array<TestRecord> {
	let byId = new Map<string, TestRecord>()
	let record = (
		event: TestEvent,
		state: TestState,
		details: Partial<TestRecord> = {},
	) => {
		let existing = byId.get(event.id)

		if (existing === undefined) {
			existing = emptyRecord(event.id, event.name ?? "")
			byId.set(event.id, existing)
		}

		// An event without a name keeps the one held, which `test-start`
		// carried.
		Object.assign(
			existing,
			{ name: event.name ?? existing.name, state },
			details,
		)

		return existing
	}

	for (let event of events) {
		switch (event.kind) {
			case "test-start":
				record(event, "passed", {
					module: event.module ?? null,
					suitePath: event.suitePath ?? [],
				})
				break
			case "test-pass":
				record(event, "passed", {
					duration: event.duration ?? 0,
					expectations: event.expectations ?? 0,
				})
				break
			case "test-fail":
				record(event, "failed", {
					duration: event.duration ?? 0,
					expectations: event.expectations ?? 0,
					failures: event.failures ?? [],
					error: event.error ?? null,
				})
				break
			case "test-skip":
				record(event, "skipped", {
					module: event.module ?? null,
					suitePath: event.suitePath ?? [],
					reason: event.reason ?? null,
				})
				break
			case "test-deselected":
				record(
					event,
					event.reason === "not-focused"
						? "not-focused"
						: "deselected",
					{
						module: event.module ?? null,
						suitePath: event.suitePath ?? [],
						reason: event.reason ?? null,
					},
				)
				break
			case "property": {
				let held = byId.get(event.id)

				if (held !== undefined) {
					held.property = {
						cases: event.cases ?? 0,
						requested: event.requested ?? 0,
						seed: event.seed ?? "",
						shrinks: event.shrinks ?? 0,
						counterexample: event.counterexample ?? null,
					}
				}

				break
			}
			case "output":
				byId.get(event.id)?.output.push({
					// `output` or `error`, the runtime's names for the
					// streams a test's `Terminal` writes to.
					stream: event.stream ?? "output",
					text: event.text ?? "",
				})
				break
			default:
				break
		}
	}

	return [...byId.values()]
}

// #endregion

// #region The state a client holds between batches

export type FileState = {
	sites: Array<TestSite>
	records: Map<string, TestRecord>
	// Whether what is held is the last run before the file stopped
	// compiling.
	stale: boolean
	duration: number
}

export type ClientState = {
	files: Map<string, FileState>
	// Held apart from the test results, since a cycle runs `Foo.tests.es` and
	// counts `Foo.es`. See "Applying a batch" in DEVELOPMENT.md.
	coverage: CoverageSummary
}

export function createState(): ClientState {
	return { files: new Map(), coverage: { files: [], choices: [] } }
}

function fileState(state: ClientState, file: string): FileState {
	let existing = state.files.get(file)

	if (existing === undefined) {
		existing = { sites: [], records: new Map(), stale: false, duration: 0 }
		state.files.set(file, existing)
	}

	return existing
}

function groupBy<Item>(
	items: Array<Item>,
	key: (item: Item) => string | null,
): Map<string | null, Array<Item>> {
	let groups = new Map<string | null, Array<Item>>()

	for (let item of items) {
		let group = groups.get(key(item))

		if (group === undefined) {
			group = []
			groups.set(key(item), group)
		}

		group.push(item)
	}

	return groups
}

export type AppliedBatch = {
	kind: "start" | "end"
	files: Array<string>
	// The files whose tree or results this batch moved, which a view redraws.
	changed: Array<string>
	// The source files this batch has coverage for. Empty without coverage.
	covered: Array<string>
}

// One batch applied to what the client holds, answering which files it
// changed. A narrowed batch replaces only its ids, and a file that did not
// compile is kept. See "Applying a batch" in DEVELOPMENT.md.
export function applyBatch(
	state: ClientState,
	notification: TestRunNotification,
): AppliedBatch | null {
	if (notification.version !== TEST_RUN_VERSION) {
		return null
	}

	if (notification.kind === "start") {
		return {
			kind: "start",
			files: [...notification.files],
			changed: [],
			covered: [],
		}
	}

	let narrowed = new Set(notification.ids ?? [])
	let sitesByFile = groupBy(notification.sites ?? [], (site) => site.file)
	let records = foldEvents(notification.events ?? [])
	let only = notification.files.length === 1 ? notification.files[0] : null
	// A record belongs to the file its test is written in, its `module`. In a
	// batch over one file, a record without one belongs to that file.
	let recordsByFile = groupBy(records, (each) => each.module ?? only)
	let changed = []

	for (let file of notification.files) {
		let sites = sitesByFile.get(file) ?? []
		let batch = recordsByFile.get(file) ?? []
		let entry = fileState(state, file)

		if (
			sites.length === 0 &&
			batch.length === 0 &&
			!notification.compiled
		) {
			entry.stale = true

			continue
		}

		entry.sites = sites
		entry.stale = false
		entry.duration = notification.duration

		if (narrowed.size === 0) {
			entry.records = new Map(batch.map((each) => [each.id, each]))
		} else {
			for (let each of batch) {
				if (narrowed.has(each.id)) {
					entry.records.set(each.id, each)
				}
			}
		}

		changed.push(file)
	}

	let covered: Array<string> = []

	if (notification.coverage !== undefined) {
		// A whole run replaces what is held, so a `settings` cycle with no
		// files clears the marks when coverage is turned off.
		let held: Array<FileCoverage> = wholeRun(notification)
			? []
			: state.coverage.files
		let counted = new Map(held.map((file) => [file.module, file]))

		for (let file of notification.coverage.files) {
			counted.set(file.module, file)

			if (file.module !== null) {
				covered.push(file.module)
			}
		}

		state.coverage = {
			files: [...counted.values()],
			choices: notification.coverage.choices,
		}
	}

	return { kind: "end", files: [...notification.files], changed, covered }
}

// Whether a cycle covers every test file: the first run of a session, or the
// run after a setting changed.
function wholeRun(notification: TestRunNotification): boolean {
	return notification.reason === "open" || notification.reason === "settings"
}

// A file the workspace no longer holds tests for. The session stops reporting
// on it rather than reporting it empty, so the view calls this itself.
export function forgetFile(state: ClientState, file: string): boolean {
	state.coverage = {
		files: state.coverage.files.filter((each) => each.module !== file),
		choices: state.coverage.choices.filter((each) => each.module !== file),
	}

	return state.files.delete(file)
}

// #endregion

// #region The tree

// One node type, as VS Code's TestItem is. A suite has children and no site;
// a test has a site and no children.
export type TreeNode = {
	kind: "suite" | "test"
	id: string
	label: string
	file: string
	children: Array<TreeNode>
	site: TestSite | null
	record: TestRecord | null
	tags: Array<string>
	state: TestState | "unknown"
}

// A table row is labelled by its number until a run renders its name.
function labelOf(site: TestSite): string {
	return site.row === null || site.row === undefined
		? site.name
		: `row ${site.row}`
}

// A file's tests as a tree of suites, in source order. A suite stands where its
// first test stands, since the manifest lists tests in source order.
export function treeOf(state: ClientState, file: string): Array<TreeNode> {
	let entry = state.files.get(file)

	if (entry === undefined) {
		return []
	}

	let roots: Array<TreeNode> = []
	let suites = new Map<string, TreeNode>()

	let container = (suitePath: Array<string>): Array<TreeNode> => {
		if (suitePath.length === 0) {
			return roots
		}

		let key = suiteKey(file, suitePath)
		let existing = suites.get(key)

		if (existing !== undefined) {
			return existing.children
		}

		let node: TreeNode = {
			kind: "suite",
			id: key,
			label: suitePath[suitePath.length - 1],
			file,
			children: [],
			site: null,
			record: null,
			tags: [],
			state: "unknown",
		}

		suites.set(key, node)
		container(suitePath.slice(0, -1)).push(node)

		return node.children
	}

	for (let site of entry.sites) {
		let record = entry.records.get(site.id) ?? null

		container(site.suitePath).push({
			kind: "test",
			id: site.id,
			// The name a run rendered, or else the template. A table row
			// falls back to its number, since it stands under the template.
			label: record?.name ?? labelOf(site),
			file,
			children: [],
			site,
			record,
			tags: site.tags,
			state: record?.state ?? "unknown",
		})
	}

	return roots
}

// Every tag any test of the workspace carries, sorted, for one run profile per
// tag. Recomputed, so a tag nothing carries drops its profile.
export function tagsOf(state: ClientState): Array<string> {
	let tags = new Set<string>()

	for (let entry of state.files.values()) {
		for (let site of entry.sites) {
			for (let tag of site.tags) {
				tags.add(tag)
			}
		}
	}

	return [...tags].sort()
}

// What "re-run failed" runs: the failed tests' ids, not their files.
export function failedIdsOf(state: ClientState): Array<string> {
	let ids = []

	for (let entry of state.files.values()) {
		for (let site of entry.sites) {
			if (entry.records.get(site.id)?.state === "failed") {
				ids.push(site.id)
			}
		}
	}

	return ids
}

// #endregion

// #region What a failure says

// Whether a traced value explains anything. A literal, whose rendering is its
// source, does not; nor does the assertion's own answer. The terminal report
// drops the same values.
function explains(
	value: TracedValue,
	span: Span,
): value is TracedValue & {
	span: Span
} {
	return (
		value.span !== null &&
		value.value !== value.span.source &&
		!(
			value.span.start.line === span.start.line &&
			value.span.start.column === span.start.column &&
			value.span.end.line === span.end.line &&
			value.span.end.column === span.end.column
		)
	)
}

function diffLines(diff: Array<DiffLine>): Array<string> {
	return diff.map((line) => {
		switch (line.kind) {
			case "left":
				return `- ${line.text}`
			case "right":
				return `+ ${line.text}`
			default:
				return `  ${line.text}`
		}
	})
}

export type Message = {
	text: string
	// Filled in for `is` and for a snapshot, which VS Code draws as a diff.
	// `isNot` has no expected value.
	expected: string | null
	actual: string | null
	// Null for a body that threw, which is reported against the test.
	range: Range | null
}

// Each failed assertion as the terminal says it: the assertion, every traced
// sub-expression, then what the comparison held.
export function messagesOf(
	record: Pick<TestRecord, "failures" | "error" | "property">,
): Array<Message> {
	let messages: Array<Message> = []
	// The generated values a property test failed for, shown above each of
	// its assertions.
	let counterexample = counterexampleOf(record.property)

	for (let failure of record.failures) {
		let span = failure.span

		if (span === null) {
			continue
		}

		let lines = [...counterexample, `${failure.form} ${span.source}`]

		for (let value of failure.values) {
			if (explains(value, span)) {
				lines.push(`  ${value.span.source} = ${value.value}`)
			}
		}

		let comparison = failure.comparison
		let expected = null
		let actual = null

		// A snapshot's difference from its recording is the whole
		// explanation, however short, and VS Code draws it as a text diff.
		if (comparison !== null && comparison.kind === "snapshot") {
			lines.push(
				"",
				comparison.left === null
					? "nothing was recorded for this snapshot"
					: "the recorded snapshot and this run differ",
			)

			if (comparison.diff.length > 0) {
				lines.push(
					"",
					"the difference, - what was recorded, + what this run held:",
					...diffLines(comparison.diff),
				)
			}

			expected = comparison.left
			actual = comparison.right
		} else if (comparison !== null && comparison.left !== null) {
			lines.push(
				"",
				`\`${comparison.kind}\` compared ${comparison.left} with ${comparison.right}`,
			)

			// Only a walk into a Record or List adds to the comparison line.
			if (comparison.diff.length > 2) {
				lines.push(
					"",
					"the difference, - what it held, + what it was compared with:",
					...diffLines(comparison.diff),
				)
			}

			if (comparison.kind === "is" && comparison.right !== null) {
				expected = comparison.right
				actual = comparison.left
			}
		}

		messages.push({
			text: lines.join("\n"),
			expected,
			actual,
			range: { start: span.start, end: span.end },
		})
	}

	// A body that threw has no span of its own and is reported against the
	// test.
	if (record.error !== null) {
		messages.push({
			text: [...counterexample, record.error].join("\n"),
			expected: null,
			actual: null,
			range: null,
		})
	}

	return messages
}

// The values a property test failed on and the command that replays them, as
// the terminal's report writes them.
function counterexampleOf(property: PropertyRecord | null): Array<string> {
	if (property === null || property.counterexample === null) {
		return []
	}

	return [
		property.shrinks === 0
			? `after ${property.cases} cases:`
			: `after ${property.cases} cases, shrunk to:`,
		...property.counterexample.map(
			(entry) => `  ${entry.name} = ${entry.value}`,
		),
		`replay: essence test --seed ${property.seed}${
			property.requested === 0 || property.requested === 100
				? ""
				: ` --cases ${property.requested}`
		}`,
		"",
	]
}

// A test's captured output as one block. Output is held per test, not
// interleaved with the run.
export function outputOf(record: Pick<TestRecord, "output">): string {
	return record.output.map((chunk) => chunk.text).join("")
}

// #endregion

// #region What to draw in the gutter

export type LineRange = { start: number; end: number }
export type ExpectMark = { range: Range; text: string }

export type Marks = {
	passed: Array<LineRange>
	failed: Array<LineRange>
	skipped: Array<LineRange>
	notFocused: Array<LineRange>
	expects: Array<ExpectMark>
}

// The lines of each test, its whole `site.range`, by what the test last did.
// A failed `expect` is also marked on its own line, in its own colour.
export function decorationsOf(state: ClientState, file: string): Marks {
	let entry = state.files.get(file)
	let marks: Marks = {
		passed: [],
		failed: [],
		skipped: [],
		notFocused: [],
		expects: [],
	}

	if (entry === undefined) {
		return marks
	}

	for (let site of entry.sites) {
		let record = entry.records.get(site.id)

		if (record === undefined) {
			continue
		}

		let lines = { start: site.range.start.line, end: site.range.end.line }

		switch (record.state) {
			case "passed":
				marks.passed.push(lines)
				break
			case "failed":
				marks.failed.push(lines)

				for (let message of messagesOf(record)) {
					if (message.range !== null) {
						marks.expects.push({
							range: message.range,
							text: message.text,
						})
					}
				}

				break
			case "skipped":
				marks.skipped.push(lines)
				break
			case "not-focused":
				marks.notFocused.push(lines)
				break
			default:
				// A test a tag or filter left out is not marked.
				break
		}
	}

	return marks
}

// #endregion

// #region What the coverage view draws

// One line and how often it ran: the greatest count of what stands on it.
export type CoverageLine = {
	line: number
	count: number
	// The branches on this line, named as written, such as `if` or
	// `case #Postponed`. VS Code shows them as the statement's branch detail.
	branches: Array<CoverageBranch>
	// What stands on this line and never ran, such as an arm nothing reached.
	// A line that ran with something missed is partly covered.
	missed: Array<CoverageMiss>
}

export type CoverageBranch = { line: number; label: string; count: number }

export type CoverageMiss = {
	kind: "statement" | "branch" | "case"
	label: string
}

// A named thing that ran or did not, such as a Match arm or a Choice Case. VS
// Code calls it a declaration.
export type CoverageDeclaration = {
	name: string
	count: number
	position: Range
}

export function coverageOf(
	state: ClientState,
	file: string,
): FileCoverage | null {
	return state.coverage.files.find((each) => each.module === file) ?? null
}

export function coverageLinesOf(file: FileCoverage): Array<CoverageLine> {
	let lines = new Map<number, CoverageLine>()
	let lineAt = (line: number): CoverageLine => {
		let existing = lines.get(line)

		if (existing === undefined) {
			existing = { line, count: 0, branches: [], missed: [] }
			lines.set(line, existing)
		}

		return existing
	}

	for (let point of file.points) {
		if (point.kind === "construction") {
			continue
		}

		let line = point.position.start.line
		let entry = lineAt(line)

		// A branch or arm counts towards its line as a Statement does, as
		// the ratios were counted.
		entry.count = Math.max(entry.count, point.count)

		if (point.count === 0) {
			entry.missed.push({ kind: point.kind, label: point.label })
		}

		if (point.kind === "branch") {
			entry.branches.push({
				line,
				label: point.label,
				count: point.count,
			})
		}
	}

	return [...lines.values()].sort((left, right) => left.line - right.line)
}

// What the gutter draws beside a counted file, shaped like the test marks. A
// line that ran but holds something that never did is `partial`; the coverage
// view says what.
export type CoverageMarks = {
	covered: Array<LineRange>
	partial: Array<LineRange>
	uncovered: Array<LineRange>
}

export function coverageMarksOf(file: FileCoverage): CoverageMarks {
	let covered: Array<number> = []
	let partial: Array<number> = []
	let uncovered: Array<number> = []

	for (let line of coverageLinesOf(file)) {
		if (line.count === 0) {
			uncovered.push(line.line)
		} else if (line.missed.length === 0) {
			covered.push(line.line)
		} else {
			partial.push(line.line)
		}
	}

	return {
		covered: runsOf(covered),
		partial: runsOf(partial),
		uncovered: runsOf(uncovered),
	}
}

// Adjacent lines merged into ranges. The lines arrive sorted from
// `coverageLinesOf`.
function runsOf(lines: Array<number>): Array<LineRange> {
	let ranges: Array<LineRange> = []

	for (let line of lines) {
		let last = ranges[ranges.length - 1]

		if (last !== undefined && last.end === line - 1) {
			last.end = line

			continue
		}

		ranges.push({ start: line, end: line })
	}

	return ranges
}

// Every Match arm of one file, and every Case of every Choice declared in it.
// A Case is counted wherever it is built, so the whole state is read.
export function declarationsOf(
	state: ClientState,
	file: string,
): Array<CoverageDeclaration> {
	let coverage = coverageOf(state, file)
	let declarations: Array<CoverageDeclaration> =
		coverage === null
			? []
			: coverage.points
					.filter((point) => point.kind === "case")
					.map((point) => ({
						name:
							point.scope === ""
								? point.label
								: `${point.scope} › ${point.label}`,
						count: point.count,
						position: point.position,
					}))

	for (let choice of state.coverage.choices) {
		if (choice.module !== file) {
			continue
		}

		for (let entry of choice.cases) {
			declarations.push({
				name: `${choice.name}${caseNameOf(entry.tag)}`,
				count: entry.constructed ? 1 : 0,
				position: choice.position,
			})
		}
	}

	return declarations
}

// The tag `Fixture#Forfeited` as the Case is written, `#Forfeited`.
function caseNameOf(tag: string): string {
	let hash = tag.lastIndexOf("#")

	return hash === -1 ? `#${tag}` : `#${tag.slice(hash + 1)}`
}

// The output channel's line about a cycle's coverage: line and branch
// percentages, Match arms reached, and Choice Cases never constructed.
export function describeCoverage(coverage: CoverageSummary): string {
	if (coverage.files.length === 0) {
		return ""
	}

	let sum = (pick: (file: FileCoverage) => CoverageRatio): CoverageRatio =>
		coverage.files.reduce(
			(total, file) => ({
				covered: total.covered + pick(file).covered,
				total: total.total + pick(file).total,
			}),
			{ covered: 0, total: 0 },
		)
	// Rounded down, as `percentageOf` in the compiler is, so 100% means
	// everything.
	let percentage = (ratio: CoverageRatio): string =>
		ratio.total === 0
			? "–"
			: `${Math.floor((ratio.covered / ratio.total) * 100)}%`
	let lines = sum((file) => file.lines)
	let branches = sum((file) => file.branches)
	let cases = sum((file) => file.cases)
	let never = coverage.choices.flatMap((choice) =>
		choice.cases.filter((entry) => !entry.constructed),
	).length

	return (
		`coverage: ${percentage(lines)} lines · ` +
		`${percentage(branches)} branches · ` +
		`${cases.covered}/${cases.total} cases` +
		(never === 0 ? "" : ` · ${never} never constructed`)
	)
}

// #endregion

// #region What to debug

// The launch configurations that step through this selection. A session
// compiles one file, so each file named gets a session, in order, carrying its
// tests' ids. Two tests may share a name but never an id.
export type DebugConfiguration = {
	type: "essence"
	request: "launch"
	name: string
	program: string
	tests: Array<string>
}

export function debugConfigurationsFor(
	tests: Array<{ label: string; file: string; id: string }>,
): Array<DebugConfiguration> {
	let byFile = new Map<string, Array<{ label: string; id: string }>>()

	for (let test of tests) {
		if (test.file === "") {
			continue
		}

		let held = byFile.get(test.file)

		if (held === undefined) {
			byFile.set(test.file, [{ label: test.label, id: test.id }])
		} else {
			held.push({ label: test.label, id: test.id })
		}
	}

	return [...byFile.entries()].map(([file, held]) => ({
		type: "essence" as const,
		request: "launch" as const,
		// A single test names the session after itself.
		name:
			held.length === 1 ? held[0]!.label : `${path.basename(file)} tests`,
		program: file,
		tests: held.map((entry) => entry.id),
	}))
}

// #endregion

// #region The counts a run reports

// One line for the output channel: what the cycle covered, how long it took
// and whether everything compiled.
export function describeBatch(notification: TestRunNotification): string {
	let counts = notification.counts
	let files = notification.files.length
	let parts = [
		`${counts.passed} passed`,
		`${counts.failed} failed`,
		`${counts.skipped} skipped`,
		`${counts.deselected} not run`,
	]

	return (
		`run ${notification.run} (${notification.reason}) · ` +
		`${files} file${files === 1 ? "" : "s"} · ` +
		`${parts.join(", ")} · ${notification.duration} ms` +
		(notification.compiled ? "" : " · something would not compile")
	)
}

// #endregion
