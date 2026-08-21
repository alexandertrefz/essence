// NOTE: Everything the Test Explorer knows, as plain data. Nothing here imports
// `vscode`: what an `essence/testRun` batch MEANS — which tests exist, what each
// of them last did, what to draw beside which line — is a function of the
// payload, and a function of the payload can be tested without an extension
// host. `testView.js` is the half that talks to VS Code, and it is deliberately
// thin.
//
// NOTE: This is the one TypeScript file of the extension, and the split is the
// reason: `extension.js`, `launch.js` and `testView.js` all reach for `vscode`,
// whose types this package does not depend on, while everything below is a
// function of its arguments. What the Types buy is the protocol written down —
// a client reading a wire format has no other place to say what it expects.
//
// NOTE: The Compiler's own fold (`@essence-lang/compiler/testing`) does the same
// reading, and this is not it. The extension bundles into one file with no
// `node_modules` beside it, and pulling the Compiler in to read seven event
// kinds would ship a compiler inside an editor plugin. What this file is, is the
// reference client: the whole of what a consumer of the protocol has to do.

import path from "node:path"

// NOTE: The payload shape this client understands. A notification carrying any
// other version is IGNORED — that is the protocol's own rule, and guessing at a
// shape nobody wrote down is how a Test Explorer comes to show yesterday's
// answers with today's confidence.
export const TEST_RUN_VERSION = 3

// #region What arrives on the wire

// NOTE: Positions are the Compiler's throughout: 1-based line, 1-based column.
// `testView.js` converts to VS Code's 0-based pair at the last moment, and
// nothing below ever does.
export type Cursor = { line: number; column: number }
export type Range = { start: Cursor; end: Cursor }
export type Span = Range & { source: string }

export type TracedValue = { point: number; span: Span | null; value: string }
export type DiffLine = { kind: "same" | "left" | "right"; text: string }

