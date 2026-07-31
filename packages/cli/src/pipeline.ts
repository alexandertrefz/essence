import { gzipSync } from "node:zlib"

import { writeOutputs } from "@essence-lang/compiler/bundler"
import {
	containsErrors,
	placelessDiagnostic,
} from "@essence-lang/compiler/diagnostics"
import {
	enrichDocument,
	isStdlibDocument,
	parseDocument,
} from "@essence-lang/compiler/documents"
import { emitBundle } from "@essence-lang/compiler/embed"
import {
	defaultOptimiserOptions,
	type OptimiserOptions,
} from "@essence-lang/compiler/optimiser"
import { validate } from "@essence-lang/compiler/validator"
import type { common } from "@essence-lang/interfaces"

import { type CompileSession, createCompileSession } from "./session"

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
	// NOTE: How the map reaches the output — `linked` beside it (the default),
	// `inline` inside it, which is what `run`'s transient output needs. Read
	// only when `sourcemap` is set.
	sourcemapMode?: "linked" | "inline"
	// NOTE: Which Optimiser passes to run. Absent means every one of them, which
	// is what a caller that offers no say — the Debug Adapter, a spec — compiles
	// with. It travels to a worker as part of the request, so a batch spread
	// across threads compiles every file under the Options the command line
	// asked for.
	optimisation?: OptimiserOptions
}

// NOTE: One file of the compiled graph, with the text its Diagnostics are
// rendered against. `Diagnostic` is deliberately not widened with a file of its
// own: which file a Diagnostic belongs to is a property of the collection it
// was gathered into, and every collection here is one Module's.
export type CompiledModule = {
	fileName: string
	sourceText: string
	diagnostics: Array<common.Diagnostic>
}

// NOTE: `diagnostics` is every Module's, in the order the Modules are listed,
// and then whatever belongs to the compilation itself rather than to a source
// file — an unreadable entry, a failed bundle, a Compiler that threw. The
// layout is what `ownDiagnostics` reads the tail off, so a Module dropped from
// a batch takes its own Diagnostics with it and leaves the rest standing.
export type CompileOutcome = {
	inputFileName: string
	outputFileName: string | null
	ok: boolean
	sourceText: string
	modules: Array<CompiledModule>
	diagnostics: Array<common.Diagnostic>
	timings: Array<StageTiming>
	duration: number
	bytes: number | null
	gzipBytes: number | null
	failedStage: StageName | null
	stack: string | null
}

export type ProgressReporter = (stage: StageName) => void

export function ownDiagnostics(
	outcome: CompileOutcome,
): Array<common.Diagnostic> {
	return outcome.diagnostics.slice(
		outcome.modules.reduce(
			(total, module) => total + module.diagnostics.length,
			0,
		),
	)
}

// NOTE: Every file of a batch reported by exactly one outcome. A dependency
// that is also an entry belongs to its own outcome; every other shared file
// goes to the first outcome that reached it. Only the Diagnostics move — the
// Module list stays whole, because `esc watch` reads it to learn which files a
// rebuild depends on, and a file two entries share has to wake both of them.
export function attributeDiagnostics(
	outcomes: Array<CompileOutcome>,
): Array<CompileOutcome> {
	if (outcomes.length < 2) {
		return outcomes
	}

	let owners = new Map<string, CompileOutcome>()

	for (let outcome of outcomes) {
		// NOTE: The entry Module of an outcome is the last one — everything
		// ahead of it is something it depends on. Read that way rather than by
		// canonicalising the name the caller wrote, so both sides of the
		// comparison are spellings the graph itself produced.
		let entry = outcome.modules.at(-1)

		if (entry !== undefined && !owners.has(entry.fileName)) {
			owners.set(entry.fileName, outcome)
		}
	}

	for (let outcome of outcomes) {
		for (let module of outcome.modules) {
			if (!owners.has(module.fileName)) {
				owners.set(module.fileName, outcome)
			}
		}
	}

	return outcomes.map((outcome) => {
		let own = ownDiagnostics(outcome)
		let modules = outcome.modules.map((module) =>
			owners.get(module.fileName) === outcome
				? module
				: { ...module, diagnostics: [] },
		)

		return {
			...outcome,
			modules,
			diagnostics: [
				...modules.flatMap((module) => module.diagnostics),
				...own,
			],
		}
	})
}

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
	let code = (error as NodeJS.ErrnoException | undefined)?.code

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

// NOTE: What the front of the pipeline produced: the Modules to report about,
// the typed Programs to emit from — one per Module, in the same order — and the
// stage it stopped at, if it did. `programs` is null exactly when nothing may
// be emitted, which is not the same as an empty graph.
type Front = {
	entryPath: string
	sourceText: string
	modules: Array<CompiledModule>
	programs: Array<common.typed.Program> | null
	diagnostics: Array<common.Diagnostic>
	failedStage: StageName | null
}

function unreadableFront(
	request: CompileRequest,
	entryPath: string,
	error: unknown,
): Front {
	return {
		entryPath,
		sourceText: "",
		modules: [],
		programs: null,
		diagnostics: [readError(error, request.inputFileName)],
		failedStage: "read",
	}
}

