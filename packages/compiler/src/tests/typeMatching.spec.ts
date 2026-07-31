import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { enrich } from "../enricher/index"
import {
	buildUnion,
	createInferenceContext,
	describeType,
	matchesType,
	matchesTypeWithBindings,
} from "../helpers/index"
import { parse } from "../parser/index"
import { printCaseWithPayload, printType } from "../printType"
import { validate } from "../validator/index"

// NOTE: These are end-to-end, because each of these bugs only became visible
// once the Enricher had decided a Type and the Validator had judged it: the
// Type logic in `src/helpers` answered plausibly on its own and wrongly in
// concert.
function errorsFor(source: string) {
	let { program, diagnostics } = enrich(parse(source))

	return [...diagnostics, ...validate(program)].filter(
		(diagnostic) => diagnostic.severity === "error",
	)
}

describe("Type matching", () => {
	describe("Union building", () => {
		// NOTE: An empty List Literal is typed `List<Unknown>`, which is a
		// wildcard in BOTH directions — it accepts `List<Integer>` and is
		// accepted by it — so Union building saw the two subsume one another
		// and kept whichever came first. Written `[[], [1]]` the Literal
		// therefore inferred `List<List<Unknown>>`, a Type that fits EVERY
		// List Type, and the annotation below was accepted for a List of
		// Integers while the same Literal spelled `[[1], []]` was rejected.
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

		// NOTE: The placeholder losing the Union costs an empty List Literal
		// nothing — it still fits every List Type, in a Literal, an annotation
		// or an Argument.
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

	// NOTE: A bare `List` demands nothing of the items, so it accepts every
	// List. The reverse used to hold too, and that direction PROMISES something
	// a bare `List` never said: a List of Integers arrived where a
	// `List<String>` was declared, and every String Method then ran on
	// Integers. An empty List Literal is the case the loose direction was there
	// for, and it has a rule of its own — an undecided item Type is a slot
	// nothing has filled, not a claim to hold anything at all.
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

	describe("Union member inference", () => {
		// NOTE: Matching the Argument against the first member binds
		// `T := String` off `left` and THEN fails on `right`. That binding is
		// worth no more than the member that made it, but it used to survive
		// the failure, so the second member — which matches on its own with
		// `T := Integer` — was checked against the leftover `T := String` and
		// wrongly rejected. Which of the two spellings compiled came down to
		// the order the Union was written in.
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
		// NOTE: An unannotated Function literal is typed FROM the Parameter it
		// is passed to. Matched while `T` was still open it echoed `T` itself
		// back, which pinned the Generic to its own name — from then on it was
		// opaque, `to 5` could no longer bind it, and this valid Program was
		// rejected with `argument-type-mismatch` while `result` was recorded
		// as a `T` that exists in no scope the caller can see.
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

		// NOTE: The callback is resolved against the BOUND signature, so its
		// Parameter carries the Type the Argument named — which is what lets
		// the body call an Integer Method on it at all.
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

		// NOTE: Resolved against the bound `(_: Integer) -> Integer`, a body
		// answering with a String is a return-Type mismatch INSIDE the lambda
		// — the Diagnostic points at the answer that does not fit rather than
		// at the whole Argument.
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

		// NOTE: A callback that is the ONLY source of a binding still binds it
		// — `map`'s transform names `Result` in its return Type and nowhere
		// else, and deferring it changes nothing about that.
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
		// NOTE: `Reader.readsBase` names a Method without calling it, and a
		// named Method is typed `StaticMethod`/`SimpleMethod` rather than
		// `Function` — a tag saying where the signature was written, not a
		// different kind of value. Matched by tag alone, EVERY Function
		// annotation refused one: `constant`, `variable`, static Property,
		// Argument and List item alike, while the identical unannotated
		// binding was accepted and ran fine.
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

		// NOTE: An instance Method carries its receiver as the first Parameter
		// of its Type, and is emitted taking it there — so it fits the
		// Function Type that spells the receiver out.
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

		// NOTE: The receiver Parameter is the whole reason the Method below
		// does not fit, so both sides of the Diagnostic spell their signature
		// out. Both used to read the bare word "Function", which named the tag
		// and said nothing about why the two did not meet.
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

		// NOTE: The tag travels: an unannotated binding initialised from a
		// Method is DECLARED `StaticMethod`, and every later assignment is
		// measured against that. Both directions have to wave the tag through,
		// or the mirrored Program — `variable read = <literal>` taking a
		// Method — would be the only one of the two that compiles.
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

		// NOTE: `SimpleMethod` and `StaticMethod` say where the signature was
		// written down, not what the value is — of one signature, either
		// stands for the other.
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

		// NOTE: Only the tag is waved through — the signature is judged
		// exactly as one Function against another.
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

		// NOTE: An overloaded Method is a SET of signatures and is refused in
		// every value position by the Validator, annotation or not.
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
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"assignment-type-mismatch",
				"overloaded-function-value",
			])
		})
	})

	// NOTE: A Case is nominal by `(choice, name)`, and with Modules the Choice's
	// written name is no longer unique in a Program: two files each declaring
	// `choice Result` used to make interchangeable Types AND the same runtime
	// tag, so `is` and `match` confused them with no Diagnostic anywhere. The
	// identity is the declaring Module's canonical path and the name, and a
	// Program that is no Module keeps the bare name — which is why every Program
	// in every other spec, `__golden__` file and snapshot is untouched.
	describe("Module-qualified Choice identity", () => {
		const RESULT = `implementation {
			choice Result {
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

		// NOTE: The Choice a Program declares, enriched as the Module at
		// `modulePath` — or, for null, as no Module at all, which is what a single
		// file compile does.
		function choiceDeclaredIn(
			modulePath: string | null,
			source: string = RESULT,
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

		// NOTE: The Type of the Program's last Constant, which is how the applied
		// spelling of a generic Choice is asked for: `applyGenericBindings` builds
		// a fresh Case for every instantiation, and the identity has to survive
		// that as much as the declaration does.
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
			let left = choiceDeclaredIn("/modules/left/Result.es")
			let right = choiceDeclaredIn("/modules/right/Result.es")

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
			let one = choiceDeclaredIn("/modules/left/Result.es")
			let same = choiceDeclaredIn("/modules/left/Result.es")

			expect(matchesType(one.cases[0].type, same.cases[0].type)).toBe(
				true,
			)
			expect(matchesType(same.cases[0].type, one.cases[0].type)).toBe(
				true,
			)
			expect(matchesType(one.type, same.type)).toBe(true)
		})

		it("should identify a Program that is no Module by name alone", () => {
			expect(choiceDeclaredIn(null).cases[0].type.choice).toBe("Result")
		})

		it("should identify a Module's Choice by its path and its name", () => {
			expect(
				choiceDeclaredIn("/modules/left/Result.es").cases[0].type
					.choice,
			).toBe("/modules/left/Result.es#Result")
		})

		it("should print a Module's Choice under the name it was declared with", () => {
			let declaration = choiceDeclaredIn("/modules/left/Result.es")

			expect(describeType(declaration.cases[0].type)).toBe("Result#Ok")
			expect(printType(declaration.cases[0].type)).toBe("Result#Ok")
			expect(printCaseWithPayload(declaration.cases[0].type)).toBe(
				"Result#Ok { value: Integer }",
			)
			expect(printType(declaration.type)).toBe("Result")
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
					choice Result {
						Ok { value: Integer },
						Failed,
					}

					constant ok = Result#Ok({ value = 1 })
					constant missing = ok.absent
				}`),
				{ modulePath: "/modules/Result.es" },
			)

			let errors = [...diagnostics, ...validate(program)]

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("unknown-member")
			expect(errors[0].message).toBe(
				"Case 'Result#Ok' has no member 'absent'",
			)
			expect(errors[0].notes).toEqual(["Case 'Result#Ok' has 'value'."])
		})
	})

	// NOTE: Checked refinements have no syntax yet, so these build the Types
	// directly — which is also the only way to state the rules on their own,
	// away from whatever a Declaration will decide about them.
	//
	// NOTE: The direction is the whole of it. A refinement flows into its base
	// for free, because forgetting evidence loses nothing; the base does NOT
	// flow into the refinement, because that is the mistake the Type exists to
	// name. Everything else here follows from those two, including the union
	// collapse — which is not a rule of its own but what `buildUnion`'s
	// subsumption order already does once assignability answers this way.
	describe("Checked refinements", () => {
		const integer: common.Type = { type: "Integer" }
		const string: common.Type = { type: "String" }

		function conjunct(
			methodName: string,
			args: Array<string | boolean> = [],
			namespaceName: string = "Integer",
		): common.PredicateConjunct {
			return { namespaceName, methodName, overloadIndex: null, args }
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
			conjunct("hasAnyContent", [], "String"),
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

		// NOTE: Proving more than was asked is proof enough — a value known to
		// be non-zero AND positive is a value known to be non-zero.
		it("should accept a refinement proving a superset of the conjuncts", () => {
			expect(matchesType(nonZero, positiveNonZero)).toBe(true)
		})

		it("should refuse a refinement proving only some of the conjuncts", () => {
			expect(matchesType(positiveNonZero, nonZero)).toBe(false)
		})

		// NOTE: The conjunct set is compared by KEY, so the same predicate
		// written the other way round is the same Type. Which is why the
		// canonical form exists, and why nothing here relies on the order.
		it("should ignore the order the conjuncts stand in", () => {
			let reversed = refinement("PositiveNonZeroInteger", integer, [
				conjunct("isPositive"),
				conjunct("isNot", ["0"]),
			])

			expect(matchesType(positiveNonZero, reversed)).toBe(true)
			expect(matchesType(reversed, positiveNonZero)).toBe(true)
		})

		// NOTE: A conjunct is the QUESTION, not the name of an alias — two
		// aliases proving the same thing are the same Type, and two proving
		// different things are not, whatever they are called.
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

		// NOTE: The expected Union decomposes BEFORE the refinement is
		// unwrapped. Stripping the evidence first would leave the Union's own
		// refinement member facing a bare Integer — so `NonZeroInteger | String`
		// refused the very `NonZeroInteger` it names, while accepting it
		// through an `Integer` member it did not have.
		it("should let a Union holding the refinement accept it", () => {
			let refined: common.Type = {
				type: "UnionType",
				types: [nonZero, string],
			}

			expect(matchesType(refined, nonZero)).toBe(true)

			// NOTE: Proving more than the member asks is proof enough — the
			// same subset rule that answers the bare-refinement case.
			expect(matchesType(refined, positiveNonZero)).toBe(true)

			// NOTE: And the Union stays as demanding as its member: a bare
			// Integer still has no evidence to offer it.
			expect(matchesType(refined, integer)).toBe(false)
		})

		// NOTE: A refinement hoists with `conjuncts: null` while the Namespace
		// answering its predicate is still on its way, and NOTHING may be
		// decided about a predicate nobody has read — the throw is what the
		// hoisting rounds read as "not this round". Except the widening
		// direction, which forgets the evidence rather than reading it: a
		// refinement flows into its base whatever its predicate turns out to
		// say, so that answer needs no conjuncts at all.
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

		// NOTE: An Error is a poison value and matches in both directions, so
		// that one mistake does not cascade. A refinement is not an exception to
		// that, which is what the rules being placed BEHIND the Error guard says.
		it("should let an Error match a refinement in both directions", () => {
			let error: common.Type = { type: "Error" }

			expect(matchesType(nonZero, error)).toBe(true)
			expect(matchesType(error, nonZero)).toBe(true)
		})

		// NOTE: The widening rule sits ahead of Generic binding on purpose. A
		// Type Parameter inferred from a refined Argument binds the BASE, so no
		// inference carries evidence into a position nothing proved anything
		// about — refinement-typed Generic bindings are explicitly v2.
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

		// NOTE: Both insertion orders, because Union building is where a
		// directional rule most easily reads as an order-dependent one:
		// `subsumesForUnion` asks assignability in one direction and then asks
		// whether the two subsume each ANOTHER, and only the base does here. So
		// the refinement is dropped whichever side it was collected from, and
		// `isLessSpecific` is deliberately left alone — nothing about a
		// refinement is meant to win a Union.
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

		// NOTE: And the same collapse one step in: every value proving both
		// conjuncts is a value proving one of them, so the WIDER refinement
		// covers the narrower and the narrower goes — again from either side,
		// since one of the two evicts and the other declines to be collected.
		// Nothing here is a most-specific-refinement order; it is the same
		// subsumption asking the same question.
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

		// NOTE: A GENERIC refinement needs no rule of its own, which is the whole
		// design finding: its conjuncts say nothing about the items, so two
		// instantiations of one Alias differ by their BASES — which `matchTypes`
		// has always compared. Everything below is the ordinary refinement rule
		// answering a question about `List<String>` versus `List<Integer>`.
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

			// NOTE: The applied spelling is display-only, exactly as a Union's
			// name is — two refinements proving the same thing about the same base
			// are one Type however they were spelled.
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

			// NOTE: A Type Parameter binds the BASE here too — a `T` inferred from
			// a NonEmptyList Argument is `List<String>`, and no inference carries
			// evidence into a position nothing proved anything about.
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

			it("should collapse a Union of an instantiation and its base, either order", () => {
				expect(buildUnion([strings, nonEmptyStrings])).toEqual(strings)
				expect(buildUnion([nonEmptyStrings, strings])).toEqual(strings)
			})

			// NOTE: And two instantiations of one Alias cover nothing of each
			// other, because their bases do not — the Union keeps both.
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

				// NOTE: An instantiation that bound every Parameter to a Parameter
				// — a generic Namespace's own target — reads terse, because
				// `NonEmptyList<Item>` would only echo the header it is written under.
				expect(
					printType(nonEmptyOf({ type: "GenericUse", name: "Item" })),
				).toBe("NonEmptyList")
			})
		})
	})
})
