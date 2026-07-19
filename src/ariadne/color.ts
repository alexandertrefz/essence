// ANSI terminal colors, replacing the `yansi` crate used by the original
// ariadne. Only foreground colors are needed by the renderer.

export type Color =
	| { type: "named"; code: number }
	| { type: "fixed"; index: number }
	| { type: "rgb"; red: number; green: number; blue: number }

function named(code: number): Color {
	return { type: "named", code }
}

export const Colors = {
	black: named(30),
	red: named(31),
	green: named(32),
	yellow: named(33),
	blue: named(34),
	magenta: named(35),
	cyan: named(36),
	white: named(37),

	fixed(index: number): Color {
		return { type: "fixed", index }
	},

	rgb(red: number, green: number, blue: number): Color {
		return { type: "rgb", red, green, blue }
	},
}

function foregroundCode(color: Color): string {
	switch (color.type) {
		case "named":
			return `${color.code}`
		case "fixed":
			return `38;5;${color.index}`
		case "rgb":
			return `38;2;${color.red};${color.green};${color.blue}`
	}
}

// Wraps `text` in ANSI escape codes for the given foreground color. A `null`
// color leaves the text unstyled, mirroring `Option<Style>` upstream.
export function paint(text: string, color: Color | null): string {
	if (color === null || text === "") {
		return text
	}

	return `\x1b[${foregroundCode(color)}m${text}\x1b[0m`
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the point
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "")
}