// NOTE: The graph the entry names, enriched. Every file it reaches is read,
// parsed and linked through the Session, so a batch loads each of them once
// however many of its entries reach it.
async function linkGraph(
	request: CompileRequest,
	timeline: Timeline,
	session: CompileSession,
): Promise<Front> {
	let read = await timeline.run("read", () =>
		session.read(request.inputFileName),
	)

	if ("error" in read) {
		return unreadableFront(request, read.filePath, read.error)
	}

	let parsed = await timeline.run("parse", () =>
		session.modules(request.inputFileName),
	)
	let modules = parsed.map<CompiledModule>((module) => ({
		fileName: module.filePath,
		sourceText: module.sourceText,
		diagnostics: [...module.diagnostics],
	}))
	let front: Front = {
		entryPath: read.filePath,
		sourceText: read.sourceText,
		modules,
		programs: null,
		diagnostics: [],
		failedStage: null,
	}

	// NOTE: A specifier that names nothing is a parse-stage answer as much as a
	// syntax error is: the graph resolved every entry while it was reading the
	// files, and linking a graph with a hole in it would report the same
	// mistake again as a name that is not in scope.
	if (containsErrors(modules.flatMap((module) => module.diagnostics))) {
		return { ...front, failedStage: "parse" }
	}

	let linked = await timeline.run("enrich", () =>
		session.linked(request.inputFileName),
	)

	front.modules = linked.map<CompiledModule>((module) => ({
		fileName: module.module.filePath,
		sourceText: module.module.sourceText,
		diagnostics: [...module.diagnostics],
	}))

	if (containsErrors(front.modules.flatMap((module) => module.diagnostics))) {
		return { ...front, failedStage: "enrich" }
	}

	return { ...front, programs: linked.map((module) => module.program) }
}

// NOTE: A standard library source, which is not a Module: it is one shared
// declaration space, its `declarations { … }` header is a permission no other
// file has, and its own names are already builtins by the time it is read.
// `enrichDocument` is what knows all three, and it takes one Program — so this
// file is compiled the way it was before Modules, alone.
//
// The seam matters beyond the standard library itself: `esc check` on one of
// its sources and the Editor's view of the same file have to agree, or a
// Compiler developer can not check their own transcription.
async function enrichDeclarations(
	request: CompileRequest,
	timeline: Timeline,
	session: CompileSession,
): Promise<Front> {
	let read = await timeline.run("read", () =>
		session.read(request.inputFileName),
	)

	if ("error" in read) {
		return unreadableFront(request, read.filePath, read.error)
	}

	let parsed = await timeline.run("parse", () =>
		parseDocument(read.sourceText, request.inputFileName),
	)
	let module: CompiledModule = {
		fileName: read.filePath,
		sourceText: read.sourceText,
		diagnostics: [...parsed.diagnostics],
	}
	let front: Front = {
		entryPath: read.filePath,
		sourceText: read.sourceText,
		modules: [module],
		programs: null,
		diagnostics: [],
		failedStage: null,
	}

	if (containsErrors(module.diagnostics)) {
		return { ...front, failedStage: "parse" }
	}

	let enriched = await timeline.run("enrich", () =>
		enrichDocument(parsed.program, request.inputFileName),
	)

	module.diagnostics.push(...enriched.diagnostics)

	if (containsErrors(module.diagnostics)) {
		return { ...front, failedStage: "enrich" }
	}

	return { ...front, programs: [enriched.program] }
}

export async function compileFile(
	request: CompileRequest,
	report?: ProgressReporter,
	session: CompileSession = createCompileSession([request.inputFileName]),
): Promise<CompileOutcome> {
	let started = performance.now()
	let timeline = new Timeline(report)
	let modules: Array<CompiledModule> = []
	let own: Array<common.Diagnostic> = []
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
		modules,
		diagnostics: [
			...modules.flatMap((module) => module.diagnostics),
			...own,
		],
		timings: timeline.entries,
		duration: performance.now() - started,
		bytes: null,
		gzipBytes: null,
		failedStage,
		stack: null,
		...extras,
	})

	try {
		let front = await (isStdlibDocument(request.inputFileName)
			? enrichDeclarations(request, timeline, session)
			: linkGraph(request, timeline, session))

		modules = front.modules
		own.push(...front.diagnostics)
		sourceText = front.sourceText

		if (front.failedStage !== null || front.programs === null) {
			return finish(false, front.failedStage)
		}

		let programs = front.programs

		// NOTE: Validation runs over the whole graph, and only once nothing in
		// it has reported an error — a Module that failed to enrich carries
		// Types that were never established, and validating those answers about
		// the failure rather than about the source.
		await timeline.run("validate", () => {
			for (let [index, program] of programs.entries()) {
				modules[index]?.diagnostics.push(...validate(program))
			}
		})

		if (containsErrors(modules.flatMap((module) => module.diagnostics))) {
			return finish(false, "validate")
		}

		// NOTE: `check` stops here — everything past this point exists only to
		// produce a file, and produces no further Diagnostics about the source.
		if (request.outputFileName === null) {
			return finish(true, null)
		}

		// NOTE: Everything past validation is the emitter's, which `esc`
		// SHARES with the in-memory compile rather than owning: what the stages
		// are, what order they run in and what each of them is handed is one
		// description, and it lives in the Compiler. What stays here is what is
		// the CLI's own — the Session's caches, and the timings this file
		// reports.
		let bundled = await emitBundle(
			{
				modules: programs.map((program, index) => ({
					filePath: modules[index]!.fileName,
					program,
					sourceText: modules[index]!.sourceText,
				})),
				entryPath: front.entryPath,
				sourceFileName: request.inputFileName,
				outputFileName: request.outputFileName,
				minify: request.minify,
				sourcemap: request.sourcemap,
				sourcemapMode: request.sourcemapMode,
				optimisation: request.optimisation ?? defaultOptimiserOptions,
			},
			{
				simplify: session.simplify,
				optimise: session.optimise,
				stage: (name, work) => timeline.run(name, work),
			},
		)

		own.push(...bundled.diagnostics)

		if (containsErrors(bundled.diagnostics)) {
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
		own.push(
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
