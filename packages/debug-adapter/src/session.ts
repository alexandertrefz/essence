import type { ChildProcess } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import {
	DebugSession,
	ExitedEvent,
	InitializedEvent,
	OutputEvent,
	StoppedEvent,
	TerminatedEvent,
	Thread,
} from "@vscode/debugadapter"
import type { DebugProtocol } from "@vscode/debugprotocol"

import { planBreakpoints } from "./breakpoints"
import { CdpConnection } from "./cdp"
import type { CompileDiagnostic, CompileFunction } from "./compile"
import {
	type CdpCallFrame,
	type PresentedFrame,
	presentFrames,
} from "./frames"
import { launchProgram } from "./launcher"
import { BundleMap } from "./maps"

// NOTE: Module-level and exported, so the spec can read what the adapter
// promises without starting one — the same shape `serverCapabilities` has in
// the Language Server.
export const adapterCapabilities: DebugProtocol.Capabilities = {
	supportsConfigurationDoneRequest: true,
	supportsExceptionInfoRequest: true,
	supportsEvaluateForHovers: true,
	supportsDelayedStackTraceLoading: true,
	supportsTerminateRequest: true,
	exceptionBreakpointFilters: [
		{
			filter: "uncaught",
			label: "Uncaught Exceptions",
			default: true,
		},
		{
			filter: "caught",
			label: "Caught Exceptions",
			default: false,
		},
	],
}

export type AdapterOptions = {
	// NOTE: What compiling means is the host's to say — `essence dap` injects
	// its in-process pipeline, `bin/esdap` a spawn of the CLI. Absent, a
	// launch that names no precompiled `artifact` fails with a clear message.
	compile?: CompileFunction
}

export type EssenceLaunchArguments = DebugProtocol.LaunchRequestArguments & {
	program?: string
	// NOTE: A precompiled bundle, its `.map` beside it — the way to debug
	// without compiling, and the way a host without a compiler still works.
	artifact?: string
	args?: Array<string>
	cwd?: string
	env?: Record<string, string>
	stopOnEntry?: boolean
	keepArtifacts?: boolean
	glueFrames?: "hide" | "subtle"
	runtimeExecutable?: string
}

// NOTE: The emitted bundle runs on one thread; DAP still speaks in thread
// ids, so there is exactly one, and it is this.
export const MAIN_THREAD_ID = 1

type Debuggee = {
	child: ChildProcess
	cdp: CdpConnection
	bundlePath: string
	// NOTE: The URL Node knows the bundle's script under — what a CDP
	// breakpoint is addressed to.
	bundleUrl: string
	map: BundleMap | null
	scratchDirectory: string | null
	keepArtifacts: boolean
}

type PausedParameters = {
	reason: string
	callFrames: Array<CdpCallFrame>
	hitBreakpoints?: Array<string>
	data?: unknown
}

export class EssenceDebugSession extends DebugSession {
	protected compile: CompileFunction | null
	protected debuggee: Debuggee | null = null
	protected lastPause: PausedParameters | null = null
	protected presentedFrames: Array<PresentedFrame> = []
	protected glueFramesMode: "hide" | "subtle" = "hide"
	protected stopOnEntry = false
	protected terminatedSent = false
	protected pauseOnExceptionsState: "none" | "uncaught" | "all" = "uncaught"

	constructor(options: AdapterOptions = {}) {
		super()

		this.compile = options.compile ?? null

		// NOTE: The debuggee side speaks CDP, which is 0-based on both axes —
		// the base class's convert helpers translate to whatever the client
		// declared in `initialize`.
		this.setDebuggerLinesStartAt1(false)
		this.setDebuggerColumnsStartAt1(false)
	}

	protected override initializeRequest(
		response: DebugProtocol.InitializeResponse,
	): void {
		response.body = { ...adapterCapabilities }

		this.sendResponse(response)
	}

