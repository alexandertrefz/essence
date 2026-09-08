import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The ordering vocabulary is Essence — `Comparable` provides the four
// inequalities over `compare`, and `Ordering::then` composes two answers — so
// what each of them says is only visible when a Program RUNS. Every claim here
// compiles AND executes rather than only type-checking.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let javaScript = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-ordering-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

// NOTE: The four moved from `Orderable` to `Comparable`, so the Types that
// carry the smaller promise answer them now. A String and a List each write
// none of the four: every answer here is the Protocol's body over that Type's
// own `compare`.
describe("Comparable's provided inequalities", () => {
	it("orders two Strings", async () => {
		expect(
			await run(
				[
					"implementation {",
					'\tTerminal.inspect("app"::isLessThan("apple"))',
					'\tTerminal.inspect("b"::isLessThan("a"))',
					'\tTerminal.inspect("b"::isGreaterThan("a"))',
					'\tTerminal.inspect("abc"::isLessThanOrEqualTo("abc"))',
					'\tTerminal.inspect("abc"::isGreaterThanOrEqualTo("abc"))',
					'\tTerminal.inspect("abc"::isGreaterThanOrEqualTo("abd"))',
					"}",
				].join("\n"),
			),
		).toEqual(["true", "false", "true", "true", "true", "false"])
	})

	// NOTE: `List::compare` is lexicographic and the shorter List comes first
	// on an equal prefix, so the four read that way too — through the
	// conditional conformance, whose item witness the provided body never
	// names itself.
	it("orders two Lists lexicographically", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect([1, 2]::isLessThan([1, 3]))",
					"\tTerminal.inspect([1]::isLessThan([1, 2]))",
					"\tTerminal.inspect([1, 3]::isGreaterThan([1, 2]))",
					"\tTerminal.inspect([1, 2]::isLessThanOrEqualTo([1, 2]))",
					'\tTerminal.inspect(["a", "b"]::isLessThan(["a", "c"]))',
					"}",
				].join("\n"),
			),
		).toEqual(["true", "true", "true", "true", "true"])
	})

	// NOTE: A String is `Comparable` and nothing more, so the two Methods a
	// number line makes meaningful are still out of reach — which is the whole
	// of what the split keeps apart.
	it("leaves isBetween and clamp on Orderable", () => {
		let parsed = parseWithDiagnostics(
			[
				"implementation {",
				'\tTerminal.inspect("b"::isBetween("a", and "c"))',
				"}",
			].join("\n"),
		)

		expect(
			enrich(parsed.program).diagnostics.map(
				(diagnostic) => diagnostic.code,
			),
		).toEqual(["unknown-method"])
	})

	// NOTE: The Namespace spelling a written Method has, on a Method no
	// Namespace writes.
	it("answers the Namespace spelling", async () => {
		expect(
			await run(
				[
					"implementation {",
					'\tTerminal.inspect(String.isLessThan("a", "b"))',
					"\tTerminal.inspect(List.isGreaterThan([2], [1]))",
					"}",
				].join("\n"),
			),
		).toEqual(["true", "true"])
	})

	// NOTE: A bounded call reaches the same bodies through the witness it was
	// handed, which is what the four being in the SMALLER Protocol buys: a
	// Function bounded `is Comparable` can ask them now.
	it("answers a call bounded by Comparable", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tfunction below<infer Item is Comparable>(",
					"\t\t_ value: Item,",
					"\t\t_ other: Item,",
					"\t) -> Boolean {",
					"\t\t<- value::isLessThanOrEqualTo(other)",
					"\t}",
					"",
					'\tTerminal.inspect(below("a", "b"))',
					"\tTerminal.inspect(below(3, 2))",
					"}",
				].join("\n"),
			),
		).toEqual(["true", "false"])
	})
})
