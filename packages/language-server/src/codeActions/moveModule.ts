import * as path from "node:path"

import {
	derivedEnumerableNamespaceName,
	derivedEquatableNamespaceName,
	derivedPrintableNamespaceName,
} from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import {
	type ImportEdit,
	type ImportEntry,
	importBlock,
	insertExportEdit,
	insertImportEdit,
	insertImportsEdits,
	relativeSpecifier,
	spellName,
} from "../autoImport"
import { isSamePosition } from "../positions"
import {
	type Declaration,
	type DeclarationKind,
	type ProgramIndex,
	type RenameIndex,
	topLevelNames,
} from "../rename"
import type { ImportContext } from "./fixes"
import {
	closesItsLine,
	containsRange,
	insertBeforeClosingBrace,
	lineAt,
	opensItsLine,
	overlaps,
	removeLinesEdit,
	removeMemberEdit,
	sliceOf,
} from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"
import { walk } from "./lookups"

// Moves a top-level Declaration, as written, to another Module, and fixes
// every entry that named it. See "Moving a Declaration" in DEVELOPMENT.md.

// A top-level Declaration of one name. A `variable` cannot be exported, and a
// Pattern declares several names, so neither is movable.
type Declared = {
	name: parser.IdentifierNode
	documentation: common.Documentation | null
}

// A Module the Declaration could move to, and what it holds.
type Target = {
	filePath: string
	// Null for a Module this action would create.
	sourceText: string | null
	program: parser.Program | null
}

// One entry of another Module that named the Declaration, with its group.
type NamedEntry =
	| {
			section: "imports"
			group: parser.ImportGroupNode
			entry: parser.ImportNode
	  }
	| {
			section: "exports"
			group: parser.ExportGroupNode
			entry: parser.ExportNode
	  }

type Naming = {
	filePath: string
	sourceText: string
	program: parser.Program
	entries: Array<NamedEntry>
}

// An import entry of this Module the Statement reads, and the file it names.
type ReadImport = {
	entry: parser.ImportNode
	filePath: string
	// Whether the Statement writes the entry's local name, rather than only
	// dispatching through what it binds.
	named: boolean
	// Whether it binds a Namespace, a Protocol or a Choice, which a second
	// entry under another name would make ambiguous.
	implicit: boolean
	// Whether this Module may still use it once the Statement is gone.
	keptHere: boolean
}

// A use the typed tree records without a written name. A Namespace a call
// dispatches through is named by the name it is reachable under. A Protocol or
// a Choice that answers a provided Method or a bare Case is named by identity.
type ImplicitUse = { position: common.Position } & RecordedUse

type RecordedUse = {
	local: string | null
	identity: string | null
	// Set where derived printing answers the call, which also needs the
	// Namespace that states the Choice `is Printable`.
	conformers?: true
}

// Everything about the move that does not depend on its destination.
type Move = {
	context: ImportContext
	lines: Array<string>
	name: string
	// The Statement with its `§§` block.
	span: common.Position
	text: string
	// The names of this Module the Statement reads, which the destination
	// imports by the name this Module publishes each under.
	needed: Array<{ name: string; local: string }>
	// The destination imports these from the Modules they name.
	imports: Array<ReadImport>
	removal: CodeActionEdit
	// The edit that stops this Module publishing it, or null where it never
	// did.
	unpublish: CodeActionEdit | null
	usedHere: boolean
	namings: Array<Naming>
}

const implementationKeyword = "implementation"

export function moveActions(
	context: ImportContext | null,
	enrichedProgram: common.typed.Program | null,
	lines: Array<string>,
	range: common.Position,
	indexed: () => ProgramIndex,
): Array<CodeActionEntry> {
	// Without the typed tree, what a call dispatches through is unknown.
	if (context === null || enrichedProgram === null) {
		return []
	}

	let move = movableAt(context, enrichedProgram, lines, range, indexed)

	if (move === null) {
		return []
	}

	return targetsFor(move).flatMap((target) => {
		let entry = moveEntry(move, target)

		return entry === null ? [] : [entry]
	})
}

