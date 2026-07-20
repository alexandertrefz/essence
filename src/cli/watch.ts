import type { ChildProcess } from "node:child_process"
import { watch as watchPath } from "node:fs"
import { stat } from "node:fs/promises"
import * as path from "node:path"

import { EXIT_SUCCESS } from "./actions"
import type { CommandSpec } from "./commands"
import {
	planCompilation,
	printCompilationResult,
	runCompilation,
} from "./compile"
import type { CLIContext } from "./context"
import { startProgram } from "./execute"
import { renderDiagnosticsFor, renderWatchLine } from "./report"

// NOTE: Editors rarely write a file in place — many write a temporary file and
// rename it over the original, which destroys the watch on the file itself.
// Watching the containing directory and filtering by name survives that, and
// also catches a file that is deleted and recreated.
const DEBOUNCE = 60
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
		watch: true,
	})

	let signatures = new Map<string, string>()
	let running: ChildProcess | null = null
	let pending = new Set<string>()
	let debounceTimer: ReturnType<typeof setTimeout> | null = null
	let building = false
	let watchers: Array<ReturnType<typeof watchPath>> = []

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
		running = startProgram(outputFileName)
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

	let schedule = (fileNames: Array<string>) => {
		for (let fileName of fileNames) {
			pending.add(fileName)
		}

		if (debounceTimer !== null) {
			clearTimeout(debounceTimer)
		}

		debounceTimer = setTimeout(() => {
			debounceTimer = null

			let targets = [...pending]

			pending.clear()
			void rebuild(targets)
		}, DEBOUNCE)
	}

	// NOTE: A directory event says only that something happened in that
	// directory — on macOS a save that renames a temporary file over the
	// original is reported under the temporary file's name, so the event's
	// file name cannot be trusted to identify what changed. The event is used
	// purely as a prompt to re-examine the sources themselves.
	let signature = async (fileName: string): Promise<string> => {
		try {
			let info = await stat(fileName)

			return `${info.mtimeMs}:${info.size}`
		} catch {
			return "missing"
		}
	}

	async function captureSignatures(): Promise<void> {
		await Promise.all(
			plan.inputFileNames.map(async (fileName) => {
				signatures.set(fileName, await signature(fileName))
			}),
		)
	}

	async function checkForChanges(): Promise<void> {
		let changed: Array<string> = []

		await Promise.all(
			plan.inputFileNames.map(async (fileName) => {
				let current = await signature(fileName)

				if (
					current === "missing" ||
					signatures.get(fileName) === current
				) {
					return
				}

				signatures.set(fileName, current)
				changed.push(fileName)
			}),
		)

		if (changed.length > 0) {
			schedule(changed)
		}
	}

	terminal.out("")
	terminal.out(
		`  ${palette.strong("esc watch")} ${palette.faint(theme.symbols.bullet)} ${palette.muted(
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

	let directories = new Set(
		plan.inputFileNames.map((fileName) =>
			path.dirname(path.resolve(fileName)),
		),
	)

	await captureSignatures()

	for (let directory of directories) {
		try {
			watchers.push(
				watchPath(directory, () => {
					void checkForChanges()
				}),
			)
		} catch (error) {
			terminal.err(
				`  ${palette.warning(theme.symbols.warning)} ${palette.muted(
					`Could not watch ${directory}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)}`,
			)
		}
	}

	return new Promise<number>((resolve) => {
		let shutdown = async () => {
			for (let watcher of watchers) {
				watcher.close()
			}

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
