import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import * as vscode from "vscode"
// NOTE: The explicit `.js` is required — under native ESM resolution an
// extensionless specifier is not resolved, and vscode-languageclient ships no
// `exports` map that would map one.
import { LanguageClient, State } from "vscode-languageclient/node.js"

import {
	compileArguments,
	createNodeDebugConfiguration,
	debugBuildSlug,
	resolveCli,
	summariseFailure,
} from "./debug.js"

let client
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

// NOTE: The Language Server is bundled into `server/server.js` by `bun run
// build`, which compiles it out of the compiler repository. That bundle runs
// on the Node that ships with VS Code, so neither Bun nor a compiler checkout
// is needed to use the extension.
//
// `essence.server.path` overrides it, which is how the compiler is developed
// against: point it at `bin/esls` and every edit takes effect on the next
// restart, with no bundling step.
//
// NOTE: Answered as a description rather than as `ServerOptions`, because the
// startup line in the output channel, the status bar tooltip and both failure
// messages are all made of these same three facts, and every one of them has
// to name the server that is actually running.
function resolveServer(context) {
	let configuredPath = vscode.workspace
		.getConfiguration("essence")
		.get("server.path")

	if (typeof configuredPath === "string" && configuredPath.trim() !== "") {
		let serverPath = configuredPath.trim()

		if (!fs.existsSync(serverPath)) {
			reportFailure(
				`'essence.server.path' points at '${serverPath}', which does not exist.`,
			)

			return null
		}

		// NOTE: Only a built bundle is JavaScript, and only that can run on
		// Node. Everything else — a TypeScript entry point, or the compiler's
		// extensionless `bin/esls` launcher — is source that needs Bun.
		return {
			command: /\.(js|cjs|mjs)$/.test(serverPath) ? "node" : "bun",
			path: serverPath,
			configured: true,
		}
	}

	let bundledPath = path.join(context.extensionPath, "server", "server.js")

	if (!fs.existsSync(bundledPath)) {
		reportFailure(
			"the bundled Language Server is missing. Run 'bun run build' in packages/vscode-extension, or set 'essence.server.path'.",
		)

		return null
	}

	return { command: "node", path: bundledPath, configured: false }
}

function describeServer(server) {
	return `${server.configured ? "configured" : "bundled"} Language Server '${server.path}', run with '${server.command}'`
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
			: `Using the ${describeServer(currentServer)}.\n`) +
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

async function startClient(context) {
	failure = null
	currentServer = resolveServer(context)

	if (currentServer === null) {
		setFailure("no server to run")

		return
	}

	outputChannel.appendLine(`Starting the ${describeServer(currentServer)}.`)

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
		{
			command: currentServer.command,
			args: [currentServer.path, "--stdio"],
		},
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
	} catch (error) {
		if (reportedByHandler) {
			return
		}

		let message = error instanceof Error ? error.message : String(error)

		setFailure("failed to start")

		// NOTE: Not awaited. `activate` awaits its way down to here, and an
		// error notification stays up until it is dismissed — awaiting the
		// answer would leave the extension activating for as long as the
		// notification is ignored, which is exactly the case where the user is
		// reading it rather than clicking it.
		reportFailure(
			`could not start the ${describeServer(currentServer)} — ${message}. ` +
				(currentServer.configured
					? `That server is what 'essence.server.path' names; check that '${currentServer.command}' is on PATH, or clear the setting to fall back to the bundled server — rebuild it with 'bun run build' in packages/vscode-extension.`
					: "Rebuild the bundled server with 'bun run build' in packages/vscode-extension, or point 'essence.server.path' at a checkout's 'packages/language-server/bin/esls'."),
		)
	}
}

