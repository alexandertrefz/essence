import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"
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

// `loop-self-tail-calls` lets the recursive walk the language teaches run on
// every host. JavaScriptCore eliminates a tail frame and V8 does not, so
// without the pass a long walk overflows on Node and Deno. These specs run the
// walks under Node and assert the emitted shape, which holds on any engine.
//
// A fuzzer checks the rewritten Program answers as the original does over
// combinations. `optimiser.spec.ts` holds the written cases. See "Self tail
// calls" in packages/compiler/src/rewriter/DEVELOPMENT.md.

const TURNS = 200_000

// One Program per shape the pass must reach, each with the same answer, so a
// failure names the shape rather than the arithmetic.
const ANSWER = String((TURNS * (TURNS + 1)) / 2)

// The walk the documentation teaches: a `match` over `firstItem` decides when
// to stop, and the tail is walked next.
const headAndTail = `implementation {
	function total(_ rest: List<Integer>, _ sum: Integer) -> Integer {
		<- match rest::firstItem() -> Integer {
			case #Empty       { <- sum }
			case #Value(head) { <- total(rest::removeFirst(), sum::add(head)) }
		}
	}

	Terminal.print(total(List.of(integersFrom 1, through ${TURNS}), 0))
}`

// Only two Integers, so the turn is measured rather than a walk of a
// structure.
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

// The `match` is over an `Optional` the walk built, not one a native answered.
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

// The receiver is Parameter zero, and `@` inside a Handler means the matched
// value. So the walk binds the receiver outside the chain, and the loop
// rebinds it through a slot.
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

// A provided body calls itself through `@`, so the call goes through the
// conformance the witness handed it.
const providedWalk = `implementation {
	protocol Walking {
		step() -> Integer

		walked(_ n: Integer, _ sum: Integer) -> Integer {
			if n::isLessThan(1) {
				<- sum
			}

			<- @::walked(n::subtract(@::step()), sum::add(n))
		}
	}

	type Walker = { stride: Integer }

	namespace Walkers for Walker is Walking {
		step() -> Integer {
			<- @.stride
		}
	}

	constant walker: Walker = { stride = 1 }

	Terminal.print(walker::walked(${TURNS}, 0))
}`

