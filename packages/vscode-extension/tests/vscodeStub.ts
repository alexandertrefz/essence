// NOTE: Enough of VS Code's API for `testView.js` to run outside an extension
// host, and no more: a TestController and its items, runs and profiles, the
// decoration types, the output channel and the handful of value classes the
// view constructs. Every call is recorded, so a spec asserts what the view DID
// rather than what it holds.
//
// NOTE: A stand-in is not the product. What this pins is the bookkeeping —
// which item was created, which run was ended, what was drawn where — none of
// which an Extension Development Host makes easy to see, and all of which is
// wrong in ways nobody notices until a tree stops updating. Whether the real
// API behaves as this says is what the walkthrough in `DEVELOPMENT.md` is for.

export type StubUri = { fsPath: string; scheme: string; toString: () => string }

export type StubRange = {
	startLine: number
	startCharacter: number
	endLine: number
	endCharacter: number
}

// NOTE: The value class the view builds ranges with.
class StubRangeValue implements StubRange {
	startLine: number
	startCharacter: number
	endLine: number
	endCharacter: number

	constructor(
		startLine: number,
		startCharacter: number,
		endLine: number,
		endCharacter: number,
	) {
		this.startLine = startLine
		this.startCharacter = startCharacter
		this.endLine = endLine
		this.endCharacter = endCharacter
	}
}

export class StubTestItem {
	id: string
	label: string
	uri: StubUri | undefined
	parent: StubTestItem | undefined = undefined
	children: StubTestItemCollection
	range: StubRange | undefined = undefined
	tags: Array<{ id: string }> = []
	description: string | undefined = undefined
	sortText: string | undefined = undefined

	constructor(id: string, label: string, uri: StubUri | undefined) {
		this.id = id
		this.label = label
		this.uri = uri
		this.children = new StubTestItemCollection(this)
	}
}

export class StubTestItemCollection {
	owner: StubTestItem | null
	entries = new Map<string, StubTestItem>()

	constructor(owner: StubTestItem | null) {
		this.owner = owner
	}

	get size(): number {
		return this.entries.size
	}

	add(item: StubTestItem): void {
		item.parent = this.owner ?? undefined
		this.entries.set(item.id, item)
	}

	delete(id: string): void {
		this.entries.delete(id)
	}

	get(id: string): StubTestItem | undefined {
		return this.entries.get(id)
	}

	replace(items: Array<StubTestItem>): void {
		this.entries.clear()

		for (let item of items) {
			this.add(item)
		}
	}

	forEach(visit: (item: StubTestItem) => void): void {
		for (let item of this.entries.values()) {
			visit(item)
		}
	}
}

export type StubCount = { covered: number; total: number }

// NOTE: What `run.addCoverage` was handed, flattened — the counts a coverage
// view draws per file. The DETAIL is asked for separately, through the
// profile's `loadDetailedCoverage`, which a spec calls itself.
export type StubFileCoverage = {
	uri: StubUri
	statementCoverage: StubCount
	branchCoverage: StubCount | undefined
	declarationCoverage: StubCount | undefined
}

export type StubMessage = {
	text: string
	expected: string | null
	actual: string | null
	location: { uri: StubUri; range: StubRange } | null
}

// NOTE: The methods are VS Code's; the arrays beside them are what a spec
// reads. They are named apart because `run.passed(item)` and "which tests
// passed" are two different things, and the API owns the first name.
export class StubTestRun {
	name: string | undefined
	persist: boolean | undefined
	request: unknown
	enqueuedTests: Array<string> = []
	passedTests: Array<{ id: string; duration: number | undefined }> = []
	failedTests: Array<{
		id: string
		messages: Array<StubMessage>
		duration: number | undefined
	}> = []
	skippedTests: Array<string> = []
	outputChunks: Array<{ id: string | undefined; text: string }> = []
	coverages: Array<StubFileCoverage> = []
	ends = 0

	constructor(request: unknown, name?: string, persist?: boolean) {
		this.request = request
		this.name = name
		this.persist = persist
	}

	enqueued(item: StubTestItem): void {
		this.enqueuedTests.push(item.id)
	}

