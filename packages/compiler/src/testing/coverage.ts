import type { common } from "@essence-lang/interfaces"
import type {
	CoverageChoice,
	CoveredPoint,
	TestEvent,
} from "@essence-lang/runtime/Testing"

// What a coverage run means, read from its events alone, so every reader
// agrees. See "Coverage" in DEVELOPMENT.md.

export type CoveredPointRecord = CoveredPoint

// A counted ratio, for lines, branches and Cases alike.
export type CoverageRatio = { covered: number; total: number }

// A point never reached, such as a Match arm no value took. `scope` names the
// Method or Function and `label` the point.
export type MissedPoint = {
	kind: "branch" | "case"
	scope: string
	label: string
	// Whether the branch established a refinement, which a report may weigh
	// apart.
	refinement: boolean
	position: common.Position
}

export type FileCoverage = {
	// The Module's canonical path, or null for a Program a spec drives alone.
	module: string | null
	lines: CoverageRatio
	branches: CoverageRatio
	cases: CoverageRatio
	missed: Array<MissedPoint>
	// Every point, for an editor's gutter and an `lcov` writer.
	points: Array<CoveredPointRecord>
}

// A declared Choice and which of its Cases anything built, across the whole run.
export type ChoiceCoverage = {
	name: string
	module: string | null
	position: common.Position
	cases: Array<{ tag: string; constructed: boolean }>
}

export type CoverageSummary = {
	files: Array<FileCoverage>
	choices: Array<ChoiceCoverage>
}

export const emptyCoverage: CoverageSummary = { files: [], choices: [] }

export function hasCoverage(summary: CoverageSummary): boolean {
	return summary.files.some(isReported) || summary.choices.length > 0
}

// Whether a file has coverage to report. A file of tests alone has only
// constructions, which count towards Cases built but not towards the table.
export function isReported(file: FileCoverage): boolean {
	return (
		file.lines.total > 0 || file.branches.total > 0 || file.cases.total > 0
	)
}

// The stream folded into one record per Module. Reports of one table add, and a
// different table replaces the earlier whole. See "Coverage" in DEVELOPMENT.md.
export function collectCoverage(events: Array<TestEvent>): CoverageSummary {
	let files = new Map<string, Array<CoveredPointRecord>>()
	let choices: Array<CoverageChoice & { module: string | null }> = []

	for (let event of events) {
		if (event.kind !== "coverage") {
			continue
		}

		let key = keyOf(event.module)
		let existing = files.get(key)

		files.set(
			key,
			existing === undefined || !sameTable(existing, event.points)
				? event.points.map((point) => ({ ...point }))
				: existing.map((point, index) => ({
						...point,
						count: point.count + (event.points[index]?.count ?? 0),
					})),
		)

		for (let choice of event.choices) {
			choices.push({ ...choice, module: event.module })
		}
	}

	return resolved(
		[...files.entries()].map(([key, points]) =>
			fileCoverageOf(key === "" ? null : key, points),
		),
		dedupedChoices(choices),
	)
}

// One cycle's answer laid over the last: a re-run Module replaces its old
// record, and constructed Cases are worked out over the merged whole.
export function mergeCoverage(
	previous: CoverageSummary,
	next: CoverageSummary,
): CoverageSummary {
	let files = new Map(
		previous.files.map((file) => [keyOf(file.module), file]),
	)
	let choices = new Map(
		previous.choices.map((choice) => [choiceKeyOf(choice), choice]),
	)

	for (let file of next.files) {
		files.set(keyOf(file.module), file)
	}

	for (let choice of next.choices) {
		choices.set(choiceKeyOf(choice), choice)
	}

	return resolved(
		[...files.values()],
		[...choices.values()].map((choice) => ({
			name: choice.name,
			module: choice.module,
			position: choice.position,
			cases: choice.cases.map((entry) => entry.tag),
		})),
	)
}

