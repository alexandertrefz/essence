import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { entryPoints, TestEvent } from "@essence-lang/runtime/Testing"
import { registry, registryOf } from "@essence-lang/runtime/Testing"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// `Randomness` in compiled Programs.
// `packages/runtime/src/tests/randomness.spec.ts` pins a draw's range,
// exactness and replay against the natives. Here the statics resolve on a
// Namespace targeting a primitive Type. A seed replays through the whole
// pipeline, and no pass pools or hoists a draw.
//
// Every assertion over a drawn value is about a range or a replay, never a
// number. A seeded draw is the same at every run, so only tests over
// `entropy()` can miss, and the odds are written beside each.

function compile(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(enriched.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
		[],
	)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

// The lines a Program printed. `Terminal.print` reaches
// `process.stdout.write` through `Terminal.write`, so that is intercepted.
async function linesOf(source: string): Promise<Array<string>> {
	let javaScript = compile(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-randomness-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let written = ""
	let originalOut = process.stdout.write

	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	try {
		await import(file)
	} finally {
		process.stdout.write = originalOut
		rmSync(directory, { recursive: true, force: true })
	}

	return written.split("\n").slice(0, -1)
}

// A `for any` run of the Program's own `tests { … }` section, through its own
// `$tests`. Every value carries a Type key of the runtime that built it. It
// answers every outcome, since an empty list of failures can mean none ran.
type Loaded = { $tests: typeof entryPoints }

async function outcomesOf(source: string): Promise<Array<string>> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program, { tests: true, source })

	expect(enriched.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
		[],
	)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	let javaScript = rewrite(optimise(simplify(enriched.program, { source })))
	let directory = mkdtempSync(join(tmpdir(), "essence-randomness-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let before = registry().modules.length
	let loaded = (await import(file)) as Loaded
	let scoped = registryOf(loaded.$tests.registry().modules.slice(before))
	let events: Array<TestEvent> = []

	try {
		await loaded.$tests.run(scoped, {
			sink: (event) => events.push(event),
			now: () => 0,
			seed: "deadbeef",
		})
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}

	return events
		.filter(
			(event) =>
				event.kind === "test-pass" ||
				event.kind === "test-fail" ||
				event.kind === "test-skip",
		)
		.map(
			(event) =>
				`${event.kind}: ${(event as { name: string }).name}${
					event.kind === "test-fail"
						? ` — ${JSON.stringify(event.failures)}`
						: ""
				}`,
		)
}

describe("Randomness", () => {
	describe("seeded", () => {
		it("answers one sequence for one seed", async () => {
			let lines = await linesOf(`implementation {
				function draws(from source: Randomness) -> List<Integer> {
					<- [
						source::drawInteger(between 1, and 1000000),
						source::drawInteger(between 1, and 1000000),
						source::drawInteger(between 1, and 1000000),
					]
				}

				Terminal.print(draws(from Randomness.seeded("beef")))
				Terminal.print(draws(from Randomness.seeded("beef")))
			}`)

			expect(lines.length).toBe(2)
			expect(lines[0]).toBe(lines[1] as string)
		})

		// Three draws of a million agree across two seeds with odds of
		// one in 10^18.
		it("answers a different sequence for a different seed", async () => {
			let lines = await linesOf(`implementation {
				function draws(from source: Randomness) -> List<Integer> {
					<- [
						source::drawInteger(between 1, and 1000000),
						source::drawInteger(between 1, and 1000000),
						source::drawInteger(between 1, and 1000000),
					]
				}

				Terminal.print(draws(from Randomness.seeded("beef")))
				Terminal.print(draws(from Randomness.seeded("cafe")))
			}`)

			expect(lines[0]).not.toBe(lines[1] as string)
		})

		// Every draw advances the source it is handed, so a mapped List's
		// items are separate draws.
		it("draws once for each item of a mapped List", async () => {
			let lines = await linesOf(`implementation {
				constant source = Randomness.seeded("beef")
				constant drawn = [1, 2, 3, 4, 5, 6, 7, 8]::map((_) {
					<- source::drawInteger(between 1, and 1000000)
				})

				Terminal.print(drawn::removeDuplicates()::length())
			}`)

			expect(lines[0]).toBe("8")
		})
	})

	describe("entropy", () => {
		it("answers a source every draw of which lands in its range", async () => {
			let lines = await linesOf(`implementation {
				constant source = Randomness.entropy()
				constant drawn = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]::map((_) {
					<- source::drawInteger(between 1, and 6)
				})

				Terminal.print(drawn::hasOnlyItems(where (value) {
					<- value::isBetween(1, and 6)
				}))
			}`)

			expect(lines[0]).toBe("true")
		})

		// `Randomness` is not on the purity allowlist in
		// `packages/compiler/src/optimiser/purity.ts`, so no pass pools, hoists
		// or drops either draw.
		it("emits both draws of one expression", () => {
			let javaScript = compile(`implementation {
				Terminal.print(
					Randomness.entropy()::drawInteger(between 1, and 1000000)
						::add(Randomness.entropy()::drawInteger(between 1, and 1000000)),
				)
			}`)
			let draws = javaScript.split(
				"Randomness.drawInteger__overload$1(",
			).length

			expect(draws).toBe(3)
			expect(javaScript.split("Randomness.entropy()").length).toBe(3)
		})

		// Run rather than read. Two draws over a span of 10^15 agree with odds
		// of one in 10^15.
		it("answers two values for two draws in one expression", async () => {
			let lines = await linesOf(`implementation {
				constant source = Randomness.entropy()

				Terminal.print(
					source::drawInteger(between 1, and 1000000000000000)
						::isNot(source::drawInteger(between 1, and 1000000000000000)),
				)
			}`)

			expect(lines[0]).toBe("true")
		})
	})

	describe("draws", () => {
		it("answers a number below the bound, and the proof the bound gives", async () => {
			let lines = await linesOf(`implementation {
				constant source = Randomness.seeded("beef")
				constant drawn = [1, 2, 3, 4, 5, 6, 7, 8]::map((_) {
					<- source::drawInteger(below 4)
				})

				Terminal.print(drawn::sort())
			}`)

			expect(lines[0]).toMatch(/^\[[0-3](, [0-3])*\]$/)
		})

		it("answers a fraction over the denominator it is given", async () => {
			let lines = await linesOf(`implementation {
				constant source = Randomness.seeded("beef")

				Terminal.print(source::drawRational(between 1/1, and 2/1, over 7)::multiply(with 7))
			}`)

			expect(lines[0]).toMatch(/^(7|8|9|10|11|12|13|14)$/)
		})

		it("answers only what a chance of zero or one allows", async () => {
			let lines = await linesOf(`implementation {
				constant source = Randomness.seeded("beef")

				Terminal.print([1, 2, 3, 4, 5]::map((_) {
					<- source::drawBoolean(withProbability 0/1)
				}))
				Terminal.print([1, 2, 3, 4, 5]::map((_) {
					<- source::drawBoolean(withProbability 1/1)
				}))
			}`)

			expect(lines[0]).toBe("[false, false, false, false, false]")
			expect(lines[1]).toBe("[true, true, true, true, true]")
		})

		it("picks items of a List without drawing one twice", async () => {
			let lines = await linesOf(`implementation {
				constant source = Randomness.seeded("beef")
				constant drawn = source::pick(3, from ["Lions", "Tigers", "Bears", "Wolves"])

				Terminal.print(drawn::length())
				Terminal.print(drawn::removeDuplicates()::length())
			}`)

			expect(lines[0]).toBe("3")
			expect(lines[1]).toBe("3")
		})

		it("picks the item every weight is on", async () => {
			let lines = await linesOf(`implementation {
				constant source = Randomness.seeded("beef")

				Terminal.print([1, 2, 3, 4, 5]::map((_) {
					<- source::pick(
						from ["Lions", "Tigers", "Bears"],
						weightedBy (team) {
							if team::is("Tigers") {
								<- 1/1
							} else {
								<- 0/1
							}
						},
					)
				}))
			}`)

			expect(lines[0]).toBe(
				'["Tigers", "Tigers", "Tigers", "Tigers", "Tigers"]',
			)
		})

		it("shuffles a List into the same items in some order", async () => {
			let lines = await linesOf(`implementation {
				constant source = Randomness.seeded("beef")
				constant teams = ["Lions", "Tigers", "Bears", "Wolves"]

				Terminal.print(source::shuffle(teams)::sort())
				Terminal.print(teams)
			}`)

			expect(lines[0]).toBe('["Bears", "Lions", "Tigers", "Wolves"]')
			expect(lines[1]).toBe('["Lions", "Tigers", "Bears", "Wolves"]')
		})

		// The annotations are the assertion: a bare `List<Integer>` is refused
		// where a `NonEmptyList<Integer>` is declared.
		it("carries a proof through the shuffle and the counted pick", async () => {
			let lines = await linesOf(`implementation {
				constant source = Randomness.seeded("beef")
				constant shuffled: NonEmptyList<Integer> = source::shuffle([1, 2, 3])
				constant drawn: NonEmptyList<Integer> = source::pick(2, from [1, 2, 3])

				Terminal.print(shuffled::firstItem()::add(0))
				Terminal.print(drawn::firstItem()::add(0))
			}`)

			expect(lines[0]).toMatch(/^[123]$/)
			expect(lines[1]).toMatch(/^[123]$/)
		})
	})

	// For every input, a drawn number lands in the range whichever way round
	// the bounds are given, and one seed answers one sequence.
	describe("properties", () => {
		it("draws inside the range for any pair of bounds", async () => {
			expect(
				await outcomesOf(`implementation {
					function drawn(from low: Integer, to high: Integer) -> Integer {
						<- Randomness.seeded("beef")::drawInteger(between low, and high)
					}
				}

				tests {
					test "a draw is inside the range" for any (low: Integer, high: Integer) {
						expect drawn(from low, to high)::isBetween(low, and high)
						expect drawn(from high, to low)::isBetween(low, and high)
					}
				}`),
			).toEqual(["test-pass: a draw is inside the range"])
		})

		it("replays one sequence for any seed", async () => {
			expect(
				await outcomesOf(`implementation {
					function draws(from seed: String) -> List<Integer> {
						constant source = Randomness.seeded(seed)

						<- [1, 2, 3, 4]::map((_) {
							<- source::drawInteger(between 0, and 1000000)
						})
					}
				}

				tests {
					test "one seed answers one sequence" for any (seed: String) {
						expect draws(from seed)::is(draws(from seed))
					}
				}`),
			).toEqual(["test-pass: one seed answers one sequence"])
		})
	})
})
