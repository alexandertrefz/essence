import type { common } from "@essence-lang/interfaces"
import {
	type Diagnostic,
	DiagnosticSeverity,
	DiagnosticTag,
	type Position,
	type Range,
} from "vscode-languageserver"

export function toCursor(position: Position): common.Cursor {
	return { line: position.line + 1, column: position.character + 1 }
}

// A whole Range, as a selection is read.
export function toRange(range: Range): common.Position {
	return { start: toCursor(range.start), end: toCursor(range.end) }
}

// Compiler Positions are 1-based, LSP Ranges 0-based. A Diagnostic without a
// Position maps to the document's start.
export function toLspRange(position: common.Position | null): Range {
	if (position === null) {
		return {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		}
	}

	return {
		start: {
			line: position.start.line - 1,
			character: position.start.column - 1,
		},
		end: {
			line: position.end.line - 1,
			character: position.end.column - 1,
		},
	}
}

// LSP has no Labels, Notes or Helps, so the primary Label's message joins the
// message, and the Notes and Helps follow as lines.
function toLspMessage(diagnostic: common.Diagnostic): string {
	let lines = [diagnostic.message]
	let primaryLabel = diagnostic.labels?.find(
		(label) => (label.kind ?? "primary") === "primary",
	)

	if (primaryLabel !== undefined) {
		lines[0] = `${diagnostic.message}: ${primaryLabel.message}`
	}

	for (let note of diagnostic.notes ?? []) {
		lines.push(`Note: ${note}`)
	}

	for (let help of diagnostic.helps ?? []) {
		lines.push(`Help: ${help}`)
	}

	return lines.join("\n")
}

export function toLspDiagnostic(
	diagnostic: common.Diagnostic,
	uri: string,
): Diagnostic {
	// Secondary Labels become `relatedInformation`, which an Editor shows as
	// links.
	let relatedInformation = (diagnostic.labels ?? [])
		.filter((label) => label.kind === "secondary")
		.map((label) => ({
			location: { uri, range: toLspRange(label.position) },
			message: label.message,
		}))

	return {
		range: toLspRange(diagnostic.position),
		severity:
			diagnostic.severity === "error"
				? DiagnosticSeverity.Error
				: diagnostic.severity === "warning"
					? DiagnosticSeverity.Warning
					: DiagnosticSeverity.Information,
		message: toLspMessage(diagnostic),
		source: "essence",
		code: diagnostic.code,
		tags: diagnostic.tags?.map((tag) =>
			tag === "unnecessary"
				? DiagnosticTag.Unnecessary
				: DiagnosticTag.Deprecated,
		),
		...(relatedInformation.length > 0 ? { relatedInformation } : {}),
	}
}