async function stopClient() {
	stateListener?.dispose()
	stateListener = undefined

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

// NOTE: The CLI half of `resolveServer`'s answer, for the debugger — which
// executable compiles, described so the output channel can name it. The
// resolution itself is pure and lives in `debug.js`; this reads the setting
// and the workspace and reports the one failure that has a user fix.
function resolveCliForDebugging() {
	let configuredPath = vscode.workspace
		.getConfiguration("essence")
		.get("cli.path")
	let workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	let cli = resolveCli(configuredPath, workspaceRoot, fs.existsSync)

	if (cli.error !== undefined) {
		reportFailure(cli.error)

		return null
	}

	return cli
}

// NOTE: One compile, one JSON report. The report arrives on stdout — that is
// what `--json` promises — while stderr only ever carries the CLI's own
// failures, which go to the output channel where every other failure detail
// already lives.
function compileForDebugging(cli, programPath, outputFile, token) {
	return new Promise((resolve) => {
		let child = spawn(
			cli.command,
			[...cli.args, ...compileArguments(programPath, outputFile)],
			{
				cwd: path.dirname(programPath),
				stdio: ["ignore", "pipe", "pipe"],
			},
		)
		let stdout = ""

		// NOTE: Cancelling the progress notification kills the compile — the
		// promise settles once, so the `close` that follows the kill is heard
		// by a promise that has already answered "cancelled".
		let cancellation = token?.onCancellationRequested(() => {
			child.kill()
			resolve({ ok: false, report: null, detail: null, cancelled: true })
		})

		child.stdout.on("data", (chunk) => {
			stdout += chunk
		})
		child.stderr.on("data", (chunk) => {
			outputChannel.append(String(chunk))
		})
		child.on("error", (error) => {
			cancellation?.dispose()
			resolve({
				ok: false,
				report: null,
				detail:
					`could not run the ${cli.description} — ${error.message}. ` +
					"Set 'essence.cli.path', open an Essence checkout, or install 'essence' on PATH.",
			})
		})
		child.on("close", (code) => {
			cancellation?.dispose()

			let report = null

			try {
				report = JSON.parse(stdout)
			} catch {
				// NOTE: A CLI that died before printing leaves stdout empty or
				// partial; `summariseFailure(null)` words exactly that.
			}

			resolve({
				ok: code === 0 && report?.ok === true,
				report,
				detail: null,
			})
		})
	})
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

async function resolveEssenceDebugConfiguration(context, folder, config) {
	// NOTE: The empty object is what F5 sends with no launch.json — the
	// zero-configuration path. It becomes the same launch the contribution's
	// `initialConfigurations` writes, built from the active editor.
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

	if (typeof config.program !== "string" || !config.program.endsWith(".es")) {
		reportFailure("'program' must name a '.es' source file to debug.")

		return undefined
	}

	if (!fs.existsSync(config.program)) {
		reportFailure(`'${config.program}' does not exist.`)

		return undefined
	}

	let cli = resolveCliForDebugging()

	if (cli === null) {
		return undefined
	}

	// NOTE: Debug builds live in the extension's per-workspace storage rather
	// than beside the source — no `.gitignore` churn, no artefact to commit by
	// accident — with `outDir` as the escape hatch for anyone who wants to
	// read the emitted JavaScript. One directory per program, overwritten on
	// every launch. `globalStorageUri` carries the folderless window, where
	// `storageUri` is undefined.
	let storageRoot = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath
	let directory =
		typeof config.outDir === "string" && config.outDir.trim() !== ""
			? config.outDir.trim()
			: path.join(
					storageRoot,
					"debug-builds",
					debugBuildSlug(config.program),
				)

	fs.mkdirSync(directory, { recursive: true })

	let program = path.join(
		directory,
		`${path.basename(config.program, ".es")}.js`,
	)

	outputChannel.appendLine(
		`Compiling '${config.program}' for debugging with the ${cli.description}.`,
	)

	let compiled = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Compiling ${path.basename(config.program)}…`,
			cancellable: true,
		},
		(_progress, token) =>
			compileForDebugging(cli, config.program, program, token),
	)

	// NOTE: A cancelled compile is the user's own decision — the launch just
	// stops, with nothing to report.
	if (compiled.cancelled === true) {
		return undefined
	}

	if (!compiled.ok) {
		reportFailure(compiled.detail ?? summariseFailure(compiled.report))

		return undefined
	}

	await vscode.debug.startDebugging(
		folder,
		createNodeDebugConfiguration(config, {
			program,
			directory,
			defaultCwd: folder?.uri.fsPath ?? path.dirname(config.program),
		}),
	)

	// NOTE: `undefined` aborts THIS session silently — the `pwa-node` session
	// started above is the one that lives on. Returning the rewritten
	// configuration directly is not an option: VS Code ignores a resolver that
	// changes a configuration's `type` (microsoft/vscode#54213), so the
	// handoff is a fresh `startDebugging`, the same shim the js-debug
	// redirects themselves use. `null` would open launch.json instead, which
	// is the wrong answer everywhere a failure was already reported.
	return undefined
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

	context.subscriptions.push(
		outputChannel,
		statusItem,
		vscode.commands.registerCommand("essence.restartServer", () =>
			queue(async () => {
				await stopClient()
				await startClient(context)
			}),
		),
		vscode.debug.registerDebugConfigurationProvider("essence", {
			resolveDebugConfigurationWithSubstitutedVariables: (
				folder,
				config,
			) => resolveEssenceDebugConfiguration(context, folder, config),
		}),
		vscode.debug.registerDebugConfigurationProvider(
			"essence",
			{ provideDebugConfigurations: provideDynamicConfigurations },
			vscode.DebugConfigurationProviderTriggerKind.Dynamic,
		),
		// NOTE: Only the spawn path is worth interrupting for, and only by
		// asking — a restart drops every open document's diagnostics for a
		// moment. `essence.trace.server` is deliberately absent:
		// vscode-languageclient watches it itself and applies it live.
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (!event.affectsConfiguration("essence.server.path")) {
				return
			}

			let choice = await vscode.window.showInformationMessage(
				"Essence: 'essence.server.path' changed. Restart the Language Server to use it?",
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
