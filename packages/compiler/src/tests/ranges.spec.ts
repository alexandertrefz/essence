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

// `List.of`'s range entries, each compiled and run. An entry counts in the
// direction its name says, whatever its bounds say. A range counting the wrong
// way only shows in the printed List, so every spec checks a printed value.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-ranges-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

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

function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	return enrich(parsed.program).diagnostics
}

// Each range prints one line, so one Program and one pipeline run serve a
// whole spec.
async function ranges(...calls: Array<string>): Promise<Array<string>> {
	return run(`implementation {
${calls.map((call) => `\t\tTerminal.inspect(${call}::toString())`).join("\n")}
	}`)
}

describe("List.of counts the direction its label says", () => {
	it("counts up through an included end", async () => {
		expect(
			await ranges(
				"List.of(integersFrom 1, through 4)",
				"List.of(integersFrom 1, through 1)",
				"List.of(integersFrom 4, through 1)",
				"List.of(integersFrom -2, through 1)",
			),
		).toEqual(['"[1, 2, 3, 4]"', '"[1]"', '"[]"', '"[-2, -1, 0, 1]"'])
	})

	// `through:` never counts down, so a range written from the length of an
	// empty List reaches `through -1` and answers nothing.
	it("answers the empty List for a range written from an empty length", async () => {
		expect(
			await run(`implementation {
				constant nothing: List<String> = []

				Terminal.inspect(List.of(integersFrom 0, through nothing::length()::subtract(1))::toString())
			}`),
		).toEqual(['"[]"'])
	})

	it("stops before an excluded end, and only counts up", async () => {
		expect(
			await ranges(
				"List.of(integersFrom 0, upTo 3)",
				"List.of(integersFrom 0, upTo 0)",
				"List.of(integersFrom 3, upTo 1)",
			),
		).toEqual(['"[0, 1, 2]"', '"[]"', '"[]"'])
	})

	// The first value is always answered, which is what the Type says.
	it("counts down through an included end, and always answers the first value", async () => {
		expect(
			await ranges(
				"List.of(integersFrom 3, downTo 1)",
				"List.of(integersFrom 1, downTo 1)",
				"List.of(integersFrom 1, downTo 5)",
				"List.of(integersFrom 1, downTo -2)",
			),
		).toEqual(['"[3, 2, 1]"', '"[1]"', '"[1]"', '"[1, 0, -1, -2]"'])
	})

	it("steps by a signed amount in every direction", async () => {
		expect(
			await ranges(
				"List.of(integersFrom 0, through 9, by 3)",
				"List.of(integersFrom 0, through 10, by 3)",
				"List.of(integersFrom 9, through 0, by -3)",
				"List.of(integersFrom 0, through 9, by -3)",
				"List.of(integersFrom 0, through 5, by 10)",
				"List.of(integersFrom 0, upTo 9, by 3)",
				"List.of(integersFrom 9, upTo 0, by -3)",
				"List.of(integersFrom 0, upTo 0, by 3)",
				"List.of(integersFrom 9, downTo 0, by -3)",
				"List.of(integersFrom 9, downTo 0, by 3)",
			),
		).toEqual([
			'"[0, 3, 6, 9]"',
			'"[0, 3, 6, 9]"',
			'"[9, 6, 3, 0]"',
			'"[]"',
			'"[0]"',
			'"[0, 3, 6]"',
			'"[9, 6, 3]"',
			'"[]"',
			'"[9, 6, 3, 0]"',
			'"[9]"',
		])
	})

	// A step of zero would never finish. `NonZeroInteger` keeps it out, and a
	// written `0` proves it is not one, so compiling refuses it.
	it("refuses a step of zero at compile time", () => {
		let diagnostics = diagnosticsOf(`implementation {
			Terminal.inspect(List.of(integersFrom 0, through 5, by 0)::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
		expect(diagnostics[0]!.notes).toContain(
			"'List.of' takes 3 Arguments: Parameter 'integersFrom' is Integer, Parameter 'through' is Integer, Parameter 'by' is NonZeroInteger.",
		)
	})

	// A computed step carries no proof about its value, so it is refused too.
	it("refuses a step nothing proved is not zero", () => {
		let diagnostics = diagnosticsOf(`implementation {
			constant step = 3::subtract(3)

			Terminal.inspect(List.of(integersFrom 0, through 5, by step)::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
	})

	// The proof, read where it is spent rather than where it is made.
	// `firstItem` on a `NonEmptyList` answers the item, so adding to it is only
	// a Program at all when the receiver carried the proof.
	it("answers a proven List from downTo, and a plain one from through", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(List.of(integersFrom 3, downTo 1)::firstItem()::add(1)::toString())
				Terminal.inspect(List.of(integersFrom 3, downTo 1, by -1)::lastItem()::toString())
				Terminal.inspect(List.of(integersFrom 1, through 3)::firstItem()::toString())
			}`),
		).toEqual(['"4"', '"1"', '"Value(1)"'])
	})

	// `NonEmptyList::indices` is native and never answers an empty List.
	// `List.repeat` uses the up-counting entry, which answers nothing for a
	// count below one.
	it("keeps the promises the library's own bodies rest on", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect([10, 20, 30]::indices()::toString())
				Terminal.inspect([10]::indices()::lastItem()::add(1)::toString())
				Terminal.inspect(List.repeat("x", times 3)::toString())
				Terminal.inspect(List.repeat("x", times 0)::toString())
				Terminal.inspect(List.repeat("x", times -2)::toString())
			}`),
		).toEqual([
			'"[0, 1, 2]"',
			'"1"',
			'"[\\"x\\", \\"x\\", \\"x\\"]"',
			'"[]"',
			'"[]"',
		])
	})

	// The bigint half of the walk, which the counter escapes to when
	// either bound is past safe range. Both bounds and the step are read as
	// bigints there, and the answer is canonical on the way out.
	it("counts a range whose bounds are past safe range", async () => {
		expect(
			await ranges(
				"List.of(integersFrom 9007199254740990, through 9007199254740993)",
				"List.of(integersFrom 9007199254740993, downTo 9007199254740990)",
				"List.of(integersFrom 9007199254740990, through 9007199254740996, by 3)",
			),
		).toEqual([
			'"[9007199254740990, 9007199254740991, 9007199254740992, 9007199254740993]"',
			'"[9007199254740993, 9007199254740992, 9007199254740991, 9007199254740990]"',
			'"[9007199254740990, 9007199254740993, 9007199254740996]"',
		])
	})
})
