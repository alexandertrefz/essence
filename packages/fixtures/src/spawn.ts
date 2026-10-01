export type SpawnOptions = {
	cwd?: string
	env?: Record<string, string | undefined>
	input?: string
	deadline?: number
}

export type Finished = {
	code: number | null
	signal: string | null
	stdout: string
	stderr: string
}

// Under the suite's per-test budget, so a stuck child fails its own test
// rather than timing the test out anonymously.
export const SPAWN_DEADLINE_MILLISECONDS = 50_000

// Awaited, because a synchronous spawn inside `bun test` can go on
// spinning after the child has exited. Both streams are read while the child
// runs, so neither pipe can fill and stall it.
export async function spawnAndWait(
	command: Array<string>,
	options: SpawnOptions = {},
): Promise<Finished> {
	let child = Bun.spawn(command, {
		cwd: options.cwd,
		// `process.env` itself rather than Bun's default, which leaves out
		// what a spec assigned into it.
		env: options.env ?? process.env,
		stdin:
			options.input === undefined
				? "ignore"
				: new TextEncoder().encode(options.input),
		stdout: "pipe",
		stderr: "pipe",
	})
	let deadline = options.deadline ?? SPAWN_DEADLINE_MILLISECONDS
	let timer: ReturnType<typeof setTimeout> | undefined
	let expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			// Killed outright, because a child spinning in a loop never
			// reaches a handler it installed for a gentler signal.
			child.kill("SIGKILL")
			reject(
				new Error(
					`\`${command.join(" ")}\` did not finish within ${deadline} ms and was killed`,
				),
			)
		}, deadline)
	})

	try {
		let [stdout, stderr] = await Promise.race([
			Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]),
			expired,
		])

		return {
			code: child.exitCode,
			signal: child.signalCode,
			stdout,
			stderr,
		}
	} finally {
		clearTimeout(timer)
	}
}
