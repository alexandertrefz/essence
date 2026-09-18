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
