import * as path from "node:path"

import { renderDiagnostics } from "../diagnostics/render"
import type { common } from "../interfaces/index"
import type { CompileOutcome, StageName } from "./pipeline"
import type { Terminal } from "./terminal"
import type { Palette, Theme } from "./theme"
import { visibleLength } from "./theme"

// NOTE: Every line the CLI prints about a finished compilation is produced
// here, as strings, so that the shape of the output can be tested without a
// terminal and so that no command grows its own private way of saying that
// something succeeded.

const BAR_WIDTH = 24
const INDENT = "  "

export type ReportContext = {
	terminal: Terminal
	theme: Theme
	palette: Palette
	verbose: boolean
	quiet: boolean
}

export function formatBytes(bytes: number): string {
	if (bytes < 1000) {
		return `${bytes} B`
	}

	if (bytes < 1000 * 1000) {
		return `${(bytes / 1000).toFixed(1)} kB`
	}

	return `${(bytes / (1000 * 1000)).toFixed(2)} MB`
}

// NOTE: Roughly two significant digits at every scale, so that a column of
// durations spanning three orders of magnitude stays readable and a stage that
// took no measurable time is not reported as having taken exactly zero.
export function formatDuration(milliseconds: number): string {
	if (milliseconds < 1) {
		return `${milliseconds.toFixed(2)} ms`
	}

	if (milliseconds < 10) {
		return `${milliseconds.toFixed(1)} ms`
	}

	if (milliseconds < 1000) {
		return `${Math.round(milliseconds)} ms`
	}

	return `${(milliseconds / 1000).toFixed(2)} s`
}

// NOTE: An output path given as an absolute path is usually still inside the
// project, and the part that matters is the part below the working directory.
// The longer of the two spellings is never the more useful one.
export function displayPath(fileName: string): string {
	let relative = path.relative(process.cwd(), fileName)

	if (relative === "" || relative.startsWith("..")) {
		return fileName
	}

	return relative.length < fileName.length ? relative : fileName
}

export function countDiagnostics(diagnostics: Array<common.Diagnostic>): {
	errors: number
	warnings: number
} {
	let errors = 0
	let warnings = 0

	for (let diagnostic of diagnostics) {
		if (diagnostic.severity === "error") {
			errors += 1
		} else {
			warnings += 1
		}
	}

	return { errors, warnings }
}

export function pluralise(count: number, singular: string): string {
	return count === 1 ? `${count} ${singular}` : `${count} ${singular}s`
}

function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleLength(text)))
}

function padVisibleStart(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleLength(text))) + text
}

// NOTE: Diagnostics are rendered by the shared Ariadne renderer, the same one
// the Language Server output is checked against, so a Diagnostic looks
// identical wherever it is shown.
export function renderDiagnosticsFor(
	outcome: CompileOutcome,
	context: ReportContext,
): string | null {
	if (outcome.diagnostics.length === 0) {
		return null
	}

	let rendered = renderDiagnostics(
		outcome.diagnostics,
		outcome.sourceText,
		outcome.inputFileName,
		{ color: context.theme.color },
	)

	return rendered.replace(/\n$/, "")
}

function stageBar(
	duration: number,
	longest: number,
	context: ReportContext,
): string {
	if (longest <= 0) {
		return ""
	}

	let filled = Math.round((duration / longest) * BAR_WIDTH)
	let { palette, theme } = context

	if (filled === 0) {
		return palette.faint(theme.symbols.barEmpty)
	}

	return palette.accent(theme.symbols.bar.repeat(filled))
}

export function renderStageBreakdown(
	outcome: CompileOutcome,
	context: ReportContext,
): Array<string> {
	if (outcome.timings.length === 0) {
		return []
	}

	let { palette } = context
	let longest = outcome.timings.reduce(
		(max, timing) => Math.max(max, timing.duration),
		0,
	)
	let nameWidth = outcome.timings.reduce(
		(max, timing) => Math.max(max, timing.name.length),
		0,
	)
	let durations = outcome.timings.map((timing) =>
		formatDuration(timing.duration),
	)
	let durationWidth = durations.reduce(
		(max, text) => Math.max(max, text.length),
		0,
	)

	return outcome.timings.map((timing, index) => {
		let name = palette.muted(padVisible(timing.name, nameWidth))
		let duration = padVisibleStart(durations[index], durationWidth)

		return `${INDENT}${INDENT}${name}  ${duration}  ${stageBar(
			timing.duration,
			longest,
			context,
		)}`
	})
}

