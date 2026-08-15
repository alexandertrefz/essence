import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import {
	canonicalPath,
	isStdlibDocument,
} from "@essence-lang/compiler/documents"
import { patternBindings } from "@essence-lang/compiler/helpers"
import {
	type LinkedGraph,
	type ModuleHost,
	resolveSpecifier,
} from "@essence-lang/compiler/modules"
import type { common, parser } from "@essence-lang/interfaces"

import {
	type Analysis,
	analyseEnrichedDocument,
	analyseLinkedGraph,
	type Cancellation,
	type DocumentAnalysis,
	internalError,
	isCancelled,
	isModule,
} from "./analyse"
import { relativeSpecifier } from "./autoImport"
import { linkModuleGraph, loadModuleGraph, parseDocument } from "./compilation"
import {
	type DocumentSymbolEntry,
	findDocumentSymbols,
} from "./documentSymbols"
import {
	type Declaration,
	type DeclarationKind,
	indexProgram,
	occurrenceAt,
	type OccurrenceAccess,
	type ProgramIndex,
	type RenameEdit,
} from "./rename"

// NOTE: One file is one Module and a Module is named by its canonical path, so
// everything here is keyed on that rather than on a URI — an Editor may hand
// the same file over spelled several ways, and two spellings of one path would
// be two Modules whose Types are not interchangeable.
//
// Three costs are kept apart deliberately, because they differ by orders of
// magnitude:
//
//   • DISCOVERY walks the workspace folders for `.es` files. Once, then
//     maintained by the watcher.
//   • PARSING answers what a file imports, exports and declares — everything
//     auto-import, workspace symbols and the dependency graph need. Cheap, and
//     done for every file.
//   • ENRICHMENT binds Method Invocations to their Namespaces, which is what
//     joins a Method across files. It loads the whole graph a file reaches, so
//     it is done only for the files a request actually touches.

export type OpenDocument = {
	text: string
	version: number
}

export type WorkspaceOptions = {
	// NOTE: The Editor's buffers, which win over disk — an unsaved file is the
	// only truthful version of itself, and the version is what tells a cached
	// parse from a stale one.
	openDocument?: (filePath: string) => OpenDocument | undefined
}

export type WorkspaceOccurrence = {
	filePath: string
	position: common.Position
	access: OccurrenceAccess
	// NOTE: How renaming THROUGH this occurrence is written — see
	// `RenameSite.edits`. Absent everywhere but a Pattern's shorthand binder,
	// which is the one site whose name can not simply be overwritten; an entry
	// of an `import`/`export` block never has any, because a Module's own
	// grammar already writes the two names apart.
	edits?: Array<RenameEdit> | null
}

// NOTE: One symbol as the workspace sees it: the declaration, wherever it is
// written, and every occurrence of it in every file that reaches it — the
// entries that carry it across Module boundaries included.
export type WorkspaceSymbol = {
	name: string
	kind: DeclarationKind
	// NOTE: Null when nothing in the workspace declares it: an entry naming
	// something no reachable Module exports still joins its own occurrences, so
	// that renaming it stays possible where it IS written.
	filePath: string | null
	definition: common.Position | null
	occurrences: Array<WorkspaceOccurrence>
}

export type WorkspaceExport = {
	// NOTE: The name the Module publishes it under, which is what an importer
	// writes — never the name the declaration was given at home.
	name: string
	kind: DeclarationKind
	// NOTE: The Module that PUBLISHES the name, which is the one an entry has to
	// name: a facade forwarding someone else's declaration is what an importer
	// writes a specifier for, and importing past it is a different dependency.
	filePath: string
	// NOTE: Where the declaration behind it is written, which for a re-export is
	// a Module further along the chain.
	declaredIn: string
	position: common.Position
}

// NOTE: An export of another Module that this file could reach and has not —
// what Completion offers last, with the entry that would make it resolve. The
// specifier is already written from the asking file, so accepting the offer
// needs nothing further worked out.
export type WorkspaceOffer = {
	name: string
	kind: DeclarationKind
	specifier: string
	filePath: string
	declaredIn: string
	position: common.Position
}

export type WorkspaceSymbolEntry = {
	name: string
	kind: DocumentSymbolEntry["kind"]
	// NOTE: What the symbol is written inside of — a Namespace for a Method, a
	// Choice for a Case. Null at the top level.
	container: string | null
	filePath: string
	range: common.Position
	selectionRange: common.Position
	exported: boolean
}

export type Workspace = ReturnType<typeof createWorkspace>

// NOTE: The directories a discovery walk never descends into. None of them can
// hold a Module of this workspace, and `node_modules` in particular is where a
// walk that does not stop spends all of its time.
const skippedDirectories = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".claude",
])

// NOTE: THE cache. One entry is everything this Server ever derives from one
// file at one version, and every request reads it rather than deriving its own:
// the parse, the typed Program, the rename index, the written annotations, the
// Diagnostics, and which other Modules those Diagnostics reached. What used to
// be three independent pipelines — the debounced analysis, the Hover seam, and
// the raw parse-and-enrich behind Completion — are three readers of this.
//
// Every field below `program` is filled lazily and INDEPENDENTLY, and no filled
// field is ever overwritten between two invalidations. That is what keeps object
// identity stable across requests: an index built against one typed Program must
// not find a different one under it the next time it is read. An invalidation
// empties them all together (`invalidateEnrichment`), so a reader that held one
// of them across a keystroke is holding the previous version's answer — which is
// what every request checking the version for itself is for.
type FileEntry = {
	filePath: string
	sourceText: string
	// NOTE: What the cache was built from — an open document's version, or the
	// sentinel for a file read off disk, which the watcher invalidates by hand.
	// An Editor may report the same version for a document it re-opened, so the
	// text is compared as well.
	version: number
	program: parser.Program
	// NOTE: Kept because an analysis needs them and the parse happens once: a
	// Diagnostic list that dropped the Parser's half would report a file with a
	// syntax error as clean.
	parseDiagnostics: Array<common.Diagnostic>
	index: ProgramIndex | null
	enriched: common.typed.Program | null
	// NOTE: Enrichment can legitimately answer with nothing — a Compiler bug
	// must not take the Server down — so "was it tried" is its own question.
	enrichmentAttempted: boolean
	// NOTE: The written annotations of THIS file, resolved against its graph —
	// null until something asks, because the collector can only be opened for
	// ONE Module of a graph at a time, so the graph-wide analysis fills this for
	// its entry alone and a Hover elsewhere pays for its own.
	annotations: Array<common.TypeAnnotation> | null
	// NOTE: This file's own Diagnostics, complete: parse, link, enrichment,
	// validation and what its dependencies came to. Null until an analysis ran —
	// this file's, or one for another Module of the same graph, since a Module's
	// Diagnostics depend on that Module and on what it reaches and on nothing
	// else.
	diagnostics: Array<common.Diagnostic> | null
	// NOTE: Every OTHER Module this file reaches, with the Diagnostics that
	// belong to it — its transitive dependencies and no more, which is exactly
	// what analysing this file on its own would have found.
	dependencyDiagnostics: Map<string, Array<common.Diagnostic>> | null
	// NOTE: What this file's entries resolve to, by the specifier as written.
	// Memoised because it costs a `realpath` per specifier and is asked for by
	// every walk of the dependency edges.
	dependencies: Map<string, string> | null
}

