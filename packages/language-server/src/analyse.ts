import {
	collectDiagnostics,
	containsErrors,
	placelessDiagnostic,
	primary,
	reportError,
} from "@essence-lang/compiler/diagnostics"
import {
	canonicalPath,
	isStdlibDocument,
} from "@essence-lang/compiler/documents"
import {
	diskModuleHost,
	type LinkedGraph,
	type ModuleHost,
} from "@essence-lang/compiler/modules"
import { validate } from "@essence-lang/compiler/validator"
import type { common, parser } from "@essence-lang/interfaces"

import {
	enrichDocument,
	linkModuleGraph,
	loadModuleGraph,
	parseDocument,
} from "./compilation"
import type { ProgramIndex } from "./rename"

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
}

export type AnalysisOptions = {
	// NOTE: The Editor's open documents answer before disk does — an unsaved
	// buffer is the only truthful version of a file, and a dependency being
	// edited in another tab is exactly the case the graph has to see. The entry
	// document is answered from the text handed in whatever the host says.
	host?: ModuleHost
}

// NOTE: The pipeline stages are fault-tolerant, so parsing and enrichment
// always run — broken statements are dropped from the AST, and the remaining
// Program is still analysed. Validation only runs when the Enricher reported
// no errors, since the Validator relies on a fully enriched Program.
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
): Analysis {
	let entryPath = documentFilePath(documentPath)
	let graph = loadModuleGraph(entryPath, {
		readFile: (filePath) =>
			filePath === entryPath ? source : host.readFile(filePath),
	})
	let linked = linkModuleGraph(graph)
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

// NOTE: Every Module of a linked graph, judged: its own Diagnostics, then the
// Validator's, then what its dependencies came to. The Diagnostics of a Module
// depend on that Module and on what IT reaches — never on the entry the graph
// was loaded from — which is what lets the Workspace keep the answer for every
// Module a single graph touched rather than only for the one that was asked
// about. Two passes, because a Module can only be told it depends on a broken
// one once every Module has been judged, and a cycle means a Module may depend
// on one that comes after it.
//
// NOTE: Null when the work was abandoned. A cancelled analysis produces NOTHING
// — half a pass is a Module judged against dependencies that were never judged,
// and a Diagnostic list is not a thing that can be half right.
export function analyseLinkedGraph(
	linked: LinkedGraph,
	options: { cancellation?: Cancellation } = {},
): Map<string, Array<common.Diagnostic>> | null {
	let failed = new Set<string>()
	let analyses = new Map<string, Array<common.Diagnostic>>()

	for (let [filePath, module] of linked.modules) {
		if (isCancelled(options.cancellation)) {
			return null
		}

		let diagnostics = [...module.diagnostics]

		if (!containsErrors(diagnostics)) {
			try {
				diagnostics.push(...validate(module.program))
			} catch (error) {
				diagnostics.push(internalError(error))
			}
		}

		if (containsErrors(diagnostics)) {
			failed.add(filePath)
		}

		analyses.set(filePath, diagnostics)
	}

	for (let [filePath, module] of linked.modules) {
		if (isCancelled(options.cancellation)) {
			return null
		}

		analyses
			.get(filePath)!
			.push(
				...brokenDependencyDiagnostics(
					module.module.program,
					(specifier) =>
						failed.has(
							module.module.resolutions.get(specifier) ?? "",
						),
				),
			)
	}

	return analyses
}

// NOTE: The other half of the pipeline: a Program that is no Module, analysed
// as the single declaration space it is. Split out for the same reason the graph
// pass above is — the Workspace runs it to fill its cache, and a second copy of
// "what does analysing a document mean" is a second thing to keep in step.
export function analyseEnrichedDocument(
	program: parser.Program,
	parserDiagnostics: Array<common.Diagnostic>,
	documentPath: string | undefined,
	options: { annotations?: boolean } = {},
): {
	enrichedProgram: common.typed.Program
	diagnostics: Array<common.Diagnostic>
	annotations: Array<common.TypeAnnotation>
} {
	let enriched = enrichDocument(program, documentPath, options)
	let diagnostics = [...parserDiagnostics, ...enriched.diagnostics]

	if (!containsErrors(enriched.diagnostics)) {
		diagnostics.push(...validate(enriched.program))
	}

	return {
		enrichedProgram: enriched.program,
		diagnostics,
		annotations: enriched.annotations,
	}
}

// NOTE: Structurally the LSP's own CancellationToken, so a handler can pass the
// one it was handed straight down without wrapping it. Read rather than awaited:
// every stage below is synchronous, so the only thing a token can do is stop the
// NEXT one from starting.
export type Cancellation = {
	isCancellationRequested: boolean
}

export function isCancelled(cancellation: Cancellation | undefined): boolean {
	return cancellation?.isCancellationRequested === true
}

export function internalError(error: unknown): common.Diagnostic {
	return placelessDiagnostic(
		"error",
		`Internal Compiler Error: ${
			error instanceof Error ? error.message : String(error)
		}`,
		"internal-error",
	)
}

// NOTE: One Diagnostic per broken dependency rather than per entry naming it:
// six names imported from one file is one thing to go and fix, and six
// underlines saying so is the report burying itself. Reported on the specifier
// of the FIRST entry that names it, in written order, since that is the one a
// reader's eye lands on.
function brokenDependencyDiagnostics(
	program: parser.Program,
	hasErrors: (specifier: string) => boolean,
): Array<common.Diagnostic> {
	let reported = new Set<string>()
	let sources: Array<parser.ModuleSpecifierNode> = [
		...(program.imports?.entries ?? []).map((entry) => entry.source),
		...(program.exports?.entries ?? []).flatMap((entry) =>
			entry.source === null ? [] : [entry.source],
		),
	]

	let { diagnostics } = collectDiagnostics(() => {
		for (let source of sources) {
			if (reported.has(source.path) || !hasErrors(source.path)) {
				continue
			}

			reported.add(source.path)

			reportError(
				`${source.path} has errors of its own`,
				source.position,
				{
					code: "dependency-has-errors",
					labels: [
						primary(source.position, "this Module did not compile"),
					],
					notes: [
						"What a Module exports is read off a Module that compiled. Until that one does, a name this file asks for may resolve to an Error, or not resolve at all.",
					],
					helps: [
						`Open ${source.path} — its own Diagnostics say what is wrong there.`,
					],
				},
			)
		}
	})

	return diagnostics
}
