import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import {
	type ConfigurationCache,
	createConfigurationCache,
	isExcludedPath,
	type ProjectConfiguration,
	type ProjectProblems,
	skippedDirectories,
} from "@essence-lang/compiler/configuration"
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
import { type ModuleView, moduleViewsOf } from "./moduleLink"
import { relatedMembers, type ShapeGroup } from "./recordShapes"
import {
	type Declaration,
	type DeclarationKind,
	indexProgram,
	isBuiltinProtocolMember,
	occurrenceAt,
	type OccurrenceAccess,
	type ProgramIndex,
	protocolIdentityKey,
	type RenameEdit,
} from "./rename"

// The Workspace: every file of the workspace folders, keyed by canonical path,
// and what the Server derives from each. See "The Workspace" in DEVELOPMENT.md.

export type OpenDocument = {
	text: string
	version: number
}

type WorkspaceOptions = {
	// The Editor's buffers, which win over disk. The version tells a cached
	// parse from a stale one.
	openDocument?: (filePath: string) => OpenDocument | undefined
	// Whether the `tests` section is typed. Set per Workspace, since one cache
	// entry holds one enriched Program.
	tests?: boolean
}

export type WorkspaceOccurrence = {
	filePath: string
	position: common.Position
	access: OccurrenceAccess
	// See `RenameSite.edits`. An import or export entry never has any.
	edits?: Array<RenameEdit> | null
}

// One symbol across the workspace: its declaration and every occurrence in
// every file that reaches it, import and export entries included.
export type WorkspaceSymbol = {
	name: string
	kind: DeclarationKind
	// See `Declaration.labelled`.
	labelled?: boolean
	// Null when nothing in the workspace declares it. An entry naming what no
	// reachable Module exports still joins its own occurrences.
	filePath: string | null
	definition: common.Position | null
	// Every file a declaration of the symbol is written in: one, unless
	// it renames with others, as a requirement does with its conformers' Methods.
	declaredIn: Array<string>
	// Set where a Method of the group answers a member of a standard
	// library Protocol, which is declared outside every workspace.
	answersBuiltin?: boolean
	occurrences: Array<WorkspaceOccurrence>
}

type WorkspaceExport = {
	// The name the Module publishes, which an importer writes.
	name: string
	kind: DeclarationKind
	// The Module that publishes the name, which an entry names even when it
	// forwards another Module's declaration.
	filePath: string
	// Where the declaration is written; for a re-export, further along the
	// chain.
	declaredIn: string
	position: common.Position
}

// An export of another Module this file does not import yet, offered by
// Completion with the specifier written from the asking file.
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
	// What the symbol is written inside, such as a Method's Namespace. Null at
	// the top level.
	container: string | null
	filePath: string
	range: common.Position
	selectionRange: common.Position
	exported: boolean
}

export type Workspace = ReturnType<typeof createWorkspace>

// Everything the Server derives from one file at one version. See "The cache
// entry" in DEVELOPMENT.md.
type FileEntry = {
	filePath: string
	sourceText: string
	// An open document's version, or `diskVersion` for a file read off disk.
	// An Editor may reuse a version on re-opening, so the text is compared too.
	version: number
	program: parser.Program
	// Kept for the analysis, so a file with a syntax error never reports clean.
	parseDiagnostics: Array<common.Diagnostic>
	index: ProgramIndex | null
	enriched: common.typed.Program | null
	// Enrichment may answer with nothing when the Compiler throws.
	enrichmentAttempted: boolean
	// This file's written annotations. The collector opens for one Module of a
	// graph at a time, so a graph's analysis fills this for one file only.
	annotations: Array<common.TypeAnnotation> | null
	// This file's complete Diagnostics, filled by any analysis of a graph
	// holding it.
	diagnostics: Array<common.Diagnostic> | null
	// The Diagnostics of every other Module this file reaches.
	dependencyDiagnostics: Map<string, Array<common.Diagnostic>> | null
	// What each specifier of either Module section resolves to, memoised
	// since each costs a `realpath`.
	dependencies: Map<string, string> | null
	// What a Module was linked against: its imports and the graph's surfaces,
	// which let a probe resolve imported names. Null for a file that is no Module.
	module: ModuleView | null
}

