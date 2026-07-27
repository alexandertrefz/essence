import { type ChildProcess, spawn } from "node:child_process"

// NOTE: How the debuggee starts: Node, paused before the first line by
// `--inspect-brk`, on an ephemeral port so two sessions never fight over one.
// Node announces the inspector endpoint on stderr — the one line (plus its
// "For help" follow-up) that is the runtime's own and must not be shown as
// program output.

export type LaunchedProgram = {
	child: ChildProcess
	webSocketUrl: string
}

const listeningPattern = /Debugger listening on (ws:\/\/\S+)/
const inspectorNoise =
	/^(?:Debugger listening on ws:\/\/|For help, see: |Debugger attached\.|Waiting for the debugger to disconnect\.\.\.)/

export function launchProgram(options: {
	runtime: string
	bundlePath: string
	programArguments: Array<string>
	cwd: string
	env: Record<string, string | undefined>
	onStdout: (text: string) => void
	onStderr: (text: string) => void
}): Promise<LaunchedProgram> {
	return new Promise((resolve, reject) => {
		let child = spawn(
			options.runtime,
			[
				"--inspect-brk=127.0.0.1:0",
				options.bundlePath,
				...options.programArguments,
			],
			{
				cwd: options.cwd,
				env: options.env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		)

		let settled = false
		let stderrBuffer = ""

		let timeout = setTimeout(() => {
			if (!settled) {
				settled = true
				child.kill()
				reject(
					new Error(
						`'${options.runtime}' announced no inspector endpoint within 10 seconds`,
					),
				)
			}
		}, 10_000)

		child.stdout?.on("data", (chunk: Buffer) => {
			options.onStdout(chunk.toString())
		})

		// NOTE: stderr is scanned line-wise for the endpoint; everything that
		// is not inspector housekeeping is the program's own and passes
		// through. The buffer carries a line split across chunks.
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBuffer += chunk.toString()

			let lines = stderrBuffer.split("\n")

			stderrBuffer = lines.pop() ?? ""

			for (let line of lines) {
				let match = listeningPattern.exec(line)

				if (match !== null && !settled) {
					settled = true
					clearTimeout(timeout)
					resolve({ child, webSocketUrl: match[1]! })

					continue
				}

				if (!inspectorNoise.test(line)) {
					options.onStderr(`${line}\n`)
				}
			}
		})

		child.on("error", (error) => {
			if (!settled) {
				settled = true
				clearTimeout(timeout)
				reject(
					new Error(
						`could not start '${options.runtime}' — ${error.message}`,
					),
				)
			}
		})

		child.on("exit", () => {
			if (!settled) {
				settled = true
				clearTimeout(timeout)
				reject(
					new Error(
						`'${options.runtime}' exited before announcing an inspector endpoint`,
					),
				)
			}
		})
	})
}
