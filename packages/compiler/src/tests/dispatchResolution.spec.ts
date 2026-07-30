import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"

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
//
// NOTE: `expectedWarnings` names the Diagnostics a Program is SUPPOSED to carry.
// A Union of two List member Types overlaps for the empty List — the Validator
// warns that the second branch never sees one — and a Program below is about
// which branch's compiled Argument runs rather than about that Warning. Every
// other Program here compiles silent, which is what the empty default asserts.
async function run(
	source: string,
	expectedWarnings: Array<common.DiagnosticCode> = [],
): Promise<Array<string>> {
	let enriched = enrich(parse(source))

	expect(enriched.diagnostics).toEqual([])
	expect(
		validate(enriched.program).map((diagnostic) => diagnostic.code),
	).toEqual(expectedWarnings)

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

	// NOTE: Regression tests — a dispatched Invocation passes the SAME Arguments
	// to every branch, and a Function literal that omitted its annotations was
	// compiled once, against whichever member Type resolved last. Every other
	// branch was then handed a body compiled for somebody else: the callback of
	// a `List<{ a: Integer }> | List<{ b: Integer }>` map called Beta's `label`
	// on Alpha's Records, and the Program printed "BETA" for a value that was
	// nothing of the sort — no Diagnostic anywhere. Each branch carries its own
	// compiled copy now, and these pin what each one does.
	describe("Contextual Function literal Arguments in a dispatch", () => {
		let labels = `namespace Alpha for { a: Integer } {
				label() -> String {
					<- "ALPHA"
				}
			}

			namespace Beta for { b: Integer } {
				label() -> String {
					<- "BETA"
				}
			}`

		it("compiles the literal against the branch that is given it", async () => {
			expect(
				await run(
					`implementation {
						${labels}

						variable values: List<{ a: Integer }> | List<{ b: Integer }> = [{ a = 1 }]

						__print(values::map((item) { <- item::label() }))
					}`,
					["empty-list-overlap"],
				),
			).toEqual(['[ "ALPHA" ]'])
		})

		// NOTE: The member the value actually has decides, so how the Union is
		// written may not — least of all which member happens to be written
		// last, which is precisely what used to decide it.
		it("compiles it the same way however the Union is spelled", async () => {
			expect(
				await run(
					`implementation {
						${labels}

						variable values: List<{ b: Integer }> | List<{ a: Integer }> = [{ a = 1 }]

						__print(values::map((item) { <- item::label() }))
					}`,
					["empty-list-overlap"],
				),
			).toEqual(['[ "ALPHA" ]'])
		})

		// NOTE: The same fault with the Namespaces the Standard Library
		// provides, which is where it is likeliest to be met: `String.toString`
		// answers with its receiver unchanged, so the Integer List compiled
		// against the String branch printed `[ 1, 2 ]` — Integers in a
		// `List<String>` — while the String List looked perfectly fine.
		it("reaches each branch's own Method", async () => {
			expect(
				await run(
					`implementation {
						variable numbers: List<Integer> | List<String> = [1, 2]
						variable words: List<Integer> | List<String> = ["a", "b"]

						__print(numbers::map((item) { <- item::toString() }))
						__print(words::map((item) { <- item::toString() }))
					}`,
					["empty-list-overlap", "empty-list-overlap"],
				),
			).toEqual(['[ "1", "2" ]', '[ "a", "b" ]'])
		})

		// NOTE: A Standard Library Method reached ONLY from a branch's own copy
		// still has to be emitted with the Program. The search that decides
		// which of them a Program carries recurses into whatever it is given,
		// and a copy is an ordinary Expression hanging off the dispatch — but a
		// Method it missed would be NAMED by an emitted body and never declared,
		// which is a `ReferenceError` out of a Program that compiled green. Here
		// the shared literal is compiled against the Integer branch, whose
		// `toString` is native, so the String branch's copy is the only thing
		// asking for `String.toString`.
		it("emits a Method only a branch's own copy reaches", async () => {
			expect(
				await run(
					`implementation {
						variable words: List<String> | List<Integer> = ["a", "b"]

						__print(words::map((item) { <- item::toString() }))
					}`,
					["empty-list-overlap"],
				),
			).toEqual(['[ "a", "b" ]'])
		})

		it("copies every literal the branch is passed", async () => {
			expect(
				await run(`implementation {
					namespace Alpha for { a: Integer } {
						label() -> String {
							<- "ALPHA"
						}

						pair(
							_ first: (_ item: { a: Integer }) -> String,
							second: (_ item: { a: Integer }) -> String,
						) -> String {
							<- first(@)::append(second(@))
						}
					}

					namespace Beta for { b: Integer } {
						label() -> String {
							<- "BETA"
						}

						pair(
							_ first: (_ item: { b: Integer }) -> String,
							second: (_ item: { b: Integer }) -> String,
						) -> String {
							<- first(@)::append(second(@))
						}
					}

					variable value: { a: Integer } | { b: Integer } = { a = 1 }

					__print(value::pair((item) { <- item::label() }, second (item) { <- item::label()::append("!") }))
				}`),
			).toEqual(['"ALPHAALPHA!"'])
		})

		// NOTE: The copies are per branch, the rest of the Arguments are not:
		// they are evaluated once, at the call site, before any branch is
		// picked. An Argument that prints would print once per branch if the
		// Arguments were emitted per branch instead — which is the obvious way
		// to hand each branch its own and the reason this is pinned.
		it("evaluates a shared Argument exactly once", async () => {
			expect(
				await run(`implementation {
					namespace Alpha for { a: Integer } {
						label() -> String {
							<- "ALPHA"
						}

						combine(
							_ transform: (_ item: { a: Integer }) -> String,
							with extra: String,
						) -> String {
							<- transform(@)::append(extra)
						}
					}

					namespace Beta for { b: Integer } {
						label() -> String {
							<- "BETA"
						}

						combine(
							_ transform: (_ item: { b: Integer }) -> String,
							with extra: String,
						) -> String {
							<- transform(@)::append(extra)
						}
					}

					function noisy() -> String {
						__print("evaluated")

						<- "!"
					}

					variable value: { a: Integer } | { b: Integer } = { a = 1 }

					__print(value::combine((item) { <- item::label() }, with noisy()))
				}`),
			).toEqual(['"evaluated"', '"ALPHA!"'])
		})

		// NOTE: Every member of a Union must provide what is asked of it, and a
		// literal's body is part of what is asked. Compiling it against one
		// branch hid what it meant to the others: this Program used to compile
		// without a Diagnostic and die reading `.b` off a Record that has an
		// `a`.
		it("reports a body a branch's Method can not compile", () => {
			let { diagnostics } = enrich(
				parse(`implementation {
					namespace Alpha for { a: Integer } {
						apply(_ transform: (_ item: { a: Integer }) -> String) -> String {
							<- transform(@)
						}
					}

					namespace Beta for { b: Integer } {
						apply(_ transform: (_ item: { b: Integer }) -> String) -> String {
							<- transform(@)
						}
					}

					variable value: { a: Integer } | { b: Integer } = { a = 1 }

					__print(value::apply((item) { <- item.b::toString() }))
				}`),
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("unknown-member")
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

	// NOTE: An Overload set is first fit, and a refinement is freely assignable to
	// its base — so an entry taking the base Type accepts every Argument a refined
	// entry would have taken, and the refined entry only ever wins by being read
	// first. Writing it first is not how it gets there: an Overload's slot is
	// emitted into its name and, in the Standard Library, its native binding is
	// keyed by position, so the refined entries are appended. The candidates are
	// probed refinement-first instead, and what that does is visible only in which
	// body the Program ends up running — which is what these assert.
	describe("Overload probe order", () => {
		let ratios = `type NonZero = Integer where @::isNot(0)

			namespace Ratios for Integer {
				overload describe {
					§ The base entry, written first, and the one that takes any
					§ Integer at all.
					(by other: Integer) -> String {
						<- "checked"
					}

					§ The entry asking for evidence, appended after it the way the
					§ Standard Library has to append its own.
					(by other: NonZero) -> String {
						<- "total"
					}
				}
			}`

		it("reaches the entry written last for a value written down", async () => {
			expect(
				await run(`implementation {
					${ratios}

					__print(6::describe(by 3))
				}`),
			).toEqual(['"total"'])
		})

		it("reaches it for a value a branch proved", async () => {
			expect(
				await run(`implementation {
					${ratios}

					function describeChecked(_ n: Integer) -> String {
						if n::isNot(0) {
							<- 6::describe(by n)
						}

						<- "zero"
					}

					__print(describeChecked(3))
					__print(describeChecked(0))
				}`),
			).toEqual(['"total"', '"zero"'])
		})

		// NOTE: The other half of the rule, and the reason the sort is a sort
		// rather than a preference: a value carrying no evidence must still find
		// the base entry. It compiles green, so this is not only about which body
		// runs — a refined entry that swallowed the call would report the Argument
		// it can not take and the Program would not run at all.
		it("falls through to the base entry for a value nothing proved", async () => {
			expect(
				await run(`implementation {
					${ratios}

					function describeAny(_ n: Integer) -> String {
						<- 6::describe(by n)
					}

					__print(describeAny(3))
					__print(describeAny(0))
				}`),
			).toEqual(['"checked"', '"checked"'])
		})

		// NOTE: Probed first is not selected: a candidate whose bound the Arguments
		// can not satisfy is no candidate at all, refinement or not. The refined
		// entry below takes the Arguments — `3` is admitted, `Value` binds the
		// Boolean — and is passed over for the bound it fails, which is also what
		// keeps the bound's Diagnostic from being reported about a call that
		// resolved.
		it("passes over an entry asking for evidence whose bound fails", async () => {
			expect(
				await run(`implementation {
					type NonZero = Integer where @::isNot(0)

					protocol Showable {
						show() -> String
					}

					type Vector = { x: Integer, y: Integer }

					namespace VectorShowable for Vector is Showable {
						show() -> String {
							<- "vector"
						}
					}

					namespace Picker for {} {
						overload static pick {
							(_ value: Boolean, with extra: Integer) -> String {
								<- "base"
							}

							<infer Value is Showable>(_ value: Value, with extra: NonZero) -> String {
								<- value::show()
							}
						}
					}

					constant vector: Vector = { x = 1, y = 2 }

					__print(Picker.pick(true, with 3))
					__print(Picker.pick(vector, with 3))
				}`),
			).toEqual(['"base"', '"vector"'])
		})

		// NOTE: And the assertion that this costs a Program declaring no refinement
		// nothing. A wide entry written ahead of a narrow one is the same situation
		// with no evidence asked for anywhere, and it is probed in the order it was
		// written: the entry written first wins a call both of them accept. Every
		// Program that compiled before selects exactly what it selected before.
		it("keeps declaration order where no entry asks for evidence", async () => {
			expect(
				await run(`implementation {
					namespace Ratios for Integer {
						overload describe {
							(by other: Number) -> String {
								<- "wide"
							}

							(by other: Integer) -> String {
								<- "narrow"
							}
						}
					}

					__print(6::describe(by 3))
				}`),
			).toEqual(['"wide"'])
		})

		// NOTE: The whole rule again over a GENERIC refinement, which the sort sees
		// for exactly the reason it sees any other: what it asks is whether a
		// Parameter Type mentions a refinement anywhere, and an applied
		// `NonEmptyList<String>` is one. A written List reaches the entry asking for
		// evidence, a narrowed one does too, and a List nothing proved anything about
		// still finds the base entry.
		let lists = `type NonEmptyList<Item> = List<Item> where @::hasItems()

			namespace Firsts for {} {
				overload static describe {
					§ The base entry, written first, and the one that takes any List
					§ of Strings at all.
					(_ items: List<String>) -> String {
						<- "checked"
					}

					§ The entry asking for evidence, appended after it.
					(_ items: NonEmptyList<String>) -> String {
						<- "total"
					}
				}
			}`

		it("reaches the generic refined entry for a List written down", async () => {
			expect(
				await run(`implementation {
					${lists}

					__print(Firsts.describe(["a"]))
				}`),
			).toEqual(['"total"'])
		})

		it("reaches it for a List a branch proved, and falls through for one it did not", async () => {
			expect(
				await run(`implementation {
					${lists}

					function describeChecked(_ items: List<String>) -> String {
						if items::hasItems() {
							<- Firsts.describe(items)
						}

						<- "empty"
					}

					function describeAny(_ items: List<String>) -> String {
						<- Firsts.describe(items)
					}

					__print(describeChecked(["a"]))
					__print(describeChecked([]))
					__print(describeAny(["a"]))
				}`),
			).toEqual(['"total"', '"empty"', '"checked"'])
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
