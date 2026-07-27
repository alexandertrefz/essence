import type { BundleMap } from "./maps"

// NOTE: What V8 is told to step over. `Debugger.setBlackboxedRanges` takes a
// list of TOGGLE positions — the interval before the first is plain, the one
// after it blackboxed, and so on — so the bundle's mapped lines are collected
// into runs and everything between them, prelude and runtime alike, becomes
// territory a step passes straight through. Breakpoints inside blackboxed
// ranges still hit; only stepping is carried over them.

export type ScriptPosition = {
	lineNumber: number
	columnNumber: number
}

export function blackboxPositions(map: BundleMap): Array<ScriptPosition> {
	let mappedLines = new Set<number>()

	map.eachMapping((mapping) => {
		if (mapping.source !== null) {
			mappedLines.add(mapping.generatedLine)
		}
	})

	let sorted = [...mappedLines].sort((first, second) => first - second)
	let runs: Array<[number, number]> = []

	for (let line of sorted) {
		let last = runs[runs.length - 1]

		if (last !== undefined && line === last[1]) {
			last[1] = line + 1
		} else {
			runs.push([line, line + 1])
		}
	}

	if (runs.length === 0) {
		return []
	}

	// NOTE: Blackboxing starts at the top of the file — the first toggle at
	// 0:0 switches it ON — and every run of mapped lines switches it off and
	// back on around itself. A run that begins at line 0 makes the leading
	// toggle pair degenerate, so it is dropped rather than sent as an empty
	// interval.
	let positions: Array<ScriptPosition> = [{ lineNumber: 0, columnNumber: 0 }]

	for (let [start, end] of runs) {
		positions.push({ lineNumber: start, columnNumber: 0 })
		positions.push({ lineNumber: end, columnNumber: 0 })
	}

	if (runs[0]![0] === 0) {
		positions.splice(0, 2)
	}

	return positions
}
