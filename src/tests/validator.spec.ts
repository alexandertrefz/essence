import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher"
import type { common } from "../interfaces"
import { parse } from "../parser"
import { validate } from "../validator"

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
			expect(diagnostics[0].message).toBe(
				"Wrong Assignment Value Type for Constant 'a'.",
			)
			expect(diagnostics[0].position?.start.line).toBe(2)
		})

		it("should report Variable Declarations with mismatched Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				variable a: String = true
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Wrong Assignment Value Type for Variable 'a'.",
			)
		})

		it("should report Variable Assignments with mismatched Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				variable a = "value"
				a = true
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Wrong Assignment Value Type for Variable 'a'.",
			)
		})

		it("should report top level returns", () => {
			let diagnostics = diagnosticsFor(`implementation {
				<- "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Top level returns are not permitted.",
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
				"Type of returned expression doesn't match the declared return type.",
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
				"If Conditions have to be Booleans.",
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
				"If Conditions have to be Booleans.",
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
			expect(diagnostics[0].message).toBe(
				"You can only use Match-Expressions on Union Types.",
			)
		})

		it("should accept exhaustive Match Expressions", () => {
			expect(
				diagnosticsFor(`implementation {
					constant value: Number = 5
					constant a = match value -> Number {
						case Integer {
							<- @
						}

						case Fraction {
							<- @
						}
					}
				}`),
			).toEqual([])
		})

		it("should report non-exhaustive Match Expressions", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant value: Number = 5
				constant a = match value -> Number {
					case Integer {
						<- @
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"Match Expression does not handle Type 'Fraction'.",
			)
		})

		it("should warn about unreachable Match cases", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Value = Integer | Fraction

				constant value: Value = 5
				constant a = match value -> Value {
					case Integer {
						<- @
					}

					case Fraction {
						<- @
					}

					case String {
						<- 5
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].message).toBe(
				"Type 'String' is not a member of the matched Union — this case can never match.",
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
			expect(diagnostics[0].message).toBe(
				"Amount of passed arguments doesn't match the signature.",
			)
		})

		it("should report Function Invocations with mismatched Argument Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function greet (_ name: String) -> String {
					<- name
				}

				constant a = greet(true)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Argument 1 doesn't match its declared parameter.",
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

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				[
					"Wrong Assignment Value Type for Constant 'a'.",
					"Top level returns are not permitted.",
					"If Conditions have to be Booleans.",
				],
			)
		})
	})
})
