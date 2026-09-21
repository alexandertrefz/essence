import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"

import { bundle } from "../bundler/index"
import { containsErrors } from "../diagnostics/index"
import { renderDiagnostics } from "../diagnostics/render"
import { enrich } from "../enricher/index"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
} from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: What `loop-self-tail-calls` exists for, which is not a speed: it is that
// the walk the language teaches runs on every host Essence supports. Bundles run
// on Bun, on Node and on Deno byte-identically, JavaScriptCore eliminates a tail
// frame and V8 does not — so before this pass, 10,000 items was a `RangeError`
// on two of the three. This file holds the pass to that in the two ways it can
// be held: by RUNNING the programs under Node, and by asserting the SHAPE of the
// JavaScript, which is what makes the claim hold on an engine no suite here
// runs.
//
// NOTE: And it holds the pass to saying the same thing as the Program it
// rewrote, over generated Programs rather than written ones — `optimiser.spec`
// carries the written cases, one per thing the pass has to get right, and the
// fuzzer at the foot of this file is what covers their combinations.

const TURNS = 200_000

// NOTE: One Program per shape the pass has to reach, each counting to the same
// answer so a wrong one names the shape rather than the arithmetic.
const ANSWER = String((TURNS * (TURNS + 1)) / 2)

// NOTE: The canonical walk: take the head, answer with the walk of the tail,
// with the `match` over the `Optional` that `firstItem` answers deciding when to
// stop. This is the shape the documentation teaches and the one that overflowed.
const headAndTail = `implementation {
	function total(_ rest: List<Integer>, _ sum: Integer) -> Integer {
		<- match rest::firstItem() -> Integer {
			case #Empty       { <- sum }
			case #Value(head) { <- total(rest::removeFirst(), sum::add(head)) }
		}
	}

	Terminal.print(total(List.of(integersFrom 1, through ${TURNS}), 0))
}`

// NOTE: An accumulator walk with no List in it at all — nothing but two
// Integers, so what it measures is the turn and not the walk of a structure.
const accumulator = `implementation {
	function countdown(_ n: Integer, _ sum: Integer) -> Integer {
		if n::isLessThan(1) {
			<- sum
		} else {
			<- countdown(n::subtract(1), sum::add(n))
		}
	}

	Terminal.print(countdown(${TURNS}, 0))
}`

// NOTE: A walk over an `Optional` that is not a List's head — the Choice is
// carried by the Program itself, so the `match` is over a value the walk built
// rather than over one a native answered.
const optionalWalk = `implementation {
	function drain(_ next: Optional<Integer>, _ sum: Integer) -> Integer {
		<- match next -> Integer {
			case #Empty { <- sum }
			case #Value(value) {
				if value::isLessThan(1) {
					<- drain(#Empty, sum)
				} else {
					<- drain(#Value(value::subtract(1)), sum::add(value))
				}
			}
		}
	}

	Terminal.print(drain(#Value(${TURNS}), 0))
}`

// NOTE: A Namespace Method, where the receiver is Parameter zero and `@` inside
// a Handler means the matched value — so the walk binds the receiver outside the
// chain and the loop rebinds it through a slot.
const methodWalk = `implementation {
	namespace Walker for List<Integer> {
		walked(_ sum: Integer) -> Integer {
			constant items = @

			<- match items::firstItem() -> Integer {
				case #Empty     { <- sum }
				case #Value(it) { <- items::removeFirst()::walked(sum::add(it)) }
			}
		}
	}

	Terminal.print(List.of(integersFrom 1, through ${TURNS})::walked(0))
}`

const walks: Array<{ name: string; source: string; looped: string }> = [
	{ name: "the head and tail walk", source: headAndTail, looped: "total" },
	{ name: "an accumulator walk", source: accumulator, looped: "countdown" },
	{ name: "a walk over an Optional", source: optionalWalk, looped: "drain" },
	{ name: "a Namespace Method walk", source: methodWalk, looped: "walked" },
]

function generate(
	source: string,
	options: OptimiserOptions = defaultOptimiserOptions,
): string {
	let parsed = parseWithDiagnostics(source)

	expect(refusal(parsed.diagnostics, source)).toBe("")

	let enriched = enrich(parsed.program)

	expect(refusal(enriched.diagnostics, source)).toBe("")
	expect(refusal(validate(enriched.program), source)).toBe("")

	return rewrite(optimise(simplify(enriched.program), options), options)
}

// NOTE: The rendered report rather than a boolean, so a generated Program that
// does not compile says which line of itself to read.
function refusal(
	diagnostics: Array<common.Diagnostic>,
	source: string,
): string {
	return containsErrors(diagnostics)
		? renderDiagnostics(diagnostics, source, "program.es")
		: ""
}