// The Declaration whose name the range touches, so a cursor in a body does
// not offer it.
function movableAt(
	context: ImportContext,
	enrichedProgram: common.typed.Program,
	lines: Array<string>,
	range: common.Position,
	indexed: () => ProgramIndex,
): Move | null {
	let program = context.program
	let block = program.implementation.position

	// Only an ordinary Module. A `declarations { … }` Program is the standard
	// library's shared space, and a tests-only file's implementation section
	// spans its tests.
	if (program.kind !== "implementation") {
		return null
	}

	for (let statement of program.implementation.nodes) {
		let declared = declarationOf(statement)

		if (declared === null || !overlaps(declared.name.position, range)) {
			continue
		}

		let span = {
			start: (declared.documentation?.position ?? statement.position)
				.start,
			end: statement.position.end,
		}

		// Whole lines move, so the Statement must not share a line with the
		// block's braces.
		if (
			span.start.line <= block.start.line ||
			span.end.line >= block.end.line
		) {
			return null
		}

		// The Workspace's cached index, since indexing costs what a Rename
		// does.
		let { index } = indexed()
		let uses = implicitUses(enrichedProgram)
		let reads = readsMovableNames(context, index, uses, span)

		if (reads === null) {
			return null
		}

		let imports = importsRead(context, index, uses, span, reads.imports)

		if (imports === null) {
			return null
		}

		let name = declared.name.content
		let exports = program.exports
		let exportEntry =
			exports === null
				? null
				: (exports.entries.find(
						(entry) =>
							entry.source === null &&
							entry.name.content === name,
					) ?? null)

		return {
			context,
			lines,
			name,
			needed: reads.needed,
			imports,
			span,
			text: sliceOf(lines, {
				start: { line: span.start.line, column: 1 },
				end: span.end,
			}),
			removal: {
				range: removalRange(lines, span, block),
				newText: "",
			},
			unpublish:
				exports === null || exportEntry === null
					? null
					: unpublishEdit(lines, exports, exportEntry),
			usedHere: usedOutside(index, declared.name.position, {
				span,
				exportEntry,
			}),
			namings: namingsOf(context, name),
		}
	}

	return null
}

function declarationOf(node: parser.ImplementationNode): Declared | null {
	switch (node.nodeType) {
		case "FunctionStatement":
			// The Parser puts a Function Statement's `§§` block on its
			// literal.
			return {
				name: node.name,
				documentation: node.value.documentation,
			}
		case "ConstantDeclarationStatement":
			return node.name.nodeType === "Pattern"
				? null
				: { name: node.name, documentation: node.documentation }
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "ProtocolDeclarationStatement":
		case "NamespaceDefinitionStatement":
			return { name: node.name, documentation: node.documentation }
		default:
			return null
	}
}

// Whether every name the Statement reads means the same in its destination.
// Null refuses the move; otherwise the published names and the imports it
// reads, which the destination imports. See "Moving a Declaration" in
// DEVELOPMENT.md.
function readsMovableNames(
	context: ImportContext,
	index: RenameIndex,
	uses: Array<ImplicitUse>,
	span: common.Position,
): {
	needed: Array<{ name: string; local: string }>
	imports: Array<Declaration>
} | null {
	let program = context.program
	// By local name, the name each is published under. An entry publishing it
	// under its own name wins.
	let published = new Map<string, string>()

	for (let entry of program.exports?.entries ?? []) {
		if (entry.source === null && entry.alias === null) {
			published.set(entry.name.content, entry.name.content)
		} else if (
			entry.source === null &&
			!published.has(entry.name.content)
		) {
			published.set(
				entry.name.content,
				(entry.alias ?? entry.name).content,
			)
		}
	}

	let needed = new Set<string>()
	let imports = new Set<Declaration>()

	for (let occurrence of index) {
		let declaration = occurrence.declaration

		if (!containsRange(span, occurrence.position)) {
			continue
		}

		// A Method is reached through a Type, but its Namespace must still be
		// in reach, or `n::doubled()` becomes `unknown-method` elsewhere.
		if (
			declaration.kind === "method" ||
			declaration.kind === "staticMethod"
		) {
			let reached = namespaceReach(program, published, span, declaration)

			if (reached === null) {
				return null
			}

			if (reached.imported !== null) {
				needed.add(reached.imported)
			}

			continue
		}

		if (!isLexical(declaration.kind)) {
			continue
		}

		if (declaration.builtin) {
			continue
		}

		if (declaration.kind === "import") {
			imports.add(declaration)

			continue
		}

		if (declaration.definition === null) {
			return null
		}

		if (containsRange(span, declaration.definition)) {
			continue
		}

		if (!published.has(occurrence.name)) {
			return null
		}

		needed.add(occurrence.name)
	}

	// A provided Method or a bare Case reaches a Protocol or a Choice of this
	// file without naming it.
	for (let use of uses) {
		let owner = use.identity === null ? null : ownerOf(use.identity)

		if (
			owner === null ||
			owner.filePath !== context.filePath ||
			!containsRange(span, use.position)
		) {
			continue
		}

		let declared = program.implementation.nodes.find(
			(node) =>
				(node.nodeType === "ProtocolDeclarationStatement" ||
					node.nodeType === "ChoiceDeclarationStatement") &&
				node.name.content === owner.name,
		)

		if (declared !== undefined && containsRange(span, declared.position)) {
			continue
		}

		if (!published.has(owner.name)) {
			return null
		}

		needed.add(owner.name)
	}

	return {
		needed: [...needed].map((local) => ({
			name: published.get(local) ?? local,
			local,
		})),
		imports: [...imports],
	}
}