const diskVersion = -1

export function createWorkspace(options: WorkspaceOptions = {}) {
	let folders: Array<string> = []
	let files = new Map<string, FileEntry>()
	let discovered: Set<string> | null = null
	let openDocument = options.openDocument ?? (() => undefined)
	// NOTE: The dependency edges of the workspace, both ways, kept rather than
	// rebuilt. Rebuilding them meant reading the entries of every known file,
	// which meant a parse and a `realpath` per specifier per file — on a
	// keystroke, because that is when a component has to be invalidated. Held as
	// two maps rather than one undirected one because they are maintained from
	// the out-edges of one file at a time, and a dependent is what an
	// invalidation needs to find.
	let outEdges = new Map<string, Set<string>>()
	let inEdges = new Map<string, Set<string>>()
	// NOTE: The files whose recorded edges may not match their current text.
	// Refreshed only where an EXACT component is wanted — a rename, a reference
	// search — never on the invalidation path.
	let staleEdges = new Set<string>()

	// NOTE: Read through the same host the graph uses, so that a file the
	// workspace holds parsed and the same file inside a Module graph are the
	// same text — the Editor's buffer wherever there is one.
	let host: ModuleHost = {
		readFile(filePath) {
			let open = openDocument(filePath)

			if (open !== undefined) {
				return open.text
			}

			try {
				return readFileSync(filePath, "utf-8")
			} catch {
				return undefined
			}
		},
	}

	function invalidate(filePath: string): void {
		files.delete(filePath)
	}

	// NOTE: A Module's typed Program is built against its dependencies, so an
	// edit reaches every file connected to it by entries — and no further, which
	// is why the component is what is dropped rather than the whole workspace: a
	// file that imports nothing and is imported by nothing invalidates itself
	// alone. Parses are kept throughout, since the text of the other files did
	// not change.
	//
	// NOTE: Walked over the RECORDED edges, without refreshing them, and that is
	// the point: this runs on every keystroke, and refreshing means re-parsing.
	// The recorded edges are the ones the invalidation needs — an edit to F can
	// only have changed F's own entries, so every file that reaches F still
	// reaches it by the edges that were there before the keystroke. A specifier
	// F gained points at a file that does not depend on F and whose enrichment
	// therefore did not go stale.
	function invalidateEnrichment(filePath: string): void {
		for (let affected of connectedComponent(filePath, false)) {
			let entry = files.get(affected)

			if (entry === undefined) {
				continue
			}

			entry.index = null
			entry.enriched = null
			entry.enrichmentAttempted = false
			entry.annotations = null
			entry.diagnostics = null
			entry.dependencyDiagnostics = null
		}
	}

	function setFolders(nextFolders: Array<string>): void {
		folders = nextFolders.map((folder) => canonicalPath(folder))
		discovered = null
		files.clear()
		outEdges.clear()
		inEdges.clear()
		staleEdges.clear()
	}

	function changed(filePath: string): void {
		invalidate(filePath)
		invalidateEnrichment(filePath)
		staleEdges.add(filePath)

		if (isInWorkspace(filePath) && discovered?.has(filePath) === false) {
			discovered.add(filePath)
			// NOTE: A file that did not exist a moment ago is exactly what an
			// unresolved specifier in some OTHER file was waiting for, so every
			// file's edges are suspect — which specifier resolves to what is the
			// one question a parse alone can not answer. A file appearing is a
			// watcher event; a keystroke never comes through here.
			markEdgesStale()
		}
	}

	function removed(filePath: string): void {
		invalidateEnrichment(filePath)
		invalidate(filePath)
		discovered?.delete(filePath)
		forgetEdges(filePath)
		// NOTE: The mirror of a file appearing: every specifier that resolved to
		// this one resolves to nothing now.
		markEdgesStale()
	}

	function isInWorkspace(filePath: string): boolean {
		return folders.some(
			(folder) =>
				filePath === folder ||
				filePath.startsWith(`${folder}${path.sep}`),
		)
	}

	function knownFiles(): Set<string> {
		if (discovered === null) {
			discovered = new Set()

			for (let folder of folders) {
				collectEssenceFiles(folder, discovered)
			}

			for (let filePath of discovered) {
				staleEdges.add(filePath)
			}
		}

		return discovered
	}

	/*************************/
	/* The dependency edges  */
	/*************************/

	// NOTE: The out-edges of one file, and the reverse edges that go with them.
	// Called from two places: a graph that was just linked, which knows every
	// Module's dependencies exactly and for free, and a refresh, which reads
	// them off a parse.
	function recordEdges(filePath: string, targets: Iterable<string>): void {
		let next = new Set(targets)
		let previous = outEdges.get(filePath)

		for (let target of previous ?? []) {
			if (!next.has(target)) {
				dropInEdge(target, filePath)
			}
		}

		for (let target of next) {
			let back = inEdges.get(target)

			if (back === undefined) {
				back = new Set()
				inEdges.set(target, back)
			}

			back.add(filePath)
		}

		outEdges.set(filePath, next)
		staleEdges.delete(filePath)
	}

	// NOTE: The key goes with the last edge into it, so that a path named once by
	// a specifier that has since been rewritten is not kept for the process'
	// lifetime by an empty Set.
	function dropInEdge(target: string, dependent: string): void {
		let back = inEdges.get(target)

		if (back === undefined) {
			return
		}

		back.delete(dependent)

		if (back.size === 0) {
			inEdges.delete(target)
		}
	}

	// NOTE: The out-edges go, the IN-edges deliberately stay: a file that was
	// deleted is one a branch switch may bring back, and the importers waiting
	// for it are exactly what has to be invalidated when it does. They are
	// reachable only through this path until then, since nothing resolves to it.
	function forgetEdges(filePath: string): void {
		for (let target of outEdges.get(filePath) ?? []) {
			dropInEdge(target, filePath)
		}

		outEdges.delete(filePath)
		staleEdges.delete(filePath)
	}

	function refreshEdges(filePath: string): void {
		recordEdges(filePath, dependenciesOf(filePath).values())
	}

	// NOTE: Everything whose recorded edges may no longer match its text, marked
	// without asking what is in the workspace: this runs on a watcher
	// notification, and discovery is a recursive walk of every folder of it. A
	// walk that has not happened yet marks its own findings stale when it does
	// (see `knownFiles`), so deferring to it loses nothing.
	function markEdgesStale(): void {
		for (let filePath of discovered ?? []) {
			staleEdges.add(filePath)
		}

		for (let filePath of outEdges.keys()) {
			staleEdges.add(filePath)
		}
	}

	// NOTE: Every recorded edge brought up to the text as it is now, which is
	// what a walk that has to be EXACT needs — a rename, a reference search, the
	// set of documents an edit obliges the Server to publish again.
	//
	// Drained rather than iterated: reading one file's entries parses it, and a
	// parse is what makes the NEXT file's edges knowable. The delete is what
	// guarantees the loop ends, whatever `refreshEdges` finds.
	function refreshAllEdges(): void {
		knownFiles()

		while (staleEdges.size > 0) {
			let [stale] = staleEdges

			staleEdges.delete(stale!)
			refreshEdges(stale!)
		}
	}

	// NOTE: Every file that could possibly hold an occurrence of a symbol
	// written in this one, and no others. A name crosses a Module boundary only
	// through an entry, so anything sharing a symbol with this file is connected
	// to it by entries — walked in BOTH directions, since a dependency holds the
	// declaration and a dependent holds the uses.
	//
	// `exact` is what tells the two callers apart. A rename must see the edges
	// as the current text writes them, and pays a parse for each file whose text
	// has moved since the edges were read. An invalidation must not pay
	// anything, and does not have to: see `invalidateEnrichment`.
	function connectedComponent(
		filePath: string,
		exact: boolean,
	): Array<string> {
		if (exact) {
			refreshAllEdges()

			if (!outEdges.has(filePath)) {
				refreshEdges(filePath)
			}
		}

		let component = new Set<string>([filePath])
		let pending = [filePath]

		while (pending.length > 0) {
			let current = pending.shift()!

			for (let neighbour of [
				...(outEdges.get(current) ?? []),
				...(inEdges.get(current) ?? []),
			]) {
				if (
					component.has(neighbour) ||
					(exact && fileOf(neighbour) === null)
				) {
					continue
				}

				component.add(neighbour)
				pending.push(neighbour)
			}
		}

		return [...component]
	}

	function componentOf(filePath: string): Array<string> {
		return connectedComponent(filePath, true)
	}

	// NOTE: This file and everything that reaches it through entries, which is
	// exactly the set an edit to it can change the meaning of — and therefore the
	// set whose published Diagnostics have gone stale with it.
	//
	// Directed, where `componentOf` is not, and that is the whole point: a file
	// that merely SHARES a dependency with this one imports nothing from it, so
	// nothing it means can have moved. Answering with the undirected component
	// would make one keystroke in a Module thirty files import cost thirty graph
	// links — one per open sibling, since no sibling's graph contains another's.
	function dependentsOf(filePath: string): Array<string> {
		refreshAllEdges()

		if (!outEdges.has(filePath)) {
			refreshEdges(filePath)
		}

		let found = new Set<string>([filePath])
		let pending = [filePath]

		while (pending.length > 0) {
			let current = pending.shift()!

			for (let dependent of inEdges.get(current) ?? []) {
				if (found.has(dependent) || fileOf(dependent) === null) {
					continue
				}

				found.add(dependent)
				pending.push(dependent)
			}
		}

		return [...found]
	}

	function fileOf(filePath: string): FileEntry | null {
		let open = openDocument(filePath)
		let version = open?.version ?? diskVersion
		let cached = files.get(filePath)

		if (
			cached !== undefined &&
			cached.version === version &&
			(open === undefined || cached.sourceText === open.text)
		) {
			return cached
		}

		let sourceText = open?.text ?? host.readFile(filePath)

		if (sourceText === undefined || isStdlibDocument(filePath)) {
			files.delete(filePath)

			return null
		}

		let parsed = parseSafely(sourceText, filePath)
		let entry: FileEntry = {
			filePath,
			sourceText,
			version,
			program: parsed.program,
			parseDiagnostics: parsed.diagnostics,
			index: null,
			enriched: null,
			enrichmentAttempted: false,
			annotations: null,
			diagnostics: null,
			dependencyDiagnostics: null,
			dependencies: null,
		}

		files.set(filePath, entry)

		return entry
	}

	/*****************/
	/* The analysis  */
	/*****************/

	// NOTE: The one door text comes through, and therefore where the promise that
	// a Compiler bug never takes this Server down has to be kept: `fileOf` is
	// called from request handlers, from the edge walk and from the debounced
	// analysis' own timer callback, none of which sits inside a `try` — and a
	// throw out of a timer callback is the process.
	//
	// Reachable rather than defensive: the Lexer recurs once per nesting level of
	// an interpolated String and runs out of call stack before the Parser's own
	// depth guard can refuse it, so a file holding one deep enough throws here.
	// The empty Program is what every reader then sees, which is what analysing
	// such a file on its own has always answered with.
	function parseSafely(
		sourceText: string,
		filePath: string,
	): { program: parser.Program; diagnostics: Array<common.Diagnostic> } {
		try {
			return parseDocument(sourceText, filePath)
		} catch (error) {
			return {
				program: unreadableProgram(sourceText),
				diagnostics: [internalError(error)],
			}
		}
	}

	// NOTE: The ONE producer. Everything else in this file that answers with a
	// typed Program, an index, an annotation or a Diagnostic reads what this
	// left behind — the debounced analysis the Server publishes from included,
	// which is why a Hover arriving before that debounce fires does not make the
	// Server compile the same text twice.
	//
	// A Module is enriched against the whole graph it reaches, because what an
	// entry brings in is only known there — enriched on its own, every imported
	// name resolves to nothing and every Method dispatching through an imported
	// Namespace stays unbound. That makes a write for one file a write for its
	// whole component: the graph judged every Module in it, and a Module's
	// Diagnostics depend on that Module and on what IT reaches, never on the
	// entry the graph happened to be loaded from.
	//
	// NOTE: The annotations are collected for the asked-about file and no other.
	// The collector can only be open for one Module of a graph at a time
	// (`annotationsFor`), so a Hover over a DIFFERENT Module of the same
	// component pays for one more link — once, for that file at that version.
	function analysisOf(
		filePath: string,
		options: {
			annotations?: boolean
			// NOTE: Whose written annotations the graph-wide enrichment should
			// collect, when that is not the file being analysed. The collector
			// only opens for ONE Module of a graph at a time, and the analysis
			// of a component is deliberately anchored at the Module that reaches
			// the most others — which is rarely the one under the reader's
			// cursor. The Server passes the document the keystroke landed in.
			annotationsFor?: string
			cancellation?: Cancellation
		} = {},
	): Analysis | null {
		let entry = fileOf(filePath)

		if (entry === null) {
			return null
		}

		if (
			entry.diagnostics !== null &&
			!(options.annotations === true && entry.annotations === null)
		) {
			return cachedAnalysis(entry)
		}

		if (isCancelled(options.cancellation)) {
			return null
		}

		try {
			if (isModule(entry.program, filePath)) {
				if (
					!analyseGraphFrom(
						entry,
						options.cancellation,
						options.annotationsFor,
					)
				) {
					return null
				}
			} else {
				analyseAloneFrom(entry)
			}
		} catch (error) {
			// NOTE: A Compiler bug must never take the Language Server down, so
			// an unexpected throw becomes the one Diagnostic that says so — and
			// it is CACHED, because the alternative is throwing again for every
			// request over a document that will not compile until it is edited.
			//
			// The annotations are part of that: they are what a Hover asks for,
			// the guard above re-enters whenever they are still null, and a Hover
			// is the request a reader repeats. Empty is the honest answer — a
			// document that would not enrich has no written Types to report.
			entry.diagnostics ??= [internalError(error)]
			entry.dependencyDiagnostics ??= new Map()
			entry.annotations ??= []
			entry.enrichmentAttempted = true
		}

		return cachedAnalysis(entry)
	}

	function cachedAnalysis(entry: FileEntry): Analysis {
		return {
			program: entry.program,
			enrichedProgram: entry.enriched,
			diagnostics: entry.diagnostics ?? [],
			dependencies: entry.dependencyDiagnostics ?? new Map(),
		}
	}

	// NOTE: The entry's own text is handed to the graph rather than read through
	// the host a second time, so that the parse this cache holds and the parse
	// inside the graph are of the same bytes — which is what the guard on every
	// write below compares against.
	//
	// NOTE: False when the work was abandoned, and then NOTHING was written: an
	// enrichment without the Diagnostics that were being computed from it is a
	// cache entry that answers for a file it never judged.
	function analyseGraphFrom(
		entry: FileEntry,
		cancellation: Cancellation | undefined,
		annotationsFor?: string,
	): boolean {
		let entryPath = entry.filePath
		let graph = loadModuleGraph(entryPath, {
			readFile: (filePath) =>
				filePath === entryPath
					? entry.sourceText
					: host.readFile(filePath),
		})
		// NOTE: A file the graph does not hold can not have its annotations
		// collected from it, and asking for one anyway collects NOBODY's.
		let annotated =
			annotationsFor !== undefined && graph.modules.has(annotationsFor)
				? annotationsFor
				: entryPath
		let linked = linkModuleGraph(graph, { annotationsFor: annotated })
		let analyses = analyseLinkedGraph(linked, { cancellation })

		if (analyses === null) {
			return false
		}

		// NOTE: The graph knows every Module's dependencies for free, so the edge
		// index is maintained from it rather than re-derived — but only the ones
		// it could READ, and the edge an invalidation most needs is the other
		// kind: a specifier naming a file that does not exist yet is precisely
		// what has to be re-analysed when that file appears. Unrecorded, the
		// importer keeps answering `Error` for a name that now resolves, for
		// ever. The lexical resolutions know the edge whether the file is there
		// or not, so both are recorded.
		for (let [modulePath, module] of linked.modules) {
			recordEdges(modulePath, [
				...module.module.dependencies,
				...dependenciesOf(modulePath).values(),
			])
		}

		for (let [modulePath, module] of linked.modules) {
			let moduleEntry = fileOf(modulePath)

			// NOTE: The text moved between the graph reading it and this cache
			// reading it, so what the graph produced belongs to a version that
			// has already gone.
			if (
				moduleEntry === null ||
				moduleEntry.sourceText !== module.module.sourceText
			) {
				continue
			}

			// NOTE: A file that writes NEITHER section is a Program of its own
			// everywhere else in this Server — enriched by `enrichDocument`,
			// whose Choices stay unqualified — while a graph that reaches it as
			// a dependency enriches it under a Module path instead. Its own
			// answer is the one every request for it must see, so the graph's is
			// used for the importer and dropped here.
			if (!isModule(moduleEntry.program, modulePath)) {
				continue
			}

			// NOTE: Whichever graph reached this Module first keeps it, so a file
			// two graphs both reach is enriched twice and only one of the two
			// typed Programs is ever read for it — the other stays embedded in
			// the importer that was enriched alongside it. That is sound because
			// nothing across the seam compares Types by identity: the join is by
			// (declaring file, Position) and the member tables are by name. What
			// it buys is the stable identity the entry promises, which an index
			// built against the first copy depends on.
			if (!moduleEntry.enrichmentAttempted) {
				moduleEntry.enriched = module.program
				moduleEntry.enrichmentAttempted = true
			}

			if (modulePath === annotated && moduleEntry.annotations === null) {
				moduleEntry.annotations = module.annotations
			}

			if (moduleEntry.diagnostics === null) {
				moduleEntry.diagnostics =
					modulePath === entryPath
						? [
								...linked.diagnostics,
								...(analyses.get(modulePath) ?? []),
							]
						: (analyses.get(modulePath) ?? [])
				moduleEntry.dependencyDiagnostics = reachedDiagnostics(
					modulePath,
					linked,
					analyses,
				)
			}
		}

		// NOTE: The entry could not be read as a Module at all, so the graph
		// holds none for it and the Diagnostics saying so are all there is.
		if (entry.diagnostics === null) {
			entry.diagnostics = [...linked.diagnostics]
			entry.dependencyDiagnostics = new Map()
			entry.enrichmentAttempted = true
		}

		return true
	}

	function analyseAloneFrom(entry: FileEntry): void {
		let analysed = analyseEnrichedDocument(
			entry.program,
			entry.parseDiagnostics,
			entry.filePath,
			{ annotations: true },
		)

		recordEdges(entry.filePath, [])

		if (!entry.enrichmentAttempted) {
			entry.enriched = analysed.enrichedProgram
			entry.enrichmentAttempted = true
		}

		entry.annotations ??= analysed.annotations
		entry.diagnostics ??= analysed.diagnostics
		entry.dependencyDiagnostics ??= new Map()
	}

	// NOTE: What THIS Module reaches, which is what analysing it on its own
	// would have found — not the whole graph, which is what the file the graph
	// was loaded from reaches. The Server publishes these under the other files'
	// own URIs and owns them afterwards, so answering with a file this Module
	// never names would make it own a squiggle it can not clear.
	function reachedDiagnostics(
		modulePath: string,
		linked: LinkedGraph,
		analyses: Map<string, Array<common.Diagnostic>>,
	): Map<string, Array<common.Diagnostic>> {
		let reached = new Map<string, Array<common.Diagnostic>>()
		let pending = [
			...(linked.modules.get(modulePath)?.module.dependencies ?? []),
		]

		while (pending.length > 0) {
			let current = pending.shift()!

			if (current === modulePath || reached.has(current)) {
				continue
			}

			reached.set(current, analyses.get(current) ?? [])
			pending.push(
				...(linked.modules.get(current)?.module.dependencies ?? []),
			)
		}

		return reached
	}

	function enrichedOf(filePath: string): common.typed.Program | null {
		return analysisOf(filePath)?.enrichedProgram ?? null
	}

	// NOTE: The Hover seam. The same linked enrichment the analysis runs, with
	// the annotation collector open for this one file — an annotation resolved
	// WITHOUT the graph answers 'Error' for every imported name it writes, which
	// is exactly the Hover this exists to prevent.
	function annotationsOf(
		filePath: string,
		options: { cancellation?: Cancellation } = {},
	): Array<common.TypeAnnotation> {
		analysisOf(filePath, { ...options, annotations: true })

		return fileOf(filePath)?.annotations ?? []
	}

	function indexOf(filePath: string): ProgramIndex | null {
		let entry = fileOf(filePath)

		if (entry === null) {
			return null
		}

		if (entry.index === null) {
			entry.index = indexProgram(entry.program, enrichedOf(filePath))
		}

		return entry.index
	}

	// NOTE: The three things a request answering ABOUT a document needs, in one
	// read: Completion, Signature Help and the Namespace listing all used to
	// derive every one of them for themselves, several times per request.
	//
	// The index is deliberately part of it. Building one rebuilds the whole
	// builtin top level Scope — every builtin value and Type, as fresh
	// Declarations, because the walk records occurrences onto them — and
	// Completion, Semantic Tokens and Document Highlight each did it per
	// request.
	function documentOf(
		filePath: string,
		options: { cancellation?: Cancellation } = {},
	): DocumentAnalysis | null {
		let analysis = analysisOf(filePath, options)

		// NOTE: Null covers both "there is nothing here" and "the work was
		// abandoned". Neither is a document a request may answer from: half an
		// analysis would answer with an unenriched Program, which is a Hover
		// that says 'Error' about names that are perfectly fine.
		if (analysis === null || analysis.program === null) {
			return null
		}

		return {
			program: analysis.program,
			enrichedProgram: analysis.enrichedProgram,
			index: indexOf(filePath),
		}
	}

	function programOf(filePath: string): parser.Program | null {
		return fileOf(filePath)?.program ?? null
	}

	function sourceOf(filePath: string): string | null {
		return fileOf(filePath)?.sourceText ?? null
	}

	// NOTE: Both sections, since a re-export is a dependency like any other —
	// a facade whose only mention of a Module is a `from` clause still depends
	// on it. Keyed by the specifier as written, which is what an entry names it
	// by everywhere else.
	function dependenciesOf(filePath: string): Map<string, string> {
		let file = fileOf(filePath)
		let resolutions = new Map<string, string>()

		if (file === null) {
			return resolutions
		}

		if (file.dependencies !== null) {
			return file.dependencies
		}

		let sources = [
			...(file.program.imports?.entries ?? []).map(
				(entry) => entry.source,
			),
			...(file.program.exports?.entries ?? []).flatMap((entry) =>
				entry.source === null ? [] : [entry.source],
			),
		]

		for (let source of sources) {
			if (resolutions.has(source.path)) {
				continue
			}

			let resolution = resolveSpecifier(source.path, filePath)

			if (resolution.kind === "module") {
				resolutions.set(source.path, resolution.filePath)
			}
		}

		file.dependencies = resolutions

		return resolutions
	}

	// NOTE: What every Module in the workspace publishes, read off the parses.
	// A re-export forwards a name it never declares, so the kind is asked of the
	// Module the chain ends in — followed here rather than guessed, and cut off
	// at a Module already seen so two facades forwarding each other's names
	// terminate.
	function exportsOf(filePath: string): Array<WorkspaceExport> {
		let program = programOf(filePath)

		if (program === null || program.exports === null) {
			return []
		}

		return program.exports.entries.flatMap((entry) => {
			let published = entry.alias ?? entry.name
			let declaration = declarationBehind(
				filePath,
				entry,
				new Set<string>(),
			)

			if (declaration === null) {
				return []
			}

			return [
				{
					name: published.content,
					kind: declaration.kind,
					filePath,
					declaredIn: declaration.filePath,
					position: declaration.position,
				},
			]
		})
	}

	function declarationBehind(
		filePath: string,
		entry: parser.ExportNode,
		visited: Set<string>,
	): {
		kind: DeclarationKind
		filePath: string
		position: common.Position
	} | null {
		if (visited.has(filePath)) {
			return null
		}

		visited.add(filePath)

		if (entry.source === null) {
			let program = programOf(filePath)
			let declaration =
				program === null
					? undefined
					: topLevelDeclarations(program).get(entry.name.content)

			return declaration === undefined
				? null
				: { ...declaration, filePath }
		}

		let dependencyPath = dependenciesOf(filePath).get(entry.source.path)
		let dependency =
			dependencyPath === undefined ? null : programOf(dependencyPath)

		if (dependencyPath === undefined || dependency === null) {
			return null
		}

		for (let forwarded of dependency.exports?.entries ?? []) {
			if (
				(forwarded.alias ?? forwarded.name).content !==
				entry.name.content
			) {
				continue
			}

			return declarationBehind(dependencyPath, forwarded, visited)
		}

		return null
	}

	// NOTE: Every Module in the workspace that publishes this name, so that an
	// unknown name can be offered as an import of each. A name two Modules both
	// export is two offers rather than a guess between them.
	function exportersOf(name: string): Array<WorkspaceExport> {
		return [...knownFiles()].flatMap((candidate) =>
			exportsOf(candidate).filter((exported) => exported.name === name),
		)
	}

	// NOTE: Every name in the workspace this file could import and has not. A
	// name it already binds is not offered under any circumstances: an entry
	// that collided with a declaration or with another entry is refused by the
	// Compiler, so accepting such an offer would leave the file worse than it
	// was. Read off the parses — a Completion list is rebuilt on every keystroke
	// and must not enrich a workspace to be drawn.
	function offersFor(filePath: string): Array<WorkspaceOffer> {
		let program = programOf(filePath)

		if (program === null) {
			return []
		}

		let taken = new Set<string>([
			...topLevelDeclarations(program).keys(),
			...(program.imports?.entries ?? []).map(
				(entry) => (entry.alias ?? entry.name).content,
			),
		])

		return [...knownFiles()].flatMap((candidate) => {
			if (candidate === filePath) {
				return []
			}

			let specifier = relativeSpecifier(filePath, candidate)

			return exportsOf(candidate).flatMap((exported) =>
				taken.has(exported.name)
					? []
					: [
							{
								name: exported.name,
								kind: exported.kind,
								specifier,
								filePath: candidate,
								declaredIn: exported.declaredIn,
								position: exported.position,
							},
						],
			)
		})
	}

	// NOTE: The Namespace Types behind those offers, which is what turns a
	// Method Completion into an offer to import the Namespace declaring it.
	// Enriching a Module to answer this is the expensive half, so only the
	// Modules that publish a Namespace at all are ever asked.
	function namespaceOffersFor(
		filePath: string,
	): Array<{ offer: WorkspaceOffer; namespace: common.NamespaceType }> {
		let found: Array<{
			offer: WorkspaceOffer
			namespace: common.NamespaceType
		}> = []

		for (let offer of offersFor(filePath)) {
			// NOTE: The Module that DECLARES it is the one enriched, not the one
			// that publishes it — a facade forwarding a Namespace has no
			// Namespace of its own to read the Type off.
			let program =
				offer.kind === "namespace" ? enrichedOf(offer.declaredIn) : null

			if (program === null) {
				continue
			}

			for (let node of program.implementation.nodes) {
				if (
					node.nodeType === "NamespaceDefinitionStatement" &&
					isSamePosition(node.name.position, offer.position)
				) {
					found.push({
						offer,
						// NOTE: Under the name it is PUBLISHED as: an entry
						// importing it binds a copy of the Type carrying the
						// local name, and a Completion offering the import has
						// to name what the reader would actually write.
						namespace: { ...node.type, name: offer.name },
					})
				}
			}
		}

		return found
	}

	// NOTE: Answered from the parses, and from the same walk the outline is
	// built with — a workspace symbol is a document symbol whose document the
	// reader has not opened, so answering it any other way would be a second
	// definition of what counts as a symbol.
	function symbols(query: string): Array<WorkspaceSymbolEntry> {
		let entries: Array<WorkspaceSymbolEntry> = []
		let lowercased = query.toLowerCase()

		for (let filePath of knownFiles()) {
			let program = programOf(filePath)

			if (program === null) {
				continue
			}

			let published = new Set(
				(program.exports?.entries ?? []).map(
					(entry) => entry.name.content,
				),
			)

			let collect = (
				symbol: DocumentSymbolEntry,
				container: string | null,
			) => {
				if (matchesQuery(symbol.name, lowercased)) {
					entries.push({
						name: symbol.name,
						kind: symbol.kind,
						container,
						filePath,
						range: symbol.range,
						selectionRange: symbol.selectionRange,
						exported:
							container === null && published.has(symbol.name),
					})
				}

				for (let child of symbol.children) {
					collect(child, symbol.name)
				}
			}

			for (let symbol of findDocumentSymbols(program)) {
				// NOTE: The export block's own entries are left out: they are
				// the same names again, and a search that answers twice for one
				// declaration is a search that has to be read twice.
				if (symbol.kind === "export") {
					continue
				}

				collect(symbol, null)
			}
		}

		return entries
	}

	/*******************/
	/* The symbol join */
	/*******************/

	// NOTE: `localOnly` joins the file with itself and nothing else, which is
	// still a join — an unaliased entry and the declaration it binds are one
	// symbol inside one file too. It is what Document Highlight rides: that
	// request is per-file by protocol and fires on every cursor move, so it must
	// never be the thing that enriches a workspace.
	function symbolAt(
		filePath: string,
		cursor: common.Cursor,
		options: { localOnly?: boolean } = {},
	): WorkspaceSymbol | null {
		let index = indexOf(filePath)

		if (index === null) {
			return null
		}

		let occurrence = occurrenceAt(index.index, cursor)

		if (occurrence !== null && occurrence.declaration.builtin) {
			return null
		}

		let joined = joinComponent(
			options.localOnly === true ? [filePath] : componentOf(filePath),
			indexOf,
			programOf,
			dependenciesOf,
		)
		// NOTE: The join is asked by Position as well as by Declaration,
		// because half the Identifiers an entry writes are in no file's Scope
		// at all: the exported side of `PI as Pi` names what another Module
		// publishes, and the published side of `squared as square` names what
		// this one does. Neither is a local binding, and both are renameable.
		let symbol =
			(occurrence === null
				? null
				: joined.symbolFor(filePath, occurrence.declaration)) ??
			joined.symbolAtPosition(filePath, cursor)

		if (symbol !== null) {
			return symbol
		}

		if (occurrence === null) {
			return null
		}

		// NOTE: Nothing crossed a Module boundary, so the file's own answer IS
		// the workspace's — a Parameter, a local, a Record member.
		return {
			name: occurrence.name,
			kind: occurrence.declaration.kind,
			filePath,
			definition: occurrence.declaration.definition,
			occurrences: occurrence.declaration.occurrences.map((site) => ({
				filePath,
				position: site.position,
				edits: site.edits,
				access: "read" as const,
			})),
		}
	}

	return {
		setFolders,
		folders: () => folders,
		isInWorkspace,
		changed,
		removed,
		knownFiles,
		programOf,
		sourceOf,
		indexOf,
		analysisOf,
		documentOf,
		enrichedOf,
		annotationsOf,
		dependenciesOf,
		componentOf,
		dependentsOf,
		exportsOf,
		exportersOf,
		offersFor,
		namespaceOffersFor,
		symbols,
		symbolAt,
		host,
	}
}

