import { describe, expect, it } from "bun:test"

import { spawnAndWait } from "../spawn"

describe("spawnAndWait", () => {
	it("answers the exit code and both streams, with the input on stdin", async () => {
		let finished = await spawnAndWait(
			[
				process.execPath,
				"--eval",
				[
					"let text = await Bun.stdin.text()",
					"process.stdout.write(text.toUpperCase())",
					'process.stderr.write("err")',
					"process.exit(3)",
				].join("\n"),
			],
			{ input: "alpha\n" },
		)

		expect(finished).toEqual({
			code: 3,
			signal: null,
			stdout: "ALPHA\n",
			stderr: "err",
		})
	})

	it("runs in the directory and with the environment it is given", async () => {
		let finished = await spawnAndWait(
			[
				process.execPath,
				"--eval",
				"console.log(process.cwd(), process.env.SPAWN_PROBE)",
			],
			{ cwd: "/", env: { ...process.env, SPAWN_PROBE: "given" } },
		)

		expect(finished.stdout).toBe("/ given\n")
	})

	it("hands a child with no environment of its own what the spec assigned", async () => {
		process.env.SPAWN_ASSIGNED = "assigned"

		try {
			let finished = await spawnAndWait([
				process.execPath,
				"--eval",
				"console.log(process.env.SPAWN_ASSIGNED)",
			])

			expect(finished.stdout).toBe("assigned\n")
		} finally {
			delete process.env.SPAWN_ASSIGNED
		}
	})

	it("fails, naming the child, when the child outlives its deadline", async () => {
		let command = [
			process.execPath,
			"--eval",
			"setInterval(() => {}, 1000)",
		]

		await expect(spawnAndWait(command, { deadline: 200 })).rejects.toThrow(
			`\`${command.join(" ")}\` did not finish within 200 ms and was killed`,
		)
	})
})
