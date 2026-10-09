import { afterAll, describe, expect, it } from "bun:test"
import {
	accessSync,
	constants,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { buildExtension } from "../buildExtension.js"
import { buildServer } from "../buildServer.js"

// The extension forks the bundled server on the Node VS Code ships, so a
// bundle only Bun can run fails every user. This builds one as `bun run build`
// does and starts it under Node. Without a Node on the machine nothing here
// can say how the bundle runs there.
const node = Bun.which("node")

// Laid out as an installed extension: `server/` and `dist/` side by side.
let root = mkdtempSync(path.join(tmpdir(), "essence-server-bundle-"))
let extension = path.join(root, "extension")
let directory = path.join(extension, "server")
let workspace = mkdtempSync(path.join(tmpdir(), "essence-server-workspace-"))
let building: Promise<void> | null = null

afterAll(() => {
	rmSync(root, { recursive: true, force: true })
	rmSync(workspace, { recursive: true, force: true })
})

// One build serves every test.
function built(): Promise<void> {
	building ??= Promise.all([
		buildServer(directory),
		buildExtension(path.join(extension, "dist")),
	]).then(() => {})

	return building
}

// One LSP message, framed as the protocol frames it.
function framed(message: object): string {
	let body = JSON.stringify({ jsonrpc: "2.0", ...message })

	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

type Message = {
	id?: number
	method?: string
	params?: {
		kind?: string
		counts?: object
		compiled?: boolean
		message?: string
	}
	result?: { capabilities?: object } | null
}

// The messages of a stream, each read whole. A stream that ends answers null.
function messagesOf(stream: ReadableStream<Uint8Array>) {
	let reader = stream.getReader()
	let pending = Buffer.alloc(0)

	return async function next(): Promise<Message | null> {
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

				return JSON.parse(body) as Message
			}

			let { value, done } = await reader.read()

			if (done || value === undefined) {
				return null
			}

			pending = Buffer.concat([pending, value])
		}
	}
}

// The first message `matches` accepts, skipping the rest. A stream that ends
// answers null.
async function firstWhere(
	next: () => Promise<Message | null>,
	matches: (message: Message) => boolean,
): Promise<Message | null> {
	while (true) {
		let message = await next()

		if (message === null || matches(message)) {
			return message
		}
	}
}

// The answer to the request numbered `id`. A request the server makes of the
// client carries an id of its own, so only a message without a method counts.
function answerTo(
	next: () => Promise<Message | null>,
	id: number,
): Promise<Message | null> {
	return firstWhere(
		next,
		(message) => message.method === undefined && message.id === id,
	)
}

type SessionRun = {
	end: Message | null
	logs: Array<string>
	errors: string
	exitCode: number
	// The bundles the Worker staged, named for their hashes.
	staged: Array<string>
}

// Starts the bundled server on a workspace of one passing test file, waits
// for the session's first run, and stops it.
async function runSession(node: string): Promise<SessionRun> {
	writeFileSync(
		path.join(workspace, "Sums.es"),
		[
			"tests {",
			'\ttest "adds up" {',
			"\t\tconstant total = 2::add(2)",
			"",
			"\t\texpect total::is(4)",
			"\t}",
			"",
			'\ttest "adds more" {',
			"\t\tconstant total = 3::add(4)",
			"",
			"\t\texpect total::is(7)",
			"\t}",
			"}",
			"",
		].join("\n"),
	)

	// The shim a version manager installs as `node` puts its own directory on
	// `PATH`, so the server runs on the executable it starts.
	let executable = Bun.spawnSync([node, "-p", "process.execPath"])
		.stdout.toString()
		.trim()
	// The Worker stages its bundles here.
	let staging = mkdtempSync(path.join(root, "staging-"))
	let { NODE_PATH: _, ...environment } = process.env
	let server = Bun.spawn(
		[executable, path.join(directory, "server.js"), "--stdio"],
		{
			cwd: workspace,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...environment,
				ESSENCE_COMPILER_CACHE: "off",
				PATH: workspace,
				TMPDIR: staging,
			},
		},
	)
	let next = messagesOf(server.stdout)
	let logs: Array<string> = []

	server.stdin.write(
		framed({
			id: 1,
			method: "initialize",
			params: {
				processId: null,
				rootUri: pathToFileURL(workspace).href,
				workspaceFolders: [
					{ uri: pathToFileURL(workspace).href, name: "sums" },
				],
				capabilities: { workspace: { workspaceFolders: true } },
			},
		}),
	)
	server.stdin.flush()
	await answerTo(next, 1)
	// The session runs the workspace once the client says it is ready.
	server.stdin.write(framed({ method: "initialized", params: {} }))
	server.stdin.flush()

	let end = await firstWhere(next, (message) => {
		if (message.method === "window/logMessage") {
			logs.push(message.params?.message ?? "")
		}

		return (
			message.method === "essence/testRun" &&
			message.params?.kind === "end"
		)
	})
	// Read before `shutdown`, which removes them.
	let staged = readdirSync(staging).flatMap((each) =>
		readdirSync(path.join(staging, each)),
	)

	server.stdin.write(framed({ id: 2, method: "shutdown" }))
	server.stdin.flush()
	await answerTo(next, 2)
	server.stdin.write(framed({ method: "exit" }))
	server.stdin.end()

	let exitCode = await server.exited
	let errors = await new Response(server.stderr).text()

	return { end, logs, errors, exitCode, staged }
}

