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

// What a project's `essence.json` means to a run: which commands read it, how
// its unreadable settings are reported, and how each setting meets its flag.

// The commands that read the project file. A check is about its files alone,
// and the servers and the Formatter read the file themselves.
const READING_COMMANDS = new Set(["build", "run", "watch", "test", "init"])

export function readsProjectConfiguration(command: CommandSpec): boolean {
	return READING_COMMANDS.has(command.name)
}

// The nearest project file at or above the working directory, read once per
// invocation. Commands handed file names read it too, for how bundles are built.
export function projectConfigurationFor(
	command: CommandSpec,
): ProjectConfiguration {
	return readsProjectConfiguration(command)
		? readProjectConfiguration()
		: defaultConfiguration()
}

// Reports what the project file could not read as Warnings, rendered against
// `essence.json` like any Diagnostic. Each setting falls back to its default. It
// is called once, from the entry point, so the Warnings always come first.
export function reportProjectSettings(
	context: CLIContext,
	command: CommandSpec,
): void {
	// A command that reads no settings says nothing about them, even under
	// `--verbose`.
	if (!readsProjectConfiguration(command)) {
		return
	}

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

// A configured `build.out` is always a directory, so it gains the trailing
// separator that marks `--out` as one. Otherwise a single bundle could be
// written as `dist`.
function asDirectory(out: string | null): string | undefined {
	if (out === null) {
		return undefined
	}

	return out.endsWith(path.sep) ? out : `${out}${path.sep}`
}

// Where the build, coverage and case-count settings meet the flags that mirror
// them. See "Settings and flags" in DEVELOPMENT.md.
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

	// A report directory without a report format is refused rather than guessed at.
	// Only the flag is checked: a configured directory alone is not a mistake.
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
