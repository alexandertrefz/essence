import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import { DebugClient } from "@vscode/debugadapter-testsupport"
import { SourceMapGenerator } from "source-map"

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

		expect(joined).toContain("Greetee can not be empty!")
		expect(joined).toContain("Hello, World.")
		expect(joined).toContain("Hello, Universe!")
	}, 60_000)

	it("binds a breakpoint on a source line and stops on it", async () => {
		client = await startedClient()

		let programPath = fixturePath("HelloWorld.es")
		let initialized = client.waitForEvent("initialized")
		let launched = client.launch({ program: programPath } as never)

		await initialized

		// NOTE: Line 4 is `variable message = …`, the first statement of
		// `greet` — a statement the map carries.
		let breakpointResponse = await client.setBreakpointsRequest({
			source: { path: programPath },
			breakpoints: [{ line: 4 }],
		})

		expect(breakpointResponse.body.breakpoints[0]!.verified).toBe(true)
		expect(breakpointResponse.body.breakpoints[0]!.line).toBe(4)

		// NOTE: Subscribed BEFORE configurationDone — the stop lands moments
		// after the resume, and an event nobody was listening for is gone.
		let stopped = client.waitForEvent("stopped")

		await client.configurationDoneRequest()
		await launched

		expect((await stopped).body.reason).toBe("breakpoint")

		// NOTE: The paused stack must speak Essence: the author's function on
		// the author's line, in the author's file — not a bundle position.
		let stack = await client.stackTraceRequest({ threadId: 1 })
		let top = stack.body.stackFrames[0]!

		expect(top.name).toBe("greet")
		expect(top.source?.path).toBe(programPath)
		expect(top.line).toBe(4)

		// NOTE: The Variables view must speak Essence too — the paused
		// `greet("")` holds its Parameter as a quoted String, not as a tagged
		// object's innards.
		let scopes = await client.scopesRequest({ frameId: top.id })
		let local = scopes.body.scopes.find((scope) => scope.name === "Local")

		expect(local).toBeDefined()

		let variables = await client.variablesRequest({
			variablesReference: local!.variablesReference,
		})
		let greetee = variables.body.variables.find(
			(variable) => variable.name === "greetee",
		)

		expect(greetee?.value).toBe('""')

		// NOTE: The console is JavaScript over the compiled frame, but an
		// Essence value it answers still renders as one.
		let evaluated = await client.evaluateRequest({
			expression: "greetee",
			frameId: top.id,
			context: "watch",
		})

		expect(evaluated.body.result).toBe('""')

		// NOTE: One step over `variable message = …` lands on the `if` two
		// source lines down — the interpolation glue between them is carried
		// over, and never surfaces as a landing place.
		let steppedStop = client.waitForEvent("stopped")

		await client.nextRequest({ threadId: 1 })
		expect((await steppedStop).body.reason).toBe("step")

		let steppedStack = await client.stackTraceRequest({ threadId: 1 })

		expect(steppedStack.body.stackFrames[0]!.name).toBe("greet")
		expect(steppedStack.body.stackFrames[0]!.line).toBe(6)

		// NOTE: `greet` runs three times; clearing the breakpoint before
		// resuming is what lets one continue reach the end of the program.
		await client.setBreakpointsRequest({
			source: { path: programPath },
			breakpoints: [],
		})

		await Promise.all([
			client.continueRequest({ threadId: 1 }),
			client.waitForEvent("terminated"),
		])
	}, 60_000)

	it("stops on entry at the first line the author wrote", async () => {
		client = await startedClient()

		let programPath = fixturePath("HelloWorld.es")
		let initialized = client.waitForEvent("initialized")
		let launched = client.launch({
			program: programPath,
			stopOnEntry: true,
		} as never)

		await initialized

		let stopped = client.waitForEvent("stopped")

		await client.configurationDoneRequest()
		await launched

		expect((await stopped).body.reason).toBe("entry")

		// NOTE: Line 17 is `Terminal.print(greet(""))` — the entry's first
		// statement. The raw entry pause sits in runtime glue far above it;
		// the user never sees that.
		let stack = await client.stackTraceRequest({ threadId: 1 })

		expect(stack.body.stackFrames[0]!.line).toBe(17)
		expect(stack.body.stackFrames[0]!.name).toBe("HelloWorld.es")

		await Promise.all([
			client.continueRequest({ threadId: 1 }),
			client.waitForEvent("terminated"),
		])
	}, 60_000)

	// NOTE: Exercised through the `artifact` door with a hand-built bundle: a
	// Diagnostic-clean Essence program has no deterministic uncaught throw to
	// offer — the one failure it can earn, a stack overflow, is the one V8
	// cannot pause on, there being no stack left to pause with.
	it("pauses on an uncaught throw at the mapped line", async () => {
		client = await startedClient()

		let directory = mkdtempSync(path.join(tmpdir(), "essence-dap-spec-"))
		let artifactPath = path.join(directory, "boom.js")
		let sourcePath = path.join(directory, "Boom.es")

		writeFileSync(
			artifactPath,
			'function detonate() {\n\tthrow new Error("boom");\n}\ndetonate();\n//# sourceMappingURL=boom.js.map\n',
		)

		let generator = new SourceMapGenerator({ file: "boom.js" })

		for (let line = 1; line <= 4; line++) {
			generator.addMapping({
				generated: { line, column: 0 },
				original: { line, column: 0 },
				source: sourcePath,
			})
		}

		writeFileSync(`${artifactPath}.map`, generator.toString())

		try {
			let initialized = client.waitForEvent("initialized")
			let launched = client.launch({ artifact: artifactPath } as never)

			await initialized

			let stopped = client.waitForEvent("stopped")

			await client.configurationDoneRequest()
			await launched

			expect((await stopped).body.reason).toBe("exception")

			let info = await client.customRequest("exceptionInfo", {
				threadId: 1,
			})

			expect(info.body.exceptionId).toBe("Error")
			expect(info.body.description).toBe("Error: boom")

			let stack = await client.stackTraceRequest({ threadId: 1 })

			expect(stack.body.stackFrames[0]!.name).toBe("detonate")
			expect(stack.body.stackFrames[0]!.source?.path).toBe(sourcePath)
			expect(stack.body.stackFrames[0]!.line).toBe(2)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	}, 60_000)

	it("fails the launch of a program that does not compile", async () => {
		client = await startedClient()

		let directory = mkdtempSync(path.join(tmpdir(), "essence-dap-spec-"))
		let brokenPath = path.join(directory, "Broken.es")

		writeFileSync(
			brokenPath,
			'implementation {\n\tconstant answer: Integer = "text"\n}\n',
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
