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
	// NOTE: Whether the bundle carries a runtime bridge, with a Descriptor
	// written beside it — see the Option's own details.
	embed: boolean
	// NOTE: Whether `essence build` compiles the tests section into the bundle
	// rather than dropping it. A debugger is what asks; see the Option.
	tests: boolean
	noOptimise: boolean
	// NOTE: The pass names `--without-optimisation` was given, already checked
	// against the registry — an unknown one is a UsageError rather than a flag
	// that quietly does nothing.
	withoutOptimisation: Array<string>
	jobs: number | undefined
	// NOTE: How `essence test` narrows a run — a substring of a test's name,
	// the tags to run, and the tags to leave out. Repeats are unions and
	// `skipTag` wins over `tag`; see the Command's own details.
	filter: string | undefined
	tag: Array<string>
	skipTag: Array<string>
	// NOTE: How `essence test` reports what the run REACHED. `coverage` turns
	// the instrumentation pass on; `coverageReport` names a file format to
	// write beside the table and implies it; `coverageOut` says where.
	coverage: boolean
	coverageReport: CoverageReportFormat | null
	coverageOut: string | undefined
	// NOTE: Whether the benchmarks of the run are measured as well. It ADDS to a
	// run rather than replacing it — everything that would have run still runs
	// — because a measurement of a body that is wrong is a number about nothing.
	bench: boolean
	// NOTE: Whether the run also tests what a Namespace's own declarations
	// promise — see the Option. It ADDS to a run the way `bench` does: every
	// written test still runs, and the synthesized goals run beside them.
	contracts: boolean
	// NOTE: Whether a snapshot that DIFFERS is recorded rather than reported.
	// One nothing has recorded is written either way — the first run of a new
	// snapshot is what records it. A benchmark reads it the same way: a
	// measurement outside its band is recorded rather than failed.
	update: boolean
	// NOTE: What every property test draws from, and how many values each of
	// them runs for. A run with no seed makes one up and reports it beside
	// whatever failed, which is what `--seed` reads back.
	seed: string | undefined
	cases: number | null
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
	embed: false,
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
	bench: false,
	contracts: false,
	update: false,
	seed: undefined,
	cases: null,
}

// NOTE: The two flags as the Compiler reads them. Nothing named means every
// pass runs, which is what a build the user said nothing about compiles with.
//
// NOTE: And `--coverage`, which is not one of the two: it turns an
// instrumentation pass ON rather than an optimisation off, and it is here
// because that pass lives in the registry and reads the Options. Only
// `essence test` offers the flag, so every other command asks with it false.
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

// NOTE: A tag is a bare lower-case name in the source, and `--tag`/`--skip-tag`
// match it exactly — so a spelling that could never have been written is a
// mistake worth refusing here rather than a filter that quietly selects
// nothing. The rule is the Enricher's own, asked from the reading side: a tag
// is what it is when it is lower-cased, and it is not empty.
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

// NOTE: How many cases a property test runs. It is read as text and checked
// here rather than taken as a number, because `node:util`'s parser has no
// numeric Option — and a `--cases banana` that silently ran a hundred would be
// a run nobody asked for.
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

// NOTE: The format names are the Compiler's, checked here so that a misspelt
// one is refused rather than written as the other format under the name that
// was asked for.
function readCoverageReport(
	raw: string | undefined,
	out: string | undefined,
	command: CommandSpec,
): CoverageReportFormat | null {
	if (raw === undefined) {
		// NOTE: A place to write and nothing to write there is a mistake that
		// costs a whole run to discover — the table appears, the directory
		// does not, and nothing says why. Refused rather than defaulted: which
		// format was meant is not something to guess at.
		if (out !== undefined) {
			throw new UsageError(
				"--coverage-out says where to write a report, and no report was asked for.",
				command,
				`Add --coverage-report ${coverageReportFormats.join(" or ")}.`,
			)
		}

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
			embed: values.embed === true,
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
			// NOTE: Asking for a report is asking for coverage — a written
			// file with nothing in it is not what anybody meant by naming a
			// format.
			coverage:
				values.coverage === true ||
				values["coverage-report"] !== undefined,
			coverageReport: readCoverageReport(
				values["coverage-report"] as string | undefined,
				values["coverage-out"] as string | undefined,
				command,
			),
			coverageOut: values["coverage-out"] as string | undefined,
			bench: values.bench === true,
			contracts: values.contracts === true,
			update: values.update === true,
			seed: values.seed as string | undefined,
			cases: readCases(values.cases as string | undefined, command),
		},
		files: parsed.positionals.map((positional) => String(positional)),
		programArguments: program,
		rawArguments: [],
	}
}