	protected override async launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: EssenceLaunchArguments,
	): Promise<void> {
		this.stopOnEntry = args.stopOnEntry === true
		this.glueFramesMode = args.glueFrames === "subtle" ? "subtle" : "hide"

		let prepared = await this.prepareBundle(args)

		if (prepared.error !== undefined) {
			this.sendErrorResponse(response, 1001, prepared.error)

			return
		}

		let { bundlePath, scratchDirectory } = prepared
		let sourcePath = args.program ?? args.artifact ?? bundlePath!

		try {
			let launched = await launchProgram({
				runtime: args.runtimeExecutable ?? "node",
				bundlePath: bundlePath!,
				programArguments: args.args ?? [],
				cwd: args.cwd ?? path.dirname(sourcePath),
				env: { ...process.env, ...args.env },
				onStdout: (text) =>
					this.sendEvent(new OutputEvent(text, "stdout")),
				onStderr: (text) =>
					this.sendEvent(new OutputEvent(text, "stderr")),
			})

			this.debuggee = {
				child: launched.child,
				cdp: await CdpConnection.connect(launched.webSocketUrl),
				bundlePath: bundlePath!,
				bundleUrl: pathToFileURL(bundlePath!).href,
				map: BundleMap.load(bundlePath!),
				scratchDirectory,
				keepArtifacts: args.keepArtifacts === true,
			}
		} catch (error) {
			this.removeScratchDirectory(scratchDirectory, args)
			this.sendErrorResponse(
				response,
				1002,
				error instanceof Error ? error.message : String(error),
			)

			return
		}

		let { child, cdp } = this.debuggee

		// NOTE: The exit path is wired before anything can run. `ExitedEvent`
		// carries the code, `TerminatedEvent` ends the session — and both are
		// sent exactly once, however the program went down.
		child.on("exit", (code, signal) => {
			this.removeScratchDirectory(
				this.debuggee?.scratchDirectory ?? null,
				args,
			)
			this.sendTerminated(code ?? (signal === null ? 0 : 1))
		})

		cdp.on<PausedParameters>("Debugger.paused", (params) =>
			this.onPaused(params),
		)

		// NOTE: A finished program does not exit while an inspector client is
		// attached — Node prints "Waiting for the debugger to disconnect..."
		// and holds the process for exactly that. The context being destroyed
		// IS the program's end, so the disconnect is answered here, which lets
		// the child exit and carry its real exit code to the handler above.
		cdp.on("Runtime.executionContextDestroyed", () => {
			cdp.close()
		})

		// NOTE: The entry pause: `--inspect-brk` holds the program before its
		// first statement, and the engine only starts once
		// `Runtime.runIfWaitingForDebugger` is sent — so the pause that
		// follows it is awaited HERE, and never surfaces as a stop. It is the
		// window in which the client sets its breakpoints.
		let entryPause = new Promise<void>((resolve) => {
			let seen = false

			cdp.on("Debugger.paused", () => {
				if (!seen) {
					seen = true
					resolve()
				}
			})
		})

		await cdp.send("Runtime.enable")
		await cdp.send("Debugger.enable")
		await cdp.send("Debugger.setPauseOnExceptions", {
			state: this.pauseOnExceptionsState,
		})
		await cdp.send("Runtime.runIfWaitingForDebugger")
		await entryPause

		this.sendEvent(new InitializedEvent())
		this.sendResponse(response)
	}

	// NOTE: Which pauses reach the client: the entry pause is the adapter's
	// own and `configurationDone` decides what becomes of it, so it is
	// swallowed here — `lastPause` is only ever a pause the program earned.
	private entryPauseSeen = false

	private onPaused(params: PausedParameters): void {
		if (!this.entryPauseSeen) {
			this.entryPauseSeen = true
			this.lastPause = params

			return
		}

		this.lastPause = params

		let reason =
			params.reason === "exception"
				? "exception"
				: (params.hitBreakpoints?.length ?? 0) > 0
					? "breakpoint"
					: "step"

		this.sendEvent(new StoppedEvent(reason, MAIN_THREAD_ID))
	}

	protected override async configurationDoneRequest(
		response: DebugProtocol.ConfigurationDoneResponse,
	): Promise<void> {
		if (this.debuggee !== null) {
			if (this.stopOnEntry) {
				this.sendEvent(new StoppedEvent("entry", MAIN_THREAD_ID))
			} else {
				await this.resumeDebuggee()
			}
		}

		this.sendResponse(response)
	}

	protected override async continueRequest(
		response: DebugProtocol.ContinueResponse,
	): Promise<void> {
		await this.resumeDebuggee()
		response.body = { allThreadsContinued: true }
		this.sendResponse(response)
	}

	protected override async pauseRequest(
		response: DebugProtocol.PauseResponse,
	): Promise<void> {
		await this.debuggee?.cdp.send("Debugger.pause").catch(() => {})
		this.sendResponse(response)
	}

	// NOTE: What is currently set per client source — DAP's `setBreakpoints`
	// REPLACES a source's set wholesale, so the previous CDP breakpoints are
	// removed before the new ones are planted.
	private breakpointLedger = new Map<string, Array<string>>()

	protected override async setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments,
	): Promise<void> {
		let clientPath = args.source.path ?? ""
		let requestedLines = (args.breakpoints ?? []).map(
			(breakpoint) => breakpoint.line,
		)
		let debuggee = this.debuggee

		if (debuggee === null) {
			response.body = {
				breakpoints: requestedLines.map((line) => ({
					verified: false,
					line,
					message: "no program is running yet",
				})),
			}
			this.sendResponse(response)

			return
		}

		for (let breakpointId of this.breakpointLedger.get(clientPath) ?? []) {
			await debuggee.cdp
				.send("Debugger.removeBreakpoint", { breakpointId })
				.catch(() => {})
		}

		this.breakpointLedger.delete(clientPath)

		let identifiers: Array<string> = []
		let breakpoints: Array<DebugProtocol.Breakpoint> = []

		for (let plan of planBreakpoints(
			debuggee.map,
			clientPath,
			requestedLines,
		)) {
			if (plan.generated === null) {
				breakpoints.push({
					verified: false,
					line: plan.requestedLine,
					message: plan.message ?? undefined,
				})

				continue
			}

			try {
				let result = await debuggee.cdp.send<{
					breakpointId: string
					locations: Array<{
						lineNumber: number
						columnNumber?: number
					}>
				}>("Debugger.setBreakpointByUrl", {
					url: debuggee.bundleUrl,
					lineNumber: plan.generated.line,
					columnNumber: plan.generated.column,
				})

				identifiers.push(result.breakpointId)

				// NOTE: V8 may itself slide the breakpoint to the nearest
				// breakable position; where THAT came from is the line the
				// red dot belongs on.
				let actual = result.locations[0]
				let line = plan.line

				if (actual !== undefined) {
					let original = debuggee.map?.originalPositionFor({
						line: actual.lineNumber,
						column: actual.columnNumber ?? 0,
					})

					if (original != null) {
						line = original.line
					}
				}

				breakpoints.push({ verified: true, line })
			} catch (error) {
				breakpoints.push({
					verified: false,
					line: plan.requestedLine,
					message:
						error instanceof Error ? error.message : String(error),
				})
			}
		}

		this.breakpointLedger.set(clientPath, identifiers)
		response.body = { breakpoints }
		this.sendResponse(response)
	}

	protected override setExceptionBreakPointsRequest(
		response: DebugProtocol.SetExceptionBreakpointsResponse,
		args: DebugProtocol.SetExceptionBreakpointsArguments,
	): void {
		this.pauseOnExceptionsState = args.filters.includes("caught")
			? "all"
			: args.filters.includes("uncaught")
				? "uncaught"
				: "none"

		this.debuggee?.cdp
			.send("Debugger.setPauseOnExceptions", {
				state: this.pauseOnExceptionsState,
			})
			.catch(() => {})

		this.sendResponse(response)
	}

	protected override threadsRequest(
		response: DebugProtocol.ThreadsResponse,
	): void {
		response.body = { threads: [new Thread(MAIN_THREAD_ID, "main")] }
		this.sendResponse(response)
	}

	protected override stackTraceRequest(
		response: DebugProtocol.StackTraceResponse,
		args: DebugProtocol.StackTraceArguments,
	): void {
		let debuggee = this.debuggee
		let pause = this.lastPause

		if (debuggee === null || pause === null) {
			response.body = { stackFrames: [], totalFrames: 0 }
			this.sendResponse(response)

			return
		}

		// NOTE: Presented once per stop and kept — a frame's DAP id is its
		// index in here, which is what `scopes` resolves back to the raw CDP
		// frame whose chain it reads.
		this.presentedFrames = presentFrames(
			pause.callFrames,
			debuggee.map,
			this.glueFramesMode,
		)

		let start = args.startFrame ?? 0
		let count =
			args.levels === undefined || args.levels === 0
				? this.presentedFrames.length
				: args.levels

		response.body = {
			stackFrames: this.presentedFrames
				.slice(start, start + count)
				.map((frame, offset) => {
					let stackFrame: DebugProtocol.StackFrame = {
						id: start + offset,
						name: frame.name,
						line: frame.source?.line ?? 0,
						// NOTE: The map speaks 0-based columns, the client
						// 1-based ones.
						column:
							frame.source === null ? 0 : frame.source.column + 1,
					}

					if (frame.source !== null) {
						stackFrame.source = {
							name: path.basename(frame.source.source),
							path: frame.source.source,
						}
					}

					if (frame.kind !== "user") {
						stackFrame.presentationHint = "subtle"
					}

					return stackFrame
				}),
			totalFrames: this.presentedFrames.length,
		}
		this.sendResponse(response)
	}

	protected override terminateRequest(
		response: DebugProtocol.TerminateResponse,
	): void {
		this.teardown()
		this.sendResponse(response)
	}

	protected override disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
	): void {
		this.teardown()
		this.sendResponse(response)
	}

	private async resumeDebuggee(): Promise<void> {
		this.lastPause = null
		this.presentedFrames = []
		await this.debuggee?.cdp.send("Debugger.resume").catch(() => {
			// NOTE: A resume can race the program's own exit; the exit path
			// already reports what happened.
		})
	}

	private sendTerminated(exitCode: number): void {
		if (this.terminatedSent) {
			return
		}

		this.terminatedSent = true
		this.sendEvent(new ExitedEvent(exitCode))
		this.sendEvent(new TerminatedEvent())
	}

	// NOTE: What `launch` runs: the named `artifact` verbatim, or the program
	// compiled into a scratch directory that lives exactly as long as the
	// session (`keepArtifacts` keeps it for reading, and says where it is).
	private async prepareBundle(args: EssenceLaunchArguments): Promise<{
		bundlePath?: string
		scratchDirectory: string | null
		error?: string
	}> {
		if (typeof args.artifact === "string") {
			return {
				bundlePath: realpathSync(path.resolve(args.artifact)),
				scratchDirectory: null,
			}
		}

		if (typeof args.program !== "string") {
			return {
				scratchDirectory: null,
				error: "the launch configuration names neither a 'program' nor an 'artifact'.",
			}
		}

		if (this.compile === null) {
			return {
				scratchDirectory: null,
				error:
					"this adapter was started without a compiler — " +
					"launch a precompiled bundle via 'artifact', or start the adapter through 'essence dap'.",
			}
		}

		// NOTE: Canonicalised the moment it exists. On macOS the temporary
		// directory is a symlink — `/var/folders/…` for `/private/var/…` — and
		// Node registers the script under its REAL path, so a breakpoint
		// addressed to the symlinked spelling would never match its URL.
		let scratchDirectory = realpathSync(
			mkdtempSync(path.join(tmpdir(), "essence-dap-")),
		)
		let outputFile = path.join(
			scratchDirectory,
			`${path.basename(args.program, ".es")}.js`,
		)
		let compiled = await this.compile(args.program, outputFile)

		if (!compiled.ok || compiled.bundlePath === null) {
			for (let diagnostic of compiled.diagnostics) {
				this.sendEvent(
					new OutputEvent(
						`${renderDiagnostic(diagnostic)}\n`,
						"stderr",
					),
				)
			}

			this.removeScratchDirectory(scratchDirectory, args)

			return {
				scratchDirectory: null,
				error: `'${path.basename(args.program)}' did not compile — see the session output.`,
			}
		}

		if (args.keepArtifacts === true) {
			this.sendEvent(
				new OutputEvent(
					`Compiled to ${compiled.bundlePath}\n`,
					"console",
				),
			)
		}

		return { bundlePath: compiled.bundlePath, scratchDirectory }
	}

	private removeScratchDirectory(
		scratchDirectory: string | null,
		args: EssenceLaunchArguments,
	): void {
		if (scratchDirectory === null || args.keepArtifacts === true) {
			return
		}

		rmSync(scratchDirectory, { recursive: true, force: true })

		if (this.debuggee !== null) {
			this.debuggee.scratchDirectory = null
		}
	}

	private teardown(): void {
		let debuggee = this.debuggee

		if (debuggee === null) {
			return
		}

		this.debuggee = null
		debuggee.cdp.close()

		if (debuggee.child.exitCode === null) {
			debuggee.child.kill()

			// NOTE: A program that ignores SIGTERM would outlive its session;
			// the escalation is unreferenced so a clean exit is not held open
			// by a live timer.
			let escalation = setTimeout(() => {
				if (debuggee.child.exitCode === null) {
					debuggee.child.kill("SIGKILL")
				}
			}, 2_000)

			escalation.unref()
		}

		if (!debuggee.keepArtifacts && debuggee.scratchDirectory !== null) {
			rmSync(debuggee.scratchDirectory, {
				recursive: true,
				force: true,
			})
		}
	}
}

function renderDiagnostic(diagnostic: CompileDiagnostic): string {
	let place =
		diagnostic.line === null
			? diagnostic.file
			: `${diagnostic.file}:${diagnostic.line}:${diagnostic.column ?? 1}`
	let code = diagnostic.code === null ? "" : ` [${diagnostic.code}]`

	return `${place} — ${diagnostic.message}${code}`
}
