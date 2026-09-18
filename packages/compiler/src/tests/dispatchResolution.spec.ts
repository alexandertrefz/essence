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
// its top-level `Terminal.inspect` calls run — the same harness `codeGeneration.spec.ts`
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

// NOTE: The counterpart for the Programs that are supposed to be refused —
// which is where the probe ORDER is visible as something a reader sees, rather
// than as which body ran.
function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrich(parse(source)).diagnostics
}

// NOTE: The characters a Diagnostic's Label covers, which is the only way to
// say "it points at what the Program wrote" without counting columns by hand.
// Single line spans only; every Label asked this covers one call or one name.
function underlinedText(source: string, label: common.DiagnosticLabel): string {
	let position = label.position

	return source
		.split("\n")
		[position.start.line - 1].slice(
			position.start.column - 1,
			position.end.column - 1,
		)
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

					Terminal.inspect(1::apply((item) { <- item::toString() }))
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

					Terminal.inspect(1::apply((item) { <- item::toString() }))
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

						Terminal.inspect(values::map((item) { <- item::label() }))
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

						Terminal.inspect(values::map((item) { <- item::label() }))
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

						Terminal.inspect(numbers::map((item) { <- item::toString() }))
						Terminal.inspect(words::map((item) { <- item::toString() }))
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

						Terminal.inspect(words::map((item) { <- item::toString() }))
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

					Terminal.inspect(value::pair((item) { <- item::label() }, second (item) { <- item::label()::append("!") }))
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
						Terminal.inspect("evaluated")

						<- "!"
					}

					variable value: { a: Integer } | { b: Integer } = { a = 1 }

					Terminal.inspect(value::combine((item) { <- item::label() }, with noisy()))
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

					Terminal.inspect(value::apply((item) { <- item.b::toString() }))
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

			Terminal.inspect(shape::describe())
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

					Terminal.inspect(shape::describe())

					shape = true

					Terminal.inspect(shape::describe())
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

					Terminal.inspect(6::describe(by 3))
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

					Terminal.inspect(describeChecked(3))
					Terminal.inspect(describeChecked(0))
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

					Terminal.inspect(describeAny(3))
					Terminal.inspect(describeAny(0))
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

					Terminal.inspect(Picker.pick(true, with 3))
					Terminal.inspect(Picker.pick(vector, with 3))
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

					Terminal.inspect(6::describe(by 3))
				}`),
			).toEqual(['"wide"'])
		})

		// NOTE: The whole rule again over a GENERIC refinement, which the sort sees
		// for exactly the reason it sees any other: what it asks is whether a
		// Parameter Type mentions a refinement anywhere, and an applied
		// `Filled<String>` is one. A written List reaches the entry asking for
		// evidence, a narrowed one does too, and a List nothing proved anything about
		// still finds the base entry.
		let lists = `type Filled<Item> = List<Item> where @::hasItems()

			namespace Firsts for {} {
				overload static describe {
					§ The base entry, written first, and the one that takes any List
					§ of Strings at all.
					(_ items: List<String>) -> String {
						<- "checked"
					}

					§ The entry asking for evidence, appended after it.
					(_ items: Filled<String>) -> String {
						<- "total"
					}
				}
			}`

		it("reaches the generic refined entry for a List written down", async () => {
			expect(
				await run(`implementation {
					${lists}

					Terminal.inspect(Firsts.describe(["a"]))
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

					Terminal.inspect(describeChecked(["a"]))
					Terminal.inspect(describeChecked([]))
					Terminal.inspect(describeAny(["a"]))
				}`),
			).toEqual(['"total"', '"empty"', '"checked"'])
		})

		// NOTE: What the sort costs a call that FAILS, which is where an order is
		// visible as something a reader is told rather than as which body ran. A
		// probe reports about the Arguments it was given, and a losing one's report
		// is held — but only from the first candidate whose Arguments matched
		// onwards, because an Argument is enriched exactly once and a report held
		// before that would be held forever. So the sort decides which entry the
		// call is reported ABOUT, and these say which, in both directions.
		describe("the report a call every entry refuses gets", () => {
			// NOTE: Both entries take the Arguments — `3` is admitted into
			// `NonZero`, and `true` binds each entry's Type Parameter — and both
			// fail the bound that Parameter carries. Named differently on purpose:
			// which Protocol the Diagnostic names is which entry the call was
			// reported about, and nothing else in the two entries differs.
			let bounds = (refined: string) => `protocol Showable {
					§§ Shows it.
					§§
					§§ @returns — the text
					show() -> String
				}

				protocol Renderable {
					§§ Renders it.
					§§
					§§ @returns — the text
					render() -> String
				}

				namespace Ratios for Integer {
					overload describe {
						§§ The base entry, written first.
						§§
						§§ @param by — any Integer
						§§ @param with — a Showable
						§§ @returns — the text
						<infer Value is Showable>(by other: Integer, with extra: Value) -> String {
							<- extra::show()
						}

						§§ The entry appended after it.
						§§
						§§ @param by — ${refined}
						§§ @param with — a Renderable
						§§ @returns — the text
						<infer Value is Renderable>(by other: ${refined}, with extra: Value) -> String {
							<- extra::render()
						}
					}
				}`

			// NOTE: The entry asking for evidence is probed first, so it is the
			// first whose Arguments match, so it is the one the call is reported
			// about — its bound is the one named. The report is about the Argument
			// the Program wrote either way: both entries would refuse `true` for the
			// same reason, and what the sort decides is which of the two bounds it
			// is refused by.
			it("names the entry asking for evidence, which matched first", () => {
				let source = `implementation {
					type NonZero = Integer where @::isNot(0)

					${bounds("NonZero")}

					Terminal.inspect(6::describe(by 3, with true))
				}`

				let diagnostics = diagnosticsFor(source)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["unsatisfied-bound"])
				expect(diagnostics[0]!.message).toBe(
					"Boolean does not conform to 'Renderable'",
				)
				expect(underlinedText(source, diagnostics[0]!.labels[0]!)).toBe(
					"6::describe(by 3, with true)",
				)
			})

			// NOTE: And the same two entries with the refinement taken out, which is
			// the assertion that this costs a Program declaring none: with nothing
			// asking for evidence the entries are probed as written, the entry
			// written FIRST is the first to match, and its bound is named. Every
			// Program that was reported on before is reported on the same way.
			it("names the entry written first where none asks for evidence", () => {
				let source = `implementation {
					${bounds("Integer")}

					Terminal.inspect(6::describe(by 3, with true))
				}`

				let diagnostics = diagnosticsFor(source)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["unsatisfied-bound"])
				expect(diagnostics[0]!.message).toBe(
					"Boolean does not conform to 'Showable'",
				)
			})

			// NOTE: The other half of a probe's report — not what solving the
			// candidate's bounds said, but what TYPING an Argument against its
			// Parameter Types did. An unannotated Function literal is resolved
			// against each candidate's Parameter Types in turn, and where NO
			// candidate's Arguments match, every probe is an unheld one: the
			// literal's body is left compiled under the LAST entry probed, and its
			// report is that entry's reading of it.
			//
			// Which is the sort earning its keep. The entries asking for evidence go
			// first, so the entry probed LAST is the one a value carrying no
			// evidence falls through to — the base entry — and the reading a reader
			// is shown is the base entry's, not the refined entry's. Here the base
			// entry hands the literal an Integer and the refined one a String, and
			// `isEven` is a Method only the Integer answers.
			let appliers = (
				refined: string,
			) => `namespace Appliers for Integer {
					overload apply {
						§§ The base entry, written first.
						§§
						§§ @param _ — over Integers
						§§ @param with — any Integer
						§§ @returns — the text
						(_ transform: (_ item: Integer) -> String, with n: Integer) -> String {
							<- transform(@)
						}

						§§ The entry appended after it.
						§§
						§§ @param _ — over Strings
						§§ @param with — ${refined}
						§§ @returns — the text
						(_ transform: (_ item: String) -> String, with n: ${refined}) -> String {
							<- transform("x")
						}
					}
				}`

			it("leaves the literal compiled under the entry a bare value falls through to", () => {
				let source = `implementation {
					type NonZero = Integer where @::isNot(0)

					${appliers("NonZero")}

					Terminal.inspect(1::apply((item) { <- item::isEven()::toString() }, with true))
				}`

				// NOTE: One Diagnostic, and it is about the call rather than about
				// the literal: the base entry was probed last, it reads `item` as an
				// Integer, and `isEven` is a Method an Integer answers. The refined
				// entry's reading — where `item` is a String and `isEven` is nothing
				// at all — was overwritten by it and is nowhere in the report.
				expect(
					diagnosticsFor(source).map((diagnostic) => diagnostic.code),
				).toEqual(["no-matching-overload"])

				// NOTE: And the entries are still LISTED as they were written. What
				// the sort decides is the order they are tried in, never the order a
				// Program's own declarations are read back to it in.
				expect(diagnosticsFor(source)[0]!.notes).toEqual([
					"'Appliers::apply' takes 2 Arguments: Parameter 1 is (_: Integer) -> String, Parameter 'with' is Integer.",
					"'Appliers::apply' takes 2 Arguments: Parameter 1 is (_: String) -> String, Parameter 'with' is NonZero.",
				])
			})

			// NOTE: The same call with nothing asking for evidence, which is what
			// says the paragraph above is the sort's doing: probed as written, the
			// entry left compiled into the literal is the one written LAST, so the
			// body is read as a String's and the Method it calls is reported missing
			// — pointing inside the literal, at the name the Program wrote there.
			it("leaves it under the entry written last where none asks for evidence", () => {
				let source = `implementation {
					${appliers("String")}

					Terminal.inspect(1::apply((item) { <- item::isEven()::toString() }, with true))
				}`

				let diagnostics = diagnosticsFor(source)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["no-matching-overload", "unknown-method"])
				expect(diagnostics[1]!.message).toBe(
					"No Method named 'isEven' for this value",
				)
				expect(underlinedText(source, diagnostics[1]!.labels[0]!)).toBe(
					"isEven",
				)
			})
		})
	})

	// NOTE: An `overload` block resolves by the Arguments a call WRITES, so a
	// default — which lets an entry be called with fewer — is the one thing that
	// can make two entries answer the same call. Refused where it is written.
	describe("Overloads a default makes identical", () => {
		it("should refuse an entry a default reduces to another entry's shape", () => {
			let source = `implementation {
				namespace Texts for String {
					overload trim {
						() -> String {
							<- @
						}

						(at side: Integer = 1) -> String {
							<- @
						}
					}
				}
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("ambiguous-overload-default")
			expect(underlinedText(source, diagnostics[0].labels[0]!)).toBe("1")
		})

		// NOTE: The `loop` shape — four entries told apart by their label sets
		// alone. Defaulting `while` would give the first entry the fourth's
		// written shape, and two entries resolved purely by label would have
		// become indistinguishable.
		it("should refuse a default that reduces one label set to another", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Counters for Integer {
					overload step {
						(startingWith start: Integer, while limit: Integer = 10, by amount: Integer) -> Integer {
							<- start
						}

						(startingWith start: Integer, by amount: Integer) -> Integer {
							<- start
						}
					}
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"ambiguous-overload-default",
			])
		})

		// NOTE: The regression guard the whole "only by omitting a default"
		// qualifier exists for — the numeric tower's entries all have the same
		// written shape and resolve by Type.
		it("should leave entries of the same written shape alone", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Widths for Integer {
						overload widen {
							(_ by: Integer) -> Integer {
								<- @
							}

							(_ by: String) -> Integer {
								<- @
							}
						}
					}
				}`),
			).toEqual([])
		})

		it("should let a defaulted entry sit beside a type-dispatched one", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Widths for Integer {
						overload widen {
							(_ by: Integer = 1, to limit: Integer) -> Integer {
								<- @
							}

							(_ by: String) -> Integer {
								<- @
							}
						}
					}
				}`),
			).toEqual([])
		})

		// NOTE: Pinning what a default on a REFINED Parameter does rather than
		// asserting what it ought to do. `overloadProbeOrder` hoists the entries
		// asking for a refinement so a refined entry is probed before its base,
		// and a default makes an entry accept more shapes — the two have not
		// been worked through together, so this records where they stand.
		it("should accept a default that is its own proof of a refinement", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Widths for Integer {
						overload widen {
							(_ by: NonZeroInteger = 1) -> Integer {
								<- @
							}

							(_ by: String) -> Integer {
								<- @
							}
						}
					}
				}`),
			).toEqual([])
		})

		// NOTE: A PARTIAL Record default adds no accepted shape — its Argument
		// is still written — but it widens the RECORDS an entry accepts, which
		// is the same mistake one level down.
		describe("a partial Record default", () => {
			it("should refuse a Record the default makes fit both entries", () => {
				let source = `implementation {
					type Options = { host: String, retries: Integer }

					namespace Links for String {
						overload open {
							(using options: Options = { retries = 3 }) -> String {
								<- options.host
							}

							(using options: { host: String }) -> String {
								<- options.host
							}
						}
					}
				}`
				let diagnostics = diagnosticsFor(source)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["ambiguous-overload-default"])
				expect(underlinedText(source, diagnostics[0]!.labels[0]!)).toBe(
					"{ retries = 3 }",
				)
			})

			// NOTE: The two Records still tell themselves apart: nothing a call
			// writes satisfies both, because each declares a member the other
			// requires and does not declare.
			it("should leave two Records that share no Argument alone", () => {
				expect(
					diagnosticsFor(`implementation {
						type Options = { host: String, retries: Integer }

						namespace Links for String {
							overload open {
								(using options: Options = { retries = 3 }) -> String {
									<- options.host
								}

								(using options: { port: Integer }) -> String {
									<- options.port::toString()
								}
							}
						}
					}`),
				).toEqual([])
			})

			// NOTE: A member of the same name and a different Type is what
			// keeps the two apart, so the default changes nothing.
			it("should leave two Records that disagree on a member alone", () => {
				expect(
					diagnosticsFor(`implementation {
						type Options = { host: String, retries: Integer }

						namespace Links for String {
							overload open {
								(using options: Options = { retries = 3 }) -> String {
									<- options.host
								}

								(using options: { host: Integer }) -> String {
									<- options.host::toString()
								}
							}
						}
					}`),
				).toEqual([])
			})

			// NOTE: Labels are read before Types, so an entry a call can not
			// even address is not a clash.
			it("should leave entries told apart by their labels alone", () => {
				expect(
					diagnosticsFor(`implementation {
						type Options = { host: String, retries: Integer }

						namespace Links for String {
							overload open {
								(using options: Options = { retries = 3 }) -> String {
									<- options.host
								}

								(with options: { host: String }) -> String {
									<- options.host
								}
							}
						}
					}`),
				).toEqual([])
			})
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

					Terminal.inspect(Maker.describe(5))
					Terminal.inspect(Maker.describe(true))
				}`),
			).toEqual(['"5"', '"boolean"'])
		})
	})
})

