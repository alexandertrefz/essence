import type { common } from "@essence-lang/interfaces"
import type {
	CoverageChoice,
	CoveredPoint,
	TestEvent,
} from "@essence-lang/runtime/Testing"

// NOTE: What a coverage run MEANS, read back out of the event stream — the same
// discipline the run fold beside it keeps, and for the same reason: three
// readers want the answer (the command line's table, the files it writes, and
// the Language Server's per-file payload) and one of them must not be able to
// disagree with the other two about what 88% meant.
//
// NOTE: Everything here reads EVENTS. A `coverage` event carries the table the
// Compiler emitted and the count each point reached; nothing here goes back to
// a Program, a source file or a bundle.

export type CoveredPointRecord = CoveredPoint

// NOTE: A counted ratio, spelled the same for lines, branches and Cases so a
// reader of the summary is reading one thing three times.
export type CoverageRatio = { covered: number; total: number }

// NOTE: One point that could have been reached and was not — a Match arm no
// value took, a branch nothing entered. `scope` names the Method or Function it
// stands in and `label` what it is, so `Standings::compute › case #Postponed`
// is the two of them with an arrow between.
export type MissedPoint = {
	kind: "branch" | "case"
	scope: string
	label: string
	// NOTE: Whether the branch it stands on is a doorway — a condition that
	// established something. Refinement coverage is exactly this flag over
	// branch points, and a report may weigh a missed doorway differently from a
	// missed `else` that guards nothing.
	refinement: boolean
	position: common.Position
}

export type FileCoverage = {
	// NOTE: The Module's canonical path, or null for a compile that had none —
	// which the command line never produces and a single Program driven by a
	// spec does.
	module: string | null
	lines: CoverageRatio
	branches: CoverageRatio
	cases: CoverageRatio
	missed: Array<MissedPoint>
	// NOTE: Every point, kept whole. The ratios above are what a table shows;
	// an Editor drawing a gutter needs to know which LINE, and a `lcov` writer
	// needs every one of them.
	points: Array<CoveredPointRecord>
}

// NOTE: A declared Choice and which of its Cases anything built. It is answered
// across the WHOLE run rather than per file: a Choice is declared in one Module
// and constructed in any, and "no test ever builds a `#Forfeited`" is a claim
// about the run.
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

// NOTE: Whether a file has anything to SAY. A `Foo.tests.es` — imports and a
// tests section, no implementation at all — is instrumented for the Cases its
// tests construct and for nothing else, so it has counts and no coverage: a row
// of dashes about a file that is all tests tells a reader nothing. Its
// constructions still count towards which Cases were built, which is why it is
// kept in the summary rather than dropped from it.
export function isReported(file: FileCoverage): boolean {
	return (
		file.lines.total > 0 || file.branches.total > 0 || file.cases.total > 0
	)
}

// NOTE: The stream folded into one record per Module. One RUN may report a
// Module twice — two entries whose graphs both hold it each carry a copy, and
// each counts what it evaluated — so the counts are ADDED. Which is what
// happened: the Module really was loaded twice, and every ratio here asks
// whether a point was reached at all, so a doubled count changes nothing but
// the per-line numbers a viewer draws, where it is the truth.
//
// NOTE: Two reports of one Module that do not agree about the TABLE are two
// different compiles of it — a watch session mid-edit is the case — and the
// later one replaces the earlier whole. Adding them index by index would
// attribute one compile's counts to another compile's points.
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
			existing === undefined || existing.length !== event.points.length
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

// NOTE: One cycle's answer laid over the last one — what a watch session and
// the Language Server's session both need, because each cycle re-runs the
// tests a change REACHED and says nothing about the rest. A Module the new
// answer covers replaces the old one whole; a Module it does not keeps what it
// had. Which Cases were constructed is worked out again across the merged
// whole, because a Case built only by the file that was just re-run is still a
// Case somebody built.
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

// NOTE: The files sorted and the Choices answered — which Case anything built
// is a question about the WHOLE run, because a Choice is declared in one Module
// and constructed in any.
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

// NOTE: One Module's points, counted up. Lines are counted as LINES and not as
// points: two Statements on one line are one line, and a line either ran or it
// did not.
export function fileCoverageOf(
	module: string | null,
	points: Array<CoveredPointRecord>,
): FileCoverage {
	let lines = new Map<number, boolean>()
	let branches: CoverageRatio = { covered: 0, total: 0 }
	let cases: CoverageRatio = { covered: 0, total: 0 }
	let missed: Array<MissedPoint> = []

	for (let point of points) {
		// NOTE: A Case built at a line is an Expression, and the Statement it
		// stands in is counted already — so a construction says nothing about
		// whether a LINE ran, and a file that holds nothing else (a
		// `Foo.tests.es`, instrumented for the Cases its tests build) has no
		// coverage rather than a hundred per cent of nothing.
		if (point.kind === "construction") {
			continue
		}

		// NOTE: Every other kind counts towards its line — a branch and an arm
		// are places control arrives, exactly as a Statement is, and a line
		// whose only point is one of them either ran or it did not.
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

// NOTE: A percentage, or null where there was nothing to be a percentage OF. A
// file with no branches in it is not 0% branch-covered and it is not 100%
// either — the honest answer is a dash, and only the caller knows how to draw
// one.
export function percentageOf(ratio: CoverageRatio): number | null {
	return ratio.total === 0
		? null
		: Math.round((ratio.covered / ratio.total) * 100)
}

// NOTE: Every Case of every declared Choice that nothing built, flattened for a
// report that lists them one per line.
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

// NOTE: `Fixture#Forfeited` is how a tag is spelled everywhere it is COMPARED;
// `#Forfeited` is how a Case is written, and how a report names one under the
// Choice it already said.
export function caseNameOf(tag: string): string {
	let hash = tag.lastIndexOf("#")

	return hash === -1 ? `#${tag}` : `#${tag.slice(hash + 1)}`
}

function keyOf(module: string | null): string {
	return module ?? ""
}

// NOTE: One Choice may be reported by two Modules of one run — a file compiled
// as its own entry and again as somebody's dependency — and the two say the
// same thing. Kept by name and declaring Module.
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
