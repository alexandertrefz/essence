import { type CompileMode, modeOf } from "@essence-lang/compiler/compileMode"

import { UsageError } from "./args"
import type { CommandSpec } from "./commands"
import {
	type CompilationResult,
	hasFailures,
	planCompilation,
	printCompilationResult,
	runCompilation,
} from "./compile"
import type { CLIContext } from "./context"
import { execute } from "./execute"
import { toJSONReport } from "./json"

export const EXIT_SUCCESS = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

// The usage error's code, since a leftover `focused` test means the run did not
// answer what was asked. A failed test keeps its own code.
export const EXIT_FOCUSED = 2

function emitJSON(
	context: CLIContext,
	result: CompilationResult,
	command: string,
): void {
	context.terminal.out(
		JSON.stringify(
			toJSONReport(result.outcomes, {
				command,
				version: context.version,
				duration: result.duration,
			}),
			null,
			2,
		),
	)
}

async function compileAll(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
	options: CompileMode & {
		emit: boolean
		cacheOutput?: boolean
		sourcemapMode?: "linked" | "inline"
	},
): Promise<CompilationResult> {
	let plan = await planCompilation(context, command, files, {
		...modeOf(options),
		emit: options.emit,
		cacheOutput: options.cacheOutput,
	})

	try {
		return await runCompilation(context, plan, {
			cacheOutput: options.cacheOutput,
			sourcemapMode: options.sourcemapMode,
		})
	} finally {
		await plan.dispatcher.dispose()
	}
}

export async function runBuild(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
): Promise<number> {
	let result = await compileAll(context, command, files, {
		emit: true,
		tests: context.options.tests,
	})

	printCompilationResult(context, result)

	if (context.options.json) {
		emitJSON(context, result, "build")
	}

	if (hasFailures(result)) {
		return EXIT_FAILURE
	}

	if (!context.options.execute) {
		return EXIT_SUCCESS
	}

	// `--execute` on a batch would interleave several programs' output, so only a
	// single build runs.
	if (result.outcomes.length !== 1) {
		throw new UsageError(
			"--execute can only run a single file.",
			command,
			"Compile the files you want, then run one of them with " +
				`${context.programName} run.`,
		)
	}

	let outputFileName = result.outcomes[0].outputFileName

	if (outputFileName === null) {
		return EXIT_SUCCESS
	}

	let execution = await execute(context, outputFileName, [])

	return execution.code
}

export async function runCheck(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
): Promise<number> {
	// With the tests section, so `check` reports tests that do not compile, as the
	// editor does. Without contract goals, which are tests to run and say nothing
	// about whether the file is correct.
	let result = await compileAll(context, command, files, {
		emit: false,
		tests: true,
	})

	printCompilationResult(context, result)

	if (context.options.json) {
		emitJSON(context, result, "check")
	}

	return hasFailures(result) ? EXIT_FAILURE : EXIT_SUCCESS
}

export async function runRun(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
	programArguments: Array<string>,
): Promise<number> {
	if (files.length > 1) {
		throw new UsageError(
			`${context.programName} run takes a single source file.`,
			command,
			`Use ${context.programName} build to compile several files at once.`,
		)
	}

	// Without `--out` the bundle is scratch work, kept in the bundle cache under its
	// sources' key. The source tree stays untouched, and an unchanged Program emits
	// nothing.
	let cacheOutput = context.options.out === undefined

	// The cached bundle outlives the run in a shared directory, so its map rides
	// inline. `--out` keeps the linked default.
	let result = await compileAll(context, command, files, {
		emit: true,
		cacheOutput,
		sourcemapMode: cacheOutput ? "inline" : undefined,
	})

	printCompilationResult(context, result)

	// `--json` changes how the compile is reported, not what `run` does: the program
	// still runs and the exit code is its own.
	if (context.options.json) {
		emitJSON(context, result, "run")
	}

	if (hasFailures(result)) {
		return EXIT_FAILURE
	}

	// Runs the file the Compiler wrote, since `--out` may be a directory and without
	// it the name is the cache's. A successful emit always reports one.
	let compiledFileName = result.outcomes[0]?.outputFileName ?? null

	if (compiledFileName === null) {
		return EXIT_FAILURE
	}

	let execution = await execute(context, compiledFileName, programArguments)

	return execution.code
}
