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

// NOTE: Re-exported rather than re-declared: what a cancellation is and what an
// unexpected throw becomes are the shared analysis' answers, and every handler
// in this Server already reaches for them through here.
export { type Cancellation, internalError, isCancelled }

// NOTE: Either Program is null when the stage that builds it threw — the
// Diagnostics then hold the Internal Compiler Error and nothing else.
export type Analysis = {
	program: parser.Program | null
	enrichedProgram: common.typed.Program | null
	diagnostics: Array<common.Diagnostic>
	// NOTE: Every OTHER Module the graph reached, by canonical path, with the
	// Diagnostics that belong to it. Empty for a Program that is no Module. The
	// Editor publishes these under those files' own URIs, which is what makes a
	// mistake in an unopened dependency visible at all — and what obliges the
	// Server to clear them again, since nothing else will.
	dependencies: Map<string, Array<common.Diagnostic>>
}

// NOTE: The typed view of ONE document, as every request that answers about the
// document itself reads it. Handed down into `findCompletions`, `matchingNamespaces`
// and Signature Help so that the places which used to parse and enrich the
// unmodified text for themselves read the Workspace's copy instead — a
// Completion list fires on every keystroke, and three enrichments of one file to
// draw one list is three quarters of the request.
//
// NOTE: A probe is deliberately NOT this. A probe is a DIFFERENT text — the
// document with a synthetic member, a Case or a padded tail written into it —
// so it has no cache entry and can not have one; what it must not do is
// re-derive the unmodified document beside it.
export type DocumentAnalysis = {
	program: parser.Program
	enrichedProgram: common.typed.Program | null
	// NOTE: The rename index of this document, which is where the Scope model
	// comes from. Null where the caller holds none — it is rebuilt then, exactly
	// as it always was.
	index: ProgramIndex | null
	// NOTE: What this document is LINKED against, when it is a Module: the
	// names its import block bound, and the linked dependencies a probe of it
	// has to be read against. Null for a Program that is no Module — nothing
	// outside such a file is in reach, and a probe of it enriches alone.
	module: ModuleView | null
}

type AnalysisOptions = {
	// NOTE: The Editor's open documents answer before disk does — an unsaved
	// buffer is the only truthful version of a file, and a dependency being
	// edited in another tab is exactly the case the graph has to see. The entry
	// document is answered from the text handed in whatever the host says.
	host?: ModuleHost
	// NOTE: Whether this analysis asked for the tests — see `enrichDocument`.
	// The Editor's ordinary analysis leaves it off, so what a writer sees in a
	// file is what a build sees; the test session is what turns it on, and it
	// keeps a cache of its own for exactly that reason.
	tests?: boolean
}

// NOTE: Every stage runs, always — see `@essence-lang/compiler/analysis`, which
// is the one description of what analysing a source means and which `esc` runs
// too. Broken Statements are dropped from the AST, the rest is enriched, and
// the Validator judges what the two of them established.
// NOTE: `documentPath` is what tells a standard library source apart from an
// ordinary Program — see `./documents`. Absent, the document is an ordinary
// one, which is what every caller outside the Language Server is.
// NOTE: The Programs are handed back as well as the Diagnostics, for the
// requests that answer with an edit rather than with a message: a Code Action
// reads the source's own Nodes, and running this pipeline twice for one
// request costs as much as the analysis itself.
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

		// NOTE: A file that writes neither section is a Program of its own, and
		// is analysed as one — no graph is loaded, nothing is read off disk, and
		// its Diagnostics are the ones it always had. It may well be some other
		// Module's dependency; that Module's own analysis is what covers it.
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
		}
	} catch (error) {
		// NOTE: A compiler bug must never take down the Language Server, so
		// any unexpected throw is surfaced as a single Diagnostic instead.
		// Whatever the stages before it produced is still handed back — a
		// throw out of the Validator does not make the Programs unusable.
		return {
			program,
			enrichedProgram,
			diagnostics: [internalError(error)],
			dependencies: new Map(),
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

// NOTE: A standard library source writes import sections like any other Module,
// but it is not analysed through the graph: the process-wide loader has already
// hoisted every one of its files into the builtin tables, and `enrichDocument`
// subtracts the file's own names back out so that editing it does not read as a
// redeclaration of itself. The graph path has no equivalent of that correction,
// so routing a standard library source through it would give one file two
// enrichments that disagree. It is analysed as the single declaration space the
// loader made it.
export function isModule(
	program: parser.Program,
	documentPath: string | undefined,
): boolean {
	return (
		(program.imports !== null || program.exports !== null) &&
		!(documentPath !== undefined && isStdlibDocument(documentPath))
	)
}

// NOTE: The Language Server is handed URIs and the tests plain paths, and a
// Module's identity is a path — the same decoding `isStdlibDocument` does,
// because a document that reaches one of them has to reach the other as the
// same file.
export function documentFilePath(documentPath: string): string {
	let filePath = documentPath.startsWith("file://")
		? documentPath.slice("file://".length)
		: documentPath

	try {
		filePath = decodeURIComponent(filePath)
	} catch {}

	return canonicalPath(filePath)
}

// NOTE: The whole graph the document reaches, enriched together, so that a name
// an entry brings in resolves to what the other Module actually declares rather
// than to nothing. Every Module in it is validated and reported on under its own
// path — the Editor needs a dependency's Diagnostics to show them where they
// were written, not where they were noticed.
//
// The entry is parsed twice: once above, to learn whether it is a Module at all,
// and once by the graph, which parses every file it reads through one code path.
// Parsing is the cheap half of an analysis and the alternative is a second way
// into the graph that takes an already-parsed entry — one more thing to keep
// agreeing with the first.
//
// NOTE: This is the way in for a caller with no Workspace behind it — the tests
// and anything holding a document as a string. The Language Server goes through
// `workspace.analysisOf`, which runs the same two passes below over a graph it
// caches per file and version. The two must keep answering identically: the
// Workspace path is what an Editor sees, and this one is what the tests pin.
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
	}
}

// NOTE: Every Module of a linked graph, judged — the shared analysis' answer,
// keyed the way this Server wants it. The graph carries its Modules in a Map;
// what the analysis takes is the list, because `esc` holds one too.
export function analyseLinkedGraph(
	linked: LinkedGraph,
	options: { cancellation?: Cancellation } = {},
): Map<string, Array<common.Diagnostic>> | null {
	return analyseLinkedModules([...linked.modules.values()], options)
}

// NOTE: The other half of the pipeline: a Program that is no Module, analysed
// as the single declaration space it is. Split out for the same reason the graph
// pass above is — the Workspace runs it to fill its cache, and a second copy of
// "what does analysing a document mean" is a second thing to keep in step.
//
// NOTE: The enrichment runs HERE rather than inside the shared analysis, so
// that it goes through this Server's counted door — see `./compilation`. What
// is shared is the judgement: that every stage runs, what the Validator is told
// to stand down on, and the order the three stages' Diagnostics come out in.
export function analyseEnrichedDocument(
	program: parser.Program,
	parserDiagnostics: Array<common.Diagnostic>,
	documentPath: string | undefined,
	options: {
		annotations?: boolean
		tests?: boolean
		// NOTE: The document's own text. Only a test analysis reads it, and
		// only to compile the `@example` blocks of a `§§` block — leave it out
		// and the editor says nothing about an example that a run will fail on.
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