/*******************/
/* The symbol join */
/*******************/

// NOTE: Symbol identity across Modules is (declaring file, declaration
// Position), and the entries are what tie one file's answer to another's. Each
// site below is one END of such a tie:
//
//   • a `decl:` site is a Declaration in one file, occurrences and all;
//   • an `export:` site is the name a Module PUBLISHES, which is a symbol in
//     its own right — `area as measure` has two, and renaming the public one
//     must not touch the local one or the other way round.
//
// An entry that writes one Identifier for both roles — an unaliased import or
// export — merges the two sites instead of recording its Identifier twice,
// which is what keeps one Position out of two edits of the same rename.
type SiteData = {
	name: string
	kind: DeclarationKind | null
	filePath: string | null
	definition: common.Position | null
	occurrences: Array<WorkspaceOccurrence>
}

type JoinedWorkspace = {
	symbolFor(
		filePath: string,
		declaration: Declaration,
	): WorkspaceSymbol | null
	symbolAtPosition(
		filePath: string,
		cursor: common.Cursor,
	): WorkspaceSymbol | null
}

function joinComponent(
	component: Array<string>,
	indexOf: (filePath: string) => ProgramIndex | null,
	programOf: (filePath: string) => parser.Program | null,
	dependenciesOf: (filePath: string) => Map<string, string>,
): JoinedWorkspace {
	let sites = new Map<string, SiteData>()
	let parents = new Map<string, string>()
	let declarationKeys = new Map<string, Map<Declaration, string>>()
	let indices = new Map<string, ProgramIndex>()

	let find = (key: string): string => {
		let parent = parents.get(key)

		if (parent === undefined || parent === key) {
			return key
		}

		let root = find(parent)

		parents.set(key, root)

		return root
	}

	let siteOf = (key: string, data: () => SiteData): SiteData => {
		let site = sites.get(key)

		if (site === undefined) {
			site = data()
			sites.set(key, site)
			parents.set(key, key)
		}

		return site
	}

	let union = (left: string, right: string): void => {
		let leftRoot = find(left)
		let rightRoot = find(right)

		if (leftRoot === rightRoot) {
			return
		}

		parents.set(rightRoot, leftRoot)
	}

	let addOccurrence = (
		key: string,
		occurrence: WorkspaceOccurrence,
	): void => {
		sites.get(key)?.occurrences.push(occurrence)
	}

	let exportKey = (filePath: string, name: string) =>
		`export:${filePath}:${name}`

	// NOTE: Every Declaration of every file first, so that an entry resolved
	// below always has something on both ends to tie together.
	for (let filePath of component) {
		let index = indexOf(filePath)

		if (index === null) {
			continue
		}

		indices.set(filePath, index)

		let keys = new Map<Declaration, string>()

		declarationKeys.set(filePath, keys)

		for (let occurrence of index.index) {
			let { declaration } = occurrence
			let key = keys.get(declaration)

			if (key === undefined) {
				key =
					declaration.definition === null
						? `local:${filePath}:${keys.size}`
						: `decl:${filePath}:${positionKey(declaration.definition)}`
				keys.set(declaration, key)

				siteOf(key, () => ({
					name: occurrence.name,
					kind: declaration.kind,
					filePath,
					definition: declaration.definition,
					occurrences: [],
				}))
			}

			addOccurrence(key, {
				filePath,
				position: occurrence.position,
				edits: occurrence.edits,
				access: occurrence.access,
			})
		}
	}

	for (let filePath of component) {
		let program = programOf(filePath)
		let index = indices.get(filePath)

		if (program === null || index === undefined) {
			continue
		}

		let dependencies = dependenciesOf(filePath)
		let keys = declarationKeys.get(filePath)!

		for (let entry of program.imports?.entries ?? []) {
			let dependencyPath = dependencies.get(entry.source.path)

			if (dependencyPath === undefined) {
				continue
			}

			let remote = exportKey(dependencyPath, entry.name.content)

			siteOf(remote, () => ({
				name: entry.name.content,
				kind: null,
				filePath: null,
				definition: null,
				occurrences: [],
			}))

			let local = occurrenceAt(
				index.index,
				cursorOf(entry.alias ?? entry.name),
			)
			let localKey =
				local === null ? undefined : keys.get(local.declaration)

			if (entry.alias === null) {
				// NOTE: One Identifier, both roles — the entry's own binding and
				// the reference to what the dependency publishes. Merged rather
				// than recorded twice, so a rename writes that Position once.
				if (localKey !== undefined) {
					union(remote, localKey)
				}
			} else {
				addOccurrence(remote, {
					filePath,
					position: entry.name.position,
					access: "read",
				})
			}
		}

		for (let entry of program.exports?.entries ?? []) {
			let published = entry.alias ?? entry.name
			let publicKey = exportKey(filePath, published.content)

			siteOf(publicKey, () => ({
				name: published.content,
				kind: null,
				filePath: null,
				definition: null,
				occurrences: [],
			}))

			let target: string | undefined

			if (entry.source === null) {
				// NOTE: One entry carries the name across every table this
				// Module binds it in, so a `type Foo` and a Namespace `Foo` are
				// one exported symbol however separately the file declares
				// them. Joined here rather than left as two: a rename that
				// moved one of them would leave the other published under a
				// name nothing declares any more.
				for (let declaration of exportedDeclarations(
					index,
					entry.name,
				)) {
					let key = keys.get(declaration)

					if (key === undefined) {
						continue
					}

					if (target === undefined) {
						target = key
					} else {
						union(target, key)
					}
				}
			} else {
				let dependencyPath = dependencies.get(entry.source.path)

				if (dependencyPath !== undefined) {
					target = exportKey(dependencyPath, entry.name.content)

					siteOf(target, () => ({
						name: entry.name.content,
						kind: null,
						filePath: null,
						definition: null,
						occurrences: [],
					}))

					addOccurrence(target, {
						filePath,
						position: entry.name.position,
						access: "read",
					})
				}
			}

			if (target === undefined) {
				addOccurrence(publicKey, {
					filePath,
					position: published.position,
					access: "read",
				})

				continue
			}

			if (entry.alias === null) {
				union(target, publicKey)
			} else {
				addOccurrence(publicKey, {
					filePath,
					position: entry.alias.position,
					access: "read",
				})
			}
		}
	}

	// NOTE: Last, because a Method dispatching through an imported Namespace can
	// only be bound once the entry that brought that Namespace in has been
	// joined — the Declaration it names is in another file, and which file that
	// is is exactly what the join above answers.
	for (let filePath of component) {
		let index = indices.get(filePath)

		if (index === undefined) {
			continue
		}

		let topLevel = index.scopes.find((entry) => entry.range === null)?.scope

		for (let reference of index.externalMembers) {
			let binding = topLevel?.values.get(reference.namespaceName)
			let localKey =
				binding === undefined
					? undefined
					: declarationKeys.get(filePath)?.get(binding)

			if (localKey === undefined) {
				continue
			}

			let declaring = declaringSite(sites, find, localKey)

			if (declaring === null || declaring.filePath === null) {
				continue
			}

			let member = indices
				.get(declaring.filePath)
				?.namespaceMembers.get(declaring.name)
				?.get(reference.memberName)
			let memberKey =
				member === undefined
					? undefined
					: declarationKeys.get(declaring.filePath)?.get(member)

			if (memberKey === undefined) {
				continue
			}

			addOccurrence(memberKey, {
				filePath,
				position: reference.position,
				access: "read",
			})
		}
	}

	let symbolOf = (key: string): WorkspaceSymbol | null => {
		let root = find(key)
		let members = [...sites].filter(([siteKey]) => find(siteKey) === root)
		let anchor = declaringSite(sites, find, key) ?? sites.get(key) ?? null

		if (anchor === null) {
			return null
		}

		return {
			name: anchor.name,
			kind: anchor.kind ?? "constant",
			filePath: anchor.filePath,
			definition: anchor.definition,
			occurrences: members.flatMap(([, site]) => site.occurrences),
		}
	}

	return {
		symbolFor(filePath, declaration) {
			let key = declarationKeys.get(filePath)?.get(declaration)

			return key === undefined ? null : symbolOf(key)
		},

		// NOTE: Identifiers never span lines, and `end.column` is exclusive —
		// it is included anyway, so that a rename works with the cursor sitting
		// directly behind the name. The same rule `occurrenceAt` reads by.
		symbolAtPosition(filePath, cursor) {
			for (let [key, site] of sites) {
				for (let occurrence of site.occurrences) {
					if (
						occurrence.filePath === filePath &&
						occurrence.position.start.line === cursor.line &&
						occurrence.position.start.column <= cursor.column &&
						cursor.column <= occurrence.position.end.column
					) {
						return symbolOf(key)
					}
				}
			}

			return null
		},
	}
}

