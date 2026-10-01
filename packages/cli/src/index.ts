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
import { runInit } from "./init"
import { toJSONUsageError } from "./json"
import {
	projectConfigurationFor,
	reportProjectSettings,
	resolveProjectOptions,
} from "./projectOptions"
import { runWatch } from "./watch"

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
	// `esc help build` and `esc build --help` both land here. The explicit command
	// wins, else the argument to `help`.
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

// The Formatter and the Language Server are imported where they are used, so
// `essence check` never loads them.
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

	// The Server holds stdio until the Editor closes the connection, which ends the
	// process. The exit code is a clean start's.
	startServer()

	return EXIT_SUCCESS
}

// How `essence dap` compiles, in the Adapter's report shape. The Optimiser is
// off, so a debug session steps through the Program as written. Its passes drop
// unread Constants and unreachable Handlers, and fold literal operations.
export function debugAdapterCompile(): (
	programPath: string,
	outputFile: string,
	options?: { tests?: boolean },
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
	return async (
		programPath: string,
		outputFile: string,
		options: { tests?: boolean } = {},
	) => {
		let { unoptimisedOptions } =
			await import("@essence-lang/compiler/optimiser")
		let { compileFile } = await import("./pipeline")

		let outcome = await compileFile({
			inputFileName: programPath,
			outputFileName: outputFile,
			minify: false,
			sourcemap: true,
			optimisation: unoptimisedOptions,
			// A build drops the `tests` block, so it is compiled only when the launch asks
			// for a test.
			tests: options.tests,
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

	// The Adapter is handed how to compile. stdout belongs to the protocol from here
	// on, so the command prints nothing.
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

		case "init":
			return runInit(context, command)

		case "run":
			return runRun(context, command, files, programArguments)

		case "watch":
			return runWatch(context, command, files, { emit: true })

		case "test": {
			// Imported where used, so `esc check` never loads the test runtime or the
			// emitter. `--mutate` goes first because it refuses `--watch` itself, in
			// `runMutation`.
			if (options.mutate) {
				let { runMutation } = await import("./mutate")

				return runMutation(context, command, files)
			}

			if (options.watch) {
				let { runTestWatch } = await import("./testWatch")

				return runTestWatch(context, command, files)
			}

			let { runTest } = await import("./test")

			return runTest(context, command, files)
		}

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

// Returns an exit code instead of calling `process.exit`, so specs can drive the
// whole CLI. The executables in `bin/` set `process.exitCode` from it.
export async function run(
	argv: Array<string>,
	programName: string = DEFAULT_PROGRAM_NAME,
): Promise<number> {
	let invocation: Invocation
	let context: CLIContext

	try {
		invocation = parseArguments(argv, programName)

		// The project file is read once, before any command runs, so commands find its
		// settings in their context. See `readsProjectConfiguration`.
		let configuration = projectConfigurationFor(invocation.command)

		// The flags are resolved against it here too, so a command reads the effective
		// value.
		context = createContext(
			resolveProjectOptions(
				invocation.options,
				configuration,
				invocation.command,
			),
			programName,
			undefined,
			configuration,
		)
	} catch (error) {
		// The arguments could not be read, so a default context renders the error.
		// `--json` is read from the raw arguments, so the failure comes as JSON too.
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

	// A bare `esc` shows what it can do, since nothing is wrong, only missing.
	if (
		invocation.options.help ||
		(invocation.files.length === 0 && !invocation.commandWasExplicit)
	) {
		return showHelp(context, invocation)
	}

	// After `--version` and help, which are answered without a project.
	reportProjectSettings(context, invocation.command)

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