export type Comparison = {
	kind: "is" | "isNot"
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

// NOTE: What this client reads off an event, whatever kind the event is. The
// stream is versioned separately from the payload — `schema` is its own — so a
// batch may carry a kind this extension has never heard of, and every field
// below a kind does not have is simply absent. What a batch does NOT carry is
// `run-start` or `run-end`: the notification's own counts say that, so every
// event in one is about a single test and names it.
export type TestEvent = {
	schema: number
	kind: string
	id: string
	name?: string
	suitePath?: Array<string>
	module?: string | null
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

// NOTE: One test as the Compiler found it, independently of what running it
// said — the half of a run that draws a TREE. It comes off the compiled
// Module's own manifest, so a test a filter left out is here too, on the line
// it was written on.
export type TestSite = {
	id: string
	// NOTE: The name TEMPLATE. What a run reports is the RENDERING, which only
	// differs where the name interpolates.
	name: string
	// NOTE: Which row of a table test this is, and null for the ordinary test.
	// `suitePath` already ends in the template the rows share, so this is only
	// what labels a row before anything has run and worked its name out.
	row?: number | null
	suitePath: Array<string>
	file: string
	range: Range
	keywordRange: Range
	// NOTE: The EFFECTIVE tags — the test's own and every enclosing suite's.
	tags: Array<string>
	focused: boolean
	skipped: string | null
}

// NOTE: What the run's counters counted, one point at a time — where it stands,
// what kind of thing it counts, what to call it and how often control reached
// it. `scope` is the Method or Function it was written in, which is what makes
// a "never taken" line readable without opening the file.
export type CoveragePoint = {
	kind: "statement" | "branch" | "case" | "construction"
	label: string
	scope: string
	position: Range
	// NOTE: A branch whose condition ESTABLISHED something — the guard in front
	// of a division. Both sides of one are worth looking at separately.
	refinement: boolean
	// NOTE: `Choice#Case` on a construction point, null on every other kind.
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

// NOTE: One SOURCE file's coverage, which is not the file the tests are in: a
// `Foo.tests.es` runs the tests, and what its counters counted is mostly
// `Foo.es`.
export type FileCoverage = {
	module: string | null
	lines: CoverageRatio
	branches: CoverageRatio
	cases: CoverageRatio
	missed: Array<MissedPoint>
	points: Array<CoveragePoint>
}

// NOTE: A declared Choice and which of its Cases anything built. It is answered
// across the whole run rather than per file — a Choice is declared in one
// Module and constructed in any — which is why the Server sends the merged
// picture rather than the cycle.
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

// NOTE: `essence/testRun`, as a client must be able to READ it rather than as
// the Server declares it: `version` is a number here, because the number a
// client refuses is exactly the one it was not built for.
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
	// NOTE: `files` is what THIS CYCLE counted and is laid over what the client
	// holds, keyed by module; `choices` is the session's whole answer and
	// replaces what it holds. Optional because a client reads the wire, and a
	// Server that never turns coverage on never writes the field.
	coverage?: CoverageSummary
}

// #endregion

// #region Identity

// NOTE: The same escaping the Compiler spells a structural id with, so that the
// id of a suite is exactly the prefix every id under it starts with. A client
// never invents an identity — a test's is handed to it — but a SUITE has none
// of its own, because a suite is not a thing the runner selects.
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
	// NOTE: What a property test's run of cases did, and null for every other
	// test. It is what turns "this failed" into "this failed for THESE values"
	// — the values a property failed on are made up by the runner, so nothing
	// in the source says what they were.
	property: PropertyRecord | null
}

export type PropertyCounterexample = { name: string; value: string }

export type PropertyRecord = {
	cases: number
	// NOTE: How many cases the run was TOLD to run, which a replay has to say
	// back — the size a case is drawn at grows over the whole run.
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

// NOTE: The event stream folded back into one record per test, in the order the
// tests started. Unknown event kinds are skipped rather than refused — the
// stream is versioned separately from the payload, and a `coverage` event this
// extension has never heard of must not cost it the batch.
//
// NOTE: `probe` events are deliberately dropped. The values a run recorded are
// drawn by the Server, as inlay hints, at the end of the line that produced
// them; a decoration of our own on the same line would be a second answer to one
// question — see `README.md`.
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

		// NOTE: The name falls back to the one already held rather than to
		// nothing: a `test-start` carries it, and the kinds that end a test
		// carry it again only because the stream is readable on its own.
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
					// NOTE: `output` or `error`, which is what the runtime
					// names the two streams a test's `Terminal` writes to.
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
	// NOTE: Whether what is held for this file is what the buffer would produce,
	// or the last thing that ran before it stopped compiling.
	stale: boolean
	duration: number
}

export type ClientState = {
	files: Map<string, FileState>
	// NOTE: Coverage is held APART from the per-file test results, because
	// those are two different sets: one cycle runs `Foo.tests.es` and counts
	// `Foo.es`. The files a batch carries are laid over what is here, keyed by
	// module — a cycle covers what a change reached and says nothing about the
	// rest — while the Choices replace what is here, because the Server works
	// that answer out across the whole run and nobody should work it out twice.
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
	// NOTE: The files whose tree or results this batch actually moved, which is
	// what a view redraws. A batch that found nothing for a file it could not
	// compile moves nothing.
	changed: Array<string>
	// NOTE: The SOURCE files this batch has coverage for, which is a different
	// list from `changed` for the reason `ClientState.coverage` is held apart.
	// Empty where the session was not asked for coverage.
	covered: Array<string>
}

// NOTE: One batch applied to what the client holds, answering which files it
// changed. Three rules, and the second and third are the whole reason this is a
// function rather than an assignment:
//
// 1. A file the batch covered is REPLACED by what the batch says about it.
// 2. Unless the batch was NARROWED — a Run lens over one test reports a
//    deselection for every other test of that file, and adopting those would
//    forget results nobody asked to forget. Only the named ids are replaced.
// 3. Unless the batch has nothing at all for that file and did not compile. A
//    half-typed line is not a reason to empty a Test Explorer; the file is
//    marked stale instead, and goes on saying what it last said.
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
	// NOTE: A record belongs to the file its test was WRITTEN in, which is what
	// the events carry as `module`. The fallback is for a batch over exactly one
	// file, where a Module that never named itself can only be that one.
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
		let counted = new Map(
			state.coverage.files.map((file) => [file.module, file]),
		)

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

// NOTE: A file the workspace no longer holds tests for. The session stops
// reporting on it rather than reporting that it is empty, so the client has to
// be told separately — by the file being deleted, or by a batch that covered it
// and found nothing.
export function forgetFile(state: ClientState, file: string): boolean {
	state.coverage = {
		files: state.coverage.files.filter((each) => each.module !== file),
		choices: state.coverage.choices.filter((each) => each.module !== file),
	}

	return state.files.delete(file)
}

// #endregion

// #region The tree

// NOTE: One node type rather than two, with `kind` saying which half of it means
// anything: a suite has children and no site, a test has a site and no children.
// It is the shape VS Code's own TestItem has, which is what this is mapped onto,
// and a reader walking the tree never has to ask which of two Types it is
// holding.
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

// NOTE: A file's tests as a tree of suites, in the order they were written. A
// suite stands where its FIRST test stands, which is where it was written: the
// manifest lists tests in source order, and a suite is the path they share.
function labelOf(site: TestSite): string {
	return site.row === null || site.row === undefined
		? site.name
		: `row ${site.row}`
}

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
			// NOTE: The rendering a run reported, and the template where
			// nothing has run — which is the only name an interpolated test
			// that was never selected has. A row of a table test stands under
			// that template already, so what it falls back to is its number.
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

// NOTE: Every tag any test of the workspace carries, sorted. What it is for is
// one run profile per tag — a tag nothing carries any more must stop offering
// one, which is why this is recomputed rather than accumulated.
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

// NOTE: What "re-run failed" runs. Ids rather than files, because a file with
// one failure in forty is a file where re-running the forty is not what was
// asked for.
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

// NOTE: A traced value that explains nothing: one whose rendering IS its own
// source (a literal), and the assertion's own answer, which "this failed" has
// already said. Both would be a line the reader has to look past. The terminal
// report drops exactly these, for exactly this reason.
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
	// NOTE: Filled in only for `is`, which is the one comparison that HAS an
	// expectation. VS Code draws the pair as a diff.
	expected: string | null
	actual: string | null
	// NOTE: Where to say it. Null for a body that threw, which happened to the
	// test rather than at a Position.
	range: Range | null
}

