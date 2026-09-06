import * as path from "node:path"

import type { common, parser } from "@essence-lang/interfaces"

import type { CompletionEntry } from "./completion"
import type { WorkspaceOffer } from "./workspace"

// NOTE: Completion inside the two Module sections, which the ordinary modes
// have nothing to say about: a name in Scope is no answer to a cursor that is
// asking which file to import from, or which of that file's exports to take.
//
// Where the cursor stands is read off the TEXT rather than the AST, the way
// the `::` and `.` triggers are: a block being typed into is a block that does
// not parse — `from "./Sea` is an unterminated String — and the shape asked
// about is simple enough to walk. From the section's own `{` to the cursor,
// braces are counted outside Strings and Comments: one deep is the block
// itself, two deep is a group, and a String left open one deep after `from` is
// a specifier being written.

export type ModuleSectionCursor =
	// NOTE: Inside the specifier of a `from`. `typed` is what stands between
	// the opening quote and the cursor; `quoted` says a closing quote already
	// follows, so accepting an entry must not write a second one.
	| {
			at: "path"
			section: "import" | "export"
			typed: string
			replaces: common.Position
			quoted: boolean
	  }
	// NOTE: Inside the braces of a group, whose specifier says which Module's
	// exports are the answer.
	| { at: "names"; section: "import" | "export"; specifier: string }
	// NOTE: Directly inside the block's own braces, where a group starts — or,
	// in an export block, where one of the Module's own names is listed.
	| { at: "members"; section: "import" | "export"; replaces: common.Position }

const sectionHeadPattern =
	/^(import|export|implementation|declarations|tests)\s*\{/

export function moduleSectionCursor(
	lines: Array<string>,
	cursor: common.Cursor,
): ModuleSectionCursor | null {
	let headLine = 0
	let section: "import" | "export" | null = null
	let openingColumn = 0

	// NOTE: The nearest section head at or above the cursor says which block
	// the cursor could be in. The heads stand at the start of their line, and
	// nothing else in a file does.
	for (let line = cursor.line; line >= 1; line--) {
		let text = lines[line - 1] ?? ""
		let match = sectionHeadPattern.exec(
			line === cursor.line ? text.slice(0, cursor.column - 1) : text,
		)

		if (match === null) {
			continue
		}

		if (match[1] !== "import" && match[1] !== "export") {
			return null
		}

		headLine = line
		section = match[1]
		openingColumn = match[0].length
		break
	}

	if (section === null) {
		return null
	}

	let depth = 0
	let quoteStart: common.Cursor | null = null
	// NOTE: The specifier of the last `from "…"` read one deep, which is what
	// the `{` after it opens a group for.
	let pendingSpecifier: string | null = null
	let groupSpecifier: string | null = null

	for (let line = headLine; line <= cursor.line; line++) {
		let text = lines[line - 1] ?? ""
		let from = line === headLine ? openingColumn - 1 : 0
		let to = line === cursor.line ? cursor.column - 1 : text.length

		for (let column = from; column < to; column++) {
			let character = text[column]

			if (quoteStart !== null) {
				if (character === '"') {
					let before = text.slice(0, quoteStart.column - 2)

					pendingSpecifier =
						depth === 1 && /(?:^|\s)from\s*$/.test(before)
							? text.slice(quoteStart.column - 1, column)
							: null
					quoteStart = null
				}

				continue
			}

			if (character === "§") {
				break
			}

			if (character === '"') {
				quoteStart = { line, column: column + 2 }
			} else if (character === "{") {
				depth++

				if (depth === 2) {
					groupSpecifier = pendingSpecifier
				}
			} else if (character === "}") {
				depth--
			}
		}

		// NOTE: A specifier never spans lines, so a String still open at the
		// end of one that is not the cursor's own is a broken line rather than
		// a String the cursor is in.
		if (quoteStart !== null && line !== cursor.line) {
			quoteStart = null
		}
	}

	if (depth <= 0 || depth > 2) {
		return null
	}

	let currentLine = lines[cursor.line - 1] ?? ""
	let beforeCursor = currentLine.slice(0, cursor.column - 1)

	if (quoteStart !== null) {
		if (depth !== 1) {
			return null
		}

		let before = currentLine.slice(0, quoteStart.column - 2)

		if (!/(?:^|\s)from\s*$/.test(before)) {
			return null
		}

		return {
			at: "path",
			section,
			typed: currentLine.slice(quoteStart.column - 1, cursor.column - 1),
			replaces: { start: quoteStart, end: cursor },
			quoted: currentLine.slice(cursor.column - 1).startsWith('"'),
		}
	}

	if (depth === 2) {
		return groupSpecifier === null
			? null
			: { at: "names", section, specifier: groupSpecifier }
	}

	// NOTE: What accepting a group replaces: the `from` the writer may have
	// begun, with the space after it, or the word under the cursor — so that
	// `from ` completed to a group is not `from from "./A.es" { }`.
	let tail = /(?:from\s+|[A-Za-z_]*)$/.exec(beforeCursor)
	let start = tail === null ? cursor.column : tail.index + 1

	return {
		at: "members",
		section,
		replaces: {
			start: { line: cursor.line, column: start },
			end: cursor,
		},
	}
}

// NOTE: Two spellings of one file — `./A.es` and `././A.es` — are one
// specifier, and the offers are written the canonical way.
function sameSpecifier(left: string, right: string): boolean {
	return path.posix.normalize(left) === path.posix.normalize(right)
}

// NOTE: The specifiers the section already writes a group for, read off the
// text for the reason the cursor is: the block may not parse. The cursor's
// own line is left out, since a specifier being typed is not a group that is
// already there.
function writtenSpecifiers(
	lines: Array<string>,
	cursor: common.Cursor,
): Set<string> {
	let written = new Set<string>()

	for (let [index, line] of lines.entries()) {
		if (index + 1 === cursor.line) {
			continue
		}

		for (let match of line.matchAll(/(?:^|\s)from\s+"([^"]*)"\s*\{/g)) {
			written.add(path.posix.normalize(match[1] as string))
		}
	}

	return written
}

