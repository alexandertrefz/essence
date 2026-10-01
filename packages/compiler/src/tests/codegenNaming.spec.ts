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

// The CLI's stages without bundling. A naming rule must hold with any
// Optimiser pass off, so the Options are a Parameter. An uncollapsed List
// literal is `List.createList(…)` and names a Namespace.
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

// A naming fault compiles cleanly and shows only when the JavaScript runs, so
// the specs run the Program too. The emitted imports are absolute paths, so
// the throwaway module resolves from anywhere.
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
	// A Lookup's base's resolved Type, not its spelling, decides whether it is
	// a static call, a static Property read or a Record field read.
	describe("A local named after a Namespace", () => {
		const shadowedOptional = `implementation {
			function f() -> Integer {
				constant Optional = { value = 5 }

				<- Optional.value
			}

			Terminal.inspect(f())
		}`

		it("reads the Record field, not the standard library Method", () => {
			let generated = generate(shadowedOptional)

			expect(generated).not.toContain("$es_Optional_value")
			expect(generated).toContain("$user_Optional.value")
		})

		it("answers with the field's value at run time", async () => {
			expect(await run(shadowedOptional)).toEqual(["5"])
		})

		it("emits no const for a Method only the shadowing named", () => {
			// The reachability search reads the same Types, so it draws no edge
			// to `$es_Optional_value`.
			expect(generate(shadowedOptional)).not.toContain("$es_Optional_")
		})

		it("keeps a genuine static read on the Namespace itself", () => {
			// A base whose Type is a Namespace still routes through
			// `namespaceMember`, so a static Property is a plain member read.
			expect(
				generate(`implementation { Terminal.inspect(Number.Pi) }`),
			).toContain("Number.Pi")
		})
	})

	// A Program may bind any name emitted code uses for itself. See "Escaped
	// names" in packages/compiler/src/rewriter/DEVELOPMENT.md.
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

			// The collapsed literal is a branded object literal, which names no
			// Namespace.
			expect(generated).toContain('[$type.typeKeySymbol]: "List"')
			expect(generated).toContain("const $user_List = ")
			expect(generated).not.toMatch(/\bconst List\b/)

			// Without the collapse the literal is `List.createList(…)`, and that
			// `List` must be the import.
			expect(generate(source, withoutCollapsedConstruction)).toMatch(
				/\bList\.createList\(/,
			)

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

			// A Match reads `$type` for the hidden key a compiled Type test reads
			// and for the descriptor check of an uncompiled Matcher. Both must be
			// the import.
			expect(generated).toContain(
				'_self[$type.typeKeySymbol] === "Integer"',
			)
			expect(generate(source, withoutCompiledTypeTests)).toContain(
				"$type.isValueOfType(",
			)
			expect(generated).toContain("const $user_$type = ")

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

			// A collapsed Combination is a spread. Without
			// `collapse-combinations` it is `Object.assign`, which must be the
			// global.
			expect(generated).toContain("...base")
			expect(generated).toContain("const $user_Object = ")
			expect(generate(source, withoutCollapsedCombinations)).toContain(
				"Object.assign(",
			)

			expect(await run(source)).toEqual(["2", "1"])
		})

		it("does not rebind the global Object for a Namespace either", async () => {
			// A user Namespace is a `class <Name>` at module scope, so it could
			// shadow `Object` the same way.
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
			// Only an inner scope can bind a runtime Namespace's name, since the
			// Enricher refuses the redeclaration at the top level.
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

	// A nested user Namespace may take a runtime Namespace's name. The user's
	// class is mangled and the import keeps its name, which every literal
	// constructor spells. See "Shadowed Namespaces" in
	// packages/compiler/src/rewriter/DEVELOPMENT.md.
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

			expect(await run(shadowedList)).toEqual(["[ 1, 2 ]", "42"])
		})

		it("does not shadow it for an un-optimised literal either", () => {
			// Without `collapse-construction` the literal is `List.createList(…)`
			// beside the user's `class $user_List`.
			let generated = generate(shadowedList, withoutCollapsedConstruction)

			expect(generated).toContain("class $user_List {")
			// `\b` does not match between `_` and `L`, so this finds only the
			// bare import name.
			expect(generated).toMatch(/\bList\.createList\(/)
			expect(generated).not.toMatch(/\bclass List\b/)
		})

		it("leaves a sibling Function on the runtime Namespace", async () => {
			// The mangling stops at the block that declares the Namespace. `g`
			// never sees the user's `List`, so its `List` is the standard
			// library's.
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

					<- items::firstItem()::value(defaultingTo 0)
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
			// Inside the Conditional `List` is the user's. After the block it is
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

					Terminal.inspect(items::firstItem()::value(defaultingTo 0))

					<- total
				}

				Terminal.inspect(f())
			}`

			let generated = generate(source)

			expect(generated).toContain("class $user_List {")
			expect(generated).toContain("$es_List_firstItem")
			expect(generated).toContain('[$type.typeKeySymbol]: "List"')

			// Without the collapse the literal names the import, after the
			// block where the user's `List` closed.
			expect(generate(source, withoutCollapsedConstruction)).toMatch(
				/\bList\.createList\(/,
			)

			expect(await run(source)).toEqual(["1", "42"])
		})

		it("does not route a shadowing Method to the standard library's const", async () => {
			// An Essence-bodied standard library Method is a `$es_<Namespace>_<member>`
			// const. A user Namespace sharing both names must not be routed to it.
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

			expect(await run(source)).toEqual(["true"])
		})

		it("escapes a static call and a dispatch branch alike", async () => {
			// A `Lookup`'s static call and each `dispatchMethod` branch reach
			// `namespaceMember`, so they agree with the class declaration.
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
			// The String literal's constructor and the List literal's Type key
			// still reach the runtime Namespaces.
			expect(generated).toContain('[$type.typeKeySymbol]: "List"')
			expect(generated).toMatch(/\bString\.createString\(/)

			// Without the collapse the List literal names the import, beside a
			// `class $user_List` with a static Method of its own.
			expect(generate(source, withoutCollapsedConstruction)).toMatch(
				/\bList\.createList\(/,
			)

			expect(await run(source)).toEqual(["[ 1, 2 ]", "0", "2"])
		})

		it("escapes a conformance witness on the shadowing Namespace", async () => {
			// A witness names its Namespace as a bare string with no Type, so it
			// relies on the same lexical answer.
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
			// The Enricher refuses `namespace List` at the top level, so the spec
			// builds the typed Program by hand. The Rewriter must not rely on that
			// refusal.
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
				tests: null,
				coverage: null,
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

	// A declaration and its references go through one escape, including Lookup
	// bases and Namespace class names.
	describe("A JavaScript reserved word", () => {
		it("escapes the base of a Record field read", async () => {
			const source = `implementation {
				constant this = { x = 1 }

				Terminal.inspect(this.x)
			}`

			let generated = generate(source)

			expect(generated).toContain("_this.x")
			// `\b` does not match inside `_this`, so this finds only the bare
			// reserved word, which would bundle to `exports.x`.
			expect(generated).not.toMatch(/\bthis\.x/)

			expect(await run(source)).toEqual(["1"])
		})

		it("escapes a base that would not even bundle", async () => {
			// `new.x` is not even a member read in JavaScript.
			const source = `implementation {
				constant new = { x = 1 }

				Terminal.inspect(new.x)
			}`

			expect(generate(source)).toContain("_new.x")
			expect(await run(source)).toEqual(["1"])
		})

		it("escapes a Namespace's class name and its references alike", async () => {
			// `new` is no Essence keyword, so `namespace new for Integer` is legal,
			// but `class new {` does not parse.
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

	// A class refuses a static member named `prototype` and a field named
	// `constructor`, which an object literal accepts. Such a Namespace member is
	// mangled at the class body and at every read.
	describe("A Namespace member a class can not hold", () => {
		it("mangles a Method named prototype, at definition and call", async () => {
			const source = `implementation {
				type Box = { value: Integer }

				namespace Box for Box {
					prototype() -> Integer {
						<- @.value
					}
				}

				constant box: Box = { value = 4 }

				Terminal.inspect(box::prototype())
			}`

			let generated = generate(source)

			expect(generated).toContain("static $user_prototype(")
			expect(generated).toContain("Box.$user_prototype(")
			expect(generated).not.toMatch(/\bstatic prototype\b/)

			expect(await run(source)).toEqual(["4"])
		})

		it("mangles a static Property named constructor, at definition and read", async () => {
			const source = `implementation {
				namespace Box for Integer {
					static constructor = 5
				}

				Terminal.inspect(Box.constructor)
			}`

			let generated = generate(source)

			expect(generated).toContain("static $user_constructor = ")
			expect(generated).toContain("Box.$user_constructor")

			expect(await run(source)).toEqual(["5"])
		})

		it("leaves a Record member of either name alone", async () => {
			// A Record is an object literal, which holds both names, so the read
			// matches the key as written.
			const source = `implementation {
				constant r = { prototype = 1 }

				Terminal.inspect(r.prototype)
			}`

			let generated = generate(source)

			expect(generated).not.toContain("$user_prototype")

			expect(await run(source)).toEqual(["1"])
		})
	})

	// `ok?` and `a+b` are single Identifiers that JavaScript cannot spell. See
	// "Escaped names" in packages/compiler/src/rewriter/DEVELOPMENT.md.
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
			// The encoding is injective, since `_` appears in no Essence name.
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
			// A member name is not escaped, so the read matches the key as
			// written. Both positions use the string form instead.
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
			// A Program with no such name emits its names unmangled.
			let generated = generate(`implementation {
				constant value = 5

				Terminal.inspect(value)
			}`)

			expect(generated).toContain("const value = ")
			expect(generated).not.toContain("$user_")
		})
	})

	// `BigInt` reads `"0xFF"` as 255 and throws on `"FF"`. The Lexer already
	// refuses such a Literal, so this is a second guard against a silent wrong
	// value or a throw with no source location.
	describe("A Number Literal that is not decimal digits", () => {
		function emitInteger(value: string): string {
			let program = {
				nodeType: "Program",
				tests: null,
				coverage: null,
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
			expect(emitInteger("0xFF")).toContain("Integer.createInteger(0)")
		})

		it("does not throw on a digit string with no digits", () => {
			expect(emitInteger("FF")).toContain("Integer.createInteger(0)")
		})

		it("leaves a well-formed Literal byte-identical", () => {
			expect(emitInteger("42")).toContain("Integer.createInteger(42)")
		})
	})
})