// NOTE: One failed assertion, said the way the terminal says it: the assertion
// itself, then every sub-expression the lowering recorded, then what the
// comparison held. `expected`/`actual` are filled in only for `is` — VS Code
// draws those two as a diff, and "expected" is a claim `isNot` never makes.
export function messagesOf(
	record: Pick<TestRecord, "failures" | "error" | "property">,
): Array<Message> {
	let messages: Array<Message> = []
	// NOTE: What a property test failed FOR, said once above each assertion:
	// every assertion of a property test failed for the same generated values,
	// and nothing in the source says what they were.
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

		if (comparison !== null && comparison.left !== null) {
			lines.push(
				"",
				`\`${comparison.kind}\` compared ${comparison.left} with ${comparison.right}`,
			)

			// NOTE: Only a walk INTO a Record or a List says something the line
			// above has not already said in full.
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

	// NOTE: A test body that THREW is a Compiler or a runtime bug rather than a
	// failed assertion, and it has no span of its own — it is reported against
	// the test itself.
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

// NOTE: The values a property test failed on, and how to draw them again — the
// same two lines the terminal's report carries, because a reader who has one
// open should not have to learn the other.
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

// NOTE: Everything a test's captured output said, as one block. `Terminal.print`
// inside a test is held per test rather than interleaved with the run, which is
// what makes it worth showing at all.
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

// NOTE: The lines to mark, by what the test they belong to last did. It is the
// whole of the test — `site.range` spans `test "…" { … }` — rather than the
// keyword's line alone, because VS Code's own Testing gutter already owns that
// one line, and a second icon on it would say the same thing twice. What it does
// not draw is the BODY, which is what a reader is looking at.
//
// NOTE: A failed `expect` is marked on its own line as well, in its own colour.
// The test's mark says the test failed; this one says WHERE, which the test's
// mark could not, and which the Problems panel says in a different window.
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
				// NOTE: A test a tag or a filter left out is not marked at all.
				// It did not fail, it was not skipped by anything the source
				// says, and colouring the lines of a test nobody selected is
				// colour that answers no question.
				break
		}
	}

	return marks
}

