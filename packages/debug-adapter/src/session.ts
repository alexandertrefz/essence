import type { ChildProcess } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { escapeName } from "@essence-lang/compiler/rewriter/names"
import {
	DebugSession,
	ExitedEvent,
	Handles,
	InitializedEvent,
	OutputEvent,
	Scope,
	StoppedEvent,
	TerminatedEvent,
	Thread,
} from "@vscode/debugadapter"
import type { DebugProtocol } from "@vscode/debugprotocol"

import { planBreakpoints } from "./breakpoints"
import { CdpConnection } from "./cdp"
import type { CompileDiagnostic, CompileFunction } from "./compile"
import { type CdpCallFrame, type PresentedFrame, presentFrames } from "./frames"
import { launchProgram } from "./launcher"
import { BundleMap } from "./maps"
import { isSingleWord } from "./names"
import {
	type DescribedValue,
	DESCRIBE_BATCH_SOURCE,
	DICTIONARY_ENTRIES_SOURCE,
	LIST_ITEMS_SOURCE,
} from "./render"
import { blackboxPositions } from "./stepping"
import { testRunnerSource } from "./testRunner"
import {
	fallbackDisplay,
	isPresentableScope,
	presentScopeVariableName,
	type RemoteObject,
	toCallArgument,
} from "./variables"

// Exported, so a spec can read what the adapter promises without starting
// one.
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

// The object group of every handle the Variables view mints in the debuggee,
// released on each pause and resume. See "Releasing handles" in
// DEVELOPMENT.md.
const VARIABLE_OBJECT_GROUP = "essence-variables"

export type AdapterOptions = {
	// `essence dap` injects its in-process pipeline, `bin/esdap` a spawn of
	// the CLI. Without one, a launch needs a precompiled `artifact`.
	compile?: CompileFunction
}

type EssenceLaunchArguments = DebugProtocol.LaunchRequestArguments & {
	program?: string
	// A precompiled bundle with its `.map` beside it, debugged without
	// compiling.
	artifact?: string
	args?: Array<string>
	cwd?: string
	env?: Record<string, string>
	stopOnEntry?: boolean
	keepArtifacts?: boolean
	glueFrames?: "hide" | "subtle"
	runtimeExecutable?: string
	// The structural ids of the tests to debug, where an empty Array means
	// every test. When present, `program` is compiled with its `tests { … }`
	// block and a runner runs those tests instead of the Program.
	tests?: Array<string>
}

// The bundle runs on one thread, and DAP still speaks in thread ids.
const MAIN_THREAD_ID = 1

