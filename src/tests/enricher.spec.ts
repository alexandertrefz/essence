import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher/index"
import type { common } from "../interfaces/index"
import { parse } from "../parser/index"

function enrichSource(source: string): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} {
	return enrich(parse(source))
}

function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrichSource(source).diagnostics
}

describe("Enricher", () => {
	describe("Diagnostics", () => {
		it("should report no Diagnostics for a valid Program", () => {
			expect(
				diagnosticsFor(`implementation {
					constant name = "essence"
					__print(name)
				}`),
			).toEqual([])
		})

		it("should report undeclared Variables", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = undeclaredVariable
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"Variable 'undeclaredVariable' is not declared.",
			)
			expect(diagnostics[0].position?.start.line).toBe(2)
		})

		it("should report undeclared Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a: UndeclaredType = "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'UndeclaredType' is not declared.",
			)
		})

		it("should report redeclared Variables", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "first"
				constant a = "second"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Variable 'a' is already declared.",
			)
			expect(diagnostics[0].position?.start.line).toBe(3)
		})

		it("should report redeclared Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Name = String
				type Name = Boolean
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Name' is already declared.",
			)
		})

		it("should report Method Invocations without a matching Namespace method", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"::undeclaredMethod()
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Could not find a method named 'undeclaredMethod' in the Namespaces matching this value.",
			)
		})

		it("should report Method Invocations whose arguments match no overload", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"::prepend()
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Passed arguments do not match any overload.",
			)
		})

		it("should accept Method Invocations with matching argument labels", () => {
			expect(
				diagnosticsFor(`implementation {
					constant a = [1]::append(contentsOf [2])
				}`),
			).toEqual([])
		})

		it("should report Method Invocations with wrong argument labels", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = [1]::append(wrongLabel [2])
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Passed arguments do not match any overload.",
			)
		})

		it("should report Combinations of non-Record Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = { "value" with name = "x" }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("You can not combine Strings.")
		})

		it("should report Combinations whose right hand side is not a Partial", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = { name = "x" }
				constant b = { age = 5 }
				constant c = { a with b }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"The right hand side Type must be a Partial of the left hand side Type.",
			)
		})

		it("should report non-Record Type Annotations on Record Literals", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = String ~> { name = "x" }
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("Type Annotations for Records must be Record Types.")
		})

		it("should report @-Expressions outside of Methods", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = @
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"@-Expressions can not be used outside of Methods and Match Expressions.",
			)
		})

		it("should report Lookups on Types without members", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"
				constant b = a.member
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Only Records and Namespaces have members.",
			)
		})

		it("should report missing Record members", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = { name = "x" }
				constant b = a.age
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"This Record has no member 'age'.",
			)
		})

		it("should report all independent errors of a Program", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = undeclaredVariable
				constant b: UndeclaredType = "value"
				constant c = "value"::undeclaredMethod()
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				[
					"Variable 'undeclaredVariable' is not declared.",
					"Type 'UndeclaredType' is not declared.",
					"Could not find a method named 'undeclaredMethod' in the Namespaces matching this value.",
				],
			)
		})

		it("should not report follow-up errors on Error Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = undeclaredVariable
				constant b = a::someMethod()
				constant c = a.someMember
				constant d = { a with name = "x" }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Variable 'undeclaredVariable' is not declared.",
			)
		})

		it("should still enrich statements after a broken statement", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant a = undeclaredVariable
				constant b = "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(program.implementation.nodes).toHaveLength(2)
		})
	})

	describe("Constant Reassignment", () => {
		it("should allow reassigning Variables", () => {
			expect(
				diagnosticsFor(`implementation {
					variable a = "first"
					a = "second"
				}`),
			).toEqual([])
		})

		it("should report reassigned Constants", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "first"
				a = "second"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Constant 'a' can not be reassigned.",
			)
			expect(diagnostics[0].position?.start.line).toBe(3)
		})

		it("should report reassigned Functions", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function getName () -> String {
					<- "essence"
				}

				getName = "value"
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("Constant 'getName' can not be reassigned.")
		})

		it("should report reassigned Parameters", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function greet (_ name: String) -> String {
					name = "other"
					<- name
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Constant 'name' can not be reassigned.",
			)
		})

		it("should allow reassigning outer Variables from inner scopes", () => {
			expect(
				diagnosticsFor(`implementation {
					variable a = "first"

					if true {
						a = "second"
					}
				}`),
			).toEqual([])
		})
	})

	describe("Declaration Hoisting", () => {
		it("should allow using Functions before their declaration", () => {
			expect(
				diagnosticsFor(`implementation {
					constant greeting = getGreeting()

					function getGreeting () -> String {
						<- "hello"
					}
				}`),
			).toEqual([])
		})

		it("should allow mutually recursive Functions", () => {
			expect(
				diagnosticsFor(`implementation {
					function isEven (_ value: Integer) -> Boolean {
						if value::is(0) {
							<- true
						}

						<- isOdd(value::subtract(1))
					}

					function isOdd (_ value: Integer) -> Boolean {
						if value::is(0) {
							<- false
						}

						<- isEven(value::subtract(1))
					}

					__print(isEven(4))
				}`),
			).toEqual([])
		})

		it("should allow using Type Aliases before their declaration", () => {
			expect(
				diagnosticsFor(`implementation {
					type Names = List<Name>
					type Name = String

					constant names: Names = ["essence"]
				}`),
			).toEqual([])
		})

		it("should allow Namespaces before their target Type Alias", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Person for Person {
						createWith (_ name: String) -> Person {
							<- { name = name }
						}
					}

					type Person = { name: String }

					constant person = Person.createWith("essence")
				}`),
			).toEqual([])
		})

		it("should not hoist Constants", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = b
				constant b = "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("Variable 'b' is not declared.")
		})

		it("should leave Namespaces referencing later Variables to in-order enrichment", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Config {
					static defaultName () -> String {
						<- fallbackName
					}
				}

				constant fallbackName = "essence"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Variable 'fallbackName' is not declared.",
			)
		})

		it("should still report duplicate hoisted declarations", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Name = String
				type Name = Boolean
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Name' is already declared.",
			)
			expect(diagnostics[0].position?.start.line).toBe(3)
		})
	})

	describe("Generic Inference", () => {
		function typeOfFirstConstant(source: string): common.Type {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			for (let node of program.implementation.nodes) {
				if (node.nodeType === "ConstantDeclarationStatement") {
					return node.type
				}
			}

			throw new Error("No ConstantDeclarationStatement found.")
		}

		it("should infer List item Types through Method Invocations", () => {
			expect(
				typeOfFirstConstant(`implementation {
					constant first = [1, 2]::firstItem()
				}`),
			).toEqual({
				type: "UnionType",
				types: [{ type: "Integer" }, { type: "Nothing" }],
			})
		})

		it("should substitute the receiver's item Type into List returns", () => {
			expect(
				typeOfFirstConstant(`implementation {
					constant shorter = ["a", "b"]::removeFirst()
				}`),
			).toEqual({ type: "List", itemType: { type: "String" } })
		})

		it("should infer Namespace Generics from the receiver", () => {
			expect(
				typeOfFirstConstant(`implementation {
					namespace Wrapper<infer Item> for List<Item> {
						firstAgain() -> Item | Nothing {
							<- @::firstItem()
						}
					}

					constant first = ["x"]::firstAgain()
				}`),
			).toEqual({
				type: "UnionType",
				types: [{ type: "String" }, { type: "Nothing" }],
			})
		})

		it("should bind Method Generics from Function Argument return Types", () => {
			expect(
				typeOfFirstConstant(`implementation {
					namespace Mapper<infer Item> for List<Item> {
						transformFirst<infer Target>(
							_ transform: (_ item: Item) -> Target,
							fallback fallbackValue: Target,
						) -> Target {
							<- match @::firstItem() -> Target {
								case Nothing { <- fallbackValue }
								case Item { <- transform(@) }
							}
						}
					}

					constant first = [1]::transformFirst(
						(_ item: Integer) -> String { <- item::toString() },
						fallback "none",
					)
				}`),
			).toEqual({ type: "String" })
		})

		it("should check Function Argument parameters against bound Generics", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Mapper<infer Item> for List<Item> {
					transformFirst<infer Target>(
						_ transform: (_ item: Item) -> Target,
						fallback fallbackValue: Target,
					) -> Target {
						<- fallbackValue
					}
				}

				constant first = [1]::transformFirst(
					(_ item: String) -> String { <- item },
					fallback "none",
				)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Passed arguments do not match any overload.",
			)
		})

		it("should infer Generic Functions from their Arguments", () => {
			expect(
				typeOfFirstConstant(`implementation {
					function identity <infer T>(_ value: T) -> T {
						<- value
					}

					constant a = identity(5)
				}`),
			).toEqual({ type: "Integer" })
		})

		it("should report conflicting later occurrences as mismatches", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = [1, 2]::append("x")
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Passed arguments do not match any overload.",
			)
		})

		it("should report Type Parameters that can not be inferred", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function broken <infer T>() -> T {
					<- "value"
				}

				constant a = broken()
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("Could not infer Type Parameter 'T'.")
		})

		it("should apply defaults for unbound plain Generics", () => {
			expect(
				typeOfFirstConstant(`implementation {
					function fallback <T = String>() -> T {
						<- "value"
					}

					constant a = fallback()
				}`),
			).toEqual({ type: "String" })
		})

		it("should expand applied Generic Type Aliases", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type Maybe<Value> = Value | Nothing

				constant a: Maybe<Fraction> = 1/2
			}`)

			expect(diagnostics).toEqual([])

			let constant = program.implementation.nodes[1]

			expect(constant.nodeType).toBe("ConstantDeclarationStatement")

			if (constant.nodeType === "ConstantDeclarationStatement") {
				expect(constant.declaredType).toEqual({
					type: "UnionType",
					types: [{ type: "Fraction" }, { type: "Nothing" }],
				})
			}
		})

		it("should apply Generic Type Alias defaults", () => {
			expect(
				diagnosticsFor(`implementation {
					type Fallback<Value = String> = Value | Nothing

					constant a: Fallback = "value"
				}`),
			).toEqual([])
		})

		it("should report Generic Type Aliases applied with too many Type Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Maybe<Value> = Value | Nothing

				constant a: Maybe<Fraction, Integer> = 1/2
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Wrong number of Type Arguments for Type 'Maybe'.",
			)
			expect(diagnostics[0].position?.start.line).toBe(4)
		})

		it("should report Generic Type Aliases used without Type Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Maybe<Value> = Value | Nothing

				constant a: Maybe = 1/2
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Wrong number of Type Arguments for Type 'Maybe'.",
			)
		})

		it("should match Generic Namespaces through applied Alias targets", () => {
			expect(
				typeOfFirstConstant(`implementation {
					type Maybe<Value> = Value | Nothing

					namespace Maybe<infer Value> for Maybe<Value> {
						withDefault(_ fallbackValue: Value) -> Value {
							<- match @ -> Value {
								case Nothing { <- fallbackValue }
								case Value { <- @ }
							}
						}
					}

					constant first = [1, 2]::firstItem()::withDefault(0)
				}`),
			).toEqual({ type: "Integer" })
		})
	})

	describe("Protocols", () => {
		it("should accept a well-formed Protocol declaration", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Equatable {
						is(_ other: Self) -> Boolean
						isNot(_ other: Self) -> Boolean
					}
				}`),
			).toEqual([])
		})

		it("should accept static and overloaded Protocol Method Signatures", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Creatable {
						static create() -> Self

						overload combine {
							(_ other: Self) -> Self
							(_ others: List<Self>) -> Self
						}
					}
				}`),
			).toEqual([])
		})

		it("should report duplicate Protocol declarations", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Printable {
					toString() -> String
				}

				protocol Printable {
					toString() -> String
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"Protocol 'Printable' is already declared.",
			)
		})

		it("should reject a Protocol used as a Type annotation", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Printable {
					toString() -> String
				}

				constant value: Printable = "text"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Printable' can not be used as a Type. Protocols are only usable as Generic bounds ('<infer T is Printable>') and Namespace conformance clauses ('is Printable').",
			)
		})

		it("should reject a Protocol used as a Union member", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Printable {
					toString() -> String
				}

				constant value: Printable | Nothing = nothing
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Printable' can not be used as a Type. Protocols are only usable as Generic bounds ('<infer T is Printable>') and Namespace conformance clauses ('is Printable').",
			)
		})

		it("should reject a Protocol used as a Match Case", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Printable {
					toString() -> String
				}

				variable value: Integer | Nothing = 1

				constant result = match value -> Integer {
					case Printable { <- 0 }
					case Integer { <- @ }
					case Nothing { <- 0 }
				}
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.message ===
						"Protocol 'Printable' can not be used as a Type. Protocols are only usable as Generic bounds ('<infer T is Printable>') and Namespace conformance clauses ('is Printable').",
				),
			).toBe(true)
		})

		it("should reject a Protocol used as a value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Printable {
					toString() -> String
				}

				constant value = Printable
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Printable' can not be used as a value. Protocols are only usable as Generic bounds ('<infer T is Printable>') and Namespace conformance clauses ('is Printable').",
			)
		})

		it("should reserve Self as a Generic name", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function identity <Self>(_ value: Self) -> Self {
					<- value
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'Self' is a reserved Type name.",
			)
		})

		it("should reserve Self as a Type Alias name", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Self = String
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'Self' is a reserved Type name.",
			)
		})
	})
})