// NOTE: Every Declaration an export entry with no 'from' names. The local index
// binds the entry's Identifier to whichever symbol space answered first, so the
// other one is read off the top level Scope — where a Namespace sits under the
// same name as the Type it is written for.
function exportedDeclarations(
	index: ProgramIndex,
	name: parser.IdentifierNode,
): Array<Declaration> {
	let found: Array<Declaration> = []
	let remember = (declaration: Declaration | undefined): void => {
		if (declaration !== undefined && !found.includes(declaration)) {
			found.push(declaration)
		}
	}

	let topLevel = index.scopes.find((entry) => entry.range === null)?.scope

	remember(occurrenceAt(index.index, cursorOf(name))?.declaration)
	remember(topLevel?.values.get(name.content))
	remember(topLevel?.types.get(name.content))

	return found
}

// NOTE: The one site of a joined symbol that is a declaration in a file rather
// than a name an entry carries. An `import` binding has a Position too, so it is
// deliberately not it: what a rename must report as the declaration is where the
// symbol is WRITTEN, which is the file that would refuse the rename if it were
// outside the workspace.
function declaringSite(
	sites: Map<string, SiteData>,
	find: (key: string) => string,
	key: string,
): SiteData | null {
	let root = find(key)
	let fallback: SiteData | null = null

	for (let [siteKey, site] of sites) {
		if (find(siteKey) !== root || site.definition === null) {
			continue
		}

		if (site.kind !== "import") {
			return site
		}

		fallback ??= site
	}

	return fallback
}

