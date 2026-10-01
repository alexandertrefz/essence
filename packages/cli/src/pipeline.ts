import { readdirSync } from "node:fs"
import * as path from "node:path"
import { gzipSync } from "node:zlib"

import {
	analyseEnriched,
	analyseLinkedModules,
} from "@essence-lang/compiler/analysis"
import type {
	BundleOutput,
	ModuleSources,
} from "@essence-lang/compiler/bundler"
import { type CompileMode, modeOf } from "@essence-lang/compiler/compileMode"
import {
	containsErrors,
	placelessDiagnostic,
} from "@essence-lang/compiler/diagnostics"
import {
	enrichDocument,
	isStdlibDocument,
	parseDocument,
} from "@essence-lang/compiler/documents"
import { closestMatch } from "@essence-lang/compiler/helpers"
import type { ExportSurface } from "@essence-lang/compiler/modules"
import type { MutationSite } from "@essence-lang/compiler/mutation"
import {
	defaultOptimiserOptions,
	type OptimiserOptions,
} from "@essence-lang/compiler/optimiser"
import type { EmitTarget } from "@essence-lang/compiler/rewriter/emitTarget"
import type { common } from "@essence-lang/interfaces"

import {
	type Bundle,
	bundleCacheDirectory,
	bundleKey,
	type CachedBundle,
	readBundle,
	scratchBundlePath,
	writeBundle,
	writeScratchBundle,
} from "./cache"
import { type CompileSession, createCompileSession } from "./session"

// The Compiler pipeline for both the in-process and the worker path, so both
// report the same timings, sizes and stopping stages. The Bundler and the
// emitter are imported dynamically, so `esc check` and a cached build never
// load them.

const stageNames = [
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

type StageTiming = {
	name: StageName
	duration: number
}

// The compile mode changes what is enriched from the same sources, so it joins
// `bundleKey`. The Session carries it into the Enricher, so a request with a
// mode is compiled through a Session opened with it.
export type CompileRequest = CompileMode & {
	inputFileName: string
	// Null for a compile that emits nothing, as `check` does. `esc run` without
	// `--out` asks for `cacheOutput` instead.
	outputFileName: string | null
	// Writes the bundle into the bundle cache under its sources' key, so a
	// repeat run of unchanged sources writes nothing.
	cacheOutput?: boolean
	minify: boolean
	sourcemap: boolean
	// `linked` writes the map beside the output, `inline` inside it. Read only
	// when `sourcemap` is set.
	sourcemapMode?: "linked" | "inline"
	// Absent means every pass. It travels to a worker with the request.
	optimisation?: OptimiserOptions
	// Absent means a bundle. It changes the emitted bytes but not the sources,
	// so `bundleKey` names it.
	emit?: EmitTarget
	// A bundle for a JavaScript host to load: it carries the runtime bridge and
	// a Descriptor is written beside it. It joins the key too.
	embed?: boolean
	// Asks every Module which mutations it admits, for the baseline of
	// `essence test --mutate`. See `CompileOutcome.mutations`.
	enumerateMutations?: boolean
	// The one mutation this compile applies, by Module and site id. Sites are
	// enumerated and applied after simplifying and before optimising, so an id
	// names the same Node. A mutated compile bypasses the bundle cache.
	mutation?: { module: string; site: number }
}

// One file of the compiled graph, with the text its Diagnostics are rendered
// against. A Diagnostic names no file: the collection it is in does.
export type CompiledModule = {
	fileName: string
	sourceText: string
	diagnostics: Array<common.Diagnostic>
}

// INVARIANT: `diagnostics` holds every Module's, in Module order, then the
// compilation's own, such as an unreadable entry or a Compiler that threw.
// `ownDiagnostics` reads that tail.
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
	// Whether this entry's bundle came from the bundle cache.
	cached: boolean
	// The mutation sites of every Module the entry reaches, when asked. A
	// shared Module yields the same sites under each entry, so callers key them
	// by Module.
	mutations?: Array<MutationSite>
}

type ProgressReporter = (stage: StageName) => void

// The Descriptor beside a bundle: `app.js` gets `app.descriptor.json`.
// `@essence-lang/client` spells the same rule, and a test holds the two together.
export function descriptorFileName(outputFileName: string): string {
	let extension = path.extname(outputFileName)

	return `${outputFileName.slice(
		0,
		outputFileName.length - extension.length,
	)}.descriptor.json`
}

