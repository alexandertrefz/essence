import { glob, readFile, stat } from "node:fs/promises"
import * as path from "node:path"

import { essenceFilesUnder } from "@essence-lang/compiler/configuration"
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

// `esc build` compiles the files it is given. `essence test` walks a project with
// the Compiler's `essenceFilesUnder`, the walk the Formatter shares.

// A `.tests.es` file holds imports and a `tests` block for the Module it is
// named after. It is kept by name, so one that does not parse still reports.
const TESTS_SUFFIX = ".tests.es"

// A file without a `tests` block holds tests if a `§§` block has an `@example`.
// Finding the text only rules a file in for parsing.
const EXAMPLE_TAG = "@example"

// A contract run finds goals only in a file that writes this word. Under
// `--contracts` finding it keeps the file without a parse.
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

async function collectEssenceFiles(
	directory: string,
	found: Set<string>,
	// Whether a standard library source counts. A project walk never keeps one, but a
	// walk started inside the library keeps its `@example` tests.
	allowStdlib: boolean,
	// The project's `exclude`. Empty for a caller that read no project file.
	exclude: Array<string> = [],
): Promise<void> {
	for (let filePath of await essenceFilesUnder(directory, exclude)) {
		if (allowStdlib || !isStdlibDocument(filePath)) {
			found.add(canonicalPath(filePath))
		}
	}
}

// A named file is kept even when it cannot be read or parsed, so the compile
// says why. A walked file is kept only when it plainly holds tests.
async function keepsFile(
	filePath: string,
	named: boolean,
	// Whether the run tests Namespace declarations too. It widens what a walk keeps,
	// since a file with goals has tests without a `tests` block.
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

	// Under `--contracts` the text scan decides: nearly every implementation file
	// declares a Namespace, and parsing them all here would precede the compile's
	// own parse. A file that declares nothing yields no goals.
	if (contracts && sourceText.includes(NAMESPACE_KEYWORD)) {
		return true
	}

	// Without the word `tests` a file cannot open the section, so a walked file is
	// answered without a parse. With it, `tests` may be a Constant's name, so it
	// is parsed.
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
		// An `@example` in a `§§` block is a test of the file it is written in.
		hasDocumentationExamples(parsed.program) ||
		(named && containsErrors(parsed.diagnostics))
	)
}

// Every file `essence test` will compile. Nothing typed means the project, a
// directory means every source under it, and anything else is a named file or glob.
export async function discoverTestFiles(
	patterns: Array<string>,
	command: CommandSpec,
	programName: string = DEFAULT_PROGRAM_NAME,
	workingDirectory: string = process.cwd(),
	// Where a walk with nothing typed starts: the project file's directory, or the
	// working directory without one. It moves only the walk, since a typed path means
	// what the shell's directory says.
	root: string | null = null,
	// The project's `exclude`. It narrows only the walk: a file named on the command
	// line was asked about by name.
	exclude: Array<string> = [],
	// Whether this run tests declarations. See `keepsFile`.
	contracts: boolean = false,
): Promise<Array<string>> {
	let walked = new Set<string>()
	let named = new Set<string>()
	// Typed patterns are read against `workingDirectory` rather than
	// `process.cwd()`, so specs and nested runs can say where.
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
	// Every candidate is checked at once, since each is an independent read. The
	// answers keep the sorted candidates' order.
	let answers = await Promise.all(
		candidates.map((candidate) =>
			keepsFile(candidate, named.has(candidate), contracts),
		),
	)

	return candidates.filter((_, index) => answers[index] === true)
}
