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
			"CI checks and scripts. A program run or --execute starts still " +
			"runs, with its own output routed to stderr so the document stays " +
			"alone on stdout.",
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

// NOTE: A build compiles what a Program DOES and drops what it proves, which is
// what keeps a `tests { … }` block free. This is the one way to ask for a
// bundle with the block in it, and it exists for the debugger: stepping through
// one test means having a bundle that holds it, and the adapter reaches the
// Compiler by spawning this command.
const testsOption: OptionSpec = {
	name: "tests",
	type: "boolean",
	summary: "Compile the tests section into the bundle",
	details:
		"The bundle exports its test registry as `$tests` and runs nothing on " +
		"its own — `essence test` is what runs a project's tests. What needs " +
		"this is a debugger, which has to load a bundle holding the test it is " +
		"stepping through.",
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

// NOTE: The one flag that changes what the OUTPUT IS rather than how it was
// made: a bundle a JavaScript host can load and marshal, and the Descriptor that
// says how. Off by default, because everything else `esc build` writes is a
// program to run and this is a Module to import.
//
// NOTE: Not on `run`, which spawns what it built — a bundle for a host to import
// is not a program to execute, and the two are asked for by different people.
const embedOption: OptionSpec = {
	name: "embed",
	type: "boolean",
	summary: "Build a bundle a JavaScript host can load and call",
	details:
		"The bundle exports the runtime's own Type key and value constructors " +
		"beside the Module, and a <name>.descriptor.json is written next to " +
		"it — the boundary between Essence and JavaScript, written down at " +
		"build time. loadPrebuilt from @essence-lang/client reads the pair and " +
		"answers with the Module as JavaScript, with no compiler in reach. " +
		"Without this the output is a program, and a host importing it gets " +
		"Essence's own values.",
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
			embedOption,
			testsOption,
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
			{
				command: `${PROGRAM} build App.es -o dist/app.js --embed`,
				description: "Build a bundle JavaScript can load and call",
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
			"The `tests { … }` block is checked too, which no build does: a " +
				"build drops the section, and the one command a project runs " +
				"to be told whether it is correct would otherwise say nothing " +
				"about a third of the file.",
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
			embedOption,
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
		name: "test",
		aliases: ["t"],
		summary: "Compile the tests and run them",
		description: [
			"Compiles every module that writes a tests { … } section — and " +
				"every *.tests.es file — with the tests enriched, then runs " +
				"them in this process and reports what held. Without " +
				"arguments every Essence source under the working directory is " +
				"searched, skipping .git, node_modules, dist, build and " +
				".claude. With arguments only those files, or every source " +
				"under a directory named as one.",
			"A failed assertion is reported as an ordinary Essence Diagnostic " +
				"— the asserted Expression underlined, and the value of every " +
				"sub-expression the Compiler recorded shown at the span it was " +
				"written at. Whatever a failing test printed is shown with it " +
				"rather than interleaved with the report.",
			"Selection happens here rather than in the source: --filter " +
				"matches a substring of a test's name, --tag runs only the " +
				"tests carrying one of the given tags and --skip-tag leaves " +
				"them out. --skip-tag wins over --tag. A project may skip tags " +
				"by default by writing them in the nearest package.json:",
			'    { "essence": { "test": { "skipTags": ["slow"] } } }',
			"A tag that list leaves out still runs when --tag asks for it by " +
				"name, which is how a nightly job runs what a working day " +
				"skips.",
			"The same key takes the directories the walk stays out of — a " +
				"corpus of deliberately broken sources, an example a book " +
				"quotes — written relative to the package.json that names " +
				"them:",
			'    { "essence": { "test": { "exclude": ["fixtures/broken"] } } }',
			"It narrows the WALK and nothing else: a file named on the " +
				"command line was asked about by name and is still compiled " +
				"and still reported.",
			"--watch stays up and re-runs on every save. Only the tests a " +
				"change reached run again — the entries whose module graph " +
				"holds the file that changed — and the report is cleared and " +
				"reprinted whole, so what is on screen is the state of the " +
				"project rather than a log. Press r to re-run everything, c " +
				"to clear and q — or Ctrl+C — to quit.",
			"--json writes the event stream instead of the report: one JSON " +
				"object per line on stdout and nothing else, the same stream " +
				"the editor's live session reads. Diagnostics stay on stderr. " +
				"Under --watch the stream carries on, one run-start … run-end " +
				"per re-run.",
			"--bench measures the benchmarks as well. A benchmark is timed " +
				"rather than judged, which takes hundreds of runs of its body " +
				"— so it is left out of an ordinary run and counted as " +
				"deselected. The first measurement is recorded as a baseline " +
				"in __benchmarks__ beside the source; later runs compare " +
				"against it, and one a quarter slower FAILS. Accept a new " +
				"time with --bench --update.",
			"--contracts tests what the declarations themselves promise: one " +
				"generated goal per Namespace Method, calling it with values " +
				"drawn from the declared Types and expecting the answer to " +
				"hold every conjunct of the return Type's refinement. A " +
				"project may ask for them by default in the nearest " +
				"package.json:",
			'    { "essence": { "test": { "contracts": true } } }',
			"--mutate answers the question coverage can not: coverage says a " +
				"line RAN, and mutation says a bug there would be CAUGHT. The " +
				"project is compiled once with counters in it and run once to " +
				"learn which tests reach which lines; then, for every site a " +
				"test reaches, the Compiler is asked to tell one deliberate " +
				"lie about the code and only the tests that reach it are run " +
				"again. A mutant nothing notices is named with the sentence " +
				"that says what was changed. --mutation-limit caps how many " +
				"are tried and --strict makes a survivor exit non-zero.",
			"--coverage compiles the tests with counters in them and reports " +
				"what ran: lines and branches as percentages, Match arms as " +
				"taken out of total, every branch and arm nothing reached " +
				"named by the Method it stands in, and every Case of a choice " +
				"no test ever built. --coverage-report writes lcov or json " +
				"beside the table, into --coverage-out.",
			"The exit code is 0 when everything that ran passed, 1 when a test " +
				"failed, and 2 when a run nobody narrowed still holds a " +
				"`focused` test — so a focus left behind while iterating can " +
				"not land unnoticed.",
		],
		usage: [
			`${PROGRAM} test [file...] [options]`,
			`${PROGRAM} test --tag slow`,
		],
		options: [
			{
				name: "watch",
				short: "w",
				type: "boolean",
				summary: "Stay up and re-run the tests a change reaches",
				details:
					"Only the entries whose module graph holds the file that " +
					"changed are compiled and run again; everything else keeps " +
					"the result it had. A `focused` test left behind never " +
					"fails a watching run — it is how iterating works.",
			},
			{
				name: "filter",
				short: "f",
				type: "string",
				placeholder: "text",
				summary: "Run only the tests whose name contains this",
				details:
					"Matched against the name as the report shows it, and " +
					"against the template it was written as — so a row of a " +
					"table test is selected by what fills its holes, and a " +
					"name with a hole in it is still selected by the text " +
					"around them. A filter that names no test says so.",
			},
			{
				name: "tag",
				type: "string",
				multiple: true,
				placeholder: "tag",
				summary: "Run only the tests carrying this tag",
				details:
					"Repeatable, and repeats are a union: --tag network --tag " +
					"slow runs everything carrying either. A test's tags are " +
					"its own plus every enclosing suite's.",
			},
			{
				name: "skip-tag",
				type: "string",
				multiple: true,
				placeholder: "tag",
				summary: "Leave out the tests carrying this tag",
				details:
					"Repeatable, and it wins over --tag. Tests left out are " +
					"counted rather than failed.",
			},
			{
				name: "bench",
				type: "boolean",
				summary: "Measure the benchmarks as well as running the tests",
				details:
					'Every `benchmark "…" { … }` is timed: its body is run in ' +
					"batches until one takes long enough to measure, several " +
					"batches are taken, and the middle one answers. The time " +
					"of a single run is compared against the baseline in " +
					"__benchmarks__ beside the source — a quarter slower fails " +
					"the test, a fifth faster passes and says so, and a " +
					"benchmark nothing has recorded records one and passes.",
			},
			{
				name: "contracts",
				type: "boolean",
				summary: "Test what a Namespace's own declarations promise",
				details:
					"A checked refinement is a property, and a Method that " +
					"writes one in its return Type has already stated the " +
					"property its answer holds. This runs it: the receiver and " +
					"every Argument are generated from the declared Types, the " +
					"Method is called, and the answer is expected to hold each " +
					"conjunct the return Type promises. A Method that never " +
					"comes back fails its goal whatever it declared — a " +
					"signature is a promise to answer over the domain it " +
					"names. The goals are reported under a `contracts` suite " +
					"beside the tests the project wrote, and a Method nothing " +
					"could build a goal for is named once per Namespace.",
			},
			{
				name: "no-contracts",
				type: "boolean",
				summary: "Run without goals whatever the project configured",
				details:
					"The way out of `essence.test.contracts` for one run: a " +
					"project that always tests its declarations still gets a " +
					"plain run on demand — while a broken declaration is " +
					"repaired, or when only the written tests are the " +
					"question. The flag wins over the setting in both " +
					"directions, and saying both flags at once is refused.",
			},
			{
				name: "mutate",
				type: "boolean",
				summary: "Report which deliberate bugs the tests catch",
				details:
					"Compiles the tests once, runs them once to learn which " +
					"tests reach which lines, and then compiles the project " +
					"again for every mutant — a comparison rotated a step, a " +
					"Case swapped for its sibling, an `if` turned inside out, " +
					"a literal nudged — running only the tests that reach the " +
					"site. A mutant no test notices is a SURVIVOR, and is " +
					"named with the sentence that says what was changed. The " +
					"run is information rather than a verdict and exits 0; " +
					"--strict makes a survivor a failure.",
			},
			{
				name: "mutation-limit",
				type: "string",
				placeholder: "count",
				summary: "How many mutants --mutate compiles at most",
				details:
					"Every covered site by default. A mutant costs a compile " +
					"and a run of the tests that reach it, so a large project " +
					"is worth narrowing — the sites are taken in file order, " +
					"so the same limit answers about the same mutants twice. " +
					"It caps what is JUDGED and nothing else: a site no test " +
					"reaches costs neither a compile nor a run, and is " +
					"reported whatever the limit. The report says where the " +
					"limit stopped and how many sites it left alone.",
			},
			{
				name: "strict",
				type: "boolean",
				summary: "Make a surviving mutant fail the run",
				details:
					"A mutation score is information, so --mutate exits 0 " +
					"whatever it found. This is what a CI job that holds a " +
					"project to its score asks for: a survivor exits 1, the " +
					"way a failing test does.",
			},
			{
				name: "coverage",
				type: "boolean",
				summary: "Report what the tests reached",
				details:
					"Compiles with an instrumentation pass on, so the run " +
					"counts every Statement, both sides of every branch, every " +
					"Match arm and every Choice Case a source constructs. " +
					"Because the language is exhaustive, an arm nothing took " +
					"and a Case nothing built are complete statements rather " +
					"than guesses — both are named in the report.",
			},
			{
				name: "coverage-report",
				type: "string",
				placeholder: "lcov|json",
				summary: "Write the coverage as a file as well as a table",
				details:
					"lcov writes the tracefile every coverage viewer reads, " +
					"with Match arms written as branches. json writes the " +
					"Compiler's own vocabulary — the arms, the doorways and " +
					"the scope each point stands in — which lcov has no way of " +
					"saying. Implies --coverage.",
			},
			{
				name: "coverage-out",
				type: "string",
				placeholder: "directory",
				summary: "Where --coverage-report writes",
				details:
					"Defaults to `coverage` under the working directory. The " +
					"file is called lcov.info or coverage.json after the " +
					"format.",
			},
			{
				name: "update",
				type: "boolean",
				summary: "Record every snapshot this run produced",
				details:
					"An inline `matches snapshot` is written back into the " +
					"source through the formatter, and a stored one into the " +
					"file's `__snapshots__` companion. A snapshot nothing has " +
					"recorded is written whether this is asked for or not — " +
					"what it asks for is REPLACING one that differs, which is " +
					"otherwise the failure.",
			},
			{
				name: "seed",
				type: "string",
				placeholder: "hex",
				summary: "Draw every property test's values from this seed",
				details:
					"A run makes one up and prints it beside a property that " +
					"failed, so the run that found a counterexample can be run " +
					"again exactly. Each test folds its own identity into the " +
					"seed, so replaying one test with --filter draws what the " +
					"whole run drew for it.",
			},
			{
				name: "cases",
				type: "string",
				placeholder: "count",
				summary: "How many values each property test runs for",
				details:
					"100 by default. A property that failed reports how many " +
					"cases it took and the smallest value it could shrink the " +
					"failure to.",
			},
			// NOTE: A test run compiles, so the two ways of turning the
			// Optimiser down belong here as much as they belong to `build` —
			// "does it still do that with the optimiser off?" is a question
			// asked of a failing TEST more often than of a build. Neither
			// touches --coverage: instrumentation is a pass being turned on,
			// and `--no-optimise --coverage` still counts.
			noOptimiseOption,
			withoutOptimisationOption,
			jobsOption,
		],
		examples: [
			{
				command: `${PROGRAM} test`,
				description: "Run every test under the working directory",
			},
			{
				command: `${PROGRAM} test Standings.es`,
				description: "Run one file's tests",
			},
			{
				command: `${PROGRAM} test -f leader`,
				description: "Run the tests whose name mentions the leader",
			},
			{
				command: `${PROGRAM} test --watch`,
				description: "Stay up and re-run what each save reaches",
			},
			{
				command: `${PROGRAM} test --skip-tag slow --json`,
				description: "Emit the event stream, leaving the slow ones out",
			},
			{
				command: `${PROGRAM} test --coverage-report lcov`,
				description: "Report what the tests reached, and write lcov",
			},
			{
				command: `${PROGRAM} test --update`,
				description: "Accept every snapshot this run produced",
			},
			{
				command: `${PROGRAM} test --bench`,
				description: "Measure the benchmarks against their baselines",
			},
			{
				command: `${PROGRAM} test --contracts`,
				description: "Also test what every declaration promises",
			},
			{
				command: `${PROGRAM} test --mutate src/Standings.es`,
				description: "Ask which deliberate bugs one file's tests catch",
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
