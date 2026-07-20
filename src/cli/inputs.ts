import { glob, stat } from "node:fs/promises"
import * as path from "node:path"

import { UsageError } from "./args"
import type { CommandSpec } from "./commands"

// NOTE: Shells expand globs themselves, but not all of them, not on every
// platform, and not when the pattern is quoted to stop them from trying. The
// patterns that survive to here are expanded so that `esc build "src/*.es"`
// behaves the same everywhere.
const GLOB_PATTERN = /[*?[\]{}]/

export type ResolvedInput = {
	fileName: string
	bytes: number
}

export function looksLikeGlob(value: string): boolean {
	return GLOB_PATTERN.test(value)
}

export async function resolveInputFiles(
	patterns: Array<string>,
	command: CommandSpec,
): Promise<Array<string>> {
	if (patterns.length === 0) {
		throw new UsageError(
			`esc ${command.name} needs at least one Essence source file.`,
			command,
			"For example: esc " +
				`${command.name === "build" ? "" : `${command.name} `}` +
				"HelloWorld.es",
		)
	}

	let found: Array<string> = []

	for (let pattern of patterns) {
		if (!looksLikeGlob(pattern)) {
			found.push(pattern)

			continue
		}

		let matches: Array<string> = []

		for await (let match of glob(pattern)) {
			matches.push(match)
		}

		if (matches.length === 0) {
			throw new UsageError(
				`No files match "${pattern}".`,
				command,
				"Check the pattern, or pass the file names directly.",
			)
		}

		found.push(...matches.sort())
	}

	return [...new Set(found.map((file) => path.normalize(file)))]
}

export async function totalSourceBytes(
	fileNames: Array<string>,
): Promise<number> {
	let sizes = await Promise.all(
		fileNames.map(async (fileName) => {
			try {
				return (await stat(fileName)).size
			} catch {
				return 0
			}
		}),
	)

	return sizes.reduce((total, size) => total + size, 0)
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await stat(target)).isDirectory()
	} catch {
		return false
	}
}

export function defaultOutputFor(inputFileName: string): string {
	let directory = path.dirname(inputFileName)
	let base = path.basename(inputFileName, path.extname(inputFileName))

	return path.join(directory, `${base}.js`)
}

// NOTE: With one input `--out` names a file; with several it can only name a
// directory, since several sources cannot share one output path. A trailing
// separator, or an existing directory, makes it a directory in either case.
export async function resolveOutputFiles(
	inputFileNames: Array<string>,
	out: string | undefined,
	command: CommandSpec,
): Promise<Map<string, string>> {
	let outputs = new Map<string, string>()

	if (out === undefined) {
		for (let input of inputFileNames) {
			outputs.set(input, defaultOutputFor(input))
		}

		return outputs
	}

	let endsWithSeparator = out.endsWith("/") || out.endsWith(path.sep)
	let treatAsDirectory =
		endsWithSeparator ||
		inputFileNames.length > 1 ||
		(await isDirectory(out))

	if (!treatAsDirectory) {
		outputs.set(inputFileNames[0], path.normalize(out))

		return outputs
	}

	if (inputFileNames.length > 1 && !endsWithSeparator) {
		let existing = await isDirectory(out)

		if (!existing && path.extname(out) !== "") {
			throw new UsageError(
				`--out must name a directory when compiling several files, ` +
					`but "${out}" looks like a file.`,
				command,
				`Try --out ${path.dirname(out) || "."}/`,
			)
		}
	}

	// NOTE: Compiling several sources into one directory flattens them, so two
	// inputs with the same base name would silently overwrite each other.
	let claimed = new Map<string, string>()

	for (let input of inputFileNames) {
		let base = `${path.basename(input, path.extname(input))}.js`
		let target = path.join(out, base)
		let previous = claimed.get(target)

		if (previous !== undefined) {
			throw new UsageError(
				`${previous} and ${input} would both be written to ${target}.`,
				command,
				"Compile them separately, or rename one of them.",
			)
		}

		claimed.set(target, input)
		outputs.set(input, target)
	}

	return outputs
}