/*************/
/* Utilities */
/*************/

// NOTE: A Program with nothing in it, standing in for a file the Parser could
// not read at all. Neither Module section, so every reader treats it as the
// single declaration space it now is — and its one Diagnostic, the Internal
// Compiler Error, is what the file actually shows.
function unreadableProgram(sourceText: string): parser.Program {
	let lines = sourceText.split("\n")
	let position: common.Position = {
		start: { line: 1, column: 1 },
		end: { line: lines.length, column: lines.at(-1)!.length + 1 },
	}

	return {
		nodeType: "Program",
		kind: "implementation",
		imports: null,
		implementation: {
			nodeType: "ImplementationSection",
			nodes: [],
			position,
		},
		exports: null,
		position,
	}
}

function positionKey(position: common.Position): string {
	return `${position.start.line}:${position.start.column}`
}

function cursorOf(identifier: parser.IdentifierNode): common.Cursor {
	return {
		line: identifier.position.start.line,
		column: identifier.position.start.column,
	}
}

function isSamePosition(a: common.Position, b: common.Position): boolean {
	return (
		a.start.line === b.start.line &&
		a.start.column === b.start.column &&
		a.end.line === b.end.line &&
		a.end.column === b.end.column
	)
}

// NOTE: The client filters and ranks the list itself, so this only has to be as
// generous as the protocol allows — a subsequence match, which is what every
// Editor's own "go to symbol" box does with what is typed into it.
function matchesQuery(name: string, query: string): boolean {
	if (query.length === 0) {
		return true
	}

	let lowercased = name.toLowerCase()
	let index = 0

	for (let character of query) {
		index = lowercased.indexOf(character, index)

		if (index === -1) {
			return false
		}

		index += 1
	}

	return true
}

