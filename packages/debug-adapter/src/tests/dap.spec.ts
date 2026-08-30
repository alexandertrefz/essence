import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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

	// NOTE: The three faces a List box wears once its runs are shared, all
	// bound at one pause: `start` still names a box whose inner Array `held`'s
	// first append grew past it, `held` was then prepended to and holds its
	// first item in a second run stored backwards, and `grown` views the whole
	// of the Array all three share. Reading any of them off its raw Array
	// would draw the wrong items — which is what the Variables view is here to
	// never do.
	it("shows a List by the items it views, however it holds them", async () => {
		client = await startedClient()

		// NOTE: Canonicalised for the reason `prepareBundle` canonicalises its
		// scratch directory — on macOS the temporary directory is a symlink,
		// and a breakpoint addressed to the symlinked spelling of a file the
		// map names by its real one binds to nothing.
		let directory = realpathSync(
			mkdtempSync(path.join(tmpdir(), "essence-dap-spec-")),
		)
		let programPath = path.join(directory, "Shared.es")

		writeFileSync(
			programPath,
			"implementation {\n" +
				"\n" +
				"\tfunction grow(_ start: List<Integer>) -> Integer {\n" +
				"\t\tvariable held = start::append(1)\n" +
				"\t\tvariable grown = held::append(2)\n" +
				"\n" +
				"\t\theld = held::prepend(0)\n" +
				"\n" +
				'\t\tTerminal.print("paused")\n' +
				"\n" +
				"\t\t<- grown::length()\n" +
				"\t}\n" +
				"\n" +
				'\tTerminal.print("{grow([])}")\n' +
				"}\n",
		)

		try {
			let initialized = client.waitForEvent("initialized")
			let launched = client.launch({ program: programPath } as never)

			await initialized

			// NOTE: Line 9 is `Terminal.print("paused")`, the first statement
			// after all three bindings have taken their final values.
			await client.setBreakpointsRequest({
				source: { path: programPath },
				breakpoints: [{ line: 9 }],
			})

			let stopped = client.waitForEvent("stopped")

			await client.configurationDoneRequest()
			await launched
			await stopped

			let stack = await client.stackTraceRequest({ threadId: 1 })
			let scopes = await client.scopesRequest({
				frameId: stack.body.stackFrames[0]!.id,
			})
			let local = scopes.body.scopes.find(
				(scope) => scope.name === "Local",
			)!
			let variables = (
				await client.variablesRequest({
					variablesReference: local.variablesReference,
				})
			).body.variables
			let shown = (name: string) =>
				variables.find((variable) => variable.name === name)!

			expect(shown("start").value).toBe("[]")
			expect(shown("held").value).toBe("[ 0, 1 ]")
			expect(shown("grown").value).toBe("[ 1, 2 ]")

			// NOTE: And expanding the row answers those same items, one live
			// value per row — not the positions of the Array underneath.
			let items = (
				await client.variablesRequest({
					variablesReference: shown("held").variablesReference,
				})
			).body.variables

			expect(items.map((item) => item.value)).toEqual(["0", "1"])

			await Promise.all([
				client.continueRequest({ threadId: 1 }),
				client.waitForEvent("terminated"),
			])
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	}, 60_000)

	// NOTE: The same hazard a Dictionary wears instead. Its store is shared by
	// every box of its chain and separated by a STAMP rather than by a copy, so
	// the four bound at this pause view four generations of one structure:
	// `ages` was made before both writes and still answers 39 for a key the
	// store holds 40 for, `held` before the two that fork off it, `older` is
	// the tip, and `fewer` forked and so carries a store of its own with the
	// tombstone in it. Reading any of them off the slots would draw entries its
	// Program cannot reach.
	it("shows a Dictionary by the entries it views, not its slots", async () => {
		client = await startedClient()

		let directory = realpathSync(
			mkdtempSync(path.join(tmpdir(), "essence-dap-entries-")),
		)
		let programPath = path.join(directory, "Ages.es")

		writeFileSync(
			programPath,
			"implementation {\n" +
				"\n" +
				"\tfunction shape(_ ages: Dictionary<String, Integer>) -> Integer {\n" +
				'\t\tconstant held = ages::set("sam", to 25)\n' +
				'\t\tconstant older = held::set("alex", to 40)\n' +
				'\t\tconstant fewer = held::remove(at "sam")\n' +
				"\n" +
				'\t\tTerminal.print("paused")\n' +
				"\n" +
				"\t\t<- older::length()::add(fewer::length())\n" +
				"\t}\n" +
				"\n" +
				'\tTerminal.print("{shape(["alex" = 39])}")\n' +
				'\tTerminal.print("{shape(["ada" = 1])}")\n' +
				"}\n",
		)

		try {
			let initialized = client.waitForEvent("initialized")
			let launched = client.launch({ program: programPath } as never)

			await initialized

			// NOTE: Line 8 is `Terminal.print("paused")`, the first statement
			// after all four bindings have taken their values.
			await client.setBreakpointsRequest({
				source: { path: programPath },
				breakpoints: [{ line: 8 }],
			})

			let stopped = client.waitForEvent("stopped")

			await client.configurationDoneRequest()
			await launched
			await stopped

			let stack = await client.stackTraceRequest({ threadId: 1 })
			let scopes = await client.scopesRequest({
				frameId: stack.body.stackFrames[0]!.id,
			})
			let local = scopes.body.scopes.find(
				(scope) => scope.name === "Local",
			)!
			let variables = (
				await client.variablesRequest({
					variablesReference: local.variablesReference,
				})
			).body.variables
			let shown = (name: string) =>
				variables.find((variable) => variable.name === name)!

			expect(shown("ages").value).toBe('[ "alex" = 39 ]')
			expect(shown("held").value).toBe('[ "alex" = 39, "sam" = 25 ]')
			expect(shown("older").value).toBe('[ "alex" = 40, "sam" = 25 ]')
			expect(shown("fewer").value).toBe('[ "alex" = 39 ]')

			// NOTE: And expanding the row answers those same entries, in
			// insertion order, each the Record `{ key, value }` the language
			// writes an entry as — not the store, the generation and the count
			// the box is made of.
			let entries = (
				await client.variablesRequest({
					variablesReference: shown("older").variablesReference,
				})
			).body.variables

			expect(entries.map((entry) => entry.value)).toEqual([
				'{ key = "alex", value = 40 }',
				'{ key = "sam", value = 25 }',
			])

			// NOTE: And an entry opens onto the LIVE key and the live value,
			// which is what makes a nested one worth expanding again.
			let entry = (
				await client.variablesRequest({
					variablesReference: entries[0]!.variablesReference,
				})
			).body.variables

			expect(entry.map((member) => [member.name, member.value])).toEqual([
				["key", '"alex"'],
				["value", "40"],
			])

			// NOTE: The entry Records above were MINTED in the debuggee for
			// this expansion — nothing the Program holds reaches them — so they
			// are released with the handles that named them, at the next pause
			// and at every resume. What the DAP can see of that is the pause
			// AFTER: the same row expands again, into this call's entries and
			// not the last one's. A release that took too much would answer an
			// empty row here, and one that took nothing would leave a Record
			// per entry standing for the length of the session.
			let stoppedAgain = client.waitForEvent("stopped")

			await client.continueRequest({ threadId: 1 })
			await stoppedAgain

			let secondStack = await client.stackTraceRequest({ threadId: 1 })
			let secondScopes = await client.scopesRequest({
				frameId: secondStack.body.stackFrames[0]!.id,
			})
			let secondLocal = secondScopes.body.scopes.find(
				(scope) => scope.name === "Local",
			)!
			let secondVariables = (
				await client.variablesRequest({
					variablesReference: secondLocal.variablesReference,
				})
			).body.variables
			let secondOlder = secondVariables.find(
				(variable) => variable.name === "older",
			)!

			expect(secondOlder.value).toBe('[ "ada" = 1, "sam" = 25, "alex" = 40 ]')

			let secondEntries = (
				await client.variablesRequest({
					variablesReference: secondOlder.variablesReference,
				})
			).body.variables

			expect(secondEntries.map((each) => each.value)).toEqual([
				'{ key = "ada", value = 1 }',
				'{ key = "sam", value = 25 }',
				'{ key = "alex", value = 40 }',
			])

			await Promise.all([
				client.continueRequest({ threadId: 1 }),
				client.waitForEvent("terminated"),
			])
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	}, 60_000)

	// NOTE: The other thing a launch can be: a test rather than a Program. The
	// bundle is compiled WITH the `tests { … }` block a build drops, and a
	// runner beside it asks the registry for the tests named — so what is
	// launched and what a breakpoint is addressed to are two different files,
	// and this is what says the second one still binds.
	it("debugs a test out of a file's tests section", async () => {
		client = await startedClient()

		let directory = realpathSync(
			mkdtempSync(path.join(tmpdir(), "essence-dap-tests-")),
		)
		let programPath = path.join(directory, "Rules.es")

		writeFileSync(
			programPath,
			"implementation {\n" +
				"\tfunction double(_ value: Integer) -> Integer {\n" +
				"\t\t<- value::multiply(with 2)\n" +
				"\t}\n" +
				"}\n" +
				"\n" +
				"tests {\n" +
				'\ttest "doubles" {\n' +
				"\t\tconstant doubled = double(21)\n" +
				"\n" +
				"\t\texpect doubled::is(42)\n" +
				"\t}\n" +
				"}\n",
		)

		let output: Array<string> = []

		client.on("output", (event) => {
			if (event.body.category === "stdout") {
				output.push(event.body.output)
			}
		})

		try {
			let initialized = client.waitForEvent("initialized")
			// NOTE: The empty Array is every test of the file, which is what a
			// "Debug" on the section asks for. A named id runs that one.
			let launched = client.launch({
				program: programPath,
				tests: [],
			} as never)

			await initialized

			// NOTE: Line 9 is `constant doubled = double(21)` — a statement of
			// the TEST's body, which is in the bundle at all only because the
			// launch asked for the tests.
			let bound = await client.setBreakpointsRequest({
				source: { path: programPath },
				breakpoints: [{ line: 9 }],
			})

			expect(bound.body.breakpoints[0]!.verified).toBe(true)

			let stopped = client.waitForEvent("stopped")

			await client.configurationDoneRequest()
			await launched

			expect((await stopped).body.reason).toBe("breakpoint")

			let stack = await client.stackTraceRequest({ threadId: 1 })

			expect(stack.body.stackFrames[0]!.line).toBe(9)

			await Promise.all([
				client.continueRequest({ threadId: 1 }),
				client.waitForEvent("terminated"),
			])

			expect(output.join("")).toContain("✓ doubles")
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
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
