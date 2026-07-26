import { glob, readFile, stat, writeFile } from "node:fs/promises"
import * as path from "node:path"

import { format, WIDTH } from "./index"

export const EXIT_SUCCESS = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

const USAGE = `esfmt — the Essence source formatter.

  esfmt <files…>           format each file in place
  esfmt --check <files…>   report which files are not formatted; write nothing
  esfmt --stdin            format standard input onto standard output
                           (composes with --check; write nothing, report only)
  esfmt --stdin-filepath <path>
                           the path standard input should be read as, so that
                           path-dependent sources — the standard library's
                           declarations — parse as themselves
  esfmt --version          print esfmt's version

Arguments may be paths, globs, or directories — a directory is every .es file
under it. There is nothing to configure: Essence is written with tabs, and
lines are laid out to fit ${WIDTH} columns.`

type Options = {
	check: boolean
	stdin: boolean
	stdinFilepath: string | null
	version: boolean
	patterns: Array<string>
}

function parseArguments(argv: Array<string>): Options | string {
	let options: Options = {
		check: false,
		stdin: false,
		stdinFilepath: null,
		version: false,
		patterns: [],
	}

	for (let index = 0; index < argv.length; index++) {
		let argument = argv[index] as string

		if (argument === "--check") {
			options.check = true
		} else if (argument === "--stdin") {
			options.stdin = true
		} else if (argument === "--stdin-filepath") {
			let value = argv[++index]

			if (value === undefined || value.startsWith("-")) {
				return "'--stdin-filepath' needs a path."
			}

			options.stdinFilepath = value
		} else if (argument === "--version") {
			options.version = true
		} else if (argument === "--help" || argument === "-h") {
			return USAGE
		} else if (argument.startsWith("-")) {
			return `Unknown option '${argument}'.`
		} else {
			options.patterns.push(argument)
		}
	}

	return options
}

async function resolveFiles(patterns: Array<string>): Promise<Array<string>> {
	let found = new Set<string>()

	for (let pattern of patterns) {
		// NOTE: A plain path is its own match — `glob` would treat characters
		// like `[` in a file name as a pattern rather than as the name. A named
		// file is taken as it is, whatever its extension; only a directory
		// filters, because there the author named a place rather than a file.
		if (!/[*?[\]{}]/.test(pattern)) {
			let resolved = path.resolve(pattern)
			let isDirectory = await stat(resolved).then(
				(stats) => stats.isDirectory(),
				() => false,
			)

			if (!isDirectory) {
				found.add(resolved)

				continue
			}

			for await (let match of glob(path.join(resolved, "**/*.es"))) {
				found.add(path.resolve(match))
			}

			continue
		}

		for await (let match of glob(pattern)) {
			found.add(path.resolve(match))
		}
	}

	return [...found].sort()
}

function displayPath(file: string): string {
	let relative = path.relative(process.cwd(), file)

	return relative.startsWith("..") ? file : relative
}

// NOTE: A syntax error is the file's own problem and is reported with the
// position the parser gave; anything else that stops a file being formatted is
// the formatter's, and says so plainly rather than blaming the source.
function reportRefusal(
	file: string,
	refusal: NonNullable<ReturnType<typeof format>["refusal"]>,
) {
	if (refusal.kind === "syntax") {
		for (let diagnostic of refusal.diagnostics) {
			if (diagnostic.severity !== "error") {
				continue
			}

			let where =
				diagnostic.position === null
					? displayPath(file)
					: `${displayPath(file)}:${diagnostic.position.start.line}:${diagnostic.position.start.column}`

			process.stderr.write(`${where}: ${diagnostic.message}\n`)
		}

		return
	}

	process.stderr.write(
		`${displayPath(file)}: ${refusal.message} The file was left unchanged; this is a bug in esfmt.\n`,
	)
}

async function runStdin(
	check: boolean,
	stdinFilepath: string | null,
): Promise<number> {
	let source = await new Response(Bun.stdin.stream()).text()
	let documentPath =
		stdinFilepath === null ? undefined : path.resolve(stdinFilepath)
	let result = format(source, { documentPath })

	if (result.refusal !== null) {
		reportRefusal(
			documentPath === undefined ? "<stdin>" : documentPath,
			result.refusal,
		)

		return EXIT_FAILURE
	}

	if (check) {
		return result.changed ? EXIT_FAILURE : EXIT_SUCCESS
	}

	process.stdout.write(result.text)

	return EXIT_SUCCESS
}

export async function run(argv: Array<string>): Promise<number> {
	let parsed = parseArguments(argv)

	if (typeof parsed === "string") {
		let isHelp = parsed === USAGE

		if (isHelp) {
			process.stdout.write(parsed + "\n")

			return EXIT_SUCCESS
		}

		process.stderr.write(parsed + "\n\n" + USAGE + "\n")

		return EXIT_USAGE
	}

	if (parsed.version) {
		let packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as { version: string }

		process.stdout.write(packageJson.version + "\n")

		return EXIT_SUCCESS
	}

	if (parsed.stdinFilepath !== null && !parsed.stdin) {
		process.stderr.write(
			"'--stdin-filepath' names what standard input is read as, so it only goes with '--stdin'.\n",
		)

		return EXIT_USAGE
	}

	if (parsed.stdin) {
		if (parsed.patterns.length > 0) {
			process.stderr.write(
				"'--stdin' reads one Program from standard input, so it takes no file arguments.\n",
			)

			return EXIT_USAGE
		}

		return runStdin(parsed.check, parsed.stdinFilepath)
	}

	if (parsed.patterns.length === 0) {
		process.stderr.write(USAGE + "\n")

		return EXIT_USAGE
	}

	let files = await resolveFiles(parsed.patterns)

	if (files.length === 0) {
		process.stderr.write("No files matched.\n")

		return EXIT_FAILURE
	}

	let failed = false
	let unformatted: Array<string> = []
	let written = 0

	for (let file of files) {
		let source: string

		try {
			source = await readFile(file, "utf8")
		} catch {
			process.stderr.write(`${displayPath(file)}: could not be read.\n`)
			failed = true

			continue
		}

		let result = format(source, { documentPath: file })

		if (result.refusal !== null) {
			reportRefusal(file, result.refusal)
			failed = true

			continue
		}

		if (!result.changed) {
			continue
		}

		if (parsed.check) {
			unformatted.push(file)

			continue
		}

		await writeFile(file, result.text, "utf8")
		written++
	}

	if (parsed.check) {
		for (let file of unformatted) {
			process.stdout.write(`${displayPath(file)}\n`)
		}

		if (unformatted.length > 0) {
			process.stderr.write(
				`\n${unformatted.length} of ${files.length} files are not formatted.\n`,
			)
		}

		return failed || unformatted.length > 0 ? EXIT_FAILURE : EXIT_SUCCESS
	}

	// NOTE: Silent when something was refused — the refusal has already been
	// written to stderr, and a count of what did get formatted underneath it
	// reads like the run succeeded.
	if (failed) {
		return EXIT_FAILURE
	}

	process.stdout.write(
		`Formatted ${written} of ${files.length} ${files.length === 1 ? "file" : "files"}.\n`,
	)

	return EXIT_SUCCESS
}
