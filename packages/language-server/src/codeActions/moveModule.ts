import * as path from "node:path"

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
} from "../rename"
import type { ImportContext } from "./fixes"
import {
	containsRange,
	insertBeforeClosingBrace,
	lineAt,
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

// Everything about the move that does not depend on its destination.
type Move = {
	context: ImportContext
	lines: Array<string>
	name: string
	// The Statement with its `§§` block.
	span: common.Position
	text: string
	// The published names of this Module the Statement reads, which the
	// destination imports.
	needed: Array<string>
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
	lines: Array<string>,
	range: common.Position,
	indexed: () => ProgramIndex,
): Array<CodeActionEntry> {
	if (context === null) {
		return []
	}

	let move = movableAt(context, lines, range, indexed)

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
		let needed = readsMovableNames(program, index, span)

		if (needed === null) {
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
			needed,
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
// Null refuses the move; otherwise the published names it reads, which the
// destination imports. See "Moving a Declaration" in DEVELOPMENT.md.
function readsMovableNames(
	program: parser.Program,
	index: RenameIndex,
	span: common.Position,
): Array<string> | null {
	let published = new Set(
		(program.exports?.entries ?? [])
			.filter((entry) => entry.source === null)
			.map((entry) => entry.name.content),
	)
	let needed = new Set<string>()

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

		if (declaration.builtin || declaration.kind === "import") {
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

	return [...needed]
}

// Whether the destination can see the Namespace a dispatch resolved to. Null
// refuses; otherwise the name to import, or null for a builtin Namespace, one
// the Statement carries, or one this file imports.
function namespaceReach(
	program: parser.Program,
	published: Set<string>,
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
			edits.push(removeLinesEdit(lines, group.position))

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
	let landing = landingEdits(move, target, publish, landingNamings)

	if (landing === null) {
		return null
	}

	let edits = [move.removal, ...landing]

	if (move.unpublish !== null) {
		edits.push(move.unpublish)
	}

	if (move.usedHere) {
		let edit = insertImportEdit(
			move.context.documentText,
			move.context.program,
			{ name: move.name, alias: null, specifier },
		)

		if (edit !== null) {
			edits.push(edit)
		}
	}

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

// What lands in the destination: the Statement, its export entry where
// needed, and the names it reads from this Module. The destination's own
// imports of the name go, since it now declares it.
function landingEdits(
	move: Move,
	target: Target,
	publish: boolean,
	landingNamings: Array<Naming>,
): Array<CodeActionEdit> | null {
	let sourceText = target.sourceText
	let program = target.program
	// Imported back from this Module, which still publishes them.
	let imports = move.needed.map((name) => ({
		name,
		alias: null,
		specifier: relativeSpecifier(target.filePath, move.context.filePath),
	}))

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
