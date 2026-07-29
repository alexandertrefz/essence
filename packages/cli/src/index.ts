import {
	EXIT_FAILURE,
	EXIT_SUCCESS,
	EXIT_USAGE,
	runBuild,
	runCheck,
	runRun,
} from "./actions"
import {
	emptyOptions,
	type Invocation,
	parseArguments,
	UsageError,
} from "./args"
import { DEFAULT_PROGRAM_NAME, findCommand } from "./commands"
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
					command: error.command?.name ?? context.programName,
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
				`${context.programName} help ${error.command.name}`,
			)}`,
		)
	} else {
		terminal.err("")
		terminal.err(
			`  ${palette.muted("Help:")}  ${palette.accent(
				`${context.programName} help`,
			)}`,
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
				`Run "${context.programName} help" to see every command.`,
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

// NOTE: The Formatter and the Language Server are imported where they are used
// and nowhere else. `essence check` must not pay for a Formatter it never calls
// — a static import at the top of this module would load both packages, and
// every module they import, before the first argument is even read.
async function runFormat(
	context: CLIContext,
	rawArguments: Array<string>,
): Promise<number> {
	let { run: runFormatter } = await import("@essence-lang/formatter/cli")

	return runFormatter(rawArguments, {
		programName: `${context.programName} format`,
	})
}

async function runLanguageServer(): Promise<number> {
	let { startServer } = await import("@essence-lang/language-server")

	// NOTE: The Server does not return: it holds stdio open and answers
	// requests until the Editor closes the connection, which ends the process.
	// The exit code is what a clean start reports, not what a session did.
	startServer()

	return EXIT_SUCCESS
}

// NOTE: How `essence dap` compiles — this CLI's own in-process pipeline,
// answering in the Adapter's report shape. Exported so that WHAT a debug
// session builds can be asked of the same function the command hands over.
//
// NOTE: The Optimiser is OFF, and that is the whole reason this is not simply
// what `build` does. A debug session steps through Statements, stops on
// bindings and reads their values back, and half the registry exists to take
// exactly those things away: a Constant nothing reads is dropped, a Match
// Handler nothing can reach is dropped, an operation over literals becomes its
// answer, a walk is written out where it stood. Stepping through the Program as
// WRITTEN is worth more to a debug session than any of that.
export function debugAdapterCompile(): (
	programPath: string,
	outputFile: string,
) => Promise<{
	ok: boolean
	bundlePath: string | null
	diagnostics: Array<{
		file: string
		severity: string
		message: string
		code: string | null
		line: number | null
		column: number | null
	}>
}> {
	return async (programPath: string, outputFile: string) => {
		let { unoptimisedOptions } =
			await import("@essence-lang/compiler/optimiser")
		let { compileFile } = await import("./pipeline")

		let outcome = await compileFile({
			inputFileName: programPath,
			outputFileName: outputFile,
			minify: false,
			sourcemap: true,
			optimisation: unoptimisedOptions,
		})

		return {
			ok: outcome.ok,
			bundlePath: outcome.ok
				? (outcome.outputFileName ?? outputFile)
				: null,
			diagnostics: outcome.modules.flatMap((module) =>
				module.diagnostics.map((diagnostic) => ({
					file: module.fileName,
					severity: diagnostic.severity,
					message: diagnostic.message,
					code: diagnostic.code ?? null,
					line: diagnostic.position?.start.line ?? null,
					column: diagnostic.position?.start.column ?? null,
				})),
			),
		}
	}
}

async function runDebugAdapter(): Promise<number> {
	let { startAdapter } = await import("@essence-lang/debug-adapter")

	// NOTE: The Adapter does not know how to compile — it is handed what
	// compiling MEANS. stdout belongs to the protocol from this point on, which
	// is why the command is a passthrough that prints nothing.
	startAdapter({ compile: debugAdapterCompile() })

	return EXIT_SUCCESS
}

async function dispatch(
	context: CLIContext,
	invocation: Invocation,
): Promise<number> {
	let { command, files, options, programArguments, rawArguments } = invocation

	switch (command.name) {
		case "help":
			return showHelp(context, invocation)

		case "check":
			return runCheck(context, command, files)

		case "run":
			return runRun(context, command, files, programArguments)

		case "watch":
			return runWatch(context, command, files, { emit: true })

		case "format":
			return runFormat(context, rawArguments)

		case "lsp":
			return runLanguageServer()

		case "dap":
			return runDebugAdapter()

		default:
			if (options.watch) {
				return runWatch(context, command, files, { emit: true })
			}

			return runBuild(context, command, files)
	}
}

export async function run(
	argv: Array<string>,
	programName: string = DEFAULT_PROGRAM_NAME,
): Promise<number> {
	let invocation: Invocation
	let context: CLIContext

	try {
		invocation = parseArguments(argv, programName)
		context = createContext(invocation.options, programName)
	} catch (error) {
		// NOTE: The arguments could not be read, so there are no resolved
		// options to build a context from — a default one is used purely to
		// render the error. `--json` is read straight from the raw arguments,
		// because a caller that asked for JSON needs the failure in JSON too.
		let fallback = createContext(
			{ ...emptyOptions, json: argv.includes("--json") },
			programName,
		)

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
