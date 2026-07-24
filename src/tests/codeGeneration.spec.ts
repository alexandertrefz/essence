import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type * as estree from "estree"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	loadStdlib,
	loadStdlibFrom,
	parseStdlibSource,
} from "../enricher/stdlib"
import type { common } from "../interfaces/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import {
	essenceMethodReferences,
	reachableEssenceMethods,
	rewrite,
} from "../rewriter/index"
import {
	buildStdlibPrelude,
	essenceMethodIdentifier,
	essenceMethodName,
	stdlibPrelude,
} from "../rewriter/stdlibPrelude"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: Runs the same stages the CLI runs, minus bundling — enough to assert
// on the shape of the emitted JavaScript without touching the file system.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

// NOTE: Emits the Program, writes it to a throwaway module and imports it so
// its top-level `__print` calls run. The emitted imports are absolute paths
// into this repo's runtime, so the module resolves from anywhere; `console.log`
// is captured to collect the output, then restored.
async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-e2e-"))
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

// NOTE: The counterpart for cases that are supposed to be rejected — returns
// whatever the first failing stage reported instead of asserting success.
function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return parsed.diagnostics
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		return enriched.diagnostics
	}

	return validate(enriched.program)
}

function hasCode(
	diagnostics: Array<common.Diagnostic>,
	code: common.DiagnosticCode,
): boolean {
	return diagnostics.some((diagnostic) => diagnostic.code === code)
}

