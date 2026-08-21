import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import * as vscode from "vscode"
// NOTE: The explicit `.js` is required — under native ESM resolution an
// extensionless specifier is not resolved, and vscode-languageclient ships no
// `exports` map that would map one.
import {
	LanguageClient,
	State,
	TransportKind,
} from "vscode-languageclient/node.js"

import {
	describeEnvironment,
	describeServer,
	resolveCli,
	resolveRuntime,
	resolveServer,
} from "./launch.js"
import { createTestView } from "./testView.js"

let client
// NOTE: The Test Explorer, the gutter marks and the test output channel. It
// outlives a client — a restarted Language Server re-runs everything it finds,
// and the view is reset rather than rebuilt — so it is created once, on
// activation, and told when a run happened.
let testView
// NOTE: The `essence/testRun` subscription belongs to the client it was made on:
// a restart builds a new client, and a handler left on the old one is a handler
// that will never be called again.
let testListener
// NOTE: `onDidChangeState` belongs to the client, and a restart builds a new
// one. Held here so the subscription can be disposed with the client it came
// from — a listener left attached to a dead client keeps driving the status
// item, and after a few restarts the item is answering to all of them.
let stateListener
let outputChannel
let statusItem
let currentServer = null
// NOTE: A failure outranks the state that follows it. The client stops itself
// after refusing to initialise, so the state listener arrives second and would
// answer "stopped" — true, and the less useful of the two answers once the
// notification has been dismissed. Cleared by the next start.
let failure = null

function settings() {
	return vscode.workspace.getConfiguration("essence")
}

