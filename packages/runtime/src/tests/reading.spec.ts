import { describe, expect, test } from "bun:test"

import { readAll, readLine, withInputSource } from "../Terminal"
import { typeKeySymbol } from "../type"

// NOTE: The reading half of `writing.spec.ts`, and host-dependent for the same
// reason: Bun and Node read descriptor 0 through `node:fs`, Deno through
// `Deno.stdin.readSync`, and a browser has neither. What a Program reads is
// also the one thing the runtime BUFFERS — a host answers bytes at whatever
// boundary it had them, and a line ends where the text says — so most of what
// is asserted here is that the buffering hands out exactly what came in.
//
// NOTE: Two ways in. `withInputSource(text, …)` stages the whole input, which
// is what pins the line rules; a staged `Deno` stages the HOST, which is what
// pins the chunking and the decoding underneath them. The end-to-end path, a
// compiled Program reading a pipe, is `packages/cli/src/tests/terminalInput.spec.ts`.

// NOTE: An answer read back as plain JavaScript, so that a test asserts on a
// line rather than on an Optional's shape. `null` is `#Empty`.
function lineOf(answer: ReturnType<typeof readLine>): string | null {
	return answer[typeKeySymbol] === "Optional#Empty" ? null : answer.item.value
}

function linesOf(text: string): Array<string | null> {
	return withInputSource(text, () => {
		let seen: Array<string | null> = []

		// NOTE: One read past the end on purpose: the end of the input has to
		// stay the end, rather than becoming an empty line for every further
		// call.
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

	// NOTE: A text that stops without a break still ends in a line. The
	// alternative — dropping it — loses the last line of every file an editor
	// wrote without a final newline.
	test("a last line without a break is a line", () => {
		expect(linesOf("alpha\nbeta")).toEqual(["alpha", "beta", null])
	})

	test("an empty line is a line", () => {
		expect(linesOf("\n\nx\n")).toEqual(["", "", "x", null])
	})

	test("the end of the input answers nothing, not an empty line", () => {
		expect(linesOf("")).toEqual([null])
	})

	// NOTE: The three breaks `String::lines` splits on, so that reading a text
	// line by line and splitting the same text into lines answer the same
	// lines.
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
	// NOTE: Unchanged, which is what makes `readAll` the reading side of
	// `write`: a Program that reads its input and writes it back writes what it
	// was given, final break included.
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

	// NOTE: The two Methods read one stream, so what a line took is gone and
	// what `readAll` takes is the rest of it — including the middle of a line.
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

// NOTE: The staged source is scoped to the call, exactly as an output sink is —
// which is what makes reading testable at all, since the buffer under these
// Methods is the one piece of state a caller can not otherwise reach.
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

// NOTE: A host that answers bytes rather than text, staged as Deno's — the one
// host whose reading is a Method of its own rather than `node:fs`. It is also
// how the pieces underneath a line are reached: a read answers what the host
// HAS, so a line arrives in as many pieces as the host felt like, and a
// character of three bytes can arrive in two of them.
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
		// NOTE: `null` as the staged text means the HOST's input, read from the
		// start — which is what puts the buffer back to empty around each of
		// these.
		return withInputSource(null, run)
	} finally {
		if (previous === undefined) {
			delete host.Deno
		} else {
			Object.defineProperty(host, "Deno", previous)
		}
	}
}

// NOTE: A reader that hands over one chunk per call and answers the end of the
// input the way Deno does, with `null` rather than with zero.
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

	// NOTE: A decoder told `stream: true` holds the half of a character it has
	// until the rest arrives. Without it the two halves each become the
	// replacement character, and a text read in pieces stops being the text
	// that was written.
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

	// NOTE: A break that arrives as `\r` and then `\n` is still one break: the
	// `\r` at the end of what has been read is the one character the runtime
	// can not decide on yet, so it asks the host again before it does.
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

// NOTE: A browser, where there is no descriptor to read and no `Deno`. It
// answers the end of the input rather than throwing, exactly as `write` falls
// back to the console rather than refusing to write.
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
