import {
	diskModuleHost,
	type ImportedNames,
	type LinkContext,
	linkContextOf,
	type LinkedGraph,
} from "@essence-lang/compiler/modules"
import type { common, parser } from "@essence-lang/interfaces"

import { type DocumentAnalysis, documentFilePath, isModule } from "./analyse"
import {
	enrichDocument,
	linkModuleAgainst,
	linkModuleGraph,
	loadModuleGraph,
	parseDocument,
} from "./compilation"

// What a Module's probe is linked against. Enrichment alone seeds no import
// block, so imported names would be unknown. The graph's surfaces are kept
// linked, so a probe per keystroke need not read the graph again.
export type ModuleView = {
	entryPath: string
	// What the import block bound, such as an imported Namespace or Protocol.
	imported: ImportedNames
	// Each specifier's resolution. The probe writes the same import block, so
	// the answers carry over without a `realpath` per keystroke.
	resolutions: Map<string, string>
	// The Modules those specifiers named, in entry order, as the graph recorded.
	dependencies: Array<string>
	// The graph's export surfaces and declarations, as linking left them:
	// expensive to build, cheap to keep.
	context: LinkContext
}

// One view per Module of the graph, sharing one context, since every Module
// links against the same surfaces.
export function moduleViewsOf(linked: LinkedGraph): Map<string, ModuleView> {
	let context = linkContextOf(linked)
	let views = new Map<string, ModuleView>()

	for (let [filePath, module] of linked.modules) {
		views.set(filePath, {
			entryPath: filePath,
			imported: module.imported,
			resolutions: module.module.resolutions,
			dependencies: module.module.dependencies,
			context,
		})
	}

	return views
}

// The document's analysis for a caller holding none, derived once per
// request. A throw goes to `onInternalError`, and the document stays untyped.
export function documentAnalysisOf(
	documentText: string,
	documentPath: string | undefined,
	onInternalError: (error: unknown) => void = () => {},
): DocumentAnalysis | null {
	let program: parser.Program

	try {
		program = parseDocument(documentText, documentPath).program
	} catch {
		return null
	}

	let linked = linkedDocumentOf(program, documentText, documentPath)

	if (linked !== null) {
		return linked
	}

	let enrichedProgram: common.typed.Program | null = null

	try {
		enrichedProgram = enrichDocument(program, documentPath, {
			tests: true,
		}).program
	} catch (error) {
		onInternalError(error)
	}

	return { program, enrichedProgram, index: null, module: null }
}

// Null where there is nothing to link against: a file writing neither Module
// section, a standard library source, or a document without a path.
function linkedDocumentOf(
	program: parser.Program,
	documentText: string,
	documentPath: string | undefined,
): DocumentAnalysis | null {
	if (documentPath === undefined || !isModule(program, documentPath)) {
		return null
	}

	try {
		let entryPath = documentFilePath(documentPath)
		let linked = linkModuleGraph(
			loadModuleGraph(entryPath, {
				readFile: (filePath) =>
					filePath === entryPath
						? documentText
						: diskModuleHost.readFile(filePath),
			}),
			{ tests: true },
		)
		let view = moduleViewsOf(linked).get(entryPath)

		if (view === undefined) {
			return null
		}

		return {
			program,
			enrichedProgram: linked.modules.get(entryPath)?.program ?? null,
			// Rebuilt by the one listing that reads it.
			index: null,
			module: view,
		}
	} catch {
		// A graph that cannot be read, such as one naming a file not yet written,
		// leaves the document enriched alone, with imported names unknown.
		return null
	}
}

// One probe source, typed. A Module's probe links against the document's
// dependencies, so imported names are in Scope. Null where it does not parse or
// the link threw, and the next reading runs.
export function enrichProbe(
	probeSource: string,
	documentPath: string | undefined,
	view: ModuleView | null,
): common.typed.Program | null {
	try {
		let { program } = parseDocument(probeSource, documentPath)

		return view === null
			? enrichDocument(program, documentPath, { tests: true }).program
			: linkProbe(program, probeSource, view)
	} catch {
		return null
	}
}

// The probe stands in for the document, with its path and resolutions. Its
// Diagnostics are dropped: nobody wrote its text.
function linkProbe(
	program: parser.Program,
	probeSource: string,
	view: ModuleView,
): common.typed.Program {
	return linkModuleAgainst(
		{
			filePath: view.entryPath,
			sourceText: probeSource,
			program,
			diagnostics: [],
			dependencies: view.dependencies,
			resolutions: view.resolutions,
		},
		view.context,
		{ tests: true },
	).program
}
