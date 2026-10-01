import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"

import { EXIT_SUCCESS } from "../actions"

// `Terminal.readLine`, `readAll` and `ask` read descriptor 0, which only a real
// process has. So a compiled Program runs as a child with piped input. The line
// rules are pinned in `packages/runtime/src/tests/reading.spec.ts`; this pins a
// real host, and that the CLI hands its input over.

// A cache of this run's own, passed to the child rather than assigned here,
// since `cli.spec.ts` assigns the variable in this process.
let bundleCache = mkdtempSync(path.join(tmpdir(), "essence-input-cache-"))
let workspace = mkdtempSync(path.join(tmpdir(), "essence-input-"))

afterAll(() => {
	rmSync(bundleCache, { recursive: true, force: true })
	rmSync(workspace, { recursive: true, force: true })
})

const binary = fileURLToPath(import.meta.resolve("../../bin/essence"))

// Passed explicitly, since Bun does not give a child a spec's `process.env`
// assignments.
function childEnvironment(): NodeJS.ProcessEnv {
	return { ...process.env, ESSENCE_CLI_CACHE: bundleCache }
}

// Compiled once, in `beforeAll`, and run per test.
async function build(name: string, source: string): Promise<string> {
	let sourceFile = path.join(workspace, `${name}.es`)

	writeFileSync(sourceFile, source)

	let built = await spawnAndWait(
		[process.execPath, binary, "build", sourceFile, "--quiet"],
		{ env: childEnvironment() },
	)

	if (built.code !== EXIT_SUCCESS) {
		throw new Error(
			`${name}.es did not build: ${built.stdout}${built.stderr}`,
		)
	}

	return path.join(workspace, `${name}.js`)
}

type Run = { out: string; err: string; code: number | null }

async function run(bundle: string, input: string): Promise<Run> {
	let finished = await spawnAndWait([process.execPath, bundle], { input })

	return {
		out: finished.stdout,
		err: finished.stderr,
		code: finished.code,
	}
}

// Each line read, then the count, so a case shows the lines and where input
// ended.
const LINES = [
	"implementation {",
	"	function drain(_ count: Integer) -> Integer {",
	"		<- match Terminal.readLine() -> Integer {",
	"			case #Value(line) {",
	"				Terminal.print(Terminal.describe(line))",
	"",
	"				<- drain(count::add(1))",
	"			}",
	"			case #Empty {",
	"				<- count",
	"			}",
	"		}",
	"	}",
	"",
	'	Terminal.print("lines: {drain(0)}")',
	"}",
	"",
].join("\n")

let lines = ""

beforeAll(async () => {
	lines = await build("Lines", LINES)
})

describe("a Program reading its input", () => {
	it("reads a line at a time, without the break that ends it", async () => {
		let finished = await run(lines, "alpha\nbeta\n")

		expect(finished.out).toBe('"alpha"\n"beta"\nlines: 2\n')
		expect(finished.code).toBe(EXIT_SUCCESS)
	})

	// Text without a final newline still ends in a line, and the count shows it was
	// kept.
	it("reads a last line that ends without a break", async () => {
		expect((await run(lines, "alpha\nbeta")).out).toBe(
			'"alpha"\n"beta"\nlines: 2\n',
		)
	})

	it("reads a blank line as an empty line", async () => {
		expect((await run(lines, "\nalpha\n")).out).toBe(
			'""\n"alpha"\nlines: 2\n',
		)
	})

	it("answers nothing at once for an empty input", async () => {
		expect((await run(lines, "")).out).toBe("lines: 0\n")
	})

	// A Windows line break is one break, not a line ending in a stray carriage
	// return.
	it("reads a Windows break as one break", async () => {
		expect((await run(lines, "alpha\r\nbeta\r\n")).out).toBe(
			'"alpha"\n"beta"\nlines: 2\n',
		)
	})

	// Larger than the runtime's read buffer, so the pieces must be joined.
	it("reads an input longer than one read of the host", async () => {
		let long = `${"x".repeat(70_000)}\ny\n`
		let finished = await run(lines, long)

		expect(finished.out).toBe(`"${"x".repeat(70_000)}"\n"y"\nlines: 2\n`)
	})
})

describe("a Program reading everything at once", () => {
	let all = ""

	beforeAll(async () => {
		all = await build(
			"All",
			[
				"implementation {",
				"	constant text = Terminal.readAll()",
				"",
				'	Terminal.print("length: {text::length()}")',
				"	Terminal.write(text)",
				"}",
				"",
			].join("\n"),
		)
	})

	// Unchanged, final break included.
	it("answers the text exactly", async () => {
		expect((await run(all, "alpha\nbeta\n")).out).toBe(
			"length: 11\nalpha\nbeta\n",
		)
	})

	it("answers the empty String for an empty input", async () => {
		expect((await run(all, "")).out).toBe("length: 0\n")
	})
})

describe("a Program asking a question", () => {
	let ask = ""

	beforeAll(async () => {
		ask = await build(
			"Ask",
			[
				"implementation {",
				'	constant name = Terminal.ask("name? ")::value(defaultingTo "nobody")',
				"",
				'	Terminal.print("hello, {name}")',
				"}",
				"",
			].join("\n"),
		)
	})

	// The prompt has no newline, so the answer lands on the question's line; `ask`
	// writes rather than prints.
	it("writes the prompt with no newline, then reads the answer", async () => {
		expect((await run(ask, "Ada\n")).out).toBe("name? hello, Ada\n")
	})

	it("answers nothing when there is no line to read", async () => {
		expect((await run(ask, "")).out).toBe("name? hello, nobody\n")
	})
})

// A read is an effect, and `Terminal` is absent from the Optimiser's purity
// allowlist. Two reads in one Expression answer different lines. `terminal.spec.ts`
// pins both are emitted; this pins both run.
describe("two reads in one Expression", () => {
	let twice = ""

	beforeAll(async () => {
		twice = await build(
			"Twice",
			[
				"implementation {",
				'	constant joined = Terminal.readLine()::value(defaultingTo "")::append(',
				'		Terminal.readLine()::value(defaultingTo ""),',
				"	)",
				"",
				"	Terminal.print(joined)",
				"}",
				"",
			].join("\n"),
		)
	})

	it("reads two lines", async () => {
		expect((await run(twice, "alpha\nbeta\n")).out).toBe("alphabeta\n")
	})
})

// The CLI runs a Program as a child with inherited streams, so it reads the
// CLI's input. Under `--json` its output goes to stderr and input still arrives,
// as `essence run … --json | jq` needs.
describe("essence run", () => {
	it("hands its own input to the Program", async () => {
		let finished = await spawnAndWait(
			[
				process.execPath,
				binary,
				"run",
				path.join(workspace, "Lines.es"),
				"--json",
			],
			{ input: "alpha\nbeta\n", env: childEnvironment() },
		)

		expect(finished.stderr).toBe('"alpha"\n"beta"\nlines: 2\n')
		expect(finished.code).toBe(EXIT_SUCCESS)
	})
})
