import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"
import { readStdlibFiles } from "@essence-lang/standard-library"
import type * as estree from "estree"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	loadStdlib,
	loadStdlibFrom,
	parseStdlibSource,
	type Stdlib,
	useStdlib,
} from "../enricher/stdlib"
import { resolveOverloadedMethodName } from "../helpers/index"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
	unoptimisedOptions,
} from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import {
	checkEssenceMethodsAreDeclared,
	type EssenceMember,
	essenceMethodReferences,
	essenceMemberBands,
	orderEssenceMembers,
	reachableEssenceMethods,
	rewrite,
} from "../rewriter/index"
import {
	buildStdlibPrelude,
	essenceMethodIdentifier,
	essenceMethodName,
	essencePropertyName,
	nativeFreeFunctionNames,
	type PreludeFreeFunction,
	stdlibFreeFunctions,
	stdlibPrelude,
} from "../rewriter/stdlibPrelude"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: Runs the same stages the CLI runs, minus bundling — enough to assert
// on the shape of the emitted JavaScript without touching the file system.
//
// NOTE: `modulePath` enriches the source as a Module, which identifies its
// Choices by that path — left out, the Program is no Module and its Cases carry
// the bare tags every other test here asserts on.
function generate(
	source: string,
	modulePath?: string,
	optimiserOptions: OptimiserOptions = defaultOptimiserOptions,
): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(
		parsed.program,
		modulePath === undefined ? {} : { modulePath },
	)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(
		optimise(simplify(enriched.program), optimiserOptions),
		optimiserOptions,
	)
}

