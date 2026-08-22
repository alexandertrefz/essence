import { describe, expect, test } from "bun:test"

import type { StreamType } from "../Stream"
import { createString } from "../String"
import { write } from "../Terminal"
import { typeKeySymbol } from "../type"

// NOTE: `write` is the one primitive under everything a Program puts in front
// of a person, and the one runtime Function whose behaviour depends on what
// HOST it runs on: Bun, Node and Deno give it `process.stdout` and
// `process.stderr`, a browser gives it nothing but a console made of lines.
// Each of these tests stages one host around a call and reads back what the
// host received — the real streams are intercepted rather than written, since
// the text would otherwise land in the test runner's own output.

const output: StreamType = { [typeKeySymbol]: "Stream#Output" }
const error: StreamType = { [typeKeySymbol]: "Stream#Error" }

// NOTE: Three hosts. `streams` is Bun, Node and Deno: both streams present and
// writable. `shim` is a bundler's `process` polyfill: a `process` exists, but
// its `stdout` is an empty object and its `stderr` is null, so neither can be
// written to. `none` is a browser: no `process` at all, and a bare `process`
// is a ReferenceError there, which is what `typeof` guards.
type Host = "streams" | "shim" | "none"

type Seen = {
	// NOTE: Raw text per stream, concatenated: what is asserted is as often
	// the ABSENCE of a newline as its presence.
	stdout: string
	stderr: string
	// NOTE: One entry per console call, so a newline inside an entry and a
	// newline the console would add between two can not be confused.
	logged: Array<string>
	errored: Array<string>
}

function observe(host: Host, body: () => void): Seen {
	let seen: Seen = { stdout: "", stderr: "", logged: [], errored: [] }
	let originalLog = console.log
	let originalError = console.error
	let originalOut = process.stdout.write
	let originalErr = process.stderr.write
	let originalStdout = Object.getOwnPropertyDescriptor(process, "stdout")
	let originalStderr = Object.getOwnPropertyDescriptor(process, "stderr")
	let originalProcess = globalThis.process

	console.log = (...args: Array<unknown>) => {
		seen.logged.push(args.map((arg) => String(arg)).join(" "))
	}

	console.error = (...args: Array<unknown>) => {
		seen.errored.push(args.map((arg) => String(arg)).join(" "))
	}

	try {
		if (host === "streams") {
			process.stdout.write = ((chunk: unknown) => {
				seen.stdout += String(chunk)

				return true
			}) as typeof process.stdout.write

			process.stderr.write = ((chunk: unknown) => {
				seen.stderr += String(chunk)

				return true
			}) as typeof process.stderr.write
		} else if (host === "shim") {
			Object.defineProperty(process, "stdout", {
				value: {},
				configurable: true,
				writable: true,
			})
			Object.defineProperty(process, "stderr", {
				value: null,
				configurable: true,
				writable: true,
			})
		} else {
			;(globalThis as { process?: unknown }).process = undefined
		}

		body()
	} finally {
		// NOTE: Undone in the reverse order, and every branch restores exactly
		// what it replaced — the runner's own reporting writes to these
		// streams the moment the test returns.
		if (host === "none") {
			;(globalThis as { process?: unknown }).process = originalProcess
		} else if (host === "shim") {
			if (originalStdout !== undefined) {
				Object.defineProperty(process, "stdout", originalStdout)
			}

			if (originalStderr !== undefined) {
				Object.defineProperty(process, "stderr", originalStderr)
			}
		} else {
			process.stdout.write = originalOut
			process.stderr.write = originalErr
		}

		console.log = originalLog
		console.error = originalError
	}

	return seen
}

describe("writing to a host with streams", () => {
	test("the text reaches the stream exactly as given", () => {
		let seen = observe("streams", () => {
			write(createString("no newline, then "), output)
			write(createString("a line\n"), output)
			write(createString("two\n\n"), output)
		})

		expect(seen.stdout).toBe("no newline, then a line\ntwo\n\n")
		expect(seen.stderr).toBe("")
		expect(seen.logged).toEqual([])
	})

	test("the Error Stream is the error stream", () => {
		let seen = observe("streams", () => {
			write(createString("complaint\n"), error)
		})

		expect(seen.stderr).toBe("complaint\n")
		expect(seen.stdout).toBe("")
		expect(seen.errored).toEqual([])
	})
})

describe("writing to a host without streams", () => {
	// NOTE: `print` hands `write` the value and a newline; the console ends
	// every line it is handed itself. So the newline `print` appended comes
	// off, and a printed line is one console line — not a line and a blank.
	test("a printed line is one console line", () => {
		let seen = observe("none", () => {
			write(createString("a line\n"), output)
			write(createString("complaint\n"), error)
		})

		expect(seen.logged).toEqual(["a line"])
		expect(seen.errored).toEqual(["complaint"])
		expect(seen.stdout).toBe("")
		expect(seen.stderr).toBe("")
	})

	// NOTE: Exactly one newline, never all of them: `print("")` is a blank
	// line and has to stay one, and a text ending in two is a line and a
	// blank line after it.
	test("exactly one trailing newline comes off", () => {
		let seen = observe("none", () => {
			write(createString("\n"), output)
			write(createString("two\n\n"), output)
		})

		expect(seen.logged).toEqual(["", "two\n"])
	})

	// NOTE: The console has no way to continue a line, so a text without a
	// newline becomes a line of its own there — unchanged, rather than
	// dropped or held back until something ends it.
	test("text without a newline is a line of its own", () => {
		let seen = observe("none", () => {
			write(createString("no newline"), output)
		})

		expect(seen.logged).toEqual(["no newline"])
	})

	// NOTE: A `process` whose streams can not be written to is the same as no
	// `process` — it is the stream's `write` that is looked for, not the
	// global, since a bundler's shim has the one without the other.
	test("a process shim without writable streams counts as no streams", () => {
		let seen = observe("shim", () => {
			write(createString("a line\n"), output)
			write(createString("complaint\n"), error)
		})

		expect(seen.logged).toEqual(["a line"])
		expect(seen.errored).toEqual(["complaint"])
	})
})
