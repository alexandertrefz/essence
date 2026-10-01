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

// The single-line text a Label underlines, so a test can check the span
// without counting columns.
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
			// Optional is a nominal Choice, not its payload in a Union, so
			// neither is assignable to the other.
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
			// The Choice keeps the two levels of a nested Optional apart:
			// `#Value(#Empty)` is not `#Empty`, and only
			// `NestedOptional::flatten` collapses one into the other. So a
			// `List<Optional<Integer>>` can say whether `firstItem()` found an
			// empty Optional or found nothing at all.
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

		// The Quick Fix writes one Handler per entry in order, so `data` keeps
		// the Union's declaration order.
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

		// A Matcher covers every application of its Case, so a second Handler
		// for another application would be unreachable.
		it("should name a Case two applications leave unhandled once", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Box<Item> { Full { item: Item }, Empty }

				function describe(_ b: Box<Integer> | Box<String>) -> String {
					<- match b -> String {
						case #Empty { <- "empty" }
					}
				}
			}`)

			expect(diagnostics[0].helps).toEqual([
				"Add 'case Box#Full', or a 'case _' that covers the rest.",
			])
			expect(diagnostics[0].data).toEqual({
				kind: "missing-case",
				unhandled: ["Box#Full"],
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

		// A body promising the unit Type `{}` may fall off its end, and the
		// Simplifier appends the Return.
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

	// A free Function's Arguments are matched by label before Type. A callee
	// with one signature has no Overload to choose, so the Validator reports
	// the label, with the whole signature in the note.
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

		// The pair decides which edit the Quick Fix offers, so both the expected
		// and the written label are carried.
		it("should carry the expected label and the written one", () => {
			let shout = (call: string) => `implementation {
				function shout (about topic: String) -> String {
					<- topic
				}

				Terminal.inspect(${call})
			}`

			expect(
				diagnosticsFor(shout('shout(regarding "hi")'))[0].data,
			).toEqual({
				kind: "expected-label",
				label: "about",
				written: "regarding",
			})

			expect(diagnosticsFor(shout('shout("hi")'))[0].data).toEqual({
				kind: "expected-label",
				label: "about",
				written: null,
			})

			expect(
				diagnosticsFor(`implementation {
					function shout (_ topic: String) -> String {
						<- topic
					}

					Terminal.inspect(shout(about "hi"))
				}`)[0].data,
			).toEqual({
				kind: "expected-label",
				label: null,
				written: "about",
			})
		})

		// The label is reported first, since it decides which Parameter's Type
		// the Argument is compared with.
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

	// List items, Record members and the sides of a Combination hold whole
	// Expressions, so the walk must descend into them.
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
			// The Warning is on the second `case Integer`, which never runs.
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

		// Types erase, so a Generic Matcher's check is always true and every
		// later Case is dead. It is an Error rather than a dead-code Warning,
		// since the Program would answer with the wrong value.
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
			// Untagged, since `unnecessary` would grey out a Case that needs
			// reordering rather than removing.
			expect(diagnostics[0].tags).toBeUndefined()
			// On `case String`, which never runs, pointing back at the Generic
			// Case.
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

		// A Function-typed member is checked only for being callable, so of two
		// Cases naming differently-signed callbacks the first swallows the
		// second in either order. Reordering can not fix it.
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
			// No Guard is offered: on the later Case it changes nothing, and on
			// the earlier one it leads to `missing-case`.
			expect(diagnostics[0].helps).toEqual([
				"Tell the two Cases apart by a member that survives to runtime — a member whose Type is not a Function.",
			])
		})

		// The Case spelling of the callback conflict is refused as the Record
		// spelling is, since the analysis reads the payload requirement too.
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

		// A requirement that narrows survives to runtime, so the arm declines
		// payloads it does not name, as the Record spelling does.
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

		// The Enricher refuses an Alias hiding a refinement as a Matcher before
		// this analysis sees it. `enricher.spec.ts` pins that refusal.

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

		// A Guard can decline what its Matcher accepted, so a Guarded Generic
		// Case leaves later Cases reachable.
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

	// Item Types erase, so `case List<String>` accepts an empty
	// `List<Integer>`, which assignability calls impossible. A Warning says
	// so.
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
			// On `case List<Integer>`, which misses the empty Lists, pointing
			// back at the Case that takes them.
			expect(diagnostics[0].position?.start.line).toBe(7)
			expect(diagnostics[0].labels[1]?.position.start.line).toBe(6)
		})

		// Every List with items still reaches the Case, so it is not greyed
		// out.
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

		// The payload spelling of the List crossover warns as the Record
		// spelling does.
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

		// A member narrowed by Type takes exactly the values it names, with no
		// erasure, so nothing is reported.
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

		// Guarded Cases take nothing away from the Cases below them, so
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

	// A Match on an Integer or a String has no Union to be exhaustive over, so
	// its shape stands in. The last Case is where a refinement's evidence is
	// read.
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

		// A Case naming the matched Type is `case _` spelled out.
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
			// On the Matcher that can not stand there, not on the Match.
			expect(diagnostics[0].position?.start.line).toBe(5)
		})

		// A Guard decides after the value matched, so a Guarded value Case could
		// pass its value to later Cases whose evidence excludes it.
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

		// The Case is compared to the matched value, so this is the mistake
		// `n::is("zero")` would be.
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

		// A refinement holds its base's values, so a Match takes them apart the
		// same way, and the Cases add to its evidence.
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

		// A Match on a Boolean is an `if` written the long way, and a Boolean
		// is no refinable base.
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

		// A Match on an Integer naming no value has one outcome.
		it("should keep refusing a Match that names no value", () => {
			let diagnostics = diagnosticsFor(match(`case _ { <- "any" }`))

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("match-on-non-union")
		})
	})

	// A Union receiver's dispatch branches are unwritten Cases. The first that
	// fits the runtime Type wins, so a branch can swallow a later one.
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
				namespace IntegerTally for List<Integer> {
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
					namespace IntegerTally for List<Integer> {
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

		// The receiver is bound to a `List` Type, since a written List would
		// prove an item and `firstItem` would answer it bare.
		it("should accept declared Types matching inferred return Types", () => {
			expect(
				diagnosticsFor(`implementation {
					constant texts: List<String> = ["x"]
					constant a: Optional<String> = texts::firstItem()
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

		// The divisors are computed as differences. A written divisor proves it
		// is not zero and reaches the entry answering a bare Rational, which is
		// asserted alongside.
		it("should type Divisions as Optional<Rational>", () => {
			expect(
				diagnosticsFor(`implementation {
					constant two = 3::subtract(1)

					constant a: Optional<Rational> = 1::divide(by two)
					constant b: Optional<Rational> = 1/2::divide(by two)
					constant c: Optional<Rational> = Rational.of(1, over two)
					constant d: Rational = Rational.of(1, over 2)
					constant e: Rational = 1::divide(by 2)
					constant f: Rational = 1/2::divide(by 2)
				}`),
			).toEqual([])

			let diagnostics = diagnosticsFor(`implementation {
				constant two = 3::subtract(1)

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
			// `firstItem()` answers `Optional<Item>`, and the payload binding
			// carries `Item` out of the Match. The Choice's two Cases make it
			// exhaustive.
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
			// The conformance's `where` bound puts hidden conformance Parameters
			// on its Method, which can then not be a value.
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

	// A Namespace is emitted as a `class`, so its name holds nothing until the
	// Declaration runs.
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

		// A predicate is asked of a value, never run where it is written.
		it("leaves a refinement's predicate naming a Namespace declared below it alone", () => {
			expect(
				diagnosticsFor(`implementation {
				type Small = Integer where @::isSmall()

				namespace Smalls for Integer {
					isSmall() -> Boolean { <- @::isLessThan(10) }
				}
			}`),
			).toEqual([])
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

		// A conformance witness names a Namespace the source does not spell:
		// `things::sort()` emits `{ compare: Thing.compare }`.
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
			// The Method the witness is passed to, and the Namespace it reads its
			// Method off, since neither place spells the other.
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
			// The call handing the witness over is underlined, not the
			// `items::sort()` using it, since the call is what can be moved.
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
			// The witness `boxes::sort()` is built from both Namespaces, so the
			// secondary Label tells the two Diagnostics apart.
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
			// No branch is written, so both Diagnostics point at the dispatched
			// call. The Label's message names the branch.
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

		// Static Properties are emitted as static fields initialised in order,
		// so reading a later one from an earlier one would answer `undefined`.
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
				// A Method is installed with the class, ahead of every
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

			// A Property holding a Function is called through the Lookup that
			// reads it, so the call examines it.
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

	// What a call leaving an Argument out is judged against, and what a
	// signature taking a range of Argument counts reports.
	describe("Default Parameter Values", () => {
		// In the Parameter's declaration order, since a scaffold writes the
		// members in the order it is given.
		it("should carry the missing members of a partial Argument", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Options = { host: String, port: Integer, retries: Integer }

				function connect(using options: Options = { retries = 3 }) -> Integer {
					<- options.port
				}

				constant opened = connect(using { retries = 1 })
			}`)

			expect(diagnostics[0].code).toBe("incomplete-record-argument")
			expect(diagnostics[0].data).toEqual({
				kind: "missing-members",
				names: ["host", "port"],
			})
		})

		it("should accept a call that omits a default", () => {
			expect(
				diagnosticsFor(`implementation {
					function f(_ count: Integer = 1) -> Integer {
						<- count
					}

					constant value = f()
				}`),
			).toEqual([])
		})

		it("should still refuse a call that omits a required Argument", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function f(_ a: Integer, _ b: Integer = 1) -> Integer {
					<- a
				}

				constant value = f()
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-count-mismatch")
		})

		// Every Argument mismatch and `no-matching-overload` note reads this
		// one description, so a signature reads alike everywhere.
		it("should describe a signature by the range of counts it takes", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function f(_ a: Integer, _ b: Integer = 1) -> Integer {
					<- a
				}

				constant value = f(1, 2, 3)
			}`)

			expect(diagnostics[0].notes[0]).toBe(
				"The signature takes 1 or 2 Arguments: Parameter 1 is Integer, Parameter 2 is Integer, which may be left out.",
			)
		})

		it("should describe a wider range as a span", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function f(_ a: Integer, to b: Integer = 1, by c: Integer = 2) -> Integer {
					<- a
				}

				constant value = f(1, to 2, by 3, 4)
			}`)

			expect(diagnostics[0].notes[0]).toContain("takes 1 to 3 Arguments")
		})

		it("should name the Parameter an Argument was actually paired with", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function cut(from start: Integer = 0, to end: String) -> String {
					<- end
				}

				constant value = cut(to 3)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
			expect(diagnostics[0].message).toBe(
				"This Argument does not fit Parameter 'to'",
			)
		})

		// `checkCommittedOverload` re-matches a committed call's Arguments. A
		// defaulted call writes fewer Arguments than Parameters, which the
		// re-match must accept.
		it("should not throw re-matching a committed defaulted Overload", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Sizes for Integer {
						overload widen {
							(_ by: Integer = 1) -> Integer {
								<- @::add(by)
							}

							(_ by: String) -> Integer {
								<- @
							}
						}
					}

					constant value = Sizes.widen(1)
				}`),
			).toEqual([])
		})
	})

	// No source reaches the cross-checks while the Compiler is right. So each
	// failing case edits a typed Program by hand into a state no source
	// produces.
	describe("Compiler cross-checks", () => {
		function enrichedProgram(source: string): common.typed.Program {
			let { program, diagnostics } = enrich(parse(source))

			expect(diagnostics).toEqual([])

			return program
		}

		// Every Node of the typed Program, walked structurally, wherever it
		// stands.
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

		// Each branch of the Union receiver binds the enclosing Function's
		// bounded Type Parameter, so all forward one hidden conformance.
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

			// A dropped witness: the Method still expects its hidden trailing
			// Argument.
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
				"'NonEmptyList::sort' was given 0 conformance Arguments for a Signature with 1 Protocol-bounded Type Parameter",
			)
		})

		it("reports a call typed before its callee's Signature was woven", () => {
			let program = enrichedProgram(`implementation {
				namespace Counting for List<Integer> {
					total() -> Integer { <- @::length() }
				}

				Terminal.inspect([1, 2]::total())
			}`)

			// A conditional conformance woven in after the call was typed. The
			// shared Namespace Type now names a Method that wants a witness.
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

			// The Declaration loses its bound while the call inside still
			// forwards `Item__conformance`, which nothing binds.
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

		// Two Overloads accept the same Argument, so only the Node says which
		// was committed. A third accepts nothing the call passes.
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

			// An Overload a re-match would never reach. The Simplifier mangles
			// the callee from this index, so the Validator must check this one.
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

		// The re-match reads labels too. `loop`'s `while` and `until` entries
		// differ only in the middle label, so only a label-aware re-match refuses
		// a `while` call committed to the `until` entry.
		it("re-matches a labelled free-Function call by its labels", () => {
			let program = enrichedProgram(`implementation {
				Terminal.inspect(loop(
					startingWith 1,
					while (n) { <- n::isLessThan(4) },
					(n) { <- n::add(1) },
				))
			}`)
			let calls = overloadedCalls(program)

			expect(
				calls.map((call) =>
					call.arguments.map((argument) => argument.name),
				),
			).toEqual([["startingWith", "while", null]])
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

			// A branch carries its own witnesses and its own Arguments, so
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

	// A written value carries its own evidence, so the predicate is decided
	// while compiling and no source here needs an `if`. The Validator's part is
	// the refusal, which names the predicate.
	describe("Checked refinements", () => {
		function withRefinements(body: string): string {
			return `implementation {
				type NonZero = Integer where @::isNot(0)
				type NonEmptyText = String where @::hasCharacters()
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

		// Every standard library refinement predicate, asked of a written value.
		// Each is stored resolved, as `isNot` is `is` negated, so the evaluator
		// answers a few primitives.
		describe("the predicates the standard library declares", () => {
			function codesFor(declared: string, value: string): Array<string> {
				return diagnosticsFor(
					`implementation { constant admitted: ${declared} = ${value} }`,
				).map((diagnostic) => diagnostic.code)
			}

			it("should admit a written value each Alias holds of", () => {
				expect(codesFor("NonZeroInteger", "5")).toEqual([])
				expect(codesFor("NonNegativeInteger", "0")).toEqual([])
				expect(codesFor("PositiveInteger", "7")).toEqual([])
				expect(codesFor("NonEmptyString", '"x"')).toEqual([])
				expect(codesFor("NonEmptyList<Integer>", "[1]")).toEqual([])
			})

			it("should refuse a written value each Alias refuses", () => {
				expect(codesFor("NonZeroInteger", "0")).toEqual([
					"assignment-type-mismatch",
				])
				expect(codesFor("NonNegativeInteger", "-1")).toEqual([
					"assignment-type-mismatch",
				])
				expect(codesFor("PositiveInteger", "0")).toEqual([
					"assignment-type-mismatch",
				])
				expect(codesFor("NonEmptyString", '""')).toEqual([
					"assignment-type-mismatch",
				])
				expect(codesFor("NonEmptyList<Integer>", "[]")).toEqual([
					"assignment-type-mismatch",
				])
			})

			// And a Program's own alias of a primitive is decided by the
			// leaf it forwards to, exactly as the standard library's are.
			it("should decide a Program's own alias by what it forwards to", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Stock for Integer {
						isInStock() -> Boolean {
							<- @::isGreaterThan(5)
						}
					}

					type Stocked = Integer where @::isInStock()

					constant kept: Stocked = 9
					constant refused: Stocked = 1
				}`)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["assignment-type-mismatch"])
			})

			// An alias forwarding its bound is decided with the bound written in.
			// The Diagnostic names the predicate as the reader wrote it.
			it("should decide a Program's own alias by the bound it forwards", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Stock for Integer {
						isAtLeast(_ n: Integer) -> Boolean {
							<- @::isLessThan(n)::negate()
						}
					}

					type Healthy = Integer where @::isAtLeast(5)

					constant kept: Healthy = 5
					constant refused: Healthy = 4
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("assignment-type-mismatch")
				expect(diagnostics[0].notes).toEqual([
					"'refused' is declared as Healthy.",
					"Every value of 'Healthy' has been proven to answer '@::isAtLeast(5)'.",
				])
			})
		})

		it("should report a zero denominator in a refinement's predicate", () => {
			let source = `implementation {
				type Weird = Integer where @::isGreaterThan(1/0)
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"zero-denominator",
			])
			expect(underlinedBy(source, diagnostics[0]?.labels[0])).toBe("1/0")
		})

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

		// A committed Overload whose Arguments do not match is an ICE here, so
		// the Validator must admit what the Enricher admitted.
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

		// A static Property's initialiser is admitted and refused as a
		// Constant Declaration is.
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

		// String and List predicates read a written value as plainly as an
		// Integer's.
		it("should admit a written String and a written List", () => {
			expect(
				diagnosticsOfBody(`
					function shouted(_ text: NonEmptyText) -> String {
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

		// `isBetween` is `Orderable`'s provided Method. Its conjunct is keyed
		// under `Integer`, the Namespace whose conformance put it in reach.
		it("should admit a predicate a Protocol provides to the base's Namespace", () => {
			expect(
				diagnosticsOfBody(`
					function placed(_ digit: Digit) -> Integer {
						<- digit::add(1)
					}

					Terminal.inspect(placed(7))
				`),
			).toEqual([])
		})

		// `Orderable::isBetween` reads its bounds in either order, so a
		// refinement written backwards admits the same values.
		it("should read a pair of bounds either way round", () => {
			let source = `implementation {
				type Backwards = Integer where @::isBetween(9, and 0)

				function placed(_ digit: Backwards) -> Integer {
					<- digit::add(1)
				}

				Terminal.inspect(placed(7))
			}`

			expect(diagnosticsFor(source)).toEqual([])
			expect(
				diagnosticsFor(source.replace("placed(7)", "placed(11)")),
			).toHaveLength(1)
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

		// Conjuncts are resolved to their leaves and sorted, and spelled back in
		// that order. `isOdd` sorts under `isEven`, the leaf it negates, but
		// prints under its own name.
		it("should name every conjunct of the predicate it refused", () => {
			let diagnostics = diagnosticsOfBody(`
				function tripled(_ n: SmallOdd) -> Integer {
					<- n::multiply(with 3)
				}

				Terminal.inspect(tripled(12))
			`)

			expect(diagnostics[0].helps).toEqual([
				"Check '@::isOdd()::and(@::isLessThan(10))' on the value in an 'if' or a 'match', or pass a value that already has Type 'SmallOdd'.",
			])
		})

		// A name is a value the Program computes, and deciding it would need an
		// interpreter.
		it("should refuse a value the Program computes", () => {
			expect(
				diagnosticsOfBody(`
					constant three = 3
					constant d: NonZero = three
				`),
			).toHaveLength(1)
		})

		// `[first]` holds one item whatever `first` is, so the brackets decide
		// `hasItems`.
		it("should admit a List whose items are not written", () => {
			expect(
				diagnosticsOfBody(`
					constant first = "a"
					constant items: NonEmptyStrings = [first]
				`),
			).toEqual([])
		})

		// A name standing for a whole List has no brackets to count.
		it("should refuse a List the Program computes", () => {
			expect(
				diagnosticsOfBody(`
					constant written = ["a"]
					constant items: NonEmptyStrings = written
				`),
			).toHaveLength(1)
		})

		// Evidence is not something a Program can ask for and be given. The
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

		// The standard library compares an Integer with a Rational by value, so a
		// fraction bound decides a written Integer exactly.
		describe("a fraction bound on an Integer", () => {
			function codesFor(predicate: string, value: string): Array<string> {
				return diagnosticsFor(`implementation {
					type Bounded = Integer where ${predicate}

					function placed(_ value: Bounded) -> Integer {
						<- value::add(1)
					}

					Terminal.inspect(placed(${value}))
				}`).map((diagnostic) => diagnostic.code)
			}

			// This `isLessThan` is Integer's Rational entry.
			it("should decide Integer's own comparison", () => {
				expect(codesFor("@::isLessThan(5/2)", "2")).toEqual([])
				expect(codesFor("@::isLessThan(5/2)", "3")).toEqual([
					"argument-type-mismatch",
				])
			})

			// A fraction bound is no Integer, so this `isBetween` is the one
			// `Number`'s conformance answers.
			it("should decide the comparison Number answers", () => {
				expect(codesFor("@::isBetween(0, and 9/2)", "4")).toEqual([])
				expect(codesFor("@::isBetween(0, and 9/2)", "5")).toEqual([
					"argument-type-mismatch",
				])
			})
		})

		// String equality is canonical equivalence over NFC, so a composed and a
		// decomposed accent are one String. The evaluator must agree, or `isNot`
		// would prove something false.
		it("should compare a written String the way the Program does", () => {
			// Escapes, since an editor may print the two alike.
			let composed = "\u00e9"
			let decomposed = "e\u0301"
			let source = (predicate: string) => `implementation {
				type Accented = String where @::${predicate}("${composed}")

				constant text: Accented = "${decomposed}"
			}`

			expect(diagnosticsFor(source("is"))).toEqual([])
			expect(diagnosticsFor(source("isNot"))).toHaveLength(1)
		})

		// A generic refinement uses the same evaluator: the predicate reads the
		// item count, and the base compares the Type Arguments.
		describe("a generic refinement", () => {
			function withFilled(body: string): string {
				return `implementation {
					type Filled<Item> = List<Item> where @::hasItems()

					function firstOf(_ items: Filled<String>) -> String {
						<- items::item(at 0)::value(defaultingTo "")
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

			// The refusal names the applied Type, since a bare `Filled` takes no
			// Arguments and is no Type.
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

			// The base is asked too, since `[1]::hasItems()` says nothing about a
			// List of Strings.
			it("should refuse a written List of the wrong items", () => {
				expect(
					diagnosticsFor(
						withFilled("constant broken: Filled<String> = [1]"),
					),
				).toHaveLength(1)
			})

			// With a Type Parameter the call infers, the base `List<Item>` is not
			// yet a Type. The value is asked about the refinement its own Type
			// decides, and binds `Item` as an unrefined `List<Item>` would.
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

				// The refusal names the Type as the Declaration spells it, with its
				// Parameter, since a bare `Filled` is no Type.
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

				// An `Item` the call can not bind is the Declaration's opaque
				// symbol. The admission answers `Filled<String>`, which ordinary
				// assignability refuses for `Filled<Item>`.
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

			// Two applications of one Alias are two questions about one written
			// List, each answer kept apart for the Overload probes.
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

		// A refinement written as a Type Argument comes back out as itself, so
		// a Type Parameter bound off it keeps the proof. At the outermost
		// position a Generic inferred from a refined Argument binds the base.
		describe("as a Type Argument", () => {
			function withGroups(body: string): string {
				return `implementation {
					function groups() -> List<NonEmptyList<Integer>> {
						<- []
					}

					${body}
				}`
			}

			// Read by asking for a Boolean, which nothing here is: the
			// Diagnostic then names the Type the expression really has.
			function typeOf(expression: string): string {
				let diagnostics = diagnosticsFor(
					withGroups(`constant probe: Boolean = ${expression}`),
				)

				return diagnostics[0]?.labels[0]?.message ?? "no Diagnostic"
			}

			it("should answer the item's proof back out of the List", () => {
				expect(typeOf("groups()::firstItem()")).toBe(
					"this is an Optional<NonEmptyList<Integer>>",
				)
			})

			it("should hand a transform the proven item Type", () => {
				expect(
					typeOf("groups()::map((inner) { <- inner::firstItem() })"),
				).toBe("this is a List<Integer>")
			})

			// Both proofs are read without a branch: the written List's item is
			// proven, and the outer proof is its own count.
			it("should spend both proofs of a proven List of proven Lists", () => {
				expect(
					diagnosticsFor(`implementation {
						function groups() -> NonEmptyList<NonEmptyList<Integer>> {
							constant inner: NonEmptyList<Integer> = [1]

							<- [inner]
						}

						Terminal.inspect(groups()::firstItem()::firstItem())
					}`),
				).toEqual([])
			})

			// A `List<NonEmptyList<Integer>>` is a `List<List<Integer>>`, so a
			// Namespace over the base still answers.
			it("should still reach a Namespace written over the base", () => {
				expect(typeOf("groups()::flatten()")).toBe(
					"this is a List<Integer>",
				)
			})

			// A walk's State binds the base, or the seed's proof would refuse
			// every step answering an ordinary value.
			it("should still bind a threaded Type Parameter to the base", () => {
				expect(
					diagnosticsFor(`implementation {
						constant half: Rational = 1/2
						constant seed = half::denominator()

						constant answer = loop(from 1, through 3, startingWith seed, (
							_index,
							carried,
						) { <- carried::add(carried) })

						Terminal.inspect(answer)
					}`),
				).toEqual([])
			})

			// What comes back out goes back in: a proven or written value fits an
			// `ItemType` bound to a refinement, and an unproven List does not.
			it("should take a proven item back where the item Type stands", () => {
				expect(
					diagnosticsFor(
						withGroups(`constant proven: NonEmptyList<Integer> = [9]

						Terminal.inspect(groups()::append(proven))
						Terminal.inspect(groups()::append([9]))
						Terminal.inspect(groups()::contains(proven))
						Terminal.inspect(groups()::firstItem(defaultingTo [9]))`),
					),
				).toEqual([])
			})

			// Refused where the Method is resolved, so these read the Enricher's
			// Diagnostics.
			it("should refuse an item nothing proves has anything in it", () => {
				let refusals = (body: string) =>
					enrich(parse(withGroups(body))).diagnostics.map(
						(diagnostic) => diagnostic.code,
					)

				expect(
					refusals(`constant plain: List<Integer> = [9]

						Terminal.inspect(groups()::append(plain))`),
				).toEqual(["no-matching-overload"])
				expect(
					refusals("Terminal.inspect(groups()::append([]))"),
				).toEqual(["no-matching-overload"])
			})
		})

		// A written List decides its length, which is all the List predicates
		// read. With no spread, `[x, y]` holds two items whatever they are, so an
		// unwritten item stands opaque.
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

			// Every part is written down, and the predicate asks nothing of the
			// Record items.
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

			// The standard library's alias, where the admission makes
			// `firstItem` total.
			it("should admit a List of written Records into the builtin", () => {
				expect(
					diagnosticsFor(`implementation {
						constant proven: NonEmptyList<{ x: Integer }> = [{ x = 1 }]

						Terminal.inspect(proven::firstItem().x)
					}`),
				).toEqual([])
			})

			// An item nobody wrote out is still an item, and the count asks only
			// how many stand there.
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

			// And a Record whose member is computed, which is the same
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

			// Each written level is its own question: `[[]]` holds one item, so
			// the outer List is admitted and the empty inner List is refused.
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

			// The one List a count refuses, and the reason the count is
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

			// The base is still asked, so a List of the wrong Records is refused
			// for its Type.
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

		// A written List under a refined item Type is asked item by item.
		// `[[1], [2, 3]]` is a `List<NonEmptyList<Integer>>` by its brackets.
		describe("into a refined item Type", () => {
			it("should admit every written item at all three positions", () => {
				expect(
					diagnosticsFor(`implementation {
						function widest(_ groups: List<NonEmptyList<Integer>>) -> Integer {
							<- groups::length()
						}

						function made() -> List<NonEmptyList<Integer>> {
							<- [[1], [2, 3]]
						}

						constant written: List<NonEmptyList<Integer>> = [[1], [2, 3]]

						Terminal.inspect(widest(written))
						Terminal.inspect(widest([[1], [2, 3]]))
						Terminal.inspect(widest(made()))
					}`),
				).toEqual([])
			})

			// Both proofs at once, the Type `split(intoGroupsOf:)` answers.
			it("should admit a written List into a proven List of proven Lists", () => {
				expect(
					diagnosticsFor(`implementation {
						constant groups: NonEmptyList<NonEmptyList<Integer>> = [[1], [2]]

						Terminal.inspect(groups::firstItem()::firstItem())
					}`),
				).toEqual([])
			})

			// The refusal points at the item whose predicate went unanswered.
			it("should refuse an empty item, pointing at it", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant broken: List<NonEmptyList<Integer>> = [[1], []]
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("assignment-type-mismatch")
				expect(diagnostics[0].labels[1]?.kind).toBe("secondary")
				expect(diagnostics[0].labels[1]?.message).toBe(
					"this item is a List<Unknown>",
				)
				expect(diagnostics[0].notes).toEqual([
					"'broken' is declared as List<NonEmptyList<Integer>>.",
					"Every item has to be a NonEmptyList<Integer>, and every value of that Type has been proven to answer '@::hasItems()'.",
				])
				expect(diagnostics[0].helps).toEqual([
					"Check '@::hasItems()' on the item in an 'if' or a 'match', or write an item that already has Type 'NonEmptyList<Integer>'.",
				])
			})

			// An item nobody wrote out is judged by its Type, since brackets say
			// how many items there are, never what one is.
			it("should judge an item the Program computes by its Type", () => {
				let source = (answer: string) => `implementation {
					function made() -> ${answer} {
						<- [7]
					}

					constant groups: List<NonEmptyList<Integer>> = [[1], made()]

					Terminal.inspect(groups::length())
				}`

				expect(diagnosticsFor(source("NonEmptyList<Integer>"))).toEqual(
					[],
				)

				let refused = diagnosticsFor(source("List<Integer>"))

				expect(refused).toHaveLength(1)
				expect(refused[0].labels[1]?.message).toBe(
					"this item is a List<Integer>",
				)
			})

			// The empty written List decides nothing about its items and
			// needs to decide nothing: it has none, and every List Type already
			// accepts it.
			it("should keep the empty written List assignable", () => {
				expect(
					diagnosticsFor(`implementation {
						constant none: List<NonEmptyList<Integer>> = []

						Terminal.inspect(none::length())
					}`),
				).toEqual([])
			})

			// A written Rational item answers for itself as a written Integer
			// does, asked by its base's own rung.
			it("should admit written Rational items into a refined item Type", () => {
				expect(
					diagnosticsFor(`implementation {
						constant ratios: List<NonZeroRational> = [1/2, 2/4]

						Terminal.inspect(ratios::length())
					}`),
				).toEqual([])

				let refused = diagnosticsFor(`implementation {
					constant ratios: List<NonZeroRational> = [1/2, 0/3]

					Terminal.inspect(ratios::length())
				}`)

				expect(refused).toHaveLength(1)
				expect(refused[0].labels[1]?.message).toBe(
					"this item is a Rational",
				)
			})

			// Where the call infers the item's Type Arguments, the items decide
			// them.
			it("should decide a Type Argument the call infers from the items", () => {
				expect(
					diagnosticsFor(`implementation {
						type Filled<Item> = List<Item> where @::hasItems()

						function countOf<infer Item>(_ groups: List<Filled<Item>>) -> Integer {
							<- groups::length()
						}

						Terminal.inspect(countOf([["a"], ["b", "c"]]))
					}`),
				).toEqual([])
			})
		})
	})
})

// A `= expression` default runs in the body's frame, so it is held to
// everything the body is held to.
describe("A default's own Expression", () => {
	it("should have its calls checked for how many Arguments they pass", () => {
		let diagnostics = diagnosticsFor(`implementation {
			function twice(_ text: String) -> String {
				<- text::append(text)
			}

			function greet(_ name: String = twice("one", "two")) -> String {
				<- name
			}
		}`)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"argument-count-mismatch",
		])
	})

	it("should have its calls checked for the Types they pass", () => {
		let diagnostics = diagnosticsFor(`implementation {
			function twice(_ text: String) -> String {
				<- text::append(text)
			}

			function greet(_ name: String = twice(1)) -> String {
				<- name
			}
		}`)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"argument-type-mismatch",
		])
	})

	it("should have a Match written in it checked for exhaustiveness", () => {
		let diagnostics = diagnosticsFor(`implementation {
			choice Edge {
				Front,
				Back,
			}

			function edge(at side: Edge, of fallback: Integer = match side -> Integer {
				case Edge#Front { <- 0 }
			}) -> Integer {
				<- fallback
			}
		}`)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"missing-case",
		])
	})
})

