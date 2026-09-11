import * as path from "node:path"

import type { common, parser } from "@essence-lang/interfaces"

import {
	insertExportEdit,
	insertImportEdit,
	relativeSpecifier,
} from "../autoImport"
import { isSamePosition } from "../positions"
import { type DeclarationKind, indexProgram, type RenameIndex } from "../rename"
import type { ImportContext } from "./fixes"
import {
	containsRange,
	insertBeforeClosingBrace,
	lineAt,
	overlaps,
	removeMemberEdit,
	sliceOf,
} from "./geometry"
import type { CodeActionEdit, CodeActionEntry } from "./index"

// NOTE: The one refactoring here that edits files the reader never opened —
// three of them in the ordinary case: the Module the Declaration leaves, the
// Module it lands in, and every Module that named it in an entry. Nothing else
// in this Server rewrites a file nobody asked about, which is why the refusal
// below is written first and read as the whole of what makes this safe: a
// Declaration whose body reads something private to the file it is leaving would
// land somewhere it can not compile, and no edit here can invent the name for it.
//
// The Statement travels as WRITTEN — the text of its lines, its `§§` block
// included — rather than printed back from its Node. A Declaration is the
// author's prose as much as their code, and moving it is not the moment to
// reflow either.

// NOTE: What a Statement has to be for this to say anything about it: one
// top-level Declaration under one name. A `variable` is deliberately absent —
// no Module may export one, so there is nowhere for it to go — and so is a
// Declaration that binds a Pattern, which declares as many names as it takes
// apart and has no single one to move.
type Declared = {
	name: parser.IdentifierNode
	documentation: common.Documentation | null
}

// NOTE: The Module an entry of another file could name this from, and what it
// holds — read once for the whole request, because every action offered
// measures its edits against the same two.
type Target = {
	filePath: string
	// NOTE: Null for the Module this action would WRITE, which is the one that
	// has neither yet.
	sourceText: string | null
	program: parser.Program | null
}

// NOTE: One entry of one other Module that named the Declaration, with the
// group it stands in — what says the entry has to be retargeted, and how.
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

// NOTE: Everything about the move that does not depend on where it is going,
// worked out once rather than once per Module offered.
type Move = {
	context: ImportContext
	lines: Array<string>
	name: string
	// NOTE: The Statement together with the `§§` block above it, which documents
	// it and belongs to it.
	span: common.Position
	text: string
	removal: CodeActionEdit
	// NOTE: The edit that stops this Module publishing it, and null where this
	// Module never did — which is also what says whether the Module it lands in
	// has to publish it in turn.
	unpublish: CodeActionEdit | null
	usedHere: boolean
	namings: Array<Naming>
}

const implementationKeyword = "implementation"

export function moveActions(
	context: ImportContext | null,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	if (context === null) {
		return []
	}

	let move = movableAt(context, lines, range)

	if (move === null) {
		return []
	}

	return targetsFor(move).flatMap((target) => {
		let entry = moveEntry(move, target)

		return entry === null ? [] : [entry]
	})
}