// The gzipped size a build report prints. A mutant is never reported, so it
// is not compressed.
function gzipBytesOf(
	request: CompileRequest,
	contents: Uint8Array,
): number | null {
	return request.mutation === undefined ? gzipSync(contents).byteLength : null
}

// Writes the Descriptor beside the bundle, on the cached path as well as the
// emitting one. It is indented, since people read it too.
async function writeDescriptor(
	request: CompileRequest,
	front: Front,
): Promise<void> {
	// A standard library source exports nothing, so it has no Surface.
	if (
		request.embed !== true ||
		request.outputFileName === null ||
		front.surface === null
	) {
		return
	}

	// The cached path runs this too, and `embed/describe` loads neither the
	// emitter nor esbuild.
	let { describeModule } =
		await import("@essence-lang/compiler/embed/describe")
	let { writeFile } = await import("node:fs/promises")

	await writeFile(
		descriptorFileName(request.outputFileName),
		`${JSON.stringify(
			describeModule(front.surface, front.entryPath),
			null,
			"\t",
		)}\n`,
		"utf8",
	)
}

// The runtime bridge an embedded bundle exports, with the Dictionary and Future
// parts its Descriptor needs. `@essence-lang/client` asks the same questions,
// so both tools build one bundle per graph. A standard library source gets the
// plain bridge.
async function runtimeBridgeFor(
	front: Front,
): Promise<(sources: ModuleSources) => ModuleSources> {
	let { withRuntimeBridge } =
		await import("@essence-lang/compiler/embed/bridge")

	if (front.surface === null) {
		return (sources) => withRuntimeBridge(sources)
	}

	let { carriesDictionary, carriesFuture, describeModule, describeTypes } =
		await import("@essence-lang/compiler/embed/describe")
	// Described once for both questions.
	let described = describeModule(front.surface, front.entryPath)
	let declared = describeTypes(front.surface, front.entryPath)
	let dictionary = carriesDictionary(described, declared)
	let future = carriesFuture(described, declared)

	return (sources) => withRuntimeBridge(sources, { dictionary, future })
}

// A cached bundle as the outputs the emitting compile writes. The map is
// `<output>.map`, as the Bundler names it and the bundle's last line says.
function bundleOutputs(
	outputFileName: string,
	cached: CachedBundle,
): Array<BundleOutput> {
	let outputs = [{ path: outputFileName, contents: cached.contents }]

	if (cached.map !== null) {
		outputs.push({ path: `${outputFileName}.map`, contents: cached.map })
	}

	return outputs
}

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

