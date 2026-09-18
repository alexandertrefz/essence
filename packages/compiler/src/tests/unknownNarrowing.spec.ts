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

// NOTE: End-to-end, because narrowing is a decision the Enricher makes and the
// Validator judges: the Enricher replaces the Scope entry, and what that is
// worth only shows up in the annotation the Validator then refuses.
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
// top-level `Terminal.inspect` calls run, capturing `console.log` — the decided item
// Type is what picks the witness a Method is handed, so what the Program PRINTS
// is the only place a Type that was decided wrongly can be caught.
async function run(source: string): Promise<Array<string>> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(enriched.diagnostics).toEqual([])
	expect(validate(enriched.program)).toEqual([])

	let javascript = rewrite(optimise(simplify(enriched.program)))
	let directory = mkdtempSync(join(tmpdir(), "essence-narrowing-"))
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

// NOTE: An empty List Literal is typed `List<Unknown>`, and that Type fits
// EVERY List. A Variable declared from one therefore used to launder its items:
// `variable items = []` followed by `items = [1, 2]` kept the undecided Type, so
// `constant strings: List<String> = items` was accepted and every String Method
// then ran on Integers — a clean compile answering wrongly.
describe("Unknown Slot Narrowing", () => {
	describe("a Variable declared from an empty List Literal", () => {
		it("decides its item Type at the first assignment that says so", async () => {
			expect(
				await run(`implementation {
					variable items = []

					items = [1, 2]

					constant integers: List<Integer> = items

					Terminal.inspect(integers::sort())
				}`),
			).toEqual(["[ 1, 2 ]"])
		})

		it("refuses the annotation that would launder its items", () => {
			let errors = errorsFor(`implementation {
				variable items = []

				items = [1, 2]

				constant strings: List<String> = items
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("assignment-type-mismatch")
		})

		// NOTE: The decision is final. Widening to `List<Integer | String>`
		// would make the Variable hold something neither assignment wrote, and
		// there is a place to say that already — the declaration's annotation.
		it("refuses a later assignment that disagrees with the decision", () => {
			expect(
				codesFor(`implementation {
					variable items = []

					items = [1, 2]
					items = ["a"]
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		// NOTE: The Union matched on is `Integer | String` only because a Match
		// needs something to narrow at all — nothing here turns on WHICH Types
		// those are. What is pinned is that the decision the first Handler made
		// still binds the second one: the Handlers are separate bodies, and the
		// slot they share is the Variable's, not either body's. The Handlers
		// answer unit, the empty Record `{}`, because their value is not what
		// is under test.
		it("refuses the second of two Handlers that disagree", () => {
			expect(
				codesFor(`implementation {
					variable items = []
					constant value: Integer | String = 1

					constant ignored = match value -> {} {
						case Integer {
							items = [1, 2]

							<- {}
						}
						case String {
							items = ["a"]

							<- {}
						}
					}
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		// NOTE: An annotated declaration decided its item Type itself, so
		// there is no slot left for an assignment to fill and nothing changes.
		it("leaves an annotated declaration to its annotation", async () => {
			expect(
				await run(`implementation {
					variable items: List<Integer> = []

					items = [1, 2]

					Terminal.inspect(items::sort())
				}`),
			).toEqual(["[ 1, 2 ]"])
		})

		it("decides a slot buried in a Record member", () => {
			expect(
				codesFor(`implementation {
					variable box = { items = [] }

					box = { items = [1, 2] }

					constant strings: { items: List<String> } = box
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		it("decides the inner slot of a nested empty List too", () => {
			expect(
				codesFor(`implementation {
					variable rows = [[]]

					rows = [["a"]]

					constant integers: List<List<Integer>> = rows
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		// NOTE: `append` answers a `NonEmptyList<String>`, a refinement over the
		// List the Variable is being handed — and a write is a write however the
		// value that made it is spelled. The run is what proves it: `sort` needs
		// an Orderable of the item Type, and an undecided item Type has none, so
		// this Program did not compile at all before the write decided the slot.
		it("decides its item Type from a write that answers a Refinement", async () => {
			expect(
				await run(`implementation {
					variable items = []

					items = items::append("b")
					items = items::append("a")

					Terminal.inspect(items::sort())
				}`),
			).toEqual(['[ "a", "b" ]'])
		})

		it("refuses the annotation that write would have laundered", () => {
			expect(
				codesFor(`implementation {
					variable items = []

					items = items::append("a")

					constant integers: List<Integer> = items
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		// NOTE: The shape the hole was reported as, which no annotation is
		// written in at all: `Number.sum` takes a List of Numbers, an undecided
		// item Type fit that, and the Program compiled and then added Strings
		// up. Decided, there is simply no overload to call.
		it("keeps the decided items out of a Method that wanted Numbers", () => {
			expect(
				codesFor(`implementation {
					variable items = []

					items = items::append("a")

					Terminal.print(Number.sum(items))
				}`),
			).toEqual(["no-matching-overload"])
		})

		// NOTE: The second call is made ON the refinement the first answered —
		// `NonEmptyList` declares no `append` of its own, so it flows into its
		// base to be dispatched — and answers a refinement again. One write is
		// one decision however many calls built the value it wrote.
		it("decides it from a chain of calls answering a Refinement", async () => {
			expect(
				await run(`implementation {
					variable items = []

					items = items::append("b")::append("a")

					Terminal.inspect(items::sort())
				}`),
			).toEqual(['[ "a", "b" ]'])
		})

		// NOTE: Pinned to the refinement's BASE, never to the refinement. The
		// Variable's earlier value was the empty List the Declaration wrote, and
		// nothing proved that one holds anything — so `NonEmptyList<String>` is
		// a Type the name never had, and an empty List is still a value it takes.
		it("pins to the base of the Refinement rather than to the Refinement", async () => {
			expect(
				await run(`implementation {
					variable items = []

					items = items::append("a")
					items = []

					Terminal.inspect(items::length()::toString())
				}`),
			).toEqual(['"0"'])
		})
	})

	// NOTE: Two slots and nothing else new — `[=]` decides neither, and both are
	// decided by the first write that says what they hold, exactly as a List's
	// one item Type is.
	describe("a Variable declared from an empty Dictionary Literal", () => {
		it("decides both slots from a write that answers a Refinement", async () => {
			expect(
				await run(`implementation {
					variable ages = [=]

					ages = ages::set("kim", to 7)

					Terminal.inspect(ages::keys()::sort())
				}`),
			).toEqual(['[ "kim" ]'])
		})

		it("decides both slots from an update", async () => {
			expect(
				await run(`implementation {
					variable ages = [=]

					ages = [ages with "kim" = 7]

					Terminal.inspect(ages::keys()::sort())
				}`),
			).toEqual(['[ "kim" ]'])
		})

		it("refuses the annotation the write would have laundered", () => {
			expect(
				codesFor(`implementation {
					variable ages = [=]

					ages = ages::set("kim", to 7)

					constant strings: Dictionary<String, String> = ages
				}`),
			).toEqual(["assignment-type-mismatch"])
		})
	})

	// NOTE: An update WRITES the members it names, so it decides the ones the
	// original left undecided — the same rule as an assignment's, one level in.
	// Reading the base's blank back out of the update would let `{ box with
	// items = ["a"] }` stand for a Record whose `items` fits every List.
	describe("a Record member declared from an empty List Literal", () => {
		it("is decided by the update that writes it", () => {
			expect(
				codesFor(`implementation {
					constant box = { items = [] }
					constant filled = { box with items = ["a"] }

					constant integers: { items: List<Integer> } = filled
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		it("is decided by a path key that writes it", () => {
			expect(
				codesFor(`implementation {
					constant outer = { inner = { items = [] } }
					constant filled = { outer with inner.items = ["a"] }

					constant integers: { inner: { items: List<Integer> } } = filled
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		it("leaves a member the update does not name undecided", async () => {
			expect(
				await run(`implementation {
					constant box = { items = [], others = [] }
					constant filled = { box with items = ["a"] }

					constant integers: List<Integer> = filled.others

					Terminal.inspect(filled.items::sort())
					Terminal.inspect(integers::length()::toString())
				}`),
			).toEqual(['[ "a" ]', '"0"'])
		})

		// NOTE: Both halves at once — the update decides the member, and the
		// assignment it feeds decides the Variable from the Record the update
		// answered.
		it("is decided through an assignment that updates in place", async () => {
			expect(
				await run(`implementation {
					variable box = { items = [] }

					box = { box with items = box.items::append("x") }

					Terminal.inspect(box.items::sort())
				}`),
			).toEqual(['[ "x" ]'])
		})

		// NOTE: A member's two slots are decided the way its one item Type is —
		// `{ base with ages = ["alex" = 39] }` over a `base` whose `ages` came
		// from `[=]` leaked both of them.
		it("decides both slots of a Dictionary member", () => {
			expect(
				codesFor(`implementation {
					constant base = { ages = [=] }
					constant filled = { base with ages = ["alex" = 39] }

					constant strings: { ages: Dictionary<String, String> } = filled
				}`),
			).toEqual(["assignment-type-mismatch"])
		})

		// NOTE: And the same without an annotation to carry it — the decided
		// member is what the Method the update's answer is read with gets,
		// which is where an undecided one did its damage.
		it("hands the decided member to the Methods that read it", () => {
			expect(
				codesFor(`implementation {
					constant box = { items = [] }
					constant filled = { box with items = ["a"] }

					Terminal.inspect(filled.items::append(1))
				}`),
			).toEqual(["no-matching-overload"])
		})

		it("refuses an update that disagrees with a decided member", () => {
			expect(
				codesFor(`implementation {
					constant box = { items = ["a"] }
					constant filled = { box with items = [1] }
				}`),
			).toEqual(["partial-type-mismatch"])
		})

		// NOTE: An Error decides nothing, so there is no write here to refuse.
		// The slot stayed open BECAUSE the name is not declared, and reporting
		// the Partial on top of that would charge the author twice for one
		// mistake — which is what an Error means everywhere else in the match.
		it("says nothing of an update whose value is already an Error", () => {
			expect(
				codesFor(`implementation {
					constant box = { items = [] }
					constant filled = { box with items = box.items::append(undeclaredThing) }
				}`),
			).toEqual(["unknown-name"])
		})

		// NOTE: And still reports what the Error does not excuse: a member the
		// original does not have is a second mistake, not the same one.
		it("still refuses an update naming a member that is not there", () => {
			expect(
				codesFor(`implementation {
					constant box = { items = [] }
					constant filled = { box with missing = [undeclaredThing] }
				}`),
			).toEqual(["unknown-name", "partial-type-mismatch"])
		})
	})

	// NOTE: The one place a later assignment comes too late. A literal's body is
	// checked once, where it is written, so a captured `items` is checked as a
	// `List<Unknown>` — which fits `List<String>` — and no decision made further
	// down can go back and make that body's Types true.
	describe("a Function Literal capturing one", () => {
		it("refuses the capture", () => {
			let errors = errorsFor(`implementation {
				variable items = []

				constant launder = () -> List<String> {
					<- items
				}

				items = [1, 2]
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("uninferable-item-type")
		})

		// NOTE: The write below the capture answers a refinement, which decides
		// the slot — and still not in time. Nothing about WHICH write decides a
		// slot moves the line a capture is refused at: the body was checked
		// where it was written.
		it("refuses it above a write that answers a Refinement", () => {
			let errors = errorsFor(`implementation {
				variable items = []

				constant launder = () -> List<String> {
					<- items
				}

				items = items::append(1)
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("uninferable-item-type")
		})

		it("refuses it inside a callback Argument too", () => {
			expect(
				codesFor(`implementation {
					variable items = []

					constant mapped = [1, 2]::map((value) -> List<String> {
						<- items
					})

					items = [1, 2]
				}`),
			).toEqual(["uninferable-item-type"])
		})

		it("accepts it once the declaration is annotated", async () => {
			expect(
				await run(`implementation {
					variable items: List<Integer> = []

					constant read = () -> List<Integer> {
						<- items
					}

					items = [1, 2]

					Terminal.inspect(read())
				}`),
			).toEqual(["[ 1, 2 ]"])
		})

		// NOTE: A Parameter of the same name is not a capture — it is the
		// literal's own, declared below the boundary the check walks out from.
		it("says nothing about a Parameter that shadows one", () => {
			expect(
				codesFor(`implementation {
					variable items = []

					constant f = (_ items: List<String>) -> List<String> {
						<- items
					}

					items = [1, 2]
				}`),
			).toEqual([])
		})

		it("says nothing about a Variable declared inside it", async () => {
			expect(
				await run(`implementation {
					constant lengthOf = () -> Integer {
						variable inner = []

						inner = [1, 2]

						<- inner::length()
					}

					Terminal.inspect(lengthOf()::toString())
				}`),
			).toEqual(['"2"'])
		})
	})

	// NOTE: What a reader is told where the refusal still lands. `List<Unknown>`
	// on the EXPECTED side of a mismatch names no Type anybody can act on — it
	// is the blank the Declaration left — so the Diagnostic has to say that it
	// is a blank and where it is filled in. The annotation is spelled at the
	// depth the blank actually sits: an example that answers a different
	// Declaration is worse than none.
	describe("the refusal a reader is shown", () => {
		function undecidedHelp(source: string): string {
			let errors = errorsFor(source)

			expect(errors).toHaveLength(1)

			return errors[0].helps.join("\n")
		}

		function undecidedNote(source: string): string {
			let errors = errorsFor(source)

			expect(errors).toHaveLength(1)

			return errors[0].notes.join("\n")
		}

		it("spells the annotation that would decide a List", () => {
			let source = `implementation {
				variable items = []

				items = "a"
			}`

			expect(undecidedHelp(source)).toContain(
				"'variable items: List<Integer>'",
			)
			expect(undecidedNote(source)).toContain(
				"An empty List Literal leaves its item Type unknown",
			)
		})

		it("spells it at the depth the undecided slot sits", () => {
			expect(
				undecidedHelp(`implementation {
					variable rows = [[]]

					rows = ["a"]
				}`),
			).toContain("'variable rows: List<List<Integer>>'")
		})

		it("spells both slots of a Dictionary, and says both are blank", () => {
			let source = `implementation {
				variable ages = [=]

				ages = ["a"]
			}`

			expect(undecidedHelp(source)).toContain(
				"'variable ages: Dictionary<String, Integer>'",
			)
			expect(undecidedNote(source)).toContain(
				"leaves its key and value Types unknown",
			)
		})

		it("spells the Record whose member is the blank", () => {
			expect(
				undecidedHelp(`implementation {
					variable box = { items = [] }

					box = { items = "a" }
				}`),
			).toContain("'variable box: { items: List<Integer> }'")
		})

		// NOTE: The update names the value it updates by Expression rather than
		// by name, so there is no annotation to write out — the shape is.
		it("spells the shape where an update refuses a member", () => {
			let errors = errorsFor(`implementation {
				constant box = { items = [] }
				constant updated = { box with items = 1 }
			}`)

			expect(errors[0].code).toBe("partial-type-mismatch")
			expect(errors[0].helps.join("\n")).toContain(
				"'{ items: List<Integer> }'",
			)
			expect(errors[0].notes.join("\n")).toContain(
				"An empty List Literal leaves its item Type unknown",
			)
		})

		// NOTE: Said only about a blank. A slot an assignment DECIDED is a Type
		// like any other, and a later assignment that disagrees with it is
		// refused for what it holds — there is nothing undecided to explain.
		it("says nothing about a slot an earlier write decided", () => {
			let errors = errorsFor(`implementation {
				variable items = []

				items = ["a"]
				items = [1]
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].helps).toEqual([])
			expect(errors[0].notes.some((note) => note.includes("blank"))).toBe(
				false,
			)
		})
	})

	// NOTE: An undecided item Type is a slot nothing has filled, not a promise
	// to hold nothing — an empty List Literal still fits every annotated List,
	// which is the whole reason it is written without one.
	it("keeps an empty List Literal assignable to any List", async () => {
		expect(
			await run(`implementation {
				constant integers: List<Integer> = []
				constant strings: List<String> = []
				constant nested: List<List<Integer>> = []

				Terminal.inspect(integers::length()::toString())
				Terminal.inspect(strings::length()::toString())
				Terminal.inspect(nested::length()::toString())
			}`),
		).toEqual(['"0"', '"0"', '"0"'])
	})
})
