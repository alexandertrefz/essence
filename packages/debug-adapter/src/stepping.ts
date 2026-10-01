import type { BundleMap } from "./maps"

// What V8 is told to step over: everything between the runs of the bundle's
// mapped lines. See "Stepping" in DEVELOPMENT.md.

type ScriptPosition = {
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

	// The interval before the first toggle is plain, so the toggle at 0:0
	// starts blackboxing. A run starting at line 0 would leave an empty
	// interval, so its leading pair is dropped.
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
