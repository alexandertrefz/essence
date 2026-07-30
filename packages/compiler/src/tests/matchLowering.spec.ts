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

// NOTE: The same stages the CLI runs, minus bundling — a Match is lowered to
// an emitted `if` chain, and both halves of what it does wrong are only
// visible once that chain RUNS, so these go all the way through.
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

// NOTE: Writes the emitted Program to a throwaway module and imports it so its
// top-level `__print` calls run. The emitted imports are absolute paths into
// this repo's runtime, so the module resolves from anywhere; `console.log` is
// captured to collect the output, then restored.
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

// NOTE: The counterpart for a Program that is supposed to be reported on —
// a Warning is not an error, so the Program still compiles and still runs.
function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)

	return validate(enriched.program)
}

describe("Match Lowering", () => {
	// NOTE: Regression tests — a Record Matcher naming a Function-typed member
	// lowered to a runtime check that could never answer true, because the
	// Function descriptor reached `isValueOfType`'s "not implemented" branch:
	// it printed a line of Compiler prose into the Program's own output and
	// answered false. Every Handler of an exhaustive Match declined, the
	// emitted chain fell off its end, and the Match answered `undefined` —
	// which `__print` then read a Type key off, so a Program that compiled
	// green died with a `TypeError` naming the runtime's internals.
	describe("Record Matchers naming a Function member", () => {
		let source = (value: string) => `implementation {
			type Click = { x: Integer }
			type Handler = { fn: (_ n: Integer) -> Integer }

			constant input: Click | Handler = ${value}

			__print(match input -> String {
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

					__print(match input -> Integer {
						case { x: Integer } { <- @.x }
						case { fn: (_ n: Integer) -> Integer } { <- @.fn(21) }
					})
				}`),
			).toEqual(["42"])
		})

		// NOTE: A Signature does not survive to runtime, so a callback member
		// only ever answers "callable" — two Cases are told apart by the OTHER
		// members they name, and a pair that names nothing else is reported as
		// unreachable rather than silently taking the first branch.
		it("tells two callback-carrying Cases apart by their other members", async () => {
			expect(
				await run(`implementation {
					type IntHandler = { fn: (_ n: Integer) -> Integer, arity: Integer }
					type StringHandler = { fn: (_ s: String) -> String, label: String }

					constant input: IntHandler | StringHandler = {
						fn = (_ s: String) -> String { <- s },
						label = "strings",
					}

					__print(match input -> String {
						case { fn: (_ n: Integer) -> Integer, arity: Integer } { <- "int handler" }
						case { fn: (_ s: String) -> String, label: String } { <- "string handler" }
					})
				}`),
			).toEqual(['"string handler"'])
		})

		// NOTE: A Guard is ANDed onto the Matcher's own check, so a Matcher
		// that never answered true made the Guard unreachable too.
		it("narrows a Guarded Case naming a callback member", async () => {
			expect(
				await run(`implementation {
					type Click = { x: Integer }
					type Handler = { fn: (_ n: Integer) -> Integer, times: Integer }

					constant input: Click | Handler = {
						fn = (_ n: Integer) -> Integer { <- n },
						times = 3,
					}

					__print(match input -> String {
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

	// NOTE: Regression tests — an Essence identifier may hold characters no
	// JavaScript IdentifierName may, and a Matcher's Record members reached the
	// emitted Type descriptor as bare Identifiers, so `case { ok?: Boolean }`
	// emitted `members: { ok?: … }`. Nothing in the Compiler objected: the
	// Program type-checked clean, the only stage that ever parsed the emitted
	// JavaScript was the bundler, and all it could say was that bundling had
	// failed.
	describe("Member names JavaScript can not spell", () => {
		let source = (value: string) => `implementation {
			constant input: { ok?: Boolean } | { count: Integer } = ${value}

			__print(match input -> String {
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

					__print(thing::describe())
				}`),
			).toEqual(['"flag"'])
		})

		// NOTE: The descriptor and the Record literal have to spell the name
		// the same way — `isValueOfType` reads the member back off the value by
		// the key the literal wrote — so the quoted form is pinned here rather
		// than left to whichever of the two the emitted JavaScript happens to
		// parse.
		it("writes the member as a quoted key in the emitted descriptor", () => {
			expect(generate(source(`{ ok? = true }`))).toContain(
				'members: { "ok?":',
			)
		})
	})

	// NOTE: Regression test — the emitted chain used to simply END after the
	// last Handler. Nothing answered for a value no Matcher accepted: the
	// wrapper returned `undefined`, which is not an Essence value at all, so
	// the Program failed later and elsewhere, in whatever read the missing
	// Type key next.
	describe("Exhaustiveness fallback", () => {
		it("ends the emitted chain in an else no Handler owns", () => {
			// NOTE: Asked with `elide-final-match-test` off, because that pass
			// is the considered decision to give this up: it proves the last
			// Handler is what the end of the chain IS, so the fallback goes
			// with its test. What is pinned here is what the chain ends in when
			// no such proof has been taken — which is every Match whose last
			// Handler is Guarded, matches a literal, or asks something no tag
			// answers.
			let generated = generate(
				`implementation {
					constant scrutinee: Integer | String = 5

					__print(match scrutinee -> String {
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
			// NOTE: A Record Matcher asks about members rather than a tag, so
			// the elision does not apply and the chain ends where it always
			// did — under the ordinary, fully optimised build.
			let generated = generate(`implementation {
				constant scrutinee: { x: Integer } | String = "text"

				__print(match scrutinee -> String {
					case String { <- "a String" }
					case { x: Integer } { <- "a Record" }
				})
			}`)

			expect(generated).toContain("$type.noCaseMatched(_self)")
		})

		// NOTE: A Match written for its effects promises the unit Type, `{}`,
		// and its Handlers answer nothing useful, so the fallback has to be the
		// innermost `else` rather than a Statement after the chain — a Handler
		// that RAN and fell off its own end must not reach it.
		it("leaves a Match in Statement position alone", async () => {
			expect(
				await run(`implementation {
					constant scrutinee: Integer | String = "text"

					match scrutinee -> {} {
						case Integer { __print("an Integer") }
						case String { __print("a String") }
					}
				}`),
			).toEqual(['"a String"'])
		})
	})

	// NOTE: Regression tests — Types erase before a Match runs, so the check
	// emitted for a Generic Matcher is unconditionally true. A Generic Case
	// written above a concrete one therefore swallowed every value, and neither
	// the Enricher nor the Validator said so: `pick("missing", fallback 7)`
	// compiled with no Diagnostic at all and answered the String, where its own
	// Signature promised a `Value`.
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

			__print(pick("missing", fallback 7))
			__print(pick(3, fallback 7))
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

	// NOTE: Regression tests — item Types erase before a Match runs, so a List
	// Matcher asks about the items the value HOLDS. An empty List holds none
	// and fits every List Matcher there is, so an empty `List<Integer>` takes
	// the `case List<String>` written above it. The Program compiled without a
	// single Diagnostic while doing it; it is a Warning now, and this pins the
	// behaviour the Warning is about.
	describe("Empty List Cases", () => {
		let arms = `implementation {
			constant empty: List<Integer> = []
			constant scrutinee: List<Integer> | List<String> = empty

			__print(match scrutinee -> String {
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

					__print(match scrutinee -> String {
						case List<String>  { <- "took the String arm" }
						case List<Integer> { <- "took the Integer arm" }
					})
				}`),
			).toEqual(['"took the Integer arm"'])
		})
	})

	// NOTE: A Match on an Integer or a String takes the VALUE apart, and there is
	// no Union under it — so what the Handlers are is a chain of value
	// comparisons ending in the one Case that answers for the rest. That last Case
	// is also evidence: reaching it proves the value is none of the values named
	// above, which is the `isNot` a refinement is declared by. None of that runs —
	// the evidence erases and the chain is the one someone would have written
	// without it, which is why this goes all the way through.
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

			__print(doubledOrZero(21))
			__print(doubledOrZero(0))
		}`

		it("answers per value, with the narrowed value reaching the total operation", async () => {
			expect(await run(doubledOrZero)).toEqual(["42", "0"])
		})

		it("emits a value comparison and no trace of the evidence", () => {
			let generated = generate(doubledOrZero)

			// NOTE: A literal Matcher is a value comparison rather than a Type
			// check, and the refinement is not a Type the emitted Program has ever
			// heard of — it erases to the Integer it refines, which is the same
			// object built by the same constructor.
			expect(generated).toContain("anyIs")
			expect(generated).not.toContain("Divisor")

			// NOTE: What the product DOES name is `NonZeroInteger`, and that is a
			// Namespace rather than a Type — the standard library declares one for
			// exactly this predicate, so a `Divisor` is answered by the total
			// `multiply` written for it. A Namespace name is emitted text like
			// every other Namespace's; the refinement above is not emitted at all.
			expect(generated).toContain("NonZeroInteger.multiply")
		})

		// NOTE: The last Handler of such a Match asks a tag question — every value
		// reaching it is an Integer — so the elision applies exactly as it does to a
		// Union's last Case, and the chain ends in the Handler rather than in the
		// throw.
		it("ends the emitted chain in the Case for the rest", () => {
			expect(generate(doubledOrZero)).not.toContain(
				"$type.noCaseMatched(_self)",
			)
		})
	})
})