	passed(item: StubTestItem, duration?: number): void {
		this.passedTests.push({ id: item.id, duration })
	}

	failed(
		item: StubTestItem,
		messages: StubMessage | Array<StubMessage>,
		duration?: number,
	): void {
		this.failedTests.push({
			id: item.id,
			messages: Array.isArray(messages) ? messages : [messages],
			duration,
		})
	}

	skipped(item: StubTestItem): void {
		this.skippedTests.push(item.id)
	}

	addCoverage(coverage: StubFileCoverage): void {
		this.coverages.push(coverage)
	}

	appendOutput(
		text: string,
		_location: unknown,
		item: StubTestItem | undefined,
	): void {
		this.outputChunks.push({ id: item?.id, text })
	}

	end(): void {
		this.ends += 1
	}
}

export type StubProfile = {
	label: string
	kind: number
	tag: { id: string } | undefined
	isDefault: boolean
	run: (request: unknown, token: unknown) => unknown
	disposals: number
	dispose: () => void
}

export type StubEditor = {
	document: { languageId: string; uri: StubUri }
	drawn: Map<unknown, Array<unknown>>
	setDecorations: (type: unknown, ranges: Array<unknown>) => void
}

export type Stub = {
	module: Record<string, unknown>
	controller: {
		id: string
		label: string
		items: StubTestItemCollection
		profiles: Array<StubProfile>
		refreshHandler: (() => unknown) | undefined
		disposals: number
	}
	runs: Array<StubTestRun>
	decorations: Array<{ options: Record<string, unknown>; disposals: number }>
	channel: { lines: Array<string>; shown: number; disposals: number }
	messages: Array<{ text: string; actions: Array<string> }>
	clipboard: Array<string>
	// NOTE: What `vscode.debug.startDebugging` was handed, in order. A Debug
	// gesture is a launch configuration and nothing else, so this is the whole
	// of what a spec has to read.
	debugSessions: Array<{
		folder: unknown
		configuration: Record<string, unknown>
	}>
	refuseDebugStart: () => void
	editors: Array<StubEditor>
	deletions: Array<(uri: StubUri) => void>
	// NOTE: The client's own settings, so a spec can read back a setting the
	// view WROTE — running with coverage turns `essence.tests.coverage` on.
	settings: Record<string, unknown>
	updates: Array<{
		section: string
		key: string
		value: unknown
		target: number | undefined
	}>
	answerMessageWith: (action: string | undefined) => void
	editor: (filePath: string, languageId?: string) => StubEditor
	// NOTE: The module object is registered once for the whole spec file — a
	// module can not be re-registered under an import that already happened —
	// so what a spec gets between tests is this, rather than a new stub.
	reset: () => void
}

function uriOf(filePath: string): StubUri {
	return {
		fsPath: filePath,
		scheme: "file",
		toString: () => `file://${filePath}`,
	}
}

