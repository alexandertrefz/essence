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

// NOTE: The same stages the CLI runs, minus bundling — the emitted text is what
// every assertion below is about, so nothing is written to disk to get it.
//
// NOTE: A naming rule holds for every build the Compiler can do, and turning an
// Optimiser pass off is one of them — which is why the Options are a Parameter
// here. They matter to exactly one question below: an un-optimised List literal
// is `List.createList(…)` and names a Namespace, where the collapsed one is an
// object literal that names none.
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

const withoutCollapsedConstruction: OptimiserOptions = {
	enabled: true,
	disabledPasses: new Set(["collapse-construction"]),
}

const withoutCollapsedCombinations: OptimiserOptions = {
	enabled: true,
	disabledPasses: new Set(["collapse-combinations"]),
}

const withoutCompiledTypeTests: OptimiserOptions = {
	enabled: true,
	disabledPasses: new Set(["compile-type-tests"]),
}

// NOTE: Every fault here compiled green and only showed itself in the emitted
// JavaScript — a wrong value, a `TypeError`, or a bundler syntax error quoting
// generated text — so each is pinned by RUNNING the Program as well as reading
// it. The emitted imports are absolute paths into this repo's runtime, so the
// throwaway module resolves from anywhere.
async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-naming-"))
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

describe("Code Generation — Naming and Escaping", () => {
	// NOTE: A Lookup used to be routed by the SPELLING of its base: any
	// Identifier base was treated as a Namespace, so a local named after one
	// answered with the standard library's Method. Which of the three a Lookup is
	// — a static call, a static Property read, a Record field read — is a
	// question about the base's resolved Type, and is now asked of it.
	describe("A local named after a Namespace", () => {
		const shadowedOptional = `implementation {
			function f() -> Integer {
				constant Optional = { otherwise = 5 }

				<- Optional.otherwise
			}

			Terminal.inspect(f())
		}`

		it("reads the Record field, not the standard library Method", () => {
			let generated = generate(shadowedOptional)

			// NOTE: The bug: `Optional.otherwise` became the prelude const for
			// `Optional::otherwise`, so `f` answered with a JavaScript Function
			// where an Integer was promised.
			expect(generated).not.toContain("$es_Optional_otherwise")
			expect(generated).toContain("$user_Optional.otherwise")
		})

		it("answers with the field's value at run time", async () => {
			expect(await run(shadowedOptional)).toEqual(["5"])
		})

		it("emits no const for a Method only the shadowing named", () => {
			// NOTE: The reachability search reads the same Types, so the edge to
			// `$es_Optional_otherwise` is not drawn either — a const nothing
			// references would otherwise be emitted beside the correct read.
			expect(generate(shadowedOptional)).not.toContain("$es_Optional_")
		})

		it("keeps a genuine static read on the Namespace itself", () => {
			// NOTE: The counterpart guard — an Identifier base whose Type IS a
			// Namespace still routes through `namespaceMember`, so a static
			// Property is the plain member read it always was.
			expect(
				generate(`implementation { Terminal.inspect(Number.Pi) }`),
			).toContain("Number.Pi")
		})
	})

	// NOTE: The emitted Program binds seventeen runtime Namespaces, `$_`, `$type`
	// and `$helpers`, and reads the global `Object` for a Combination. None is an
	// Essence keyword, so a Program may bind any of them itself — and JavaScript
	// lexical scoping then points every emitted helper call at the user's value.
	// `$` is a legal Essence identifier character, so `$type` and `$helpers` are
	// names a user can write with no way of knowing they are spoken for.
	describe("A binding spelled like a compiler-emitted global", () => {
		it("does not rebind the List import a list literal calls", async () => {
			const source = `implementation {
				function f() -> Integer {
					constant List = 5
					constant items = [1, 2]

					Terminal.inspect(items)

					<- List
				}

				Terminal.inspect(f())
			}`

			let generated = generate(source)

			// NOTE: The literal is a branded object literal — it names no
			// Namespace at all — and the user's own binding is somewhere else
			// entirely.
			expect(generated).toContain('[$type.typeKeySymbol]: "List"')
			expect(generated).toContain("const $user_List = ")
			expect(generated).not.toMatch(/\bconst List\b/)

			// NOTE: And with the collapse turned off the literal is
			// `List.createList(…)` again, which is the shape the shadowing
			// could break: that `List` has to be the IMPORT.
			expect(generate(source, withoutCollapsedConstruction)).toMatch(
				/\bList\.createList\(/,
			)

			// NOTE: Before the fix: `TypeError: List.createList is not a
			// function`.
			expect(await run(source)).toEqual(["[ 1, 2 ]", "5"])
		})

		it("does not rebind $type for a Match", async () => {
			const source = `implementation {
				variable value: Integer | String = 5
				constant $type = "hi"

				Terminal.inspect(match value -> String {
					case Integer { <- "integer" }
					case String  { <- "string" }
				})

				Terminal.inspect($type)
			}`

			let generated = generate(source)

			// NOTE: A Match reaches `$type` twice over — for the hidden key a
			// compiled Type test reads, and for the descriptor check the
			// Matchers that can not be compiled keep — and both have to be the
			// IMPORT.
			expect(generated).toContain(
				'_self[$type.typeKeySymbol] === "Integer"',
			)
			expect(generate(source, withoutCompiledTypeTests)).toContain(
				"$type.isValueOfType(",
			)
			expect(generated).toContain("const $user_$type = ")

			// NOTE: Before the fix: `TypeError: $type.isValueOfType is not a
			// function`.
			expect(await run(source)).toEqual([`"integer"`, `"hi"`])
		})

		it("does not rebind the global Object for a Combination", async () => {
			const source = `implementation {
				constant Object = 1
				constant base = { a = 1 }
				constant combined = { base with a = 2 }

				Terminal.inspect(combined.a)
				Terminal.inspect(Object)
			}`

			let generated = generate(source)

			// NOTE: A collapsed Combination is a spread and names nothing at
			// all; turn `collapse-combinations` off and `Object.assign` is
			// back, which is the shape the shadowing could break.
			expect(generated).toContain("...base")
			expect(generated).toContain("const $user_Object = ")
			expect(generate(source, withoutCollapsedCombinations)).toContain(
				"Object.assign(",
			)

			// NOTE: Before the fix: `TypeError: Object2.assign is not a
			// function`, esbuild having renamed the shadowing binding.
			expect(await run(source)).toEqual(["2", "1"])
		})

		it("does not rebind the global Object for a Namespace either", async () => {
			// NOTE: A Namespace is a `class <Name>` — the same shadowing, at the
			// same module scope, reached through the other emission path.
			const source = `implementation {
				namespace Object for Integer {
					doubled() -> Integer {
						<- @::multiply(with 2)
					}
				}

				constant base = { a = 1 }
				constant combined = { base with a = 3::doubled() }

				Terminal.inspect(combined.a)
			}`

			let generated = generate(source)

			expect(generated).toContain("class $user_Object {")
			expect(generated).toContain("$user_Object.doubled(")
			expect(generate(source, withoutCollapsedCombinations)).toContain(
				"Object.assign(",
			)

			expect(await run(source)).toEqual(["6"])
		})

		it("mangles a nested binding named after a runtime Namespace", async () => {
			// NOTE: Only an inner scope can hold one of these — at the top level
			// the Enricher refuses the redeclaration — which is exactly where
			// JavaScript's own scoping made the shadowing invisible.
			const source = `implementation {
				constant $helpers = 1

				function f() -> Integer {
					constant Record = 3

					<- Record
				}

				Terminal.inspect($helpers)
				Terminal.inspect(f())
				Terminal.inspect({ a = 1 })
				Terminal.inspect(true::isNot(false))
			}`

			expect(await run(source)).toEqual(["1", "3", "{ a = 1 }", "true"])
		})
	})

	// NOTE: A user Namespace can be named after a runtime one — `namespace List
	// for Integer` is a legal Program in any block below the top level, where
	// `List` is not declared yet and the Enricher has nothing to refuse. Emitted
	// verbatim, its `class List` shadowed the `import * as List` for the rest of
	// that block, so the List literal beside it called the USER's class:
	// `List.createList is not a function`, out of a Program that compiled green.
	//
	// NOTE: Which of the two a `List` means is a lexical question, and the
	// Enricher answers it lexically — a nested Namespace REPLACES the builtin of
	// its name for the rest of its block, in Method resolution ('No Method named
	// 'firstItem'' for a List beside a `namespace List`) and in conformance
	// solving alike ('String does not conform to 'Comparable'' beside a
	// `namespace String`). So the Rewriter answers it lexically too, and it is the
	// USER's Namespace that is mangled: the import keeps the name it was imported
	// under, which is the name every literal constructor spells.
	describe("A Namespace named after a runtime Namespace", () => {
		const shadowedList = `implementation {
			function f() -> Integer {
				namespace List for Integer {
					doubledValue() -> Integer {
						<- @::multiply(with 2)
					}
				}

				constant items = [1, 2]

				Terminal.inspect(items)

				<- 21::doubledValue()
			}

			Terminal.inspect(f())
		}`

		it("does not shadow the List import a list literal calls", async () => {
			let generated = generate(shadowedList)

			expect(generated).toContain("class $user_List {")
			expect(generated).toContain("$user_List.doubledValue(")
			expect(generated).toContain('[$type.typeKeySymbol]: "List"')
			expect(generated).not.toMatch(/\bclass List\b/)

			// NOTE: Before the fix: `TypeError: List.createList is not a
			// function` — the emitted `class List` had no such static Method.
			expect(await run(shadowedList)).toEqual(["[ 1, 2 ]", "42"])
		})

		it("does not shadow it for an un-optimised literal either", () => {
			// NOTE: The shape the fault was found in. A collapsed List literal
			// names no Namespace, so the shadowing can not reach it; turn
			// `collapse-construction` off and the literal is
			// `List.createList(…)` again, with the same `class $user_List`
			// beside it.
			let generated = generate(shadowedList, withoutCollapsedConstruction)

			expect(generated).toContain("class $user_List {")
			// NOTE: `\b` does not fire between `_` and `L`, so this asks for the
			// BARE name — the import the literal has to keep reaching.
			expect(generated).toMatch(/\bList\.createList\(/)
			expect(generated).not.toMatch(/\bclass List\b/)
		})

		it("leaves a sibling Function on the runtime Namespace", async () => {
			// NOTE: The mangling has to stop at the block that declares the
			// Namespace. `g` never saw the user's `List`, so every `List` in it is
			// the standard library's — mangling those alongside would answer a
			// `ReferenceError` for a Program that was always fine.
			const source = `implementation {
				function f() -> Integer {
					namespace List for Integer {
						doubledValue() -> Integer {
							<- @::multiply(with 2)
						}
					}

					<- 21::doubledValue()
				}

				function g() -> Integer {
					constant items = [1, 2]

					<- items::firstItem()::otherwise(0)
				}

				Terminal.inspect(f())
				Terminal.inspect(g())
			}`

			let generated = generate(source)

			expect(generated).toContain("$user_List.doubledValue(")
			expect(generated).toContain("$es_List_firstItem")
			expect(generated).not.toContain("$user_List.firstItem")

			expect(await run(source)).toEqual(["42", "1"])
		})

		it("closes the Namespace's scope with its block", async () => {
			// NOTE: The sanity case the whole fix is for: a Namespace named `List`
			// and List literals in the ONE Function, both working. Inside the
			// Conditional `List` is the user's; the moment the block closes it is
			// the standard library's again, and `firstItem` resolves on it.
			const source = `implementation {
				function f() -> Integer {
					variable total = 0

					if true {
						namespace List for Integer {
							doubledValue() -> Integer {
								<- @::multiply(with 2)
							}
						}

						total = 21::doubledValue()
					}

					constant items = [1, 2]

					Terminal.inspect(items::firstItem()::otherwise(0))

					<- total
				}

				Terminal.inspect(f())
			}`

			let generated = generate(source)

			expect(generated).toContain("class $user_List {")
			expect(generated).toContain("$es_List_firstItem")
			expect(generated).toContain('[$type.typeKeySymbol]: "List"')

			// NOTE: And with the collapse off, where the literal names the
			// import again — the shape the scoping rule is actually about, in
			// the Function whose block the user's `List` closed inside.
			expect(generate(source, withoutCollapsedConstruction)).toMatch(
				/\bList\.createList\(/,
			)

			expect(await run(source)).toEqual(["1", "42"])
		})

		it("does not route a shadowing Method to the standard library's const", async () => {
			// NOTE: The other half of the same fault, through the other spelling.
			// An Essence-implemented standard library Method is its own top-level
			// `$es_<Namespace>_<member>` const, and a user Namespace sharing the
			// Namespace's NAME and a Method's name was routed straight to it:
			// `$es_List_contains(5, 5)` ran the library's List.contains against an
			// Integer and died inside `reduce`.
			const source = `implementation {
				function f() -> Boolean {
					namespace List for Integer {
						contains(_ digit: Integer) -> Boolean {
							<- @::is(digit)
						}
					}

					<- 5::contains(5)
				}

				Terminal.inspect(f())
			}`

			let generated = generate(source)

			expect(generated).toContain("$user_List.contains(")
			expect(generated).not.toContain("$es_List_contains")

			// NOTE: Before the fix: `TypeError: value is not iterable`.
			expect(await run(source)).toEqual(["true"])
		})

		it("escapes a static call and a dispatch branch alike", async () => {
			// NOTE: Every emission site that names a Namespace has to agree with
			// the class declaration — a `Lookup`'s static call and each
			// `dispatchMethod` branch among them, both of which reach the same
			// `namespaceMember`.
			const source = `implementation {
				function f() -> Integer {
					namespace List for Integer {
						static zero() -> Integer {
							<- 0
						}

						describe() -> Integer {
							<- 1
						}
					}

					namespace Record for String {
						describe() -> Integer {
							<- 2
						}
					}

					variable value: Integer | String = "hi"
					constant items = [1, 2]

					Terminal.inspect(items)
					Terminal.inspect(List.zero())

					<- value::describe()
				}

				Terminal.inspect(f())
			}`

			let generated = generate(source)

			expect(generated).toContain("$user_List.zero()")
			expect(generated).toContain("$user_List.describe")
			expect(generated).toContain("$user_Record.describe")
			// NOTE: The runtime Namespaces the emitted helpers reach are
			// untouched — the String literal's constructor, and the hidden Type
			// key a collapsed List literal brands itself with.
			expect(generated).toContain('[$type.typeKeySymbol]: "List"')
			expect(generated).toMatch(/\bString\.createString\(/)

			// NOTE: The List literal names its Namespace again with the
			// collapse off, and it is still the import it names — beside a
			// `class $user_List` holding a static Method of its own, which is
			// the collision this Program is built out of.
			expect(generate(source, withoutCollapsedConstruction)).toMatch(
				/\bList\.createList\(/,
			)

			expect(await run(source)).toEqual(["[ 1, 2 ]", "0", "2"])
		})

		it("escapes a conformance witness on the shadowing Namespace", async () => {
			// NOTE: A witness is an object literal of Methods read off the
			// conforming Namespace, and its Namespace arrives as a bare string
			// with no Type to ask — so it rests on the same lexical answer.
			const source = `implementation {
				protocol Showable {
					toString() -> String
				}

				type Vector = { x: Integer }

				function describeValue <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				function f() -> String {
					namespace String for Vector is Showable {
						toString() -> String {
							<- "vector"
						}
					}

					constant greeting = "hi"

					Terminal.inspect(greeting)

					<- describeValue({ x = 1 })
				}

				Terminal.inspect(f())
			}`

			let generated = generate(source)

			expect(generated).toContain("toString: $user_String.toString")
			expect(generated).toMatch(/\bString\.createString\(/)

			expect(await run(source)).toEqual([`"hi"`, `"vector"`])
		})

		it("escapes a top-level Namespace of that name as well", () => {
			// NOTE: The Enricher refuses `namespace List` at the TOP level —
			// 'Variable 'List' is already declared' — so this shape can not be
			// written as a source Program, and the Rewriter must not rest on that
			// refusal staying in place. The typed Program is handed straight to it
			// instead.
			let listNamespace = {
				nodeType: "Identifier",
				name: "List",
				type: { type: "Namespace", name: "List" },
			}

			let integerList = { type: "List", itemType: { type: "Integer" } }

			let zero = {
				isStatic: true,
				method: {
					nodeType: "FunctionValue",
					value: {
						nodeType: "FunctionDefinition",
						parameters: [],
						body: [
							{
								nodeType: "ReturnStatement",
								expression: {
									nodeType: "IntegerValue",
									value: "0",
									type: { type: "Integer" },
								},
							},
						],
					},
				},
			}

			let program = {
				nodeType: "Program",
				implementation: {
					nodeType: "ImplementationSection",
					nodes: [
						{
							nodeType: "NamespaceDefinitionStatement",
							name: listNamespace,
							properties: {},
							methods: { zero },
						},
						{
							nodeType: "Lookup",
							base: listNamespace,
							member: { nodeType: "Identifier", name: "zero" },
						},
						{
							nodeType: "ListValue",
							values: [],
							type: integerList,
						},
					],
				},
			} as unknown as common.typedSimple.Program

			let generated = rewrite(program)

			expect(generated).toContain("class $user_List {")
			expect(generated).toContain("$user_List.zero")
			expect(generated).toMatch(/\bList\.createList\(/)
			expect(generated).not.toMatch(/\bclass List\b/)
		})
	})

	// NOTE: A declaration was escaped and its references were not, so the two
	// disagreed — `constant this = { x = 1 }` bound `_this` and read `this.x`,
	// which bundles to `exports.x` and reads `undefined`. Lookup bases and
	// Namespace class names go through the same escape as a Constant now.
	describe("A JavaScript reserved word", () => {
		it("escapes the base of a Record field read", async () => {
			const source = `implementation {
				constant this = { x = 1 }

				Terminal.inspect(this.x)
			}`

			let generated = generate(source)

			expect(generated).toContain("_this.x")
			// NOTE: `\b` does not fire inside `_this`, so this asks for the
			// BARE reserved word — which bundles to `exports.x` and reads
			// `undefined`.
			expect(generated).not.toMatch(/\bthis\.x/)

			expect(await run(source)).toEqual(["1"])
		})

		it("escapes a base that would not even bundle", async () => {
			// NOTE: `new.x` is not a member read at all — esbuild died with
			// `Unexpected "x"` on generated text.
			const source = `implementation {
				constant new = { x = 1 }

				Terminal.inspect(new.x)
			}`

			expect(generate(source)).toContain("_new.x")
			expect(await run(source)).toEqual(["1"])
		})

		it("escapes a Namespace's class name and its references alike", async () => {
			// NOTE: `class new {` was a bundler error — `Expected identifier but
			// found "new"`. `namespace new for Integer` is a legal Program: `new`
			// is not an Essence keyword.
			const source = `implementation {
				namespace new for Integer {
					static zero() -> Integer {
						<- 0
					}
				}

				Terminal.inspect(new.zero())
			}`

			let generated = generate(source)

			expect(generated).toContain("class _new {")
			expect(generated).toContain("_new.zero(")

			expect(await run(source)).toEqual(["0"])
		})
	})

	// NOTE: The Lexer ends an Identifier only at one of ITS symbols, and `?`,
	// `+`, `!`, `%`, `*`, `&`, `^` and `;` are not among them — so `ok?` and
	// `a+b` are single Identifier Tokens every stage carries to the Rewriter.
	// Emitted raw they are not JavaScript at all, and the build died in the
	// bundler with an esbuild syntax error quoting generated text at a line
	// number that does not exist in the author's file.
	describe("An identifier JavaScript can not spell", () => {
		it("mangles a Constant, at binding and reference", async () => {
			const source = `implementation {
				constant ok? = true

				Terminal.inspect(ok?)
			}`

			let generated = generate(source)

			expect(generated).toContain("const $user_ok_3f_ = ")
			expect(generated).not.toContain("ok?")

			expect(await run(source)).toEqual(["true"])
		})

		it("mangles a free Function's name too", async () => {
			const source = `implementation {
				function ok?() -> Boolean {
					<- true
				}

				Terminal.inspect(ok?())
			}`

			expect(generate(source)).toContain("function $user_ok_3f_(")
			expect(await run(source)).toEqual(["true"])
		})

		it("mangles distinct names distinctly", async () => {
			// NOTE: The encoding is injective — every character JavaScript
			// accepts is kept and every other becomes `_<code point>_`, and `_`
			// can appear nowhere else, so two names can not mangle alike.
			const source = `implementation {
				constant a+b = 1
				constant a?b = 2

				Terminal.inspect(a+b)
				Terminal.inspect(a?b)
			}`

			let generated = generate(source)

			expect(generated).toContain("$user_a_2b_b")
			expect(generated).toContain("$user_a_3f_b")

			expect(await run(source)).toEqual(["1", "2"])
		})

		it("is deterministic across runs", () => {
			const source = `implementation {
				constant ok? = true

				Terminal.inspect(ok?)
			}`

			expect(generate(source)).toBe(generate(source))
		})

		it("spells a Record field as a string key and a bracketed read", async () => {
			// NOTE: A member name is never ESCAPED — the read has to match the
			// key the literal wrote — but it does have to be spellable, so both
			// positions become the string form together.
			const source = `implementation {
				constant r = { ok? = true, a+b = 5 }

				Terminal.inspect(r.ok?)
				Terminal.inspect(r.a+b)
			}`

			let generated = generate(source)

			expect(generated).toContain(`"ok?":`)
			expect(generated).toContain(`["ok?"]`)

			expect(await run(source)).toEqual(["true", "5"])
		})

		it("spells a Namespace Method as a string key and a bracketed call", async () => {
			const source = `implementation {
				namespace Q for Integer {
					ok?() -> Boolean {
						<- true
					}
				}

				Terminal.inspect(1::ok?())
			}`

			let generated = generate(source)

			expect(generated).toContain(`static "ok?"(`)
			expect(generated).toContain(`Q["ok?"](`)

			expect(await run(source)).toEqual(["true"])
		})

		it("leaves an ordinary name untouched", () => {
			// NOTE: The whole point of the three narrow tests above — a Program
			// that trips none of them emits exactly what it always did.
			let generated = generate(`implementation {
				constant value = 5

				Terminal.inspect(value)
			}`)

			expect(generated).toContain("const value = ")
			expect(generated).not.toContain("$user_")
		})
	})

	// NOTE: `BigInt` is not a decimal parser: it reads `"0xFF"` as 255 and THROWS
	// on `"FF"`. The Lexer refuses a non-decimal Number Literal with a positioned
	// Diagnostic, so nothing should reach here — this is the belt to those
	// braces, because either failure would be silent or would abort the Rewriter
	// with a JavaScript error carrying no source location.
	describe("A Number Literal that is not decimal digits", () => {
		function emitInteger(value: string): string {
			let program = {
				nodeType: "Program",
				implementation: {
					nodeType: "ImplementationSection",
					nodes: [
						{
							nodeType: "IntegerValue",
							value,
							type: { type: "Integer" },
						},
					],
				},
			} as unknown as common.typedSimple.Program

			return rewrite(program)
		}

		it("does not read a hexadecimal digit string as a number", () => {
			expect(emitInteger("0xFF")).toContain("Integer.createInteger(0n)")
		})

		it("does not throw on a digit string with no digits", () => {
			expect(emitInteger("FF")).toContain("Integer.createInteger(0n)")
		})

		it("leaves a well-formed Literal byte-identical", () => {
			expect(emitInteger("42")).toContain("Integer.createInteger(42n)")
		})
	})
})
