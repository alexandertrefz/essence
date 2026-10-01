import path from "node:path"

import * as vscode from "vscode"

import {
	applyBatch,
	coverageLinesOf,
	coverageMarksOf,
	coverageOf,
	createState,
	debugConfigurationsFor,
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
} from "./testModel.js"

// The half of the Test Explorer that talks to VS Code. `testModel.ts` decides
// everything; this file holds the controller, run profiles and decorations.
//
// The Server owns the run and re-runs on every edit, so a run here is a
// request whose results arrive on an ordinary notification. Run objects are
// therefore kept by cycle number rather than awaited.

// #region Drawing

// Baked into the icons, since a gutter icon is an image and cannot follow the
// theme. See "Gutter marks" in DEVELOPMENT.md.
const COLOURS = {
	passed: "#3fb950",
	failed: "#f85149",
	skipped: "#8b949e",
	notFocused: "#d29922",
	covered: "#3fb950",
	partial: "#d29922",
	uncovered: "#8b949e",
}

function icon(svg) {
	return vscode.Uri.parse(
		`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
	)
}

// A square beside each line of a test, not a bar, which a source-control
// gutter uses. Both glyphs share an 18-unit box that `contain` scales, so they
// keep their relative sizes.
function square(colour) {
	return icon(
		`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18">` +
			`<rect x="5" y="5" width="8" height="8" rx="2" fill="${colour}"/></svg>`,
	)
}

function dot(colour) {
	return icon(
		`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18">` +
			`<circle cx="9" cy="9" r="4.5" fill="${colour}"/></svg>`,
	)
}

function createDecorations() {
	let gutter = (colour) =>
		vscode.window.createTextEditorDecorationType({
			gutterIconPath: square(colour),
			gutterIconSize: "contain",
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		})

	return {
		passed: gutter(COLOURS.passed),
		failed: gutter(COLOURS.failed),
		skipped: gutter(COLOURS.skipped),
		notFocused: gutter(COLOURS.notFocused),
		// The failed line inside a test, as a dot so it reads apart from
		// the squares. It reaches the overview ruler, to find it off screen.
		expects: vscode.window.createTextEditorDecorationType({
			gutterIconPath: dot(COLOURS.failed),
			gutterIconSize: "contain",
			overviewRulerColor: COLOURS.failed,
			overviewRulerLane: vscode.OverviewRulerLane.Right,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		}),
		// What a coverage run counted, line by line, drawn whether or not
		// VS Code's coverage view is open.
		covered: gutter(COLOURS.covered),
		partial: gutter(COLOURS.partial),
		uncovered: gutter(COLOURS.uncovered),
	}
}

// The compiler's 1-based positions to VS Code's 0-based ones, here and
// nowhere else.
function toRange(range) {
	return new vscode.Range(
		range.start.line - 1,
		range.start.column - 1,
		range.end.line - 1,
		range.end.column - 1,
	)
}

