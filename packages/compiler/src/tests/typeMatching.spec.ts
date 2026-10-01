import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { enrich } from "../enricher/index"
import { describeType } from "../helpers/describe"
import {
	buildUnion,
	createInferenceContext,
	matchesType,
	matchesTypeWithBindings,
} from "../helpers/types"
import { parse } from "../parser/index"
import { printCaseWithPayload, printType } from "../printType"
import { validate } from "../validator/index"

// End to end, since the Type logic in `src/helpers` must hold once the
// Enricher decides a Type and the Validator judges it.
function errorsFor(source: string) {
	let { program, diagnostics } = enrich(parse(source))

	return [...diagnostics, ...validate(program)].filter(
		(diagnostic) => diagnostic.severity === "error",
	)
}

describe("Type matching", () => {
	describe("Union building", () => {
		// `List<Unknown>` and `List<Integer>` each accept the other, so Union
		// building must keep the decided one whatever the order. Otherwise
		// `[[], [1]]` would infer `List<List<Unknown>>`, which fits every List.
		it("should not let an empty List Literal erase the Type beside it", () => {
			let errors = errorsFor(`implementation {
				constant broken: List<List<String>> = [[], [1]]
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("assignment-type-mismatch")
		})

		it("should reject the same Literal whichever order it is written in", () => {
			let errors = errorsFor(`implementation {
				constant reversed: List<List<String>> = [[1], []]
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("assignment-type-mismatch")
		})

		// An empty List Literal still fits every List Type.
		it("should keep an empty List Literal assignable everywhere", () => {
			expect(
				errorsFor(`implementation {
					constant nested: List<List<String>> = [[], ["a"]]
					constant integers: List<List<Integer>> = [[], [1]]
					constant empty: List<String> = []
					constant onlyEmpties: List<List<String>> = [[], []]
					Terminal.inspect(nested::length()::toString())
					Terminal.inspect(integers::length()::toString())
					Terminal.inspect(empty::length()::toString())
					Terminal.inspect(onlyEmpties::length()::toString())
				}`),
			).toEqual([])
		})
	})

	// A bare `List` accepts every List, but does not satisfy `List<String>`,
	// which promises something a bare `List` never said. An empty List Literal
	// has a rule of its own.
	describe("Bare List annotations", () => {
		it("should accept a List of anything", () => {
			expect(
				errorsFor(`implementation {
					constant integers: List = [1, 2]
					constant copied: List = integers
					constant empty: List = []
				}`),
			).toEqual([])
		})

		it("should not satisfy a List of something", () => {
			let errors = errorsFor(`implementation {
				constant integers: List = [1, 2]
				constant strings: List<String> = integers
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("assignment-type-mismatch")
		})
	})

	// A Dictionary is compared slot by slot, so two that differ only in their
	// values are two Types. Each Dictionary here arrives as a Parameter.
	describe("Dictionary annotations", () => {
		it("should accept a Dictionary of the same two slots", () => {
			expect(
				errorsFor(`implementation {
					function keep(_ entries: Dictionary<String, Integer>) -> Boolean {
						<- true
					}

					function pass(_ entries: Dictionary<String, Integer>) -> Boolean {
						<- keep(entries)
					}
				}`),
			).toEqual([])
		})

		it("should not accept a Dictionary whose values differ", () => {
			let errors = errorsFor(`implementation {
				function keep(_ entries: Dictionary<String, String>) -> Boolean {
					<- true
				}

				function pass(_ entries: Dictionary<String, Integer>) -> Boolean {
					<- keep(entries)
				}
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("argument-type-mismatch")
		})

		it("should not accept a Dictionary whose keys differ", () => {
			let errors = errorsFor(`implementation {
				function keep(_ entries: Dictionary<Integer, Integer>) -> Boolean {
					<- true
				}

				function pass(_ entries: Dictionary<String, Integer>) -> Boolean {
					<- keep(entries)
				}
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("argument-type-mismatch")
		})

		it("should accept a Dictionary of anything where a bare one is asked for", () => {
			expect(
				errorsFor(`implementation {
					function keep(_ entries: Dictionary) -> Boolean {
						<- true
					}

					function pass(_ entries: Dictionary<String, Integer>) -> Boolean {
						<- keep(entries)
					}
				}`),
			).toEqual([])
		})

		it("should not let a bare Dictionary satisfy a Dictionary of something", () => {
			let errors = errorsFor(`implementation {
				function keep(_ entries: Dictionary<String, Integer>) -> Boolean {
					<- true
				}

				function pass(_ entries: Dictionary) -> Boolean {
					<- keep(entries)
				}
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("argument-type-mismatch")
		})

		it("should not accept a List where a Dictionary is asked for", () => {
			let errors = errorsFor(`implementation {
				function keep(_ entries: Dictionary<String, Integer>) -> Boolean {
					<- true
				}

				constant answered = keep([1, 2])
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("argument-type-mismatch")
		})
	})

	describe("Union member inference", () => {
		// The first member binds `T := String` off `left` and then fails on
		// `right`. That binding must not survive into the second member, which
		// matches with `T := Integer`, so the Union's order does not matter.
		it("should try each Union member from a clean set of bindings", () => {
			expect(
				errorsFor(`implementation {
					function pick <infer T>(_ value: { left: T, right: String } | { left: String, right: T }) -> {} {
						<- {}
					}

					constant used = pick({ left = "hi", right = 5 })
				}`),
			).toEqual([])
		})

		it("should accept the same call with the members written the other way round", () => {
			expect(
				errorsFor(`implementation {
					function pick <infer T>(_ value: { left: String, right: T } | { left: T, right: String }) -> {} {
						<- {}
					}

					constant used = pick({ left = "hi", right = 5 })
				}`),
			).toEqual([])
		})

		it("should still reject an Argument no member accepts", () => {
			let errors = errorsFor(`implementation {
				function pick <infer T>(_ value: { left: T, right: String } | { left: String, right: T }) -> {} {
					<- {}
				}

				constant used = pick({ left = 1, right = 5 })
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("argument-type-mismatch")
		})
	})

	describe("Argument matching order", () => {
		// An unannotated Function literal is typed from its Parameter. Matched
		// while `T` is open, it would echo `T` back and pin the Generic, so
		// `to 5` could no longer bind it. The literal is matched afterwards.
		it("should infer a Generic from the Argument that follows a callback", () => {
			expect(
				errorsFor(`implementation {
					function apply <infer T>(transform fn: (_: T) -> T, to value: T) -> T {
						<- fn(value)
					}

					constant result: Integer = apply(transform (x) { <- x }, to 5)
					Terminal.inspect(result::toString())
				}`),
			).toEqual([])
		})

		// The callback is resolved against the bound signature, so its body can
		// call an Integer Method on its Parameter.
		it("should hand the callback the Type the other Argument bound", () => {
			expect(
				errorsFor(`implementation {
					function apply <infer T>(transform fn: (_: T) -> T, to value: T) -> T {
						<- fn(value)
					}

					constant result: Integer = apply(transform (x) { <- x::add(1) }, to 5)
					Terminal.inspect(result::toString())
				}`),
			).toEqual([])
		})

		// Against the bound `(_: Integer) -> Integer`, a body answering a String
		// is a return-Type mismatch inside the literal, at the answer.
		it("should still reject a callback that disagrees with the binding", () => {
			let errors = errorsFor(`implementation {
				function apply <infer T>(transform fn: (_: T) -> T, to value: T) -> T {
					<- fn(value)
				}

				constant result = apply(transform (x) { <- x::toString() }, to 5)
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("return-type-mismatch")
		})

		// A callback that is the only source of a binding still binds it, as
		// `map`'s transform names `Result` only in its return Type.
		it("should still bind a Generic a callback alone can name", () => {
			expect(
				errorsFor(`implementation {
					constant lengths: List<Integer> = ["a", "bb"]::map((word) { <- word::length() })
					Terminal.inspect(lengths::length()::toString())
				}`),
			).toEqual([])
		})
	})

	describe("Methods read as values", () => {
		// A Method read as a value is typed `StaticMethod` or `SimpleMethod`, a
		// tag for where the signature was written, not a different kind of value.
		// So it fits a Function annotation of the same signature.
		it("should let a static Method stand in a Function-typed Constant", () => {
			expect(
				errorsFor(`implementation {
					namespace Reader {
						static readsBase(_ x: Integer) -> Integer {
							<- x
						}
					}

					constant read: (_ x: Integer) -> Integer = Reader.readsBase
					Terminal.inspect(read(1)::toString())
				}`),
			).toEqual([])
		})

		// An instance Method takes its receiver as its first Parameter, so it
		// fits a Function Type that spells the receiver out.
		it("should let an instance Method stand in a Function that takes its receiver", () => {
			expect(
				errorsFor(`implementation {
					namespace Doubler for Integer {
						double() -> Integer {
							<- @::add(@)
						}
					}

					constant double: (_ x: Integer) -> Integer = Doubler.double
					Terminal.inspect(double(21)::toString())
				}`),
			).toEqual([])
		})

		// A Method taken as a value loses its defaults, which only a direct
		// call fills in. A call through the value writes every Argument.
		it("should require every Argument of a defaulted Method read as a value", () => {
			expect(
				errorsFor(`implementation {
					namespace Doubler for Integer {
						scaled(by factor: Integer = 2) -> Integer {
							<- @::multiply(with factor)
						}
					}

					constant scaled = Doubler.scaled
					Terminal.inspect(scaled(21)::toString())
				}`).map((error) => error.code),
			).toEqual(["argument-count-mismatch"])
		})

		it("should accept the same value called with every Argument", () => {
			expect(
				errorsFor(`implementation {
					namespace Doubler for Integer {
						scaled(by factor: Integer = 2) -> Integer {
							<- @::multiply(with factor)
						}
					}

					constant scaled = Doubler.scaled
					Terminal.inspect(scaled(21, by 3)::toString())
				}`),
			).toEqual([])
		})

		// The receiver Parameter is why the Method does not fit, so the
		// Diagnostic spells out both signatures.
		it("should name both signatures where a Method does not fit", () => {
			let errors = errorsFor(`implementation {
				namespace Doubler for Integer {
					double() -> Integer {
						<- @::add(@)
					}
				}

				constant double: () -> Integer = Doubler.double
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("assignment-type-mismatch")
			expect(errors[0].labels[0]?.message).toBe(
				"this is a (_: Integer) -> Integer",
			)
			expect(errors[0].notes).toEqual([
				"'double' is declared as () -> Integer.",
			])
		})

		it("should let a Method stand in a Function-typed static Property", () => {
			expect(
				errorsFor(`implementation {
					namespace Reader {
						static readsBase(_ x: Integer) -> Integer {
							<- x
						}
					}

					namespace Holder {
						static READER: (_ x: Integer) -> Integer = Reader.readsBase
					}

					Terminal.inspect(Holder.READER(1)::toString())
				}`),
			).toEqual([])
		})

		it("should let a Method stand in a Function Argument and a List of Functions", () => {
			expect(
				errorsFor(`implementation {
					namespace Reader {
						static readsBase(_ x: Integer) -> Integer {
							<- x
						}
					}

					function apply(_ fn: (_ x: Integer) -> Integer, to value: Integer) -> Integer {
						<- fn(value)
					}

					constant readers: List<(_ x: Integer) -> Integer> = [Reader.readsBase]
					Terminal.inspect(apply(Reader.readsBase, to 1)::toString())
					Terminal.inspect(readers::length()::toString())
				}`),
			).toEqual([])
		})

		// A binding initialised from a Method is declared `StaticMethod`, so
		// the tag must be ignored in both directions of an assignment.
		it("should let a Function literal stand where a Method decided the Type", () => {
			expect(
				errorsFor(`implementation {
					namespace Reader {
						static readsBase(_ x: Integer) -> Integer {
							<- x
						}
					}

					variable read = Reader.readsBase
					read = (_ x: Integer) -> Integer { <- x::add(1) }
					Terminal.inspect(read(1)::toString())
				}`),
			).toEqual([])
		})

		// Of one signature, a `SimpleMethod` and a `StaticMethod` stand for
		// each other.
		it("should let a static and an instance Method stand for one another", () => {
			expect(
				errorsFor(`implementation {
					namespace Reader {
						static readsBase(_ x: Integer) -> Integer {
							<- x
						}
					}

					namespace Doubler for Integer {
						double() -> Integer {
							<- @::add(@)
						}
					}

					variable read = Reader.readsBase
					read = Doubler.double
					Terminal.inspect(read(1)::toString())
				}`),
			).toEqual([])
		})

		// Only the tag is ignored. The signatures are compared as Functions.
		it("should still reject a Method whose signature disagrees", () => {
			let errors = errorsFor(`implementation {
				namespace Reader {
					static readsBase(_ x: Integer) -> Integer {
						<- x
					}
				}

				constant read: (_ x: String) -> Integer = Reader.readsBase
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("assignment-type-mismatch")
		})

		it("should still reject a Function whose signature disagrees with the Method that decided the Type", () => {
			let errors = errorsFor(`implementation {
				namespace Reader {
					static readsBase(_ x: Integer) -> Integer {
						<- x
					}
				}

				variable read = Reader.readsBase
				read = (_ x: String) -> Integer { <- x::length() }
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("assignment-type-mismatch")
		})

		// An overloaded Method is a set of signatures, which the Validator
		// refuses in every value position. That refusal is the one report, so
		// the declared Type does not add a mismatch.
		it("should still refuse an overloaded Method as a value", () => {
			let errors = errorsFor(`implementation {
				namespace Reader {
					overload static readsBase {
						(_ x: Integer) -> Integer {
							<- x
						}

						(_ x: Integer, and y: Integer) -> Integer {
							<- x::add(y)
						}
					}
				}

				constant read: (_ x: Integer) -> Integer = Reader.readsBase
				variable kept = (_ x: Integer) -> Integer { <- x }

				kept = Reader.readsBase
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"overloaded-function-value",
				"overloaded-function-value",
			])
		})

		// The bound `Terminal.print` puts on its Argument is no second mistake,
		// and the call's missing witness is no compiler bug.
		it("should refuse a Function value passed to a bounded Parameter once", () => {
			let errors = errorsFor(`implementation {
				function shown<infer Item is Printable>(_ item: Item) -> String {
					<- item::toString()
				}

				Terminal.print(Integer.add)
				Terminal.print(shown)
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"overloaded-function-value",
				"protocol-bound-function-value",
			])
		})

		// The refusal is the one report wherever the value stands: an Argument,
		// a `<-`, a `define` arm, a Case payload, an update or a receiver. The
		// same holds inside a List or a Record.
		it("should refuse a Function value once in every value position", () => {
			let errors = errorsFor(`implementation {
				function shown<infer Item is Printable>(_ item: Item) -> String {
					<- item::toString()
				}

				function take(_ rule: (_: Integer, _: Integer) -> Integer) -> Integer {
					<- rule(1, 2)
				}

				function pick() -> (_: Integer, _: Integer) -> Integer {
					<- Integer.add
				}

				constant choose = () -> (_: Integer, _: Integer) -> Integer {
					<- Integer.add
				}

				constant flag = true

				constant chosen: (_: Integer, _: Integer) -> Integer = define {
					as Integer.add if flag
					as Integer.add otherwise
				}

				constant rules: List<(_: Integer, _: Integer) -> Integer> = [
					Integer.add,
				]

				choice Holder {
					Has { rule: (_: Integer, _: Integer) -> Integer },
					Empty,
				}

				constant maybe: Optional<(_: Integer, _: Integer) -> Integer> =
					#Value(Integer.add)
				constant held: Holder = #Has({ rule = Integer.add })
				constant base = { rule = (_ a: Integer, _ b: Integer) -> Integer { <- a } }
				constant updated = { base with rule = Integer.add }
				constant book: Dictionary<String, (_: Integer, _: Integer) -> Integer> = [=]
				constant written = [book with "add" = Integer.add]
				constant table = ["add" = Integer.add]

				Terminal.print(take(Integer.add))
				Terminal.print(take(shown))
				Terminal.print([Integer.add])
				Terminal.print({ a = shown })
				Terminal.inspect([[3, 1]]::map(List.sort))
				Terminal.inspect(table::count())
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"protocol-bound-function-value",
				"overloaded-function-value",
				"protocol-bound-function-value",
				"overloaded-function-value",
			])
		})
	})

	// Two Modules may each declare `choice Outcome`, so a Choice's identity is
	// the declaring Module's canonical path and its name. A Program that is no
	// Module keeps the bare name.
	describe("Module-qualified Choice identity", () => {
		const OUTCOME = `implementation {
			choice Outcome {
				Ok { value: Integer },
				Failed,
			}
		}`

		const BOX = `implementation {
			choice Box<Value> {
				Full { value: Value },
			}

			constant full: Box<Integer> = Box<Integer>#Full({ value = 1 })
		}`

		// The Choice a Program declares, enriched as the Module at
		// `modulePath`, or as no Module for null, as a single-file compile is.
		function choiceDeclaredIn(
			modulePath: string | null,
			source: string = OUTCOME,
		): common.typed.ChoiceDeclarationStatementNode {
			let { program, diagnostics } = enrich(
				parse(source),
				modulePath === null ? {} : { modulePath },
			)

			expect(diagnostics).toEqual([])

			let declaration = program.implementation.nodes.find(
				(node) => node.nodeType === "ChoiceDeclarationStatement",
			)

			if (declaration?.nodeType !== "ChoiceDeclarationStatement") {
				throw new Error("The Program declares no Choice.")
			}

			return declaration
		}

		// The Type of the Program's last Constant, an applied generic Choice.
		// `applyGenericBindings` builds a fresh Case per instantiation, which must
		// keep the identity.
		function lastConstantTypeIn(
			modulePath: string,
			source: string,
		): common.Type {
			let { program, diagnostics } = enrich(parse(source), { modulePath })

			expect(diagnostics).toEqual([])

			let constants = program.implementation.nodes.filter(
				(node) => node.nodeType === "ConstantDeclarationStatement",
			)

			return constants[constants.length - 1].value.type
		}

		it("should refuse a Case of another Module's Choice, both ways round", () => {
			let left = choiceDeclaredIn("/modules/left/Outcome.es")
			let right = choiceDeclaredIn("/modules/right/Outcome.es")

			expect(matchesType(left.cases[0].type, right.cases[0].type)).toBe(
				false,
			)
			expect(matchesType(right.cases[0].type, left.cases[0].type)).toBe(
				false,
			)
			expect(matchesType(left.type, right.type)).toBe(false)
			expect(matchesType(right.type, left.type)).toBe(false)
		})

		it("should refuse an instantiated Case of another Module's generic Choice", () => {
			let left = lastConstantTypeIn("/modules/left/Box.es", BOX)
			let right = lastConstantTypeIn("/modules/right/Box.es", BOX)

			expect(matchesType(left, right)).toBe(false)
			expect(matchesType(right, left)).toBe(false)
			expect(
				matchesType(
					left,
					lastConstantTypeIn("/modules/left/Box.es", BOX),
				),
			).toBe(true)
		})

		it("should still match the Cases of one Module's Choice", () => {
			let one = choiceDeclaredIn("/modules/left/Outcome.es")
			let same = choiceDeclaredIn("/modules/left/Outcome.es")

			expect(matchesType(one.cases[0].type, same.cases[0].type)).toBe(
				true,
			)
			expect(matchesType(same.cases[0].type, one.cases[0].type)).toBe(
				true,
			)
			expect(matchesType(one.type, same.type)).toBe(true)
		})

		it("should identify a Program that is no Module by name alone", () => {
			expect(choiceDeclaredIn(null).cases[0].type.choice).toBe("Outcome")
		})

		it("should identify a Module's Choice by its path and its name", () => {
			expect(
				choiceDeclaredIn("/modules/left/Outcome.es").cases[0].type
					.choice,
			).toBe("/modules/left/Outcome.es#Outcome")
		})

		it("should print a Module's Choice under the name it was declared with", () => {
			let declaration = choiceDeclaredIn("/modules/left/Outcome.es")

			expect(describeType(declaration.cases[0].type)).toBe("Outcome#Ok")
			expect(printType(declaration.cases[0].type)).toBe("Outcome#Ok")
			expect(printCaseWithPayload(declaration.cases[0].type)).toBe(
				"Outcome#Ok { value: Integer }",
			)
			expect(printType(declaration.type)).toBe("Outcome")
		})

		it("should name the Choices a Diagnostic asks a reader to pick between", () => {
			let { diagnostics } = enrich(
				parse(`implementation {
					choice Left {
						Shared,
					}

					choice Right {
						Shared,
					}

					constant which = #Shared
				}`),
				{ modulePath: "/modules/Ambiguity.es" },
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("ambiguous-case")
			expect(diagnostics[0].notes).toEqual([
				"'Left' declares '#Shared'.",
				"'Right' declares '#Shared'.",
			])
			expect(diagnostics[0].helps).toEqual([
				"Write 'Left#Shared' to pick 'Left'.",
				"Write 'Right#Shared' to pick 'Right'.",
			])
		})

		it("should name a Module's Case as written where a Diagnostic is about it", () => {
			let { program, diagnostics } = enrich(
				parse(`implementation {
					choice Outcome {
						Ok { value: Integer },
						Failed,
					}

					constant ok = Outcome#Ok({ value = 1 })
					constant missing = ok.absent
				}`),
				{ modulePath: "/modules/Outcome.es" },
			)

			let errors = [...diagnostics, ...validate(program)]

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("unknown-member")
			expect(errors[0].message).toBe(
				"Case 'Outcome#Ok' has no member 'absent'",
			)
			expect(errors[0].notes).toEqual(["Case 'Outcome#Ok' has 'value'."])
		})
	})

	// These build refinement Types directly, so the rules stand apart from any
	// Declaration. A refinement flows into its base, since forgetting evidence
	// loses nothing, and the base does not flow into the refinement. The Union
	// collapse follows from `buildUnion`'s subsumption.
	describe("Checked refinements", () => {
		const integer: common.Type = { type: "Integer" }
		const string: common.Type = { type: "String" }

		function conjunct(
			methodName: string,
			args: Array<string | boolean> = [],
			namespaceName: string = "Integer",
		): common.PredicateConjunct {
			return { namespaceName, methodName, args, negated: false }
		}

		function refinement(
			name: string,
			base: common.Type,
			conjuncts: Array<common.PredicateConjunct>,
		): common.Type {
			return { type: "Refinement", name, base, conjuncts }
		}

		const nonZero = refinement("NonZeroInteger", integer, [
			conjunct("isNot", ["0"]),
		])
		const positiveNonZero = refinement("PositiveNonZeroInteger", integer, [
			conjunct("isNot", ["0"]),
			conjunct("isPositive"),
		])
		const nonEmpty = refinement("NonEmptyString", string, [
			conjunct("hasCharacters", [], "String"),
		])

		it("should accept a refinement where its base is expected", () => {
			expect(matchesType(integer, nonZero)).toBe(true)
		})

		it("should refuse the base where a refinement is expected", () => {
			expect(matchesType(nonZero, integer)).toBe(false)
		})

		it("should accept a refinement where itself is expected", () => {
			expect(matchesType(nonZero, nonZero)).toBe(true)
		})

		// A value known to be non-zero and positive is known to be non-zero.
		it("should accept a refinement proving a superset of the conjuncts", () => {
			expect(matchesType(nonZero, positiveNonZero)).toBe(true)
		})

		it("should refuse a refinement proving only some of the conjuncts", () => {
			expect(matchesType(positiveNonZero, nonZero)).toBe(false)
		})

		// What a leaf implies is proven by it. Less than, greater than and equal
		// to one bound exclude each other and cover everything. So a value above
		// zero is proven neither zero nor below it.
		describe("what one comparison says about the others", () => {
			const above = refinement("PositiveInteger", integer, [
				conjunct("isGreaterThan", ["0"]),
			])
			const notZero = refinement("NonZeroInteger", integer, [
				{ ...conjunct("is", ["0"]), negated: true },
			])
			const notBelow = refinement("NonNegativeInteger", integer, [
				{ ...conjunct("isLessThan", ["0"]), negated: true },
			])

			it("should accept a leaf where what it excludes is expected", () => {
				expect(matchesType(notZero, above)).toBe(true)
				expect(matchesType(notBelow, above)).toBe(true)
			})

			// The other way round proves nothing. A value that is merely
			// not zero may be below it.
			it("should refuse an exclusion where the leaf is expected", () => {
				expect(matchesType(above, notZero)).toBe(false)
				expect(matchesType(above, notBelow)).toBe(false)
			})

			// Two exclusions leave the third standing. The pair is read together,
			// since neither half alone says anything about direction.
			it("should accept the leaf two exclusions leave standing", () => {
				let neither = refinement("Neither", integer, [
					{ ...conjunct("is", ["0"]), negated: true },
					{ ...conjunct("isLessThan", ["0"]), negated: true },
				])

				expect(matchesType(above, neither)).toBe(true)
				expect(matchesType(above, notZero)).toBe(false)
			})

			// `isBetween` excludes what lies outside its bounds, and the bounds
			// name the same range in either order.
			it("should read a pair of bounds either way round", () => {
				let within = refinement("Digit", integer, [
					conjunct("isBetween", ["0", "9"]),
				])
				let backwards = refinement("Backwards", integer, [
					conjunct("isBetween", ["9", "0"]),
				])

				expect(matchesType(notBelow, within)).toBe(true)
				expect(matchesType(notBelow, backwards)).toBe(true)
			})

			// The bound is part of the question. Nothing is read across two
			// literals, so the closure a leaf carries stays small.
			it("should read nothing across two bounds", () => {
				let aboveOne = refinement("AboveOne", integer, [
					conjunct("isGreaterThan", ["1"]),
				])

				expect(matchesType(notZero, aboveOne)).toBe(false)
			})
		})

		// The conjunct set is compared by key, so the order of the conjuncts
		// does not matter.
		it("should ignore the order the conjuncts stand in", () => {
			let reversed = refinement("PositiveNonZeroInteger", integer, [
				conjunct("isPositive"),
				conjunct("isNot", ["0"]),
			])

			expect(matchesType(positiveNonZero, reversed)).toBe(true)
			expect(matchesType(reversed, positiveNonZero)).toBe(true)
		})

		// A conjunct is the question asked, not the alias' name. Two aliases
		// proving the same thing are one Type, whatever they are called.
		it("should decide by the conjuncts rather than by the alias name", () => {
			let sameQuestion = refinement("NotZero", integer, [
				conjunct("isNot", ["0"]),
			])
			let otherArgument = refinement("NonOneInteger", integer, [
				conjunct("isNot", ["1"]),
			])

			expect(matchesType(nonZero, sameQuestion)).toBe(true)
			expect(matchesType(nonZero, otherArgument)).toBe(false)
		})

		it("should refuse a refinement over another base", () => {
			expect(matchesType(nonZero, nonEmpty)).toBe(false)
			expect(matchesType(nonEmpty, nonZero)).toBe(false)
			expect(matchesType(string, nonZero)).toBe(false)
		})

		it("should unwrap a refinement inside a List", () => {
			let refinedItems: common.Type = { type: "List", itemType: nonZero }
			let plainItems: common.Type = { type: "List", itemType: integer }

			expect(matchesType(plainItems, refinedItems)).toBe(true)
			expect(matchesType(refinedItems, plainItems)).toBe(false)
		})

		it("should let a Union holding the base accept the refinement", () => {
			let numberish: common.Type = {
				type: "UnionType",
				types: [integer, string],
			}

			expect(matchesType(numberish, nonZero)).toBe(true)
		})

		// The expected Union decomposes before the refinement is unwrapped, so
		// its `NonZeroInteger` member meets the refinement rather than a bare
		// Integer.
		it("should let a Union holding the refinement accept it", () => {
			let refined: common.Type = {
				type: "UnionType",
				types: [nonZero, string],
			}

			expect(matchesType(refined, nonZero)).toBe(true)

			// Proving more than the member asks is enough, by the same subset
			// rule.
			expect(matchesType(refined, positiveNonZero)).toBe(true)

			// A bare Integer has no evidence to offer the member.
			expect(matchesType(refined, integer)).toBe(false)
		})

		// A refinement hoists with `conjuncts: null` until its predicate is
		// read, and nothing may be decided about it before. Hoisting reads the
		// throw as "not this round". Widening into the base needs no conjuncts.
		it("should refuse to decide about a pending refinement by throwing", () => {
			let pending: common.Type = {
				type: "Refinement",
				name: "Pending",
				base: integer,
				conjuncts: null,
			}

			expect(() => matchesType(pending, nonZero)).toThrow(
				"read before it resolved",
			)
			expect(() => matchesType(nonZero, pending)).toThrow(
				"read before it resolved",
			)

			expect(matchesType(integer, pending)).toBe(true)
		})

		// An Error matches in both directions so one mistake does not cascade,
		// and the refinement rules stand behind that guard.
		it("should let an Error match a refinement in both directions", () => {
			let error: common.Type = { type: "Error" }

			expect(matchesType(nonZero, error)).toBe(true)
			expect(matchesType(error, nonZero)).toBe(true)
		})

		// At the outermost position, a Type Parameter inferred from a refined
		// Argument binds the base. So a walk seeded with a `NonZeroInteger` whose
		// step answers a plain Integer compiles. One level in, the rule is the
		// opposite.
		it("should bind a Type Parameter to the base rather than the refinement", () => {
			let context = createInferenceContext([
				{ name: "T", infer: true, defaultType: null },
			])

			expect(
				matchesTypeWithBindings(
					{ type: "GenericUse", name: "T" },
					nonZero,
					context,
				),
			).toBe(true)
			expect(context.bindings.get("T")).toEqual(integer)
		})

		// Both orders, since `subsumesForUnion` asks assignability one way and
		// then the other, and only the base subsumes here. `isLessSpecific` gives
		// a refinement no precedence in a Union.
		it("should collapse a Union of a refinement and its base, either order", () => {
			expect(buildUnion([integer, nonZero])).toEqual(integer)
			expect(buildUnion([nonZero, integer])).toEqual(integer)
		})

		it("should keep a refinement in a Union nothing there covers", () => {
			expect(buildUnion([string, nonZero])).toEqual({
				type: "UnionType",
				types: [string, nonZero],
			})
		})

		// A value proving both conjuncts proves one of them, so the wider
		// refinement covers the narrower, in either order. This is the same
		// subsumption, not an order of refinements.
		it("should collapse two refinements into the wider one, either order", () => {
			expect(buildUnion([nonZero, positiveNonZero])).toEqual(nonZero)
			expect(buildUnion([positiveNonZero, nonZero])).toEqual(nonZero)
			expect(buildUnion([nonZero, positiveNonZero, integer])).toEqual(
				integer,
			)
		})

		it("should describe and print a refinement under its alias name", () => {
			expect(describeType(nonZero)).toBe("NonZeroInteger")
			expect(printType(nonZero)).toBe("NonZeroInteger")
			expect(printType({ type: "List", itemType: nonZero })).toBe(
				"List<NonZeroInteger>",
			)
		})

		// A generic refinement needs no rule of its own. Its conjuncts say
		// nothing about the items, so two instantiations differ only by their
		// bases, which the ordinary rule compares.
		describe("applied to a generic Alias", () => {
			function nonEmptyOf(itemType: common.Type): common.Type {
				return {
					type: "Refinement",
					name: "NonEmptyList",
					base: { type: "List", itemType },
					conjuncts: [conjunct("hasItems", [], "List")],
					typeArguments: [itemType],
				}
			}

			const nonEmptyStrings = nonEmptyOf(string)
			const nonEmptyIntegers = nonEmptyOf(integer)
			const strings: common.Type = { type: "List", itemType: string }

			it("should accept the same instantiation and refuse another", () => {
				expect(matchesType(nonEmptyStrings, nonEmptyStrings)).toBe(true)
				expect(matchesType(nonEmptyStrings, nonEmptyIntegers)).toBe(
					false,
				)
			})

			it("should flow into its base and refuse the base back", () => {
				expect(matchesType(strings, nonEmptyStrings)).toBe(true)
				expect(matchesType(nonEmptyStrings, strings)).toBe(false)
			})

			// The applied spelling is only for display, as a Union's name is.
			it("should decide by the base and the conjuncts, never by the spelling", () => {
				let unstamped: common.Type = {
					type: "Refinement",
					name: "Several",
					base: strings,
					conjuncts: [conjunct("hasItems", [], "List")],
				}

				expect(matchesType(nonEmptyStrings, unstamped)).toBe(true)
				expect(matchesType(unstamped, nonEmptyStrings)).toBe(true)
			})

			// A `T` inferred from a NonEmptyList Argument binds the base,
			// `List<String>`, as in the non-generic case.
			it("should bind a Type Parameter to the instantiated base", () => {
				let context = createInferenceContext([
					{ name: "T", infer: true, defaultType: null },
				])

				expect(
					matchesTypeWithBindings(
						{ type: "GenericUse", name: "T" },
						nonEmptyStrings,
						context,
					),
				).toBe(true)
				expect(context.bindings.get("T")).toEqual(strings)
			})

			// One level in the rule is the opposite. A refinement as a Type
			// Argument was written or promised, and no later value widens an item
			// Type. So `T` binds the refinement, and `groups::firstItem()` keeps it.
			it("should bind a Type Parameter inside a Type to the refinement", () => {
				let context = createInferenceContext([
					{ name: "T", infer: true, defaultType: null },
				])

				expect(
					matchesTypeWithBindings(
						{
							type: "List",
							itemType: { type: "GenericUse", name: "T" },
						},
						{ type: "List", itemType: nonEmptyStrings },
						context,
					),
				).toBe(true)
				expect(context.bindings.get("T")).toEqual(nonEmptyStrings)
			})

			// The bound refinement then matches itself both ways. A literal's
			// Parameter typed off the binding meets the flipped direction.
			it("should measure a bound refinement against itself either way round", () => {
				let context = createInferenceContext([
					{ name: "T", infer: true, defaultType: null },
				])
				let generic: common.Type = { type: "GenericUse", name: "T" }

				expect(
					matchesTypeWithBindings(
						{ type: "List", itemType: generic },
						{ type: "List", itemType: nonEmptyStrings },
						context,
					),
				).toBe(true)
				expect(
					matchesTypeWithBindings(nonEmptyStrings, generic, context),
				).toBe(true)
				expect(matchesTypeWithBindings(strings, generic, context)).toBe(
					true,
				)
				expect(matchesTypeWithBindings(generic, strings, context)).toBe(
					false,
				)
			})

			// `groups::append(proven)` hands a `NonEmptyList<String>` to an
			// `ItemType` bound to one, so the proven Argument must not be widened
			// first. A value without the proof is refused.
			it("should accept a proven Argument where a bound refinement stands", () => {
				let context = createInferenceContext([
					{ name: "T", infer: true, defaultType: null },
				])
				let generic: common.Type = { type: "GenericUse", name: "T" }

				expect(
					matchesTypeWithBindings(
						{ type: "List", itemType: generic },
						{ type: "List", itemType: nonEmptyStrings },
						context,
					),
				).toBe(true)
				expect(
					matchesTypeWithBindings(generic, nonEmptyStrings, context),
				).toBe(true)
				expect(matchesTypeWithBindings(generic, strings, context)).toBe(
					false,
				)
			})

			// An unbound Type Parameter on the actual side gets nothing from a
			// refinement, so this is no second inference route.
			it("should refuse a refinement against an unbound Type Parameter", () => {
				let context = createInferenceContext([
					{ name: "T", infer: true, defaultType: null },
				])

				expect(
					matchesTypeWithBindings(
						nonEmptyStrings,
						{ type: "GenericUse", name: "T" },
						context,
					),
				).toBe(false)
			})

			it("should collapse a Union of an instantiation and its base, either order", () => {
				expect(buildUnion([strings, nonEmptyStrings])).toEqual(strings)
				expect(buildUnion([nonEmptyStrings, strings])).toEqual(strings)
			})

			// Their bases cover nothing of each other, so the Union keeps both.
			it("should keep two instantiations a Union does not cover", () => {
				expect(buildUnion([nonEmptyStrings, nonEmptyIntegers])).toEqual(
					{
						type: "UnionType",
						types: [nonEmptyStrings, nonEmptyIntegers],
					},
				)
			})

			it("should print and describe an instantiation as applied", () => {
				expect(printType(nonEmptyStrings)).toBe("NonEmptyList<String>")
				expect(describeType(nonEmptyStrings)).toBe(
					"NonEmptyList<String>",
				)
				expect(printType(nonEmptyOf(nonZero))).toBe(
					"NonEmptyList<NonZeroInteger>",
				)

				// An instantiation over Type Parameters alone, as in a generic
				// Namespace's target, prints tersely rather than echo its header.
				expect(
					printType(nonEmptyOf({ type: "GenericUse", name: "Item" })),
				).toBe("NonEmptyList")
			})
		})
	})
})
