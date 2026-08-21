import { glob, readdir, readFile, stat } from "node:fs/promises"
import * as path from "node:path"

import { containsErrors } from "@essence-lang/compiler/diagnostics"
import {
	canonicalPath,
	isStdlibDocument,
	isStdlibWalk,
	parseDocument,
} from "@essence-lang/compiler/documents"
import { hasDocumentationExamples } from "@essence-lang/compiler/enricher/examples"

import { UsageError } from "./args"
import { type CommandSpec, DEFAULT_PROGRAM_NAME } from "./commands"
import { looksLikeGlob } from "./inputs"

// NOTE: `esc build` is pointed at the files it compiles; `essence test` is
// pointed at a project. Nothing else in the CLI walks a directory, so this is
// the walk — one of them, with one ignore set, rather than a third variant
// beside the Language Server's and the Formatter's.

// NOTE: The directories a discovery walk never descends into, the same set the
// Language Server's workspace walk uses, so that the two agree about which
// files belong to a project. `node_modules` is the one that matters: a walk
// that does not stop there spends all of its time in it, and nothing under it
// is a Module of THIS project.
export const skippedDirectories = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".claude",
])

// NOTE: The convention from the design: a file that is nothing but imports and
// a `tests { … }` block, named after the Module it tests. It is discovered by
// its NAME as well as by its content, so a `Season.tests.es` that does not
// parse is still compiled and still reports its Diagnostic — a file that can
// not be read can not be shown to hold no tests.
const TESTS_SUFFIX = ".tests.es"

// NOTE: The one thing a file with no `tests { … }` block may still write that
// makes it a file with tests. Like the substring check on `tests`, it can only
// rule a file OUT — an `@example` may perfectly well be prose — so what follows
// it is a parse.
const EXAMPLE_TAG = "@example"

export function namesTests(filePath: string): boolean {
	return path.basename(filePath).endsWith(TESTS_SUFFIX)
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await stat(target)).isDirectory()
	} catch {
		return false
	}
}

// NOTE: Symlinked directories are read as files rather than descended into, so
// a link back up the tree can not send the walk round for ever — the same rule
// the Language Server's walk follows.
// NOTE: Whether a path is one the project said to stay out of. Compared as a
// path rather than as text, so that `fixtures/broken` excludes everything under
// it and `fixtures/brokenish` beside it stays.
function isExcluded(target: string, exclude: Array<string>): boolean {
	let resolved = path.resolve(target)

	return exclude.some(
		(each) =>
			resolved === each || resolved.startsWith(`${each}${path.sep}`),
	)
}

async function collectEssenceFiles(
	directory: string,
	found: Set<string>,
	// NOTE: Whether a standard library source counts. A walk of a PROJECT must
	// never pick one up, wherever the checkout puts it — it declares the
	// builtins and is nobody's test. A walk that STARTED inside the standard
	// library is a different question: the library's own `@example` blocks are
	// tests, and `essence test` run in it is how they are run.
	allowStdlib: boolean,
	// NOTE: What the project said not to walk into. Empty for every caller that
	// read no configuration, which is every caller but the two commands.
	exclude: Array<string> = [],
): Promise<void> {
	let entries: Array<{ name: string; isDirectory: boolean }> = []

	try {
		entries = (await readdir(directory, { withFileTypes: true })).map(
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
			if (
				!skippedDirectories.has(entry.name) &&
				!isExcluded(entryPath, exclude)
			) {
				await collectEssenceFiles(
					entryPath,
					found,
					allowStdlib,
					exclude,
				)
			}

			continue
		}

		if (!entry.name.endsWith(".es") || isExcluded(entryPath, exclude)) {
			continue
		}

		if (allowStdlib || !isStdlibDocument(entryPath)) {
			found.add(canonicalPath(entryPath))
		}
	}
}

// NOTE: Two rules, because the two ways a file arrives here mean different
// things. A file the caller NAMED is one they want an answer about, so an
// unreadable or unparsable one is kept and the compile reports why. A file a
// WALK turned up is one nobody mentioned, so it is kept only when it plainly
// holds tests — an unrelated broken source under the working directory is not
// what `essence test` was asked about.
async function keepsFile(filePath: string, named: boolean): Promise<boolean> {
	if (namesTests(filePath)) {
		return true
	}

	let sourceText: string

	try {
		sourceText = await readFile(filePath, "utf8")
	} catch {
		return named
	}

	// NOTE: A file that never writes the word can not open the section, so a
	// walk that turned it up is answered without parsing it — which is what
	// keeps `essence test` in a project from parsing every source in it twice,
	// once here and once in the compile. The reverse does NOT hold: `tests` is a
	// contextual keyword, so a file that writes it may only be naming a
	// Constant, and that is why what follows is a parse rather than a second
	// guess.
	if (
		!named &&
		!sourceText.includes("tests") &&
		!sourceText.includes(EXAMPLE_TAG)
	) {
		return false
	}

	let parsed = parseDocument(sourceText, filePath)

	return (
		parsed.program.tests !== null ||
		// NOTE: A file that writes no section may still promise something: an
		// `@example` in a `§§` block is a test of the file it was written in,
		// and a project's documentation is the last place a drifting example
		// should be allowed to sit unrun.
		hasDocumentationExamples(parsed.program) ||
		(named && containsErrors(parsed.diagnostics))
	)
}

// NOTE: Every file `essence test` will compile, from what was typed. Nothing
// typed means the working directory; a directory means every Essence source
// under it; anything else is a file or a glob, and is a file the caller named.
export async function discoverTestFiles(
	patterns: Array<string>,
	command: CommandSpec,
	programName: string = DEFAULT_PROGRAM_NAME,
	workingDirectory: string = process.cwd(),
	// NOTE: The project's own `essence.test.exclude`. It narrows the WALK and
	// nothing else: a file named on the command line was asked about by name,
	// and answering "there is a setting" to a direct question would be the
	// worse reading of both.
	exclude: Array<string> = [],
): Promise<Array<string>> {
	let walked = new Set<string>()
	let named = new Set<string>()
	// NOTE: Everything typed is read against the working directory rather than
	// against `process.cwd()`, so that the one parameter that says where the
	// project is says it for the walk, the globs and the named files alike.
	let against = (target: string): string =>
		path.resolve(workingDirectory, target)

	if (patterns.length === 0) {
		await collectEssenceFiles(
			workingDirectory,
			walked,
			isStdlibWalk(workingDirectory),
			exclude,
		)
	}

	for (let pattern of patterns) {
		let matches: Array<string> = [against(pattern)]

		if (looksLikeGlob(pattern)) {
			matches = []

			for await (let match of glob(pattern, { cwd: workingDirectory })) {
				matches.push(against(match))
			}

			if (matches.length === 0) {
				throw new UsageError(
					`No files match "${pattern}".`,
					command,
					`Check the pattern, or run ${programName} ${command.name} ` +
						"with no arguments to find every test.",
				)
			}

			matches.sort()
		}

		for (let match of matches) {
			if (await isDirectory(match)) {
				await collectEssenceFiles(
					match,
					walked,
					isStdlibWalk(match),
					exclude,
				)

				continue
			}

			named.add(canonicalPath(match))
		}
	}

	let candidates = [...new Set([...named, ...walked])].sort()
	let kept: Array<string> = []

	for (let candidate of candidates) {
		if (await keepsFile(candidate, named.has(candidate))) {
			kept.push(candidate)
		}
	}

	return kept
}
