import { DebugSession } from "@vscode/debugadapter"
import type { DebugProtocol } from "@vscode/debugprotocol"

import type { CompileFunction } from "./compile"

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

export class EssenceDebugSession extends DebugSession {
	protected compile: CompileFunction | null

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

	protected override disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
	): void {
		this.sendResponse(response)
	}
}
