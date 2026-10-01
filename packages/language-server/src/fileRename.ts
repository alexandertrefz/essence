import type { common, parser } from "@essence-lang/interfaces"

import { relativeSpecifier } from "./autoImport"
import type { Workspace } from "./workspace"

// The import edits a move needs, both in the Modules naming the moved file and
// in its own entries. Answered before the move, so nothing is ever on disk
// broken.

const SOURCE_EXTENSION = ".es"

export type FileRename = {
	oldPath: string
	newPath: string
}

export type SpecifierRewrite = {
	filePath: string
	edits: Array<{ range: common.Position; newText: string }>
}

export function importRewrites(
	workspace: Workspace,
	renames: Array<FileRename>,
): Array<SpecifierRewrite> {
	let moves = movesOf(workspace, renames)

	if (moves.size === 0) {
		return []
	}

	// The moved files and every file reaching them. Only the files that name one
	// directly are rewritten.
	let reached = new Set<string>()

	for (let oldPath of moves.keys()) {
		for (let dependent of workspace.dependentsOf(oldPath)) {
			reached.add(dependent)
		}
	}

	let rewrites: Array<SpecifierRewrite> = []

	for (let filePath of [...reached].sort()) {
		let edits = rewritesIn(workspace, moves, filePath)

		if (edits.length > 0) {
			rewrites.push({ filePath, edits })
		}
	}

	return rewrites
}

// One rename is one known file or every `.es` file under a directory. A file
// renamed out of the language, such as `Shared.txt`, moves nothing: the
// Compiler refuses that specifier (`missing-extension`).
function movesOf(
	workspace: Workspace,
	renames: Array<FileRename>,
): Map<string, string> {
	let known = workspace.knownFiles()
	let moves = new Map<string, string>()

	for (let rename of renames) {
		if (known.has(rename.oldPath)) {
			if (rename.newPath.endsWith(SOURCE_EXTENSION)) {
				moves.set(rename.oldPath, rename.newPath)
			}

			continue
		}

		let prefix = `${rename.oldPath}/`

		for (let candidate of known) {
			if (candidate.startsWith(prefix)) {
				moves.set(
					candidate,
					`${rename.newPath}/${candidate.slice(prefix.length)}`,
				)
			}
		}
	}

	return moves
}

// Every group of both blocks, rewritten from the new location. A group whose
// specifier stays the same is left alone.
function rewritesIn(
	workspace: Workspace,
	moves: Map<string, string>,
	filePath: string,
): Array<{ range: common.Position; newText: string }> {
	let program = workspace.programOf(filePath)

	if (program === null) {
		return []
	}

	let resolutions = workspace.dependenciesOf(filePath)
	let from = moves.get(filePath) ?? filePath
	let groups: Array<parser.ImportGroupNode | parser.ExportGroupNode> = [
		...(program.imports?.groups ?? []),
		...(program.exports?.groups ?? []),
	]
	let edits: Array<{ range: common.Position; newText: string }> = []

	for (let group of groups) {
		let resolved = resolutions.get(group.source.path)

		if (resolved === undefined) {
			continue
		}

		let specifier = relativeSpecifier(from, moves.get(resolved) ?? resolved)

		if (specifier !== group.source.path) {
			edits.push({
				// The String Literal with its quotes, as the Lexer spans it, replaced whole.
				range: group.source.position,
				newText: `"${specifier}"`,
			})
		}
	}

	return edits
}
