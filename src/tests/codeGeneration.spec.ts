import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"
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
import { reachableMergedNamespaces, rewrite } from "../rewriter/index"
import { buildStdlibPrelude, stdlibPrelude } from "../rewriter/stdlibPrelude"
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
							case _       { <- @::multiplyWith(2) }
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
						case _ { <- @::multiplyWith(2) }
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
							case _       { <- @::multiplyWith(2) }
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
					__print(["b", "a"]::sortedBy(
						(first, second) { <- first::compareTo(second) },
					))
				}
			`)

			expect(generated).toContain("List.sortedBy(")
			expect(generated).toContain("String.compareTo(")
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
				constant ordered: List<Integer> = [3, 1, 2]::sorted()
			}`)

			// NOTE: An unconditional witness stays exactly the method-map object
			// literal — no `boundConformance` wrapper, so its emit is unchanged.
			expect(code).toContain("compareTo: Integer.compareTo")
			expect(code).not.toContain("boundConformance")
		})

		it("should wrap a nested witness in boundConformance", () => {
			const code = generate(`implementation {
				constant ordered = [[1, 2], [3]]::sorted()
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
			expect(code).toContain("Integer.toString")
			expect(code).toContain("Boolean.toString")
		})

		it("should mangle overloaded Method names per dispatch case", () => {
			const code = generate(`implementation {
				constant number: Number = 5

				__print(number::multiplyWith(2)::toString())
			}`)

			expect(code).toContain("Integer.multiplyWith__overload$")
			expect(code).toContain("Rational.multiplyWith__overload$")
		})

		it("should dispatch a bounded Type Parameter member through the conformance parameter", () => {
			const code = generate(`implementation {
				function firstText <infer Item is Printable>(_ items: List<Item>) -> String {
					<- items::firstItem()::toString()
				}

				__print(firstText([1, 2]))
			}`)

			expect(code).toContain("$type.dispatchMethod")
			expect(code).toContain("Nothing.toString")
			expect(code).toContain("Item__conformance.toString")
		})

		it("should order the catch-all Type Parameter case last", () => {
			const code = generate(`implementation {
				function firstText <infer Item is Printable>(_ items: List<Item>) -> String {
					<- items::firstItem()::toString()
				}

				__print(firstText([1, 2]))
			}`)

			expect(code.indexOf("Nothing.toString")).toBeGreaterThan(-1)
			expect(code.indexOf("Nothing.toString")).toBeLessThan(
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
	describe("Standard Library Prelude", () => {
		it("merges the Essence-implemented Methods over the runtime module", () => {
			const code = generate(`implementation {
				__print(true)
			}`)

			expect(code).toContain('import * as $native_Boolean from "')
			expect(code).not.toContain('import * as Boolean from "')
			expect(code).toContain("const Boolean = {\n\t...$native_Boolean,")
			expect(code).toContain("isNot: function (_self, other) {")

			// NOTE: Every other Namespace is still wholly native, so it keeps
			// the plain import and gains no const.
			expect(code).toContain('import * as String from "')
			expect(code).not.toContain("const String = {")
		})

		// NOTE: The const's Method bodies name other Namespaces — `isNot` calls
		// `Boolean.is` and `Boolean.negate`, both of which arrive through the
		// spread of the const being defined. That is only safe because the
		// lookup happens when the Method is CALLED.
		it("emits a body that reads back through the merged const", () => {
			const code = generate(`implementation {
				__print(true)
			}`)

			expect(code).toContain(
				"return Boolean.negate(Boolean.is(_self, other));",
			)
		})

		// NOTE: The const spreads the runtime module, which keeps every export
		// that module has alive through the Bundler. A Program that never names
		// the Namespace must therefore not get one — before this was gated, a
		// file of nothing but comments compiled to a twelve kilobyte bundle.
		it("emits no const for a Namespace the Program never names", () => {
			const code = generate(`implementation {
				__print("hello")
			}`)

			expect(code).not.toContain("const Boolean = {")
			expect(code).not.toContain("$native_Boolean")
			// NOTE: Left exactly as it was before the prelude existed — an
			// unreferenced plain import the Bundler shakes away.
			expect(code).toContain('import * as Boolean from "')
		})

		// NOTE: The gate runs over the FINISHED tree, after generation, which is
		// the only place a conformance witness, a `dispatchMethod` target and a
		// plain call all look alike — they are `Identifier` nodes. A survey of
		// the source would have to know every one of those shapes.
		it("finds a Namespace named only through a conformance witness", () => {
			const code = generate(`implementation {
				function differ <infer Value is Equatable>(_ a: Value, _ b: Value) -> String {
					<- a::isNot(b)::toString()
				}

				constant yes = true

				__print(differ(yes, yes))
			}`)

			expect(code).toContain("isNot: Boolean.isNot")
			expect(code).toContain("const Boolean = {")
		})

		// NOTE: A dotted member name is text, not a reference — a Record with a
		// member spelled like a merged Namespace must not drag the whole thing
		// in.
		it("does not mistake a member name for a reference", () => {
			const code = generate(`implementation {
				constant record = { Boolean = "not the Namespace" }

				__print(record.Boolean)
			}`)

			expect(code).not.toContain("const Boolean = {")
		})

		it("runs isNot from the merged const", async () => {
			expect(
				await run(`implementation {
					__print(false::isNot(true)::toString())
					__print(true::isNot(true)::toString())
					__print(false::isNot(false)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"false"'])
		})

		// NOTE: The conformance witness reads `Boolean.isNot` off the merged
		// const rather than off the runtime module, so a Boolean that reaches a
		// bounded generic has to find the Essence implementation there.
		it("witnesses Equatable with the merged Method", async () => {
			const source = `implementation {
				function differ <infer Value is Equatable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::isNot(b)
				}

				__print(differ(true, false)::toString())
				__print(differ(true, true)::toString())
			}`

			expect(generate(source)).toContain("isNot: Boolean.isNot")
			expect(await run(source)).toEqual(['"true"', '"false"'])
		})

		// NOTE: A dispatch case names its target as `<Namespace>.<method>`, which
		// for Boolean is now a read off the merged const. The natives have to
		// still be there — they arrive through the spread — or every dispatch to
		// a Boolean would hand `dispatchMethod` an `undefined` target.
		//
		// NOTE: `isNot` itself can not be reached this way: every case of a
		// dispatch is passed the SAME Arguments, and no single value is both an
		// Integer and a Boolean. What a Union receiver reaches on the merged
		// const is therefore a native, which is exactly the half that had to
		// survive the merge.
		it("dispatches a Union receiver through the merged const", async () => {
			const source = `implementation {
				constant value: Integer | Boolean = true

				__print(value::toString())
			}`

			expect(generate(source)).toContain("Boolean.toString")
			expect(await run(source)).toEqual(['"true"'])
		})

		// NOTE: `Number.isBetween` is the SECOND Method to be written in
		// Essence, and `Number` the second merged Namespace — which is what
		// makes the three tests below more than a repeat of the Boolean ones:
		// the reachability fixed point now has two candidates to get right, and
		// each has to be emitted exactly when the Program reaches it and not
		// otherwise.
		//
		// NOTE: These five cases are the ones `stdlib.spec.ts` used to assert
		// against the runtime `isBetween` before it was deleted — both bounds
		// included, both bounds excluded from outside, and bounds in the wrong
		// order — now run through the compiled Method instead.
		it("runs isBetween from the merged const", async () => {
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

		// NOTE: The body calls `Boolean.and`, so reaching `Number` drags
		// `Boolean` in with it — the reachability search follows a merged
		// Namespace's own body, which is exactly what the README promises
		// whoever adds the next cross-Namespace Method.
		it("emits both merged consts, either one, or neither", () => {
			const both = generate(`implementation {
				__print(5::isBetween(1, and 10)::isNot(false))
			}`)

			expect(both).toContain("const Number = {")
			expect(both).toContain("const Boolean = {")

			// NOTE: `Boolean` alone — a Program that never names a Number.
			const booleanOnly = generate(`implementation {
				__print(true::isNot(false))
			}`)

			expect(booleanOnly).not.toContain("const Number = {")
			expect(booleanOnly).toContain("const Boolean = {")

			// NOTE: `Number` alone is not reachable on its own: `isBetween`'s
			// body names `Boolean.and`, so the pair always arrive together.
			const numberReached = generate(`implementation {
				__print(5::isBetween(1, and 10))
			}`)

			expect(numberReached).toContain("const Number = {")
			expect(numberReached).toContain("const Boolean = {")
			expect(numberReached).toContain(
				"isBetween: function (_self, lower, upper) {",
			)

			// NOTE: Neither. A String-only Program names no merged Namespace at
			// all and gets no const, exactly as before either one existed.
			const neither = generate(`implementation {
				__print("hello")
			}`)

			expect(neither).not.toContain("const Number = {")
			expect(neither).not.toContain("const Boolean = {")
		})

		// NOTE: A value-LESS `static PI: Transcendental` is a native — it never
		// reaches the prelude's bodied-Property refusal — so it has to arrive
		// through the spread of the runtime module into the merged const, like
		// every other native does.
		it("reads PI and TAU off the merged const", async () => {
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

		// NOTE: The search has to run to a FIXED POINT: a Namespace may be
		// reached only through the BODY of another merged Namespace's Method.
		// `Boolean` is the only merged one today, so this is driven directly —
		// and it is the case that will start happening for real as the
		// conversion goes on.
		describe("reachability", () => {
			// NOTE: `Outer.quadruple` calls `Inner.double`, and nothing else
			// mentions `Inner`. Neither Namespace has a runtime module, which
			// also exercises the no-spread shape.
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
							type: "MemberExpression",
							optional: false,
							computed: false,
							object: { type: "Identifier", name: namespaceName },
							property: { type: "Identifier", name: methodName },
						},
						arguments: [],
					},
				}
			}

			it("follows a reference out of a merged Method's body", () => {
				let reachable = reachableMergedNamespaces(preludeOf(pair), [
					callOf("Outer", "quadruple"),
				])

				expect([...reachable.keys()].sort()).toEqual(["Inner", "Outer"])
			})

			it("keeps a Namespace nothing names out", () => {
				let reachable = reachableMergedNamespaces(preludeOf(pair), [
					callOf("Elsewhere", "somewhere"),
				])

				expect([...reachable.keys()]).toEqual([])
			})

			it("does not pull a Namespace in through the one it calls", () => {
				let reachable = reachableMergedNamespaces(preludeOf(pair), [
					callOf("Inner", "double"),
				])

				expect([...reachable.keys()]).toEqual(["Inner"])
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
