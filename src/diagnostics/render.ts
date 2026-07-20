import { type Cache, Config, Label, Report, Source } from "../ariadne/index"
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
	let labels: Array<Label> = []
	let primaryOffset = 0

	if (diagnostic.position !== null) {
		let start = toOffset(source, diagnostic.position.start)
		let end = Math.max(toOffset(source, diagnostic.position.end), start)

		labels.push(new Label({ start, end }))
		primaryOffset = start
	}

	let report = new Report({
		kind: diagnostic.severity,
		span: { start: primaryOffset, end: primaryOffset },
		message: diagnostic.message,
		labels,
		config: new Config({
			color: options.color ?? true,
			indexType: "utf16",
		}),
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

	return diagnostics
		.map((diagnostic) =>
			renderDiagnostic(diagnostic, source, fileName, options),
		)
		.join("")
}
