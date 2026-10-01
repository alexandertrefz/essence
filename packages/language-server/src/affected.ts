import { coveringPoints } from "@essence-lang/compiler/testing"
import type { common } from "@essence-lang/interfaces"
import type { CoveredPoint, TestEvent } from "@essence-lang/runtime/Testing"

// Which tests a change reached, so the live session re-runs only those. Pure
// functions of their arguments, read off coverage attribution. See "Narrowing
// a cycle" in DEVELOPMENT.md.

// One Module's coverage table, plus which tests touched each point:
// `points[i]` and `tests[i]` share the index a `test-coverage` event names. A
// point's `count` tells a dead point from one reached at load.
type ModulePoints = {
	points: Array<CoveredPoint>
	tests: Array<Set<string>>
	// The points this Module ran by being loaded, which no test can be credited
	// with. A change covering one runs whole.
	loaded: Set<number>
}

// One entry's attribution, from one whole cycle, so every index fits one
// table. `byModule` covers every Module the bundle reached; `text` holds the
// text its Positions were measured in.
export type EntryAttribution = {
	entry: string
	byModule: Map<string, ModulePoints>
	text: Map<string, string>
}

// The attribution of one Module, folded out of a cycle's `coverage` and
// `test-coverage` events. Unlike `attributionOf` for `--mutate`, it keeps the
// whole `CoveredPoint` and a Set of tests per point.
export function buildAttribution(
	events: Array<TestEvent>,
): Map<string, ModulePoints> {
	let byModule = new Map<string, ModulePoints>()

	for (let event of events) {
		if (event.kind !== "coverage" || event.module === null) {
			continue
		}

		byModule.set(event.module, {
			points: event.points,
			tests: event.points.map(() => new Set<string>()),
			loaded: new Set(event.loaded ?? []),
		})
	}

	for (let event of events) {
		if (event.kind !== "test-coverage" || event.module === null) {
			continue
		}

		let held = byModule.get(event.module)

		if (held === undefined) {
			continue
		}

		for (let point of event.points) {
			held.tests[point]?.add(event.id)
		}
	}

	return byModule
}

function lineCount(text: string): number {
	// `split` counts the lines a 1-based line number refers to, including a last
	// line without a newline.
	return text.split("\n").length
}

// The span of old text a change touched, from the first differing line to the
// last, in the stored table's coordinates. Null for identical text, and for a
// change that added or removed lines, whose later points all moved.
export function changedRange(
	oldText: string,
	newText: string,
): common.Position | null {
	if (oldText === newText || lineCount(oldText) !== lineCount(newText)) {
		return null
	}

	let oldLines = oldText.split("\n")
	let newLines = newText.split("\n")
	let total = oldLines.length
	let prefix = 0

	while (prefix < total && oldLines[prefix] === newLines[prefix]) {
		prefix += 1
	}

	let suffix = 0

	while (
		suffix < total - prefix &&
		oldLines[total - 1 - suffix] === newLines[total - 1 - suffix]
	) {
		suffix += 1
	}

	// 1-based and inclusive, never empty: the line counts match and the texts
	// differ.
	let firstLine = prefix + 1
	let lastLine = total - suffix

	return {
		start: { line: firstLine, column: 1 },
		end: {
			line: lastLine,
			column: (oldLines[lastLine - 1]?.length ?? 0) + 1,
		},
	}
}

// The tests to re-run for a change to fresh entries, or null to run the
// reached files whole. An entry owning none of the tests runs nothing. See
// "Narrowing a cycle" in DEVELOPMENT.md.
export function affectedTests(
	entries: Array<EntryAttribution>,
	changed: Array<string>,
	currentText: (file: string) => string | undefined,
	reaches: (entry: string, file: string) => boolean,
): Array<string> | null {
	let affected = new Set<string>()

	for (let attribution of entries) {
		for (let file of changed) {
			let held = attribution.byModule.get(file)

			// `reached` picked this entry up for another changed file.
			if (held === undefined) {
				if (reaches(attribution.entry, file)) {
					return null
				}

				continue
			}

			let old = attribution.text.get(file)
			let now = currentText(file)

			if (old === undefined || now === undefined) {
				return null
			}

			let range = changedRange(old, now)

			if (range === null) {
				// Identical text leaves this entry alone; a line-count change is refused,
				// which runs whole.
				if (old === now) {
					continue
				}

				return null
			}

			for (let index of coveringPoints(
				held.points.map((point) => point.position),
				range,
			)) {
				let point = held.points[index]
				let tests = held.tests[index]

				if (point === undefined || tests === undefined) {
					continue
				}

				// A point reached at load is checked before its tests: a test that read the
				// load-time result never touched it, so it runs whole.
				if (held.loaded.has(index)) {
					return null
				}

				if (tests.size > 0) {
					for (let id of tests) {
						affected.add(id)
					}
				} else if (point.count > 0) {
					// Reached by no test's span, so reached at load.
					return null
				}
			}
		}
	}

	return affected.size > 0 ? [...affected] : null
}
