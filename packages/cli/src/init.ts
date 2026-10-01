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

// A new project's file: two settings at their defaults, each under a comment
// saying what it is for. `essence help` documents the rest. It is text, since
// JSON cannot hold comments, with `$schema` first for editors. The website's spec
// checks the documentation shows it as written.
export function projectFileTemplate(): string {
	return `{
	"$schema": "${PROJECT_SCHEMA_URL}",

	// Directories under this project that are not its sources.
	"exclude": [],

	"test": {
		// Tags an everyday \`essence test\` leaves out; \`--tag\` brings one back.
		"skipTags": []
	}
}
`
}

// The file marks the project root: what `essence test` walks with no arguments,
// and what the editor's Problems panel covers.
export async function runInit(
	context: CLIContext,
	command: CommandSpec,
): Promise<number> {
	let { palette, terminal, theme } = context
	let directory = process.cwd()
	let target = path.join(directory, PROJECT_FILE_NAME)
	let governing = context.configuration.filePath

	// An existing file is never merged or overwritten, since it holds the project's
	// own decisions.
	if (governing !== null && path.dirname(governing) === directory) {
		throw new UsageError(
			`${displayPath(target)} already exists.`,
			command,
			`Open it — \`${context.programName} help test\` and ` +
				`\`${context.programName} help build\` say what it may hold.`,
		)
	}

	try {
		await writeFile(target, projectFileTemplate(), "utf8")
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

	// A project inside a project is allowed, as for a monorepo package, but may be a
	// mistake. So the command says that the outer file no longer reaches here.
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
