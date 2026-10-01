import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import * as vscode from "vscode"
// Native ESM resolution needs the `.js`, since vscode-languageclient ships no
// `exports` map.
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
import { revealForRename } from "./renameAt.js"
import { createTestView } from "./testView.js"

let client
// The Test Explorer, the gutter marks and the test output channel. Created
// once on activation, it outlives a client and is reset on a restart.
let testView
// The `essence/testRun` subscription, which belongs to the client it was made
// on and is made again for each new client.
let testListener
// The `onDidChangeState` subscription, disposed with its client so a dead
// client stops driving the status item.
let stateListener
let outputChannel
let statusItem
let currentServer = null
// A failure outranks the "stopped" state that follows it when the client
// stops after refusing to initialise. Cleared by the next start.
let failure = null

function settings() {
	return vscode.workspace.getConfiguration("essence")
}

function workspaceRoot() {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

// Runs the login shell, bounded to five seconds, since a hanging shell is why
// VS Code gave up. Resolves to its stdout, or to nothing on any failure.
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

// Everything `launch.js` is handed about the machine, shared so the Language
// Server and the debugger look in the same places.
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

// Each runtime has its own setting, such as `essence.bun.path`.
function findRuntime(name) {
	let settingName = `essence.${name}.path`

	return resolveRuntime(
		name,
		settings().get(`${name}.path`),
		runtimeContext(settingName),
	)
}

// Reports how a runtime was found or not. One found off `PATH` without the
// setting is reported too, since the next tool may not look as hard.
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

// The message also goes to the output channel, and the button leads there. A
// notification soon goes, and the detail is rarely on its first line.
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

// One attempt at one server, answering whether it runs. A failure is reported
// here; the caller decides whether to try another server.
async function launch(server) {
	currentServer = server

	outputChannel.appendLine(`Starting the ${describeServer(server)}.`)

	stateListener?.dispose()

	// Whether `initializationFailedHandler` reported the failure. `start()`
	// rejects after it too, and must not add spawn advice on top.
	let reportedByHandler = false

	client = new LanguageClient(
		"essence",
		"Essence Language Server",
		serverOptions(server),
		{
			documentSelector: [
				{ scheme: "file", language: "essence" },
				// Never-saved documents too: the server keys documents by URI
				// and never reads one from disk.
				{ scheme: "untitled", language: "essence" },
				// The project file, which the server only reads, so a bad
				// setting is reported while it is typed rather than on save.
				{
					scheme: "file",
					language: "jsonc",
					pattern: "**/essence.json",
				},
			],
			outputChannel,
			initializationFailedHandler: (error) => {
				reportedByHandler = true

				// Where a standard library that could not be loaded is
				// reported; its message names the directory searched. `false`,
				// since a second attempt would fail the same way.
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

		// Subscribed after the start, since a client refuses it before.
		// The first batch may already be in flight, so the view is fed
		// rather than asked.
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

	// A new Server re-runs everything it finds, so the view starts empty.
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
		// The configured server cannot run, so the bundled one does, with a
		// warning: a silently stale server would confuse someone developing
		// the compiler.
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

	// A configured server that resolved but would not start falls back to the
	// bundled one. A bundle that fails to fork has nowhere left to go.
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

	// A client whose start failed throws on `stop()`, and a restart begins by
	// stopping it. The failure is logged so the restart goes on.
	try {
		await stopping.stop()
	} catch (error) {
		outputChannel.appendLine(
			`Stopping the Language Server failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

// Every start and stop runs on this chain, never concurrently. See "Restarting
// the server" in DEVELOPMENT.md.
let lifecycle = Promise.resolve()

// The `catch` keeps the chain usable: a rejected link would skip every step
// queued behind it.
function queue(work) {
	lifecycle = lifecycle.then(work).catch((error) => {
		outputChannel.appendLine(
			`Starting or stopping the Language Server failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	})

	return lifecycle
}

// The Debug Adapter is the CLI's `dap` command, so the binary that compiles
// also debugs. A bundle runs on the extension host's own executable as plain
// Node, through `ELECTRON_RUN_AS_NODE`; Bun or `essence` is found otherwise.
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

// What the Run and Debug view offers before any launch.json exists: the same
// configuration F5 builds from an empty one.
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

// Completes a configuration; the Debug Adapter compiles and drives the
// program. F5 without a launch.json sends an empty object, which becomes the
// launch `initialConfigurations` writes, for the active editor.
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

	// A source launch is checked here, before a session starts. A precompiled
	// `artifact` is left to the Adapter.
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

	// The program runs on Node, which the Adapter would spawn as `node` off a
	// `PATH` that may lack it. Found here instead, unless the configuration
	// names its own `runtimeExecutable`.
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
	// One channel for the client's traffic and for the extension's own report
	// of what it started and why a start failed.
	outputChannel = vscode.window.createOutputChannel("Essence")

	statusItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	)
	statusItem.name = "Essence Language Server"
	statusItem.command = "essence.restartServer"

	// Built before the client, since the session's first `essence/testRun`
	// follows `initialized` at once.
	testView = createTestView({
		// The Server answers with the cycle the results will arrive under. No
		// running client answers null, which the view reports as nothing ran.
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
		// Decorations belong to an editor, not a document, so a newly visible
		// editor is drawn on.
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
		// The Run lens over a `test` or `suite` sends the ids it carries back
		// to the server, which owns the run. The lens commands stay out of
		// `contributes.commands`, since the palette has no ids to pass.
		vscode.commands.registerCommand("essence.test.run", async (item) => {
			if (item === undefined) {
				return
			}

			await testView?.runIds(item.ids ?? [], [item.filePath])
		}),
		// The "Accept snapshot" lens: the same run, recording what it finds.
		// Sources come back as a workspace edit, so an unsaved buffer is
		// edited rather than overwritten.
		vscode.commands.registerCommand(
			"essence.test.acceptSnapshot",
			async (item) => {
				if (item === undefined) {
					return
				}

				await testView?.acceptSnapshots(item.ids ?? [], [item.filePath])
			},
		),
		// Runs the failed tests by id rather than their whole files.
		vscode.commands.registerCommand("essence.test.runFailed", async () => {
			await testView?.runFailed()
		}),
		vscode.commands.registerCommand("essence.test.showOutput", () => {
			testView?.show()
		}),
		// The "Debug" lens, through the Test Explorer like "Run". It starts
		// an `essence` debug session over a bundle compiled with the tests.
		vscode.commands.registerCommand("essence.test.debug", async (item) => {
			if (item === undefined) {
				return
			}

			await testView?.debugIds(item.ids ?? [], [item.filePath])
		}),
		// What an extraction carries. The editor applies the action's edits
		// before its command, so the derived name already stands at the
		// Position. Not in the palette, which has no Position to pass.
		vscode.commands.registerCommand("essence.renameAt", (uri, position) =>
			revealForRename(uri, position),
		),
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
		// A restart drops diagnostics for a moment, so it is offered, not
		// forced. vscode-languageclient applies `essence.trace.server` itself.
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
