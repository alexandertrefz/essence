import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The Namespace every other spec here PRINTS through, tested on its own
// terms. `stdlibGolden.spec.ts` can not cover it — that harness works by
// calling `Terminal.inspect`, so a `Terminal.print` beside it would print
// twice and a `Terminal.write` would put text in the middle of a captured line
// — so this is where the three Methods' behaviour is pinned.
//
// NOTE: What has to be true, and is not true of any other standard library
// Method: `print` renders through `Printable` and ENDS THE LINE, `inspect`
// renders the STRUCTURE of any value at all and answers with it unchanged, and
// `write` adds NOTHING. Every one of those is invisible to every stage before
// the emitted Program runs, so every one of them is checked by running one.

// NOTE: Both streams are intercepted, not just `console.log`. `inspect` goes
// through `console.log` because a structural rendering is a whole line by
// construction; `write` goes through `process.stdout.write`/`process.stderr.write`
// because there is no way to spell "no newline" through the console. So a test
// that only captured one of the two would see half of what a Program wrote —
// and the missing newline, which is the whole difference between `print` and
// `write`, would be exactly what it missed.
type Written = {
	// NOTE: The raw text each stream received, concatenated in order. Raw
	// rather than split into lines: what is being asserted is often the
	// ABSENCE of a line break.
	output: string
	error: string
}

function compile(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function write(source: string): Promise<Written> {
	let javaScript = compile(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-terminal-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let written: Written = { output: "", error: "" }
	let originalLog = console.log
	let originalOut = process.stdout.write
	let originalError = process.stderr.write

	// NOTE: `console.log` appends the newline its callers rely on, so the
	// interception has to append one too — otherwise an `inspect` and a `print`
	// of the same value would look alike here, which is the one distinction
	// this file exists to make.
	console.log = (...args: Array<unknown>) => {
		written.output += `${args.map((arg) => String(arg)).join(" ")}\n`
	}

	process.stdout.write = ((chunk: unknown) => {
		written.output += String(chunk)

		return true
	}) as typeof process.stdout.write

	process.stderr.write = ((chunk: unknown) => {
		written.error += String(chunk)

		return true
	}) as typeof process.stderr.write

	try {
		await import(file)
	} finally {
		console.log = originalLog
		process.stdout.write = originalOut
		process.stderr.write = originalError
		rmSync(directory, { recursive: true, force: true })
	}

	return written
}

function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return parsed.diagnostics
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		return enriched.diagnostics
	}

	return validate(enriched.program)
}

