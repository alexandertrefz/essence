import {
	type CommandSpec,
	commands,
	findCommand,
	globalOptions,
	type OptionSpec,
	optionsFor,
	PROGRAM,
	visibleOptions,
	withProgramName,
} from "./commands"
import type { Palette } from "./theme"
import { visibleLength } from "./theme"

// NOTE: Help is rendered to a fixed comfortable measure rather than to the
// full terminal width — long lines of prose are hard to scan, and a help
// screen that reflows differently on every terminal is hard to talk about.
const MAX_WIDTH = 88
const INDENT = "  "

export type HelpContext = {
	palette: Palette
	width: number
	version: string
	programName: string
}

function measure(context: HelpContext): number {
	return Math.max(40, Math.min(context.width, MAX_WIDTH))
}

export function wrap(text: string, width: number, indent = ""): Array<string> {
	let words = text.split(/\s+/).filter((word) => word !== "")
	let lines: Array<string> = []
	let current = indent

	for (let word of words) {
		if (current === indent) {
			current += word

			continue
		}

		if (current.length + 1 + word.length > width) {
			lines.push(current)
			current = indent + word

			continue
		}

		current += ` ${word}`
	}

	if (current !== indent) {
		lines.push(current)
	}

	return lines
}

function heading(context: HelpContext, text: string): string {
	return context.palette.heading(text.toUpperCase())
}

// NOTE: `-o, --out <path>` — the exact string the user has to type, which is
// also what the two-column layout is aligned on. That layout pads away a
// missing short flag so every long name starts in the same column. The block
// layout must not: there is no column to line up with, and the padding would
// indent the name past the description written underneath it.
function signature(
	option: OptionSpec,
	palette: Palette,
	padShort = true,
): string {
	let short =
		option.short === undefined
			? padShort
				? "    "
				: ""
			: `${palette.flag(`-${option.short}`)}, `
	let name = palette.flag(`--${option.name}`)
	let value =
		option.placeholder === undefined
			? ""
			: ` ${palette.placeholder(`<${option.placeholder}>`)}`

	return `${short}${name}${value}`
}

function columns(
	rows: Array<{ left: string; right: string }>,
	context: HelpContext,
	gap = 3,
): Array<string> {
	let width = measure(context)
	let longest = rows.reduce(
		(max, row) => Math.max(max, visibleLength(row.left)),
		0,
	)
	let leftWidth = longest + gap
	let rightWidth = width - INDENT.length * 2 - leftWidth
	let lines: Array<string> = []

	for (let row of rows) {
		// NOTE: A row with nothing in its right column is written without the
		// padding that would otherwise leave trailing whitespace behind.
		if (row.right === "") {
			lines.push(`${INDENT}${INDENT}${row.left}`)

			continue
		}

		let padding = " ".repeat(leftWidth - visibleLength(row.left))
		let wrapped =
			rightWidth < 24 ? [row.right] : wrap(row.right, rightWidth)

		lines.push(`${INDENT}${INDENT}${row.left}${padding}${wrapped[0] ?? ""}`)

		for (let continuation of wrapped.slice(1)) {
			lines.push(
				`${INDENT}${INDENT}${" ".repeat(leftWidth)}${continuation}`,
			)
		}
	}

	return lines
}

function section(context: HelpContext, title: string): Array<string> {
	return ["", `${INDENT}${heading(context, title)}`, ""]
}

// NOTE: The placeholder is substituted as each spec string enters the renderer
// rather than once over the finished screen, so that wrapping and column widths
// are measured against the name the user will actually read.
function named(text: string, context: HelpContext): string {
	return withProgramName(text, context.programName)
}

function renderExamples(
	examples: CommandSpec["examples"],
	context: HelpContext,
): Array<string> {
	let { palette } = context
	let lines: Array<string> = []

	for (let [index, example] of examples.entries()) {
		if (index > 0) {
			lines.push("")
		}

		lines.push(
			`${INDENT}${INDENT}${palette.accent(named(example.command, context))}`,
		)

		for (let line of wrap(
			named(example.description, context),
			measure(context) - INDENT.length * 3,
		)) {
			lines.push(`${INDENT}${INDENT}${INDENT}${palette.muted(line)}`)
		}
	}

	return lines
}

// NOTE: The compact form, used where an option list is a reference rather than
// documentation — only the summary is shown, details live in the command help.
function renderCompactOptions(
	options: Array<OptionSpec>,
	context: HelpContext,
): Array<string> {
	return columns(
		visibleOptions(options).map((option) => ({
			left: signature(option, context.palette),
			right: named(option.summary, context),
		})),
		context,
	)
}

