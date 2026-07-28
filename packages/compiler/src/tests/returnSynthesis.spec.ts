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

// NOTE: The same stages the CLI runs, minus bundling — what a body that falls
// off its end answers is only visible once the emitted Function RUNS, so these
// go all the way through.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

// NOTE: Writes the emitted Program to a throwaway module and imports it so its
// top-level `__print` calls run. The emitted imports are absolute paths into
// this repo's runtime, so the module resolves from anywhere; `console.log` is
// captured to collect the output, then restored.
async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-return-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((arg) => String(arg)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

// NOTE: Regression tests — a body promising unit, the empty Record `{}`, is
// allowed to fall off its end, and the emitted JavaScript Function then
// answered `undefined`. That is not an Essence value: it carries no hidden Type
// key, so the failure surfaced somewhere else entirely, in whatever read that
// key next — printing the result, holding it in a Record, or matching on it all
// died with a `TypeError` naming the runtime's internals, out of a Program that
// compiled with zero Diagnostics. What the Simplifier appends is the empty
// Record the Signature promised, so every one of those reads finds a real
// value.
describe("Return Synthesis", () => {
	describe("a Function body that falls off its end", () => {
		it("answers the unit Record its Signature promised", async () => {
			expect(
				await run(`implementation {
					function noop () -> {} {
					}

					__print(noop())
				}`),
			).toEqual(["{}"])
		})

		it("answers one a Record member can be read back out of", async () => {
			expect(
				await run(`implementation {
					function noop () -> {} {
					}

					constant wrapper = { result = noop() }

					__print(wrapper)
				}`),
			).toEqual(["{ result = {} }"])
		})

		it("answers one a Match can narrow", async () => {
			expect(
				await run(`implementation {
					function noop () -> {} {
					}

					constant value: Integer | {} = noop()

					__print(match value -> String {
						case Integer {
							<- "integer"
						}
						case {} {
							<- "unit"
						}
					})
				}`),
			).toEqual(['"unit"'])
		})
	})

	// NOTE: A Handler body is under the same rule for the same reason — it is
	// lowered to a Function of its own, and the emitted `if` chain's value is
	// the Match's value. The Union being matched on is `Integer | String`
	// because a Match needs something to narrow at all; the Handlers' own
	// Return Type is what this pins.
	it("answers unit for a Handler that writes no Return", async () => {
		expect(
			await run(`implementation {
				constant value: Integer | String = 1

				__print(match value -> {} {
					case Integer {
					}
					case String {
					}
				})
			}`),
		).toEqual(["{}"])
	})

	// NOTE: The synthesised Return is appended only where one is missing —
	// a body that already ends in `<- {}` must not grow a second, unreachable
	// one behind it.
	it("leaves a body that returns explicitly alone", () => {
		let generated = generate(`implementation {
			function explicit () -> {} {
				<- {}
			}

			__print(explicit())
		}`)

		expect(generated.match(/\breturn\b/g)).toHaveLength(1)
	})
})
