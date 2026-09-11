import type { common, parser } from "@essence-lang/interfaces"

import { relativeSpecifier } from "./autoImport"
import type { Workspace } from "./workspace"

// NOTE: What moving a file does to the Modules around it. A specifier is a path
// written in the source, so a file that moves takes every entry naming it out of
// step — and a file that moves takes its OWN entries out of step too, since they
// are written from where it used to be.
//
// Answered BEFORE the rename happens, which is what makes it one edit rather
// than a repair: the client applies these to the files as they still are and
// then moves the file, so nothing is ever on disk in the broken state.

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

	// NOTE: The files that move, and every file that reaches one of them. A
	// Module that never named any of them writes no specifier that could have
	// gone stale — and the ones that did are asked entry by entry below, since
	// reaching a Module through a third is not naming it.
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

// NOTE: One rename is one file, or — when the client renamed a directory — every
// `.es` file under it. Which of the two it is is not something the request says:
// it hands over two paths, and what stands at the old one is a file this
// workspace already knows or a directory whose files it knows. A path that is
// neither moves nothing, which is what a rename of something that is not Essence
// should do.
//
// And a source renamed OUT of the language moves nothing either. `Shared.txt`
// is not a specifier the Compiler will take — `missing-extension` refuses it —
// so rewriting every dependent to name it would be the Server volunteering
// text that can not compile, and putting it in the reader's undo stack. The
// import was going to dangle whatever happened; answering nothing leaves the
// reader with the one Diagnostic that says so. A DIRECTORY rename is not one of
// these: its new path is a directory, and the `.es` files under it keep their
// own names.
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

// NOTE: Every group of both blocks, written from where the file will be to where
// what it names will be. A group whose specifier comes out the same is left
// alone — a file and its dependency moving together is the ordinary case of a
// directory rename, and rewriting a specifier to itself would put every file of
// that directory in the Editor's undo stack for nothing.
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
				// NOTE: The String Literal with its quotes, which is what the
				// Lexer's Position spans — the specifier written back is written
				// back whole, so nothing depends on where the quotes ended up.
				range: group.source.position,
				newText: `"${specifier}"`,
			})
		}
	}

	return edits
}
