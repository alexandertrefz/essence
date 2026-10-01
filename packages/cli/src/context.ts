import {
	defaultConfiguration,
	type ProjectConfiguration,
} from "@essence-lang/compiler/configuration"

import manifest from "../package.json" with { type: "json" }
import type { OptionValues } from "./args"
import { DEFAULT_PROGRAM_NAME } from "./commands"
import type { HelpContext } from "./help"
import type { ReportContext } from "./report"
import { createTerminal, type Terminal } from "./terminal"
import {
	type ColorChoice,
	createPalette,
	createTheme,
	type Palette,
	supportsColor,
	supportsUnicode,
	type Theme,
} from "./theme"

// Imported from package.json, so `esc --version` matches what was published and
// a wrong path fails the build.
export const version: string = manifest.version

// Everything a command needs besides its arguments: where to write, how to style
// it and how loud to be. Resolved once, so a run agrees about colour.
export type CLIContext = {
	terminal: Terminal
	theme: Theme
	palette: Palette
	options: OptionValues
	// The project's settings, read once per invocation, so `test` and the compile
	// under it read the same file. See `resolveProjectOptions`.
	configuration: ProjectConfiguration
	report: ReportContext
	help: HelpContext
	version: string
	programName: string
}

export function colorChoiceFor(options: {
	color: boolean
	noColor: boolean
}): ColorChoice {
	if (options.noColor) {
		return "never"
	}

	if (options.color) {
		return "always"
	}

	return "auto"
}

export function createContext(
	options: OptionValues,
	programName: string = DEFAULT_PROGRAM_NAME,
	terminal: Terminal = createTerminal(),
	configuration: ProjectConfiguration = defaultConfiguration(),
): CLIContext {
	// Colour support follows stderr, where human-facing output goes when stdout is a
	// pipe.
	let theme = createTheme(
		supportsColor(colorChoiceFor(options), terminal.stderr) &&
			!options.json,
		supportsUnicode(),
	)
	let palette = createPalette(theme)

	return {
		terminal,
		theme,
		palette,
		options,
		configuration,
		version,
		programName,
		report: {
			terminal,
			theme,
			palette,
			verbose: options.verbose,
			quiet: options.quiet,
		},
		help: {
			palette,
			width: terminal.width,
			version,
			programName,
		},
	}
}