// Reports each file of a batch under exactly one outcome: its own if it is an
// entry, else the first that reached it. Only Diagnostics move, since
// `esc watch` reads each outcome's whole Module list.
export function attributeDiagnostics(
	outcomes: Array<CompileOutcome>,
): Array<CompileOutcome> {
	if (outcomes.length < 2) {
		return outcomes
	}

	let owners = new Map<string, CompileOutcome>()

	for (let outcome of outcomes) {
		// The entry Module is the last one. Taking it from the graph compares
		// spellings the graph produced, not the caller's.
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

// The near miss for a path that could not be read, in the path's own spelling.
// Only base names are compared, since the shared directories would make every
// candidate look close.
function nearestSource(fileName: string): string | null {
	let directory = path.dirname(fileName)

	try {
		let candidate = closestMatch(
			path.basename(fileName),
			readdirSync(directory).filter((entry) => entry.endsWith(".es")),
		)

		return candidate === null
			? null
			: directory === "."
				? candidate
				: path.join(directory, candidate)
	} catch {
		return null
	}
}

// Every branch puts its advice in a Help, keeping the message to one line.
function readError(error: unknown, fileName: string): common.Diagnostic {
	let code = (error as NodeJS.ErrnoException | undefined)?.code

	if (code === "ENOENT") {
		let suggestion = nearestSource(fileName)

		return {
			...placelessDiagnostic(
				"error",
				`No such file: ${fileName}`,
				"file-not-found",
			),
			helps:
				suggestion === null
					? [
							"Check the path, and that the file is saved where it says.",
						]
					: [`Did you mean '${suggestion}'?`],
		}
	}

	if (code === "EISDIR") {
		return {
			...placelessDiagnostic(
				"error",
				`${fileName} is a directory`,
				"not-a-file",
			),
			helps: [
				`Pass the source files inside it instead — '${fileName}/*.es'.`,
			],
		}
	}

	if (code === "EACCES") {
		return {
			...placelessDiagnostic(
				"error",
				`Not allowed to read ${fileName}`,
				"unreadable-file",
			),
			helps: ["Check the file's permissions."],
		}
	}

	return {
		...placelessDiagnostic(
			"error",
			`Could not read ${fileName}: ${
				error instanceof Error ? error.message : String(error)
			}`,
			"unreadable-file",
		),
		helps: ["Check the path and the file's permissions."],
	}
}

// What the front of the pipeline produced. `programs` has one typed Program per
// Module, in Module order, and is null exactly when nothing may be emitted.
type Front = {
	entryPath: string
	sourceText: string
	modules: Array<CompiledModule>
	programs: Array<common.typed.Program> | null
	// The entry's exports. Null for a standard library source and for a compile
	// that stopped before linking.
	surface: ExportSurface | null
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
		surface: null,
		diagnostics: [readError(error, request.inputFileName)],
		failedStage: "read",
	}
}

// Reads, parses, links and validates the entry's graph through the Session, so
// a batch loads each file once. Every stage runs whatever the one before found,
// so one run reports every kind of error.
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

	// Timed on its own. The Session holds the parsed Modules for linking, and
	// the linked Modules carry the parse Diagnostics.
	await timeline.run("parse", () => session.modules(request.inputFileName))

	let linked = await timeline.run("enrich", () =>
		session.linked(request.inputFileName),
	)
	let analyses = await timeline.run("validate", () =>
		analyseLinkedModules(linked),
	)

	return {
		entryPath: read.filePath,
		sourceText: read.sourceText,
		modules: linked.map<CompiledModule>((module) => ({
			fileName: module.module.filePath,
			sourceText: module.module.sourceText,
			diagnostics: analyses?.get(module.module.filePath) ?? [
				...module.diagnostics,
			],
		})),
		programs: linked.map((module) => module.program),
		// Found by path rather than by position, so a Descriptor can never
		// describe a dependency.
		surface:
			linked.find((module) => module.module.filePath === read.filePath)
				?.surface ?? null,
		diagnostics: [],
		failedStage: null,
	}
}

// A standard library source is not a Module: it is one shared declaration
// space whose names are already builtins. `enrichDocument` compiles it alone,
// as the Editor does.
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
	let enriched = await timeline.run("enrich", () =>
		enrichDocument(parsed.program, request.inputFileName, {
			...modeOf(request),
			source: read.sourceText,
		}),
	)
	// Every stage runs here too, as in `linkGraph`.
	let analysed = await timeline.run("validate", () =>
		analyseEnriched(parsed.program, parsed.diagnostics, enriched),
	)

	return {
		entryPath: read.filePath,
		sourceText: read.sourceText,
		modules: [
			{
				fileName: read.filePath,
				sourceText: read.sourceText,
				diagnostics: analysed.diagnostics,
			},
		],
		programs: [analysed.program],
		surface: null,
		diagnostics: [],
		failedStage: null,
	}
}

