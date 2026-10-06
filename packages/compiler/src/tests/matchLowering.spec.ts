import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
} from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// The stages the CLI runs, minus bundling. A Match is lowered to an `if`
// chain whose mistakes show only when it runs.
function generate(
	source: string,
	optimiserOptions: OptimiserOptions = defaultOptimiserOptions,
): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(
		optimise(simplify(enriched.program), optimiserOptions),
		optimiserOptions,
	)
}

// Imports the emitted Program from a throwaway module, which resolves because
// its imports are absolute paths into this repository's runtime.
async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-match-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

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

// For a Program that is reported on: a Warning is not an error, so it still
// compiles and runs.
function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)

	return validate(enriched.program)
}

describe("Match Lowering", () => {
	// A Record Matcher naming a Function-typed member must accept a value
	// carrying a callback there.
	describe("Record Matchers naming a Function member", () => {
		let source = (value: string) => `implementation {
			type Click = { x: Integer }
			type Handler = { fn: (_ n: Integer) -> Integer }

			constant input: Click | Handler = ${value}

			Terminal.inspect(match input -> String {
				case { x: Integer } { <- "click" }
				case { fn: (_ n: Integer) -> Integer } { <- "handler" }
			})
		}`

		it("matches the value carrying the callback", async () => {
			expect(
				await run(
					source(`{ fn = (_ n: Integer) -> Integer { <- n } }`),
				),
			).toEqual(['"handler"'])
		})

		it("still declines it for the Case that names other members", async () => {
			expect(await run(source(`{ x = 7 }`))).toEqual(['"click"'])
		})

		it("reads the matched callback inside the Handler", async () => {
			expect(
				await run(`implementation {
					type Click = { x: Integer }
					type Handler = { fn: (_ n: Integer) -> Integer }

					constant input: Click | Handler = {
						fn = (_ n: Integer) -> Integer { <- n::multiply(with 2) }
					}

					Terminal.inspect(match input -> Integer {
						case { x: Integer } { <- @.x }
						case { fn: (_ n: Integer) -> Integer } { <- @.fn(21) }
					})
				}`),
			).toEqual(["42"])
		})

		// A Signature does not survive to runtime, so a callback member only
		// answers "callable". Two Cases are told apart by their other members.
		it("tells two callback-carrying Cases apart by their other members", async () => {
			expect(
				await run(`implementation {
					type IntHandler = { fn: (_ n: Integer) -> Integer, arity: Integer }
					type StringHandler = { fn: (_ s: String) -> String, label: String }

					constant input: IntHandler | StringHandler = {
						fn = (_ s: String) -> String { <- s },
						label = "strings",
					}

					Terminal.inspect(match input -> String {
						case { fn: (_ n: Integer) -> Integer, arity: Integer } { <- "int handler" }
						case { fn: (_ s: String) -> String, label: String } { <- "string handler" }
					})
				}`),
			).toEqual(['"string handler"'])
		})

		// A Guard is joined to the Matcher's own check with an and.
		it("narrows a Guarded Case naming a callback member", async () => {
			expect(
				await run(`implementation {
					type Click = { x: Integer }
					type Handler = { fn: (_ n: Integer) -> Integer, times: Integer }

					constant input: Click | Handler = {
						fn = (_ n: Integer) -> Integer { <- n },
						times = 3,
					}

					Terminal.inspect(match input -> String {
						case { x: Integer } { <- "click" }
						case { fn: (_ n: Integer) -> Integer, times: Integer } where @.times::isGreaterThan(2) {
							<- "handler, more than twice"
						}
						case { fn: (_ n: Integer) -> Integer, times: Integer } {
							<- "handler"
						}
					})
				}`),
			).toEqual(['"handler, more than twice"'])
		})
	})

	// An Essence member name may hold characters no JavaScript identifier
	// may, such as `ok?`, so the emitted descriptor and check must quote it.
	describe("Member names JavaScript can not spell", () => {
		let source = (value: string) => `implementation {
			constant input: { ok?: Boolean } | { count: Integer } = ${value}

			Terminal.inspect(match input -> String {
				case { ok?: Boolean } { <- "flag" }
				case { count: Integer } { <- "count" }
			})
		}`

		it("matches either arm of a Union naming such a member", async () => {
			expect(await run(source(`{ ok? = true }`))).toEqual(['"flag"'])
			expect(await run(source(`{ count = 3 }`))).toEqual(['"count"'])
		})

		it("dispatches on a member Type naming one", async () => {
			expect(
				await run(`implementation {
					namespace Flag for { ok?: Boolean } {
						describe() -> String {
							<- "flag"
						}
					}

					namespace Counter for { count: Integer } {
						describe() -> String {
							<- "count"
						}
					}

					variable thing: { ok?: Boolean } | { count: Integer } = { ok? = true }

					Terminal.inspect(thing::describe())
				}`),
			).toEqual(['"flag"'])
		})

		// The check reads the member back by the key the Record literal wrote,
		// so both spell it quoted.
		it("writes the member as a quoted key in the emitted descriptor", () => {
			expect(
				generate(source(`{ ok? = true }`), {
					enabled: true,
					disabledPasses: new Set(["compile-record-members"]),
				}),
			).toContain('members: { "ok?":')
		})

		// An ordinary build emits the decision tree's check, whose read must
		// quote `ok?` too.
		it("writes the member as a quoted read in the compiled check", () => {
			expect(generate(source(`{ ok? = true }`))).toContain(
				'_self["ok?"]?.[$type.typeKeySymbol] === "Boolean"',
			)
		})
	})

	// A value no Matcher accepts must not fall off the end of the chain. See
	// "The end of the chain" in packages/compiler/src/rewriter/DEVELOPMENT.md.
	describe("Exhaustiveness fallback", () => {
		it("ends the emitted chain in an else no Handler owns", () => {
			// `elide-final-match-test` drops the fallback with the last test,
			// so it is off here. Without it, the chain ends as one whose last
			// Handler is Guarded, matches a literal, or asks what no tag answers.
			let generated = generate(
				`implementation {
					constant scrutinee: Integer | String = 5

					Terminal.inspect(match scrutinee -> String {
						case Integer { <- "an Integer" }
						case String { <- "a String" }
					})
				}`,
				{
					enabled: true,
					disabledPasses: new Set(["elide-final-match-test"]),
				},
			)

			expect(generated).toContain("$type.noCaseMatched(_self)")
		})

		it("keeps the fallback where the last Handler can decline", () => {
			// Both Union members carry the Record tag and differ only in their
			// members, so the elision does not apply even in an optimised build.
			let generated = generate(`implementation {
				constant scrutinee: { x: Integer } | { key: String } = { key = "k" }

				Terminal.inspect(match scrutinee -> String {
					case { key: String } { <- "a String" }
					case { x: Integer } { <- "a Record" }
				})
			}`)

			expect(generated).toContain("$type.noCaseMatched(_self)")
		})

		// A Handler that ran and fell off its own end must not reach the
		// fallback, so the fallback is the innermost `else`.
		it("leaves a Match in Statement position alone", async () => {
			expect(
				await run(`implementation {
					constant scrutinee: Integer | String = "text"

					match scrutinee -> {} {
						case Integer { Terminal.inspect("an Integer") }
						case String { Terminal.inspect("a String") }
					}
				}`),
			).toEqual(['"a String"'])
		})
	})

	// Types erase before a Match runs, so a Generic Matcher's check is always
	// true. A Generic Case above a concrete one swallows every value, so it is
	// refused.
	describe("Generic Cases", () => {
		let pick = (cases: string) => `implementation {
			function pick <infer Value>(
				_ candidate: Value | String,
				fallback fallbackValue: Value,
			) -> Value {
				<- match candidate -> Value {
					${cases}
				}
			}

			Terminal.inspect(pick("missing", fallback 7))
			Terminal.inspect(pick(3, fallback 7))
		}`

		it("refuses the Case a Generic Case above it swallows", () => {
			let diagnostics = diagnosticsOf(
				pick(`case Value { <- @ }
					case String { <- fallbackValue }`),
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("erased-case-conflict")
		})

		it("answers with the fallback once the Generic Case is written last", async () => {
			expect(
				await run(
					pick(`case String { <- fallbackValue }
						case Value { <- @ }`),
				),
			).toEqual(["7", "3"])
		})
	})

	// Item Types erase, so a List Matcher asks about the items a value holds.
	// An empty List fits every List Matcher and takes the first, which a
	// Warning reports.
	describe("Empty List Cases", () => {
		let arms = `implementation {
			constant empty: List<Integer> = []
			constant scrutinee: List<Integer> | List<String> = empty

			Terminal.inspect(match scrutinee -> String {
				case List<String>  { <- "took the String arm" }
				case List<Integer> { <- "took the Integer arm" }
			})
		}`

		it("reports the Case an empty List never reaches, once", () => {
			let diagnostics = diagnosticsOf(arms)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("empty-list-overlap")
		})

		it("takes the first List Case for the empty List", async () => {
			expect(await run(arms)).toEqual(['"took the String arm"'])
		})

		it("takes the Case its items belong to for every other List", async () => {
			expect(
				await run(`implementation {
					constant scrutinee: List<Integer> | List<String> = [1, 2]

					Terminal.inspect(match scrutinee -> String {
						case List<String>  { <- "took the String arm" }
						case List<Integer> { <- "took the Integer arm" }
					})
				}`),
			).toEqual(['"took the Integer arm"'])
		})
	})

	// Type Arguments erase, so a Case of a generic Choice is told from the same
	// Case of another application by its payload alone. A Warning reports the
	// Cases whose payload can not tell them apart.
	describe("Cases of two applications", () => {
		let boxes = (cases: string) => `implementation {
			choice Box<Item> {
				Full { item: Item },
				Many { items: List<Item> },
				Empty,
			}

			function describe(_ value: Box<Integer> | Box<String>) -> String {
				<- match value -> String {
					${cases}
				}
			}

			constant none: List<String> = []

			Terminal.inspect(describe(Box<String>#Empty))
			Terminal.inspect(describe(Box<String>#Many({ items = none })))
			Terminal.inspect(describe(Box<String>#Many({ items = ["a"] })))
			Terminal.inspect(describe(Box<String>#Full({ item = "a" })))
			Terminal.inspect(describe(Box<Integer>#Full({ item = 1 })))
		}`
		let byApplication = boxes(`case Box<Integer> { <- "integers" }
			case Box<String> { <- "strings" }`)

		it("reports the Case another application's Cases never reach, once", () => {
			let diagnostics = diagnosticsOf(byApplication)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("type-argument-overlap")
		})

		// The empty `Many` holds no item, and `Empty` no payload at all. A
		// `Full` holds the item that decides.
		it("takes the first application's Case where the payload can not tell", async () => {
			expect(await run(byApplication)).toEqual([
				'"integers"',
				'"integers"',
				'"strings"',
				'"strings"',
				'"integers"',
			])
		})

		// The Help's Cases, written first, answer for every application.
		it("answers each value from its own Case once the Help is followed", async () => {
			let followed = boxes(`case Box#Many { <- "many" }
				case Box#Empty { <- "empty" }
				case Box<Integer> { <- "integers" }
				case Box<String> { <- "strings" }`)

			expect(diagnosticsOf(followed)).toEqual([])
			expect(await run(followed)).toEqual([
				'"empty"',
				'"many"',
				'"many"',
				'"strings"',
				'"integers"',
			])
		})

		// A payload requirement asks its member the same erased question.
		describe("at a member", () => {
			let held = (cases: string) => `implementation {
				choice Box<Item> {
					Full { item: Item },
					Empty,
				}

				choice Holder {
					Hold { box: Box<Integer> | Box<String> },
					Nothing,
				}

				function describe(_ value: Holder) -> String {
					<- match value -> String {
						${cases}
						case #Nothing { <- "nothing" }
					}
				}

				Terminal.inspect(describe(#Hold({ box = Box<String>#Empty })))
				Terminal.inspect(describe(#Hold({ box = Box<String>#Full({ item = "a" }) })))
				Terminal.inspect(describe(#Hold({ box = Box<Integer>#Full({ item = 1 }) })))
			}`
			let byApplication =
				held(`case #Hold({ box: Box<Integer> }) { <- "integers" }
				case #Hold({ box: Box<String> }) { <- "strings" }
				case _ { <- "other" }`)

			it("reports the Case another application's Case never reaches", () => {
				expect(
					diagnosticsOf(byApplication).map(
						(diagnostic) => diagnostic.code,
					),
				).toContain("type-argument-overlap")
			})

			it("takes the first application's Case where the payload can not tell", async () => {
				expect(await run(byApplication)).toEqual([
					'"integers"',
					'"strings"',
					'"integers"',
				])
			})

			it("answers each value from its own Case once the Help is followed", async () => {
				let followed = held(`case #Hold({ box }) {
					<- match box -> String {
						case Box#Empty { <- "empty" }
						case Box<Integer> { <- "integers" }
						case Box<String> { <- "strings" }
					}
				}`)

				expect(diagnosticsOf(followed)).toEqual([])
				expect(await run(followed)).toEqual([
					'"empty"',
					'"strings"',
					'"integers"',
				])
			})
		})
	})

	// A Match on an Integer or a String is a chain of value comparisons, ending
	// in the Case for the rest. That Case proves the value is none of the named
	// ones, which a refinement's `isNot` reads. The evidence erases before the
	// chain runs.
	describe("Matches on values", () => {
		let doubledOrZero = `implementation {
			type Divisor = Integer where @::isNot(0)

			function doubled(_ d: Divisor) -> Integer {
				<- d::multiply(with 2)
			}

			function doubledOrZero(_ d: Integer) -> Integer {
				<- match d -> Integer {
					case 0 { <- 0 }

					case _ { <- doubled(@) }
				}
			}

			Terminal.inspect(doubledOrZero(21))
			Terminal.inspect(doubledOrZero(0))
		}`

		it("answers per value, with the narrowed value reaching the total operation", async () => {
			expect(await run(doubledOrZero)).toEqual(["42", "0"])
		})

		it("emits a value comparison and no trace of the evidence", () => {
			let generated = generate(doubledOrZero)

			// The refinement erases to the Integer it refines. The scrutinee is
			// exactly an Integer, so `compile-type-tests` compares the bigints
			// rather than calling the structural equality.
			expect(generated).toContain("_self.value === $pool_1.value")
			expect(generated).not.toContain("anyIs")
			expect(generated).not.toContain("Divisor")

			// A `Divisor` reaches `NonZeroInteger`'s total `multiply`, declared
			// for the same predicate. Only the unoptimised build names the
			// Namespace.
			let unoptimised = generate(doubledOrZero, {
				enabled: false,
				disabledPasses: new Set(),
			})

			expect(unoptimised).toContain("NonZeroInteger.multiply")
			expect(unoptimised).not.toContain("Divisor")

			// With the Optimiser on, `lower-scalar-operations` writes the
			// product as a bigint multiplication, as it does for `Integer`.
			expect(generated).not.toContain("NonZeroInteger.multiply")
			expect(generated).toContain("value: d.value * $pool_0.value")
		})

		// Every value reaching the last Handler is an Integer, so the elision
		// applies, and the chain ends in the Handler.
		it("ends the emitted chain in the Case for the rest", () => {
			expect(generate(doubledOrZero)).not.toContain(
				"$type.noCaseMatched(_self)",
			)
		})
	})
})