// NOTE: What a call no candidate accepts is TOLD. The report used to name only
// what each candidate declares — "'String::append' takes 1 Argument: Parameter 1
// is String" under "this call passes 1 Argument" — which says everything about
// the callee and nothing about the call: the Argument's own Type, the half a
// reader can not read off a signature, was never printed at all, and which of
// the Arguments was the wrong one had to be worked out from a list. It leads
// with the closest candidate now, and the Labels say what was passed and what
// was wanted where.
describe("What a refused call is told", () => {
	// NOTE: The finding's own example, and the shape three studies named as the
	// most frequent complaint: one candidate, one Argument, and a message that
	// said neither what it is nor what it should have been.
	describe("an Argument of the wrong Type", () => {
		let source = `implementation {
			constant total = 12

			Terminal.print("Total: "::append(total))
		}`

		it("names the Argument and what it came to", () => {
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics.map(({ code }) => code)).toEqual([
				"no-matching-overload",
			])
			expect(diagnostics[0]!.labels[0]!.kind).toBe("primary")
			expect(diagnostics[0]!.labels[0]!.message).toBe(
				"this is an Integer",
			)
			expect(underlinedText(source, diagnostics[0]!.labels[0]!)).toBe(
				"total",
			)
		})

		it("names what the candidate takes there, beside the callee", () => {
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics[0]!.labels[1]!.kind).toBe("secondary")
			expect(diagnostics[0]!.labels[1]!.message).toBe(
				"'String::append' takes a String as Parameter 1",
			)
			expect(underlinedText(source, diagnostics[0]!.labels[1]!)).toBe(
				"append",
			)
		})

		// NOTE: The signature is still listed. What the Labels say is where THIS
		// call went wrong; what the Note says is what the callee takes, which is
		// what a reader rewriting the call needs to see whole.
		it("still lists the signature", () => {
			expect(diagnosticsFor(source)[0]!.notes).toEqual([
				"'String::append' takes 1 Argument: Parameter 1 is String.",
			])
		})
	})

	// NOTE: The A1 refusal, which is where this report is met on a Program that
	// looks right: a fold's accumulator decided by what its combiner writes,
	// handed to a Method over Numbers. "Parameter 1 is List<Integer>" with no
	// word about what was passed left the one fact that explains it unsaid.
	it("names the Type a Method over Numbers was handed instead", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant words = ["a", "bb"]
			constant kept = words::reduce(startingWith [], (current, word) {
				<- current::append(word)
			})

			Terminal.print(Number.sum(kept)::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
		expect(diagnostics[0]!.labels[0]!.message).toBe(
			"this is a List<String>",
		)
		expect(diagnostics[0]!.labels[1]!.message).toBe(
			"'Number.sum' takes a List<Integer> as Parameter 1",
		)
	})

	// NOTE: Eight entries of one `add` refuse the same Argument for the same
	// reason, and the Labels say it once. A clause per Note would be the same
	// sentence eight times over the list a reader is scanning for the entry they
	// meant.
	it("says nothing more under a candidate refused the same way", () => {
		expect(
			diagnosticsFor(`implementation {
				Terminal.print(5::add("one"))
			}`)[0]!.notes,
		).toEqual([
			"'Integer::add' takes 1 Argument: Parameter 1 is Integer.",
			"'Integer::add' takes 1 Argument: Parameter 1 is Rational.",
			"'Integer::add' takes 1 Argument: Parameter 1 is Algebraic.",
			"'Integer::add' takes 1 Argument: Parameter 1 is Transcendental.",
			"'NonNegativeInteger::add' takes 1 Argument: Parameter 1 is PositiveInteger.",
			"'NonNegativeInteger::add' takes 1 Argument: Parameter 1 is NonNegativeInteger.",
			"'PositiveInteger::add' takes 1 Argument: Parameter 1 is NonNegativeInteger.",
			"'Scalar::add' takes 1 Argument: Parameter 1 is Scalar.",
		])
	})

	// NOTE: And where a candidate disagreed somewhere ELSE, its Note says so —
	// which is the whole of what tells two entries of one name apart. The entry
	// taking a bare item refused the LABEL; the entry the call meant refused the
	// Type behind it.
	it("says where a candidate disagreed otherwise", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant numbers = [1, 2, 3]

			Terminal.print(numbers::append(contentsOf ["a"])::toString())
		}`)

		expect(diagnostics[0]!.notes).toEqual([
			"'List::append' takes 1 Argument: Parameter 1 is Integer — this call writes 'contentsOf' where Parameter 1 takes no label.",
			"'List::append' takes 1 Argument: Parameter 'contentsOf' is List<Integer>.",
		])
	})

	// NOTE: Which is also the tie the closest candidate is decided by. Both
	// entries stopped at the same Parameter, and the one that agreed on the
	// label got further into the call than the one that did not — leading with
	// the entry the call clearly did not mean would be a report about the wrong
	// signature.
	it("leads with the candidate whose labels agreed", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant numbers = [1, 2, 3]

			Terminal.print(numbers::append(contentsOf ["a"])::toString())
		}`)

		expect(diagnostics[0]!.labels[0]!.message).toBe(
			"this is a List<String>",
		)
		expect(diagnostics[0]!.labels[1]!.message).toBe(
			"'List::append' takes a List<Integer> as Parameter 'contentsOf'",
		)
	})

	// NOTE: Among candidates of the right arity, the closest is the one that
	// answered the most Parameters before refusing one — the second entry here,
	// which took the String and stopped at the Integer beside it.
	it("leads with the candidate that got furthest into the call", () => {
		let diagnostics = diagnosticsFor(`implementation {
			namespace Shipping {
				overload static label {
					(_ code: Integer, to city: String) -> String {
						<- "{code}"
					}

					(_ name: String, to postcode: Integer) -> String {
						<- name
					}
				}
			}

			Terminal.print(Shipping.label("Ada", to 1/2))
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
		expect(diagnostics[0]!.labels[0]!.message).toBe("this is a Rational")
		expect(diagnostics[0]!.labels[1]!.message).toBe(
			"'Shipping.label' takes an Integer as Parameter 'to'",
		)
	})

	// NOTE: A label that does not agree is what the call got wrong, and saying
	// it is an Integer where a String was wanted would name nothing the call did
	// — the Type behind the label was never even read. The Help is the
	// Validator's own, word for word: one mistake, one edit, however the callee
	// was reached.
	describe("an Argument labelled wrongly", () => {
		let source = `implementation {
			constant temperature = 42

			Terminal.print(temperature::clamp(0, and 100)::toString())
		}`

		it("says what the Argument is labelled and what was expected", () => {
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics.map(({ code }) => code)).toEqual([
				"no-matching-overload",
			])
			expect(diagnostics[0]!.labels[0]!.message).toBe(
				"this Argument carries no label",
			)
			expect(underlinedText(source, diagnostics[0]!.labels[0]!)).toBe("0")
			expect(diagnostics[0]!.labels[1]!.message).toBe(
				"'Integer::clamp' takes Parameter 'between' here",
			)
		})

		it("offers the edit the label asks for", () => {
			expect(diagnosticsFor(source)[0]!.helps).toEqual([
				"Write 'between' before the value.",
			])
		})
	})

	// NOTE: The other half of a label mismatch — a label written where the
	// Parameter takes none.
	it("says so where the Parameter takes no label at all", () => {
		let diagnostics = diagnosticsFor(`implementation {
			Terminal.print("essence"::append(with "!"))
		}`)

		expect(diagnostics[0]!.labels[0]!.message).toBe(
			"this is labelled 'with'",
		)
		expect(diagnostics[0]!.labels[1]!.message).toBe(
			"'String::append' takes no label on Parameter 1",
		)
		expect(diagnostics[0]!.helps).toEqual(["Pass the value with no label."])
	})

	// NOTE: A label no candidate declares anywhere is matched before anything is
	// typed, and the Parameter it names nowhere leaves the count wrong — so the
	// report falls back to the call's shape and would be about a count nobody
	// miscounted. The label is named instead, which is what went wrong.
	it("names a label no candidate declares", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant numbers = [1, 2, 3]

			Terminal.print(numbers::slice(at 1)::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
		expect(diagnostics[0]!.notes[0]).toBe(
			"No Parameter of 'slice' is labelled 'at'.",
		)
	})

	// NOTE: Where no candidate takes this many Arguments there is no Argument to
	// lead with — nothing was refused for what it is. The report stays about the
	// call's shape, and says what the call handed over, which is the half a
	// reader can not count off their own source.
	it("names what a call of the wrong shape passed", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant word = "essence"

			Terminal.print(word::character(at 1, 2, 3))
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
		expect(diagnostics[0]!.labels[0]!.message).toBe(
			"this call passes 3 Arguments: an Integer, an Integer and an Integer",
		)
	})

	// NOTE: A call that passes nothing has nothing to list, and the count says
	// the whole of it.
	it("leaves the list out where the call passes nothing", () => {
		expect(
			diagnosticsFor(`implementation {
				Terminal.print("essence"::prepend())
			}`)[0]!.labels[0]!.message,
		).toBe("this call passes 0 Arguments")
	})

	// NOTE: A Function literal Argument is named by the signature it was read as
	// — which is the one thing a reader can not see, since the literal they
	// wrote spells none of it.
	it("names the signature a Function literal was read as", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant numbers = [1, 2, 3]

			Terminal.print(numbers::map((item: Integer, index: Integer) -> Integer {
				<- item
			})::length()::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
		expect(diagnostics[0]!.labels[0]!.message).toBe(
			"this is a (item: Integer, index: Integer) -> Integer",
		)
	})

	// NOTE: And where the literal could not be read at all, the report says that
	// and points at it rather than naming the Error Type nobody wrote. The
	// literal's own Diagnostic is untouched — it is the one that says which
	// Parameter has no Type and how to give it one.
	it("says so where a Function literal could not be read", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant numbers = [1, 2, 3]

			Terminal.print(numbers::map((item, index) { <- item })::length()::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"uninferable-parameter-type",
			"no-matching-overload",
		])
		expect(diagnostics[1]!.labels[0]!.message).toBe(
			"this Argument's Type could not be read",
		)
		expect(diagnostics[1]!.notes).toEqual([
			"'List::map' takes 1 Argument: Parameter 1 is (_: Integer) -> Other.",
		])
	})

	// NOTE: The pair the blank question is about is in hand here for the first
	// time — the Parameter Type the closest candidate held the Argument to, and
	// the Type the Argument came to. A Type Parameter bound to a blank by an
	// earlier Argument refuses the one after it for being a write into a blank
	// rather than for holding the wrong thing, and nothing else in the report
	// says so. The same two sentences every other refusal over a blank carries.
	it("explains a blank on the expected side", () => {
		let diagnostics = diagnosticsFor(`implementation {
			namespace Keeps {
				overload static keep {
					<infer T>(_ seed: T, _ more: T) -> T {
						<- seed
					}

					<infer T>(_ seed: T, _ more: T, _ third: T) -> T {
						<- seed
					}
				}
			}

			constant empty = []

			Terminal.print(Keeps.keep(empty, ["a"], 1)::length()::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
		expect(diagnostics[0]!.labels[1]!.message).toBe(
			"'Keeps.keep' takes a List<Unknown> as Parameter 2",
		)
		expect(diagnostics[0]!.notes).toContain(
			"An empty List Literal leaves its item Type unknown until a write decides it, and nothing has written into this one — the 'Unknown' here is a blank, not a Type.",
		)
		expect(diagnostics[0]!.helps).toEqual([
			"Annotate the Declaration that creates it — 'List<Integer>' — so what is written into it is judged against the Type it holds.",
		])
	})

	// NOTE: A Union receiver whose covering Namespace declares the Method is
	// reported against the receiver as written — per-member dispatch is the
	// second chance, not the failure worth reporting — and the Argument it
	// refused is named exactly as it is anywhere else.
	it("names the Argument a Union receiver's Namespace refused", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant maybe: Optional<Rational> = #Empty

			Terminal.inspect(maybe::value(defaultingTo 0))
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
		expect(diagnostics[0]!.labels[0]!.message).toBe("this is an Integer")
		expect(diagnostics[0]!.labels[1]!.message).toBe(
			"'Optional::value' takes a Rational as Parameter 'defaultingTo'",
		)
	})
})
