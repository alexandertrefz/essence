import { styleText } from "node:util"

import { stripAnsi } from "../ariadne/color"

// NOTE: Colour and Unicode support are resolved once at startup and passed
// around as a Theme, so that every renderer draws consistently and tests can
// construct a plain Theme instead of faking a Terminal.

export type ColorChoice = "auto" | "always" | "never"

export type Style =
	| "reset"
	| "bold"
	| "dim"
	| "italic"
	| "underline"
	| "red"
	| "green"
	| "yellow"
	| "blue"
	| "magenta"
	| "cyan"
	| "white"
	| "gray"

export type Theme = {
	color: boolean
	unicode: boolean
	symbols: {
		success: string
		error: string
		warning: string
		info: string
		pending: string
		bullet: string
		arrow: string
		bar: string
		barEmpty: string
		line: string
	}
}

// NOTE: The environment variable conventions implemented here are the ones
// tools are expected to honour: NO_COLOR disables colour regardless of TTY
// state, FORCE_COLOR enables it regardless — an explicit `--color` flag wins
// over both.
export function supportsColor(
	choice: ColorChoice,
	stream: NodeJS.WriteStream,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (choice === "always") {
		return true
	}

	if (choice === "never") {
		return false
	}

	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
		return false
	}

	if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") {
		return true
	}

	if (env.TERM === "dumb") {
		return false
	}

	return stream.isTTY === true
}

// NOTE: Windows consoles outside of Windows Terminal, and the handful of
// terminals that report a non-UTF-8 locale, render the Braille and box drawing
// characters as replacement boxes — those fall back to ASCII.
export function supportsUnicode(
	env: NodeJS.ProcessEnv = process.env,
	platform: string = process.platform,
): boolean {
	if (platform !== "win32") {
		let locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? ""

		return locale === "" || /UTF-?8$/i.test(locale)
	}

	return (
		env.WT_SESSION !== undefined ||
		env.TERMINAL_EMULATOR === "JetBrains-JediTerm" ||
		env.TERM_PROGRAM === "vscode"
	)
}

const unicodeSymbols: Theme["symbols"] = {
	success: "✔",
	error: "✖",
	warning: "⚠",
	info: "ℹ",
	pending: "◌",
	bullet: "·",
	arrow: "→",
	bar: "█",
	barEmpty: "░",
	line: "─",
}

const asciiSymbols: Theme["symbols"] = {
	success: "+",
	error: "x",
	warning: "!",
	info: "i",
	pending: "-",
	bullet: "*",
	arrow: "->",
	bar: "#",
	barEmpty: ".",
	line: "-",
}

export function createTheme(color: boolean, unicode: boolean): Theme {
	return {
		color,
		unicode,
		symbols: unicode ? unicodeSymbols : asciiSymbols,
	}
}

type StyleTextFormat = Parameters<typeof styleText>[0]

// NOTE: `gray` is not a styleText format name — it is spelled `blackBright`
// in the ANSI naming Node uses. Mapping it here keeps call sites readable.
function resolveStyles(styles: Array<Style>): StyleTextFormat {
	return styles.map((style) =>
		style === "gray" ? "blackBright" : style,
	) as StyleTextFormat
}

export function style(
	theme: Theme,
	styles: Style | Array<Style>,
	text: string,
): string {
	if (!theme.color || text === "") {
		return text
	}

	let list = Array.isArray(styles) ? styles : [styles]

	return styleText(resolveStyles(list), text, { validateStream: false })
}

// NOTE: Semantic wrappers, so that the meaning of a colour lives in one place
// and the palette can be retuned without touching every renderer.
export function createPalette(theme: Theme) {
	let apply =
		(styles: Style | Array<Style>) =>
		(text: string): string =>
			style(theme, styles, text)

	return {
		success: apply("green"),
		error: apply("red"),
		warning: apply("yellow"),
		accent: apply("cyan"),
		heading: apply(["bold"]),
		strong: apply("bold"),
		muted: apply("dim"),
		faint: apply("gray"),
		flag: apply("cyan"),
		placeholder: apply(["dim", "italic"]),
		path: apply("cyan"),
		output: apply("green"),
		number: apply("magenta"),
	}
}

export type Palette = ReturnType<typeof createPalette>

// NOTE: Re-exported rather than reimplemented — the Diagnostic renderer needs
// the same operation, and two copies of an escape-sequence pattern is one copy
// too many.
export { stripAnsi }

export function visibleLength(text: string): number {
	return stripAnsi(text).length
}
