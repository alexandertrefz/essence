import path from "node:path"

import * as vscode from "vscode"

import {
	applyBatch,
	commandFor,
	coverageLinesOf,
	coverageOf,
	createState,
	declarationsOf,
	decorationsOf,
	describeBatch,
	describeCoverage,
	failedIdsOf,
	fileKey,
	forgetFile,
	messagesOf,
	outputOf,
	tagsOf,
	TEST_RUN_VERSION,
	treeOf,
	uncoveredLinesOf,
} from "./testModel.js"

// NOTE: The half of the Test Explorer that talks to VS Code. Everything it
// DECIDES is in `testModel.js`; what is left here is the API — a
// TestController, its run profiles, the decorations, and the bookkeeping that
// ties a run VS Code asked for to the notification that answers it.
//
// NOTE: The Server owns the run. It holds the session, the compiled bundles and
// the results, and it re-runs on every edit whether or not anybody pressed
// anything — so a "run" here is a REQUEST, and its results arrive on the same
// notification an edit produces. That is why run objects are kept by cycle
// number rather than awaited.

// #region Drawing

// NOTE: The colours are baked into the icons rather than taken from the theme: a
// gutter icon is an image, and VS Code has no themable one. These are the values
// its own testing icons use, which read on a light and a dark background alike.
const COLOURS = {
	passed: "#3fb950",
	failed: "#f85149",
	skipped: "#8b949e",
	notFocused: "#d29922",
	// NOTE: The same grey a skipped test is marked in, at half the width — a
	// line nothing ran and a test nobody ran are the same news about different
	// things, and a third colour in the gutter would be a third thing to learn.
	uncovered: "#8b949e",
}

function icon(svg) {
	return vscode.Uri.parse(
		`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
	)
}

// NOTE: A bar down the gutter beside the LINES OF A TEST, rather than a dot on
// its first line. VS Code's own Testing gutter already owns that first line — it
// draws the run/pass/fail icon there — and a second icon on it would be two
// answers to one question. What it does not draw is the body, which is what a
// reader scrolling a file is looking at.
function bar(colour) {
	return icon(
		`<svg xmlns="http://www.w3.org/2000/svg" width="6" height="18">` +
			`<rect x="2" y="0" width="2" height="18" fill="${colour}"/></svg>`,
	)
}

function dot(colour) {
	return icon(
		`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
			`<circle cx="5" cy="5" r="3.5" fill="${colour}"/></svg>`,
	)
}

function createDecorations() {
	let gutter = (colour) =>
		vscode.window.createTextEditorDecorationType({
			gutterIconPath: bar(colour),
			gutterIconSize: "contain",
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		})

	return {
		passed: gutter(COLOURS.passed),
		failed: gutter(COLOURS.failed),
		skipped: gutter(COLOURS.skipped),
		notFocused: gutter(COLOURS.notFocused),
		// NOTE: The one line inside a test that failed, which the test's own bar
		// cannot point at. A dot rather than a bar, so the two read apart at a
		// glance, and it reaches the overview ruler because a failure scrolled
		// off the screen is the one a reader is looking for.
		expects: vscode.window.createTextEditorDecorationType({
			gutterIconPath: dot(COLOURS.failed),
			gutterIconSize: "contain",
			overviewRulerColor: COLOURS.failed,
			overviewRulerLane: vscode.OverviewRulerLane.Right,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		}),
		// NOTE: A line nothing ran. VS Code's own coverage view draws this too
		// — once a reader has opened it — and this is drawn whether or not they
		// have: what a coverage run is FOR is being told, while reading the
		// file, that a line was never reached.
		uncovered: vscode.window.createTextEditorDecorationType({
			gutterIconPath: bar(COLOURS.uncovered),
			gutterIconSize: "contain",
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		}),
	}
}

// NOTE: Positions are the Compiler's throughout — 1-based line, 1-based column —
// and VS Code's are 0-based in both. Converted here and nowhere else.
function toRange(range) {
	return new vscode.Range(
		range.start.line - 1,
		range.start.column - 1,
		range.end.line - 1,
		range.end.column - 1,
	)
}

// NOTE: One decoration per LINE. A gutter icon over a range is drawn once for
// each line the range covers, and spelling that out is cheaper than depending
// on it.
function lineRanges(marks) {
	let ranges = []

	for (let mark of marks) {
		for (let line = mark.start; line <= mark.end; line += 1) {
			ranges.push(new vscode.Range(line - 1, 0, line - 1, 0))
		}
	}

	return ranges
}