// NOTE: Emits the Program, writes it to a throwaway module and imports it so
// its top-level `Terminal.inspect` calls run. The emitted imports are absolute paths
// into this repo's runtime, so the module resolves from anywhere; `console.log`
// is captured to collect the output, then restored.
async function run(
	source: string,
	modulePath?: string,
): Promise<Array<string>> {
	let js = generate(source, modulePath)
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
	// NOTE: A Namespace's static Property is the one node the code generator
	// cannot emit on its own. `escodegen` has no `PropertyDefinition` case
	// upstream and throws on a node type it does not know, so the vendored copy
	// in `packages/escodegen` carries a twelve-line patch that adds one — see
	// its `PATCHES.md`. Nothing else in this suite reaches that node: a
	// Namespace's Methods are `MethodDefinition`s, which upstream handles, so
	// the whole suite stays green with the patch removed and every Program with
	// a `static` Property fails at `esc build` with an opaque
	// "this[type] is not a function". While the patch was pinned by commit SHA
	// that could not silently happen; vendored, it is a file someone can
	// re-vendor over, so it needs a test that goes red when they do.
	describe("a Namespace's static Property", () => {
		it("emits a class field", () => {
			let generated = generate(`
				implementation {
					namespace Config {
						static version = "1.0"
					}

					Terminal.inspect(Config.version)
				}
			`)

			expect(generated).toContain("static version =")
		})

		it("reads back the value at runtime", async () => {
			expect(
				await run(`
					implementation {
						namespace Config {
							static version = "1.0"
						}

						Terminal.inspect(Config.version)
					}
				`),
			).toEqual(['"1.0"'])
		})
	})

	// NOTE: A value the Program computes and drops. Before `collapse-construction`
	// every one of them was a runtime CALL, which no engine may take away; now a
	// Record, a List and a Case are object literals, and an object literal whose
	// value is unused is something an engine may decide not to build. Bun's
	// decides exactly that — and still evaluates the computed key, which is the
	// hidden Type SYMBOL every value carries, as a property NAME: converting a
	// Symbol to a string throws, out of a Statement that was supposed to do
	// nothing. So a discarded value is bound to a name, and the Statement it was
	// written as RUNS.
	describe("a value written for nothing", () => {
		it("binds a discarded value rather than dropping it", () => {
			let generated = generate(`
				implementation {
					{ x = 1, y = 2 }
					[1, 2, 3]

					Terminal.inspect("done")
				}
			`)

			expect(generated).toContain("let $discarded_value = {")
			expect(generated).not.toContain("({\n\t\t[$type.typeKeySymbol]")
		})

		// NOTE: Regression test — the name held a `$` and no `_`, and `$` is a
		// legal Essence identifier character while `_` is a Symbol the Lexer
		// ends an Identifier at. So `$discarded` was a name a Program could
		// bind, and one bound HERE around an Expression that READS it was read
		// before it was initialised: a Program that ran under `--no-optimise`
		// died with a `ReferenceError` with the passes on.
		it("holds it under a name no Program can write", async () => {
			expect(
				await run(`
					implementation {
						constant $discarded = 1

						{ x = $discarded }

						Terminal.inspect($discarded)
					}
				`),
			).toEqual(["1"])
		})

		it("leaves a call where it stands", () => {
			// NOTE: Which is what every Statement of this kind a real Program
			// writes actually is — a call can not be taken away, because it may
			// print.
			let generated = generate(`
				implementation {
					Terminal.inspect("done")
				}
			`)

			expect(generated).toContain("Terminal.inspect($pool_0);")
			expect(generated).not.toContain("$discarded")
		})

		it("runs the Program that writes one", async () => {
			expect(
				await run(`
					implementation {
						choice Colour { Red, Green }

						constant base = { x = 1 }

						{ x = 1, y = 2 }
						[1, 2, 3]
						{ base with x = 9 }
						Colour#Red

						Terminal.inspect("done")
					}
				`),
			).toEqual(['"done"'])
		})
	})

	// NOTE: Structural printing used to be a free Function read off the runtime
	// `functions` module. It is `Terminal.inspect` now — an ordinary native
	// static Method of an ordinary Namespace, emitted as a read off that
	// Namespace's runtime import like every other native. The observable
	// behaviour is unchanged, which is why the golden file did not move when
	// every call site was rewritten.
	describe("Terminal.inspect", () => {
		it("emits a read off the Terminal module, not the functions one", () => {
			let generated = generate(`
				implementation {
					Terminal.inspect("hello")
				}
			`)

			expect(generated).toContain("Terminal.inspect(")
			// NOTE: `$_` is the runtime `functions` module, where a native FREE
			// Function lives. A Namespace member never comes off it, and this is
			// the assertion that says so.
			expect(generated).not.toContain("$_.inspect(")
		})

		it("prints the value and is unchanged at runtime", async () => {
			let output = await run(`
				implementation {
					Terminal.inspect("hello")
					Terminal.inspect(42)
				}
			`)

			// NOTE: A String prints QUOTED, an Integer bare — the structural
			// representation `getStringRepresentation` always produced, which is
			// exactly what tells `inspect` apart from `print`.
			expect(output).toEqual(['"hello"', "42"])
		})
	})

	// NOTE: The four end-to-end guards for what the runtime PRINTS and what it
	// calls EQUAL. Each fault below was invisible to every stage before the
	// emitted Program ran, so each is pinned by running one — the unit-level
	// counterparts live in `runtimeInternal.spec.ts`.
	describe("Runtime Printing and Equality", () => {
		// NOTE: A Record whose single-line rendering reaches sixty characters
		// goes multi-line, and every member used to be printed TWICE — once
		// unindented from the single-line attempt, once indented.
		it("prints each member of a multi-line Record exactly once", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect({
						firstName = "Alexander",
						lastName = "Trefz",
						occupation = "Language designer",
					})
				}`),
			).toEqual([
				[
					"{",
					'    firstName = "Alexander",',
					'    lastName = "Trefz",',
					'    occupation = "Language designer"',
					"}",
				].join("\n"),
			])
		})

		// NOTE: A Function is the one value carrying no Type key, so printing
		// one — or anything holding one — read `undefined.includes` and threw a
		// TypeError at run time out of a Program that compiled clean.
		it("prints a Function, and a value holding one, without crashing", async () => {
			expect(
				await run(`implementation {
					constant double = (_ value: Integer) -> Integer {
						<- value::multiply(with 2)
					}

					Terminal.inspect(double)
					Terminal.inspect({ callback = double })
					Terminal.inspect([double])
				}`),
			).toEqual(["Function", "{ callback = Function }", "[ Function ]"])
		})

		// NOTE: `String::is` is canonical equivalence — `compare` normalises
		// to NFC — so a composed and a decomposed `café` are the same String.
		// Deep equality compared the raw code units, so the same pair came out
		// unequal the moment it was wrapped.
		it("compares Strings inside a Record by canonical equivalence", async () => {
			expect(
				await run(`implementation {
					constant composed = "café"::normalize()
					constant decomposed = "café"::normalize(as #DecomposedCanonical)

					Terminal.inspect(composed::is(decomposed))
					Terminal.inspect({ v = composed }::is({ v = decomposed }))
					Terminal.inspect([{ v = composed }]::is([{ v = decomposed }]))
				}`),
			).toEqual(["true", "true", "true"])
		})

		// NOTE: `Number::is` is numeric equality — `1 is 1/1` holds — but deep
		// equality demanded the same member Type on both sides, so a Record
		// holding the Integer answered unequal to one holding the Rational.
		it("compares Numbers inside a Record across the tower", async () => {
			expect(
				await run(`implementation {
					constant whole: Number = 1
					constant ratio: Number = 1/1

					Terminal.inspect(whole::is(ratio))
					Terminal.inspect({ x = 1 }::is({ x = 1/1 }))
					Terminal.inspect({ x = 1/2::add(1/2) }::is({ x = 1 }))
					Terminal.inspect({ x = 1 }::is({ x = 1/2 }))
				}`),
			).toEqual(["true", "true", "true", "false"])
		})
	})

	describe("Match", () => {
		// NOTE: Regression test — the Handlers used to be folded into the
		// if/else cascade in a way that only kept the first and the last, so
		// every Match with more than two Handlers silently dropped the ones in
		// between and fell through to `undefined`.
		it("emits every Handler of a Match", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Rational | String | Boolean = true

					Terminal.inspect(match value -> String {
						case Integer  { <- "handled integer" }
						case Rational { <- "handled rational" }
						case String   { <- "handled string" }
						case Boolean  { <- "handled boolean" }
					})
				}
			`)

			expect(generated).toContain("handled integer")
			expect(generated).toContain("handled rational")
			expect(generated).toContain("handled string")
			expect(generated).toContain("handled boolean")
		})

		it("nests the Handlers so that each one is the alternate of the last", () => {
			const source = `
				implementation {
					variable value: Integer | Rational | Boolean = true

					Terminal.inspect(match value -> String {
						case Integer  { <- "a" }
						case Rational { <- "b" }
						case Boolean  { <- "c" }
					})
				}
			`

			// NOTE: Three Handlers produce one `if` plus two `else` branches,
			// and the chain ends in a third `else` that no Handler owns — the
			// exhaustiveness fallback, which throws rather than letting the
			// wrapper answer `undefined`. Asked with `elide-final-match-test`
			// off, which is the pass that proves the last Handler IS that
			// third `else` and emits it there.
			let generated = generate(source, undefined, {
				enabled: true,
				disabledPasses: new Set(["elide-final-match-test"]),
			})

			expect(generated.split("else").length - 1).toBe(3)
			expect(generated).toContain("$type.noCaseMatched(_self)")

			// NOTE: And with it on, the same chain is two `else`s and no
			// fallback — the nesting itself is unchanged.
			let elided = generate(source)

			expect(elided.split("else").length - 1).toBe(2)
			expect(elided).not.toContain("$type.noCaseMatched(_self)")
		})

		// NOTE: Regression test — a Union Matcher used to be serialised with
		// `Object.entries`, which turned its member list into `{ 0: …, 1: … }`
		// and left the runtime Type check calling Array Methods on an Object.
		it("serialises the member list of a Union Matcher as an Array", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Rational | Boolean = true

					Terminal.inspect(match value -> String {
						case Integer | Rational { <- "number" }
						case Boolean            { <- "boolean" }
					})
				}
			`)

			expect(generated).toContain("types: [")
			expect(generated).not.toContain("types: {")
		})

		it("emits a wildcard Handler alongside the Handlers before it", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Rational | Boolean = true

					Terminal.inspect(match value -> String {
						case Boolean { <- "handled boolean" }
						case _       { <- "handled the rest" }
					})
				}
			`)

			expect(generated).toContain("handled boolean")
			expect(generated).toContain("handled the rest")
		})

		// NOTE: The matched value's tag is read once for a chain that asks about
		// it more than once. It is emission rather than a pass — nothing about
		// the Program changes, the same key is read off the same immutable value
		// before the same tests — so it is held to account here rather than in
		// the Optimiser's registry.
		it("binds the matched value's tag where the chain asks for it twice", () => {
			let generated = generate(`
				implementation {
					variable value: Integer | Rational | String | Boolean = true

					Terminal.inspect(match value -> String {
						case Integer  { <- "handled integer" }
						case Rational { <- "handled rational" }
						case String   { <- "handled string" }
						case Boolean  { <- "handled boolean" }
					})
				}
			`)

			expect(generated).toContain(
				"const $self_tag = _self[$type.typeKeySymbol]",
			)
			expect(generated).toContain('$self_tag === "Integer"')
			expect(generated).not.toContain(
				'_self[$type.typeKeySymbol] === "Integer"',
			)
		})

		it("leaves a chain that asks once reading the key where it stands", () => {
			// NOTE: One tag test is one read, and a name for it would say what
			// the read already says. Two Handlers is one test: the last is the
			// `else` `elide-final-match-test` proved it is.
			let generated = generate(`
				implementation {
					variable value: Integer | Boolean = true

					Terminal.inspect(match value -> String {
						case Integer { <- "handled integer" }
						case Boolean { <- "handled boolean" }
					})
				}
			`)

			expect(generated).toContain(
				'_self[$type.typeKeySymbol] === "Integer"',
			)
			expect(generated).not.toContain("$self_tag")
		})

		it("binds nothing where the Optimiser left no tag test", () => {
			// NOTE: The binding is made off the `tag-test` Nodes
			// `compile-type-tests` leaves. With the phase off there are none, so
			// the chain is emitted exactly as it was — which is what makes this
			// safe under any subset of the registry.
			let generated = generate(
				`
				implementation {
					variable value: Integer | Rational | String | Boolean = true

					Terminal.inspect(match value -> String {
						case Integer  { <- "handled integer" }
						case Rational { <- "handled rational" }
						case String   { <- "handled string" }
						case Boolean  { <- "handled boolean" }
					})
				}
			`,
				undefined,
				unoptimisedOptions,
			)

			expect(generated).not.toContain("$self_tag")
			expect(generated).toContain("$type.isValueOfType(_self,")
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
						variable value: Integer | Boolean = 5

						Terminal.inspect(match value -> Integer {
							case Boolean { <- 0 }
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
						variable value: Integer | Boolean = 5

						Terminal.inspect(match value -> String {
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
					variable value: Integer | Boolean = 0

					Terminal.inspect(match value -> String {
						case 0       { <- "zero" }
						case Integer { <- "other" }
						case Boolean { <- "boolean" }
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
					variable value: Integer | Boolean = 1

					Terminal.inspect(match value -> String {
						case Integer where @::isGreaterThan(0) { <- "positive" }
						case Integer                           { <- "other" }
						case Boolean                           { <- "boolean" }
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
					variable value: Integer | Boolean = 0

					Terminal.inspect(match value -> String {
						case 0       { <- "zero" }
						case Boolean { <- "boolean" }
					})
				}
			`)

			expect(hasCode(diagnostics, "missing-case")).toBe(true)
		})

		it("does not let a Guard discharge its Type", () => {
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: Integer | Boolean = 1

					Terminal.inspect(match value -> String {
						case Integer where @::isGreaterThan(0) { <- "positive" }
						case Boolean                           { <- "boolean" }
					})
				}
			`)

			expect(hasCode(diagnostics, "missing-case")).toBe(true)
		})

		it("leaves a literal's Type in the residual of a later wildcard", () => {
			// NOTE: `case 0` catches one Integer, so `@` inside the wildcard is
			// still Integer|Boolean — calling an Integer Method on it has to
			// stay an error.
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: Integer | Boolean = 1

					Terminal.inspect(match value -> Integer {
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
						variable value: Integer | Boolean = 1

						Terminal.inspect(match value -> Integer {
							case Boolean { <- 0 }
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
					variable value: { a: Integer } | String = { a = 1 }

					Terminal.inspect(match value -> String {
						case { a: Integer } { <- "handled record" }
						case String         { <- "handled string" }
					})
				}
			`)

			expect(generated).toContain("handled record")
			expect(generated).toContain("handled string")
		})

		it("compares a value-constrained member by value", () => {
			let generated = generate(`
				implementation {
					variable value: { a: Integer, b: Integer } | String = { a = 6, b = 2 }

					Terminal.inspect(match value -> String {
						case { a = 6, b: Integer } { <- "six" }
						case { a: Integer }        { <- "record" }
						case String                { <- "string" }
					})
				}
			`)

			expect(generated).toContain("anyIs")
		})

		it("types @ as the Record so its members can be read", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: { a: Integer, b: Integer } | String = { a = 6, b = 7 }

						Terminal.inspect(match value -> Integer {
							case { a = 6, b: Integer } { <- @.b }
							case { a: Integer }        { <- @.a }
							case String                { <- 0 }
						})
					}
				`),
			).not.toThrow()
		})

		it("does not let a value-constrained Record discharge its Type", () => {
			let diagnostics = diagnosticsOf(`
				implementation {
					variable value: { a: Integer } | String = { a = 6 }

					Terminal.inspect(match value -> String {
						case { a = 6 }  { <- "six" }
						case String     { <- "string" }
					})
				}
			`)

			expect(hasCode(diagnostics, "missing-case")).toBe(true)
		})

		it("lets a purely Type-constrained Record discharge its Type", () => {
			expect(() =>
				generate(`
					implementation {
						variable value: { a: Integer } | String = { a = 6 }

						Terminal.inspect(match value -> String {
							case { a: Integer } { <- "record" }
							case String         { <- "string" }
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

					Terminal.inspect(f(1, "a", true))
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

						Terminal.inspect(apply((_ value: Integer) -> String {
							<- value::toString()
						}))
					}
				`),
			).not.toThrow()
		})
	})

	describe("String Methods", () => {
		// NOTE: String gained Comparable, so a List of Strings sorts with a
		// real comparator — this pins that `compare` resolves on the String
		// receiver and the whole pipeline emits.
		it("sorts a List of Strings through String.compare", () => {
			let generated = generate(`
				implementation {
					Terminal.inspect(["b", "a"]::sort(by 
						(first, second) { <- first::compare(to second) },
					))
				}
			`)

			expect(generated).toContain("List.sort__overload$2(")
			expect(generated).toContain("String.compare__overload$1(")
		})
	})

	describe("Higher-order List Methods", () => {
		// NOTE: `map`/`reduce` are the first builtins with a Method-level
		// Generic and the first to take a contextually typed callback all the
		// way through codegen. This pins that the callback's body reached the
		// emitted JavaScript with its Parameters bound and its Types resolved.
		//
		// NOTE: The CALL is no longer here to pin: a walk whose callback is
		// written AT the call is written out where it stands — `inline-loops` —
		// so the Method is reached only where the callback is a value instead.
		// The pass's own spec pins both halves of that; these two pin what the
		// Enricher and the Simplifier made of the literal, which is the same
		// either way.
		it("emits map with an inferred callback", () => {
			let generated = generate(`
				implementation {
					Terminal.inspect([1, 2]::map((n) { <- n::toString() }))
				}
			`)

			expect(generated).toContain("const n = $loop_0_items[")
			expect(generated).toContain("Integer.toString(")
		})

		it("emits reduce with its starting value and callback", () => {
			let generated = generate(`
				implementation {
					Terminal.inspect([1, 2]::reduce(
						startingWith 0,
						(total, n) { <- total::add(n) },
					))
				}
			`)

			expect(generated).toContain("let $loop_0_state = $pool_")
			// NOTE: `total::add(n)` on two Integers is lowered to the addition
			// itself — `lower-scalar-operations` — so what says the callback's
			// body resolved is the operation rather than the call. The
			// accumulator is the walk's own, so it is carried as the value it
			// holds and the addition answers one; the item is a List's and is
			// read through.
			expect(generated).toContain("total + n.value")
		})

		// NOTE: And the Method itself, which is reached exactly where the
		// callback is not written at the call — the same Program with the
		// literal bound to a name first.
		it("emits the call where the callback is a value", () => {
			let generated = generate(`
				implementation {
					constant double = (_ n: Integer) -> Integer {
						<- n::multiply(with 2)
					}

					Terminal.inspect([1, 2]::map(double))
				}
			`)

			expect(generated).toContain("List.map(")
		})
	})

	describe("Contextual Function literals", () => {
		// NOTE: The whole point is that the inferred Parameter Type reaches
		// the body's Scope. The comparison is lowered to a bigint one, which
		// `lower-scalar-operations` does only where the receiver and the
		// Argument are exactly Integers — so it says what the emitted
		// `__overload$1` used to say, and says it more strongly: a body typed
		// as an Error would leave the call standing.
		it("types the body from the inferred Parameter", () => {
			let generated = generate(`
				implementation {
					Terminal.inspect([1, 2, 3]::removeEvery(
						where (item) { <- item::isGreaterThan(2) },
					))
				}
			`)

			expect(generated).toContain("removeEvery__overload$2")
			expect(generated).toContain("item.value > ")
		})

		it("emits the same JavaScript however the literal was written", () => {
			let annotated = generate(`
				implementation {
					Terminal.inspect([1, 2, 3]::removeEvery(
						where (_ item: Integer) -> Boolean { <- item::isGreaterThan(2) },
					))
				}
			`)

			let inferred = generate(`
				implementation {
					Terminal.inspect([1, 2, 3]::removeEvery(
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

				Terminal.inspect("done")
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

				Terminal.inspect(describeValue({ x = 1, y = 2 }))
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
					<- match a::compare(to b) -> Item {
						case #Less    { <- a }
						case #Equal   { <- a }
						case #Greater { <- b }
					}
				}

				Terminal.inspect(smaller(5, 3))
			}`)

			expect(code).toContain("compare: Integer.compare")
			expect(code).toContain("Item__conformance.compare(")
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

				Terminal.inspect(outer({ x = 1, y = 2 }))
			}`)

			expect(code).toContain("inner(item, Item__conformance)")
		})

		it("should keep a flat witness a plain object literal", () => {
			const code = generate(`implementation {
				constant ordered: List<Integer> = [3, 1, 2]::sort()
			}`)

			// NOTE: An unconditional witness stays exactly the method-map object
			// literal — no `boundConformance` wrapper. `Integer.compare` is
			// native, so the witness is a plain member read.
			expect(code).toContain("compare: Integer.compare")
			expect(code).not.toContain("boundConformance")
		})

		it("should wrap a nested witness in boundConformance", () => {
			const code = generate(`implementation {
				constant ordered = [[1, 2], [3]]::sort()
			}`)

			// NOTE: `List<List<Integer>>` sorts through List's own `compare`,
			// curried with the inner Integer ordering — the conditional witness.
			expect(code).toContain("$type.boundConformance(")
			expect(code).toContain("compare: List.compare")
			expect(code).toContain("compare: Integer.compare")
		})

		it("should order multiple retrofitted bounds by Namespace Generic declaration", () => {
			const code = generate(`implementation {
				namespace Pair<infer Key, infer Value> for { key: Key, value: Value }
					is Comparable where Key is Comparable, Value is Comparable
				{
					compare(to other: { key: Key, value: Value }) -> Ordering {
						constant keyOrder = @.key::compare(to other.key)
						constant valueOrder = @.value::compare(to other.value)
						<- match keyOrder -> Ordering {
							case #Equal { <- valueOrder }
							case _ { <- keyOrder }
						}
					}
				}

				constant a = { key = 1, value = "x" }
				constant b = { key = 1, value = "y" }
				Terminal.inspect(a::compare(to b))
			}`)

			// NOTE: R7 — the hidden conformance Parameters follow the Namespace's
			// Generic declaration order (Key, then Value), and the call site's
			// witnesses appear in that same order so they line up.
			expect(code).toContain(
				"compare(_self, other, Key__conformance, Value__conformance)",
			)
			expect(code).toContain(
				"Key__conformance.compare(_self.key, other.key)",
			)
			expect(code).toContain(
				"Value__conformance.compare(_self.value, other.value)",
			)
		})
	})

	// NOTE: A free Function's Arguments carry labels exactly as a Method's do —
	// the standard library's `loop` family is told apart by nothing else — and a
	// label is spent entirely at compile time: what it decides is which
	// Parameter, and which Overload, an Argument is matched against, after which
	// the emitted call is positional and the label appears nowhere in it.
	describe("Labelled Arguments", () => {
		it("spends the label at compile time and emits the call positionally", async () => {
			const source = `implementation {
				function shout (about topic: String, times count: Integer) -> String {
					<- topic::append("!")::repeat(times count)
				}

				Terminal.inspect(shout(about "hi", times 2))
			}`

			const code = generate(source)

			// NOTE: The internal names survive as the emitted Parameters; the
			// LABELS are not names the JavaScript has anything to do with.
			expect(code).toContain("function shout(topic, count)")
			expect(code).not.toContain("about")
			expect(code).not.toContain("times")

			expect(await run(source)).toEqual(['"hi!hi!"'])
		})

		// NOTE: The one thing a free Function has instead of a receiver. Both
		// calls pass the same three Arguments in the same order, and the middle
		// label is the whole of the difference: `while` steps until the predicate
		// stops holding, `until` steps until it starts. The predicate holds on the
		// seed, so a Program that picked the wrong entry prints the other number.
		it("picks the Overload the label names", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(loop(
						startingWith 1,
						while (n) { <- n::isLessThan(4) },
						step (n) { <- n::add(1) },
					))

					Terminal.inspect(loop(
						startingWith 1,
						until (n) { <- n::isLessThan(4) },
						step (n) { <- n::add(1) },
					))
				}`),
			).toEqual(["4", "1"])
		})
	})

	// NOTE: A user's `overload` block defines every Overload itself, so the
	// emitted names run 1, 2, 3 in written order — the same numbering the call
	// site resolves against the Method Type. Only the Namespaces the standard
	// library declares can leave a gap, where a native holds the slot.
	// NOTE: A default is lowered to the JavaScript default parameter, whose
	// semantics are the language's term for term. A call that leaves an Argument
	// out therefore emits SHORT where nothing follows the hole, and passes
	// `void 0` where something does — the one place "no Argument given" is
	// deliberately introduced into emitted code, and spelled so that a Program
	// binding the NAME `undefined` can not capture it.
	describe("Default Parameter Values", () => {
		// NOTE: Asked with `pool-constants` off, so what is read back is the
		// default itself rather than the name the pool gave it — that pass
		// reaches a default too, and what IT does is `optimiser.spec`'s.
		it("should emit a default as the Parameter's own default", () => {
			expect(
				generate(
					`implementation {
					function f(_ count: Integer = 1) -> Integer {
						<- count
					}

					Terminal.inspect(f())
				}`,
					undefined,
					{
						enabled: true,
						disabledPasses: new Set(["pool-constants"]),
					},
				),
			).toContain("function f(count = Integer.createInteger(1)) {")
		})

		it("should emit a short call for a trailing omission", () => {
			expect(
				generate(`implementation {
					function f(_ count: Integer = 1) -> Integer {
						<- count
					}

					Terminal.inspect(f())
				}`),
			).toContain("f()")
		})

		it("should emit void 0 for an interior omission", () => {
			expect(
				generate(`implementation {
					function g(from a: Integer = 0, to b: Integer) -> Integer {
						<- b::subtract(a)
					}

					Terminal.inspect(g(to 7))
				}`),
			).toMatch(/g\(void 0, \$pool_\d\)/)
		})

		// NOTE: The case a naive reading of "trailing omissions are simply not
		// passed" breaks on — the hidden `__conformance` Argument a bounded
		// Generic appends comes AFTER the hole, so the hole has to be passed.
		it("should emit void 0 for an omission before a conformance Argument", () => {
			expect(
				generate(`implementation {
					function show<infer Value is Printable>(_ value: Value, with prefix: String = "> ") -> String {
						<- prefix::append(value::toString())
					}

					Terminal.inspect(show(1))
				}`),
			).toMatch(/show\(\$pool_\d, void 0, \$pool_\d\)/)
		})

		// NOTE: `undefined` is a NAME a Program may bind — `constant undefined =
		// 99` is legal Essence and emits a `const undefined` — so the hole is
		// spelled `void 0`, which is the same value under a spelling nothing can
		// rebind. Written as the Identifier, every hole in that Module was
		// passed the Program's own value.
		it("should not let a Constant named undefined capture a hole", async () => {
			let source = `implementation {
				constant undefined = 99

				function g(from a: Integer = 0, to b: Integer) -> Integer {
					<- b::subtract(a)
				}

				Terminal.inspect(g(to 7))
			}`

			expect(generate(source)).not.toContain("g(undefined")
			expect(await run(source)).toEqual(["7"])
		})

		it("should read @ as a binding rather than recompute the receiver", () => {
			expect(
				generate(`implementation {
					namespace Slices for List<Integer> {
						upTo(_ end: Integer = @::length()) -> Integer {
							<- end
						}
					}

					Terminal.inspect([1, 2]::upTo())
				}`),
			).toContain("static upTo(_self, end = List.length(_self)) {")
		})

		it("should run a defaulted call and its written twin", async () => {
			expect(
				await run(`implementation {
					function f(_ count: Integer = 1) -> Integer {
						<- count
					}

					function g(from a: Integer = 0, to b: Integer) -> Integer {
						<- b::subtract(a)
					}

					namespace Slices for List<Integer> {
						upTo(_ end: Integer = @::length()) -> Integer {
							<- end
						}
					}

					Terminal.inspect(f())
					Terminal.inspect(f(5))
					Terminal.inspect(g(to 7))
					Terminal.inspect(g(from 2, to 7))
					Terminal.inspect([1, 2, 3]::upTo())
					Terminal.inspect([1, 2, 3]::upTo(9))
				}`),
			).toEqual(["1", "5", "7", "5", "3", "9"])
		})

		// NOTE: Every branch of a dispatch resolves to a DIFFERENT Method, so
		// they need not agree on what may be left out — the shared Argument list
		// holds what the call wrote and each branch opens its own holes.
		const divergentDispatch = `implementation {
			namespace Scaled for Integer {
				measure(_ scale: Integer = 10, to limit: Integer) -> Integer {
					<- scale::multiply(with limit)
				}
			}

			namespace Plain for String {
				measure(to limit: Integer) -> Integer {
					<- limit
				}
			}

			function measured(_ value: Integer | String) -> Integer {
				<- value::measure(to 3)
			}

			Terminal.inspect(measured(1))
			Terminal.inspect(measured("a"))
		}`

		it("should let dispatch branches omit different Parameters", async () => {
			expect(await run(divergentDispatch)).toEqual(["30", "3"])
		})

		// NOTE: The same Program through the runtime's own search, which is
		// what `--without-optimisation compile-union-dispatch` builds — the two
		// have to agree, so the holes are opened in both.
		it("should let the runtime search open a branch's holes too", () => {
			expect(
				generate(divergentDispatch, undefined, {
					enabled: true,
					disabledPasses: new Set(["compile-union-dispatch"]),
				}),
			).toContain("$type.dispatchMethod")
		})
	})

	describe("Overload Numbering", () => {
		it("should number a Namespace's own Overloads in written order", async () => {
			const source = `implementation {
				namespace Greeter for String {
					overload greet {
						() -> String { <- @::append("!") }
						(_ other: String) -> String { <- @::append(other) }
					}
				}

				Terminal.inspect("hello"::greet())
				Terminal.inspect("hello"::greet(" world"))
			}`

			const code = generate(source)

			expect(code).toContain("greet__overload$1")
			expect(code).toContain("greet__overload$2")
			expect(code).not.toContain("greet__overload$3")

			expect(await run(source)).toEqual(['"hello!"', '"hello world"'])
		})
	})

	describe("Union Method Dispatch", () => {
		it("should emit one statically resolved target per member", () => {
			const source = `implementation {
				constant value: Integer | Boolean = 5

				Terminal.inspect(value::toString())
			}`
			const code = generate(source)

			// NOTE: `compile-union-dispatch` writes the search out where it
			// stands — a test on the receiver's tag and the branch it selects.
			// With the pass off the same targets are reached through
			// `$type.dispatchMethod`, which is what this Namespace asked about
			// before there was a pass to compile it.
			expect(code).toContain('value[$type.typeKeySymbol] === "Integer"')
			expect(
				generate(source, undefined, {
					enabled: true,
					disabledPasses: new Set(["compile-union-dispatch"]),
				}),
			).toContain("$type.dispatchMethod")
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

				Terminal.inspect(number::multiply(with 2)::toString())
			}`)

			// NOTE: The mangled name survives into both spellings — the
			// Integer entry is native, a member read off the plain import,
			// while the Rational entry is Essence and so is its own const.
			expect(code).toContain("Integer.multiply__overload$")
			expect(code).toContain("$es_Rational_multiply__overload$")
		})

		// NOTE: `fallback` is `Item | Boolean`, so `toString` dispatches over a
		// Union — the `Item` case through the conformance witness, the
		// `Boolean` case to `Boolean.toString`, which is implemented in
		// Essence. This is the Union-dispatch-to-an-Essence-Method path: the
		// case target is the bare `$es_Boolean_toString`, and the reachability
		// gate has to pull that const in off the emitted branch for the Program
		// to run — no other expression in the Program names it.
		//
		// NOTE: The Union is spelled out by hand and `Item` is inferred from a
		// second Parameter, because an argument that lands on the concrete
		// member leaves `Item` unbound and the call is rejected as
		// uninferable. This pair of tests used to reach the same shape through
		// `items::firstItem()::toString()`, back when `Optional<Item>` was a
		// Type Alias for `Item | Nothing`; `Optional` is a Choice now, so
		// `toString` on it resolves statically to `$es_Optional_toString` and
		// dispatches over nothing at all.
		it("should dispatch a bounded Type Parameter member through the conformance parameter", async () => {
			const source = `implementation {
				function describe <infer Item is Printable>(_ item: Item, or fallback: Item | Boolean) -> String {
					<- fallback::toString()
				}

				Terminal.inspect(describe(1, or 2))
				Terminal.inspect(describe(1, or true))
			}`
			const code = generate(source)

			expect(code).toContain(
				'fallback[$type.typeKeySymbol] === "Boolean"',
			)
			expect(code).toContain("$es_Boolean_toString")
			expect(code).toContain("const $es_Boolean_toString")
			expect(code).toContain("Item__conformance.toString")
			expect(await run(source)).toEqual(['"2"', '"true"'])
		})

		it("should order the catch-all Type Parameter case last", () => {
			const code = generate(`implementation {
				function describe <infer Item is Printable>(_ item: Item, or fallback: Item | Boolean) -> String {
					<- fallback::toString()
				}

				Terminal.inspect(describe(1, or 2))
				Terminal.inspect(describe(1, or true))
			}`)

			// NOTE: `lastIndexOf` is what picks the emitted branch out —
			// `$es_Boolean_toString` is also the name of the prelude const,
			// which is emitted above every Function and would otherwise be the
			// occurrence found. The conformance read appears in the chain and
			// nowhere else, and it comes after: a catch-all accepts every value
			// there is, so it can only be tried once everything else has
			// declined.
			expect(code.lastIndexOf("$es_Boolean_toString")).toBeGreaterThan(-1)
			expect(code.lastIndexOf("$es_Boolean_toString")).toBeLessThan(
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

				Terminal.inspect(value::tag())
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

				Terminal.inspect(stringify([1, 2, 3]))
				Terminal.inspect(same([1, 2], [1, 2])::toString())
				Terminal.inspect(same([1, 2], [3, 4])::toString())
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
			// NOTE: The lookup keys on Methods only. `Number.Pi` is a Property
			// and reaches a call site through a member read, never a const.
			expect(essenceMethodName("Number", "Pi")).toBeNull()
		})

		it("keeps an overload's mangled suffix in the name", () => {
			expect(essenceMethodIdentifier("Number", "sum__overload$2")).toBe(
				"$es_Number_sum__overload$2",
			)
		})

		// NOTE: The Properties are asked for separately, because a Property's const
		// is emitted in a band of its own — but under the same name, so the two
		// tables must not both answer for one member. No standard library Property
		// has a value today, so every one of them is a member read.
		it("returns null for a static Property the library gives no value", () => {
			expect(essencePropertyName("Number", "Pi")).toBeNull()
			expect(essencePropertyName("Number", "Tau")).toBeNull()
		})

		it("keeps a Method out of the Property table", () => {
			expect(essencePropertyName("Boolean", "isNot")).toBeNull()
			expect(essenceMethodName("Boolean", "isNot")).toBe(
				"$es_Boolean_isNot",
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

					Terminal.inspect(new::toString())
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

						Terminal.inspect(delete::toString())
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

						Terminal.inspect(pick(3, or 4)::toString())
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

						Terminal.inspect(thing.new::add(thing.default)::toString())
					}
				`),
			).toEqual([`"3"`])
		})
	})

	describe("Standard Library Prelude", () => {
		// NOTE: A synthetic standard library, so a shape the real one does not
		// have yet can be handed to the Rewriter — the edges are read off the
		// prelude that comes back, so a prelude the process-wide one knows nothing
		// about is exactly what these must answer for.
		function preludeOf(source: string) {
			return buildStdlibPrelude(
				loadStdlibFrom([parseStdlibSource("Synthetic.es", source)]),
			)
		}

		it("emits an Essence-implemented Method as its own const", () => {
			const code = generate(`implementation {
				Terminal.inspect(true::isNot(false))
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

		// NOTE: The const's body names another Namespace — `isNot` is
		// `@::is(other)::negate()`, and `Boolean.is` is a native, so it is a
		// plain member read off the runtime module the plain import binds. The
		// `negate` around it is not a call any more: `lower-scalar-operations`
		// writes it out as JavaScript's own `!`.
		it("emits a body that reads the natives off the runtime module", () => {
			const code = generate(`implementation {
				Terminal.inspect(true::isNot(false))
			}`)

			expect(code).toContain("!Boolean.is(_self, other).value")
		})

		// NOTE: An unused const is not free — it still names the runtime Methods
		// its body reaches, and once a module is in the graph its impure
		// top-level initialisers can not be dropped — so a Program that never
		// names the Method must not get its const. The plain import stays and,
		// unreferenced, the Bundler shakes it away.
		it("emits no const for a Method the Program never names", () => {
			const code = generate(`implementation {
				Terminal.inspect("hello")
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

				Terminal.inspect(differ(yes, yes))
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

				Terminal.inspect(record.Boolean)
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
			const source = readFileSync(fixturePath("Everyday.es"), {
				encoding: "utf-8",
			})

			expect(generate(source)).not.toMatch(/\{\s*\.\.\./)
		})

		// NOTE: The `$es_` prefix can not collide with a user identifier because
		// `_` is a Lexer Symbol — no user name contains one. `$esBooleanisNot` is
		// the closest a user can write, and it must survive as its own distinct
		// binding alongside the Rewriter's `$es_Boolean_isNot`.
		it("keeps a user identifier near the prefix distinct", async () => {
			const source = `implementation {
				constant $esBooleanisNot = "mine"

				Terminal.inspect($esBooleanisNot::append(true::isNot(false)::toString()))
			}`

			const code = generate(source)

			expect(code).toContain("$esBooleanisNot")
			expect(code).toContain("$es_Boolean_isNot")
			expect(await run(source)).toEqual(['"minetrue"'])
		})

		it("runs isNot from its const", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(false::isNot(true)::toString())
					Terminal.inspect(true::isNot(true)::toString())
					Terminal.inspect(false::isNot(false)::toString())
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

				Terminal.inspect(differ(true, false)::toString())
				Terminal.inspect(differ(true, true)::toString())
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

				Terminal.inspect(value::toString())
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
					Terminal.inspect(5::isBetween(1, and 10)::toString())
					Terminal.inspect(1::isBetween(1, and 10)::toString())
					Terminal.inspect(10::isBetween(1, and 10)::toString())
					Terminal.inspect(11::isBetween(1, and 10)::toString())
					Terminal.inspect(0::isBetween(1, and 10)::toString())
					Terminal.inspect(5::isBetween(10, and 1)::toString())
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
					Terminal.inspect(Number.Pi::isBetween(3, and 22/7)::toString())
					Terminal.inspect(Number.Pi::isBetween(22/7, and 4)::toString())
					Terminal.inspect(3/2::isBetween(1, and 2)::toString())
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
				Terminal.inspect(5::isBetween(1, and 10)::isNot(false))
			}`)

			expect(both).toContain("const $es_Number_isBetween")
			expect(both).toContain("const $es_Boolean_isNot")

			// NOTE: `isNot` alone — a Program that never names a Number.
			const booleanOnly = generate(`implementation {
				Terminal.inspect(true::isNot(false))
			}`)

			expect(booleanOnly).not.toContain("$es_Number_isBetween")
			expect(booleanOnly).toContain("const $es_Boolean_isNot")

			// NOTE: `isBetween` alone reaches only natives, so its const stands
			// alone.
			const numberReached = generate(`implementation {
				Terminal.inspect(5::isBetween(1, and 10))
			}`)

			expect(numberReached).toContain(
				"const $es_Number_isBetween = function (_self, lower, upper) {",
			)
			expect(numberReached).not.toContain("$es_Boolean_isNot")

			// NOTE: Neither. A String-only Program names no Essence Method at all
			// and gets no const.
			const neither = generate(`implementation {
				Terminal.inspect("hello")
			}`)

			expect(neither).not.toContain("$es_Number_isBetween")
			expect(neither).not.toContain("$es_Boolean_isNot")
		})

		// NOTE: A value-LESS `static PI: Transcendental` is a native — it reaches
		// no typed Node, so the prelude has nothing to emit for it — and it stays a
		// plain member read off the runtime module, `Number.Pi`, like every native.
		it("reads Pi and Tau as native member reads", async () => {
			const source = `implementation {
				Terminal.inspect(Number.Pi::toString())
				Terminal.inspect(Number.Tau::toString())
				Terminal.inspect(Number.Pi::isBetween(3, and 22/7)::toString())
			}`

			expect(generate(source)).toContain("Number.Pi")
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

			buildStdlibPrelude(loadStdlib())

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

			let prelude = buildStdlibPrelude(stdlib)

			expect(prelude).toHaveLength(1)
			expect(prelude[0]!.name).toBe("Mixed")
			expect(Object.keys(prelude[0]!.node.methods)).toEqual([
				"combine__overload$2",
			])
		})

		// NOTE: The two tables the Rewriter reads a free Function off. They are
		// complementary and both derived from the loader's `functionBindings`, so
		// they can only be right together: a bodied entry is emitted as a
		// declaration of its own and a native one is a read off the runtime
		// `functions` module, and an entry that landed in both — or in neither —
		// is either a name emitted twice or a `ReferenceError` at run time.
		describe("the standard library's free Functions", () => {
			it("collects the Essence-bodied entries by their emitted name", () => {
				expect(
					stdlibFreeFunctions().map(
						(freeFunction) => freeFunction.name,
					),
				).toEqual(["loop__overload$2", "loop__overload$3"])
			})

			// NOTE: The name the Rewriter keys a candidate by has to be the name
			// the emitted declaration answers to, or the fixed point would pull in
			// a declaration that defines something else.
			it("names each one after the Node it hands over", () => {
				for (let freeFunction of stdlibFreeFunctions()) {
					expect(freeFunction.node.nodeType).toBe("FunctionStatement")
					expect(freeFunction.node.name.name).toBe(freeFunction.name)
				}
			})

			it("builds them once per process, beside the prelude", () => {
				expect(stdlibFreeFunctions()).toBe(stdlibFreeFunctions())
			})

			it("names every native entry, one per native slot", () => {
				expect([...nativeFreeFunctionNames()].sort()).toEqual([
					"loop__overload$1",
					"loop__overload$4",
				])
			})

			it("memoises the native names", () => {
				expect(nativeFreeFunctionNames()).toBe(
					nativeFreeFunctionNames(),
				)
			})

			// NOTE: The invariant the two tables exist to keep, read off the
			// loader's flags rather than off a list written by hand — every
			// declared entry is accounted for by exactly one of them, under the
			// `__overload$N` name its SLOT gives it.
			it("accounts for every declared entry exactly once", () => {
				let stdlib = loadStdlib()
				let bodied = new Set(
					stdlibFreeFunctions().map(
						(freeFunction) => freeFunction.name,
					),
				)
				let natives = nativeFreeFunctionNames()

				for (let [name, flags] of Object.entries(
					stdlib.functionBindings,
				)) {
					flags.forEach((native, index) => {
						let emitted =
							stdlib.members[name]?.type ===
							"OverloadedStaticMethod"
								? resolveOverloadedMethodName(name, index)
								: name

						expect(natives.has(emitted)).toBe(native)
						expect(bodied.has(emitted)).toBe(!native)
					})
				}
			})
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

			// NOTE: The free Functions share the ONE fixed point with the
			// Methods, so an edge that crosses between the two kinds has to be
			// followed like any other. Driven over a synthetic library whose
			// chain crosses the boundary twice — Method to free Function, free
			// Function to free Function, free Function back to Method — because
			// the real library's two bodied entries call a native `while` and
			// nothing else, so it exercises no crossing edge at all yet.
			describe("free Functions", () => {
				const crossing = `declarations {
	§§ Doubles the value.
	§§
	§§ @param value — the Integer to double.
	§§ @returns — twice the value.
	function double(_ value: Integer) -> Integer {
		<- value::twice()
	}

	§§ Quadruples the value.
	§§
	§§ @param value — the Integer to quadruple.
	§§ @returns — four times the value.
	function quadruple(_ value: Integer) -> Integer {
		<- double(double(value))
	}

	namespace Inner for Integer {
		§§ Twice the value.
		§§
		§§ @returns — twice the value.
		twice() -> Integer {
			<- @
		}

		§§ Four times the value, by way of the free Function.
		§§
		§§ @returns — four times the value.
		fourTimes() -> Integer {
			<- quadruple(@)
		}
	}
}`

				// NOTE: The free-Function half of a synthetic prelude, built the
				// way `buildStdlibArtifacts` builds the real one — the copy
				// before the Simplifier included, since it writes into the Nodes
				// it is handed. It can not be read off `stdlibFreeFunctions`,
				// which answers for the process-wide standard library.
				function freeFunctionsOf(
					source: string,
				): Array<PreludeFreeFunction> {
					return loadStdlibFrom([
						parseStdlibSource("Crossing.es", source),
					]).typedPrograms.flatMap((typedProgram) =>
						optimise(
							simplify(structuredClone(typedProgram)),
						).implementation.nodes.flatMap((node) =>
							node.nodeType === "FunctionStatement"
								? [{ name: node.name.name, node }]
								: [],
						),
					)
				}

				// NOTE: A free Function is reached as a bare Identifier call —
				// the emitted spelling of `quadruple(…)`, and of an overloaded
				// entry's `quadruple__overload$2(…)` alike.
				function callOfFunction(
					name: string,
				): estree.ExpressionStatement {
					return {
						type: "ExpressionStatement",
						expression: {
							type: "CallExpression",
							optional: false,
							callee: { type: "Identifier", name },
							arguments: [],
						},
					}
				}

				it("follows the chain across both boundaries", () => {
					let reachable = reachableEssenceMethods(
						preludeOf(crossing),
						[callOf("Inner", "fourTimes")],
						freeFunctionsOf(crossing),
					)

					expect([...reachable.keys()].sort()).toEqual([
						"$es_Inner_fourTimes",
						"$es_Inner_twice",
						"double",
						"quadruple",
					])
				})

				it("follows a free Function's own edges when the Program names it", () => {
					let reachable = reachableEssenceMethods(
						preludeOf(crossing),
						[callOfFunction("double")],
						freeFunctionsOf(crossing),
					)

					expect([...reachable.keys()].sort()).toEqual([
						"$es_Inner_twice",
						"double",
					])
				})

				it("keeps a free Function nothing names out", () => {
					let reachable = reachableEssenceMethods(
						preludeOf(crossing),
						[callOf("Inner", "twice")],
						freeFunctionsOf(crossing),
					)

					expect([...reachable.keys()]).toEqual(["$es_Inner_twice"])
				})

				// NOTE: A free Function is emitted as a declaration of its own
				// rather than as a const — nothing has to hold a Function
				// expression for it, and the name it answers to is the bare one a
				// call site resolved to.
				it("emits a free Function as its own declaration", () => {
					let reachable = reachableEssenceMethods(
						preludeOf(crossing),
						[callOfFunction("double")],
						freeFunctionsOf(crossing),
					)

					expect(reachable.get("double")?.declaration).toMatchObject({
						type: "FunctionDeclaration",
						id: { type: "Identifier", name: "double" },
					})
					expect(
						reachable.get("$es_Inner_twice")?.declaration.type,
					).toBe("VariableDeclaration")
				})

				// NOTE: The set handed in is what decides an edge, exactly as
				// `implemented` does for a Method — so a NATIVE free Function,
				// which is a read off `$_` and reaches no const, drops out along
				// with everything it would have pulled in.
				it("draws no edge to a free Function this run does not implement", () => {
					let reachable = reachableEssenceMethods(
						preludeOf(crossing),
						[callOf("Inner", "fourTimes")],
					)

					expect([...reachable.keys()]).toEqual([
						"$es_Inner_fourTimes",
					])
				})
			})

			// NOTE: The sweep the emitted Program is held to after every rewrite
			// — the net under the fixed point above, and the reason a shape the
			// edge finder does not know about can not reach a user again. Driven
			// with a hand-built tree, because while the Rewriter is right the
			// only way to see it fire is to hand it a Program that names a const
			// nobody emitted.
			describe("the emitted-name sweep", () => {
				function programOf(
					body: Array<estree.Statement>,
				): estree.Program {
					return { type: "Program", sourceType: "module", body }
				}

				it("accepts a Program whose every named Method was emitted", () => {
					expect(() =>
						checkEssenceMethodsAreDeclared(
							programOf([callOf("Inner", "double")]),
							new Set(["$es_Inner_double"]),
						),
					).not.toThrow()
				})

				it("throws on a Method named with no const emitted for it", () => {
					expect(() =>
						checkEssenceMethodsAreDeclared(
							programOf([callOf("Inner", "double")]),
							new Set(["$es_Outer_quadruple"]),
						),
					).toThrow(
						"The emitted Program names '$es_Inner_double', but no const was emitted for it. This is a bug in the Compiler.",
					)
				})

				// NOTE: The sweep reads REFERENCES, so an object literal's key
				// and a dotted member — text, both of them — are none of its
				// business. `{ $es_Inner_double: … }` is a witness's method map,
				// which names a Method it does not call.
				it("leaves a member and a key that are only spelled that way alone", () => {
					expect(() =>
						checkEssenceMethodsAreDeclared(
							programOf([
								{
									type: "ExpressionStatement",
									expression: {
										type: "ObjectExpression",
										properties: [
											{
												type: "Property",
												kind: "init",
												method: false,
												shorthand: false,
												computed: false,
												key: {
													type: "Identifier",
													name: "$es_Inner_double",
												},
												value: {
													type: "MemberExpression",
													optional: false,
													computed: false,
													object: {
														type: "Identifier",
														name: "Inner",
													},
													property: {
														type: "Identifier",
														name: "$es_Inner_double",
													},
												},
											},
										],
									},
								},
							]),
							new Set(),
						),
					).not.toThrow()
				})

				// NOTE: A free Function's const is emitted under its bare name,
				// which a user's own binding can be spelled exactly like — the
				// prefix is what makes the sweep safe, so everything without it
				// is left to the fixed point.
				it("says nothing about a name that carries no prefix", () => {
					expect(() =>
						checkEssenceMethodsAreDeclared(
							programOf([
								{
									type: "ExpressionStatement",
									expression: {
										type: "Identifier",
										name: "loop__overload$2",
									},
								},
							]),
							new Set(),
						),
					).not.toThrow()
				})
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

					expect([...refs.references]).toEqual([
						"$es_Target_instance",
					])
					expect([...refs.evaluatedReferences]).toEqual([
						"$es_Target_instance",
					])
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

					let called = essenceMethodReferences(
						{
							nodeType: "FunctionInvocation",
							name: lookup,
							arguments: [],
						},
						implemented,
					)

					expect([...called.references]).toEqual([
						"$es_Target_static",
					])
					expect([...called.evaluatedReferences]).toEqual([
						"$es_Target_static",
					])

					// NOTE: A static Method passed as a value, not called — the
					// shape an earlier version missed by only inspecting a
					// `FunctionInvocation`'s callee. It is an edge for
					// reachability, since the const is named, and NOT an ordering
					// constraint on the value band: the body it names runs
					// whenever whoever was handed it calls it.
					let handedOn = essenceMethodReferences(
						{ nodeType: "Argument", value: lookup },
						implemented,
					)

					expect([...handedOn.references]).toEqual([
						"$es_Target_static",
					])
					expect([...handedOn.evaluatedReferences]).toEqual([])
				})

				// NOTE: A static Property READ is the same Node shape as a static
				// Method reference, so which table holds the pair is the whole of
				// the difference — and a native Property is in neither, which is why
				// `Number.Pi` draws no edge to a const nothing emitted.
				it("follows a read of a static Property the prelude gives a value", () => {
					const lookup = {
						nodeType: "Lookup",
						base: {
							nodeType: "Identifier",
							name: "Target",
							type: { type: "Namespace" },
						},
						member: { nodeType: "Identifier", name: "CONSTANT" },
					}

					let refs = essenceMethodReferences(
						lookup,
						implemented,
						new Set(),
						new Set(["Target CONSTANT"]),
					)

					expect([...refs.references]).toEqual([
						"$es_Target_CONSTANT",
					])
					// NOTE: A Property read is evaluated wherever it stands —
					// reading the const IS taking the value, so there is no
					// handing it on the way a Method reference is.
					expect([...refs.evaluatedReferences]).toEqual([
						"$es_Target_CONSTANT",
					])

					expect([
						...essenceMethodReferences(lookup, implemented)
							.references,
					]).toEqual([])
				})

				// NOTE: A Method handed to a call is a Method that call may run at
				// once — `items::map(Boolean.isNot)` and every native taking a
				// callback — so it counts as evaluated where a stored one does
				// not. Without this a Property could be emitted above a Property
				// the Method it passed along reads. The callee here is a native
				// free Function, the shape whose Arguments the runtime runs.
				it("evaluates a static Method given to a call as an Argument", () => {
					let refs = essenceMethodReferences(
						{
							nodeType: "FunctionInvocation",
							name: { nodeType: "Identifier", name: "loop" },
							arguments: [
								{
									nodeType: "Argument",
									value: {
										nodeType: "Lookup",
										base: {
											nodeType: "Identifier",
											name: "Target",
											type: { type: "Namespace" },
										},
										member: {
											nodeType: "Identifier",
											name: "static",
										},
									},
								},
							],
						},
						implemented,
					)

					expect([...refs.evaluatedReferences]).toEqual([
						"$es_Target_static",
					])
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

					expect([...refs.references]).toEqual([
						"$es_Target_witnessed",
					])
					// NOTE: A witness holds its Methods, it does not run them —
					// whoever is handed the witness calls them, later — so the
					// value band is not ordered against what they read.
					expect([...refs.evaluatedReferences]).toEqual([])
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

					expect([...refs.references]).toEqual([
						"$es_Target_dispatched",
					])
				})

				// NOTE: The one shape that draws a free-Function edge instead of a
				// Method one — a `FunctionInvocation` off a bare Identifier, which
				// is what an overloaded free Function's call site looks like once
				// the Simplifier has mangled the callee. The reference IS the bare
				// name, because that is the key the free Function's own
				// declaration is emitted under.
				it("follows a bare free-Function call", () => {
					let refs = essenceMethodReferences(
						{
							nodeType: "FunctionInvocation",
							name: {
								nodeType: "Identifier",
								name: "loop__overload$2",
							},
							arguments: [],
						},
						implemented,
						new Set(["loop__overload$2"]),
					)

					expect([...refs.references]).toEqual(["loop__overload$2"])
				})

				// NOTE: A native free Function is reached off `$_`, and a call on a
				// Function-typed local or Parameter is the very same Node shape —
				// neither is in the set, so neither draws an edge to a const that
				// was never emitted for it.
				it("draws no edge to a free Function the run does not implement", () => {
					let refs = essenceMethodReferences(
						{
							nodeType: "FunctionInvocation",
							name: {
								nodeType: "Identifier",
								name: "loop__overload$1",
							},
							arguments: [],
						},
						implemented,
						new Set(["loop__overload$2"]),
					)

					expect([...refs.references]).toEqual([])
				})

				// NOTE: One body reaches both kinds, and the two sets decide
				// independently — the free-Function edge is keyed by the bare name
				// and the Method edge by the `$es_…` one, so neither filter can
				// answer for the other.
				it("follows a Method and a free Function out of one body", () => {
					let refs = essenceMethodReferences(
						{
							nodeType: "FunctionInvocation",
							name: {
								nodeType: "Identifier",
								name: "loop__overload$2",
							},
							arguments: [
								{
									nodeType: "Argument",
									value: {
										nodeType: "MethodInvocation",
										base: {
											nodeType: "Identifier",
											name: "Target",
										},
										member: { name: "instance" },
										arguments: [],
									},
								},
							],
						},
						implemented,
						new Set(["loop__overload$2"]),
					)

					expect([...refs.references].sort()).toEqual([
						"$es_Target_instance",
						"loop__overload$2",
					])
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

					expect([...refs.references]).toEqual([])
				})
			})
		})

		// NOTE: A bodied static Property is emitted as a const of its own, in a
		// band BELOW every Function-valued member — its value is computed where
		// the const stands, not when something calls it, so the band is the only
		// place from which it can read the Methods it needs. No standard library
		// Property has a value yet, which is what keeps every golden
		// byte-identical while the machinery below is live; the fixtures are
		// synthetic for the same reason.
		describe("a bodied static Property", () => {
			// NOTE: `Constants.DOUBLE` reads `Other.BASE` and calls `Other.doubled`
			// — one edge into the value band and one out of it. The reading
			// Namespace is written BELOW the one it reads on purpose: a Property's
			// value is enriched where the `namespace` stands, so it can only name a
			// Namespace already declared, which is why no cycle among them can be
			// written in a source at all.
			const constants = `declarations {
	namespace Other for Integer {
		§§ The base value.
		static BASE: Integer = 2

		§§ Twice the value.
		§§
		§§ @returns — twice the value.
		doubled() -> Integer {
			<- @
		}
	}

	namespace Constants for Integer {
		§§ Twice the base.
		static DOUBLE: Integer = Other.BASE::doubled()
	}
}`

			// NOTE: A read of an Essence-implemented member is a bare `$es_…`
			// Identifier by the time the seed sees it, whether it is a Property's
			// value or a Method passed as one.
			function referenceOf(name: string): estree.ExpressionStatement {
				return {
					type: "ExpressionStatement",
					expression: { type: "Identifier", name },
				}
			}

			function nameOf(
				declaration:
					| estree.VariableDeclaration
					| estree.FunctionDeclaration,
			): string {
				return declaration.type === "FunctionDeclaration"
					? declaration.id!.name
					: (declaration.declarations[0]!.id as estree.Identifier)
							.name
			}

			it("keeps a Namespace whose only bodied member is a Property", () => {
				let prelude = preludeOf(constants)

				expect(prelude.map((namespace) => namespace.name)).toEqual([
					"Other",
					"Constants",
				])
				expect(Object.keys(prelude[1]!.node.methods)).toEqual([])
				expect(Object.keys(prelude[1]!.node.properties)).toEqual([
					"DOUBLE",
				])
			})

			// NOTE: The fixed point runs over the Properties on the same footing as
			// the Methods: the Program names one Property, whose value reaches the
			// other and the Method it calls. The KIND comes back with each, because
			// nothing about the name or the declaration tells a Method's const from
			// a Property's.
			it("emits the value as a const of its own, and reaches what it reads", () => {
				let reachable = reachableEssenceMethods(preludeOf(constants), [
					referenceOf("$es_Constants_DOUBLE"),
				])

				expect([...reachable.keys()].sort()).toEqual([
					"$es_Constants_DOUBLE",
					"$es_Other_BASE",
					"$es_Other_doubled",
				])
				expect(reachable.get("$es_Constants_DOUBLE")).toMatchObject({
					kind: "value",
					declaration: {
						type: "VariableDeclaration",
						kind: "const",
						declarations: [
							{
								id: {
									type: "Identifier",
									name: "$es_Constants_DOUBLE",
								},
							},
						],
					},
				})
				expect(reachable.get("$es_Other_doubled")?.kind).toBe(
					"function",
				)
			})

			it("keeps a Property nothing reads out", () => {
				let reachable = reachableEssenceMethods(preludeOf(constants), [
					referenceOf("$es_Other_doubled"),
				])

				expect([...reachable.keys()]).toEqual(["$es_Other_doubled"])
			})

			// NOTE: Both bands in one list. The Map is in DISCOVERY order —
			// `DOUBLE`, then the members its value reaches — so this is exactly
			// what the partition and the topological sort are for: every Function
			// first, and `BASE` above the `DOUBLE` that reads it. Emitted in
			// discovery order the value band would read `$es_Other_BASE` before its
			// const existed.
			it("emits the Functions first, then each Property below the one it reads", () => {
				let ordered = orderEssenceMembers(
					reachableEssenceMethods(preludeOf(constants), [
						referenceOf("$es_Constants_DOUBLE"),
					]),
				)

				expect(ordered.map(nameOf)).toEqual([
					"$es_Other_doubled",
					"$es_Other_BASE",
					"$es_Constants_DOUBLE",
				])
			})

			// NOTE: The edge that is only visible through a Method's body, and the
			// one an earlier version of this band dropped: `Constants.DOUBLE` reads
			// no Property at all, it CALLS `Reader.readsBase` — and that call runs
			// where the const stands, so `Other.BASE` is read there and has to be
			// bound first. Emitted in discovery order, or ordered on
			// Property-to-Property edges alone, `$es_Constants_DOUBLE` comes out
			// above the `$es_Other_BASE` its initialiser reads: a `ReferenceError`
			// at import out of a Program that compiled green.
			it("orders a Property below what the Method it calls reads", () => {
				const throughAMethod = `declarations {
	namespace Other for Integer {
		§§ The base value.
		static BASE: Integer = 2
	}

	namespace Reader for Integer {
		§§ The base value, read the long way around.
		§§
		§§ @returns — the base value.
		readsBase() -> Integer {
			<- Other.BASE
		}
	}

	namespace Constants for Integer {
		§§ The base value, once removed.
		static DOUBLE: Integer = 3::readsBase()
	}
}`

				let reachable = reachableEssenceMethods(
					preludeOf(throughAMethod),
					[referenceOf("$es_Constants_DOUBLE")],
				)

				expect(
					reachable.get("$es_Constants_DOUBLE")?.evaluatedReferences,
				).toEqual(new Set(["$es_Reader_readsBase"]))
				expect(orderEssenceMembers(reachable).map(nameOf)).toEqual([
					"$es_Reader_readsBase",
					"$es_Other_BASE",
					"$es_Constants_DOUBLE",
				])
			})

			// NOTE: The edge inside ONE Namespace, which is the shape a Namespace
			// naming itself made writable — `static Tau = Number.Pi` is the
			// spelling the numeric tower's constants want. It is an ordinary edge
			// of the band, and it is the only direction there is: a Property
			// reading one written BELOW it is refused by the Validator, so the
			// consts of one Namespace reach the band in an order that already runs.
			it("orders a Property below the one it reads in its own Namespace", () => {
				const ownNamespace = `declarations {
	namespace Constants for Integer {
		§§ The base value.
		static BASE: Integer = 2

		§§ The base value, read through the Namespace's own name.
		static ECHO: Integer = Constants.BASE
	}
}`

				let reachable = reachableEssenceMethods(
					preludeOf(ownNamespace),
					[referenceOf("$es_Constants_ECHO")],
				)

				expect(
					reachable.get("$es_Constants_ECHO")?.evaluatedReferences,
				).toEqual(new Set(["$es_Constants_BASE"]))
				expect(orderEssenceMembers(reachable).map(nameOf)).toEqual([
					"$es_Constants_BASE",
					"$es_Constants_ECHO",
				])
			})

			// NOTE: The shapes the band can not survive, handed in directly because
			// none of them can be written in a source: a Property's value only
			// names Namespaces above it — or its own, and there only a Property
			// written above it — so every edge points backwards. They are
			// refused rather than emitted in an order that happens to run —
			// whichever const comes first reads one that does not exist yet, which
			// is a `ReferenceError` at import out of a Program that compiled green.
			//
			// NOTE: The edges are the EVALUATED ones, since those are what the
			// ordering follows, and a name listed in `functions` is a
			// Function-valued member — which is how a route from a Property through
			// a Method and back is written here.
			function band(
				edges: Record<string, Array<string>>,
				functions: Array<string> = [],
			): Map<string, EssenceMember> {
				return new Map(
					Object.entries(edges).map(([name, references]) => [
						name,
						{
							kind: functions.includes(name)
								? "function"
								: "value",
							declaration: {
								type: "VariableDeclaration",
								kind: "const",
								declarations: [
									{
										type: "VariableDeclarator",
										id: { type: "Identifier", name },
										init: null,
									},
								],
							},
							references: new Set(references),
							evaluatedReferences: new Set(references),
						},
					]),
				)
			}

			// NOTE: The seam between the two bands, asked for directly —
			// the pooled constants are emitted BETWEEN them, so which
			// declaration is in which band decides whether a Program's
			// constants can be read where they are needed. `orderEssenceMembers`
			// above is the same answer with the seam closed up.
			it("keeps the Function-valued members apart from the Properties", () => {
				let bands = essenceMemberBands(
					band(
						{
							$es_A_ONE: ["$es_F_reads"],
							$es_F_reads: [],
							$es_B_TWO: [],
						},
						["$es_F_reads"],
					),
				)

				expect(bands.functions.map(nameOf)).toEqual(["$es_F_reads"])
				expect(bands.values.map(nameOf)).toEqual([
					"$es_A_ONE",
					"$es_B_TWO",
				])
			})

			it("refuses two Properties that read each other", () => {
				expect(() =>
					orderEssenceMembers(
						band({
							$es_A_ONE: ["$es_B_TWO"],
							$es_B_TWO: ["$es_A_ONE"],
						}),
					),
				).toThrow("$es_A_ONE -> $es_B_TWO -> $es_A_ONE")
			})

			// NOTE: A self-edge is a cycle here, unlike among the Methods, where a
			// Method calling itself is how recursion is written.
			it("refuses a Property that reads itself", () => {
				expect(() =>
					orderEssenceMembers(band({ $es_A_ONE: ["$es_A_ONE"] })),
				).toThrow("$es_A_ONE -> $es_A_ONE")
			})

			// NOTE: The edge a Method HIDES. `A` calls a Method that reads `B`, and
			// the call runs inside `A`'s own initialiser, so `B` is read before `A`
			// is bound and its const has to stand above `A`'s — the Method's own
			// const is in the band above and constrains nothing.
			it("orders a Property below the Properties the Method it calls reads", () => {
				let ordered = orderEssenceMembers(
					band(
						{
							$es_A_ONE: ["$es_F_reads"],
							$es_F_reads: ["$es_B_TWO"],
							$es_B_TWO: [],
						},
						["$es_F_reads"],
					),
				)

				expect(ordered.map(nameOf)).toEqual([
					"$es_F_reads",
					"$es_B_TWO",
					"$es_A_ONE",
				])
			})

			// NOTE: The same route closing on itself — a temporal dead zone no
			// order can fix, and the shape the band was blind to while it followed
			// Property-to-Property edges alone. The refusal names the Methods it
			// went through, because the two Properties on their own read nothing of
			// each other.
			it("refuses a Property a Method it calls reads back", () => {
				expect(() =>
					orderEssenceMembers(
						band(
							{
								$es_A_ONE: ["$es_F_reads"],
								$es_F_reads: ["$es_G_reads"],
								$es_G_reads: ["$es_A_ONE"],
							},
							["$es_F_reads", "$es_G_reads"],
						),
					),
				).toThrow(
					"$es_A_ONE -> $es_F_reads -> $es_G_reads -> $es_A_ONE",
				)
			})

			// NOTE: Two Methods calling each other is recursion, not a cycle of
			// this band's kind — the walk over the Function nodes is plain
			// reachability, so it answers what they read between them and returns.
			it("orders a Property against what mutually recursive Methods read", () => {
				let ordered = orderEssenceMembers(
					band(
						{
							$es_A_ONE: ["$es_F_reads"],
							$es_F_reads: ["$es_G_reads"],
							$es_G_reads: ["$es_F_reads", "$es_B_TWO"],
							$es_B_TWO: [],
						},
						["$es_F_reads", "$es_G_reads"],
					),
				)

				expect(ordered.map(nameOf)).toEqual([
					"$es_F_reads",
					"$es_G_reads",
					"$es_B_TWO",
					"$es_A_ONE",
				])
			})

			// NOTE: A Property and a Method of one Namespace are emitted under the
			// one const name, and nothing upstream refuses the overlap — the two
			// are declared in records of their own — so the prelude does.
			it("refuses a Property spelled like a Method of its own Namespace", () => {
				expect(() =>
					preludeOf(`declarations {
	namespace Clash for Boolean {
		§§ The affirmative.
		static yes: Boolean = true

		§§ The value itself.
		§§
		§§ @returns — the Boolean.
		yes() -> Boolean {
			<- @
		}
	}
}`),
				).toThrow(
					/'Clash' spells the static Property 'yes' exactly like a Method of its own/,
				)
			})

			// NOTE: The Method is NATIVE here, so it reaches no typed Node — the
			// clash is invisible to the prelude's own tables and has to be read
			// off the loader's `nativeBindings`. Emitted, this is the worse half
			// of the two: the Method's call sites find no Essence Method of that
			// name, fall through to the static Property, and call its value.
			it("refuses a Property spelled like a native Method of its own Namespace", () => {
				expect(() =>
					preludeOf(`declarations {
	namespace Clash for Boolean {
		§§ The affirmative.
		static yes: Boolean = true

		§§ The value itself.
		§§
		§§ @returns — the Boolean.
		yes() -> Boolean
	}
}`),
				).toThrow(
					/'Clash' spells the static Property 'yes' exactly like a Method of its own/,
				)
			})

			// NOTE: And the mirror — a value-LESS static Property is native, so it
			// reaches no typed Node either, while the Method beside it does. A read
			// of `Clash.PI` would be routed to the Method's const and hand back the
			// Function itself.
			it("refuses a native Property spelled like a Method of its own Namespace", () => {
				expect(() =>
					preludeOf(`declarations {
	namespace Clash for Integer {
		§§ The ratio.
		static PI: Integer

		§§ The ratio, computed.
		§§
		§§ @returns — the ratio.
		PI() -> Integer {
			<- 3
		}
	}
}`),
				).toThrow(
					/'Clash' spells the static Property 'PI' exactly like a Method of its own/,
				)
			})

			// NOTE: The clash is looked for inside ONE Namespace — the const name
			// carries the Namespace, so a Property and a Method of the same name in
			// two different Namespaces are two different consts and collide with
			// nothing.
			it("allows a Property spelled like another Namespace's Method", () => {
				let prelude = preludeOf(`declarations {
	namespace Holder for Boolean {
		§§ The affirmative.
		static yes: Boolean = true
	}

	namespace Asker for Boolean {
		§§ The value itself.
		§§
		§§ @returns — the Boolean.
		yes() -> Boolean {
			<- @
		}
	}
}`)

				expect(prelude.map((namespace) => namespace.name)).toEqual([
					"Holder",
					"Asker",
				])
			})

			// NOTE: Everything above hands the prelude in and reads the answer
			// back. This block reaches the same machinery the way a PROGRAM
			// reaches it — the whole standard library with one more file on the
			// end, installed as THE library for the length of the block, so a
			// user Program can be compiled and run against a Property that has a
			// value. No library on disk gives one a value yet (`Number.Pi` is the
			// primitive every other Transcendental is written from, and nothing
			// in Essence produces one), so a source of its own is the only way to
			// compile against the band at all.
			describe("read from a user Program", () => {
				// NOTE: The three shapes the band has to get right in one file:
				// a Property whose value CALLS a Method, a Property that reads
				// another one of its OWN Namespace, and a Namespace declared
				// below every one it names.
				// NOTE: Appended to the REAL sources, so `./Integer.es` resolves
				// to the real one — a standard library specifier is matched by
				// file name against the set being loaded, which is what lets a
				// library assembled in a test name a file it did not write.
				const constants = `import { Integer from "./Integer.es" }

declarations {

	§ A Namespace whose static Properties carry values.
	namespace Constants for Integer {
		§§ The base value.
		static BASE: Integer = 21

		§§ Twice the base, read through the Namespace's own name.
		static DOUBLE: Integer = Constants.BASE::doubled()

		§§ Doubles the Integer.
		§§
		§§ @returns — twice the Integer.
		doubled() -> Integer {
			<- @::add(@)
		}
	}
}
`

				let replacedStdlib: Stdlib | null = null

				beforeAll(() => {
					// NOTE: The prelude is extended along with the sources.
					// Exporting `Constants` from its own file makes it reachable
					// by the standard library; it takes a line in `Prelude.es`
					// to make it a name a user Program can write, which is the
					// whole of the difference between an internal helper and a
					// builtin.
					let sources = readStdlibFiles().map(
						({ filePath, sourceText }) =>
							parseStdlibSource(
								filePath,
								filePath.endsWith("Prelude.es")
									? sourceText.replace(
											/\n}\s*$/,
											'\n\tConstants from "./Constants.es"\n}\n',
										)
									: sourceText,
							),
					)

					sources.push(parseStdlibSource("Constants.es", constants))

					replacedStdlib = useStdlib(loadStdlibFrom(sources))
				})

				// NOTE: Put back, rather than dropped: every consumer of the
				// standard library reads the one process-wide object, so a test
				// that left its own in place would compile every file after it
				// against a library the repository does not have.
				afterAll(() => {
					useStdlib(replacedStdlib)
				})

				it("answers with the const for a Property that has a value", () => {
					expect(essencePropertyName("Constants", "DOUBLE")).toBe(
						"$es_Constants_DOUBLE",
					)
					expect(essencePropertyName("Constants", "BASE")).toBe(
						"$es_Constants_BASE",
					)
					expect(essenceMethodName("Constants", "doubled")).toBe(
						"$es_Constants_doubled",
					)
				})

				it("routes a Property read to its const, in a band below the Functions", () => {
					let code = generate(`implementation {
	Terminal.inspect(Constants.DOUBLE::toString())
}`)

					// NOTE: The read is the bare const, not the
					// `Constants.DOUBLE` member read a native Property emits —
					// and no import for the Namespace is emitted at all, since
					// nothing about it is native.
					expect(code).toContain(
						"Terminal.inspect(Integer.toString($es_Constants_DOUBLE));",
					)
					expect(code).not.toContain("Constants.DOUBLE")
					expect(code).not.toContain('import * as Constants from "')

					// NOTE: The order the initialisers need: the Method's const
					// stands above the whole value band, `BASE` above the
					// `DOUBLE` whose value reads it. Emitted in discovery order
					// this is a `ReferenceError` at import out of a Program that
					// compiled green.
					expect(
						code.indexOf("const $es_Constants_doubled ="),
					).toBeLessThan(code.indexOf("const $es_Constants_BASE ="))
					expect(
						code.indexOf("const $es_Constants_BASE ="),
					).toBeLessThan(code.indexOf("const $es_Constants_DOUBLE ="))
				})

				// NOTE: And the proof that the order is not just written down but
				// runs: the values are computed at import, so a band in the wrong
				// order throws before the first line of the Program.
				it("runs the value band", async () => {
					expect(
						await run(`implementation {
	Terminal.inspect(Constants.DOUBLE)
	Terminal.inspect(Constants.BASE)
}`),
					).toEqual(["42", "21"])
				})
			})
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

			expect(buildStdlibPrelude(stdlib)).toEqual([])
		})
	})

	// NOTE: A Case's tag is its Choice's identity and its name, so a Module's
	// Cases are tagged with the Module's path — which is what keeps two files'
	// same-named Choices apart at runtime as well as in the Type checker, since
	// `isValueOfType` compares nothing but that tag. Rendering the path
	// entry-relative is the bundler's business; what is asserted here is that
	// qualifying a Program changes the tags and NOTHING else about what is
	// emitted, and that the tags still agree with themselves when the Program
	// runs.
	describe("Module-qualified Case tags", () => {
		const MODULE_PATH = "/modules/Colour.es"

		const SOURCE = `implementation {
	choice Colour {
		Red,
		Green { shade: Integer },
	}

	constant red: Colour = #Red
	constant green: Colour = #Green({ shade = 2 })

	Terminal.inspect(match green -> String {
		case #Red { <- "red" }
		case #Green { <- @.shade::toString() }
	})

	Terminal.inspect(red::is(green)::toString())
	Terminal.inspect(red::is(#Red)::toString())
}`

		it("tags a Module's Cases with the Module's path", () => {
			let generated = generate(SOURCE, MODULE_PATH)

			expect(generated).toContain(`"${MODULE_PATH}#Colour#Red"`)
			expect(generated).toContain(`"${MODULE_PATH}#Colour#Green"`)
			expect(generate(SOURCE)).toContain('"Colour#Red"')
		})

		it("emits the same Program but for the tags", () => {
			expect(
				generate(SOURCE, MODULE_PATH).replaceAll(`${MODULE_PATH}#`, ""),
			).toBe(generate(SOURCE))
		})

		it("matches a Module's own Cases at runtime", async () => {
			expect(await run(SOURCE, MODULE_PATH)).toEqual([
				'"2"',
				'"false"',
				'"true"',
			])
		})
	})

	// NOTE: A doorway is an ordinary Function that takes a bare value, asks a
	// refinement's question of it, and hands the checked value onwards under the
	// refined name. It is the whole point of flow narrowing, and it needs no code
	// generation at all: a refinement erases to its base, so what runs here is the
	// Program someone would have written without one — which is exactly what these
	// two assertions together say.
	describe("a hand-written doorway", () => {
		const SOURCE = `implementation {
	type NonZero = Integer where @::isNot(0)

	§ The operation that can not fail, and says so.
	function doubled(_ d: NonZero) -> Integer {
		<- d::multiply(with 2)
	}

	§ The doorway: a bare Integer goes in, and the branch that proved the
	§ predicate is the only one that reaches the total operation.
	function doubledOrZero(_ d: Integer) -> Integer {
		if d::isNot(0) {
			<- doubled(d)
		}

		<- 0
	}

	Terminal.inspect(doubledOrZero(21))
	Terminal.inspect(doubledOrZero(0))
}`

		// NOTE: The same Program with the check taken out, which is the only thing
		// that makes the run above mean anything — without it the test would pass
		// just as well with no narrowing and no refinement at all.
		const UNCHECKED = `implementation {
	type NonZero = Integer where @::isNot(0)

	function doubled(_ d: NonZero) -> Integer {
		<- d::multiply(with 2)
	}

	function doubledOrZero(_ d: Integer) -> Integer {
		<- doubled(d)
	}

	Terminal.inspect(doubledOrZero(21))
	Terminal.inspect(doubledOrZero(0))
}`

		it("runs the checked value through the total operation", async () => {
			expect(await run(SOURCE)).toEqual(["42", "0"])
		})

		it("refuses the same call outside the branch", () => {
			expect(
				hasCode(diagnosticsOf(UNCHECKED), "argument-type-mismatch"),
			).toBe(true)
		})
	})

	// NOTE: A value written DOWN is its own evidence — the predicate is decided
	// while compiling, so a literal reaches a total operation with no branch in
	// front of it and no `Optional` coming back. The emitted Program is the plain
	// one: `3` is `3`, and the proof left no trace to run.
	describe("an admitted literal", () => {
		const SOURCE = `implementation {
	type NonZero = Integer where @::isNot(0)
	type NonEmptyString = String where @::hasAnyContent()

	function doubled(_ d: NonZero) -> Integer {
		<- d::multiply(with 2)
	}

	function shouted(_ text: NonEmptyString) -> String {
		<- text::append("!")
	}

	§ Written where the refinement stands, with nothing asking anything.
	constant twentyOne: NonZero = 21

	§ And returned as one, which is the same question a third time.
	function three() -> NonZero {
		<- 3
	}

	Terminal.inspect(doubled(twentyOne))
	Terminal.inspect(doubled(three()))
	Terminal.inspect(shouted("essence"))
}`

		// NOTE: The same Program with the values the predicates refuse, which is
		// what makes the run above mean anything: admission is a decision about
		// the value, not a hole that lets every literal through.
		const REFUSED = `implementation {
	type NonZero = Integer where @::isNot(0)

	function doubled(_ d: NonZero) -> Integer {
		<- d::multiply(with 2)
	}

	Terminal.inspect(doubled(0))
}`

		it("runs the written value through the total operation", async () => {
			expect(await run(SOURCE)).toEqual(["42", "6", '"essence!"'])
		})

		it("refuses a written value the predicate refuses", () => {
			expect(
				hasCode(diagnosticsOf(REFUSED), "argument-type-mismatch"),
			).toBe(true)
		})
	})

	// NOTE: A Match Handler's Guard is the doorway a Handler carries with it: the
	// Matcher's own check is ANDed in front of it, so what it proves holds over
	// every Statement of the body — of the value the Handler NAMED as much as of
	// `@`. The emitted Program is a Case tag test and an `if`, which is what
	// someone would have written with no refinement anywhere.
	describe("a Guard over the value a Handler named", () => {
		const SOURCE = `implementation {
	type Shout = String where @::hasAnyContent()

	§ The operation that can not fail, and says so — there is nothing to shout
	§ where there is nothing written.
	function shouted(_ text: Shout) -> String {
		<- text::uppercase()
	}

	§ The doorway: the Guard asks the question of the value the Case carries, and
	§ the body reaches the total operation with the value it named.
	function shoutedOr(_ value: Optional<String>) -> String {
		<- match value -> String {
			case #Value(item) where item::hasAnyContent() {
				<- shouted(item)
			}

			case _ {
				<- "nothing"
			}
		}
	}

	Terminal.inspect(shoutedOr(#Value("essence")))
	Terminal.inspect(shoutedOr(#Value("")))
	Terminal.inspect(shoutedOr(#Empty))
}`

		// NOTE: The same Program with the Guard taken out, which is the only thing
		// that makes the run above mean anything — without it the test would pass
		// just as well with no narrowing and no refinement at all.
		const UNGUARDED = `implementation {
	type Shout = String where @::hasAnyContent()

	function shouted(_ text: Shout) -> String {
		<- text::uppercase()
	}

	function shoutedOr(_ value: Optional<String>) -> String {
		<- match value -> String {
			case #Value(item) {
				<- shouted(item)
			}

			case _ {
				<- "nothing"
			}
		}
	}

	Terminal.inspect(shoutedOr(#Value("essence")))
}`

		it("runs the named value through the total operation", async () => {
			expect(await run(SOURCE)).toEqual([
				'"ESSENCE"',
				'"nothing"',
				'"nothing"',
			])
		})

		it("refuses the same call with no Guard in front of it", () => {
			expect(
				hasCode(diagnosticsOf(UNGUARDED), "argument-type-mismatch"),
			).toBe(true)
		})
	})

	// NOTE: The doorway nobody has to write. A Match on a bare Integer takes the
	// VALUE apart, and its Cases are evidence in both directions: the Case
	// answering for the rest is reached only by a value none of the Cases above it
	// named, and a Case that NAMES a value proves that. So both total operations
	// below are reached with no `if`, no doorway Function and nothing at all to run
	// — the evidence erases, and what is emitted is the value comparison someone
	// would have written anyway.
	describe("a Match on values", () => {
		const SOURCE = `implementation {
	type NonZero = Integer where @::isNot(0)
	type Zero = Integer where @::is(0)

	§ The operation that can not fail, and says so.
	function doubled(_ d: NonZero) -> Integer {
		<- d::multiply(with 2)
	}

	§ And its mirror image: an operation only the value zero may reach.
	function named(_ d: Zero) -> String {
		<- d::toString()
	}

	function namedOrDoubled(_ d: Integer) -> String {
		<- match d -> String {
			case 0 { <- named(@) }

			case _ { <- doubled(@)::toString() }
		}
	}

	Terminal.inspect(namedOrDoubled(21))
	Terminal.inspect(namedOrDoubled(0))
}`

		// NOTE: The same Match with a different value named, which is what makes the
		// run above mean anything: what the last Case knows is decided by the Cases
		// that were actually written, and a Match naming `1` proves nothing about
		// zero.
		const UNCHECKED = `implementation {
	type NonZero = Integer where @::isNot(0)

	function doubled(_ d: NonZero) -> Integer {
		<- d::multiply(with 2)
	}

	function namedOrDoubled(_ d: Integer) -> String {
		<- match d -> String {
			case 1 { <- "one" }

			case _ { <- doubled(@)::toString() }
		}
	}

	Terminal.inspect(namedOrDoubled(21))
}`

		it("runs the value each Case proved through its total operation", async () => {
			expect(await run(SOURCE)).toEqual(['"42"', '"0"'])
		})

		it("refuses the call the Cases written prove nothing for", () => {
			expect(
				hasCode(diagnosticsOf(UNCHECKED), "argument-type-mismatch"),
			).toBe(true)
		})
	})

	// NOTE: The same doorway over a GENERIC refinement, which is the one shape
	// where the Type the branch establishes was written nowhere: `Filled<String>`
	// is worked out from the receiver standing in front of the question. What runs
	// is still the Program someone would have written without a refinement
	// anywhere — the evidence erases, and a List is a List.
	describe("a doorway over a generic refinement", () => {
		const SOURCE = `implementation {
	type Filled<Item> = List<Item> where @::hasItems()

	§ The operation that can not fail, and says so — there is no first item of an
	§ empty List, and no value of this Parameter's Type is empty.
	function firstOf(_ items: Filled<String>) -> String {
		<- items::item(at 0)::value(withDefault "")
	}

	§ The doorway: a bare List goes in, and the branch that proved the predicate
	§ is the only one that reaches the total operation. Nothing wrote
	§ 'Filled<String>' anywhere in it.
	function firstOrEmpty(_ items: List<String>) -> String {
		if items::hasItems() {
			<- firstOf(items)
		}

		<- "nothing"
	}

	§ And a written List is its own proof, with nothing asking anything.
	constant proven: Filled<String> = ["written"]

	Terminal.inspect(firstOrEmpty(["a", "b"]))
	Terminal.inspect(firstOrEmpty([]))
	Terminal.inspect(firstOf(proven))
}`

		// NOTE: The same Program with the check taken out, which is the only thing
		// that makes the run above mean anything — without it the test would pass
		// just as well with no narrowing and no refinement at all.
		const UNCHECKED = `implementation {
	type Filled<Item> = List<Item> where @::hasItems()

	function firstOf(_ items: Filled<String>) -> String {
		<- items::item(at 0)::value(withDefault "")
	}

	function firstOrEmpty(_ items: List<String>) -> String {
		<- firstOf(items)
	}

	Terminal.inspect(firstOrEmpty(["a", "b"]))
}`

		// NOTE: And the same Program asking about a List of the wrong items, which
		// is what says that the Type Arguments are part of the evidence: the branch
		// proves `hasItems` of a `List<Integer>` and proves nothing whatever about a
		// `Filled<String>`.
		const WRONG_ITEMS = `implementation {
	type Filled<Item> = List<Item> where @::hasItems()

	function firstOf(_ items: Filled<String>) -> String {
		<- items::item(at 0)::value(withDefault "")
	}

	function firstOrEmpty(_ items: List<Integer>) -> String {
		if items::hasItems() {
			<- firstOf(items)
		}

		<- "nothing"
	}

	Terminal.inspect(firstOrEmpty([1, 2]))
}`

		it("runs the narrowed List through the total operation", async () => {
			expect(await run(SOURCE)).toEqual(['"a"', '"nothing"', '"written"'])
		})

		it("refuses the same call outside the branch", () => {
			expect(
				hasCode(diagnosticsOf(UNCHECKED), "argument-type-mismatch"),
			).toBe(true)
		})

		it("refuses a branch that proved it of the wrong items", () => {
			expect(
				hasCode(diagnosticsOf(WRONG_ITEMS), "argument-type-mismatch"),
			).toBe(true)
		})
	})

	// NOTE: The same total operation over a Parameter whose Type Argument the CALL
	// works out, which is the one position where nothing has spelled the refinement
	// at all: `NonEmptyList<Item>` is a Type only once something says what `Item` is,
	// and the written List is the only thing that ever could. What runs is again the
	// Program with no refinement in it — `firstItem` answers the item itself rather
	// than an Optional, and that is the whole difference.
	describe("a refined Parameter whose Type Argument is inferred", () => {
		const SOURCE = `implementation {
	§ Total for the same reason as ever, and generic on top: there is no first item
	§ of an empty List, and no value of this Parameter's Type is empty.
	function firstOf<infer Item>(_ items: NonEmptyList<Item>) -> Item {
		<- items::firstItem()
	}

	§ Each call decides 'Item' by the List it is written with, and the List is its
	§ own proof of the predicate.
	Terminal.inspect(firstOf(["written", "second"]))
	Terminal.inspect(firstOf([1, 2]))
}`

		// NOTE: The empty List is what says the evidence is still being read: it
		// decides no 'Item' AND answers the predicate with a no, either of which is
		// enough to refuse it.
		const EMPTY = `implementation {
	function firstOf<infer Item>(_ items: NonEmptyList<Item>) -> Item {
		<- items::firstItem()
	}

	Terminal.inspect(firstOf([]))
}`

		it("runs the written List through the total operation", async () => {
			expect(await run(SOURCE)).toEqual(['"written"', "1"])
		})

		it("refuses the empty written List", () => {
			expect(
				hasCode(diagnosticsOf(EMPTY), "argument-type-mismatch"),
			).toBe(true)
		})
	})

	// NOTE: The one operation that KEEPS the evidence — a product of two proven
	// Integers is proven too — and the one whose Namespace the Optimiser writes
	// out. `lower-scalar-operations` lowers `NonZeroInteger.multiply` exactly as
	// it lowers `Integer.multiply`: the refinement erases before the first pass
	// runs, so what the call had in its hands was two Integers holding bigints,
	// and the runtime Method it would have reached is Integer's own product
	// re-exported. What runs has to be the same product either way, which is what
	// the two runs below say — bigint arithmetic beyond what a double can hold,
	// and a sign, so that a lowering to the wrong operator could not read as
	// right.
	describe("the product of two proven Integers", () => {
		const SOURCE = `implementation {
	§ Both Parameters are proven, so this reaches the Namespace declared for
	§ proven Integers rather than the one every Integer answers.
	function product(_ n: NonZeroInteger, _ m: NonZeroInteger) -> NonZeroInteger {
		<- n::multiply(with m)
	}

	constant six: NonZeroInteger = 6
	constant seven: NonZeroInteger = 7
	constant huge: NonZeroInteger = 9_007_199_254_740_991
	constant negative: NonZeroInteger = -3

	Terminal.inspect(product(six, seven))
	Terminal.inspect(product(huge, huge))
	Terminal.inspect(product(six, negative))
	§ And the answer is proven in its turn, which is what the Namespace is for.
	Terminal.inspect(product(product(six, seven), seven))
}`

		it("runs the proven product through the lowered path", async () => {
			expect(await run(SOURCE)).toEqual([
				"42",
				"81129638414606663681390495662081",
				"-18",
				"294",
			])
		})

		// NOTE: The same Program with the Optimiser off answers the same thing,
		// which is the whole contract a pass is held to — there it is the runtime
		// Method that multiplies, and here it is JavaScript's own operator.
		it("answers the same with the Optimiser off", async () => {
			let generated = generate(SOURCE, undefined, {
				enabled: false,
				disabledPasses: new Set(),
			})

			expect(generated).toContain("NonZeroInteger.multiply")
			expect(generate(SOURCE)).not.toContain("NonZeroInteger.multiply")
		})
	})
})
