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
function diagnosticsFor(source: string) {
	let { program, diagnostics } = enrich(parse(source))

	return [...diagnostics, ...validate(program)]
}

function errorsFor(source: string) {
	return diagnosticsFor(source).filter(
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

		// An Error matches every member, so a written Union keeping or dropping
		// it would depend on the order. A Match over it is then no second
		// mistake.
		it("should leave a written Union with an undeclared member a hole", () => {
			let source = (union: string) => `implementation {
				type Pair = ${union}

				function describe(_ value: ${union}) -> String {
					<- match value -> String {
						case Integer { <- "number" }
						case _       { <- "other" }
					}
				}

				constant paired: Pair = 1

				constant described = match paired -> String {
					case Integer { <- "number" }
					case _       { <- "other" }
				}
			}`

			// Sorted, since the hoist may report the Function's first.
			for (let union of ["Integer | Colr", "Colr | Integer"]) {
				let reports = diagnosticsFor(source(union)).map(
					(diagnostic) =>
						`${diagnostic.code}@${diagnostic.position?.start.line}`,
				)

				expect(reports.sort()).toEqual([
					"unknown-type@2",
					"unknown-type@4",
				])
			}
		})

		// The hole stands beside the members that resolved, so what is done
		// with an Integer is still measured.
		it("should keep a written Union's known members beside its hole", () => {
			expect(
				diagnosticsFor(`implementation {
					type Pair = Integer | Colr

					function describe(_ value: Pair) -> String {
						<- match value -> String {
							case Integer { <- value::add("a") }
							case _       { <- "other" }
						}
					}

					function other(_ value: Integer | Colr) -> Integer {
						<- value::add("x")
					}
				}`)
					.map(
						(diagnostic) =>
							`${diagnostic.code}@${diagnostic.position?.start.line}`,
					)
					.sort(),
			).toEqual([
				"no-matching-overload@12",
				"no-matching-overload@6",
				"unknown-type@11",
				"unknown-type@2",
			])
		})

		// Measured or called, the Union is its known members: an Integer fits
		// where an Integer is expected, and a String still does not.
		it("should let a Union holding a hole fit where its known members fit", () => {
			expect(
				diagnosticsFor(`implementation {
					type Pair = Integer | Colr
					type Boxed = { n: Integer }

					function id<infer T>(_ v: T) -> T {
						<- v
					}

					function fits(_ value: Pair, _ values: List<Pair>) -> Integer {
						constant n: Integer = value
						constant listed: List<Integer> = [value]
						constant boxed: Boxed = { n = value }
						constant kept: List<Integer> = values
						constant same: Integer = id(value)
						variable v: Integer = 0
						v = value
						constant matched = match id(value) -> Integer {
							case Integer { <- @ }
							case _       { <- 0 }
						}
						<- value::add(1)
					}

					function refused(_ value: Pair) -> String {
						<- value
					}
				}`)
					.map(
						(diagnostic) =>
							`${diagnostic.code}@${diagnostic.position?.start.line}`,
					)
					.sort(),
			).toEqual(["return-type-mismatch@25", "unknown-type@2"])
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

		// A call of the wrong count still meets each Parameter at its place, so
		// its literal is typed and the count is the one mistake.
		it("should report a call of the wrong count once beside its literal", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function twice(_ f: (_: Integer) -> Integer, _ n: Integer) -> Integer {
					<- f(f(n))
				}

				function apply <infer T>(_ fn: (_: T) -> T, _ value: T) -> T {
					<- fn(value)
				}

				constant extra = twice((x) { <- x }, 1, 2)
				constant missing = twice((x) { <- x })
				constant bound = apply((x) { <- x::add(1) }, 1, 2)
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["argument-count-mismatch", 10],
				["argument-count-mismatch", 11],
				["argument-count-mismatch", 12],
			])
		})

		// A literal meets the Parameter of its label, or the unlabelled one at
		// its place. One past the last, or at a place taking no Function, is no
		// mistake of its own. The count is still measured beside its hole, and
		// a mistake in a literal's body is its own.
		it("should read each literal of a refused call at its place", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function twice(_ f: (_: Integer) -> Integer, _ n: Integer) -> Integer {
					<- f(f(n))
				}

				function labelled(by n: Integer = 1, step f: (_: Integer) -> Integer) -> Integer {
					<- f(n)
				}

				namespace Twice for Integer {
					twice(_ f: (_: Integer) -> Integer, _ n: Integer) -> Integer {
						<- f(f(n))
					}
				}

				constant past = twice((y) { <- y }, 2, (x) { <- x })
				constant swapped = twice(1, (x) { <- x }, 2)
				constant body = twice((x) { <- x::add("s") }, 1, 2)
				constant named = labelled(step (x) { <- x::add("t") }, by 1, 2)
				constant reordered = labelled(step (x) { <- x }, 1)
				constant method = 1::twice((x) { <- x::add("u") }, 1, 2)
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["no-matching-overload", 18],
				["no-matching-overload", 19],
				["no-matching-overload", 21],
				["no-matching-overload", 21],
				["argument-count-mismatch", 16],
				["argument-count-mismatch", 17],
				["argument-count-mismatch", 18],
				["argument-count-mismatch", 19],
				["argument-label-mismatch", 20],
				["argument-label-mismatch", 20],
			])
		})

		// A label no Parameter carries meets the Parameter its place pairs it
		// with, as the label mismatch reads it. The literal is typed there, so
		// only its body's own mistake joins the label's.
		it("should read a literal whose label names no Parameter at its place", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function mixed(_ a: Integer, step f: (_ x: Integer) -> Integer) -> Integer {
					<- f(a)
				}

				namespace Steps for Integer {
					mix(step f: (_ x: Integer) -> Integer) -> Integer {
						<- f(@)
					}
				}

				constant plain = mixed(1, stepp (x) { <- x })
				constant body = mixed(1, stepp (x) { <- x::add("s") })
				constant method = 1::mix(stepp (x) { <- x::add("t") })
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.message,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["No overload of 'add' accepts these Arguments", 13],
				["No overload of 'mix' accepts these Arguments", 14],
				["No overload of 'add' accepts these Arguments", 14],
				["This Argument is not labelled 'step'", 12],
				["This Argument is not labelled 'step'", 13],
			])
		})

		// Where the Parameter at its place is taken by a label, such an
		// Argument meets the one Parameter left unpaired.
		it("should read a literal whose label names no Parameter at the one left", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function two(step f: (_ x: Integer) -> Integer, by g: (_ x: String) -> Integer) -> Integer {
					<- 1
				}

				constant swapped = two(by (x) { <- x::length() }, stepp (x) { <- x::add(1) })
				constant body = two(by (x) { <- x::length() }, stepp (x) { <- x::add("s") })
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["no-matching-overload", 7],
				["argument-label-mismatch", 6],
				["argument-label-mismatch", 6],
				["argument-label-mismatch", 7],
				["argument-label-mismatch", 7],
			])
		})

		// The call still answers its declared Type, so what is done with the
		// answer is measured. A literal paired with a Function at its place
		// still reports a Parameter that Function lacks.
		it("should keep what a refused call answers and its literals' own mistakes", () => {
			expect(
				diagnosticsFor(`implementation {
					function twice(_ f: (_: Integer) -> Integer, _ n: Integer) -> Integer {
						<- f(f(n))
					}

					function plain(_ n: Integer) -> Integer {
						<- n
					}

					constant b: String = plain(1, 2)
					constant c = plain(1, 2)::append("s")
					constant e: String = plain()
					constant extra = twice((x, y) { <- x }, 1, 2)
				}`)
					.map(
						(diagnostic) =>
							`${diagnostic.code}@${diagnostic.position?.start.line}`,
					)
					.sort(),
			).toEqual([
				"argument-count-mismatch@10",
				"argument-count-mismatch@11",
				"argument-count-mismatch@12",
				"argument-count-mismatch@13",
				"assignment-type-mismatch@10",
				"assignment-type-mismatch@12",
				"uninferable-parameter-type@13",
				"unknown-method@11",
			])
		})

		// A written Union holding a hole is no hole as an Argument: its known
		// members are measured against the Parameter.
		it("should measure an Argument holding a hole by its known members", () => {
			expect(
				diagnosticsFor(`implementation {
					type Pair = Integer | Colr

					function takesString(_ s: String) -> String {
						<- s
					}

					function described(_ value: Pair) -> String {
						<- takesString(value)
					}
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-type", "argument-type-mismatch"])
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

		// A default, a String hole, a receiver, a `start` or `complete` operand
		// and a Case payload default are values too. The refusal is their one
		// report, and a call of a `define` holding one adds none.
		it("should refuse a Function value once beside the checks on its position", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function shown<infer Item is Printable>(_ item: Item) -> String {
					<- item::toString()
				}

				function apply(_ rule: (_: Integer, _: Integer) -> Integer = Integer.add) -> Integer {
					<- rule(1, 2)
				}

				function show(_ rule: (_: Integer) -> String = shown) -> String {
					<- rule(1)
				}

				choice Holder {
					Has { rule: (_: Integer, _: Integer) -> Integer } = { rule = Integer.add },
					Empty,
				}

				function waits() -> Future<Integer> {
					constant done = complete Integer.add
					<- 1
				}

				constant flag = true
				constant either = define {
					as (a: Integer, b: Integer) -> Integer { <- a } if flag
					as Integer.add otherwise
				}

				Terminal.print("{Integer.add} {shown}")
				Terminal.print(Integer.add::toString())
				Terminal.inspect(start Integer.add)
				Terminal.print(either(1, 2))
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"overloaded-function-value",
				"protocol-bound-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"protocol-bound-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
			])
		})

		// A callee other than a name or a static path is walked, and a Lookup
		// callee's base is a value. A refused Function in either is reported.
		it("should refuse a Function value written inside a callee", () => {
			let errors = errorsFor(`implementation {
				Terminal.print({ rule = Integer.add }(1, 2))
				Terminal.print([Integer.add](1, 2))
				Terminal.print({ rule = Integer.add }.rule(1, 2))
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
			])
		})

		// A `start` or `complete` before no work answers its operand, so the
		// operand is what was written as a value.
		it("should refuse the operand of a `start`, not the keyword", () => {
			let source = `implementation {
				Terminal.inspect(start Integer.add)
			}`
			let [refusal] = diagnosticsFor(source)

			expect(refusal.code).toBe("overloaded-function-value")
			expect(refusal.position?.start.column).toBe(
				source.split("\n")[1].indexOf("Integer.add") + 1,
			)
		})

		// A Constant, Variable, Pattern or static Property holding a refused
		// Function was reported at its value, so reading it reports nothing
		// more. A Function's own name is written where it is read.
		it("should refuse a Function value where it is written, not where it is read", () => {
			let errors = errorsFor(`implementation {
				function shown<infer Item is Printable>(_ item: Item) -> String {
					<- item::toString()
				}

				constant bounded = <infer Item is Printable>(_ item: Item) -> String {
					<- item::toString()
				}
				constant added = Integer.add
				variable kept = Integer.add
				constant record = { rule = Integer.add }
				constant { rule } = { rule = Integer.add }

				namespace Holder for Integer {
					static held = Integer.add
				}

				Terminal.inspect({ a = bounded })
				Terminal.inspect(added)
				Terminal.print(added::toString())
				Terminal.print("{added}")
				Terminal.inspect([kept])
				Terminal.inspect(record.rule)
				Terminal.inspect(rule)
				Terminal.inspect(Holder.held)
				Terminal.inspect(shown)
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"protocol-bound-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"protocol-bound-function-value",
			])
		})

		// A Function literal's Parameter typed from a refused value was refused
		// where that value was written, so reading it reports nothing more.
		it("should not refuse a Parameter typed from a refused value", () => {
			let errors = errorsFor(`implementation {
				constant added = Integer.add

				Terminal.inspect([added]::map((rule) { <- rule }))
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"overloaded-function-value",
			])
		})

		// A remembered Constant is matched by its value's Type as well as its
		// name. A Function of that name read elsewhere is still refused.
		it("should refuse a Function named like a remembered Constant", () => {
			let errors = errorsFor(`implementation {
				function early() -> Integer {
					constant shown = Integer.add
					<- shown(1, 2)
				}

				function shown<infer Item is Printable>(_ item: Item) -> String {
					<- item::toString()
				}

				Terminal.print(early())
				Terminal.inspect([shown])
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"overloaded-function-value",
				"protocol-bound-function-value",
			])
		})

		// A refused Function inside a value is a hole, which spares checks about
		// it alone. The shape of the value around it is still measured.
		it("should measure the value around a refused Function", () => {
			let errors = errorsFor(`implementation {
				constant bounded = <infer Item is Printable>(_ item: Item) -> String {
					<- item::toString()
				}

				constant wrong: Integer = { a = bounded }
				constant right: { a: (_: Integer) -> String } = { a = bounded }
				variable kept: List<Integer> = [1]

				kept = { a = bounded }
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"protocol-bound-function-value",
				"assignment-type-mismatch",
				"assignment-type-mismatch",
			])
		})

		// The written List still proves it has an item, though the item is the
		// hole a refused Function leaves.
		it("should keep what a written value proves around a refused Function", () => {
			let errors = errorsFor(`implementation {
				constant rules: NonEmptyList<(_: Integer, _: Integer) -> Integer> = [
					Integer.add,
				]
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"overloaded-function-value",
			])
		})

		// A mismatch around a refused Function names only what does not fit, in
		// a declaration, a `<-` and a List alike.
		it("should name only the mismatch around a refused Function", () => {
			let errors = errorsFor(`implementation {
				type Rule = { count: Integer, rule: (_: Integer, _: Integer) -> Integer }

				function make() -> Rule {
					<- { count = "3", rule = Integer.add }
				}

				constant declared: Rule = { count = "3", rule = Integer.add }
				constant listed: List<Integer> = ["3", Integer.add]
			}`)

			expect(
				errors.map((error) => [
					error.code,
					error.labels?.map((label) => label.message),
				]),
			).toEqual([
				[
					"return-type-mismatch",
					["this is a String, and Rule declares an Integer"],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				[
					"assignment-type-mismatch",
					["this is a String, and Rule declares an Integer"],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				["assignment-type-mismatch", ["this is a List<String | …>"]],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
			])
		})

		// A payload is measured around a refused Function as a declaration is.
		// A one-member Case reads a Record holding one as its payload Record.
		it("should name only the payload mismatch around a refused Function", () => {
			let errors = errorsFor(`implementation {
				choice Holder {
					Has { rule: (_: Integer, _: Integer) -> Integer, count: Integer },
					Lacks,
				}

				choice Single {
					Has { rule: (_: Integer, _: Integer) -> Integer },
					Lacks,
				}

				choice Nested {
					Has { settings: { rule: (_: Integer, _: Integer) -> Integer, count: Integer } },
					Lacks,
				}

				constant held: Holder = #Has({ rule = Integer.add, count = "x" })
				constant named = Holder#Has({ rule = Integer.add, count = "x" })
				constant single: Single = #Has({ rule = Integer.add })
				constant nested: Nested = #Has({ rule = Integer.add, count = "x" })
				constant fits: Holder = #Has({ rule = Integer.add, count = 1 })
			}`)

			expect(
				errors.map((error) => [
					error.code,
					error.labels?.map((label) => label.message),
				]),
			).toEqual([
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				[
					"payload-type-mismatch",
					["this is a String, and '#Has' declares an Integer"],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				[
					"payload-type-mismatch",
					["this is a String, and '#Has' declares an Integer"],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				[
					"payload-type-mismatch",
					[
						"this is a String, and the expected Record declares an Integer",
					],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
			])
		})

		// An Argument is measured around a refused Function, whether it is the
		// Argument, a member of a Record or an item of a List.
		it("should name only the Argument mismatch around a refused Function", () => {
			let errors = errorsFor(`implementation {
				type Rule = (_: Integer, _: Integer) -> Integer

				function settle(_ settings: { rule: Rule, n: Integer }) -> Integer {
					<- settings.n
				}

				function pair(_ rule: Rule, _ n: Integer) -> Integer {
					<- n
				}

				function labelled(with rule: Rule, at n: Integer) -> Integer {
					<- n
				}

				function listed(_ rules: List<Rule>) -> Integer {
					<- rules::length()
				}

				constant record = settle({ rule = Integer.add, n = "x" })
				constant positional = pair(Integer.add, "x")
				constant named = labelled(with Integer.add, at "x")
				constant items = listed([Integer.add, "x"])
				constant fits = settle({ rule = Integer.add, n = 1 })
			}`)

			expect(
				errors.map((error) => [
					error.code,
					error.labels?.map((label) => label.message),
				]),
			).toEqual([
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				[
					"argument-type-mismatch",
					[
						"this is a String, and the Parameter's Type declares an Integer",
					],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				["argument-type-mismatch", ["this is a String"]],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				["argument-type-mismatch", ["this is a String"]],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				["argument-type-mismatch", ["this is a List<… | String>"]],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
			])
		})

		// Matching around a refused Function reads every Argument again, so each
		// is read first where its own mistakes are reported. Selection stopped
		// at the refused Function, before the Argument after it.
		it("should keep the Diagnostics of an Argument after a refused Function", () => {
			let source = (call: string) => `implementation {
				type Rule = (_ n: Integer, _ m: Integer) -> Integer

				namespace Tool for Integer {
					overload both {
						(_ r: Rule, _ xs: { a: Integer, b: Integer }) -> Integer { <- 1 }
						(_ r: Rule, _ xs: { a: Integer, b: Boolean }) -> Integer { <- 2 }
					}
				}

				Terminal.inspect(${call})
			}`
			let codes = (call: string) =>
				errorsFor(source(call)).map((error) => error.code)

			expect(codes(`1::both(Integer.add, { a = nope, b = 3 })`)).toEqual([
				"unknown-name",
				"overloaded-function-value",
			])
			expect(
				codes(`1::both(Integer.add, { a = nope, b = "x" })`),
			).toEqual([
				"unknown-name",
				"no-matching-overload",
				"overloaded-function-value",
			])
			expect(
				codes(`Tool.both(1, Integer.add, { a = nope, b = 3 })`),
			).toEqual(["unknown-name", "overloaded-function-value"])
			expect(
				codes(`Tool.both(1, Integer.add, { a = nope, b = "x" })`),
			).toEqual([
				"unknown-name",
				"no-matching-overload",
				"overloaded-function-value",
			])
		})

		// A call the enricher selects among candidates is refused around a
		// refused Function too, and never for that Function alone. The enricher
		// reports before the validator.
		it("should refuse a Method call only for what is passed around a refused Function", () => {
			let errors = errorsFor(`implementation {
				namespace Tool for Integer {
					settle(_ settings: { rule: (_: Integer, _: Integer) -> Integer, n: Integer }) -> Integer {
						<- settings.n
					}
				}

				constant record = 1::settle({ rule = Integer.add, n = "x" })
				constant overloaded = Integer.add(Integer.subtract, "x")
				constant fits = 1::settle({ rule = Integer.add, n = 1 })
				constant alone = Integer.add(Integer.subtract, 1)
			}`)

			expect(
				errors.map((error) => [
					error.code,
					error.labels?.[0]?.message,
					error.notes.at(-1),
				]),
			).toEqual([
				[
					"no-matching-overload",
					"this is a { rule: …, n: String }",
					"'n' is a String; the expected Record declares an Integer.",
				],
				[
					"no-matching-overload",
					"this is a String",
					"'Integer.add' takes 2 Arguments: Parameter 1 is Integer, Parameter 2 is Transcendental.",
				],
				[
					"overloaded-function-value",
					"this names all 4 overloads at once",
					undefined,
				],
				[
					"overloaded-function-value",
					"this names all 4 overloads at once",
					undefined,
				],
				[
					"overloaded-function-value",
					"this names all 4 overloads at once",
					undefined,
				],
				[
					"overloaded-function-value",
					"this names all 4 overloads at once",
					undefined,
				],
			])
		})

		// The refused Argument is described as the validator describes one,
		// with each refused Function a hole, since only that Function is
		// unreadable.
		it("should describe an Argument a call refuses around a refused Function", () => {
			let errors = errorsFor(`implementation {
				constant first = (_ a: Integer, _ b: Integer) -> Integer { <- a }
				constant rules = [first]
				constant more = rules::append(contentsOf [Integer.add, "x"])
			}`)

			expect(
				errors.map((error) => [
					error.code,
					error.labels?.map((label) => label.message),
				]),
			).toEqual([
				[
					"no-matching-overload",
					[
						"this is a List<… | String>",
						"'List::append' takes a List<(_: Integer, _: Integer) -> Integer> as Parameter 'contentsOf'",
					],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
			])
		})

		// Each Argument is judged by its own Errors: one beside a refused
		// Function, rather than holding one, still could not be read.
		it("should still call an Argument unreadable where its own Error is no hole", () => {
			let labelOf = (argument: string) =>
				errorsFor(`implementation {
					type Rule = (_ n: Integer, _ m: Integer) -> Integer

					namespace Tool for Integer {
						overload both {
							(_ r: Rule, _ xs: { a: Integer, b: Integer }) -> Integer { <- 1 }
							(_ r: Rule, _ xs: { a: Integer, b: Boolean }) -> Integer { <- 2 }
						}
					}

					Terminal.inspect(1::both(Integer.add, ${argument}))
				}`).find((error) => error.code === "no-matching-overload")
					?.labels[0]?.message

			expect(labelOf(`{ a = nope, b = "x" }`)).toBe(
				"this Argument's Type could not be read",
			)
			expect(labelOf(`(_ x) -> Integer { <- x }`)).toBe(
				"this Argument's Type could not be read",
			)
			expect(labelOf(`{ a = 1, b = "x" }`)).toBe(
				"this is a { a: Integer, b: String }",
			)
		})

		// An update is measured around a refused Function as a Literal is, a
		// path key included.
		it("should name only the update mismatch around a refused Function", () => {
			let errors = errorsFor(`implementation {
				type Rule = (_: Integer, _: Integer) -> Integer
				type Settings = { rule: Rule, count: Integer }

				constant first = (_ a: Integer, _ b: Integer) -> Integer { <- a }
				constant base: Settings = { rule = first, count = 1 }
				constant outer = { settings = base }
				constant wrong = { base with rule = Integer.add, count = "x" }
				constant pathed = { outer with settings.rule = Integer.add, settings.count = "x" }
				constant alone = { base with rule = Integer.add }
			}`)

			expect(
				errors.map((error) => [
					error.code,
					error.labels?.map((label) => label.message),
				]),
			).toEqual([
				[
					"partial-type-mismatch",
					[
						"this is a String, and Settings declares an Integer",
						"this is a Settings",
					],
				],
				[
					"partial-type-mismatch",
					[
						"this is a String, and Settings declares an Integer",
						"this is a Settings",
					],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
			])
		})

		// A written part is asked for its evidence with each refused Function
		// in it a hole. The List still has an item, and `3` still is no zero.
		it("should admit a written part around a refused Function", () => {
			let errors = errorsFor(`implementation {
				type Rule = (_: Integer, _: Integer) -> Integer

				choice Holder {
					Has { rule: Rule, count: NonZeroInteger },
					Lacks,
				}

				function use(_ settings: { rule: Rule, count: NonZeroInteger }) -> Integer {
					<- settings.count
				}

				constant rows: List<NonEmptyList<Rule>> = [[Integer.add]]
				constant record: { rule: Rule, count: NonZeroInteger } = { rule = Integer.add, count = 3 }
				constant used = use({ rule = Integer.add, count = 3 })
				constant held: Holder = #Has({ rule = Integer.add, count = 3 })
				constant table: Dictionary<String, NonEmptyList<Rule>> = ["a" = [Integer.add]]
			}`)

			expect(errors.map((error) => error.code)).toEqual([
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
				"overloaded-function-value",
			])
		})

		// The part that proves nothing is named, not the one holding the hole.
		it("should name the part beside a refused Function that proves nothing", () => {
			let errors = errorsFor(`implementation {
				type Rule = (_: Integer, _: Integer) -> Integer

				constant rows: List<NonEmptyList<Rule>> = [[Integer.add], []]
			}`)

			expect(
				errors.map((error) => [
					error.code,
					error.labels?.map((label) => label.message),
				]),
			).toEqual([
				[
					"assignment-type-mismatch",
					["this is a List<List<…>>", "this item is a List<Unknown>"],
				],
				[
					"overloaded-function-value",
					["this names all 4 overloads at once"],
				],
			])
		})

		// A default and a Dictionary update are measured around a refused
		// Function as a value written anywhere else is.
		it("should name only the default's or the update's mismatch around a refused Function", () => {
			let errors = errorsFor(`implementation {
				type Rule = (_ n: Integer, _ m: Integer) -> Integer
				type Entry = { rule: Rule, count: Integer }

				choice Call {
					Post { rule: Rule, count: Integer, body: String } = { rule = Integer.add, count = "x" },
					Idle,
				}

				function use(_ s: Entry = { rule = Integer.add, count = "y" }) -> Integer {
					<- s.count
				}

				constant first = (_ n: Integer, _ m: Integer) -> Integer { <- n }
				constant d: Dictionary<String, Entry> = ["a" = { rule = first, count = 1 }]
				constant e = [d with "b" = { rule = Integer.add, count = "z" }]
				constant fits = [d with "c" = { rule = Integer.add, count = 2 }]
			}`)

			expect(
				errors.map((error) => [error.code, error.labels?.[0]?.message]),
			).toEqual([
				[
					"default-type-mismatch",
					"this is a String, and '#Post' declares an Integer",
				],
				[
					"default-type-mismatch",
					"this is a String, and Entry declares an Integer",
				],
				[
					"partial-type-mismatch",
					"this is a { rule: …, count: String }",
				],
				[
					"overloaded-function-value",
					"this names all 4 overloads at once",
				],
				[
					"overloaded-function-value",
					"this names all 4 overloads at once",
				],
				[
					"overloaded-function-value",
					"this names all 4 overloads at once",
				],
				[
					"overloaded-function-value",
					"this names all 4 overloads at once",
				],
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
