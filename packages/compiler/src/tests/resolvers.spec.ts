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

// NOTE: What the Enricher's name resolution answers — the Scope walks in
// `resolvers.ts`. Several of the faults below were invisible to every stage
// before the emitted Program RAN (a specifier resolved to a Namespace the
// emitted code can not reach, a payload compared without its witness), so those
// are pinned by running one rather than by asserting on Types.

function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrich(parse(source)).diagnostics
}

function codesFor(source: string): Array<string> {
	return diagnosticsFor(source).map((diagnostic) => diagnostic.code)
}

// NOTE: The JavaScript a clean Program compiles to. Read directly where the
// question is what the emitted call SAYS — a witness that never reaches a
// hidden conformance Parameter is a missing Argument, and the text is where an
// Argument is either there or not.
function emitted(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(enriched.diagnostics).toEqual([])
	expect(validate(enriched.program)).toEqual([])

	return rewrite(optimise(simplify(enriched.program)))
}

// NOTE: Emits the Program, writes it to a throwaway module and imports it so
// its top-level `Terminal.inspect` calls run — the same harness `codeGeneration.spec.ts`
// uses, because the same faults only show up in what the Program prints.
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

// NOTE: The names a JavaScript object carries whether anyone declared them or
// not. A Scope map indexed plainly answers with `Object.prototype`'s function
// for every one of them, so each has to be checked rather than `toString`
// standing in for the family.
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

	// NOTE: A Namespace's own name is in Scope inside every body it holds, which
	// is what the emitted `class` says too — its binding is in scope in its own
	// static initialisers, and its Methods are installed before any of them run.
	// A static Property's value was the one body that could not see it: it is
	// enriched while the Namespace Type is still being built, so `Reader.base`
	// inside `namespace Reader` reported `unknown-name` where the identical
	// spelling outside resolved.
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
		// NOTE: The shadow is the whole point — the specifier used to walk past
		// the Constant to the Namespace outside, so the call type-checked
		// against a Namespace the emitted `Greeter.greet(…)` could not reach and
		// crashed at runtime with `5.greet is not a function`.
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
			// NOTE: The control the fault was measured against — the same call
			// WITHOUT the specifier was always rejected, and stays rejected.
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

		// NOTE: The control — one solve, below a second conforming Namespace
		// declared into the same body, is ambiguous.
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

		// NOTE: And the fault: an EARLIER solve in the same Scope used to leave
		// a memoised witness behind that the later one reused, so the Namespace
		// declared in between was silently ignored and the Program compiled.
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

	// NOTE: A conditional conformance bounds the Methods that fulfil it, and
	// hoisting is what puts the Namespace Type into Scope. Until the bounds were
	// woven while it hoisted, WHERE a use site sat decided which Type it solved
	// against: one above the Namespace's Statement saw unbounded Methods and
	// emitted calls that curried no witness, one below saw the bounded ones.
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

		// NOTE: `compare` can not fulfil `Rankable` unconditionally AND carry
		// the `Comparable` clause's bound — the Method the Protocol promises
		// takes no witness. Both orders have to say so; the "above" one used to
		// compile clean and die with `Item__conformance` undefined.
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

		// NOTE: The Protocol is declared BELOW the Namespace here, so the
		// Namespace can not be checked in the hoist round that reaches it first
		// — it defers to the next one rather than hoisting a Type whose Methods
		// have lost their bound.
		it("should weave the bound when the Protocol hoists after the Namespace", async () => {
			expect(await run(sortable(true))).toEqual(['"Less"', '"Greater"'])
		})

		it("should weave it for a use site above the Namespace too", async () => {
			expect(await run(sortable(false))).toEqual(['"Less"', '"Greater"'])
		})

		it("should curry the Item witness onto the call above the Namespace", () => {
			// NOTE: The witness is a constant — a map of Method references, the
			// same one at every site — so `pool-constants` declares it once and
			// the call reads it by name. What it is a witness FOR is the
			// question here, so the map itself is read out of the band.
			let generated = emitted(sortable(false))

			expect(generated).toMatch(/Boxes\.rank\(a, b, \$pool_\d+\)/)
			expect(generated).toMatch(
				/const \$pool_\d+ = \{ compare: Integer\.compare \}/,
			)
		})
	})

	// NOTE: An empty List Literal's item Type is Unknown, and `List<ItemType>`
	// accepts a `List<Unknown>` receiver without binding `ItemType` to anything.
	// The `where ItemType is Comparable` condition then had no Type to solve, and
	// was silently dropped: the emitted call handed the fulfilling Method a plain
	// method map where it expects a curried one. Programs that got away with it
	// are rejected now — there is no witness to emit for a Type nothing has
	// pinned down yet.
	describe("Witness conditions over an unpinned item Type", () => {
		it("should report sorting a List of empty Lists", () => {
			let diagnostics = diagnosticsFor(`implementation {
				Terminal.inspect([[], []]::sort())
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe(
				"unsatisfied-conformance-condition",
			)
			expect(diagnostics[0].notes).toContain(
				"Its 'ItemType' is not determined here — an empty List Literal leaves the item Type unknown until something pins it down.",
			)
		})

		it("should report searching one by value", () => {
			expect(
				codesFor(`implementation {
					Terminal.inspect([[], []]::contains([]))
				}`),
			).toEqual(["unsatisfied-conformance-condition"])
		})

		// NOTE: This one used to compile clean and die reading `compare` off
		// `undefined` — the items the Program actually sorted were Lists of
		// Integers whose witness was never curried. The assignment now DECIDES
		// the Variable's item Type, so the receiver is a List of Lists of
		// Integers by the time the witness is solved and there is nothing left
		// unpinned to report.
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

	// NOTE: An application is the only place a Generic Alias' bound can be
	// checked — the body is substituted and gone by the time anything else looks
	// at it, so `Ranked<Function>` used to hand a Type with no ordering to a
	// member declared Comparable and be found out at the call that reached for
	// the witness, if at all.
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

		// NOTE: Every Alias the standard library declares is unbounded, and the
		// bound check has to cost them nothing — `resolveConformances` answers
		// before it looks at a single Argument when no Generic carries a bound.
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

		// NOTE: `is` reads the same inside a `case #First` as outside it — the
		// receiver's Type Arguments pin the Parameters its narrowed Type no
		// longer mentions, instead of being reported as uninferable. Both sides
		// are the narrowed `@` on purpose: a whole-Choice Argument would mention
		// every Parameter and bind them by itself, which is what hid this.
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

		// NOTE: The pinned Parameter is a Type Parameter of the enclosing
		// Function here, not a Type — pinning it hands the enclosing bound's own
		// witness down, exactly as inferring it did.
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

		// NOTE: Every Record value carries the runtime tag "Record", so the
		// concrete `{ code: Integer }` arm used to claim the Parameter's values
		// too and compare them structurally — the custom witness the conformance
		// solve selected was silently skipped.
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

		// NOTE: "List" is the other tag a whole family of Types shares — the same
		// collision, and the same answer.
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

		// NOTE: A Parameter bound to a Type of another KIND leaves the concrete
		// arm claiming, so a Record payload still compares structurally and a
		// String one still goes through the witness.
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

		// NOTE: The other half of the collision, and the one a dropped arm gets
		// wrong: a `{ code = 3 }` is a value of the arm as DECLARED, and sending
		// it to the Parameter's witness — written for a Named — read a `name` off
		// a Record that has none and died in `lowercase`. Both arms have to
		// keep claiming, each the values whose SHAPE fits it.
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

		// NOTE: The same two directions for the "List" tag — a shape is not a
		// Record's members, it is whatever `isValueOfType` checks, and for a
		// List that is the items it holds.
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

		// NOTE: Two concrete arms sharing the tag with the Parameter — each is
		// told apart by its own shape, and a value of one is never a value of
		// the other.
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

		// NOTE: A shape only tells arms apart when the shapes differ — the
		// member NAMES are not the whole of it, the member Types decide too.
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

		// NOTE: The genuinely ambiguous Union — the Argument IS the arm, so no
		// runtime check can tell the two apart. The witness wins, and this
		// Namespace calls every Code equal to prove which of the two answered.
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

		// NOTE: Record shapes are OPEN — a `{ code: Integer }` arm accepts a
		// `{ code = 1, name = "A" }` too — so an Argument that REFINES the arm
		// takes a shape of its own and is ordered ahead of it. Written with the
		// concrete arm FIRST, so declaration order can not be what saves it.
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

	// NOTE: Checked refinements have no syntax yet, so the receiver is built
	// directly and asked of the standard library's own Namespaces — which is what
	// makes these about resolution rather than about a Declaration.
	//
	// NOTE: There are two halves and both are load-bearing. A refined receiver
	// has to keep every Method its base had, or refining a Type would take its
	// Methods away; and a Namespace written FOR the refinement has to be found,
	// or refining one would buy nothing. The index buckets Namespaces by the kind
	// they target, so a refinement that pulled only its own bucket would be a
	// value with no Methods at all.
	describe("Refined receivers", () => {
		const integer: common.Type = { type: "Integer" }

		const nonZeroInteger: common.Type = {
			type: "Refinement",
			name: "NonZeroInteger",
			base: integer,
			conjuncts: [
				{
					namespaceName: "Integer",
					methodName: "isNot",
					overloadIndex: null,
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

			// NOTE: `Integer` out of the kind bucket the base is filed under,
			// and `Number` out of the blanket one every lookup pays for — its
			// target is the Union, which takes a refined Integer through the
			// same widening rule.
			expect(base).toEqual(["Integer", "Number"])

			// NOTE: Evidence ADDS and never takes away, so every Namespace the
			// base is answered by answers here too — asserted as inclusion
			// rather than as equality, because the standard library declares one
			// FOR this refinement and that one is the difference.
			expect(base.every((name) => refined.includes(name))).toBe(true)
			expect(refined).toEqual(["Integer", "NonZeroInteger", "Number"])
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

			// NOTE: And not the other way round — a bare Integer has proven
			// nothing, so the Namespace that promises more than Integer can does
			// not answer for it.
			expect([
				...namespacesTargeting(namespaces, integer).keys(),
			]).not.toContain("NonZeroInteger")
		})

		// NOTE: The same two halves over a GENERIC refinement, and this one needs
		// no receiver built by hand: `NonEmptyList<String>` is a Type the standard
		// library declares and a Namespace it declares a Namespace for. The
		// asymmetry is the whole of what the refinement buys — a List someone
		// PROVED has something in it reaches the total `firstItem`, and a List
		// nothing proved anything about reaches only the one answering an Optional.
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
						methodName: "hasItems",
						overloadIndex: null,
						args: [],
					},
				],
			}

			let refined = [
				...namespacesTargeting(namespaces, nonEmptyStrings).keys(),
			]
			let base = [...namespacesTargeting(namespaces, strings).keys()]

			expect(base).toEqual(["List"])
			expect(refined).toEqual(["List", "NonEmptyList"])
		})

		// NOTE: Conformance is found through the same widening rule, which is why
		// nothing was written for it: `Integer is Comparable` covers every value a
		// `NonZeroInteger` can hold, so the witness the base declares is the
		// witness a refined value passes.
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
