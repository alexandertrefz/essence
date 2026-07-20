import {
	type Diagnostic,
	DiagnosticSeverity,
	DiagnosticTag,
	type Position,
	type Range,
} from "vscode-languageserver"

import type { common } from "../interfaces"

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

export function toLspDiagnostic(diagnostic: common.Diagnostic): Diagnostic {
	return {
		range: toLspRange(diagnostic.position),
		severity:
			diagnostic.severity === "error"
				? DiagnosticSeverity.Error
				: DiagnosticSeverity.Warning,
		message: diagnostic.message,
		source: "essence",
		code: diagnostic.code,
		tags: diagnostic.tags?.map((tag) =>
			tag === "unnecessary"
				? DiagnosticTag.Unnecessary
				: DiagnosticTag.Deprecated,
		),
	}
}