// NOTE: BUNDLED for the runs under Node. What the Rewriter emits imports the
// runtime as TypeScript, which Bun reads and Node does not — and what ships is
// the bundle anyway, so this is also the artefact the portability claim is
// about.
async function bundled(
	source: string,
	options: OptimiserOptions = defaultOptimiserOptions,
): Promise<string> {
	let result = await bundle(generate(source, options), {
		sourceFileName: "program.ts",
		outputFileName: "program.mjs",
	})

	expect(result.diagnostics).toEqual([])
	expect(result.outputs).toHaveLength(1)

	return new TextDecoder().decode(result.outputs[0]!.contents)
}

const withoutPass: OptimiserOptions = {
	enabled: true,
	disabledPasses: new Set(["loop-self-tail-calls"]),
}

// NOTE: One emitted Function's own text, found by its header and taken to the
// brace that closes it. It is read off the EMISSION rather than off the Nodes,
// because what the portability claim is about is the JavaScript: a test that
// asked the Optimiser whether it had looped a Function would be asking the pass
// to mark its own homework.
function emittedBody(generated: string, name: string): string {
	let header = new RegExp(`(?:function|static) ${name}\\(`)
	let match = header.exec(generated)

	expect(match).not.toBeNull()

	let start = generated.indexOf("{", match!.index)
	let depth = 0

	for (let index = start; index < generated.length; index++) {
		let character = generated[index]

		if (character === "{") {
			depth += 1
		} else if (character === "}") {
			depth -= 1

			if (depth === 0) {
				return generated.slice(start, index + 1)
			}
		}
	}

	throw new Error(`the emitted '${name}' has no closing brace`)
}

// NOTE: `node` if there is one on the PATH, and null where there is not. It is
// resolved by ASKING it rather than by looking for a file, so a shim, a version
// manager's shell function and a real binary all answer the same way.
function nodeVersion(): string | null {
	let result = spawnSync("node", ["--version"], { encoding: "utf-8" })

	return result.status === 0 ? result.stdout.trim() : null
}

const node = nodeVersion()

