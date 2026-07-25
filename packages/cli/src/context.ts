import manifest from "../package.json" with { type: "json" }
import type { OptionValues } from "./args"
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

// NOTE: Everything a command needs that is not its own arguments: where to
// write, how it may be styled, and how loud it should be. Resolved once at
// startup so that no two parts of a run can disagree about whether colour is
// available.

// NOTE: Read from package.json rather than duplicated here, so that
// `esc --version` can not drift away from the version that was published.
//
// NOTE: IMPORTED rather than read off a path counted out from this module.
// It was read, and the path was `../../package.json` — correct while this
// file sat one directory deeper, and silently wrong the moment it moved: the
// read failed, the `catch` answered "unknown", and `esc --version` said so to
// everyone who asked. An import is resolved by the module loader, so the same
// mistake is a build error rather than a string nobody notices.
export const version: string = manifest.version

export type CLIContext = {
	terminal: Terminal
	theme: Theme
	palette: Palette
	options: OptionValues
	report: ReportContext
	help: HelpContext
	version: string
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
	terminal: Terminal = createTerminal(),
): CLIContext {
	// NOTE: Colour support is decided from stderr rather than stdout, because
	// stderr is where the human-facing output goes when stdout is a pipe.
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
		version,
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
		},
	}
}
