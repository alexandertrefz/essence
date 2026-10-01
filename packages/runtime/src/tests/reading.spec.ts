import { describe, expect, test } from "bun:test"

import { readAll, readLine, withInputSource } from "../Terminal"
import { typeKeySymbol } from "../type"

// `withInputSource(text, …)` stages the whole input and pins the line rules. A
// staged `Deno` stages the host and pins the chunking and decoding under them.
// `packages/cli/src/tests/terminalInput.spec.ts` reads a pipe end to end. See
// "Reading input" in packages/runtime/DEVELOPMENT.md.

// An answer read back as plain JavaScript, with `null` for `#Empty`.
function lineOf(answer: ReturnType<typeof readLine>): string | null {
	return answer[typeKeySymbol] === "Optional#Empty" ? null : answer.item.value
}

function linesOf(text: string): Array<string | null> {
	return withInputSource(text, () => {
		let seen: Array<string | null> = []

		// One read past the end, since the end must stay the end rather than
		// become an empty line.
		while (seen.length < 40) {
			let line = lineOf(readLine())

			seen.push(line)

			if (line === null) {
				return seen
			}
		}

		return seen
	})
}

describe("reading lines from a staged input", () => {
	test("a line ends at the break, and the break is not part of it", () => {
		expect(linesOf("alpha\nbeta\n")).toEqual(["alpha", "beta", null])
	})

	// Dropping it would lose the last line of a file written without a final
	// newline.
	test("a last line without a break is a line", () => {
		expect(linesOf("alpha\nbeta")).toEqual(["alpha", "beta", null])
	})

	test("an empty line is a line", () => {
		expect(linesOf("\n\nx\n")).toEqual(["", "", "x", null])
	})

	test("the end of the input answers nothing, not an empty line", () => {
		expect(linesOf("")).toEqual([null])
	})

	// The breaks `String::lines` splits on, so that reading line by line and
	// splitting answer the same lines.
	test("a Windows break is one break", () => {
		expect(linesOf("alpha\r\nbeta\r\n")).toEqual(["alpha", "beta", null])
	})

	test("a lone carriage return is a break", () => {
		expect(linesOf("alpha\rbeta\r")).toEqual(["alpha", "beta", null])
	})

	test("a carriage return the input ends on is a break of its own", () => {
		expect(linesOf("alpha\r")).toEqual(["alpha", null])
	})
})

describe("reading everything left", () => {
	// So a Program that echoes its input writes back what it was given.
	test("answers the text exactly, break at the end included", () => {
		expect(withInputSource("alpha\nbeta\n", () => readAll().value)).toBe(
			"alpha\nbeta\n",
		)
	})

	test("answers the empty String at the end of the input", () => {
		expect(withInputSource("", () => readAll().value)).toBe("")

		expect(
			withInputSource("one\n", () => {
				readLine()

				return readAll().value
			}),
		).toBe("")
	})

	test("answers what the lines already read left behind", () => {
		expect(
			withInputSource("alpha\nbeta\ngamma", () => {
				readLine()

				return readAll().value
			}),
		).toBe("beta\ngamma")
	})

	test("hands the rest to a line read after it", () => {
		expect(
			withInputSource("alpha\nbeta\n", () => {
				readAll()

				return lineOf(readLine())
			}),
		).toBe(null)
	})
})

// The staged source is scoped to the call, as an output sink is, since a caller
// can not reach the buffer otherwise.
describe("the staged source", () => {
	test("puts the buffer back when the call it wrapped is over", () => {
		let outer = withInputSource("outer\n", () => {
			let inner = withInputSource("inner\n", () => lineOf(readLine()))

			expect(inner).toBe("inner")

			return lineOf(readLine())
		})

		expect(outer).toBe("outer")
	})
})

// A host that answers bytes, staged as Deno's. A read answers what the host has,
// so a line may arrive in several pieces and a character across two.
type Reader = (into: Uint8Array) => number | null

function withHostReader<Value>(read: Reader | null, run: () => Value): Value {
	let host = globalThis as { Deno?: unknown }
	let previous = Object.getOwnPropertyDescriptor(host, "Deno")

	if (read === null) {
		delete host.Deno
	} else {
		host.Deno = { stdin: { readSync: read } }
	}

	try {
		// `null` reads the host's input from the start, so each test begins
		// with an empty buffer.
		return withInputSource(null, run)
	} finally {
		if (previous === undefined) {
			delete host.Deno
		} else {
			Object.defineProperty(host, "Deno", previous)
		}
	}
}

// Hands over one chunk per call and answers the end with `null`, as Deno does.
function chunkedReader(chunks: Array<Uint8Array>): Reader {
	let index = 0

	return (into) => {
		let chunk = chunks[index]

		if (chunk === undefined) {
			return null
		}

		index += 1
		into.set(chunk)

		return chunk.length
	}
}

function bytesOf(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

describe("reading from a host that answers bytes", () => {
	test("joins the pieces a line arrived in", () => {
		let seen = withHostReader(
			chunkedReader([bytesOf("al"), bytesOf("pha\nbe"), bytesOf("ta\n")]),
			() => [lineOf(readLine()), lineOf(readLine()), lineOf(readLine())],
		)

		expect(seen).toEqual(["alpha", "beta", null])
	})

	test("decodes a character that arrived in two pieces", () => {
		let bytes = bytesOf("中")
		let seen = withHostReader(
			chunkedReader([
				new Uint8Array([bytes[0]!]),
				new Uint8Array([bytes[1]!, bytes[2]!]),
				bytesOf("\n"),
			]),
			() => lineOf(readLine()),
		)

		expect(seen).toBe("中")
	})

	// A `\r` at the end of the buffer may be half a break, so the runtime reads
	// again before deciding.
	test("waits for the other half of a Windows break", () => {
		let seen = withHostReader(
			chunkedReader([bytesOf("alpha\r"), bytesOf("\nbeta\n")]),
			() => [lineOf(readLine()), lineOf(readLine()), lineOf(readLine())],
		)

		expect(seen).toEqual(["alpha", "beta", null])
	})

	test("reads until the host has nothing left", () => {
		let seen = withHostReader(
			chunkedReader([bytesOf("alpha\n"), bytesOf("beta")]),
			() => readAll().value,
		)

		expect(seen).toBe("alpha\nbeta")
	})
})

// A browser has no descriptor to read and no `Deno`, so reading answers the end
// of the input rather than throwing.
describe("reading on a host with no input", () => {
	test("answers nothing, and the empty String", () => {
		let host = globalThis as { process?: unknown }
		let original = host.process

		host.process = undefined

		try {
			let seen = withHostReader(null, () => [
				lineOf(readLine()),
				readAll().value,
			])

			expect(seen).toEqual([null, ""])
		} finally {
			host.process = original
		}
	})
})
