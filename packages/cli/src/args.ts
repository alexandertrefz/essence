import { parseArgs, type ParseArgsConfig } from "node:util"

import { closestMatch } from "@essence-lang/compiler/helpers"
import {
	isOptimiserPassName,
	type OptimiserOptions,
	optimiserPassNames,
} from "@essence-lang/compiler/optimiser"
import {
	type CoverageReportFormat,
	coverageReportFormats,
	isCoverageReportFormat,
} from "@essence-lang/compiler/testing"

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

// A mistake the user could have typed. It carries its Command, so the entry
// point prints the right usage line beside it.
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
	// Flags a project may also set, each with its negation. `resolveProjectOptions`
	// combines them with the settings and refuses both twins at once.
	sourcemap: boolean
	noSourcemap: boolean
	minify: boolean
	noMinify: boolean
	// Whether the bundle carries a runtime bridge, with a Descriptor beside it.
	embed: boolean
	noEmbed: boolean
	// Whether `essence build` keeps the tests section, as a debugger asks.
	tests: boolean
	noOptimise: boolean
	// The pass names `--without-optimisation` was given, already checked against
	// the registry.
	withoutOptimisation: Array<string>
	jobs: number | undefined
	// How `essence test` narrows a run. `filter` is a substring of a test's
	// suites and name joined by `/`.
	filter: string | undefined
	tag: Array<string>
	skipTag: Array<string>
	// `coverage` turns the instrumentation pass on. `coverageReport` names a file
	// format to write beside the table, and `coverageOut` a directory.
	coverage: boolean
	coverageReport: CoverageReportFormat | null
	coverageOut: string | undefined
	// Whether the run asks what its tests would catch. `mutationLimit` caps how many
	// mutants are compiled; null means every covered site.
	mutate: boolean
	mutationLimit: number | null
	// Whether a surviving mutant fails the run. Without it, `--mutate` exits 0.
	strict: boolean
	// Whether benchmarks are measured too. Everything else still runs, since a
	// measurement of a wrong body means nothing.
	bench: boolean
	// Whether the run also tests what a Namespace's declarations promise, beside
	// every written test.
	contracts: boolean
	noContracts: boolean
	// Whether a differing snapshot, or a measurement outside its band, is recorded
	// rather than failed. A new snapshot is recorded either way.
	update: boolean
	// The seed property tests draw from, and how many cases each runs. A run without
	// a seed makes one and reports it beside any failure.
	seed: string | undefined
	cases: number | null
}

export type Invocation = {
	command: CommandSpec
	commandWasExplicit: boolean
	options: OptionValues
	files: Array<string>
	programArguments: Array<string>
	// Every token after a passthrough Command's name, exactly as typed, for its
	// delegate to parse. Empty for every other Command.
	rawArguments: Array<string>
}

// The Options before anything is read: what a passthrough Command leaves them at,
// and what an unreadable command line is reported with.
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
	noSourcemap: false,
	minify: false,
	noMinify: false,
	embed: false,
	noEmbed: false,
	tests: false,
	noOptimise: false,
	withoutOptimisation: [],
	jobs: undefined,
	filter: undefined,
	tag: [],
	skipTag: [],
	coverage: false,
	coverageReport: null,
	coverageOut: undefined,
	mutate: false,
	mutationLimit: null,
	strict: false,
	bench: false,
	contracts: false,
	noContracts: false,
	update: false,
	seed: undefined,
	cases: null,
}

