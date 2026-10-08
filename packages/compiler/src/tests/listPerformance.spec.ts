import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { listWork } from "@essence-lang/runtime/listWork"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// Claims about how much a List works rather than what it answers. The work is
// counted, not timed, so it holds under any load. It is the length, and each
// item a native copies while it edits a List's runs. See "Counting a List's
// work" in packages/runtime/DEVELOPMENT.md. Doubling the length doubles a
// linear count and quadruples a quadratic one, so the guard is three.
const WALK_LENGTHS = [10_000, 20_000, 40_000, 80_000]
const GROWTH_PER_DOUBLING = 3

// The Program runs in the runner, whose runtime holds the counter it moves. The
// emitted imports are absolute paths to that same runtime, which counts only
// while the flag is set.
async function workToRun(
	source: string,
	printed: string,
	length: number,
): Promise<number> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	let javaScript = rewrite(optimise(simplify(enriched.program)))
	let directory = mkdtempSync(join(tmpdir(), "essence-list-performance-"))
	let file = join(directory, "program.ts")
	let output: Array<string> = []
	let originalLog = console.log

	writeFileSync(file, javaScript)
	console.log = (...args: Array<unknown>) => {
		output.push(args.map((arg) => String(arg)).join(" "))
	}

	let before = listWork.copied

	globalThis.essenceCountsListWork = true

	try {
		await import(file)
	} finally {
		globalThis.essenceCountsListWork = undefined
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	// A build that answered the wrong length would otherwise copy least.
	expect(output).toEqual([printed])

	return length + listWork.copied - before
}

// The seed's one item makes the State a List of Integers from the first turn,
// and makes the printed length one more than the turns.
function buildingSource(method: string, turns: number): string {
	return `implementation {
	constant built = loop(from 1, through ${turns}, startingWith [0], (
		index,
		list,
	) { <- list::${method}(index) })

	Terminal.inspect(built::length())
}`
}

// Each doubling is held to the ratio, and measuring stops at the first steep
// one, before a quadratic Program meets the runner's timeout. A count reads the
// same every run, so one reading is believed.
async function expectLinearGrowth(
	sourceFor: (length: number) => string,
	printedFor: (length: number) => string,
): Promise<void> {
	let measured: Array<number> = []
	let tooSteep: Array<string> = []

	for (let [index, length] of WALK_LENGTHS.entries()) {
		measured.push(
			await workToRun(sourceFor(length), printedFor(length), length),
		)

		let grewBy = index === 0 ? 0 : measured[index]! / measured[index - 1]!

		if (grewBy >= GROWTH_PER_DOUBLING) {
			tooSteep.push(
				`${WALK_LENGTHS[index - 1]} to ${length}: ${grewBy.toFixed(1)}x`,
			)

			break
		}
	}

	expect(tooSteep).toEqual([])
}

// A prepended List keeps its items in the front run. An appended one keeps
// them in the back run, which the drain's first step has to move. The seed's
// item is never removed, so the printed length is one.
function drainingSource(
	built: "prepend" | "append",
	turns: number,
	step: string,
): string {
	return `implementation {
	constant built = loop(from 1, through ${turns}, startingWith [0], (
		index,
		list,
	) { <- list::${built}(index) })

	constant drained = loop(from 1, through ${turns}, startingWith built, (
		_,
		list,
	) { <- list::${step} })

	Terminal.inspect(drained::length())
}`
}

// The State is what is left and what has been added up, so one source serves
// every walk and only the body differs.
function walkingSource(length: number, walk: string): string {
	return `implementation {
	constant items = List.of(integersFrom 1, through ${length})

	constant total = loop(startingWith { rest = items, sum = 0 }, step (state) {
		<- ${walk}
	})

	Terminal.inspect(total)
}`
}

// The sum each walk prints, checked so a wrong walk is not the fastest. The
// two-ended walk stops at the middle and adds up the first half.
function printedSumFor(name: string, length: number): string {
	if (name === "both ends") {
		let half = length / 2

		return String((half * (half + 1)) / 2)
	}

	return String((length * (length + 1)) / 2)
}

describe("List performance", () => {
	for (let method of ["append", "prepend"] as const) {
		it(`builds a List through ${method} in linear time`, async () => {
			await expectLinearGrowth(
				(length) => buildingSource(method, length),
				(length) => `${length + 1}`,
			)
		})
	}

	// `remove(at 0)` on a prepend-built List shrinks the front run and shares
	// both runs. On an append-built one the box upgrades itself once, and the
	// rest of the drain is windows.
	for (let [built, step] of [
		["prepend", "remove(at 0)"],
		["prepend", "removeFirst()"],
		["append", "remove(at 0)"],
		["append", "removeFirst()"],
	] as const) {
		it(`drains a ${built}-built List through ${step} in linear time`, async () => {
			await expectLinearGrowth(
				(length) => drainingSource(built, length, step),
				() => "1",
			)
		})
	}

	// Take the head and go on with the tail, reading a window `slice` has just
	// answered. `trimUnderHalfRule` in `List.ts` trims a window only when it
	// views less than half its Array, which keeps the walk linear.
	for (let [name, walk] of [
		[
			"head/tail",
			`match state.rest::firstItem() -> Step<{ rest: List<Integer>, sum: Integer }, Integer> {
			case #Empty { <- #Done(state.sum) }
			case #Value(head) {
				<- #Continue({
					rest = state.rest::removeFirst(),
					sum = state.sum::add(head),
				})
			}
		}`,
		],
		[
			"init/last",
			`match state.rest::lastItem() -> Step<{ rest: List<Integer>, sum: Integer }, Integer> {
			case #Empty { <- #Done(state.sum) }
			case #Value(tail) {
				<- #Continue({
					rest = state.rest::removeLast(),
					sum = state.sum::add(tail),
				})
			}
		}`,
		],
		[
			// Both ends a turn, as a palindrome check walks. The window holds
			// neither end of its box, so the box moves its seam into it.
			"both ends",
			`match state.rest::firstItem() -> Step<{ rest: List<Integer>, sum: Integer }, Integer> {
			case #Empty { <- #Done(state.sum) }
			case #Value(head) {
				if state.rest::length()::isLessThan(2) {
					<- #Done(state.sum::add(head))
				} else {
					<- #Continue({
						rest = state.rest::removeFirst()::removeLast(),
						sum = state.sum::add(head),
					})
				}
			}
		}`,
		],
	] as const) {
		it(`walks a List ${name} in linear time`, async () => {
			await expectLinearGrowth(
				(length) => walkingSource(length, walk),
				(length) => printedSumFor(name, length),
			)
		})
	}
})
