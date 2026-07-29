// NOTE: Commands and their Options are described once, here, and everything
// else is derived from that description: the parseArgs configuration, the help
// screens, the "unknown option" suggestions and the shell-facing usage lines.
// A flag that exists but is undocumented — or documented but unparsed — is not
// possible by construction.

// NOTE: The same table is rendered under several names — the binary is
// installed as `essence` and as `esc`, and user-facing text has to say the one
// that was typed. Every spec string that names the program writes this
// placeholder instead of a name, and the help renderer substitutes it; a second
// copy of the table per name would be a second table to keep true.
export const PROGRAM = "{program}"

// NOTE: The name to render when a caller does not say which. Both executables
// in bin/ name themselves, so this is only reached by something driving the CLI
// in-process — a spec, or a script written before the second name existed.
export const DEFAULT_PROGRAM_NAME = "esc"

export function withProgramName(text: string, programName: string): string {
	return text.replaceAll(PROGRAM, programName)
}

export type OptionType = "string" | "boolean"

export type OptionSpec = {
	name: string
	short?: string
	type: OptionType
	multiple?: boolean
	placeholder?: string
	summary: string
	details?: string
	defaultDescription?: string
	hidden?: boolean
}

export type Example = {
	command: string
	description: string
}

export type CommandSpec = {
	name: string
	aliases: Array<string>
	summary: string
	description: Array<string>
	usage: Array<string>
	options: Array<OptionSpec>
	examples: Array<Example>
	acceptsProgramArguments?: boolean
	// NOTE: A passthrough Command hands every argument after its name to another
	// tool, which parses them itself. Its Options are documented here so that
	// `help` can answer for it, but they are never parsed here — and the global
	// Options are not among them, because they reach nothing that reads them.
	passthrough?: true
}

export const globalOptions: Array<OptionSpec> = [
	{
		name: "help",
		short: "h",
		type: "boolean",
		summary: "Show help for a command and exit",
	},
	{
		name: "version",
		short: "v",
		type: "boolean",
		summary: "Print the compiler version and exit",
	},
	{
		name: "verbose",
		type: "boolean",
		summary: "Include per-stage timings and resolved paths",
	},
	{
		name: "quiet",
		short: "q",
		type: "boolean",
		summary: "Print only Diagnostics — no report, no progress",
	},
	{
		name: "json",
		type: "boolean",
		summary: "Emit a machine-readable report on stdout",
		details:
			"Diagnostics, timings and output sizes are written to stdout as a " +
			"single JSON document, and nothing else is. Intended for editors, " +
			"CI checks and scripts.",
	},
	{
		name: "color",
		type: "boolean",
		summary: "Force coloured output",
		details:
			"Colour is enabled automatically when stderr is a terminal. " +
			"NO_COLOR and FORCE_COLOR are honoured; this flag overrides both.",
	},
	{
		name: "no-color",
		type: "boolean",
		summary: "Disable coloured output",
		hidden: true,
	},
]

const outputOption: OptionSpec = {
	name: "out",
	short: "o",
	type: "string",
	placeholder: "path",
	summary: "Where to write the compiled JavaScript",
	details:
		"With a single input this is the output file. With several inputs it " +
		"is a directory, and each source keeps its own name. Missing parent " +
		"directories are created.",
	defaultDescription: "next to each source file",
}

const sourcemapOption: OptionSpec = {
	name: "sourcemap",
	type: "boolean",
	summary: "Emit a source map next to the output",
}

const minifyOption: OptionSpec = {
	name: "minify",
	type: "boolean",
	summary: "Minify the emitted JavaScript",
}

// NOTE: Optimisation is on for every build, and these two are how it is turned
// down. Both exist for the same reason the passes have names at all: when a
// Program misbehaves, the question "does it still do that with the optimiser
// off?" has to be answerable in one run, and "which pass is it?" in a few more.
const noOptimiseOption: OptionSpec = {
	name: "no-optimise",
	type: "boolean",
	summary: "Emit the Program as written, running no optimisation pass",
	details:
		"Every pass is on by default. This turns the whole phase off, for the " +
		"user Program and the standard library alike — the shape to compare " +
		"against when an optimised build misbehaves.",
}

const withoutOptimisationOption: OptionSpec = {
	name: "without-optimisation",
	type: "string",
	multiple: true,
	placeholder: "pass",
	summary: "Turn one optimisation pass off, by name",
	details:
		"Repeatable, and the name is the one the pass is documented under at " +
		"essence-language.org/optimisations. Every other pass keeps running: " +
		"no pass depends on another, so any set of them emits a correct " +
		"Program, and turning one off is how a suspect is named.",
}

const jobsOption: OptionSpec = {
	name: "jobs",
	short: "j",
	type: "string",
	placeholder: "count",
	summary: "How many files to compile in parallel",
	details:
		"Compilation of several files is spread across worker threads. Set to " +
		"1 to compile everything on the main thread, which makes stack traces " +
		"from Compiler crashes easier to read.",
	defaultDescription: "one per available CPU core, up to 8",
}