// The file and name an identity is made of, or null for one the standard
// library or a nested Protocol holds, which no entry names.
function ownerOf(identity: string): { filePath: string; name: string } | null {
	let at = identity.lastIndexOf("#")
	let name = identity.slice(at + 1)

	if (at === -1 || name.includes("@")) {
		return null
	}

	return { filePath: identity.slice(0, at), name }
}

// See `ImplicitUse`. A Type is not entered: a Namespace's Type lists every
// Method, and the Protocols those provide are no use of anything.
function implicitUses(program: common.typed.Program): Array<ImplicitUse> {
	let uses: Array<ImplicitUse> = []

	let visit = (node: unknown, position: common.Position | null): void => {
		if (Array.isArray(node)) {
			for (let item of node) {
				visit(item, position)
			}

			return
		}

		if (node === null || typeof node !== "object") {
			return
		}

		let record = node as Record<string, unknown>

		if (typeof record["type"] === "string" && !("nodeType" in record)) {
			return
		}

		let here = isPosition(record["position"])
			? record["position"]
			: position

		if (here !== null) {
			for (let use of usesRecordedOn(record)) {
				uses.push({ position: here, ...use })
			}
		}

		for (let value of Object.values(record)) {
			visit(value, here)
		}
	}

	visit(program, null)

	return uses
}

// The fields the linker counts as uses of an import. See "Unused imports" in
// packages/compiler/src/modules/DEVELOPMENT.md.
function usesRecordedOn(record: Record<string, unknown>): Array<RecordedUse> {
	let uses: Array<RecordedUse> = []
	let namespace = record["namespace"] as { name?: unknown } | undefined
	let type = record["type"] as
		| { type?: unknown; choice?: unknown }
		| undefined

	if (
		record["nodeType"] === "MethodInvocation" &&
		typeof namespace?.name === "string"
	) {
		uses.push({ local: namespace.name, identity: null })

		let member = (record["member"] as { name: string }).name

		// A Protocol's body answers the call through the receiver's own
		// witness, which the call passes as `Self`.
		for (let conformance of record[
			"conformances"
		] as Array<common.Conformance>) {
			let provider =
				conformance.genericName === "Self" &&
				conformance.source.kind === "namespace"
					? conformance.source.providedMethods?.[member]
					: undefined

			if (provider !== undefined) {
				uses.push({ local: null, identity: provider })
			}
		}

		uses.push(...derivedUses(namespace.name, record["base"]))
	}

	if (typeof record["namespaceName"] === "string") {
		uses.push({ local: record["namespaceName"], identity: null })
		uses.push(
			...derivedUses(record["namespaceName"], {
				type: record["memberType"],
			}),
		)
	}

	if (record["kind"] === "namespace" && typeof record["name"] === "string") {
		uses.push({ local: record["name"], identity: null })
	}

	if (typeof record["providedBy"] === "string") {
		uses.push({ local: null, identity: record["providedBy"] })
	}

	if (
		record["nodeType"] === "CaseValue" &&
		record["choice"] === null &&
		type?.type === "Case" &&
		typeof type.choice === "string"
	) {
		uses.push({ local: null, identity: type.choice })
	}

	// A Match Handler, whose Case Matcher narrows `@` to the declared Choice
	// where that Choice is in scope.
	let matcher = record["matcher"] as
		| { type?: unknown; choice?: unknown }
		| undefined

	if (matcher?.type === "Case" && typeof matcher.choice === "string") {
		uses.push({ local: null, identity: matcher.choice })
	}

	return uses
}

// A Choice's derived Methods answer through a Namespace no source names, and
// need the Choice in scope. The receiver's Type says which Choice it is.
const derivedNamespaces = new Set([
	derivedEnumerableNamespaceName,
	derivedEquatableNamespaceName,
	derivedPrintableNamespaceName,
])

function derivedUses(
	namespaceName: string,
	receiver: unknown,
): Array<RecordedUse> {
	if (!derivedNamespaces.has(namespaceName)) {
		return []
	}

	let type = (receiver as { type?: common.Type } | undefined)?.type
	let members = type?.type === "UnionType" ? type.types : [type]
	let choices = new Set(
		members.map((member) =>
			member !== undefined && "type" in member && member.type === "Case"
				? member.choice
				: null,
		),
	)

	let conformers =
		namespaceName === derivedPrintableNamespaceName
			? { conformers: true as const }
			: {}

	return [...choices].flatMap((choice) =>
		choice === null
			? []
			: [{ local: null, identity: choice, ...conformers }],
	)
}

