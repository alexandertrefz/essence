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
import { resolveOverloadedMethodName } from "../helpers/types"
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

// The CLI's stages without bundling, to assert on the emitted JavaScript.
// `modulePath` enriches the source as a Module, whose Choices carry its path.
// Without it, Cases carry the bare tags most specs assert on.
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

// Runs the emitted Program and captures what `Terminal.inspect` prints. The
// emitted imports are absolute paths, so the module resolves from anywhere.
async function run(
	source: string,
	modulePath?: string,
	optimiserOptions: OptimiserOptions = defaultOptimiserOptions,
): Promise<Array<string>> {
	let js = generate(source, modulePath, optimiserOptions)
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

// For Programs that must be refused: what the first failing stage reported.
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
	// A Help that moves Statements keeps what the Program prints. The move it
	// refuses, the assignment after `Sizes`, prints the Variable's first value.
	describe("a use-before-declaration Help", () => {
		const program = (statements: Array<string>) => `implementation {
			function useIt() -> Integer {
				<- Sizes.base
			}

			${statements.join("\n\n")}
		}`
		const sizes = `namespace Sizes {
				static base: Integer = 4
			}`

		// Moving a Statement with an effect past another effect would swap
		// what they print, so only the Declaration moves.
		it("moves no Statement with an effect past another", async () => {
			expect(
				diagnosticsOf(
					program([
						"Terminal.inspect(useIt())",
						'Terminal.inspect("a")',
						sizes,
					]),
				).flatMap((diagnostic) => diagnostic.helps),
			).toEqual(["Move the Declaration of 'Sizes' above this Statement."])
			expect(
				await run(
					program([
						sizes,
						"Terminal.inspect(useIt())",
						'Terminal.inspect("a")',
					]),
				),
			).toEqual(["4", '"a"'])
		})

		// Neither move keeps the written order, so the Help says what the one
		// it names changes, and the change is what running it shows.
		it("says when moving a Declaration runs its effects earlier", async () => {
			let loud = `function loud() -> Integer {
				Terminal.inspect("loud")

				<- 1
			}`
			let loudSizes = `namespace Sizes {
				static base: Integer = loud()
			}`

			expect(
				diagnosticsOf(
					program([
						loud,
						"Terminal.inspect(useIt())",
						'Terminal.inspect("b")',
						loudSizes,
					]),
				).flatMap((diagnostic) => diagnostic.helps),
			).toEqual([
				"Move the Declaration of 'Sizes' above this Statement; its static Properties will then run before the Statements between.",
			])
			expect(
				await run(
					program([
						loud,
						loudSizes,
						"Terminal.inspect(useIt())",
						'Terminal.inspect("b")',
					]),
				),
			).toEqual(['"loud"', "1", '"b"'])
		})

		it("moves a Statement with an effect past Declarations that run nothing", async () => {
			let declarations = ["type Size = Integer", "constant size = 4"]

			expect(
				diagnosticsOf(
					program([
						"Terminal.inspect(useIt())",
						...declarations,
						sizes,
					]),
				).flatMap((diagnostic) => diagnostic.helps),
			).toEqual([
				"Move the Declaration of 'Sizes' above this Statement, or this Statement below it.",
			])
			expect(
				await run(
					program([
						...declarations,
						sizes,
						"Terminal.inspect(useIt())",
					]),
				),
			).toEqual(["4"])
		})

		it("moves no assignment past a read of its Variable", async () => {
			expect(
				diagnosticsOf(
					program([
						"variable v = 1",
						"v = useIt()",
						"Terminal.inspect(v)",
						sizes,
					]),
				).flatMap((diagnostic) => diagnostic.helps),
			).toEqual(["Move the Declaration of 'Sizes' above this Statement."])
			expect(
				await run(
					program([
						"variable v = 1",
						sizes,
						"v = useIt()",
						"Terminal.inspect(v)",
					]),
				),
			).toEqual(["4"])
			expect(
				await run(
					program([
						"variable v = 1",
						"Terminal.inspect(v)",
						sizes,
						"v = useIt()",
					]),
				),
			).toEqual(["1"])
		})
	})

	// A static Property emits a `PropertyDefinition`, which upstream
	// `escodegen` cannot print. The vendored copy in `packages/escodegen`
	// patches it in (see its `PATCHES.md`), and these specs fail if a re-vendor
	// drops the patch.
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

		// The Namespace hoists though its Property's value reads a Constant, and
		// the Property is typed where `late` reads it.
		it("runs a Namespace whose unannotated Property reads a Constant", async () => {
			expect(
				await run(`
					implementation {
						function early() -> Integer {
							<- Sizes.doubled()
						}

						constant size = 4

						function late() -> Integer {
							<- Sizes.base::add(early())
						}

						namespace Sizes {
							static base = size

							static doubled() -> Integer {
								<- Sizes.base::multiply(with 2)
							}
						}

						Terminal.inspect(late())
					}
				`),
			).toEqual(["12"])
		})

		// `Outer.total` waits while hoisting until `Inner.base` settles, so the
		// read in `show` is typed rather than an Error.
		it("runs a Property that reads another unannotated one", async () => {
			expect(
				await run(`
					implementation {
						constant size = 4

						function show() -> Integer {
							<- Outer.total::multiply(with 3)
						}

						namespace Inner {
							static base = size
						}

						namespace Outer {
							static total = Inner.base::add(1)
						}

						Terminal.inspect(show())
					}
				`),
			).toEqual(["15"])
		})
	})

	// A discarded value is bound to a name rather than dropped. See "Discarded
	// values" in packages/compiler/src/rewriter/DEVELOPMENT.md.
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

		// `$` may appear in an Essence name and `_` may not, so the binding's
		// `_` keeps it apart from a Program's own `$discarded`.
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
			// A call cannot be taken away, so it stays as written.
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

	// `Terminal.inspect` is an ordinary native static Method, emitted as a read
	// off the Namespace's runtime import.
	describe("Terminal.inspect", () => {
		it("emits a read off the Terminal module, not the functions one", () => {
			let generated = generate(`
				implementation {
					Terminal.inspect("hello")
				}
			`)

			expect(generated).toContain("Terminal.inspect(")
			// `$_` is the runtime `functions` module, which holds only native free
			// Functions.
			expect(generated).not.toContain("$_.inspect(")
		})

		it("prints the value and is unchanged at runtime", async () => {
			let output = await run(`
				implementation {
					Terminal.inspect("hello")
					Terminal.inspect(42)
				}
			`)

			// A String prints quoted and an Integer bare, which tells `inspect`
			// from `print`.
			expect(output).toEqual(['"hello"', "42"])
		})
	})

	// What the runtime prints and calls equal shows only when a Program runs.
	// `runtimeInternal.spec.ts` holds the unit-level counterparts.
	describe("Runtime Printing and Equality", () => {
		// A Record whose single-line rendering reaches sixty characters prints
		// over several lines, each member once.
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

		// A Function carries no Type key, so printing one, or a value holding
		// one, must not read it.
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

		// `String::is` is canonical equivalence, so a composed and a decomposed
		// `café` are equal, inside a Record too.
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

		// `Number::is` is numeric, so `1 is 1/1` holds inside a Record too.
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

			// Without `elide-final-match-test`, the chain ends in an `else` no
			// Handler owns, which throws.
			let generated = generate(source, undefined, {
				enabled: true,
				disabledPasses: new Set(["elide-final-match-test"]),
			})

			expect(generated.split("else").length - 1).toBe(3)
			expect(generated).toContain("$type.noCaseMatched(_self)")

			// With the pass, the last Handler is that `else`.
			let elided = generate(source)

			expect(elided.split("else").length - 1).toBe(2)
			expect(elided).not.toContain("$type.noCaseMatched(_self)")
		})

		// The runtime Type check reads a Union Matcher's members as an Array.
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

		// A chain asking the tag more than once reads it once. This is emission,
		// not an Optimiser pass. See "The bound tag" in
		// packages/compiler/src/rewriter/DEVELOPMENT.md.
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
			// Two Handlers make one tag test, since the last is the `else`.
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
			// The binding is made off the `tag-test` Nodes `compile-type-tests`
			// leaves, so without the pass there is none.
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
		// `@` in a wildcard has the unhandled members' Type, precise enough to
		// call Methods on.
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

			// `anyIs` is false across differing Types, so a literal Matcher needs
			// no Type check.
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

		// A Handler that can decline a value it Type-matched does not make the
		// Union exhaustive.
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
			// `case 0` catches one Integer, so `@` in the wildcard is still
			// `Integer | Boolean`.
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

	// A `define` holds only Expressions, so it is emitted as a chain of
	// conditionals rather than a Function called at once. See "Define emission"
	// in packages/compiler/src/rewriter/DEVELOPMENT.md.
	describe("Define", () => {
		it("answers with the first arm whose Condition holds", async () => {
			expect(
				await run(`
					implementation {
						constant grade = (_ score: Integer) -> String {
							<- define {
								as "A" if score::isGreaterThanOrEqualTo(90)
								as "B" if score::isGreaterThanOrEqualTo(80)
								as "F" otherwise
							}
						}

						Terminal.inspect(grade(95))
						Terminal.inspect(grade(85))
						Terminal.inspect(grade(20))
					}
				`),
			).toEqual(['"A"', '"B"', '"F"'])
		})

		it("answers through a define written inside a define", async () => {
			expect(
				await run(`
					implementation {
						constant sign = (_ value: Integer) -> String {
							<- define -> String {
								as define {
									as "one" if value::is(1)
									as "many" otherwise
								} if value::isPositive()
								as "none" otherwise
							}
						}

						Terminal.inspect(sign(1))
						Terminal.inspect(sign(7))
						Terminal.inspect(sign(0))
					}
				`),
			).toEqual(['"one"', '"many"', '"none"'])
		})

		// A one-member Case's payload slot offers both the Record and the
		// member's Type. The `define` answers the member's value, which is
		// wrapped as `#Value(1)` would be.
		it("answers with the payload of a one-member Case", async () => {
			expect(
				await run(`
					implementation {
						constant n = 4

						constant maybe: Optional<Integer> = #Value(define {
							as 1 if n::isEven()
							as 2 otherwise
						})

						Terminal.inspect(maybe)
					}
				`),
			).toEqual(["Optional#Value(1)"])
		})

		// `otherwise` is a valid Identifier, so it can name a Method and end an
		// arm in one `define`, each read by where it stands.
		it("answers through a Method named otherwise", async () => {
			expect(
				await run(`
					implementation {
						namespace Fallback for Integer {
							otherwise(_ fallback: Integer) -> Integer {
								<- define {
									as @ if @::isPositive()
									as fallback otherwise
								}
							}
						}

						constant grade = (_ score: Integer) -> Integer {
							<- define {
								as score::otherwise(1) if score::isNegative()
								as score::otherwise(2) otherwise
							}
						}

						Terminal.inspect(grade(-3))
						Terminal.inspect(grade(4))
					}
				`),
			).toEqual(["1", "4"])
		})

		it("emits a chain of conditionals rather than a Function to call", () => {
			let generated = generate(
				`implementation {
					variable score: Integer = 95

					Terminal.inspect(define {
						as "A" if score::isGreaterThanOrEqualTo(90)
						as "B" if score::isGreaterThanOrEqualTo(80)
						as "F" otherwise
					})
				}`,
				undefined,
				unoptimisedOptions,
			)

			// With the Optimiser off the Conditions stay calls. Each `.value`
			// reads the Essence Boolean, an object that would always be truthy.
			expect(generated).toContain('.value ? String.createString("A") : ')
			expect(generated).toContain(
				'.value ? String.createString("B") : String.createString("F")',
			)

			expect(generated).not.toContain("(function")
			expect(generated).not.toContain("=>")
		})
	})

	describe("Record Matchers", () => {
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

	// A right-hand side may carry members its Type does not name, so the update
	// takes only the named ones, with or without the Optimiser. See "Record and
	// Dictionary updates" in packages/compiler/src/rewriter/DEVELOPMENT.md.
	describe("a Record Combination's expression right-hand side", () => {
		// `partial`'s Type names `port` alone, but its value also carries a String
		// `tls`, which must not replace the Boolean. A Literal names only declared
		// members, so the wider value is bound first.
		const widened = `implementation {
	type Server = { port: Integer, tls: Boolean }

	constant server: Server = { port = 80, tls = true }
	constant raw = { port = 8080, tls = "nope" }
	constant partial: { port: Integer } = raw
	constant merged: Server = { server with partial }

	Terminal.inspect(merged)
	Terminal.inspect(merged.tls::negate())
}`

		it("takes only the members the right-hand side's Type names", async () => {
			expect(await run(widened)).toEqual([
				"{ port = 8080, tls = true }",
				"false",
			])
		})

		it("takes only those members with the Optimiser off", async () => {
			let js = generate(widened, undefined, unoptimisedOptions)

			expect(js).toContain("port: partial.port")
			expect(js).not.toContain("Object.assign({}, server, partial)")
		})

		it("takes only those members with the collapse off", () => {
			expect(
				generate(widened, undefined, {
					enabled: true,
					disabledPasses: new Set(["collapse-combinations"]),
				}),
			).toContain("port: partial.port")
		})

		// A bare name, including the `_self` that `@` lowers to, is read per
		// member without a temporary.
		it("reads a bare name and `@` in place", () => {
			let generated = generate(`
				implementation {
					type Point = { x: Integer, y: Integer }

					namespace Points for Point {
						§§ Answers this Point with an update applied.
						§§
						§§ @param update — the members to set.
						§§ @returns — the updated Point.
						updated(with update: { x: Integer }) -> Point {
							<- { @ with update }
						}

						§§ Answers this Point widened onto a base.
						§§
						§§ @param base — the Point to widen onto.
						§§ @returns — the widened Point.
						onto(_ base: Point) -> Point {
							<- { base with @ }
						}
					}

					constant point: Point = { x = 1, y = 2 }

					Terminal.inspect(point::updated(with { x = 9 }))
					Terminal.inspect(point::onto({ x = 0, y = 0 }))
				}
			`)

			expect(generated).toContain("x: update.x")
			expect(generated).toContain("x: _self.x")
			expect(generated).toContain("y: _self.y")
			expect(generated).not.toContain("=> ({")
		})

		// A computed right-hand side is bound by an arrow, so its call runs once.
		// See "Record and Dictionary updates" in packages/compiler/src/rewriter/DEVELOPMENT.md.
		it("binds a computed right-hand side once", async () => {
			const counted = `implementation {
	type Point = { x: Integer, y: Integer }

	variable calls = 0

	function update() -> { x: Integer, y: Integer } {
		calls = calls::add(1)
		<- { x = 9, y = 8 }
	}

	constant point: Point = { x = 1, y = 2 }

	Terminal.inspect({ point with update() })
	Terminal.inspect(calls)
}`

			expect(generate(counted)).toContain("(_lhs, _rhs) => ({")
			expect(await run(counted)).toEqual(["{ x = 9, y = 8 }", "1"])
		})

		// The Enricher writes a dotted key as a hand-written nesting. Running it
		// shows the nesting copies: the updated value comes out unchanged.
		// See "Path keys" in packages/compiler/src/enricher/DEVELOPMENT.md.
		it("nests a dotted key into the update it stands for", async () => {
			const nested = `implementation {
	type Tls = { enabled: Boolean, name: String }
	type Server = { host: String, port: Integer, tls: Tls }
	type Config = { name: String, server: Server }

	constant config: Config = {
		name = "api",
		server = {
			host = "localhost",
			port = 80,
			tls = { enabled = false, name = "a" },
		},
	}

	constant moved = { config with server.tls.enabled = true, server.port = 1 }

	Terminal.inspect(moved.server.tls.enabled)
	Terminal.inspect(moved.server.port)
	Terminal.inspect(moved.server.host)
	Terminal.inspect(config.server.port)
}`
			let generated = generate(nested)

			expect(generated).toContain("...config.server")
			expect(generated).toContain("...config.server.tls")
			expect(await run(nested)).toEqual([
				"true",
				"1",
				`"localhost"`,
				"80",
			])
		})

		// With every pass off, the Rewriter's own path emits the nesting.
		it("nests a dotted key with the Optimiser off", () => {
			const nested = `implementation {
	type Tls = { enabled: Boolean }
	type Server = { host: String, port: Integer, tls: Tls }
	type Config = { name: String, server: Server }

	constant config: Config = {
		name = "api",
		server = { host = "localhost", port = 80, tls = { enabled = false } },
	}

	constant moved = { config with server.tls.enabled = true }

	Terminal.inspect(moved.server.tls.enabled)
}`
			let generated = generate(nested, undefined, unoptimisedOptions)

			expect(generated).toContain("config.server")
			expect(generated).toContain("config.server.tls")
		})

		// `?` is legal in an Essence name but not in a JavaScript one, so a
		// projected member is a quoted key and a bracketed read.
		// See "Escaped names" in packages/compiler/src/rewriter/DEVELOPMENT.md.
		it("projects a member JavaScript can not spell", async () => {
			const spelling = `implementation {
	type Flags = { ok?: Boolean, count: Integer }

	constant flags: Flags = { ok? = true, count = 1 }
	constant update: { ok?: Boolean } = { ok? = false }

	Terminal.inspect({ flags with update })
}`

			expect(generate(spelling)).toContain(`"ok?": update["ok?"]`)
			expect(await run(spelling)).toEqual(["{ ok? = false, count = 1 }"])
		})
	})

	// The Parser reads `{ x }` as `{ x = x }`, so later stages see only the
	// written-out form.
	// See "Record literals and updates" in packages/compiler/src/parser/DEVELOPMENT.md.
	describe("Property shorthand", () => {
		it("reads a bare member name as its own value", async () => {
			expect(
				await run(`implementation {
	type Point = { x: Integer, y: Integer }

	constant x = 1
	constant y = 2
	constant point: Point = { x, y }

	Terminal.inspect(point)
}`),
			).toEqual(["{ x = 1, y = 2 }"])
		})

		it("emits exactly what the written-out spelling emits", () => {
			const written = `implementation {
	constant x = 1
	constant y = 2
	constant point = { x = x, y = y }

	Terminal.inspect(point)
}`

			expect(
				generate(written.replace("{ x = x, y = y }", "{ x, y }")),
			).toBe(generate(written))
		})

		it("reads a bare member name in a Case payload and in a merged Literal", async () => {
			expect(
				await run(`implementation {
	choice Shape {
		Rectangle { width: Integer, height: Integer },
	}

	type Server = { host: String, port: Integer }

	constant width = 3
	constant height = 4
	constant port = 8080
	constant base: Server = { host = "localhost", port = 80 }

	Terminal.inspect(Shape#Rectangle({ width, height }))
	Terminal.inspect({ base with { port } })
}`),
			).toEqual([
				"Shape#Rectangle { width = 3, height = 4 }",
				'{ host = "localhost", port = 8080 }',
			])
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

			// Two Parameters sharing a name would be a redeclaration in JavaScript.
			expect(generated).toContain("_0")
			expect(generated).toContain("_1")
			expect(generated).toContain("_2")
		})

		// A Function literal binds no name for `_` or `on _`, standalone or as
		// an Argument, and a call still writes the label.
		it("runs Function literals whose Parameters bind no name", async () => {
			expect(
				await run(`implementation {
	constant third = (_: Integer, _: Integer, at x: Integer) -> Integer { <- x }
	constant flat = (on _: Integer) -> Integer { <- 7 }

	function twice(_ rule: (on: Integer) -> Integer) -> Integer {
		<- rule(on rule(on 1))
	}

	function ignoring(on _: Integer, _: String) -> Integer {
		<- 9
	}

	Terminal.inspect(third(1, 2, at 3))
	Terminal.inspect(flat(on 4))
	Terminal.inspect([1, 2]::map((_: Integer) { <- 0 }))
	Terminal.inspect(twice((on _: Integer) -> Integer { <- 2 }))
	Terminal.inspect(ignoring(on 1, "x"))
}`),
			).toEqual(["3", "7", "[ 0, 0 ]", "2", "9"])
		})

		// A Function Type has no body, so its Parameter names are never read.
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

	// A Record default fills in the members a caller left out, which a
	// JavaScript default can not do.
	// See "Record defaults" in packages/compiler/src/simplifier/DEVELOPMENT.md.
	describe("Record defaults", () => {
		const options = `type Options = { host: String, retries: Integer }`

		it("fills in the members a partial Argument left out", async () => {
			const source = `implementation {
	${options}

	function connect(_ url: String, using settings: Options = { retries = 3 }) -> String {
		<- "{url}|{settings.host}|{settings.retries}"
	}

	Terminal.inspect(connect("a", using { host = "h" }))
	Terminal.inspect(connect("a", using { host = "h", retries = 9 }))
}`

			expect(generate(source)).toContain("retries: settings.retries ??")
			expect(await run(source)).toEqual(['"a|h|3"', '"a|h|9"'])
		})

		// A complete default lets the whole Argument be left out, so each member
		// is read through `?.`.
		it("takes a whole Argument, a partial one, or none", async () => {
			const source = `implementation {
	${options}

	function connect(using settings: Options = { host = "d", retries = 3 }) -> String {
		<- "{settings.host}|{settings.retries}"
	}

	Terminal.inspect(connect())
	Terminal.inspect(connect(using { retries = 1 }))
	Terminal.inspect(connect(using { host = "h", retries = 9 }))
}`

			expect(generate(source)).toContain("settings?.host ??")
			expect(await run(source)).toEqual(['"d|3"', '"d|1"', '"h|9"'])
		})

		// Each member's expression runs only where the caller left that member out.
		it("evaluates only the members the caller left out", async () => {
			const source = `implementation {
	${options}

	variable calls = 0

	function counted() -> Integer {
		calls = calls::add(1)
		<- 3
	}

	function connect(using settings: Options = { retries = counted() }) -> String {
		<- settings.host
	}

	Terminal.inspect(connect(using { host = "a" }))
	Terminal.inspect(connect(using { host = "b", retries = 7 }))
	Terminal.inspect(calls)
}`

			expect(await run(source)).toEqual(['"a"', '"b"', "1"])
		})

		// A default that is not a Literal is hoisted into one `const`, evaluated
		// once per call.
		it("hoists a default that is not a literal", async () => {
			const source = `implementation {
	${options}

	constant fallback: Options = { host = "f", retries = 7 }

	function connect(using settings: Options = fallback) -> String {
		<- "{settings.host}|{settings.retries}"
	}

	Terminal.inspect(connect())
	Terminal.inspect(connect(using { retries = 1 }))
}`

			expect(generate(source)).toContain("const _default0 = fallback")
			expect(await run(source)).toEqual(['"f|7"', '"f|1"'])
		})

		it("reads @ in a Method's default", async () => {
			expect(
				await run(`implementation {
	${options}

	namespace Links for String {
		§§ Answers a description of this link.
		§§
		§§ @param settings — how to open it.
		§§ @returns — the description.
		open(using settings: Options = { host = @ }) -> String {
			<- "{settings.host}|{settings.retries}"
		}
	}

	Terminal.inspect("self"::open(using { retries = 2 }))
	Terminal.inspect("self"::open(using { host = "over", retries = 5 }))
}`),
			).toEqual(['"self|2"', '"over|5"'])
		})

		// A Function value drops its defaults, but the entry rebuild still
		// projects the Argument to the members the Type declares.
		it("merges an Argument passed through a Function value", async () => {
			expect(
				await run(`implementation {
	${options}

	function connect(using settings: Options = { retries = 3 }) -> String {
		<- "{settings.host}|{settings.retries}"
	}

	constant taken: (using: Options) -> String = connect

	Terminal.inspect(taken(using { host = "v", retries = 4 }))
}`),
			).toEqual(['"v|4"'])
		})

		// A member JavaScript can not spell is a quoted key and a bracketed read.
		it("merges a member JavaScript can not spell", async () => {
			const source = `implementation {
	type Flags = { ok?: Boolean, count: Integer }

	function show(using flags: Flags = { ok? = true }) -> String {
		<- "{flags.ok?}|{flags.count}"
	}

	Terminal.inspect(show(using { count = 1 }))
}`

			expect(generate(source)).toContain(`"ok?": flags["ok?"] ??`)
			expect(await run(source)).toEqual(['"true|1"'])
		})

		// A member the default writes as a Record Literal is rebuilt one level
		// further in, so a path key can merge into it. A member the caller writes
		// whole is complete, so the rebuild hands it back.
		it("rebuilds a member the default writes as a Record", async () => {
			const source = `implementation {
	type Server = { host: String, port: Integer }
	type Config = { retries: Integer, server: Server }

	function connect(using settings: Config = { retries = 3, server = { host = "d", port = 80 } }) -> String {
		<- "{settings.retries}|{settings.server.host}|{settings.server.port}"
	}

	Terminal.inspect(connect())
	Terminal.inspect(connect(using { retries = 1 }))
	Terminal.inspect(connect(using { server = { host = "h", port = 1 } }))
}`

			expect(generate(source)).toContain("settings?.server?.host ??")
			expect(await run(source)).toEqual([
				'"3|d|80"',
				'"1|d|80"',
				'"3|h|1"',
			])
		})

		// The rebuild follows the default's Literal, not the Type, so a deep Type
		// does not grow the prologue.
		it("rebuilds as deep as the default's Literal nests", async () => {
			const source = `implementation {
	type Tls = { enabled: Boolean, authority: String }
	type Server = { port: Integer, tls: Tls }
	type Config = { server: Server }

	function connect(using settings: Config = { server = { port = 80, tls = { enabled = false, authority = "self" } } }) -> String {
		<- "{settings.server.port}|{settings.server.tls.authority}"
	}

	Terminal.inspect(connect())
}`

			expect(generate(source)).toContain(
				"settings?.server?.tls?.authority ??",
			)
			expect(await run(source)).toEqual(['"80|self"'])
		})

		// A member the default names rather than writes can not be taken apart
		// without being evaluated, so it is read whole.
		it("takes a member the default names rather than writes", async () => {
			const source = `implementation {
	type Server = { host: String, port: Integer }
	type Config = { retries: Integer, server: Server }

	constant fallback: Server = { host = "f", port = 7 }

	function connect(using settings: Config = { retries = 3, server = fallback }) -> String {
		<- "{settings.retries}|{settings.server.host}"
	}

	Terminal.inspect(connect())
}`

			expect(generate(source)).toContain("settings?.server ??")
			expect(await run(source)).toEqual(['"3|f"'])
		})

		// An Argument for a defaulted Record Parameter is the right-hand side of
		// `{ default with argument }`, so a path key means what it means after `with`.
		it("merges a path key into the default's member", async () => {
			const source = `implementation {
	type Tls = { enabled: Boolean, authority: String }
	type Server = { port: Integer, host: String, tls: Tls }
	type Options = { retries: Integer, server: Server }

	function connect(using options: Options = { retries = 3, server = { port = 8080, host = "local", tls = { enabled = false, authority = "self" } } }) -> String {
		<- "{options.retries}|{options.server.port}|{options.server.host}|{options.server.tls.enabled}|{options.server.tls.authority}"
	}

	Terminal.inspect(connect(using { server.port = 1 }))
	Terminal.inspect(connect(using { retries = 9, server.tls.enabled = true, server.host = "h" }))
	Terminal.inspect(connect(using { server.{ port = 2, tls.authority = "x" } }))
}`

			expect(await run(source)).toEqual([
				'"3|1|local|false|self"',
				'"9|8080|h|true|self"',
				'"3|2|local|false|x"',
			])
		})

		// The Argument carries only the members the path wrote, and the callee
		// merges it into the default.
		it("passes only the members a path key wrote", () => {
			const generated = generate(`implementation {
	type Server = { port: Integer, host: String }
	type Options = { retries: Integer, server: Server }

	function connect(using options: Options = { retries = 3, server = { port = 8080, host = "local" } }) -> String {
		<- options.server.host
	}

	Terminal.inspect(connect(using { server.port = 1 }))
}`)
			const call = generated.slice(
				generated.indexOf("Terminal.inspect(connect("),
			)

			expect(call).toContain("port:")
			expect(call).not.toContain("host:")
		})

		// A partial Literal's written members carry their own evidence for a
		// refinement, as a whole Literal's do, wherever a default fills it in.
		it("admits a partial Literal whose written member proves a refinement", async () => {
			const source = (
				port: string,
				preset: string = port,
			) => `implementation {
	type Settings = { port: PositiveInteger, host: String }

	choice Call {
		Post { port: PositiveInteger, host: String } = { host = "a" },
		Idle,
	}

	function configure(_ s: Settings = { port = 80, host = "a" }) -> String {
		<- "{s.host}:{s.port}"
	}

	function preset(_ s: Settings = { port = ${preset} }) -> PositiveInteger {
		<- s.port
	}

	constant call: Call = #Post({ port = ${port} })

	Terminal.inspect(configure({ port = ${port} }))
	Terminal.inspect(preset({ host = "b" }))
	Terminal.inspect(call)
}`

			expect(await run(source("8080"))).toEqual([
				'"a:8080"',
				"8080",
				'Call#Post { port = 8080, host = "a" }',
			])

			let codes = (port: string, preset: string) =>
				diagnosticsOf(source(port, preset)).map(({ code }) => code)

			expect(codes("8080", "0")).toEqual(["default-type-mismatch"])
			expect(codes("0", "80")).toEqual([
				"payload-type-mismatch",
				"argument-type-mismatch",
			])
		})

		// The members a payload's default fills in are not missing from it.
		it("names only the written member a partial payload refuses", () => {
			let refused = diagnosticsOf(`implementation {
	choice Call {
		Post { port: PositiveInteger, host: String } = { host = "a" },
		Idle,
	}

	constant call: Call = #Post({ port = 0 })
}`)

			expect(
				refused.map(({ code, labels, notes }) => [
					code,
					labels[0]?.message,
					notes,
				]),
			).toEqual([
				[
					"payload-type-mismatch",
					"this is an Integer, and '#Post' declares a PositiveInteger",
					[
						"'#Post' carries a { port: PositiveInteger, host: String }.",
					],
				],
			])
		})
	})

	describe("String Methods", () => {
		// Pins that `compare` resolves on a String receiver inside a sort callback.
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
		// `inline-loops` writes out a walk whose callback is written at the call,
		// so these pin the callback's body with its Parameters bound and typed.
		// See "Inlined loops" in packages/compiler/src/rewriter/DEVELOPMENT.md.
		it("emits map with an inferred callback", () => {
			let generated = generate(`
				implementation {
					Terminal.inspect([1, 2]::map((n) { <- n::toString() }))
				}
			`)

			expect(generated).toContain("const n = $loop_0_items[")
			expect(generated).toContain("Integer.toString__overload$1(")
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
			// `lower-scalar-operations` turns `total::add(n)` into the addition. The
			// accumulator is carried as a bare value, and the List item is read through.
			expect(generated).toContain("total + n.value")
		})

		// A callback bound to a name is not inlined, so the Method is called.
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
		// `lower-scalar-operations` lowers the comparison only where both operands
		// are Integers, so it shows the inferred Parameter Type reached the body.
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

	describe("Member paths", () => {
		let product = `
			type Product = { name: String, price: Integer, maker: Maker }
			type Maker = { town: String }
			constant products: List<Product> = [
				{ name = "b", price = 2, maker = { town = "Ulm" } },
				{ name = "a", price = 1, maker = { town = "Kiel" } },
			]
		`

		it("reads the member the path names", async () => {
			expect(
				await run(`implementation {
					${product}
					Terminal.inspect(products::map(.price))
				}`),
			).toEqual(["[ 2, 1 ]"])
		})

		it("reads every step of the path", async () => {
			expect(
				await run(`implementation {
					${product}
					Terminal.inspect(products::map(.maker.town))
				}`),
			).toEqual(['[ "Ulm", "Kiel" ]'])
		})

		// The Enricher desugars a path into a Function literal whose Parameter is
		// `_0`, so the Optimiser inlines an ordinary Function.
		// See "Member paths" in packages/compiler/src/enricher/DEVELOPMENT.md.
		it("emits the Function literal it stands for", () => {
			expect(
				generate(`implementation {
					${product}
					Terminal.inspect(products::map(.maker.town))
				}`),
			).toContain("_0.maker.town")
		})

		it("reads a path off an annotation", async () => {
			expect(
				await run(`implementation {
					${product}
					constant priceOf: (_: Product) -> Integer = .price
					Terminal.inspect(priceOf({
						name = "a",
						price = 7,
						maker = { town = "Kiel" },
					}))
				}`),
			).toEqual(["7"])
		})

		// The path's return Type binds `Key`, and the path is readable only once
		// `Item` is bound. `deferredArgumentOrder` holds the path back until then.
		it("binds a Type Parameter from what the path reads", async () => {
			expect(
				await run(`implementation {
					${product}
					function keyed<infer Item, infer Key>(
						_ items: List<Item>,
						on key: (_: Item) -> Key,
					) -> List<Key> {
						<- items::map(key)
					}

					Terminal.inspect(keyed(products, on .maker.town))
				}`),
			).toEqual(['[ "Ulm", "Kiel" ]'])
		})

		// A literal outside Argument position takes no Types from around it, so
		// the second Help writes both Types out as blanks.
		it("refuses a path where no Function is expected", () => {
			let diagnostics = diagnosticsOf(`implementation {
				${product}
				constant price = .price
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("path-without-context")
			expect(diagnostics[0].helps).toEqual([
				"Pass the path where a Function of one Parameter is expected — '::map(.price)'.",
				"Or write the Function literal, with the Parameter and return Types a path leaves out — '(_ item: <Type>) -> <Type> { <- item.price }', filling each '<Type>' in.",
			])
		})

		it("refuses a path where a Function of two Parameters is expected", () => {
			let diagnostics = diagnosticsOf(`implementation {
				${product}
				constant order: (_: Product, _: Product) -> Ordering = .price
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("path-without-context")
		})

		// A call that resolved to nothing names no Parameter Type, and its own
		// refusal is the mistake.
		it("reports only the call around a path when the call resolved to nothing", () => {
			let diagnostics = diagnosticsOf(`implementation {
				${product}
				constant total = sumBy(products, .price)
				constant other = products::sumBy(.price)
				constant third = Nowhere.sumBy(products, .price)
				constant fourth = undeclared::map(.price)
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unknown-name",
				"unknown-method",
				"unknown-name",
				"unknown-name",
			])
		})

		// A call inside the refused one reads its own Arguments' positions. A
		// literal's body stands in no Argument. A path in either is a mistake of
		// its own.
		it("still reports a path a call or a body inside that call holds", () => {
			let diagnostics = diagnosticsOf(`implementation {
				${product}
				constant shown = sumBy(Terminal.print(.price))
				constant read = sumBy((x: Integer) -> Integer {
					constant price = .price
					<- x
				})
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["unknown-name", 10],
				["path-without-context", 10],
				["unknown-name", 11],
				["path-without-context", 12],
			])
		})

		// The path's own hole binds `T`, so the call answers an Error, yet it
		// selected `id`. The path is the one mistake.
		it("still reports a path a call answering an Error selected", () => {
			let diagnostics = diagnosticsOf(`implementation {
				function id<infer T>(_ value: T) -> T {
					<- value
				}

				constant read = id(.price)
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"path-without-context",
			])
		})

		// `5` binds no `T`, so no Type names the member the path reads. A
		// bound changes nothing, though it makes the call answer an Error.
		it("refuses a path the call decides no Type for", () => {
			for (let bound of ["", " is Printable"]) {
				let diagnostics = diagnosticsOf(`implementation {
					function free<infer T${bound}>(
						_ items: List<T>,
						_ by: (_ item: T) -> Integer,
					) -> Integer {
						<- items::length()
					}

					Terminal.inspect(free(5, .price))
				}`)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["path-without-context"])
				expect(diagnostics[0].labels[0]?.message).toBe(
					"'price' is read off 'T', which nothing here decides",
				)
			}
		})

		// Arguments that do not pair are a refused call's, so the count is the
		// one report and the path stays silent.
		it("reports only the count where a lone signature's Arguments do not pair", () => {
			let diagnostics = diagnosticsOf(`implementation {
				function free<infer T>(_ items: List<T>, _ by: (_ item: T) -> Integer) -> Integer {
					<- items::length()
				}

				Terminal.inspect(free(5, .price, 3))
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"argument-count-mismatch",
			])
		})

		// The path's own Error would bind `T`, which then reads as decided.
		it("refuses a path no Argument decides the Type of", () => {
			let diagnostics = diagnosticsOf(`implementation {
				function apply<infer T>(_ by: (_ item: T) -> Integer) -> Integer {
					<- 1
				}

				Terminal.inspect(apply(.price))
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"path-without-context",
			])
		})

		// A Type Parameter the Function declares stands for any Type, so the
		// emitted read would find no member.
		it("refuses a step read off a Type Parameter the Function declares", () => {
			let diagnostics = diagnosticsOf(`implementation {
				function prices<infer T>(_ items: List<T>) -> List<Integer> {
					<- items::map(.price)
				}

				Terminal.inspect(prices([1, 2]))
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"path-step-not-a-record",
			])
			expect(diagnostics[0].labels[0]?.message).toBe("read off a T")
		})

		it("refuses a step read off a List", () => {
			let diagnostics = diagnosticsOf(`implementation {
				type Basket = { lines: List<Integer> }
				constant baskets: List<Basket> = []
				constant counts = baskets::map(.lines.length)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("path-step-not-a-record")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"read off a List<Integer>",
			)
		})

		it("refuses a step read off an Optional", () => {
			let diagnostics = diagnosticsOf(`implementation {
				type Person = { nickname: Optional<String> }
				constant people: List<Person> = []
				constant lengths = people::map(.nickname.length)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("path-step-not-a-record")
		})

		// The Record is right and the name is wrong, so this is an unknown member.
		it("names a member the Record does not declare", () => {
			let diagnostics = diagnosticsOf(`implementation {
				${product}
				constant towns = products::map(.makr)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-member")
		})

		it("refuses a call written on a path", () => {
			let diagnostics = diagnosticsOf(`implementation {
				${product}
				constant towns = products::map(.price::toString())
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("path-is-members-only")
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

			// The bounded Function takes a hidden trailing Parameter. The call site
			// passes the conforming Namespace's Methods as an object literal.
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

			// An unconditional witness is a plain object literal. `Integer.compare`
			// is native, so its entry is a plain member read.
			expect(code).toContain("compare: Integer.compare")
			expect(code).not.toContain("boundConformance")
		})

		it("should wrap a nested witness in boundConformance", () => {
			const code = generate(`implementation {
				constant ordered = [[1, 2], [3]]::sort()
			}`)

			// `List<List<Integer>>` sorts through `List.compare`, which the
			// conditional witness curries with the inner Integer ordering.
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

			// The hidden conformance Parameters and the call's witnesses both follow
			// the Namespace's Generic order: `Key`, then `Value`.
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

	// A label decides which Parameter and Overload an Argument matches, and
	// the emitted call is positional.
	describe("Labelled Arguments", () => {
		it("spends the label at compile time and emits the call positionally", async () => {
			const source = `implementation {
				function shout (about topic: String, times count: Integer) -> String {
					<- topic::append("!")::repeat(times count)
				}

				Terminal.inspect(shout(about "hi", times 2))
			}`

			const code = generate(source)

			// The internal names become the emitted Parameters, and the labels
			// appear nowhere.
			expect(code).toContain("function shout(topic, count)")
			expect(code).not.toContain("about")
			expect(code).not.toContain("times")

			expect(await run(source)).toEqual(['"hi!hi!"'])
		})

		// The two calls differ only in the middle label. The predicate holds on
		// the seed, so picking the wrong Overload prints the other number.
		it("picks the Overload the label names", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(loop(
						startingWith 1,
						while (n) { <- n::isLessThan(4) },
						(n) { <- n::add(1) },
					))

					Terminal.inspect(loop(
						startingWith 1,
						until (n) { <- n::isLessThan(4) },
						(n) { <- n::add(1) },
					))
				}`),
			).toEqual(["4", "1"])
		})
	})

	// A default is lowered to a JavaScript default parameter. A call that
	// leaves out an Argument ends early where nothing follows the hole, and
	// passes `void 0` where something does.
	describe("Default Parameter Values", () => {
		// `pool-constants` is off, so the default is read back rather than the
		// name the pool gives it.
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

		// The hidden `__conformance` Argument comes after the hole, so the hole
		// has to be passed.
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

		// A Program may bind the name `undefined`, so a hole is spelled `void 0`,
		// which nothing can rebind.
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

		// Each dispatch branch resolves to its own Method, so each opens its own
		// holes in the shared Argument list.
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

		// With `compile-union-dispatch` off, the runtime's own search dispatches.
		it("should let the runtime search open a branch's holes too", async () => {
			let options = {
				enabled: true,
				disabledPasses: new Set(["compile-union-dispatch"]),
			}

			expect(generate(divergentDispatch, undefined, options)).toContain(
				"$type.dispatchMethod",
			)
			expect(await run(divergentDispatch, undefined, options)).toEqual([
				"30",
				"3",
			])
		})
	})

	// A user's `overload` block defines every Overload, so the emitted slots
	// follow written order. Only a standard library Namespace can leave a gap.
	// See "Overload slots" in packages/compiler/src/simplifier/DEVELOPMENT.md.
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

		// Each callback runs the entry whose Function takes its Parameter count.
		it("should run the Overload a callback's Parameter count selects", async () => {
			expect(
				await run(`implementation {
					namespace Runner for Integer {
						overload run {
							(step advance: (_ a: Integer) -> Integer) -> Integer {
								<- advance(@)
							}
							(step advance: (_ a: Integer, _ b: Integer) -> Integer) -> Integer {
								<- advance(@, 10)
							}
						}
					}

					Terminal.inspect(1::run(step (a, b) { <- a::add(b) }))
					Terminal.inspect(1::run(step (a) { <- a::add(100) }))
				}`),
			).toEqual(["11", "101"])
			expect(
				await run(`implementation {
					namespace Runner for Integer {
						overload run {
							<infer T>(step value: T) -> Integer {
								<- 0
							}
							(step advance: (_ a: Integer, _ b: Integer) -> Integer) -> Integer {
								<- advance(@, 10)
							}
						}
					}

					Terminal.inspect(1::run(step (a, b) { <- a::add(b) }))
				}`),
			).toEqual(["11"])
		})
	})

	// A literal inside an Argument is no Argument, so it takes no Types from
	// the Overload selected, and its report stands whichever entry is.
	describe("A literal inside an Argument of an Overload", () => {
		let gen = (entries: string, call: string) => `implementation {
			namespace Gen for Integer {
				overload pick {
					${entries}
				}
			}

			Terminal.inspect(${call})
		}`
		let entries = (step: string, body: string) => `
			(step c: ${step}, by n: String) -> Integer {
				<- 0
			}
			(step c: ${step}, by n: Integer) -> Integer {
				${body}
			}
		`
		let record = entries("{ f: (_ a: Integer) -> Integer }", "<- c.f(n)")
		let listed = entries("List<(_ a: Integer) -> Integer>", "<- n")
		let optional = entries(
			"Optional<(_ a: Integer) -> Integer>",
			"<- match c -> Integer { case #Value(held) { <- held(n) } case #Empty { <- 0 } }",
		)

		it("reports it whichever entry is selected", () => {
			for (let source of [
				gen(record, "1::pick(step { f = (p) { <- p } }, by 2)"),
				gen(listed, "1::pick(step [(p) { <- p }], by 2)"),
				gen(
					optional,
					'1::pick(step #Value((p) { <- p::add("y") }), by 2)',
				),
				gen(
					entries("Integer", "<- c"),
					"1::pick(step match 1 -> Integer { case Integer { constant f = (p) { <- p } <- 1 } }, by 2)",
				),
			]) {
				expect(
					diagnosticsOf(source)
						.filter((diagnostic) => diagnostic.severity === "error")
						.map((diagnostic) => diagnostic.code),
				).toContain("uninferable-parameter-type")
			}
		})

		it("runs once the literal writes its Types", async () => {
			expect(
				await run(
					gen(
						record,
						"1::pick(step { f = (_ p: Integer) -> Integer { <- p::add(1) } }, by 2)",
					),
				),
			).toEqual(["3"])
			expect(
				await run(
					gen(
						optional,
						"1::pick(step #Value((_ p: Integer) -> Integer { <- p::add(5) }), by 2)",
					),
				),
			).toEqual(["7"])
		})
	})

	describe("Union Method Dispatch", () => {
		it("should emit one statically resolved target per member", () => {
			const source = `implementation {
				constant value: Integer | Boolean = 5

				Terminal.inspect(value::toString())
			}`
			const code = generate(source)

			// `compile-union-dispatch` writes a test on the receiver's tag. With the
			// pass off, `$type.dispatchMethod` reaches the same targets.
			expect(code).toContain('value[$type.typeKeySymbol] === "Integer"')
			expect(
				generate(source, undefined, {
					enabled: true,
					disabledPasses: new Set(["compile-union-dispatch"]),
				}),
			).toContain("$type.dispatchMethod")
			// `Integer.toString` is native, a read off the plain import, and
			// `Boolean.toString` is Essence, a const of its own.
			// See "The standard library prelude" in packages/compiler/src/rewriter/DEVELOPMENT.md.
			expect(code).toContain("Integer.toString")
			expect(code).toContain("$es_Boolean_toString")
		})

		it("should mangle overloaded Method names per dispatch case", () => {
			const code = generate(`implementation {
				constant number: Number = 5

				Terminal.inspect(number::multiply(with 2)::toString())
			}`)

			// The mangled name survives in both spellings, the native Integer entry
			// and the Essence Rational one.
			expect(code).toContain("Integer.multiply__overload$")
			expect(code).toContain("$es_Rational_multiply__overload$")
		})

		// `fallback` is `Item | Boolean`, so `toString` dispatches over a Union.
		// Only the emitted branch names `$es_Boolean_toString`, so reachability
		// has to find the const there. `Item` comes from the first Parameter,
		// since an Argument on the concrete member leaves it unbound. An Optional's
		// `toString` is native and resolves statically, so it would not dispatch.
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

			// The prelude const comes before every Function, so `lastIndexOf` finds
			// the branch. A catch-all accepts every value, so it is tried last.
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

			expect(output).toEqual(['"[1, 2, 3]"', '"true"', '"false"'])
		})
	})

	// Each Method the standard library writes in Essence is a top-level const
	// beside the Namespace's import.
	// See "Const names" in packages/compiler/src/rewriter/DEVELOPMENT.md.
	describe("Essence Method Names", () => {
		it("names a Method the standard library implements in Essence", () => {
			expect(essenceMethodName("Boolean", "exclusiveOr")).toBe(
				"$es_Boolean_exclusiveOr",
			)
			expect(essenceMethodName("Number", "toString")).toBe(
				"$es_Number_toString",
			)
		})

		it("returns null for a native Method", () => {
			// `Boolean.negate` is bound to the runtime module, so it stays
			// a member read and has no top-level const.
			expect(essenceMethodName("Boolean", "negate")).toBeNull()
			expect(essenceMethodName("String", "append")).toBeNull()
		})

		it("returns null for a native static Property", () => {
			// The lookup keys on Methods only. `Number.Pi` is a Property
			// and reaches a call site through a member read, never a const.
			expect(essenceMethodName("Number", "Pi")).toBeNull()
		})

		it("keeps an overload's mangled suffix in the name", () => {
			expect(essenceMethodIdentifier("Number", "sum__overload$2")).toBe(
				"$es_Number_sum__overload$2",
			)
		})

		// A Property's const takes the same name a Method's would, so the two
		// tables must not both answer for one member.
		it("returns null for a static Property the library gives no value", () => {
			expect(essencePropertyName("Number", "Pi")).toBeNull()
			expect(essencePropertyName("Number", "Tau")).toBeNull()
		})

		it("keeps a Method out of the Property table", () => {
			expect(essencePropertyName("Boolean", "exclusiveOr")).toBeNull()
			expect(essenceMethodName("Boolean", "exclusiveOr")).toBe(
				"$es_Boolean_exclusiveOr",
			)
		})
	})

	describe("Reserved-word identifiers", () => {
		// A JavaScript reserved word such as `new` is a legal Essence name. It is
		// emitted with a `_` prefix, which no Essence name can contain.
		// See "Escaped names" in packages/compiler/src/rewriter/DEVELOPMENT.md.

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
			// A member name is not escaped, since a reserved word is a legal property
			// key.
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
		// A synthetic standard library hands the Rewriter shapes the real one
		// lacks. The edges are read off the prelude it returns.
		function preludeOf(source: string) {
			return buildStdlibPrelude(
				loadStdlibFrom([parseStdlibSource("Synthetic.es", source)]),
			)
		}

		it("emits an Essence-implemented Method as its own const", () => {
			const code = generate(`implementation {
				Terminal.inspect(true::exclusiveOr(false))
			}`)

			// The Namespace keeps its plain import, with no `$native_` alias and no
			// merged const. The Essence Method is a top-level const beside it.
			expect(code).toContain('import * as Boolean from "')
			expect(code).not.toContain("$native_Boolean")
			expect(code).not.toContain("const Boolean = {")
			expect(code).toContain(
				"const $es_Boolean_exclusiveOr = function (_self, other) {",
			)

			// A Namespace whose Essence Methods the Program does not reach
			// keeps the plain import and gains no const.
			expect(code).toContain('import * as String from "')
			expect(code).not.toContain("$es_String_")
		})

		// `exclusiveOr` is `@::is(other)::negate()`. The native `Boolean.is` is a
		// read off the runtime module, and `lower-scalar-operations` writes
		// `negate` as `!`.
		it("emits a body that reads the natives off the runtime module", () => {
			const code = generate(`implementation {
				Terminal.inspect(true::exclusiveOr(false))
			}`)

			expect(code).toContain("!Boolean.is(_self, other).value")
		})

		// An unused const still names the runtime Methods its body reaches, so a
		// Program that never names the Method gets no const.
		// See "Prelude reachability" in packages/compiler/src/rewriter/DEVELOPMENT.md.
		it("emits no const for a Method the Program never names", () => {
			const code = generate(`implementation {
				Terminal.inspect("hello")
			}`)

			expect(code).not.toContain("$es_Boolean_exclusiveOr")
			expect(code).toContain('import * as Boolean from "')
		})

		// Reachability starts from the emitted code, where a conformance witness,
		// a dispatch target and a plain call are all Identifiers.
		it("finds a Method named only through a conformance witness", () => {
			const code = generate(`implementation {
				function describe <infer Value is Printable>(_ a: Value) -> String {
					<- a::toString()
				}

				constant yes = true

				Terminal.inspect(describe(yes))
			}`)

			expect(code).toContain("toString: $es_Boolean_toString")
			expect(code).toContain("const $es_Boolean_toString")
		})

		// A Record member spelled like a Namespace stays a plain member read.
		// `rewriteLookup` handles a Record field and a static Method alike.
		it("does not mistake a member name for a reference", () => {
			const code = generate(`implementation {
				constant record = { Boolean = "not the Namespace" }

				Terminal.inspect(record.Boolean)
			}`)

			expect(code).toContain("record.Boolean")
			expect(code).not.toContain("$es_")
		})

		// Spreading a runtime module, `{ ...Number, … }`, builds its module
		// namespace object. `Everyday.es` reaches an Essence Method and a large
		// runtime module but writes no spread, so its output should hold none.
		it("never spreads a runtime module", () => {
			const source = readFileSync(fixturePath("Everyday.es"), {
				encoding: "utf-8",
			})

			expect(generate(source)).not.toMatch(/\{\s*\.\.\./)
		})

		// No user name contains `_`, so the `$es_` prefix can not collide.
		// `$esBooleanexclusiveOr` is the closest a user can write.
		it("keeps a user identifier near the prefix distinct", async () => {
			const source = `implementation {
				constant $esBooleanexclusiveOr = "mine"

				Terminal.inspect($esBooleanexclusiveOr::append(true::exclusiveOr(false)::toString()))
			}`

			const code = generate(source)

			expect(code).toContain("$esBooleanexclusiveOr")
			expect(code).toContain("$es_Boolean_exclusiveOr")
			expect(await run(source)).toEqual(['"minetrue"'])
		})

		it("runs exclusiveOr from its const", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(false::exclusiveOr(true)::toString())
					Terminal.inspect(true::exclusiveOr(true)::toString())
					Terminal.inspect(false::exclusiveOr(false)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"false"'])
		})

		// The witness reads the bare `$es_Boolean_toString` const. It uses
		// `Printable` because Boolean's `is` is native and `isNot` is `Equatable`'s.
		it("witnesses Printable with the Essence Method", async () => {
			const source = `implementation {
				function describe <infer Value is Printable>(_ a: Value) -> String {
					<- a::toString()
				}

				Terminal.inspect(describe(true))
				Terminal.inspect(describe(false))
			}`

			expect(generate(source)).toContain("toString: $es_Boolean_toString")
			expect(await run(source)).toEqual(['"true"', '"false"'])
		})

		// A dispatch case reaches an Essence Method as a bare `$es_` Identifier,
		// and nothing else in the Program names the const.
		it("dispatches a Union receiver to an Essence Method", async () => {
			const source = `implementation {
				constant value: Integer | Boolean = true

				Terminal.inspect(value::toString())
			}`

			const code = generate(source)

			expect(code).toContain("$es_Boolean_toString")
			expect(code).toContain("const $es_Boolean_toString")
			// The Integer case stays a native member read.
			expect(code).toContain("Integer.toString")
			expect(await run(source)).toEqual(['"true"'])
		})

		// `Orderable.isBetween` is Essence and reaches other Essence consts. The
		// range named backwards holds `5` and not `15`, which shows the exchange.
		it("runs isBetween from its const", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(5::isBetween(1, and 10)::toString())
					Terminal.inspect(1::isBetween(1, and 10)::toString())
					Terminal.inspect(10::isBetween(1, and 10)::toString())
					Terminal.inspect(11::isBetween(1, and 10)::toString())
					Terminal.inspect(0::isBetween(1, and 10)::toString())
					Terminal.inspect(5::isBetween(10, and 1)::toString())
					Terminal.inspect(15::isBetween(10, and 1)::toString())
				}`),
			).toEqual([
				'"true"',
				'"true"',
				'"true"',
				'"false"',
				'"false"',
				'"true"',
				'"false"',
			])
		})

		// `isBetween` is `Orderable`'s provided Method over `Self`. Mixed bounds
		// compare through `Number`'s conformance, and Rational bounds through
		// Rational's.
		it("runs isBetween across the whole numeric tower", async () => {
			expect(
				await run(`implementation {
					constant pi: Number = Number.Pi
					constant half: Number = 3/2
					Terminal.inspect(pi::isBetween(3, and 22/7)::toString())
					Terminal.inspect(pi::isBetween(22/7, and 4)::toString())
					Terminal.inspect(half::isBetween(1, and 2)::toString())
					Terminal.inspect(3/2::isBetween(1/1, and 2/1)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"true"', '"true"'])
		})

		// Each const is gated per Method rather than per Namespace.
		it("emits each Essence Method's const only where it is reached", () => {
			const both = generate(`implementation {
				Terminal.inspect(5::isBetween(1, and 10)::exclusiveOr(false))
			}`)

			expect(both).toContain("const $es_Orderable__isBetween")
			expect(both).toContain("const $es_Boolean_exclusiveOr")

			// `exclusiveOr` alone, which names no Number.
			const booleanOnly = generate(`implementation {
				Terminal.inspect(true::exclusiveOr(false))
			}`)

			expect(booleanOnly).not.toContain("$es_Orderable__isBetween")
			expect(booleanOnly).toContain("const $es_Boolean_exclusiveOr")

			// `isBetween` alone, which reaches no `Boolean` const.
			const numberReached = generate(`implementation {
				Terminal.inspect(5::isBetween(1, and 10))
			}`)

			expect(numberReached).toContain(
				"const $es_Orderable__isBetween = function (_self, lower, upper, Self__conformance) {",
			)
			expect(numberReached).not.toContain("$es_Boolean_exclusiveOr")

			// Neither. A String-only Program names no Essence Method at all
			// and gets no const.
			const neither = generate(`implementation {
				Terminal.inspect("hello")
			}`)

			expect(neither).not.toContain("$es_Orderable__isBetween")
			expect(neither).not.toContain("$es_Boolean_exclusiveOr")
		})

		// `static Pi: Transcendental` has no value, so it is a native and stays a
		// member read off the runtime module.
		it("reads Pi and Tau as native member reads", async () => {
			const source = `implementation {
				constant pi: Number = Number.Pi
				Terminal.inspect(Number.Pi::toString())
				Terminal.inspect(Number.Tau::toString())
				Terminal.inspect(pi::isBetween(3, and 22/7)::toString())
			}`

			expect(generate(source)).toContain("Number.Pi")
			expect(await run(source)).toEqual(['"π"', '"2·π"', '"true"'])
		})

		// Simplifying and optimising the standard library for every file
		// compiled would be paid once per file for an answer that can not
		// differ.
		it("builds the prelude once per process", () => {
			expect(stdlibPrelude()).toBe(stdlibPrelude())
		})

		// The standard library's typed Programs are a process-wide
		// singleton. Building the prelude must leave them exactly as they were,
		// or the Language Server and the tests would read the Rewriter's
		// leavings.
		it("leaves the standard library's typed Programs untouched", () => {
			let before = JSON.stringify(loadStdlib().typedPrograms)

			buildStdlibPrelude(loadStdlib())

			expect(JSON.stringify(loadStdlib().typedPrograms)).toBe(before)
		})

		// A native holds its Overload slot, so the bodied Overload takes the
		// second name.
		// See "Overload slots" in packages/compiler/src/simplifier/DEVELOPMENT.md.
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

		// The Rewriter reads a free Function off two tables, both derived from the
		// loader's `functionBindings`. A bodied entry is a declaration of its own,
		// and a native one is a read off the runtime `functions` module.
		describe("the standard library's free Functions", () => {
			it("collects the Essence-bodied entries by their emitted name", () => {
				expect(
					stdlibFreeFunctions().map(
						(freeFunction) => freeFunction.name,
					),
				).toEqual([
					"loop__overload$2",
					"loop__overload$3",
					"loop__overload$5",
					"loop__overload$6",
					"loop__overload$7",
					"loop__overload$8",
					"loop__overload$9",
				])
			})

			// The Rewriter keys a candidate by name, so that name has to be the one
			// the emitted declaration answers to.
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

			// Every declared entry is in exactly one table, under the `__overload$N`
			// name its slot gives it.
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

		// The search runs to a fixed point, since a Method may be reached only
		// through another's body.
		// See "Prelude reachability" in packages/compiler/src/rewriter/DEVELOPMENT.md.
		describe("reachability", () => {
			// `Outer.quadruple` calls `Inner.double`, and nothing else
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

			// An Essence Method is reached as a bare `$es_` Identifier, as in a user
			// Program's emitted calls.
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

			// Free Functions share the fixed point with the Methods. The chain runs
			// from a Method to a free Function, between free Functions, and back to a
			// Method.
			describe("free Functions", () => {
				const crossing = `declarations {
	§§ Doubles the value.
	§§
	§§ @param _ — the Integer to double.
	§§ @returns — twice the value.
	function double(_ value: Integer) -> Integer {
		<- value::twice()
	}

	§§ Quadruples the value.
	§§
	§§ @param _ — the Integer to quadruple.
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

				// The free-Function half of a synthetic prelude, built the
				// way `buildStdlibArtifacts` builds the real one, copy included.
				// It can not be read off `stdlibFreeFunctions`, which answers for
				// the process-wide standard library.
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

				// A free Function is reached as a bare Identifier call, overloaded or not.
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

				// A free Function is a declaration of its own, under the bare name a call
				// site resolved to.
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

				// The set handed in decides an edge, as `implemented` does for a Method.
				// A native free Function is a read off `$_`, so it drops out.
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

			// `checkEssenceMethodsAreDeclared` checks every emitted Program behind the
			// fixed point. Only a hand-built tree can make it fire.
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

				// The sweep reads references only. A dotted member and an object literal's
				// key, such as a witness's `{ $es_Inner_double: … }`, are text.
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

				// A free Function's declaration takes its bare name, which a user binding
				// can spell too. The sweep checks only `$es_` names.
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

			// A shape the edge finder misses names a const that is never emitted, a
			// `ReferenceError` at run time. Each shape is fed in directly.
			// See "Prelude reachability" in packages/compiler/src/rewriter/DEVELOPMENT.md.
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

					// A static Method held as a value is an edge but is not evaluated. It
					// runs only when whoever holds it calls it.
					let handedOn = essenceMethodReferences(
						{ nodeType: "Argument", value: lookup },
						implemented,
					)

					expect([...handedOn.references]).toEqual([
						"$es_Target_static",
					])
					expect([...handedOn.evaluatedReferences]).toEqual([])
				})

				// A static Property read has the shape of a static Method reference, so
				// the table decides. A native Property such as `Number.Pi` is in neither.
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
					// Reading a Property's const takes its value, so the read is evaluated.
					expect([...refs.evaluatedReferences]).toEqual([
						"$es_Target_CONSTANT",
					])

					expect([
						...essenceMethodReferences(lookup, implemented)
							.references,
					]).toEqual([])
				})

				// A call may run a Method it is handed at once, as
				// `items::map(Boolean.isNot)` does, so the Method counts as evaluated. The
				// callee here is a native free Function.
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
					// A witness holds its Methods without running them, so they are not
					// evaluated.
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

				// A `FunctionInvocation` off a bare Identifier draws a free-Function edge,
				// keyed by the bare name the declaration is emitted under.
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

				// A native free Function and a call on a Function-typed local share this
				// shape. Neither is in the set, so neither draws an edge.
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

				// The free-Function edge is keyed by the bare name and the Method edge by
				// the `$es_` one, so the two sets decide independently.
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
					// A Record field access is a `Lookup` too, and must not be read as a
					// static reference.
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

				// `[ages with other]` is emitted as a call of `merge`, and
				// `[ages with "kim" = 7]` as a call of `set` per entry.
				describe("a Dictionary update", () => {
					const updates = new Set([
						"Dictionary merge__overload$1",
						"Dictionary set",
					])

					function updateOf(
						lhsType: unknown,
						rhs: unknown,
					): Record<string, unknown> {
						return {
							nodeType: "Combination",
							lhs: {
								nodeType: "Identifier",
								name: "ages",
								type: lhsType,
							},
							rhs,
						}
					}

					const other = {
						nodeType: "Identifier",
						name: "other",
						type: { type: "Dictionary" },
					}

					it("follows the merge a Dictionary on the right is emitted as", () => {
						let refs = essenceMethodReferences(
							updateOf({ type: "Dictionary" }, other),
							updates,
						)

						expect([...refs.references]).toEqual([
							"$es_Dictionary_merge__overload$1",
						])
						expect([...refs.evaluatedReferences]).toEqual([
							"$es_Dictionary_merge__overload$1",
						])
					})

					it("follows the set written entries are emitted as", () => {
						let refs = essenceMethodReferences(
							updateOf(
								{ type: "Dictionary" },
								{
									nodeType: "DictionaryValue",
									entries: [{ key: {}, value: {} }],
									keyConformance: null,
								},
							),
							updates,
						)

						expect([...refs.references]).toEqual([
							"$es_Dictionary_set",
						])
					})

					it("reads the base through the Refinement it carries", () => {
						let refs = essenceMethodReferences(
							updateOf(
								{
									type: "Refinement",
									base: { type: "Dictionary" },
								},
								other,
							),
							updates,
						)

						expect([...refs.references]).toEqual([
							"$es_Dictionary_merge__overload$1",
						])
					})

					it("draws no edge from a Record update", () => {
						let refs = essenceMethodReferences(
							updateOf({ type: "Record" }, other),
							updates,
						)

						expect([...refs.references]).toEqual([])
					})

					// The update runs the call it is emitted as, so a Method
					// handed to it counts as evaluated, as it does under a written
					// `set`.
					it("evaluates a static Method stored by the update", () => {
						let refs = essenceMethodReferences(
							updateOf(
								{ type: "Dictionary" },
								{
									nodeType: "DictionaryValue",
									entries: [
										{
											key: {},
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
									keyConformance: null,
								},
							),
							implemented,
						)

						expect([...refs.evaluatedReferences]).toEqual([
							"$es_Target_static",
						])
					})
				})

				// `Shade.cases()` beside `namespace Shades for Shade` names
				// the Choice in its base and is emitted off the Namespace the
				// Lookup carries.
				it("follows a `cases` read off the Namespace that writes it", () => {
					let refs = essenceMethodReferences(
						{
							nodeType: "Lookup",
							base: {
								nodeType: "Identifier",
								name: "Shade",
								type: { type: "Choice" },
							},
							member: { nodeType: "Identifier", name: "cases" },
							namespaceName: "Shades",
						},
						new Set(["Shades cases"]),
					)

					expect([...refs.references]).toEqual(["$es_Shades_cases"])
				})

				// A witness and a devirtualised witness name a native at
				// full arity, which is where `namespaceMember` routes a native
				// whose shim merges a Record default.
				describe("a native whose shim merges a Record default", () => {
					const mergingShims = new Set(["Target sent"])

					function referencesOf(root: unknown): Array<string> {
						return [
							...essenceMethodReferences(
								root,
								new Set(),
								new Set(),
								new Set(),
								new Set(),
								new Map(),
								mergingShims,
							).references,
						]
					}

					it("follows a witness's method map to the shim", () => {
						expect(
							referencesOf({
								nodeType: "ConformanceValue",
								namespaceName: "Target",
								methodMap: { send: "sent" },
								conditions: [],
							}),
						).toEqual(["$es_Target_sent"])
					})

					it("follows a devirtualised witness to the shim", () => {
						expect(
							referencesOf({
								nodeType: "Intrinsic",
								kind: "direct-method",
								namespaceName: "Target",
								memberName: "sent",
							}),
						).toEqual(["$es_Target_sent"])
					})
				})
			})

			// The real sources plus one file are installed as the library for this
			// block. The emitted bodies then spell their consts from that prelude.
			describe("the edges of a library body", () => {
				// Appended to the real sources, so its imports resolve to
				// the real files and `merge` is the library's own.
				const reached = `import {
	from "./Dictionary.es" { Dictionary }
	from "./Enumerable.es" { Enumerable }
	from "./List.es" { NonEmptyList }
	from "./String.es" { String }
}

declarations {

	§§ A shade of a colour.
	choice Shade {
		Light,
		Dark,
	}

	§ Named apart from the Choice, so \`Shade.cases()\` reads this Namespace's
	§ \`cases\` through the Choice's own name.
	namespace Shades for Shade is Enumerable {
		§§ Every Shade.
		§§
		§§ @returns — every Shade, lightest first.
		static cases() -> NonEmptyList<Shade> {
			<- [#Light, #Dark]
		}
	}

	namespace Reached for String {
		§§ Every Shade, read through the Choice.
		§§
		§§ @returns — every Shade, lightest first.
		static shades() -> NonEmptyList<Shade> {
			<- Shade.cases()
		}

		§§ The two Dictionaries as one.
		§§
		§§ @param _ — the Dictionary to add to
		§§ @param with — the Dictionary whose entries to add
		§§ @returns — the merged Dictionary.
		static merged(
			_ first: Dictionary<String, Integer>,
			with other: Dictionary<String, Integer>,
		) -> Dictionary<String, Integer> {
			<- [first with other]
		}

		§§ The Dictionary with one more entry.
		§§
		§§ @param _ — the Dictionary to add to
		§§ @returns — the Dictionary with the entry.
		static extended(
			_ first: Dictionary<String, Integer>,
		) -> Dictionary<String, Integer> {
			<- [first with "kim" = 7]
		}
	}
}

export {
	Reached
	Shade
}
`

				let replacedStdlib: Stdlib | null = null

				beforeAll(() => {
					let sources = readStdlibFiles().map(
						({ filePath, sourceText }) =>
							parseStdlibSource(
								filePath,
								filePath.endsWith("Prelude.es")
									? sourceText.replace(
											/\n}\s*$/,
											'\n\tfrom "./Reached.es" { Reached }\n}\n',
										)
									: sourceText,
							),
					)

					sources.push(parseStdlibSource("Reached.es", reached))

					replacedStdlib = useStdlib(loadStdlibFrom(sources))
				})

				afterAll(() => {
					useStdlib(replacedStdlib)
				})

				it("reaches merge from a body that writes a Dictionary update", () => {
					let reachable = reachableEssenceMethods(stdlibPrelude(), [
						callOf("Reached", "merged"),
					])

					expect([...reachable.keys()]).toContain(
						"$es_Dictionary_merge__overload$1",
					)
				})

				it("reaches a cases written in a Namespace of another name", () => {
					let reachable = reachableEssenceMethods(stdlibPrelude(), [
						callOf("Reached", "shades"),
					])

					expect([...reachable.keys()]).toContain("$es_Shades_cases")
				})

				it("compiles and runs a Program that reaches those bodies", async () => {
					expect(
						await run(`implementation {
	Terminal.inspect(Reached.merged(["amy" = 1], with ["bo" = 2]))
	Terminal.inspect(Reached.extended(["amy" = 1]))
	Terminal.inspect(Reached.shades())
}`),
					).toEqual([
						'[ "amy" = 1, "bo" = 2 ]',
						'[ "amy" = 1, "kim" = 7 ]',
						"[ Shade#Light, Shade#Dark ]",
					])
				})

				// `namespaceMember` spells a body's consts and the walk reads its edges
				// off the typed body, so a shape only one of them knows fails here.
				it("draws an edge to every const a library body names", () => {
					let whole = reachableEssenceMethods(
						stdlibPrelude(),
						[],
						stdlibFreeFunctions(),
						null,
						"whole",
					)

					let unfollowed = [...whole].flatMap(([name, member]) => {
						try {
							checkEssenceMethodsAreDeclared(
								{
									type: "Program",
									sourceType: "module",
									body: [member.declaration],
								},
								new Set([name, ...member.references]),
							)

							return []
						} catch (error) {
							return [`${name}: ${(error as Error).message}`]
						}
					})

					expect(unfollowed).toEqual([])
				})
			})
		})

		// A bodied static Property's value is computed where its const stands, so
		// it is emitted after every Function-valued member. No standard library
		// Property has a value, so these fixtures are synthetic.
		// See "Prelude emission order" in packages/compiler/src/rewriter/DEVELOPMENT.md.
		describe("a bodied static Property", () => {
			// `Constants.DOUBLE` reads `Other.BASE` and calls `Other.doubled`, one edge
			// into the value band and one out of it. `Other` stands first, since a
			// Property may name only a Namespace declared before it.
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

			// The seed sees an Essence member as a bare `$es_` Identifier, whether it
			// is a Property's value or a Method passed as one.
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

			// The fixed point covers Properties as it covers Methods. The kind comes
			// back with each, since neither name nor declaration tells the two apart.
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

			// The Map is in discovery order. Ordering puts every Function first, then
			// `BASE` before the `DOUBLE` that reads it.
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

			// `Constants.DOUBLE` reads no Property but calls `Reader.readsBase`, which
			// reads `Other.BASE` where the const stands. Ordered on Property edges
			// alone, `DOUBLE` would read `BASE` before it exists.
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

			// An edge inside one Namespace is an ordinary edge of the band. The
			// Validator refuses a Property that reads one written after it.
			// See "Use before declaration" in packages/compiler/src/validator/DEVELOPMENT.md.
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

			// A source can not write a cycle among Properties, so the band is handed
			// in directly. The edges are the evaluated ones, and a name listed in
			// `functions` is a Function-valued member.
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

			// The pooled constants are emitted between the two bands, so which band
			// a declaration is in decides where a Program's constants can be read.
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

			// A self-edge is a cycle here, unlike among the Methods, where a
			// Method calling itself is how recursion is written.
			it("refuses a Property that reads itself", () => {
				expect(() =>
					orderEssenceMembers(band({ $es_A_ONE: ["$es_A_ONE"] })),
				).toThrow("$es_A_ONE -> $es_A_ONE")
			})

			// `A` calls a Method that reads `B` inside `A`'s own initialiser, so `B`
			// comes first. The Method's const is in the Function band and constrains
			// nothing.
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

			// The same route closing on itself is a cycle no order can fix. The
			// refusal names the Methods on the route, since the Properties read
			// nothing of each other directly.
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

			// Two Methods calling each other is recursion, not a cycle. The walk over
			// the Functions is plain reachability, so it ends.
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

			// A Property and a Method of one Namespace share a const name, and
			// nothing upstream refuses the pair, so the prelude does.
			// See "Const names" in packages/compiler/src/rewriter/DEVELOPMENT.md.
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

			// A native Method reaches no typed Node, so the clash is read off the
			// loader's `nativeBindings`. Emitted, a call of the Method would call the
			// Property's value.
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

			// A static Property with no value is native too. A read of `Clash.PI`
			// would get the Method's const, the Function itself.
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

			// The const name carries the Namespace, so one name in two Namespaces is
			// two consts and no clash.
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

			// This block runs a user Program against a Property with a value. No
			// library file gives one a value, so the whole standard library plus one
			// file is installed as the library for the block.
			describe("read from a user Program", () => {
				// `DOUBLE` calls a Method and reads a Property of its own Namespace. It is
				// appended to the real sources, so `./Integer.es` resolves to the real
				// file: a library specifier is matched by file name.
				const constants = `import { from "./Integer.es" { Integer } }

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
					// Exporting `Constants` from its own file makes it reachable by the
					// standard library. A line in `Prelude.es` makes it a name a user Program
					// can write.
					let sources = readStdlibFiles().map(
						({ filePath, sourceText }) =>
							parseStdlibSource(
								filePath,
								filePath.endsWith("Prelude.es")
									? sourceText.replace(
											/\n}\s*$/,
											'\n\tfrom "./Constants.es" { Constants }\n}\n',
										)
									: sourceText,
							),
					)

					sources.push(parseStdlibSource("Constants.es", constants))

					replacedStdlib = useStdlib(loadStdlibFrom(sources))
				})

				// Every consumer reads the one process-wide standard library, so the
				// real one is put back.
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

					// The read is the bare const, not a native Property's member read.
					// Nothing about the Namespace is native, so it gets no import.
					expect(code).toContain(
						"Terminal.inspect(Integer.toString__overload$1($es_Constants_DOUBLE));",
					)
					expect(code).not.toContain("Constants.DOUBLE")
					expect(code).not.toContain('import * as Constants from "')

					// The Method's const comes before the value band, and `BASE` before the
					// `DOUBLE` that reads it.
					expect(
						code.indexOf("const $es_Constants_doubled ="),
					).toBeLessThan(code.indexOf("const $es_Constants_BASE ="))
					expect(
						code.indexOf("const $es_Constants_BASE ="),
					).toBeLessThan(code.indexOf("const $es_Constants_DOUBLE ="))
				})

				// The values are computed at import, so a band in the wrong order throws
				// before the Program's first line.
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

		// A native takes exactly the Parameters it declares, which
		// `builtins.spec.ts` checks through each export's `length`. So a shim, a
		// const beside the prelude, fills its defaults in. `String.slice` is one.
		describe("a native Method that declares a default", () => {
			// A call that writes every Argument is the direct runtime read and names
			// no const.
			it("emits a full call as the plain native read", () => {
				let code = generate(`implementation {
	Terminal.inspect("abcd"::slice(from 1, to 3))
}`)

				expect(code).toContain(
					"String.slice($pool_0, $pool_1, $pool_2)",
				)
				expect(code).not.toContain("$es_String_slice")
			})

			it("fronts a call that omits an Argument with a shim", () => {
				let code = generate(`implementation {
	Terminal.inspect("abcd"::slice(from 1))
}`)

				expect(code).toContain(
					"const $es_String_slice = (_self, start = ",
				)
				expect(code).toContain(") => String.slice(_self, start, end);")
				expect(code).toContain("$es_String_slice($pool_0, $pool_1)")
			})

			// `@` is `_self`, the shim's first Parameter, so the receiver is
			// evaluated once however many defaults read it. Filling defaults in at
			// the call site could not promise that.
			it("reads the receiver as a binding in the shim's own frame", () => {
				expect(
					generate(`implementation {
	Terminal.inspect("abcd"::slice(from 1))
}`),
				).toContain("end = String.length(_self)")
			})

			it("runs every spelling", async () => {
				expect(
					await run(`implementation {
	Terminal.inspect("abcd"::slice(from 1, to 3))
	Terminal.inspect("abcd"::slice(from 1))
	Terminal.inspect("abcd"::slice(to 2))
	Terminal.inspect("abcd"::slice())
}`),
				).toEqual(['"bc"', '"bcd"', '"ab"', '"abcd"'])
			})
		})

		// A native's Record default is merged into the Argument the call wrote,
		// which may leave members out. `Http.send` is the library's own case.
		describe("a native Method that declares a Record default", () => {
			it("fronts a call that wrote its Argument with the shim all the same", () => {
				let code = generate(`implementation {
	constant answered = complete Http.send({ url = "http://x.test/" })

	Terminal.inspect(answered::hasValue())
}`)

				expect(code).toContain("const $es_Http_send = request =>")
				expect(code).toContain("$es_Http_send({")
				expect(code).not.toContain("Http.send({")
			})

			// Each default member is merged with `??`, so a member the call wrote
			// survives, and the Argument's own `url` comes through unchanged. The
			// prologue is optimised like any body, so each default is pooled.
			it("merges every member the default fills in", () => {
				let code = generate(`implementation {
	constant answered = complete Http.send({ url = "http://x.test/" })

	Terminal.inspect(answered::hasValue())
}`)

				expect(code).toContain("url: request.url")

				for (let [member, tag] of [
					["method", "HttpMethod#Get"],
					["body", "Optional#Empty"],
					["redirects", "Redirects#Follow"],
				]) {
					let pooled = new RegExp(
						`${member}: request\\.${member} \\?\\? (\\$pool_\\d+)`,
					).exec(code)?.[1]

					expect(pooled).toBeDefined()
					expect(code).toContain(
						`const ${pooled} = $type.createCase("${tag}")`,
					)
				}
			})

			// `Http.get` calls `Http.send({ url, method = #Get, headers })` and omits
			// no Argument, so reachability has to draw the edge to the merging shim.
			// See "Prelude reachability" in packages/compiler/src/rewriter/DEVELOPMENT.md.
			it("pulls the shim in from an Essence body that calls it at full arity", () => {
				let code = generate(`implementation {
	constant answered = complete Http.get("http://x.test/")

	Terminal.inspect(answered::hasValue())
}`)

				expect(code).toContain("const $es_Http_send = request =>")
				expect(code).toContain("return $es_Http_send({")
			})
		})

		// A Namespace whose every member is native keeps its plain import,
		// and no const is emitted for it.
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

	// A Case's tag carries its Module's path, which keeps two files'
	// same-named Choices apart at run time. Qualifying a Program changes the
	// tags and nothing else, and the tags still agree when it runs.
	// See "Case tags and identities" in packages/compiler/src/rewriter/DEVELOPMENT.md.
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

	// A doorway takes a bare value, asks a refinement's question of it, and
	// hands it on under the refined name. A refinement erases to its base, so
	// what runs is the Program written without one.
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

		// The same Program without the check. Its refusal shows the narrowing is
		// what admits the call.
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

	// A written value is its own evidence, decided while compiling. A literal
	// reaches a total operation with no branch, and the proof leaves no trace.
	describe("an admitted literal", () => {
		const SOURCE = `implementation {
	type NonZero = Integer where @::isNot(0)
	type NonEmptyText = String where @::hasCharacters()

	function doubled(_ d: NonZero) -> Integer {
		<- d::multiply(with 2)
	}

	function shouted(_ text: NonEmptyText) -> String {
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

		// The same Program with a value the predicate refuses. Admission decides
		// about the value rather than letting every literal through.
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

	// A Guard runs after the Matcher's own check, so what it proves holds over
	// the whole body, for the named value as for `@`. The emitted Program is a
	// Case tag test and an `if`.
	describe("a Guard over the value a Handler named", () => {
		const SOURCE = `implementation {
	type Shout = String where @::hasCharacters()

	§ The operation that can not fail, and says so — there is nothing to shout
	§ where there is nothing written.
	function shouted(_ text: Shout) -> String {
		<- text::uppercase()
	}

	§ The doorway: the Guard asks the question of the value the Case carries, and
	§ the body reaches the total operation with the value it named.
	function shoutedOr(_ value: Optional<String>) -> String {
		<- match value -> String {
			case #Value(item) where item::hasCharacters() {
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

		// The same Program without the Guard. Its refusal shows the narrowing is
		// what admits the call.
		const UNGUARDED = `implementation {
	type Shout = String where @::hasCharacters()

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

	// A Guard reads a Handler's binding as `@.member`, since the body's
	// Constant does not exist yet. A `define` there narrows the binding, and
	// its arms must still read `@.member`. Each source divides by the narrowed
	// value through the total `divide(by:)`, so the output names the divisor.
	describe("a define inside a Match Guard", () => {
		it("reads the Handler's binding through the '@' its Guard lent it", async () => {
			expect(
				await run(`
					implementation {
						function quotientIsLarge(_ value: Optional<Integer>) -> String {
							<- match value -> String {
								case #Value(count) where define {
									as 100::divide(by count)::isGreaterThan(10) if count::isNot(0)
									as false otherwise
								} {
									<- "large"
								}

								case #Value(count) {
									<- "small"
								}

								case #Empty {
									<- "nothing"
								}
							}
						}

						Terminal.inspect(quotientIsLarge(#Value(5)))
						Terminal.inspect(quotientIsLarge(#Value(0)))
						Terminal.inspect(quotientIsLarge(#Empty))
					}
				`),
			).toEqual(['"large"', '"small"', '"nothing"'])
		})

		// A bare name in the arm would read the shadowed outer Parameter.
		// Dividing 100 by the outer 1 is large, and by the bound 50 it is not.
		it("does not read an outer name the binding shadows", async () => {
			expect(
				await run(`
					implementation {
						constant quotientIsLarge = (_ count: Integer, _ value: Optional<Integer>) -> String {
							<- match value -> String {
								case #Value(count) where define {
									as 100::divide(by count)::isGreaterThan(10) if count::isNot(0)
									as false otherwise
								} {
									<- "large"
								}

								case _ {
									<- "small"
								}
							}
						}

						Terminal.inspect(quotientIsLarge(1, #Value(50)))
					}
				`),
			).toEqual(['"small"'])
		})

		// The shadow takes its Type from what the Guard proved of `@.n`. An
		// outer String of that name would reach the standard library as a
		// `NonZeroInteger`.
		it("does not read an outer name of another Type", async () => {
			expect(
				await run(`
					implementation {
						constant n = "not a Number at all"

						constant quotientIsLarge = (_ value: Optional<{ n: Integer }>) -> String {
							<- match value -> String {
								case #Value({ n }) where define {
									as 100::divide(by n)::isGreaterThan(10) if n::isNot(0)
									as false otherwise
								} {
									<- "large"
								}

								case _ {
									<- "small"
								}
							}
						}

						Terminal.inspect(quotientIsLarge(#Value({ n = 50 })))
					}
				`),
			).toEqual(['"small"'])
		})

		// An `otherwise` arm holds the complements of every Condition above
		// it, which is a narrowing like any other and was lost the same way.
		it("reads it through '@' in the otherwise arm too", async () => {
			expect(
				await run(`
					implementation {
						function quotientIsLarge(_ value: Optional<Integer>) -> String {
							<- match value -> String {
								case #Value(count) where define {
									as false if count::is(0)
									as 100::divide(by count)::isGreaterThan(10) otherwise
								} {
									<- "large"
								}

								case _ {
									<- "small"
								}
							}
						}

						Terminal.inspect(quotientIsLarge(#Value(5)))
						Terminal.inspect(quotientIsLarge(#Value(0)))
					}
				`),
			).toEqual(['"large"', '"small"'])
		})

		// In the body the binding is a Constant, and a `define` there narrows it
		// under its own name.
		it("still narrows the same binding in the Handler's body", async () => {
			expect(
				await run(`
					implementation {
						function quotient(_ value: Optional<Integer>) -> String {
							<- match value -> String {
								case #Value(count) {
									<- define {
										as 100::divide(by count)::toString() if count::isNot(0)
										as "undefined" otherwise
									}
								}

								case #Empty {
									<- "nothing"
								}
							}
						}

						Terminal.inspect(quotient(#Value(5)))
						Terminal.inspect(quotient(#Value(0)))
					}
				`),
			).toEqual(['"20"', '"undefined"'])
		})
	})

	// A Match on an Integer's values is evidence both ways. A Case that names
	// a value proves it, and the last Case proves the value is none of those
	// named. What is emitted is a plain value comparison.
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

		// The same Match naming `1`, which proves nothing about zero.
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

	// Over a generic refinement, the branch works out `Filled<String>` from
	// the receiver. The evidence erases, so a List is a List.
	describe("a doorway over a generic refinement", () => {
		const SOURCE = `implementation {
	type Filled<Item> = List<Item> where @::hasItems()

	§ The operation that can not fail, and says so — there is no first item of an
	§ empty List, and no value of this Parameter's Type is empty.
	function firstOf(_ items: Filled<String>) -> String {
		<- items::item(at 0)::value(defaultingTo "")
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

		// The same Program without the check. Its refusal shows the narrowing is
		// what admits the call.
		const UNCHECKED = `implementation {
	type Filled<Item> = List<Item> where @::hasItems()

	function firstOf(_ items: Filled<String>) -> String {
		<- items::item(at 0)::value(defaultingTo "")
	}

	function firstOrEmpty(_ items: List<String>) -> String {
		<- firstOf(items)
	}

	Terminal.inspect(firstOrEmpty(["a", "b"]))
}`

		// The branch proves `hasItems` of a `List<Integer>`, which says nothing
		// about a `Filled<String>`. The Type Arguments are part of the evidence.
		const WRONG_ITEMS = `implementation {
	type Filled<Item> = List<Item> where @::hasItems()

	function firstOf(_ items: Filled<String>) -> String {
		<- items::item(at 0)::value(defaultingTo "")
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

	// An `else` proves the leaf of its condition asked the other way round.
	// `isZero` and `isNegative` call `is` and `isLessThan`, and the standard
	// library declares Types by exactly those leaves.
	describe("a doorway an else branch opens", () => {
		const SOURCE = `implementation {
	§ Total because the exponent is proven whole, and because the divisor is
	§ proven not to be zero. Neither answers an Optional.
	function raised(_ base: Integer, by exponent: NonNegativeInteger) -> Integer {
		<- base::raise(to exponent)
	}

	function shared(_ total: Integer, among count: NonZeroInteger) -> Rational {
		<- total::divide(by count)
	}

	§ The 'else' of a Method written as one call on '@' is the other polarity of
	§ that call, and nothing here spells either Type.
	function safelyRaised(_ base: Integer, by exponent: Integer) -> Integer {
		if exponent::isNegative() {
			<- 0
		} else {
			<- raised(base, by exponent)
		}
	}

	function safelyShared(_ total: Integer, among count: Integer) -> String {
		if count::isZero() {
			<- "nobody"
		} else {
			<- shared(total, among count)::toString()
		}
	}

	Terminal.inspect(safelyRaised(2, by 10))
	Terminal.inspect(safelyRaised(2, by -1))
	Terminal.inspect(safelyShared(9, among 3))
	Terminal.inspect(safelyShared(9, among 0))
}`

		// The same Program without the branches, which is refused.
		const UNCHECKED = `implementation {
	function raised(_ base: Integer, by exponent: NonNegativeInteger) -> Integer {
		<- base::raise(to exponent)
	}

	function safelyRaised(_ base: Integer, by exponent: Integer) -> Integer {
		<- raised(base, by exponent)
	}

	Terminal.inspect(safelyRaised(2, by 10))
}`

		it("runs each else branch through its total operation", async () => {
			expect(await run(SOURCE)).toEqual(["1024", "0", '"3"', '"nobody"'])
		})

		it("refuses the same call with no branch above it", () => {
			expect(
				hasCode(diagnosticsOf(UNCHECKED), "argument-type-mismatch"),
			).toBe(true)
		})
	})

	// The call works out `Item` in `NonEmptyList<Item>` from the written List.
	// `firstItem` then answers the item itself rather than an Optional.
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

		// The empty List decides no `Item` and fails the predicate, and either is
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

	// A product of two proven Integers is proven too. The refinement erases
	// first, so `lower-scalar-operations` lowers `NonZeroInteger.multiply` as
	// it lowers `Integer.multiply`. The runs use bigint values and a sign, so
	// a wrong operator shows.
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

		// With the Optimiser off the runtime Method multiplies instead of the
		// JavaScript operator, and the answer is the same.
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