function outcomeSymbol(
	outcome: CompileOutcome,
	context: ReportContext,
): string {
	let { palette, theme } = context

	if (!outcome.ok) {
		return palette.error(theme.symbols.error)
	}

	let { warnings } = countDiagnostics(outcome.diagnostics)

	return warnings > 0
		? palette.warning(theme.symbols.warning)
		: palette.success(theme.symbols.success)
}

function headline(outcome: CompileOutcome, context: ReportContext): string {
	let { palette, theme } = context
	let symbol = outcomeSymbol(outcome, context)
	let input = palette.path(displayPath(outcome.inputFileName))

	if (!outcome.ok) {
		let { errors } = countDiagnostics(outcome.diagnostics)
		let detail = errors === 0 ? "failed" : pluralise(errors, "error")

		return `${INDENT}${symbol} ${input} ${palette.error(detail)}`
	}

	if (outcome.outputFileName === null) {
		return `${INDENT}${symbol} ${input} ${palette.muted("no errors")}`
	}

	return `${INDENT}${symbol} ${input} ${palette.muted(theme.symbols.arrow)} ${palette.output(
		displayPath(outcome.outputFileName),
	)}`
}

function sizeLine(
	outcome: CompileOutcome,
	context: ReportContext,
): string | null {
	if (outcome.bytes === null) {
		return null
	}

	let { palette, theme } = context
	let size = palette.number(formatBytes(outcome.bytes))
	let gzip =
		outcome.gzipBytes === null
			? ""
			: ` ${palette.faint(theme.symbols.bullet)} ${palette.muted(
					`${formatBytes(outcome.gzipBytes)} gzipped`,
				)}`

	return `${INDENT}${INDENT}${palette.muted(padVisible("output", 8))}${size}${gzip}`
}

function warningLine(
	outcome: CompileOutcome,
	context: ReportContext,
): string | null {
	let { warnings } = countDiagnostics(outcome.diagnostics)

	if (warnings === 0 || !outcome.ok) {
		return null
	}

	let { palette } = context

	return `${INDENT}${INDENT}${palette.muted(padVisible("notes", 8))}${palette.warning(
		pluralise(warnings, "warning"),
	)}`
}

// NOTE: The full report for a single file. The stage breakdown is the point of
// it — it is the only place the cost of the Compiler's own stages is visible,
// and it is what makes a slow compilation explainable rather than mysterious.
export function renderSingleReport(
	outcome: CompileOutcome,
	context: ReportContext,
): string {
	let { palette } = context
	let lines: Array<string> = [headline(outcome, context)]

	if (context.quiet) {
		return lines.join("\n")
	}

	if (!outcome.ok) {
		if (outcome.failedStage !== null) {
			lines.push(
				`${INDENT}${INDENT}${palette.muted(
					`stopped while ${stageVerb(outcome.failedStage)}`,
				)}`,
			)
		}

		if (outcome.stack !== null && context.verbose) {
			lines.push("")

			for (let line of outcome.stack.split("\n")) {
				lines.push(`${INDENT}${INDENT}${palette.faint(line)}`)
			}
		}

		return lines.join("\n")
	}

	lines.push("")
	lines.push(...renderStageBreakdown(outcome, context))
	lines.push("")

	let size = sizeLine(outcome, context)

	if (size !== null) {
		lines.push(size)
	}

	let warnings = warningLine(outcome, context)

	if (warnings !== null) {
		lines.push(warnings)
	}

	lines.push(
		`${INDENT}${INDENT}${palette.muted(padVisible("total", 8))}${palette.number(
			formatDuration(outcome.duration),
		)}`,
	)

	return lines.join("\n")
}

// NOTE: While watching, a rebuild is one line. The report form would push the
// previous rebuilds — and the Diagnostics that matter — off the screen after
// a handful of saves.
export function renderWatchLine(
	outcome: CompileOutcome,
	context: ReportContext,
	timestamp: string,
): string {
	let { palette, theme } = context
	let symbol = outcomeSymbol(outcome, context)
	let time = palette.faint(timestamp)
	let input = palette.path(displayPath(outcome.inputFileName))

	if (!outcome.ok) {
		let { errors } = countDiagnostics(outcome.diagnostics)

		return `${INDENT}${symbol} ${time}  ${input}  ${palette.error(
			errors === 0 ? "failed" : pluralise(errors, "error"),
		)}`
	}

	let size =
		outcome.bytes === null
			? ""
			: `  ${palette.number(formatBytes(outcome.bytes))}`
	let target =
		outcome.outputFileName === null
			? ""
			: ` ${palette.muted(theme.symbols.arrow)} ${palette.output(
					displayPath(outcome.outputFileName),
				)}`

	return `${INDENT}${symbol} ${time}  ${input}${target}${size}  ${palette.muted(
		formatDuration(outcome.duration),
	)}`
}

