import { glob, readFile, stat, writeFile } from "node:fs/promises"
import * as path from "node:path"

import {
	essenceFilesUnder,
	isExcludedPath,
	readProjectConfiguration,
	skippedDirectories,
} from "@essence-lang/compiler/configuration"

import { format, WIDTH } from "./index"

export const EXIT_SUCCESS = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

const DEFAULT_PROGRAM_NAME = "esfmt"

// The argument lists' width, gap included. Descriptions start three spaces past
// the longest list that shares their line.
const ARGUMENTS_WIDTH = "--check <files…>   ".length

function usage(programName: string): string {
	let entries: Array<{ arguments: string; description: Array<string> }> = [
		{ arguments: "<files…>", description: ["format each file in place"] },
		{
			arguments: "--check <files…>",
			description: [
				"report which files are not formatted; write nothing",
			],
		},
		{
			arguments: "--stdin",
			description: [
				"format standard input onto standard output",
				"(composes with --check; write nothing, report only)",
			],
		},
		{
			arguments: "--stdin-filepath <path>",
			description: [
				"the path standard input should be read as, so that",
				"path-dependent sources — the standard library's",
				"declarations — parse as themselves",
			],
		},
		{
			arguments: "--version",
			description: [`print ${programName}'s version`],
		},
	]

	// A longer program name, such as `essence format`, moves the description
	// column right until the longest description would pass `WIDTH`. An
	// argument list that does not fit before the column puts its description on
	// the next line.
	let widest = Math.max(
		...entries.flatMap((entry) =>
			entry.description.map((line) => line.length),
		),
	)
	let column = Math.min(
		2 + programName.length + 1 + ARGUMENTS_WIDTH,
		WIDTH - widest,
	)
	let indent = " ".repeat(column)
	let lines: Array<string> = []

	for (let entry of entries) {
		let invocation = `  ${programName} ${entry.arguments}`
		let [first, ...rest] = entry.description as [string, ...Array<string>]

		if (invocation.length < column) {
			lines.push(invocation.padEnd(column) + first)
		} else {
			lines.push(invocation, indent + first)
		}

		for (let line of rest) {
			lines.push(indent + line)
		}
	}

	return `${programName} — the Essence source formatter.

${lines.join("\n")}

Arguments may be paths, globs, or directories — a directory is every .es file
under it. A directory or a glob skips ${[...skippedDirectories].join(", ")}
and what the project's essence.json excludes; a file named on its own is always
formatted. There is nothing to configure: Essence is written with tabs, and
lines are laid out to fit ${WIDTH} columns.`
}

type Options = {
	check: boolean
	stdin: boolean
	stdinFilepath: string | null
	version: boolean
	help: boolean
	patterns: Array<string>
}

function parseArguments(argv: Array<string>): Options | string {
	let options: Options = {
		check: false,
		stdin: false,
		stdinFilepath: null,
		version: false,
		help: false,
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
			// Ends the parse, so an argument after it cannot get it rejected.
			options.help = true

			return options
		} else if (argument === "--") {
			// Everything after `--` is a file name, so a path starting with `-`
			// can be named. Only `essence format` passes a `--` through, since Bun
			// drops one right after the script path.
			options.patterns.push(...argv.slice(index + 1))

			return options
		} else if (argument.startsWith("-")) {
			return `Unknown option '${argument}'.`
		} else {
			options.patterns.push(argument)
		}
	}

	return options
}

const GLOB_CHARACTERS = /[*?[\]{}]/

// The directory a glob's walk starts in: its segments up to the first
// one that holds a pattern.
function globBase(pattern: string): string {
	let segments = pattern.split("/")
	let first = segments.findIndex((segment) => GLOB_CHARACTERS.test(segment))
	let fixed = segments.slice(0, first).join("/")

	return path.resolve(fixed === "" && pattern.startsWith("/") ? "/" : fixed)
}