// The files sorted and the Choices answered over the whole run.
function resolved(
	files: Array<FileCoverage>,
	choices: Array<CoverageChoice & { module: string | null }>,
): CoverageSummary {
	let constructed = new Map<string, number>()

	for (let file of files) {
		for (let point of file.points) {
			if (point.kind !== "construction" || point.tag === null) {
				continue
			}

			constructed.set(
				point.tag,
				(constructed.get(point.tag) ?? 0) + point.count,
			)
		}
	}

	return {
		files: files.sort((left, right) =>
			keyOf(left.module).localeCompare(keyOf(right.module)),
		),
		choices: choices
			.sort((left, right) =>
				`${keyOf(left.module)} ${left.name}`.localeCompare(
					`${keyOf(right.module)} ${right.name}`,
				),
			)
			.map((choice) => ({
				name: choice.name,
				module: choice.module,
				position: choice.position,
				cases: choice.cases.map((tag) => ({
					tag,
					constructed: (constructed.get(tag) ?? 0) > 0,
				})),
			})),
	}
}

function choiceKeyOf(choice: { module: string | null; name: string }): string {
	return `${keyOf(choice.module)} ${choice.name}`
}

// One Module's points counted up, lines as lines.
export function fileCoverageOf(
	module: string | null,
	points: Array<CoveredPointRecord>,
): FileCoverage {
	let lines = new Map<number, boolean>()
	let branches: CoverageRatio = { covered: 0, total: 0 }
	let cases: CoverageRatio = { covered: 0, total: 0 }
	let missed: Array<MissedPoint> = []

	for (let point of points) {
		// A construction is an Expression in a Statement counted already, so it says
		// nothing about lines.
		if (point.kind === "construction") {
			continue
		}

		// A branch and an arm count towards their line, as a Statement does.
		let line = point.position.start.line

		lines.set(line, (lines.get(line) ?? false) || point.count > 0)

		if (point.kind === "statement") {
			continue
		}

		let ratio = point.kind === "branch" ? branches : cases

		ratio.total += 1

		if (point.count > 0) {
			ratio.covered += 1

			continue
		}

		missed.push({
			kind: point.kind,
			scope: point.scope,
			label: point.label,
			refinement: point.refinement,
			position: point.position,
		})
	}

	return {
		module,
		lines: {
			covered: [...lines.values()].filter(Boolean).length,
			total: lines.size,
		},
		branches,
		cases,
		missed: missed.sort(byPosition),
		points,
	}
}

// A percentage, or null where there is nothing to measure. Rounded down, so
// 100% means every point.
export function percentageOf(ratio: CoverageRatio): number | null {
	return ratio.total === 0
		? null
		: Math.floor((ratio.covered / ratio.total) * 100)
}

// Every Case of every declared Choice that nothing built, one per line.
export function neverConstructed(
	summary: CoverageSummary,
): Array<{ choice: string; tag: string }> {
	return summary.choices.flatMap((choice) =>
		choice.cases
			.filter((entry) => !entry.constructed)
			.map((entry) => ({
				choice: choice.name,
				tag: caseNameOf(entry.tag),
			})),
	)
}

// A tag such as `Fixture#Forfeited` as a report names the Case, `#Forfeited`.
export function caseNameOf(tag: string): string {
	let hash = tag.lastIndexOf("#")

	return hash === -1 ? `#${tag}` : `#${tag.slice(hash + 1)}`
}

// Whether two reports are of one compile, so their counts may be added: each
// point has the same kind and start position.
function sameTable(
	left: Array<CoveredPointRecord>,
	right: Array<CoveredPointRecord>,
): boolean {
	return (
		left.length === right.length &&
		left.every((point, index) => {
			let other = right[index]!

			return (
				point.kind === other.kind &&
				point.position.start.line === other.position.start.line &&
				point.position.start.column === other.position.start.column
			)
		})
	)
}

function keyOf(module: string | null): string {
	return module ?? ""
}

// One Choice may be reported twice in a run, and is kept once by name and
// declaring Module.
function dedupedChoices(
	choices: Array<CoverageChoice & { module: string | null }>,
): Array<CoverageChoice & { module: string | null }> {
	let seen = new Map<string, CoverageChoice & { module: string | null }>()

	for (let choice of choices) {
		seen.set(`${keyOf(choice.module)} ${choice.name}`, choice)
	}

	return [...seen.values()]
}

function byPosition(left: MissedPoint, right: MissedPoint): number {
	return (
		left.position.start.line - right.position.start.line ||
		left.position.start.column - right.position.start.column
	)
}