function isPosition(value: unknown): value is common.Position {
	return (
		typeof value === "object" &&
		value !== null &&
		"start" in value &&
		"end" in value
	)
}

// The import entries the Statement reads, by name or by an implicit use, each
// with the file it names. Null refuses the move, where an entry names no file.
function importsRead(
	context: ImportContext,
	index: RenameIndex,
	uses: Array<ImplicitUse>,
	span: common.Position,
	declarations: Array<Declaration>,
): Array<ReadImport> | null {
	let workspace = context.workspace
	let resolutions = workspace.dependenciesOf(context.filePath)
	let read: Array<ReadImport> = []

	for (let entry of context.program.imports?.entries ?? []) {
		let local = entry.alias ?? entry.name
		let filePath = resolutions.get(entry.source.path) ?? null
		let binding =
			filePath === null
				? null
				: bindingOf(workspace, filePath, entry.name.content)
		let usesEntry = (use: ImplicitUse): boolean =>
			use.local === local.content ||
			(use.identity !== null &&
				binding !== null &&
				(binding.identities.has(use.identity) ||
					(use.conformers === true &&
						binding.targets.has(use.identity))))
		let named = declarations.some(
			(candidate) =>
				candidate.definition !== null &&
				isSamePosition(candidate.definition, local.position),
		)

		if (
			!named &&
			!uses.some(
				(use) => usesEntry(use) && containsRange(span, use.position),
			)
		) {
			continue
		}

		if (filePath === null || binding === null) {
			return null
		}

		read.push({
			entry,
			filePath,
			named,
			implicit: binding.implicit,
			keptHere:
				binding.reachedUnseen ||
				readOutside(index, local.position, span) ||
				uses.some(
					(use) =>
						usesEntry(use) && !containsRange(span, use.position),
				),
		})
	}

	return read
}

// What an entry binds, as the identities of the declarations behind its name,
// and of the Choices a Namespace it binds is written for. A Choice's derived
// Methods need the Choice in scope where the typed tree records no use of it,
// so `reachedUnseen` keeps its entry. So does an entry whose declaration is not
// found.
function bindingOf(
	workspace: ImportContext["workspace"],
	filePath: string,
	name: string,
): {
	identities: Set<string>
	targets: Set<string>
	implicit: boolean
	reachedUnseen: boolean
} {
	let identities = new Set<string>()
	let targets = new Set<string>()
	let implicit = false
	let reachedUnseen = false

	for (let exported of workspace.exportsOf(filePath)) {
		let text = workspace.sourceOf(exported.declaredIn)
		let program = workspace.programOf(exported.declaredIn)

		if (exported.name !== name || text === null || program === null) {
			continue
		}

		let declared = sliceOf(text.split("\n"), exported.position)

		identities.add(`${exported.declaredIn}#${declared}`)

		for (let node of program.implementation.nodes) {
			if (
				node.nodeType === "ChoiceDeclarationStatement" &&
				node.name.content === declared
			) {
				reachedUnseen = true
			}

			if (
				(node.nodeType === "ChoiceDeclarationStatement" ||
					node.nodeType === "ProtocolDeclarationStatement" ||
					node.nodeType === "NamespaceDefinitionStatement") &&
				node.name.content === declared
			) {
				implicit = true
			}

			if (
				node.nodeType === "NamespaceDefinitionStatement" &&
				node.name.content === declared &&
				node.targetType?.nodeType === "IdentifierTypeDeclaration"
			) {
				let target = choiceNamed(
					workspace,
					exported.declaredIn,
					program,
					node.targetType.type.content,
				)

				if (target !== null) {
					targets.add(target)
				}
			}
		}
	}

	return {
		identities,
		targets,
		implicit: implicit || identities.size === 0,
		reachedUnseen: reachedUnseen || identities.size === 0,
	}
}

// The identity of the Choice a name means in a Module, declared there or
// imported straight from its declaring Module.
function choiceNamed(
	workspace: ImportContext["workspace"],
	filePath: string,
	program: parser.Program,
	name: string,
): string | null {
	if (
		program.implementation.nodes.some(
			(node) =>
				node.nodeType === "ChoiceDeclarationStatement" &&
				node.name.content === name,
		)
	) {
		return `${filePath}#${name}`
	}

	let entry = program.imports?.entries.find(
		(candidate) => (candidate.alias ?? candidate.name).content === name,
	)
	let dependency =
		entry === undefined
			? undefined
			: workspace.dependenciesOf(filePath).get(entry.source.path)
	let declaring =
		dependency === undefined ? null : workspace.programOf(dependency)

	if (entry === undefined || dependency === undefined || declaring === null) {
		return null
	}

	return choiceNamed(workspace, dependency, declaring, entry.name.content)
}

