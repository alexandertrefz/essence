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

// The emitted half of the hybrid Integer. The runtime's
// `hybridIntegers.spec.ts` holds the representation to its invariant. This
// file holds the Rewriter's JavaScript to it: each inlined operation's guard,
// a counted walk's counter, a literal's representation, and what all of it
// prints. See "Hybrid Integers" in
// packages/compiler/src/rewriter/DEVELOPMENT.md.

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

// Imports the emitted module from a throwaway file, so what is asserted is
// what the Program prints.
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

// Every emitted line mentioning a walk's State slot outside a raw slot's
// positions. Those are a write of it, a whole read of it into a name, and the
// exit that boxes it. Any other mention would have refused the swap.
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
	// The Compiler writes the bound as a literal and the runtime holds its
	// own, since a bundle inlines the runtime. This keeps the two equal.
	it("is the largest integer a double holds exactly", () => {
		// Through Parameters, so that `fold-constants` has nothing to
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

	// The guard reads each operand twice, so an operand that may be evaluated
	// only once goes to the runtime whole. See "Arithmetic" in
	// packages/compiler/src/rewriter/DEVELOPMENT.md.
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
		// A guarded operand is read through both arms rather than boxed and
		// taken apart, with or without a walk. See "Unboxing" in
		// packages/compiler/src/rewriter/DEVELOPMENT.md.
		let source = program(`	§§ Triples a value.
	§§
	§§ @param _ — the value
	§§ @returns — three times the value.
	function triple(_ value: Integer) -> Integer {
		<- value::add(value)::add(value)
	}

	constant chained = loop(from 1, through 3, startingWith 9007199254740990, (
		index,
		carried,
	) { <- carried::add(index)::add(index) })

	constant compared = loop(from 1, through 3, startingWith 0, (
		index,
		carried,
	) {
		if carried::add(index)::isGreaterThan(2) { <- carried::add(10) } else { <- carried::add(index) }
	})

	Terminal.print(triple(9007199254740990))
	Terminal.print(chained)
	Terminal.print(chained::is(9007199254741002))
	Terminal.print(compared)`)

		// Every answer here is read for its value, so no Integer is built. The
		// walks cross 2⁵³, where an arm read wrongly would show.
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
	// A literal is written in its canonical representation, so `createInteger`
	// converts nothing and a pooled constant has the shape comparisons expect.
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
	// `fold-constants` computes in bigint, and the Rewriter spells the folded
	// `IntegerValue` as the same value written by hand.
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
	Terminal.print(2::raise(to 200))`),
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
	// Literal bounds a double holds exactly decide the counter's kind while
	// compiling, so no bigint is written.
	it("counts in numbers where both bounds are written as ones", () => {
		let generated = generate(
			program(`	constant sum = loop(from 1, through 10, startingWith 0, (
		index,
		total,
	) { <- total::add(index) })

	Terminal.print(sum)`),
		)

		expect(generated).not.toContain("$loop_0_big")
		expect(generated).not.toContain("BigInt(")
		expect(generated).toContain("const $loop_0_delta = 1;")
	})

	it("asks which kind a bound it can not read is holding", () => {
		let generated = generate(
			program(`	function upTo(_ limit: Integer) -> Integer {
		<- loop(from 1, through limit, startingWith 0, (
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
			"const $loop_0_delta = $loop_0_big ? 1n : 1;",
		)
	})

	// A walk across the safe range must count correctly. A lower bound held as
	// a number is converted once rather than every turn.
	it("counts a crossing walk exactly", async () => {
		expect(
			await outputOf(
				program(`	constant crossed = loop(from 9007199254740990, through 9007199254740994,
		startingWith 0, (index, total) { <- total::add(1) })

	constant last = loop(from 9007199254740990, through 9007199254740994,
		startingWith 0, (index, _total) { <- index })

	constant down = loop(from 9007199254740994, downTo 9007199254740990,
		startingWith 0, (index, _total) { <- index })

	Terminal.print(crossed)
	Terminal.print(last)
	Terminal.print(down)`),
			),
		).toEqual(["5", "9007199254740994", "9007199254740990"])
	})

	// The counter's Integer is dropped where the body only reads its value.
	// A body that hands the counter on needs the Integer, and a nested walk
	// reads the outer counter. See "Unboxed counters and States" in
	// packages/compiler/src/rewriter/DEVELOPMENT.md.
	it("counts alike whether the counter's Integer survives or not", async () => {
		expect(
			await outputOf(
				program(`	constant seed: List<Integer> = []

	constant gathered = loop(from 1, through 3, startingWith seed,
		(index, seen) { <- seen::append(index) })

	constant nested = loop(from 1, through 3, startingWith 0, (outer, carried) {
		<- loop(from 1, through 3, startingWith carried, (inner, running) {
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
		startingWith "", (index, gathered) {
		<- gathered::append(index::toString())::append(" ")
	})

	Terminal.print(seen)`),
			),
		).toEqual(["9007199254740991 9007199254740992 9007199254740993 "])
	})

	// A crossing walk counts in bigint through safe values, and `is` is `===`,
	// so each turn must canonicalise the counter it reads. Printing the counter
	// would refuse the elision, so these ask with `is`.
	it("compares a counter of a crossing walk by its value", async () => {
		expect(
			await outputOf(
				program(`	constant hits = loop(from 9007199254740988, through 9007199254740992,
		startingWith 0, (index, found) {
		if index::is(9007199254740990) { <- found::add(1) } else { <- found }
	})

	constant misses = loop(from 9007199254740991, through 9007199254740993,
		startingWith 0, (index, found) {
		if index::isNot(9007199254740992) { <- found::add(1) } else { <- found }
	})

	constant below = loop(from -9007199254740992, through -9007199254740988,
		startingWith 0, (index, found) {
		if index::is(-9007199254740990) { <- found::add(1) } else { <- found }
	})

	Terminal.print(hits)
	Terminal.print(misses)
	Terminal.print(below)`),
			),
		).toEqual(["1", "2", "1"])
	})

	// No bound is a literal, so nothing is decided while compiling.
	it("compares two crossing counters against each other", async () => {
		expect(
			await outputOf(
				program(`	function matches(_ target: Integer, upTo limit: Integer) -> Integer {
		<- loop(from 9007199254740988, through limit, startingWith 0,
			(index, found) {
			if index::is(target) { <- found::add(1) } else { <- found }
		})
	}

	constant paired = loop(from 9007199254740990, through 9007199254740991,
		startingWith 0, (outer, carried) {
		<- loop(from 9007199254740990, through 9007199254740992,
			startingWith carried, (inner, running) {
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

	// `1 is 1/1`, with the Integer held as a number.
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
		<- left::quotient(dividingBy right)::value(defaultingTo 0)
	}

	function left(_ value: Integer, _ by: Integer) -> Integer {
		<- value::remainder(dividingBy by)::value(defaultingTo 0)
	}

	Terminal.print(ratio(9007199254740992, 2))
	Terminal.print(ratio(-9007199254740992, 3))
	Terminal.print(left(9007199254740992, 3))
	Terminal.print(left(-9007199254740993, 1000000007))
	Terminal.print(2::raise(to 53))
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
	Terminal.print(items::item(at 9007199254740992)::value(defaultingTo 0))
	Terminal.print(items::item(at -9007199254740992)::value(defaultingTo 0))
	Terminal.print(items::item(at -1)::value(defaultingTo 0))
	Terminal.print("abc"::length())
	Terminal.print("abc"::character(at 9007199254740992)::value(defaultingTo "-"))`),
			),
		).toEqual(["3", "0", "0", "30", "3", "-"])
	})
})