// Every file under `directory`, at any depth.
function filesUnder(directory: string): Array<string> {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name))
}

// `start` and every directory above it, up to the root.
function directoriesAbove(start: string): Array<string> {
	let directories = [start]

	while (path.dirname(directories.at(-1) as string) !== directories.at(-1)) {
		directories.push(path.dirname(directories.at(-1) as string))
	}

	return directories
}

describe("The bundled Language Server", () => {
	it.skipIf(node === null)(
		"starts under Node and answers `initialize`",
		async () => {
			await built()

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

	// A packaged extension has no `node_modules`, and VS Code may run it with a
	// `PATH` that holds no `node`. So the server runs from a directory with no
	// `node_modules` above it, on Node named by its own path, with a `PATH`
	// that holds nothing.
	it.skipIf(node === null)(
		"runs a workspace's tests with no node_modules and no node on PATH",
		async () => {
			await built()

			let reachable = [extension, workspace].flatMap((start) =>
				directoriesAbove(start)
					.map((each) => path.join(each, "node_modules"))
					.filter((each) => existsSync(each)),
			)

			expect(reachable).toEqual([])

			let run = await runSession(node as string)

			expect({
				errors: run.errors,
				exitCode: run.exitCode,
				logs: run.logs,
			}).toEqual({ errors: "", exitCode: 0, logs: [] })
			expect(run.end?.params).toMatchObject({
				compiled: true,
				counts: { passed: 2, failed: 0, skipped: 0, deselected: 0 },
			})
		},
	)

	// A bundle is staged under its hash, which mixes in the compiler's version.
	// Installed, the directory above the extension holds whatever it holds, and
	// a `package.json` there must not move the hash.
	it.skipIf(node === null)(
		"names a test bundle alike whatever sits above the extension",
		async () => {
			await built()

			let manifest = path.join(extension, "..", "package.json")
			let staged: Array<Array<string>> = []

			for (let version of ["1.0.0", "2.0.0"]) {
				writeFileSync(manifest, JSON.stringify({ version }))
				staged.push((await runSession(node as string)).staged)
			}

			rmSync(manifest)

			expect(staged[0]).toHaveLength(1)
			expect(staged[1]).toEqual(staged[0]!)
		},
	)

	// A bundled CommonJS module would spell out the path it was built from.
	// That path names the building machine and its user, and exists on no other.
	it("names no path of the machine that built it", async () => {
		await built()

		let checkout = path.resolve(import.meta.dirname, "..", "..", "..")
		// Every path holds the root, so a home directory at the root is no clue.
		let spellings = [
			...new Set(
				[checkout, homedir()].flatMap((each) => [
					each,
					realpathSync(each),
				]),
			),
		].filter((each) => path.parse(each).root !== each)
		let naming = filesUnder(extension).filter((file) => {
			let contents = readFileSync(file)

			return spellings.some((spelling) => contents.includes(spelling))
		})

		expect(naming.map((file) => path.relative(extension, file))).toEqual([])
	})

	// The language client stops a server that outlives `stop` by running this
	// script, which it looks for beside its own bundled file.
	it("ships the language client's terminate script beside it", async () => {
		await built()

		let script = path.join(extension, "dist", "terminateProcess.sh")

		expect(() => accessSync(script, constants.X_OK)).not.toThrow()
	})
})
