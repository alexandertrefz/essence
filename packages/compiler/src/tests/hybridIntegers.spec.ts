import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createInteger } from "@essence-lang/runtime/Integer"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The emitted half of the hybrid Integer. `runtime/src/tests/
// hybridIntegers.spec.ts` holds the representation itself to its invariant; this
// file holds the JavaScript the Rewriter writes to the same one — the guard
// around every inlined operation, the counter a counted walk runs on, the
// representation a literal is written in, and what all of it PRINTS, which is
// the only thing a Program's author ever sees.

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

// NOTE: The emitted module is written to a throwaway file and imported, so that
// what is asserted is what the Program PRINTS rather than what it looks like.
async function outputOf(source: string): Promise<Array<string>> {
	let directory = mkdtempSync(join(tmpdir(), "essence-hybrid-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, generate(source))

	let written = ""
	let originalLog = console.log
	let originalOut = process.stdout.write

	console.log = (...args: Array<unknown>) => {
		written += `${args.map((argument) => String(argument)).join(" ")}\n`
	}

	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	try {
		await import(file)
	} finally {
		console.log = originalLog
		process.stdout.write = originalOut
		rmSync(directory, { recursive: true, force: true })
	}

	return written === "" ? [] : written.replace(/\n$/, "").split("\n")
}

function program(body: string): string {
	return `implementation {\n${body}\n}`
}

describe("the bound the emitted guard is written against", () => {
	// NOTE: The Compiler writes the bound as a literal and the runtime holds one
	// of its own, because neither can read the other's — the runtime is inlined
	// into a user's bundle and the Compiler must not import it. This is what
	// keeps the two the same number.
	it("is the largest integer a double holds exactly", () => {
		// NOTE: Through Parameters, so that `fold-constants` has nothing to
		// answer and the guard survives to be read.
		let generated = generate(
			program(`	function total(_ left: Integer, _ right: Integer) -> Integer {
		<- left::add(right)
	}

	Terminal.print(total(1, 2))`),
		)

		expect(generated).toContain(String(Number.MAX_SAFE_INTEGER))
		expect(generated).not.toContain(String(Number.MAX_SAFE_INTEGER + 2))
	})
})

describe("an emitted operation", () => {
	it("guards the operands by kind and the answer by range", () => {
		let generated = generate(
			program(`	function total(_ left: Integer, _ right: Integer) -> Integer {
		<- left::add(right)
	}

	Terminal.print(total(1, 2))`),
		)

		expect(generated).toContain(
			'typeof left.value === "number" && typeof right.value === "number" && left.value + right.value >= -9007199254740991 && left.value + right.value <= 9007199254740991 ? {',
		)
		expect(generated).toContain("Integer.sum(left.value, right.value)")
	})

	// NOTE: The guard reads each operand twice, so an operand that may only be
	// evaluated once can not be guarded in place — it goes to the runtime whole,
	// where the same decision is made after one evaluation.
	it("hands an operand it may not read twice to the runtime", () => {
		let generated = generate(
			program(`	§§ Answers two, loudly.
	§§
	§§ @returns — two.
	function noisy() -> Integer {
		Terminal.print("evaluated")

		<- 2
	}

	Terminal.print(3::add(noisy()))`),
		)

		expect(generated).toContain("Integer.sum($pool_")
		expect(generated).not.toContain("typeof $pool_0.value")
	})

	it("evaluates a call operand exactly once", async () => {
		expect(
			await outputOf(
				program(`	§§ Answers two, loudly.
	§§
	§§ @returns — two.
	function noisy() -> Integer {
		Terminal.print("evaluated")

		<- 2
	}

	Terminal.print(3::add(noisy()))`),
			),
		).toEqual(["evaluated", "5"])
	})

	it("subtracts and multiplies through their own entries", () => {
		let generated = generate(
			program(`	function apart(_ left: Integer, _ right: Integer) -> Integer {
		<- left::subtract(right)
	}

	function times(_ left: Integer, _ right: Integer) -> Integer {
		<- left::multiply(with right)
	}

	Terminal.print(apart(3, 1))
	Terminal.print(times(3, 2))`),
		)

		expect(generated).toContain(
			"Integer.difference(left.value, right.value)",
		)
		expect(generated).toContain("Integer.product(left.value, right.value)")
	})
})

describe("an emitted literal", () => {
	// NOTE: A literal is written in the representation its value canonically
	// has, so that `createInteger` has nothing to convert and a pooled constant
	// is already the shape every comparison against it expects.
	it("is a number inside safe range and a bigint outside it", () => {
		let generated = generate(
			program(`	Terminal.print(9007199254740991)
	Terminal.print(9007199254740992)
	Terminal.print(-9007199254740992)`),
		)

		expect(generated).toContain("Integer.createInteger(9007199254740991)")
		expect(generated).toContain("Integer.createInteger(9007199254740992n)")
		expect(generated).toContain("Integer.createInteger(-9007199254740992n)")
	})

	it("prints every crossing exactly", async () => {
		expect(
			await outputOf(
				program(`	Terminal.print(9007199254740991)
	Terminal.print(9007199254740992)
	Terminal.print(-9007199254740993)
	Terminal.print(170141183460469231731687303715884105728)`),
			),
		).toEqual([
			"9007199254740991",
			"9007199254740992",
			"-9007199254740993",
			"170141183460469231731687303715884105728",
		])
	})
})

describe("a folded operation", () => {
	// NOTE: `fold-constants` computes in bigint and writes an `IntegerValue`
	// back, which the Rewriter then spells canonically — so a fold that crosses
	// the boundary must land in the representation the same value written by
	// hand would.
	it("writes its answer in the canonical representation", () => {
		let generated = generate(
			program(`	Terminal.print(4503599627370496::multiply(with 2))
	Terminal.print(4503599627370495::multiply(with 2))`),
		)

		expect(generated).toContain("Integer.createInteger(9007199254740992n)")
		expect(generated).toContain("Integer.createInteger(9007199254740990)")
	})

	it("prints what the unfolded operation prints", async () => {
		expect(
			await outputOf(
				program(`	Terminal.print(9007199254740991::add(1))
	Terminal.print(9007199254740992::subtract(1))
	Terminal.print(94906266::multiply(with 94906266))
	Terminal.print(2::raise(to 200)::otherwise(0))`),
			),
		).toEqual([
			"9007199254740992",
			"9007199254740991",
			"9007199326062756",
			"1606938044258990275541962092341162602522202993782792835301376",
		])
	})
})

describe("a counted walk", () => {
	// NOTE: Two Literals a double holds exactly answer the question before the
	// Program runs, so the walk is written with no bigint in it anywhere. A
	// bound the Compiler can not read is what the run-time test below is for.
	it("counts in numbers where both bounds are written as ones", () => {
		let generated = generate(
			program(`	constant sum = loop(from 1, through 10, startingWith 0, step (
		index,
		total,
	) { <- total::add(index) })

	Terminal.print(sum)`),
		)

		expect(generated).not.toContain("$loop_0_big")
		expect(generated).not.toContain("BigInt(")
		expect(generated).toContain(
			"const $loop_0_delta = $loop_0_up ? 1 : -1;",
		)
	})

	it("asks which kind a bound it can not read is holding", () => {
		let generated = generate(
			program(`	function upTo(_ limit: Integer) -> Integer {
		<- loop(from 1, through limit, startingWith 0, step (
			index,
			total,
		) { <- total::add(index) })
	}

	Terminal.print(upTo(10))`),
		)

		expect(generated).toContain(
			'const $loop_0_big = typeof $loop_0_from !== "number" || typeof $loop_0_to !== "number";',
		)
		expect(generated).toContain(
			"const $loop_0_delta = $loop_0_big ? $loop_0_up ? 1n : -1n : $loop_0_up ? 1 : -1;",
		)
	})

	// NOTE: A bound past safe range is a walk of more turns than a Program can
	// run, so what matters is only that it counts CORRECTLY — the counter
	// escapes with its bounds, and a lower bound still held as a number is
	// converted once rather than every turn.
	it("counts a crossing walk exactly", async () => {
		expect(
			await outputOf(
				program(`	constant crossed = loop(from 9007199254740990, through 9007199254740994,
		startingWith 0, step (index, total) { <- total::add(1) })

	constant last = loop(from 9007199254740990, through 9007199254740994,
		startingWith 0, step (index, _total) { <- index })

	constant down = loop(from 9007199254740994, through 9007199254740990,
		startingWith 0, step (index, _total) { <- index })

	Terminal.print(crossed)
	Terminal.print(last)
	Terminal.print(down)`),
			),
		).toEqual(["5", "9007199254740994", "9007199254740990"])
	})

	// NOTE: The counter's Integer is dropped where the body only reads what it
	// holds, so the two shapes that must not be got wrong are a body that hands
	// the counter ON — which needs the Integer — and a nested walk reading the
	// outer counter, which reads through a second walk's worth of emitted code
	// to reach it.
	it("counts alike whether the counter's Integer survives or not", async () => {
		expect(
			await outputOf(
				program(`	constant seed: List<Integer> = []

	constant gathered = loop(from 1, through 3, startingWith seed,
		step (index, seen) { <- seen::append(index) })

	constant nested = loop(from 1, through 3, startingWith 0, step (outer, carried) {
		<- loop(from 1, through 3, startingWith carried, step (inner, running) {
			<- running::add(outer::multiply(with inner))
		})
	})

	Terminal.print(gathered::length())
	Terminal.print(nested)`),
			),
		).toEqual(["3", "36"])
	})

	it("hands the body a counter that is canonical on both sides", async () => {
		expect(
			await outputOf(
				program(`	constant seen = loop(from 9007199254740991, through 9007199254740993,
		startingWith "", step (index, gathered) {
		<- gathered::append(index::toString())::append(" ")
	})

	Terminal.print(seen)`),
			),
		).toEqual(["9007199254740991 9007199254740992 9007199254740993 "])
	})

	// NOTE: The counter's KIND is decided once, from the bounds, because a `for`
	// counter can not change kind mid-walk. Canonicality is a property of each
	// VALUE, so a walk with one bound inside safe range and one outside counts
	// in bigint through values a double holds exactly — and the body that had
	// its Integer elided reads the counter itself. Every one of those turns is a
	// value with two spellings unless the turn canonicalises it, and `is` is
	// emitted as `===`, which answers `false` across the two.
	//
	// NOTE: Asked with `is` and not with `toString`: a mention of the counter
	// that is not a read of its value REFUSES the elision, so a body that prints
	// the counter never reaches the shape this is about.
	it("compares a counter of a crossing walk by its value", async () => {
		expect(
			await outputOf(
				program(`	constant hits = loop(from 9007199254740988, through 9007199254740992,
		startingWith 0, step (index, found) {
		if index::is(9007199254740990) { <- found::add(1) } else { <- found }
	})

	constant misses = loop(from 9007199254740991, through 9007199254740993,
		startingWith 0, step (index, found) {
		if index::isNot(9007199254740992) { <- found::add(1) } else { <- found }
	})

	constant below = loop(from -9007199254740992, through -9007199254740988,
		startingWith 0, step (index, found) {
		if index::is(-9007199254740990) { <- found::add(1) } else { <- found }
	})

	Terminal.print(hits)
	Terminal.print(misses)
	Terminal.print(below)`),
			),
		).toEqual(["1", "2", "1"])
	})

	// NOTE: Neither bound written as a literal, so nothing about the walk is
	// decided while compiling, and the two counters that meet are two walks'
	// worth of emitted code apart.
	it("compares two crossing counters against each other", async () => {
		expect(
			await outputOf(
				program(`	function matches(_ target: Integer, upTo limit: Integer) -> Integer {
		<- loop(from 9007199254740988, through limit, startingWith 0,
			step (index, found) {
			if index::is(target) { <- found::add(1) } else { <- found }
		})
	}

	constant paired = loop(from 9007199254740990, through 9007199254740991,
		startingWith 0, step (outer, carried) {
		<- loop(from 9007199254740990, through 9007199254740992,
			startingWith carried, step (inner, running) {
			if inner::is(outer) { <- running::add(1) } else { <- running }
		})
	})

	Terminal.print(matches(9007199254740990, upTo 9007199254740992))
	Terminal.print(matches(9007199254740990, upTo 9007199254740991))
	Terminal.print(paired)`),
			),
		).toEqual(["1", "1", "2"])
	})
})

describe("what a Program computes across the boundary", () => {
	it("adds, subtracts, multiplies and negates exactly", async () => {
		expect(
			await outputOf(
				program(`	function total(_ left: Integer, _ right: Integer) -> Integer {
		<- left::add(right)
	}

	function apart(_ left: Integer, _ right: Integer) -> Integer {
		<- left::subtract(right)
	}

	function times(_ left: Integer, _ right: Integer) -> Integer {
		<- left::multiply(with right)
	}

	Terminal.print(total(9007199254740991, 1))
	Terminal.print(total(9007199254740992, -1))
	Terminal.print(apart(9007199254740992, 9007199254740992))
	Terminal.print(times(94906266, 94906266))
	Terminal.print(times(94906265, 94906265))
	Terminal.print(times(9007199254740992, 0))
	Terminal.print(9007199254740992::negate())`),
			),
		).toEqual([
			"9007199254740992",
			"9007199254740991",
			"0",
			"9007199326062756",
			"9007199136250225",
			"0",
			"-9007199254740992",
		])
	})

	it("compares and orders across the two representations", async () => {
		expect(
			await outputOf(
				program(`	function same(_ left: Integer, _ right: Integer) -> Boolean {
		<- left::is(right)
	}

	function below(_ left: Integer, _ right: Integer) -> Boolean {
		<- left::isLessThan(right)
	}

	Terminal.print(same(9007199254740992, 9007199254740992))
	Terminal.print(same(9007199254740991, 9007199254740992))
	Terminal.print(same(0, 0))
	Terminal.print(below(9007199254740991, 9007199254740992))
	Terminal.print(below(9007199254740992, 9007199254740991))
	Terminal.print(below(-9007199254740992, 0))`),
			),
		).toEqual(["true", "false", "true", "true", "false", "true"])
	})

	// NOTE: The cross-kind cell — `1 is 1/1` — with the Integer side held as a
	// number, which is what it always is for a value this small.
	it("still equals the Rational spelling the same value", async () => {
		expect(
			await outputOf(
				program(`	constant one: Number = 1
	constant over: Number = 1/1
	constant boxed: List<Number> = [1]
	constant others: List<Number> = [1/1]

	Terminal.print(one::is(over))
	Terminal.print(boxed::is(others))`),
			),
		).toEqual(["true", "true"])
	})

	it("divides, takes remainders and raises across the boundary", async () => {
		expect(
			await outputOf(
				program(`	function ratio(_ left: Integer, _ right: Integer) -> Integer {
		<- left::quotient(dividingBy right)::otherwise(0)
	}

	function left(_ value: Integer, _ by: Integer) -> Integer {
		<- value::remainder(dividingBy by)::otherwise(0)
	}

	Terminal.print(ratio(9007199254740992, 2))
	Terminal.print(ratio(-9007199254740992, 3))
	Terminal.print(left(9007199254740992, 3))
	Terminal.print(left(-9007199254740993, 1000000007))
	Terminal.print(2::raise(to 53)::otherwise(0))
	Terminal.print(1::divide(by 9007199254740992))`),
			),
		).toEqual([
			"4503599627370496",
			"-3002399751580331",
			"2",
			"808309407",
			"9007199254740992",
			"1/9007199254740992",
		])
	})

	it("indexes and measures a List at either representation", async () => {
		expect(
			await outputOf(
				program(`	constant items = [10, 20, 30]

	Terminal.print(items::length())
	Terminal.print(items::item(at 9007199254740992)::otherwise(0))
	Terminal.print(items::item(at -9007199254740992)::otherwise(0))
	Terminal.print(items::item(at -1)::otherwise(0))
	Terminal.print("abc"::length())
	Terminal.print("abc"::character(at 9007199254740992)::otherwise("-"))`),
			),
		).toEqual(["3", "0", "0", "30", "3", "-"])
	})
})

describe("the pooled constants", () => {
	// NOTE: A pooled literal is built once and read by name everywhere, so a
	// pool holding a value in the wrong representation would put an uncanonical
	// Integer in front of every comparison against it.
	it("are canonical", async () => {
		let generated = generate(
			program(`	Terminal.print(7::add(7))
	Terminal.print(9007199254740992::add(9007199254740992))`),
		)
		let pooled = [
			...generated.matchAll(
				/const (\$pool_\d+) = Integer\.createInteger\(([^)]+)\);/g,
			),
		]

		expect(pooled.length).toBeGreaterThan(0)

		for (let [, , written] of pooled) {
			let value = written!.endsWith("n")
				? BigInt(written!.slice(0, -1))
				: Number(written!)

			expect(createInteger(value).value).toBe(
				value as unknown as number | bigint,
			)
		}
	})
})