// Whether anything outside the Statement reads the entry's local name.
function readOutside(
	index: RenameIndex,
	local: common.Position,
	span: common.Position,
): boolean {
	return index.some(
		(occurrence) =>
			occurrence.declaration.kind === "import" &&
			occurrence.declaration.definition !== null &&
			isSamePosition(occurrence.declaration.definition, local) &&
			!isSamePosition(occurrence.position, local) &&
			!containsRange(span, occurrence.position),
	)
}

// Whether the destination can see the Namespace a dispatch resolved to. Null
// refuses; otherwise the name to import, or null for a builtin Namespace, one
// the Statement carries, or one this file imports.
function namespaceReach(
	program: parser.Program,
	published: Map<string, string>,
	span: common.Position,
	declaration: Declaration,
): { imported: string | null } | null {
	if (declaration.builtin || declaration.definition === null) {
		return { imported: null }
	}

	let namespace = namespaceHolding(program, declaration.definition)

	if (namespace === null) {
		return { imported: null }
	}

	if (containsRange(span, namespace.position)) {
		return { imported: null }
	}

	return published.has(namespace.name.content)
		? { imported: namespace.name.content }
		: null
}

// The innermost Namespace around a Position, or null, as for an imported
// Method.
function namespaceHolding(
	program: parser.Program,
	position: common.Position,
): parser.NamespaceDefinitionStatementNode | null {
	let found: parser.NamespaceDefinitionStatementNode | null = null

	walk(program, (node) => {
		if (
			node.nodeType === "NamespaceDefinitionStatement" &&
			containsRange(node.position, position)
		) {
			found = node
		}
	})

	return found
}

// The kinds a Module binds by name. Members, properties, Methods and labels
// are reached through a Type instead.
function isLexical(kind: DeclarationKind): boolean {
	switch (kind) {
		case "member":
		case "property":
		case "method":
		case "staticMethod":
		case "label":
			return false
		default:
			return true
	}
}

// Whether anything outside the Statement, tests included, still reads the
// name, so this Module must import it back. Its export entry does not count.
function usedOutside(
	index: RenameIndex,
	definition: common.Position,
	moved: { span: common.Position; exportEntry: parser.ExportNode | null },
): boolean {
	let declaration = index.find((occurrence) =>
		isSamePosition(occurrence.position, definition),
	)?.declaration

	if (declaration === undefined) {
		return false
	}

	return index.some(
		(occurrence) =>
			occurrence.declaration === declaration &&
			!containsRange(moved.span, occurrence.position) &&
			(moved.exportEntry === null ||
				!isSamePosition(
					occurrence.position,
					moved.exportEntry.name.position,
				)),
	)
}

// The Statement's lines and the one blank line that would stop separating
// anything: a second in a row, or one against a brace.
function removalRange(
	lines: Array<string>,
	span: common.Position,
	block: common.Position,
): common.Position {
	let first = span.start.line
	let last = span.end.line
	let above = isBlank(lines, first - 1)

	if (above && (isBlank(lines, last + 1) || last + 1 >= block.end.line)) {
		first -= 1
	} else if (isBlank(lines, last + 1) && first - 1 <= block.start.line) {
		last += 1
	}

	return lineRange(lines, first, last)
}

// The name taken out of the export block, or the whole block, with its
// separating blank line, where it was the only name.
function unpublishEdit(
	lines: Array<string>,
	section: parser.ExportSectionNode,
	entry: parser.ExportNode,
): CodeActionEdit {
	if (section.entries.length > 1) {
		return removeMemberEdit(lines, entry.position)
	}

	return removeSectionEdit(lines, section.position)
}

// A whole Module block with the blank line separating it from the
// implementation.
function removeSectionEdit(
	lines: Array<string>,
	position: common.Position,
): CodeActionEdit {
	let first = position.start.line
	let last = position.end.line

	if (first > 1 && isBlank(lines, first - 1)) {
		first -= 1
	} else if (isBlank(lines, last + 1)) {
		last += 1
	}

	return { range: lineRange(lines, first, last), newText: "" }
}