export function createStub(): Stub {
	let runs: Array<StubTestRun> = []
	let decorations: Array<{
		options: Record<string, unknown>
		disposals: number
	}> = []
	let channel = { lines: [] as Array<string>, shown: 0, disposals: 0 }
	let messages: Array<{ text: string; actions: Array<string> }> = []
	let clipboard: Array<string> = []
	let debugSessions: Array<{
		folder: unknown
		configuration: Record<string, unknown>
	}> = []
	let debugTerminations: Array<(session: { name: unknown }) => void> = []
	let debugStarts = true
	let editors: Array<StubEditor> = []
	let deletions: Array<(uri: StubUri) => void> = []
	let answer: string | undefined = undefined
	// NOTE: The client's own settings, so that a gesture which WRITES one — the
	// coverage profile turning `essence.tests.coverage` on — can be read back.
	let settings: Record<string, unknown> = {}
	let updates: Array<{
		section: string
		key: string
		value: unknown
		target: number | undefined
	}> = []
	let controller = {
		id: "",
		label: "",
		items: new StubTestItemCollection(null),
		profiles: [] as Array<StubProfile>,
		refreshHandler: undefined as (() => unknown) | undefined,
		disposals: 0,
		createTestItem: (id: string, label: string, uri: StubUri | undefined) =>
			new StubTestItem(id, label, uri),
		createTestRun: (request: unknown, name?: string, persist?: boolean) => {
			let run = new StubTestRun(request, name, persist)

			runs.push(run)

			return run
		},
		createRunProfile: (
			label: string,
			kind: number,
			run: (request: unknown, token: unknown) => unknown,
			isDefault: boolean,
			tag: { id: string } | undefined,
		) => {
			let profile: StubProfile = {
				label,
				kind,
				tag,
				isDefault,
				run,
				disposals: 0,
				dispose: () => {
					profile.disposals += 1
				},
			}

			controller.profiles.push(profile)

			return profile
		},
		dispose: () => {
			controller.disposals += 1
		},
	}

	// NOTE: The classes the view constructs, flattened into plain records — a
	// spec reading `message.expected` should not have to know which of VS
	// Code's two constructors made it.
	let module: Record<string, unknown> = {
		tests: {
			createTestController: (id: string, label: string) => {
				controller.id = id
				controller.label = label

				return controller
			},
		},
		window: {
			get visibleTextEditors() {
				return editors
			},
			createOutputChannel: () => ({
				appendLine: (line: string) => channel.lines.push(line),
				show: () => {
					channel.shown += 1
				},
				dispose: () => {
					channel.disposals += 1
				},
			}),
			createTextEditorDecorationType: (
				options: Record<string, unknown>,
			) => {
				let decoration = {
					options,
					disposals: 0,
					dispose: () => {
						decoration.disposals += 1
					},
				}

				decorations.push(decoration)

				return decoration
			},
			showInformationMessage: (
				text: string,
				...actions: Array<string>
			) => {
				messages.push({ text, actions })

				return Promise.resolve(answer)
			},
		},
		// NOTE: A debug session that starts and ends at once. What a spec reads
		// back is the configuration — which file, which ids — and the loop that
		// waits for one session before starting the next needs the terminate
		// listener to be called, or a selection covering two files would hang.
		debug: {
			startDebugging: (
				folder: unknown,
				configuration: Record<string, unknown>,
			) => {
				debugSessions.push({ folder, configuration })

				queueMicrotask(() => {
					// NOTE: A copy, because a listener disposes itself as it
					// runs and would otherwise be spliced out from under the
					// walk.
					let listeners = debugTerminations.slice()

					for (let listener of listeners) {
						listener({ name: configuration.name })
					}
				})

				return Promise.resolve(debugStarts)
			},
			onDidTerminateDebugSession: (
				listener: (session: { name: unknown }) => void,
			) => {
				debugTerminations.push(listener)

				return {
					dispose: () => {
						let at = debugTerminations.indexOf(listener)

						if (at !== -1) {
							debugTerminations.splice(at, 1)
						}
					},
				}
			},
			registerDebugConfigurationProvider: () => ({ dispose: () => {} }),
			registerDebugAdapterDescriptorFactory: () => ({
				dispose: () => {},
			}),
		},
		workspace: {
			workspaceFolders: [{ uri: uriOf("/repo") }],
			getWorkspaceFolder: (uri: StubUri) =>
				uri.fsPath.startsWith("/repo")
					? { uri: uriOf("/repo") }
					: undefined,
			getConfiguration: (section: string) => ({
				get: (key: string) => settings[`${section}.${key}`],
				update: (key: string, value: unknown, target?: number) => {
					settings[`${section}.${key}`] = value
					updates.push({ section, key, value, target })

					return Promise.resolve()
				},
			}),
			createFileSystemWatcher: () => ({
				onDidDelete: (listener: (uri: StubUri) => void) => {
					deletions.push(listener)

					return { dispose: () => {} }
				},
				dispose: () => {},
			}),
		},
		env: {
			clipboard: {
				writeText: (text: string) => {
					clipboard.push(text)

					return Promise.resolve()
				},
			},
		},
		Uri: {
			file: uriOf,
			parse: (value: string) => ({ ...uriOf(value), scheme: "data" }),
		},
		Range: StubRangeValue,
		Location: class {
			uri: StubUri
			range: StubRange

			constructor(uri: StubUri, range: StubRange) {
				this.uri = uri
				this.range = range
			}
		},
		TestMessage: Object.assign(
			class {
				text: string
				expected: string | null = null
				actual: string | null = null
				location: { uri: StubUri; range: StubRange } | null = null

				constructor(text: string) {
					this.text = text
				}
			},
			{
				diff: (text: string, expected: string, actual: string) => ({
					text,
					expected,
					actual,
					location: null,
				}),
			},
		),
		TestRunRequest: class {
			include: Array<StubTestItem> | undefined
			exclude: Array<StubTestItem> | undefined
			profile: StubProfile | undefined

			constructor(
				include?: Array<StubTestItem>,
				exclude?: Array<StubTestItem>,
				profile?: StubProfile,
			) {
				this.include = include
				this.exclude = exclude
				this.profile = profile
			}
		},
		TestCoverageCount: class {
			covered: number
			total: number

			constructor(covered: number, total: number) {
				this.covered = covered
				this.total = total
			}
		},
		FileCoverage: class {
			uri: StubUri
			statementCoverage: StubCount
			branchCoverage: StubCount | undefined
			declarationCoverage: StubCount | undefined

			constructor(
				uri: StubUri,
				statementCoverage: StubCount,
				branchCoverage?: StubCount,
				declarationCoverage?: StubCount,
			) {
				this.uri = uri
				this.statementCoverage = statementCoverage
				this.branchCoverage = branchCoverage
				this.declarationCoverage = declarationCoverage
			}
		},
		StatementCoverage: class {
			kind = "statement"
			executed: number | boolean
			location: unknown
			branches: Array<unknown>

			constructor(
				executed: number | boolean,
				location: unknown,
				branches: Array<unknown> = [],
			) {
				this.executed = executed
				this.location = location
				this.branches = branches
			}
		},
		BranchCoverage: class {
			kind = "branch"
			executed: number | boolean
			location: unknown
			label: string | undefined

			constructor(
				executed: number | boolean,
				location?: unknown,
				label?: string,
			) {
				this.executed = executed
				this.location = location
				this.label = label
			}
		},
		DeclarationCoverage: class {
			kind = "declaration"
			name: string
			executed: number | boolean
			location: unknown

			constructor(
				name: string,
				executed: number | boolean,
				location: unknown,
			) {
				this.name = name
				this.executed = executed
				this.location = location
			}
		},
		Position: class {
			line: number
			character: number

			constructor(line: number, character: number) {
				this.line = line
				this.character = character
			}
		},
		TestTag: class {
			id: string

			constructor(id: string) {
				this.id = id
			}
		},
		MarkdownString: class {
			value = ""

			appendCodeblock(text: string): this {
				this.value += text

				return this
			}
		},
		TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		DecorationRangeBehavior: { ClosedClosed: 3 },
		OverviewRulerLane: { Right: 4 },
	}

	return {
		module,
		controller,
		runs,
		decorations,
		channel,
		messages,
		clipboard,
		debugSessions,
		refuseDebugStart: () => {
			debugStarts = false
		},
		editors,
		deletions,
		settings,
		updates,
		answerMessageWith: (action) => {
			answer = action
		},
		reset: () => {
			runs.length = 0
			decorations.length = 0
			channel.lines.length = 0
			channel.shown = 0
			channel.disposals = 0
			messages.length = 0
			clipboard.length = 0
			debugSessions.length = 0
			debugTerminations.length = 0
			debugStarts = true
			editors.length = 0
			deletions.length = 0
			answer = undefined

			for (let key of Object.keys(settings)) {
				delete settings[key]
			}

			updates.length = 0
			controller.items.replace([])
			controller.profiles.length = 0
			controller.refreshHandler = undefined
			controller.disposals = 0
		},
		editor: (filePath, languageId = "essence") => {
			let drawn = new Map<unknown, Array<unknown>>()
			let editor: StubEditor = {
				document: { languageId, uri: uriOf(filePath) },
				drawn,
				setDecorations: (type, ranges) => {
					drawn.set(type, ranges)
				},
			}

			editors.push(editor)

			return editor
		},
	}
}
