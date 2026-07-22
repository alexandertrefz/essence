import {
	type Cache,
	type Color,
	ColorGenerator,
	Config,
	Label,
	Report,
	Source,
} from "../ariadne/index"
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

	if (diagnostic.labels !== undefined && diagnostic.labels.length > 0) {
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
					// NOTE: Left at 0 unless a Diagnostic asks otherwise —
					// Labels are grouped into one source excerpt only while
					// their order agrees with their line order, and an order
					// taken from the array index tears a two-line report into
					// two separate excerpts.
					order: label.order ?? 0,
					// NOTE: The primary Label wins when spans overlap — the
					// mistake is what the reader came for, not the
					// declaration it is measured against.
					priority: isPrimary ? 1 : 0,
				}),
			)
		}
	} else if (diagnostic.position !== null) {
		// NOTE: A Diagnostic that carries no Labels still gets its Position
		// underlined, bare, the way every Diagnostic was rendered before
		// Labels existed.
		labels.push(new Label(toSpan(source, diagnostic.position)))
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
	return diagnostics
		.map((diagnostic) =>
			renderDiagnostic(diagnostic, source, fileName, options),
		)
		.join("\n")
}