// A walk's State, held as the value its Integer holds, which pays only with
// arithmetic answering a raw value. See "Unboxed counters and States" in
// packages/compiler/src/rewriter/DEVELOPMENT.md. The numbered `it`s are the
// invariants `/docs/reference/optimisations` lists under `unboxed-loop-state`,
// with its numbers. The rest test which drivers take the swap, and nested
// walks.
describe("a walk's carried State", () => {
	it("1: is held raw only where its Type is exactly Integer", async () => {
		let source =
			program(`	constant summed = loop(from 1, through 3, startingWith 0, (
		index,
		total,
	) { <- total::add(index) })

	constant built = loop(from 1, through 3, startingWith { total = 0 }, (
		index,
		state,
	) { <- { state with total = state.total::add(index) } })

	constant text = loop(from 1, through 3, startingWith "", (
		_index,
		seen,
	) { <- seen::append("x") })

	Terminal.print(summed)
	Terminal.print(built.total)
	Terminal.print(text)`)
		let generated = generate(source)

		expect(generated).toMatch(/let \$loop_0_state = \$pool_\d+\.value;/)
		// Only an Integer has a value under it to hold instead.
		expect(generated).not.toMatch(/let \$loop_1_state = .*\.value;/)
		expect(generated).not.toMatch(/let \$loop_2_state = .*\.value;/)
		expect(await outputOf(source)).toEqual(["6", "6", "xxx"])
	})

	it("2: keeps its box for any mention past a read of the value", async () => {
		// Only the arithmetic and comparisons `lower-scalar-operations` writes
		// out read the value. Every other Method of Integer takes the Integer, so
		// asking whether the accumulator is even keeps its box.
		let source = program(`	§§ Doubles a value.
	§§
	§§ @param _ — the value
	§§ @returns — twice the value.
	function twice(_ value: Integer) -> Integer {
		<- value::add(value)
	}

	constant handed = loop(from 1, through 3, startingWith 1, (
		_index,
		carried,
	) { <- twice(carried) })

	constant spelled = loop(from 1, through 3, startingWith 7, (
		_index,
		carried,
	) { <- carried::add(carried::toString()::length()) })

	constant listed = loop(from 1, through 3, startingWith 5, (
		_index,
		carried,
	) { <- [carried]::length()::add(carried) })

	constant asked = loop(from 1, through 3, startingWith 5, (
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
		// One State reaches two bodies, and the predicate refuses the swap by
		// spelling the State. A swap for the step alone would break the
		// predicate's `.value` read.
		let source =
			program(`	constant asked = loop(startingWith 0, while (n) {
		<- n::toString()::length()::isLessThan(3)
	}, (n) { <- n::add(7) })

	constant read = loop(startingWith 0, while (n) {
		<- n::isLessThan(30)
	}, (n) { <- n::add(7) })

	Terminal.print(asked)
	Terminal.print(read)`)
		let generated = generate(source)

		expect(generated).not.toMatch(/let \$loop_0_state = .*\.value;/)
		expect(generated).toContain("n.value + $pool")
		expect(generated).toMatch(/let \$loop_1_state = \$pool_\d+\.value;/)
		expect(await outputOf(source)).toEqual(["105", "35"])
	})

	it("4: binds the Parameter each turn, so a closure holds that turn", async () => {
		// The slot is one binding for the whole walk, while the Parameter's
		// `const` is bound per turn. So a closure that outlives its turn answers
		// what that turn carried.
		let source = program(`	variable holder = () -> Integer { <- 0 }

	constant total = loop(from 1, through 3, startingWith 100, (
		index,
		carried,
	) {
		holder = () -> Integer { <- carried::add(0) }

		<- carried::add(index)
	})

	Terminal.print(total)
	Terminal.print(holder())`)

		expect(generate(source)).toContain("const carried = $loop_0_state;")
		// 103 is what the third turn was handed, not the 106 the walk ends on.
		expect(await outputOf(source)).toEqual(["106", "103"])
	})

	it("5: unboxes the seed and every write of the State", () => {
		// A State is written by its seed's `let` and by assignments. A `Step`
		// the Compiler could not see being built writes it through `state`.
		let generated = generate(
			program(`	§§ Answers the Step a value has earned.
	§§
	§§ @param _ — the running State
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
		// Finding the writes by name is enough because the swap refuses any
		// mention of the slot outside its known positions. Every driver that
		// threads a State is asked here.
		let generated = generate(
			program(`	constant conditioned = loop(startingWith 0, while (n) {
		<- n::isLessThan(20)
	}, (n) { <- n::add(7) })

	constant counted = loop(from 1, through 3, startingWith 0, (
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

	constant nested = loop(from 1, through 2, startingWith 0, (outer, carried) {
		<- loop(from 1, through 2, startingWith carried, (inner, running) {
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
			program(`	constant sum = loop(from 1, through 10, startingWith 0, (
		index,
		total,
	) { <- total::add(index) })

	Terminal.print(sum)`),
		)
		let turn = generated.slice(
			generated.indexOf("for (let $loop_0_index"),
			generated.indexOf("sum = "),
		)

		// No Integer is built in the turn. `Integer.sum` stands on the escaped
		// arm, where the runtime decides the answer.
		expect(turn).not.toContain('"Integer"')
		expect(turn).not.toContain("Integer.createInteger")
		expect(generated).toContain("Integer.createInteger($loop_0_state)")
	})

	it("7: holds the canonical spelling at every turn and at the exit", async () => {
		// The slot holds what a canonical Integer holds, since `is` is `===`
		// on what each Integer holds. The walks cross the boundary upward,
		// downward, and both ways.
		expect(
			await outputOf(
				program(`	constant up = loop(from 1, through 3, startingWith 9007199254740990, (
		_index,
		carried,
	) { <- carried::add(1) })

	constant down = loop(from 1, through 3, startingWith 9007199254740994, (
		_index,
		carried,
	) { <- carried::subtract(1) })

	constant both = loop(from 1, through 4, startingWith 9007199254740990, (
		index,
		carried,
	) {
		if index::isLessThan(3) { <- carried::add(2) } else { <- carried::subtract(2) }
	})

	constant far = loop(from 1, through 3, startingWith 1, (
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
		// `<- carried` is admitted because its write is unboxed with every
		// other. An arm that changes nothing writes it, so most conditional walks
		// need it.
		let source =
			program(`	constant hits = loop(from 9007199254740988, through 9007199254740992,
		startingWith 0, (index, found) {
		if index::is(9007199254740990) { <- found::add(1) } else { <- found }
	})

	constant kept = loop(from 1, through 5, startingWith 9007199254740991, (
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
		// `<- #Done(carried)` is how a `Step` body usually finishes. It is
		// admitted but boxed, since it writes the slot the walk answers with,
		// and a `#Done` leaves the walk, so it builds one Integer.
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
		// Both walks leave past 2⁵³, where an exit that stopped canonicalising
		// would fail `is`.
		expect(await outputOf(source)).toEqual([
			"9007199254740994",
			"true",
			"9007199254740993",
			"true",
		])
	})

	it("takes a nested walk's exit apart and leaves the counter's box alone", async () => {
		// An inner walk's exit box is taken apart by identity, not shape. A
		// counted walk's index is boxed by the same call and must stay
		// canonicalised. The second walk here is that site. See "Unboxing" in
		// packages/compiler/src/rewriter/DEVELOPMENT.md.
		let source =
			program(`	constant nested = loop(from 1, through 3, startingWith 9007199254740988, (
		outer,
		carried,
	) {
		<- loop(from 1, through 2, startingWith carried, (inner, running) {
			<- running::add(outer::multiply(with inner))
		})
	})

	constant spelled = loop(from 9007199254740990, through 9007199254740992,
		startingWith 0, (index, carried) {
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
		// `optimise` erases refinements before any pass, even with `--no-optimise`,
		// so a `NonZeroInteger` State reaches the Rewriter as an Integer.
		let source = program(`	constant half: Rational = 1/2
	constant start = half::denominator()

	constant answer = loop(from 1, through 3, startingWith start, (
		_index,
		carried,
	) { <- carried::add(carried) })

	Terminal.print(answer)`)

		expect(generate(source)).toContain("let $loop_0_state = start.value;")
		expect(await outputOf(source)).toEqual(["16"])
	})

	it("carries every walk that threads a State", async () => {
		// The drivers that thread a State: `while` and `until`, the counted
		// walk, the `Step` walk, and both `reduce` entries.
		let source =
			program(`	constant conditioned = loop(startingWith 0, while (n) {
		<- n::isLessThan(9007199254740993)
	}, (n) { <- n::add(9007199254740991) })

	constant counted = loop(from 1, through 3, startingWith 9007199254740990, (
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
		// The inner walk is seeded from the outer State and answers into it.
		expect(
			await outputOf(
				program(`	constant nested = loop(from 1, through 3, startingWith 9007199254740988, (
		outer,
		carried,
	) {
		<- loop(from 1, through 2, startingWith carried, (inner, running) {
			<- running::add(outer::multiply(with inner))
		})
	})

	constant escapes = loop(from 1, through 3, startingWith 0, (
		outer,
		carried,
	) {
		<- loop(from 1, through 2, startingWith 0, (inner, running) {
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
		// The inner walk is emitted first, so the outer reads its seed as
		// `carried.value`, which allows the swap, or as `carried`, which refuses
		// it. Here the inner keeps its box, so the outer does too.
		let source =
			program(`	constant seeded = loop(from 1, through 3, startingWith 9007199254740990, (
		_outer,
		carried,
	) {
		<- loop(from 1, through 2, startingWith carried, (_inner, running) {
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
	// A pooled literal is read everywhere, so a wrong representation there
	// would reach every comparison against it.
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
