import {
	defaultConfiguration,
	PROJECT_FILE_NAME,
	type ProjectConfiguration,
	readProjectConfiguration,
} from "@essence-lang/compiler/configuration"
import {
	displayPath,
	renderDiagnostics,
} from "@essence-lang/compiler/diagnostics/render"

import type { CommandSpec } from "./commands"
import type { CLIContext } from "./context"

// NOTE: What a project's own `essence.json` means to a run, in one place: which
// commands read it, how what it could not read is reported, and how every
// setting it holds meets the flag that says the same thing. A command reads the
// answer off its context and nothing else — a second place deriving "the flag
// unless the project said otherwise" would be a second answer to give.

// NOTE: The commands a project file has something to say to. `check`, `format`,
// `lsp`, `dap` and `help` are not among them: nothing they do is a fact about a
// project — a check is about the files it was handed, and the two servers are
// handed a workspace by the editor, which reads the file itself. Reading it for
// them would cost a walk up the filesystem and print a Warning about a key
// nothing on that path would have read.
const READING_COMMANDS = new Set(["build", "run", "watch", "test", "init"])

export function readsProjectConfiguration(command: CommandSpec): boolean {
	return READING_COMMANDS.has(command.name)
}

// NOTE: Read from the working directory, once, for the whole invocation — the
// nearest file at or above where the run was started. A command that walks a
// project walks the directory this file sits in; a command handed file names
// still reads it, because how a bundle is built is a fact about the project the
// sources belong to.
export function projectConfigurationFor(
	command: CommandSpec,
): ProjectConfiguration {
	return readsProjectConfiguration(command)
		? readProjectConfiguration()
		: defaultConfiguration()
}

// NOTE: What the project file said that could not be read, rendered by the
// renderer every other Diagnostic goes through — one block per file, against
// that file's own text, so a mistake in `essence.json` is underlined in
// `essence.json` exactly as a mistake in a source is underlined in the source.
// They are Warnings: the run carries on with the setting at its default, which
// is what each of them says in its note.
//
// NOTE: Called once, from the entry point, rather than by each command. Every
// command that reads the file reports the same thing at the same moment — ahead
// of the work — and a command that grew a second copy of this loop would be a
// command whose Warnings appeared somewhere else in the output.
export function reportProjectSettings(context: CLIContext): void {
	let { configuration, palette, terminal, theme } = context

	for (let problem of configuration.problems) {
		terminal.err(
			renderDiagnostics(
				problem.diagnostics,
				problem.sourceText,
				displayPath(problem.filePath),
				{ color: theme.color },
			).replace(/\n$/, ""),
		)
	}

	if (!context.options.verbose) {
		return
	}

	terminal.err(
		`  ${palette.muted(
			configuration.filePath === null
				? `no ${PROJECT_FILE_NAME} governs the working directory`
				: `settings read from ${displayPath(configuration.filePath)}`,
		)}`,
	)
}
