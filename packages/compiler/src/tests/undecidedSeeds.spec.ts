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

// NOTE: End to end, because a decision made here is judged everywhere else: the
// Enricher decides what a call carries, the Validator measures the Declaration
// it is written into against it, and a body typed under the decision is what
// reports a misread accumulator.
function errorsFor(source: string): Array<common.Diagnostic> {
	let { program, diagnostics } = enrich(parse(source))

	return [...diagnostics, ...validate(program)].filter(
		(diagnostic) => diagnostic.severity === "error",
	)
}

function codesFor(source: string): Array<string> {
	return errorsFor(source).map((diagnostic) => diagnostic.code)
}

// NOTE: Writes the emitted Program to a throwaway module and imports it so its
// top-level `Terminal.inspect` calls run, capturing `console.log`. Every
// Program here sorts what it built: a sort is handed the witness the decided
// item Type picks, so what the Program PRINTS is where a slot decided wrongly
// shows up — and a slot left undecided does not compile the sort at all.
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

// NOTE: The Type a top-level Declaration came to, for the decisions that are
// about a Type rather than about what a Program answers.
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

// NOTE: The Type the seed's own Node carries, found by the one Argument of the
// Declaration's Invocation that is written as a List Literal.
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

// NOTE: An empty `[]` seed is typed `List<Unknown>`, and a Type Parameter bound
// to one carries a slot nobody decided. `Unknown` is bottom as an Argument and
// top as a Parameter, so every later occurrence of that Parameter was waved
// through against it: `words::reduce(startingWith [], (kept, word) { <-
// kept::append(word) })` answered `List<Unknown>`, and the `kept` its own
// combiner read was a `List<Unknown>` too — so a body reading Integers out of a
// List of Strings compiled clean and answered wrongly. The Arguments of one call
// are read together here, and what they say between them decides the slot.
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

		// NOTE: The laundering the undecided answer used to allow. Nothing was
		// reported at either end: the call answered a List that promised nothing
		// about its items, and a Type that promises nothing fits every
		// annotation.
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

		// NOTE: The other half of the same hole, and the half an annotation can
		// not close: the accumulator the combiner's BODY reads is the Type the
		// call decided, so the body is checked against the decision rather than
		// against the seed that started it.
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

		// NOTE: A combiner that answers the seed untouched decides nothing, and
		// nothing else here does either — so the fold really does answer an empty
		// List, and the Type that says so is the honest one. No Diagnostic of its
		// own: there is nothing wrong with a Program that builds nothing.
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

		// NOTE: The Node as well as the answer. Every stage after the Enricher
		// reads a call off its Nodes — the Validator re-matches the committed
		// signature against exactly these Types — so a seed still typed
		// `List<Unknown>` beside a combiner typed `(_: List<String>, _: String)
		// -> List<String>` would be a call nothing downstream could make sense
		// of.
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

	// NOTE: The combiner an author actually writes. A filter keeps the
	// accumulator in one branch and writes into it in the other, so the body
	// answers `NonEmptyList<Integer> | List<Unknown>` — one branch saying what it
	// holds and one saying nothing at all. Read as one Type that decides nothing,
	// and every one of these was refused for returning a decided List where the
	// Function returns `List<Unknown>`. Read branch by branch, the branch that
	// writes decides the slot and the branch that hands the seed back is silent,
	// which is what it is.
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

		// NOTE: Which branch writes is nothing to the rule — a slot takes what
		// the branches that fill it agree on, and the order they are written in
		// is not one of them.
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

		// NOTE: A `step` body answers a Choice rather than the accumulator, so
		// the branches are two instantiations of one Choice and the slot is a
		// Case's payload member. Same rule, one level in.
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

		// NOTE: Two Parameters, and the second decided only once the first is.
		// `#Done` hands back the accumulator, so what the loop ANSWERS is what
		// the accumulator came to — which the arm that appends says and the arm
		// that answers can only repeat.
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

		// NOTE: One accumulator per member, each written by its own branch —
		// so neither branch decides the Record and the two together decide
		// every member of it.
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

		// NOTE: A branch answering the seed itself decides nothing and refuses
		// nothing either — what the OTHER branch writes is still the answer.
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

		// NOTE: Branches that disagree decide nothing. There is no one Type the
		// accumulator holds, and taking the branch that happens to be written
		// first would be inventing one — so the slot stays open and every write
		// into it is refused, which is the same answer a fold nothing writes
		// into at all gets.
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

		// NOTE: A branch that decides the accumulator WHOLE is not made worse by
		// the branch beside it that decides one member of it.
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
		// NOTE: The Declaration's annotation is a decision somebody wrote down,
		// and it is read BEFORE anything is inferred from the call's own
		// Arguments — which is what decides a fold whose combiner says nothing,
		// and what makes the combiner below answer to the annotation rather than
		// the other way round.
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

		// NOTE: The annotation wins, and the combiner is then measured against
		// it: appending an Integer to a List of Strings is refused where the
		// undecided accumulator used to accept both and promise neither.
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
		// NOTE: Two slots, decided independently — the keys off what the update
		// writes and the values off what it stores.
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

		// NOTE: A Record seed, whose open slot is a member rather than the whole
		// accumulator — decided from the member the combiner answers, and decided
		// to the BASE of the `NonEmptyList` that answer carries, because the seed
		// wrote `[]` into that member and an empty List is not a proof of
		// anything.
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

		// NOTE: The decision a slot takes carries no proof, which is what keeps
		// the idiom that BUILT the Dictionary writable against it. Deciding the
		// values `NonEmptyList<String>` off the `[]::append(word)` one turn
		// answers refuses the `defaultingTo []` of the very next turn — a
		// Dictionary of non-empty Lists has no empty List to fall back to.
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

		// NOTE: And at every depth, because a proof one level in refuses the
		// next write just as surely: `rows::append(["a"]::append("b"))` decides
		// a List of Lists of Strings, never a List of NON-EMPTY ones, so the
		// empty List written after it still fits.
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

		// NOTE: The other direction, unchanged and worth saying beside them: a
		// slot the fold DECIDED still reads an empty List as bottom, so clearing
		// what was built is not a write that has to decide anything.
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

		// NOTE: A Type Parameter the RECEIVER bound, which is the order every
		// Method is matched in: `rows::append(["a"])` binds the item Type to
		// `List<Unknown>` off the receiver and then had nothing left to do with
		// the `List<String>` that followed but agree with it. The decision is
		// made once the whole call is in hand, so the order the match bound
		// things in does not decide what it could work out.
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

		// NOTE: The other end of that decision. What the call answers is what the
		// assignment pins the Variable to, so the write that decided the item
		// Type is also the write every later one is held to — an undecided slot
		// laundered a second write of another Type through the same name.
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
		// NOTE: Two callbacks, one decision. `loop` is an Overloaded Function
		// whose entries each carry their own `State`, and the seed is the
		// Argument every one of them binds it from — so the `while` condition and
		// the body are both resolved against the State the loop was decided to
		// carry.
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

		// NOTE: One Parameter open beside one the Arguments decided — the
		// callback's own Parameter Types are read from both, and only the open
		// one is filled in.
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

	// NOTE: A decision the call makes but writes onto no Node. The seed's own
	// brackets take the decided Type where the seed is WRITTEN as a Literal, and
	// a name standing in the same place keeps the undecided Type its Declaration
	// gave it — so everything downstream that re-derives the call from its Nodes
	// has to reach the decision another way. The Validator re-matches the
	// committed Signature, and where the plain re-match binds the Parameter to
	// the blank again it asks a second time, seeded from the Type the call itself
	// carries.
	describe("a seed written as a name rather than as a Literal", () => {
		// NOTE: Reported as an Internal Compiler Error before the Validator read
		// the call's own Type: the combiner it re-matched was recorded as
		// `(_: Integer, _: List<Integer>) -> List<Integer>` and the seed beside
		// it still said `List<Unknown>`, which is a call no re-match of those two
		// can make sense of.
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

		// NOTE: The whole accumulator bound to a Type Parameter rather than a slot
		// inside one, which is the case a later Argument decides: `T := List<Unknown>`
		// off the name, then `["a"]` says what the List holds.
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

		// NOTE: One mistake, one report. An Argument carrying a blank binds no
		// Type Parameter, so `["a"]` is what decides `T` and the blank is read
		// against it. Binding `T` to the blank instead made the very Argument
		// that decides it a write into one, and the call was refused twice: for
		// the `["a"]` that is right, and for the `"two"` that is wrong.
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

		// NOTE: Every Argument a blank. The deferred ones are matched in the
		// order they were written, so the first binds the Type Parameter and the
		// rest are read against it — to a blank, which is the honest answer for a
		// call that was handed nothing that says anything.
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

		// NOTE: The seeded re-match rescues nothing it cannot explain. An
		// Argument that disagrees with a Parameter the decision never touched is
		// reported exactly as it is in a call that writes no empty seed at all.
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

	// NOTE: The first match stops at its first mismatch, and where a blank seed
	// bound the Type Parameter that mismatch is the very Argument that decides it
	// — so an Argument written AFTER it is read for the first time by the second
	// match. An Argument is enriched once and its Node kept, so a Diagnostic the
	// second match held would be held for good, and each of these checked clean
	// and emitted the member, the Method call and the body that are not there.
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

		// NOTE: An ANNOTATED Function literal, which is enriched once like any
		// other Argument rather than re-resolved per position — so its body is
		// read here, and read nowhere else.
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

		// NOTE: And once only. With no blank to decide there is no second match
		// at all; with one, both matches read the same Argument and say the same
		// thing about it, which `report` counts as said.
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