export const commands: Array<CommandSpec> = [
	{
		name: "build",
		aliases: ["b"],
		summary: "Compile Essence sources to JavaScript",
		description: [
			"Runs the full Compiler pipeline over every given source file and " +
				"writes the resulting JavaScript. The output is a self-contained " +
				"ES module: the parts of the Essence runtime a program actually " +
				"uses are bundled into it, so it can be executed by Bun or Node, " +
				"or loaded in a browser, without further installation.",
			"Every Module a source imports is compiled with it and bundled into " +
				"the same file, and its Diagnostics are reported under its own " +
				"name. A dependency named on the command line as well is " +
				"compiled once and gets an output of its own.",
			"Compilation stops at the first stage that reports an Error, and " +
				"every Diagnostic that stage found is shown. Warnings never stop " +
				"a build.",
		],
		usage: [
			`${PROGRAM} build <file...> [options]`,
			`${PROGRAM} <file...> [options]`,
		],
		options: [
			outputOption,
			{
				name: "watch",
				short: "w",
				type: "boolean",
				summary: "Rebuild whenever a source file changes",
			},
			{
				name: "execute",
				short: "e",
				type: "boolean",
				summary: "Execute the output once the build succeeds",
			},
			sourcemapOption,
			minifyOption,
			noOptimiseOption,
			withoutOptimisationOption,
			jobsOption,
		],
		examples: [
			{
				command: `${PROGRAM} HelloWorld.es`,
				description: "Compile one file to HelloWorld.js beside it",
			},
			{
				command: `${PROGRAM} build src/*.es -o dist/`,
				description: "Compile several files into a directory",
			},
			{
				command: `${PROGRAM} build App.es -o build/app.js --minify`,
				description: "Compile to an explicit path, minified",
			},
		],
	},
	{
		name: "run",
		aliases: [],
		summary: "Compile a source file and execute it immediately",
		description: [
			"Compiles a single source file and runs it, without leaving a " +
				"JavaScript file behind — the output is written to a temporary " +
				"directory that is removed once the program exits. Pass --out to " +
				"keep the compiled file instead.",
			"The program's output is streamed through as it is produced, and " +
				`${PROGRAM} exits with the program's own exit code. Arguments ` +
				"after a bare -- are handed to the program rather than read by " +
				`${PROGRAM}.`,
		],
		usage: [`${PROGRAM} run <file> [options] [-- <program arguments...>]`],
		options: [
			{
				...outputOption,
				summary: "Keep the compiled JavaScript at this path",
				details:
					"Without this the compiled file is scratch work: it is " +
					"written to a temporary directory and removed once the " +
					"program exits, leaving the source tree untouched.",
				defaultDescription: "a temporary directory",
			},
			sourcemapOption,
			minifyOption,
			noOptimiseOption,
			withoutOptimisationOption,
		],
		examples: [
			{
				command: `${PROGRAM} run HelloWorld.es`,
				description: "Compile and execute in one step",
			},
			{
				command: `${PROGRAM} run App.es -- --port 8080`,
				description: "Forward arguments to the compiled program",
			},
		],
		acceptsProgramArguments: true,
	},
	{
		name: "check",
		aliases: [],
		summary: "Type-check sources without writing any output",
		description: [
			"Runs the Parser, Enricher and Validator and reports every " +
				"Diagnostic they find, then stops — no JavaScript is generated " +
				"and nothing is written to disk.",
			"This is the fastest way to find out whether a Program is valid, " +
				"and the form intended for editors, pre-commit hooks and CI. " +
				"Combined with --json it produces a Diagnostic list that can be " +
				"consumed by other tools, each Diagnostic under the file it was " +
				"written in.",
			"Every Module a source imports is checked with it. A file given " +
				"twice over — named on the command line and imported by another " +
				"file that was — is checked once and reported once.",
		],
		usage: [`${PROGRAM} check <file...> [options]`],
		options: [jobsOption],
		examples: [
			{
				command: `${PROGRAM} check src/*.es`,
				description: "Type-check a whole directory of sources",
			},
			{
				command: `${PROGRAM} check src/*.es --json`,
				description: "Produce Diagnostics for another tool to read",
			},
		],
	},
	{
		name: "watch",
		aliases: ["w"],
		summary: "Recompile automatically whenever a source changes",
		description: [
			"Compiles the given sources, then stays running and recompiles " +
				"each one as it is saved. Rebuilds reuse warm worker threads, so " +
				"they are noticeably faster than repeated one-shot builds.",
			"Every Module the sources import is watched as well, and saving one " +
				"rebuilds the sources that import it rather than the Module " +
				"itself.",
			"While watching, press r to force a rebuild, c to clear the " +
				"screen and q — or Ctrl+C — to quit.",
		],
		usage: [
			`${PROGRAM} watch <file...> [options]`,
			`${PROGRAM} build <file...> --watch`,
		],
		options: [
			outputOption,
			{
				name: "execute",
				short: "e",
				type: "boolean",
				summary: "Execute the output after every successful rebuild",
			},
			{
				name: "clear",
				type: "boolean",
				summary: "Clear the screen before each rebuild",
			},
			sourcemapOption,
			minifyOption,
			noOptimiseOption,
			withoutOptimisationOption,
			jobsOption,
		],
		examples: [
			{
				command: `${PROGRAM} watch App.es`,
				description: "Rebuild App.js on every save",
			},
			{
				command: `${PROGRAM} watch App.es --execute --clear`,
				description: "Rebuild, clear, and re-run on every save",
			},
		],
	},
	{
		name: "format",
		aliases: ["fmt"],
		summary: "Format Essence sources in place",
		description: [
			"Rewrites every given source into Essence's one canonical layout: " +
				"tabs for indentation, and lines laid out to fit a fixed measure. " +
				"There is nothing to configure, so a formatted file reads the " +
				"same way for everyone who opens it.",
			"An argument may be a path, a glob, or a directory — a directory " +
				"stands for every .es file under it. A source that does not parse " +
				"is reported with the Diagnostic the Parser gave and left " +
				"untouched; formatting is refused rather than guessed at.",
		],
		usage: [
			`${PROGRAM} format <files...> [options]`,
			`${PROGRAM} format --check <files...>`,
		],
		options: [
			{
				name: "check",
				type: "boolean",
				summary: "Name the files that are not formatted; write nothing",
				details:
					"Every file that would change is named, and the exit code is " +
					"non-zero if there is one. This is the form intended for CI " +
					"checks and pre-commit hooks.",
			},
			{
				name: "stdin",
				type: "boolean",
				summary: "Format standard input onto standard output",
				details:
					"One Program is read from standard input, so no file " +
					"arguments are taken. Combined with --check nothing is " +
					"written and only the verdict is reported.",
			},
			{
				name: "stdin-filepath",
				type: "string",
				placeholder: "path",
				summary: "The path standard input should be read as",
				details:
					"Some sources are only themselves at a particular path — the " +
					"standard library's declarations are — so an Editor " +
					"formatting an unsaved buffer says where that buffer lives. " +
					"Only meaningful together with --stdin.",
			},
			{
				name: "version",
				type: "boolean",
				summary: "Print the Formatter's version and exit",
			},
		],
		examples: [
			{
				command: `${PROGRAM} format src/*.es`,
				description: "Format a directory of sources in place",
			},
			{
				command: `${PROGRAM} format --check src/`,
				description: "Fail if anything under src/ is unformatted",
			},
		],
		passthrough: true,
	},
	{
		name: "lsp",
		aliases: [],
		summary: "Start the Essence Language Server, speaking over stdio",
		description: [
			"Serves Diagnostics, hovers, completions, definitions, references, " +
				"renames and formatting to an Editor over the Language Server " +
				"Protocol, reading requests from standard input and writing " +
				"responses to standard output.",
			"This is started by an Editor rather than by hand: it prints nothing " +
				"a person would want to read, and stays running until the Editor " +
				"closes the connection. Whatever arguments the Editor's client " +
				"passes are left for the Server to read.",
		],
		usage: [`${PROGRAM} lsp`],
		options: [],
		examples: [],
		passthrough: true,
	},
	{
		name: "dap",
		aliases: [],
		summary: "Start the Essence Debug Adapter, speaking over stdio",
		description: [
			"Serves breakpoints, stepping, call stacks, variables and " +
				"evaluation to an Editor over the Debug Adapter Protocol, " +
				"reading requests from standard input and writing responses to " +
				"standard output. Programs are compiled with this compiler " +
				"before they are launched.",
			"This is started by an Editor rather than by hand: it prints " +
				"nothing a person would want to read, and stays running until " +
				"the debug session ends.",
		],
		usage: [`${PROGRAM} dap`],
		options: [],
		examples: [],
		passthrough: true,
	},
	{
		name: "help",
		aliases: [],
		summary: `Show help for ${PROGRAM} or for a single command`,
		description: [
			"Without an argument this prints the command overview. With a " +
				"command name it prints that command's full documentation, " +
				"including every option and a set of worked examples.",
		],
		usage: [`${PROGRAM} help [command]`],
		options: [],
		examples: [
			{
				command: `${PROGRAM} help build`,
				description: "Everything the build command can do",
			},
		],
	},
]

export function findCommand(name: string): CommandSpec | undefined {
	return commands.find(
		(command) => command.name === name || command.aliases.includes(name),
	)
}

// NOTE: The command an invocation falls back to when none is named, resolved
// here rather than looked up by name at each call site, so that it cannot be
// missing.
export const defaultCommand: CommandSpec = commands[0]

export function optionsFor(command: CommandSpec): Array<OptionSpec> {
	if (command.passthrough === true) {
		return command.options
	}

	return [...command.options, ...globalOptions]
}

export function visibleOptions(options: Array<OptionSpec>): Array<OptionSpec> {
	return options.filter((option) => option.hidden !== true)
}
