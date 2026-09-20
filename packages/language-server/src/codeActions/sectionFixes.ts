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

// NOTE: The Diagnostics about a Program's SECTIONS rather than about anything
// written inside one — which keyword opens it, which files its imports name, and
// what its export block is allowed to publish. Each of them is answered from a
// span the section itself carries, so none of them reads a body.

const declarationsKeyword = "declarations"
const implementationKeyword = "implementation"

// NOTE: The Diagnostic spans exactly the `declarations` keyword, and the whole
// of what is wrong is that word: the block behind it is parsed as an
// implementation section either way, so swapping the keyword is what makes the
// source say what the Parser already read.
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

// NOTE: One group per dependency, in both sections — `from "./A.es" { … }` is
// written the same way whether it imports names or forwards them — so a
// Diagnostic reported on a specifier names exactly one of these, and which
// section it stands in is what says how much removing it costs.
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

// NOTE: One action per section, because the two sections mean opposite things by
// the same group. An IMPORT group naming this file asks for names that are in
// scope inside it already, so the whole group goes and the Program provably
// answers what it answered before — preferred, and the whole group rather than
// one entry, since the specifier the Diagnostic is reported on is the group's.
//
// An EXPORT group naming this file publishes names this Module DECLARES, written
// the forwarding way. Deleting it takes the Module's public surface with it,
// which is the one thing the writer did not ask for — so the names are written
// bare instead, which is the edit the Help spells. Never preferred: what a
// Module publishes is a decision, and an Editor does not make it on its own.
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

	// NOTE: An `as` is kept. A bare entry renames the same way a forwarded one
	// does, so `area as squareArea` says the same thing on either side of this
	// edit and the Module goes on publishing the name it published.
	let written = entries.map((entry) =>
		entry.alias === null
			? entry.name.content
			: `${entry.name.content} as ${entry.alias.content}`,
	)

	// NOTE: Laid out the way the group was — one name per line under the
	// group's own indentation where it stood on a line of its own, and beside
	// each other where it shared its line with something else.
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

// NOTE: Read off the Diagnostic's own Help rather than worked out again here.
// Which specifiers are refused and what each of them should have said is
// `reportRejection`'s to decide — four rejections share this code and only two
// of them have a concrete answer at all — and re-deriving that rule in the
// Editor would offer a rewrite for the two that do not. The shape of the Help is
// the contract between the two, and the check below is what keeps a reworded one
// from writing nonsense: the specifier it spells has to be the written one with
// a `./` in front or a `.es` behind, and nothing else is accepted.
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

		// NOTE: Preferred only for the extension. The `.es` a specifier ends in
		// is part of the path this Module names and nothing else could have been
		// meant; a `./` in front of it is a guess at where the file sits, which
		// the Help itself says out loud — "if the file sits beside this one".
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

// NOTE: The mirror of `constantToVariableAction`, answering the other direction:
// a name the export block publishes has to be a Constant, so the Declaration the
// Diagnostic points back at is the one to rewrite.
//
// Never preferred. A Variable is declared as one because something assigns to
// it, and every one of those assignments is a `constant-reassignment` the moment
// this lands — which is exactly the conversation the fix is for, and not
// something an Editor may start on its own.
export function variableToConstantAction(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): CodeActionEntry | null {
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

	// NOTE: The Statement's Position starts at its keyword, but a `§§` block or
	// a Declaration this Parser recovered from could move it — replacing a span
	// that does not read `variable` would corrupt the line silently.
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
