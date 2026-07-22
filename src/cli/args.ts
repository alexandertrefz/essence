import { parseArgs, type ParseArgsConfig } from "node:util"

import { closestMatch } from "../helpers/index"
import {
	type CommandSpec,
	commands,
	defaultCommand,
	findCommand,
	type OptionSpec,
	optionsFor,
	visibleOptions,
} from "./commands"

// NOTE: Anything the user could have typed wrong is a UsageError, and every
// UsageError carries the command it happened in so the entry point can print
// the right usage line next to it — a bare "unknown option" with no context is
// the least helpful thing a CLI can say.
export class UsageError extends Error {
	readonly command: CommandSpec | null
	readonly suggestion: string | null

	constructor(
		message: string,
		command: CommandSpec | null = null,
		suggestion: string | null = null,
	) {
		super(message)
		this.name = "UsageError"
		this.command = command
		this.suggestion = suggestion
	}
}

export type OptionValues = {
	help: boolean
	version: boolean
	verbose: boolean
	quiet: boolean
	json: boolean
	color: boolean
	noColor: boolean
	out: string | undefined
	watch: boolean
	execute: boolean
	clear: boolean
	sourcemap: boolean
	minify: boolean
	jobs: number | undefined
}

export type Invocation = {
	command: CommandSpec
	commandWasExplicit: boolean
	options: OptionValues
	files: Array<string>
	programArguments: Array<string>
}

function toParseArgsOptions(
	options: Array<OptionSpec>,
): NonNullable<ParseArgsConfig["options"]> {
	let result: NonNullable<ParseArgsConfig["options"]> = {}

	for (let option of options) {
		result[option.name] = {
			type: option.type,
			...(option.short === undefined ? {} : { short: option.short }),
			...(option.multiple === true ? { multiple: true } : {}),
		}
	}

	return result
}

// NOTE: Everything after a bare `--` belongs to the compiled program, not to
// esc. Splitting it off before parsing keeps parseArgs from folding those
// arguments into the file list.
function splitProgramArguments(argv: Array<string>): {
	own: Array<string>
	program: Array<string>
} {
	let separator = argv.indexOf("--")

	if (separator === -1) {
		return { own: argv, program: [] }
	}

	return {
		own: argv.slice(0, separator),
		program: argv.slice(separator + 1),
	}
}

function resolveCommand(argv: Array<string>): {
	command: CommandSpec
	explicit: boolean
	rest: Array<string>
} {
	let first = argv[0]

	if (first === undefined || first.startsWith("-")) {
		return {
			command: defaultCommand,
			explicit: false,
			rest: argv,
		}
	}

	let command = findCommand(first)

	if (command !== undefined) {
		return { command, explicit: true, rest: argv.slice(1) }
	}

	// NOTE: A first argument that is not a command is a file name — `esc
	// HelloWorld.es` is the shorthand every other form is measured against.
	// Only something that looks like a command name but matches none is worth
	// suggesting a correction for; a path is passed through untouched.
	if (!first.includes(".") && !first.includes("/") && !first.includes("\\")) {
		let names = commands.flatMap((entry) => [entry.name, ...entry.aliases])
		let suggestion = closestMatch(first, names)

		if (suggestion !== null) {
			throw new UsageError(
				`Unknown command "${first}".`,
				null,
				`Did you mean "esc ${suggestion}"?`,
			)
		}
	}

	return {
		command: defaultCommand,
		explicit: false,
		rest: argv,
	}
}

function describeParseError(
	error: NodeJS.ErrnoException,
	command: CommandSpec,
): UsageError {
	let known = visibleOptions(optionsFor(command)).map(
		(option) => `--${option.name}`,
	)

	if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
		let match = /'([^']+)'/.exec(error.message ?? "")
		let flag = match?.[1] ?? "option"
		let suggestion = closestMatch(
			flag.replace(/^-+/, ""),
			known.map((name) => name.replace(/^-+/, "")),
		)

		return new UsageError(
			`Unknown option "${flag}" for esc ${command.name}.`,
			command,
			suggestion === null
				? `Run "esc help ${command.name}" to see every option.`
				: `Did you mean "--${suggestion}"?`,
		)
	}

	if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
		return new UsageError(
			error.message ?? "Invalid option value.",
			command,
			`Run "esc help ${command.name}" to see every option.`,
		)
	}

	return new UsageError(
		error.message ?? "Could not read the given arguments.",
		command,
	)
}

function readJobs(
	raw: string | undefined,
	command: CommandSpec,
): number | undefined {
	if (raw === undefined) {
		return undefined
	}

	let value = Number(raw)

	if (!Number.isInteger(value) || value < 1) {
		throw new UsageError(
			`--jobs expects a whole number of at least 1, but got "${raw}".`,
			command,
		)
	}

	return value
}

export function parseArguments(argv: Array<string>): Invocation {
	let { own, program } = splitProgramArguments(argv)
	let { command, explicit, rest } = resolveCommand(own)
	let parsed: ReturnType<typeof parseArgs>

	try {
		parsed = parseArgs({
			args: rest,
			options: toParseArgsOptions(optionsFor(command)),
			allowPositionals: true,
			strict: true,
		})
	} catch (error) {
		throw describeParseError(error as NodeJS.ErrnoException, command)
	}

	let values = parsed.values as Record<string, string | boolean | undefined>

	if (program.length > 0 && command.acceptsProgramArguments !== true) {
		throw new UsageError(
			`esc ${command.name} does not pass arguments to a program.`,
			command,
			"Only esc run forwards arguments after --.",
		)
	}

	return {
		command,
		commandWasExplicit: explicit,
		options: {
			help: values.help === true,
			version: values.version === true,
			verbose: values.verbose === true,
			quiet: values.quiet === true,
			json: values.json === true,
			color: values.color === true,
			noColor: values["no-color"] === true,
			out: values.out as string | undefined,
			watch: values.watch === true,
			execute: values.execute === true,
			clear: values.clear === true,
			sourcemap: values.sourcemap === true,
			minify: values.minify === true,
			jobs: readJobs(values.jobs as string | undefined, command),
		},
		files: parsed.positionals.map((positional) => String(positional)),
		programArguments: program,
	}
}
