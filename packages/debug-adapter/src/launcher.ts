import { type ChildProcess, spawn } from "node:child_process"

// How the debuggee starts: Node, paused before the first line by
// `--inspect-brk`, on an ephemeral port so sessions never share one. Node's
// inspector messages on stderr are not shown as program output.

type LaunchedProgram = {
	child: ChildProcess
	webSocketUrl: string
}

const listeningPattern = /Debugger listening on (ws:\/\/\S+)/
const inspectorNoise =
	/^(?:Debugger listening on ws:\/\/|For help, see: |Debugger attached\.|Waiting for the debugger to disconnect\.\.\.)/

export function launchProgram(options: {
	runtime: string
	// The script Node runs: the bundle, or the test runner beside it when
	// debugging a test.
	entryPath: string
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
				// A crash the debugger does not catch prints its trace to
				// stderr with `.es` lines, read through the bundle's map.
				"--enable-source-maps",
				options.entryPath,
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

		// stderr is scanned line by line for the endpoint, and any line that
		// is not the inspector's passes through. The buffer carries a line
		// split across chunks.
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
