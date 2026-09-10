import { glob, readdir, readFile, stat } from "node:fs/promises"
import * as path from "node:path"

import {
	isExcludedPath,
	skippedDirectories,
} from "@essence-lang/compiler/configuration"
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

// NOTE: And the word a file has to write before a contract run can find
// anything to test in it. Like the two above it can only rule a file OUT — the
// word may be written in a Comment, or be a Constant's name — so what follows
// it is a parse.
const NAMESPACE_KEYWORD = "namespace"

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
				!isExcludedPath(entryPath, exclude)
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

		if (!entry.name.endsWith(".es") || isExcludedPath(entryPath, exclude)) {
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
async function keepsFile(
	filePath: string,
	named: boolean,
	// NOTE: Whether the run reads a Namespace declaration as tests too — see
	// `--contracts`. It widens what a WALK keeps, because a file whose goals a
	// run is about to synthesize is a file with tests whether or not anybody
	// wrote a `tests { … }` block in it. A project's ordinary run is untouched.
	contracts: boolean,
): Promise<boolean> {
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
	//
	// NOTE: Under `--contracts` the text scan is the WHOLE answer: a Namespace
	// declaration promises goals, a declaration can not be written without the
	// word, and nearly every implementation file writes one — so a parse here
	// would be a parse of most of the project, serially, before the compile
	// parses it all again in parallel. A file the word turns up in that
	// declares nothing simply synthesizes zero goals; over-keeping is the
	// compile's cost once, under-parsing here was every run's.
	if (contracts && sourceText.includes(NAMESPACE_KEYWORD)) {
		return true
	}

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
// typed means the project — see `root` — a directory means every Essence source
// under it; anything else is a file or a glob, and is a file the caller named.
export async function discoverTestFiles(
	patterns: Array<string>,
	command: CommandSpec,
	programName: string = DEFAULT_PROGRAM_NAME,
	workingDirectory: string = process.cwd(),
	// NOTE: Where a walk that was given nothing starts: the directory the
	// project file sits in, which is what `essence test` typed with no argument
	// is about. Null where no project file governs the run, and then the
	// working directory answers as it always did. Handed over rather than read
	// here, because this is the walk and not the place a project is worked out
	// — the commands read the file once, at the head of a run, and hand what it
	// said to everything that needs it.
	//
	// NOTE: It moves the WALK and nothing else. A pattern that WAS typed — a
	// file, a glob, a directory — is still read against the working directory,
	// because a path typed into a shell means what that shell's directory says
	// it means.
	root: string | null = null,
	// NOTE: The project's own `exclude`. It narrows the WALK and nothing else:
	// a file named on the command line was asked about by name, and answering
	// "there is a setting" to a direct question would be the worse reading of
	// both.
	exclude: Array<string> = [],
	// NOTE: Whether this run reads a declaration as a test — see `keepsFile`.
	contracts: boolean = false,
): Promise<Array<string>> {
	let walked = new Set<string>()
	let named = new Set<string>()
	// NOTE: Everything typed is read against the working directory rather than
	// against `process.cwd()`, so that a caller driving this from somewhere
	// else — a spec, a run started in a nested directory — says once where the
	// globs and the named files are read from.
	let against = (target: string): string =>
		path.resolve(workingDirectory, target)

	if (patterns.length === 0) {
		let from = root ?? workingDirectory

		await collectEssenceFiles(from, walked, isStdlibWalk(from), exclude)
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
	// NOTE: Fanned out — each answer is one independent read (and sometimes a
	// parse), and a project of hundreds of files pays this walk at the head of
	// every run and every watch cycle. The order of the answers is the sorted
	// candidates', whatever order the disk answered in.
	let answers = await Promise.all(
		candidates.map((candidate) =>
			keepsFile(candidate, named.has(candidate), contracts),
		),
	)

	return candidates.filter((_, index) => answers[index] === true)
}
