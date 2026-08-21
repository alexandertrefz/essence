import type { CoverageSummary, FileCoverage } from "./coverage"
import { isReported, percentageOf } from "./coverage"

// NOTE: The two shapes a coverage run can be WRITTEN as, produced as text and
// written to disk by whoever asked. They live beside the fold rather than in
// the command line because what they mean is a property of the run and not of
// the terminal: a CI job reads `lcov.info`, and the Compiler is the thing that
// knows what a branch point was.

export type CoverageReportFormat = "lcov" | "json"

export const coverageReportFormats: ReadonlyArray<CoverageReportFormat> = [
	"lcov",
	"json",
]

export function isCoverageReportFormat(
	name: string,
): name is CoverageReportFormat {
	return (coverageReportFormats as ReadonlyArray<string>).includes(name)
}

// NOTE: What the written file is CALLED, per format — so a caller asking for a
// directory does not have to know either.
export function coverageReportFileName(format: CoverageReportFormat): string {
	return format === "lcov" ? "lcov.info" : "coverage.json"
}

// NOTE: `lcov`'s tracefile format, which is what every coverage viewer reads.
// Only the records that mean something here are written:
//
//   SF   the source file
//   DA   a line and how often it ran
//   LF/LH lines found / lines hit
//   BRDA a branch: line, block, branch number, taken count
//   BRF/BRH branches found / branches hit
//
// A Match arm is written as a BRANCH, because lcov has no notion of an
// exhaustive Case and a viewer that draws arms as branches is telling the
// reader the truth about them. Each point gets a block of its own and is named
// by its label, so a viewer shows `case #Postponed` rather than `1`.
export function toLcov(summary: CoverageSummary): string {
	let lines: Array<string> = []

	for (let file of summary.files) {
		if (file.module === null || !isReported(file)) {
			continue
		}

		lines.push("TN:")
		lines.push(`SF:${file.module}`)

		for (let [line, count] of lineCounts(file)) {
			lines.push(`DA:${line},${count}`)
		}

		lines.push(`LF:${file.lines.total}`)
		lines.push(`LH:${file.lines.covered}`)

		let block = 0

		for (let point of file.points) {
			if (point.kind !== "branch" && point.kind !== "case") {
				continue
			}

			lines.push(
				`BRDA:${point.position.start.line},${block},${branchName(
					point.label,
				)},${point.count}`,
			)
			block += 1
		}

		lines.push(`BRF:${file.branches.total + file.cases.total}`)
		lines.push(`BRH:${file.branches.covered + file.cases.covered}`)
		lines.push("end_of_record")
	}

	return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

// NOTE: The same answer as data, for a consumer that would rather read the
// Compiler's own vocabulary than lcov's — the Cases, the doorways and the
// scopes are all here, and none of them survive the translation above.
export function toCoverageJson(summary: CoverageSummary): string {
	return `${JSON.stringify(
		{
			schema: 1,
			files: summary.files.filter(isReported).map((file) => ({
				module: file.module,
				lines: file.lines,
				branches: file.branches,
				cases: file.cases,
				percentages: {
					lines: percentageOf(file.lines),
					branches: percentageOf(file.branches),
				},
				missed: file.missed,
				points: file.points,
			})),
			choices: summary.choices,
		},
		null,
		"\t",
	)}\n`
}

// NOTE: A `BRDA` record is four COMMA-separated fields, so a label holding a
// comma — `case { x: Integer, y: Integer }` is one an ordinary Record Matcher
// produces — would move the count into the name and leave the record
// unreadable. The commas go; the label with them intact is in the JSON report,
// which has no such trouble.
function branchName(label: string): string {
	return label.replaceAll(",", ";")
}

// NOTE: How often each line ran, which is the one thing lcov asks for that the
// point table does not hold directly: a line may carry several Statements, and
// what a viewer draws is the greatest of their counts — the line ran that often.
function lineCounts(file: FileCoverage): Array<[number, number]> {
	let counts = new Map<number, number>()

	for (let point of file.points) {
		if (point.kind === "construction") {
			continue
		}

		let line = point.position.start.line

		counts.set(line, Math.max(counts.get(line) ?? 0, point.count))
	}

	return [...counts.entries()].sort((left, right) => left[0] - right[0])
}