// The optimisation flags as the Compiler reads them; none named runs every pass.
// `--coverage` turns the instrumentation pass on, and only `essence test` offers
// it.
export function optimiserOptionsFor(options: OptionValues): OptimiserOptions {
	return {
		enabled: !options.noOptimise,
		disabledPasses: new Set(options.withoutOptimisation),
		coverage: options.coverage,
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

// Everything after a bare `--` belongs to the compiled program. Splitting it off
// first keeps `parseArgs` from folding it into the file list.
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

	// A first argument that is not a Command is a file name, as in
	// `esc HelloWorld.es`. Only something that looks like a Command name gets a
	// suggestion.
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

// A tag in the source is lower-case and not empty, so `--tag` refuses any other
// spelling rather than silently selecting nothing.
function readTags(
	raw: Array<string> | undefined,
	flag: string,
	command: CommandSpec,
): Array<string> {
	let names = raw ?? []

	for (let name of names) {
		if (name === "") {
			throw new UsageError(`${flag} expects a tag.`, command)
		}

		if (name !== name.toLowerCase()) {
			throw new UsageError(
				`${flag} expects a lower-case tag, but got "${name}".`,
				command,
				`Did you mean "${flag} ${name.toLowerCase()}"?`,
			)
		}
	}

	return names
}

// How many cases a property test runs, read as text because `parseArgs` has no
// numeric Options. A malformed count is refused.
function readCases(
	raw: string | undefined,
	command: CommandSpec,
): number | null {
	if (raw === undefined) {
		return null
	}

	let count = Number(raw)

	if (!Number.isSafeInteger(count) || count < 1) {
		throw new UsageError(
			`--cases expects a whole number of at least 1, but got "${raw}".`,
			command,
			"Try --cases 100.",
		)
	}

	return count
}

// Read like `--cases`. A limit of zero would judge nothing.
function readMutationLimit(
	raw: string | undefined,
	command: CommandSpec,
): number | null {
	if (raw === undefined) {
		return null
	}

	let count = Number(raw)

	if (!Number.isSafeInteger(count) || count < 1) {
		throw new UsageError(
			`--mutation-limit expects a whole number of at least 1, but got "${raw}".`,
			command,
			"Try --mutation-limit 50.",
		)
	}

	return count
}

// Refuses a misspelt format name. A directory with no format is refused later,
// by `resolveProjectOptions`, since a project file may name the format.
function readCoverageReport(
	raw: string | undefined,
	command: CommandSpec,
): CoverageReportFormat | null {
	if (raw === undefined) {
		return null
	}

	if (!isCoverageReportFormat(raw)) {
		throw new UsageError(
			`There is no coverage report format called "${raw}".`,
			command,
			`Try ${coverageReportFormats.join(" or ")}.`,
		)
	}

	return raw
}

// Checked here, since the Optimiser would silently ignore a misspelt pass. The
// message lists every valid name.
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

// A passthrough Command's arguments belong to its delegate, so they are not read.
// Only `--help` is answered from esc's own Command table, so `essence lsp --help`
// starts no Server.
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
			noSourcemap: values["no-sourcemap"] === true,
			minify: values.minify === true,
			noMinify: values["no-minify"] === true,
			embed: values.embed === true,
			noEmbed: values["no-embed"] === true,
			tests: values.tests === true,
			noOptimise: values["no-optimise"] === true,
			withoutOptimisation: readDisabledPasses(
				values["without-optimisation"] as Array<string> | undefined,
				command,
				programName,
			),
			jobs: readJobs(values.jobs as string | undefined, command),
			filter: values.filter as string | undefined,
			tag: readTags(
				values.tag as Array<string> | undefined,
				"--tag",
				command,
			),
			skipTag: readTags(
				values["skip-tag"] as Array<string> | undefined,
				"--skip-tag",
				command,
			),
			// Naming a report format asks for coverage.
			coverage:
				values.coverage === true ||
				values["coverage-report"] !== undefined,
			coverageReport: readCoverageReport(
				values["coverage-report"] as string | undefined,
				command,
			),
			coverageOut: values["coverage-out"] as string | undefined,
			mutate: values.mutate === true,
			mutationLimit: readMutationLimit(
				values["mutation-limit"] as string | undefined,
				command,
			),
			strict: values.strict === true,
			bench: values.bench === true,
			contracts: values.contracts === true,
			noContracts: values["no-contracts"] === true,
			update: values.update === true,
			seed: values.seed as string | undefined,
			cases: readCases(values.cases as string | undefined, command),
		},
		files: parsed.positionals.map((positional) => String(positional)),
		programArguments: program,
		rawArguments: [],
	}
}