// `looped` is what a self call names, and `emitted` the Function's own name
// where it differs.
const walks: Array<{
	name: string
	source: string
	looped: string
	emitted?: string
}> = [
	{ name: "the head and tail walk", source: headAndTail, looped: "total" },
	{ name: "an accumulator walk", source: accumulator, looped: "countdown" },
	{ name: "a walk over an Optional", source: optionalWalk, looped: "drain" },
	{ name: "a Namespace Method walk", source: methodWalk, looped: "walked" },
	{
		name: "a provided Method walk",
		source: providedWalk,
		looped: "walked",
		emitted: "\\$es_Walking__walked",
	},
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

// The rendered report rather than a boolean, so a generated Program that
// does not compile says which line of itself to read.
function refusal(
	diagnostics: Array<common.Diagnostic>,
	source: string,
): string {
	return containsErrors(diagnostics)
		? renderDiagnostics(diagnostics, source, "program.es")
		: ""
}

// Node cannot import the runtime's TypeScript, so its runs use a bundle, which
// is also what ships.
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

// One emitted Function's text, from its header to its closing brace. The
// claim is about the JavaScript, so the spec reads the emission rather than
// asking the Optimiser. A provided Method is a prelude const.
function emittedBody(generated: string, name: string): string {
	let header = new RegExp(
		`(?:(?:function|static) ${name}|const ${name} = function )\\(`,
	)
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

// The `node` version, or null without one on the PATH. Running it rather than
// looking for a file treats shims and real binaries alike.
async function nodeVersion(): Promise<string | null> {
	try {
		let result = await spawnAndWait(["node", "--version"])

		return result.code === 0 ? result.stdout.trim() : null
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null
		}

		throw error
	}
}

const node = await nodeVersion()

// Runs the Module in a subprocess, since an import would run it on Bun.
async function runUnder(
	command: string,
	javaScript: string,
): Promise<{ stdout: string; stderr: string }> {
	let directory = mkdtempSync(join(tmpdir(), "essence-tail-calls-"))
	let file = join(directory, "program.mjs")

	writeFileSync(file, javaScript)

	try {
		let result = await spawnAndWait([command, file])

		return { stdout: result.stdout.trim(), stderr: result.stderr }
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

describe("self tail calls", () => {
	describe("the emitted shape", () => {
		// The emitted Function never returns a call to itself, which holds on
		// every engine. The build without the pass must show the opposite, or
		// this would pass against a pass that did nothing.
		for (let walk of walks) {
			it(`leaves no self call in the answer of ${walk.name}`, () => {
				let emitted = walk.emitted ?? walk.looped
				let body = emittedBody(generate(walk.source), emitted)

				expect(body).toContain("while (true)")
				expect(body).toMatch(/continue \$tail_\d+/)
				expect(body).not.toMatch(
					new RegExp(`return \\w*\\.?${walk.looped}\\(`),
				)

				let unlooped = emittedBody(
					generate(walk.source, withoutPass),
					emitted,
				)

				expect(unlooped).not.toContain("while (true)")
				expect(unlooped).toMatch(
					new RegExp(`return \\w*\\.?${walk.looped}\\(`),
				)
			})
		}
	})

	describe("under Node", () => {
		// Without `node`, the skip says why, and the emitted-shape specs still
		// hold the claim.
		if (node === null) {
			it.skip("runs each walk at 200,000 turns (no `node` on the PATH)", () => {})
		} else {
			for (let walk of walks) {
				it(`runs ${walk.name} at ${TURNS} turns on Node ${node}`, async () => {
					let result = await runUnder(
						"node",
						await bundled(walk.source),
					)

					expect(result.stderr).toBe("")
					expect(result.stdout).toBe(ANSWER)
				})
			}

			// Without the pass, V8 overflows long before `TURNS` frames, so the
			// walks under Node are a real guard. An engine with proper tail calls
			// would fail this spec.
			it("overflows Node's stack with the pass off", async () => {
				let result = await runUnder(
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

	// Combinations the written cases cannot cover, such as a swap under a
	// `define` with a default reading a rebound Parameter. Each Program runs
	// with and without the pass, and the outputs must match. The seed is fixed,
	// so a failure is reproducible.
	describe("the fuzzer", () => {
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
			// Each knob is drawn independently. One picks the driver of the turn.
			// The others add a swapped pair, a default reading an earlier
			// Parameter, a capturing closure, or a non-tail self call.
			let driver = pick(["if", "match", "define", "nested"])
			let swapped = random() < 0.5
			let defaulted = random() < 0.5
			let captured = random() < 0.35
			let alsoRecurses = random() < 0.3
			// `recorded` reads a Record member named like a Parameter, which
			// tells a binding from a key. `noisy` prints Arguments, so their order
			// shows. `paired` captures several Parameters, and `closured` puts a
			// Function literal in a default, which the pass declines.
			let recorded = random() < 0.5
			let noisy = random() < 0.5
			let paired = captured && random() < 0.5
			let closured = captured && random() < 0.5
			// A `provided` walk is a Protocol's provided Method, which calls itself
			// through `@`. Such a body takes no default and reaches nothing the
			// Program declares, so the knobs that need either are off.
			let provided = random() < 0.3

			if (provided) {
				driver = driver === "match" ? "if" : driver
				defaulted = false
				recorded = false
				noisy = false
				closured = false
			}

			// `note` prints a tag and answers its value, so it shows evaluation
			// order without changing the answer.
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
				// After the defaulted Parameters and written by every call, so a
				// written Argument follows an omitted one, which a turn must hold.
				...(noisy ? ["_ tag: Integer"] : []),
				...(captured ? ["_ made: List<() -> Integer>"] : []),
				...(closured
					? ["_ maker: () -> Integer = () -> Integer { <- n }"]
					: []),
			]

			// The first call and the turn differ only in what they hand over.
			// Neither hands the defaulted Parameters anything, so each takes its
			// default afresh.
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

			// A `paired` walk adds the counter rather than the stride. Its
			// Arguments then read no Parameter the turn assigns, so only the
			// omitted Argument before a written one makes the turn hold them.
			let carried =
				defaulted && !paired
					? "sum::add(stride)"
					: `sum::add(${swapped ? "left" : "n"})`
			// A closure built in a default closes over a Parameter the turn
			// rebinds, which the pass declines to loop. A `paired` closure captures
			// every carried value, so each is rebound through a slot.
			let closure = paired
				? `() -> Integer { <- n::add(sum)${
						swapped ? "::add(left)::add(right)" : ""
					}::add(made::length()) }`
				: "() -> Integer { <- n }"
			// The turn swaps its pair, takes the defaults again and hands on a
			// closure built in this turn. A wrong rebinding order, a stale default
			// or a binding shared across turns changes the answer.
			let turn = `${provided ? "@::" : ""}${called(
				noted("arg-n", `n::subtract(${step})`),
				carried,
				["right", "left"],
				"opts",
				noted("arg-tag", String(step)),
				closured ? "made::append(maker)" : `made::append(${closure})`,
			)}`
			let answer = captured
				? "sum::add(made::map((_ f: () -> Integer) -> Integer { <- f() })::sum())"
				: swapped
					? "sum::add(left)"
					: "sum"

			// The answer reads every Parameter drawn, so no difference hides in
			// an unread default.
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
				// A Choice of the Program's own, so a Case decides the turn as
				// in the canonical walk.
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

			// A self call whose answer is still worked on must stay a call.
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

			// Declared only for `noisy` Programs.
			let helper = noisy
				? `	function note(_ tag: String, _ value: Integer) -> Integer {
		Terminal.print(tag)

		<- value
	}

`
				: ""

			// Declared only for the `match` driver.
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

			let declared = provided
				? `	protocol Walking {
		walked(${parameters.join(", ")}) -> Integer {
${body}
		}
	}

	type Walker = { walker: Integer }

	namespace Walkers for Walker is Walking {}

	constant walker: Walker = { walker = 0 }
`
				: `	function walked(${parameters.join(", ")}) -> Integer {
${body}
	}
`

			return `implementation {
${choice}${helper}${declared}
${extra}	Terminal.print(${provided ? "walker::" : ""}${called(
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
			it(`answers the same with the pass off — case ${index}`, async () => {
				let source = fuzzed(index)
				let looped = await runUnder("bun", generate(source))
				let plain = await runUnder("bun", generate(source, withoutPass))

				expect(looped.stderr).toBe("")
				// The source is in the message, so a failing case can be read.
				expect({ source, ...looped }).toEqual({ source, ...plain })
			})
		}
	})
})