// A glob leaves out what a walk from its base would: a match under a
// skipped directory below the base, or one the project excludes.
function walkLeavesOut(
	base: string,
	match: string,
	exclude: Array<string>,
): boolean {
	let directories = path.relative(base, match).split(path.sep).slice(0, -1)

	return (
		directories.some((name) => skippedDirectories.has(name)) ||
		isExcludedPath(match, exclude)
	)
}

async function resolveFiles(patterns: Array<string>): Promise<Array<string>> {
	let found = new Set<string>()
	// Found from the working directory, as every command finds it.
	let { exclude } = readProjectConfiguration()

	for (let pattern of patterns) {
		// A plain path is its own match, since `glob` would read a `[` in it as
		// a pattern. A named file is taken whatever its extension, even when the
		// project excludes it. Only a directory filters.
		if (!GLOB_CHARACTERS.test(pattern)) {
			let resolved = path.resolve(pattern)
			let isDirectory = await stat(resolved).then(
				(stats) => stats.isDirectory(),
				() => false,
			)

			if (!isDirectory) {
				found.add(resolved)

				continue
			}

			for (let match of await essenceFilesUnder(resolved, exclude)) {
				found.add(match)
			}

			continue
		}

		let base = globBase(pattern)

		for await (let match of glob(pattern)) {
			let resolved = path.resolve(match)

			if (!walkLeavesOut(base, resolved, exclude)) {
				found.add(resolved)
			}
		}
	}

	return [...found].sort()
}

function displayPath(file: string): string {
	let relative = path.relative(process.cwd(), file)

	return relative.startsWith("..") ? file : relative
}

// A syntax error is reported where the parser found it. Any other refusal is a
// formatter bug, and says so.
function reportRefusal(
	file: string,
	refusal: NonNullable<ReturnType<typeof format>["refusal"]>,
	programName: string,
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
		`${displayPath(file)}: ${refusal.message} The file was left unchanged; this is a bug in ${programName}.\n`,
	)
}

async function runStdin(
	check: boolean,
	stdinFilepath: string | null,
	programName: string,
): Promise<number> {
	// Read through the Node stream rather than `Bun.stdin`, so the
	// published formatter reads its input under either runtime.
	let chunks: Array<Buffer> = []

	for await (let chunk of process.stdin) {
		chunks.push(chunk as Buffer)
	}

	let source = Buffer.concat(chunks).toString("utf8")
	let documentPath =
		stdinFilepath === null ? undefined : path.resolve(stdinFilepath)
	let result = format(source, { documentPath })

	if (result.refusal !== null) {
		reportRefusal(
			documentPath === undefined ? "<stdin>" : documentPath,
			result.refusal,
			programName,
		)

		return EXIT_FAILURE
	}

	if (check) {
		return result.changed ? EXIT_FAILURE : EXIT_SUCCESS
	}

	process.stdout.write(result.text)

	return EXIT_SUCCESS
}

export async function run(
	argv: Array<string>,
	options: { programName?: string } = {},
): Promise<number> {
	let programName = options.programName ?? DEFAULT_PROGRAM_NAME
	let parsed = parseArguments(argv)

	if (typeof parsed === "string") {
		process.stderr.write(parsed + "\n\n" + usage(programName) + "\n")

		return EXIT_USAGE
	}

	if (parsed.help) {
		process.stdout.write(usage(programName) + "\n")

		return EXIT_SUCCESS
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

		return runStdin(parsed.check, parsed.stdinFilepath, programName)
	}

	if (parsed.patterns.length === 0) {
		process.stderr.write(usage(programName) + "\n")

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
			reportRefusal(file, result.refusal, programName)
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

	// Silent after a refusal, since a count of formatted files under it would
	// read as success.
	if (failed) {
		return EXIT_FAILURE
	}

	process.stdout.write(
		`Formatted ${written} of ${files.length} ${files.length === 1 ? "file" : "files"}.\n`,
	)

	return EXIT_SUCCESS
}
