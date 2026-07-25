import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence/interfaces"

import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parse } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: What a resolved Invocation DOES — which Namespace's Method the emitted
// Program calls, with which Arguments, and which dispatch branch it takes.
// Every fault pinned here type-checked cleanly and only showed up in what the
// Program printed: a Function literal compiled against a Namespace that lost
// resolution, and a dispatch branch that could never be reached because a
// member Type that swallows it was tried first. Asserting on Types would have
// seen none of it, so these run.

// NOTE: Emits the Program, writes it to a throwaway module and imports it so
// its top-level `__print` calls run — the same harness `codeGeneration.spec.ts`
// and `resolvers.spec.ts` use.
async function run(source: string): Promise<Array<string>> {
	let enriched = enrich(parse(source))

	expect(enriched.diagnostics).toEqual([])
	expect(validate(enriched.program)).toEqual([])

	let javascript = rewrite(optimise(simplify(enriched.program)))
	let directory = mkdtempSync(join(tmpdir(), "essence-dispatch-"))
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

describe("Dispatch and Resolution", () => {
	describe("Contextual Function literal Arguments", () => {
		// NOTE: `IntApplier` wins — its target is strictly more specific than
		// `Number` — but every Namespace is probed before that is decided, and
		// each probe resolves the unannotated literal against its own
		// Parameter Type. With the last probe's resolution left standing, the
		// literal's body was compiled as if `item` were a Boolean: the emitted
		// Program called the Boolean `toString` on an Integer receiver and
		// printed "true".
		it("compiles the literal against the Namespace that won", async () => {
			expect(
				await run(`implementation {
					namespace IntApplier for Integer {
						apply(_ transform: (_ item: Integer) -> String) -> String {
							<- transform(@)
						}
					}

					namespace NumApplier for Number {
						apply(_ transform: (_ item: Boolean) -> String) -> String {
							<- transform(true)
						}
					}

					__print(1::apply((item) { <- item::toString() }))
				}`),
			).toEqual(['"1"'])
		})

		// NOTE: The same call with the Namespaces written the other way round.
		// The winner does not depend on declaration order, so neither may the
		// literal's Parameter Types.
		it("compiles the literal the same way whichever Namespace is probed last", async () => {
			expect(
				await run(`implementation {
					namespace NumApplier for Number {
						apply(_ transform: (_ item: Boolean) -> String) -> String {
							<- transform(true)
						}
					}

					namespace IntApplier for Integer {
						apply(_ transform: (_ item: Integer) -> String) -> String {
							<- transform(@)
						}
					}

					__print(1::apply((item) { <- item::toString() }))
				}`),
			).toEqual(['"1"'])
		})
	})

	describe("Union dispatch order", () => {
		// NOTE: `isValueOfType` matches a Record openly — a value "may carry
		// more besides" — and `dispatchMethod` takes the first branch that
		// matches, so the branch for `{ width }` answers for a
		// `{ width, height }` value unless the more specific branch is tried
		// first. Ordering by a `sort` with a partial order never compared the
		// two Records, because the incomparable `Boolean` sat between them.
		let program = (alias: string) => `implementation {
			type Mixed<Extra> = ${alias}

			namespace Square for { width: Integer } {
				describe() -> String {
					<- "square"
				}
			}

			namespace Flag for Boolean {
				describe() -> String {
					<- "flag"
				}
			}

			namespace Rect for { width: Integer, height: Integer } {
				describe() -> String {
					<- "rect"
				}
			}

			variable shape: Mixed<{ width: Integer, height: Integer }> = { width = 1, height = 2 }

			__print(shape::describe())
		}`

		it("reaches the more specific Record's branch", async () => {
			expect(
				await run(program("{ width: Integer } | Boolean | Extra")),
			).toEqual(['"rect"'])
		})

		it("reaches it however the Union is spelled", async () => {
			expect(
				await run(program("{ width: Integer } | Extra | Boolean")),
			).toEqual(['"rect"'])
		})

		it("keeps taking the branch for the Type the value actually has", async () => {
			expect(
				await run(`implementation {
					type Mixed<Extra> = { width: Integer } | Boolean | Extra

					namespace Square for { width: Integer } {
						describe() -> String {
							<- "square"
						}
					}

					namespace Flag for Boolean {
						describe() -> String {
							<- "flag"
						}
					}

					namespace Rect for { width: Integer, height: Integer } {
						describe() -> String {
							<- "rect"
						}
					}

					variable shape: Mixed<{ width: Integer, height: Integer }> = { width = 1 }

					__print(shape::describe())

					shape = true

					__print(shape::describe())
				}`),
			).toEqual(['"square"', '"flag"'])
		})
	})

	describe("Static Method bodies", () => {
		// NOTE: A static Method is emitted without the `_self` Parameter `@`
		// lowers to, so `@` in one used to compile to an unbound name and the
		// Program died on its first call. The Enricher refuses it now; this is
		// the Simplifier's own guard, reached by retagging an enriched
		// instance Method as static — which is what a regression in the
		// Enricher would look like from here.
		it("refuses to lower '@' inside a static Method", () => {
			let { program, diagnostics } = enrich(
				parse(`implementation {
					namespace Maker for Integer {
						doubled() -> Integer {
							<- @::multiply(with 2)
						}
					}
				}`),
			)

			expect(diagnostics).toEqual([])

			let namespaceNode = program.implementation.nodes.find(
				(node) => node.nodeType === "NamespaceDefinitionStatement",
			)

			if (namespaceNode?.nodeType !== "NamespaceDefinitionStatement") {
				throw new Error("No Namespace was enriched.")
			}

			let method: common.typed.Methods[string] =
				namespaceNode.methods["doubled"]

			expect(method.nodeType).toBe("SimpleMethod")
			;(method as unknown as { nodeType: string }).nodeType =
				"StaticMethod"

			expect(() => simplify(program)).toThrow(
				"'@' reached the Simplifier inside a static Method",
			)
		})

		// NOTE: A Match Handler is emitted as a Function of its own taking the
		// value that matched, so its `@` is bound wherever the Match is
		// written — the guard above must not mistake it for the receiver.
		it("keeps a Match Handler's '@' inside a static Method", async () => {
			expect(
				await run(`implementation {
					namespace Maker for Integer {
						static describe(_ value: Integer | Boolean) -> String {
							<- match value -> String {
								case Integer { <- @::toString() }
								case Boolean { <- "boolean" }
							}
						}
					}

					__print(Maker.describe(5))
					__print(Maker.describe(true))
				}`),
			).toEqual(['"5"', '"boolean"'])
		})
	})
})