// NOTE: LSP snippet syntax gives `$`, `}` and `\` a meaning, and a path may
// carry any of them.
function escapeSnippet(text: string): string {
	return text.replace(/[\\$}]/g, "\\$&")
}

function localNames(
	entries: Array<parser.ImportNode | parser.ExportNode> | undefined,
): Set<string> {
	return new Set(
		(entries ?? []).map((entry) => (entry.alias ?? entry.name).content),
	)
}

// NOTE: The names an export block may list bare: what the Module declares at
// its top level. A Constant or Variable bound by a Pattern declares several
// names and no single one to export under, so it is left out.
function ownDeclarations(
	program: parser.Program,
): Array<{ name: string; kind: CompletionEntry["kind"] }> {
	let declarations: Array<{ name: string; kind: CompletionEntry["kind"] }> =
		[]

	for (let node of program.implementation.nodes) {
		switch (node.nodeType) {
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
				if (node.name.nodeType === "Identifier") {
					declarations.push({
						name: node.name.content,
						kind:
							node.nodeType === "ConstantDeclarationStatement"
								? "constant"
								: "variable",
					})
				}
				break
			case "FunctionStatement":
			case "OverloadedFunctionStatement":
				declarations.push({ name: node.name.content, kind: "function" })
				break
			case "NamespaceDefinitionStatement":
				declarations.push({
					name: node.name.content,
					kind: "namespace",
				})
				break
			case "ProtocolDeclarationStatement":
				declarations.push({ name: node.name.content, kind: "protocol" })
				break
			case "ChoiceDeclarationStatement":
			case "TypeAliasStatement":
				declarations.push({ name: node.name.content, kind: "type" })
				break
			default:
				break
		}
	}

	return declarations
}

// NOTE: What the section offers where the cursor stands. `specifiers` is every
// Module of the workspace as this file would write it; `offers` is every name
// those Modules export that this file could still bind.
export function moduleSectionCompletions(
	at: ModuleSectionCursor,
	lines: Array<string>,
	cursor: common.Cursor,
	program: parser.Program,
	specifiers: Array<string>,
	offers: Array<WorkspaceOffer>,
): Array<CompletionEntry> {
	let written = writtenSpecifiers(lines, cursor)
	let unwritten = specifiers.filter(
		(specifier) => !written.has(path.posix.normalize(specifier)),
	)

	switch (at.at) {
		// NOTE: Every Module of the workspace, as a path from this file. The
		// whole specifier is offered and the whole of what was typed replaced,
		// because the Editor's word ends at every `.` and `/` and would keep
		// the `./math/` in front of what it inserted.
		case "path":
			return unwritten.map((specifier) => ({
				label: specifier,
				kind: "module",
				detail: null,
				tier: 1,
				replaces: at.replaces,
				insertText: at.quoted
					? escapeSnippet(specifier)
					: `${escapeSnippet(specifier)}" { $0 }`,
			}))

		// NOTE: The exports of the one Module the group names, less what the
		// file already binds — from the Workspace's reading of it, and from
		// the buffer as it stands, since the two can differ by a keystroke.
		case "names": {
			let section =
				at.section === "import" ? program.imports : program.exports
			let bound = localNames(section?.entries)

			return offers
				.filter(
					(offer) =>
						sameSpecifier(offer.specifier, at.specifier) &&
						!bound.has(offer.name),
				)
				.map((offer) => ({
					label: offer.name,
					kind: offer.kind,
					detail: null,
					tier: 1,
				}))
		}

		// NOTE: A group for every Module not yet written, opened with the
		// cursor inside its braces — and, in an export block, the Module's own
		// names that are not yet listed.
		case "members": {
			let groups: Array<CompletionEntry> = unwritten.map((specifier) => ({
				label: `from "${specifier}"`,
				kind: "module",
				detail: null,
				tier: 2,
				replaces: at.replaces,
				insertText: `from "${escapeSnippet(specifier)}" { $0 }`,
			}))

			if (at.section === "import") {
				return groups
			}

			let exported = localNames(program.exports?.entries)
			let own: Array<CompletionEntry> = ownDeclarations(program)
				.filter((declaration) => !exported.has(declaration.name))
				.map((declaration) => ({
					label: declaration.name,
					kind: declaration.kind,
					detail: null,
					tier: 1,
				}))

			return [...own, ...groups]
		}
	}
}
