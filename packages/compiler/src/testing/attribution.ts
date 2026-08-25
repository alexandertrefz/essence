import type { common } from "@essence-lang/interfaces"
import type { TestEvent } from "@essence-lang/runtime/Testing"

// NOTE: The span predicates from the pass whose points they describe — see the
// note beside them. The join is only correct while the two sides agree about
// what "holds" and "overlaps" mean, and one spelling is how they agree.
import { holds, overlaps } from "../optimiser/passes/instrumentCoverage"

// NOTE: The coverage-attribution join — which tests reached which points, and
// which points stand over a site — lives HERE rather than beside `--mutate`
// because two readers want it: the mutation driver in `@essence-lang/cli` and
// the Language Server's live session. The Language Server has no dependency
// edge to the CLI (no package may depend on cli), so the shared answer has to
// sit in a package they both already reach — compiler/testing, where the rest
// of a test run is folded and weighed.

// NOTE: One Module's coverage table as the join reads it: where each point
// stands, and which tests touched it. Both are indexed the same way, which is
// how a `test-coverage` event names points — by index into the `coverage`
// event's own table.
export type ModuleAttribution = {
	points: Array<common.Position>
	tests: Array<Array<string>>
}

export function attributionOf(
	events: Array<TestEvent>,
): Map<string, ModuleAttribution> {
	let byModule = new Map<string, ModuleAttribution>()

	for (let event of events) {
		if (event.kind !== "coverage" || event.module === null) {
			continue
		}

		byModule.set(event.module, {
			points: event.points.map((point) => point.position),
			tests: event.points.map(() => []),
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
			held.tests[point]?.push(event.id)
		}
	}

	return byModule
}

// NOTE: Which points of a Module's table stand over a site. Every point whose
// span HOLDS the site is one — a site inside a Statement inside a branch inside
// a Method body is covered by each of them, and a test that reached any of them
// reached the site.
//
// NOTE: The fallback is EVERY overlapping span, and it is not a nicety: a
// point's span is the span of the Node the instrumentation stood in front of,
// and a site inside a Statement that spans several lines is held by it — but a
// site standing in a Method's Parameter default, or in a Node whose Position the
// Simplifier trimmed differently, may only overlap. Answering with nothing there
// would report a well-tested site as UNCOVERED, which is the one wrong answer
// worth writing a fallback for.
//
// NOTE: All of them rather than the narrowest, because a site that STRADDLES two
// points is reached by whatever reached either — the two spans between them are
// the ground the site stands on, and picking the smaller one drops the tests of
// the other. The whole point of the join is that a mutant is judged by every
// test that could possibly notice it, and a covering set that is missing one is
// a survivor nobody can trust.
export function coveringPoints(
	points: Array<common.Position>,
	position: common.Position,
): Array<number> {
	let containing = points.flatMap((point, index) =>
		holds(point, position) ? [index] : [],
	)

	return containing.length > 0
		? containing
		: points.flatMap((point, index) =>
				overlaps(point, position) ? [index] : [],
			)
}
