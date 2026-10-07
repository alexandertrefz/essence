import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { enrich } from "../enricher/index"
import { parse } from "../parser/index"
import { reachWork } from "../validator/declarationOrder"
import { validate } from "../validator/index"
import {
	analysedDiagnosticsFor,
	codesOfSource,
	compiles,
	firstAnalysed,
} from "./followedHelps"

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

		// `case Box<Integer>` answers for `Box<String>#Empty` too, so a Case
		// Matcher for the rest would hide that. The application is named
		// instead, and `type-argument-overlap` then reports the crossing.
		it("should name the application another application's Matcher crosses into", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Box<Item> { Full { item: Item }, Empty }

				function describe(_ b: Box<Integer> | Box<String>) -> String {
					<- match b -> String {
						case Box<Integer> { <- "integers" }
					}
				}
			}`)

			expect(diagnostics[0].helps).toEqual([
				"Add 'case Box<String>', or a 'case _' that covers the rest.",
			])
			expect(diagnostics[0].notes).toEqual([
				"Unhandled: 'Box<String>#Full'.",
			])
			expect(diagnostics[0].data).toEqual({
				kind: "missing-case",
				unhandled: ["Box<String>"],
			})
		})

		// A Matcher can not test a refinement's predicate, so the Help names
		// the base, once for every refinement of it. The Note lists the
		// members as the Union writes them.
		it("should name a refinement member by the base a Matcher can test", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Healthy = Integer where @::isGreaterThan(4)
				type Depleted = Integer where @::isLessThan(5)

				function describe(_ level: Healthy | Depleted | String) -> String {
					<- match level -> String {
						case String { <- @ }
					}
				}
			}`)

			expect(diagnostics[0].notes).toEqual([
				"Unhandled: 'Healthy', 'Depleted'.",
			])
			expect(diagnostics[0].helps).toEqual([
				"Add 'case Integer', or a 'case _' that covers the rest.",
			])
			expect(diagnostics[0].data).toEqual({
				kind: "missing-case",
				unhandled: ["Integer"],
			})
		})

		it("should list a member carrying a refinement as the Union writes it", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Healthy = Integer where @::isGreaterThan(4)

				function describe(_ levels: List<Healthy> | String) -> String {
					<- match levels -> String {
						case String { <- @ }
					}
				}
			}`)

			expect(diagnostics[0].notes).toEqual([
				"Unhandled: 'List<Healthy>'.",
			])
			expect(diagnostics[0].helps).toEqual([
				"Add 'case List<Integer>', or a 'case _' that covers the rest.",
			])
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

		// Each earlier Case claims its own member by Type, and no member Type
		// holds a Function, so nothing erased covers the dead Cases.
		it("should warn about Cases that earlier Cases cover together", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Click = { x: Integer, y: Integer }
				type KeyPress = { key: String }

				constant input: Click | KeyPress = { x = 0, y = 7 }

				Terminal.print(match input -> String {
					case { x, y } { <- "at {x}, {y}" }
					case { key } { <- "pressed {key}" }
					case { x } { <- "x {x}" }
					case _ { <- "something else" }
				})
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["unreachable-case", 10],
				["unreachable-case", 11],
			])
			expect(diagnostics[0].notes).toEqual([
				"Cases are tried in order, and the first one that fits wins.",
			])
			expect(diagnostics[0].helps).toEqual([
				"Remove this Case — the Case above answers for every value it would take, in whichever order the two are written.",
			])
			expect(diagnostics[1].notes).toEqual([
				"Cases are tried in order, and the first one that fits wins.",
			])
			expect(diagnostics[1].helps).toEqual([
				"Remove this Case — the Cases above answer for every value it would take.",
			])
			expect(
				diagnostics[1].labels.map((label) => [
					label.message,
					label.position.start.line,
				]),
			).toEqual([
				[
					"earlier Cases already answer for every Type this one matches",
					11,
				],
				["this Case runs first", 8],
				["this Case runs first", 9],
			])
		})

		it("should warn about a wildcard after every Case of a Choice", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Light { Red, Green }

				constant light: Light = #Red

				Terminal.print(match light -> String {
					case #Red { <- "red" }
					case #Green { <- "green" }
					case _ { <- "other" }
				})
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].notes).toEqual([
				"Cases are tried in order, and the first one that fits wins.",
			])
			expect(diagnostics[0].helps).toEqual([
				"Remove this Case — the Cases above answer for every value it would take.",
			])
		})

		it("should warn about a wildcard after a Case naming every member", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant either: Integer | String = 5
				constant a = match either -> Integer {
					case Integer | String { <- 1 }
					case _ { <- 0 }
				}

				Terminal.inspect(a)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].notes).toEqual([
				"Cases are tried in order, and the first one that fits wins.",
			])
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

		// `case Item` claims only the `Item` member, which it names, so nothing
		// erased covers the wildcard.
		it("should warn about a wildcard after a Generic Case that claims its own member", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function d<infer Item is Printable>(_ value: Item | Integer) -> String {
					<- match value -> String {
						case Integer { <- "number" }
						case Item { <- "item" }
						case _ { <- "other" }
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].position?.start.line).toBe(6)
			expect(diagnostics[0].helps).toEqual([
				"Remove this Case — the Cases above answer for every value it would take.",
			])
		})

		it("should warn about a Generic Case after a wildcard that claims its member", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function d<infer Item is Printable>(_ value: Item | Integer) -> String {
					<- match value -> String {
						case Integer { <- "number" }
						case _ { <- "other" }
						case Item { <- "item" }
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unreachable-case")
			expect(diagnostics[0].position?.start.line).toBe(6)
		})

		// The Type Parameter inside the Union Matcher accepts every value, so
		// the Union Matcher does too.
		it("should reject a Case shadowed by a Union Matcher naming a Type Parameter", () => {
			let source = `implementation {
				function q<infer Item is Printable>(_ v: Item | Integer | Boolean) -> String {
					<- match v -> String {
						case Item | Boolean { <- "item" }
						case Integer { <- "int" }
					}
				}
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("erased-case-conflict")
			expect(diagnostics[0].notes[1]).toBe(
				"Types erase before a Match runs, so the Generic Case 'Item | Boolean' narrows nothing and accepts every value that reaches it.",
			)
			expect(diagnostics[0].helps).toEqual([
				"Write this Case above 'case Item | Boolean', which can only ever be the last one.",
			])
			expect(
				diagnosticsFor(
					source.replace(
						`case Item | Boolean { <- "item" }
						case Integer { <- "int" }`,
						`case Integer { <- "int" }
						case Item | Boolean { <- "item" }`,
					),
				),
			).toEqual([])
		})

		// `{ a: Item }` still checks that `a` is there, but not what Type it
		// holds, so it takes every Record with an `a`. No Function is involved.
		it("should reject a Case shadowed by a Record Matcher naming a Type Parameter", () => {
			let program = (handlers: string): string => `implementation {
				function pick<infer Item>(_ value: { a: Item } | { a: Integer }) -> String {
					<- match value -> String {
						${handlers}
					}
				}

				Terminal.print(pick({ a = "x" }))
			}`
			let [diagnostic] = diagnosticsFor(
				program(`case { a: Item } { <- "item" }
						case { a: Integer } { <- "integer" }`),
			)

			expect(diagnostic?.code).toBe("erased-case-conflict")
			expect(diagnostic?.notes[1]).toBe(
				"A Record Matcher still checks that its members are present, but Types erase before a Match runs, so it can not test a member's Type against a Type Parameter — '{ a: Item }' takes 'a' whatever Type it holds.",
			)
			expect(diagnostic?.helps).toEqual([
				"Write this Case above 'case { a: Item }', which takes 'a' whatever Type it holds.",
			])
			expect(
				compiles(
					program(`case { a: Integer } { <- "integer" }
						case { a: Item } { <- "item" }`),
				),
			).toBe(true)
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

		it("should refuse a Pattern naming a member only Object.prototype has", () => {
			let { diagnostics } = enrich(
				parse(`implementation {
				type A = { x: Integer }
				type B = { y: Integer }

				constant v: A | B = { x = 1 }

				Terminal.inspect(match v -> String {
					case { hasOwnProperty } { <- "?" }
					case _ { <- "ok" }
				})
			}`),
			)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([["unknown-member", 8]])
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

		// The `case _` sees the same member, and the Guard the Help asks for
		// on the Cases above it settles both.
		it("should report the member once, on the Case written for it", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Bag {
					Items { items: List<Integer> | List<String> },
					Nothing,
				}

				function describe(_ value: Bag) -> String {
					<- match value -> String {
						case #Items({ items: List<Integer> }) { <- "integers" }
						case #Items({ items: List<String> }) { <- "strings" }
						case _ { <- "other" }
					}
				}
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([["empty-list-overlap", 10]])
		})

		// `n` keeps the earlier Case from every value the later one is for. The
		// `case _` still misses an empty `items` whose `n` is an Integer.
		it("should stay silent where another member keeps the earlier Case from the value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Held = { items: List<Integer> | List<String>, n: Integer | String }

				function describe(_ value: Held | Boolean) -> String {
					<- match value -> String {
						case { items: List<Integer>, n: Integer } { <- "integers" }
						case { items: List<String>, n: String } { <- "strings" }
						case _ { <- "other" }
					}
				}
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([["empty-list-overlap", 8]])
		})
	})

	// Type Arguments erase, so `case Box<Integer>` takes a `Box<String>#Empty`,
	// whose payload holds nothing to tell the two applications apart.
	describe("Type Argument Overlap", () => {
		let match = (cases: string, payloads: string) => `implementation {
			choice Box<Item> {
				${payloads}
			}

			function describe(_ value: Box<Integer> | Box<String>) -> String {
				<- match value -> String {
					${cases}
				}
			}
		}`
		let byApplication = `case Box<Integer> { <- "integers" }
			case Box<String> { <- "strings" }`

		it("should warn about the Case a payload-free Case reaches first", () => {
			let diagnostics = diagnosticsFor(
				match(byApplication, "Full { item: Item }, Empty,"),
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("type-argument-overlap")
			expect(diagnostics[0].message).toBe(
				"This Case never sees Box<String>#Empty",
			)
			// On `case Box<String>`, pointing back at the Case that takes it.
			expect(diagnostics[0].position?.start.line).toBe(9)
			expect(diagnostics[0].labels[1]?.position.start.line).toBe(8)
			// Every other `Box<String>` still reaches it.
			expect(diagnostics[0].tags).toBeUndefined()
		})

		it("should warn about a payload that names no Type Parameter", () => {
			let diagnostics = diagnosticsFor(
				match(
					byApplication,
					"Full { item: Item }, Count { n: Integer },",
				),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				["This Case never sees Box<String>#Count"],
			)
		})

		// The empty List is the payload's, and `case Box<Integer>` has no
		// `hasItems()` for a Guard to ask, so the Help asks about the Case.
		it("should warn about a payload whose List can be empty", () => {
			let diagnostics = diagnosticsFor(
				match(
					byApplication,
					"Full { item: Item }, Many { items: List<Item> },",
				),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"type-argument-overlap",
			])
			expect(diagnostics[0].message).toBe(
				"This Case never sees some Box<String>#Many values",
			)
		})

		it("should name every Case the earlier one takes in its Help", () => {
			let diagnostics = diagnosticsFor(
				match(
					byApplication,
					"Full { item: Item }, Count { n: Integer }, Empty,",
				),
			)

			expect(diagnostics[0].helps).toEqual([
				"Write 'case Box#Count' and 'case Box#Empty' above the Case that runs first, so one Case answers for each in every application.",
			])
		})

		// The message names a Case every value of which crosses, wherever it
		// stands among the Cases.
		it("should name a Case that crosses whole before one that crosses in part", () => {
			let diagnostics = diagnosticsFor(
				match(
					byApplication,
					"Full { item: Item }, Many { items: List<Item> }, Empty,",
				),
			)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				["This Case never sees Box<String>#Empty"],
			)
		})

		it("should stay silent where the payload tells the applications apart", () => {
			expect(
				diagnosticsFor(match(byApplication, "Full { item: Item },")),
			).toEqual([])
		})

		// A Case Matcher names its Case in every application, so the Case
		// the Help asks for leaves nothing to cross.
		it("should stay silent once the Case has a Case of its own", () => {
			expect(
				diagnosticsFor(
					match(
						`case Box#Empty { <- "empty" }
						${byApplication}`,
						"Full { item: Item }, Empty,",
					),
				),
			).toEqual([])
		})

		// `case Box<Boolean>` also overlaps `Box<String>#Empty`, but it is
		// not a Case it names.
		it("should name the member the later Case is written for", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Box<Item> {
					Full { item: Item },
					Empty,
				}

				function describe(_ value: Box<Integer> | Box<String> | Box<Boolean>) -> String {
					<- match value -> String {
						case Box<Integer> { <- "integers" }
						case Box<String> { <- "strings" }
						case Box<Boolean> { <- "booleans" }
					}
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
				[
					"This Case never sees Box<String>#Empty",
					"This Case never sees Box<Boolean>#Empty",
				],
			)
		})

		// No Matcher can name a Case inside a member, so the crossing is
		// looked for under the Matchers' members.
		describe("at a member", () => {
			let held = (cases: string) => `implementation {
				choice Box<Item> {
					Full { item: Item },
					Empty,
				}

				choice Holder {
					Hold { box: Box<Integer> | Box<String> },
					Nothing,
				}

				function describe(_ value: Holder) -> String {
					<- match value -> String {
						${cases}
						case #Nothing { <- "nothing" }
						case _ { <- "other" }
					}
				}
			}`

			it("should warn about a payload requirement another application's Case reaches first", () => {
				let diagnostics = diagnosticsFor(
					held(`case #Hold({ box: Box<Integer> }) { <- "integers" }
						case #Hold({ box: Box<String> }) { <- "strings" }`),
				)

				expect(diagnostics[0]?.code).toBe("type-argument-overlap")
				expect(diagnostics[0]?.message).toBe(
					"This Case never sees Holder#Hold values whose box is Box<String>#Empty",
				)
				expect(diagnostics[0]?.position?.start.line).toBe(15)
			})

			it("should warn about a Record Matcher another application's Case reaches first", () => {
				let diagnostics = diagnosticsFor(`implementation {
					choice Box<Item> {
						Full { item: Item },
						Empty,
					}

					function describe(_ value: { box: Box<Integer> } | { box: Box<String> }) -> String {
						<- match value -> String {
							case { box: Box<Integer> } { <- "integers" }
							case { box: Box<String> } { <- "strings" }
						}
					}
				}`)

				expect(
					diagnostics.map((diagnostic) => diagnostic.message),
				).toEqual([
					"This Case never sees { box: Box<String> } values whose box is Box<String>#Empty",
				])
			})

			// A List of crossing Cases crosses with them, so a `hasItems()`
			// Guard would leave it crossing.
			it("should warn about a List whose items another application's Case reaches first", () => {
				let diagnostics = diagnosticsFor(`implementation {
					choice Box<Item> {
						Full { item: Item },
						Empty,
					}

					function describe(_ value: List<Box<Integer>> | List<Box<String>>) -> String {
						<- match value -> String {
							case List<Box<Integer>> { <- "integers" }
							case List<Box<String>> { <- "strings" }
						}
					}
				}`)

				expect(
					diagnostics.map((diagnostic) => [
						diagnostic.code,
						diagnostic.message,
						diagnostic.helps,
					]),
				).toEqual([
					[
						"type-argument-overlap",
						"This Case never sees some List<Box<String>> values",
						[
							"Write the matched value's Type as one application of 'Box'.",
						],
					],
				])
			})

			it("should warn about a Dictionary whose values another application's Case reaches first", () => {
				let diagnostics = diagnosticsFor(`implementation {
					choice Box<Item> {
						Full { item: Item },
						Empty,
					}

					function describe(_ value: Dictionary<String, Box<Integer>> | Dictionary<String, Box<String>>) -> String {
						<- match value -> String {
							case Dictionary<String, Box<Integer>> { <- "integers" }
							case Dictionary<String, Box<String>> { <- "strings" }
						}
					}
				}`)

				expect(
					diagnostics.map((diagnostic) => [
						diagnostic.code,
						diagnostic.message,
						diagnostic.helps,
					]),
				).toEqual([
					[
						"type-argument-overlap",
						"This Case never sees some Dictionary<String, Box<String>> values",
						[
							"Write the matched value's Type as one application of 'Box'.",
						],
					],
				])
			})

			it("should stay silent where the payload tells the applications apart", () => {
				expect(
					diagnosticsFor(
						held(`case #Hold({ box: Box<Integer>#Full }) { <- "integers" }
							case #Hold({ box: Box<String>#Full }) { <- "strings" }`),
					).map((diagnostic) => diagnostic.code),
				).not.toContain("type-argument-overlap")
			})

			it("should stay silent once the member is matched in a Case of its own", () => {
				expect(
					diagnosticsFor(
						held(`case #Hold({ box }) {
							<- match box -> String {
								case Box#Empty { <- "empty" }
								case Box<Integer> { <- "integers" }
								case Box<String> { <- "strings" }
							}
						}`),
					).map((diagnostic) => diagnostic.code),
				).not.toContain("type-argument-overlap")
			})

			// `n` keeps every value the later Case is for out of the earlier
			// one, whatever its `box` holds.
			it("should stay silent where another member keeps the earlier Case from the value", () => {
				expect(
					diagnosticsFor(`implementation {
						choice Box<Item> {
							Full { item: Item },
							Empty,
						}

						type Held = { box: Box<Integer> | Box<String>, n: Integer | String }

						function describe(_ value: Held | Boolean) -> String {
							<- match value -> String {
								case { box: Box<Integer>, n: Integer } { <- "integers" }
								case { box: Box<String>, n: String } { <- "strings" }
								case _ { <- "other" }
							}
						}
					}`),
				).toEqual([])
			})

			// The `case _` after the Cases sees the same member, and no Case
			// can be bound in its place.
			it("should report the member once, on the Case written for it", () => {
				expect(
					diagnosticsFor(
						held(`case #Hold({ box: Box<Integer> }) { <- "integers" }
							case #Hold({ box: Box<String> }) { <- "strings" }`),
					).map((diagnostic) => diagnostic.position?.start.line),
				).toEqual([15])
			})
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

		// The empty List is a payload's, so the branch misses a Case of its
		// own application. A `Bag` has no `hasItems()` for a Guard to ask.
		it("should warn about the branch another application's Case reaches first", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Bag<Item> {
					Full { item: Item },
					Many { items: List<Item> },
				}

				namespace IntegerBag for Bag<Integer> {
					describe() -> String {
						<- "integers"
					}
				}

				namespace StringBag for Bag<String> {
					describe() -> String {
						<- "strings"
					}
				}

				constant bag: Bag<Integer> | Bag<String> = Bag<String>#Many({ items = ["a"] })

				Terminal.inspect(bag::describe())
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("type-argument-overlap")
			expect(diagnostics[0].message).toBe(
				"The branch for Bag<String>#Many never sees some of its values",
			)
		})

		// No Case can be written for the `box` a member holds, so the Help
		// asks for one application.
		it("should warn about a branch another application's Case reaches inside a member", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Box<Item> {
					Full { item: Item },
					Empty,
				}

				namespace IntegerHeld for { box: Box<Integer> } {
					describe() -> String {
						<- "integers"
					}
				}

				namespace StringHeld for { box: Box<String> } {
					describe() -> String {
						<- "strings"
					}
				}

				constant held: { box: Box<Integer> } | { box: Box<String> } = { box = Box<String>#Empty }

				Terminal.inspect(held::describe())
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.helps,
				]),
			).toEqual([
				[
					"type-argument-overlap",
					["Write the receiver's Type as one application of 'Box'."],
				],
			])
		})

		it("should warn about branches whose member Types share values", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Left = { a: Integer | String }
				type Right = { a: String | Boolean }

				namespace Lefts for Left {
					describe() -> String {
						<- "left"
					}
				}

				namespace Rights for Right {
					describe() -> String {
						<- "right"
					}
				}

				constant either: Left | Right = { a = "x" }

				Terminal.inspect(either::describe())
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("dispatch-overlap")
			expect(diagnostics[0].message).toBe(
				"The branch for Right never sees the values Left shares with it",
			)
		})

		// `Small` and `Large` share no value, but the check sees two Integers.
		describe("told apart by a refinement", () => {
			let sides = (left: string, right: string) => `implementation {
				type Small = Integer where @::isLessThan(10)
				type Large = Integer where @::isGreaterThan(100)
				type Left = { a: ${left} }
				type Right = { a: ${right} }

				namespace Lefts for Left {
					describe() -> String {
						<- "left"
					}
				}

				namespace Rights for Right {
					describe() -> String {
						<- "right"
					}
				}

				function show(_ value: Left | Right) -> String {
					<- value::describe()
				}
			}`
			let erasureNote =
				"A refinement's predicate does not survive to runtime, so the check for Small asks only for an Integer, which a Large is too."
			let help =
				"Call the Method on a value of one member Type, such as 'Right', so its own Namespace answers without a runtime check."

			it("should refuse a branch only some of whose values a refinement tells apart", () => {
				let diagnostics = diagnosticsFor(
					sides("Small | String", "Large | Boolean"),
				)

				expect(
					diagnostics.map((diagnostic) => [
						diagnostic.severity,
						diagnostic.code,
						diagnostic.message,
					]),
				).toEqual([
					[
						"error",
						"erased-case-conflict",
						"The branch for Right never sees some of its values",
					],
				])
				expect(diagnostics[0].notes).toContain(erasureNote)
				expect(diagnostics[0].helps).toEqual([help])
			})

			it("should name the refinement where it erases a whole branch", () => {
				let diagnostics = diagnosticsFor(sides("Small", "Large"))

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["erased-case-conflict"])
				expect(diagnostics[0].notes).toContain(erasureNote)
				expect(diagnostics[0].helps).toEqual([help])
			})

			// Values with a String `a` are shared. Where `n` is the same Type on
			// both sides, or only the later one refines it, the refinement turns
			// none of them away.
			let shared = (left: string, right: string) => `implementation {
				type Small = Integer where @::isLessThan(10)
				type Left = { a: Integer | String, n: ${left} }
				type Right = { a: String | Boolean, n: ${right} }

				namespace Lefts for Left {
					describe() -> String {
						<- "left"
					}
				}

				namespace Rights for Right {
					describe() -> String {
						<- "right"
					}
				}

				function show(_ value: Left | Right) -> String {
					<- value::describe()
				}
			}`

			it("should warn about shared values where the refinement turns none away", () => {
				expect(
					diagnosticsFor(shared("Small", "Small")).map(
						(diagnostic) => diagnostic.code,
					),
				).toEqual(["dispatch-overlap"])
				expect(
					diagnosticsFor(shared("Integer", "Small")).map(
						(diagnostic) => diagnostic.code,
					),
				).toEqual(["dispatch-overlap"])
			})

			// Every `Tiny` is a `Small`, read off the two ranges, so a value
			// with a String `a` really is of both member Types.
			let ranged = (right: string) => `implementation {
				type Small = Integer where @::isLessThan(10)
				type Tiny = Integer where @::isLessThan(5)
				type Odd = Integer where @::isOdd()
				type Left = { a: Integer | String, n: Small }
				type Right = { a: String | Boolean, n: ${right} }

				namespace Lefts for Left {
					describe() -> String {
						<- "left"
					}
				}

				namespace Rights for Right {
					describe() -> String {
						<- "right"
					}
				}

				function show(_ value: Left | Right) -> String {
					<- value::describe()
				}
			}`

			it("should warn about shared values where one range holds the other", () => {
				let diagnostics = diagnosticsFor(ranged("Tiny"))

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["dispatch-overlap"])
				expect(diagnostics[0].notes).toContain(
					"A value can be a Left and a Right at once, and fits both branches.",
				)
				expect(diagnostics[0].helps).toEqual([help])
			})

			// `isOdd()` is no range, so whether every Odd is a Small is open.
			it("should say only what is known where no range decides", () => {
				let diagnostics = diagnosticsFor(ranged("Odd"))

				expect(
					diagnostics.map((diagnostic) => [
						diagnostic.code,
						diagnostic.message,
					]),
				).toEqual([
					[
						"dispatch-overlap",
						"The branch for Right never sees the values the branch for Left takes too",
					],
				])
				expect(diagnostics[0].notes).toContain(
					"Small and Odd are both checked as an Integer, and the compiler does not decide whether every Odd is a Small.",
				)
				expect(diagnostics[0].helps).toEqual([help])
			})

			// Each `n` refines an Integer, and the earlier one is read off its
			// conjuncts where the Integer Namespace answers them.
			let bounded = (
				prefix: string,
				left: string,
				right: string,
			) => `implementation {
				${prefix}
				type L = Integer where ${left}
				type R = Integer where ${right}
				type Left = { n: L, a: Integer | String }
				type Right = { n: R, a: String | Boolean }

				namespace Lefts for Left {
					describe() -> String {
						<- "left"
					}
				}

				namespace Rights for Right {
					describe() -> String {
						<- "right"
					}
				}

				function show(_ value: Left | Right) -> String {
					<- value::describe()
				}
			}`

			// Every R below 6 is turned away by L.
			it("should read an inclusive bound as a range", () => {
				expect(
					diagnosticsFor(
						bounded(
							"",
							"@::isGreaterThanOrEqualTo(6)",
							"@::isGreaterThanOrEqualTo(0)",
						),
					).map((diagnostic) => diagnostic.code),
				).toEqual(["erased-case-conflict"])
			})

			it("should decide a value against its exclusion", () => {
				expect(
					diagnosticsFor(bounded("", "@::isNot(5)", "@::is(5)")).map(
						(diagnostic) => diagnostic.code,
					),
				).toEqual(["erased-case-conflict"])
			})

			// `isLessThan(than:)` is the Program's own, and may mean anything.
			it("should not read a comparison another Namespace answers", () => {
				let diagnostics = diagnosticsFor(
					bounded(
						`namespace Weird for Integer {
							overload isLessThan {
								(than other: Integer) -> Boolean {
									<- true
								}
							}
						}`,
						"@::isLessThan(6)",
						"@::isLessThan(than 5)",
					),
				)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["dispatch-overlap"])
				expect(diagnostics[0].notes).toContain(
					"L and R are both checked as an Integer, and the compiler does not decide whether every R is an L.",
				)
			})

			it("should refuse the branch where the earlier check's refinement erases", () => {
				let diagnostics = diagnosticsFor(shared("Small", "Integer"))

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["erased-case-conflict"])
				expect(diagnostics[0].notes).toContain(
					"A refinement's predicate does not survive to runtime, so the check for Small asks only for an Integer, and every Integer passes it.",
				)
			})
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

			// The Method runs while `first` is given its value, when `later`
			// has none yet.
			it("reports a static Property calling a Method that reads one written below it", () => {
				let source = `implementation {
					namespace Box for Integer {
						static first = Box.compute()

						static compute() -> Integer { <- Box.later::add(1) }

						static later = 3
					}

					Terminal.inspect(Box.first)
				}`
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("use-before-declaration")
				expect(diagnostics[0].message).toBe(
					"Property 'Box.later' is read before it has a value",
				)
				expect(
					diagnostics[0].labels.map((label) => [
						label.message,
						underlinedBy(source, label),
					]),
				).toEqual([
					["this call reaches it", "Box.compute"],
					["it is given its value here", "later"],
					["this reads it", "later"],
				])
				expect(diagnostics[0].helps).toEqual([
					"Move this Declaration below the one it reads.",
				])
			})

			it("accepts a static Property calling a Method that reads one written above it", () => {
				expect(
					diagnosticsFor(`implementation {
						namespace Box for Integer {
							static later = 3

							static first = Box.compute()

							static compute() -> Integer { <- Box.later::add(1) }
						}

						Terminal.inspect(Box.first)
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

		// A body runs where it is called, so a Statement calling it above a
		// Namespace the body uses runs ahead of that Namespace too.
		describe("through what the Statement runs", () => {
			const parity = `namespace Parity for Integer {
					isEvenly() -> Boolean { <- @::remainder(dividingBy 2)::is(0) }
				}`

			it("reports a call to a Function whose body uses a Namespace declared below", () => {
				let source = `implementation {
					function run() -> Boolean {
						<- 4::isEvenly()
					}

					Terminal.inspect(run())

					${parity}
				}`
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("use-before-declaration")
				expect(diagnostics[0].message).toBe(
					"Namespace 'Parity' is used before it is declared",
				)
				expect(
					diagnostics[0].labels.map((label) => [
						label.kind,
						label.message,
						underlinedBy(source, label),
					]),
				).toEqual([
					["primary", "this call reaches it", "run"],
					["secondary", "declared here, below the use", "Parity"],
					["secondary", "this Method comes from it", "isEvenly"],
				])
				expect(diagnostics[0].notes).toEqual([
					"A Namespace comes into being where it is written, so nothing that runs above it can reach it.",
					"This reaches 'Parity' through 'run'.",
				])
				expect(diagnostics[0].helps).toEqual([
					"Move the Declaration of 'Parity' above this Statement, or this Statement below it.",
				])
			})

			// The Property can not be read while its Namespace does not exist
			// either, and only moving the Statement answers both.
			it.each([
				[
					"a call",
					`function useIt() -> Integer {
						<- Sizes.base
					}`,
					"Terminal.print(useIt())",
				],
				[
					"a Function handed on",
					"",
					"Terminal.inspect([1, 2]::map((value) { <- value::add(Sizes.base) }))",
				],
			])(
				"reports a static Property read through %s above its Namespace once",
				(_, declarations, statement) => {
					let program = (order: Array<string>) => `implementation {
						constant size = 4

						${declarations}

						${order.join("\n\n")}
					}`
					let namespace = `namespace Sizes {
							static base: Integer = size
						}`
					let diagnostics = diagnosticsFor(
						program([statement, namespace]),
					)

					expect(
						diagnostics.map((diagnostic) => [
							diagnostic.message,
							diagnostic.helps,
						]),
					).toEqual([
						[
							"Namespace 'Sizes' is used before it is declared",
							[
								"Move the Declaration of 'Sizes' above this Statement, or this Statement below it.",
							],
						],
					])
					expect(
						diagnosticsFor(program([namespace, statement])),
					).toEqual([])
				},
			)

			// Each move the Help offers is followed, so offering one that leaves
			// a read before its value fails here.
			const sizes = (value: string) => `namespace Sizes {
					static base: Integer = ${value}
				}`

			it.each([
				[
					"a Constant between that the Namespace reads",
					[
						"Terminal.print(useIt())",
						"constant size = 4",
						sizes("size"),
					],
					"Move this Statement below the Declaration of 'Sizes'.",
					[
						"constant size = 4",
						sizes("size"),
						"Terminal.print(useIt())",
					],
				],
				[
					"a Statement between that reads what this one declares",
					["constant v = useIt()", "Terminal.print(v)", sizes("4")],
					"Move the Declaration of 'Sizes' above this Statement.",
					[sizes("4"), "constant v = useIt()", "Terminal.print(v)"],
				],
				[
					"both",
					[
						"constant v = useIt()",
						"Terminal.print(v)",
						"constant size = 4",
						sizes("size"),
					],
					"Move the Declarations of 'size' and 'Sizes' above this Statement, in the order they are written.",
					[
						"constant size = 4",
						sizes("size"),
						"constant v = useIt()",
						"Terminal.print(v)",
					],
				],
				[
					"a Namespace that needs what this Statement declares",
					[
						"constant v = useIt()",
						"constant size = v",
						sizes("size"),
					],
					"Give the Properties of 'Sizes' values that do not need 'v', then move its Declaration above this Statement.",
					[sizes("4"), "constant v = useIt()", "constant size = v"],
				],
				[
					"a body between that names what this Statement declares",
					[
						"constant v = useIt()",
						"function show() -> Integer { <- v }",
						sizes("4"),
						"Terminal.print(show())",
					],
					"Move the Declaration of 'Sizes' above this Statement.",
					[
						sizes("4"),
						"constant v = useIt()",
						"function show() -> Integer { <- v }",
						"Terminal.print(show())",
					],
				],
				[
					"a Constant between that a Method of the Namespace names",
					[
						"Terminal.print(useIt())",
						"constant size = 4",
						`namespace Sizes {
							static base: Integer = 4

							static twice() -> Integer { <- size::multiply(with 2) }
						}`,
					],
					"Move this Statement below the Declaration of 'Sizes'.",
					[
						"constant size = 4",
						`namespace Sizes {
							static base: Integer = 4

							static twice() -> Integer { <- size::multiply(with 2) }
						}`,
						"Terminal.print(useIt())",
					],
				],
			])(
				"offers only the move that compiles past %s",
				(_, written, help, followed) => {
					let program = (
						statements: Array<string>,
					) => `implementation {
						function useIt() -> Integer {
							<- Sizes.base
						}

						${statements.join("\n\n")}
					}`

					expect(
						diagnosticsFor(program(written)).map(
							(diagnostic) => diagnostic.helps,
						),
					).toEqual([[help]])
					expect(compiles(program(followed))).toBe(true)
				},
			)

			it("offers only the move that compiles to a Constant read too early", () => {
				let program = (statements: Array<string>) => `implementation {
					${statements.join("\n\n")}

					function useIt() -> Integer {
						<- k
					}
				}`

				expect(
					diagnosticsFor(
						program([
							"constant v = useIt()",
							"Terminal.print(v)",
							"constant w = 3",
							"constant k = w",
						]),
					).map((diagnostic) => diagnostic.helps),
				).toEqual([
					[
						"Move the Declarations of 'w' and 'k' above this Statement, in the order they are written.",
					],
				])
				expect(
					compiles(
						program([
							"constant w = 3",
							"constant k = w",
							"constant v = useIt()",
							"Terminal.print(v)",
						]),
					),
				).toBe(true)
			})

			it("names every Function a call runs through", () => {
				let diagnostics = diagnosticsFor(`implementation {
					function outer() -> Boolean {
						<- inner(4)
					}

					function inner(_ n: Integer) -> Boolean {
						<- n::isEvenly()
					}

					Terminal.inspect(outer())

					${parity}
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].notes[1]).toBe(
					"This reaches 'Parity' through 'outer', then 'inner'.",
				)
			})

			it("reports a Method of another Namespace whose body uses one declared below", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Checks for Integer {
						isFine() -> Boolean { <- @::isEvenly() }
					}

					Terminal.inspect(4::isFine())

					${parity}
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].message).toBe(
					"Namespace 'Parity' is used before it is declared",
				)
				expect(diagnostics[0].notes[1]).toBe(
					"This reaches 'Parity' through 'Checks::isFine'.",
				)
			})

			it("reports a Function literal bound to a Constant and called above the Namespace", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant check = () -> Boolean { <- 4::isEvenly() }

					Terminal.inspect(check())

					${parity}
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].notes[1]).toBe(
					"This reaches 'Parity' through 'check'.",
				)
			})

			it("accepts a Function literal bound to a Constant and called below the Namespace", () => {
				expect(
					diagnosticsFor(`implementation {
						constant check = () -> Boolean { <- 4::isEvenly() }

						${parity}

						Terminal.inspect(check())
					}`),
				).toEqual([])
			})

			// The library runs the literal it is handed, at once.
			it("reports a Function literal handed to the library in the Statement", () => {
				let source = `implementation {
					Terminal.inspect([1, 2]::map((_ item: Integer) -> Boolean { <- item::isEvenly() }))

					${parity}
				}`
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(
					diagnostics[0].labels.map((label) => [
						label.message,
						underlinedBy(source, label),
					]),
				).toEqual([
					["this call may run a Function that reaches it", "map"],
					["declared here, below the use", "Parity"],
					["this Method comes from it", "isEvenly"],
				])
				expect(diagnostics[0].notes[1]).toBe(
					"This reaches 'Parity' through the Function on line 2.",
				)
			})

			it("reports a Constant initialiser calling a Function that uses a Namespace declared below", () => {
				let diagnostics = diagnosticsFor(`implementation {
					function run() -> Boolean {
						<- 4::isEvenly()
					}

					constant answer = run()

					${parity}

					Terminal.inspect(answer)
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].position?.start.line).toBe(6)
			})

			it("reports a conformance witness whose Method uses a Namespace declared below", () => {
				let source = `implementation {
					namespace Thing for { value: Integer } is Comparable {
						compare(to other: { value: Integer }) -> Ordering {
							<- @.value::scaled()::compare(to other.value)
						}
					}

					Terminal.inspect([{ value = 3 }, { value = 1 }]::sort())

					namespace Scaling for Integer {
						scaled() -> Integer { <- @::multiply(with 2) }
					}
				}`
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].message).toBe(
					"Namespace 'Scaling' is used before it is declared",
				)
				expect(diagnostics[0].labels[0]?.message).toBe(
					"this call's Comparable conformance reaches it",
				)
				expect(underlinedBy(source, diagnostics[0].labels[0])).toBe(
					"sort",
				)
				expect(diagnostics[0].notes[1]).toBe(
					"This reaches 'Scaling' through 'Thing::compare'.",
				)
			})

			// `"{thing}"` emits `Shown.toString(thing)`.
			it("reports a String hole whose Printable conformance comes from a Namespace declared below", () => {
				let source = `implementation {
					constant thing = { value = 3 }

					Terminal.inspect("{thing}")

					namespace Shown for { value: Integer } is Printable {
						toString() -> String { <- @.value::toString() }
					}
				}`
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].message).toBe(
					"Namespace 'Shown' is used before it is declared",
				)
				expect(diagnostics[0].labels[0]?.message).toBe(
					"this value's Printable conformance comes from it",
				)
				expect(underlinedBy(source, diagnostics[0].labels[0])).toBe(
					"thing",
				)
			})

			it("reports one Namespace once for a Statement", () => {
				let diagnostics = diagnosticsFor(`implementation {
					function run() -> Boolean {
						<- 4::isEvenly()
					}

					Terminal.inspect(run()::and(4::isEvenly())::and(run()))

					${parity}
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].labels[0]?.message).toBe(
					"this Method comes from it",
				)
			})

			it("accepts a call below the Namespace its Function uses", () => {
				expect(
					diagnosticsFor(`implementation {
						function run() -> Boolean {
							<- 4::isEvenly()
						}

						${parity}

						Terminal.inspect(run())
					}`),
				).toEqual([])
			})

			// A Function outside the class names it through the binding that is
			// only set once the class is declared.
			it("reports a static Property reaching its own Namespace through a Function", () => {
				let source = `implementation {
					function run() -> Integer {
						<- 4::doubled()
					}

					namespace Doubling for Integer {
						static four = run()

						doubled() -> Integer { <- @::multiply(with 2) }
					}

					Terminal.inspect(Doubling.four)
				}`
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].message).toBe(
					"Namespace 'Doubling' is used before it is declared",
				)
				expect(
					diagnostics[0].labels.map((label) => [
						label.message,
						underlinedBy(source, label),
					]),
				).toEqual([
					["this call reaches it", "run"],
					["this Method comes from it", "doubled"],
					["still being declared when this runs", "Doubling"],
				])
				expect(diagnostics[0].helps).toEqual([
					"Work the value out in a Method of 'Doubling' instead.",
				])
			})

			it("accepts a static Property reaching its own Namespace through its own Method", () => {
				expect(
					diagnosticsFor(`implementation {
						namespace Doubling for Integer {
							static four = Doubling.computed()

							static computed() -> Integer { <- 2::doubled() }

							doubled() -> Integer { <- @::multiply(with 2) }
						}

						Terminal.inspect(Doubling.four)
					}`),
				).toEqual([])
			})

			// A name is followed to what it binds where it is read.
			it("follows a Parameter, not the top-level Function of its name", () => {
				expect(
					diagnosticsFor(`implementation {
						function apply(_ step: (_: Integer) -> Integer, to n: Integer) -> Integer {
							<- step(n)
						}

						Terminal.inspect(apply((_ x: Integer) -> Integer { <- x::add(1) }, to 3))

						${parity}

						function step(_ x: Integer) -> Boolean { <- x::isEvenly() }

						Terminal.inspect(step(1))
					}`),
				).toEqual([])
			})

			it("follows a Method of a Namespace written below the Function calling it", () => {
				let diagnostics = diagnosticsFor(`implementation {
					function run() -> Boolean {
						<- 4::isFine()
					}

					namespace Checks for Integer {
						isFine() -> Boolean { <- @::isEvenly() }
					}

					Terminal.inspect(run())

					${parity}
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].notes[1]).toBe(
					"This reaches 'Parity' through 'run', then 'Checks::isFine'.",
				)
			})

			it("follows a local Constant, not the top-level Function of its name", () => {
				expect(
					diagnosticsFor(`implementation {
						function twice() -> Integer {
							constant step = (_ x: Integer) -> Integer { <- x::add(1) }

							<- step(step(1))
						}

						Terminal.inspect(twice())

						${parity}

						function step(_ x: Integer) -> Boolean { <- x::isEvenly() }

						Terminal.inspect(step(1))
					}`),
				).toEqual([])
			})

			// Making, naming or storing a Function runs nothing. A call through
			// a value nothing names may run any Function that escaped by then.
			it.each([
				[
					"a Function a call answers",
					`function makeCheck() -> () -> Boolean {
						<- () -> Boolean { <- 4::isEvenly() }
					}

					constant check = makeCheck()`,
					"check()",
				],
				[
					"a Function stored in a Record",
					"constant handlers = { onCheck = () -> Boolean { <- 4::isEvenly() } }",
					"handlers.onCheck()",
				],
				[
					"a Function named by a Constant",
					`function check() -> Boolean { <- 4::isEvenly() }

					constant named = check`,
					"named()",
				],
				[
					"a Function stored in a List",
					"constant checks = [() -> Boolean { <- 4::isEvenly() }]",
					"checks::map((_ f: () -> Boolean) -> Boolean { <- f() })",
				],
			])(
				"accepts %s that runs below the Namespace",
				(_, above, below) => {
					expect(
						diagnosticsFor(`implementation {
						${above}

						${parity}

						Terminal.inspect(${below})
					}`),
					).toEqual([])
				},
			)

			it("reports a Function stored above the Namespace and run through a value above it", () => {
				let source = `implementation {
					constant handlers = { onCheck = () -> Boolean { <- 4::isEvenly() } }

					Terminal.inspect(handlers.onCheck())

					${parity}
				}`
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].labels[0]?.message).toBe(
					"this call may run a Function that reaches it",
				)
				expect(underlinedBy(source, diagnostics[0].labels[0])).toBe(
					"handlers.onCheck",
				)
			})

			it("reports a Parameter's default that runs above the Namespace", () => {
				let diagnostics = diagnosticsFor(`implementation {
					function scaled(_ n: Integer, by even: Boolean = 3::isEvenly()) -> Boolean {
						<- even
					}

					Terminal.inspect(scaled(2))

					${parity}
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].notes[1]).toBe(
					"This reaches 'Parity' through 'scaled'.",
				)
			})

			// A completing body runs once started, and the part after its first
			// sure suspension waits for the top level to suspend.
			it("accepts work that uses the Namespace only after suspending", () => {
				expect(
					diagnosticsFor(`implementation {
						function slowly(_ value: Integer) -> Future<Boolean> {
							complete Async.sleep(milliseconds 1)

							<- value::isEvenly()
						}

						constant running = start slowly(4)

						${parity}

						Terminal.inspect(complete running)
					}`),
				).toEqual([])
			})

			it("accepts work that is never started above the Namespace", () => {
				expect(
					diagnosticsFor(`implementation {
						function slowly(_ value: Integer) -> Future<Boolean> {
							constant even = value::isEvenly()

							complete Async.sleep(milliseconds 1)

							<- even
						}

						constant later = slowly(4)

						${parity}

						Terminal.inspect(complete later)
					}`),
				).toEqual([])
			})

			it("reports work started above the Namespace that uses it before suspending", () => {
				let source = `implementation {
					function slowly(_ value: Integer) -> Future<Boolean> {
						constant even = value::isEvenly()

						complete Async.sleep(milliseconds 1)

						<- even
					}

					constant running = start slowly(4)

					${parity}

					Terminal.inspect(complete running)
				}`
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].labels[0]?.message).toBe(
					"this starts work that reaches it",
				)
				expect(underlinedBy(source, diagnostics[0].labels[0])).toBe(
					"start slowly(4)",
				)
			})

			// The Statement that starts the work suspends too, so the part after
			// the sleep runs while it waits.
			it.each([
				["completed", "complete slowly()"],
				[
					"completed with others",
					"complete [slowly(), slowly()]::all()",
				],
			])(
				"reports work %s above the Namespace that uses it after suspending",
				(_, written) => {
					let diagnostics = diagnosticsFor(`implementation {
					function slowly() -> Future<Boolean> {
						complete Async.sleep(milliseconds 1)

						<- 4::isEvenly()
					}

					Terminal.inspect(${written})

					${parity}
				}`)

					expect(
						diagnostics.map((diagnostic) => diagnostic.message),
					).toEqual([
						"Namespace 'Parity' is used before it is declared",
					])
				},
			)

			// The parts of one Statement are not ordered, so a `complete` run before
			// the `start` releases the work there too. See "Use before declaration"
			// in packages/compiler/src/validator/DEVELOPMENT.md.
			it("reports work started in a Statement that completes something before it", () => {
				let program = (statements: string) => `implementation {
					function pause() -> Future<Integer> {
						complete Async.sleep(milliseconds 1)

						<- 1
					}

					function later() -> Future<Boolean> {
						complete Async.sleep(milliseconds 1)

						<- 4::isEvenly()
					}

					function both(_ a: Integer, _ b: Started<Boolean>) -> Started<Boolean> {
						<- b
					}

					${statements}

					${parity}

					Terminal.inspect(complete running)
				}`
				let source = program(
					"constant running = both(complete pause(), start later())",
				)
				let diagnostics = diagnosticsFor(source)

				let starts = diagnostics[0]?.labels.find(
					(label) =>
						label.message ===
						"this starts work that later reaches it",
				)

				expect(diagnostics).toHaveLength(1)
				expect(underlinedBy(source, starts)).toBe("start later()")
				expect(
					diagnosticsFor(
						program(`constant paused = complete pause()
					constant running = both(paused, start later())`),
					),
				).toEqual([])
			})

			// A completing Function's call builds its Future and runs the
			// default then, before anything starts it.
			it("reports a completing Function's default that runs where its Future is built", () => {
				let source = `implementation {
					function slowly(_ even: Boolean = 4::isEvenly()) -> Future<Boolean> {
						complete Async.sleep(milliseconds 1)

						<- even
					}

					constant later = slowly()

					${parity}

					Terminal.inspect(complete later)
				}`
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(underlinedBy(source, diagnostics[0].labels[0])).toBe(
					"slowly",
				)
			})

			// A Record default is merged where the body starts, which here is
			// below the Namespace.
			it("accepts a completing Function's Record default that runs once started", () => {
				expect(
					diagnosticsFor(`implementation {
						function slowly(_ options: { even: Boolean } = { even = 4::isEvenly() }) -> Future<Boolean> {
							complete Async.sleep(milliseconds 1)

							<- options.even
						}

						constant later = slowly({})

						${parity}

						Terminal.inspect(complete later)
					}`),
				).toEqual([])
			})

			it("reports a Namespace declared inside a body that uses one declared below", () => {
				let diagnostics = diagnosticsFor(`implementation {
					function run() -> Boolean {
						namespace Helper for Integer {
							isFine() -> Boolean { <- @::isEvenly() }
						}

						<- 2::isFine()
					}

					Terminal.inspect(run())

					${parity}
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].notes[1]).toBe(
					"This reaches 'Parity' through 'run', then 'Helper::isFine'.",
				)
			})

			// A Function is hoisted, but the Constant its body reads holds
			// nothing until its own Statement runs.
			it("reports a Function called above a Constant its body reads", () => {
				let source = `implementation {
					Terminal.inspect(f())

					constant k = 3

					function f() -> Integer {
						<- k
					}
				}`
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].message).toBe(
					"Constant 'k' is read before it has a value",
				)
				expect(
					diagnostics[0].labels.map((label) => [
						label.message,
						underlinedBy(source, label),
					]),
				).toEqual([
					["this call reaches it", "f"],
					["it is given its value here", "k"],
					["this reads it", "k"],
				])
				expect(diagnostics[0].notes[1]).toBe(
					"This reads 'k' through 'f'.",
				)
			})

			it("accepts a Function called below the Constant its body reads", () => {
				expect(
					diagnosticsFor(`implementation {
						constant k = 3

						Terminal.inspect(f())

						function f() -> Integer {
							<- k
						}
					}`),
				).toEqual([])
			})

			// Each body's closure is worked out once, so a chain of N Functions
			// called from N Statements costs work in proportion to N.
			it("walks a chain of Functions in work linear in its length", () => {
				let visitsFor = (length: number): number => {
					let functions = Array.from(
						{ length },
						(_, index) =>
							`function f${index}(_ n: Integer) -> Integer { <- ${index === length - 1 ? "n" : `f${index + 1}(n)`} }`,
					)
					let constants = Array.from(
						{ length },
						(_, index) =>
							`constant c${index} = f${index}(${index})`,
					)

					expect(
						diagnosticsFor(`implementation {
							${functions.join("\n")}
							${constants.join("\n")}
							${parity}
							Terminal.inspect(c0)
						}`),
					).toEqual([])

					return reachWork.visits
				}

				let short = visitsFor(100)
				let long = visitsFor(200)

				expect(long).toBeGreaterThan(short)
				expect(long).toBeLessThanOrEqual(short * 2.2)
			})
		})

		// The enricher answers such a read with an Error, and the validator
		// reports it once the order check has run. See "Static Properties
		// while hoisting" in packages/compiler/src/enricher/DEVELOPMENT.md.
		describe("an unannotated static Property read before its Type is decided", () => {
			let sizes = (property: string) => `namespace Sizes {
					${property}
				}`

			it("reports every read above what the value reads once, at the Property", () => {
				let program = (
					property: string,
					constantFirst: boolean,
				) => `implementation {
					${constantFirst ? "constant size = 4" : ""}

					function first() -> Integer {
						<- Sizes.base
					}

					function second() -> Integer {
						<- Sizes.base::add(1)
					}

					${constantFirst ? "" : "constant size = 4"}

					${sizes(property)}

					Terminal.print(first()::add(second()))
				}`
				let source = program("static base = size", false)
				let diagnostics = analysedDiagnosticsFor(source)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["uninferable-property-type"])
				expect(diagnostics[0].message).toBe(
					"'Sizes.base' is read before its Type is decided",
				)
				expect(
					diagnostics[0].labels.map((label) =>
						underlinedBy(source, label),
					),
				).toEqual(["base", "base", "base"])
				expect(diagnostics[0].position?.start.line).toBe(
					source
						.split("\n")
						.findIndex((line) => line.includes("static base")) + 1,
				)
				expect(diagnostics[0].helps).toEqual([
					"Annotate 'Sizes.base' with its Type: 'static base: Type = …'.",
					"Or declare what its value reads above every read of it.",
				])
				expect(
					compiles(program("static base: Integer = size", false)),
				).toBe(true)
				expect(compiles(program("static base = size", true))).toBe(true)
			})

			// Moving the Statement below the Namespace answers both.
			it.each([
				["a Statement", "Terminal.print(Sizes.base)"],
				[
					"a Function the Statement hands on",
					"Terminal.inspect([1, 2]::map((value) { <- value::add(Sizes.base) }))",
				],
			])(
				"leaves a read %s runs above the Namespace to the order check",
				(_, statement) => {
					let codes = codesOfSource(`implementation {
						${statement}

						constant size = 4

						${sizes("static base = size")}
					}`)

					expect(codes).toEqual(["use-before-declaration"])
				},
			)

			it.each<[string, string, common.DiagnosticCode]>([
				[
					"names nothing declared",
					"static base = sise",
					"unknown-name",
				],
				[
					"reads itself",
					"static base = Sizes.base::add(size)",
					"use-before-declaration",
				],
			])(
				"reports only the value's own mistake where it %s",
				(_, property, code) => {
					expect(
						codesOfSource(`implementation {
							constant size = 4

							function useIt() -> Integer {
								<- Sizes.base
							}

							${sizes(property)}

							Terminal.print(useIt())
						}`),
					).toEqual([code])
				},
			)

			// `xs` is declared above the read, but its item Type is decided
			// only by the assignment below it.
			it("offers only the annotation where the value's Type is undecided", () => {
				let program = (property: string) => `implementation {
					variable xs = []

					function count() -> Integer {
						<- Sizes.items::length()
					}

					xs = [1, 2]

					${sizes(property)}

					Terminal.print(count())
				}`

				expect(
					firstAnalysed(
						program("static items = xs"),
						"uninferable-property-type",
					).helps,
				).toEqual([
					"Annotate 'Sizes.items' with its Type: 'static items: Type = …'.",
				])
				expect(
					compiles(program("static items: List<Integer> = xs")),
				).toBe(true)
			})

			// `Outer.total` reads `Inner.base` while hoisting, before anything
			// can type it, so it waits and settles like `Inner.base`.
			describe("read by another Property's value", () => {
				let program = (
					constantFirst: boolean,
					total: string,
				) => `implementation {
					${constantFirst ? "constant size = 4" : ""}

					function show() -> String {
						<- Outer.total
					}

					${constantFirst ? "" : "constant size = 4"}

					${sizes("static base = size").replace("Sizes", "Inner")}

					namespace Outer {
						${total}
					}

					Terminal.print(show())
				}`

				it.each([
					["without", "static total = Inner.base::add(1)"],
					["with", "static total: Integer = Inner.base::add(1)"],
				])(
					"checks a read of it %s an annotation against its Type",
					(_, total) => {
						expect(codesOfSource(program(true, total))).toEqual([
							"return-type-mismatch",
						])
					},
				)

				it("reports a read of it above what the values read", () => {
					let diagnostics = analysedDiagnosticsFor(
						program(false, "static total = Inner.base::add(1)"),
					)

					expect(
						diagnostics.map((diagnostic) => diagnostic.message),
					).toEqual([
						"'Outer.total' is read before its Type is decided",
					])
				})
			})

			// The Protocol's body may not name `Limits` at all, which is the one
			// report.
			it("leaves a read in a provided Method to the refusal of the name", () => {
				expect(
					codesOfSource(`implementation {
						protocol Sized {
							size() -> Integer

							limit() -> Integer {
								<- Limits.most
							}
						}

						constant most = 4

						namespace Limits {
							static most = most
						}

						type Box = { items: List<Integer> }

						namespace Box for Box is Sized {
							size() -> Integer {
								<- @.items::length()
							}
						}

						Terminal.print({ items = [1] }::limit())
					}`),
				).toEqual(["provided-method-out-of-reach"])
			})

			// `C.c` fails because `A.a` names `size`, which is not declared
			// where `show` is checked.
			it("offers declaring what the value reads through other Properties", () => {
				let program = (
					constantFirst: boolean,
					c: string,
				) => `implementation {
					${constantFirst ? "constant size = 4" : ""}

					function show() -> Integer {
						<- C.c
					}

					${constantFirst ? "" : "constant size = 4"}

					namespace A {
						static a = size
					}

					namespace B {
						static b = A.a::add(1)
					}

					namespace C {
						${c}
					}

					Terminal.print(show())
				}`

				expect(
					firstAnalysed(
						program(false, "static c = B.b::add(1)"),
						"uninferable-property-type",
					).helps,
				).toEqual([
					"Annotate 'C.c' with its Type: 'static c: Type = …'.",
					"Or declare what its value reads above every read of it.",
				])
				expect(
					compiles(program(false, "static c: Integer = B.b::add(1)")),
				).toBe(true)
				expect(compiles(program(true, "static c = B.b::add(1)"))).toBe(
					true,
				)
			})

			it("reports a read in the tests section", () => {
				expect(
					codesOfSource(
						`implementation {
							Terminal.print("main")
						}

						tests {
							function show() -> String {
								<- Sizes.base
							}

							constant size = 4

							${sizes("static base = size")}

							test "reads it" {
								expect show()::length()::is(1)
							}
						}`,
						{ tests: true },
					),
				).toEqual(["uninferable-property-type"])
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

		// No check of `isNot(0)` makes a String a `NonZero`, so only the other
		// half of the Help is offered.
		it("should not ask an item of another base to check the predicate", () => {
			let diagnostics = diagnosticsOfBody(
				`constant words: List<NonZero> = [1, "a"]`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.helps)).toEqual([
				["Write an item that already has Type 'NonZero'."],
			])
		})

		// A Type Parameter the call binds may still take the value's items, so
		// the check is offered.
		it("should ask an Argument a Parameter could bind to check the predicate", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function countOf<infer Item>(_ items: NonEmptyList<Item>) -> Integer {
					<- items::length()
				}

				constant words: List<String> = ["a"]

				Terminal.inspect(countOf(words))
				Terminal.inspect(countOf("a"))
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.helps)).toEqual([
				[
					"Check '@::hasItems()' on the value in an 'if' or a 'match', or pass a value that already has Type 'NonEmptyList<Item>'.",
				],
				[],
			])
		})

		// The closure binds no Type Parameter of its own, and the enclosing
		// `Item` is opaque, so the base refuses the Strings before the check.
		it("should not ask a closure's Argument to check against an opaque Type Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Filled<Item> = List<Item> where @::hasItems()

				function countOf<infer Item>(_ items: Filled<Item>) -> Integer {
					constant counted = (_ xs: Filled<Item>) -> Integer { <- xs::length() }
					constant words: List<String> = ["a"]

					<- counted(words)
				}

				Terminal.inspect(countOf([1, 2]))
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.notes[1],
					diagnostic.helps,
				]),
			).toEqual([
				[
					"'Filled<Item>' refines List<Item>, so a value has to be a List<Item> before '@::hasItems()' is asked.",
					[],
				],
			])
		})

		// The value has items already, so the other Argument's `T` is what
		// it does not fit, and no check would change that.
		it("should not ask a value that proves the refinement to check it", () => {
			let program = (call: string): string => `implementation {
				type Filled<Item> = List<Item> where @::hasItems()

				function pair<infer T>(_ a: Filled<T>, _ b: Filled<T>) -> Integer {
					<- a::length()::add(b::length())
				}

				constant words: NonEmptyList<String> = ["a"]

				Terminal.inspect(${call})
			}`
			let diagnostics = diagnosticsFor(program("pair([1], words)"))

			expect(diagnostics.map((diagnostic) => diagnostic.helps)).toEqual([
				["Pass a value that already has Type 'Filled<Integer>'."],
			])
			expect(compiles(program("pair([1], [2])"))).toBe(true)
		})

		// The other Argument binds `T` to Integer, so no check of the Strings
		// could make them fit.
		it("should not ask an Argument to check the predicate where the other Argument binds its Type Parameter apart", () => {
			let program = (call: string): string => `implementation {
				function pair<infer T>(_ a: NonEmptyList<T>, _ b: List<T>) -> Integer {
					<- 1
				}

				constant strings: List<String> = ["a"]

				Terminal.inspect(${call})
			}`
			let [diagnostic] = diagnosticsFor(program("pair(strings, [1])"))

			expect(diagnostic?.notes).toEqual([
				"Parameter 1 is NonEmptyList<T>.",
				"This call binds 'T' to Integer.",
				"'NonEmptyList<Integer>' refines List<Integer>, so a value has to be a List<Integer> before '@::hasItems()' is asked.",
			])
			expect(diagnostic?.helps).toEqual([
				"Pass a value that already has Type 'NonEmptyList<Integer>'.",
			])
			expect(compiles(program("pair([2], [1])"))).toBe(true)
		})

		// The other Argument binds `T` to String, which the value's items are,
		// so checking it is what makes it fit.
		it("should ask an Argument to check the predicate where the other Argument binds its Type Parameter alike", () => {
			let program = (call: string): string => `implementation {
				function pair<infer T>(_ a: NonEmptyList<T>, _ b: List<T>) -> Integer {
					<- 1
				}

				constant strings: List<String> = ["a"]

				${call}
			}`
			let [diagnostic] = diagnosticsFor(
				program("Terminal.inspect(pair(strings, strings))"),
			)

			expect(diagnostic?.helps).toEqual([
				"Check '@::hasItems()' on the value in an 'if' or a 'match', or pass a value that already has Type 'NonEmptyList<String>'.",
			])
			expect(
				compiles(
					program(`if strings::hasItems() {
						Terminal.inspect(pair(strings, strings))
					}`),
				),
			).toBe(true)
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

		// An Integer is no Rational, so no check of the predicate would let one
		// through.
		it("should name the base where a value is not of the refined Type", () => {
			let diagnostics = diagnosticsOfBody(`
				type Small = Rational where @::isLessThan(1/2)

				function halved(_ x: Small) -> Rational {
					<- x::divide(by 2)
				}

				Terminal.inspect(halved(0))
			`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("argument-type-mismatch")
			expect(diagnostics[0].notes).toEqual([
				"Parameter 1 is Small.",
				"'Small' refines Rational, so a value has to be a Rational before '@::isLessThan(1/2)' is asked.",
			])
			expect(diagnostics[0].helps).toEqual([])
		})

		it("should name the base where a declared value is not of the refined Type", () => {
			let diagnostics = diagnosticsOfBody(`constant d: NonZero = "zero"`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("assignment-type-mismatch")
			expect(diagnostics[0].notes).toEqual([
				"'d' is declared as NonZero.",
				"'NonZero' refines Integer, so a value has to be an Integer before '@::isNot(0)' is asked.",
			])
			expect(diagnostics[0].helps).toEqual([])
		})

		// The base names the Type Parameter, which the value binds: a List of
		// any item fits it, and only the predicate is left to ask.
		it("should bind a generic base before judging the value against it", () => {
			let diagnostics = diagnosticsOfBody(`
				function first<infer Item>(_ items: NonEmptyList<Item>) -> Item {
					<- items::firstItem()
				}

				constant numbers: List<Integer> = [1]

				Terminal.inspect(first(numbers))
				Terminal.inspect(first("a"))
			`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.notes[1],
					diagnostic.helps,
				]),
			).toEqual([
				[
					"Every value of 'NonEmptyList<Item>' has been proven to answer '@::hasItems()'.",
					[
						"Check '@::hasItems()' on the value in an 'if' or a 'match', or pass a value that already has Type 'NonEmptyList<Item>'.",
					],
				],
				[
					"'NonEmptyList<Item>' refines List<Item>, so a value has to be a List<Item> before '@::hasItems()' is asked.",
					[],
				],
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

				// Inside the Namespace, `@` binds `Item` to the Declaration's
				// opaque symbol. The admission answers `Filled<String>`, which
				// ordinary assignability refuses for `Filled<Item>`.
				// A value the evaluator can not read decides `Item` by its own
				// Type, as an unrefined `List<Item>` would let it.
				it("should admit a written List of refined values beside written Lists", () => {
					expect(
						diagnosticsFor(`implementation {
							function nested<infer Item>(_ rows: List<NonEmptyList<Item>>) -> Integer {
								<- rows::length()
							}

							function keyed<infer Item>(_ rows: Dictionary<String, NonEmptyList<Item>>) -> Integer {
								<- rows::length()
							}

							constant proven: NonEmptyList<Integer> = [1, 2]

							Terminal.inspect(nested([proven, [9]]))
							Terminal.inspect(keyed(["a" = proven, "b" = [9]]))
						}`),
					).toEqual([])
				})

				// `ints` fits `NonEmptyList<Item>` as it stands, so each report
				// points at the part no `Item` makes fit.
				it("should point past a refined value an inferred Type Parameter takes", () => {
					let source = `implementation {
						function nested<infer Item>(_ rows: List<NonEmptyList<Item>>) -> Integer {
							<- rows::length()
						}

						function keyed<infer Item>(_ rows: Dictionary<String, NonEmptyList<Item>>) -> Integer {
							<- rows::length()
						}

						constant ints: NonEmptyList<Integer> = [1, 2]
						constant empty: List<Integer> = []

						Terminal.inspect(nested([ints, []]))
						Terminal.inspect(keyed(["a" = ints, "b" = empty]))
					}`
					let diagnostics = diagnosticsFor(source)

					expect(
						diagnostics.map((diagnostic) => diagnostic.code),
					).toEqual([
						"argument-type-mismatch",
						"argument-type-mismatch",
					])
					expect(
						diagnostics.map((diagnostic) =>
							underlinedBy(
								source,
								diagnostic.labels.find((label) =>
									/^this (item|value) is/.test(label.message),
								),
							),
						),
					).toEqual(["[]", "empty"])
				})

				// The closure binds nothing, so its `Item` is the opaque one, and
				// a List of Integers is no List of `Item`s.
				it("should refuse refined values against an opaque Type Parameter's items", () => {
					expect(
						diagnosticsFor(`implementation {
							function countOf<infer Item>(_ items: NonEmptyList<Item>) -> Integer {
								constant counted = (_ rows: List<NonEmptyList<Item>>) -> Integer {
									<- rows::length()
								}
								constant ints: NonEmptyList<Integer> = [1]

								<- counted([ints, [2]])
							}

							Terminal.inspect(countOf([1]))
						}`).map((diagnostic) => diagnostic.code),
					).toEqual(["argument-type-mismatch"])
				})

				it("should refuse a written List against an opaque Type Parameter", () => {
					let { diagnostics } = enrich(
						parse(`implementation {
						type Filled<Item> = List<Item> where @::hasItems()

						namespace Boxes<infer Item> for List<Item> {
							counted(_ items: Filled<Item>) -> Integer {
								<- items::length()
							}

							again() -> Integer {
								<- @::counted(["a"])
							}
						}
					}`),
					)

					expect(
						diagnostics.map((diagnostic) => diagnostic.code),
					).toEqual(["no-matching-overload"])
				})
			})

			// Inside the Declaration, `Item` is opaque. A written List decides its
			// own `Item`, and that answer must still fit the declared Type.
			describe("against the Declaration's own Type Parameter", () => {
				function inCountOf(declaration: string): string {
					return `implementation {
						type Filled<Item> = List<Item> where @::hasItems()

						function countOf<infer Item>(_ items: Filled<Item>) -> Integer {
							constant first: Item = items::firstItem()
							${declaration}

							<- again::length()
						}

						Terminal.inspect(countOf([1, 2]))
					}`
				}

				function codesFor(source: string): Array<string | undefined> {
					return diagnosticsFor(source).map(
						(diagnostic) => diagnostic.code,
					)
				}

				// No check of the predicate makes the Strings `Item`s, so the
				// report names the base and offers no check.
				it("should refuse a written List of Strings", () => {
					let diagnostics = diagnosticsFor(
						inCountOf(`constant again: Filled<Item> = ["a"]`),
					)

					expect(
						diagnostics.map((diagnostic) => diagnostic.code),
					).toEqual(["assignment-type-mismatch"])
					expect(diagnostics[0].notes[1]).toBe(
						"'Filled<Item>' refines List<Item>, so a value has to be a List<Item> before '@::hasItems()' is asked.",
					)
					expect(diagnostics[0].helps).toEqual([])
				})

				it("should refuse a written List of Strings as the standard library's refinement", () => {
					expect(
						codesFor(
							inCountOf(
								`constant again: NonEmptyList<Item> = ["a"]`,
							),
						),
					).toEqual(["assignment-type-mismatch"])
				})

				it("should admit a written List of the Parameter's own items", () => {
					expect(
						codesFor(
							inCountOf("constant again: Filled<Item> = [first]"),
						),
					).toEqual([])
					expect(
						codesFor(
							inCountOf(
								"constant again: NonEmptyList<Item> = [first, first]",
							),
						),
					).toEqual([])
					expect(
						codesFor(
							inCountOf("constant again: Filled<Item> = items"),
						),
					).toEqual([])
				})

				// A default is checked while the signature is enriched.
				it("should refuse a written List of Strings as a Parameter's default", () => {
					let { diagnostics } = enrich(
						parse(`implementation {
							type Filled<Item> = List<Item> where @::hasItems()

							function countOf<infer Item>(_ items: Filled<Item> = ["a"]) -> Integer {
								<- items::length()
							}
						}`),
					)

					expect(
						diagnostics.map((diagnostic) => diagnostic.code),
					).toEqual(["default-type-mismatch"])
				})

				// The Declaration's `Item` is fixed, so the base is asked as
				// written. A String fits `Item | String` without deciding `Item`.
				it("should admit a written List the base takes without deciding the Parameter", () => {
					expect(
						codesFor(`implementation {
							type Both<A, B> = List<A | B> where @::hasItems()
							type Filled<Item> = List<Item> where @::hasItems()

							function countOf<infer Item>(_ items: Filled<Item>) -> Integer {
								constant first: Item = items::firstItem()
								constant words: Both<Item, String> = ["a"]
								constant mixed: Both<Item, String> = ["a", first]
								constant nested: Filled<Filled<Item>> = [[first]]

								<- words::length()::add(mixed::length())::add(nested::length())
							}

							Terminal.inspect(countOf([1, 2]))
						}`),
					).toEqual([])
				})
			})

			// `[1]` decides an `Item` the call could take, so the report points
			// at the empty List, which no `Item` makes a `NonEmptyList`.
			it("should point at the item no inferred Type Parameter admits", () => {
				let source = `implementation {
					function nested<infer Item>(_ rows: List<NonEmptyList<Item>>) -> Integer {
						<- rows::length()
					}

					Terminal.print(nested([[1], []]))
				}`
				let diagnostics = diagnosticsFor(source)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["argument-type-mismatch"])
				expect(
					underlinedBy(
						source,
						diagnostics[0].labels.find((label) =>
							label.message.startsWith("this item"),
						),
					),
				).toBe("[]")
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

		// A written Record is asked member by member, as a written List is
		// asked item by item, however deep the member stands.
		describe("into a refined member", () => {
			it("should admit a written member at every position", () => {
				expect(
					diagnosticsFor(`implementation {
						type Rule = (_ n: Integer) -> Integer
						type Counted = { count: NonZeroInteger }

						function use(_ settings: Counted) -> Integer {
							<- settings.count
						}

						function apply(_ settings: { rules: NonEmptyList<Rule> }) -> Integer {
							<- settings.rules::firstItem()(3)
						}

						function made() -> Counted {
							<- { count = 5 }
						}

						function defaulted(_ settings: Counted = { count = 6 }) -> Integer {
							<- settings.count
						}

						constant someRule = (_ n: Integer) -> Integer { <- n::add(1) }
						constant declared: Counted = { count = 2 }
						constant listed: List<Counted> = [{ count = 7 }]
						constant nested: { inner: Counted } = { inner = { count = 9 } }
						constant grouped: List<NonEmptyList<Counted>> = [[{ count = 3 }]]
						constant table: Dictionary<String, Counted> = ["a" = { count = 4 }]

						Terminal.inspect(use({ count = 1 }))
						Terminal.inspect(apply({ rules = [someRule] }))
						Terminal.inspect(made().count)
						Terminal.inspect(defaulted())
						Terminal.inspect(declared.count)
						Terminal.inspect(listed::length())
						Terminal.inspect(nested.inner.count)
						Terminal.inspect(grouped::length())
						Terminal.inspect(table::length())
					}`),
				).toEqual([])
			})

			// A payload is a written Record too, spelled out or through the
			// one-member shorthand.
			it("should admit a written member of a Case payload", () => {
				expect(
					diagnosticsFor(`implementation {
						choice Holder {
							Has { count: NonZeroInteger, label: String },
							Lacks,
						}

						choice Single {
							Full { count: NonZeroInteger },
							Empty,
						}

						function hold(_ holder: Holder) -> Holder {
							<- holder
						}

						constant held: Holder = #Has({ count = 3, label = "x" })
						constant named = Holder#Has({ count = 3, label = "x" })
						constant short: Single = #Full(3)
						constant spelled: Single = #Full({ count = 3 })
						constant inside: { holder: Holder } = { holder = #Has({ count = 3, label = "x" }) }

						Terminal.inspect(hold(#Has({ count = 3, label = "x" })))
						Terminal.inspect([held, named])
						Terminal.inspect([short, spelled])
						Terminal.inspect(inside)
					}`),
				).toEqual([])
			})

			// A member nobody wrote out is judged by its Type, and a written one
			// the predicate refuses is no evidence.
			it("should refuse a member the predicate refuses or the Program computes", () => {
				let diagnostics = diagnosticsFor(`implementation {
					type Counted = { count: NonZeroInteger }

					choice Single {
						Full { count: NonZeroInteger },
						Empty,
					}

					function use(_ settings: Counted) -> Integer {
						<- settings.count
					}

					constant three = 3
					constant zero = use({ count = 0 })
					constant computed: Counted = { count = three }
					constant payload: Single = #Full(0)
					constant listed: List<Counted> = [{ count = 3 }, { count = 0 }]
					constant emptied: { rules: NonEmptyList<Integer> } = { rules = [] }
				}`)

				expect(
					diagnostics.map((diagnostic) => [
						diagnostic.code,
						diagnostic.labels[0]?.message,
					]),
				).toEqual([
					[
						"argument-type-mismatch",
						"this is an Integer, and Counted declares a NonZeroInteger",
					],
					[
						"assignment-type-mismatch",
						"this is an Integer, and Counted declares a NonZeroInteger",
					],
					[
						"payload-type-mismatch",
						"'count' is an Integer, and '#Full' declares a NonZeroInteger",
					],
					[
						"assignment-type-mismatch",
						"this is a List<{ count: Integer }>",
					],
					[
						"assignment-type-mismatch",
						"this is a List<Unknown>, and the declared Type declares a NonEmptyList<Integer>",
					],
				])
			})

			// An update is a written Record too, a path key's level included.
			it("should admit a written member of a Record update", () => {
				expect(
					diagnosticsFor(`implementation {
						type Counted = { count: NonZeroInteger, label: String }
						type Outer = { inner: Counted, rules: NonEmptyList<Integer> }

						constant counted: Counted = { count = 1, label = "a" }
						constant outer: Outer = { inner = counted, rules = [1] }
						constant recounted: Counted = { counted with count = 3 }
						constant deeper = { outer with inner.count = 4, rules = [5, 6] }
						constant whole = { outer with inner = { count = 7, label = "b" } }

						Terminal.inspect([recounted.count, deeper.inner.count, whole.inner.count])
						Terminal.inspect(deeper.rules::length())
					}`),
				).toEqual([])
			})

			// A Literal merged into a default is asked as its merge reads it,
			// whatever level a path key writes.
			describe("a path key into a default", () => {
				const shapes = `type Server = { port: PositiveInteger, host: String }
					type Settings = { server: Server, retries: NonNegativeInteger }

					choice Call {
						Post { server: Server, body: String } = { server = { port = 80, host = "a" } },
						Idle,
					}

					function configure(_ settings: Settings = { server = { port = 80, host = "a" }, retries = 0 }) -> Integer {
						<- settings.server.port
					}

					namespace Tool for Integer {
						configure(_ settings: Settings = { server = { port = 80, host = "a" }, retries = 0 }) -> Integer {
							<- settings.server.port::add(@)
						}
					}`

				it("should admit a written member a path key reaches", () => {
					expect(
						diagnosticsFor(`implementation {
							${shapes}

							constant call: Call = Call#Post({ server.port = 8083, body = "x" })

							Terminal.inspect(configure({ server.port = 8080 }))
							Terminal.inspect(configure({ server.port = 8081, retries = 2 }))
							Terminal.inspect(1::configure({ server.port = 8082 }))
							Terminal.inspect(call)
						}`),
					).toEqual([])
				})

				it("should refuse a member a path key reaches the predicate refuses", () => {
					let diagnostics = diagnosticsFor(`implementation {
						${shapes}

						constant zero = 0
						constant written = configure({ server.port = 0 })
						constant computed = configure({ server.port = zero })
						constant call: Call = #Post({ server.port = 0, body = "x" })
					}`)

					expect(
						diagnostics.map((diagnostic) => [
							diagnostic.code,
							diagnostic.labels[0]?.message,
						]),
					).toEqual([
						[
							"argument-type-mismatch",
							"this is an Integer, and Server declares a PositiveInteger",
						],
						[
							"argument-type-mismatch",
							"this is an Integer, and Server declares a PositiveInteger",
						],
						[
							"payload-type-mismatch",
							"this is an Integer, and Server declares a PositiveInteger",
						],
					])
				})
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
		expect(diagnostics[0].helps).toEqual([
			"Write the whole member: 'server = { … }'.",
		])
		expect(
			compiles(
				source.replace(
					"{ server.port = 1 }",
					'{ server = { host = "db", port = 1 } }',
				),
			),
		).toBe(true)
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
		expect(diagnostics[0].helps).toEqual([
			"Write the whole member: 'server = { … }'.",
			"Or write the default's 'server' out as a Record Literal, member by member.",
		])

		// The whole member, or the default written out so the path merges.
		for (let [defaultValue, argument] of [
			[
				"{ retries = 3, server = fallback }",
				'{ server = { host = "db", port = 1 } }',
			],
			[
				'{ retries = 3, server = { host = "d", port = 80 } }',
				"{ server.port = 1 }",
			],
		]) {
			expect(
				compiles(`implementation {
			${server}

			constant fallback: Server = { host = "d", port = 80 }

			${connect(defaultValue)}

			constant a = connect(using ${argument})
		}`),
			).toBe(true)
		}
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
