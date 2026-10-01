import { displayPath } from "@essence-lang/compiler/diagnostics/render"
import type { common } from "@essence-lang/interfaces"

import { type CompileOutcome, ownDiagnostics } from "./pipeline"

// The machine-readable form of a run. Positions are plain line and column
// numbers, and every field is present on every entry.

type JSONDiagnostic = {
	file: string
	severity: common.DiagnosticSeverity
	message: string
	code: string | null
	line: number | null
	column: number | null
	endLine: number | null
	endColumn: number | null
}

type JSONFile = {
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
			// Every Diagnostic under the file it was written in, which with Modules is often
			// not the compiled entry.
			diagnostics: [
				...outcome.modules.flatMap((module) =>
					module.diagnostics.map((diagnostic) =>
						toJSONDiagnostic(
							diagnostic,
							displayPath(module.fileName),
						),
					),
				),
				...ownDiagnostics(outcome).map((diagnostic) =>
					toJSONDiagnostic(diagnostic, outcome.inputFileName),
				),
			],
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
