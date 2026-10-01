import { styleText } from "node:util"

import { stripAnsi } from "@essence-lang/ariadne"

// Colour and Unicode support are resolved once into a Theme, so renderers agree
// and specs build a plain Theme without a Terminal.

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
		// A test's marks are lighter than a compilation's, so a tree of many tests reads
		// by shape.
		pass: string
		fail: string
		skip: string
		bullet: string
		arrow: string
		bar: string
		barEmpty: string
		line: string
	}
}

// `NO_COLOR` turns colour off and `FORCE_COLOR` on, whatever the TTY says. An
// explicit `--color` beats both.
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

// Older Windows consoles and terminals with a non-UTF-8 locale draw Braille and
// box characters as boxes, so they get ASCII.
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
	pass: "✓",
	fail: "✗",
	skip: "–",
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
	pass: "+",
	fail: "x",
	skip: "-",
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

// `styleText` spells `gray` as `blackBright`.
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

// Semantic wrappers, so a colour's meaning lives in one place.
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

// Re-exported from the Diagnostic renderer, which needs the same pattern.
export { stripAnsi }

export function visibleLength(text: string): number {
	return stripAnsi(text).length
}
