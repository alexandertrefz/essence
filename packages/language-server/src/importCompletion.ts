import * as path from "node:path"

import type { common, parser } from "@essence-lang/interfaces"

import type { CompletionEntry } from "./completion"
import type { WorkspaceOffer } from "./workspace"

// Completion inside the Module sections, read off the text since a block
// being typed does not parse. From the section's `{`, braces outside Strings
// and comments count: one deep is the block, two a group.

export type ModuleSectionCursor =
	// Inside a `from` specifier. `typed` is the text after the opening quote;
	// `quoted` says a closing quote already follows.
	| {
			at: "path"
			section: "import" | "export"
			typed: string
			replaces: common.Position
			quoted: boolean
	  }
	// Inside a group's braces, where the group's Module's exports are offered.
	| { at: "names"; section: "import" | "export"; specifier: string }
	// Directly inside the block's braces, where a group starts, or in an export
	// block one of the Module's own names.
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

	// The nearest section head at or above the cursor. Heads start their line, as
	// nothing else does.
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
	// The specifier of the last `from "…"` one deep, whose group the next `{`
	// opens.
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

		// A specifier never spans lines, so a String still open at the end of
		// another line is a broken line.
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

	// What accepting a group replaces: a begun `from ` or the word under the
	// cursor, so no `from from` results.
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

// `./A.es` and `././A.es` are one specifier; offers use the canonical one.
function sameSpecifier(left: string, right: string): boolean {
	return path.posix.normalize(left) === path.posix.normalize(right)
}

// The specifiers the section has groups for, read off the text, leaving out
// the cursor's line.
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

// `$`, `}` and `\` are snippet syntax, and a path may hold any of them.
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

// The names an export block may list bare: the top level declarations. A
// Pattern declaration binds several names, so it is left out.
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

// What the section offers at the cursor. `offers` is every export of the
// Modules in `specifiers` that this file could still bind.
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
		// Every Module, as a path from this file. The whole specifier is replaced,
		// since the Editor's word ends at every `.` and `/`.
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

		// The exports of the group's Module, less what the file binds by the
		// Workspace's reading and by the current buffer.
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

		// A group for every Module not yet written, with the cursor in its braces,
		// and in an export block the Module's own unlisted names.
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
