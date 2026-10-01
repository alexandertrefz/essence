import type { BundleMap, GeneratedPosition } from "./maps"

// The pure half of `setBreakpoints`: which CDP breakpoints one request wants,
// and what the client is told about each. DAP replaces a source's breakpoints
// per request; the session removes the old ones.

type PlannedBreakpoint = {
	// What the client asked for, answered back in request order.
	requestedLine: number
	verified: boolean
	// The `.es` line the debugger stops on. A breakpoint on a blank line
	// slides to the next statement, and reporting that moves the client's dot.
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

		// The generated position is mapped back, so the verified line is the
		// one execution pauses on.
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