const diskVersion = -1

export function createWorkspace(options: WorkspaceOptions = {}) {
	let folders: Array<string> = []
	let files = new Map<string, FileEntry>()
	let discovered: Set<string> | null = null
	// The project file governing each directory. A workspace may hold several
	// projects, one per `essence.json`.
	let configurations: ConfigurationCache = createConfigurationCache()
	let openDocument = options.openDocument ?? (() => undefined)
	// The dependency edges both ways, kept across edits. See "Dependency edges"
	// in DEVELOPMENT.md.
	let outEdges = new Map<string, Set<string>>()
	let inEdges = new Map<string, Set<string>>()
	// Files whose recorded edges may not match their text.
	let staleEdges = new Set<string>()

	// The host the Module graph reads through too, so both see the Editor's
	// buffer.
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

	// Drops what was derived from the enrichment of every file connected to
	// this one, keeping the parses. See "Dependency edges" in DEVELOPMENT.md.
	function invalidateEnrichment(filePath: string): void {
		for (let affected of connectedComponent(filePath, false)) {
			let entry = files.get(affected)

			if (entry === undefined) {
				continue
			}

			// A file writing neither Module section was enriched from its own
			// text alone, so an edit elsewhere cannot have moved it.
			if (!isModule(entry.program, affected)) {
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
		configurations.clear()
		files.clear()
		outEdges.clear()
		inEdges.clear()
		staleEdges.clear()
	}

	function changed(filePath: string): void {
		invalidate(filePath)
		invalidateEnrichment(filePath)
		staleEdges.add(filePath)

		if (
			isInWorkspace(filePath) &&
			!isExcluded(filePath) &&
			discovered?.has(filePath) === false
		) {
			discovered.add(filePath)
			// A new file may be what another file's unresolved specifier names,
			// so every edge is suspect. Only the watcher reaches this.
			markEdgesStale()
		}
	}

	function removed(filePath: string): void {
		invalidateEnrichment(filePath)
		invalidate(filePath)
		discovered?.delete(filePath)
		forgetEdges(filePath)
		// Every specifier that resolved to this file resolves to nothing now.
		markEdgesStale()
	}

	function isInWorkspace(filePath: string): boolean {
		return folders.some(
			(folder) =>
				filePath === folder ||
				filePath.startsWith(`${folder}${path.sep}`),
		)
	}

	// The settings of the nearest `essence.json` at or above the file, held
	// per directory until `setFolders` or `forgetConfiguration`.
	function configurationFor(filePath: string): ProjectConfiguration {
		return configurations.forFile(filePath)
	}

	// The problems of every project file the walk met, including an `essence`
	// key in a `package.json`, one entry per file. Each folder's root is read
	// first, so a manifest beside no `.es` file is still reported.
	function configurationProblems(): Array<ProjectProblems> {
		for (let folder of folders) {
			configurations.forDirectory(folder)
		}

		let byFile = new Map<string, ProjectProblems>()

		for (let configuration of configurations.known()) {
			for (let problem of configuration.problems) {
				if (!byFile.has(problem.filePath)) {
					byFile.set(problem.filePath, problem)
				}
			}
		}

		return [...byFile.values()]
	}

	// Forgets the settings alone, for a changed `package.json`, which moves no
	// boundary.
	function forgetConfiguration(): void {
		configurations.clear()
	}

	// Whether the nearest `essence.json` excludes the file from discovery. An
	// excluded file is still linked when imported, and analysed when opened.
	function isExcluded(filePath: string): boolean {
		return isExcludedPath(filePath, configurationFor(filePath).exclude)
	}

	function knownFiles(): Set<string> {
		if (discovered === null) {
			discovered = new Set()

			for (let folder of folders) {
				collectEssenceFiles(folder, discovered, configurations)
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

	// The out-edges of one file, and the in-edges that go with them.
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

	// The key goes with its last edge, so no empty Set outlives a rewritten
	// specifier.
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

	// The in-edges stay: a deleted file may come back, and its importers are
	// what its return invalidates.
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

	// Marks every known file without running discovery, whose walk marks what
	// it finds itself (`knownFiles`).
	function markEdgesStale(): void {
		for (let filePath of discovered ?? []) {
			staleEdges.add(filePath)
		}

		for (let filePath of outEdges.keys()) {
			staleEdges.add(filePath)
		}
	}

	// Brings every stale edge up to the current text, for walks that must be
	// exact. Drained, deleting before each refresh, so the loop ends.
	function refreshAllEdges(): void {
		knownFiles()

		while (staleEdges.size > 0) {
			let [stale] = staleEdges

			staleEdges.delete(stale!)
			refreshEdges(stale!)
		}
	}

	// Every file that could hold an occurrence of a symbol written in this one,
	// walking edges both ways. Only `exact` refreshes stale edges first.
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

	// This file and every file reaching it, the set an edit to it can change
	// the meaning of. Directed: a file sharing a dependency is unaffected.
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

	// These files and the live files they reach. An edge to a missing file
	// covers nothing.
	function reachFrom(
		entryPaths: Iterable<string>,
		live: Set<string>,
	): Set<string> {
		let reached = new Set<string>()
		let pending: Array<string> = []

		for (let entryPath of entryPaths) {
			if (live.has(entryPath) && !reached.has(entryPath)) {
				reached.add(entryPath)
				pending.push(entryPath)
			}
		}

		while (pending.length > 0) {
			let current = pending.shift()!

			for (let dependency of outEdges.get(current) ?? []) {
				if (reached.has(dependency) || !live.has(dependency)) {
					continue
				}

				reached.add(dependency)
				pending.push(dependency)
			}
		}

		return reached
	}

	// The files whose graphs between them cover the workspace. See "Roots" in
	// DEVELOPMENT.md.
	function roots(): Array<string> {
		refreshAllEdges()

		let known = [...knownFiles()].filter(
			(filePath) => fileOf(filePath) !== null,
		)

		known.sort()

		let live = new Set(known)
		// An unreadable importer does not count, or what it names would be
		// covered by nobody.
		let chosen = known.filter((filePath) =>
			[...(inEdges.get(filePath) ?? [])].every(
				(importer) => !live.has(importer),
			),
		)
		let reaches = new Map<string, Set<string>>()
		let reachOf = (filePath: string): Set<string> => {
			let reached = reaches.get(filePath)

			if (reached === undefined) {
				reached = reachFrom([filePath], live)
				reaches.set(filePath, reached)
			}

			return reached
		}
		let covered = reachFrom(chosen, live)

		while (covered.size < known.length) {
			let uncovered = known.filter((filePath) => !covered.has(filePath))
			let closest = uncovered[0]!

			for (let candidate of uncovered) {
				if (reachOf(candidate).size > reachOf(closest).size) {
					closest = candidate
				}
			}

			chosen.push(closest)

			for (let reached of reachOf(closest)) {
				covered.add(reached)
			}
		}

		return chosen.sort()
	}

	// The roots reaching these files. A root that only shares a dependency with
	// them was judged against text that did not move.
	function rootsReaching(filePaths: Iterable<string>): Array<string> {
		let chosen = new Set(roots())
		let reaching = new Set<string>()

		for (let filePath of filePaths) {
			for (let dependent of dependentsOf(filePath)) {
				if (chosen.has(dependent)) {
					reaching.add(dependent)
				}
			}
		}

		return [...reaching].sort()
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
			module: null,
		}

		files.set(filePath, entry)

		return entry
	}

	/*****************/
	/* The analysis  */
	/*****************/

	// Every parse goes through here. `fileOf` runs in timer callbacks outside
	// any `try`, where a Compiler throw would end the process. Reachable: a deep
	// enough interpolated String overflows the Lexer's stack before the Parser's
	// depth guard refuses it.
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

	// The one producer of typed Programs, indexes, annotations and Diagnostics;
	// every reader reads what it cached. See "Analysing a graph" in
	// DEVELOPMENT.md.
	function analysisOf(
		filePath: string,
		options: {
			annotations?: boolean
			// The file whose annotations the graph collects, when that is not
			// the analysed one. The Server passes the file being typed in.
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
			// A Compiler throw becomes one cached Diagnostic, so later requests
			// do not throw again. The annotations are cached empty for the same
			// reason, since a Hover asks for them.
			entry.diagnostics ??= [internalError(error)]
			entry.dependencyDiagnostics ??= new Map()
			entry.annotations ??= []
			entry.enrichmentAttempted = true
		}

		return cachedAnalysis(entry)
	}

	// Whether this file's Diagnostics are cached for its current text, without
	// reading or parsing it. The Server's coverage check asks this.
	function isAnalysed(filePath: string): boolean {
		let open = openDocument(filePath)
		let cached = files.get(filePath)

		return (
			cached !== undefined &&
			cached.diagnostics !== null &&
			cached.version === (open?.version ?? diskVersion) &&
			(open === undefined || cached.sourceText === open.text)
		)
	}

	// Whether a graph reaching this file judges it. A file writing neither
	// Module section is analysed alone, whatever graph reaches it.
	function isModuleFile(filePath: string): boolean {
		let entry = fileOf(filePath)

		return entry !== null && isModule(entry.program, filePath)
	}

	function cachedAnalysis(entry: FileEntry): Analysis {
		return {
			program: entry.program,
			enrichedProgram: entry.enriched,
			diagnostics: entry.diagnostics ?? [],
			dependencies: entry.dependencyDiagnostics ?? new Map(),
			imported: entry.module?.imported ?? null,
		}
	}

	// The graph reads the entry's own text, so both parses see the same bytes.
	// False when cancelled, and then nothing was written.
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
		// Asking for a file the graph does not hold would collect nobody's.
		let annotated =
			annotationsFor !== undefined && graph.modules.has(annotationsFor)
				? annotationsFor
				: entryPath
		let linked = linkModuleGraph(graph, {
			annotationsFor: annotated,
			tests: options.tests,
		})
		let analyses = analyseLinkedGraph(linked, { cancellation })

		if (analyses === null) {
			return false
		}

		// One view per Module, so a probe needs no graph of its own.
		let views = moduleViewsOf(linked)

		// The graph's edges, plus the lexical resolutions, which also name
		// files that do not exist yet and must invalidate their importers.
		for (let [modulePath, module] of linked.modules) {
			recordEdges(modulePath, [
				...module.module.dependencies,
				...dependenciesOf(modulePath).values(),
			])
		}

		for (let [modulePath, module] of linked.modules) {
			let moduleEntry = fileOf(modulePath)

			// The text moved since the graph read it.
			if (
				moduleEntry === null ||
				moduleEntry.sourceText !== module.module.sourceText
			) {
				continue
			}

			// A file writing neither Module section keeps its own analysis.
			if (!isModule(moduleEntry.program, modulePath)) {
				continue
			}

			// The first graph to reach a Module keeps its typed Program, so its
			// identity stays stable. See "Analysing a graph" in DEVELOPMENT.md.
			if (!moduleEntry.enrichmentAttempted) {
				moduleEntry.enriched = module.program
				moduleEntry.enrichmentAttempted = true
				moduleEntry.module = views.get(modulePath) ?? null
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

		// The graph could not read the entry as a Module; its Diagnostics say so.
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
			{
				annotations: true,
				tests: options.tests,
				source: entry.sourceText,
			},
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

	// The Diagnostics of what this Module reaches, not of the whole graph. The
	// Server publishes and owns these, so no unreached file may be among them.
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

	// This file's annotations, resolved against its graph so imported names do
	// not read as `Error`.
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

	// What a request about a document needs: the parse, the typed Program, the
	// rename index and the Module view. The index is cached, since building one
	// rebuilds the builtin top level Scope.
	function documentOf(
		filePath: string,
		options: { cancellation?: Cancellation } = {},
	): DocumentAnalysis | null {
		let analysis = analysisOf(filePath, options)
		let entry = files.get(filePath)

		// Null when there is nothing here or the work was cancelled. Half an
		// analysis would call good names `Error`.
		if (analysis === null || analysis.program === null) {
			return null
		}

		return {
			program: analysis.program,
			enrichedProgram: analysis.enrichedProgram,
			index: indexOf(filePath),
			module: entry?.module ?? null,
		}
	}

	function programOf(filePath: string): parser.Program | null {
		return fileOf(filePath)?.program ?? null
	}

	function sourceOf(filePath: string): string | null {
		return fileOf(filePath)?.sourceText ?? null
	}

	// The files both Module sections name, since a re-export is a dependency
	// too, keyed by the specifier as written.
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

	// What a Module publishes, read off the parses. A re-export's kind comes
	// from the end of its chain, which stops at a Module already seen.
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

	// Every Module publishing this name, each offered as an import of an
	// unknown name.
	function exportersOf(name: string): Array<WorkspaceExport> {
		return [...knownFiles()].flatMap((candidate) =>
			exportsOf(candidate).filter((exported) => exported.name === name),
		)
	}

	// Every name this file could import and has not, read off the parses. A
	// name it already binds is never offered: the Compiler refuses the collision.
	function offersFor(filePath: string): Array<WorkspaceOffer> {
		let program = programOf(filePath)

		if (program === null) {
			return []
		}

		let taken = namesBoundBy(program)

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

	// Every other Module as this file would write its specifier, sorted.
	function specifiersFor(filePath: string): Array<string> {
		return [...knownFiles()]
			.filter((candidate) => candidate !== filePath)
			.map((candidate) => relativeSpecifier(filePath, candidate))
			.sort()
	}

	// The Namespace Types behind the offers, so a Method Completion can offer
	// to import its Namespace. Only Modules exporting a Namespace are enriched.
	function namespaceOffersFor(
		filePath: string,
	): Array<{ offer: WorkspaceOffer; namespace: common.NamespaceType }> {
		let found: Array<{
			offer: WorkspaceOffer
			namespace: common.NamespaceType
		}> = []

		for (let offer of offersFor(filePath)) {
			// The declaring Module is enriched, since a facade has no Namespace
			// of its own.
			let program =
				offer.kind === "namespace" ? enrichedOf(offer.declaredIn) : null

			if (program === null) {
				continue
			}

			// The implementation alone: an export can only name what it
			// declares, never a Namespace of the `tests` section.
			for (let node of program.implementation.nodes) {
				if (
					node.nodeType === "NamespaceDefinitionStatement" &&
					isSamePosition(node.name.position, offer.position)
				) {
					found.push({
						offer,
						// Under its published name, which the import would bind.
						namespace: { ...node.type, name: offer.name },
					})
				}
			}
		}

		return found
	}

	// The document symbols of every file, open or not, read off the parses
	// with the outline's own walk.
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
				// The export entries would repeat the declarations' names.
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

	// `localOnly` joins this file alone, for Document Highlight. See "The
	// symbol join" in DEVELOPMENT.md.
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
		// Asked by Position too: in `PI as Pi` and `squared as square`, one
		// side is in no Scope and still renameable.
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

		// Nothing crossed a Module boundary, so the file's answer stands.
		return {
			name: occurrence.name,
			kind: occurrence.declaration.kind,
			labelled: occurrence.declaration.labelled,
			filePath,
			definition: occurrence.declaration.definition,
			declaredIn: [filePath],
			answersBuiltin: occurrence.declaration.answersBuiltin,
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
		isExcluded,
		configurationFor,
		configurationProblems,
		forgetConfiguration,
		changed,
		removed,
		knownFiles,
		programOf,
		sourceOf,
		indexOf,
		analysisOf,
		isAnalysed,
		isModuleFile,
		documentOf,
		enrichedOf,
		annotationsOf,
		dependenciesOf,
		componentOf,
		dependentsOf,
		roots,
		rootsReaching,
		exportsOf,
		exportersOf,
		offersFor,
		namespaceOffersFor,
		specifiersFor,
		symbols,
		symbolAt,
		host,
	}
}

/*******************/
/* The symbol join */
/*******************/

// One end of a tie between files: a `decl:` or an `export:` site. See "The
// symbol join" in DEVELOPMENT.md.
type SiteData = {
	name: string
	kind: DeclarationKind | null
	labelled?: boolean
	filePath: string | null
	definition: common.Position | null
	answersBuiltin?: boolean
	// As on a `Declaration`.
	inNamedType?: true
	occurrences: Array<WorkspaceOccurrence>
}

// What `protocolMemberKey` answers for a standard library Protocol's
// member. That member has no site to join, so a Method answering it is marked
// instead.
const builtinMember = Symbol("builtinMember")

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
	// An aliased entry's site to the site it stands for. The two rename apart,
	// so only this map follows one to the other.
	let aliases = new Map<string, string>()

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

	// Every Declaration first, so each entry finds both of its ends.
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
					labelled: declaration.labelled,
					filePath,
					definition: declaration.definition,
					inNamedType: declaration.inNamedType,
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

	// A Record member joins the members of related shapes in every Module,
	// as it does within one.
	for (let [first, ...others] of relatedMemberKeys(
		component,
		indices,
		declarationKeys,
	)) {
		for (let key of others) {
			union(first, key)
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
				// One Identifier in both roles, merged so a rename writes it once.
				if (localKey !== undefined) {
					union(remote, localKey)
				}
			} else {
				addOccurrence(remote, {
					filePath,
					position: entry.name.position,
					access: "read",
				})

				if (localKey !== undefined) {
					aliases.set(localKey, remote)
				}
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
				// A Type and a Namespace of one name are one exported symbol.
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
				aliases.set(publicKey, target)
			}
		}
	}

	let topLevelBinding = (
		filePath: string,
		name: string,
		space: "values" | "types",
	): Declaration | undefined =>
		indices
			.get(filePath)
			?.scopes.find((entry) => entry.range === null)
			?.scope[space].get(name)

	// Each alias by the group it stands in. No later union reaches one of
	// these groups, since those merge Method Declarations alone.
	let aliasOfGroup = new Map<string, string>()

	for (let [from, to] of aliases) {
		if (!aliasOfGroup.has(find(from))) {
			aliasOfGroup.set(find(from), to)
		}
	}

	// Follows every alias, of imports and forwarding exports alike, to the
	// Module that declares the symbol.
	let followAliases = (key: string): string => {
		let current = key
		let seen = new Set<string>()

		while (!seen.has(find(current))) {
			seen.add(find(current))

			let next = aliasOfGroup.get(find(current))

			if (next === undefined) {
				break
			}

			current = next
		}

		return current
	}

	// The Declaration a name written in this file resolves to, wherever
	// that is declared, and under the name it is declared with there. A Protocol
	// is not a value, so its name binds among the Types.
	let declaringSiteOf = (
		filePath: string,
		name: string,
		space: "values" | "types",
	): { filePath: string; name: string } | null => {
		let binding = topLevelBinding(filePath, name, space)
		let localKey =
			binding === undefined || binding.builtin
				? undefined
				: declarationKeys.get(filePath)?.get(binding)

		if (localKey === undefined) {
			return null
		}

		let declaring = declaringSite(sites, find, followAliases(localKey))

		return declaring === null || declaring.filePath === null
			? null
			: { filePath: declaring.filePath, name: declaring.name }
	}

	// A Protocol's member, looked for through the Protocols it extends,
	// each resolved from the file whose `is` list names it.
	let protocolMemberKey = (
		filePath: string,
		protocolName: string,
		memberName: string,
		visited: Set<string> = new Set(),
	): string | typeof builtinMember | undefined => {
		if (
			topLevelBinding(filePath, protocolName, "types")?.builtin === true
		) {
			return isBuiltinProtocolMember(protocolName, memberName)
				? builtinMember
				: undefined
		}

		// A Protocol the file declares in a body is keyed by its
		// Position as well as its name, and no top level name binds it.
		let declaring =
			declaringSiteOf(filePath, protocolName, "types") ??
			(indices.get(filePath)?.protocolMembers.has(protocolName) === true
				? { filePath, name: protocolName }
				: null)

		if (declaring === null) {
			return undefined
		}

		let seen = `${declaring.filePath}:${declaring.name}`

		if (visited.has(seen)) {
			return undefined
		}

		visited.add(seen)

		let declaringIndex = indices.get(declaring.filePath)
		let member = declaringIndex?.protocolMembers
			.get(declaring.name)
			?.get(memberName)

		if (member !== undefined) {
			return declarationKeys.get(declaring.filePath)?.get(member)
		}

		for (let extended of declaringIndex?.protocolExtensions.get(
			declaring.name,
		) ?? []) {
			let key = protocolMemberKey(
				declaring.filePath,
				extended,
				memberName,
				visited,
			)

			if (key !== undefined) {
				return key
			}
		}

		return undefined
	}

	// The same for a Protocol the typed tree names by identity, which
	// names the Module that declares it. A bare identity is a standard library
	// Protocol's, and no rename reaches its members.
	let identityMemberKey = (
		identity: string,
		memberName: string,
	): string | typeof builtinMember | undefined => {
		let separator = identity.lastIndexOf("#")

		if (separator === -1) {
			return undefined
		}

		let modulePath = identity.slice(0, separator)
		let name = protocolIdentityKey(identity)
		let declaringIndex = indices.get(modulePath)
		let member = declaringIndex?.protocolMembers.get(name)?.get(memberName)

		if (member !== undefined) {
			return declarationKeys.get(modulePath)?.get(member)
		}

		for (let extended of declaringIndex?.protocolExtensions.get(name) ??
			[]) {
			let key = protocolMemberKey(modulePath, extended, memberName)

			if (key !== undefined) {
				return key
			}
		}

		return undefined
	}

	// Last, since an imported member is found through its joined entry.
	for (let filePath of component) {
		let index = indices.get(filePath)

		if (index === undefined) {
			continue
		}

		for (let reference of index.externalMembers) {
			let memberKey: string | undefined

			if (reference.protocol === true) {
				let key = identityMemberKey(
					reference.namespaceName,
					reference.memberName,
				)

				memberKey = key === builtinMember ? undefined : key
			} else {
				let declaring = declaringSiteOf(
					filePath,
					reference.namespaceName,
					"values",
				)
				let member =
					declaring === null
						? undefined
						: indices
								.get(declaring.filePath)
								?.namespaceMembers.get(declaring.name)
								?.get(reference.memberName)

				memberKey =
					declaring === null || member === undefined
						? undefined
						: declarationKeys.get(declaring.filePath)?.get(member)
			}

			if (memberKey === undefined) {
				continue
			}

			addOccurrence(memberKey, {
				filePath,
				position: reference.position,
				access: "read",
			})
		}

		// A conformer's Method and the member it answers are one rename,
		// whichever Modules the Namespace, the Protocol and its extensions are
		// written in.
		for (let link of index.conformances) {
			let ownKey = declarationKeys.get(filePath)?.get(link.declaration)
			let memberKey = protocolMemberKey(
				filePath,
				link.protocolName,
				link.memberName,
			)

			if (ownKey === undefined || memberKey === undefined) {
				continue
			}

			if (memberKey === builtinMember) {
				sites.get(ownKey)!.answersBuiltin = true
			} else {
				union(memberKey, ownKey)
			}
		}
	}

	let symbolOf = (key: string): WorkspaceSymbol | null => {
		let root = find(key)
		let members = [...sites].filter(([siteKey]) => find(siteKey) === root)
		let own = sites.get(key)
		// A declaration answers for itself even where it renames with
		// others: a conformer's Method is still where a call bound to it leads.
		// A Record member leads to a named Type declaring it, from any file.
		let anchor =
			(own?.inNamedType === true ? own : null) ??
			members.find(([, site]) => site.inNamedType === true)?.[1] ??
			(own !== undefined && isDeclaration(own) ? own : null) ??
			declaringSite(sites, find, key) ??
			own ??
			null

		if (anchor === null) {
			return null
		}

		return {
			name: anchor.name,
			kind: anchor.kind ?? "constant",
			labelled: anchor.labelled,
			filePath: anchor.filePath,
			definition: anchor.definition,
			declaredIn: [
				...new Set(
					members.flatMap(([, site]) =>
						site.filePath !== null && isDeclaration(site)
							? [site.filePath]
							: [],
					),
				),
			],
			answersBuiltin: members.some(
				([, site]) => site.answersBuiltin === true,
			),
			occurrences: members.flatMap(([, site]) => site.occurrences),
		}
	}

	return {
		symbolFor(filePath, declaration) {
			let key = declarationKeys.get(filePath)?.get(declaration)

			return key === undefined ? null : symbolOf(key)
		},

		// Hit-tested as `occurrenceAt` does.
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

// The join keys of the Record member Declarations one rename reaches across
// the component's files.
function relatedMemberKeys(
	component: Array<string>,
	indices: Map<string, ProgramIndex>,
	declarationKeys: Map<string, Map<Declaration, string>>,
): Array<Array<string>> {
	let groups: Array<ShapeGroup<string>> = []

	for (let filePath of component) {
		let keys = declarationKeys.get(filePath)

		for (let group of indices.get(filePath)?.recordMembers ?? []) {
			let members = new Map<string, string>()

			for (let [name, declaration] of group.members) {
				let key = keys?.get(declaration)

				if (key !== undefined) {
					members.set(name, key)
				}
			}

			groups.push({ shapes: group.shapes, members })
		}
	}

	return relatedMembers(groups)
}

// Every Declaration an export entry without `from` names, in both symbol
// spaces of the top level Scope.
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

// Written in a file, as opposed to a name an entry carries or publishes.
function isDeclaration(site: SiteData): boolean {
	return (
		site.definition !== null &&
		site.filePath !== null &&
		site.kind !== null &&
		site.kind !== "import"
	)
}

// The site of a joined symbol where it is written, preferred over an import
// binding.
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

// An empty Program for a file the Parser threw on, with neither Module
// section.
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
		tests: null,
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

// A subsequence match, case-insensitive. The client filters and ranks the
// list itself.
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

// The kind of each top level declaration, off the Parser AST, for the export
// surface. The tests section is private to its block, so it is left out.
function topLevelDeclarations(
	program: parser.Program,
): Map<string, { kind: DeclarationKind; position: common.Position }> {
	let declarations = new Map<
		string,
		{ kind: DeclarationKind; position: common.Position }
	>()
	// The first declaration of a name wins; the Enricher rejects a second.
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

// The names a file's top level binds by declaration or import. The Compiler
// refuses an import entry of one of them.
export function namesBoundBy(program: parser.Program): Set<string> {
	return new Set<string>([
		...topLevelDeclarations(program).keys(),
		...(program.imports?.entries ?? []).map(
			(entry) => (entry.alias ?? entry.name).content,
		),
	])
}

// The discovery walk. A symlinked directory is not descended into, so a link
// up the tree cannot loop. The exclusions are read per directory, so a nested
// `essence.json` governs its own subtree.
function collectEssenceFiles(
	directory: string,
	found: Set<string>,
	configurations: ConfigurationCache,
): void {
	let exclude = configurations.forDirectory(directory).exclude
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
			if (
				!skippedDirectories.has(entry.name) &&
				!isExcludedPath(entryPath, exclude)
			) {
				collectEssenceFiles(entryPath, found, configurations)
			}

			continue
		}

		if (!entry.name.endsWith(".es") || isExcludedPath(entryPath, exclude)) {
			continue
		}

		let filePath = canonicalPath(entryPath)

		// A standard library source declares the builtins and is no Module, so
		// it belongs to no workspace.
		if (!isStdlibDocument(filePath)) {
			found.add(filePath)
		}
	}
}