type Debuggee = {
	child: ChildProcess
	cdp: CdpConnection
	bundlePath: string
	// The URL Node knows the bundle's script under, which a CDP breakpoint
	// is addressed to.
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

// What a `variablesReference` stands for: a scope's bindings, an object's own
// members, or a List or Dictionary, whose view the debuggee is asked for.
type VariableContainer = {
	kind: "scope" | "members" | "list" | "dictionary"
	objectId: string
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

		// CDP is 0-based on both axes. The base class converts to whatever
		// the client declared in `initialize`.
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
		// "Run Without Debugging" arrives as `noDebug`. The program still
		// runs under the adapter, but the client sends no breakpoints and
		// exceptions and `stopOnEntry` pause nothing.
		this.stopOnEntry = args.stopOnEntry === true && args.noDebug !== true
		this.glueFramesMode = args.glueFrames === "subtle" ? "subtle" : "hide"

		if (args.noDebug === true) {
			this.pauseOnExceptionsState = "none"
		}

		let prepared = await this.prepareBundle(args)

		if (prepared.error !== undefined) {
			this.sendErrorResponse(response, 1001, prepared.error)

			return
		}

		let { bundlePath, entryPath, scratchDirectory } = prepared
		let sourcePath = args.program ?? args.artifact ?? bundlePath!

		try {
			let launched = await launchProgram({
				runtime: args.runtimeExecutable ?? "node",
				// A launch that names tests runs the runner beside the
				// bundle; breakpoints still address the bundle.
				entryPath: entryPath ?? bundlePath!,
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

		// Wired before anything runs. `ExitedEvent` carries the code and
		// `TerminatedEvent` ends the session, each sent exactly once.
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

		// Node keeps a finished program alive while an inspector is attached.
		// The destroyed context is the program's end, so disconnecting lets
		// the child exit with its real code.
		cdp.on("Runtime.executionContextDestroyed", () => {
			cdp.close()
		})

		// Everything the bundle's map does not cover is blackboxed, so V8
		// steps over the prelude and runtime itself. See "Stepping" in
		// DEVELOPMENT.md.
		cdp.on<{ scriptId: string; url: string }>(
			"Debugger.scriptParsed",
			(params) => {
				let debuggee = this.debuggee

				if (
					debuggee === null ||
					params.url !== debuggee.bundleUrl ||
					debuggee.map === null
				) {
					return
				}

				let positions = blackboxPositions(debuggee.map)

				if (positions.length > 0) {
					debuggee.cdp
						.send("Debugger.setBlackboxedRanges", {
							scriptId: params.scriptId,
							positions,
						})
						.catch(() => {})
				}
			},
		)

		// `--inspect-brk` holds the program before its first statement. The
		// pause after `Runtime.runIfWaitingForDebugger` is awaited here and
		// never shown; the client sets its breakpoints during it.
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

	// The entry pause is the adapter's own, and `configurationDone` decides
	// what becomes of it, so `onPaused` does not report it.
	private entryPauseSeen = false

	// The manual step, alive between a step request and the stop it earns.
	// See "Stepping" in DEVELOPMENT.md.
	private pendingStep: {
		kind: "next" | "stepIn" | "stepOut"
		stopReason: "step" | "entry"
		origin: { source: string; line: number } | null
		budget: number
	} | null = null

	private onPaused(params: PausedParameters): void {
		if (!this.entryPauseSeen) {
			this.entryPauseSeen = true
			this.lastPause = params

			return
		}

		this.lastPause = params
		this.variableHandles.reset()
		this.releaseVariableObjects()

		let reason =
			params.reason === "exception"
				? "exception"
				: (params.hitBreakpoints?.length ?? 0) > 0
					? "breakpoint"
					: "step"

		if (reason !== "step" || this.pendingStep === null) {
			this.pendingStep = null
			this.sendEvent(new StoppedEvent(reason, MAIN_THREAD_ID))

			return
		}

		let step = this.pendingStep
		let top = params.callFrames[0]
		let original =
			top === undefined
				? null
				: (this.debuggee?.map?.originalPositionFor({
						line: top.location.lineNumber,
						column: top.location.columnNumber ?? 0,
					}) ?? null)

		if (step.budget > 0) {
			step.budget -= 1

			if (original === null) {
				// Unmapped code. A step-in keeps going forward; a next or
				// step-out climbs back out of the glue it landed in.
				this.debuggee?.cdp
					.send(
						step.kind === "stepIn"
							? "Debugger.stepInto"
							: "Debugger.stepOut",
					)
					.catch(() => {})

				return
			}

			if (
				step.kind === "next" &&
				step.origin !== null &&
				original.source === step.origin.source &&
				original.line === step.origin.line
			) {
				this.debuggee?.cdp.send("Debugger.stepOver").catch(() => {})

				return
			}
		}

		let stopReason = step.stopReason

		this.pendingStep = null
		this.sendEvent(new StoppedEvent(stopReason, MAIN_THREAD_ID))
	}

	private beginStep(
		kind: "next" | "stepIn" | "stepOut",
		stopReason: "step" | "entry" = "step",
	): void {
		let top = this.lastPause?.callFrames[0]
		let origin =
			top === undefined
				? null
				: (this.debuggee?.map?.originalPositionFor({
						line: top.location.lineNumber,
						column: top.location.columnNumber ?? 0,
					}) ?? null)

		this.pendingStep = {
			kind,
			stopReason,
			origin:
				origin === null
					? null
					: { source: origin.source, line: origin.line },
			budget: 50,
		}
		this.lastPause = null
		this.presentedFrames = []
	}

	protected override async nextRequest(
		response: DebugProtocol.NextResponse,
	): Promise<void> {
		this.beginStep("next")
		await this.debuggee?.cdp.send("Debugger.stepOver").catch(() => {})
		this.sendResponse(response)
	}

	protected override async stepInRequest(
		response: DebugProtocol.StepInResponse,
	): Promise<void> {
		this.beginStep("stepIn")
		await this.debuggee?.cdp.send("Debugger.stepInto").catch(() => {})
		this.sendResponse(response)
	}

	protected override async stepOutRequest(
		response: DebugProtocol.StepOutResponse,
	): Promise<void> {
		this.beginStep("stepOut")
		await this.debuggee?.cdp.send("Debugger.stepOut").catch(() => {})
		this.sendResponse(response)
	}

	protected override async configurationDoneRequest(
		response: DebugProtocol.ConfigurationDoneResponse,
	): Promise<void> {
		if (this.debuggee !== null) {
			if (this.stopOnEntry) {
				// The entry pause sits in runtime glue, so stopping on entry
				// steps in to the author's first statement and reports the
				// stop as `entry`.
				this.beginStep("stepIn", "entry")
				await this.debuggee.cdp
					.send("Debugger.stepInto")
					.catch(() => {})
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

	// The CDP breakpoints set per client source. `setBreakpoints` replaces a
	// source's set, so the previous ones are removed first.
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

				// V8 may slide the breakpoint to the nearest breakable
				// position, so that position's source line is reported.
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

		// Kept per stop: a frame's DAP id is its index here, which `scopes`
		// resolves back to the raw CDP frame.
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
						// The map's columns are 0-based, the client's 1-based.
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

	private variableHandles = new Handles<VariableContainer>()

	protected override scopesRequest(
		response: DebugProtocol.ScopesResponse,
		args: DebugProtocol.ScopesArguments,
	): void {
		let frame = this.presentedFrames[args.frameId]
		let raw =
			frame === undefined
				? undefined
				: this.lastPause?.callFrames[frame.callFrameIndex]

		response.body = {
			scopes: (raw?.scopeChain ?? [])
				.filter(
					(scope) =>
						isPresentableScope(scope.type) &&
						scope.object.objectId !== undefined,
				)
				.map(
					(scope) =>
						new Scope(
							scope.type === "local"
								? "Local"
								: scope.type === "closure"
									? "Closure"
									: scope.type === "block"
										? "Block"
										: "Catch",
							this.variableHandles.create({
								kind: "scope",
								objectId: scope.object.objectId!,
							}),
							false,
						),
				),
		}
		this.sendResponse(response)
	}

	protected override async variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments,
	): Promise<void> {
		let container = this.variableHandles.get(args.variablesReference)
		let debuggee = this.debuggee

		if (container === undefined || debuggee === null) {
			response.body = { variables: [] }
			this.sendResponse(response)

			return
		}

		let entries: Array<{ name: string; value: RemoteObject }>

		if (container.kind === "scope") {
			entries = (await this.ownProperties(container.objectId)).flatMap(
				(entry) => {
					let name = presentScopeVariableName(entry.name)

					return name === null ? [] : [{ ...entry, name }]
				},
			)
		} else if (container.kind === "members") {
			// The tag's `Symbol($type)` row is left out, since the display
			// already shows the tag.
			entries = (await this.ownProperties(container.objectId)).filter(
				(entry) => !entry.name.startsWith("Symbol("),
			)
		} else {
			// A List or Dictionary shares its Arrays or store with its chain,
			// so the debuggee is asked for the box's view instead of its
			// properties. A box that does not answer expands to nothing.
			let items = await this.viewedItems(
				container.objectId,
				container.kind === "list"
					? LIST_ITEMS_SOURCE
					: DICTIONARY_ENTRIES_SOURCE,
			)

			if (items === null) {
				entries = []
			} else {
				entries = (await this.ownProperties(items)).filter((entry) =>
					/^\d+$/.test(entry.name),
				)

				// The Array was built for this expansion and the items have
				// their own handles now, so the Array is released.
				await this.releaseObject(items)
			}
		}

		let described = await this.describeValues(container.objectId, entries)

		response.body = {
			variables: entries.map((entry, index) => {
				let description =
					described[index] ??
					({ display: null, kind: "leaf" } as DescribedValue)
				let reference = 0

				if (entry.value.objectId !== undefined) {
					if (
						description.kind === "list" ||
						description.kind === "dictionary"
					) {
						reference = this.variableHandles.create({
							kind: description.kind,
							objectId: entry.value.objectId,
						})
					} else if (
						description.kind === "record" ||
						description.kind === "plain"
					) {
						reference = this.variableHandles.create({
							kind: "members",
							objectId: entry.value.objectId,
						})
					}
				}

				return {
					name: entry.name,
					value: description.display ?? fallbackDisplay(entry.value),
					variablesReference: reference,
				}
			}),
		}
		this.sendResponse(response)
	}

	private async ownProperties(
		objectId: string,
	): Promise<Array<{ name: string; value: RemoteObject }>> {
		let debuggee = this.debuggee

		if (debuggee === null) {
			return []
		}

		try {
			let result = await debuggee.cdp.send<{
				result: Array<{ name: string; value?: RemoteObject }>
			}>("Runtime.getProperties", {
				objectId,
				ownProperties: true,
			})

			return result.result.flatMap((entry) =>
				entry.value === undefined
					? []
					: [{ name: entry.name, value: entry.value }],
			)
		} catch {
			return []
		}
	}

	// The box, passed to itself as the argument, answers a new Array of what
	// its view holds. The Array stays in the debuggee, so each item is the
	// live value its row expands.
	private async viewedItems(
		objectId: string,
		source: string,
	): Promise<string | null> {
		let debuggee = this.debuggee

		if (debuggee === null) {
			return null
		}

		try {
			let result = await debuggee.cdp.send<{ result: RemoteObject }>(
				"Runtime.callFunctionOn",
				{
					objectId,
					functionDeclaration: source,
					arguments: [{ objectId }],
					objectGroup: VARIABLE_OBJECT_GROUP,
				},
			)

			return result.result.objectId ?? null
		} catch {
			return null
		}
	}

	// Releases what the Variables view holds in the debuggee, on each pause
	// and resume. See "Releasing handles" in DEVELOPMENT.md.
	private releaseVariableObjects(): void {
		this.debuggee?.cdp
			.send("Runtime.releaseObjectGroup", {
				objectGroup: VARIABLE_OBJECT_GROUP,
			})
			.catch(() => {
				// A debuggee that has minted nothing yet, or a session
				// closing. There is nothing to release either way.
			})
	}

	private async releaseObject(objectId: string): Promise<void> {
		let debuggee = this.debuggee

		if (debuggee === null) {
			return
		}

		try {
			await debuggee.cdp.send("Runtime.releaseObject", { objectId })
		} catch {
			// A handle the debuggee has already dropped, or a session
			// closing. There is nothing to release either way.
		}
	}

	// One round trip per container. A scope object sometimes refuses to be a
	// call target, so the first member that is an object stands in. A failed
	// batch falls back to default descriptions.
	private async describeValues(
		targetObjectId: string,
		entries: Array<{ name: string; value: RemoteObject }>,
	): Promise<Array<DescribedValue>> {
		let debuggee = this.debuggee

		if (debuggee === null || entries.length === 0) {
			return []
		}

		let targets = [
			targetObjectId,
			...entries.flatMap((entry) =>
				entry.value.objectId === undefined
					? []
					: [entry.value.objectId],
			),
		]

		for (let target of targets.slice(0, 2)) {
			try {
				let result = await debuggee.cdp.send<{
					result: { value?: string }
				}>("Runtime.callFunctionOn", {
					objectId: target,
					functionDeclaration: DESCRIBE_BATCH_SOURCE,
					arguments: entries.map((entry) =>
						toCallArgument(entry.value),
					),
					returnByValue: true,
				})

				if (typeof result.result.value === "string") {
					return JSON.parse(
						result.result.value,
					) as Array<DescribedValue>
				}
			} catch {
				// Fall through to the next target, then to defaults.
			}
		}

		return entries.map(() => ({ display: null, kind: "leaf" }))
	}

	protected override exceptionInfoRequest(
		response: DebugProtocol.ExceptionInfoResponse,
	): void {
		let pause = this.lastPause
		let data =
			pause?.reason === "exception"
				? (pause.data as RemoteObject | undefined)
				: undefined
		let description = data?.description ?? "An exception was thrown."

		// A thrown Error's `description` is its message followed by V8's
		// stack of bundle positions. Only the message is kept; the stack shown
		// is the session's mapped one.
		response.body = {
			exceptionId: data?.className ?? "Error",
			description: description.split("\n")[0]!,
			breakMode:
				this.pauseOnExceptionsState === "all" ? "always" : "unhandled",
			details: {
				message: description.split("\n")[0]!,
				stackTrace:
					pause === undefined || pause === null
						? undefined
						: presentFrames(
								pause.callFrames,
								this.debuggee?.map ?? null,
								this.glueFramesMode,
							)
								.map((frame) =>
									frame.source === null
										? `at ${frame.name}`
										: `at ${frame.name} (${frame.source.source}:${frame.source.line})`,
								)
								.join("\n"),
			},
		}
		this.sendResponse(response)
	}

	protected override async evaluateRequest(
		response: DebugProtocol.EvaluateResponse,
		args: DebugProtocol.EvaluateArguments,
	): Promise<void> {
		let debuggee = this.debuggee
		let frame =
			args.frameId !== undefined
				? this.presentedFrames[args.frameId]
				: this.presentedFrames[0]
		let callFrameId =
			frame === undefined
				? this.lastPause?.callFrames[0]?.callFrameId
				: this.lastPause?.callFrames[frame.callFrameIndex]?.callFrameId

		if (debuggee === null || callFrameId === undefined) {
			this.sendErrorResponse(
				response,
				1003,
				"evaluation needs a paused program.",
			)

			return
		}

		let evaluate = (expression: string) =>
			debuggee.cdp.send<{
				result: RemoteObject
				exceptionDetails?: {
					text?: string
					exception?: RemoteObject
				}
			}>("Debugger.evaluateOnCallFrame", {
				callFrameId,
				expression,
			})

		// The console evaluates JavaScript in the compiled frame. A single word
		// is tried first under the spelling the bundle gives an author's name,
		// such as `ok?`, `new` or `Object`, and then as JavaScript.
		let escaped = isSingleWord(args.expression)
			? escapeName(args.expression)
			: args.expression
		let result = await evaluate(escaped)

		if (
			result.exceptionDetails !== undefined &&
			escaped !== args.expression
		) {
			result = await evaluate(args.expression)
		}

		if (result.exceptionDetails !== undefined) {
			this.sendErrorResponse(
				response,
				1004,
				result.exceptionDetails.exception?.description?.split(
					"\n",
				)[0] ??
					result.exceptionDetails.text ??
					"the expression failed.",
			)

			return
		}

		let value = result.result
		let described =
			value.objectId === undefined
				? undefined
				: (
						await this.describeValues(value.objectId, [
							{ name: "result", value },
						])
					)[0]
		let reference = 0

		if (value.objectId !== undefined && described !== undefined) {
			if (described.kind === "list" || described.kind === "dictionary") {
				reference = this.variableHandles.create({
					kind: described.kind,
					objectId: value.objectId,
				})
			} else if (
				described.kind === "record" ||
				described.kind === "plain"
			) {
				reference = this.variableHandles.create({
					kind: "members",
					objectId: value.objectId,
				})
			}
		}

		response.body = {
			result: described?.display ?? fallbackDisplay(value),
			variablesReference: reference,
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
		this.variableHandles.reset()
		this.releaseVariableObjects()
		await this.debuggee?.cdp.send("Debugger.resume").catch(() => {
			// A resume can race the program's exit, which the exit path
			// reports.
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

	// The named `artifact` as it is, or the program compiled into a scratch
	// directory that lives as long as the session. `keepArtifacts` keeps it
	// and names it. `entryPath`, when given, is a test runner beside the bundle.
	private async prepareBundle(args: EssenceLaunchArguments): Promise<{
		bundlePath?: string
		entryPath?: string
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

		// On macOS the temporary directory is a symlink, and Node registers
		// the script under its real path, which a breakpoint's URL must match.
		let scratchDirectory = realpathSync(
			mkdtempSync(path.join(tmpdir(), "essence-dap-")),
		)
		// A test bundle is `.mjs`, so the runner's `import` reads it as a
		// module.
		let tests = Array.isArray(args.tests)
		let outputFile = path.join(
			scratchDirectory,
			`${path.basename(args.program, ".es")}${tests ? ".tests.mjs" : ".js"}`,
		)
		let compiled = await this.compile(args.program, outputFile, { tests })

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

		if (!tests) {
			return { bundlePath: compiled.bundlePath, scratchDirectory }
		}

		// The runner imports the bundle by name, so they are siblings. A
		// separate file keeps the bundle the exact file its map describes.
		let entryPath = path.join(scratchDirectory, "run-tests.mjs")

		writeFileSync(
			entryPath,
			testRunnerSource(path.basename(compiled.bundlePath), args.tests!),
		)

		return { bundlePath: compiled.bundlePath, entryPath, scratchDirectory }
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

			// A program that ignores SIGTERM is killed after two seconds. The
			// timer is unreferenced so it does not hold a clean exit open.
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