function testItemsUnder(item, into) {
	if (item.children.size === 0) {
		into.push(item)

		return into
	}

	item.children.forEach((child) => testItemsUnder(child, into))

	return into
}

// #endregion

export function createTestView(options) {
	let state = createState()
	// NOTE: Every item this controller holds, by id, so that an edit which MOVES
	// a test keeps its item — its state, its expansion, its selection — rather
	// than replacing it with an identical one. The id is structural, so a test
	// stops being itself only when its name or its suite changes.
	let items = new Map()
	let controller = vscode.tests.createTestController(
		"essence",
		"Essence Tests",
	)
	let output = vscode.window.createOutputChannel("Essence Tests")
	let decorations = createDecorations()
	// NOTE: The runs VS Code is showing, by the cycle number each answers. A
	// notification is what ends one, and most notifications answer a cycle
	// nobody asked for — every edit produces one.
	let runs = new Map()
	// NOTE: A run made for a request whose cycle number has not come back yet.
	// The Server sends the `start` notification from inside the request handler,
	// so the notification routinely arrives BEFORE the response naming the cycle
	// it belongs to.
	let requested = null
	let tagProfiles = new Map()

	function log(line) {
		output.appendLine(line)
	}

	// #region The tree

	function describeSite(node) {
		if (node.site.skipped !== null) {
			return `skipped — ${node.site.skipped}`
		}

		if (node.state === "not-focused") {
			return "not focused"
		}

		if (node.state === "deselected") {
			return "not run"
		}

		return node.site.focused ? "focused" : undefined
	}

	function syncChildren(collection, nodes, uri) {
		let children = nodes.map((node, index) => {
			let item =
				items.get(node.id) ??
				controller.createTestItem(node.id, node.label, uri)

			item.label = node.label
			// NOTE: The Explorer sorts by label unless it is told otherwise, and
			// the order a file's tests are READ in is the order they were
			// written in.
			item.sortText = String(index).padStart(6, "0")
			items.set(node.id, item)

			if (node.kind === "suite") {
				// NOTE: A suite has no Position of its own — the manifest
				// carries tests, and a suite is the path they share — so it gets
				// no range, and VS Code lists it in the Explorer only.
				item.range = undefined
				item.tags = []
				syncChildren(item.children, node.children, uri)

				return item
			}

			item.range = toRange(node.site.range)
			item.tags = node.tags.map((tag) => new vscode.TestTag(tag))
			item.description = describeSite(node)
			item.children.replace([])

			return item
		})

		collection.replace(children)
	}

	// NOTE: Everything under an item stops being known when the item goes. An
	// entry left behind for an item nothing holds any more would be re-adopted
	// by the next test to be given that id.
	function forget(item) {
		items.delete(item.id)
		item.children.forEach(forget)
	}

	function syncFile(file) {
		let uri = vscode.Uri.file(file)
		let key = fileKey(file)
		let nodes = treeOf(state, file)
		let item = items.get(key)

		if (nodes.length === 0) {
			if (item !== undefined) {
				forget(item)
				controller.items.delete(key)
			}

			return
		}

		if (item === undefined) {
			item = controller.createTestItem(key, path.basename(file), uri)
			controller.items.add(item)
			items.set(key, item)
		}

		syncChildren(item.children, nodes, uri)
	}

	// #endregion

	// #region Reporting what a cycle found

	function itemsOfFiles(files) {
		let covered = []

		for (let file of files) {
			let item = items.get(fileKey(file))

			if (item !== undefined) {
				covered.push(item)
			}
		}

		return covered
	}

	function beginRun(notification) {
		let existing = runs.get(notification.run)

		if (existing !== undefined) {
			return existing
		}

		let run = controller.createTestRun(
			new vscode.TestRunRequest(
				itemsOfFiles(notification.files),
				undefined,
				// NOTE: The run is attributed to the coverage profile exactly
				// when there is coverage to attach — VS Code shows what a run
				// counted through the profile it ran under, and a run that
				// counted nothing under a Coverage profile would show an empty
				// report rather than none.
				(notification.coverage?.files.length ?? 0) > 0
					? coverageProfile
					: undefined,
			),
			"Essence tests",
			// NOTE: A cycle nobody asked for is not worth a line in the Test
			// Results history; a burst of typing would otherwise be twenty.
			false,
		)

		runs.set(notification.run, run)

		return run
	}

	function markEnqueued(notification) {
		let narrowed = new Set(notification.ids ?? [])
		let run = beginRun(notification)

		for (let item of itemsOfFiles(notification.files)) {
			for (let test of testItemsUnder(item, [])) {
				if (narrowed.size === 0 || narrowed.has(test.id)) {
					run.enqueued(test)
				}
			}
		}
	}

	function testMessage(message, uri, item) {
		let built =
			message.expected === null
				? new vscode.TestMessage(message.text)
				: vscode.TestMessage.diff(
						message.text,
						message.expected,
						message.actual,
					)

		built.location = new vscode.Location(
			uri,
			message.range === null
				? (item.range ?? new vscode.Range(0, 0, 0, 0))
				: toRange(message.range),
		)

		return built
	}

	// NOTE: Every test of every file the cycle covered, told to VS Code. A file
	// the batch had nothing for is reported out of what the client still holds:
	// an item left enqueued spins forever, and what it last did is a truer
	// answer than a spinner.
	function report(notification) {
		let run = beginRun(notification)

		runs.delete(notification.run)

		for (let file of notification.files) {
			let entry = state.files.get(file)

			if (entry === undefined) {
				continue
			}

			let uri = vscode.Uri.file(file)

			for (let site of entry.sites) {
				let item = items.get(site.id)
				let record = entry.records.get(site.id)

				if (item === undefined || record === undefined) {
					continue
				}

				let text = outputOf(record)

				if (text !== "") {
					// NOTE: The Test Results terminal is a terminal: it needs
					// carriage returns, and text that carries only newlines
					// staircases down the screen.
					run.appendOutput(
						text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"),
						undefined,
						item,
					)
				}

				switch (record.state) {
					case "passed":
						run.passed(item, record.duration)
						break
					case "failed":
						run.failed(
							item,
							messagesOf(record).map((message) =>
								testMessage(message, uri, item),
							),
							record.duration,
						)
						break
					default:
						// NOTE: Skipped, not focused and deselected are all "did
						// not run" as far as VS Code has words for it. Which of
						// the three it was is on the item's description, where
						// the reason is worth reading.
						run.skipped(item)
						break
				}
			}
		}

		addCoverage(run, notification)
		run.end()
	}

	// NOTE: What the run counted, told to VS Code — the summary per file here,
	// and the per-line detail on demand through the profile below. A Match arm
	// and a Choice Case are reported as DECLARATIONS: they are things the
	// source declares, they are counted one by one, and an exhaustive language
	// can say which of them nothing reached without guessing. That is the
	// closest thing the Testing API has to what this language knows, and it
	// wants no view of its own.
	function addCoverage(run, notification) {
		let coverage = notification.coverage

		if (coverage === undefined || coverage.files.length === 0) {
			return
		}

		for (let file of coverage.files) {
			if (file.module === null) {
				continue
			}

			let declarations = declarationsOf(state, file.module)

			run.addCoverage(
				new vscode.FileCoverage(
					vscode.Uri.file(file.module),
					new vscode.TestCoverageCount(
						file.lines.covered,
						file.lines.total,
					),
					new vscode.TestCoverageCount(
						file.branches.covered,
						file.branches.total,
					),
					new vscode.TestCoverageCount(
						declarations.filter(
							(declaration) => declaration.count > 0,
						).length,
						declarations.length,
					),
				),
			)
		}
	}

	// NOTE: Asked for once a reader opens the coverage view on a file, which is
	// why the detail is built here rather than sent with every cycle.
	function detailedCoverage(fileCoverage) {
		let file = fileCoverage.uri.fsPath
		let coverage = coverageOf(state, file)

		if (coverage === null) {
			return []
		}

		let details = coverageLinesOf(coverage).map(
			(line) =>
				new vscode.StatementCoverage(
					line.count,
					new vscode.Position(line.line - 1, 0),
					line.branches.map(
						(branch) =>
							new vscode.BranchCoverage(
								branch.count,
								new vscode.Position(branch.line - 1, 0),
								branch.label,
							),
					),
				),
		)

		for (let declaration of declarationsOf(state, file)) {
			details.push(
				new vscode.DeclarationCoverage(
					declaration.name,
					declaration.count,
					toRange(declaration.position),
				),
			)
		}

		return details
	}

	// #endregion

	// #region Decorations

	function draw(editor) {
		if (editor.document.languageId !== "essence") {
			return
		}

		let marks = decorationsOf(state, editor.document.uri.fsPath)

		editor.setDecorations(decorations.passed, lineRanges(marks.passed))
		editor.setDecorations(decorations.failed, lineRanges(marks.failed))
		editor.setDecorations(decorations.skipped, lineRanges(marks.skipped))
		editor.setDecorations(
			decorations.notFocused,
			lineRanges(marks.notFocused),
		)
		editor.setDecorations(
			decorations.expects,
			marks.expects.map((mark) => ({
				range: toRange(mark.range),
				hoverMessage: new vscode.MarkdownString().appendCodeblock(
					mark.text,
					"text",
				),
			})),
		)

		let coverage = coverageOf(state, editor.document.uri.fsPath)

		editor.setDecorations(
			decorations.uncovered,
			coverage === null ? [] : lineRanges(uncoveredLinesOf(coverage)),
		)
	}

	function redraw() {
		for (let editor of vscode.window.visibleTextEditors) {
			draw(editor)
		}
	}

	// #endregion

	// #region Running

	// NOTE: What a request asks the Server for. A whole FILE is asked for as a
	// file rather than as the ids it held last time — a test written since the
	// last cycle has no id here yet, and running the file is what finds it.
	//
	// NOTE: And a request over NOTHING asks for nothing in particular, which
	// the Server reads as the whole workspace. Listing the files this client
	// knows instead would leave out the file whose first test was written a
	// moment ago — the one case where "run everything" is what a reader means
	// and this side could not know it.
	function selectionOf(request) {
		if (request.include === undefined || request.include.length === 0) {
			return { ids: [], files: [] }
		}

		let excluded = new Set((request.exclude ?? []).map((item) => item.id))
		let ids = []
		let files = []

		for (let item of request.include) {
			if (item.parent === undefined && item.uri !== undefined) {
				files.push(item.uri.fsPath)

				continue
			}

			for (let test of testItemsUnder(item, [])) {
				if (!excluded.has(test.id)) {
					ids.push(test.id)
				}
			}
		}

		// NOTE: Naming ids narrows the whole cycle, files included — so a
		// selection holding both is spelled out entirely in ids, or the files in
		// it would run only the tests the other half named.
		if (ids.length > 0 && files.length > 0) {
			for (let item of itemsOfFiles(files)) {
				for (let test of testItemsUnder(item, [])) {
					if (!excluded.has(test.id)) {
						ids.push(test.id)
					}
				}
			}

			return { ids, files: [] }
		}

		return { ids, files }
	}

	async function ask(testRun, selection, token) {
		let cycle = null

		token?.onCancellationRequested(() => {
			// NOTE: The Server cannot be told to stop — a cycle is a Worker
			// compiling, and cancelling it would throw away a compile that is
			// about to answer. What cancelling means here is that VS Code stops
			// waiting; the results still arrive, and the next batch draws them.
			if (cycle !== null) {
				runs.delete(cycle)
			}

			testRun.end()
		})

		requested = testRun

		let answer = await options.runTests(selection)

		if (answer === null || answer === undefined || answer.run === null) {
			log("nothing ran — no test file matched what was asked for.")

			if (requested === testRun) {
				requested = null
			}

			testRun.end()

			return
		}

		cycle = answer.run

		if (requested === testRun) {
			requested = null
			// NOTE: A request made while a cycle is already going is answered
			// with THAT cycle's number — the Server folds the two together
			// rather than starting a second Worker — so a run may already be
			// registered under it. Two runs can not both be the one that ends,
			// and the one a reader pressed is the one to keep; the other is a
			// cycle nobody asked for, and its results land in this one.
			runs.get(answer.run)?.end()
			runs.set(answer.run, testRun)
		}
	}

	// NOTE: Marked as waiting before the Server has said anything, so that a
	// gesture answers instantly rather than after a round trip. The `start`
	// notification marks the same tests again, which costs nothing and covers
	// the tests this side could not name.
	function enqueue(testRun, items) {
		for (let item of items) {
			for (let test of testItemsUnder(item, [])) {
				testRun.enqueued(test)
			}
		}

		return testRun
	}

	async function run(request, token) {
		let testRun = enqueue(
			controller.createTestRun(request),
			request.include ?? [],
		)

		await ask(testRun, selectionOf(request), token)
	}

	function debug(request) {
		let testRun = controller.createTestRun(request)
		// NOTE: What to run instead, handed over rather than apologised for.
		let command = commandFor(
			(request.include ?? [])
				.flatMap((item) => testItemsUnder(item, []))
				.map((item) => ({
					label: item.label,
					file: item.uri?.fsPath ?? "",
				})),
		)

		log(
			"debugging one test is not wired up yet: the debug adapter has to " +
				`compile the tests section and run one by id. Run it: ${command}`,
		)
		void vscode.window
			.showInformationMessage(
				"Essence: debugging a single test is not wired up yet — the " +
					"debug adapter has to compile the tests section and select " +
					`one by id. Run it instead: ${command}`,
				"Copy command",
			)
			.then((chosen) => {
				if (chosen !== undefined) {
					void vscode.env.clipboard.writeText(command)
				}
			})
		testRun.end()
	}

	// NOTE: One profile per tag any test of the workspace carries, rebuilt as
	// those tags change: VS Code offers a profile whether or not anything would
	// run under it, so a tag nothing carries any more must stop offering one.
	function syncTagProfiles() {
		let tags = new Set(tagsOf(state))

		for (let [tag, profile] of tagProfiles) {
			if (!tags.has(tag)) {
				profile.dispose()
				tagProfiles.delete(tag)
			}
		}

		for (let tag of tags) {
			if (tagProfiles.has(tag)) {
				continue
			}

			tagProfiles.set(
				tag,
				controller.createRunProfile(
					`Run ${tag}`,
					vscode.TestRunProfileKind.Run,
					(request, token) => run(request, token),
					false,
					new vscode.TestTag(tag),
				),
			)
		}
	}

	// NOTE: A file that is GONE stops being reported on rather than being
	// reported as empty — the session simply stops naming it in a batch — so
	// the news that its tests no longer exist can only come from the file
	// system. Deletions only: a create or a change is a run, and a run says
	// what it found.
	let deletions = vscode.workspace.createFileSystemWatcher(
		"**/*.es",
		true,
		true,
		false,
	)

	deletions.onDidDelete((uri) => {
		if (!forgetFile(state, uri.fsPath)) {
			return
		}

		syncFile(uri.fsPath)
		syncTagProfiles()
		redraw()
	})

	// NOTE: The default profile is what the ▶ beside a test sends.
	let runProfile = controller.createRunProfile(
		"Run",
		vscode.TestRunProfileKind.Run,
		(request, token) => run(request, token),
		true,
	)
	// NOTE: Offered although it refuses, because the gesture exists whether or
	// not this extension names it: a reader who right-clicks a test and finds no
	// Debug at all learns nothing, and one who finds a Debug that starts the
	// program under test learns something false.
	let debugProfile = controller.createRunProfile(
		"Debug",
		vscode.TestRunProfileKind.Debug,
		(request) => debug(request),
		false,
	)
	// NOTE: Running WITH COVERAGE is the same run — the Server owns it, and it
	// counts what it reaches only when `essence.tests.coverage` says so. So the
	// gesture turns that setting on: pressing "Run with Coverage" and being
	// shown nothing because a setting was off is the worst of the readings, and
	// the setting is written where a reader can see it and turn it back off.
	let coverageProfile = controller.createRunProfile(
		"Run with Coverage",
		vscode.TestRunProfileKind.Coverage,
		async (request, token) => {
			await askForCoverage()
			await run(request, token)
		},
		false,
	)

	coverageProfile.loadDetailedCoverage = (_run, fileCoverage) =>
		Promise.resolve(detailedCoverage(fileCoverage))

	async function askForCoverage() {
		let settings = vscode.workspace.getConfiguration("essence.tests")

		if (settings.get("coverage") === true) {
			return
		}

		// NOTE: Workspace settings need a workspace. A single file opened on
		// its own has none, and writing there rejects — so the setting goes to
		// the user's own where there is nowhere else to put it.
		let folders = vscode.workspace.workspaceFolders ?? []
		let target =
			folders.length === 0
				? vscode.ConfigurationTarget.Global
				: vscode.ConfigurationTarget.Workspace

		try {
			await settings.update("coverage", true, target)
		} catch (error) {
			// NOTE: And a setting that could not be written is not a reason to
			// refuse the run. The tests still run; what is missing is the
			// counting, and the line below says so.
			log(`could not turn essence.tests.coverage on: ${String(error)}`)

			return
		}

		// NOTE: The Server reads its configuration on its own schedule and has
		// to compile again before anything is counted, so the run this press
		// starts is very likely the last uninstrumented one. The cycle after it
		// fills the coverage view in.
		log(
			"turned essence.tests.coverage on — every run counts what it " +
				"reaches from the next cycle on, until it is turned off",
		)
	}

	// NOTE: Refresh is the gesture for "I do not believe what I am looking at",
	// which is a run of everything rather than of what this client happens to
	// hold.
	controller.refreshHandler = () => options.runTests({ ids: [], files: [] })

	// #endregion

	// #region What the outside calls

	function handle(notification) {
		if (notification?.version !== TEST_RUN_VERSION) {
			log(
				"ignoring a test run this extension does not understand " +
					`(payload version ${notification?.version}, expected ${TEST_RUN_VERSION}). ` +
					"The Language Server and the extension are different versions.",
			)

			return
		}

		// NOTE: A cycle that never ended — the session was switched off, or a
		// Worker died — would leave VS Code spinning forever. A newer cycle
		// starting is the news that no older one is coming back.
		for (let [number, open] of runs) {
			if (number < notification.run) {
				open.end()
				runs.delete(number)
			}
		}

		if (notification.kind === "start") {
			if (requested !== null && notification.reason === "request") {
				runs.set(notification.run, requested)
				requested = null
			}

			markEnqueued(notification)

			return
		}

		let applied = applyBatch(state, notification)

		if (applied === null) {
			return
		}

		for (let file of applied.changed) {
			syncFile(file)
		}

		syncTagProfiles()
		report(notification)
		redraw()
		log(describeBatch(notification))

		if (applied.covered.length > 0) {
			log(describeCoverage(state.coverage))
		}
	}

	async function runFailed() {
		let ids = failedIdsOf(state)

		if (ids.length === 0) {
			void vscode.window.showInformationMessage(
				"Essence: no test has failed since the session started.",
			)

			return
		}

		let covered = ids
			.map((id) => items.get(id))
			.filter((item) => item !== undefined)

		await ask(
			enqueue(
				controller.createTestRun(new vscode.TestRunRequest(covered)),
				covered,
			),
			{ ids, files: [] },
			undefined,
		)
	}

	// NOTE: What the Run lens sends. It goes through here rather than straight to
	// the Server so that a run started from a lens shows in the Test Explorer
	// like every other one — and so that a lens pressed before anything has run,
	// where no id is known yet, still runs the file it sits in.
	async function runIds(ids, files) {
		let covered = ids
			.map((id) => items.get(id))
			.filter((item) => item !== undefined)

		await ask(
			enqueue(
				controller.createTestRun(new vscode.TestRunRequest(covered)),
				covered,
			),
			covered.length === 0 ? { ids: [], files } : { ids, files: [] },
			undefined,
		)
	}

	// NOTE: A Language Server that restarted is a session that starts over: it
	// re-runs everything it finds, so what this holds is at best a copy and at
	// worst a file it will never mention again.
	function reset() {
		state = createState()
		items.clear()
		controller.items.replace([])

		for (let run of runs.values()) {
			run.end()
		}

		runs.clear()
		requested = null
		// NOTE: A tag is a tag some test carries, and no test carries anything
		// any more.
		syncTagProfiles()
		redraw()
	}

	function dispose() {
		for (let run of runs.values()) {
			run.end()
		}

		runs.clear()

		for (let profile of tagProfiles.values()) {
			profile.dispose()
		}

		tagProfiles.clear()
		runProfile.dispose()
		debugProfile.dispose()
		coverageProfile.dispose()

		for (let decoration of Object.values(decorations)) {
			decoration.dispose()
		}

		deletions.dispose()
		controller.dispose()
		output.dispose()
	}

	return {
		handle,
		runIds,
		runFailed,
		reset,
		dispose,
		// NOTE: An editor that has just become visible has never been drawn on.
		drawEditor: draw,
		show: () => output.show(true),
	}

	// #endregion
}
