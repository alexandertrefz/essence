import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parse, parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// End to end. The Enricher decides what a call carries, the Validator
// measures the Declaration against it, and a body typed under it reports a
// misread accumulator.
function errorsFor(source: string): Array<common.Diagnostic> {
	let { program, diagnostics } = enrich(parse(source))

	return [...diagnostics, ...validate(program)].filter(
		(diagnostic) => diagnostic.severity === "error",
	)
}

function codesFor(source: string): Array<string> {
	return errorsFor(source).map((diagnostic) => diagnostic.code)
}

// Imports the emitted Program from a throwaway module. Every Program sorts
// what it built with the witness the decided item Type picks. A wrong decision
// prints wrongly, and an undecided slot does not compile.
async function run(source: string): Promise<Array<string>> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(enriched.diagnostics).toEqual([])
	expect(validate(enriched.program)).toEqual([])

	let javascript = rewrite(optimise(simplify(enriched.program)))
	let directory = mkdtempSync(join(tmpdir(), "essence-seeds-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javascript)

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

// The Type a top-level Declaration came to.
function typeOfDeclaration(source: string, name: string): common.Type {
	let { program } = enrich(parse(source))

	for (let node of program.implementation.nodes) {
		if (
			(node.nodeType === "ConstantDeclarationStatement" ||
				node.nodeType === "VariableDeclarationStatement") &&
			node.name.content === name
		) {
			return node.type
		}
	}

	throw new Error(`no Declaration named '${name}'`)
}

// The Type of the seed, the Declaration's List Literal Argument.
function typeOfSeedNode(source: string, name: string): common.Type {
	let { program } = enrich(parse(source))

	for (let node of program.implementation.nodes) {
		if (
			node.nodeType !== "ConstantDeclarationStatement" ||
			node.name.content !== name
		) {
			continue
		}

		if (
			node.value.nodeType !== "MethodInvocation" &&
			node.value.nodeType !== "FunctionInvocation"
		) {
			break
		}

		for (let argument of node.value.arguments) {
			if (argument.value.nodeType === "ListValue") {
				return argument.value.type
			}
		}
	}

	throw new Error(`no List Literal Argument under '${name}'`)
}

// An empty `[]` seed binds a Type Parameter to a Type with an undecided slot,
// which the call's other Arguments decide. See "Seeds an Invocation decides" in
// packages/compiler/src/enricher/DEVELOPMENT.md.
describe("Undecided Seeds", () => {
	describe("a fold seeded with an empty List Literal", () => {
		it("decides what it carries from what the combiner answers", async () => {
			expect(
				await run(`implementation {
					constant words = ["ccc", "a", "bb"]
					constant kept = words::reduce(startingWith [], (current, word) {
						<- current::append(word)
					})

					Terminal.inspect(kept::sort())
				}`),
			).toEqual(['[ "a", "bb", "ccc" ]'])
		})

		// An undecided answer would fit every annotation.
		it("refuses the annotation that would launder what it carries", () => {
			let errors = errorsFor(`implementation {
				constant gathered = [1, 2, 3]::reduce(startingWith [], (carry, item) {
					<- carry::append(item)
				})
				constant laundered: List<String> = gathered
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("assignment-type-mismatch")
		})

		it("refuses reading the decided answer as something else", () => {
			expect(
				codesFor(`implementation {
					constant words = ["a", "bb"]
					constant kept = words::reduce(startingWith [], (current, word) {
						<- current::append(word)
					})

					Terminal.print(Number.sum(kept))
				}`),
			).toEqual(["no-matching-overload"])
		})

		// The combiner's body reads the accumulator as the decided Type, not
		// as the seed.
		it("refuses a combiner body that misreads the accumulator", () => {
			expect(
				codesFor(`implementation {
					constant words = ["a", "bb"]
					constant kept = words::reduce(startingWith [], (current, word) {
						constant misread = Number.sum(current)

						<- current::append(word)
					})
				}`),
			).toEqual(["no-matching-overload"])
		})

		// Nothing decides the slot, and the fold does answer an empty List, so
		// the undecided Type is honest and nothing is reported.
		it("leaves the seed undecided where the combiner answers it unchanged", () => {
			expect(
				codesFor(`implementation {
					constant words = ["a", "bb"]
					constant kept = words::reduce(startingWith [], (current, word) {
						<- current
					})
					constant empty: List<String> = kept
				}`),
			).toEqual([])
		})

		// The Validator re-matches the committed signature against the
		// Argument Nodes' Types, so the seed's Node must carry the decision.
		it("writes the decision onto the seed's own Node", () => {
			let source = `implementation {
				constant words = ["a", "bb"]
				constant kept = words::reduce(startingWith [], (current, word) {
					<- current::append(word)
				})
			}`

			expect(typeOfSeedNode(source, "kept")).toEqual({
				type: "List",
				itemType: { type: "String" },
			})
		})
	})

	// A filter keeps the accumulator in one branch and writes into it in the
	// other, so the body answers `NonEmptyList<Integer> | List<Unknown>`. Read
	// branch by branch, the writing branch decides the slot.
	describe("a combiner that writes in only some of its branches", () => {
		it("decides from the branch that writes, after an early return", async () => {
			expect(
				await run(`implementation {
					constant kept = [1, -2, 3]::reduce(startingWith [], (current, number) {
						if number::isLessThan(0) {
							<- current
						}

						<- current::append(number)
					})

					Terminal.inspect(kept::sort())
				}`),
			).toEqual(["[ 1, 3 ]"])
		})

		it("decides it through an if and an else", async () => {
			expect(
				await run(`implementation {
					constant kept = [1, 2, 3, 4]::reduce(startingWith [], (current, number) {
						if number::remainder(dividingBy 2)::is(0) {
							<- current::append(number)
						} else {
							<- current
						}
					})

					Terminal.inspect(kept::sort())
				}`),
			).toEqual(["[ 2, 4 ]"])
		})

		// A slot takes what the branches that fill it agree on, in whatever
		// order they are written.
		it("decides it with the branches the other way round", async () => {
			expect(
				await run(`implementation {
					constant kept = [1, 2, 3, 4]::reduce(startingWith [], (current, number) {
						if number::remainder(dividingBy 2)::isNot(0) {
							<- current
						} else {
							<- current::append(number)
						}
					})

					Terminal.inspect(kept::sort())
				}`),
			).toEqual(["[ 2, 4 ]"])
		})

		it("decides it through a conditional expression", async () => {
			expect(
				await run(`implementation {
					constant kept = [1, 2, 3, 4]::reduce(startingWith [], (current, number) {
						<- define {
							as current::append(number) if number::remainder(dividingBy 2)::is(0)
							as current otherwise
						}
					})

					Terminal.inspect(kept::sort())
				}`),
			).toEqual(["[ 2, 4 ]"])
		})

		// A `step` body answers a Choice, so the slot is a Case's payload. The
		// same rule holds one level in.
		it("decides it through a step body answering a Case", async () => {
			expect(
				await run(`implementation {
					constant kept = [1, 2, 3, 4]::reduce(startingWith [], step (current, number) {
						if number::remainder(dividingBy 2)::is(0) {
							<- #Continue(current::append(number))
						} else {
							<- #Continue(current)
						}
					})

					Terminal.inspect(kept::sort())
				}`),
			).toEqual(["[ 2, 4 ]"])
		})

		// The answer's Type Parameter is decided only once the accumulator's
		// is, from what `#Continue` wrote.
		it("decides what a step body's #Done answers from what #Continue wrote", async () => {
			expect(
				await run(`implementation {
					constant found = loop(startingWith [], step (current) {
						if current::length()::isGreaterThan(2) {
							<- #Done(current)
						}

						<- #Continue(current::append("x"))
					})

					Terminal.inspect(found::sort())
				}`),
			).toEqual(['[ "x", "x", "x" ]'])
		})

		it("decides it under a counted loop", async () => {
			expect(
				await run(`implementation {
					constant grown = loop(from 1, through 5, startingWith [], (index, current) {
						if index::remainder(dividingBy 2)::is(0) {
							<- current
						}

						<- current::append(index)
					})

					Terminal.inspect(grown::sort())
				}`),
			).toEqual(["[ 1, 3, 5 ]"])
		})

		// Each branch writes one member, and together they decide the Record.
		it("decides a Record seed one member per branch", async () => {
			expect(
				await run(`implementation {
					constant split = [1, 2, 3, 4]::reduce(startingWith { evens = [], odds = [] }, (current, number) {
						if number::remainder(dividingBy 2)::is(0) {
							<- { current with evens = current.evens::append(number) }
						} else {
							<- { current with odds = current.odds::append(number) }
						}
					})

					Terminal.inspect(split.evens::sort())
					Terminal.inspect(split.odds::sort())
				}`),
			).toEqual(["[ 2, 4 ]", "[ 1, 3 ]"])
		})

		// A branch answering an empty List decides nothing and refuses nothing,
		// so the other branch decides.
		it("decides it where a branch answers an empty List of its own", async () => {
			expect(
				await run(`implementation {
					constant kept = [1, 2]::reduce(startingWith [], (current, number) {
						if number::isGreaterThan(1) {
							<- current::append(number)
						}

						<- []
					})

					Terminal.inspect(kept::sort())
				}`),
			).toEqual(["[ 2 ]"])
		})

		it("decides it inside a tests block", () => {
			expect(
				codesFor(`implementation {
					function evens(_ numbers: List<Integer>) -> List<Integer> {
						<- numbers
					}
				}

				tests {
					test "a fold that sometimes keeps the seed" {
						constant kept = [1, 2, 3]::reduce(startingWith [], (current, number) {
							if number::isGreaterThan(1) {
								<- current::append(number)
							} else {
								<- current
							}
						})

						require [2, 3] = kept
					}
				}`),
			).toEqual([])
		})

		// Branches that disagree decide nothing, so the slot stays open and
		// every write into it is refused.
		it("refuses a combiner whose branches write different Types", () => {
			expect(
				codesFor(`implementation {
					constant mixed = [1, 2, 3]::reduce(startingWith [], (current, number) {
						if number::is(1) {
							<- current::append(number)
						}

						if number::is(2) {
							<- current::append("two")
						}

						<- current
					})
				}`),
			).toEqual(["return-type-mismatch", "return-type-mismatch"])
		})

		// A branch that decides one member does not spoil the branch that
		// decides the whole accumulator.
		it("decides a member one branch leaves alone", async () => {
			expect(
				await run(`implementation {
					constant tallied = ["a", "", "bb"]::reduce(startingWith { items = [], skipped = 0 }, (current, word) {
						if word::isEmpty() {
							<- { current with skipped = current.skipped::add(1) }
						}

						<- { current with items = current.items::append(word) }
					})

					Terminal.inspect(tallied.items::sort())
				}`),
			).toEqual(['[ "a", "bb" ]'])
		})
	})

	describe("the position a fold is written in", () => {
		// An annotation is read before anything is inferred from the
		// Arguments, so it decides a fold whose combiner says nothing.
		it("decides the accumulator from the Declaration's annotation", async () => {
			expect(
				await run(`implementation {
					constant words = ["ccc", "a", "bb"]
					constant kept: List<String> = words::reduce(startingWith [], (current, word) {
						<- current
					})

					Terminal.inspect(kept::sort())
				}`),
			).toEqual(["[]"])
		})

		it("decides it from the enclosing Function's declared return Type", async () => {
			expect(
				await run(`implementation {
					constant words = ["ccc", "a", "bb"]

					function collected() -> List<String> {
						<- words::reduce(startingWith [], (current, word) {
							<- current::append(word)
						})
					}

					Terminal.inspect(collected()::sort())
				}`),
			).toEqual(['[ "a", "bb", "ccc" ]'])
		})

		it("refuses a body that misreads an accumulator the annotation decided", () => {
			expect(
				codesFor(`implementation {
					constant words = ["a", "bb"]
					constant kept: List<String> = words::reduce(startingWith [], (current, word) {
						constant misread = Number.sum(current)

						<- current
					})
				}`),
			).toEqual(["no-matching-overload"])
		})

		// The annotation wins, and the combiner is measured against it.
		it("refuses a combiner that disagrees with the annotation", () => {
			expect(
				codesFor(`implementation {
					constant kept: List<String> = [1, 2]::reduce(startingWith [], (current, number) {
						<- current::append(number)
					})
				}`),
			).toEqual(["no-matching-overload"])
		})
	})

	describe("the other empty seeds", () => {
		// The keys and the values are decided independently.
		it("decides both slots of an empty Dictionary Literal", async () => {
			expect(
				await run(`implementation {
					constant words = ["ccc", "a", "bb"]
					constant sizes = words::reduce(startingWith [=], (current, word) {
						<- [current with word = word::length()]
					})

					Terminal.inspect(sizes::keys()::sort())
				}`),
			).toEqual(['[ "a", "bb", "ccc" ]'])
		})

		it("decides the items of a nested empty List Literal", async () => {
			expect(
				await run(`implementation {
					constant nested = [2, 1]::reduce(startingWith [[]], (current, number) {
						<- current::append([number])
					})

					Terminal.inspect(nested)
				}`),
			).toEqual(["[ [], [ 2 ], [ 1 ] ]"])
		})

		// The open slot is a member of the Record seed. It is decided to the
		// base of the `NonEmptyList` the combiner answers, since the seed wrote
		// `[]` there.
		it("decides a slot inside a Record seed", async () => {
			expect(
				await run(`implementation {
					constant tallied = ["ccc", "a"]::reduce(startingWith { items = [], count = 0 }, (current, word) {
						<- {
							items = current.items::append(word),
							count = current.count::add(1),
						}
					})

					Terminal.inspect(tallied.items::sort())
					Terminal.inspect(tallied.count::toString())
				}`),
			).toEqual(['[ "a", "ccc" ]', '"2"'])
		})

		// A decided slot carries no proof. Values decided as
		// `NonEmptyList<String>` would refuse the `defaultingTo []` that reads
		// the Dictionary back.
		it("decides a Dictionary's values without the proof one write carried", async () => {
			expect(
				await run(`implementation {
					constant lists = ["apple", "bb"]::reduce(startingWith [=], (current, word) {
						<- [current with word = []::append(word)]
					})

					constant missing = lists::value(at "zz", defaultingTo [])

					Terminal.inspect(missing)
				}`),
			).toEqual(["[]"])
		})

		it("decides it where the fold reads the slot back to build it", async () => {
			expect(
				await run(`implementation {
					constant grouped = ["apple", "avocado", "bb"]::reduce(startingWith [=], (current, word) {
						constant key = word::length()

						<- [current with key = current::value(at key, defaultingTo [])::append(word)]
					})

					Terminal.inspect(grouped::keys()::sort())
				}`),
			).toEqual(["[ 2, 5, 7 ]"])
		})

		// At every depth: `rows::append(["a"]::append("b"))` decides a List of
		// Lists of Strings, so a later empty List still fits.
		it("decides a slot inside a slot without its proof", async () => {
			expect(
				await run(`implementation {
					variable rows = []

					rows = rows::append(["a"]::append("b"))
					rows = rows::append([])

					Terminal.inspect(rows)
				}`),
			).toEqual(['[ [ "a", "b" ], [] ]'])
		})

		// A decided slot still reads an empty List as bottom, so clearing it
		// decides nothing.
		it("still takes an empty List into a slot the fold decided", async () => {
			expect(
				await run(`implementation {
					constant tallied = ["apple", "bb"]::reduce(startingWith { items = [] }, (current, word) {
						<- { items = current.items::append(word) }
					})

					constant cleared = { tallied with items = [] }

					Terminal.inspect(cleared.items)
				}`),
			).toEqual(["[]"])
		})

		// The receiver binds the item Type to `List<Unknown>` first, and the
		// `List<String>` Argument decides it once the whole call is in hand.
		it("decides a Type Parameter the receiver bound before the Argument was read", () => {
			expect(
				typeOfDeclaration(
					`implementation {
						variable rows = [[]]
						constant appended = rows::append(["a"])
					}`,
					"appended",
				),
			).toMatchObject({
				type: "Refinement",
				base: {
					type: "List",
					itemType: { type: "List", itemType: { type: "String" } },
				},
			})
		})

		// The first write decides the Variable's item Type, and every later
		// write is held to it.
		it("refuses a second write that disagrees with the decided one", () => {
			expect(
				codesFor(`implementation {
					variable rows = [[]]

					rows = rows::append(["a"])
					rows = rows::append([1])
				}`),
			).toEqual(["no-matching-overload"])
		})
	})

	describe("a generic Function rather than a Method", () => {
		// Each `loop` entry binds `State` from the seed, so the `while`
		// condition and the body both read the decided State.
		it("decides a loop's State for every callback it hands it", async () => {
			expect(
				await run(`implementation {
					constant grown = loop(
						startingWith [],
						while (current) { <- current::length()::isLessThan(2) },
						(current) { <- current::append("x") },
					)

					Terminal.inspect(grown::sort())
				}`),
			).toEqual(['[ "x", "x" ]'])
		})

		it("refuses a callback body that misreads the decided State", () => {
			expect(
				codesFor(`implementation {
					constant grown = loop(
						startingWith [],
						while (current) { <- Number.sum(current)::isLessThan(2) },
						(current) { <- current::append("x") },
					)
				}`),
			).toEqual(["no-matching-overload"])
		})

		it("decides a user-written generic's Answer", async () => {
			expect(
				await run(`implementation {
					function collect<infer Answer>(
						_ seed: Answer,
						step: (_: Answer) -> Answer,
					) -> Answer {
						<- step(seed)
					}

					constant made = collect([], step (current) { <- current::append(3) })

					Terminal.inspect(made::sort())
				}`),
			).toEqual(["[ 3 ]"])
		})

		// Only the open Type Parameter is filled in.
		it("decides one Type Parameter where a second is already decided", async () => {
			expect(
				await run(`implementation {
					function zip<infer Answer, infer Other>(
						_ seed: Answer,
						with other: Other,
						step: (_: Answer, _: Other) -> Answer,
					) -> Answer {
						<- step(seed, other)
					}

					constant joined = zip([], with "x", step (current, text) {
						<- current::append(text)
					})

					Terminal.inspect(joined::sort())
				}`),
			).toEqual(['[ "x" ]'])
		})
	})

	// A name keeps the undecided Type its Declaration gave it, so no Node
	// carries the decision. Where its plain re-match binds the blank again, the
	// Validator re-matches seeded from the call's own Type.
	describe("a seed written as a name rather than as a Literal", () => {
		// The combiner says `List<Integer>` while the seed's Node still says
		// `List<Unknown>`, so only the call's own Type explains the match.
		it("hands the decided State to a loop seeded with a name", async () => {
			expect(
				await run(`implementation {
					constant seed = []
					constant grown = loop(from 1, through 2, startingWith seed, (index, kept) {
						<- kept::append(index)
					})

					Terminal.inspect(grown::sort())
				}`),
			).toEqual(["[ 1, 2 ]"])
		})

		// `T` binds to `List<Unknown>` off the name, and the later `["a"]` says
		// what the List holds.
		it("decides a Type Parameter a name bound to an undecided slot", async () => {
			expect(
				await run(`implementation {
					function pair <infer T>(_ a: T, _ b: T) -> T {
						<- b
					}

					constant empty = []
					constant both = pair(empty, ["a"])

					Terminal.inspect(both::sort())
				}`),
			).toEqual(['[ "a" ]'])
		})

		// An Argument carrying a blank binds no Type Parameter, so `["a"]`
		// decides `T` and only the wrong `"two"` is reported.
		it("reports only the Argument that is wrong beside a blank", () => {
			expect(
				codesFor(`implementation {
					function pair <infer T>(_ a: T, _ b: T, _ c: Integer) -> T {
						<- b
					}

					constant empty = []
					constant both = pair(empty, ["a"], "two")
				}`),
			).toEqual(["argument-type-mismatch"])
		})

		// With every Argument a blank, the first binds the Type Parameter to a
		// blank, which is honest for a call handed nothing that decides it.
		it("binds the first of several blanks and reads the rest against it", async () => {
			expect(
				await run(`implementation {
					function pair <infer T>(_ a: T, _ b: T, _ c: Integer) -> T {
						<- b
					}

					constant empty = []
					constant other = []
					constant both = pair(empty, other, 1)

					Terminal.inspect(both)
				}`),
			).toEqual(["[]"])
		})

		// An Argument that disagrees with a Parameter the decision never
		// touched is reported as in any call.
		it("still reports an Argument the decision does not explain", () => {
			expect(
				codesFor(`implementation {
					function take(_ items: List<String>, _ count: Integer) -> Integer {
						<- count
					}

					constant empty = []
					constant taken = take(empty, "two")
				}`),
			).toEqual(["argument-type-mismatch"])
		})
	})

	// The first match stops at the Argument that decides a blank. A later
	// Argument is read first by the second match, whose Diagnostics must be
	// reported. See "Seeds an Invocation decides" in
	// packages/compiler/src/enricher/DEVELOPMENT.md.
	describe("an Argument the first match never reached", () => {
		it("reports a member the Record does not have", () => {
			expect(
				codesFor(`implementation {
					function triple <infer T>(_ a: T, _ b: T, _ c: Boolean) -> T {
						<- b
					}

					constant record = { present = true }
					constant empty = []
					constant made = triple(empty, ["a"], record.missing)
				}`),
			).toEqual(["unknown-member"])
		})

		it("reports a Method no overload of which takes these Types", () => {
			expect(
				codesFor(`implementation {
					function triple <infer T>(_ a: T, _ b: T, _ c: Boolean) -> T {
						<- b
					}

					constant empty = []
					constant made = triple(empty, ["a"], Number.sum(["x"])::isLessThan(2))
				}`),
			).toEqual(["no-matching-overload"])
		})

		// An annotated Function literal is enriched once like any other
		// Argument, so its body is read only here.
		it("reports what a written callback's body gets wrong", () => {
			expect(
				codesFor(`implementation {
					function triple <infer T>(_ a: T, _ b: T, _ c: (_ n: Integer) -> Integer) -> T {
						<- b
					}

					constant empty = []
					constant made = triple(empty, ["a"], (_ n: Integer) -> Integer {
						<- Number.sum(["x"])
					})
				}`),
			).toEqual(["no-matching-overload"])
		})

		// With no blank there is no second match. With one, both matches read
		// the Argument, and it is still reported once.
		it("reports it once where the first match reached it too", () => {
			let withoutABlank = `implementation {
				function triple <infer T>(_ a: T, _ b: T, _ c: Boolean) -> T {
					<- b
				}

				constant record = { present = true }
				constant made = triple(["b"], ["a"], record.missing)
			}`
			let withABlank = `implementation {
				function triple <infer T>(_ a: T, _ b: Boolean, _ c: T) -> T {
					<- c
				}

				constant record = { present = true }
				constant empty = []
				constant made = triple(empty, record.missing, ["a"])
			}`

			expect(codesFor(withoutABlank)).toEqual(["unknown-member"])
			expect(codesFor(withABlank)).toEqual(["unknown-member"])
		})
	})
})
