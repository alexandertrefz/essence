import * as path from "node:path"

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
import { coverageReportFormats } from "@essence-lang/compiler/testing"

import { type OptionValues, UsageError } from "./args"
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

// NOTE: A configured `build.out` is a DIRECTORY, always: the setting says where
// a project's bundles are written, and a project can not name one output file
// for every source it builds. `--out` spells "a directory" with a trailing
// separator, so that is what the configured path arrives with — without it, a
// project with a single source and no `dist` yet would have its bundle written
// AS `dist`.
function asDirectory(out: string | null): string | undefined {
	if (out === null) {
		return undefined
	}

	return out.endsWith(path.sep) ? out : `${out}${path.sep}`
}

// NOTE: Where a setting meets the flag that says the same thing, for every
// setting that mirrors one — ONCE, so that no command derives "the flag unless
// the project said otherwise" a second way. Three rules cover all of them:
//
//   · A value a flag NAMES — `--out`, `--cases`, `--coverage-report`,
//     `--coverage-out` — is the flag's if it was given, the project's
//     otherwise, and the default of whatever reads it where neither said.
//   · A value a flag TURNS ON — `--sourcemap`, `--minify`, `--embed` — is on
//     when either says so, and off when the run said `--no-…`. Saying both
//     twins is refused: a run has to be one or the other, and guessing which
//     would write an artefact the reader did not ask for.
//   · The Optimiser runs unless something turned it off, and the passes left
//     out are the union of the two lists.
//
// What is NOT here: `--coverage` itself. Collecting coverage is a choice about
// one run — it compiles the whole project a second way — while the format and
// the directory a report goes to are facts about the project. A configured
// format is what a `--coverage` run writes, and turns nothing on by itself.
export function resolveProjectOptions(
	options: OptionValues,
	configuration: ProjectConfiguration,
	command: CommandSpec | null = null,
): OptionValues {
	let either = (
		name: string,
		asked: boolean,
		refused: boolean,
		configured: boolean,
	): boolean => {
		if (asked && refused) {
			throw new UsageError(
				`--${name} and --no-${name} contradict each other — say one.`,
				command,
			)
		}

		return refused ? false : asked || configured
	}
	let report = options.coverageReport ?? configuration.test.coverage.report

	// NOTE: A place to write and nothing to write there is a mistake that costs
	// a whole run to discover — the table appears, the directory does not, and
	// nothing says why. Refused rather than defaulted: which format was meant is
	// not something to guess at. It asks about the FLAG, because a configured
	// directory with no configured format is a project saying where a report
	// would go if one were asked for, which is not a mistake at all.
	if (options.coverageOut !== undefined && report === null) {
		throw new UsageError(
			"--coverage-out says where to write a report, and no report was asked for.",
			command,
			`Add --coverage-report ${coverageReportFormats.join(" or ")}.`,
		)
	}

	return {
		...options,
		out: options.out ?? asDirectory(configuration.build.out),
		sourcemap: either(
			"sourcemap",
			options.sourcemap,
			options.noSourcemap,
			configuration.build.sourcemap,
		),
		minify: either(
			"minify",
			options.minify,
			options.noMinify,
			configuration.build.minify,
		),
		embed: either(
			"embed",
			options.embed,
			options.noEmbed,
			configuration.build.embed,
		),
		noOptimise: options.noOptimise || !configuration.build.optimise,
		withoutOptimisation: [
			...new Set([
				...options.withoutOptimisation,
				...configuration.build.withoutOptimisations,
			]),
		],
		cases: options.cases ?? configuration.test.cases,
		coverageReport: report,
		coverageOut:
			options.coverageOut ?? configuration.test.coverage.out ?? undefined,
	}
}