export async function compileFile(
	request: CompileRequest,
	report?: ProgressReporter,
	session: CompileSession = createCompileSession(
		[request.inputFileName],
		request,
	),
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
		cached: false,
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

		// Every stage that reports on the source has run, and any error stops
		// the emitter. `failedStage` stays null because no stage refused.
		if (containsErrors(modules.flatMap((module) => module.diagnostics))) {
			return finish(false, null)
		}

		// `check` stops here: the rest only produces a file.
		if (request.outputFileName === null && request.cacheOutput !== true) {
			return finish(true, null)
		}

		// The key is taken from the linked graph before emitting, and a mutated
		// compile has no store. See "The bundle cache" in DEVELOPMENT.md.
		let store =
			request.mutation === undefined ? bundleCacheDirectory() : null
		// Hashing the graph is skipped where no name is needed.
		let key =
			store === null && request.outputFileName !== null
				? ""
				: bundleKey(
						request,
						front.entryPath,
						new Map(
							modules.map((module) => [module.fileName, module]),
						),
					)
		// Only a linked map is a second file.
		let hasMapFile =
			request.sourcemap &&
			request.sourcemapMode !== "inline" &&
			request.outputFileName !== null
		// An enumerating compile writes the store but never reads it: the sites
		// are collected while simplifying, which a hit skips.
		let cached =
			store === null || request.enumerateMutations === true
				? null
				: await readBundle(store, key, hasMapFile)

		if (cached !== null) {
			let target = request.outputFileName

			if (target !== null) {
				await timeline.run("write", async () => {
					let { writeOutputs } =
						await import("@essence-lang/compiler/bundler")

					await writeOutputs(bundleOutputs(target, cached))
					await writeDescriptor(request, front)
				})
			}

			return finish(true, null, {
				outputFileName: target ?? cached.path,
				bytes: cached.contents.byteLength,
				gzipBytes: gzipBytesOf(request, cached.contents),
				cached: true,
			})
		}

		// The Compiler's `emitBundle` owns the stages past validation. `esc`
		// adds the Session's caches and the timings.
		let { emitBundle } = await import("@essence-lang/compiler/embed")
		// Loaded only for a mutation run.
		let mutating =
			request.mutation !== undefined ||
			request.enumerateMutations === true
		let mutation = mutating
			? await import("@essence-lang/compiler/mutation")
			: null
		let embedding =
			request.embed === true ? await runtimeBridgeFor(front) : undefined
		// `run` without `--out` emits under the scratch name, but a clean emit is
		// spawned from the cache entry it becomes.
		let emitFileName = request.outputFileName ?? scratchBundlePath(key)
		// Each typed Program's file, which the emitter does not carry.
		let names = new Map(
			programs.map((program, index) => [
				program,
				modules[index]!.fileName,
			]),
		)
		let mutations: Array<MutationSite> = []
		// Mutations are enumerated and applied after simplifying and before
		// optimising, so a site is where the author wrote it. `applyMutation`
		// returns a fresh Program, so the Session keeps the unmutated one.
		let simplify: NonNullable<
			Parameters<typeof emitBundle>[1]
		>["simplify"] = (program, options) => {
			let simplified = session.simplify(program, options)

			if (mutation === null) {
				return simplified
			}

			let fileName = names.get(program) ?? null

			if (request.enumerateMutations === true) {
				mutations.push(
					...mutation.enumerateMutations(simplified, fileName),
				)
			}

			return request.mutation !== undefined &&
				fileName === request.mutation.module
				? mutation.applyMutation(simplified, request.mutation.site)
				: simplified
		}
		let bundled = await emitBundle(
			{
				modules: programs.map((program, index) => ({
					filePath: modules[index]!.fileName,
					program,
					sourceText: modules[index]!.sourceText,
				})),
				entryPath: front.entryPath,
				sourceFileName: request.inputFileName,
				outputFileName: emitFileName,
				minify: request.minify,
				sourcemap: request.sourcemap,
				// A bundle with no name of its own carries its map inline.
				sourcemapMode:
					request.outputFileName === null
						? "inline"
						: request.sourcemapMode,
				optimisation: request.optimisation ?? defaultOptimiserOptions,
				emit: request.emit,
				// The runtime's Type key and value constructors, which a host needs
				// to build values. See `withRuntimeBridge`.
				transformSources: embedding,
			},
			{
				simplify,
				optimise: session.optimise,
				stage: (name, work) => timeline.run(name, work),
			},
		)

		own.push(...bundled.diagnostics)

		if (containsErrors(bundled.diagnostics)) {
			return finish(false, "bundle")
		}

		let emitted: Bundle = {
			contents:
				bundled.outputs.find((output) => !output.path.endsWith(".map"))
					?.contents ?? new Uint8Array(),
			map:
				bundled.outputs.find((output) => output.path.endsWith(".map"))
					?.contents ?? null,
		}

		let outputFileName = await timeline.run("write", async () => {
			if (request.outputFileName !== null) {
				let { writeOutputs } =
					await import("@essence-lang/compiler/bundler")

				await writeOutputs(bundled.outputs)
				await writeDescriptor(request, front)
			}

			// Kept only when the emit reported nothing, since a hit would skip
			// the stages that report.
			if (store !== null && bundled.diagnostics.length === 0) {
				let file = await writeBundle(store, key, emitted)

				return request.outputFileName ?? file
			}

			return request.outputFileName === null
				? await writeScratchBundle(key, emitted)
				: request.outputFileName
		})

		return finish(true, null, {
			outputFileName,
			bytes: emitted.contents.byteLength,
			gzipBytes: gzipBytesOf(request, emitted.contents),
			...(request.enumerateMutations === true ? { mutations } : {}),
		})
	} catch (error) {
		// A throw here is a Compiler bug. As a Diagnostic it lets a batch go on,
		// and the stack is kept for `--verbose`.
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
