import {
	analyseEnriched,
	analyseLinkedModules,
	type Cancellation,
	internalError,
	isCancelled,
} from "@essence-lang/compiler/analysis"
import {
	canonicalPath,
	isStdlibDocument,
} from "@essence-lang/compiler/documents"
import {
	diskModuleHost,
	type ImportedNames,
	type LinkedGraph,
	type ModuleHost,
} from "@essence-lang/compiler/modules"
import type { common, parser } from "@essence-lang/interfaces"

import {
	enrichDocument,
	linkModuleGraph,
	loadModuleGraph,
	parseDocument,
} from "./compilation"
import type { ModuleView } from "./moduleLink"
import type { ProgramIndex } from "./rename"

// Re-exported, since the shared analysis defines what a cancellation is and
// what an unexpected throw becomes.
export { type Cancellation, internalError, isCancelled }

// A Program is null when the stage building it threw; the Diagnostics then
// hold only the Internal Compiler Error.
export type Analysis = {
	program: parser.Program | null
	enrichedProgram: common.typed.Program | null
	diagnostics: Array<common.Diagnostic>
	// Every other Module the graph reached, by canonical path, with its
	// Diagnostics. Empty for a Program that is no Module. The Server publishes and
	// later clears these.
	dependencies: Map<string, Array<common.Diagnostic>>
	// What the import block bound, for a Module. A Protocol imported to be
	// conformed to is in no table of the typed Program.
	imported: ImportedNames | null
}

// The typed view of one document, which requests about it read rather than
// enriching the same text again. A probe is a different text and never this.
export type DocumentAnalysis = {
	program: parser.Program
	enrichedProgram: common.typed.Program | null
	// The document's rename index, which supplies the Scope model. Null where the
	// caller holds none, and it is rebuilt.
	index: ProgramIndex | null
	// What a Module is linked against: its imports and the dependencies a probe
	// reads. Null for a Program that is no Module, whose probe enriches alone.
	module: ModuleView | null
}

type AnalysisOptions = {
	// Open documents answer before disk, so a dependency edited in another tab is
	// seen. The entry document is always the text handed in.
	host?: ModuleHost
	// Whether the `tests` section is typed, as `enrichDocument` reads it.
	tests?: boolean
}

// Runs every stage, as `@essence-lang/compiler/analysis` defines analysing a
// source. `documentPath` tells a standard library source apart. The Programs
// come back too, for requests that answer with an edit.
export function analyseDocument(
	source: string,
	documentPath?: string,
	options: AnalysisOptions = {},
): Analysis {
	let program: parser.Program | null = null
	let enrichedProgram: common.typed.Program | null = null

	try {
		let { program: parsedProgram, diagnostics: parserDiagnostics } =
			parseDocument(source, documentPath)

		program = parsedProgram

		// A file writing neither Module section is a Program of its own, analysed
		// without loading a graph.
		if (
			isModule(parsedProgram, documentPath) &&
			documentPath !== undefined
		) {
			let analysis = analyseModuleGraph(
				source,
				documentPath,
				options.host ?? diskModuleHost,
				options.tests,
			)

			return {
				...analysis,
				program: analysis.program ?? parsedProgram,
			}
		}

		let analysed = analyseEnrichedDocument(
			parsedProgram,
			parserDiagnostics,
			documentPath,
			{ tests: options.tests, source },
		)

		enrichedProgram = analysed.enrichedProgram

		return {
			program,
			enrichedProgram,
			diagnostics: analysed.diagnostics,
			dependencies: new Map(),
			imported: null,
		}
	} catch (error) {
		// A Compiler throw becomes one Diagnostic, and whatever the earlier stages
		// produced is still handed back.
		return {
			program,
			enrichedProgram,
			diagnostics: [internalError(error)],
			dependencies: new Map(),
			imported: null,
		}
	}
}

export function analyse(
	source: string,
	documentPath?: string,
	options: AnalysisOptions = {},
): Array<common.Diagnostic> {
	return analyseDocument(source, documentPath, options).diagnostics
}

// A standard library source is analysed alone: the loader hoisted it into the
// builtin tables, and only `enrichDocument` subtracts its own names back out.
export function isModule(
	program: parser.Program,
	documentPath: string | undefined,
): boolean {
	return (
		(program.imports !== null || program.exports !== null) &&
		!(documentPath !== undefined && isStdlibDocument(documentPath))
	)
}

// Decodes a URI to the path a Module is identified by, as `isStdlibDocument`
// does, so both see the same file.
export function documentFilePath(documentPath: string): string {
	let filePath = documentPath.startsWith("file://")
		? documentPath.slice("file://".length)
		: documentPath

	try {
		filePath = decodeURIComponent(filePath)
	} catch {}

	return canonicalPath(filePath)
}

// The whole graph the document reaches, enriched together and judged per
// Module. For callers without a Workspace; `workspace.analysisOf` runs the
// same passes, and the two must answer alike.
function analyseModuleGraph(
	source: string,
	documentPath: string,
	host: ModuleHost,
	tests?: boolean,
): Analysis {
	let entryPath = documentFilePath(documentPath)
	let graph = loadModuleGraph(entryPath, {
		readFile: (filePath) =>
			filePath === entryPath ? source : host.readFile(filePath),
	})
	let linked = linkModuleGraph(graph, { tests })
	let analyses = analyseLinkedGraph(linked)!

	return {
		program: linked.modules.get(entryPath)?.module.program ?? null,
		enrichedProgram: linked.modules.get(entryPath)?.program ?? null,
		diagnostics: [
			...linked.diagnostics,
			...(analyses.get(entryPath) ?? []),
		],
		dependencies: new Map(
			[...analyses].filter(([filePath]) => filePath !== entryPath),
		),
		imported: linked.modules.get(entryPath)?.imported ?? null,
	}
}

// Every Module of a linked graph, judged, keyed by path.
export function analyseLinkedGraph(
	linked: LinkedGraph,
	options: { cancellation?: Cancellation } = {},
): Map<string, Array<common.Diagnostic>> | null {
	return analyseLinkedModules([...linked.modules.values()], options)
}

// A Program that is no Module, analysed alone. The enrichment runs here,
// through the counted entry points of `./compilation`; the judgement is shared.
export function analyseEnrichedDocument(
	program: parser.Program,
	parserDiagnostics: Array<common.Diagnostic>,
	documentPath: string | undefined,
	options: {
		annotations?: boolean
		tests?: boolean
		// The document's text, which a test analysis reads to compile the `@example`
		// blocks of its `§§` blocks.
		source?: string
	} = {},
): {
	enrichedProgram: common.typed.Program
	diagnostics: Array<common.Diagnostic>
	annotations: Array<common.TypeAnnotation>
} {
	let analysed = analyseEnriched(
		program,
		parserDiagnostics,
		enrichDocument(program, documentPath, options),
	)

	return {
		enrichedProgram: analysed.program,
		diagnostics: analysed.diagnostics,
		annotations: analysed.annotations,
	}
}