// A native Method has no body. The frame synthesized for its defaults is the
// only Essence it owns, and is checked as any Program is.
describe("A default written on a native signature", () => {
	// Only a `declarations { … }` Program can hold a native signature.
	function declarationDiagnosticsFor(
		source: string,
	): Array<common.Diagnostic> {
		let { program, diagnostics } = enrich(
			parse(source, { allowDeclarationsHeader: true }),
		)

		expect(diagnostics).toEqual([])

		return validate(program)
	}

	it("should be checked like any other Expression", () => {
		let diagnostics = declarationDiagnosticsFor(`declarations {
			function twice(_ text: String) -> String {
				<- text::append(text)
			}

			namespace Texts for String {
				padded(with filler: String = twice("a", "b")) -> String
			}
		}`)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"argument-count-mismatch",
		])
	})

	it("should accept one that fits", () => {
		expect(
			declarationDiagnosticsFor(`declarations {
			function twice(_ text: String) -> String {
				<- text::append(text)
			}

			namespace Texts for String {
				padded(with filler: String = twice("a")) -> String
			}
		}`),
		).toEqual([])
	})
})

// A path key in a Literal merged into a default reaches into a rebuilt
// member. Whether the default reaches that far depends on the Parameter or
// Case the Literal was committed to.
describe("A path key merged into a default", () => {
	const server = `type Server = { host: String, port: Integer }
		type Options = { retries: Integer, server: Server }`

	function connect(defaultValue: string): string {
		return `§§ Answers the address.
		§§
		§§ @param using — how to connect.
		§§ @returns — the address.
		function connect(using options: Options = ${defaultValue}) -> String {
			<- options.server.host
		}`
	}

	it("should accept a path into a member the default writes out", () => {
		expect(
			diagnosticsFor(`implementation {
				${server}
				${connect(`{ retries = 3, server = { host = "d", port = 80 } }`)}

				constant a = connect(using { server.port = 1 })
			}`),
		).toEqual([])
	})

	it("should accept a path two levels into one", () => {
		expect(
			diagnosticsFor(`implementation {
				type Tls = { enabled: Boolean }
				type Server = { port: Integer, tls: Tls }
				type Options = { server: Server }

				§§ Answers the port.
				§§
				§§ @param using — how to connect.
				§§ @returns — the port.
				function connect(
					using options: Options = {
						server = { port = 80, tls = { enabled = false } },
					},
				) -> Integer {
					<- options.server.port
				}

				constant a = connect(using { server.tls.enabled = true })
			}`),
		).toEqual([])
	})

	it("should refuse a path into a member no default fills in", () => {
		let source = `implementation {
			${server}
			${connect(`{ retries = 3 }`)}

			constant a = connect(using { server.port = 1 })
		}`
		let diagnostics = diagnosticsFor(source)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"path-key-without-default",
		])
		expect(underlinedBy(source, diagnostics[0].labels?.[0])).toBe("server")
	})

	it("should refuse a path into a member the default only names", () => {
		let diagnostics = diagnosticsFor(`implementation {
			${server}

			constant fallback: Server = { host = "d", port = 80 }

			${connect(`{ retries = 3, server = fallback }`)}

			constant a = connect(using { server.port = 1 })
		}`)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"path-key-without-default",
		])
	})

	// The default writes `server` out but leaves `tls` to a name, so the
	// merge stops one level short of where the path reaches.
	it("should refuse a path past where the default stops writing", () => {
		let diagnostics = diagnosticsFor(`implementation {
			type Tls = { enabled: Boolean }
			type Server = { port: Integer, tls: Tls }
			type Options = { server: Server }

			constant plain: Tls = { enabled = false }

			§§ Answers the port.
			§§
			§§ @param using — how to connect.
			§§ @returns — the port.
			function connect(
				using options: Options = { server = { port = 80, tls = plain } },
			) -> Integer {
				<- options.server.port
			}

			constant a = connect(using { server.tls.enabled = true })
		}`)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"path-key-without-default",
		])
	})

	it("should refuse a step that is not a Record", () => {
		let diagnostics = diagnosticsFor(`implementation {
			${server}
			${connect(`{ retries = 3, server = { host = "d", port = 80 } }`)}

			constant a = connect(using { retries.length = 1, server.port = 1 })
		}`)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"path-step-not-a-record",
		])
	})

	// A Function taken as a value drops its defaults, so there is nothing to
	// merge with.
	it("should refuse a path through a Function value", () => {
		let diagnostics = diagnosticsFor(`implementation {
			${server}
			${connect(`{ retries = 3, server = { host = "d", port = 80 } }`)}

			constant taken: (using: Options) -> String = connect
			constant a = taken(using { server.port = 1 })
		}`)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"path-key-without-default",
		])
	})

	it("should accept a path into a Case payload's default", () => {
		expect(
			diagnosticsFor(`implementation {
				type Limits = { calls: Integer, burst: Integer }

				choice Fetch {
					Get { url: String, limits: Limits } = {
						limits = { calls = 1, burst = 2 },
					},
				}

				constant a: Fetch = #Get({ url = "/x", limits.calls = 5 })
			}`),
		).toEqual([])
	})

	it("should refuse a path into a payload member no default fills in", () => {
		let diagnostics = diagnosticsFor(`implementation {
			type Limits = { calls: Integer, burst: Integer }

			choice Fetch {
				Get { limits: Limits, quota: Limits } = {
					limits = { calls = 1, burst = 2 },
				},
			}

			constant a: Fetch = #Get({ limits.calls = 5, quota.calls = 1 })
		}`)

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"path-key-without-default",
		])
	})

	// The members the path did not write are the default's, so a payload
	// that reaches into one is not missing anything.
	it("should not call a merged payload incomplete", () => {
		expect(
			diagnosticsFor(`implementation {
				type Limits = { calls: Integer, burst: Integer }

				choice Fetch {
					Get { limits: Limits } = { limits = { calls = 1, burst = 2 } },
				}

				constant a: Fetch = #Get({ limits.calls = 5 })
			}`),
		).toEqual([])
	})
})

