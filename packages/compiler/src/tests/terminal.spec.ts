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

// `Terminal` on its own terms. `stdlibGolden.spec.ts` captures through
// `Terminal.inspect`, so it cannot pin the Methods that write. `print` renders
// through `Printable` and ends the line. `inspect` renders the structure of any
// value and answers it unchanged. `write` adds nothing. Only running a Program
// shows any of that.

// `inspect` writes through `console.log`, while `write` uses the process's
// streams, since the console cannot leave a line open. A capture of only one
// would miss the newline that tells `print` from `write`.
type Written = {
	// The raw text each stream received, in order, since a spec often asserts
	// that a line break is absent.
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

	// `console.log` appends a newline, so the interception appends one too.
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
		// A String's `toString` is itself, so `print` writes its text, while
		// `inspect` writes the Literal with its quotes.
		it("writes a String's text, without the quotes a Literal carries", async () => {
			let written = await write(`implementation {
				Terminal.print("hello")
			}`)

			expect(written.output).toBe("hello\n")
			expect(written.error).toBe("")
		})

		// `print` adds the newline in Essence, so two prints are two lines.
		it("ends each line, and adds nothing else", async () => {
			let written = await write(`implementation {
				Terminal.print("one")
				Terminal.print("two")
			}`)

			expect(written.output).toBe("one\ntwo\n")
		})

		// A Choice prints as its Namespace's `toString` says, which for
		// `Ordering` is the bare Case name.
		it("renders through the value's own Printable conformance", async () => {
			let written = await write(`implementation {
				Terminal.print(42)
				Terminal.print(true)
				Terminal.print(1::compare(to 2))
			}`)

			expect(written.output).toBe("42\ntrue\nLess\n")
		})

		// The `to` Argument picks the stream and changes nothing else. Left
		// out, it defaults to `#Output`.
		it("writes to the Stream the call names", async () => {
			let written = await write(`implementation {
				Terminal.print("fine", to #Output)
				Terminal.print("broken", to #Error)
			}`)

			expect(written.output).toBe("fine\n")
			expect(written.error).toBe("broken\n")
		})

		// `Printable` is a bound, so a value that conforms to nothing is refused
		// at the call.
		it("refuses a value that conforms to no Printable", () => {
			// A Choice is Printable only where a Namespace declares it, and
			// this one has none.
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
		// No newline, quotes or separator, so three writes make one line.
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

		// `write` takes text only. A Printable value goes through `print`.
		it("refuses a value that is not a String", () => {
			let diagnostics = diagnosticsOf(`implementation {
				Terminal.write(42)
			}`)

			expect(containsErrors(diagnostics)).toBe(true)
		})
	})

	describe("inspect", () => {
		// The structural form, for the Program's author, keeps a String's quotes.
		it("writes a String with its quotes", async () => {
			let written = await write(`implementation {
				Terminal.inspect("hello")
			}`)

			expect(written.output).toBe('"hello"\n')
		})

		// The Record's Namespace declares no `toString`, so `print` would refuse
		// it, while `inspect` lays out any value.
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

		// It answers the value it was handed, so it can wrap any Expression
		// without changing what it evaluates to.
		it("answers with the value it was given", async () => {
			let written = await write(`implementation {
				constant total = Terminal.inspect(1)::add(Terminal.inspect(2))

				Terminal.print(total)
			}`)

			expect(written.output).toBe("1\n2\n3\n")
		})
	})

	describe("describe", () => {
		// The rendering `inspect` writes, answered as a String, so a message can
		// carry a value's structure. A String keeps its Literal quotes.
		it("answers a String's structural form, quotes included", async () => {
			let written = await write(`implementation {
				Terminal.print(Terminal.describe("hello"))
			}`)

			expect(written.output).toBe('"hello"\n')
		})

		// `inspect` can only write, so this is how a failure message or a log
		// line carries a value's structure.
		it("puts a value's structure inside a message", async () => {
			let written = await write(`implementation {
				constant total = { won = 2, lost = 1 }

				Terminal.print("unexpected: {Terminal.describe(total)}")
			}`)

			expect(written.output).toBe("unexpected: { won = 2, lost = 1 }\n")
		})

		// A Record holding a List, a Dictionary and a Case, so every container
		// the structural walk knows is rendered. The Strings inside are quoted.
		it("lays out a Record, a List, a Dictionary and a Case", async () => {
			let written = await write(`implementation {
				Terminal.print(Terminal.describe({ name = "x", tags = ["a", ""] }))
				Terminal.print(Terminal.describe(["a" = 1, "b" = 2]))
				Terminal.print(Terminal.describe(1::compare(to 2)))
				Terminal.print(Terminal.describe("a"::firstIndex(of "b")))
			}`)

			expect(written.output).toBe(
				[
					'{ name = "x", tags = [ "a", "" ] }',
					'[ "a" = 1, "b" = 2 ]',
					"Ordering#Less",
					"Optional#Empty",
					"",
				].join("\n"),
			)
		})

		// Any value, with or without a conformance.
		it("takes a value that conforms to no Printable", async () => {
			let written = await write(`implementation {
				choice Colour {
					Red,
					Blue,
				}

				constant chosen: Colour = Colour#Red

				Terminal.print(Terminal.describe(chosen))
			}`)

			expect(written.output).toBe("Colour#Red\n")
		})

		// `inspect` writes exactly the String this answers.
		it("answers exactly what inspect writes", async () => {
			let written = await write(`implementation {
				constant value = { name = "x", scores = [1, 2] }

				Terminal.inspect(value)
				Terminal.write(Terminal.describe(value))
				Terminal.write("\n")
			}`)

			let lines = written.output.split("\n")

			expect(lines[0]).toBe('{ name = "x", scores = [ 1, 2 ] }')
			expect(lines[1]).toBe(lines[0])
		})
	})

	// The Optimiser must never drop a `Terminal` call. `isPureExpression` names
	// no `Terminal` entry, but its allowlist could widen by accident, and a lost
	// print leaves no Diagnostic. So a Program puts a print where a pass would
	// drop it.
	describe("purity", () => {
		// `&&` short-circuits and Essence's `and` does not, so
		// `lower-scalar-operations` uses `&&` only when the right operand is pure.
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

		// A read takes no Argument, so two reads look alike to a pass that
		// compares Expressions. They answer different lines, so both must stay.
		it("emits both reads of an expression that reads twice", () => {
			let javaScript = compile(`implementation {
				constant joined = Terminal.readLine()::value(defaultingTo "")::append(
					Terminal.readLine()::value(defaultingTo ""),
				)

				Terminal.write(joined)
			}`)

			expect(javaScript.split("Terminal.readLine(").length - 1).toBe(2)
		})
	})
})
