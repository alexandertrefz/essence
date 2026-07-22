import {
	type Diagnostic,
	DiagnosticSeverity,
	DiagnosticTag,
	type Position,
	type Range,
} from "vscode-languageserver"

import type { common } from "../interfaces/index"

export function toCursor(position: Position): common.Cursor {
	return { line: position.line + 1, column: position.character + 1 }
}

// NOTE: Compiler Positions are 1-based, LSP Ranges are 0-based. Diagnostics
// without a Position are mapped to the very start of the document.
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

// NOTE: The terminal renderer gives Labels their own arrows, Notes and Helps
// their own footers. The Language Server protocol has neither: a Diagnostic
// is one message plus related locations. So the primary Label's message is
// folded into the message — it is the sentence the arrow would have carried —
// and the Notes and Helps follow it as lines. Dropping them would make the
// Editor strictly worse informed than the terminal.
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
	// NOTE: Secondary Labels are what `relatedInformation` is for — an Editor
	// renders each as a link the reader can jump to, which is the closest
	// thing it has to the terminal renderer's second arrow.
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
				: DiagnosticSeverity.Warning,
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
