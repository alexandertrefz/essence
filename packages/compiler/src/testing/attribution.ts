import type { common } from "@essence-lang/interfaces"
import type { TestEvent } from "@essence-lang/runtime/Testing"

// The instrumentation pass's own span predicates, so both sides agree on them.
import { holds, overlaps } from "../optimiser/passes/instrumentCoverage"

// One Module's coverage points and the tests that touched each, indexed as a
// `test-coverage` event names them. The join is shared by the CLI's mutation
// driver and the language server. See "Coverage attribution" in DEVELOPMENT.md.
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

// The points over a site: every point whose span holds it, or else every one
// that overlaps it. See "Coverage attribution" in DEVELOPMENT.md.
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
