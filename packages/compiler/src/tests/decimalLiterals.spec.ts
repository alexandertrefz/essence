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

// `0.75` is a second spelling of `3/4`. The Parser joins the two digit runs
// into a fraction over a power of ten, and every later stage sees a Rational.
// `parser.spec.ts` pins the Node. These specs check that the runtime gets the
// fraction's value: exact, reduced on read, printed as a fraction, and folded
// by the Optimiser.
//
// The harness is `rationals.spec.ts`'s: a broken Rational shows from Essence,
// so these run Essence rather than reading the tree.

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
	let directory = mkdtempSync(join(tmpdir(), "essence-decimals-"))
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

describe("Decimal Literals", () => {
	// In binary floating point, two tenths do not add up to three tenths.
	it("adds two tenths exactly", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(0.1::add(0.2)::is(0.3)::toString())
			}`),
		).toEqual(['"true"'])
	})

	it("is the same value as the fraction it spells", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(0.75::is(3/4)::toString())
				Terminal.inspect(0.75::toString())
			}`),
		).toEqual(['"true"', '"3/4"'])
	})

	it("keeps no scale, so a trailing zero changes nothing", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(1.50::is(1.5)::toString())
				Terminal.inspect(1.50::toString())
			}`),
		).toEqual(['"true"', '"3/2"'])
	})

	it("prints as a fraction and as a decimal on request", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(19.99)
				Terminal.inspect(19.99::toString(as #Decimal))
			}`),
		).toEqual(["1999/100", '"19.99"'])
	})

	// A whole Rational prints its numerator alone, so `2.0` prints `2`.
	it("prints a whole decimal bare", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(2.0::toString())
				Terminal.inspect(2.0::toString(as #Decimal))
			}`),
		).toEqual(['"2"', '"2"'])
	})

	// A written positive decimal reaches `PositiveRational`'s total square
	// root. A computed receiver reaches `Rational`'s, which answers an Optional.
	it("reaches the numeric tower through a decimal receiver", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(2.25::squareRoot()::toString())
				Terminal.inspect(match 2.5::subtract(0.25)::squareRoot() -> String {
					case #Value(root) { <- root::toString() }
					case #Empty       { <- "Empty" }
				})
				Terminal.inspect(-0.5::absolute()::toString())
			}`),
		).toEqual(['"3/2"', '"3/2"', '"1/2"'])
	})

	// A whole mixed sum answers an Integer, as it does for written fractions.
	it("sums a mixed List down to an Integer", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect([1, 0.5, 0.5]::sum())
			}`),
		).toEqual(["2"])
	})

	it("compares against a decimal value Matcher", async () => {
		expect(
			await run(`implementation {
				variable share: Rational | Boolean = 0.5

				Terminal.inspect(match share -> String {
					case 0.5      { <- "a half" }
					case Rational { <- "another Rational" }
					case Boolean  { <- "a Boolean" }
				})
			}`),
		).toEqual(['"a half"'])
	})

	// The Optimiser knows nothing of decimals. The Parser normalises the
	// numerator and denominator through `BigInt` into plain digit strings.
	it("is folded by the Optimiser the way a fraction is", () => {
		let generated = generate(`implementation {
			constant half = 0.25::add(0.25)

			Terminal.inspect(half::toString())
		}`)

		expect(generated).toContain("Rational.createRational(1n, 2n)")
		expect(generated).not.toContain("Rational.add")
	})
})