// Every arm of a `define` is held to the answer Type. A `define` with only an
// `otherwise` arm is a value written the long way round.
describe("A definition by cases", () => {
	it("should warn about a define whose only arm is the otherwise arm", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant grade = define {
				as "unrated" otherwise
			}
		}`)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("warning")
		expect(diagnostics[0].code).toBe("define-without-cases")
		expect(diagnostics[0].labels[0]?.message).toBe(
			"nothing here is decided by cases",
		)
	})

	// Greyed out rather than underlined, since a ladder has this shape while
	// it is being written.
	it("should tag the define as unnecessary", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant grade = define {
				as "unrated" otherwise
			}
		}`)

		expect(diagnostics[0].tags).toEqual(["unnecessary"])
	})

	it("should stay silent once the define asks something", () => {
		expect(
			diagnosticsFor(`implementation {
				constant score = 91

				constant grade = define {
					as "A" if score::isGreaterThanOrEqualTo(90)
					as "unrated" otherwise
				}
			}`),
		).toEqual([])
	})

	it("should refuse an arm the arrow's Type does not accept", () => {
		let source = `implementation {
			constant score = 91

			constant grade = define -> Integer {
				as "A" if score::isGreaterThanOrEqualTo(90)
				as 0 otherwise
			}
		}`
		let diagnostics = diagnosticsFor(source)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].code).toBe("return-type-mismatch")
		expect(diagnostics[0].labels[0]?.message).toBe("this is a String")
		expect(underlinedBy(source, diagnostics[0].labels[0])).toBe(`"A"`)
		expect(diagnostics[0].notes).toEqual(["This 'define' answers Integer."])
	})

	// The `otherwise` arm is an answer like any other, held to the
	// position's Type.
	it("should refuse an otherwise arm the position's Type does not accept", () => {
		let source = `implementation {
			constant score = 91

			constant grade: String = define {
				as "A" if score::isGreaterThanOrEqualTo(90)
				as 0 otherwise
			}
		}`
		let diagnostics = diagnosticsFor(source)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("return-type-mismatch")
		expect(underlinedBy(source, diagnostics[0].labels[0])).toBe("0")
	})

	// Where the arms decide the answer Type, it is the Union of their values.
	// Every arm fits, and a `define` inferring a Union is no mistake.
	it("should stay silent where the arms decided the Type themselves", () => {
		expect(
			diagnosticsFor(`implementation {
				constant score = 91

				constant grade = define {
					as "A" if score::isGreaterThanOrEqualTo(90)
					as 0 otherwise
				}
			}`),
		).toEqual([])
	})

	// An arm's Condition picks the path exactly as an `if` does, and is
	// held to what every Condition is held to.
	it("should refuse a Condition that is not a Boolean", () => {
		let diagnostics = diagnosticsFor(`implementation {
			constant score = 91

			constant grade = define {
				as "A" if score
				as "unrated" otherwise
			}
		}`)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("condition-not-boolean")
		expect(diagnostics[0].message).toBe(
			"A Define Condition has to be a Boolean",
		)
	})
})
