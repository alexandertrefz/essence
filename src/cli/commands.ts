// NOTE: Commands and their Options are described once, here, and everything
// else is derived from that description: the parseArgs configuration, the help
// screens, the "unknown option" suggestions and the shell-facing usage lines.
// A flag that exists but is undocumented — or documented but unparsed — is not
// possible by construction.

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
			"Compilation stops at the first stage that reports an Error, and " +
				"every Diagnostic that stage found is shown. Warnings never stop " +
				"a build.",
		],
		usage: ["esc build <file...> [options]", "esc <file...> [options]"],
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
			jobsOption,
		],
		examples: [
			{
				command: "esc HelloWorld.es",
				description: "Compile one file to HelloWorld.js beside it",
			},
			{
				command: "esc build src/*.es -o dist/",
				description: "Compile several files into a directory",
			},
			{
				command: "esc build App.es -o build/app.js --minify",
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
				"esc exits with the program's own exit code. Arguments after a " +
				"bare -- are handed to the program rather than read by esc.",
		],
		usage: ["esc run <file> [options] [-- <program arguments...>]"],
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
		],
		examples: [
			{
				command: "esc run HelloWorld.es",
				description: "Compile and execute in one step",
			},
			{
				command: "esc run App.es -- --port 8080",
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
				"consumed by other tools.",
		],
		usage: ["esc check <file...> [options]"],
		options: [jobsOption],
		examples: [
			{
				command: "esc check src/*.es",
				description: "Type-check a whole directory of sources",
			},
			{
				command: "esc check src/*.es --json",
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
			"While watching, press r to force a rebuild, c to clear the " +
				"screen and q — or Ctrl+C — to quit.",
		],
		usage: ["esc watch <file...> [options]", "esc build <file...> --watch"],
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
			jobsOption,
		],
		examples: [
			{
				command: "esc watch App.es",
				description: "Rebuild App.js on every save",
			},
			{
				command: "esc watch App.es --execute --clear",
				description: "Rebuild, clear, and re-run on every save",
			},
		],
	},
	{
		name: "help",
		aliases: [],
		summary: "Show help for esc or for a single command",
		description: [
			"Without an argument this prints the command overview. With a " +
				"command name it prints that command's full documentation, " +
				"including every option and a set of worked examples.",
		],
		usage: ["esc help [command]"],
		options: [],
		examples: [
			{
				command: "esc help build",
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
	return [...command.options, ...globalOptions]
}

export function visibleOptions(options: Array<OptionSpec>): Array<OptionSpec> {
	return options.filter((option) => option.hidden !== true)
}