// NOTE: The Declaration whose NAME the request's range touches — a refactoring
// offered on a body would be offered on every Statement of it, and what a reader
// with the cursor inside a Function body is doing is editing that body.
function movableAt(
	context: ImportContext,
	lines: Array<string>,
	range: common.Position,
): Move | null {
	let program = context.program
	let block = program.implementation.position

	// NOTE: An ordinary Module and nothing else. A `declarations { … }` Program
	// is the standard library's one shared declaration space rather than a
	// Module with names to give away, and a file that is nothing but tests
	// carries an implementation section spanning its `tests { … }` block — so
	// what would be moved out of it is a test.
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

		// NOTE: Whole lines are what is carried over, so a Statement sharing a
		// line with the block's own braces has nothing to carry: taking its
		// lines would take the block with it.
		if (
			span.start.line <= block.start.line ||
			span.end.line >= block.end.line
		) {
			return null
		}

		let { index } = indexProgram(program)

		if (!readsMovableNames(program, index, span)) {
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
			// NOTE: A Function Statement's `§§` block is handed down to the
			// literal it declares, which is where the Parser writes it.
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

// NOTE: THE refusal. Every name the Statement reads has to mean the same thing
// in the Module it lands in, and there are exactly four ways it can: it is a
// builtin, it is something this file imports, it is declared inside the
// Statement itself, or it is something this file publishes — which the Module it
// lands in can then import back. A name this file keeps to itself is none of
// them, and moving the Statement away from it would be moving it away from what
// it means.
//
// Read off the rename index rather than off the Statement's Nodes, because
// "what does this name resolve to" is the question the index exists to answer,
// and answering it again here would be a second scoping rule to keep in step.
function readsMovableNames(
	program: parser.Program,
	index: RenameIndex,
	span: common.Position,
): boolean {
	let published = new Set(
		(program.exports?.entries ?? [])
			.filter((entry) => entry.source === null)
			.map((entry) => entry.name.content),
	)

	return index.every((occurrence) => {
		let declaration = occurrence.declaration

		if (
			!containsRange(span, occurrence.position) ||
			!isLexical(declaration.kind)
		) {
			return true
		}

		if (declaration.builtin || declaration.kind === "import") {
			return true
		}

		if (declaration.definition === null) {
			return false
		}

		return (
			containsRange(span, declaration.definition) ||
			published.has(occurrence.name)
		)
	})
}

// NOTE: The kinds a Module binds by NAME, which are the ones a Statement takes
// with it or leaves behind. A member, a property, a Method and an Argument label
// are reached through a Type instead — `{ x = 1 }` names the member of whatever
// Record it is written for, and `by 2` names a Parameter of whatever it is
// calling — so what has to be in scope where the Statement lands is the name
// beside them, and that one is an occurrence of its own.
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

// NOTE: Whether anything OUTSIDE the Statement still reads the name once it is
// gone — its tests included, which is exactly the reason to ask: a Module that
// keeps using what it gave away has to import it back. The entry that publishes
// it is not such a read, since that entry goes along with the Declaration.
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

// NOTE: The Statement's own lines, and the ONE blank line that stops being a
// separator when they go: a Statement with a blank line on either side of it
// leaves two behind, and one written against a brace leaves a blank line inside
// the block. Every other blank line separates two Statements that are both still
// there, and stays exactly where the author put it.
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

// NOTE: The name taken out of this Module's export block — and the block taken
// with it where that name was all it published, since `export {}` says what a
// Module writing no block at all says, in four characters more. The blank line
// above the block goes too: it separated the block from the implementation, and
// there is no longer anything on the far side of it.
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

// NOTE: A whole Module block, with the blank line that separated it from the
// implementation — which is the line UNDER it for a block that opens the file
// and the line over it for one that closes it.
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

// NOTE: The entries of the Module the Declaration lands in that named it
// somewhere else. It is declared right there now, so the entry binds a name the
// file already has — and whatever the entry was the last of goes with it: the
// group where it was the only name, the block where that was the only group.
//
// Entries of the import block and no others, because a Module that FORWARDS the
// name is not offered as a destination at all — see `forwards`.
function unbindEdits(naming: Naming): Array<CodeActionEdit> {
	let lines = naming.sourceText.split("\n")
	let section = naming.program.imports

	if (section === null) {
		return []
	}

	return naming.entries.flatMap((named) =>
		named.section !== "imports"
			? []
			: [
					{
						...(section.entries.length === 1
							? removeSectionEdit(lines, section.position)
							: named.group.entries.length === 1
								? removeMemberEdit(lines, named.group.position)
								: removeMemberEdit(
										lines,
										named.entry.position,
									)),
						filePath: naming.filePath,
					},
				],
	)
}

// NOTE: Whole lines, the break that ends the last of them included — and where
// that is the last line of the file, the break BEFORE the first instead, since
// a deletion may not end past the end of the document.
function lineRange(
	lines: Array<string>,
	first: number,
	last: number,
): common.Position {
	if (last >= lines.length) {
		let end = { line: last, column: lineAt(lines, last).length + 1 }

		// NOTE: The break BEFORE the first line, since a deletion may not end
		// past the end of the document — and where there is no line before it,
		// the lines alone, which leaves the empty document an empty document.
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

// NOTE: Every other Module in the document's own directory, and the one this
// would write beside it. A Module further away is deliberately not offered: a
// list of every file in the workspace is a menu rather than an offer, and the
// move a reader means is nearly always into a file they can already see.
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

	// NOTE: A Module named after what it holds, which is the one name that can
	// be chosen without asking. A file already standing there is not offered:
	// choosing between overwriting it and naming the new one something else is
	// the reader's, and a Code Action has no way to ask.
	let written = path.join(directory, `${move.name}.es`)

	if (workspace.sourceOf(written) === null) {
		targets.push({ filePath: written, sourceText: null, program: null })
	}

	return targets
}

// NOTE: A Module that FORWARDS the name is a facade for the Module that
// declares it, and the Declaration landing inside the facade would have to
// become the very thing the facade forwards — an entry rewritten into a
// Declaration rather than a Declaration moved. Not offered, rather than offered
// and half done.
function forwards(move: Move, candidate: string): boolean {
	return move.namings.some(
		(naming) =>
			naming.filePath === candidate &&
			naming.entries.some((named) => named.section === "exports"),
	)
}

function moveEntry(move: Move, target: Target): CodeActionEntry | null {
	let specifier = relativeSpecifier(move.context.filePath, target.filePath)
	// NOTE: The Module it LANDS in may be one of the Modules that named it —
	// moving a helper into its one reader is the ordinary reason to move one at
	// all — and there the entry is not retargeted but dropped: a Module does not
	// import what it declares.
	let landingNamings = move.namings.filter(
		(naming) => naming.filePath === target.filePath,
	)
	let otherNamings = move.namings.filter(
		(naming) => naming.filePath !== target.filePath,
	)
	// NOTE: The Module it lands in publishes it whenever anything still names
	// it: another Module that imported it from here, this file's own body, or
	// this file's export block — which published it to the whole workspace, and
	// may be read by a Module the workspace has not been asked about.
	let publish =
		move.unpublish !== null || otherNamings.length > 0 || move.usedHere
	let landing = landingEdits(move, target, publish)

	if (landing === null) {
		return null
	}

	let edits = [move.removal, ...landing]

	for (let naming of landingNamings) {
		edits.push(...unbindEdits(naming))
	}

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
		// NOTE: Never preferred. Which Module a Declaration belongs in is the
		// one question here that the Compiler has no opinion about, and an
		// Editor applying an answer to it without being asked would be moving
		// somebody's code around behind them.
		isPreferred: false,
		edits,
	}
}

// NOTE: What lands in the Module at the other end: the Statement, and the entry
// that publishes it where anything still names it.
function landingEdits(
	move: Move,
	target: Target,
	publish: boolean,
): Array<CodeActionEdit> | null {
	let sourceText = target.sourceText
	let program = target.program

	// NOTE: A Module that is not there yet and a file holding nothing but
	// whitespace are one case: there is no implementation block to append to, so
	// what lands is a whole Program.
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
				newText: moduleText(move, publish),
				filePath: target.filePath,
				...(sourceText === null ? { createFile: true } : {}),
			},
		]
	}

	let section = program.implementation
	let lines = sourceText.split("\n")

	// NOTE: Measured against the file's own text rather than taken from its
	// Program, because a Program carries an implementation section whether the
	// file wrote one or not: a file that did not parse carries an empty one at
	// the top, a `declarations { … }` Program carries the standard library's
	// shared declaration space, and a file that is nothing but tests carries one
	// spanning its `tests { … }` block. Appending to any of those writes the
	// Statement somewhere it does not belong.
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

	// NOTE: A blank line above it where something is already written there, and
	// none where the block is empty — a Statement against the opening brace of
	// an empty block reads as the first thing in it, which is what it is.
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

	return edits
}

function moduleText(move: Move, publish: boolean): string {
	let exported = publish ? `\nexport {\n\t${move.name}\n}\n` : ""

	return `implementation {\n${move.text}\n}\n${exported}`
}

// NOTE: An entry that named the Declaration in the Module it is leaving, made to
// name the Module it lands in. A group holding nothing but this name is
// retargeted WHOLE — one specifier written over, which leaves the entry, its
// `as` and every Comment around it exactly as they were — and an entry sharing
// its group with others is taken out and handed to the group of the other
// Module, which is where the Formatter would put it anyway.
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

// NOTE: Every other Module that named it in an entry, with the entries
// themselves — asked of the dependency edges rather than of the workspace at
// large, since a Module that never named this file can not have named anything
// in it. A re-export counts: a facade forwarding the name is naming the Module
// behind it, and that Module is about to be a different one.
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