// NOTE: The kinds a top level declaration can be, off the Parser AST — the same
// question `modules/link.ts` answers for the export surface, asked here without
// enriching anything, because auto-import and workspace symbols both need it for
// every file and neither needs a Type.
function topLevelDeclarations(
	program: parser.Program,
): Map<string, { kind: DeclarationKind; position: common.Position }> {
	let declarations = new Map<
		string,
		{ kind: DeclarationKind; position: common.Position }
	>()
	// NOTE: Only the FIRST declaration of a name is kept — a second one is a
	// duplicate the Enricher rejects, and it is not what an export of that name
	// forwards either.
	let remember = (
		name: parser.IdentifierNode,
		kind: DeclarationKind,
	): void => {
		if (!declarations.has(name.content)) {
			declarations.set(name.content, { kind, position: name.position })
		}
	}

	for (let node of program.implementation.nodes) {
		switch (node.nodeType) {
			// NOTE: A Pattern declares one name per binding, and every one of
			// them is a name this Module could export.
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement": {
				let kind =
					node.nodeType === "ConstantDeclarationStatement"
						? ("constant" as const)
						: ("variable" as const)

				if (node.name.nodeType === "Pattern") {
					for (let binding of patternBindings(node.name)) {
						remember(binding.name, kind)
					}
				} else {
					remember(node.name, kind)
				}

				break
			}
			case "FunctionStatement":
			case "OverloadedFunctionStatement":
				remember(node.name, "function")
				break
			case "NamespaceDefinitionStatement":
				remember(node.name, "namespace")
				break
			case "TypeAliasStatement":
			case "ChoiceDeclarationStatement":
				remember(node.name, "type")
				break
			case "ProtocolDeclarationStatement":
				remember(node.name, "protocol")
				break
		}
	}

	return declarations
}

// NOTE: A discovery walk, not a watcher — the watcher is the client's, and it
// keeps this answer current afterwards. Symlinked directories are followed as
// files rather than descended into, so a link back up the tree can not send the
// walk round for ever.
function collectEssenceFiles(directory: string, found: Set<string>): void {
	let entries: Array<{ name: string; isDirectory: boolean }> = []

	try {
		entries = readdirSync(directory, { withFileTypes: true }).map(
			(entry) => ({
				name: entry.name,
				isDirectory: entry.isDirectory(),
			}),
		)
	} catch {
		return
	}

	for (let entry of entries) {
		let entryPath = path.join(directory, entry.name)

		if (entry.isDirectory) {
			if (!skippedDirectories.has(entry.name)) {
				collectEssenceFiles(entryPath, found)
			}

			continue
		}

		if (!entry.name.endsWith(".es")) {
			continue
		}

		let filePath = canonicalPath(entryPath)

		// NOTE: A standard library source is never a Module — it declares the
		// builtins rather than importing anything — so it is not part of any
		// workspace, whichever directory a checkout happens to put it in.
		if (!isStdlibDocument(filePath)) {
			found.add(filePath)
		}
	}
}