// Takes entries out of a Module's import block and writes others into it, as
// edits that never overlap. See "Moving a Declaration" in DEVELOPMENT.md.
function rewriteImports(
	sourceText: string,
	program: parser.Program,
	removed: Array<parser.ImportNode>,
	added: Array<ImportEntry>,
): Array<ImportEdit> {
	let lines = sourceText.split("\n")
	let section = program.imports

	if (section === null || removed.length === 0) {
		return insertImportsEdits(sourceText, program, added)
	}

	if (
		added.length === 0 &&
		section.entries.every((entry) => removed.includes(entry))
	) {
		return [removeSectionEdit(lines, section.position)]
	}

	let edits: Array<ImportEdit> = []
	let left = added

	for (let group of section.groups) {
		let gone = group.entries.filter((entry) => removed.includes(entry))

		if (gone.length === 0) {
			continue
		}

		// `insertImportsEdits` writes into the first group of a Module.
		let receives =
			section.groups.find(
				(candidate) => candidate.source.path === group.source.path,
			) === group
		let incoming = receives
			? left.filter((entry) => entry.specifier === group.source.path)
			: []

		if (incoming.length > 0) {
			left = left.filter((entry) => !incoming.includes(entry))
			edits.push({
				range: (gone[0] as parser.ImportNode).position,
				newText: incoming.map(spellName).join(" "),
			})
			gone = gone.slice(1)
		} else if (gone.length === group.entries.length) {
			// A group sharing its line loses its span alone. A new group
			// written beside it then meets the deletion rather than landing
			// inside it.
			edits.push(
				opensItsLine(lines, group.position.start) &&
					closesItsLine(lines, group.position.end)
					? removeLinesEdit(lines, group.position)
					: { range: group.position, newText: "" },
			)

			continue
		}

		for (let entry of gone) {
			edits.push(removeLinesEdit(lines, entry.position))
		}
	}

	return [...edits, ...insertImportsEdits(sourceText, program, left)]
}

// Whole lines with the last one's line break, or, at the end of the file, the
// break before the first.
function lineRange(
	lines: Array<string>,
	first: number,
	last: number,
): common.Position {
	if (last >= lines.length) {
		let end = { line: last, column: lineAt(lines, last).length + 1 }

		// A deletion may not end past the document's end. Without a line
		// before, only the lines go.
		return first > 1
			? {
					start: {
						line: first - 1,
						column: lineAt(lines, first - 1).length + 1,
					},
					end,
				}
			: { start: { line: first, column: 1 }, end }
	}

	return {
		start: { line: first, column: 1 },
		end: { line: last + 1, column: 1 },
	}
}

function isBlank(lines: Array<string>, line: number): boolean {
	return (
		line >= 1 && line <= lines.length && lineAt(lines, line).trim() === ""
	)
}

// The other Modules in the document's directory, and a new one beside it.
function targetsFor(move: Move): Array<Target> {
	let workspace = move.context.workspace
	let directory = path.dirname(move.context.filePath)
	let targets: Array<Target> = []

	for (let candidate of [...workspace.knownFiles()].sort()) {
		if (
			candidate === move.context.filePath ||
			path.dirname(candidate) !== directory ||
			forwards(move, candidate)
		) {
			continue
		}

		let sourceText = workspace.sourceOf(candidate)
		let program = workspace.programOf(candidate)

		if (sourceText === null || program === null) {
			continue
		}

		targets.push({ filePath: candidate, sourceText, program })
	}

	// Named after the Declaration, and not offered where that file exists.
	let written = path.join(directory, `${move.name}.es`)

	if (workspace.sourceOf(written) === null) {
		targets.push({ filePath: written, sourceText: null, program: null })
	}

	return targets
}

// Whether a candidate forwards the name, which rules it out as a destination.
function forwards(move: Move, candidate: string): boolean {
	return move.namings.some(
		(naming) =>
			naming.filePath === candidate &&
			naming.entries.some((named) => named.section === "exports"),
	)
}

function moveEntry(move: Move, target: Target): CodeActionEntry | null {
	let specifier = relativeSpecifier(move.context.filePath, target.filePath)
	// The destination may already import the name, as when a helper moves
	// into its one reader; that import is dropped.
	let landingNamings = move.namings.filter(
		(naming) => naming.filePath === target.filePath,
	)
	let otherNamings = move.namings.filter(
		(naming) => naming.filePath !== target.filePath,
	)
	// The destination publishes it while anything still names it: another
	// Module, this file's body, or this file's export block.
	let publish =
		move.unpublish !== null || otherNamings.length > 0 || move.usedHere
	let imports = landingImports(move, target)

	if (
		imports === null ||
		importsEachOther(move, target, imports, landingNamings)
	) {
		return null
	}

	let landing = landingEdits(move, target, publish, imports, landingNamings)

	if (landing === null) {
		return null
	}

	let edits = [move.removal, ...landing]

	if (move.unpublish !== null) {
		edits.push(move.unpublish)
	}

	// This Module drops the imports only the Statement read, and imports the
	// Declaration back where it still reads it.
	edits.push(
		...rewriteImports(
			move.context.documentText,
			move.context.program,
			move.imports
				.filter((read) => !read.keptHere)
				.map((read) => read.entry),
			move.usedHere ? [{ name: move.name, alias: null, specifier }] : [],
		),
	)

	for (let naming of otherNamings) {
		edits.push(...retargetEdits(move, naming, target.filePath))
	}

	return {
		title: `Move '${move.name}' to ${
			target.sourceText === null ? "a new Module" : specifier
		}`,
		kind: "refactor.move",
		diagnosticCode: null,
		diagnosticPosition: null,
		// Where a Declaration belongs is the author's choice.
		isPreferred: false,
		edits,
	}
}

