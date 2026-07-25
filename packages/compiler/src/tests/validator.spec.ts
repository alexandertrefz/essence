import { describe, expect, it } from "bun:test"

import type { common } from "@essence/interfaces"

import { enrich } from "../enricher/index"
import { parse } from "../parser/index"
import { validate } from "../validator/index"

function diagnosticsFor(source: string): Array<common.Diagnostic> {
	let { program, diagnostics } = enrich(parse(source))

	expect(diagnostics).toEqual([])

	return validate(program)
}

describe("Validator", () => {
	describe("Diagnostics", () => {
		it("should report no Diagnostics for a valid Program", () => {
			expect(
				diagnosticsFor(`implementation {
					constant name: String = "essence"
					__print(name)
				}`),
			).toEqual([])
		})

		it("should report Constant Declarations with mismatched Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a: String = true
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("assignment-type-mismatch")
			expect(diagnostics[0].position?.start.line).toBe(2)
		})

		it("should treat a nested Optional and its flattened spelling as interchangeable", () => {
			// NOTE: `Optional<Integer | Rational>` nests its payload as one
			// member; the flat spelling lists all three. Assignability must
			// accept both directions — the two describe the same values.
			expect(
				diagnosticsFor(`implementation {
					constant nested: Optional<Integer | Rational> = 1
					constant flat: Integer | Rational | Nothing = nested
					constant back: Optional<Integer | Rational> = flat
					__print(back)
				}`),
			).toEqual([])
		})

		it("should report Variable Declarations with mismatched Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				variable a: String = true
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("assignment-type-mismatch")
		})

		it("should report Variable Assignments with mismatched Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				variable a = "value"
				a = true
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("assignment-type-mismatch")
		})

		it("should report top level returns", () => {
			let diagnostics = diagnosticsFor(`implementation {
				<- "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"There is nothing here to return from",
			)
		})

		it("should report returns with mismatched Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function getName () -> String {
					<- true
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"This value does not fit the declared return Type",
			)
		})

		it("should report non-Boolean If Conditions", () => {
			let diagnostics = diagnosticsFor(`implementation {
				if "value" {
					__print("then")
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"An If Condition has to be a Boolean",
			)
		})

		it("should report non-Boolean IfElse Conditions", () => {
			let diagnostics = diagnosticsFor(`implementation {
				if "value" {
					__print("then")
				} else {
					__print("else")
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"An If Condition has to be a Boolean",
			)
		})

		it("should report Match Expressions on non-Union Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = match "value" -> String {
					case String {
						<- @
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("match-on-non-union")
		})

		it("should accept exhaustive Match Expressions", () => {
			expect(
				diagnosticsFor(`implementation {
					constant value: Integer | Rational = 5
					constant a = match value -> Integer | Rational {
						case Integer {
							<- @
						}

						case Rational {
							<- @
						}
					}
				}`),
			).toEqual([])
		})

		it("should report non-exhaustive Match Expressions", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant value: Integer | Rational = 5
				constant a = match value -> Integer | Rational {
					case Integer {
						<- @
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("missing-case")
			expect(diagnostics[0].notes).toEqual(["Unhandled: 'Rational'."])
		})

		it("should warn about unreachable Match cases", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Value = Integer | Rational

				constant value: Value = 5
				constant a = match value -> Value {
					case Integer {
						<- @
					}

					case Rational {
						<- @
					}

					case String {
						<- 5
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"String is not a member of the matched Union",
			)
		})

		it("should report Function Invocations with mismatched arity", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function greet (_ name: String) -> String {
					<- name
				}

				constant a = greet("essence", "extra")
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-count-mismatch")
		})

		it("should report Function Invocations with mismatched Argument Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function greet (_ name: String) -> String {
					<- name
				}

				constant a = greet(true)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
		})

		it("should accept Functions that return on all code paths", () => {
			expect(
				diagnosticsFor(`implementation {
					function classify (_ value: Boolean) -> String {
						if value {
							<- "true"
						} else {
							<- "false"
						}
					}
				}`),
			).toEqual([])
		})

		it("should accept Functions returning Nothing without a return", () => {
			expect(
				diagnosticsFor(`implementation {
					function log (_ value: String) -> Nothing {
						__print(value)
					}
				}`),
			).toEqual([])
		})

		it("should report Functions that do not return on all code paths", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function classify (_ value: Boolean) -> String {
					if value {
						<- "true"
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Not every path through this Function returns",
			)
		})

		it("should report Match cases that do not return on all code paths", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant value: Integer | Rational = 5
				constant a = match value -> Integer | Rational {
					case Integer {
						<- @
					}

					case Rational {
						__print(@)
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Not every path through this Function returns",
			)
		})

		it("should report all independent errors of a Program", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a: String = true
				<- "value"

				if "value" {
					__print("then")
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"assignment-type-mismatch",
				"top-level-return",
				"condition-not-boolean",
			])
		})
	})

	// NOTE: A value position is not a leaf — a List item, a Record member and
	// either side of a Combination hold whole Expressions, and everything the
	// Validator says about a Statement has to hold there too. These check that
	// the walk descends rather than stopping at the literal that contains them.
	describe("Nested Expressions", () => {
		it("should report a non-exhaustive Match inside a List Literal", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant maybe: Integer | Nothing = nothing
				constant values = [match maybe -> Integer {
					case Integer { <- @ }
				}]

				__print(values)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("missing-case")
		})

		it("should report a mismatched Argument inside a List Literal", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function shout (_ value: String) -> String {
					<- value::append("!")
				}

				constant values = [shout(1)]

				__print(values)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
		})

		it("should report a mismatched Argument inside a Record Literal", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function shout (_ value: String) -> String {
					<- value::append("!")
				}

				constant record = { loud = shout(1) }

				__print(record.loud)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
		})

		it("should report a Function Literal stored in a Record that does not return", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant record = {
					compute = (_ value: Integer) -> Integer {
						__print(value)
					}
				}

				__print(record.compute(1))
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("missing-return")
		})

		it("should report a mismatched Argument on the right side of a Combination", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function takesInteger (_ value: Integer) -> Integer {
					<- value
				}

				constant base = { x = 1, y = 2 }
				constant combined = { base with x = takesInteger("bad") }

				__print(combined.x)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
		})

		it("should report a non-exhaustive Match on the right side of a Combination", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant maybe: Integer | Nothing = nothing
				constant base = { x = 1, y = 2 }
				constant combined = { base with x = match maybe -> Integer {
					case Integer { <- @ }
				} }

				__print(combined.x)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("missing-case")
		})

		it("should report a mismatched Argument on the left side of a Combination", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function makeBase (_ value: Integer) -> { x: Integer, y: Integer } {
					<- { x = value, y = 0 }
				}

				constant combined = { makeBase("bad") with x = 2 }

				__print(combined.x)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
		})

		it("should accept valid nested Expressions", () => {
			expect(
				diagnosticsFor(`implementation {
					function double (_ value: Integer) -> Integer {
						<- value::multiply(with 2)
					}

					constant base = { x = 1, y = 2 }
					constant values = [double(1)]
					constant record = { first = double(2) }
					constant combined = { base with x = double(3) }

					__print(values)
					__print(record.first)
					__print(combined.x)
				}`),
			).toEqual([])
		})
	})

	describe("Match Handlers", () => {
		it("should report a non-Boolean Guard", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant maybe: Integer | Nothing = 5
				constant a = match maybe -> Integer {
					case Integer where "" { <- 111 }
					case Nothing { <- 0 }
					case Integer { <- 222 }
				}

				__print(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("condition-not-boolean")
			expect(diagnostics[0].message).toBe(
				"A Case Guard has to be a Boolean",
			)
			expect(diagnostics[0].notes).toEqual([
				"Essence has no truthiness — only a Boolean can be a Condition.",
			])
		})

		it("should report a mismatched Argument inside a Guard", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function takesInteger (_ value: Integer) -> Integer {
					<- value
				}

				constant maybe: Integer | Nothing = 5
				constant a = match maybe -> Integer {
					case Integer where takesInteger("bad")::isEven() { <- 1 }
					case _ { <- 0 }
				}

				__print(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
		})

		it("should accept a Boolean Guard", () => {
			expect(
				diagnosticsFor(`implementation {
					constant maybe: Integer | Nothing = 5
					constant a = match maybe -> Integer {
						case Integer where @::isGreaterThan(100) { <- 111 }
						case Integer { <- 222 }
						case Nothing { <- 0 }
					}

					__print(a)
				}`),
			).toEqual([])
		})

		it("should report a zero denominator in a literal Matcher", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant maybe: Rational | Nothing = 1/2
				constant a = match maybe -> String {
					case 1/0 { <- "half" }
					case Rational { <- "other" }
					case Nothing { <- "none" }
				}

				__print(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("zero-denominator")
		})

		it("should report a zero denominator in a Record Matcher's member", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Point = { x: Rational, y: Rational }

				constant point: Point | Nothing = { x = 1/2, y = 1/2 }
				constant a = match point -> String {
					case { x = 2/0, y: Rational } { <- "x" }
					case Point { <- "point" }
					case Nothing { <- "none" }
				}

				__print(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("zero-denominator")
		})
	})

	describe("Unreachable Cases", () => {
		it("should warn about a duplicated Case", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant maybe: Integer | Nothing = 5
				constant a = match maybe -> Integer {
					case Integer { <- 1 }
					case Integer { <- 2 }
					case Nothing { <- 0 }
				}

				__print(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].tags).toEqual(["unnecessary"])
			expect(diagnostics[0].labels[0]?.message).toBe(
				"an earlier Case already answers for every Type this one matches",
			)
			expect(diagnostics[0].labels[1]?.message).toBe(
				"this Case runs first",
			)
			// NOTE: The second `case Integer`, not the first — the Warning is
			// on the Case that never runs.
			expect(diagnostics[0].position?.start.line).toBe(5)
			expect(diagnostics[0].labels[1]?.position.start.line).toBe(4)
		})

		it("should warn about a Case shadowed by an earlier wildcard", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant maybe: Integer | Nothing = 5
				constant a = match maybe -> Integer {
					case _ { <- 0 }
					case Integer { <- 1 }
				}

				__print(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].position?.start.line).toBe(5)
		})

		it("should not warn about a Case below a Guarded Case of the same Type", () => {
			expect(
				diagnosticsFor(`implementation {
					constant maybe: Integer | Nothing = 5
					constant a = match maybe -> Integer {
						case Integer where @::isGreaterThan(100) { <- 111 }
						case Integer { <- 222 }
						case Nothing { <- 0 }
					}

					__print(a)
				}`),
			).toEqual([])
		})

		it("should not warn about a Case below a literal Case of the same Type", () => {
			expect(
				diagnosticsFor(`implementation {
					constant maybe: Integer | Nothing = 5
					constant a = match maybe -> String {
						case 0 { <- "none" }
						case Integer { <- "many" }
						case Nothing { <- "no count at all" }
					}

					__print(a)
				}`),
			).toEqual([])
		})

		it("should not warn about a wildcard that catches what is left", () => {
			expect(
				diagnosticsFor(`implementation {
					constant maybe: Integer | Nothing = 5
					constant a = match maybe -> Integer {
						case Nothing { <- 0 }
						case _ { <- @ }
					}

					__print(a)
				}`),
			).toEqual([])
		})

		// NOTE: Regression test — Types erase before a Match runs, so the
		// emitted check for a Generic Matcher is unconditionally true and every
		// Case below it is dead. Assignability says `Value` matches nothing but
		// `Value`, so this Match used to pass every check without a Diagnostic:
		// `unwrap(nothing, fallback 7)` answered the Nothing where the
		// Signature promised a `Value`, and the wrong value flowed on.
		it("should warn about a Case shadowed by an earlier Generic Case", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function unwrap <infer Value>(
					_ maybe: Value | Nothing,
					fallback fallbackValue: Value,
				) -> Value {
					<- match maybe -> Value {
						case Value { <- @ }
						case Nothing { <- fallbackValue }
					}
				}

				__print(unwrap(nothing, fallback 7))
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].tags).toEqual(["unnecessary"])
			// NOTE: On `case Nothing`, the Case that never runs — pointing back
			// at the Generic Case above it.
			expect(diagnostics[0].position?.start.line).toBe(8)
			expect(diagnostics[0].labels[1]?.position.start.line).toBe(7)
			expect(diagnostics[0].notes[1]).toBe(
				"Types erase before a Match runs, so the Generic Case 'Value' narrows nothing and accepts every value that reaches it.",
			)
			expect(diagnostics[0].helps).toEqual([
				"Write this Case above 'case Value', which can only ever be the last one.",
			])
		})

		it("should not warn about a Generic Case written below the Cases it would swallow", () => {
			expect(
				diagnosticsFor(`implementation {
					function unwrap <infer Value>(
						_ maybe: Value | Nothing,
						fallback fallbackValue: Value,
					) -> Value {
						<- match maybe -> Value {
							case Nothing { <- fallbackValue }
							case Value { <- @ }
						}
					}

					__print(unwrap(nothing, fallback 7))
				}`),
			).toEqual([])
		})

		// NOTE: A Function's Signature does not survive to runtime — the check
		// emitted for a Function-typed member asks only whether the value is
		// callable — so of two Cases naming differently-signed callbacks, the
		// first swallows the second whichever way round they are written. That
		// is not something reordering can fix, and the Warning says so.
		it("should warn about a Case a differently-signed callback Case swallows", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type IntHandler = { fn: (_ n: Integer) -> Integer }
				type StringHandler = { fn: (_ s: String) -> String }

				constant input: IntHandler | StringHandler = {
					fn = (_ s: String) -> String { <- s }
				}

				constant a = match input -> String {
					case { fn: (_ n: Integer) -> Integer } { <- "int handler" }
					case { fn: (_ s: String) -> String } { <- "string handler" }
				}

				__print(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].position?.start.line).toBe(11)
			expect(diagnostics[0].notes[1]).toBe(
				"A Function's Signature erases before a Match runs, so a Function-typed member is only ever checked for being callable — which makes these two Matchers ask the same question.",
			)
			expect(diagnostics[0].helps).toEqual([
				"Tell the two Cases apart by a member that survives to runtime, or give this one a Guard.",
			])
		})

		it("should not warn about callback Cases told apart by another member", () => {
			expect(
				diagnosticsFor(`implementation {
					type IntHandler = { fn: (_ n: Integer) -> Integer, arity: Integer }
					type StringHandler = { fn: (_ s: String) -> String, label: String }

					constant input: IntHandler | StringHandler = {
						fn = (_ s: String) -> String { <- s },
						label = "strings",
					}

					constant a = match input -> String {
						case { fn: (_ n: Integer) -> Integer, arity: Integer } { <- "int handler" }
						case { fn: (_ s: String) -> String, label: String } { <- "string handler" }
					}

					__print(a)
				}`),
			).toEqual([])
		})

		// NOTE: A Guard can decline a value its Matcher accepted, so a Generic
		// Case carrying one leaves its Types to the Cases below it — the same
		// rule every other conditional Handler follows.
		it("should not warn about a Case below a Guarded Generic Case", () => {
			expect(
				diagnosticsFor(`implementation {
					function unwrap <infer Value>(
						_ maybe: Value | Nothing,
						fallback fallbackValue: Value,
					) -> Value {
						<- match maybe -> Value {
							case Value where true { <- @ }
							case Nothing { <- fallbackValue }
							case Value { <- @ }
						}
					}

					__print(unwrap(nothing, fallback 7))
				}`),
			).toEqual([])
		})
	})

	describe("Namespace Properties", () => {
		it("should report a non-exhaustive Match in a static Property", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Thing = { id: Integer }

				constant maybe: Integer | Nothing = nothing

				namespace Things for Thing {
					static fallback: Integer = match maybe -> Integer {
						case Integer { <- @ }
					}
				}

				__print(Things.fallback)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("missing-case")
		})

		it("should report a mismatched Argument in a static Property", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Thing = { id: Integer }

				function takesInteger (_ value: Integer) -> Integer {
					<- value
				}

				namespace Things for Thing {
					static fallback: Integer = takesInteger("nope")
				}

				__print(Things.fallback)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
		})

		it("should report a static Property whose value does not fit its declared Type", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Thing = { id: Integer }

				namespace Things for Thing {
					static fallback: Integer = "not an Integer"
				}

				__print(Things.fallback)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("assignment-type-mismatch")
			expect(diagnostics[0].notes).toEqual([
				"'Things.fallback' is declared as Integer.",
			])
		})

		it("should accept a valid static Property", () => {
			expect(
				diagnosticsFor(`implementation {
					type Thing = { id: Integer }

					function double (_ value: Integer) -> Integer {
						<- value::multiply(with 2)
					}

					namespace Things for Thing {
						static fallback: Integer = double(21)
					}

					__print(Things.fallback)
				}`),
			).toEqual([])
		})
	})

	describe("Generic Inference", () => {
		it("should check declared Types against inferred return Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a: Integer = ["x"]::firstItem()
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("assignment-type-mismatch")
		})

		it("should accept declared Types matching inferred return Types", () => {
			expect(
				diagnosticsFor(`implementation {
					constant a: String | Nothing = ["x"]::firstItem()
				}`),
			).toEqual([])
		})

		it("should report Rational literals with a zero denominator", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = 1/0
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"A Rational can not have a denominator of zero",
			)
		})

		it("should type Divisions as Rational | Nothing", () => {
			expect(
				diagnosticsFor(`implementation {
					constant a: Rational | Nothing = 1::divide(by 2)
					constant b: Rational | Nothing = 1/2::divide(by 2)
					constant c: Rational | Nothing = Rational.of(1, over 2)
				}`),
			).toEqual([])

			let diagnostics = diagnosticsFor(`implementation {
				constant a: Rational = 1::divide(by 2)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("assignment-type-mismatch")
		})

		it("should treat Generics as opaque inside Generic Functions", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function broken <infer T>(_ value: T) -> T {
					<- "constant"
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"This value does not fit the declared return Type",
			)
		})

		it("should accept returning a Generic value as its own Generic Type", () => {
			expect(
				diagnosticsFor(`implementation {
					function identity <infer T>(_ value: T) -> T {
						<- value
					}
				}`),
			).toEqual([])
		})

		it("should validate Match Expressions over Generic Unions", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Wrapper<infer Item> for List<Item> {
						firstOr(fallback fallbackValue: Item) -> Item {
							<- match @::firstItem() -> Item {
								case Nothing { <- fallbackValue }
								case Item { <- @ }
							}
						}
					}

					__print([1]::firstOr(fallback 0))
				}`),
			).toEqual([])
		})
	})

	describe("Protocol Bounds", () => {
		const boundFunctionSetup = `
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
		`

		const boundValueMessage =
			"A Function with Protocol-bound Type Parameters can not be used as a value"

		it("should allow calling a bounded Function directly", () => {
			expect(
				diagnosticsFor(`implementation {
					${boundFunctionSetup}

					__print(describeValue({ x = 1, y = 2 }))
				}`),
			).toEqual([])
		})

		it("should reject a bounded Function as a Constant value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				${boundFunctionSetup}

				constant reference = describeValue
			}`)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.message === boundValueMessage,
				),
			).toBe(true)
		})

		it("should reject a bounded Function as an Argument", () => {
			let diagnostics = diagnosticsFor(`implementation {
				${boundFunctionSetup}

				__print(describeValue)
			}`)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.message === boundValueMessage,
				),
			).toBe(true)
		})

		it("should reject a bounded Function inside a List", () => {
			let diagnostics = diagnosticsFor(`implementation {
				${boundFunctionSetup}

				constant references = [describeValue]
			}`)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.message === boundValueMessage,
				),
			).toBe(true)
		})

		it("should reject a bounded Function as a Record member", () => {
			let diagnostics = diagnosticsFor(`implementation {
				${boundFunctionSetup}

				constant references = { transform = describeValue }
			}`)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.message === boundValueMessage,
				),
			).toBe(true)
		})

		it("should reject a retrofitted conditional Method as a stored value", () => {
			// NOTE: A conditional conformance retrofits the `where` bound onto
			// its fulfilling Method's Namespace Generic — so the Method carries
			// hidden conformance Parameters and can no more be a value than any
			// other bounded Function.
			let diagnostics = diagnosticsFor(`implementation {
				namespace Wrapper<infer Item> for { value: Item }
					is Comparable where Item is Comparable
				{
					compareTo(_ other: { value: Item }) -> Ordering {
						<- @.value::compareTo(other.value)
					}
				}

				constant reference = Wrapper.compareTo
			}`)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.message === boundValueMessage,
				),
			).toBe(true)
		})
	})

	describe("Infinite Recursion", () => {
		it("reports a Method whose only path returns a call to itself", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Looping for Integer {
					forever() -> Integer { <- @::forever() }
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("infinite-recursion")
		})

		it("reports a Method that recurses on every branch, with no base case", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Looping for Integer {
					forever() -> Integer {
						if @::isNegative() {
							<- @::forever()
						} else {
							<- @::forever()
						}
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("infinite-recursion")
		})

		it("accepts a Method whose recursion is guarded by a base case", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Looping for Integer {
						countDown() -> Integer {
							if @::isNegative() {
								<- 0
							} else {
								<- @::countDown()
							}
						}
					}
				}`),
			).toEqual([])
		})

		it("accepts a Method that dispatches through a Match, where each Case narrows the receiver to a different Method", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Rendering for Number {
						render() -> String {
							<- match @ -> String {
								case Integer { <- @::toString() }
								case Rational { <- @::toString() }
								case Algebraic { <- @::toString() }
								case Transcendental { <- @::toString() }
							}
						}
					}
				}`),
			).toEqual([])
		})

		it("accepts a Method that delegates to a different Method", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Delegating for Integer {
						distance() -> Integer { <- @::absolute() }
					}
				}`),
			).toEqual([])
		})
	})
})
