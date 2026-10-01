import { describe, expect, test } from "bun:test"

import type { StreamType } from "../Stream"
import { createString } from "../String"
import { write } from "../Terminal"
import { typeKeySymbol } from "../type"

// Each test stages one host around a call to `write` and reads back what the
// host received. The real streams are intercepted so the text stays out of the
// runner's output. See "Writing to the host" in packages/runtime/DEVELOPMENT.md.

const output: StreamType = { [typeKeySymbol]: "Stream#Output" }
const error: StreamType = { [typeKeySymbol]: "Stream#Error" }

// `streams` is Bun, Node and Deno. `shim` is a bundler's `process` polyfill,
// whose `stdout` is an empty object and `stderr` null. `none` is a browser,
// with no `process` at all.
type Host = "streams" | "shim" | "none"

type Seen = {
	// Raw text per stream, since a missing newline matters as much as one.
	stdout: string
	stderr: string
	// One entry per console call, so a newline inside an entry stays apart from
	// the one the console adds.
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
		// Each branch restores exactly what it replaced: the runner writes its
		// report to these streams as soon as the test returns.
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
	// The console ends every line itself, so the newline `print` appended comes
	// off.
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

	// `print("")` is a blank line and must stay one.
	test("exactly one trailing newline comes off", () => {
		let seen = observe("none", () => {
			write(createString("\n"), output)
			write(createString("two\n\n"), output)
		})

		expect(seen.logged).toEqual(["", "two\n"])
	})

	test("text without a newline is a line of its own", () => {
		let seen = observe("none", () => {
			write(createString("no newline"), output)
		})

		expect(seen.logged).toEqual(["no newline"])
	})

	// `write` looks for the stream's `write` rather than the `process` global,
	// since a shim has the one without the other.
	test("a process shim without writable streams counts as no streams", () => {
		let seen = observe("shim", () => {
			write(createString("a line\n"), output)
			write(createString("complaint\n"), error)
		})

		expect(seen.logged).toEqual(["a line"])
		expect(seen.errored).toEqual(["complaint"])
	})
})
