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

// NOTE: Every line mentioning a walk's State slot that is NOT one of the three
// positions a raw slot may stand in: a WRITE of it — the `let` its seed declares
// or an assignment to it — a WHOLE read of it into a name, which is the `const` a
// turn binds a Parameter through and the enclosing slot a nested walk answers
// into, and the exit that boxes it. Read off the emitted text rather than off the
// tree, because the text is what a reader chasing the shape sees — and a slot
// standing anywhere else is a mention the Rewriter's own fence would have refused
// the walk for.
function unknownMentionsOf(generated: string, slot: string): Array<string> {
	return generated
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.includes(slot) &&
				!line.startsWith(`let ${slot} = `) &&
				!line.startsWith(`${slot} = `) &&
				!line.endsWith(`= ${slot};`) &&
				!line.includes(`Integer.createInteger(${slot})`),
		)
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

	it("reads a chained operation through both of its arms", async () => {
		// NOTE: An operand that is ITSELF a guarded operation used to build an
		// Integer for the operation around it to read straight back — a box
		// built and taken apart on one line, which is the half swap
		// `unboxed-loop-state` measured as a LOSS. Every site that reads an
		// Integer for its value reads it through both arms instead: the operands
		// of an operation that escaped, both sides of a comparison, and the
		// value a raw slot takes. It is not a walk's question — the Function
		// below has no walk in it.
		let source = program(`	§§ Triples a value.
	§§
	§§ @param value — the value
	§§ @returns — three times the value.
	function triple(_ value: Integer) -> Integer {
		<- value::add(value)::add(value)
	}

	constant chained = loop(from 1, through 3, startingWith 9007199254740990, step (
		index,
		carried,
	) { <- carried::add(index)::add(index) })

	constant compared = loop(from 1, through 3, startingWith 0, step (
		index,
		carried,
	) {
		if carried::add(index)::isGreaterThan(2) { <- carried::add(10) } else { <- carried::add(index) }
	})

	Terminal.print(triple(9007199254740990))
	Terminal.print(chained)
	Terminal.print(chained::is(9007199254741002))
	Terminal.print(compared)`)

		// NOTE: Not one Integer is BUILT anywhere in this Program. Every
		// operation here stands where its answer is read for its value — as the
		// operand of another, as the side of a comparison, or as the value a raw
		// slot takes — so the object literal has nowhere left to be written. The
		// walks also cross 2⁵³, which is where an arm read wrongly would show.
		expect(generate(source)).not.toContain(
			'[$type.typeKeySymbol]: "Integer"',
		)
		expect(await outputOf(source)).toEqual([
			"27021597764222970",
			"9007199254741002",
			"true",
			"21",
		])
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

// NOTE: The other half of the same elision, and the one that PAYS: a walk's
// loop-carried State, held as the value its Integer boxes rather than as the
// Integer. It only pays TOGETHER with the arithmetic answering a raw value — a
// slot that reads a boxed answer back through `.value` measured SLOWER than
// leaving the State alone — so the two are one change and are tested as one.
//
// NOTE: The first eight `it`s are the eight numbered invariants of the fence, in
// the order `optimisations.md` states them under `unboxed-loop-state` and under
// the same numbers — a reviewer reading the page and a reviewer reading this file
// should find one list, not two. What follows them is not part of the fence: which
// drivers take the swap, and the two shapes where one walk stands inside another.
describe("a walk's carried State", () => {
	it("1: is held raw only where its Type is exactly Integer", async () => {
		let source =
			program(`	constant summed = loop(from 1, through 3, startingWith 0, step (
		index,
		total,
	) { <- total::add(index) })

	constant built = loop(from 1, through 3, startingWith { total = 0 }, step (
		index,
		state,
	) { <- { state with total = state.total::add(index) } })

	constant text = loop(from 1, through 3, startingWith "", step (
		_index,
		seen,
	) { <- seen::append("x") })

	Terminal.print(summed)
	Terminal.print(built.total)
	Terminal.print(text)`)
		let generated = generate(source)

		expect(generated).toMatch(/let \$loop_0_state = \$pool_\d+\.value;/)
		// NOTE: A Record and a String hold their seed as it stands. Only an
		// Integer has a value under it to be held instead.
		expect(generated).not.toMatch(/let \$loop_1_state = .*\.value;/)
		expect(generated).not.toMatch(/let \$loop_2_state = .*\.value;/)
		expect(await outputOf(source)).toEqual(["6", "6", "xxx"])
	})

	it("2: keeps its box for any mention past a read of the value", async () => {
		// NOTE: The fourth walk is the one a reader reaches for first. Only the
		// operations `lower-scalar-operations` writes out — the arithmetic and
		// the comparisons — read the value; every other Method of Integer takes
		// the Integer, so asking the accumulator whether it is even keeps its
		// box, and there is no way to ask that and keep the swap.
		let source = program(`	§§ Doubles a value.
	§§
	§§ @param value — the value
	§§ @returns — twice the value.
	function twice(_ value: Integer) -> Integer {
		<- value::add(value)
	}

	constant handed = loop(from 1, through 3, startingWith 1, step (
		_index,
		carried,
	) { <- twice(carried) })

	constant spelled = loop(from 1, through 3, startingWith 7, step (
		_index,
		carried,
	) { <- carried::add(carried::toString()::length()) })

	constant listed = loop(from 1, through 3, startingWith 5, step (
		_index,
		carried,
	) { <- [carried]::length()::add(carried) })

	constant asked = loop(from 1, through 3, startingWith 5, step (
		_index,
		carried,
	) {
		if carried::isEven() { <- carried::add(1) } else { <- carried::add(2) }
	})

	Terminal.print(handed)
	Terminal.print(spelled)
	Terminal.print(listed)
	Terminal.print(asked)`)
		let generated = generate(source)

		for (let walk of ["$loop_0", "$loop_1", "$loop_2", "$loop_3"]) {
			expect(generated).not.toMatch(
				new RegExp(`let \\${walk}_state = .*\\.value;`),
			)
			expect(generated).not.toContain(
				`Integer.createInteger(${walk}_state)`,
			)
		}

		expect(await outputOf(source)).toEqual(["8", "10", "8", "11"])
	})

	it("3: decides for a while driver's predicate and its step together", async () => {
		// NOTE: One State reaches TWO bodies here, and the predicate is the one
		// that refuses — it asks the State for its decimal spelling. A swap
		// taken for the step alone would hand the predicate a raw value under a
		// name it still reads `.value` off.
		let source =
			program(`	constant asked = loop(startingWith 0, while (n) {
		<- n::toString()::length()::isLessThan(3)
	}, step (n) { <- n::add(7) })

	constant read = loop(startingWith 0, while (n) {
		<- n::isLessThan(30)
	}, step (n) { <- n::add(7) })

	Terminal.print(asked)
	Terminal.print(read)`)
		let generated = generate(source)

		expect(generated).not.toMatch(/let \$loop_0_state = .*\.value;/)
		expect(generated).toContain("n.value + $pool")
		expect(generated).toMatch(/let \$loop_1_state = \$pool_\d+\.value;/)
		expect(await outputOf(source)).toEqual(["105", "35"])
	})

	it("4: binds the Parameter each turn, so a closure holds that turn", async () => {
		// NOTE: THE reason the Parameter's `const` is kept rather than read out
		// of the slot directly. The slot is ONE binding for the whole walk, so a
		// closure reading it would answer what the walk finished with; the
		// Parameter is bound per turn, exactly as the Integer it replaced was,
		// so a closure that outlives its turn answers what that turn carried.
		let source = program(`	variable holder = () -> Integer { <- 0 }

	constant total = loop(from 1, through 3, startingWith 100, step (
		index,
		carried,
	) {
		holder = () -> Integer { <- carried::add(0) }

		<- carried::add(index)
	})

	Terminal.print(total)
	Terminal.print(holder())`)

		expect(generate(source)).toContain("const carried = $loop_0_state;")
		// NOTE: 103 is what the third turn was handed, not the 106 the walk
		// finished with.
		expect(await outputOf(source)).toEqual(["106", "103"])
	})

	it("5: unboxes the seed and every write of the State", () => {
		// NOTE: Three shapes write a State: the `let` its seed declares, the
		// assignment an answer is written as, and the `state` member of a `Step`
		// the Compiler could not see being built. The third is the one that
		// arrives as an Integer from somewhere else entirely.
		let generated = generate(
			program(`	§§ Answers the Step a value has earned.
	§§
	§§ @param value — the running State
	§§ @returns — the Step.
	function next(_ value: Integer) -> Step<Integer, Integer> {
		if value::isLessThan(10) { <- #Continue(value::add(1)) } else { <- #Done(0) }
	}

	constant held = loop(startingWith 1, step (n) {
		constant answer = next(n::add(0))

		<- answer
	})

	Terminal.print(held)`),
		)

		expect(generated).toMatch(/let \$loop_0_state = \$pool_\d+\.value;/)
		expect(generated).toContain("$loop_0_state = $loop_0_step.state.value;")
		expect(unknownMentionsOf(generated, "$loop_0_state")).toEqual([])
	})

	it("5b: mentions the slot nowhere the swap can not see it", () => {
		// NOTE: What makes finding the writes by NAME enough. The slot may stand
		// in four positions and no others — the `let` its seed declares, an
		// assignment to it, the `const` a turn binds a Parameter through, and
		// the exit that boxes it — and the swap refuses a walk that mentions it
		// a fifth way rather than emitting one, because a write the rewriter
		// walked past would leave an Integer in a slot holding values and say
		// nothing. Every driver that threads a State is asked here.
		let generated = generate(
			program(`	constant conditioned = loop(startingWith 0, while (n) {
		<- n::isLessThan(20)
	}, step (n) { <- n::add(7) })

	constant counted = loop(from 1, through 3, startingWith 0, step (
		index,
		carried,
	) { <- carried::add(index) })

	constant stepped = loop(startingWith 0, step (n) {
		if n::isLessThan(3) { <- #Continue(n::add(1)) } else { <- #Done(n) }
	})

	constant folded = [1, 2, 3]::reduce(startingWith 0, (carried, item) {
		<- carried::add(item)
	})

	constant early = [1, 2, 3]::reduce(startingWith 0, step (carried, item) {
		if carried::isLessThan(2) { <- #Continue(carried::add(item)) } else { <- #Done(carried) }
	})

	constant nested = loop(from 1, through 2, startingWith 0, step (outer, carried) {
		<- loop(from 1, through 2, startingWith carried, step (inner, running) {
			<- running::add(outer::multiply(with inner))
		})
	})

	Terminal.print(conditioned)
	Terminal.print(counted)
	Terminal.print(stepped)
	Terminal.print(folded)
	Terminal.print(early)
	Terminal.print(nested)`),
		)

		for (let walk of [0, 1, 2, 3, 4, 5, 6]) {
			expect(unknownMentionsOf(generated, `$loop_${walk}_state`)).toEqual(
				[],
			)
		}
	})

	it("6: builds one Integer where the walk is over and none in the turn", () => {
		let generated = generate(
			program(`	constant sum = loop(from 1, through 10, startingWith 0, step (
		index,
		total,
	) { <- total::add(index) })

	Terminal.print(sum)`),
		)
		let turn = generated.slice(
			generated.indexOf("for (let $loop_0_index"),
			generated.indexOf("sum = "),
		)

		// NOTE: No Integer BUILT — the literal the guarded arm used to write
		// and the constructor a boxed slot would need. `Integer.sum` still
		// stands on the escaped arm, which is where an Integer has to be built
		// because the runtime is what decides the answer there.
		expect(turn).not.toContain('"Integer"')
		expect(turn).not.toContain("Integer.createInteger")
		expect(generated).toContain("Integer.createInteger($loop_0_state)")
	})

	it("7: holds the canonical spelling at every turn and at the exit", async () => {
		// NOTE: The invariant the slot answers to is the Integer's own — a value
		// in safe range is a number and one outside it is a bigint — and `is` is
		// emitted as `===` on what each Integer holds, so a slot that fell out of
		// it answers `false` against the value written as a literal. The walks
		// below cross the boundary upward, downward, and both ways in one walk.
		expect(
			await outputOf(
				program(`	constant up = loop(from 1, through 3, startingWith 9007199254740990, step (
		_index,
		carried,
	) { <- carried::add(1) })

	constant down = loop(from 1, through 3, startingWith 9007199254740994, step (
		_index,
		carried,
	) { <- carried::subtract(1) })

	constant both = loop(from 1, through 4, startingWith 9007199254740990, step (
		index,
		carried,
	) {
		if index::isLessThan(3) { <- carried::add(2) } else { <- carried::subtract(2) }
	})

	constant far = loop(from 1, through 3, startingWith 1, step (
		_index,
		carried,
	) { <- carried::multiply(with 1606938044258990275541962092341162602522202993782792835301376) })

	Terminal.print(up)
	Terminal.print(up::is(9007199254740993))
	Terminal.print(down)
	Terminal.print(down::is(9007199254740991))
	Terminal.print(both)
	Terminal.print(both::is(9007199254740990))
	Terminal.print(far::is(4149515568880992958512407863691161151012446232242436899995657329690652811412908146399707048947103794288197886611300789182395151075411775307886874834113963687061181803401509523685376))`),
			),
		).toEqual([
			"9007199254740993",
			"true",
			"9007199254740991",
			"true",
			"9007199254740990",
			"true",
			"true",
		])
	})

	it("8: admits the State handed straight back", async () => {
		// NOTE: `<- carried` is the one mention past `.value` that is admitted,
		// because the write it stands in is unboxed with every other — which
		// turns it into a read of the value like any other. It is what an arm
		// that changes nothing writes, and refusing it would refuse most walks
		// with a condition in them.
		let source =
			program(`	constant hits = loop(from 9007199254740988, through 9007199254740992,
		startingWith 0, step (index, found) {
		if index::is(9007199254740990) { <- found::add(1) } else { <- found }
	})

	constant kept = loop(from 1, through 5, startingWith 9007199254740991, step (
		index,
		carried,
	) {
		if carried::is(9007199254740991) { <- carried::add(index) } else { <- carried }
	})

	Terminal.print(hits)
	Terminal.print(kept)
	Terminal.print(kept::is(9007199254740992))`)

		expect(generate(source)).toMatch(
			/let \$loop_0_state = \$pool_\d+\.value;/,
		)
		expect(await outputOf(source)).toEqual([
			"1",
			"9007199254740992",
			"true",
		])
	})

	it("8b: boxes the State a `#Done` finishes with, where it is written", async () => {
		// NOTE: `<- #Done(carried)` is how a `Step`-answering body ordinarily
		// finishes, so refusing it left the two drivers that take a `Step`
		// carrying their box in nearly every Program that writes one. It is
		// admitted for the reason `<- carried` is — the write it stands in is one
		// the swap rewrites — but this write is BOXED rather than unboxed: it
		// goes to the slot the walk ANSWERS with, which holds the Integers every
		// other `#Done` writes into it. Still one Integer per walk, because a
		// `#Done` is what leaves the walk.
		let source =
			program(`	constant stepped = loop(startingWith 9007199254740990, step (n) {
		if n::isGreaterThan(9007199254740993) { <- #Done(n) } else { <- #Continue(n::add(1)) }
	})

	constant folded = [1, 2, 3, 4]::reduce(startingWith 9007199254740990, step (
		carried,
		item,
	) {
		if carried::isGreaterThan(9007199254740992) { <- #Done(carried) } else { <- #Continue(carried::add(item)) }
	})

	Terminal.print(stepped)
	Terminal.print(stepped::is(9007199254740994))
	Terminal.print(folded)
	Terminal.print(folded::is(9007199254740993))`)
		let generated = generate(source)

		expect(generated).toMatch(/let \$loop_0_state = \$pool_\d+\.value;/)
		expect(generated).toContain(
			"$loop_0_answer = Integer.createInteger(n);",
		)
		expect(generated).toMatch(/let \$loop_1_state = \$pool_\d+\.value;/)
		expect(generated).toContain(
			"$loop_1_answer = Integer.createInteger(carried);",
		)
		// NOTE: Both walks leave past 2⁵³, so the boxed answer is where the
		// canonical spelling would go wrong if the exit ever stopped
		// canonicalising — `is` is `===` on what each Integer holds.
		expect(await outputOf(source)).toEqual([
			"9007199254740994",
			"true",
			"9007199254740993",
			"true",
		])
	})

	it("takes a nested walk's exit apart and leaves the counter's box alone", async () => {
		// NOTE: A walk inside a walk answers straight into the enclosing slot,
		// and where both are raw the Integer the inner one builds at its exit
		// would be taken apart on the line that built it. The exit box is
		// recognised by IDENTITY: `Integer.createInteger` is also how a counted
		// walk boxes its index, and that index is a bigint spelling of a value a
		// double holds exactly wherever the bounds straddle safe range — a call
		// recognised by its shape would strip the canonicalisation that site
		// exists to perform. The second walk here is that site.
		let source =
			program(`	constant nested = loop(from 1, through 3, startingWith 9007199254740988, step (
		outer,
		carried,
	) {
		<- loop(from 1, through 2, startingWith carried, step (inner, running) {
			<- running::add(outer::multiply(with inner))
		})
	})

	constant spelled = loop(from 9007199254740990, through 9007199254740992,
		startingWith 0, step (index, carried) {
		<- carried::add(index::toString()::length())
	})

	Terminal.print(nested)
	Terminal.print(nested::is(9007199254741006))
	Terminal.print(spelled)`)
		let generated = generate(source)

		expect(generated).toContain("$loop_1_state = $loop_0_state;")
		expect(generated).not.toContain(
			"Integer.createInteger($loop_0_state).value",
		)
		expect(generated).toContain(
			"const index = Integer.createInteger($loop_2_index);",
		)
		expect(await outputOf(source)).toEqual([
			"9007199254741006",
			"true",
			"48",
		])
	})

	it("carries a State the language refined over Integer", async () => {
		// NOTE: A checked refinement is erased before any of this runs —
		// `eraseRefinements` stands at the head of every pipeline, `--no-optimise`
		// included — so a `NonZeroInteger` State reaches the Rewriter as the
		// Integer it is and is carried like one. That is right, and it is what
		// the first rule's exactness means: a refinement is a promise the
		// Validator kept, not a second representation.
		let source = program(`	constant half: Rational = 1/2
	constant start = half::denominator()

	constant answer = loop(from 1, through 3, startingWith start, step (
		_index,
		carried,
	) { <- carried::add(carried) })

	Terminal.print(answer)`)

		expect(generate(source)).toContain("let $loop_0_state = start.value;")
		expect(await outputOf(source)).toEqual(["16"])
	})

	it("carries every walk that threads a State", async () => {
		// NOTE: The five drivers that thread one — the `while` and `until`
		// entries, the counted walk, the `Step` walk, and both `reduce` entries.
		// `map` and `keepEvery` thread none, so there is nothing there to hold.
		let source =
			program(`	constant conditioned = loop(startingWith 0, while (n) {
		<- n::isLessThan(9007199254740993)
	}, step (n) { <- n::add(9007199254740991) })

	constant counted = loop(from 1, through 3, startingWith 9007199254740990, step (
		index,
		carried,
	) { <- carried::add(index) })

	constant stepped = loop(startingWith 9007199254740990, step (n) {
		if n::isLessThan(9007199254740993) { <- #Continue(n::add(1)) } else { <- #Done(n::multiply(with 2)) }
	})

	constant folded = [1, 2, 3]::reduce(startingWith 9007199254740990, (
		carried,
		item,
	) { <- carried::add(item) })

	constant early = [1, 2, 3]::reduce(startingWith 9007199254740990, step (
		carried,
		item,
	) {
		if carried::isLessThan(9007199254740999) { <- #Continue(carried::add(item)) } else { <- #Done(0) }
	})

	Terminal.print(conditioned)
	Terminal.print(counted)
	Terminal.print(stepped)
	Terminal.print(folded)
	Terminal.print(early)`)
		let generated = generate(source)

		for (let walk of [
			"$loop_0",
			"$loop_1",
			"$loop_2",
			"$loop_3",
			"$loop_4",
		]) {
			expect(generated).toMatch(
				new RegExp(`let \\${walk}_state = \\$pool_\\d+\\.value;`),
			)
		}

		expect(await outputOf(source)).toEqual([
			"18014398509481982",
			"9007199254740996",
			"18014398509481986",
			"9007199254740996",
			"9007199254740996",
		])
	})

	it("carries a State through a walk inside a walk", async () => {
		// NOTE: Two walks deep, with the inner one seeded from the outer's State
		// and answering it — so the inner walk's Integer is built at its exit and
		// read straight back into the outer slot.
		expect(
			await outputOf(
				program(`	constant nested = loop(from 1, through 3, startingWith 9007199254740988, step (
		outer,
		carried,
	) {
		<- loop(from 1, through 2, startingWith carried, step (inner, running) {
			<- running::add(outer::multiply(with inner))
		})
	})

	constant escapes = loop(from 1, through 3, startingWith 0, step (
		outer,
		carried,
	) {
		<- loop(from 1, through 2, startingWith 0, step (inner, running) {
			<- running::add(carried)::add(inner)::add(outer)
		})
	})

	Terminal.print(nested)
	Terminal.print(nested::is(9007199254741006))
	Terminal.print(escapes)`),
			),
		).toEqual(["9007199254741006", "true", "43"])
	})

	it("refuses a walk whose State seeds a walk that kept its box", async () => {
		// NOTE: The seam between two walks, and the one shape that could get it
		// wrong. The inner walk is written FIRST, so by the time the outer's
		// fence reads its body the inner seed is either `carried.value` — a read
		// of the value like any other, which lets the outer carry raw too — or
		// `carried` itself, which is a mention past `.value` and refuses the
		// outer. Here the inner keeps its box, so the outer keeps its own.
		let source =
			program(`	constant seeded = loop(from 1, through 3, startingWith 9007199254740990, step (
		_outer,
		carried,
	) {
		<- loop(from 1, through 2, startingWith carried, step (_inner, running) {
			<- running::add(running::toString()::length())
		})
	})

	Terminal.print(seeded)
	Terminal.print(seeded::is(9007199254741086))`)
		let generated = generate(source)

		expect(generated).toMatch(/let \$loop_1_state = \$pool_\d+;/)
		expect(generated).toContain("let $loop_0_state = carried;")
		expect(await outputOf(source)).toEqual(["9007199254741086", "true"])
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
