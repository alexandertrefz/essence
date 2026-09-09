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

// NOTE: `0.75` is a second SPELLING of `3/4` and nothing more — the Parser
// joins the two digit runs into a fraction over a power of ten, and every
// stage behind it sees the Rational it has always seen. So what is worth
// testing is not the Node, which `parserDiagnostics.spec.ts` pins, but that
// the value reaching the runtime is the same one the fraction reaches it with:
// exact, reduced on read, printed as a fraction, and folded by the Optimiser
// the way a written fraction is.
//
// NOTE: The harness is `rationals.spec.ts`'s, for the reason that spec gives —
// the damage a broken Rational does is visible from Essence, so these run
// Essence rather than reading the tree.

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
	// NOTE: The whole reason a decimal can be a Rational Literal at all. A
	// Program that adds two tenths in binary floating point answers something
	// that is not three tenths; this one answers three tenths, because the
	// Literal never became a float.
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

	// NOTE: No scale is kept anywhere — a Rational has no memory of how it was
	// written, so `1.50` and `1.5` are one value rather than two that compare
	// equal.
	it("keeps no scale, so a trailing zero changes nothing", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(1.50::is(1.5)::toString())
				Terminal.inspect(1.50::toString())
			}`),
		).toEqual(['"true"', '"3/2"'])
	})

	// NOTE: Printing is untouched by any of this. `inspect` shows a Rational
	// as the fraction it is, whichever way the Literal was written, and the
	// decimal form is asked for by name.
	it("prints as a fraction and as a decimal on request", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(19.99)
				Terminal.inspect(19.99::toString(as #Decimal))
			}`),
		).toEqual(["1999/100", '"19.99"'])
	})

	// NOTE: `2.0` is a Rational the way `4/2` is one, and a whole Rational
	// prints its numerator alone — so the spelling that looks like a float
	// still prints `2`.
	it("prints a whole decimal bare", async () => {
		expect(
			await run(`implementation {
				Terminal.inspect(2.0::toString())
				Terminal.inspect(2.0::toString(as #Decimal))
			}`),
		).toEqual(['"2"', '"2"'])
	})

	// NOTE: A written decimal above zero proves its sign for itself, so the
	// root reaches `PositiveRational`'s total entry and there is no Optional
	// to take apart. A computed receiver goes to `Rational`'s own entry, which
	// still answers one.
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

	// NOTE: A whole mixed sum answers an Integer rather than a Rational over
	// one, which is the rule the fraction spelling already follows — the
	// decimal spelling reaches the same fold.
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

	// NOTE: The Optimiser folds a decimal because it folds a Rational, and it
	// never learned about decimals at all — the numerator and denominator it
	// reads are plain digit strings, which is what the Parser normalises them
	// through `BigInt` to guarantee.
	it("is folded by the Optimiser the way a fraction is", () => {
		let generated = generate(`implementation {
			constant half = 0.25::add(0.25)

			Terminal.inspect(half::toString())
		}`)

		expect(generated).toContain("Rational.createRational(1n, 2n)")
		expect(generated).not.toContain("Rational.add")
	})
})
