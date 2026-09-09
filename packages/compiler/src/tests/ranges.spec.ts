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

// NOTE: `List.of`'s six range entries, each compiled AND run. The direction one
// of them counts is what it is CALLED now rather than what its two bounds
// happen to say, so every claim here is about a value the walk answered, not
// about a Type it was given: a range that counts the wrong way is a Program
// that prints the wrong List, and nothing else reports it.
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

// NOTE: One Program per block rather than one per claim, because each range is
// a line of output and the pipeline runs once for all of them.
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

	// NOTE: The empty answer is the whole reason `through:` stopped counting
	// down. A range written from the length of an empty List reaches
	// `through -1`, which used to answer `[0, -1]` and now answers nothing.
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

	// NOTE: The first value is always answered, which is what the Type says and
	// what the two Essence bodies written on this entry rest on.
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

	// NOTE: A step of zero reaches no end, so the walk behind it would never
	// finish. `NonZeroInteger` is what keeps it out, and a written `0` is its
	// own proof that it is not one — so this is refused while compiling rather
	// than hung at run time.
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

	// NOTE: A computed step is refused too, because the proof is about the
	// VALUE and a value the Program is handed carries none.
	it("refuses a step nothing proved is not zero", () => {
		let diagnostics = diagnosticsOf(`implementation {
			constant step = 3::subtract(3)

			Terminal.inspect(List.of(integersFrom 0, through 5, by step)::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
	})

	// NOTE: The proof, read where it is spent rather than where it is made.
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

	// NOTE: The two Essence bodies the proof is what makes writable.
	// `NonEmptyList::indices` counts down and turns the answer round, and
	// `List.repeat` needs the up-counting entry to answer nothing below one.
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

	// NOTE: The bigint half of the walk, which the counter escapes to when
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
