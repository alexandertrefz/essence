import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich, topLevelScope } from "../enricher/index"
import { namespacesTargeting, solveConformance } from "../enricher/resolvers"
import { loadStdlib } from "../enricher/stdlib"
import { optimise } from "../optimiser/index"
import { parse, parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// What the Enricher's name resolution answers: the Scope walks in
// `resolvers.ts`. Some answers show only when the emitted Program runs, so
// those specs run one.

function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrich(parse(source)).diagnostics
}

function codesFor(source: string): Array<string> {
	return diagnosticsFor(source).map((diagnostic) => diagnostic.code)
}

// The JavaScript a clean Program compiles to, read where the question is
// whether the emitted call passes a witness.
function emitted(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(enriched.diagnostics).toEqual([])
	expect(validate(enriched.program)).toEqual([])

	return rewrite(optimise(simplify(enriched.program)))
}

// Emits the Program, writes it to a throwaway module and imports it, so its
// top-level `Terminal.inspect` calls run.
async function run(source: string): Promise<Array<string>> {
	let javascript = emitted(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-resolvers-"))
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

// The names every JavaScript object carries. A Scope map indexed plainly
// answers each with `Object.prototype`'s function, so each is checked.
const INHERITED_NAMES = [
	"toString",
	"valueOf",
	"constructor",
	"hasOwnProperty",
	"isPrototypeOf",
	"toLocaleString",
	"propertyIsEnumerable",
]

describe("Resolvers", () => {
	describe("Variable Lookup", () => {
		for (let name of INHERITED_NAMES) {
			it(`should report an undeclared '${name}'`, () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant x = ${name}
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("unknown-name")
				expect(diagnostics[0].message).toBe(`'${name}' is not declared`)
			})

			it(`should accept a Constant named '${name}'`, () => {
				expect(
					diagnosticsFor(`implementation {
						constant ${name} = 5

						Terminal.inspect(${name})
					}`),
				).toEqual([])
			})
		}

		it("should accept a Constant named after an inherited member in a nested Scope", () => {
			expect(
				diagnosticsFor(`implementation {
					function inner () -> Integer {
						constant valueOf = 3

						<- valueOf
					}

					Terminal.inspect(inner())
				}`),
			).toEqual([])
		})

		it("should still report a Variable declared twice", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant toString = 1
				constant toString = 2
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-variable")
		})

		it("should run a Program whose Constant is named after an inherited member", async () => {
			expect(
				await run(`implementation {
					constant toString = 5

					Terminal.inspect(toString)
				}`),
			).toEqual(["5"])
		})

		it("should read a Record member named after an inherited member", async () => {
			expect(
				await run(`implementation {
					constant record = { toString = "written" }

					Terminal.inspect(record.toString)
				}`),
			).toEqual(['"written"'])
		})

		it("should reject a Combination whose right hand side names a member the value lacks", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant record = { name = "x" }
				constant updated = { record with valueOf = 2 }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("partial-type-mismatch")
		})
	})

	// A Namespace's own name is in Scope inside every body it holds, a static
	// Property's value included, as in the emitted `class`.
	describe("A Namespace naming itself", () => {
		it("reads a static Property written above it", async () => {
			expect(
				await run(`implementation {
					namespace Reader {
						static base = 10
						static doubled = Reader.base::multiply(with 2)
					}

					Terminal.inspect(Reader.doubled)
				}`),
			).toEqual(["20"])
		})

		it("calls a Method of its own Namespace from a static Property", async () => {
			expect(
				await run(`implementation {
					namespace Reader {
						static doubled = Reader.computed()::multiply(with 2)

						static computed() -> Integer { <- 10 }
					}

					Terminal.inspect(Reader.doubled)
				}`),
			).toEqual(["20"])
		})

		it("reads its own static Property from a Method body", async () => {
			expect(
				await run(`implementation {
					namespace Reader for Integer {
						static base = 10

						scaled() -> Integer { <- Reader.base::multiply(with @) }
					}

					Terminal.inspect(2::scaled())
				}`),
			).toEqual(["20"])
		})

		it("names itself from a generic Namespace's static Property", async () => {
			expect(
				await run(`implementation {
					namespace Boxes<infer Item> for List<Item> {
						static empty = "none"
						static label = Boxes.empty

						first() -> Optional<Item> { <- @::firstItem() }
					}

					Terminal.inspect(Boxes.label)
				}`),
			).toEqual(['"none"'])
		})
	})

	describe("Namespace Specifiers", () => {
		// The Constant shadows the Namespace, so the specifier must not walk
		// past it to a Namespace the emitted call can not reach.
		it("should report a specifier shadowed by a Constant", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Greeter for String {
					greet () -> String {
						<- "hi"
					}
				}

				function shadowed () -> String {
					constant Greeter = 5

					<- "x"::<Greeter>greet()
				}

				Terminal.inspect(shadowed())
			}`)

			let specifier = diagnostics.find(
				(diagnostic) => diagnostic.code === "not-a-namespace",
			)

			expect(specifier).toBeDefined()
			expect(specifier?.message).toBe("'Greeter' is not a Namespace")
			expect(
				specifier?.labels.some(
					(label) => label.message === "declared here",
				),
			).toBe(true)
		})

		it("should report a specifier that names a Constant with no Namespace anywhere", () => {
			expect(
				codesFor(`implementation {
					constant Other = 5

					constant text = "x"::<Other>uppercase()
				}`),
			).toContain("not-a-namespace")
		})

		// The receiver is fine, so nothing is reported about its Namespaces.
		it("should report a specifier nothing declares where it is written", () => {
			let diagnostics = diagnosticsFor(`implementation {
				Terminal.print(5::<Nope>toString())
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unknown-name",
			])
			expect(diagnostics[0]?.message).toBe("'Nope' is not declared")
			expect(diagnostics[0]?.position?.start).toEqual({
				line: 2,
				column: 24,
			})
			expect(diagnostics[0]?.helps).toEqual([
				"Drop the Namespace specifier.",
			])
		})

		it("should offer the closest Namespace for a misspelled specifier", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Shout for Integer {
					loud() -> String {
						<- @::toString()::append("!")
					}
				}

				Terminal.print(5::<Shuot>loud())
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unknown-name",
			])
			expect(diagnostics[0]?.helps).toEqual([
				"Did you mean 'Shout'?",
				"Or drop the Namespace specifier.",
			])
			expect(diagnostics[0]?.data).toEqual({
				kind: "suggestion",
				suggestion: "Shout",
			})
		})

		// The control: a Protocol's name is a pick, and the call resolves.
		it("should report a specifier that names a Type", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Click = { x: Integer }

				Terminal.print(5::<Click>toString())
				Terminal.print("pear"::<Equatable>isNot("plum"))
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.labels[0]?.message,
				]),
			).toEqual([["not-a-namespace", "this names a Type"]])
		})

		// A Type Parameter's Methods come through its Protocol alone, but the
		// specifier is read all the same.
		it("should report a specifier on a Type Parameter receiver", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function bounded<infer T is Printable>(_ x: T) -> String {
					<- x::<Nope>toString()
				}

				function unbounded<infer T>(_ x: T) -> String {
					<- x::<Nope>toString()
				}

				function viaInteger<infer T is Printable>(_ x: T) -> String {
					<- x::<Integer>toString()
				}
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.notes,
				]),
			).toEqual([
				["unknown-name", []],
				["unknown-name", []],
				[
					"no-namespace-for-value",
					[
						"The specifier limits the lookup to 'Integer', which provides no 'toString' for T.",
					],
				],
			])
		})

		// The control: a Protocol pick on a bounded receiver reaches the
		// conformance.
		it("should keep a Protocol pick on a Type Parameter receiver", () => {
			expect(
				diagnosticsFor(`implementation {
					function differs<infer T is Equatable>(_ x: T, _ y: T) -> Boolean {
						<- x::<Equatable>isNot(y)
					}

					Terminal.inspect(differs(1, 2))
				}`),
			).toEqual([])
		})

		it("should keep resolving an unshadowed specifier", async () => {
			expect(
				await run(`implementation {
					namespace Greeter for String {
						greet () -> String {
							<- "hi"
						}
					}

					function greeting () -> String {
						<- "x"::<Greeter>greet()
					}

					Terminal.inspect(greeting())
				}`),
			).toEqual(['"hi"'])
		})

		it("should keep the specifier out of an unqualified call's way", () => {
			// The control: the same call without the specifier is rejected.
			expect(
				codesFor(`implementation {
					namespace Greeter for String {
						greet () -> String {
							<- "hi"
						}
					}

					function shadowed () -> String {
						constant Greeter = 5

						<- "x"::greet()
					}
				}`),
			).toContain("unknown-method")
		})
	})

	describe("Conformance Memoisation", () => {
		let tagged = (body: string) => `implementation {
			protocol Tag {
				tag () -> String
			}

			namespace IntTagA for Integer is Tag {
				tag () -> String {
					<- "A"
				}
			}

			function describeIt <infer T is Tag>(_ value: T) -> String {
				<- value::tag()
			}

			function ambiguously () -> String {
				${body}
			}

			Terminal.inspect(ambiguously())
		}`

		// The control: one solve, below a second conforming Namespace declared
		// in the same body, is ambiguous.
		it("should report the ambiguity a body-local Namespace creates", () => {
			expect(
				codesFor(
					tagged(`namespace IntTagB for Integer is Tag {
						tag () -> String {
							<- "B"
						}
					}

					<- describeIt(2)`),
				),
			).toEqual(["ambiguous-conformance"])
		})

		// An earlier solve in the same Scope must not leave a memoised witness
		// that hides the Namespace declared in between.
		it("should report it again after an earlier solve in the same Scope", () => {
			expect(
				codesFor(
					tagged(`constant first = describeIt(1)

					namespace IntTagB for Integer is Tag {
						tag () -> String {
							<- "B"
						}
					}

					constant second = describeIt(2)

					<- first::append(second)`),
				),
			).toEqual(["ambiguous-conformance"])
		})

		it("should keep answering a solve that nothing invalidated", async () => {
			expect(
				await run(
					tagged(`constant first = describeIt(1)
					constant second = describeIt(2)

					<- first::append(second)`),
				),
			).toEqual(['"AA"'])
		})
	})

	// A conditional conformance bounds the Methods that fulfil it, and the
	// bounds are woven while the Namespace hoists. Use sites before and after the
	// Namespace solve against the same Type.
	describe("Conditional Conformance and Declaration Order", () => {
		let boxes = (order: "above" | "below") => {
			let use = `function rankBoxes(
				_ a: { value: Integer },
				_ b: { value: Integer },
			) -> String {
				<- rank(a, b)
			}`

			let namespace = `namespace Boxes<infer Item> for { value: Item }
				is Rankable,
				is Comparable where Item is Comparable {
				compare(to other: { value: Item }) -> Ordering {
					<- @.value::compare(to other.value)
				}
			}`

			return `implementation {
				protocol Rankable {
					compare(to other: Self) -> Ordering
				}

				function rank<infer Item is Rankable>(_ a: Item, _ b: Item) -> String {
					<- a::compare(to b)::toString()
				}

				${order === "above" ? `${use}\n\n${namespace}` : `${namespace}\n\n${use}`}

				Terminal.inspect(rankBoxes({ value = 1 }, { value = 2 }))
			}`
		}

		// `compare` can not fulfil `Rankable` unconditionally and carry the
		// `Comparable` clause's bound, since the promised Method takes no witness.
		it("should reject an unconditional clause the bound Method can not fulfil", () => {
			expect(codesFor(boxes("above"))).toEqual([
				"nonconforming-namespace",
				"nonconforming-namespace",
			])
		})

		it("should reject it the same way from below the Namespace", () => {
			expect(codesFor(boxes("below"))).toEqual(codesFor(boxes("above")))
		})

		let sortable = (namespaceFirst: boolean) => {
			let use = `function rankBoxes(
				_ a: { value: Integer },
				_ b: { value: Integer },
			) -> String {
				<- a::rank(b)
			}`

			let namespace = `namespace Boxes<infer Item> for { value: Item }
				is Rankable where Item is Comparable {
				rank(_ other: { value: Item }) -> String {
					<- @.value::compare(to other.value)::toString()
				}
			}`

			return `implementation {
				${namespaceFirst ? `${namespace}\n\n${use}` : `${use}\n\n${namespace}`}

				protocol Rankable {
					rank(_ other: Self) -> String
				}

				Terminal.inspect(rankBoxes({ value = 1 }, { value = 2 }))
				Terminal.inspect(rankBoxes({ value = 5 }, { value = 2 }))
			}`
		}

		// The Protocol is declared after the Namespace, so the Namespace defers
		// to the next hoist round rather than losing its bound.
		it("should weave the bound when the Protocol hoists after the Namespace", async () => {
			expect(await run(sortable(true))).toEqual(['"Less"', '"Greater"'])
		})

		it("should weave it for a use site above the Namespace too", async () => {
			expect(await run(sortable(false))).toEqual(['"Less"', '"Greater"'])
		})

		it("should curry the Item witness onto the call above the Namespace", () => {
			// `pool-constants` declares the witness once and the call reads it
			// by name, so the pooled map is asserted separately.
			let generated = emitted(sortable(false))

			expect(generated).toMatch(/Boxes\.rank\(a, b, \$pool_\d+\)/)
			expect(generated).toMatch(
				/const \$pool_\d+ = \{\n\tcompare: Integer\.compare,\n/,
			)
		})
	})

	// An empty List Literal's item Type is Unknown, which binds no `ItemType`.
	// A `where ItemType is Comparable` condition then has no witness to emit,
	// so the call is refused.
	describe("Witness conditions over an unpinned item Type", () => {
		// The receiver is a `NonEmptyList<List<Unknown>>`, and both `List` and
		// `NonEmptyList` declare `sort`, so the undecided receiver is refused
		// first. The next spec reaches the witness condition.
		it("should report sorting a List of empty Lists", () => {
			let diagnostics = diagnosticsFor(`implementation {
				Terminal.inspect([[], []]::sort())
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("undecided-receiver-type")
			expect(diagnostics[0].helps).toContain(
				"Annotate what the receiver comes from — 'constant items: List<Integer> = []', for instance — so its Type is decided before the call.",
			)
		})

		it("should report searching one by value", () => {
			expect(
				codesFor(`implementation {
					Terminal.inspect([[], []]::contains([]))
				}`),
			).toEqual(["unsatisfied-conformance-condition"])
		})

		// The assignment decides the Variable's item Type, so the witness is
		// solved for Lists of Integers.
		it("should sort a Variable that was only assigned later", async () => {
			expect(
				await run(`implementation {
					variable items = []

					items = [1, 2]

					Terminal.inspect([items, items]::sort())
				}`),
			).toEqual(["[ [ 1, 2 ], [ 1, 2 ] ]"])
		})

		it("should keep sorting Lists one of which pins the item Type", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect([[], [1]]::sort())
				}`),
			).toEqual(["[ [], [ 1 ] ]"])
		})

		it("should keep sorting an annotated empty List", async () => {
			expect(
				await run(`implementation {
					constant items: List<Integer> = []

					Terminal.inspect([items, [1]]::sort())
				}`),
			).toEqual(["[ [], [ 1 ] ]"])
		})
	})

	// A Generic Alias' bound is checked where the Alias is applied, since its
	// body is substituted away afterwards.
	describe("Type Argument Bounds", () => {
		let ranked = `protocol Rankable {
			rank() -> Integer
		}

		type Ranked<T is Rankable> = { value: T }`

		it("should report a Type Argument that does not conform", () => {
			let diagnostics = diagnosticsFor(`implementation {
				${ranked}

				function take(_ ranked: Ranked<Integer>) -> Integer {
					<- ranked.value
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unsatisfied-bound")
			expect(diagnostics[0].message).toBe(
				"Integer does not conform to 'Rankable'",
			)
		})

		it("should report a bound carried by an unbounded Type Parameter", () => {
			expect(
				diagnosticsFor(`implementation {
					${ranked}

					function take<Item>(_ item: Item) -> Ranked<Item> {
						<- { value = item }
					}
				}`).map((diagnostic) => diagnostic.helps),
			).toEqual([["Declare it as '<infer Item is Rankable>'."]])
		})

		it("should accept a Type Argument a Namespace makes conform", async () => {
			expect(
				await run(`implementation {
					${ranked}

					namespace IntegerRank for Integer is Rankable {
						rank() -> Integer {
							<- @
						}
					}

					constant one: Ranked<Integer> = { value = 7 }

					Terminal.inspect(one.value::rank())
				}`),
			).toEqual(["7"])
		})

		// When no Generic carries a bound, `resolveConformances` answers before
		// it looks at any Argument.
		it("should leave an unbounded Alias applying to anything", () => {
			expect(
				diagnosticsFor(`implementation {
					type Held<T> = { value: T }

					constant held: Held<(_ x: Integer) -> Integer> = {
						value = (_ x: Integer) -> Integer { <- x }
					}

					Terminal.inspect(held.value(1))
				}`),
			).toEqual([])
		})
	})

	describe("Derived Equality of a generic Choice", () => {
		let pace = `choice Pace<A, B> {
			First { a: A },
			Second { b: B }
		}`

		// The receiver's Type Arguments pin the Parameters its narrowed Type no
		// longer mentions. Both sides are the narrowed `@`, since a whole-Choice
		// Argument would bind every Parameter by itself.
		it("should compare a receiver narrowed to one Case", async () => {
			expect(
				await run(`implementation {
					${pace}

					constant first: Pace<Integer, String> = #First({ a = 1 })

					match first -> {} {
						case #First {
							Terminal.inspect(@::is(@))
							Terminal.inspect(@::isNot(@))

							<- {}
						}
						case #Second {
							<- {}
						}
					}
				}`),
			).toEqual(["true", "false"])
		})

		it("should report no diagnostic for a narrowed receiver of the Case that mentions no Parameter", () => {
			expect(
				diagnosticsFor(`implementation {
					choice Signal<Payload> {
						Ping,
						Pong { payload: Payload }
					}

					constant signal: Signal<Integer> = #Ping

					match signal -> {} {
						case #Ping {
							Terminal.inspect(@::is(@))

							<- {}
						}
						case #Pong {
							<- {}
						}
					}
				}`),
			).toEqual([])
		})

		it("should answer false for a narrowed receiver against another Case", async () => {
			expect(
				await run(`implementation {
					${pace}

					constant first: Pace<Integer, String> = #First({ a = 1 })
					constant second: Pace<Integer, String> = #Second({ b = "s" })

					match first -> {} {
						case #First {
							Terminal.inspect(@::is(second))

							<- {}
						}
						case #Second {
							<- {}
						}
					}
				}`),
			).toEqual(["false"])
		})

		// The pinned Parameter is the enclosing Function's Type Parameter, so
		// pinning it hands down that bound's witness.
		it("should compare a narrowed receiver inside a bounded Function", async () => {
			expect(
				await run(`implementation {
					${pace}

					function compareNarrowed <infer T is Equatable>(_ value: Pace<T, String>) -> Boolean {
						<- match value -> Boolean {
							case #First {
								<- @::is(@)
							}
							case #Second {
								<- @::is(@)
							}
						}
					}

					constant value: Pace<Integer, String> = #First({ a = 1 })

					Terminal.inspect(compareNarrowed(value))
				}`),
			).toEqual(["true"])
		})

		it("should keep comparing unnarrowed receivers", async () => {
			expect(
				await run(`implementation {
					${pace}

					constant first: Pace<Integer, String> = #First({ a = 1 })
					constant same: Pace<Integer, String> = #First({ a = 1 })
					constant other: Pace<Integer, String> = #First({ a = 2 })

					Terminal.inspect(first::is(same))
					Terminal.inspect(first::is(other))
				}`),
			).toEqual(["true", "false"])
		})
	})

	describe("Derived Equality of a Union payload", () => {
		let named = `type Named = { name: String }

			namespace NamedEquality for Named is Equatable {
				is (_ other: Named) -> Boolean {
					<- @.name::lowercase()::is(other.name::lowercase())
				}

				isNot (_ other: Named) -> Boolean {
					<- @::is(other)::negate()
				}
			}

			choice Wrapper<T> {
				Val { v: T | { code: Integer } }
			}`

		// Every Record value carries the runtime tag "Record", so the concrete
		// `{ code: Integer }` arm must not claim the Parameter's values.
		it("should compare a Parameter's values through their witness", async () => {
			expect(
				await run(`implementation {
					${named}

					constant lhs: Named = { name = "A" }
					constant rhs: Named = { name = "a" }

					constant wrapped: Wrapper<Named> = #Val({ v = lhs })
					constant otherWrapped: Wrapper<Named> = #Val({ v = rhs })

					Terminal.inspect(lhs::is(rhs))
					Terminal.inspect(wrapped::is(otherWrapped))
				}`),
			).toEqual(["true", "true"])
		})

		// "List" is the other tag a whole family of Types shares.
		it("should compare a Parameter bound to a List through its witness", async () => {
			expect(
				await run(`implementation {
					type Named = { name: String }

					namespace NamedEquality for Named is Equatable {
						is (_ other: Named) -> Boolean {
							<- @.name::lowercase()::is(other.name::lowercase())
						}

						isNot (_ other: Named) -> Boolean {
							<- @::is(other)::negate()
						}
					}

					choice Boxed<T> {
						Val { v: T | List<Integer> }
					}

					constant lhs: List<Named> = [{ name = "A" }]
					constant rhs: List<Named> = [{ name = "a" }]

					constant wrapped: Boxed<List<Named>> = #Val({ v = lhs })
					constant otherWrapped: Boxed<List<Named>> = #Val({ v = rhs })

					Terminal.inspect(lhs::is(rhs))
					Terminal.inspect(wrapped::is(otherWrapped))
				}`),
			).toEqual(["true", "true"])
		})

		// A Parameter bound to a Type of another kind leaves the concrete arm
		// claiming its Records.
		it("should keep a concrete arm that no Parameter collides with", async () => {
			expect(
				await run(`implementation {
					choice Wrapper<T> {
						Val { v: T | { code: Integer } }
					}

					constant text: Wrapper<String> = #Val({ v = "x" })
					constant sameText: Wrapper<String> = #Val({ v = "x" })
					constant code: Wrapper<String> = #Val({ v = { code = 1 } })
					constant sameCode: Wrapper<String> = #Val({ v = { code = 1 } })
					constant otherCode: Wrapper<String> = #Val({ v = { code = 2 } })

					Terminal.inspect(text::is(sameText))
					Terminal.inspect(code::is(sameCode))
					Terminal.inspect(code::is(otherCode))
					Terminal.inspect(text::is(code))
				}`),
			).toEqual(["true", "true", "false", "false"])
		})

		// A `{ code = 3 }` is a value of the declared arm, not of the
		// Parameter's witness. Each arm claims the values whose shape fits it.
		it("should compare the colliding arm's own values structurally", async () => {
			expect(
				await run(`implementation {
					${named}

					constant a: Wrapper<Named> = #Val({ v = { name = "A" } })
					constant b: Wrapper<Named> = #Val({ v = { name = "a" } })
					constant c: Wrapper<Named> = #Val({ v = { name = "different" } })
					constant d: Wrapper<Named> = #Val({ v = { code = 3 } })
					constant e: Wrapper<Named> = #Val({ v = { code = 3 } })
					constant f: Wrapper<Named> = #Val({ v = { code = 4 } })

					Terminal.inspect(a::is(b))
					Terminal.inspect(a::is(c))
					Terminal.inspect(a::is(d))
					Terminal.inspect(d::is(e))
					Terminal.inspect(d::is(f))
				}`),
			).toEqual(["true", "false", "false", "true", "false"])
		})

		// For a List the shape `isValueOfType` checks is the items it holds.
		it("should tell a colliding List arm apart by its items", async () => {
			expect(
				await run(`implementation {
					type Named = { name: String }

					namespace NamedEquality for Named is Equatable {
						is (_ other: Named) -> Boolean {
							<- @.name::lowercase()::is(other.name::lowercase())
						}

						isNot (_ other: Named) -> Boolean {
							<- @::is(other)::negate()
						}
					}

					choice Boxed<T> {
						Val { v: List<T> | List<Integer> }
					}

					constant named: Boxed<Named> = #Val({ v = [{ name = "A" }] })
					constant sameNamed: Boxed<Named> = #Val({ v = [{ name = "a" }] })
					constant numbers: Boxed<Named> = #Val({ v = [1, 2] })
					constant sameNumbers: Boxed<Named> = #Val({ v = [1, 2] })

					Terminal.inspect(named::is(sameNamed))
					Terminal.inspect(numbers::is(sameNumbers))
					Terminal.inspect(named::is(numbers))
				}`),
			).toEqual(["true", "true", "false"])
		})

		// Two concrete arms sharing the tag with the Parameter are each told
		// apart by their shape.
		it("should tell several colliding arms apart by their shapes", async () => {
			expect(
				await run(`implementation {
					type Named = { name: String }

					namespace NamedEquality for Named is Equatable {
						is (_ other: Named) -> Boolean {
							<- @.name::lowercase()::is(other.name::lowercase())
						}

						isNot (_ other: Named) -> Boolean {
							<- @::is(other)::negate()
						}
					}

					choice Wrapper<T> {
						Val { v: T | { code: Integer } | { flag: Boolean } }
					}

					constant named: Wrapper<Named> = #Val({ v = { name = "A" } })
					constant sameNamed: Wrapper<Named> = #Val({ v = { name = "a" } })
					constant code: Wrapper<Named> = #Val({ v = { code = 3 } })
					constant sameCode: Wrapper<Named> = #Val({ v = { code = 3 } })
					constant flag: Wrapper<Named> = #Val({ v = { flag = true } })

					Terminal.inspect(named::is(sameNamed))
					Terminal.inspect(code::is(sameCode))
					Terminal.inspect(flag::is(code))
					Terminal.inspect(flag::is(named))
				}`),
			).toEqual(["true", "true", "false", "false"])
		})

		// Member Types tell shapes apart as well as member names.
		it("should tell a colliding arm apart by its member Types", async () => {
			expect(
				await run(`implementation {
					type Coded = { code: String }

					namespace CodedEquality for Coded is Equatable {
						is (_ other: Coded) -> Boolean {
							<- @.code::lowercase()::is(other.code::lowercase())
						}

						isNot (_ other: Coded) -> Boolean {
							<- @::is(other)::negate()
						}
					}

					choice Wrapper<T> {
						Val { v: T | { code: Integer } }
					}

					constant text: Wrapper<Coded> = #Val({ v = { code = "A" } })
					constant sameText: Wrapper<Coded> = #Val({ v = { code = "a" } })
					constant number: Wrapper<Coded> = #Val({ v = { code = 1 } })
					constant sameNumber: Wrapper<Coded> = #Val({ v = { code = 1 } })

					Terminal.inspect(text::is(sameText))
					Terminal.inspect(number::is(sameNumber))
					Terminal.inspect(text::is(number))
				}`),
			).toEqual(["true", "true", "false"])
		})

		// Where the Argument is the arm, no runtime check tells them apart and
		// the witness wins. This one calls every Code equal, to show it answered.
		it("should give an exactly overlapping arm to the witness", async () => {
			expect(
				await run(`implementation {
					type Code = { code: Integer }

					namespace CodeEquality for Code is Equatable {
						is (_ other: Code) -> Boolean {
							<- true
						}

						isNot (_ other: Code) -> Boolean {
							<- false
						}
					}

					choice Wrapper<T> {
						Val { v: T | { code: Integer } }
					}

					constant one: Wrapper<Code> = #Val({ v = { code = 1 } })
					constant two: Wrapper<Code> = #Val({ v = { code = 2 } })

					Terminal.inspect(one::is(two))
				}`),
			).toEqual(["true"])
		})

		// Record shapes are open, so an Argument that refines the arm is
		// ordered ahead of it. The concrete arm is written first on purpose.
		it("should let a refining Type Argument claim before the arm it refines", async () => {
			expect(
				await run(`implementation {
					type Tagged = { code: Integer, name: String }

					namespace TaggedEquality for Tagged is Equatable {
						is (_ other: Tagged) -> Boolean {
							<- @.name::lowercase()::is(other.name::lowercase())
						}

						isNot (_ other: Tagged) -> Boolean {
							<- @::is(other)::negate()
						}
					}

					choice Wrapper<T> {
						Val { v: { code: Integer } | T }
					}

					constant tagged: Wrapper<Tagged> = #Val({ v = { code = 1, name = "A" } })
					constant sameTagged: Wrapper<Tagged> = #Val({ v = { code = 2, name = "a" } })
					constant code: Wrapper<Tagged> = #Val({ v = { code = 1 } })
					constant sameCode: Wrapper<Tagged> = #Val({ v = { code = 1 } })
					constant otherCode: Wrapper<Tagged> = #Val({ v = { code = 2 } })

					Terminal.inspect(tagged::is(sameTagged))
					Terminal.inspect(code::is(sameCode))
					Terminal.inspect(code::is(otherCode))
					Terminal.inspect(tagged::is(code))
				}`),
			).toEqual(["true", "true", "false", "false"])
		})
	})

	// A receiver built by hand, asked of the standard library's Namespaces. A
	// refined receiver keeps every Method its base had and also finds the
	// Namespaces written for the refinement.
	describe("Refined receivers", () => {
		const integer: common.Type = { type: "Integer" }

		// The conjunct is spelled as `Integer.es` spells `NonZeroInteger`'s. A
		// conjunct spelled any other way is a different refinement.
		const nonZeroInteger: common.Type = {
			type: "Refinement",
			name: "NonZeroInteger",
			base: integer,
			conjuncts: [
				{
					namespaceName: "Integer",
					methodName: "is",
					negated: true,
					args: ["0"],
				},
			],
		}

		const position: common.Position = {
			start: { line: 1, column: 1 },
			end: { line: 1, column: 1 },
		}

		function stdlibNamespaces(): Map<string, common.NamespaceType> {
			let namespaces: Map<string, common.NamespaceType> = new Map()

			for (let namespace of loadStdlib().namespaces) {
				namespaces.set(namespace.name, namespace)
			}

			return namespaces
		}

		it("should offer a refined receiver every Namespace its base has", () => {
			let namespaces = stdlibNamespaces()

			let refined = [
				...namespacesTargeting(namespaces, nonZeroInteger).keys(),
			]
			let base = [...namespacesTargeting(namespaces, integer).keys()]

			// `Integer` from the base's kind bucket, and `Scalar` and `Number`
			// from the blanket one, as Unions an Integer is a member of.
			expect(base).toEqual(["Integer", "Scalar", "Number"])

			// Evidence only adds, so every Namespace of the base answers here
			// too, plus the one declared for the refinement.
			expect(base.every((name) => refined.includes(name))).toBe(true)
			expect(refined).toEqual([
				"Integer",
				"NonZeroInteger",
				"Scalar",
				"Number",
			])
		})

		it("should find a Namespace written for the refinement itself", () => {
			let namespaces = stdlibNamespaces()

			namespaces.set("NonZeroInteger", {
				type: "Namespace",
				name: "NonZeroInteger",
				targetType: nonZeroInteger,
				generics: [],
				properties: {},
				methods: {},
			})

			expect([
				...namespacesTargeting(namespaces, nonZeroInteger).keys(),
			]).toContain("NonZeroInteger")

			// A bare Integer has proven nothing, so the refinement's Namespace
			// does not answer for it.
			expect([
				...namespacesTargeting(namespaces, integer).keys(),
			]).not.toContain("NonZeroInteger")
		})

		// The same over a generic refinement the standard library declares. A
		// proven non-empty List reaches the total `firstItem`, and a plain List
		// only the one answering an Optional.
		it("should offer a refined List its own Namespace and the base's", () => {
			let namespaces = stdlibNamespaces()
			let strings: common.Type = {
				type: "List",
				itemType: { type: "String" },
			}
			let nonEmptyStrings: common.Type = {
				type: "Refinement",
				name: "NonEmptyList",
				base: strings,
				typeArguments: [{ type: "String" }],
				conjuncts: [
					{
						namespaceName: "List",
						methodName: "isEmpty",
						negated: true,
						args: [],
					},
				],
			}

			let refined = [
				...namespacesTargeting(namespaces, nonEmptyStrings).keys(),
			]
			let base = [...namespacesTargeting(namespaces, strings).keys()]

			// `KeyedNumberList` and `GroupedList` target every List.
			// `NonEmptyKeyedNumberList` and `GroupedNonEmptyList` target every
			// proven List, so they join only the refined half.
			expect(base).toEqual(["List", "KeyedNumberList", "GroupedList"])
			expect(refined).toEqual([
				"List",
				"NonEmptyList",
				"KeyedNumberList",
				"NonEmptyKeyedNumberList",
				"GroupedList",
				"GroupedNonEmptyList",
			])
		})

		// Conformance is found through the same widening rule, so a refined
		// value passes the witness its base declares.
		it("should solve a Protocol conformance through the base's Namespace", () => {
			let solved = solveConformance(
				nonZeroInteger,
				"Comparable",
				topLevelScope(),
				position,
			)

			expect(solved.ok).toBe(true)
			expect(solved.ok && solved.source).toMatchObject({
				kind: "namespace",
				name: "Integer",
			})
		})
	})
})
