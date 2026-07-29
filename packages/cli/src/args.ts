import { parseArgs, type ParseArgsConfig } from "node:util"

import { closestMatch } from "@essence-lang/compiler/helpers"
import {
	isOptimiserPassName,
	type OptimiserOptions,
	optimiserPassNames,
} from "@essence-lang/compiler/optimiser"

import {
	type CommandSpec,
	commands,
	DEFAULT_PROGRAM_NAME,
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
	noOptimise: boolean
	// NOTE: The pass names `--without-optimisation` was given, already checked
	// against the registry — an unknown one is a UsageError rather than a flag
	// that quietly does nothing.
	withoutOptimisation: Array<string>
	jobs: number | undefined
}

export type Invocation = {
	command: CommandSpec
	commandWasExplicit: boolean
	options: OptionValues
	files: Array<string>
	programArguments: Array<string>
	// NOTE: Every token after a passthrough Command's name, exactly as it was
	// typed — the delegate parses them itself, so nothing here is interpreted,
	// reordered, or split on a bare `--`. Empty for every other Command.
	rawArguments: Array<string>
}

// NOTE: The Options as they stand before anything has been read: what a
// passthrough Command leaves them at, and what an unreadable command line is
// reported with.
export const emptyOptions: OptionValues = {
	help: false,
	version: false,
	verbose: false,
	quiet: false,
	json: false,
	color: false,
	noColor: false,
	out: undefined,
	watch: false,
	execute: false,
	clear: false,
	sourcemap: false,
	minify: false,
	noOptimise: false,
	withoutOptimisation: [],
	jobs: undefined,
}

// NOTE: The two flags as the Compiler reads them. Nothing named means every
// pass runs, which is what a build the user said nothing about compiles with.
export function optimiserOptionsFor(options: OptionValues): OptimiserOptions {
	return {
		enabled: !options.noOptimise,
		disabledPasses: new Set(options.withoutOptimisation),
	}
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

function resolveCommand(
	argv: Array<string>,
	programName: string,
): {
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

	// NOTE: A first argument that is not a command is a file name —
	// `esc HelloWorld.es` is the shorthand every other form is measured against.
	// Only something that looks like a command name but matches none is worth
	// suggesting a correction for; a path is passed through untouched.
	if (!first.includes(".") && !first.includes("/") && !first.includes("\\")) {
		let names = commands.flatMap((entry) => [entry.name, ...entry.aliases])
		let suggestion = closestMatch(first, names)

		if (suggestion !== null) {
			throw new UsageError(
				`Unknown command "${first}".`,
				null,
				`Did you mean "${programName} ${suggestion}"?`,
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
	programName: string,
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
			`Unknown option "${flag}" for ${programName} ${command.name}.`,
			command,
			suggestion === null
				? `Run "${programName} help ${command.name}" to see every option.`
				: `Did you mean "--${suggestion}"?`,
		)
	}

	if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
		return new UsageError(
			error.message ?? "Invalid option value.",
			command,
			`Run "${programName} help ${command.name}" to see every option.`,
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

// NOTE: A pass name is checked HERE rather than left to the Optimiser, which
// would simply not find it in the registry and run everything — a misspelt name
// that silently changed nothing looks exactly like a pass that does not do what
// its name says. The message lists every valid name, because there is no other
// place a reader can be sent to that is as short as the answer itself.
function readDisabledPasses(
	raw: Array<string> | undefined,
	command: CommandSpec,
	programName: string,
): Array<string> {
	let names = raw ?? []

	for (let name of names) {
		if (isOptimiserPassName(name)) {
			continue
		}

		let suggestion = closestMatch(name, [...optimiserPassNames])

		throw new UsageError(
			`There is no optimisation pass named "${name}".`,
			command,
			suggestion === null
				? `The passes are: ${optimiserPassNames.join(", ")}.`
				: `Did you mean "${programName} ${command.name} --without-optimisation ${suggestion}"?`,
		)
	}

	return names
}

// NOTE: A passthrough Command is recognised before anything else is read: its
// arguments belong to the tool it delegates to, and reading them here — folding
// `--` away, or refusing a flag esc has never heard of — would break flags that
// are perfectly good ones over there. `--help` is the one exception: it is
// answered from esc's own Command table, so that `essence format --help` and
// `essence help format` are the same screen, and so that `essence lsp --help`
// cannot start a Server nobody is talking to.
function parsePassthrough(
	argv: Array<string>,
	command: CommandSpec,
): Invocation {
	let rawArguments = argv.slice(1)
	let help = rawArguments.includes("--help") || rawArguments.includes("-h")

	return {
		command,
		commandWasExplicit: true,
		options: { ...emptyOptions, help },
		files: [],
		programArguments: [],
		rawArguments,
	}
}

export function parseArguments(
	argv: Array<string>,
	programName: string = DEFAULT_PROGRAM_NAME,
): Invocation {
	let leading = argv[0] === undefined ? undefined : findCommand(argv[0])

	if (leading !== undefined && leading.passthrough === true) {
		return parsePassthrough(argv, leading)
	}

	let { own, program } = splitProgramArguments(argv)
	let { command, explicit, rest } = resolveCommand(own, programName)
	let parsed: ReturnType<typeof parseArgs>

	try {
		parsed = parseArgs({
			args: rest,
			options: toParseArgsOptions(optionsFor(command)),
			allowPositionals: true,
			strict: true,
		})
	} catch (error) {
		throw describeParseError(
			error as NodeJS.ErrnoException,
			command,
			programName,
		)
	}

	let values = parsed.values as Record<
		string,
		string | boolean | Array<string> | undefined
	>

	if (program.length > 0 && command.acceptsProgramArguments !== true) {
		throw new UsageError(
			`${programName} ${command.name} does not pass arguments to a program.`,
			command,
			`Only ${programName} run forwards arguments after --.`,
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
			noOptimise: values["no-optimise"] === true,
			withoutOptimisation: readDisabledPasses(
				values["without-optimisation"] as Array<string> | undefined,
				command,
				programName,
			),
			jobs: readJobs(values.jobs as string | undefined, command),
		},
		files: parsed.positionals.map((positional) => String(positional)),
		programArguments: program,
		rawArguments: [],
	}
}
