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

// The stages the CLI runs, minus bundling, since what a body that falls off
// its end answers shows only when the emitted Function runs.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

// Imports the emitted Program from a throwaway module, which resolves because
// its imports are absolute paths into this repository's runtime.
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

// A body promising the unit Type `{}` may fall off its end. The Simplifier
// appends a Return of `{}`, since `undefined` is no Essence value.
describe("Return Synthesis", () => {
	describe("a Function body that falls off its end", () => {
		it("answers the unit Record its Signature promised", async () => {
			expect(
				await run(`implementation {
					function noop () -> {} {
					}

					Terminal.inspect(noop())
				}`),
			).toEqual(["{}"])
		})

		it("answers one a Record member can be read back out of", async () => {
			expect(
				await run(`implementation {
					function noop () -> {} {
					}

					constant wrapper = { result = noop() }

					Terminal.inspect(wrapper)
				}`),
			).toEqual(["{ result = {} }"])
		})

		it("answers one a Match can narrow", async () => {
			expect(
				await run(`implementation {
					function noop () -> {} {
					}

					constant value: Integer | {} = noop()

					Terminal.inspect(match value -> String {
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

	// A Handler body is lowered to a Function of its own, so the same rule
	// holds there.
	it("answers unit for a Handler that writes no Return", async () => {
		expect(
			await run(`implementation {
				constant value: Integer | String = 1

				Terminal.inspect(match value -> {} {
					case Integer {
					}
					case String {
					}
				})
			}`),
		).toEqual(["{}"])
	})

	// A body that already ends in `<- {}` gets no second Return.
	it("leaves a body that returns explicitly alone", () => {
		let generated = generate(`implementation {
			function explicit () -> {} {
				<- {}
			}

			Terminal.inspect(explicit())
		}`)

		expect(generated.match(/\breturn\b/g)).toHaveLength(1)
	})
})