describe("Terminal", () => {
	describe("print", () => {
		// NOTE: THE distinction. A String is a Printable whose `toString` is
		// itself, so `print` writes its text; `inspect` writes the Literal a
		// reader would have to type to get it back, quotes included. Getting
		// this backwards is what made every fixture read like a debugger.
		it("writes a String's text, without the quotes a Literal carries", async () => {
			let written = await write(`implementation {
				Terminal.print("hello")
			}`)

			expect(written.output).toBe("hello\n")
			expect(written.error).toBe("")
		})

		// NOTE: The newline is `print`'s, added in Essence around the value's
		// rendering — so two prints are two lines with nothing between them.
		it("ends each line, and adds nothing else", async () => {
			let written = await write(`implementation {
				Terminal.print("one")
				Terminal.print("two")
			}`)

			expect(written.output).toBe("one\ntwo\n")
		})

		// NOTE: Rendered through the value's OWN `Printable` conformance, not
		// through the structural printer — an Integer reads as its digits and a
		// Choice as whatever its Namespace's `toString` says, which for
		// `Ordering` is the bare word.
		it("renders through the value's own Printable conformance", async () => {
			let written = await write(`implementation {
				Terminal.print(42)
				Terminal.print(true)
				Terminal.print(1::compare(to 2))
			}`)

			expect(written.output).toBe("42\ntrue\nLess\n")
		})

		// NOTE: The `to` Overload picks the stream, and nothing else changes —
		// same rendering, same newline, other file handle. The stream-less entry
		// IS this one applied to `#Output`, so a Program that never names a
		// Stream is writing to one all the same.
		it("writes to the Stream the call names", async () => {
			let written = await write(`implementation {
				Terminal.print("fine", to #Output)
				Terminal.print("broken", to #Error)
			}`)

			expect(written.output).toBe("fine\n")
			expect(written.error).toBe("broken\n")
		})

		// NOTE: `Printable` is a BOUND, so a value that conforms to nothing is
		// refused where a Program asks for it to be printed — and refused at the
		// call, with a Diagnostic, rather than rendered as whatever the runtime
		// could make of it.
		it("refuses a value that conforms to no Printable", () => {
			// NOTE: A Choice derives `Equatable` from its tags and nothing
			// else — `Printable` is a decision about how it should READ, so it
			// has to be written, and this one does not write it.
			let diagnostics = diagnosticsOf(`implementation {
				choice Colour {
					Red,
					Blue,
				}

				constant chosen: Colour = Colour#Red

				Terminal.print(chosen)
			}`)

			expect(containsErrors(diagnostics)).toBe(true)
		})
	})

	describe("write", () => {
		// NOTE: The primitive. No newline, no quotes, no separator — three
		// writes are one line, which is the whole reason it exists beside
		// `print`.
		it("adds nothing at all to the text it is given", async () => {
			let written = await write(`implementation {
				Terminal.write("a")
				Terminal.write("b")
				Terminal.write("c")
			}`)

			expect(written.output).toBe("abc")
		})

		it("writes to the Stream the call names", async () => {
			let written = await write(`implementation {
				Terminal.write("out", to #Output)
				Terminal.write("err", to #Error)
			}`)

			expect(written.output).toBe("out")
			expect(written.error).toBe("err")
		})

		// NOTE: A String and nothing else. `write` is about TEXT — a value with
		// a `Printable` conformance is what `print` takes, and routing one
		// through here would silently make `write` a second `print` without the
		// newline.
		it("refuses a value that is not a String", () => {
			let diagnostics = diagnosticsOf(`implementation {
				Terminal.write(42)
			}`)

			expect(containsErrors(diagnostics)).toBe(true)
		})
	})

	describe("inspect", () => {
		// NOTE: The structural form, for the Program's AUTHOR — a String comes
		// back with the quotes a Literal is written with, which is exactly what
		// `print` leaves off.
		it("writes a String with its quotes", async () => {
			let written = await write(`implementation {
				Terminal.inspect("hello")
			}`)

			expect(written.output).toBe('"hello"\n')
		})

		// NOTE: Any value at all, conformance or none. The Record below belongs
		// to a Namespace that declares no `toString`, so `print` would refuse it
		// — and `inspect` lays it out anyway, which is the other half of why the
		// two are separate Methods.
		it("takes a value that conforms to no Printable", async () => {
			let written = await write(`implementation {
				choice Colour {
					Red,
					Blue,
				}

				constant chosen: Colour = Colour#Red

				Terminal.inspect(chosen)
			}`)

			expect(written.output).toBe("Colour#Red\n")
		})

		// NOTE: It answers with the very value it was handed, so it can be
		// wrapped around any Expression without changing what that Expression
		// evaluates to. That is what let every printing call site in this
		// repository become a `Terminal.inspect` without the golden file moving.
		it("answers with the value it was given", async () => {
			let written = await write(`implementation {
				constant total = Terminal.inspect(1)::add(Terminal.inspect(2))

				Terminal.print(total)
			}`)

			expect(written.output).toBe("1\n2\n3\n")
		})
	})

	// NOTE: The Optimiser may never take one of these away. `isPureExpression`
	// answers "can this be left unevaluated" and its enumeration of pure Method
	// calls names no `Terminal` entry — but the enumeration is an allowlist, and
	// an allowlist is exactly the kind of thing a later entry can widen by
	// accident. A print that stops happening leaves no Diagnostic and no crash,
	// so it is pinned by running a Program whose print stands where a pass would
	// most like to drop it.
	describe("purity", () => {
		// NOTE: `and` short-circuits in JavaScript and does not in Essence, so
		// `lower-scalar-operations` may only compile it to `&&` when the right
		// operand can be left unevaluated. A print there is the case it must
		// refuse.
		it("keeps a print standing as the Argument of a short-circuiting call", async () => {
			let written = await write(`implementation {
				function noisy () -> Boolean {
					Terminal.print("the Argument ran")

					<- true
				}

				constant decided = false::and(noisy())

				Terminal.print(decided)
			}`)

			expect(written.output).toBe("the Argument ran\nfalse\n")
		})
	})
})
