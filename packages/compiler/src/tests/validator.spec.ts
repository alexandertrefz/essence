import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { enrich } from "../enricher/index"
import { parse } from "../parser/index"
import { validate } from "../validator/index"

function diagnosticsFor(source: string): Array<common.Diagnostic> {
	let { program, diagnostics } = enrich(parse(source))

	expect(diagnostics).toEqual([])

	return validate(program)
}

// NOTE: The text a Label underlines. A Diagnostic that names a Namespace the
// source never spells at the place it is reported — a conformance witness — is
// only readable if its Labels land on the right two spans, and reading them
// back out of the source is the only way to say so without counting columns by
// hand. Single line spans only; every Label asked this points at one name.
function underlinedBy(
	source: string,
	label: common.DiagnosticLabel | undefined,
): string {
	if (label === undefined) {
		throw new Error("Diagnostic has no such Label.")
	}

	return source
		.split("\n")
		[label.position.start.line - 1].slice(
			label.position.start.column - 1,
			label.position.end.column - 1,
		)
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
			expect(diagnostics[0].data).toEqual({
				kind: "missing-case",
				unhandled: ["Rational"],
			})
		})

		// NOTE: The Quick Fix writes one Handler per entry in the order it
		// finds them, so the order is part of what `data` promises — Handlers
		// that appear in a different order than the Union declares its members
		// read as though the Compiler shuffled them.
		it("should carry every unhandled member in declaration order", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant value: Integer | Rational | String | Boolean = 5
				constant a = match value -> Integer {
					case Integer {
						<- @
					}
				}
			}`)

			expect(diagnostics[0].data).toEqual({
				kind: "missing-case",
				unhandled: ["Rational", "String", "Boolean"],
			})
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

	// NOTE: A free Function's Arguments are matched by their LABELS before their
	// Types, exactly as a Method's are. A callee with one signature has no
	// Overload to choose, so a call that matches nothing lands here rather than
	// on the Enricher's `no-matching-overload` — and what it did wrong is the
	// label, which a Type mismatch would say nothing about. The note carries the
	// whole signature, the same thing the overloaded rail lists per candidate.
	describe("Labelled Arguments", () => {
		it("should accept a call that writes the labels the signature declares", () => {
			expect(
				diagnosticsFor(`implementation {
					function shout (about topic: String, times count: Integer) -> String {
						<- topic
					}

					__print(shout(about "hi", times 2))
				}`),
			).toEqual([])
		})

		it("should report an Argument labelled with something else", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function shout (about topic: String) -> String {
					<- topic
				}

				__print(shout(regarding "hi"))
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-label-mismatch")
			expect(diagnostics[0].message).toBe(
				"This Argument is not labelled 'about'",
			)
			expect(diagnostics[0].labels[0]?.message).toBe(
				"this is labelled 'regarding'",
			)
			expect(diagnostics[0].notes).toEqual([
				"The signature takes 1 Argument: Parameter 'about' is String.",
			])
			expect(diagnostics[0].helps).toEqual([
				"Write 'about' before the value.",
			])
		})

		it("should report an Argument that carries no label at all", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function shout (about topic: String) -> String {
					<- topic
				}

				__print(shout("hi"))
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-label-mismatch")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"this Argument carries no label",
			)
		})

		it("should report a label on a Parameter that takes none", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function shout (_ topic: String) -> String {
					<- topic
				}

				__print(shout(about "hi"))
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-label-mismatch")
			expect(diagnostics[0].message).toBe(
				"This Argument is labelled where Parameter 1 takes no label",
			)
			expect(diagnostics[0].helps).toEqual([
				"Pass the value with no label.",
			])
		})

		// NOTE: The label is answered first — an Argument that agrees with
		// NEITHER half of its Parameter is told about the label, because the
		// Type it should have had is the Type of whichever Parameter it was
		// meant for, and until the label says which one that is there is
		// nothing to compare.
		it("should report the label before the Type where both are wrong", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function shout (about topic: String) -> String {
					<- topic
				}

				__print(shout(regarding 2))
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-label-mismatch")
		})

		it("should still report a Type mismatch under the right label", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function shout (about topic: String) -> String {
					<- topic
				}

				__print(shout(about 2))
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
			expect(diagnostics[0].message).toBe(
				"This Argument does not fit Parameter 'about'",
			)
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
		// Signature promised a `Value`, and the wrong value flowed on. It is an
		// Error rather than the Warning dead code gets: nothing is greyed out
		// here, a Program is answering with the wrong value.
		it("should reject a Case shadowed by an earlier Generic Case", () => {
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
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("erased-case-conflict")
			// NOTE: Untagged — `unnecessary` greys a Case out, and this one is
			// not something to remove but something to reorder.
			expect(diagnostics[0].tags).toBeUndefined()
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
		// is not something reordering can fix, and the Error says so.
		it("should reject a Case a differently-signed callback Case swallows", () => {
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
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("erased-case-conflict")
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

	// NOTE: Regression tests — item Types erase before a Match runs, so a List
	// Matcher is answered by the items the value holds, and an empty List holds
	// none. `case List<String>` therefore accepts an empty `List<Integer>`,
	// which assignability calls impossible: the Validator reported NOTHING at
	// all while the Program took the String arm for an Integer List.
	describe("Empty List Overlap", () => {
		it("should warn about the Case an empty List reaches first", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant empty: List<Integer> = []
				constant scrutinee: List<Integer> | List<String> = empty

				__print(match scrutinee -> String {
					case List<String>  { <- "took the String arm" }
					case List<Integer> { <- "took the Integer arm" }
				})
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("empty-list-overlap")
			// NOTE: On `case List<Integer>`, the Case that misses the empty
			// Lists — pointing back at the Case above that takes them.
			expect(diagnostics[0].position?.start.line).toBe(7)
			expect(diagnostics[0].labels[1]?.position.start.line).toBe(6)
		})

		// NOTE: The Case is not dead — every List with items still reaches it —
		// so it is neither greyed out nor reported twice.
		it("should not tag the Case as unnecessary", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant scrutinee: List<Integer> | List<String> = [1]

				__print(match scrutinee -> String {
					case List<String>  { <- "strings" }
					case List<Integer> { <- "integers" }
				})
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].tags).toBeUndefined()
		})

		it("should stay silent where no empty List can cross over", () => {
			expect(
				diagnosticsFor(`implementation {
					constant scrutinee: List<Integer> | Nothing = [1]

					__print(match scrutinee -> String {
						case Nothing       { <- "nothing" }
						case List<Integer> { <- "integers" }
					})
				}`),
			).toEqual([])
		})

		// NOTE: Guarded Cases take nothing away from the Cases below them, so
		// the fix the Diagnostic asks for is a Match nobody has to warn about.
		it("should stay silent once the Cases are Guarded", () => {
			expect(
				diagnosticsFor(`implementation {
					constant scrutinee: List<Integer> | List<String> = [1]

					__print(match scrutinee -> String {
						case List<String> where @::hasItems()  { <- "strings" }
						case List<Integer> where @::hasItems() { <- "integers" }
						case _ { <- "empty" }
					})
				}`),
			).toEqual([])
		})
	})

	// NOTE: The dispatch branches of a Method Invocation on a Union-typed
	// receiver are the Cases nobody wrote — the receiver's runtime Type picks
	// one, and the first that fits wins, so the two ways a Case can swallow the
	// Case below it are two ways a branch can swallow the branch below it.
	describe("Dispatch Branches", () => {
		it("should reject a branch a callback-typed member Type swallows", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type IntHandler = { fn: (_ n: Integer) -> Integer }
				type StringHandler = { fn: (_ s: String) -> String }

				namespace Ints for IntHandler {
					describe() -> String {
						<- "ints"
					}
				}

				namespace Strings for StringHandler {
					describe() -> String {
						<- "strings"
					}
				}

				constant input: IntHandler | StringHandler = {
					fn = (_ s: String) -> String { <- s }
				}

				__print(input::describe())
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("erased-case-conflict")
		})

		it("should warn about the branch an empty List never reaches", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace IntegerList for List<Integer> {
					describe() -> String {
						<- "integers"
					}
				}

				namespace StringList for List<String> {
					describe() -> String {
						<- "strings"
					}
				}

				constant items: List<Integer> | List<String> = [1]

				__print(items::describe())
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("empty-list-overlap")
		})

		it("should stay silent for branches a runtime check tells apart", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace IntegerList for List<Integer> {
						describe() -> String {
							<- "integers"
						}
					}

					namespace Words for String {
						describe() -> String {
							<- "a word"
						}
					}

					constant thing: List<Integer> | String = "hi"

					__print(thing::describe())
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

	// NOTE: A Namespace is emitted as a `class`, so its name holds nothing until
	// the Declaration runs — every case here compiled green and failed at run
	// time before the check existed.
	describe("Use Before Declaration", () => {
		it("reports a Method call whose Namespace is declared below it", () => {
			let diagnostics = diagnosticsFor(`implementation {
				__print(21::doubled())

				namespace Doubling for Integer {
					doubled() -> Integer { <- @::multiply(with 2) }
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("use-before-declaration")
			expect(diagnostics[0].message).toBe(
				"Namespace 'Doubling' is used before it is declared",
			)
			expect(diagnostics[0].labels[1]?.message).toBe(
				"declared here, below the use",
			)
			expect(diagnostics[0].helps).toEqual([
				"Move the use below the Declaration.",
			])
		})

		it("reports a static Property read above the Namespace", () => {
			let diagnostics = diagnosticsFor(`implementation {
				__print(Greeter.greeting)

				namespace Greeter {
					static greeting = "hello"
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("use-before-declaration")
			expect(diagnostics[0].position?.start.line).toBe(2)
		})

		it("reports a static Method call above the Namespace", () => {
			let diagnostics = diagnosticsFor(`implementation {
				__print(Greeter.greet())

				namespace Greeter {
					static greet() -> String { <- "hello" }
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("use-before-declaration")
		})

		it("reports a use in the body of a top-level If, which runs where it is written", () => {
			let diagnostics = diagnosticsFor(`implementation {
				if true {
					__print(Greeter.greeting)
				}

				namespace Greeter {
					static greeting = "hello"
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("use-before-declaration")
		})

		it("reports a static Property initialiser naming a Namespace declared below", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace First {
					static value = Second.value
				}

				namespace Second {
					static value = 5
				}

				__print(First.value)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("use-before-declaration")
			expect(diagnostics[0].message).toBe(
				"Namespace 'Second' is used before it is declared",
			)
		})

		it("reports every dispatch branch whose Namespace is declared below", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant value: Integer | String = 5

				__print(value::described())

				namespace Ints for Integer {
					described() -> String { <- "an Integer" }
				}

				namespace Strings for String {
					described() -> String { <- "a String" }
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				[
					"Namespace 'Ints' is used before it is declared",
					"Namespace 'Strings' is used before it is declared",
				],
			)
		})

		// NOTE: A conformance witness names a Namespace that the source does not
		// spell anywhere — `things::sort()` emits `{ compareTo: Thing.compareTo }`
		// — so these compiled green and threw a `TypeError` reading `compareTo` of
		// `undefined` before the witness rail existed.
		it("reports a call whose conformance witness comes from a Namespace declared below it", () => {
			let source = `implementation {
				constant things = [{ value = 3 }, { value = 1 }]

				__print(things::sort()::length()::toString())

				namespace Thing for { value: Integer } is Comparable {
					compareTo(_ other: { value: Integer }) -> Ordering {
						<- @.value::compareTo(other.value)
					}
				}
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("use-before-declaration")
			expect(diagnostics[0].message).toBe(
				"Namespace 'Thing' is used before it is declared",
			)
			expect(diagnostics[0].labels[0]?.message).toBe(
				"this call's Comparable conformance comes from it",
			)
			expect(diagnostics[0].labels[1]?.message).toBe(
				"declared here, below the use",
			)
			// NOTE: The Method the witness is passed to, and the Namespace the
			// witness reads its Method off — the two spans are the whole of what
			// the Diagnostic explains, since neither place spells the other.
			expect(diagnostics[0].labels[0]?.kind).toBe("primary")
			expect(diagnostics[0].labels[1]?.kind).toBe("secondary")
			expect(diagnostics[0].labels[0]?.position.start.line).toBe(4)
			expect(underlinedBy(source, diagnostics[0].labels[0])).toBe("sort")
			expect(diagnostics[0].labels[1]?.position.start.line).toBe(6)
			expect(underlinedBy(source, diagnostics[0].labels[1])).toBe("Thing")
		})

		it("reports a bounded Function call whose witness comes from a Namespace declared below it", () => {
			let source = `implementation {
				function ordered <infer Item is Comparable>(_ items: List<Item>) -> List<Item> {
					<- items::sort()
				}

				__print(ordered([{ value = 3 }, { value = 1 }])::length()::toString())

				namespace Thing for { value: Integer } is Comparable {
					compareTo(_ other: { value: Integer }) -> Ordering {
						<- @.value::compareTo(other.value)
					}
				}
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("use-before-declaration")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"this call's Comparable conformance comes from it",
			)
			// NOTE: The call that hands the witness over, not the `items::sort()`
			// in the body that ends up using it — the body is only ever reached
			// through a call, and the call is the place that can be moved.
			expect(diagnostics[0].labels[0]?.position.start.line).toBe(6)
			expect(underlinedBy(source, diagnostics[0].labels[0])).toBe(
				"ordered",
			)
			expect(diagnostics[0].labels[1]?.position.start.line).toBe(8)
			expect(underlinedBy(source, diagnostics[0].labels[1])).toBe("Thing")
		})

		it("reports a conditional conformance's nested witness Namespaces", () => {
			let source = `implementation {
				constant boxes = [{ item = { value = 3 } }, { item = { value = 1 } }]

				__print(boxes::sort()::length()::toString())

				namespace Boxes<infer Item> for { item: Item }
					is Comparable where Item is Comparable
				{
					compareTo(_ other: { item: Item }) -> Ordering {
						<- @.item::compareTo(other.item)
					}
				}

				namespace Thing for { value: Integer } is Comparable {
					compareTo(_ other: { value: Integer }) -> Ordering {
						<- @.value::compareTo(other.value)
					}
				}
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				[
					"Namespace 'Boxes' is used before it is declared",
					"Namespace 'Thing' is used before it is declared",
				],
			)
			// NOTE: One call, two Namespaces — the witness `boxes::sort()` is
			// built from is composed of both — so the secondary Label is the only
			// thing telling the two Diagnostics apart.
			expect(
				diagnostics.map((diagnostic) => [
					underlinedBy(source, diagnostic.labels[0]),
					diagnostic.labels[0]?.position.start.line,
					underlinedBy(source, diagnostic.labels[1]),
					diagnostic.labels[1]?.position.start.line,
				]),
			).toEqual([
				["sort", 4, "Boxes", 6],
				["sort", 4, "Thing", 14],
			])
		})

		it("reports every dispatch branch whose witness comes from a Namespace declared below", () => {
			let source = `implementation {
				namespace Lefts for { left: Integer } {
					ranked <infer Item is Comparable>(_ item: Item) -> String {
						<- item::compareTo(item)::toString()
					}
				}

				namespace Rights for { right: Integer } {
					ranked <infer Item is Printable>(_ item: Item) -> String {
						<- item::toString()
					}
				}

				constant receiver: { left: Integer } | { right: Integer } = { left = 1 }

				__print(receiver::ranked({ value = 3 }))

				namespace Ordered for { value: Integer } is Comparable {
					compareTo(_ other: { value: Integer }) -> Ordering {
						<- @.value::compareTo(other.value)
					}
				}

				namespace Shown for { value: Integer } is Printable {
					toString() -> String { <- @.value::toString() }
				}
			}`
			let diagnostics = diagnosticsFor(source)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.message,
					diagnostic.labels[0]?.message,
				]),
			).toEqual([
				[
					"Namespace 'Ordered' is used before it is declared",
					"the branch for { left: Integer } takes its Comparable conformance from it",
				],
				[
					"Namespace 'Shown' is used before it is declared",
					"the branch for { right: Integer } takes its Printable conformance from it",
				],
			])
			// NOTE: A branch is not written anywhere, so both Diagnostics point at
			// the dispatched call itself; the branch each one is about is said in
			// the Label's message, and the Namespace is pointed at.
			expect(
				diagnostics.map((diagnostic) => [
					underlinedBy(source, diagnostic.labels[0]),
					diagnostic.labels[0]?.position.start.line,
					underlinedBy(source, diagnostic.labels[1]),
					diagnostic.labels[1]?.position.start.line,
				]),
			).toEqual([
				["ranked", 16, "Ordered", 18],
				["ranked", 16, "Shown", 24],
			])
		})

		it("accepts a call whose conformance witness comes from a Namespace declared above it", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Thing for { value: Integer } is Comparable {
						compareTo(_ other: { value: Integer }) -> Ordering {
							<- @.value::compareTo(other.value)
						}
					}

					constant things = [{ value = 3 }, { value = 1 }]

					__print(things::sort()::length()::toString())
				}`),
			).toEqual([])
		})

		it("accepts a Function body whose conformance witness comes from a Namespace declared below it", () => {
			expect(
				diagnosticsFor(`implementation {
					function ordered (_ items: List<{ value: Integer }>) -> List<{ value: Integer }> {
						<- items::sort()
					}

					namespace Thing for { value: Integer } is Comparable {
						compareTo(_ other: { value: Integer }) -> Ordering {
							<- @.value::compareTo(other.value)
						}
					}

					__print(ordered([{ value = 3 }, { value = 1 }])::length()::toString())
				}`),
			).toEqual([])
		})

		it("accepts a Function body that names a Namespace declared below it", () => {
			expect(
				diagnosticsFor(`implementation {
					function greeting () -> String {
						<- Greeter.greeting
					}

					namespace Greeter {
						static greeting = "hello"
					}

					__print(greeting())
				}`),
			).toEqual([])
		})

		it("accepts a use below the Declaration", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Greeter {
						static greeting = "hello"
					}

					namespace Doubling for Integer {
						doubled() -> Integer { <- @::multiply(with 2) }
					}

					__print(Greeter.greeting)
					__print(21::doubled())
				}`),
			).toEqual([])
		})

		// NOTE: A Namespace names itself from its own body, so the order its
		// static Properties are written in became something a Program can feel:
		// they are emitted as static fields, initialised top to bottom, and a
		// read of one below answers `undefined` out of a Program that compiled
		// green — the same fault as naming a Namespace above its Declaration,
		// one level in.
		describe("inside the Namespace's own body", () => {
			it("accepts a static Property reading one written above it", () => {
				expect(
					diagnosticsFor(`implementation {
						namespace Reader {
							static base = 10
							static doubled = Reader.base::multiply(with 2)
						}

						__print(Reader.doubled)
					}`),
				).toEqual([])
			})

			it("reports a static Property reading one written below it", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Reader {
						static doubled = Reader.base::multiply(with 2)
						static base = 10
					}

					__print(Reader.doubled)
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].severity).toBe("error")
				expect(diagnostics[0].code).toBe("use-before-declaration")
				expect(diagnostics[0].message).toBe(
					"Property 'Reader.base' is read before it has a value",
				)
				expect(diagnostics[0].labels[0]?.message).toBe("this reads it")
				expect(diagnostics[0].labels[0]?.position.start.line).toBe(3)
				expect(diagnostics[0].labels[1]?.message).toBe(
					"it is given its value here",
				)
				expect(diagnostics[0].labels[1]?.position.start.line).toBe(4)
				expect(diagnostics[0].helps).toEqual([
					"Move this Declaration below the one it reads.",
				])
			})

			it("reports a static Property reading itself", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Reader {
						static base = Reader.base
					}

					__print(Reader.base)
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("use-before-declaration")
				expect(diagnostics[0].message).toBe(
					"Property 'Reader.base' is read before it has a value",
				)
			})

			it("accepts a static Property calling a Method written below it", () => {
				// NOTE: A Method is installed with the class, ahead of every
				// static initialiser, so it answers whichever order the two are
				// written in.
				expect(
					diagnosticsFor(`implementation {
						namespace Reader {
							static base = Reader.computed()

							static computed() -> Integer { <- 10 }
						}

						__print(Reader.base)
					}`),
				).toEqual([])
			})

			// NOTE: The one read that reaches no `validateExpression` of its own
			// — a Property holding a Function is CALLED through the very Lookup
			// that reads it, and the callee of a call is examined by the call.
			it("reports a static Property calling one written below it", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Reader {
						static base = Reader.compute()
						static compute = () -> Integer { <- 10 }
					}

					__print(Reader.base)
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("use-before-declaration")
				expect(diagnostics[0].message).toBe(
					"Property 'Reader.compute' is read before it has a value",
				)
			})

			it("accepts a Function literal in an initialiser reading a Property written below it", () => {
				expect(
					diagnosticsFor(`implementation {
						namespace Reader {
							static reader = () -> Integer { <- Reader.base }
							static base = 10
						}

						__print(Reader.reader())
					}`),
				).toEqual([])
			})

			it("accepts a Method body reading a Property written above it", () => {
				expect(
					diagnosticsFor(`implementation {
						namespace Reader for Integer {
							static base = 10

							doubled() -> Integer {
								<- Reader.base::multiply(with @)
							}
						}

						__print(2::doubled())
					}`),
				).toEqual([])
			})
		})
	})

	// NOTE: The two cross-checks are about the COMPILER rather than about a
	// Program — while the Compiler is right, nothing anyone can write reaches
	// them — so each failing case is a typed Program put by hand into the state a
	// fixed hole used to produce: a witness dropped on the way (the `List<Unknown>`
	// hole), a Signature that grew its bound after the call was typed (the
	// hoisting-order hole), a witness forwarded out of a Function that declares no
	// such Parameter (the declared-Case fallback hole). Each of those compiled
	// green and failed at run time, which is what these turn into a Diagnostic.
	describe("Compiler cross-checks", () => {
		function enrichedProgram(source: string): common.typed.Program {
			let { program, diagnostics } = enrich(parse(source))

			expect(diagnostics).toEqual([])

			return program
		}

		// NOTE: Every Node of the typed Program, walked structurally — the Nodes
		// below are reached through a Namespace, a Function body and a Match
		// alike, and none of the tests here cares which.
		function walk(
			program: common.typed.Program,
			visit: (node: Record<string, unknown>) => void,
		): void {
			let go = (node: unknown): void => {
				if (node === null || typeof node !== "object") {
					return
				}

				if (Array.isArray(node)) {
					node.forEach(go)

					return
				}

				visit(node as Record<string, unknown>)

				Object.values(node).forEach(go)
			}

			program.implementation.nodes.forEach(go)
		}

		// NOTE: A Union receiver whose every member has the Method, each branch
		// binding the enclosing Function's own bounded Type Parameter — so every
		// branch forwards the same hidden conformance Parameter.
		const dispatchedWitnesses = `implementation {
			namespace Firsts for Integer {
				pair <infer Item is Printable>(_ item: Item) -> String {
					<- item::toString()
				}
			}

			namespace Seconds for String {
				pair <infer Item is Printable>(_ item: Item) -> String {
					<- item::toString()
				}
			}

			function both <infer Item is Printable>(
				_ receiver: Integer | String,
				_ item: Item,
			) -> String {
				<- receiver::pair(item)
			}

			__print(both(1, 2))
		}`

		it("accepts a bounded call that forwards the enclosing Function's witness", () => {
			expect(
				validate(
					enrichedProgram(`implementation {
						function ordered <infer Item is Comparable>(_ items: List<Item>) -> List<Item> {
							<- items::sort()
						}

						__print(ordered([3, 1, 2]))
					}`),
				),
			).toEqual([])
		})

		it("accepts a conditional conformance's nested witnesses", () => {
			expect(
				validate(
					enrichedProgram(`implementation {
						constant ordered: List<List<Integer>> = [[2], [1]]::sort()
						__print(ordered)
					}`),
				),
			).toEqual([])
		})

		it("accepts a dispatch whose every branch forwards the same witness", () => {
			expect(validate(enrichedProgram(dispatchedWitnesses))).toEqual([])
		})

		it("reports a call that was handed fewer witnesses than its callee has bounds", () => {
			let program = enrichedProgram(`implementation {
				constant ordered: List<List<Integer>> = [[2], [1]]::sort()
				__print(ordered)
			}`)

			// NOTE: What the silent `continue` in conformance solving left
			// behind — the Method still expects its hidden trailing Argument.
			walk(program, (node) => {
				if (node["nodeType"] === "MethodInvocation") {
					node["conformances"] = []
				}
			})

			let diagnostics = validate(program)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("internal-error")
			expect(diagnostics[0].message).toContain(
				"'List::sort' was given 0 conformance Arguments for a Signature with 1 Protocol-bounded Type Parameter",
			)
		})

		it("reports a call typed before its callee's Signature was woven", () => {
			let program = enrichedProgram(`implementation {
				namespace Counting for List<Integer> {
					total() -> Integer { <- @::length() }
				}

				__print([1, 2]::total())
			}`)

			// NOTE: The weave a conditional conformance performs, arriving after
			// the call was typed — the Namespace Type is shared by reference, so
			// the call site that resolved no witness now names a Method that
			// wants one.
			walk(program, (node) => {
				if (node["nodeType"] !== "NamespaceDefinitionStatement") {
					return
				}

				let methods = (node["type"] as common.NamespaceType).methods
				let method = methods["total"] as common.SimpleMethodType

				methods["total"] = {
					...method,
					generics: [
						...method.generics,
						{
							name: "ItemType",
							infer: true,
							defaultType: null,
							constraint: "Comparable",
						},
					],
				}
			})

			let diagnostics = validate(program)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("internal-error")
			expect(diagnostics[0].message).toContain(
				"'Counting::total' was given 0 conformance Arguments",
			)
		})

		it("reports a witness no enclosing Function declares", () => {
			let program = enrichedProgram(`implementation {
				function ordered <infer Item is Comparable>(_ items: List<Item>) -> List<Item> {
					<- items::sort()
				}

				__print(ordered([3, 1, 2]))
			}`)

			// NOTE: The bound gone from the Declaration the Simplifier emits the
			// hidden Parameter from, while the call inside still forwards it —
			// `Item__conformance` is read where nothing binds it.
			walk(program, (node) => {
				if (node["nodeType"] === "FunctionDefinition") {
					node["generics"] = (
						node[
							"generics"
						] as Array<common.typed.GenericDeclarationNode>
					).map((generic) => ({ ...generic, constraint: null }))
				}
			})

			let diagnostics = validate(program)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("internal-error")
			expect(diagnostics[0].message).toContain(
				"'List::sort' forwards the conformance Parameter 'Item__conformance', which no enclosing Function declares",
			)
		})

		// NOTE: Two Overloads that BOTH accept the same Argument, so which one a
		// call was committed to can only be read off the Node — matching again
		// would answer with the first, whatever the Enricher decided — and one
		// that accepts nothing the call passes, to commit to by hand.
		const overlappingOverloads = `implementation {
			namespace Tags for Integer {
				overload static tag {
					(_ value: Integer) -> String {
						<- "integer"
					}

					(_ value: Integer | String) -> String {
						<- "either"
					}

					(_ value: Boolean) -> String {
						<- "flag"
					}
				}
			}

			__print(Tags.tag(1))
		}`

		function overloadedCalls(
			program: common.typed.Program,
		): Array<common.typed.FunctionInvocationNode> {
			let found: Array<common.typed.FunctionInvocationNode> = []

			walk(program, (node) => {
				if (
					node["nodeType"] === "FunctionInvocation" &&
					node["overloadedMethodIndex"] !== null
				) {
					found.push(
						node as unknown as common.typed.FunctionInvocationNode,
					)
				}
			})

			return found
		}

		it("keeps the Overload the Enricher committed to", () => {
			let program = enrichedProgram(overlappingOverloads)
			let calls = overloadedCalls(program)

			expect(calls.map((call) => call.overloadedMethodIndex)).toEqual([0])

			// NOTE: The Overload a re-match would never arrive at, and the one
			// this is about: the Enricher decides WHICH Overload with the context
			// each Argument was written in, and the Simplifier mangles the callee
			// from the index — so a Validator that answered again would emit a
			// call against an Overload the Program was never checked against.
			for (let call of calls) {
				call.overloadedMethodIndex = 1
			}

			expect(validate(program)).toEqual([])
			expect(calls.map((call) => call.overloadedMethodIndex)).toEqual([1])
		})

		it("reports a call committed to an Overload that refuses its Arguments", () => {
			let program = enrichedProgram(overlappingOverloads)

			for (let call of overloadedCalls(program)) {
				call.overloadedMethodIndex = 2
			}

			let diagnostics = validate(program)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("internal-error")
			expect(diagnostics[0].message).toContain(
				"This call was committed to the overload that takes 1 Argument: Parameter 1 is Boolean, which does not accept the Arguments it passes",
			)
		})

		// NOTE: The check matches the Arguments against the committed Signature
		// again, LABELS and all. `loop` is the standard library's overloaded free
		// Function and its `while` and `until` entries are told apart by nothing
		// BUT the middle label — identical Types, identical arity — so committing
		// the `while` call to the `until` entry is a shape only a label-aware
		// re-match can refuse. A check that dropped the labels would wave it
		// through and the Program would be emitted against the other entry.
		it("re-matches a labelled free-Function call by its labels", () => {
			let program = enrichedProgram(`implementation {
				__print(loop(
					startingWith 1,
					while (n) { <- n::isLessThan(4) },
					step (n) { <- n::add(1) },
				))
			}`)
			let calls = overloadedCalls(program)

			expect(
				calls.map((call) =>
					call.arguments.map((argument) => argument.name),
				),
			).toEqual([["startingWith", "while", "step"]])
			expect(calls.map((call) => call.overloadedMethodIndex)).toEqual([0])
			expect(validate(program)).toEqual([])

			for (let call of calls) {
				call.overloadedMethodIndex = 1
			}

			let diagnostics = validate(program)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("internal-error")
			expect(diagnostics[0].message).toContain(
				"'loop' was committed to the overload that takes 3 Arguments: Parameter 'startingWith' is State, Parameter 'until' is (_: State) -> Boolean",
			)
		})

		it("reports a call committed to an Overload its callee does not have", () => {
			let program = enrichedProgram(overlappingOverloads)

			for (let call of overloadedCalls(program)) {
				call.overloadedMethodIndex = 7
			}

			let diagnostics = validate(program)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("internal-error")
			expect(diagnostics[0].message).toContain(
				"This call was committed to overload 7 of a callee that has 3 overloads",
			)
		})

		it("reports a dispatch branch's witness no enclosing Function declares", () => {
			let program = enrichedProgram(dispatchedWitnesses)

			// NOTE: A branch carries its own witnesses and its own Arguments, so
			// it is its own chance to name something that is not there.
			walk(program, (node) => {
				if (node["nodeType"] !== "MethodInvocation") {
					return
				}

				for (let dispatchCase of (node["dispatch"] ??
					[]) as Array<common.DispatchCase>) {
					for (let conformance of dispatchCase.conformances) {
						conformance.source = {
							kind: "parameter",
							name: "Other__conformance",
						}
					}
				}
			})

			let diagnostics = validate(program)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("internal-error")
			expect(diagnostics[0].message).toContain(
				"the branch for Integer, forwards the conformance Parameter 'Other__conformance'",
			)
		})
	})
})