// NOTE: A subprocess, and the emitted Module written to a file — an import into
// the runner's own process would run it on Bun, which is the engine this whole
// file exists to look past.
function runUnder(
	command: string,
	javaScript: string,
): { stdout: string; stderr: string } {
	let directory = mkdtempSync(join(tmpdir(), "essence-tail-calls-"))
	let file = join(directory, "program.mjs")

	writeFileSync(file, javaScript)

	try {
		let result = spawnSync(command, [file], {
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
		})

		return { stdout: result.stdout.trim(), stderr: result.stderr }
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

describe("self tail calls", () => {
	describe("the emitted shape", () => {
		// NOTE: The guard that holds EVERYWHERE, including on an engine nothing
		// here runs: the Function does not call itself where its answer goes. It
		// is asked of the emitted text, and the same question is asked of the
		// build with the pass off, where the answer has to be the opposite —
		// otherwise this would pass just as happily against a pass that did
		// nothing at all.
		for (let walk of walks) {
			it(`leaves no self call in the answer of ${walk.name}`, () => {
				let body = emittedBody(generate(walk.source), walk.looped)

				expect(body).toContain("while (true)")
				expect(body).toMatch(/continue \$tail_\d+/)
				expect(body).not.toMatch(
					new RegExp(`return \\w*\\.?${walk.looped}\\(`),
				)

				let unlooped = emittedBody(
					generate(walk.source, withoutPass),
					walk.looped,
				)

				expect(unlooped).not.toContain("while (true)")
				expect(unlooped).toMatch(
					new RegExp(`return \\w*\\.?${walk.looped}\\(`),
				)
			})
		}
	})

	describe("under Node", () => {
		// NOTE: Skipped with a reason rather than silently, because the whole
		// point of this block is the engine it runs on. `node` is on the PATH of
		// every machine this repository is developed on and of CI; a machine
		// without one still runs everything else here, and the shape guard above
		// is what carries the claim there.
		if (node === null) {
			it.skip("runs each walk at 200,000 turns (no `node` on the PATH)", () => {})
		} else {
			for (let walk of walks) {
				it(`runs ${walk.name} at ${TURNS} turns on Node ${node}`, async () => {
					let result = runUnder("node", await bundled(walk.source))

					expect(result.stderr).toBe("")
					expect(result.stdout).toBe(ANSWER)
				})
			}

			// NOTE: What makes the four above a guard rather than four passing
			// tests. With the pass off, V8 is handed 200,000 frames and says so
			// — so a change that quietly stopped looping these walks fails the
			// block above rather than passing it more slowly. It is a claim
			// about V8's stack, which is a deterministic limit far below 200,000
			// frames in every configuration it has; an engine that grew proper
			// tail calls would fail HERE, which is the right place to hear it.
			it("overflows Node's stack with the pass off", async () => {
				let result = runUnder(
					"node",
					await bundled(headAndTail, withoutPass),
				)

				expect(result.stdout).toBe("")
				expect(result.stderr).toContain(
					"Maximum call stack size exceeded",
				)
			})
		}
	})

	// NOTE: The differential the written cases can not cover: not one thing at a
	// time but their COMBINATIONS — a swap under a `define` under a `match`, with
	// a default that reads a Parameter the same turn rebinds, with a closure
	// holding one of them. Each generated Program is compiled twice and run
	// twice, and the two answers have to be the same text.
	//
	// NOTE: Deterministic. The seed is fixed, so a failure is reproducible and
	// the counterexample is in the message; a random seed would make this a test
	// that fails for somebody once and never again.
	describe("the fuzzer", () => {
		// NOTE: Sixty-four rather than forty-eight, because four knobs were
		// added to the nine that were here and the combinations they stand for
		// are what this block is: two of them, a closure in a default and a
		// default reading a Record member, are each a bug an independent review
		// found in code every one of the forty-eight agreed with.
		const CASES = 64

		function generator(seed: number): () => number {
			let state = seed >>> 0

			return () => {
				state = (state + 0x6d2b79f5) >>> 0

				let value = Math.imul(state ^ (state >>> 15), 1 | state)

				value =
					(value + Math.imul(value ^ (value >>> 7), 61 | value)) ^
					value

				return ((value ^ (value >>> 14)) >>> 0) / 4294967296
			}
		}

		function fuzzed(index: number): string {
			let random = generator(0x5eed + index * 7919)
			let pick = <Value>(values: Array<Value>): Value =>
				values[Math.floor(random() * values.length)]!
			let turns = 1 + Math.floor(random() * 6)
			let start = 1 + Math.floor(random() * 9)
			let step = 1 + Math.floor(random() * 4)
			// NOTE: Every knob the written cases hold one at a time, drawn
			// independently: which shape decides the turn, whether a Parameter
			// is swapped with another, whether one takes a default that reads
			// the Parameter before it, whether a closure captures one, and
			// whether a non-tail call to the same Function stands beside the
			// tail one.
			let driver = pick(["if", "match", "define", "nested"])
			let swapped = random() < 0.5
			let defaulted = random() < 0.5
			let captured = random() < 0.35
			let alsoRecurses = random() < 0.3
			// NOTE: And four more, each of which is a corner an independent
			// review reached and this could not. A Record Parameter with a
			// default that reads a MEMBER of it spelled like a Parameter, which
			// is the difference between renaming a binding and renaming a key.
			// A second Parameter the same closure captures, because a rule that
			// is per Parameter can not be shown to be by capturing one. Two
			// Arguments that PRINT, which is the only way the ORDER a turn
			// evaluates its Arguments in is observable at all. And a Function
			// literal standing in a DEFAULT, the one capture a slot can not
			// hold and the pass declines.
			let recorded = random() < 0.5
			let noisy = random() < 0.5
			let paired = captured && random() < 0.5
			let closured = captured && random() < 0.5

			// NOTE: A value that says it was evaluated, where the Program has
			// something to say it with. `note` answers what it is given, so the
			// knob changes the ORDER a difference would show up in and never the
			// answer.
			let noted = (tag: string, value: string): string =>
				noisy ? `note("${tag}", ${value})` : value

			let parameters = [
				"_ n: Integer",
				"_ sum: Integer",
				...(swapped ? ["_ left: Integer", "_ right: Integer"] : []),
				...(recorded ? ["_ opts: { n: Integer }"] : []),
				...(defaulted
					? [
							`by stride: Integer = ${noted(
								"dflt-stride",
								`n::add(${step})`,
							)}`,
						]
					: []),
				...(recorded ? ["at mark: Integer = opts.n"] : []),
				// NOTE: AFTER the two Parameters with defaults, and written by
				// every call — so a turn that leaves those out has a written
				// Argument standing behind an omitted one, which a call
				// evaluates first and a turn therefore has to hold.
				...(noisy ? ["_ tag: Integer"] : []),
				...(captured ? ["_ made: List<() -> Integer>"] : []),
				...(closured
					? ["_ maker: () -> Integer = () -> Integer { <- n }"]
					: []),
			]

			// NOTE: One call, written from the values its Arguments take — so
			// the first call and the turn differ only in what they hand over,
			// and a Parameter drawn into the signature above is handed something
			// in both. The two with defaults are handed nothing by either, so
			// both take their default afresh.
			let called = (
				next: string,
				sum: string,
				pair: [string, string],
				options: string,
				tag: string,
				made: string,
			): string =>
				`walked(${[
					next,
					sum,
					...(swapped ? pair : []),
					...(recorded ? [options] : []),
					...(noisy ? [tag] : []),
					...(captured ? [made] : []),
				].join(", ")})`

			// NOTE: What the turn carries in its accumulator. A `paired` walk
			// adds the counter rather than the stride, which leaves `stride`
			// read by nobody but the answer — and that is what makes such a
			// turn one whose Arguments mention no Parameter it assigns where it
			// stands, so the ONLY reason left to hold them is the Argument it
			// left out standing in front of one it wrote.
			let carried =
				defaulted && !paired
					? "sum::add(stride)"
					: `sum::add(${swapped ? "left" : "n"})`
			// NOTE: The closure the turn hands on is built where it stands
			// unless a default builds it — and where a default does, it closes
			// over a Parameter the turn rebinds, which is the shape the pass
			// declines rather than loops.
			//
			// NOTE: A `paired` one closes over every value the walk carries
			// rather than over the counter alone, so every one of them is
			// rebound through a slot — which is the other half of "a binding per
			// turn is decided per Parameter".
			let closure = paired
				? `() -> Integer { <- n::add(sum)${
						swapped ? "::add(left)::add(right)" : ""
					}::add(made::length()) }`
				: "() -> Integer { <- n }"
			// NOTE: The turn swaps its pair, takes the defaults again by leaving
			// them out, and hands on a closure built in THIS turn — so a loop
			// that rebound in the wrong order, carried a stale default or shared
			// one binding across turns answers differently.
			let turn = called(
				noted("arg-n", `n::subtract(${step})`),
				carried,
				["right", "left"],
				"opts",
				noted("arg-tag", String(step)),
				closured ? "made::append(maker)" : `made::append(${closure})`,
			)
			let answer = captured
				? "sum::add(made::map((_ f: () -> Integer) -> Integer { <- f() })::sum())"
				: swapped
					? "sum::add(left)"
					: "sum"

			// NOTE: Every Parameter drawn is READ by the answer, so a default
			// nothing reads can not hide a difference in what it was given.
			if (recorded) {
				answer = `${answer}::add(mark)`
			}

			if (noisy) {
				answer = `${answer}::add(tag)`
			}

			let body: string

			if (driver === "if") {
				body = `		if n::isLessThan(1) {
			<- ${answer}
		} else {
			<- ${turn}
		}`
			} else if (driver === "match") {
				// NOTE: A Choice of the Program's own, because a `match` needs a
				// Union to decide over — so the turn is decided by a Case rather
				// than by a Boolean, which is the shape the canonical walk has.
				body = `		<- match decided(n) -> Integer {
			case #Stop  { <- ${answer} }
			case #Go(it) { <- ${turn} }
		}`
			} else if (driver === "define") {
				body = `		<- define {
			as ${answer} if n::isLessThan(1)
			as ${turn}   otherwise
		}`
			} else {
				body = `		if n::isLessThan(1) {
			<- ${answer}
		} else {
			if n::isGreaterThan(1000) {
				<- ${answer}
			} else {
				<- ${turn}
			}
		}`
			}

			// NOTE: A second call to the same Function standing where its answer
			// is still worked on. It must stay a call, and the Program must
			// still answer the same thing either way — which is what says the
			// pass told the two apart.
			let extra = alsoRecurses
				? `	function doubled(_ n: Integer) -> Integer {
		if n::isLessThan(1) {
			<- 0
		} else {
			<- doubled(n::subtract(1))::add(2)
		}
	}

	Terminal.print(doubled(${turns}))
`
				: ""

			// NOTE: Declared only where an Argument or a default is asked to
			// say when it was evaluated.
			let helper = noisy
				? `	function note(_ tag: String, _ value: Integer) -> Integer {
		Terminal.print(tag)

		<- value
	}

`
				: ""

			// NOTE: Declared only where the `match` driver needs it, so every
			// other generated Program stays the shape it was.
			let choice =
				driver === "match"
					? `	choice Turn {
		Stop,
		Go { by: Integer },
	}

	function decided(_ n: Integer) -> Turn {
		if n::isLessThan(1) {
			<- #Stop
		} else {
			<- #Go({ by = n })
		}
	}

`
					: ""

			return `implementation {
${choice}${helper}	function walked(${parameters.join(", ")}) -> Integer {
${body}
	}

${extra}	Terminal.print(${called(
				String(start),
				"0",
				[String(turns), String(step)],
				`{ n = ${start} }`,
				noted("arg-tag", String(step)),
				"[]",
			)})
}`
		}

		for (let index = 0; index < CASES; index++) {
			it(`answers the same with the pass off — case ${index}`, () => {
				let source = fuzzed(index)
				let looped = runUnder("bun", generate(source))
				let plain = runUnder("bun", generate(source, withoutPass))

				expect(looped.stderr).toBe("")
				// NOTE: The source is in the message, because a generated
				// counterexample nobody can read is a failure nobody can fix.
				expect({ source, ...looped }).toEqual({ source, ...plain })
			})
		}
	})
})