function stageVerb(stage: StageName): string {
	let verbs: Record<StageName, string> = {
		read: "reading the file",
		parse: "parsing",
		enrich: "inferring types",
		validate: "validating",
		simplify: "simplifying",
		optimise: "optimising",
		generate: "generating JavaScript",
		bundle: "bundling",
		write: "writing the output",
	}

	return verbs[stage]
}

// NOTE: The per-file table for a batch. One line each, aligned into columns,
// so that an unusually large or slow file stands out by shape alone.
export function renderBatchReport(
	outcomes: Array<CompileOutcome>,
	context: ReportContext,
	details: { workers: number; duration: number },
): string {
	let { palette, theme } = context
	let succeeded = outcomes.filter((outcome) => outcome.ok)
	let failed = outcomes.filter((outcome) => !outcome.ok)
	let warnings = outcomes.reduce(
		(total, outcome) =>
			total + countDiagnostics(outcome.diagnostics).warnings,
		0,
	)

	// NOTE: `check` produces no output files, so the whole output half of the
	// table — arrow, path, size — is dropped rather than shown empty.
	let emits = outcomes.some((outcome) => outcome.outputFileName !== null)
	let summary: Array<string> = []

	if (succeeded.length > 0) {
		summary.push(
			`${palette.success(theme.symbols.success)} ${pluralise(
				succeeded.length,
				"file",
			)} ${emits ? "compiled" : "checked"}`,
		)
	}

	if (failed.length > 0) {
		summary.push(
			`${palette.error(theme.symbols.error)} ${failed.length} failed`,
		)
	}

	if (warnings > 0) {
		summary.push(
			`${palette.warning(theme.symbols.warning)} ${pluralise(
				warnings,
				"warning",
			)}`,
		)
	}

	let lines: Array<string> = [
		`${INDENT}${summary.join(`  ${palette.faint(theme.symbols.bullet)}  `)}`,
	]

	if (context.quiet) {
		return lines.join("\n")
	}

	lines.push("")

	let inputTexts = outcomes.map((outcome) =>
		displayPath(outcome.inputFileName),
	)
	let inputWidth = inputTexts.reduce(
		(max, text) => Math.max(max, text.length),
		0,
	)
	let outputTexts = outcomes.map((outcome) =>
		outcome.ok && outcome.outputFileName !== null
			? displayPath(outcome.outputFileName)
			: "",
	)
	let outputWidth = outputTexts.reduce(
		(max, text) => Math.max(max, text.length),
		0,
	)
	let sizeTexts = outcomes.map((outcome) =>
		outcome.bytes === null ? "" : formatBytes(outcome.bytes),
	)
	let sizeWidth = sizeTexts.reduce(
		(max, text) => Math.max(max, text.length),
		0,
	)

	for (let [index, outcome] of outcomes.entries()) {
		let symbol = outcomeSymbol(outcome, context)
		let input = padVisible(palette.path(inputTexts[index]), inputWidth)
		let duration = padVisibleStart(formatDuration(outcome.duration), 8)

		if (!outcome.ok) {
			let { errors } = countDiagnostics(outcome.diagnostics)

			lines.push(
				`${INDENT}${INDENT}${symbol} ${input}    ${palette.error(
					errors === 0 ? "failed" : pluralise(errors, "error"),
				)}`,
			)

			continue
		}

		if (!emits) {
			lines.push(
				`${INDENT}${INDENT}${symbol} ${input}  ${palette.muted(duration)}`,
			)

			continue
		}

		let output = padVisible(palette.output(outputTexts[index]), outputWidth)
		let size = padVisibleStart(palette.number(sizeTexts[index]), sizeWidth)

		lines.push(
			`${INDENT}${INDENT}${symbol} ${input} ${palette.muted(
				theme.symbols.arrow,
			)} ${output}  ${size}  ${palette.muted(duration)}`,
		)
	}

	let totalBytes = outcomes.reduce(
		(total, outcome) => total + (outcome.bytes ?? 0),
		0,
	)

	lines.push("")

	let emitted =
		totalBytes > 0
			? `${palette.number(formatBytes(totalBytes))} emitted across ${pluralise(
					succeeded.length,
					"file",
				)} `
			: `${pluralise(succeeded.length, "file")} checked `

	let workers =
		details.workers > 1
			? ` ${palette.faint(
					`${theme.symbols.bullet} ${details.workers} workers`,
				)}`
			: ""

	lines.push(
		`${INDENT}${INDENT}${palette.muted(emitted)}${palette.muted("in")} ${palette.number(
			formatDuration(details.duration),
		)}${workers}`,
	)

	return lines.join("\n")
}
