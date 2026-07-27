import {
	collectDiagnostics,
	containsErrors,
	placelessDiagnostic,
	primary,
	reportError,
} from "@essence/compiler/diagnostics"
import {
	canonicalPath,
	enrichDocument,
	parseDocument,
} from "@essence/compiler/documents"
import {
	diskModuleHost,
	linkModuleGraph,
	loadModuleGraph,
	type ModuleHost,
} from "@essence/compiler/modules"
import { validate } from "@essence/compiler/validator"
import type { common, parser } from "@essence/interfaces"

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
		if (isModule(parsedProgram) && documentPath !== undefined) {
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

		let { program: typedProgram, diagnostics: enricherDiagnostics } =
			enrichDocument(parsedProgram, documentPath)

		enrichedProgram = typedProgram

		let diagnostics = [...parserDiagnostics, ...enricherDiagnostics]

		if (!containsErrors(enricherDiagnostics)) {
			diagnostics.push(...validate(typedProgram))
		}

		return {
			program,
			enrichedProgram,
			diagnostics,
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

// NOTE: A `declarations { … }` Program can carry neither section, so a standard
// library source never reaches the graph — the Parser refuses the sections
// there, and `documents.ts` is what draws that line for everything else.
function isModule(program: parser.Program): boolean {
	return program.imports !== null || program.exports !== null
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

type ModuleAnalysis = {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
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
	let failed = new Set<string>()
	let analyses = new Map<string, ModuleAnalysis>()

	for (let [filePath, module] of linked.modules) {
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

		analyses.set(filePath, { program: module.program, diagnostics })
	}

	// NOTE: Second pass, because a Module can only be told it depends on a
	// broken one once every Module has been judged — and a cycle means a Module
	// may depend on one that comes after it.
	for (let [filePath, module] of linked.modules) {
		let broken = brokenDependencyDiagnostics(
			module.module.program,
			(specifier) =>
				failed.has(module.module.resolutions.get(specifier) ?? ""),
		)

		analyses.get(filePath)!.diagnostics.push(...broken)
	}

	let entry = analyses.get(entryPath)
	let dependencies = new Map<string, Array<common.Diagnostic>>()

	for (let [filePath, analysis] of analyses) {
		if (filePath !== entryPath) {
			dependencies.set(filePath, analysis.diagnostics)
		}
	}

	return {
		program: linked.modules.get(entryPath)?.module.program ?? null,
		enrichedProgram: entry?.program ?? null,
		diagnostics: [...linked.diagnostics, ...(entry?.diagnostics ?? [])],
		dependencies,
	}
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

function internalError(error: unknown): common.Diagnostic {
	return placelessDiagnostic(
		"error",
		`Internal Compiler Error: ${
			error instanceof Error ? error.message : String(error)
		}`,
		"internal-error",
	)
}