// #endregion

// #region What the coverage view draws

// NOTE: One line, and how often it ran. A line may carry several Statements —
// the greatest of their counts is how often the LINE ran, which is what a
// coverage view draws beside it.
export type CoverageLine = {
	line: number
	count: number
	// NOTE: The branches standing on this line, each named as it was written:
	// `if`, `else`, `case #Postponed`. VS Code draws them as the branch detail
	// of the statement they are on.
	branches: Array<CoverageBranch>
}

export type CoverageBranch = { line: number; label: string; count: number }

// NOTE: A thing that either RAN or did not, named — a Match arm, a Choice Case.
// It is what VS Code calls a declaration, which is the right shape for it: an
// arm and a Case are things the source declares, they are counted one by one,
// and an exhaustive language can say which of them nothing reached without
// guessing.
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
			existing = { line, count: 0, branches: [] }
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

		// NOTE: A branch and an arm count towards their line exactly as a
		// Statement does — they are places control arrives — and the same rule
		// is what the ratios beside them were counted under.
		entry.count = Math.max(entry.count, point.count)

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

// NOTE: The lines nothing reached, in the same shape the test marks answer in —
// ranges rather than lines, so a caller draws both the same way. Adjacent lines
// are merged, which is what makes a run of never-executed lines one thing to
// read rather than nine.
export function uncoveredLinesOf(file: FileCoverage): Array<LineRange> {
	let uncovered = coverageLinesOf(file)
		.filter((line) => line.count === 0)
		.map((line) => line.line)
	let ranges: Array<LineRange> = []

	for (let line of uncovered) {
		let last = ranges[ranges.length - 1]

		if (last !== undefined && last.end === line - 1) {
			last.end = line

			continue
		}

		ranges.push({ start: line, end: line })
	}

	return ranges
}

// NOTE: Every Match arm of one file, and every Case of every Choice DECLARED in
// it — which is why the whole state is read rather than the file's own entry: a
// Choice's Cases are counted wherever they are built, and what is declared is
// known only where it was written.
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

// NOTE: `Fixture#Forfeited` is how a tag is spelled where it is compared;
// `#Forfeited` is how a Case is written.
function caseNameOf(tag: string): string {
	let hash = tag.lastIndexOf("#")

	return hash === -1 ? `#${tag}` : `#${tag.slice(hash + 1)}`
}

// NOTE: The one line the output channel writes about a cycle's coverage — the
// two percentages and the count of what an exhaustive language can say and a
// line counter can not.
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
	// NOTE: Rounded DOWN, exactly as the Compiler's own `percentageOf` is, so
	// that 100% means every one of them: 199 of 200 rounded up would say a file
	// with a missed branch is complete.
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

// #region What to run instead

// NOTE: The `essence test` invocation that runs exactly this selection, which
// is what the Debug profile hands over in place of a debug session it can not
// start yet. One test is named by `--filter`, which matches a substring of the
// rendered name — the label an item carries; anything else is the whole run,
// because a filter that matches several tests is not the thing that was asked
// for.
export function commandFor(
	tests: Array<{ label: string; file: string }>,
): string {
	if (tests.length !== 1) {
		return "essence test"
	}

	let [only] = tests

	return (
		`essence test ${path.basename(only!.file)} ` +
		`--filter ${JSON.stringify(only!.label)}`
	)
}

// #endregion

// #region The counts a run reports

// NOTE: One line for the output channel: what the cycle covered and what it
// found. The channel is the session's own story — which files, how long, what
// would not compile — rather than a second copy of the results.
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
