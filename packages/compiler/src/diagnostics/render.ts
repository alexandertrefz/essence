import {
	type Cache,
	type Color,
	ColorGenerator,
	Config,
	Label,
	paint,
	Report,
	Source,
} from "../ariadne/index"
import { countOf } from "../helpers/index"
import type { common } from "../interfaces/index"

export interface RenderOptions {
	color?: boolean
}

// NOTE: Compiler Positions are 1-based with exclusive end columns, counted in
// UTF-16 code units (the lexer advances per code unit), hence the "utf16"
// index type below.
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

// NOTE: A Position that points past the end of the source — or backwards,
// after clamping — must still render. Ariadne's `Label` throws on an inverted
// span, so the clamping happens here rather than there.
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
			: config.warningColor()
	// NOTE: Secondary Labels each get their own generated color so that a
	// report with several of them stays readable — the arrows are what tie a
	// message to its span, and identically colored arrows that cross are not
	// followable.
	let secondaryColors = new ColorGenerator()
	let labels: Array<Label> = []
	let primaryOffset = 0

	if (diagnostic.position !== null) {
		primaryOffset = toSpan(source, diagnostic.position).start
	}

	// NOTE: No fallback for a Diagnostic with a Position and no Labels — the
	// `Diagnostic` type makes that combination unrepresentable, which is what
	// keeps a bare underline with no explanation from ever being rendered
	// again.
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
				// NOTE: Left at 0 unless a Diagnostic asks otherwise — Labels
				// are grouped into one source excerpt only while their order
				// agrees with their line order, and an order taken from the
				// array index tears a two-line report into two separate
				// excerpts.
				order: label.order ?? 0,
				// NOTE: The primary Label wins when spans overlap — the
				// mistake is what the reader came for, not the declaration it
				// is measured against.
				priority: isPrimary ? 1 : 0,
			}),
		)
	}

	let report = new Report({
		kind: diagnostic.severity,
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

	// NOTE: A blank line between reports. Each report already ends in a rule
	// that closes it off, but run together they read as one wall — the gap is
	// what lets the eye find where the next problem starts.
	let reports = diagnostics
		.map((diagnostic) =>
			renderDiagnostic(diagnostic, source, fileName, options),
		)
		.join("\n")

	return `${reports}${renderSummary(diagnostics, options)}`
}

// NOTE: The tally goes underneath rather than on top. Above the reports it
// would be read before it means anything; below, it answers the question the
// reader actually has once they have scrolled — whether that was all of it.
// Nothing is rendered when there is nothing to count.
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
	let warnings = diagnostics.length - errors
	let counts: Array<string> = []

	if (errors > 0) {
		counts.push(paint(countOf(errors, "error"), config.errorColor()))
	}

	if (warnings > 0) {
		counts.push(paint(countOf(warnings, "warning"), config.warningColor()))
	}

	return `\n${paint("───", config.marginColor())} ${counts.join(", ")}\n`
}
