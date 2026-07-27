import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import {
	canonicalPath,
	enrichDocument,
	isStdlibDocument,
	parseDocument,
} from "@essence/compiler/documents"
import {
	linkModuleGraph,
	loadModuleGraph,
	type ModuleHost,
	resolveSpecifier,
} from "@essence/compiler/modules"
import type { common, parser } from "@essence/interfaces"

import { relativeSpecifier } from "./autoImport"
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

type FileEntry = {
	filePath: string
	sourceText: string
	// NOTE: What the cache was built from — an open document's version, or the
	// sentinel for a file read off disk, which the watcher invalidates by hand.
	// An Editor may report the same version for a document it re-opened, so the
	// text is compared as well.
	version: number
	program: parser.Program
	index: ProgramIndex | null
	enriched: common.typed.Program | null
	// NOTE: Enrichment can legitimately answer with nothing — a Compiler bug
	// must not take the Server down — so "was it tried" is its own question.
	enrichmentAttempted: boolean
}

const diskVersion = -1

export function createWorkspace(options: WorkspaceOptions = {}) {
	let folders: Array<string> = []
	let files = new Map<string, FileEntry>()
	let discovered: Set<string> | null = null
	let openDocument = options.openDocument ?? (() => undefined)

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
	function invalidateEnrichment(filePath: string): void {
		for (let affected of componentOf(filePath)) {
			let entry = files.get(affected)

			if (entry === undefined) {
				continue
			}

			entry.index = null
			entry.enriched = null
			entry.enrichmentAttempted = false
		}
	}

	function setFolders(nextFolders: Array<string>): void {
		folders = nextFolders.map((folder) => canonicalPath(folder))
		discovered = null
		files.clear()
	}

	function changed(filePath: string): void {
		invalidate(filePath)
		invalidateEnrichment(filePath)

		if (isInWorkspace(filePath)) {
			discovered?.add(filePath)
		}
	}

	function removed(filePath: string): void {
		invalidateEnrichment(filePath)
		invalidate(filePath)
		discovered?.delete(filePath)
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
		}

		return discovered
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

		let entry: FileEntry = {
			filePath,
			sourceText,
			version,
			program: parseDocument(sourceText, filePath).program,
			index: null,
			enriched: null,
			enrichmentAttempted: false,
		}

		files.set(filePath, entry)

		return entry
	}

	// NOTE: A Module is enriched against the whole graph it reaches, because
	// what an entry brings in is only known there — enriched on its own, every
	// imported name resolves to nothing and every Method dispatching through an
	// imported Namespace stays unbound, which is exactly the binding the join
	// below rides on. The other Modules of that graph are enriched by the same
	// pass, so they are kept: the next request for one of them costs nothing.
	function enrichedOf(filePath: string): common.typed.Program | null {
		let entry = fileOf(filePath)

		if (entry === null) {
			return null
		}

		if (entry.enrichmentAttempted) {
			return entry.enriched
		}

		entry.enrichmentAttempted = true

		try {
			if (
				entry.program.imports === null &&
				entry.program.exports === null
			) {
				entry.enriched = enrichDocument(entry.program, filePath).program

				return entry.enriched
			}

			let linked = linkModuleGraph(loadModuleGraph(filePath, host))

			for (let [modulePath, module] of linked.modules) {
				let moduleEntry = fileOf(modulePath)

				if (
					moduleEntry === null ||
					moduleEntry.sourceText !== module.module.sourceText
				) {
					continue
				}

				moduleEntry.enriched = module.program
				moduleEntry.enrichmentAttempted = true
			}
		} catch {}

		return entry.enriched
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
		let program = programOf(filePath)
		let resolutions = new Map<string, string>()

		if (program === null) {
			return resolutions
		}

		let sources = [
			...(program.imports?.entries ?? []).map((entry) => entry.source),
			...(program.exports?.entries ?? []).flatMap((entry) =>
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

		return resolutions
	}

	// NOTE: Every file that could possibly hold an occurrence of a symbol
	// written in this one, and no others. A name crosses a Module boundary only
	// through an entry, so anything sharing a symbol with this file is connected
	// to it by entries — walked in BOTH directions, since a dependency holds the
	// declaration and a dependent holds the uses. Read off the parses alone;
	// only the component this answers with is ever enriched.
	function componentOf(filePath: string): Array<string> {
		let component = new Set<string>([filePath])
		let neighbours = new Map<string, Set<string>>()
		let add = (from: string, to: string) => {
			let known = neighbours.get(from)

			if (known === undefined) {
				known = new Set()
				neighbours.set(from, known)
			}

			known.add(to)
		}

		for (let candidate of [...knownFiles(), filePath]) {
			for (let dependency of dependenciesOf(candidate).values()) {
				add(candidate, dependency)
				add(dependency, candidate)
			}
		}

		let pending = [filePath]

		while (pending.length > 0) {
			let current = pending.shift()!

			for (let neighbour of neighbours.get(current) ?? []) {
				if (component.has(neighbour) || fileOf(neighbour) === null) {
					continue
				}

				component.add(neighbour)
				pending.push(neighbour)
			}
		}

		return [...component]
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
			occurrences: occurrence.declaration.occurrences.map((position) => ({
				filePath,
				position,
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
		enrichedOf,
		dependenciesOf,
		componentOf,
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
				let local = occurrenceAt(index.index, cursorOf(entry.name))

				target =
					local === null ? undefined : keys.get(local.declaration)
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
			case "ConstantDeclarationStatement":
				remember(node.name, "constant")
				break
			case "VariableDeclarationStatement":
				remember(node.name, "variable")
				break
			case "FunctionStatement":
			case "NativeFunctionStatement":
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
