import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import {
	indentationOf,
	opensItsLine,
	removeLinesEdit,
	sliceOf,
} from "./geometry"
import type { CodeActionEntry } from "./index"
import { findVariableDeclaration } from "./lookups"

// Fixes for a Program's sections: the keyword that opens one, the files its
// imports name, and what its export block may publish. None reads a body.

const declarationsKeyword = "declarations"
const implementationKeyword = "implementation"

// Replaces `declarations` with `implementation`, which is how the Parser
// already reads the block.
export function implementationHeaderAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): CodeActionEntry | null {
	if (sliceOf(lines, diagnostic.position) !== declarationsKeyword) {
		return null
	}

	return {
		title: `Open the Program with '${implementationKeyword}'`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: true,
		edits: [{ range: diagnostic.position, newText: implementationKeyword }],
	}
}

// The group a Diagnostic's specifier names, and its section. Both sections
// write `from "./A.es" { … }` alike, but mean different things by it.
type SpecifierGroup = {
	group: parser.ImportGroupNode | parser.ExportGroupNode
	section: "import" | "export"
}

function groupOf(
	program: parser.Program,
	specifier: common.Position,
): SpecifierGroup | null {
	for (let group of program.imports?.groups ?? []) {
		if (isSamePosition(group.source.position, specifier)) {
			return { group, section: "import" }
		}
	}

	for (let group of program.exports?.groups ?? []) {
		if (isSamePosition(group.source.position, specifier)) {
			return { group, section: "export" }
		}
	}

	return null
}

// A group naming this file. An import group imports what is in scope already,
// so it goes whole, preferred. An export group publishes this Module's own
// names, so they are written bare instead, as the Help says. That is not
// preferred, since what a Module publishes is the author's decision.
export function removeSelfImportAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	let found = groupOf(program, diagnostic.position)

	if (found === null) {
		return null
	}

	if (found.section === "import") {
		return {
			title: `Remove the entry for ${sliceOf(lines, diagnostic.position)}`,
			kind: "quickfix",
			diagnosticCode: diagnostic.code,
			diagnosticPosition: diagnostic.position,
			isPreferred: true,
			edits: [removeLinesEdit(lines, found.group.position)],
		}
	}

	let entries = found.group.entries

	if (entries.length === 0) {
		return null
	}

	// An `as` is kept, since a bare entry renames as a forwarded one does.
	let written = entries.map((entry) =>
		entry.alias === null
			? entry.name.content
			: `${entry.name.content} as ${entry.alias.content}`,
	)

	// One name per line when the group opened its line, side by side
	// otherwise.
	let separator = opensItsLine(lines, found.group.position.start)
		? `\n${indentationOf(lines, found.group.position.start.line)}`
		: " "

	return {
		title:
			written.length === 1
				? `Write '${written[0]}' as a bare entry`
				: "Write the names as bare entries",
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [
			{ range: found.group.position, newText: written.join(separator) },
		],
	}
}

// The rewrite `reportRejection` spells in the Help. The suggested specifier
// must be the written one with `./` before it or `.es` after it. See "Reading
// a Help" in DEVELOPMENT.md.
const specifierHelpPattern = /^Write '([^']+)'/
const quotedSpecifierPattern = /^"(.*)"$/

export function moduleSpecifierActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	lines: Array<string>,
): Array<CodeActionEntry> {
	let quoted = quotedSpecifierPattern.exec(
		sliceOf(lines, diagnostic.position),
	)

	if (quoted === null) {
		return []
	}

	let written = quoted[1] as string

	return diagnostic.helps.flatMap((help) => {
		let suggested = specifierHelpPattern.exec(help)?.[1]

		if (suggested === undefined) {
			return []
		}

		// Only the `.es` fix is preferred. A `./` guesses where the file
		// sits, as the Help itself says.
		let isExtension = suggested === `${written}.es`

		if (!isExtension && suggested !== `./${written}`) {
			return []
		}

		return [
			{
				title: `Write '${suggested}'`,
				kind: "quickfix" as const,
				diagnosticCode: diagnostic.code,
				diagnosticPosition: diagnostic.position,
				isPreferred: isExtension,
				edits: [
					{
						range: diagnostic.position,
						newText: `"${suggested}"`,
					},
				],
			},
		]
	})
}

const variableKeyword = "variable"
const constantHelpPrefix = "Declare it as a Constant"

// The reverse of `constantToVariableAction`: an exported name must be a
// Constant. Offered only where the Help offers it, which excludes an assigned
// Variable. See "Reading a Help" in DEVELOPMENT.md.
//
// Not preferred: `variable` says the value changes, which only the author can
// take back.
export function variableToConstantAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
	if (!diagnostic.helps.some((help) => help.startsWith(constantHelpPrefix))) {
		return null
	}

	let declarationPosition = diagnostic.labels.find(
		(label) => label.kind === "secondary",
	)?.position

	if (declarationPosition === undefined) {
		return null
	}

	let declaration = findVariableDeclaration(program, declarationPosition)

	if (declaration === null) {
		return null
	}

	let keyword = {
		start: declaration.position.start,
		end: {
			line: declaration.position.start.line,
			column: declaration.position.start.column + variableKeyword.length,
		},
	}

	// A `§§` block or a recovered Declaration could move the keyword, so the
	// span must read `variable`.
	if (sliceOf(lines, keyword) !== variableKeyword) {
		return null
	}

	return {
		title: `Declare '${sliceOf(lines, declarationPosition)}' as a Constant`,
		kind: "quickfix",
		diagnosticCode: diagnostic.code,
		diagnosticPosition: diagnostic.position,
		isPreferred: false,
		edits: [{ range: keyword, newText: "constant" }],
	}
}