function workspaceRoot() {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

// NOTE: The login shell asked what VS Code failed to ask it at launch. Bounded,
// because a shell that hangs is the very reason VS Code gave up, and an
// extension that hangs with it has made nothing better; the output channel
// names the runtime it was looking for, so a slow answer is at least
// explained. Resolves to the shell's stdout, or to nothing on any failure —
// `probeLoginShell` treats both the same.
function runLoginShell(shell, args) {
	return new Promise((resolve) => {
		let output = ""
		let settled = false
		let finish = (answer) => {
			if (!settled) {
				settled = true
				resolve(answer)
			}
		}
		let child

		try {
			child = spawn(shell, args, {
				stdio: ["ignore", "pipe", "ignore"],
				env: process.env,
			})
		} catch {
			finish(undefined)

			return
		}

		let timer = setTimeout(() => {
			outputChannel.appendLine(
				`The login shell '${shell}' did not answer within 5 seconds; giving up on it.`,
			)
			child.kill()
			finish(undefined)
		}, 5000)

		child.stdout.on("data", (chunk) => {
			output += chunk.toString()
		})
		child.on("error", () => {
			clearTimeout(timer)
			finish(undefined)
		})
		child.on("close", () => {
			clearTimeout(timer)
			finish(output)
		})
	})
}

function listDirectory(directory) {
	try {
		return fs.readdirSync(directory)
	} catch {
		return []
	}
}

// NOTE: Everything `launch.js` is handed about the machine, in one place, so
// the Language Server and the debugger cannot disagree about where to look.
function runtimeContext(settingName) {
	return {
		settingName,
		env: process.env,
		home: os.homedir(),
		platform: process.platform,
		shell: process.env.SHELL,
		exists: fs.existsSync,
		list: listDirectory,
		run: runLoginShell,
	}
}

// NOTE: `essence.bun.path` and `essence.node.path` are the explicit answers;
// each runtime's `resolveRuntime` reads its own.
function findRuntime(name) {
	let settingName = `essence.${name}.path`

	return resolveRuntime(
		name,
		settings().get(`${name}.path`),
		runtimeContext(settingName),
	)
}

// NOTE: What the output channel says about how a runtime was — or was not —
// found. A runtime found anywhere but PATH (or by the setting) means PATH is
// not what the user thinks it is, which is worth a line even on success: the
// next tool to need it may not look as hard.
function reportRuntimeLookup(name, resolution) {
	if (resolution.error === undefined) {
		if (resolution.source !== "PATH" && resolution.source !== "setting") {
			outputChannel.appendLine(
				`Found '${name}' at '${resolution.path}' through its ${resolution.source}; it is not on the PATH the extension host started with.`,
			)

			for (let line of describeEnvironment(runtimeContext())) {
				outputChannel.appendLine(line)
			}
		}

		return
	}

	if (resolution.searched?.length > 0) {
		outputChannel.appendLine(
			`Looked for '${name}' in: ${resolution.searched.join(", ")}`,
		)
	}

	for (let line of describeEnvironment(runtimeContext())) {
		outputChannel.appendLine(line)
	}
}

function serverOptions(server) {
	if (server.kind === "module") {
		return { module: server.path, transport: TransportKind.stdio }
	}

	return { command: server.command, args: [server.path, "--stdio"] }
}

const statusByState = {
	[State.Starting]: { icon: "sync~spin", detail: "starting" },
	[State.Running]: { icon: "check", detail: "running" },
	[State.Stopped]: { icon: "error", detail: "stopped" },
}

function setStatus(icon, detail) {
	statusItem.text = `$(${icon}) Essence`
	statusItem.tooltip =
		`Essence Language Server — ${detail}\n` +
		(currentServer === null
			? "No Language Server resolved.\n"
			: `Using the ${describeServer(currentServer)}${currentServer.fellBack ? " (fallback — the configured server could not run)" : ""}.\n`) +
		"Click to restart it."

	statusItem.show()
}

function setFailure(detail) {
	failure = detail

	setStatus("error", detail)
}

function setStatusFromState(state) {
	let status = statusByState[state]

	if (status === undefined) {
		return
	}

	if (state === State.Stopped && failure !== null) {
		setStatus("error", failure)

		return
	}

	setStatus(status.icon, status.detail)
}

// NOTE: Everything the user is told is also written to the channel, and the
// button is the only route there that does not require knowing the channel
// exists — a notification is gone in a few seconds, and the detail worth
// reading is rarely the first line.
async function reportFailure(message) {
	outputChannel.appendLine(message)

	let choice = await vscode.window.showErrorMessage(
		`Essence: ${message}`,
		"Show Output",
	)

	if (choice === "Show Output") {
		outputChannel.show(true)
	}
}

async function reportFallback(message) {
	outputChannel.appendLine(message)

	let choice = await vscode.window.showWarningMessage(
		`Essence: ${message}`,
		"Show Output",
	)

	if (choice === "Show Output") {
		outputChannel.show(true)
	}
}

// NOTE: One attempt at one server. Answers whether it is running; a failure
// is reported here, and the caller decides whether there is another server to
// try. The spawn advice is specific to the kind: a module is forked on VS
// Code's own Node, so a failed fork is a broken bundle and not a PATH
// problem; a command is Bun, already resolved to a path that existed.
async function launch(server) {
	currentServer = server

	outputChannel.appendLine(`Starting the ${describeServer(server)}.`)

	stateListener?.dispose()

	// NOTE: Whether the handler below has already spoken. The client re-throws
	// after calling it, so `start()` rejects for a failed handshake as well as
	// for a failed spawn — and the spawn advice, shown on top of a standard
	// library that could not be read, would contradict it. Whoever spoke first
	// owns the failure.
	let reportedByHandler = false

	client = new LanguageClient(
		"essence",
		"Essence Language Server",
		serverOptions(server),
		{
			documentSelector: [
				{ scheme: "file", language: "essence" },
				// NOTE: Never-saved documents are served too. The server keys
				// documents by their URI string and never resolves one to a
				// path — the only thing it reads off a URI is whether it names
				// a standard library source, which `untitled:` cannot — and it
				// loads the standard library itself off its own location on
				// disk, so a document without a file behind it costs nothing.
				{ scheme: "untitled", language: "essence" },
			],
			outputChannel,
			initializationFailedHandler: (error) => {
				reportedByHandler = true

				// NOTE: Where the standard library's own "missing sources"
				// throw arrives — `loadStdlib` runs inside `initialize`, and
				// the message already names the directory it searched, so it
				// is passed on untouched. `false`, because the answer will not
				// change on a second attempt: the directory does not appear
				// between them.
				setFailure("initialisation failed")
				reportFailure(error?.message ?? String(error))

				return false
			},
		},
	)

	stateListener = client.onDidChangeState((event) =>
		setStatusFromState(event.newState),
	)

	try {
		await client.start()

		// NOTE: After the start, because a client refuses to be subscribed to
		// before it is running. The session begins its first cycle at
		// `initialized`, so the first batch can be in flight already — which is
		// why the view is fed rather than asked.
		testListener?.dispose()
		testListener = client.onNotification("essence/testRun", (payload) => {
			testView?.handle(payload)
		})

		return true
	} catch (error) {
		if (reportedByHandler) {
			return false
		}

		let message = error instanceof Error ? error.message : String(error)

		setFailure("failed to start")
		outputChannel.appendLine(
			`could not start the ${describeServer(server)} — ${message}`,
		)

		return false
	}
}

async function startClient(context) {
	failure = null
	currentServer = null

	// NOTE: A new Server is a new session, which re-runs everything it finds —
	// so what the view holds is at best about to be replaced and at worst about
	// a file this Server will never mention.
	testView?.reset()

	let resolution = await resolveServer(settings().get("server.path"), {
		workspaceRoot: workspaceRoot(),
		extensionPath: context.extensionPath,
		home: os.homedir(),
		exists: fs.existsSync,
		resolveBun: async () => {
			let bun = await findRuntime("bun")

			reportRuntimeLookup("bun", bun)

			return bun
		},
	})

	if (resolution.error !== undefined) {
		// NOTE: The configured server cannot run, and the bundled one can. The
		// bundled one is what runs, and the user is told in a warning rather
		// than an error — diagnostics are still coming, just not from the
		// checkout — because silently serving a stale server to someone
		// developing the compiler would be the more confusing outcome.
		if (resolution.fallback !== undefined) {
			reportFallback(
				`${resolution.error} Running the bundled Language Server instead.`,
			)

			await launch({ ...resolution.fallback, fellBack: true })

			return
		}

		setFailure("no server to run")
		reportFailure(resolution.error)

		return
	}

	if (resolution.kind === "command") {
		outputChannel.appendLine(
			`Using '${resolution.command}' (${resolution.runtimeSource}) to run it.`,
		)
	}

	if (await launch(resolution)) {
		return
	}

	// NOTE: A configured server that resolved but would not start. A source
	// entry's Bun was a path that existed a moment ago, so this is the rare
	// case — but the bundled server is still there, and still better than
	// nothing. A bundle that fails to fork has nowhere left to go, and says so.
	if (resolution.configured) {
		let bundledPath = path.join(
			context.extensionPath,
			"server",
			"server.js",
		)

		if (fs.existsSync(bundledPath) && resolution.path !== bundledPath) {
			reportFallback(
				`The configured Language Server did not start (see above). Running the bundled Language Server instead.`,
			)

			failure = null

			await launch({
				kind: "module",
				path: bundledPath,
				configured: false,
				fellBack: true,
			})

			return
		}
	}

	reportFailure(
		`could not start the ${describeServer(resolution)}. ` +
			(resolution.configured
				? "That server is what 'essence.server.path' names; clear the setting to fall back to the bundled server — rebuild it with 'bun run build' in packages/vscode-extension."
				: "Rebuild the bundled server with 'bun run build' in packages/vscode-extension, or point 'essence.server.path' at a checkout's 'packages/language-server/bin/esls'."),
	)
}

async function stopClient() {
	stateListener?.dispose()
	stateListener = undefined
	testListener?.dispose()
	testListener = undefined

	if (client === undefined) {
		return
	}

	let stopping = client

	client = undefined

	// NOTE: A client refuses to stop unless it is running — one whose start
	// failed throws instead — and a restart begins by stopping exactly that
	// client. Unguarded, the failure the user is restarting BECAUSE OF is what
	// takes the restart command down, and clicking the status item again does
	// the same thing again.
	try {
		await stopping.stop()
	} catch (error) {
		outputChannel.appendLine(
			`Stopping the Language Server failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

// NOTE: Every start and stop runs on this chain rather than concurrently. The
// restart command is bound to a status bar item, where a second click is one
// gesture away, and two restarts overlapping leak a server: the second one
// sees the `client = undefined` the first has already written, skips the stop,
// and starts a client that the first then overwrites when its own stop
// resolves — that client is now unreferenced, never stopped, and its spawned
// server lives until the window closes. Queued, a restart cannot begin until
// the one before it has finished starting, so it always has that client to
// stop.
let lifecycle = Promise.resolve()

// NOTE: The `catch` is what keeps the chain usable. A rejected link would skip
// every step queued behind it, so a single failure would mean the Language
// Server could never be started again. Neither half rejects today — both
// report their own failures — and this is what stops that from becoming
// load-bearing.
function queue(work) {
	lifecycle = lifecycle.then(work).catch((error) => {
		outputChannel.appendLine(
			`Starting or stopping the Language Server failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	})

	return lifecycle
}

// NOTE: The Debug Adapter is the CLI's own `dap` command — the same binary
// that compiles is the one that debugs, so the two can never disagree about a
// bundle or its map. A bundle runs on VS Code's own Node, the way the
// Language Server's does: `process.execPath` is the extension host, and
// `ELECTRON_RUN_AS_NODE` makes it plain Node — no lookup. Source needs Bun,
// and an installed `essence` needs finding; both go through the same
// resolution as the Language Server, and both explain themselves the same way
// when it fails.
async function createDebugAdapter() {
	let cli = resolveCli(settings().get("cli.path"), {
		workspaceRoot: workspaceRoot(),
		home: os.homedir(),
		exists: fs.existsSync,
	})

	if (cli.error !== undefined) {
		reportFailure(cli.error)

		return undefined
	}

	if (cli.kind === "module") {
		outputChannel.appendLine(
			`Starting the Debug Adapter through the ${cli.description}, run on VS Code's own Node.`,
		)

		return new vscode.DebugAdapterExecutable(
			process.execPath,
			[cli.path, "dap"],
			{ env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
		)
	}

	let runtimeName = cli.kind === "bun" ? "bun" : "essence"
	let runtime = await findRuntime(runtimeName)

	reportRuntimeLookup(runtimeName, runtime)

	if (runtime.error !== undefined) {
		reportFailure(
			cli.kind === "bun"
				? `the ${cli.description} needs Bun to run, but ${runtime.error} Set 'essence.bun.path', or point 'essence.cli.path' at a built bundle.`
				: `${runtime.error} Install the Essence CLI, or set 'essence.cli.path'.`,
		)

		return undefined
	}

	outputChannel.appendLine(
		`Starting the Debug Adapter through the ${cli.description}, run with '${runtime.path}'.`,
	)

	return new vscode.DebugAdapterExecutable(
		runtime.path,
		cli.kind === "bun" ? [cli.path, "dap"] : ["dap"],
	)
}

// NOTE: What the Run-and-Debug view offers before any launch.json exists —
// the same configuration the empty-config F5 path synthesizes, so the two
// entry points cannot drift apart.
function provideDynamicConfigurations() {
	let editor = vscode.window.activeTextEditor

	if (
		editor === undefined ||
		editor.document.languageId !== "essence" ||
		editor.document.uri.scheme !== "file"
	) {
		return []
	}

	return [
		{
			type: "essence",
			request: "launch",
			name: `Debug ${path.basename(editor.document.uri.fsPath)}`,
			program: editor.document.uri.fsPath,
		},
	]
}

// NOTE: The session itself is `essence dap`'s — the Debug Adapter compiles
// the program and drives it; this resolver only completes the configuration.
// The empty object is what F5 sends with no launch.json, and it becomes the
// same launch the contribution's `initialConfigurations` writes, built from
// the active editor.
async function resolveEssenceDebugConfiguration(folder, config) {
	if (
		config.type === undefined &&
		config.request === undefined &&
		config.name === undefined
	) {
		let editor = vscode.window.activeTextEditor

		if (
			editor === undefined ||
			editor.document.languageId !== "essence" ||
			editor.document.uri.scheme !== "file"
		) {
			reportFailure(
				"open an Essence file to debug it, or add an 'essence' configuration to launch.json.",
			)

			return undefined
		}

		config = {
			type: "essence",
			request: "launch",
			name: `Debug ${path.basename(editor.document.uri.fsPath)}`,
			program: editor.document.uri.fsPath,
			noDebug: config.noDebug,
		}
	}

	// NOTE: A precompiled `artifact` is the Adapter's business entirely; only
	// the ordinary source launch is worth validating here, where the failure
	// can be reported before a session ever starts.
	if (typeof config.artifact !== "string") {
		if (
			typeof config.program !== "string" ||
			!config.program.endsWith(".es")
		) {
			reportFailure("'program' must name a '.es' source file to debug.")

			return undefined
		}

		if (!fs.existsSync(config.program)) {
			reportFailure(`'${config.program}' does not exist.`)

			return undefined
		}
	}

	if (config.cwd === undefined && folder !== undefined) {
		config.cwd = folder.uri.fsPath
	}

	// NOTE: The program itself runs on a real Node — the Adapter speaks its
	// inspector protocol — which the Adapter would otherwise spawn as `node`
	// off its own PATH, the same PATH that may have nothing on it. Resolved
	// here, where there is a login shell to ask; a configuration that names
	// its own `runtimeExecutable` is left alone, and when nothing is found the
	// Adapter is left to try `node` and report in its own words.
	if (config.runtimeExecutable === undefined) {
		let node = await findRuntime("node")

		reportRuntimeLookup("node", node)

		if (node.error === undefined) {
			config.runtimeExecutable = node.path
		}
	}

	return config
}

export async function activate(context) {
	// NOTE: One channel for both halves of the story. The client writes its
	// own traffic wherever `outputChannel` says, and the extension writes which
	// server it spawned and why a start failed to the same place, so "what is
	// running, and what went wrong" is answered without switching views.
	outputChannel = vscode.window.createOutputChannel("Essence")

	statusItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	)
	statusItem.name = "Essence Language Server"
	statusItem.command = "essence.restartServer"

	// NOTE: Built before the client, so that the first `essence/testRun` — the
	// session starts its first cycle at `initialized` — has somewhere to land.
	testView = createTestView({
		// NOTE: The Server answers with the cycle number the results will
		// arrive under. A client that is not running answers with nothing,
		// which the view reports as "nothing ran".
		runTests: async (selection) => {
			if (client === undefined) {
				return null
			}

			try {
				return await client.sendRequest("essence/runTests", selection)
			} catch (error) {
				outputChannel.appendLine(
					`Asking the Language Server to run tests failed: ${error instanceof Error ? error.message : String(error)}`,
				)

				return null
			}
		},
	})

	context.subscriptions.push(
		outputChannel,
		statusItem,
		testView,
		// NOTE: A file opened in a second editor group, or an editor scrolled
		// back to, has never been drawn on — decorations belong to an editor
		// rather than to a document.
		vscode.window.onDidChangeVisibleTextEditors((editors) => {
			for (let editor of editors) {
				testView?.drawEditor(editor)
			}
		}),
		vscode.commands.registerCommand("essence.restartServer", () =>
			queue(async () => {
				await stopClient()
				await startClient(context)
			}),
		),
		// NOTE: What the Run lens above every `test` and every `suite` sends.
		// The server owns the run — it holds the session, the compiled bundles
		// and the results — so the whole of this is forwarding the ids it put
		// on the lens back to it. The results arrive as `essence/testRun`
		// notifications, the same ones every other edit produces.
		//
		// Deliberately not in `contributes.commands`: a command in the palette
		// is a command a reader can invoke with no test in front of them, and
		// what this needs is the ids the lens carries.
		vscode.commands.registerCommand("essence.test.run", async (item) => {
			if (item === undefined) {
				return
			}

			await testView?.runIds(item.ids ?? [], [item.filePath])
		}),
		// NOTE: What failed is what a reader is iterating on, and re-running
		// everything to get back to it is the loop this is here to shorten. It
		// runs by id rather than by file: one failure in forty is not a reason
		// to run forty.
		vscode.commands.registerCommand("essence.test.runFailed", async () => {
			await testView?.runFailed()
		}),
		vscode.commands.registerCommand("essence.test.showOutput", () => {
			testView?.show()
		}),
		// NOTE: Honest rather than absent. Debugging ONE test means compiling
		// the test bundle under the debug adapter and running the registry
		// narrowed to an id, which is the adapter's half of this feature and is
		// not wired yet — and a lens whose command does not exist reports a
		// protocol error, which tells a reader nothing at all.
		vscode.commands.registerCommand("essence.test.debug", async () => {
			await vscode.window.showInformationMessage(
				"Essence: debugging a single test is not wired up yet — the " +
					"debug adapter has to compile the tests and run one by id. " +
					"Run it instead, or debug the program it tests.",
			)
		}),
		vscode.debug.registerDebugConfigurationProvider("essence", {
			resolveDebugConfigurationWithSubstitutedVariables: (
				folder,
				config,
			) => resolveEssenceDebugConfiguration(folder, config),
		}),
		vscode.debug.registerDebugConfigurationProvider(
			"essence",
			{ provideDebugConfigurations: provideDynamicConfigurations },
			vscode.DebugConfigurationProviderTriggerKind.Dynamic,
		),
		vscode.debug.registerDebugAdapterDescriptorFactory("essence", {
			createDebugAdapterDescriptor: () => createDebugAdapter(),
		}),
		// NOTE: Only the spawn path is worth interrupting for, and only by
		// asking — a restart drops every open document's diagnostics for a
		// moment. `essence.trace.server` is deliberately absent:
		// vscode-languageclient watches it itself and applies it live.
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (
				!event.affectsConfiguration("essence.server.path") &&
				!event.affectsConfiguration("essence.bun.path")
			) {
				return
			}

			let choice = await vscode.window.showInformationMessage(
				"Essence: the Language Server's settings changed. Restart it to use them?",
				"Restart",
			)

			if (choice === "Restart") {
				await vscode.commands.executeCommand("essence.restartServer")
			}
		}),
	)

	await queue(() => startClient(context))
}

export async function deactivate() {
	await queue(stopClient)
}