// One decoration per line, rather than relying on how VS Code draws a gutter
// icon over a range.
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
	// Every item this controller holds, by id, so a moved test keeps its
	// item, state and selection. The id changes only with its name or suite.
	let items = new Map()
	let controller = vscode.tests.createTestController(
		"essence",
		"Essence Tests",
	)
	let output = vscode.window.createOutputChannel("Essence Tests")
	let decorations = createDecorations()
	// The runs VS Code is showing, by the cycle each answers. Most cycles
	// answer an edit rather than a run.
	let runs = new Map()
	// A run whose request has not answered its cycle yet. The `start`
	// notification often arrives before that answer.
	let requested = null
	// Cycles the Server has promised but not started: a request during a
	// cycle is answered with a later one. Held so it is not taken for a dead
	// cycle.
	let promised = new Set()
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
			// The Explorer sorts by label otherwise; tests keep source order.
			item.sortText = String(index).padStart(6, "0")
			items.set(node.id, item)

			if (node.kind === "suite") {
				// A suite has no Position of its own, so it gets no range
				// and appears in the Explorer only.
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

	// Drops an item and everything under it, so the next test given that id
	// gets a new item.
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
				// The coverage profile only when there is coverage to
				// attach, since VS Code would show an empty report otherwise.
				(notification.coverage?.files.length ?? 0) > 0
					? coverageProfile
					: undefined,
			),
			"Essence tests",
			// Not persisted: a burst of typing would flood the Test Results
			// history.
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

	// Every test of every file the cycle covered, told to VS Code. A file the
	// batch had nothing for reports what the client still holds, so no item is
	// left enqueued.
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
					// The Test Results terminal needs carriage returns, or
					// the lines staircase.
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
						// VS Code has one word for every test that did not
						// run. The item's description says which it was.
						run.skipped(item)
						break
				}
			}
		}

		addCoverage(run, notification)
		run.end()
	}

	// What the run counted, as a summary per file. `coverageProfile` loads the
	// detail on demand. Match arms and Choice Cases are reported as
	// declarations.
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

	// Built when the coverage view opens a file, rather than with every cycle.
	function detailedCoverage(fileCoverage) {
		let file = fileCoverage.uri.fsPath
		let coverage = coverageOf(state, file)

		if (coverage === null) {
			return []
		}

		/** @type {Array<vscode.FileCoverageDetail>} */
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
		let counted =
			coverage === null
				? { covered: [], partial: [], uncovered: [] }
				: coverageMarksOf(coverage)

		editor.setDecorations(decorations.covered, lineRanges(counted.covered))
		editor.setDecorations(decorations.partial, lineRanges(counted.partial))
		editor.setDecorations(
			decorations.uncovered,
			lineRanges(counted.uncovered),
		)
	}

	function redraw() {
		for (let editor of vscode.window.visibleTextEditors) {
			draw(editor)
		}
	}

	// #endregion

	// #region Running

	// What a request asks the Server for. A whole file is asked for as a file,
	// and an empty request as the whole workspace. See "Runs and cycles" in
	// DEVELOPMENT.md.
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

		// Ids narrow the whole cycle, so a selection holding both is
		// spelled out in ids.
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
			// A cycle cannot be stopped, so cancelling only stops VS Code
			// waiting. The results still arrive and the next batch draws them.
			if (cycle !== null) {
				runs.delete(cycle)
				promised.delete(cycle)
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
			// Two deferred gestures may share a cycle; the one pressed last
			// is kept.
			runs.get(answer.run)?.end()
			runs.set(answer.run, testRun)
			// `RunTestsResult` does not say whether the request was deferred,
			// so every answer is promised until a notification names it.
			promised.add(answer.run)
		}
	}

	// Marked as waiting at once rather than after a round trip. The `start`
	// notification marks them again, with any this side could not name.
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

	// A debug session is not a test run, so the TestRun VS Code hands over is
	// ended at once. Each file gets a session in turn, so a reader never gets
	// two debuggers at once.
	async function debug(request) {
		controller.createTestRun(request).end()

		let configurations = debugConfigurationsFor(
			(request.include ?? [])
				.flatMap((item) => testItemsUnder(item, []))
				.map((item) => ({
					label: item.label,
					file: item.uri?.fsPath ?? "",
					id: item.id,
				})),
		)

		await debugConfigurations(configurations)
	}

	async function debugConfigurations(configurations) {
		if (configurations.length === 0) {
			log("nothing to debug: the selection names no test in a file")

			return
		}

		for (let configuration of configurations) {
			let folder = vscode.workspace.getWorkspaceFolder(
				vscode.Uri.file(configuration.program),
			)

			log(
				`debugging ${configuration.tests.length} ${
					configuration.tests.length === 1 ? "test" : "tests"
				} in ${path.basename(configuration.program)}`,
			)

			// Listened for before the session starts, since a fast test can
			// end it before `startDebugging` answers.
			let ending = sessionEnding(configuration.name)
			let started = await vscode.debug.startDebugging(
				folder,
				configuration,
			)

			if (!started) {
				ending.cancel()
				log("the debug session did not start")

				return
			}

			await ending.ended
		}
	}

	// Resolved when the session of that name ends, since `startDebugging`
	// answers once it starts. Another session the reader runs is ignored.
	function sessionEnding(name) {
		let subscription = null
		/** @type {Promise<void>} */
		let ended = new Promise((resolve) => {
			subscription = vscode.debug.onDidTerminateDebugSession(
				(session) => {
					if (session !== undefined && session.name !== name) {
						return
					}

					subscription?.dispose()
					resolve()
				},
			)
		})

		return { ended, cancel: () => subscription?.dispose() }
	}

	// What the Debug lens sends: its ids, or its file before any id is known.
	async function debugIds(ids, files) {
		let covered = ids
			.map((id) => items.get(id))
			.filter((item) => item !== undefined)

		await debugConfigurations(
			covered.length === 0
				? files.map((file) => ({
						type: "essence",
						request: "launch",
						name: `${path.basename(file)} tests`,
						program: file,
						tests: [],
					}))
				: debugConfigurationsFor(
						covered.map((item) => ({
							label: item.label,
							file: item.uri?.fsPath ?? "",
							id: item.id,
						})),
					),
		)
	}

	// One profile per tag any test carries. A tag nothing carries loses its
	// profile, since VS Code would still offer it.
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

	// The session stops naming a deleted file rather than reporting it empty,
	// so only the file system says it is gone. Creates and changes are runs.
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

	// The default profile is what the ▶ beside a test sends.
	let runProfile = controller.createRunProfile(
		"Run",
		vscode.TestRunProfileKind.Run,
		(request, token) => run(request, token),
		true,
	)
	// The debugger, pointed at the selected tests rather than a Program.
	let debugProfile = controller.createRunProfile(
		"Debug",
		vscode.TestRunProfileKind.Debug,
		(request) => debug(request),
		false,
	)
	// The same run, which counts only when `essence.tests.coverage` is on.
	// So the gesture turns the setting on, where a reader can turn it off.
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

		// A single file opened on its own has no workspace settings, so the
		// user's settings take it.
		let folders = vscode.workspace.workspaceFolders ?? []
		let target =
			folders.length === 0
				? vscode.ConfigurationTarget.Global
				: vscode.ConfigurationTarget.Workspace

		try {
			await settings.update("coverage", true, target)
		} catch (error) {
			// The tests still run; only the counting is missing.
			log(`could not turn essence.tests.coverage on: ${String(error)}`)

			return
		}

		// The Server must read the setting and compile again, so counting
		// likely starts with the cycle after this run.
		log(
			"turned essence.tests.coverage on — every run counts what it " +
				"reaches from the next cycle on, until it is turned off",
		)
	}

	// Refresh runs everything, not only what this client holds.
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

		// A cycle the Server names is no longer owed.
		promised.delete(notification.run)

		// A newer cycle's start ends every older open run that is not
		// promised. See "Runs and cycles" in DEVELOPMENT.md.
		if (notification.kind === "start") {
			for (let [number, open] of runs) {
				if (number < notification.run && !promised.has(number)) {
					open.end()
					runs.delete(number)
				}
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

	// What the Run lens sends, through the Test Explorer like every other run.
	// Before any id is known, it runs the lens's file.
	async function runIds(ids, files) {
		let covered = ids
			.map((id) => items.get(id))
			.filter((item) => item !== undefined)

		// Both ids and files. See "Runs and cycles" in DEVELOPMENT.md.
		await ask(
			enqueue(
				controller.createTestRun(new vscode.TestRunRequest(covered)),
				covered,
			),
			{ ids: covered.length === 0 ? [] : ids, files },
			undefined,
		)
	}

	// What the "Accept snapshot" lens sends: a run that records what the
	// tests produce. Sources come back through `workspace/applyEdit`, so the
	// change can be undone.
	async function acceptSnapshots(ids, files) {
		let covered = ids
			.map((id) => items.get(id))
			.filter((item) => item !== undefined)

		await ask(
			enqueue(
				controller.createTestRun(new vscode.TestRunRequest(covered)),
				covered,
			),
			// Both ids and files, as the Run lens sends.
			{
				ids: covered.length === 0 ? [] : ids,
				files,
				update: true,
			},
			undefined,
		)
	}

	// A restarted Language Server starts a new session that re-runs
	// everything, so all held state goes.
	function reset() {
		state = createState()
		items.clear()
		controller.items.replace([])

		for (let run of runs.values()) {
			run.end()
		}

		runs.clear()
		// The next session counts cycles from one again.
		promised.clear()
		requested = null
		// No test carries a tag any more.
		syncTagProfiles()
		redraw()
	}

	function dispose() {
		// Every open run, or VS Code keeps spinning for it.
		for (let run of runs.values()) {
			run.end()
		}

		runs.clear()
		promised.clear()
		requested = null

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
		debugIds,
		acceptSnapshots,
		runFailed,
		reset,
		dispose,
		// For an editor that has just become visible.
		drawEditor: draw,
		show: () => output.show(true),
	}

	// #endregion
}
