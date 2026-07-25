import type { common } from "../interfaces/index"
import type { CompileOutcome } from "./pipeline"

// NOTE: The machine-readable form of a run. Positions are flattened to plain
// line and column numbers — a consumer should not have to know the Compiler's
// internal Position shape — and every field is present on every entry, so a
// reader never has to distinguish "absent" from "not applicable".

export type JSONDiagnostic = {
	file: string
	severity: common.DiagnosticSeverity
	message: string
	code: string | null
	line: number | null
	column: number | null
	endLine: number | null
	endColumn: number | null
}

export type JSONFile = {
	input: string
	output: string | null
	ok: boolean
	bytes: number | null
	gzipBytes: number | null
	durationMs: number
	stages: Record<string, number>
	diagnostics: Array<JSONDiagnostic>
}

export type JSONReport = {
	version: string
	command: string
	ok: boolean
	errors: number
	warnings: number
	durationMs: number
	files: Array<JSONFile>
}

function toJSONDiagnostic(
	diagnostic: common.Diagnostic,
	file: string,
): JSONDiagnostic {
	return {
		file,
		severity: diagnostic.severity,
		message: diagnostic.message,
		code: diagnostic.code ?? null,
		line: diagnostic.position?.start.line ?? null,
		column: diagnostic.position?.start.column ?? null,
		endLine: diagnostic.position?.end.line ?? null,
		endColumn: diagnostic.position?.end.column ?? null,
	}
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000
}

export function toJSONReport(
	outcomes: Array<CompileOutcome>,
	details: { command: string; version: string; duration: number },
): JSONReport {
	let errors = 0
	let warnings = 0

	let files = outcomes.map<JSONFile>((outcome) => {
		let stages: Record<string, number> = {}

		for (let timing of outcome.timings) {
			stages[timing.name] = round(timing.duration)
		}

		for (let diagnostic of outcome.diagnostics) {
			if (diagnostic.severity === "error") {
				errors += 1
			} else {
				warnings += 1
			}
		}

		return {
			input: outcome.inputFileName,
			output: outcome.outputFileName,
			ok: outcome.ok,
			bytes: outcome.bytes,
			gzipBytes: outcome.gzipBytes,
			durationMs: round(outcome.duration),
			stages,
			diagnostics: outcome.diagnostics.map((diagnostic) =>
				toJSONDiagnostic(diagnostic, outcome.inputFileName),
			),
		}
	})

	return {
		version: details.version,
		command: details.command,
		ok: outcomes.every((outcome) => outcome.ok),
		errors,
		warnings,
		durationMs: round(details.duration),
		files,
	}
}

export function toJSONUsageError(
	message: string,
	details: { command: string; version: string },
): JSONReport & { error: string } {
	return {
		version: details.version,
		command: details.command,
		ok: false,
		errors: 1,
		warnings: 0,
		durationMs: 0,
		files: [],
		error: message,
	}
}
