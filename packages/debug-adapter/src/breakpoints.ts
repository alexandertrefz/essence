import type { BundleMap, GeneratedPosition } from "./maps"

// NOTE: The pure half of `setBreakpoints`: which CDP breakpoints one request
// wants, and what the client is told about each. DAP semantics are
// replace-per-source — the session keeps the ledger of what is currently set
// and removes it when the same source is asked about again; this module only
// translates.

export type PlannedBreakpoint = {
	// NOTE: What the client asked for, answered back in request order.
	requestedLine: number
	verified: boolean
	// NOTE: The `.es` line the debugger will genuinely stop on — a breakpoint
	// on a blank line slides to the next statement, and saying so is what
	// moves the red dot.
	line: number
	generated: GeneratedPosition | null
	message: string | null
}

export function planBreakpoints(
	map: BundleMap | null,
	clientPath: string,
	requestedLines: Array<number>,
): Array<PlannedBreakpoint> {
	let source = map?.sourceFor(clientPath) ?? null

	if (map === null || source === null) {
		return requestedLines.map((requestedLine) => ({
			requestedLine,
			verified: false,
			line: requestedLine,
			generated: null,
			message:
				map === null
					? "the compiled bundle carries no source map"
					: "this file is not part of the launched program",
		}))
	}

	return requestedLines.map((requestedLine) => {
		let generated = map.generatedPositionFor(source, requestedLine)

		if (generated === null) {
			return {
				requestedLine,
				verified: false,
				line: requestedLine,
				generated: null,
				message: "no statement maps to this line",
			}
		}

		// NOTE: The snap-back: the generated position the breakpoint lands on
		// is asked where IT came from, so the line reported verified is the
		// one execution will actually pause on.
		let original = map.originalPositionFor(generated)

		return {
			requestedLine,
			verified: true,
			line: original?.line ?? requestedLine,
			generated,
			message: null,
		}
	})
}