// NOTE: The expanded form, used in command help — summary, the long
// explanation, and what happens when the option is omitted.
function renderDetailedOptions(
	options: Array<OptionSpec>,
	context: HelpContext,
): Array<string> {
	let { palette } = context
	let width = measure(context) - INDENT.length * 3
	let lines: Array<string> = []

	for (let [index, option] of visibleOptions(options).entries()) {
		if (index > 0) {
			lines.push("")
		}

		lines.push(`${INDENT}${INDENT}${signature(option, palette, false)}`)

		for (let line of wrap(named(option.summary, context), width)) {
			lines.push(`${INDENT}${INDENT}${INDENT}${line}`)
		}

		if (option.details !== undefined) {
			for (let line of wrap(named(option.details, context), width)) {
				lines.push(`${INDENT}${INDENT}${INDENT}${palette.muted(line)}`)
			}
		}

		if (option.defaultDescription !== undefined) {
			lines.push(
				`${INDENT}${INDENT}${INDENT}${palette.faint(
					named(`Defaults to ${option.defaultDescription}.`, context),
				)}`,
			)
		}
	}

	return lines
}

export function renderOverview(context: HelpContext): string {
	let { palette } = context
	let lines: Array<string> = []

	lines.push("")
	lines.push(
		`${INDENT}${palette.strong(context.programName)} ${palette.faint(
			context.version,
		)} ${palette.muted("— the Essence toolchain")}`,
	)

	lines.push(...section(context, "usage"))
	lines.push(
		...columns(
			[
				{
					left: palette.accent(
						named(
							`${PROGRAM} <command> [file...] [options]`,
							context,
						),
					),
					right: "",
				},
				{
					left: palette.accent(
						named(`${PROGRAM} <file.es>`, context),
					),
					right: palette.muted(
						named(`same as: ${PROGRAM} build <file.es>`, context),
					),
				},
			],
			context,
		),
	)

	lines.push(...section(context, "commands"))
	lines.push(
		...columns(
			commands.map((command) => ({
				left: palette.accent(command.name),
				right:
					command.name === "build"
						? `${named(command.summary, context)} ${palette.faint(
								"(default)",
							)}`
						: named(command.summary, context),
			})),
			context,
		),
	)

	let buildCommand = findCommand("build")

	lines.push(...section(context, "common options"))
	lines.push(
		...renderCompactOptions(
			[...(buildCommand?.options ?? []), ...globalOptions],
			context,
		),
	)

	lines.push(...section(context, "examples"))
	lines.push(
		...renderExamples(
			[
				...(buildCommand?.examples.slice(0, 2) ?? []),
				{
					command: `${PROGRAM} run HelloWorld.es`,
					description: "Compile and execute in one step",
				},
				{
					command: `${PROGRAM} watch src/*.es`,
					description: "Rebuild automatically on every save",
				},
				{
					command: `${PROGRAM} format src/*.es`,
					description: "Format a directory of sources in place",
				},
			],
			context,
		),
	)

	lines.push("")
	lines.push(
		`${INDENT}${palette.muted("Run")} ${palette.accent(
			named(`${PROGRAM} help <command>`, context),
		)} ${palette.muted("for everything a single command can do.")}`,
	)
	lines.push("")

	return lines.join("\n")
}

export function renderCommandHelp(
	command: CommandSpec,
	context: HelpContext,
): string {
	let { palette } = context
	let width = measure(context) - INDENT.length * 2
	let lines: Array<string> = []

	lines.push("")
	lines.push(
		`${INDENT}${palette.strong(
			`${context.programName} ${command.name}`,
		)} ${palette.muted("—")} ${named(command.summary, context)}`,
	)

	if (command.aliases.length > 0) {
		lines.push(
			`${INDENT}${palette.faint(`alias: ${command.aliases.join(", ")}`)}`,
		)
	}

	lines.push(...section(context, "usage"))

	for (let usage of command.usage) {
		lines.push(`${INDENT}${INDENT}${palette.accent(named(usage, context))}`)
	}

	lines.push(...section(context, "description"))

	for (let [index, paragraph] of command.description.entries()) {
		if (index > 0) {
			lines.push("")
		}

		for (let line of wrap(
			named(paragraph, context),
			width - INDENT.length,
		)) {
			lines.push(`${INDENT}${INDENT}${line}`)
		}
	}

	let specificOptions = visibleOptions(command.options)

	if (specificOptions.length > 0) {
		lines.push(...section(context, "options"))
		lines.push(...renderDetailedOptions(specificOptions, context))
	}

	// NOTE: A passthrough Command's arguments are read by the tool it delegates
	// to, which knows nothing of --json or --quiet, so listing them here would
	// document flags that do nothing.
	if (command.passthrough !== true) {
		lines.push(...section(context, "global options"))
		lines.push(...renderCompactOptions(globalOptions, context))
	}

	if (command.examples.length > 0) {
		lines.push(...section(context, "examples"))
		lines.push(...renderExamples(command.examples, context))
	}

	lines.push("")

	return lines.join("\n")
}

export function renderUsageLine(
	command: CommandSpec,
	context: HelpContext,
): string {
	return `${INDENT}${context.palette.muted("Usage:")} ${context.palette.accent(
		named(command.usage[0], context),
	)}`
}

export function allOptionNames(command: CommandSpec): Array<string> {
	return optionsFor(command).map((option) => option.name)
}
