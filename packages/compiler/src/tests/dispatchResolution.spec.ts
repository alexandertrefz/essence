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

// What a resolved Invocation does: which Method the emitted Program calls, with
// which Arguments, and which dispatch branch it takes. Such faults type-check
// cleanly and show only in what the Program prints, so these specs run it.

// Runs the emitted Program and captures what `Terminal.inspect` prints.
// `expectedWarnings` names the Warnings a Program must carry, such as the
// empty-List overlap of a Union of two Lists. By default a Program compiles
// silently.
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

// For a Program that must be refused, where the probe order shows in the
// Diagnostics rather than in which body ran.
function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrich(parse(source)).diagnostics
}

// The text a single-line Label covers, so a spec can name what it points at
// without counting columns.
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
		// `IntApplier` wins because its target is more specific, but every
		// Namespace is probed first, each resolving the literal against its own
		// Parameter Type. The literal must end up compiled against the winner.
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

	// A dispatched Invocation hands each branch its own copy of an unannotated
	// literal, compiled against that branch's member. See "Union receivers" in
	// packages/compiler/src/enricher/DEVELOPMENT.md.
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

		// The value's member decides, not the order the Union is written in.
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

		// The same with the standard library's Namespaces. `String.toString`
		// answers its receiver unchanged, so a wrong copy would print Integers.
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

		// A standard library Method reached only from a branch's copy must still
		// be emitted. The shared literal is compiled against the Integer branch,
		// whose `toString` is native, so only the String copy asks for
		// `String.toString`.
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

		// Only the literals are copied per branch. The other Arguments are
		// evaluated once at the call site, before a branch is picked.
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

		// Every member must accept what the call asks, including the literal's
		// body, so a body one branch cannot compile is reported.
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
		// `dispatchMethod` takes the first branch whose Type matches, and a
		// Record matches openly. So `{ width, height }` must come before
		// `{ width }`, even with an incomparable `Boolean` between them.
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

		// Two applications erase to one question, but where both branches
		// call one Method with nothing of their own, the answer is the same
		// whichever runs.
		it("runs one generic Method for every application without a report", async () => {
			expect(
				await run(`implementation {
					choice Box<Item> {
						Full { item: Item },
						Empty,
					}

					namespace Boxes<infer Item> for Box<Item> {
						describe() -> String {
							<- "a box"
						}
					}

					function show(_ value: Box<Integer> | Box<String>) -> String {
						<- value::describe()
					}

					constant items: List<Integer> | List<String> = []

					Terminal.inspect(show(Box<String>#Empty))
					Terminal.inspect(show(Box<Integer>#Full({ item = 1 })))
					Terminal.inspect(items::hasItems())
				}`),
			).toEqual(['"a box"', '"a box"', "false"])
		})
	})

	// Refined entries are probed first, so an appended refined entry can still
	// win. The effect shows only in which body runs. See "Choosing an Overload"
	// in packages/compiler/src/enricher/DEVELOPMENT.md.
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

		// A value carrying no evidence must still find the base entry rather
		// than be refused by the refined one.
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

		// A candidate whose bound the Arguments cannot satisfy is no candidate.
		// The refined entry takes `true` and `3` but fails its bound, so it is
		// passed over without a report.
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

		// Where no entry asks for evidence, entries are probed as written, so the
		// first written wins a call both accept.
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

		// The same over a generic refinement: the probe order asks whether a
		// Parameter Type mentions a refinement anywhere, and `Filled<String>` does.
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

		// For a call every entry refuses, the probe order decides which entry the
		// report is about. See "Choosing an Overload" in
		// packages/compiler/src/enricher/DEVELOPMENT.md.
		describe("the report a call every entry refuses gets", () => {
			// Both entries take the Arguments and both fail their bound. The
			// bounds name different Protocols, so the Diagnostic shows which entry
			// the report is about.
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

			// The entry asking for evidence is probed first, so it matches first
			// and its bound is the one named.
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

			// With nothing asking for evidence, entries are probed as written,
			// so the first written entry's bound is named.
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

			// Where no candidate's Arguments match, the literal stays compiled
			// under the last entry probed, and the report reads it that way. The
			// base entry is probed last, so the reader sees its reading. It hands
			// the literal an Integer, which answers `isEven`, where the refined
			// entry hands a String.
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

				// One Diagnostic about the call. The base entry reads `item` as an
				// Integer, so nothing inside the literal is reported.
				expect(
					diagnosticsFor(source).map((diagnostic) => diagnostic.code),
				).toEqual(["no-matching-overload"])

				// The entries are still listed as written. The probe order is only
				// the order they are tried in.
				expect(diagnosticsFor(source)[0]!.notes).toEqual([
					"'Appliers::apply' takes 2 Arguments: Parameter 1 is (_: Integer) -> String, Parameter 'with' is Integer.",
					"'Appliers::apply' takes 2 Arguments: Parameter 1 is (_: String) -> String, Parameter 'with' is NonZero.",
				])
			})

			// Probed as written, the last entry is the String one, so the body
			// reads `item` as a String and `isEven` is reported inside the literal.
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

	// An `overload` block resolves by the Arguments a call writes, so a default
	// can make two entries answer one call. Such a default is refused.
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

		// The `loop` shape: entries told apart by their labels alone. A default
		// on `while` gives the first entry the second's shape.
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

		// Entries of one written shape that resolve by Type, as the numeric
		// tower's do, are no clash.
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

		// Pins today's behaviour of a default on a refined Parameter, which
		// `overloadProbeOrder` probes first. The two rules have not been reconciled.
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

		// A partial Record default adds no shape, but widens the Records an
		// entry accepts, which can make two entries clash.
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

			// Each Record requires a member the other lacks, so no call fits both.
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

			// A shared member of different Types keeps the two apart.
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

			// Labels are read before Types, so different labels never clash.
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

	// A value of both member Types takes the branch the dispatch orders first,
	// which `dispatch-overlap` reports. A Match puts it where its Cases say.
	describe("Member Types that share values", () => {
		let sides = `type Left = { a: Integer | String }
			type Right = { a: String | Boolean }

			namespace Lefts for Left {
				describe() -> String {
					<- "left"
				}
			}

			namespace Rights for Right {
				describe() -> String {
					<- "right"
				}
			}

			constant shared: Right = { a = "x" }
			constant either: Left | Right = shared`

		it("takes the branch ordered first for a shared value", async () => {
			expect(
				await run(
					`implementation {
						${sides}

						Terminal.inspect(either::describe())
					}`,
					["dispatch-overlap"],
				),
			).toEqual(['"left"'])
		})

		it("takes the Case written first once the receiver is matched", async () => {
			expect(
				await run(`implementation {
					${sides}

					Terminal.inspect(match either -> String {
						case Right { <- @::describe() }
						case Left { <- @::describe() }
					})
				}`),
			).toEqual(['"right"'])
		})
	})

	// A Case of a generic Choice binds no Type Parameter its payload leaves
	// out, so a branch for one resolves as its whole application. See "Union
	// receivers" in packages/compiler/src/enricher/DEVELOPMENT.md.
	describe("Cases of generic Choices in a dispatch", () => {
		let defaults = `protocol Defaultable {
			static default() -> Self
		}

		namespace IntegerDefaults for Integer is Defaultable {
			static default() -> Integer {
				<- 0
			}
		}

		namespace StringDefaults for String is Defaultable {
			static default() -> String {
				<- "none"
			}
		}`
		let slots = `choice Slot<Item is Defaultable> {
			Full { item: Item },
			Empty,
		}

		namespace Slots<infer Item> for Slot<Item> {
			value() -> Item {
				<- match @ -> Item {
					case #Full { <- @.item }
					case #Empty { <- Item.default() }
				}
			}
		}`
		let boxes = `choice Box<Item> {
			Full { item: Item },
			Count { n: Integer },
			Empty,
		}

		namespace Boxes<infer Item> for Box<Item> {
			fallback<Item is Defaultable>() -> Item {
				<- Item.default()
			}
		}`
		let codesOf = (source: string) => {
			let { program, diagnostics } = enrich(parse(source))

			return [...diagnostics, ...validate(program)].map(
				(diagnostic) => diagnostic.code,
			)
		}

		it("passes the witness of the application a payload-free Case belongs to", async () => {
			expect(
				await run(`implementation {
					${defaults}
					${slots}

					namespace Numbers for Integer {
						value() -> Integer {
							<- @
						}
					}

					function show(_ slot: Slot<String> | Integer) -> String | Integer {
						<- slot::value()
					}

					constant empty: Slot<String> = #Empty

					Terminal.inspect(show(empty))
					Terminal.inspect(show(3))
				}`),
			).toEqual(['"none"', "3"])
		})

		it("passes it for a Case whose payload names no Type Parameter", async () => {
			expect(
				await run(`implementation {
					${defaults}
					${boxes}

					namespace Numbers for Integer {
						fallback() -> Integer {
							<- @
						}
					}

					function show(_ box: Box<String> | Integer) -> String | Integer {
						<- box::fallback()
					}

					constant counted: Box<String> = #Count({ n = 1 })

					Terminal.inspect(show(counted))
				}`),
			).toEqual(['"none"'])
		})

		// Each application's Empty takes its own witness, and no runtime check
		// tells the two Cases apart, so either would get the other's.
		it("refuses two applications whose witnesses no runtime check tells apart", () => {
			expect(
				codesOf(`implementation {
					${defaults}
					${slots}

					function show(_ slot: Slot<Integer> | Slot<String>) -> Integer | String {
						<- slot::value()
					}
				}`),
			).toEqual(["erased-case-conflict"])
			expect(
				codesOf(`implementation {
					${defaults}
					${boxes}

					function show(_ box: Box<Integer> | Box<String>) -> Integer | String {
						<- box::fallback()
					}
				}`),
			).toEqual(["erased-case-conflict"])
		})

		// A provided Method's conformance condition is asked of the
		// application, which binds the Type Parameter it names.
		it("refuses a provided Method's branches for the same reason, not for a condition", () => {
			let named = (parameter: string) => `implementation {
				protocol Named {
					static label() -> String
				}

				namespace IntegerNames for Integer is Named {
					static label() -> String {
						<- "integer"
					}
				}

				namespace StringNames for String is Named {
					static label() -> String {
						<- "string"
					}
				}

				protocol Describable {
					name() -> String

					describe() -> String {
						<- "a box of {@::name()}"
					}
				}

				choice Box<Item> {
					Full { item: Item },
					Empty,
				}

				namespace Boxes<infer Item> for Box<Item> is Describable where Item is Named {
					name() -> String {
						<- Item.label()
					}
				}

				function show(_ value: ${parameter}) -> String {
					<- value::describe()
				}

				Terminal.inspect(show(Box<String>#Empty))
			}`

			expect(codesOf(named("Box<Integer> | Box<String>"))).toEqual([
				"erased-case-conflict",
			])
		})

		// `Box<String>#Empty` fits `IntBoxes`' Case by its empty payload, but its
		// Type Argument names another application, so its own Namespace answers.
		it("runs the Namespace of the Case's own application", async () => {
			let boxes = (namespace: string) => `implementation {
				choice Box<Item> {
					Full { item: Item },
					Empty,
				}

				namespace IntBoxes for Box<Integer> {
					describe() -> String {
						<- "integer boxes"
					}
				}

				${namespace}

				namespace Flags for Boolean {
					describe() -> String {
						<- "flag"
					}
				}

				function show(_ value: Box<String> | Boolean) -> String {
					<- value::describe()
				}

				Terminal.inspect(show(Box<String>#Empty))
				Terminal.inspect(show(Box<String>#Full({ item = "a" })))
			}`

			expect(
				await run(
					boxes(`namespace Boxes<infer Item> for Box<Item> {
						describe() -> String {
							<- "any boxes"
						}
					}`),
				),
			).toEqual(['"any boxes"', '"any boxes"'])
			expect(
				await run(
					boxes(`namespace StringBoxes for Box<String> {
						describe() -> String {
							<- "string boxes"
						}
					}`),
				),
			).toEqual(['"string boxes"', '"string boxes"'])
		})

		// `Pair<Item, Item>` binds `Item` twice from `Pair<Integer, String>`,
		// which no one binding fits, so its Namespace answers neither a direct
		// call nor a dispatch. `Pair<Integer, Integer>` binds it once.
		it("refuses a repeated Type Parameter another application fills twice", async () => {
			let pairs = (application: string, call: string) => `implementation {
				protocol Named {
					static label() -> String
				}

				namespace IntegerNames for Integer is Named {
					static label() -> String {
						<- "integer"
					}
				}

				namespace StringNames for String is Named {
					static label() -> String {
						<- "string"
					}
				}

				choice Pair<A, B> {
					Left { a: A },
					Neither,
				}

				namespace Sames<infer Item> for Pair<Item, Item> {
					label<Item is Named>() -> String {
						<- Item.label()
					}
				}

				namespace Flags for Boolean {
					label() -> String {
						<- "flag"
					}
				}

				function show(_ value: ${application} | Boolean) -> String {
					<- value::label()
				}

				constant none: ${application} = #Neither

				Terminal.inspect(${call})
			}`

			expect(
				diagnosticsFor(
					pairs("Pair<Integer, String>", "none::label()"),
				).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-method", "unknown-method"])
			expect(
				diagnosticsFor(
					pairs(
						"Pair<Integer, String>",
						"Pair<Integer, String>#Neither::label()",
					),
				).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-method", "no-namespace-for-value"])
			expect(
				await run(pairs("Pair<Integer, Integer>", "none::label()")),
			).toEqual(['"integer"'])
			expect(
				await run(pairs("Pair<Integer, Integer>", "show(none)")),
			).toEqual(['"integer"'])
		})

		// A Case's Type Arguments are its application's, named by a payload or
		// not. A Namespace for another application answers no call to it.
		it("runs no Namespace for another application, called directly or dispatched", async () => {
			let tags = (application: string, call: string) => `implementation {
				choice Tag<Item> {
					On,
					Off,
				}

				namespace Lists for Tag<List<Integer>> {
					describe() -> String {
						<- "list tag"
					}
				}

				namespace Flags for Boolean {
					describe() -> String {
						<- "flag"
					}
				}

				function show(_ value: ${application} | Boolean) -> String {
					<- value::describe()
				}

				constant on: ${application} = #On

				Terminal.inspect(${call})
			}`
			let codesOf = (source: string) =>
				diagnosticsFor(source).map((diagnostic) => diagnostic.code)

			expect(codesOf(tags("Tag<Integer>", "on::describe()"))).toEqual([
				"unknown-method",
				"unknown-method",
			])
			expect(
				codesOf(tags("Tag<Integer>", "Tag<Integer>#On::describe()")),
			).toEqual(["unknown-method", "no-namespace-for-value"])
			expect(
				await run(tags("Tag<List<Integer>>", "on::describe()")),
			).toEqual(['"list tag"'])
			expect(await run(tags("Tag<List<Integer>>", "show(on)"))).toEqual([
				'"list tag"',
			])
		})

		// A payload names the Type Parameter it binds, so a Namespace for
		// another application of `Box` answers neither its Cases nor its
		// payload-free one.
		it("runs no Namespace for another application of a Case without a payload", () => {
			expect(
				diagnosticsFor(`implementation {
					choice Box<Item> {
						Full { item: Item },
						Empty,
					}

					namespace ListBoxes for Box<List<Integer>> {
						describe() -> String {
							<- "list box"
						}
					}

					constant empty = Box<Integer>#Empty

					Terminal.inspect(empty::describe())
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["no-namespace-for-value"])
		})

		// The reader sees `ListBoxes` declare the Method, so the refusal says
		// why it does not answer, called directly as dispatched.
		it("names the Namespace for another application in the refusal", () => {
			let notesOf = (receiver: string, call: string) =>
				diagnosticsFor(`implementation {
					choice Box<Item> {
						Full { item: Item },
						Empty,
					}

					namespace ListBoxes for Box<List<Integer>> {
						describe() -> String {
							<- "list box"
						}
					}

					namespace Flags for Boolean {
						describe() -> String {
							<- "flag"
						}
					}

					function show(_ value: ${receiver}) -> String {
						<- ${call}
					}
				}`).map((diagnostic) => diagnostic.notes)
			let turnedAway =
				"'ListBoxes' declares 'describe' for Box<List<Integer>>, another application of 'Box'."

			expect(
				notesOf("Box<Integer>", "Box<Integer>#Empty::describe()"),
			).toEqual([
				[
					"No Namespace in scope targets Box<Integer>#Empty.",
					turnedAway,
				],
			])
			expect(
				notesOf("Box<Integer> | Boolean", "value::describe()"),
			).toEqual([
				[
					"Every member of the Union must provide 'describe' — the receiver's Type is only known at runtime.",
					"'describe' answers for Boolean, and not for Box<Integer>#Full and Box<Integer>#Empty.",
					turnedAway,
				],
			])
		})

		// `Box<String>#Empty` carries no `Item` in its payload, so its Type
		// Arguments bind it, called directly as dispatched.
		it("passes the witness a payload-free Case's Type Arguments decide to a direct call", async () => {
			expect(
				await run(`implementation {
					${defaults}
					${boxes}

					namespace Numbers for Integer {
						fallback() -> Integer {
							<- @
						}
					}

					function show(_ box: Box<String> | Integer) -> String | Integer {
						<- box::fallback()
					}

					constant empty = Box<String>#Empty
					constant counted = Box<Integer>#Count({ n = 1 })

					Terminal.inspect(empty::fallback())
					Terminal.inspect(show(empty))
					Terminal.inspect(counted::fallback())
				}`),
			).toEqual(['"none"', '"none"', "0"])
		})

		// Inside `Boxes`, `Box<Item>#Empty` pins the Namespace's `Item` to the
		// caller's `Item`, the same name. The pin is borrowed, so freshening
		// does not rename it into a Parameter bound to itself.
		it("pins a receiver's Type Argument that names the Namespace's own Type Parameter", async () => {
			expect(
				await run(`implementation {
					${defaults}

					choice Box<Item> {
						Full { item: Item },
						Empty,
					}

					namespace Boxes<infer Item> for Box<Item> {
						fallback<Item is Defaultable>() -> Item {
							<- Item.default()
						}

						again<Item is Defaultable>() -> Item {
							<- Box<Item>#Empty::fallback()
						}
					}

					function generic<infer Item is Defaultable>(_ item: Item) -> Item {
						<- Box<Item>#Empty::fallback()
					}

					Terminal.inspect(Box<String>#Empty::again())
					Terminal.inspect(Box<Integer>#Full({ item = 2 })::again())
					Terminal.inspect(generic("s"))
				}`),
			).toEqual(['"none"', "0", '"none"'])
		})

		// A branch's Method is read once, against its member, so what reading
		// an Argument reports is never dropped with an attempt not taken.
		it("reports an undeclared name in an Argument of a dispatched call", () => {
			expect(
				diagnosticsFor(`implementation {
					choice Box<Item> {
						Full { item: Item },
						Empty,
					}

					namespace Boxes<infer Item> for Box<Item> {
						size(_ x: Integer) -> Integer {
							<- x
						}
					}

					namespace Flags for Boolean {
						size(_ x: Integer) -> Integer {
							<- 0
						}
					}

					function show(_ v: Box<String> | Boolean) -> Integer {
						<- v::size(nope)
					}
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-name"])
		})

		// A whole `Tag<String>` holds no payload at all. Its Type Argument binds
		// `Item` before the Arguments are matched, so they are read against it.
		describe("a Type Parameter only the receiver's Type Arguments decide", () => {
			let tags = (body: string) => `implementation {
				protocol Named {
					static label() -> String
				}

				namespace StringNames for String is Named {
					static label() -> String {
						<- "string"
					}
				}

				choice Tag<Item> {
					On,
					Off,
				}

				namespace Tags<infer Item> for Tag<Item> {
					wrap(_ x: Item) -> List<Item> {
						<- [x]
					}

					apply<Item is Named>(_ change: (_: Item) -> String) -> String {
						<- Item.label()
					}
				}

				namespace Flags for Boolean {
					wrap(_ x: Integer) -> List<Integer> {
						<- [x]
					}

					apply(_ change: (_: Integer) -> String) -> String {
						<- change(1)
					}
				}

				constant on: Tag<String> = #On

				${body}
			}`
			let codesOf = (body: string) =>
				diagnosticsFor(tags(body)).map((diagnostic) => diagnostic.code)

			it("refuses an Argument of another Type, called directly or dispatched", () => {
				expect(codesOf("Terminal.inspect(on::wrap(1))")).toEqual([
					"no-matching-overload",
				])
				expect(
					codesOf("Terminal.inspect(Tag<String>#On::wrap(1))"),
				).toEqual(["no-matching-overload"])
				expect(
					codesOf(`function show(_ value: Tag<String> | Boolean) -> List<String> | List<Integer> {
						<- value::wrap(1)
					}`),
				).toEqual(["no-matching-overload"])
			})

			// Each branch reads the literal against its own Method, so the
			// Tag branch never reads it against `Flags`' Integer.
			it("reads an unannotated literal's Parameter as the Type Argument", async () => {
				let show = (
					literal: string,
				) => `function show(_ value: Tag<String> | Boolean) -> String {
					<- value::apply(${literal})
				}`

				expect(
					await run(
						tags(`${show("(x) { <- x::toString() }")}

						Terminal.inspect(on::apply((x) { <- x::toString() }))
						Terminal.inspect(show(on))
						Terminal.inspect(show(true))
						Terminal.inspect(on::wrap("a"))`),
					),
				).toEqual(['"string"', '"string"', '"1"', '[ "a" ]'])
				expect(
					codesOf(show("(x) { <- x::add(1)::toString() }")),
				).toEqual(["unknown-method"])
				expect(
					codesOf(
						"Terminal.inspect(on::apply((x) { <- x::add(1)::toString() }))",
					),
				).toEqual(["unknown-method"])
			})
		})

		// The Help the refusal gives: the receiver as one application.
		it("runs the Method once the receiver is one application", async () => {
			expect(
				await run(`implementation {
					${defaults}
					${slots}

					function show(_ slot: Slot<String>) -> String {
						<- slot::value()
					}

					constant empty: Slot<String> = #Empty

					Terminal.inspect(show(empty))
					Terminal.inspect(show(Slot<String>#Full({ item = "a" })))
				}`),
			).toEqual(['"none"', '"a"'])
		})
	})

	describe("Static Method bodies", () => {
		// A static Method has no `_self` Parameter for `@` to lower to. The
		// Enricher refuses `@` there, so the Simplifier's own guard is reached by
		// retagging an enriched instance Method as static.
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

		// A Match Handler's `@` is the matched value, bound by the Handler's own
		// Function, so the guard must not mistake it for the receiver.
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

// A call no candidate accepts is reported against the closest candidate. The
// Labels say what was passed and what was wanted there. See "The
// no-matching-overload report" in packages/compiler/src/enricher/DEVELOPMENT.md.
describe("What a refused call is told", () => {
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

		// The Labels say where this call went wrong, and the Note lists the
		// whole signature for a reader rewriting the call.
		it("still lists the signature", () => {
			expect(diagnosticsFor(source)[0]!.notes).toEqual([
				"'String::append' takes 1 Argument: Parameter 1 is String.",
			])
		})
	})

	// The combiner decides the accumulator, so `kept` is a `List<String>`
	// handed to a Method over Numbers. A Label names the Type passed.
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

	// The entries of `add` refuse the Argument for the same reason, which the
	// Labels say once, so the Notes add no clause. `cappedNotes` caps the list.
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
			"And 3 more Overloads of this name, not listed.",
		])
	})

	// Only five entries are listed, then a count of the rest.
	describe("a name with more entries than a report lists", () => {
		let source = `implementation {
			Terminal.print(Number.highest(1))
		}`

		it("lists five of them and counts the rest", () => {
			let notes = diagnosticsFor(source)[0]!.notes

			expect(notes).toHaveLength(6)
			expect(notes[5]).toBe(
				"And 9 more Overloads of this name, not listed.",
			)
		})

		// The Labels are about the closest candidate, so its Note is always
		// listed.
		it("keeps the closest candidate's own Note in the list", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant numbers = [1, 2]

				Terminal.print(Number.highest(numbers, 3))
			}`)
			let notes = diagnostics[0]!.notes

			expect(notes).toHaveLength(6)
			expect(
				notes
					.slice(0, 5)
					.some((note) => note.includes("List<Integer>")),
			).toBe(true)
		})
	})

	// A candidate that disagreed elsewhere says where in its Note. The entry
	// taking a bare item refused the label, while the one meant refused the Type.
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

	// Both entries stopped at the same Parameter, and the one whose label
	// agreed got further, so it leads.
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

	// The closest candidate answered the most Parameters before refusing one:
	// here the second entry, which took the String.
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

	// A wrong label is what the call got wrong, so the Type behind it is never
	// read. The Help is the Validator's own, word for word.
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

	// A label written where the Parameter takes none.
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

	// A label no candidate declares leaves every count wrong. The report names
	// the label rather than a count nobody miscounted.
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

	// A fold written in another language's order. The mistake is the order,
	// not the missing label on the first Argument.
	describe("Arguments written in the other order", () => {
		let source = `implementation {
			Terminal.print([1, 2, 3]::reduce((total, item) { <- total::add(item) }, 0))
		}`

		it("says the call passes them the other way round", () => {
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics.map(({ code }) => code)).toEqual([
				"no-matching-overload",
			])
			expect(diagnostics[0]!.notes[0]).toBe(
				"This call passes the Arguments in the other order.",
			)
		})

		it("says where each of the two belongs", () => {
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics[0]!.labels[0]!.kind).toBe("primary")
			expect(diagnostics[0]!.labels[0]!.message).toBe(
				"this Argument is what Parameter 2 takes",
			)
			expect(diagnostics[0]!.labels[1]!.message).toBe(
				"and this one is what Parameter 'startingWith' takes",
			)
		})

		// The label moves with the Argument, so swapping the values alone would
		// not fix the call.
		it("writes the label the swap carries with it", () => {
			expect(diagnosticsFor(source)[0]!.helps).toEqual([
				"Write them the other way round, with 'startingWith' before the value it labels.",
			])
		})

		// The literal takes its Parameter Types from the call, which has none to
		// give. So the refusal is the one report.
		it("says nothing about the literal's own Parameters", () => {
			expect(diagnosticsFor(source).map(({ code }) => code)).toEqual([
				"no-matching-overload",
			])
		})
	})

	// Where writing the labels fixes the call, the labels are reported. Only a
	// swap that is the whole edit is reported as one.
	it("keeps the label report where the order is right", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant numbers = [1, 2, 3]

			Terminal.print(numbers::slice(1, 2)::length()::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
		])
		expect(diagnostics[0]!.notes[0]).not.toBe(
			"This call passes the Arguments in the other order.",
		)
	})

	// Where no candidate takes this many Arguments, no Argument was refused for
	// its Type. The report says what the call passed.
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

	it("leaves the list out where the call passes nothing", () => {
		expect(
			diagnosticsFor(`implementation {
				Terminal.print("essence"::prepend())
			}`)[0]!.labels[0]!.message,
		).toBe("this call passes 0 Arguments")
	})

	// A Function literal is named by the signature it was read as, which the
	// literal as written does not spell.
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

	// A literal that could not be read is reported as such, not as an Error
	// Type. Its own Diagnostic says which Parameter has no Type.
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

	// A call of the wrong shape is the one mistake. The literal reads the
	// Parameter at its place, so the report names what it was read as.
	it("reports no Function literal a call of the wrong shape passed", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant numbers = [1, 2, 3]

			Terminal.print(numbers::map((item) { <- item }, 5)::length()::toString())
			Terminal.print(numbers::map(5, (item) { <- item })::length()::toString())
		}`)

		expect(diagnostics.map(({ code }) => code)).toEqual([
			"no-matching-overload",
			"no-matching-overload",
		])
		expect(diagnostics[0]!.labels[0]!.message).toBe(
			"this call passes 2 Arguments: a (_: Integer) -> Integer and an Integer",
		)
	})

	// A Type Parameter bound to a blank by an earlier Argument refuses the next
	// as a write into the blank. The report explains the blank as every refusal
	// over one does.
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
		// `List<String>` is read off the `["a"]` the blank refused.
		expect(diagnostics[0]!.helps).toEqual([
			"Annotate the Declaration that creates it — 'List<String>' — so what is written into it is judged against the Type it holds.",
		])
	})

	// A Union receiver whose covering Namespace declares the Method is reported
	// against the receiver as written, naming the refused Argument as usual.
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
