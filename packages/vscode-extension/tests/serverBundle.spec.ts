import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { buildServer } from "../buildServer.js"

// The extension forks the bundled server on the Node VS Code ships, so a
// bundle only Bun can run fails every user. This builds one as `bun run build`
// does and starts it under Node. Without a Node on the machine nothing here
// can say how the bundle runs there.
const node = Bun.which("node")

let directory = mkdtempSync(path.join(tmpdir(), "essence-server-bundle-"))

afterAll(() => {
	rmSync(directory, { recursive: true, force: true })
})

// One LSP message, framed as the protocol frames it.
function framed(message: object): string {
	let body = JSON.stringify({ jsonrpc: "2.0", ...message })

	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

type Answer = { id?: number; result?: { capabilities?: object } | null }

// The messages of a stream, each read whole. A stream that ends answers null.
function messagesOf(stream: ReadableStream<Uint8Array>) {
	let reader = stream.getReader()
	let pending = Buffer.alloc(0)

	return async function next(): Promise<Answer | null> {
		while (true) {
			let separator = pending.indexOf("\r\n\r\n")
			let length = /Content-Length: (\d+)/.exec(
				pending.subarray(0, Math.max(separator, 0)).toString(),
			)

			if (
				separator !== -1 &&
				length !== null &&
				pending.length >= separator + 4 + Number(length[1])
			) {
				let end = separator + 4 + Number(length[1])
				let body = pending.subarray(separator + 4, end).toString()

				pending = pending.subarray(end)

				return JSON.parse(body) as Answer
			}

			let { value, done } = await reader.read()

			if (done || value === undefined) {
				return null
			}

			pending = Buffer.concat([pending, value])
		}
	}
}

// The answer to the request numbered `id`, skipping notifications.
async function answerTo(
	next: () => Promise<Answer | null>,
	id: number,
): Promise<Answer | null> {
	while (true) {
		let message = await next()

		if (message === null || message.id === id) {
			return message
		}
	}
}

describe("The bundled Language Server", () => {
	it.skipIf(node === null)(
		"starts under Node and answers `initialize`",
		async () => {
			await buildServer(directory)

			let server = Bun.spawn(
				[node as string, path.join(directory, "server.js"), "--stdio"],
				{
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
					// Nothing is read from or written to the user's cache.
					env: { ...process.env, ESSENCE_COMPILER_CACHE: "off" },
				},
			)

			server.stdin.write(
				framed({
					id: 1,
					method: "initialize",
					params: {
						processId: null,
						rootUri: null,
						capabilities: {},
					},
				}),
			)
			server.stdin.flush()

			let next = messagesOf(server.stdout)
			let answer = await answerTo(next, 1)

			if (answer === null) {
				throw new Error(
					`The server exited before it answered:\n${await new Response(server.stderr).text()}`,
				)
			}

			// `exit` succeeds only after `shutdown` was answered.
			server.stdin.write(framed({ id: 2, method: "shutdown" }))
			server.stdin.flush()
			await answerTo(next, 2)
			server.stdin.write(framed({ method: "exit" }))
			server.stdin.end()

			let exitCode = await server.exited
			let errors = await new Response(server.stderr).text()

			expect({ errors, exitCode }).toEqual({ errors: "", exitCode: 0 })
			expect(answer.result?.capabilities).toMatchObject({
				hoverProvider: true,
				inlayHintProvider: { resolveProvider: true },
			})
		},
	)
})