describe("Code Generation", () => {
	describe("Match", () => {
		// NOTE: Regression test — the Handlers used to be folded into the
		// if/else cascade in a way that only kept the first and the last, so
		// every Match with more than two Handlers silently dropped the ones in
		// between and fell through to `undefined`.
		it("emits every Handler of a Match", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Rational | String | Nothing = nothing

					__print(match value -> String {
						case Integer  { <- "handled integer" }
						case Rational { <- "handled rational" }
						case String   { <- "handled string" }
						case Nothing  { <- "handled nothing" }
					})
				}
			`)

			expect(generated).toContain("handled integer")
			expect(generated).toContain("handled rational")
			expect(generated).toContain("handled string")
			expect(generated).toContain("handled nothing")
		})

		it("nests the Handlers so that each one is the alternate of the last", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Rational | Nothing = nothing

					__print(match value -> String {
						case Integer  { <- "a" }
						case Rational { <- "b" }
						case Nothing  { <- "c" }
					})
				}
			`)

			// NOTE: Three Handlers produce one `if` plus two `else` branches.
			expect(generated.split("else").length - 1).toBe(2)
		})

		// NOTE: Regression test — a Union Matcher used to be serialised with
		// `Object.entries`, which turned its member list into `{ 0: …, 1: … }`
		// and left the runtime Type check calling Array Methods on an Object.
		it("serialises the member list of a Union Matcher as an Array", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Rational | Nothing = nothing

					__print(match value -> String {
						case Integer | Rational { <- "number" }
						case Nothing            { <- "nothing" }
					})
				}
			`)

			expect(generated).toContain("types: [")
			expect(generated).not.toContain("types: {")
		})

		it("emits a wildcard Handler alongside the Handlers before it", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Rational | Nothing = nothing

					__print(match value -> String {
						case Nothing { <- "handled nothing" }
						case _       { <- "handled the rest" }
					})
				}
			`)

			expect(generated).toContain("handled nothing")
			expect(generated).toContain("handled the rest")
		})
	})

	describe("Match Wildcards", () => {
		// NOTE: The point of resolving a wildcard to the still-unhandled
		// members rather than to Unknown — `@` has to keep a Type precise
		// enough to call Methods on and to return where a member Type is
		// expected.
		it("narrows @ inside a wildcard to the unhandled members", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: Integer | Nothing = 5

						__print(match value -> Integer {
							case Nothing { <- 0 }
							case _       { <- @::multiply(with 2) }
						})
					}
				`),
			).not.toThrow()
		})

		it("accepts a wildcard as the only Handler", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: Integer | Nothing = 5

						__print(match value -> String {
							case _ { <- "anything" }
						})
					}
				`),
			).not.toThrow()
		})
	})

	describe("Match Literals and Guards", () => {
		it("compares by value for a literal Matcher", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Nothing = 0

					__print(match value -> String {
						case 0       { <- "zero" }
						case Integer { <- "other" }
						case Nothing { <- "nothing" }
					})
				}
			`)

			// NOTE: A literal Matcher is a value comparison, not a Type check
			// — `anyIs` is already false across differing Types, so it needs
			// no `isValueOfType` in front of it.
			expect(generated).toContain("anyIs")
		})

		it("ands a Guard onto the check its Matcher produced", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Nothing = 1

					__print(match value -> String {
						case Integer where @::isGreaterThan(0) { <- "positive" }
						case Integer                           { <- "other" }
						case Nothing                           { <- "nothing" }
					})
				}
			`)

			expect(generated).toContain("&&")
		})

		// NOTE: The rule both features share — a Handler that can decline a
		// value it Type-matched cannot make the Union exhaustive.
		it("does not let a literal Matcher discharge its Type", () => {
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: Integer | Nothing = 0

					__print(match value -> String {
						case 0       { <- "zero" }
						case Nothing { <- "nothing" }
					})
				}
			`)

			expect(hasCode(diagnostics, "missing-case")).toBe(true)
		})

		it("does not let a Guard discharge its Type", () => {
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: Integer | Nothing = 1

					__print(match value -> String {
						case Integer where @::isGreaterThan(0) { <- "positive" }
						case Nothing                           { <- "nothing" }
					})
				}
			`)

			expect(hasCode(diagnostics, "missing-case")).toBe(true)
		})

		it("leaves a literal's Type in the residual of a later wildcard", () => {
			// NOTE: `case 0` catches one Integer, so `@` inside the wildcard is
			// still Integer|Nothing — calling an Integer Method on it has to
			// stay an error.
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: Integer | Nothing = 1

					__print(match value -> Integer {
						case 0 { <- 0 }
						case _ { <- @::multiply(with 2) }
					})
				}
			`)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		it("narrows the wildcard once every other Type is unconditionally handled", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: Integer | Nothing = 1

						__print(match value -> Integer {
							case Nothing { <- 0 }
							case 0       { <- 0 }
							case _       { <- @::multiply(with 2) }
						})
					}
				`),
			).not.toThrow()
		})
	})

	describe("Record Matchers", () => {
		// NOTE: Regression test — matching a Record used to fall through the
		// runtime Type check entirely, so `case { a: Integer }` compiled
		// cleanly and then never matched anything.
		it("matches a Record structurally", () => {
			let generated = generate(`
				implementation {
					variable value: { a: Integer } | Nothing = { a = 1 }

					__print(match value -> String {
						case { a: Integer } { <- "record" }
						case Nothing        { <- "nothing" }
					})
				}
			`)

			expect(generated).toContain("record")
			expect(generated).toContain("nothing")
		})

		it("compares a value-constrained member by value", () => {
			let generated = generate(`
				implementation {
					variable value: { a: Integer, b: Integer } | Nothing = { a = 6, b = 2 }

					__print(match value -> String {
						case { a = 6, b: Integer } { <- "six" }
						case { a: Integer }        { <- "record" }
						case Nothing               { <- "nothing" }
					})
				}
			`)

			expect(generated).toContain("anyIs")
		})

		it("types @ as the Record so its members can be read", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: { a: Integer, b: Integer } | Nothing = { a = 6, b = 7 }

						__print(match value -> Integer {
							case { a = 6, b: Integer } { <- @.b }
							case { a: Integer }        { <- @.a }
							case Nothing               { <- 0 }
						})
					}
				`),
			).not.toThrow()
		})

		it("does not let a value-constrained Record discharge its Type", () => {
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: { a: Integer } | Nothing = { a = 6 }

					__print(match value -> String {
						case { a = 6 }  { <- "six" }
						case Nothing    { <- "nothing" }
					})
				}
			`)

			expect(hasCode(diagnostics, "missing-case")).toBe(true)
		})

		it("lets a purely Type-constrained Record discharge its Type", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: { a: Integer } | Nothing = { a = 6 }

						__print(match value -> String {
							case { a: Integer } { <- "record" }
							case Nothing        { <- "nothing" }
						})
					}
				`),
			).not.toThrow()
		})
	})

	describe("Nameless Parameters", () => {
		it("gives every nameless Parameter its own emitted name", () => {
			let generated = generate(`
				implementation {
					function f(_: Integer, _: String, _: Boolean) -> Integer {
						<- 1
					}

					__print(f(1, "a", true))
				}
			`)

			// NOTE: Distinct placeholders — two Parameters sharing a name
			// would be a redeclaration in the emitted Function.
			expect(generated).toContain("_0")
			expect(generated).toContain("_1")
			expect(generated).toContain("_2")
		})

		// NOTE: The reason the form is worth having — in a Function Type there
		// is no body, so a Parameter name could never be referred to anyway.
		it("accepts a nameless Parameter in a Function Type", () => {
			expect(() =>
				generate(`
					implementation {
						function apply(_ transform: (_: Integer) -> String) -> String {
							<- transform(1)
						}

						__print(apply((_ value: Integer) -> String {
							<- value::toString()
						}))
					}
				`),
			).not.toThrow()
		})
	})

	describe("String Methods", () => {
		// NOTE: String gained Comparable, so a List of Strings sorts with a
		// real comparator — this pins that `compareTo` resolves on the String
		// receiver and the whole pipeline emits.
		it("sorts a List of Strings through String.compareTo", () => {
			let generated = generate(`
				implementation {
					__print(["b", "a"]::sort(by 
						(first, second) { <- first::compareTo(second) },
					))
				}
			`)

			expect(generated).toContain("List.sort__overload$2(")
			expect(generated).toContain("String.compareTo__overload$1(")
		})
	})

	describe("Higher-order List Methods", () => {
		// NOTE: `map`/`reduce` are the first builtins with a Method-level
		// Generic and the first to take a contextually typed callback all the
		// way through codegen. This pins the emitted call and that the callback
		// became a plain JS closure.
		it("emits map with an inferred callback", () => {
			let generated = generate(`
				implementation {
					__print([1, 2]::map((n) { <- n::toString() }))
				}
			`)

			expect(generated).toContain("List.map(")
			expect(generated).toContain("Integer.toString(")
		})

		it("emits reduce with its starting value and callback", () => {
			let generated = generate(`
				implementation {
					__print([1, 2]::reduce(
						startingWith 0,
						(total, n) { <- total::add(n) },
					))
				}
			`)

			expect(generated).toContain("List.reduce(")
			expect(generated).toContain("Integer.add__overload$1(")
		})
	})

	describe("Contextual Function literals", () => {
		// NOTE: The whole point is that the inferred Parameter Type reaches
		// the body's Scope. `isGreaterThan` is overloaded, so the emitted
		// `__overload$1` is only chosen if `item` really resolved to an
		// Integer — a weaker assertion would pass even if the body had been
		// typed as an Error.
		it("types the body from the inferred Parameter", () => {
			let generated = generate(`
				implementation {
					__print([1, 2, 3]::removeEvery(
						where (item) { <- item::isGreaterThan(2) },
					))
				}
			`)

			expect(generated).toContain("removeEvery__overload$2")
			expect(generated).toContain("isGreaterThan__overload$1")
		})

		it("emits the same JavaScript however the literal was written", () => {
			let annotated = generate(`
				implementation {
					__print([1, 2, 3]::removeEvery(
						where (_ item: Integer) -> Boolean { <- item::isGreaterThan(2) },
					))
				}
			`)

			let inferred = generate(`
				implementation {
					__print([1, 2, 3]::removeEvery(
						where (item) { <- item::isGreaterThan(2) },
					))
				}
			`)

			expect(inferred).toBe(annotated)
		})
	})

	describe("Protocols", () => {
		it("should erase Protocol declarations from the emitted JavaScript", () => {
			const code = generate(`implementation {
				protocol Showable {
					toString() -> String
				}

				__print("done")
			}`)

			expect(code).not.toContain("Showable")
			expect(code).not.toContain("toString")
		})

		it("should pass a conformance value at bounded invocations", () => {
			const code = generate(`implementation {
				protocol Showable {
					toString() -> String
				}

				type Vector = { x: Number, y: Number }

				namespace VectorShowable for Vector is Showable {
					toString() -> String {
						<- "vector"
					}
				}

				function describeValue <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				__print(describeValue({ x = 1, y = 2 }))
			}`)

			// NOTE: The bounded Function gains a hidden trailing parameter, its
			// body dispatches through it, and the call site packages the
			// conforming Namespace's Methods into an object literal.
			expect(code).toContain("Value__conformance")
			expect(code).toContain("VectorShowable.toString")
			expect(code).toContain("Value__conformance.toString(")
		})

		it("should package builtin Namespace Methods into conformance values", () => {
			const code = generate(`implementation {
				function smaller <infer Item is Comparable>(_ a: Item, _ b: Item) -> Item {
					<- match a::compareTo(b) -> Item {
						case #Less    { <- a }
						case #Equal   { <- a }
						case #Greater { <- b }
					}
				}

				__print(smaller(5, 3))
			}`)

			expect(code).toContain("compareTo: Integer.compareTo")
			expect(code).toContain("Item__conformance.compareTo(")
		})

		it("should forward a conformance parameter between bounded Functions", () => {
			const code = generate(`implementation {
				protocol Showable {
					toString() -> String
				}

				type Vector = { x: Number, y: Number }

				namespace VectorShowable for Vector is Showable {
					toString() -> String {
						<- "vector"
					}
				}

				function inner <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				function outer <infer Item is Showable>(_ item: Item) -> String {
					<- inner(item)
				}

				__print(outer({ x = 1, y = 2 }))
			}`)

			expect(code).toContain("inner(item, Item__conformance)")
		})

		it("should keep a flat witness a plain object literal", () => {
			const code = generate(`implementation {
				constant ordered: List<Integer> = [3, 1, 2]::sort()
			}`)

			// NOTE: An unconditional witness stays exactly the method-map object
			// literal — no `boundConformance` wrapper. `Integer.compareTo` is
			// native, so the witness is a plain member read.
			expect(code).toContain("compareTo: Integer.compareTo")
			expect(code).not.toContain("boundConformance")
		})

		it("should wrap a nested witness in boundConformance", () => {
			const code = generate(`implementation {
				constant ordered = [[1, 2], [3]]::sort()
			}`)

			// NOTE: `List<List<Integer>>` sorts through List's own `compareTo`,
			// curried with the inner Integer ordering — the conditional witness.
			expect(code).toContain("$type.boundConformance(")
			expect(code).toContain("compareTo: List.compareTo")
			expect(code).toContain("compareTo: Integer.compareTo")
		})

		it("should order multiple retrofitted bounds by Namespace Generic declaration", () => {
			const code = generate(`implementation {
				namespace Pair<infer Key, infer Value> for { key: Key, value: Value }
					is Comparable where Key is Comparable, Value is Comparable
				{
					compareTo(_ other: { key: Key, value: Value }) -> Ordering {
						constant keyOrder = @.key::compareTo(other.key)
						constant valueOrder = @.value::compareTo(other.value)
						<- match keyOrder -> Ordering {
							case #Equal { <- valueOrder }
							case _ { <- keyOrder }
						}
					}
				}

				constant a = { key = 1, value = "x" }
				constant b = { key = 1, value = "y" }
				__print(a::compareTo(b))
			}`)

			// NOTE: R7 — the hidden conformance Parameters follow the Namespace's
			// Generic declaration order (Key, then Value), and the call site's
			// witnesses appear in that same order so they line up.
			expect(code).toContain(
				"compareTo(_self, other, Key__conformance, Value__conformance)",
			)
			expect(code).toContain(
				"Key__conformance.compareTo(_self.key, other.key)",
			)
			expect(code).toContain(
				"Value__conformance.compareTo(_self.value, other.value)",
			)
		})
	})

	// NOTE: A user's `overload` block defines every Overload itself, so the
	// emitted names run 1, 2, 3 in written order — the same numbering the call
	// site resolves against the Method Type. Only the Namespaces the standard
	// library declares can leave a gap, where a native holds the slot.
	describe("Overload Numbering", () => {
		it("should number a Namespace's own Overloads in written order", async () => {
			const source = `implementation {
				namespace Greeter for String {
					overload greet {
						() -> String { <- @::append("!") }
						(_ other: String) -> String { <- @::append(other) }
					}
				}

				__print("hello"::greet())
				__print("hello"::greet(" world"))
			}`

			const code = generate(source)

			expect(code).toContain("greet__overload$1")
			expect(code).toContain("greet__overload$2")
			expect(code).not.toContain("greet__overload$3")

			expect(await run(source)).toEqual(['"hello!"', '"hello world"'])
		})
	})

	describe("Union Method Dispatch", () => {
		it("should emit a runtime dispatch with one statically resolved target per member", () => {
			const code = generate(`implementation {
				constant value: Integer | Boolean = 5

				__print(value::toString())
			}`)

			expect(code).toContain("$type.dispatchMethod")
			// NOTE: One target per member, and the two are spelled differently
			// on purpose — `Integer.toString` is native, a member read off the
			// plain import, while `Boolean.toString` is Essence and so is its
			// own const. Dispatch does not care which.
			expect(code).toContain("Integer.toString")
			expect(code).toContain("$es_Boolean_toString")
		})

		it("should mangle overloaded Method names per dispatch case", () => {
			const code = generate(`implementation {
				constant number: Number = 5

				__print(number::multiply(with 2)::toString())
			}`)

			expect(code).toContain("Integer.multiply__overload$")
			expect(code).toContain("Rational.multiply__overload$")
		})

		// NOTE: `firstItem()` returns `Item | Nothing`, so `toString` dispatches
		// over a Union — the `Item` case through the conformance witness, the
		// `Nothing` case to `Nothing.toString`, which is implemented in Essence.
		// This is the Union-dispatch-to-an-Essence-Method path: the case target
		// is the bare `$es_Nothing_toString`, and the reachability gate has to
		// pull that const in off the emitted dispatch triple for the Program to
		// run.
		it("should dispatch a bounded Type Parameter member through the conformance parameter", async () => {
			const source = `implementation {
				function firstText <infer Item is Printable>(_ items: List<Item>) -> String {
					<- items::firstItem()::toString()
				}

				__print(firstText([1, 2]))
			}`
			const code = generate(source)

			expect(code).toContain("$type.dispatchMethod")
			expect(code).toContain("$es_Nothing_toString")
			expect(code).toContain("const $es_Nothing_toString")
			expect(code).toContain("Item__conformance.toString")
			expect(await run(source)).toEqual(['"1"'])
		})

		it("should order the catch-all Type Parameter case last", () => {
			const code = generate(`implementation {
				function firstText <infer Item is Printable>(_ items: List<Item>) -> String {
					<- items::firstItem()::toString()
				}

				__print(firstText([1, 2]))
			}`)

			expect(code.indexOf("$es_Nothing_toString")).toBeGreaterThan(-1)
			expect(code.indexOf("$es_Nothing_toString")).toBeLessThan(
				code.indexOf("Item__conformance.toString"),
			)
		})

		it("should emit member Namespaces of a user Union as call targets", () => {
			const code = generate(`implementation {
				namespace IntegerTag for Integer {
					tag() -> String {
						<- "integer"
					}
				}

				namespace BooleanTag for Boolean {
					tag() -> String {
						<- "boolean"
					}
				}

				constant value: Integer | Boolean = 5

				__print(value::tag())
			}`)

			expect(code).toContain("IntegerTag.tag")
			expect(code).toContain("BooleanTag.tag")
		})
	})

	describe("Conditional Conformance", () => {
		it("runs List's is and toString through bounded generic Functions", async () => {
			let output = await run(`implementation {
				function stringify <infer Value is Printable>(_ value: Value) -> String {
					<- value::toString()
				}

				function same <infer Value is Equatable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::is(b)
				}

				__print(stringify([1, 2, 3]))
				__print(same([1, 2], [1, 2])::toString())
				__print(same([1, 2], [3, 4])::toString())
			}`)

			expect(output).toEqual(['"[ 1, 2, 3 ]"', '"true"', '"false"'])
		})
	})

	// NOTE: A standard library Namespace may be half native and half Essence.
	// The prelude is what hides that from everything downstream: the runtime
	// module is imported under `$native_<Name>` and spread into a const that
	// carries the Namespace's own name, with the Essence-implemented Methods on
	// top. `Boolean.isNot` is the first Method to have made the trip.
	describe("Essence Method Names", () => {
		it("names a Method the standard library implements in Essence", () => {
			// NOTE: `Boolean.isNot` and `Number.isBetween` are the two Methods
			// with an Essence body today.
			expect(essenceMethodName("Boolean", "isNot")).toBe(
				"$es_Boolean_isNot",
			)
			expect(essenceMethodName("Number", "isBetween")).toBe(
				"$es_Number_isBetween",
			)
		})

		it("returns null for a native Method", () => {
			// NOTE: `Boolean.negate` is bound to the runtime module, so it stays
			// a member read and has no top-level const.
			expect(essenceMethodName("Boolean", "negate")).toBeNull()
			expect(essenceMethodName("String", "append")).toBeNull()
		})

		it("returns null for a native static Property", () => {
			// NOTE: The lookup keys on Methods only. `Number.PI` is a Property
			// and reaches a call site through a member read, never a const.
			expect(essenceMethodName("Number", "PI")).toBeNull()
		})

		it("keeps an overload's mangled suffix in the name", () => {
			expect(essenceMethodIdentifier("Number", "sum__overload$2")).toBe(
				"$es_Number_sum__overload$2",
			)
		})
	})

	describe("Reserved-word identifiers", () => {
		// NOTE: A JavaScript reserved word — `new`, `default`, `delete` — is a
		// legal Essence identifier, so a Constant or Parameter can be named one.
		// Emitting it verbatim produced invalid JavaScript (`const new = …`,
		// `function (…, default)`) that died at runtime; it is now escaped with a
		// `_` prefix, which no Essence identifier can contain.

		it("escapes a reserved word as a Constant, at binding and reference", () => {
			let generated = generate(`
				implementation {
					constant new = 5

					__print(new::toString())
				}
			`)

			expect(generated).toContain("_new")
			// The bare reserved word never appears as a binding or a reference.
			expect(generated).not.toMatch(/\bconst new\b/)
			expect(generated).not.toMatch(/\(new\)/)
		})

		it("compiles and runs a reserved word as a Constant", async () => {
			expect(
				await run(`
					implementation {
						constant new = 5
						variable delete = 10

						delete = delete::add(new)

						__print(delete::toString())
					}
				`),
			).toEqual([`"15"`])
		})

		it("compiles and runs a reserved word as a Parameter — the original bug", async () => {
			expect(
				await run(`
					implementation {
						function pick(_ default: Integer, or fallback: Integer) -> Integer {
							<- default::add(fallback)
						}

						__print(pick(3, or 4)::toString())
					}
				`),
			).toEqual([`"7"`])
		})

		it("keeps a reserved word verbatim as a Record field", async () => {
			// NOTE: The counterpart guard — a member/property name is NOT escaped,
			// because a reserved word is legal as a property key and the read has
			// to match the key the record literal wrote.
			expect(
				await run(`
					implementation {
						constant thing = { new = 1, default = 2 }

						__print(thing.new::add(thing.default)::toString())
					}
				`),
			).toEqual([`"3"`])
		})
	})

	describe("Standard Library Prelude", () => {
		it("emits an Essence-implemented Method as its own const", () => {
			const code = generate(`implementation {
				__print(true::isNot(false))
			}`)

			// NOTE: The Namespace is imported under its own name — no `$native_`
			// alias, no merged const — and the one Essence Method is a top-level
			// const beside it. The native half stays a member read off the plain
			// import, which is what keeps it tree-shakeable.
			expect(code).toContain('import * as Boolean from "')
			expect(code).not.toContain("$native_Boolean")
			expect(code).not.toContain("const Boolean = {")
			expect(code).toContain(
				"const $es_Boolean_isNot = function (_self, other) {",
			)

			// NOTE: Every other Namespace is wholly native, so it keeps the plain
			// import and gains no const.
			expect(code).toContain('import * as String from "')
			expect(code).not.toContain("$es_String_")
		})

		// NOTE: The const's body names other Namespaces — `isNot` calls
		// `Boolean.is` and `Boolean.negate`, both natives, so both are plain
		// member reads off the runtime module the plain import binds.
		it("emits a body that reads the natives off the runtime module", () => {
			const code = generate(`implementation {
				__print(true::isNot(false))
			}`)

			expect(code).toContain(
				"return Boolean.negate(Boolean.is(_self, other));",
			)
		})

		// NOTE: An unused const is not free — it still names the runtime Methods
		// its body reaches, and once a module is in the graph its impure
		// top-level initialisers can not be dropped — so a Program that never
		// names the Method must not get its const. The plain import stays and,
		// unreferenced, the Bundler shakes it away.
		it("emits no const for a Method the Program never names", () => {
			const code = generate(`implementation {
				__print("hello")
			}`)

			expect(code).not.toContain("$es_Boolean_isNot")
			expect(code).toContain('import * as Boolean from "')
		})

		// NOTE: The gate runs over the FINISHED tree, after generation, which is
		// the only place a conformance witness, a `dispatchMethod` target and a
		// plain call all look alike — they are `Identifier` nodes. A survey of
		// the source would have to know every one of those shapes.
		it("finds a Method named only through a conformance witness", () => {
			const code = generate(`implementation {
				function differ <infer Value is Equatable>(_ a: Value, _ b: Value) -> String {
					<- a::isNot(b)::toString()
				}

				constant yes = true

				__print(differ(yes, yes))
			}`)

			expect(code).toContain("isNot: $es_Boolean_isNot")
			expect(code).toContain("const $es_Boolean_isNot")
		})

		// NOTE: A dotted member name is text, not a reference — a Record whose
		// member is spelled like a Namespace must stay a plain member read, never
		// be mistaken for an Essence Method and rewritten to a bare `$es_…`
		// Identifier. `rewriteLookup` routes a Record field through the same
		// funnel as a static Method, so this is that funnel's guard.
		it("does not mistake a member name for a reference", () => {
			const code = generate(`implementation {
				constant record = { Boolean = "not the Namespace" }

				__print(record.Boolean)
			}`)

			expect(code).toContain("record.Boolean")
			expect(code).not.toContain("$es_")
		})

		// NOTE: The regression is the merged const, whose whole cost was the
		// spread that materialised a module namespace object — `{ ...Number, … }`,
		// whether the spread names `$native_Number` (the old shape) or the bare
		// `Number` import. No emitted Program spreads anything at all today, so an
		// object literal opening with a spread names the mechanism directly, where
		// the bundle-size ceilings catch it arriving by any other route.
		// `Everyday.es` reaches an Essence Method AND a large runtime module, the
		// exact shape that used to spread.
		it("never spreads a runtime module", () => {
			const source = readFileSync(
				join(import.meta.dir, "../..", "testFiles/Everyday.es"),
				{ encoding: "utf-8" },
			)

			expect(generate(source)).not.toMatch(/\{\s*\.\.\./)
		})

		// NOTE: The `$es_` prefix can not collide with a user identifier because
		// `_` is a Lexer Symbol — no user name contains one. `$esBooleanisNot` is
		// the closest a user can write, and it must survive as its own distinct
		// binding alongside the Rewriter's `$es_Boolean_isNot`.
		it("keeps a user identifier near the prefix distinct", async () => {
			const source = `implementation {
				constant $esBooleanisNot = "mine"

				__print($esBooleanisNot::append(true::isNot(false)::toString()))
			}`

			const code = generate(source)

			expect(code).toContain("$esBooleanisNot")
			expect(code).toContain("$es_Boolean_isNot")
			expect(await run(source)).toEqual(['"minetrue"'])
		})

		it("runs isNot from its const", async () => {
			expect(
				await run(`implementation {
					__print(false::isNot(true)::toString())
					__print(true::isNot(true)::toString())
					__print(false::isNot(false)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"false"'])
		})

		// NOTE: The conformance witness reads the Essence Method as the bare
		// `$es_Boolean_isNot` const rather than off the runtime module, so a
		// Boolean that reaches a bounded generic finds the Essence implementation.
		it("witnesses Equatable with the Essence Method", async () => {
			const source = `implementation {
				function differ <infer Value is Equatable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::isNot(b)
				}

				__print(differ(true, false)::toString())
				__print(differ(true, true)::toString())
			}`

			expect(generate(source)).toContain("isNot: $es_Boolean_isNot")
			expect(await run(source)).toEqual(['"true"', '"false"'])
		})

		// NOTE: A dispatch case reaches an Essence Method as the bare
		// `$es_…` Identifier, exactly as a plain call does. `Boolean.toString`
		// is Essence, so this is the Union-dispatch-to-an-Essence-Method path
		// end to end: the const has to be emitted off the dispatch triple alone
		// — nothing else in the Program names it — and then run.
		it("dispatches a Union receiver to an Essence Method", async () => {
			const source = `implementation {
				constant value: Integer | Boolean = true

				__print(value::toString())
			}`

			const code = generate(source)

			expect(code).toContain("$es_Boolean_toString")
			expect(code).toContain("const $es_Boolean_toString")
			// NOTE: The Integer case stays a native member read.
			expect(code).toContain("Integer.toString")
			expect(await run(source)).toEqual(['"true"'])
		})

		// NOTE: `Number.isBetween` is the SECOND Method written in Essence —
		// which is what makes the tests below more than a repeat of the Boolean
		// ones: the reachability fixed point now has two candidate consts, and
		// each has to be emitted exactly when the Program reaches it.
		//
		// NOTE: These six cases are the ones `stdlib.spec.ts` used to assert
		// against the runtime `isBetween` before it was deleted — both bounds
		// included, both bounds excluded from outside, and bounds in the wrong
		// order — now run through the compiled Method instead.
		it("runs isBetween from its const", async () => {
			expect(
				await run(`implementation {
					__print(5::isBetween(1, and 10)::toString())
					__print(1::isBetween(1, and 10)::toString())
					__print(10::isBetween(1, and 10)::toString())
					__print(11::isBetween(1, and 10)::toString())
					__print(0::isBetween(1, and 10)::toString())
					__print(5::isBetween(10, and 1)::toString())
				}`),
			).toEqual([
				'"true"',
				'"true"',
				'"true"',
				'"false"',
				'"false"',
				'"false"',
			])
		})

		// NOTE: The covering order is the whole point of putting `isBetween` on
		// `Number` rather than on each member — π against an Integer and a
		// Rational bound is a comparison no member Namespace offers.
		it("runs isBetween across the whole numeric tower", async () => {
			expect(
				await run(`implementation {
					__print(Number.PI::isBetween(3, and 22/7)::toString())
					__print(Number.PI::isBetween(22/7, and 4)::toString())
					__print(3/2::isBetween(1, and 2)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"true"'])
		})

		// NOTE: Each Essence Method's const is emitted exactly where the Program
		// reaches it. `isBetween`'s body calls `Number.isGreaterThanOrEqualTo`
		// and `Boolean.and`, both NATIVE, so it drags in no other const — under
		// the old per-Namespace gate reaching `Number` pulled the whole `Boolean`
		// const in with it, and the per-Method gate is precise enough not to.
		it("emits each Essence Method's const only where it is reached", () => {
			const both = generate(`implementation {
				__print(5::isBetween(1, and 10)::isNot(false))
			}`)

			expect(both).toContain("const $es_Number_isBetween")
			expect(both).toContain("const $es_Boolean_isNot")

			// NOTE: `isNot` alone — a Program that never names a Number.
			const booleanOnly = generate(`implementation {
				__print(true::isNot(false))
			}`)

			expect(booleanOnly).not.toContain("$es_Number_isBetween")
			expect(booleanOnly).toContain("const $es_Boolean_isNot")

			// NOTE: `isBetween` alone reaches only natives, so its const stands
			// alone.
			const numberReached = generate(`implementation {
				__print(5::isBetween(1, and 10))
			}`)

			expect(numberReached).toContain(
				"const $es_Number_isBetween = function (_self, lower, upper) {",
			)
			expect(numberReached).not.toContain("$es_Boolean_isNot")

			// NOTE: Neither. A String-only Program names no Essence Method at all
			// and gets no const.
			const neither = generate(`implementation {
				__print("hello")
			}`)

			expect(neither).not.toContain("$es_Number_isBetween")
			expect(neither).not.toContain("$es_Boolean_isNot")
		})

		// NOTE: A value-LESS `static PI: Transcendental` is a native — it never
		// reaches the prelude's bodied-Property refusal — so it stays a plain
		// member read off the runtime module, `Number.PI`, like every native.
		it("reads PI and TAU as native member reads", async () => {
			const source = `implementation {
				__print(Number.PI::toString())
				__print(Number.TAU::toString())
				__print(Number.PI::isBetween(3, and 22/7)::toString())
			}`

			expect(generate(source)).toContain("Number.PI")
			expect(await run(source)).toEqual(['"π"', '"2·π"', '"true"'])
		})

		// NOTE: Simplifying and optimising the standard library for every file
		// compiled would be paid once per file for an answer that can not
		// differ — and the Simplifier writes into the Nodes it is handed, so a
		// second pass over the same tree would mangle the names twice.
		it("builds the prelude once per process", () => {
			expect(stdlibPrelude()).toBe(stdlibPrelude())
		})

		// NOTE: R4 — the standard library's typed Programs are a process-wide
		// singleton. Building the prelude must leave them exactly as they were,
		// or the Language Server and the tests would read the Rewriter's
		// leavings.
		it("leaves the standard library's typed Programs untouched", () => {
			let before = JSON.stringify(loadStdlib().typedPrograms)

			buildStdlibPrelude(loadStdlib().typedPrograms)

			expect(JSON.stringify(loadStdlib().typedPrograms)).toBe(before)
		})

		// NOTE: The `__overload$N` suffix is the Overload's position in the
		// Method TYPE. A native holds its slot even though the prelude emits
		// nothing for it, because the runtime export it binds to already answers
		// to that name — emitting the bodied Overload under the filtered index
		// would define `combine__overload$1` on top of the spread and clobber
		// the native.
		it("numbers a mixed overload block by its position in the Method Type", () => {
			let stdlib = loadStdlibFrom([
				parseStdlibSource(
					"Mixed.es",
					`declarations {
	namespace Mixed for Integer {
		§§ Combines two values.
		overload combine {
			(_ other: Integer) -> Integer
			(_ other: String) -> String {
				<- other
			}
		}
	}
}`,
				),
			])

			let prelude = buildStdlibPrelude(stdlib.typedPrograms)

			expect(prelude).toHaveLength(1)
			expect(prelude[0]!.name).toBe("Mixed")
			expect(Object.keys(prelude[0]!.node.methods)).toEqual([
				"combine__overload$2",
			])
		})

		// NOTE: The search has to run to a FIXED POINT: an Essence Method may be
		// reached only through the BODY of another one. Both Essence Methods today
		// call natives only, so this is driven directly over a synthetic prelude
		// — and it is the case that starts happening for real as the conversion
		// goes on. The edges are read off the typed body, so injecting a prelude
		// the process-wide one does not know is exactly what this must handle.
		describe("reachability", () => {
			// NOTE: `Outer.quadruple` calls `Inner.double`, and nothing else
			// mentions `Inner`.
			const pair = `declarations {
	namespace Inner for Integer {
		§§ Doubles the value.
		double() -> Integer {
			<- @
		}
	}

	namespace Outer for Integer {
		§§ Quadruples the value.
		quadruple() -> Integer {
			<- @::double()::double()
		}
	}
}`

			function preludeOf(source: string) {
				return buildStdlibPrelude(
					loadStdlibFrom([parseStdlibSource("Pair.es", source)])
						.typedPrograms,
				)
			}

			// NOTE: An Essence Method is reached as a bare `$es_…` Identifier —
			// the same shape the user Program's emitted calls take.
			function callOf(
				namespaceName: string,
				methodName: string,
			): estree.ExpressionStatement {
				return {
					type: "ExpressionStatement",
					expression: {
						type: "CallExpression",
						optional: false,
						callee: {
							type: "Identifier",
							name: essenceMethodIdentifier(
								namespaceName,
								methodName,
							),
						},
						arguments: [],
					},
				}
			}

			it("follows a reference out of an Essence Method's body", () => {
				let reachable = reachableEssenceMethods(preludeOf(pair), [
					callOf("Outer", "quadruple"),
				])

				expect([...reachable.keys()].sort()).toEqual([
					"$es_Inner_double",
					"$es_Outer_quadruple",
				])
			})

			it("keeps a Method nothing names out", () => {
				let reachable = reachableEssenceMethods(preludeOf(pair), [
					callOf("Elsewhere", "somewhere"),
				])

				expect([...reachable.keys()]).toEqual([])
			})

			it("does not pull a Method in through the one it calls", () => {
				let reachable = reachableEssenceMethods(preludeOf(pair), [
					callOf("Inner", "double"),
				])

				expect([...reachable.keys()]).toEqual(["$es_Inner_double"])
			})

			// NOTE: The edge finder must recognise EVERY shape `namespaceMember`
			// turns into a `$es_…` Identifier, or a Method reached only through a
			// missing shape is named in an emitted body while its const is never
			// pulled in — a `ReferenceError` at run time that compiles green. Fed
			// each shape directly, because the two live Essence Methods reach
			// other Methods only through a `MethodInvocation`, so the prelude
			// never exercises the witness and static-reference shapes on its own.
			describe("edge shapes", () => {
				const implemented = new Set([
					"Target instance",
					"Target static",
					"Target witnessed",
					"Target dispatched",
				])

				it("follows an instance MethodInvocation", () => {
					let refs = essenceMethodReferences(
						{
							nodeType: "MethodInvocation",
							base: { nodeType: "Identifier", name: "Target" },
							member: { name: "instance" },
							arguments: [],
						},
						implemented,
					)

					expect([...refs]).toEqual(["$es_Target_instance"])
				})

				it("follows a static Lookup, as callee and as a bare value", () => {
					const lookup = {
						nodeType: "Lookup",
						base: {
							nodeType: "Identifier",
							name: "Target",
							type: { type: "Namespace" },
						},
						member: { nodeType: "Identifier", name: "static" },
					}

					expect([
						...essenceMethodReferences(
							{
								nodeType: "FunctionInvocation",
								name: lookup,
								arguments: [],
							},
							implemented,
						),
					]).toEqual(["$es_Target_static"])

					// NOTE: A static Method passed as a value, not called — the
					// shape an earlier version missed by only inspecting a
					// `FunctionInvocation`'s callee.
					expect([
						...essenceMethodReferences(
							{ nodeType: "Argument", value: lookup },
							implemented,
						),
					]).toEqual(["$es_Target_static"])
				})

				it("follows a conformance witness's method map", () => {
					let refs = essenceMethodReferences(
						{
							nodeType: "ConformanceValue",
							namespaceName: "Target",
							methodMap: { someProtocolMethod: "witnessed" },
							conditions: [],
						},
						implemented,
					)

					expect([...refs]).toEqual(["$es_Target_witnessed"])
				})

				it("follows a Union dispatch case", () => {
					let refs = essenceMethodReferences(
						{
							nodeType: "UnionMethodInvocation",
							base: { nodeType: "Identifier", name: "value" },
							cases: [
								{
									namespaceName: "Target",
									methodName: "dispatched",
									conformanceArguments: [],
								},
							],
							arguments: [],
						},
						implemented,
					)

					expect([...refs]).toEqual(["$es_Target_dispatched"])
				})

				it("draws no edge to a Method the prelude does not implement", () => {
					// NOTE: A Record field access is an Identifier-based `Lookup`
					// too — it must not be mistaken for a static reference.
					let refs = essenceMethodReferences(
						{
							nodeType: "Lookup",
							base: {
								nodeType: "Identifier",
								name: "record",
								type: { type: "Record" },
							},
							member: {
								nodeType: "Identifier",
								name: "instance",
							},
						},
						implemented,
					)

					expect([...refs]).toEqual([])
				})
			})
		})

		// NOTE: A bodied static Property would be initialised INSIDE the const's
		// own object literal — and every Essence literal compiles to a call on a
		// Namespace, so it would read a binding that does not exist yet. It type
		// checks and compiles; it crashes at import. Refused where it is written
		// rather than emitted.
		it("refuses a bodied static Property", () => {
			let stdlib = loadStdlibFrom([
				parseStdlibSource(
					"Flagged.es",
					`declarations {
	namespace Flagged for Boolean {
		§§ The affirmative.
		static YES: Boolean = true

		§§ The value itself.
		itself() -> Boolean {
			<- @
		}
	}
}`,
				),
			])

			expect(() => buildStdlibPrelude(stdlib.typedPrograms)).toThrow(
				/'Flagged' gives a value to the static Property 'YES'/,
			)
		})

		// NOTE: A Namespace whose every member is native has nothing to merge —
		// it keeps its plain import, and no const is emitted for it.
		it("skips a Namespace with no Essence-implemented member", () => {
			let stdlib = loadStdlibFrom([
				parseStdlibSource(
					"Natives.es",
					`declarations {
	namespace Natives for Integer {
		§§ Doubles the value.
		double() -> Integer
	}
}`,
				),
			])

			expect(buildStdlibPrelude(stdlib.typedPrograms)).toEqual([])
		})
	})
})