// Whether this Module and the destination would import each other. See
// "Moving a Declaration" in DEVELOPMENT.md.
function importsEachOther(
	move: Move,
	target: Target,
	imports: Array<ImportEntry>,
	landingNamings: Array<Naming>,
): boolean {
	let workspace = move.context.workspace
	let source = move.context.filePath
	let unbound = new Set<unknown>(
		landingNamings.flatMap((naming) =>
			naming.entries.map((named) => named.entry),
		),
	)
	let dropped = new Set(
		move.imports.filter((read) => !read.keptHere).map((read) => read.entry),
	)
	let backToSource = relativeSpecifier(target.filePath, source)
	let towardsSource = [
		...imports
			.filter((entry) => entry.specifier === backToSource)
			.map((entry) => entry.name),
		...(target.program?.imports?.entries ?? [])
			.filter(
				(entry) =>
					!unbound.has(entry) &&
					workspace
						.dependenciesOf(target.filePath)
						.get(entry.source.path) === source,
			)
			.map((entry) => entry.name.content),
	]
	let towardsTarget = [
		...(move.usedHere ? [move.name] : []),
		...(move.context.program.imports?.entries ?? [])
			.filter(
				(entry) =>
					!dropped.has(entry) &&
					workspace.dependenciesOf(source).get(entry.source.path) ===
						target.filePath,
			)
			.map((entry) => entry.name.content),
	]

	return towardsSource.length > 0 && towardsTarget.length > 0
}

// What lands in the destination: the Statement, its export entry where
// needed, and the imports it reads through. The destination's own imports of
// the name go, since it now declares it.
function landingEdits(
	move: Move,
	target: Target,
	publish: boolean,
	imports: Array<ImportEntry>,
	landingNamings: Array<Naming>,
): Array<CodeActionEdit> | null {
	let sourceText = target.sourceText
	let program = target.program

	// A new or blank file gets a whole Program.
	if (sourceText === null || program === null || sourceText.trim() === "") {
		let start = { line: 1, column: 1 }
		let lines = (sourceText ?? "").split("\n")

		return [
			{
				range: {
					start,
					end:
						sourceText === null
							? start
							: {
									line: lines.length,
									column: (lines.at(-1) ?? "").length + 1,
								},
				},
				newText: moduleText(move, publish, imports),
				filePath: target.filePath,
				...(sourceText === null ? { createFile: true } : {}),
			},
		]
	}

	let section = program.implementation
	let lines = sourceText.split("\n")

	// The text must open with `implementation`, since every Program carries
	// an implementation section, written or not.
	if (
		sliceOf(lines, {
			start: section.position.start,
			end: {
				line: section.position.start.line,
				column:
					section.position.start.column +
					implementationKeyword.length,
			},
		}) !== implementationKeyword
	) {
		return null
	}

	// A blank line before it, unless the block is empty.
	let separator = section.nodes.length === 0 ? "" : "\n"
	let edits: Array<CodeActionEdit> = [
		{
			...insertBeforeClosingBrace(
				section.position.end,
				lines,
				`${separator}${move.text}\n`,
				"",
			),
			filePath: target.filePath,
		},
	]

	if (publish) {
		let edit = insertExportEdit(sourceText, program, {
			name: move.name,
			alias: null,
			specifier: null,
		})

		if (edit !== null) {
			edits.push({ ...edit, filePath: target.filePath })
		}
	}

	let unbound = landingNamings.flatMap((naming) =>
		naming.entries.flatMap((named) =>
			named.section === "imports" ? [named.entry] : [],
		),
	)

	for (let edit of rewriteImports(sourceText, program, unbound, imports)) {
		edits.push({ ...edit, filePath: target.filePath })
	}

	return edits
}

