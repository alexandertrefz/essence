import { writeFile } from "node:fs/promises"
import * as path from "node:path"

import {
	PROJECT_FILE_NAME,
	PROJECT_SCHEMA_URL,
} from "@essence-lang/compiler/configuration"
import { displayPath } from "@essence-lang/compiler/diagnostics/render"

import { EXIT_FAILURE, EXIT_SUCCESS } from "./actions"
import { UsageError } from "./args"
import type { CommandSpec } from "./commands"
import type { CLIContext } from "./context"

// NOTE: What a project file looks like when a project has not said anything
// yet. Two settings, both at their defaults, each under the sentence that says
// what it is for — a starting point rather than an inventory: `essence help
// test` and `essence help build` document the rest, each beside the flag it
// mirrors, and a file listing every setting at its default is a file nobody
// reads twice.
//
// NOTE: Written as TEXT rather than stringified from an object, because the
// comments are half of what makes the file worth writing: a project file is
// where the reason behind a setting gets written down, and `JSON.stringify` can
// not carry one. The `$schema` is first so that an editor validating the file
// finds it before anything else it holds.
function template(): string {
	return `{
	"$schema": "${PROJECT_SCHEMA_URL}",

	// Directories under this project that are not its sources.
	"exclude": [],

	"test": {
		// Tags an everyday \`essence test\` leaves out; \`--tag\` brings one back.
		"skipTags": [],
		// Whether every run also tests what the declarations promise.
		"contracts": false
	}
}
`
}

// NOTE: The file marks the project, so where it is written is the whole
// decision: the working directory becomes a project root, and everything under
// it is that project's — what `essence test` walks with no arguments, and what
// the editor's Problems panel speaks for.
export async function runInit(
	context: CLIContext,
	command: CommandSpec,
): Promise<number> {
	let { palette, terminal, theme } = context
	let directory = process.cwd()
	let target = path.join(directory, PROJECT_FILE_NAME)
	let governing = context.configuration.filePath

	// NOTE: Refused rather than merged or overwritten. What is in the file is a
	// project's own decisions, comments and all, and a command that rewrote
	// them because it was run twice would be one nobody could run without
	// checking first.
	if (governing !== null && path.dirname(governing) === directory) {
		throw new UsageError(
			`${displayPath(target)} already exists.`,
			command,
			`Open it — \`${context.programName} help test\` and ` +
				`\`${context.programName} help build\` say what it may hold.`,
		)
	}

	try {
		await writeFile(target, template(), "utf8")
	} catch (error) {
		terminal.err("")
		terminal.err(
			`  ${palette.error(theme.symbols.error)} Could not write ${displayPath(
				target,
			)}: ${error instanceof Error ? error.message : String(error)}`,
		)
		terminal.err("")

		return EXIT_FAILURE
	}

	terminal.out("")
	terminal.out(
		`  ${palette.success(theme.symbols.success)} wrote ${palette.path(
			displayPath(target),
		)}`,
	)

	// NOTE: A project inside a project is allowed — a monorepo package that
	// runs its own tests is one — and it is also the shape of a mistake, a file
	// written one directory too deep. So it is written and said: from here on
	// the outer file's settings reach nothing under this directory, which is
	// the surprise if this was not meant.
	if (governing !== null) {
		terminal.out(
			`  ${palette.muted(
				`${displayPath(governing)} governs the directory above; ` +
					"nothing it says reaches this project now",
			)}`,
		)
	}

	terminal.out("")

	return EXIT_SUCCESS
}
