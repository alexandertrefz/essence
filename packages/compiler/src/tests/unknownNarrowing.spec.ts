import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence/interfaces"

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
// top-level `__print` calls run, capturing `console.log` — the decided item
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

					__print(integers::sort())
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

		it("refuses the second of two Handlers that disagree", () => {
			expect(
				codesFor(`implementation {
					variable items = []
					constant value: Integer | Nothing = 1

					constant ignored = match value -> Nothing {
						case Integer {
							items = [1, 2]

							<- nothing
						}
						case Nothing {
							items = ["a"]

							<- nothing
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

					__print(items::sort())
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

					__print(read())
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

					__print(lengthOf()::toString())
				}`),
			).toEqual(['"2"'])
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

				__print(integers::length()::toString())
				__print(strings::length()::toString())
				__print(nested::length()::toString())
			}`),
		).toEqual(['"0"', '"0"', '"0"'])
	})
})
