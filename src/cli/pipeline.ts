import { readFile } from "node:fs/promises"
import { gzipSync } from "node:zlib"

import { bundle, writeOutputs } from "../bundler/index"
import { containsErrors, placelessDiagnostic } from "../diagnostics/index"
import { enrichDocument, parseDocument } from "../documents"
import type { common } from "../interfaces/index"
import { optimise } from "../optimiser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: One description of the Compiler pipeline, used by both the in-process
// path and the worker path. Everything the CLI reports — stage timings, output
// sizes, which stage a compilation stopped at — is produced here, so the two
// paths can never drift into reporting different things.

export const stageNames = [
	"read",
	"parse",
	"enrich",
	"validate",
	"simplify",
	"optimise",
	"generate",
	"bundle",
	"write",
] as const

export type StageName = (typeof stageNames)[number]

export const stageLabels: Record<StageName, string> = {
	read: "reading",
	parse: "parsing",
	enrich: "inferring types",
	validate: "validating",
	simplify: "simplifying",
	optimise: "optimising",
	generate: "generating",
	bundle: "bundling",
	write: "writing",
}

export type StageTiming = {
	name: StageName
	duration: number
}

export type CompileRequest = {
	inputFileName: string
	outputFileName: string | null
	minify: boolean
	sourcemap: boolean
}

export type CompileOutcome = {
	inputFileName: string
	outputFileName: string | null
	ok: boolean
	sourceText: string
	diagnostics: Array<common.Diagnostic>
	timings: Array<StageTiming>
	duration: number
	bytes: number | null
	gzipBytes: number | null
	failedStage: StageName | null
	stack: string | null
}

export type ProgressReporter = (stage: StageName) => void

class Timeline {
	private timings: Array<StageTiming> = []
	private report: ProgressReporter | undefined

	constructor(report?: ProgressReporter) {
		this.report = report
	}

	async run<T>(stage: StageName, work: () => T | Promise<T>): Promise<T> {
		this.report?.(stage)

		let started = performance.now()

		try {
			return await work()
		} finally {
			this.timings.push({
				name: stage,
				duration: performance.now() - started,
			})
		}
	}

	get entries(): Array<StageTiming> {
		return this.timings
	}
}

function readError(error: unknown, fileName: string): common.Diagnostic {
	let code = (error as NodeJS.ErrnoException).code

	if (code === "ENOENT") {
		return placelessDiagnostic(
			"error",
			`No such file: ${fileName}`,
			"file-not-found",
		)
	}

	if (code === "EISDIR") {
		return placelessDiagnostic(
			"error",
			`${fileName} is a directory. Pass the source files inside it ` +
				`instead, for example ${fileName}/*.es`,
			"not-a-file",
		)
	}

	if (code === "EACCES") {
		return placelessDiagnostic(
			"error",
			`Not allowed to read ${fileName}`,
			"unreadable-file",
		)
	}

	return placelessDiagnostic(
		"error",
		`Could not read ${fileName}: ${
			error instanceof Error ? error.message : String(error)
		}`,
		"unreadable-file",
	)
}

export async function compileFile(
	request: CompileRequest,
	report?: ProgressReporter,
): Promise<CompileOutcome> {
	let started = performance.now()
	let timeline = new Timeline(report)
	let diagnostics: Array<common.Diagnostic> = []
	let sourceText = ""

	let finish = (
		ok: boolean,
		failedStage: StageName | null,
		extras: Partial<CompileOutcome> = {},
	): CompileOutcome => ({
		inputFileName: request.inputFileName,
		outputFileName: request.outputFileName,
		ok,
		sourceText,
		diagnostics,
		timings: timeline.entries,
		duration: performance.now() - started,
		bytes: null,
		gzipBytes: null,
		failedStage,
		stack: null,
		...extras,
	})

	try {
		try {
			sourceText = await timeline.run("read", () =>
				readFile(request.inputFileName, "utf8"),
			)
		} catch (error) {
			diagnostics.push(readError(error, request.inputFileName))

			return finish(false, "read")
		}

		// NOTE: Routed through the same seam the Language Server uses, so that
		// `esc check src/stdlib/List.es` and the Editor agree about the file
		// in front of them. Without it the CLI rejected the `declarations { … }`
		// header of the very sources it loads at startup — the exact inversion
		// of the invariant, and a compiler developer could not check their own
		// transcription.
		let parsed = await timeline.run("parse", () =>
			parseDocument(sourceText, request.inputFileName),
		)

		diagnostics.push(...parsed.diagnostics)

		if (containsErrors(diagnostics)) {
			return finish(false, "parse")
		}

		let enriched = await timeline.run("enrich", () =>
			enrichDocument(parsed.program, request.inputFileName),
		)

		diagnostics.push(...enriched.diagnostics)

		if (containsErrors(diagnostics)) {
			return finish(false, "enrich")
		}

		let validated = await timeline.run("validate", () =>
			validate(enriched.program),
		)

		diagnostics.push(...validated)

		if (containsErrors(diagnostics)) {
			return finish(false, "validate")
		}

		// NOTE: `check` stops here — everything past this point exists only to
		// produce a file, and produces no further Diagnostics about the source.
		if (request.outputFileName === null) {
			return finish(true, null)
		}

		let simplified = await timeline.run("simplify", () =>
			simplify(enriched.program),
		)

		let optimised = await timeline.run("optimise", () =>
			optimise(simplified),
		)

		let generated = await timeline.run("generate", () => rewrite(optimised))

		let bundled = await timeline.run("bundle", () =>
			bundle(generated, {
				sourceFileName: request.inputFileName,
				outputFileName: request.outputFileName as string,
				minify: request.minify,
				sourcemap: request.sourcemap,
			}),
		)

		diagnostics.push(...bundled.diagnostics)

		if (containsErrors(diagnostics)) {
			return finish(false, "bundle")
		}

		await timeline.run("write", () => writeOutputs(bundled.outputs))

		let primary = bundled.outputs.find(
			(output) => !output.path.endsWith(".map"),
		)
		let bytes = primary?.contents.byteLength ?? 0
		let gzipBytes =
			primary === undefined ? null : gzipSync(primary.contents).byteLength

		return finish(true, null, { bytes, gzipBytes })
	} catch (error) {
		// NOTE: A throw that reaches here is a Compiler bug rather than a
		// problem with the source. It is reported as a Diagnostic so that a
		// batch compile keeps going, and the stack is kept for --verbose.
		diagnostics.push(
			placelessDiagnostic(
				"error",
				`Internal Compiler error: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"internal-error",
			),
		)

		return finish(false, null, {
			stack: error instanceof Error ? (error.stack ?? null) : null,
		})
	}
}
