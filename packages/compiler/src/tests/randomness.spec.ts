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

// NOTE: The Namespace a Program could not reach until `entropy()` and
// `seeded(_)` were declared, tested by running Programs that build a source and
// draw from it. `packages/runtime/src/tests/randomness.spec.ts` drives the
// natives directly and is where a draw's range, exactness and replay are
// pinned; what is checked here is the half only a compiled Program shows: that
// the two statics resolve on a Namespace targeting a primitive Type, that a
// seed replays through the whole pipeline, and that no pass pools or hoists a
// draw.
//
// NOTE: Every assertion over a drawn value is about a RANGE or a replay, never
// about a number, so nothing here is pinned to the generator's own words. A
// seeded draw is the same draw at every run, so only the two tests over
// `entropy()` can miss at all, and the odds are written beside each.

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

// NOTE: The lines a Program printed, in order. `Terminal.print` adds its
// newline in Essence and hands the text to `Terminal.write`, which reaches
// `process.stdout.write` on a host with streams — so that is what is
// intercepted here, as `terminal.spec.ts` intercepts it.
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

// NOTE: A `for any` run of the Program's own `tests { … }` section, driven
// through the loaded program's OWN `$tests` for the reason
// `testingProperties.spec.ts` states: every Essence value carries a hidden Type
// key belonging to the runtime instance that built it.
//
// NOTE: What comes back is every test's outcome and its name, rather than the
// failures alone. A list of failures is empty when a property held and empty
// again when nothing ran at all, and the two are the same reading.
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
		loaded.$tests.run(scoped, {
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

		// NOTE: Three draws of a million agree across two seeds with odds of
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

		// NOTE: The rule the `§§` block states, run: a source is carried by
		// hand, and every draw off the one it is handed advances it. So the
		// items of a mapped List are drawn one after the other rather than
		// being one draw repeated.
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

		// NOTE: What the purity table decides, seen from the emitted Program.
		// `Randomness` has no entry in it — the table is an allowlist
		// (`packages/compiler/src/optimiser/purity.ts`) — so no pass pools the
		// two Argument-identical draws into one const, hoists either out, or
		// drops the second. Both stand in the emitted expression.
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

		// NOTE: The same again, run rather than read: two draws of the emitted
		// expression answer two values. A span of 10^15 answers the same number
		// twice with odds of one in 10^15.
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

		// NOTE: The proven entries, reached by a written Argument the Compiler
		// read the proof off. The two annotations are the whole assertion: a
		// bare `List<Integer>` is refused where a `NonEmptyList<Integer>` is
		// declared, so a run that compiles is a run that reached them.
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

	// NOTE: The two promises a draw makes over EVERY input rather than over the
	// ones a case happened to write down: a drawn number is inside the range
	// whichever way round the bounds were given, and one seed answers one
	// sequence whatever the seed says.
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
