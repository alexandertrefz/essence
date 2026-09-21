import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { EXIT_SUCCESS } from "../actions"

// NOTE: `Terminal.readLine`, `readAll` and `ask` read descriptor 0, and nothing
// short of a real process has one. So this file compiles a Program once and
// then RUNS it, as a child with its input piped in — the only place in the
// suite where what a Program reads is what a person at a keyboard would have
// given it. The line rules themselves are pinned in
// `packages/runtime/src/tests/reading.spec.ts`, against a staged source; what
// is pinned here is that a compiled Program on a real host reads the same
// lines, and that the CLI hands its own input over.

// NOTE: A cache of this run's own, passed to the child rather than assigned
// into this process — `cli.spec.ts` runs in the same process and owns the
// assignment there, and two specs assigning one variable is a race whichever
// order they load in.
let bundleCache = mkdtempSync(path.join(tmpdir(), "essence-input-cache-"))
let workspace = mkdtempSync(path.join(tmpdir(), "essence-input-"))

afterAll(() => {
	rmSync(bundleCache, { recursive: true, force: true })
	rmSync(workspace, { recursive: true, force: true })
})

const binary = fileURLToPath(import.meta.resolve("../../bin/essence"))

// NOTE: The environment is handed over rather than inherited: Bun does not
// carry a `process.env` a spec assigned into a child.
function childEnvironment(): NodeJS.ProcessEnv {
	return { ...process.env, ESSENCE_CLI_CACHE: bundleCache }
}

// NOTE: Compiled ONCE, in `beforeAll`, and run per test. A compile is most of a
// second and the reading is none of it, so a build per case would spend a
// dozen seconds saying the same thing about the same bundle.
function build(name: string, source: string): string {
	let sourceFile = path.join(workspace, `${name}.es`)

	writeFileSync(sourceFile, source)

	let built = spawnSync(
		process.execPath,
		[binary, "build", sourceFile, "--quiet"],
		{ encoding: "utf-8", env: childEnvironment() },
	)

	if (built.status !== EXIT_SUCCESS) {
		throw new Error(
			`${name}.es did not build: ${built.stdout}${built.stderr}`,
		)
	}

	return path.join(workspace, `${name}.js`)
}

type Run = { out: string; err: string; code: number | null }

function run(bundle: string, input: string): Run {
	let finished = spawnSync(process.execPath, [bundle], {
		input,
		encoding: "utf-8",
	})

	return {
		out: finished.stdout,
		err: finished.stderr,
		code: finished.status,
	}
}

// NOTE: Every line, one per line of output, and the count after them — so a
// case says both what the lines were and where the input ended.
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

beforeAll(() => {
	lines = build("Lines", LINES)
})

describe("a Program reading its input", () => {
	it("reads a line at a time, without the break that ends it", () => {
		let finished = run(lines, "alpha\nbeta\n")

		expect(finished.out).toBe('"alpha"\n"beta"\nlines: 2\n')
		expect(finished.code).toBe(EXIT_SUCCESS)
	})

	// NOTE: A text an editor wrote without a final newline still ends in a
	// line, and the count is what says the line was not dropped.
	it("reads a last line that ends without a break", () => {
		expect(run(lines, "alpha\nbeta").out).toBe(
			'"alpha"\n"beta"\nlines: 2\n',
		)
	})

	it("reads a blank line as an empty line", () => {
		expect(run(lines, "\nalpha\n").out).toBe('""\n"alpha"\nlines: 2\n')
	})

	it("answers nothing at once for an empty input", () => {
		expect(run(lines, "").out).toBe("lines: 0\n")
	})

	// NOTE: The break a Windows host writes is one break, not a line ending in
	// a stray carriage return — which is what a Program comparing a line
	// against a written String would otherwise find.
	it("reads a Windows break as one break", () => {
		expect(run(lines, "alpha\r\nbeta\r\n").out).toBe(
			'"alpha"\n"beta"\nlines: 2\n',
		)
	})

	// NOTE: Larger than the buffer the runtime reads with, so that the answer
	// depends on the pieces being joined rather than on one crossing having
	// held the whole input.
	it("reads an input longer than one read of the host", () => {
		let long = `${"x".repeat(70_000)}\ny\n`
		let finished = run(lines, long)

		expect(finished.out).toBe(`"${"x".repeat(70_000)}"\n"y"\nlines: 2\n`)
	})
})

describe("a Program reading everything at once", () => {
	let all = ""

	beforeAll(() => {
		all = build(
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

	// NOTE: Unchanged, break at the end included — a Program that reads its
	// input and writes it back writes what it was given.
	it("answers the text exactly", () => {
		expect(run(all, "alpha\nbeta\n").out).toBe("length: 11\nalpha\nbeta\n")
	})

	it("answers the empty String for an empty input", () => {
		expect(run(all, "").out).toBe("length: 0\n")
	})
})

describe("a Program asking a question", () => {
	let ask = ""

	beforeAll(() => {
		ask = build(
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

	// NOTE: The prompt carries no newline of its own, so the answer a person
	// types lands on the line the question is on — which is why `ask` is a
	// `write` rather than a `print`.
	it("writes the prompt with no newline, then reads the answer", () => {
		expect(run(ask, "Ada\n").out).toBe("name? hello, Ada\n")
	})

	it("answers nothing when there is no line to read", () => {
		expect(run(ask, "").out).toBe("name? hello, nobody\n")
	})
})

// NOTE: A read is an effect, and the Optimiser's purity table is an allowlist
// that `Terminal` is deliberately absent from. Two reads in one Expression look
// alike to any pass comparing Expressions, and they are not alike: the first
// answers one line and the second the next. `terminal.spec.ts` pins that both
// survive into the emitted JavaScript; this pins that both actually run.
describe("two reads in one Expression", () => {
	let twice = ""

	beforeAll(() => {
		twice = build(
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

	it("reads two lines", () => {
		expect(run(twice, "alpha\nbeta\n").out).toBe("alphabeta\n")
	})
})

// NOTE: The CLI runs a Program as a child of its own with the streams
// inherited, so a Program reading its input is reading whatever the CLI was
// given. Under --json the report is alone on stdout and the Program's own
// output goes to stderr, and the input still arrives — which is the pairing a
// script piping into `essence run … --json | jq` depends on.
describe("essence run", () => {
	it("hands its own input to the Program", () => {
		let finished = spawnSync(
			process.execPath,
			[binary, "run", path.join(workspace, "Lines.es"), "--json"],
			{
				input: "alpha\nbeta\n",
				encoding: "utf-8",
				env: childEnvironment(),
			},
		)

		expect(finished.stderr).toBe('"alpha"\n"beta"\nlines: 2\n')
		expect(finished.status).toBe(EXIT_SUCCESS)
	})
})
