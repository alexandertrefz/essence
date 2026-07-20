import {
	EXIT_FAILURE,
	EXIT_SUCCESS,
	EXIT_USAGE,
	runBuild,
	runCheck,
	runRun,
} from "./actions"
import { type Invocation, parseArguments, UsageError } from "./args"
import { findCommand } from "./commands"
import { type CLIContext, createContext, version } from "./context"
import { renderCommandHelp, renderOverview, renderUsageLine } from "./help"
import { toJSONUsageError } from "./json"
import { runWatch } from "./watch"

// NOTE: `run` returns an exit code instead of calling `process.exit`, so that
// the whole CLI can be driven from a test without ending the test runner along
// with it. The executable in bin/ is the only thing that exits.

function printUsageError(context: CLIContext, error: UsageError): void {
	let { palette, terminal, theme } = context

	if (context.options.json) {
		terminal.out(
			JSON.stringify(
				toJSONUsageError(error.message, {
					command: error.command?.name ?? "esc",
					version: context.version,
				}),
				null,
				2,
			),
		)

		return
	}

	terminal.err("")
	terminal.err(`  ${palette.error(theme.symbols.error)} ${error.message}`)

	if (error.suggestion !== null) {
		terminal.err(`  ${palette.muted(error.suggestion)}`)
	}

	if (error.command !== null) {
		terminal.err("")
		terminal.err(renderUsageLine(error.command, context.help))
		terminal.err(
			`  ${palette.muted("Help:")}  ${palette.accent(
				`esc help ${error.command.name}`,
			)}`,
		)
	} else {
		terminal.err("")
		terminal.err(
			`  ${palette.muted("Help:")}  ${palette.accent("esc help")}`,
		)
	}

	terminal.err("")
}

function showHelp(context: CLIContext, invocation: Invocation): number {
	// NOTE: `esc help build` and `esc build --help` are the same request, and
	// both land here. The command whose help to show is the explicit one when
	// there is one, and the argument to `help` otherwise.
	if (invocation.command.name === "help") {
		let requested = invocation.files[0]

		if (requested === undefined) {
			context.terminal.out(renderOverview(context.help))

			return EXIT_SUCCESS
		}

		let command = findCommand(requested)

		if (command === undefined) {
			throw new UsageError(
				`Unknown command "${requested}".`,
				null,
				'Run "esc help" to see every command.',
			)
		}

		context.terminal.out(renderCommandHelp(command, context.help))

		return EXIT_SUCCESS
	}

	if (invocation.commandWasExplicit) {
		context.terminal.out(
			renderCommandHelp(invocation.command, context.help),
		)

		return EXIT_SUCCESS
	}

	context.terminal.out(renderOverview(context.help))

	return EXIT_SUCCESS
}

async function dispatch(
	context: CLIContext,
	invocation: Invocation,
): Promise<number> {
	let { command, files, options, programArguments } = invocation

	switch (command.name) {
		case "help":
			return showHelp(context, invocation)

		case "check":
			return runCheck(context, command, files)

		case "run":
			return runRun(context, command, files, programArguments)

		case "watch":
			return runWatch(context, command, files, { emit: true })

		default:
			if (options.watch) {
				return runWatch(context, command, files, { emit: true })
			}

			return runBuild(context, command, files)
	}
}

export async function run(argv: Array<string>): Promise<number> {
	let invocation: Invocation
	let context: CLIContext

	try {
		invocation = parseArguments(argv)
		context = createContext(invocation.options)
	} catch (error) {
		// NOTE: The arguments could not be read, so there are no resolved
		// options to build a context from — a default one is used purely to
		// render the error. `--json` is read straight from the raw arguments,
		// because a caller that asked for JSON needs the failure in JSON too.
		let fallback = createContext({
			help: false,
			version: false,
			verbose: false,
			quiet: false,
			json: argv.includes("--json"),
			color: false,
			noColor: false,
			out: undefined,
			watch: false,
			execute: false,
			clear: false,
			sourcemap: false,
			minify: false,
			jobs: undefined,
		})

		if (error instanceof UsageError) {
			printUsageError(fallback, error)

			return EXIT_USAGE
		}

		throw error
	}

	if (invocation.options.version) {
		context.terminal.out(version)

		return EXIT_SUCCESS
	}

	// NOTE: A bare `esc` has nothing to compile and no command to run, so it
	// shows what it can do rather than an error — the arguments are not wrong,
	// they are missing.
	if (
		invocation.options.help ||
		(invocation.files.length === 0 && !invocation.commandWasExplicit)
	) {
		return showHelp(context, invocation)
	}

	try {
		return await dispatch(context, invocation)
	} catch (error) {
		if (error instanceof UsageError) {
			printUsageError(context, error)

			return EXIT_USAGE
		}

		let { palette, terminal, theme } = context

		terminal.err("")
		terminal.err(
			`  ${palette.error(theme.symbols.error)} ${palette.error(
				"Internal Compiler error",
			)}`,
		)
		terminal.err(
			`  ${palette.muted(
				error instanceof Error ? error.message : String(error),
			)}`,
		)

		if (error instanceof Error && error.stack !== undefined) {
			terminal.err("")

			for (let line of error.stack.split("\n").slice(1)) {
				terminal.err(palette.faint(line))
			}
		}

		terminal.err("")

		return EXIT_FAILURE
	}
}
