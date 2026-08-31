import { coveringPoints } from "@essence-lang/compiler/testing"
import type { common } from "@essence-lang/interfaces"
import type { CoveredPoint, TestEvent } from "@essence-lang/runtime/Testing"

// NOTE: Which tests a change reached, so the live session can re-run those and
// not every test of every file that imports the one that changed. Everything
// here is a function of its arguments — no session state, no Worker, no clock —
// which is what lets `tests/affected.spec.ts` pin the reasoning without an
// Editor. The session in `testSession.ts` holds the index this reads and feeds
// it the current buffers.
//
// NOTE: The whole thing rides on coverage. Per-test attribution — which test
// touched which point — is a fact the instrumentation records and the runtime
// emits as `test-coverage` events, so line-level selection is only ever a
// refinement AVAILABLE when `essence.tests.coverage` is on. With it off there
// is nothing to map a line to, and the session runs whole files as it always
// did. The fallback ladder is: the whole workspace, then the test files a
// change reached, then the tests within them a change reached — and every rung
// answering "run more" is the safe one.

// NOTE: One Module's coverage table as the join reads it, plus WHICH tests
// touched each point. `points[i]` and `tests[i]` are the same index — the index
// a `test-coverage` event names — so a point and the tests that reached it are
// read together. `points` keeps the whole `CoveredPoint` rather than only its
// Position, because the `count` is what tells a point nothing reached (dead, or
// pruned) apart from one reached at LOAD (a top-level Constant, a suite's
// setup) that no single test can be credited with — and those two must be
// treated differently, see `affectedTests`.
type ModulePoints = {
	points: Array<CoveredPoint>
	tests: Array<Set<string>>
	// NOTE: The point indices this Module ran simply by being LOADED — reached
	// by no single test's span, so no `tests` entry can name them. An edit to
	// one can change a test that read the load-time result without re-entering
	// the point, so a change covering one is a whole run, not a narrowing.
	loaded: Set<number>
}

// NOTE: One entry file's own attribution, built from ONE unnarrowed cycle so
// that every point index lines up with one compile's table — never a mix of two.
// `byModule` covers every instrumented Module the entry's bundle reached, not
// just the entry's own file: a test in `Reader.tests.es` reaches points in
// `Library.es`, and an edit to `Library.es` has to find it. `text` is what each
// of those Modules held WHEN this attribution was built — the coordinates the
// point Positions are in — so a change is measured against the same text the
// table was measured against.
export type EntryAttribution = {
	entry: string
	byModule: Map<string, ModulePoints>
	text: Map<string, string>
}

// NOTE: The attribution of one Module, folded out of a cycle's events. A
// `coverage` event carries the table and the load-time counts; a `test-coverage`
// event names, per test, the points it touched by index into that table. This
// is the same fold `attributionOf` does for `--mutate`, kept apart because the
// session wants the whole `CoveredPoint` (for the count) and a Set per point
// (it unions across tests), where the mutation driver wanted bare Positions.
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
	// NOTE: `split` counts the segments between newlines, which is the number of
	// lines a Position's 1-based line refers to — a file ending without a
	// trailing newline still has that last line.
	return text.split("\n").length
}

// NOTE: The span of OLD text a change touched, in the coordinates the stored
// table is in — so it maps onto the Positions that table already holds. Answered
// as the range from the first line that differs to the last, which over-states a
// scattered edit into one span rather than under-stating it: a wider range
// reaches more tests, which is the safe direction.
//
// NOTE: `null` for two cases the caller reads apart. Identical text is one — the
// entry's snapshot of this Module never changed, so nothing here concerns it.
// The other is a change that ADDED or REMOVED lines, and it is refused on
// purpose: every point below the edit would have moved, so the stored table's
// coordinates no longer describe the file, the coverage marks a client draws
// would sit a line off, and there is no honest way to narrow across it. An
// edit WITHIN the existing lines — the value a reader is iterating on, the
// operator they are trying — moves nothing, and that is exactly the loop this
// is for. Writing new lines is a whole run, which is what writing new code
// wants anyway.
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

	// NOTE: 1-based, inclusive. The line counts match and the texts differ, so
	// at least one line changed and the range is never empty.
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

// NOTE: The tests to re-run for a change, or `null` for "cannot say — run the
// reached files whole". Every entry handed in is already known FRESH: its
// attribution was built from an unnarrowed cycle whose snapshot is the text the
// change is measured against. What is left to decide is whether the change lands
// somewhere the attribution can speak for.
//
// It answers `null` — the whole-run fallback — whenever it cannot be SURE the
// set is complete:
//   - a changed file an entry reaches that is not in its table, or has no
//     snapshot (a file changed on disk and never opened) — nothing to map.
//   - a change that added or removed lines (`changedRange` refuses it).
//   - a changed point reached at LOAD by no single test (`count > 0`, no tests):
//     a top-level Constant or a suite's setup feeds tests whose spans never
//     touched it, so an edit there can change a test the attribution cannot name.
//   - an empty result: nothing concrete to narrow to, so run whole rather than
//     guess that nothing was affected.
//
// A non-empty result is the win: the cycle runs exactly those ids, and every
// reached entry that owns none of them runs nothing at all — the deselection a
// narrowed run already reports is what skips it.
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

			// NOTE: A changed file this entry does not reach is not this entry's
			// concern — `reached` picked the entry up for some OTHER changed file.
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
				// NOTE: Identical is "unchanged for this entry"; a line-count
				// change is one `changedRange` refuses, and refusing here is the
				// whole-run fallback.
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

				// NOTE: A point reached at LOAD is checked FIRST, before its
				// tests: a helper called both from a top-level Constant and
				// directly by a test has that test in its set AND ran at load,
				// and narrowing to the test alone would leave every test that
				// read the load-time result stale. Load makes it a whole run.
				if (held.loaded.has(index)) {
					return null
				}

				if (tests.size > 0) {
					for (let id of tests) {
						affected.add(id)
					}
				} else if (point.count > 0) {
					// NOTE: Reached, but by no test's span — belt to the load
					// check's braces, since a count with no test is a load hit.
					return null
				}
			}
		}
	}

	return affected.size > 0 ? [...affected] : null
}
