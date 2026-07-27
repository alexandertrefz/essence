import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { fixturePath } from "@essence/fixtures"
import { DebugClient } from "@vscode/debugadapter-testsupport"

import { adapterCapabilities } from "../session"

const adapterBinary = path.resolve(
	import.meta.dirname,
	"..",
	"..",
	"bin",
	"esdap",
)

// NOTE: A session compiles with the real CLI and runs under a real Node — the
// generous timeout carries the cold start of both.
async function startedClient(): Promise<DebugClient> {
	let client = new DebugClient("bun", adapterBinary, "essence")

	client.defaultTimeout = 30_000

	await client.start()
	await client.initializeRequest({
		adapterID: "essence",
		linesStartAt1: true,
		columnsStartAt1: true,
		pathFormat: "path",
	})

	return client
}

// NOTE: The real thing over real stdio — `DebugClient` spawns `bun bin/esdap`
// and speaks DAP at it, which is exactly how a `DebugAdapterExecutable` will.
describe("the DAP handshake", () => {
	let client: DebugClient | null = null

	afterEach(async () => {
		await client?.stop()
		client = null
	})

	it("answers initialize with the adapter's capabilities", async () => {
		client = new DebugClient("bun", adapterBinary, "essence")

		await client.start()

		let response = await client.initializeRequest({
			adapterID: "essence",
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: "path",
		})

		expect(response.body?.supportsConfigurationDoneRequest).toBe(true)
		expect(response.body?.supportsExceptionInfoRequest).toBe(true)
		expect(
			response.body?.exceptionBreakpointFilters?.map(
				(filter) => filter.filter,
			),
		).toEqual(["uncaught", "caught"])
	})

	it("promises over the wire exactly what the module promises", () => {
		expect(adapterCapabilities.supportsConfigurationDoneRequest).toBe(true)
		expect(
			adapterCapabilities.exceptionBreakpointFilters?.find(
				(filter) => filter.filter === "uncaught",
			)?.default,
		).toBe(true)
	})
})

describe("a debug session", () => {
	let client: DebugClient | null = null

	afterEach(async () => {
		await client?.stop()
		client = null
	})

	it("compiles a program, runs it and reports its output", async () => {
		client = await startedClient()

		let output: Array<string> = []

		client.on("output", (event) => {
			if (event.body.category === "stdout") {
				output.push(event.body.output)
			}
		})

		await Promise.all([
			client.launch({
				program: fixturePath("HelloWorld.es"),
			} as never),
			client.configurationSequence(),
			client.waitForEvent("terminated"),
		])

		let joined = output.join("")

		expect(joined).toContain('"Greetee can not be empty!"')
		expect(joined).toContain('"Hello, World."')
		expect(joined).toContain('"Hello, Universe!"')
	}, 60_000)

	it("fails the launch of a program that does not compile", async () => {
		client = await startedClient()

		let directory = mkdtempSync(path.join(tmpdir(), "essence-dap-spec-"))
		let brokenPath = path.join(directory, "Broken.es")

		writeFileSync(
			brokenPath,
			"implementation {\n\tconstant answer: Integer = \"text\"\n}\n",
		)

		try {
			let failure = await client
				.launch({ program: brokenPath } as never)
				.then(
					() => null,
					(error: unknown) => error,
				)

			expect(String(failure)).toContain("did not compile")
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	}, 60_000)
})
