import type { CoverageSummary, FileCoverage } from "./coverage"
import { isReported, percentageOf } from "./coverage"

// The two file formats a coverage run is written as, produced as text for the
// caller to write. A CI job reads `lcov.info`, and only the compiler knows what
// a branch point was.

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

// The file name per format, so a caller naming a directory need not know it.
export function coverageReportFileName(format: CoverageReportFormat): string {
	return format === "lcov" ? "lcov.info" : "coverage.json"
}

// The `lcov` tracefile that coverage viewers read: `SF`, `DA`, `LF` and `LH` for
// lines, and `BRDA`, `BRF` and `BRH` for branches. A Match arm is written as a
// branch, in a block of its own, named by its label.
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

// The same answer as JSON in the compiler's own terms: Cases, refinement
// branches and scopes, which `lcov` can not carry.
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

// A `BRDA` record is four comma-separated fields, so a label's commas become
// semicolons. The JSON report keeps them.
function branchName(label: string): string {
	return label.replaceAll(",", ";")
}

// How often each line ran: the greatest count of the points on it.
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