// What the destination imports for the Statement: the names it reads that
// this Module publishes, and the entries it reads this Module's imports
// through. Null refuses the destination, where it binds one of those names to
// something else.
function landingImports(move: Move, target: Target): Array<ImportEntry> | null {
	let workspace = move.context.workspace
	let reads = [
		...move.needed.map(({ name, local }) => ({
			name,
			alias: local === name ? null : local,
			filePath: move.context.filePath,
			named: true,
			implicit: bindingOf(workspace, move.context.filePath, name)
				.implicit,
		})),
		...move.imports.map(({ entry, filePath, named, implicit }) => ({
			name: entry.name.content,
			alias: entry.alias?.content ?? null,
			filePath,
			named,
			implicit,
		})),
	]
	let program = target.program
	let declared = program === null ? new Set<string>() : topLevelNames(program)
	let resolutions = workspace.dependenciesOf(target.filePath)
	let imports: Array<ImportEntry> = []

	for (let read of reads) {
		let local = read.alias ?? read.name

		// The name comes from the destination itself, which needs no import
		// where it declares the name under the one the Statement writes.
		if (read.filePath === target.filePath) {
			if (
				(read.alias === null || !read.named) &&
				publishesOwn(program, read.name)
			) {
				continue
			}

			return null
		}

		// A use that writes no name is served under any name. A second entry
		// would make a Namespace's calls ambiguous, so only a name with no
		// implicit use gets one. An entry through a Module that forwards the
		// declaration binds it too.
		let identities = bindingOf(
			workspace,
			read.filePath,
			read.name,
		).identities
		let same = program?.imports?.entries.find((entry) => {
			let filePath = resolutions.get(entry.source.path)

			return (
				filePath !== undefined &&
				[
					...bindingOf(workspace, filePath, entry.name.content)
						.identities,
				].some((identity) => identities.has(identity))
			)
		})

		if (same !== undefined) {
			if (!read.named || (same.alias ?? same.name).content === local) {
				continue
			}

			if (read.implicit) {
				return null
			}
		}

		if (
			declared.has(local) ||
			program?.imports?.entries.some(
				(entry) => (entry.alias ?? entry.name).content === local,
			) === true
		) {
			return null
		}

		imports.push({
			name: read.name,
			alias: read.alias,
			specifier: relativeSpecifier(target.filePath, read.filePath),
		})
	}

	return imports
}

// Whether a Module declares the name and publishes it as itself.
function publishesOwn(program: parser.Program | null, name: string): boolean {
	return (
		program !== null &&
		topLevelNames(program).has(name) &&
		(program.exports?.entries ?? []).some(
			(entry) =>
				entry.source === null &&
				entry.alias === null &&
				entry.name.content === name,
		)
	)
}

function moduleText(
	move: Move,
	publish: boolean,
	imports: Array<ImportEntry>,
): string {
	let exported = publish ? `\nexport {\n\t${move.name}\n}\n` : ""
	let imported = imports.length === 0 ? "" : `${importBlock(imports, "")}\n`

	return `${imported}implementation {\n${move.text}\n}\n${exported}`
}

// Points another Module's entries at the destination. A group of only this
// name gets a new specifier; a shared entry moves to the destination's group.
function retargetEdits(
	move: Move,
	naming: Naming,
	targetPath: string,
): Array<CodeActionEdit> {
	let specifier = relativeSpecifier(naming.filePath, targetPath)
	let lines = naming.sourceText.split("\n")
	let edits: Array<CodeActionEdit> = []

	for (let named of naming.entries) {
		if (named.group.entries.length === 1) {
			edits.push({
				range: named.group.source.position,
				newText: `"${specifier}"`,
				filePath: naming.filePath,
			})

			continue
		}

		let alias = named.entry.alias?.content ?? null
		let insertion =
			named.section === "imports"
				? insertImportEdit(naming.sourceText, naming.program, {
						name: move.name,
						alias,
						specifier,
					})
				: insertExportEdit(
						naming.sourceText,
						naming.program,
						{ name: move.name, alias, specifier },
						named.entry,
					)

		if (insertion === null) {
			continue
		}

		edits.push({
			...removeMemberEdit(lines, named.entry.position),
			filePath: naming.filePath,
		})
		edits.push({ ...insertion, filePath: naming.filePath })
	}

	return edits
}

// Every other Module that named it in an entry, re-exports included, found
// through this file's dependents.
function namingsOf(context: ImportContext, name: string): Array<Naming> {
	let workspace = context.workspace
	let found: Array<Naming> = []

	for (let dependentPath of workspace.dependentsOf(context.filePath).sort()) {
		if (dependentPath === context.filePath) {
			continue
		}

		let sourceText = workspace.sourceOf(dependentPath)
		let program = workspace.programOf(dependentPath)

		if (sourceText === null || program === null) {
			continue
		}

		let resolutions = workspace.dependenciesOf(dependentPath)
		let entries: Array<NamedEntry> = []

		for (let group of program.imports?.groups ?? []) {
			if (resolutions.get(group.source.path) !== context.filePath) {
				continue
			}

			for (let entry of group.entries) {
				if (entry.name.content === name) {
					entries.push({ section: "imports", group, entry })
				}
			}
		}

		for (let group of program.exports?.groups ?? []) {
			if (resolutions.get(group.source.path) !== context.filePath) {
				continue
			}

			for (let entry of group.entries) {
				if (entry.name.content === name) {
					entries.push({ section: "exports", group, entry })
				}
			}
		}

		if (entries.length > 0) {
			found.push({
				filePath: dependentPath,
				sourceText,
				program,
				entries,
			})
		}
	}

	return found
}
