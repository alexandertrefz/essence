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
					Terminal.inspect(name)
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

		it("should treat an Optional and its payload Union as different Types", () => {
			// NOTE: `Optional<ItemType>` was a Type Alias for
			// `ItemType | Nothing`, so `Optional<Integer | Rational>` and the
			// hand-written `Integer | Rational | Nothing` were two spellings
			// of one Type and assignability accepted both directions.
			// Optional is a nominal Choice now — a value is `#Value(payload)`
			// or `#Empty`, which is not the payload sitting in a Union — and
			// `Nothing` is gone, so the flattened spelling cannot even be
			// written. What is left to check is that the wrapper and its
			// payload Union stay apart: neither direction is assignable, and
			// that is the point, because no hand-written Union can be
			// Optional-shaped by accident and the wrapper is what carries the
			// Namespace a bare `Integer | Rational` never had.
			expect(
				diagnosticsFor(`implementation {
					constant nested: Optional<Integer | Rational> = #Value(1)
					Terminal.inspect(nested)
				}`),
			).toEqual([])

			let unwrapped = diagnosticsFor(`implementation {
				constant nested: Optional<Integer | Rational> = #Value(1)
				constant flat: Integer | Rational = nested
				Terminal.inspect(flat)
			}`)

			expect(unwrapped).toHaveLength(1)
			expect(unwrapped[0].code).toBe("assignment-type-mismatch")
			expect(unwrapped[0].labels[0]?.message).toBe(
				"this is an Optional<Integer | Rational>",
			)

			let rewrapped = diagnosticsFor(`implementation {
				constant flat: Integer | Rational = 1
				constant back: Optional<Integer | Rational> = flat
				Terminal.inspect(back)
			}`)

			expect(rewrapped).toHaveLength(1)
			expect(rewrapped[0].code).toBe("assignment-type-mismatch")
			expect(rewrapped[0].labels[0]?.message).toBe(
				"this is an Integer | Rational",
			)
		})

		it("should keep a nested Optional distinct from the Optional it wraps", () => {
			// NOTE: The other half of the same change, and the reason it was
			// worth making. As a Type Alias `Optional<Optional<Integer>>`
			// flattened to `Integer | Nothing`, so a `List<Optional<Integer>>`
			// could not say whether `firstItem()` had found an empty Optional
			// or had found nothing at all. The Choice keeps the two levels
			// apart: `#Value(#Empty)` is not `#Empty`, and only
			// `NestedOptional::flatten` collapses one into the other.
			expect(
				diagnosticsFor(`implementation {
					constant inner: Optional<Integer> = #Empty
					constant nested: Optional<Optional<Integer>> = #Value(inner)
					Terminal.inspect(nested::flatten())
				}`),
			).toEqual([])

			let diagnostics = diagnosticsFor(`implementation {
				constant inner: Optional<Integer> = #Value(1)
				constant nested: Optional<Optional<Integer>> = #Value(inner)
				constant flat: Optional<Integer> = nested
				Terminal.inspect(flat)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("assignment-type-mismatch")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"this is an Optional<Optional<Integer>>",
			)
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
					Terminal.inspect("then")
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
					Terminal.inspect("then")
				} else {
					Terminal.inspect("else")
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

		// NOTE: The unit Type is the empty Record, `{}`. A Function that
		// answers nothing useful promises `{}`, and a body that promises `{}`
		// is the one body allowed to fall off its end — the Validator exempts
		// it here and the Simplifier appends the `return` for it.
		it("should accept Functions returning the unit Record without a return", () => {
			expect(
				diagnosticsFor(`implementation {
					function log (_ value: String) -> {} {
						Terminal.inspect(value)
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
						Terminal.inspect(@)
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
					Terminal.inspect("then")
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

					Terminal.inspect(shout(about "hi", times 2))
				}`),
			).toEqual([])
		})

		it("should report an Argument labelled with something else", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function shout (about topic: String) -> String {
					<- topic
				}

				Terminal.inspect(shout(regarding "hi"))
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

				Terminal.inspect(shout("hi"))
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

				Terminal.inspect(shout(about "hi"))
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

				Terminal.inspect(shout(regarding 2))
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-label-mismatch")
		})

		it("should still report a Type mismatch under the right label", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function shout (about topic: String) -> String {
					<- topic
				}

				Terminal.inspect(shout(about 2))
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
				constant either: Integer | String = 5
				constant values = [match either -> Integer {
					case Integer { <- @ }
				}]

				Terminal.inspect(values)
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

				Terminal.inspect(values)
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

				Terminal.inspect(record.loud)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
		})

		it("should report a Function Literal stored in a Record that does not return", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant record = {
					compute = (_ value: Integer) -> Integer {
						Terminal.inspect(value)
					}
				}

				Terminal.inspect(record.compute(1))
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

				Terminal.inspect(combined.x)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
		})

		it("should report a non-exhaustive Match on the right side of a Combination", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant either: Integer | String = 5
				constant base = { x = 1, y = 2 }
				constant combined = { base with x = match either -> Integer {
					case Integer { <- @ }
				} }

				Terminal.inspect(combined.x)
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

				Terminal.inspect(combined.x)
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

					Terminal.inspect(values)
					Terminal.inspect(record.first)
					Terminal.inspect(combined.x)
				}`),
			).toEqual([])
		})
	})

	describe("Match Handlers", () => {
		it("should report a non-Boolean Guard", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant either: Integer | String = 5
				constant a = match either -> Integer {
					case Integer where "" { <- 111 }
					case String { <- 0 }
					case Integer { <- 222 }
				}

				Terminal.inspect(a)
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

				constant either: Integer | String = 5
				constant a = match either -> Integer {
					case Integer where takesInteger("bad")::isEven() { <- 1 }
					case _ { <- 0 }
				}

				Terminal.inspect(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
		})

		it("should accept a Boolean Guard", () => {
			expect(
				diagnosticsFor(`implementation {
					constant either: Integer | String = 5
					constant a = match either -> Integer {
						case Integer where @::isGreaterThan(100) { <- 111 }
						case Integer { <- 222 }
						case String { <- 0 }
					}

					Terminal.inspect(a)
				}`),
			).toEqual([])
		})

		it("should report a zero denominator in a literal Matcher", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant either: Rational | String = 1/2
				constant a = match either -> String {
					case 1/0 { <- "half" }
					case Rational { <- "other" }
					case String { <- "a word" }
				}

				Terminal.inspect(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("zero-denominator")
		})

		it("should report a zero denominator in a Record Matcher's member", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Point = { x: Rational, y: Rational }

				constant point: Point | String = { x = 1/2, y = 1/2 }
				constant a = match point -> String {
					case { x = 2/0, y: Rational } { <- "x" }
					case Point { <- "point" }
					case String { <- "a word" }
				}

				Terminal.inspect(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("zero-denominator")
		})
	})

	describe("Unreachable Cases", () => {
		it("should warn about a duplicated Case", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant either: Integer | String = 5
				constant a = match either -> Integer {
					case Integer { <- 1 }
					case Integer { <- 2 }
					case String { <- 0 }
				}

				Terminal.inspect(a)
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
				constant either: Integer | String = 5
				constant a = match either -> Integer {
					case _ { <- 0 }
					case Integer { <- 1 }
				}

				Terminal.inspect(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].position?.start.line).toBe(5)
		})

		it("should not warn about a Case below a Guarded Case of the same Type", () => {
			expect(
				diagnosticsFor(`implementation {
					constant either: Integer | String = 5
					constant a = match either -> Integer {
						case Integer where @::isGreaterThan(100) { <- 111 }
						case Integer { <- 222 }
						case String { <- 0 }
					}

					Terminal.inspect(a)
				}`),
			).toEqual([])
		})

		it("should not warn about a Case below a literal Case of the same Type", () => {
			expect(
				diagnosticsFor(`implementation {
					constant either: Integer | String = 5
					constant a = match either -> String {
						case 0 { <- "none" }
						case Integer { <- "many" }
						case String { <- "not a count at all" }
					}

					Terminal.inspect(a)
				}`),
			).toEqual([])
		})

		it("should not warn about a wildcard that catches what is left", () => {
			expect(
				diagnosticsFor(`implementation {
					constant either: Integer | String = 5
					constant a = match either -> Integer {
						case String { <- 0 }
						case _ { <- @ }
					}

					Terminal.inspect(a)
				}`),
			).toEqual([])
		})

		// NOTE: Regression test — Types erase before a Match runs, so the
		// emitted check for a Generic Matcher is unconditionally true and every
		// Case below it is dead. Assignability says `Value` matches nothing but
		// `Value`, so this Match used to pass every check without a Diagnostic:
		// `unwrap("missing", fallback 7)` answered the String where the
		// Signature promised a `Value` — an Integer here — and the wrong value
		// flowed on. It is an Error rather than the Warning dead code gets:
		// nothing is greyed out here, a Program is answering with the wrong
		// value.
		it("should reject a Case shadowed by an earlier Generic Case", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function unwrap <infer Value>(
					_ candidate: Value | String,
					fallback fallbackValue: Value,
				) -> Value {
					<- match candidate -> Value {
						case Value { <- @ }
						case String { <- fallbackValue }
					}
				}

				Terminal.inspect(unwrap("missing", fallback 7))
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("erased-case-conflict")
			// NOTE: Untagged — `unnecessary` greys a Case out, and this one is
			// not something to remove but something to reorder.
			expect(diagnostics[0].tags).toBeUndefined()
			// NOTE: On `case String`, the Case that never runs — pointing back
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
						_ candidate: Value | String,
						fallback fallbackValue: Value,
					) -> Value {
						<- match candidate -> Value {
							case String { <- fallbackValue }
							case Value { <- @ }
						}
					}

					Terminal.inspect(unwrap("missing", fallback 7))
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

				Terminal.inspect(a)
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

		// NOTE: Regression test — a payload requirement lived beside the
		// Matcher and this analysis read only the tag, so the Case spelling of
		// the callback conflict compiled clean while its Record spelling was
		// refused: the first arm accepted every callable, bound it at the wrong
		// Signature, and the second arm was silently dead.
		it("should reject a payload requirement a differently-signed callback swallows", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type IntFn = (_ n: Integer) -> Integer
				type StrFn = (_ s: String) -> String

				choice Op {
					Apply { fn: IntFn | StrFn },
					Skip,
				}

				function shout(_ s: String) -> String { <- s::append("!") }

				constant op: Op = #Apply({ fn = shout })

				Terminal.inspect(match op -> String {
					case #Apply({ fn: IntFn }) { <- "int fn" }
					case #Apply({ fn: StrFn }) { <- "str fn" }
					case _ { <- "other" }
				})
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("erased-case-conflict")
			expect(diagnostics[0].position?.start.line).toBe(16)
			expect(diagnostics[0].notes[1]).toBe(
				"A Function's Signature erases before a Match runs, so a Function-typed member is only ever checked for being callable — which makes these two Matchers ask the same question.",
			)
		})

		// NOTE: A requirement that narrows is not erased — the arm declines the
		// payloads it does not name and leaves them to the Cases below, exactly
		// as the Record spelling does.
		it("should not warn about payload requirements that survive to runtime", () => {
			expect(
				diagnosticsFor(`implementation {
					type Click = { x: Integer, y: Integer }
					type KeyPress = { key: String }

					choice Event {
						Fired { payload: Click | KeyPress },
						Quiet,
					}

					constant event: Event = #Fired({ payload = { key = "a" } })

					Terminal.inspect(match event -> String {
						case #Fired({ x, y }) { <- "click" }
						case #Fired({ key })  { <- "key" }
						case _                { <- "other" }
					})
				}`),
			).toEqual([])
		})

		it("should warn about a payload requirement no payload can pass", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Click = { x: Integer, y: Integer }
				type KeyPress = { key: String }

				choice Event {
					Fired { payload: Click | KeyPress },
					Quiet,
				}

				constant event: Event = #Fired({ payload = { key = "a" } })

				Terminal.inspect(match event -> String {
					case #Fired({ payload: Boolean }) { <- "?" }
					case _ { <- "other" }
				})
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("unreachable-case")
		})

		// NOTE: An Alias hiding a refinement is refused as a Matcher at the
		// Enricher, before this analysis ever sees it — the conflict wording
		// would only name a symptom, and a single such arm beside a wildcard
		// has no conflict at all while being just as unsound. The refusal is
		// pinned in `enricher.spec.ts` with the other Matcher refusals.

		it("should warn about a Pattern naming a member only Object.prototype has", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type A = { x: Integer }
				type B = { y: Integer }

				constant v: A | B = { x = 1 }

				Terminal.inspect(match v -> String {
					case { hasOwnProperty } { <- "?" }
					case _ { <- "ok" }
				})
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].position?.start.line).toBe(8)
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

					Terminal.inspect(a)
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
						_ candidate: Value | String,
						fallback fallbackValue: Value,
					) -> Value {
						<- match candidate -> Value {
							case Value where true { <- @ }
							case String { <- fallbackValue }
							case Value { <- @ }
						}
					}

					Terminal.inspect(unwrap("missing", fallback 7))
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

				Terminal.inspect(match scrutinee -> String {
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

				Terminal.inspect(match scrutinee -> String {
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
					constant scrutinee: List<Integer> | String = [1]

					Terminal.inspect(match scrutinee -> String {
						case String        { <- "a word" }
						case List<Integer> { <- "integers" }
					})
				}`),
			).toEqual([])
		})

		// NOTE: Regression test — the requirement was invisible here too, so
		// the payload spelling of the List crossover lost the warning its
		// Record spelling had.
		it("should warn about a List-typed payload requirement", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Hold {
					Items { items: List<String> | List<Integer> },
					None,
				}

				constant held: Hold = #Items({ items = [1] })

				Terminal.inspect(match held -> String {
					case #Items({ items: List<String> })  { <- "strings" }
					case #Items({ items: List<Integer> }) { <- "integers" }
					case _ { <- "other" }
				})
			}`)

			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("empty-list-overlap")
			expect(diagnostics[0].position?.start.line).toBe(11)
		})

		// NOTE: A Matcher that narrows a member by Type overlaps the Cases
		// below it too, but the values it takes are exactly the ones it names —
		// Cases being tried in order, with no List and no erasure anywhere.
		it("should stay silent for a Record member narrowed by Type", () => {
			expect(
				diagnosticsFor(`implementation {
					type Click = { x: Integer, y: Integer }
					type KeyPress = { key: String }
					type Wrapped = { payload: Click | KeyPress }
					type Other = { tag: String }

					constant value: Wrapped | Other = { payload = { x = 1, y = 2 } }

					Terminal.inspect(match value -> String {
						case { payload as { key } } { <- key }
						case { tag } { <- tag }
						case _ { <- "rest" }
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

					Terminal.inspect(match scrutinee -> String {
						case List<String> where @::hasItems()  { <- "strings" }
						case List<Integer> where @::hasItems() { <- "integers" }
						case _ { <- "empty" }
					})
				}`),
			).toEqual([])
		})
	})

	// NOTE: A Match on an Integer or a String takes the VALUE apart, and there is
	// no Union to be exhaustive over — so the SHAPE is what stands in for
	// exhaustiveness, and it is a rule rather than a style because the last Case
	// is what a refinement's evidence is read out of.
	describe("Match on values", () => {
		let match = (arms: string) => `implementation {
			constant n = 3

			constant answer = match n -> String {
				${arms}
			}

			Terminal.inspect(answer)
		}`

		it("should accept values above a Case for the rest", () => {
			expect(
				diagnosticsFor(
					match(`case 0 { <- "zero" }
						case 1 { <- "one" }
						case _ { <- "more" }`),
				),
			).toEqual([])
		})

		// NOTE: A Case naming the matched Type is `case _` spelled out — the two are
		// one Matcher by the time a Match is typed, and both are total.
		it("should accept the matched Type as the Case for the rest", () => {
			expect(
				diagnosticsFor(
					match(`case 0 { <- "zero" }
						case Integer { <- "more" }`),
				),
			).toEqual([])
		})

		it("should report a Match with no Case for the rest", () => {
			let diagnostics = diagnosticsFor(match(`case 0 { <- "zero" }`))

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("literal-match-shape")
			expect(diagnostics[0].helps).toEqual([
				"Add a 'case _' below, for every value the Cases above miss.",
			])
		})

		it("should report a Case above the end that names no value", () => {
			let diagnostics = diagnosticsFor(
				match(`case Integer { <- "any" }
					case 1 { <- "one" }
					case _ { <- "more" }`),
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("literal-match-shape")
			// NOTE: On the Matcher that can not stand there, not on the Match.
			expect(diagnostics[0].position?.start.line).toBe(5)
		})

		// NOTE: The review finding this rule exists for — a Guard decides after the
		// value already matched, so a Guarded value Case would let the value it named
		// through to the Cases below, whose evidence says they never see it.
		it("should report a value Case carrying a Guard", () => {
			let diagnostics = diagnosticsFor(
				match(`case 0 where n::isNot(1) { <- "zero" }
					case _ { <- "more" }`),
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("literal-match-shape")
			expect(diagnostics[0].message).toBe(
				"This Case names a value and can still decline it",
			)
		})

		it("should report a Guard on the Case for the rest", () => {
			let diagnostics = diagnosticsFor(
				match(`case 0 { <- "zero" }
					case _ where n::isNot(1) { <- "more" }`),
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("literal-match-shape")
			expect(diagnostics[0].message).toBe(
				"This Match has no Case for the rest of the values",
			)
		})

		// NOTE: The Case is compared TO the matched value, so this is the mistake
		// `n::is("zero")` is — reported in the one place the two Types were never
		// checked against each other.
		it("should report a value of another Type", () => {
			let diagnostics = diagnosticsFor(
				match(`case "zero" { <- "zero" }
					case _ { <- "more" }`),
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("literal-match-shape")
			expect(diagnostics[0].message).toBe(
				"This Case names a value the Match can never be given",
			)
		})

		it("should take a String apart by value too", () => {
			expect(
				diagnosticsFor(`implementation {
					constant text = "essence"

					Terminal.inspect(match text -> String {
						case "" { <- "nothing" }
						case _  { <- text }
					})
				}`),
			).toEqual([])
		})

		// NOTE: A refinement is its base with evidence attached, and the values it
		// holds are the base's values — so a Match on one takes them apart the same
		// way, and the Cases add to what the Type already carries.
		it("should take a refined value apart by value", () => {
			expect(
				diagnosticsFor(`implementation {
					type NonZero = Integer where @::isNot(0)

					function named(_ n: NonZero) -> String {
						<- match n -> String {
							case 1 { <- "one" }
							case _ { <- "more" }
						}
					}

					Terminal.inspect(named(3))
				}`),
			).toEqual([])
		})

		// NOTE: Two values are an `if` written the long way, and a Boolean is no
		// refinable base — so nothing about it changed.
		it("should keep refusing a Match on a Boolean", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant flag = true

				Terminal.inspect(match flag -> String {
					case true { <- "yes" }
					case _    { <- "no" }
				})
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("match-on-non-union")
		})

		// NOTE: And a Match on an Integer that names no value asks nothing about the
		// value it was given, which is the one-outcome Match that Diagnostic has
		// always been about.
		it("should keep refusing a Match that names no value", () => {
			let diagnostics = diagnosticsFor(match(`case _ { <- "any" }`))

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("match-on-non-union")
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

				Terminal.inspect(input::describe())
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

				Terminal.inspect(items::describe())
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

					Terminal.inspect(thing::describe())
				}`),
			).toEqual([])
		})
	})

	describe("Namespace Properties", () => {
		it("should report a non-exhaustive Match in a static Property", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Thing = { id: Integer }

				constant either: Integer | String = 5

				namespace Things for Thing {
					static fallback: Integer = match either -> Integer {
						case Integer { <- @ }
					}
				}

				Terminal.inspect(Things.fallback)
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

				Terminal.inspect(Things.fallback)
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

				Terminal.inspect(Things.fallback)
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

					Terminal.inspect(Things.fallback)
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
					constant a: Optional<String> = ["x"]::firstItem()
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

		// NOTE: The divisors and denominators here are COMPUTED, deliberately.
		// `Rational.of` and `Integer.divide` each have an entry taking a divisor
		// proven not to be zero, and a divisor written where it stands is its
		// own proof — so a written `2` reaches that entry and answers with a
		// Rational rather than an Optional, which is asserted alongside.
		it("should type Divisions as Optional<Rational>", () => {
			expect(
				diagnosticsFor(`implementation {
					constant two = 1::add(1)

					constant a: Optional<Rational> = 1::divide(by two)
					constant b: Optional<Rational> = 1/2::divide(by 2)
					constant c: Optional<Rational> = Rational.of(1, over two)
					constant d: Rational = Rational.of(1, over 2)
					constant e: Rational = 1::divide(by 2)
				}`),
			).toEqual([])

			let diagnostics = diagnosticsFor(`implementation {
				constant two = 1::add(1)

				constant a: Rational = 1::divide(by two)
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

		it("should validate Match Expressions over Generic Choices", () => {
			// NOTE: `firstItem()` answers `Optional<Item>` for a Generic
			// `Item`, so the Cases are the Choice's own — and the payload
			// binding is what carries `Item` out of the Match: `item` is
			// typed as the Namespace's `Item`, which is what the `<-` has to
			// fit. The Match is exhaustive by the Choice's two Cases, so no
			// `case _` is needed to prove it.
			expect(
				diagnosticsFor(`implementation {
					namespace Wrapper<infer Item> for List<Item> {
						firstOr(fallback fallbackValue: Item) -> Item {
							<- match @::firstItem() -> Item {
								case #Value(item) { <- item }
								case #Empty      { <- fallbackValue }
							}
						}
					}

					Terminal.inspect([1]::firstOr(fallback 0))
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

					Terminal.inspect(describeValue({ x = 1, y = 2 }))
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

				Terminal.inspect(describeValue)
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
					compare(to other: { value: Item }) -> Ordering {
						<- @.value::compare(to other.value)
					}
				}

				constant reference = Wrapper.compare
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
				Terminal.inspect(21::doubled())

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
				Terminal.inspect(Greeter.greeting)

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
				Terminal.inspect(Greeter.greet())

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
					Terminal.inspect(Greeter.greeting)
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

				Terminal.inspect(First.value)
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

				Terminal.inspect(value::described())

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
		// spell anywhere — `things::sort()` emits `{ compare: Thing.compare }`
		// — so these compiled green and threw a `TypeError` reading `compare` of
		// `undefined` before the witness rail existed.
		it("reports a call whose conformance witness comes from a Namespace declared below it", () => {
			let source = `implementation {
				constant things = [{ value = 3 }, { value = 1 }]

				Terminal.inspect(things::sort()::length()::toString())

				namespace Thing for { value: Integer } is Comparable {
					compare(to other: { value: Integer }) -> Ordering {
						<- @.value::compare(to other.value)
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

				Terminal.inspect(ordered([{ value = 3 }, { value = 1 }])::length()::toString())

				namespace Thing for { value: Integer } is Comparable {
					compare(to other: { value: Integer }) -> Ordering {
						<- @.value::compare(to other.value)
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

				Terminal.inspect(boxes::sort()::length()::toString())

				namespace Boxes<infer Item> for { item: Item }
					is Comparable where Item is Comparable
				{
					compare(to other: { item: Item }) -> Ordering {
						<- @.item::compare(to other.item)
					}
				}

				namespace Thing for { value: Integer } is Comparable {
					compare(to other: { value: Integer }) -> Ordering {
						<- @.value::compare(to other.value)
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
						<- item::compare(to item)::toString()
					}
				}

				namespace Rights for { right: Integer } {
					ranked <infer Item is Printable>(_ item: Item) -> String {
						<- item::toString()
					}
				}

				constant receiver: { left: Integer } | { right: Integer } = { left = 1 }

				Terminal.inspect(receiver::ranked({ value = 3 }))

				namespace Ordered for { value: Integer } is Comparable {
					compare(to other: { value: Integer }) -> Ordering {
						<- @.value::compare(to other.value)
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
						compare(to other: { value: Integer }) -> Ordering {
							<- @.value::compare(to other.value)
						}
					}

					constant things = [{ value = 3 }, { value = 1 }]

					Terminal.inspect(things::sort()::length()::toString())
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
						compare(to other: { value: Integer }) -> Ordering {
							<- @.value::compare(to other.value)
						}
					}

					Terminal.inspect(ordered([{ value = 3 }, { value = 1 }])::length()::toString())
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

					Terminal.inspect(greeting())
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

					Terminal.inspect(Greeter.greeting)
					Terminal.inspect(21::doubled())
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

						Terminal.inspect(Reader.doubled)
					}`),
				).toEqual([])
			})

			it("reports a static Property reading one written below it", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Reader {
						static doubled = Reader.base::multiply(with 2)
						static base = 10
					}

					Terminal.inspect(Reader.doubled)
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

					Terminal.inspect(Reader.base)
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

						Terminal.inspect(Reader.base)
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

					Terminal.inspect(Reader.base)
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

						Terminal.inspect(Reader.reader())
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

						Terminal.inspect(2::doubled())
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

			Terminal.inspect(both(1, 2))
		}`

		it("accepts a bounded call that forwards the enclosing Function's witness", () => {
			expect(
				validate(
					enrichedProgram(`implementation {
						function ordered <infer Item is Comparable>(_ items: List<Item>) -> List<Item> {
							<- items::sort()
						}

						Terminal.inspect(ordered([3, 1, 2]))
					}`),
				),
			).toEqual([])
		})

		it("accepts a conditional conformance's nested witnesses", () => {
			expect(
				validate(
					enrichedProgram(`implementation {
						constant ordered: List<List<Integer>> = [[2], [1]]::sort()
						Terminal.inspect(ordered)
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
				Terminal.inspect(ordered)
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

				Terminal.inspect([1, 2]::total())
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

				Terminal.inspect(ordered([3, 1, 2]))
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

			Terminal.inspect(Tags.tag(1))
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
				Terminal.inspect(loop(
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

	// NOTE: A refinement demands evidence and a value written DOWN carries its
	// own, so not one source below has an `if` in it anywhere: the predicate is
	// decided while compiling, and a Program says exactly what it would have said
	// without the refined Type. What is left for the Validator is the refusal —
	// and a refusal that names the question, because a value that does not answer
	// it is not a spelling mistake.
	describe("Checked refinements", () => {
		function withRefinements(body: string): string {
			return `implementation {
				type NonZero = Integer where @::isNot(0)
				type NonEmptyString = String where @::hasAnyContent()
				type NonEmptyStrings = List<String> where @::hasItems()
				type Digit = Integer where @::isBetween(0, and 9)
				type SmallOdd = Integer where @::isOdd()::and(@::isLessThan(10))

				function doubled(_ n: NonZero) -> Integer {
					<- n::multiply(with 2)
				}

				${body}
			}`
		}

		function diagnosticsOfBody(body: string): Array<common.Diagnostic> {
			return diagnosticsFor(withRefinements(body))
		}

		it("should admit a written value into a declared refinement", () => {
			expect(
				diagnosticsOfBody(`
					constant d: NonZero = 3
					variable e: NonZero = 4

					e = 5

					Terminal.inspect(doubled(d))
					Terminal.inspect(doubled(e))
				`),
			).toEqual([])
		})

		it("should admit a written value into a refined Parameter", () => {
			expect(diagnosticsOfBody("Terminal.inspect(doubled(21))")).toEqual(
				[],
			)
		})

		it("should admit a written value where a refinement is returned", () => {
			expect(
				diagnosticsOfBody(`
					function three() -> NonZero {
						<- 3
					}

					Terminal.inspect(doubled(three()))
				`),
			).toEqual([])
		})

		// NOTE: A committed Overload whose Arguments do not match is an ICE here
		// rather than a Diagnostic, so an admission the Enricher makes and the
		// Validator does not would fail the compile outright and report nothing a
		// reader could act on. This is that crossing, on the call shape that
		// cross-checks itself.
		it("should admit a written value an Overload was committed on", () => {
			expect(
				diagnosticsOfBody(`
					namespace Scale for {} {
						overload static tripled {
							(_ n: NonZero) -> Integer {
								<- n::multiply(with 3)
							}

							(_ text: String) -> Integer {
								<- text::length()
							}
						}
					}

					Terminal.inspect(Scale.tripled(7))
				`),
			).toEqual([])
		})

		// NOTE: A static Property's initialiser is the same Declaration written in
		// a Namespace, and is held to what a Constant Declaration is held to — so
		// it is admitted the same way, and refused the same way.
		it("should admit a written value into a Namespace's Property", () => {
			let property = (value: string) => `
				namespace Scale for {} {
					static factor: NonZero = ${value}
				}

				Terminal.inspect(Scale.factor)
			`

			expect(diagnosticsOfBody(property("2"))).toEqual([])
			expect(diagnosticsOfBody(property("0"))).toHaveLength(1)
		})

		// NOTE: A String and an applied List are the other two v1 bases, and their
		// predicates read what is written as plainly as an Integer's: a String with
		// characters in it, a List with items in it.
		it("should admit a written String and a written List", () => {
			expect(
				diagnosticsOfBody(`
					function shouted(_ text: NonEmptyString) -> String {
						<- text::append("!")
					}

					function counted(_ items: NonEmptyStrings) -> Integer {
						<- items::length()
					}

					Terminal.inspect(shouted("essence"))
					Terminal.inspect(counted(["a", "b"]))
				`),
			).toEqual([])
		})

		// NOTE: `isBetween` is not Integer's own — the conjunct is keyed to the
		// Namespace that ANSWERED it, which is the one declared over the whole
		// numeric tower, so the allowlist has to name it under both.
		it("should admit a predicate the covering Namespace answered", () => {
			expect(
				diagnosticsOfBody(`
					function placed(_ digit: Digit) -> Integer {
						<- digit::add(1)
					}

					Terminal.inspect(placed(7))
				`),
			).toEqual([])
		})

		it("should admit a written value only where every conjunct holds", () => {
			let source = `
				function tripled(_ n: SmallOdd) -> Integer {
					<- n::multiply(with 3)
				}

				Terminal.inspect(tripled(7))
			`

			expect(diagnosticsOfBody(source)).toEqual([])
			expect(
				diagnosticsOfBody(source.replace("tripled(7)", "tripled(11)")),
			).toHaveLength(1)
			expect(
				diagnosticsOfBody(source.replace("tripled(7)", "tripled(8)")),
			).toHaveLength(1)
		})

		it("should refuse a written value the predicate refuses", () => {
			let diagnostics = diagnosticsOfBody("constant d: NonZero = 0")

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("assignment-type-mismatch")
			expect(diagnostics[0].notes).toEqual([
				"'d' is declared as NonZero.",
				"Every value of 'NonZero' has been proven to answer '@::isNot(0)'.",
			])
			expect(diagnostics[0].helps).toEqual([
				"Check '@::isNot(0)' on the value in an 'if' or a 'match', or pass a value that already has Type 'NonZero'.",
			])
		})

		it("should name the predicate where a returned value is refused", () => {
			let diagnostics = diagnosticsOfBody(`
				function zero() -> NonZero {
					<- 0
				}

				Terminal.inspect(doubled(zero()))
			`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("return-type-mismatch")
			expect(diagnostics[0].notes).toEqual([
				"The Function returns NonZero.",
				"Every value of 'NonZero' has been proven to answer '@::isNot(0)'.",
			])
		})

		it("should name the predicate where an Argument is refused", () => {
			let diagnostics = diagnosticsOfBody("Terminal.inspect(doubled(0))")

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
			expect(diagnostics[0].notes).toEqual([
				"Parameter 1 is NonZero.",
				"Every value of 'NonZero' has been proven to answer '@::isNot(0)'.",
			])
		})

		// NOTE: The conjuncts are canonical — sorted, so that one predicate is one
		// set however it was written — and that is the order they are spelled back
		// out in, rather than the order the clause happened to put them in.
		it("should name every conjunct of the predicate it refused", () => {
			let diagnostics = diagnosticsOfBody(`
				function tripled(_ n: SmallOdd) -> Integer {
					<- n::multiply(with 3)
				}

				Terminal.inspect(tripled(12))
			`)

			expect(diagnostics[0].helps).toEqual([
				"Check '@::isLessThan(10)::and(@::isOdd())' on the value in an 'if' or a 'match', or pass a value that already has Type 'SmallOdd'.",
			])
		})

		// NOTE: A name is a value the Program computes, however plainly it was
		// computed a line above. Deciding one would need an interpreter, which is
		// exactly what the allowlist exists not to be.
		it("should refuse a value the Program computes", () => {
			expect(
				diagnosticsOfBody(`
					constant three = 3
					constant d: NonZero = three
				`),
			).toHaveLength(1)
		})

		// NOTE: A List is a different question from the values in it, and it is
		// answered by the brackets: `[first]` holds exactly one item however
		// `first` was arrived at, so `hasItems` is decided by what is written
		// even though the item is not. Nothing in the allowlist asks what an
		// item IS.
		it("should admit a List whose items are not written", () => {
			expect(
				diagnosticsOfBody(`
					constant first = "a"
					constant items: NonEmptyStrings = [first]
				`),
			).toEqual([])
		})

		// NOTE: And the boundary that keeps that from meaning "any List at
		// all". A name standing for a whole List is a value the Program
		// computed; how many items it arrived with is written nowhere, because
		// there are no brackets here to count.
		it("should refuse a List the Program computes", () => {
			expect(
				diagnosticsOfBody(`
					constant written = ["a"]
					constant items: NonEmptyStrings = written
				`),
			).toHaveLength(1)
		})

		// NOTE: Evidence is not something a Program can ask for and be given. The
		// refinement is declared over an Integer, so a String is refused whatever
		// its own predicates would have said.
		it("should refuse a written value of another base", () => {
			expect(diagnosticsOfBody(`constant d: NonZero = "3"`)).toHaveLength(
				1,
			)
		})

		it("should decide a written Integer whatever its sign", () => {
			let source = (value: string) => `implementation {
				type EvenInteger = Integer where @::isEven()

				constant d: EvenInteger = ${value}
			}`

			expect(diagnosticsFor(source("-4"))).toEqual([])
			expect(diagnosticsFor(source("-3"))).toHaveLength(1)
		})

		// NOTE: A bound the entry can not read is a conjunct it can not decide, so
		// nothing is admitted — which is also how the Overload falls out: this
		// `isLessThan` is Integer's Rational entry, and comparing `1/2` as though
		// its digits were an Integer's is exactly the mistake the shape check
		// prevents.
		it("should not admit against a bound it can not read", () => {
			expect(
				diagnosticsFor(`implementation {
					type BelowHalf = Integer where @::isLessThan(1/2)

					constant d: BelowHalf = 0
				}`),
			).toHaveLength(1)
		})

		// NOTE: Essence's String equality is canonical equivalence — `String.is`
		// is `compare(to other)::is(#Equal)` over the NFC-normalised Strings — so a
		// composed accent and a decomposed one are the same String and the
		// evaluator has to agree. `isNot` is why it MUST: comparing the two as
		// written would prove them different, which is a proof of something false
		// rather than an admission missed.
		it("should compare a written String the way the Program does", () => {
			// NOTE: Written as escapes because the two are the same TEXT — an
			// editor, a terminal and this file are all free to print them alike, and
			// which one is which is the whole assertion.
			let composed = "\u00e9"
			let decomposed = "e\u0301"
			let source = (predicate: string) => `implementation {
				type Accented = String where @::${predicate}("${composed}")

				constant text: Accented = "${decomposed}"
			}`

			expect(diagnosticsFor(source("is"))).toEqual([])
			expect(diagnosticsFor(source("isNot"))).toHaveLength(1)
		})

		// NOTE: A generic refinement is admitted by the very same evaluator — the
		// predicate reads the item COUNT, which a written List has, and the base is
		// asked separately, which is where the Type Arguments are compared. So
		// nothing here is new machinery; what is new is that one Alias asks a
		// different question at every one of its applications.
		describe("a generic refinement", () => {
			function withFilled(body: string): string {
				return `implementation {
					type Filled<Item> = List<Item> where @::hasItems()

					function firstOf(_ items: Filled<String>) -> String {
						<- items::item(at 0)::value(withDefault "")
					}

					${body}
				}`
			}

			it("should admit a written List at all three positions", () => {
				expect(
					diagnosticsFor(
						withFilled(`
							constant proven: Filled<String> = ["a"]

							function two() -> Filled<String> {
								<- ["a", "b"]
							}

							Terminal.inspect(firstOf(proven))
							Terminal.inspect(firstOf(["a"]))
							Terminal.inspect(firstOf(two()))
						`),
					),
				).toEqual([])
			})

			// NOTE: The refusal names the Type as it was APPLIED, because the bare
			// Alias name is not a Type anything can be written as — a help offering
			// to pass a value of 'Filled' names something the Program would refuse
			// for taking no Arguments.
			it("should refuse an empty written List, naming the applied Type", () => {
				let diagnostics = diagnosticsFor(
					withFilled("constant broken: Filled<String> = []"),
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("assignment-type-mismatch")
				expect(diagnostics[0].notes).toEqual([
					"'broken' is declared as Filled<String>.",
					"Every value of 'Filled<String>' has been proven to answer '@::hasItems()'.",
				])
				expect(diagnostics[0].helps).toEqual([
					"Check '@::hasItems()' on the value in an 'if' or a 'match', or pass a value that already has Type 'Filled<String>'.",
				])
			})

			// NOTE: The base is asked as well as the predicate, and the base is where
			// the Type Arguments live: `[1]::hasItems()` is true and says nothing
			// whatever about a List of Strings.
			it("should refuse a written List of the wrong items", () => {
				expect(
					diagnosticsFor(
						withFilled("constant broken: Filled<String> = [1]"),
					),
				).toHaveLength(1)
			})

			// NOTE: A Parameter written with a Type Parameter the CALL works out is
			// the one position where the refinement is not yet a Type: its base is
			// `List<Item>`, and no written List is ever of that. So the value is asked
			// about the refinement IT decides — its own Type unified against the
			// declared base — and the Parameter is bound through that base, exactly as
			// an unrefined `List<Item>` binds it.
			describe("a Type Argument the call infers", () => {
				function withCountOf(
					body: string,
					generics = "<infer Item>",
				): string {
					return `implementation {
						type Filled<Item> = List<Item> where @::hasItems()

						function countOf${generics}(_ items: Filled<Item>) -> Integer {
							<- items::length()
						}

						${body}
					}`
				}

				it("should admit a written List, deciding the Type Argument by it", () => {
					expect(
						diagnosticsFor(
							withCountOf(`Terminal.inspect(countOf(["a"]))`),
						),
					).toEqual([])
				})

				// NOTE: The refusal names the Type as the Declaration spells it,
				// Parameter and all. Named by the Alias alone it read 'Filled', which
				// is not a Type anything can be written as — a help offering to pass a
				// value of it names something the Program would refuse for taking no
				// Arguments, and the note claimed a predicate had been proven of it.
				it("should refuse an empty written List, naming the Type with its Parameter", () => {
					let diagnostics = diagnosticsFor(
						withCountOf("Terminal.inspect(countOf([]))"),
					)

					expect(diagnostics).toHaveLength(1)
					expect(diagnostics[0].code).toBe("argument-type-mismatch")
					expect(diagnostics[0].notes).toEqual([
						"Parameter 1 is Filled<Item>.",
						"Every value of 'Filled<Item>' has been proven to answer '@::hasItems()'.",
					])
					expect(diagnostics[0].helps).toEqual([
						"Check '@::hasItems()' on the value in an 'if' or a 'match', or pass a value that already has Type 'Filled<Item>'.",
					])
				})

				// NOTE: The instantiation is what the value is ASKED about, never what
				// it is allowed to answer with: an `Item` the call can not bind is the
				// enclosing Declaration's own opaque symbol, and a written String
				// decides nothing whatever about it. Which is the ordinary
				// assignability rule doing it — the admission hands back a
				// `Filled<String>`, and `Filled<Item>` accepts no such thing.
				it("should refuse a written List against an opaque Type Parameter", () => {
					let diagnostics = diagnosticsFor(
						withCountOf(
							`Terminal.inspect(countOf(["a"]))`,
							"<Item>",
						),
					)

					expect(diagnostics).toHaveLength(1)
					expect(diagnostics[0].code).toBe("argument-type-mismatch")
				})
			})

			// NOTE: Two applications of ONE Alias are two questions about the same
			// written List, and the answer to each is kept for the Overload probes
			// that follow. Keyed by the Alias' name alone, the first entry probed
			// decided both and the call it was not about was refused for it.
			it("should decide each application of one Alias on its own", () => {
				expect(
					diagnosticsFor(
						withFilled(`
							namespace Take for {} {
								overload static count {
									(_ items: Filled<Integer>) -> Integer {
										<- items::length()
									}

									(_ items: Filled<String>) -> Integer {
										<- items::length()
									}
								}
							}

							Terminal.inspect(Take.count(["a"]))
							Terminal.inspect(Take.count([1]))
						`),
					),
				).toEqual([])
			})
		})

		// NOTE: What a written List lets the Compiler decide is its LENGTH, and
		// the two List predicates in the allowlist read nothing else. `[x, y]`
		// holds exactly two items whatever `x` and `y` turn out to be — the
		// grammar has no spread, so nothing a Program can write makes a written
		// List's length depend on what stands in it. So the items are kept where
		// they are written out and stand OPAQUE where they are not, and a List
		// literal is admitted by its length either way.
		describe("what a written List's items may be", () => {
			function withCountOf(body: string): string {
				return `implementation {
					type Filled<Item> = List<Item> where @::hasItems()

					function countOf(_ items: Filled<{ x: Integer }>) -> Integer {
						<- items::length()
					}

					${body}
				}`
			}

			// NOTE: THE Program that was refused. Every part of it is written
			// down — the List, the Record in it, the Integer in that — and it
			// was refused because a Record was not one of the shapes the
			// evaluator could read, which the predicate never asked about.
			it("should admit a List of written Records at all three positions", () => {
				expect(
					diagnosticsFor(
						withCountOf(`
							constant proven: Filled<{ x: Integer }> = [{ x = 1 }]

							function two() -> Filled<{ x: Integer }> {
								<- [{ x = 1 }, { x = 2 }]
							}

							Terminal.inspect(countOf(proven))
							Terminal.inspect(countOf([{ x = 1 }]))
							Terminal.inspect(countOf(two()))
						`),
					),
				).toEqual([])
			})

			// NOTE: The same Program against the standard library's own alias,
			// which is the spelling a reader reaches for — and where the
			// admission is worth having, since it is what makes `firstItem`
			// total.
			it("should admit a List of written Records into the builtin", () => {
				expect(
					diagnosticsFor(`implementation {
						constant proven: NonEmptyList<{ x: Integer }> = [{ x = 1 }]

						Terminal.inspect(proven::firstItem().x)
					}`),
				).toEqual([])
			})

			// NOTE: An item nobody wrote out is still an item. What the count
			// asks is how many stand there, and two stand there whether the
			// Compiler can read them or not — so this is admitted for exactly
			// the reason the Records above are, and refusing it was the same
			// mistake asked of a different shape.
			it("should admit a List whose items the Program computes", () => {
				expect(
					diagnosticsFor(
						withCountOf(`
							constant one = { x = 1 }

							function made() -> { x: Integer } {
								<- { x = 2 }
							}

							Terminal.inspect(countOf([one, made()]))
						`),
					),
				).toEqual([])
			})

			// NOTE: And a Record whose member is computed, which is the same
			// claim one level in: the List still holds one item.
			it("should admit a Record item with a computed member", () => {
				expect(
					diagnosticsFor(
						withCountOf(`
							constant n = 1

							Terminal.inspect(countOf([{ x = n }]))
						`),
					),
				).toEqual([])
			})

			// NOTE: A written List of written Lists is counted at every level it
			// is written at, and each level is its own question: `[[]]` holds
			// one item, so the outer List is admitted — while the empty List
			// inside it, asked the same question in its own right, is refused
			// for holding none.
			it("should count a written List of written Lists at each level", () => {
				let source = (inner: string) => `implementation {
					type Filled<Item> = List<Item> where @::hasItems()

					constant outer: Filled<List<{ x: Integer }>> = [${inner}]
					constant inside: Filled<{ x: Integer }> = ${inner}

					Terminal.inspect(outer::length()::add(inside::length()))
				}`

				expect(diagnosticsFor(source("[{ x = 1 }]"))).toEqual([])
				expect(diagnosticsFor(source("[]"))).toHaveLength(1)
			})

			// NOTE: The one List a count refuses, and the reason the count is
			// worth reading at all.
			it("should still refuse the empty List", () => {
				expect(
					diagnosticsFor(
						withCountOf(
							"constant broken: Filled<{ x: Integer }> = []",
						),
					),
				).toHaveLength(1)
			})

			// NOTE: The base is asked as it always was, so a List of the wrong
			// Records is refused for its Type rather than admitted for its
			// length.
			it("should refuse a written List of the wrong Records", () => {
				expect(
					diagnosticsFor(
						withCountOf(
							"constant broken: Filled<{ x: Integer }> = [{ y = 1 }]",
						),
					),
				).toHaveLength(1)
			})
		})
	})
})
