import type { ChildProcess } from "node:child_process"
import * as path from "node:path"

import { EXIT_SUCCESS } from "./actions"
import type { CommandSpec } from "./commands"
import {
	type CompilationResult,
	planCompilation,
	printCompilationResult,
	runCompilation,
} from "./compile"
import type { CLIContext } from "./context"
import { startProgram } from "./execute"
import { renderDiagnosticsFor, renderWatchLine } from "./report"
import { createDependentsIndex, createSourceWatcher } from "./watcher"
const CTRL_C = "\u0003"

function timestamp(): string {
	let now = new Date()
	let pad = (value: number) => String(value).padStart(2, "0")

	return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
		now.getSeconds(),
	)}`
}

export async function runWatch(
	context: CLIContext,
	command: CommandSpec,
	files: Array<string>,
	options: { emit: boolean },
): Promise<number> {
	let { palette, terminal, theme } = context
	let plan = await planCompilation(context, command, files, {
		emit: options.emit,
	})

	let running: ChildProcess | null = null
	let pending = new Set<string>()
	let building = false

	let dependents = createDependentsIndex()

	let recordGraphs = (result: CompilationResult): void => {
		for (let outcome of result.outcomes) {
			dependents.record(
				outcome.inputFileName,
				outcome.modules.map((module) => module.fileName),
			)
		}
	}

	let watchedFiles = (): Array<string> => [
		...new Set([
			...plan.inputFileNames.map((fileName) => path.resolve(fileName)),
			...dependents.files(),
		]),
	]

	let stopProgram = () => {
		if (running !== null && running.exitCode === null) {
			running.kill()
		}

		running = null
	}

	let maybeExecute = (outputFileName: string | null) => {
		if (!context.options.execute || outputFileName === null) {
			return
		}

		stopProgram()
		terminal.out("")
		running = startProgram(outputFileName, [], context.options.sourcemap)
	}

	let footer = () => {
		terminal.out("")
		terminal.out(
			`  ${palette.faint(theme.symbols.bullet)} ${palette.muted(
				"watching for changes",
			)}  ${palette.faint("r rebuild · c clear · q quit")}`,
		)
	}

	let rebuild = async (targets: Array<string>) => {
		if (building) {
			for (let target of targets) {
				pending.add(target)
			}

			return
		}

		building = true

		if (context.options.clear && terminal.isInteractive) {
			terminal.stdout.write("\x1b[2J\x1b[H")
		}

		let result = await runCompilation(context, {
			...plan,
			inputFileNames: targets,
		})

		recordGraphs(result)
		await watchGraph()

		for (let outcome of result.outcomes) {
			let rendered = renderDiagnosticsFor(outcome, context.report)

			if (rendered !== null) {
				terminal.err(rendered)
			}

			terminal.out(renderWatchLine(outcome, context.report, timestamp()))
		}

		if (result.outcomes.length === 1 && result.outcomes[0].ok) {
			maybeExecute(result.outcomes[0].outputFileName)
		}

		footer()

		building = false

		if (pending.size > 0) {
			let next = [...pending]

			pending.clear()

			await rebuild(next)
		}
	}

	let watcher = createSourceWatcher({
		onChange: (changed) => {
			let targets = dependents.entriesFor(changed)

			if (targets.length > 0) {
				void rebuild(targets)
			}
		},
		onError: (directory, error) => {
			terminal.err(
				`  ${palette.warning(theme.symbols.warning)} ${palette.muted(
					`Could not watch ${directory}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)}`,
			)
		},
	})

	// NOTE: The graphs GROW — an import written during the session brings a
	// directory with it, and a rebuild that never watched it would be the last
	// one.
	async function watchGraph(): Promise<void> {
		await watcher.watch(watchedFiles())
	}

	terminal.out("")
	terminal.out(
		`  ${palette.strong(`${context.programName} watch`)} ${palette.faint(theme.symbols.bullet)} ${palette.muted(
			plan.inputFileNames.length === 1
				? plan.inputFileNames[0]
				: `${plan.inputFileNames.length} files`,
		)}`,
	)

	let initial = await runCompilation(context, plan)

	printCompilationResult(context, initial)

	if (initial.outcomes.length === 1 && initial.outcomes[0].ok) {
		maybeExecute(initial.outcomes[0].outputFileName)
	}

	footer()
	recordGraphs(initial)
	await watchGraph()

	return new Promise<number>((resolve) => {
		let shutdown = async () => {
			watcher.close()
			stopProgram()
			restoreInput()
			await plan.dispatcher.dispose()
			terminal.out("")
			resolve(EXIT_SUCCESS)
		}

		let onKey = (chunk: Buffer) => {
			let key = chunk.toString()

			if (key === "q" || key === CTRL_C) {
				void shutdown()

				return
			}

			if (key === "r") {
				void rebuild(plan.inputFileNames)

				return
			}

			if (key === "c") {
				terminal.stdout.write("\x1b[2J\x1b[H")
				footer()
			}
		}

		let restoreInput = () => {
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(false)
				process.stdin.pause()
			}

			process.stdin.off("data", onKey)
		}

		// NOTE: Raw mode is what makes single keypresses arrive without the
		// user pressing return. It also means Ctrl+C is delivered as data
		// rather than as a signal, so it is handled by hand above.
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true)
			process.stdin.resume()
			process.stdin.on("data", onKey)
		}

		process.on("SIGINT", () => {
			void shutdown()
		})
	})
}
