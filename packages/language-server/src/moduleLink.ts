import {
	diskModuleHost,
	type ImportedNames,
	type LinkContext,
	linkContextOf,
	type LinkedGraph,
	type ModuleHost,
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

// NOTE: What a document that is a MODULE is analysed against — everything a
// probe of it needs beyond its own text. A probe enriches a document with a
// synthetic member written into it, and enrichment seeds a Scope from the
// builtins and the file's own declarations alone: linking is what seeds an
// import block. So every name a Module takes from another was unknown to every
// probe, the base of `Colour.` typed as an Error, and `red::` offered the
// Methods of every Namespace there is — an Error receiver matches them all.
//
// The dependencies are held LINKED, because a Completion fires on every
// keystroke and one of them enriches several readings: re-reading and
// re-linking the graph per reading is the whole of what made linking too
// expensive to probe through. What is kept is the surfaces and the name lists,
// not the graph — see `LinkContext`.
export type ModuleView = {
	entryPath: string
	// NOTE: What the import block bound, which is what a listing built from the
	// document's own declarations would otherwise miss: an imported Namespace,
	// an imported Protocol used as a bound, an imported Choice named in front
	// of a `.`.
	imported: ImportedNames
	// NOTE: The specifier as written to the Module it named, and the paths
	// those spell out. A probe writes the same import block the document does —
	// it is the text above the cursor, and the cursor is below the block — so
	// what it resolves to is what the document resolved to, and resolving it
	// again is a `realpath` per specifier per keystroke.
	resolutions: Map<string, string>
	// NOTE: The Modules those specifiers named, in the order the entries name
	// them — what the graph recorded for this file, so that the probe standing
	// in for it depends on exactly what it depends on.
	dependencies: Array<string>
	// NOTE: Everything the graph published, as linking left it: the export
	// surface of every Module in it and what each declares. This is the half
	// that is expensive to build and cheap to keep, and keeping it is what
	// makes a probe of a Module affordable at all.
	context: LinkContext
}

// NOTE: One view per Module of the graph, sharing ONE context: a Module of a
// linked graph is linked against the same surfaces whichever of them the graph
// was loaded from, so the cursor's file needs no graph of its own.
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

// NOTE: The way in for a caller with no Workspace behind it — the tests, and
// anything holding a document as a string. The Language Server reads the view
// the Workspace already holds for the file, which is the same one built from
// the same graph; this pays for a graph of its own, once per request rather
// than once per probe.
//
// Null wherever there is nothing to link against: a document that writes
// neither Module section is a Program of its own, a standard library source is
// analysed as the declaration space its loader made it, and a caller with no
// path for the document can not name a Module at all.
export function moduleDocumentOf(
	documentText: string,
	documentPath: string | undefined,
	host: ModuleHost = diskModuleHost,
): DocumentAnalysis | null {
	if (documentPath === undefined) {
		return null
	}

	try {
		let { program } = parseDocument(documentText, documentPath)

		if (!isModule(program, documentPath)) {
			return null
		}

		let entryPath = documentFilePath(documentPath)
		let linked = linkModuleGraph(
			loadModuleGraph(entryPath, {
				readFile: (filePath) =>
					filePath === entryPath
						? documentText
						: host.readFile(filePath),
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
			// NOTE: Rebuilt by the one listing that reads it, exactly as it is
			// for every other caller that holds no Workspace.
			index: null,
			module: view,
		}
	} catch {
		// NOTE: A document whose graph can not be read — a specifier naming a
		// file nobody has written yet — is answered the way it always was:
		// enriched on its own, with every imported name unknown. Degrading is
		// the point; a Completion list that throws is a Completion list that
		// stops appearing.
		return null
	}
}

// NOTE: One probe source, typed. A probe of a Module is LINKED against the
// document's dependencies rather than enriched alone, which is what puts the
// names the import block brought in into the Scope the probe is read in.
// Everything else enriches exactly as it did.
//
// Null where the source does not parse or the link threw: a reading that does
// not explain the cursor is simply not the reading — the next one is tried.
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

// NOTE: The probe stands in for the document, under the document's own path and
// with the document's own resolutions — so what it links against is what the
// document links against, and the surfaces are read back rather than rebuilt.
// It carries no Diagnostics of its own: a probe is a text nobody wrote, and
// nothing it could say belongs in front of a reader.
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
