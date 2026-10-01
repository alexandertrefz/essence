import * as path from "node:path"

import {
	type Cache,
	type Color,
	ColorGenerator,
	Config,
	Label,
	paint,
	Report,
	Source,
} from "@essence-lang/ariadne"
import type { common } from "@essence-lang/interfaces"

import { countOf } from "../helpers/describe"

interface RenderOptions {
	color?: boolean
}

// How every report names a file: the shorter of its own path and its path
// from the working directory, when it lies inside that. The CLI and the client
// share it, so a file has one name everywhere.
export function displayPath(fileName: string): string {
	let relative = path.relative(process.cwd(), fileName)

	if (relative === "" || relative.startsWith("..")) {
		return fileName
	}

	return relative.length < fileName.length ? relative : fileName
}

// Compiler Positions are 1-based with exclusive end columns, counted in UTF-16
// code units, so the report's Config reads offsets as "utf16".
function toOffset(source: Source, cursor: common.Cursor): number {
	let line = source.line(
		Math.min(Math.max(cursor.line - 1, 0), source.lines.length - 1),
	)

	if (line === null) {
		return 0
	}

	let offset = line.utf16Offset + Math.max(cursor.column - 1, 0)

	return Math.min(offset, source.text.length)
}

// A Position past the end of the source, or inverted after clamping, still
// renders. Ariadne's `Label` throws on an inverted span.
function toSpan(
	source: Source,
	position: common.Position,
): { start: number; end: number } {
	let start = toOffset(source, position.start)

	return { start, end: Math.max(toOffset(source, position.end), start) }
}

function namedCache(source: Source, fileName: string): Cache<unknown> {
	return {
		fetch: () => source,
		display: () => fileName,
	}
}

export function renderDiagnostic(
	diagnostic: common.Diagnostic,
	source: Source,
	fileName: string,
	options: RenderOptions = {},
): string {
	let color = options.color ?? true
	let config = new Config({ color, indexType: "utf16" })
	let severityColor =
		diagnostic.severity === "error"
			? config.errorColor()
			: diagnostic.severity === "warning"
				? config.warningColor()
				: config.adviceColor()
	// Each secondary Label gets its own color, since crossing arrows of one
	// color can not be followed.
	let secondaryColors = new ColorGenerator()
	let labels: Array<Label> = []
	let primaryOffset = 0

	if (diagnostic.position !== null) {
		primaryOffset = toSpan(source, diagnostic.position).start
	}

	// A Diagnostic with a Position always has a Label, as its Type requires.
	for (let label of diagnostic.labels) {
		let isPrimary = (label.kind ?? "primary") === "primary"
		let labelColor: Color | null = null

		if (color) {
			labelColor = isPrimary ? severityColor : secondaryColors.next()
		}

		labels.push(
			new Label(toSpan(source, label.position), {
				message: label.message,
				color: labelColor ?? undefined,
				// Ariadne groups Labels into one excerpt only while their order
				// agrees with their line order, so the array index would split
				// a report.
				order: label.order ?? 0,
				// The primary Label wins where spans overlap.
				priority: isPrimary ? 1 : 0,
			}),
		)
	}

	let report = new Report({
		// Ariadne calls an `information` Diagnostic "advice".
		kind:
			diagnostic.severity === "information"
				? "advice"
				: diagnostic.severity,
		span: { start: primaryOffset, end: primaryOffset },
		code: diagnostic.code,
		message: diagnostic.message,
		labels,
		notes: diagnostic.notes,
		helps: diagnostic.helps,
		config,
	})

	return report.render(namedCache(source, fileName))
}

export function renderDiagnostics(
	diagnostics: Array<common.Diagnostic>,
	sourceText: string,
	fileName: string,
	options: RenderOptions = {},
): string {
	let source = new Source(sourceText)

	// A blank line between reports, so that the next one is easy to find.
	let reports = diagnostics
		.map((diagnostic) =>
			renderDiagnostic(diagnostic, source, fileName, options),
		)
		.join("\n")

	return `${reports}${renderSummary(diagnostics, options)}`
}

// The tally goes under the reports, where it tells a reader who has scrolled
// whether that was all of them.
function renderSummary(
	diagnostics: Array<common.Diagnostic>,
	options: RenderOptions,
): string {
	if (diagnostics.length === 0) {
		return ""
	}

	let config = new Config({ color: options.color ?? true })
	let errors = diagnostics.filter(
		(diagnostic) => diagnostic.severity === "error",
	).length
	let remarks = diagnostics.filter(
		(diagnostic) => diagnostic.severity === "information",
	).length
	let warnings = diagnostics.length - errors - remarks
	let counts: Array<string> = []

	if (errors > 0) {
		counts.push(paint(countOf(errors, "error"), config.errorColor()))
	}

	if (warnings > 0) {
		counts.push(paint(countOf(warnings, "warning"), config.warningColor()))
	}

	if (remarks > 0) {
		counts.push(paint(countOf(remarks, "remark"), config.adviceColor()))
	}

	return `\n${paint("───", config.marginColor())} ${counts.join(", ")}\n`
}
