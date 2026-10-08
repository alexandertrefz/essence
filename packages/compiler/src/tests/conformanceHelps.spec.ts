import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher/index"
import { unnameableTargetNote } from "../helpers/describe"
import { parse } from "../parser/index"
import {
	codesOfSource,
	compiles,
	firstAnalysed,
	firstOf,
} from "./followedHelps"

// The Helps about conformance, each followed literally and compiled. A Help
// must not lead to a report whose Help leads back. So both ends of such a
// pair, `unsatisfied-bound` and `protocol-bound-namespace-generic`, are here.

describe("A bound on a Namespace's own Type Parameter", () => {
	let underAWhere = `implementation {
		type Box<Item> = { items: List<Item> }

		namespace Boxes<infer Item> for Box<Item> is Printable where Item is Comparable {
			toString() -> String {
				<- "a box"
			}

			biggest() -> Optional<Item> {
				<- @.items::sort()::lastItem()
			}
		}

		Terminal.print("{{ items = [3, 1, 2] }}")
	}`

	let withoutTheWhere = `implementation {
		type Box<Item> = { items: List<Item> }

		namespace Boxes<infer Item> for Box<Item> is Printable {
			toString() -> String {
				<- "a box"
			}

			biggest() -> Optional<Item> {
				<- @.items::sort()::lastItem()
			}
		}

		Terminal.print("{{ items = [3, 1, 2] }}")
	}`

	let noConformanceAtAll = `implementation {
		type Box<Item> = { items: List<Item> }

		namespace Boxes<infer Item> for Box<Item> {
			biggest() -> Optional<Item> {
				<- @.items::sort()::lastItem()
			}
		}

		Terminal.print("ok")
	}`

	it("should never ask for the spelling a Namespace can not carry", () => {
		for (let source of [underAWhere, withoutTheWhere, noConformanceAtAll]) {
			expect(firstOf(source, "unsatisfied-bound").helps).not.toContain(
				"Declare it as '<infer Item is Comparable>'.",
			)
		}
	})

	// Bounding the Method that needs it always applies and needs nothing
	// declared.
	it("should send the reader to the Method that needs the bound", () => {
		for (let source of [underAWhere, withoutTheWhere, noConformanceAtAll]) {
			expect(firstOf(source, "unsatisfied-bound").helps[0]).toBe(
				"Bound it for this Method: write '<Item is Comparable>' after the Method's name.",
			)
		}

		expect(
			compiles(
				noConformanceAtAll.replace(
					"biggest()",
					"biggest<Item is Comparable>()",
				),
			),
		).toBe(true)

		expect(
			compiles(
				underAWhere.replace(
					"biggest()",
					"biggest<Item is Comparable>()",
				),
			),
		).toBe(true)
	})

	// A `where` reaches only the Methods that fulfil the conformance, and
	// `biggest` fulfils nothing, so a `where` is not offered.
	it("should not offer a 'where' the reported Method would not be reached by", () => {
		let diagnostic = firstOf(withoutTheWhere, "unsatisfied-bound")

		expect(diagnostic.helps).toHaveLength(1)
		expect(
			compiles(
				withoutTheWhere.replace(
					"is Printable {",
					"is Printable where Item is Comparable {",
				),
			),
		).toBe(false)
	})

	// A Method that fulfils the conformance may not carry a bound of its own,
	// since the conformance promised it without one. So the `where` is the only
	// edit offered.
	it("should offer the 'where' to a Method the conformance reaches", () => {
		let fulfilling = `implementation {
			type Box<Item> = { item: Item }

			namespace Boxes<infer Item> for Box<Item> is Printable {
				toString() -> String {
					<- "a box of {@.item}"
				}
			}

			Terminal.print("{{ item = 1 }}")
		}`

		expect(
			firstOf(fulfilling, "interpolation-not-printable").helps,
		).toEqual([
			"Add 'where Item is Printable' to 'is Printable' on this Namespace.",
		])

		expect(
			compiles(
				fulfilling.replace(
					"is Printable {",
					"is Printable where Item is Printable {",
				),
			),
		).toBe(true)
	})

	// Where the condition is already written, the Note says why it does not
	// reach `biggest`, and the Help still bounds the Method.
	it("should explain a 'where' that does not reach this Method", () => {
		let diagnostic = firstOf(underAWhere, "unsatisfied-bound")

		expect(diagnostic.notes[1]).toBe(
			"'is Printable where Item is Comparable' is declared here already, and a 'where' reaches the Methods that fulfil 'Printable' and no others.",
		)
		expect(diagnostic.helps).toHaveLength(1)
	})

	it("should name whose Type Parameter it is where nothing is declared", () => {
		let diagnostic = firstOf(noConformanceAtAll, "unsatisfied-bound")

		expect(diagnostic.notes[1]).toBe(
			"'Item' is 'Boxes's own Type Parameter, so a bound on it belongs to the Method that needs it rather than to the Namespace.",
		)
		expect(diagnostic.helps).toHaveLength(1)
	})

	// The refusal of a bound on the Namespace leads with the per-Method edit.
	// A Method that fulfils a conformance can carry no bound of its own, so the
	// second Help gives those Methods the conformance's `where`.
	it("should send a refused Namespace bound to the Methods", () => {
		let source = `implementation {
			namespace Boxes<infer Item is Comparable> for List<Item> is Printable {
				toString() -> String {
					<- "a box"
				}
			}

			Terminal.print("ok")
		}`

		expect(
			firstOf(source, "protocol-bound-namespace-generic").helps,
		).toEqual([
			"Bound it on each Method that needs it: write '<Item is Comparable>' after that Method's name.",
			"A Method that fulfils 'Printable' can carry no bound of its own, so bound it on the conformance instead: 'is Printable where Item is Comparable'.",
		])
		expect(
			compiles(
				source
					.replace("<infer Item is Comparable>", "<infer Item>")
					.replace(
						"is Printable {",
						"is Printable where Item is Comparable {",
					),
			),
		).toBe(true)
	})

	// The refused bound is the one mistake. Each conformance assumes it as the
	// `where` its Help asks for. So the Method that needs it is reported again
	// neither at the declaration nor at the call.
	it("should report a refused Namespace bound once", () => {
		expect(
			codesOfSource(`implementation {
			namespace Boxes<infer Item is Comparable> for { items: List<Item> } is Printable {
				toString() -> String {
					<- "{@.items::sort()::length()} items"
				}
			}

			Terminal.print({ items = [3, 1] })
		}`),
		).toEqual(["protocol-bound-namespace-generic"])
	})

	// A use site solves the refused bound as the `where` its Help asks for. So
	// a binding it does not hold for is still refused there.
	it("should solve a refused Namespace bound where the Namespace is used", () => {
		let source = `implementation {
			type Bag<Item> = { items: List<Item> }

			namespace Bags<infer Item is Comparable> for Bag<Item> is Printable {
				toString() -> String {
					<- "{@.items::sort()::length()} items"
				}
			}

			constant bag: Bag<Integer> = { items = [3, 1] }

			Terminal.print(bag)
			Terminal.print({ items = [(n: Integer) -> Integer { <- n }] })
		}`

		expect(codesOfSource(source)).toEqual([
			"protocol-bound-namespace-generic",
			"unsatisfied-conformance-condition",
		])
		expect(
			firstAnalysed(source, "unsatisfied-conformance-condition").position
				?.start.line,
		).toBe(13)
	})

	// Only a bound the reader wrote is refused and assumed. A bound the target
	// implies, as a bounded Choice's does, is assumed by no conformance, so the
	// `where` it needs is still asked for.
	it("should assume no bound the target Type only implies", () => {
		let boxes = (body: string) => `implementation {
			choice SortedBox<Item is Comparable> {
				Box { items: List<Item> },
			}

			namespace Boxes<infer Item> for SortedBox<Item> is Printable {
				toString() -> String {
					<- match @ -> String {
						case #Box(items) { <- "{${body}::length()} items" }
					}
				}
			}

			Terminal.print(SortedBox<Integer>#Box({ items = [3, 1, 2] }))
		}`

		for (let body of ["items::sort()", "items"]) {
			expect(codesOfSource(boxes(body))).toContain(
				"nonconforming-namespace",
			)
		}
	})

	// A conformance that already carries a `where` takes the bound as one more
	// condition, so the Help spells the whole clause it becomes.
	it("should spell the condition beside a 'where' already written", () => {
		let source = (generics: string, clause: string) => `implementation {
			namespace Boxes<${generics}> for { items: List<Item>, other: Other } is Printable ${clause} {
				toString() -> String {
					<- "{@.items::sort()::length()} items {@.other}"
				}
			}

			Terminal.print({ items = [3, 1], other = 1 })
		}`

		expect(
			firstOf(
				source(
					"infer Item is Comparable, infer Other",
					"where Other is Printable",
				),
				"protocol-bound-namespace-generic",
			).helps[1],
		).toBe(
			"A Method that fulfils 'Printable' can carry no bound of its own, so bound it on the conformance instead: 'is Printable where Other is Printable, Item is Comparable'.",
		)
		expect(
			compiles(
				source(
					"infer Item, infer Other",
					"where Other is Printable, Item is Comparable",
				),
			),
		).toBe(true)
	})

	// A clause that already binds the Type Parameter takes no second bound. So
	// the Help gives the edit the conformance check gives: a Namespace of its
	// own. A clause that binds it to the same Protocol has the bound already.
	it("should send a bound a clause can not take to a Namespace of its own", () => {
		let boxes = (generics: string, clause: string) => `implementation {
			namespace Boxes<${generics}> for { items: List<Item> } is Printable ${clause} {
				toString() -> String {
					<- "{@.items::sort()::length()} items"
				}
			}

			Terminal.print({ items = [3, 1] })
		}`
		let refusedWith = (clause: string) =>
			firstOf(
				boxes("infer Item is Comparable", clause),
				"protocol-bound-namespace-generic",
			).helps[1]

		expect(refusedWith("where Item is Printable")).toBe(
			"A Method that fulfils 'Printable' can carry no bound of its own, and 'Item' already carries 'Printable' on that conformance, which takes one bound per Type Parameter — declare 'is Printable where Item is Comparable' on a Namespace of its own.",
		)
		expect(compiles(boxes("infer Item", "where Item is Comparable"))).toBe(
			true,
		)
		expect(refusedWith("where Item is Comparable")).toBe(
			"A Method that fulfils 'Printable' can carry no bound of its own, so bound it on the conformance instead: 'is Printable where Item is Comparable'.",
		)
	})

	// Each conformance's Methods take the bound on that conformance, so every
	// clause is spelled, not one of them.
	it("should spell the bound on every conformance declared", () => {
		expect(
			firstOf(
				`implementation {
			namespace Boxes<infer Item is Comparable> for { items: List<Item> } is Printable, is Equatable {
				toString() -> String {
					<- "a box"
				}

				is(_ other: { items: List<Item> }) -> Boolean {
					<- true
				}
			}
		}`,
				"protocol-bound-namespace-generic",
			).helps[1],
		).toBe(
			"A Method that fulfils a requirement can carry no bound of its own, so bound it on each conformance whose Methods need it: 'is Printable where Item is Comparable', 'is Equatable where Item is Comparable'.",
		)
	})

	// The two Helps complement each other: `toString` fulfils 'Printable' and
	// takes the `where`, while `biggest` takes a bound of its own.
	it("should compile with each Help applied to the Methods it names", () => {
		let source = `implementation {
			namespace Boxes<infer Item is Comparable> for { items: List<Item> } is Printable {
				toString() -> String {
					<- "{@.items::sort()::length()} items"
				}

				biggest() -> Optional<Item> {
					<- @.items::sort()::lastItem()
				}
			}

			Terminal.print({ items = [3, 1] })
		}`
		let unbounded = source.replace(
			"<infer Item is Comparable>",
			"<infer Item>",
		)

		expect(
			compiles(
				unbounded
					.replace(
						"is Printable {",
						"is Printable where Item is Comparable {",
					)
					.replace("biggest()", "biggest<Item is Comparable>()"),
			),
		).toBe(true)
		expect(
			codesOfSource(
				unbounded
					.replace("toString()", "toString<Item is Comparable>()")
					.replace("biggest()", "biggest<Item is Comparable>()"),
			),
		).toContain("nonconforming-namespace")
	})

	it("should offer the per-Method edit where nothing is declared", () => {
		let source = `implementation {
			namespace Boxes<infer Item is Comparable> for List<Item> {
				biggest() -> Optional<Item> {
					<- @::sort()::lastItem()
				}
			}

			Terminal.print("ok")
		}`

		expect(
			firstOf(source, "protocol-bound-namespace-generic").helps,
		).toEqual([
			"Bound it on each Method that needs it: write '<Item is Comparable>' after that Method's name.",
		])

		expect(
			compiles(
				source
					.replace("<infer Item is Comparable>", "<infer Item>")
					.replace("biggest()", "biggest<Item is Comparable>()"),
			),
		).toBe(true)
	})

	// A Function's own Type Parameter can carry the bound, so the Help says so.
	it("should still bound a Function's own Type Parameter", () => {
		let source = `implementation {
			function biggest<infer Item>(of items: List<Item>) -> Optional<Item> {
				<- items::sort()::lastItem()
			}

			Terminal.print("{biggest(of [3, 1])::value(defaultingTo 0)}")
		}`

		expect(firstOf(source, "unsatisfied-bound").helps).toEqual([
			"Declare it as '<infer Item is Comparable>'.",
		])

		expect(
			compiles(`implementation {
				function biggest<infer Item is Comparable>(of items: List<Item>) -> Optional<Item> {
					<- items::sort()::lastItem()
				}

				Terminal.print("{biggest(of [3, 1])::value(defaultingTo 0)}")
			}`),
		).toBe(true)
	})
})

describe("A conformance condition that can not be added", () => {
	// A Type Parameter takes one bound per conformance, so
	// `nonconforming-namespace` must not ask for a `where` that
	// `conflicting-where-condition` refuses. The second bound needs a Namespace.
	let twoBounds = `implementation {
		type Box<Item> = { item: Item }

		protocol Shown {
			show() -> String
		}

		protocol Told {
			show() -> String
		}

		namespace Boxes<infer Item> for Box<Item>
			is Shown where Item is Printable,
			is Told where Item is Comparable {
			show() -> String {
				<- "a box"
			}
		}

		Terminal.print("ok")
	}`

	it("should send the conformance to a Namespace of its own", () => {
		expect(firstOf(twoBounds, "nonconforming-namespace").helps).toEqual([
			"'Item' already carries 'Comparable' here, and a Type Parameter takes one bound per conformance — declare 'is Told where Item is Printable' on a Namespace of its own.",
		])
	})

	it("should compile once the conformances are split apart", () => {
		expect(
			compiles(`implementation {
				type Box<Item> = { item: Item }

				protocol Shown {
					show() -> String
				}

				protocol Told {
					tell() -> String
				}

				namespace ShownBoxes<infer Item> for Box<Item> is Shown where Item is Printable {
					show() -> String {
						<- "a box of {@.item}"
					}
				}

				namespace ToldBoxes<infer Item> for Box<Item> is Told where Item is Comparable {
					tell() -> String {
						<- "a box"
					}
				}

				Terminal.print({ item = 1 }::show())
			}`),
		).toBe(true)
	})

	it("should say where a second bound belongs", () => {
		let source = `implementation {
			type Wrapper<Item> = { item: Item }

			namespace Wrappers<infer Item> for Wrapper<Item>
				is Comparable where Item is Comparable, Item is Equatable {
				compare(to other: Wrapper<Item>) -> Ordering {
					<- Ordering#Equal
				}
			}

			Terminal.print("ok")
		}`

		expect(firstOf(source, "conflicting-where-condition").helps).toEqual([
			"Drop this condition, or declare 'is Comparable' on a Namespace of its own where 'Item is Equatable' is the one condition.",
		])
	})
})

describe("A conformance a Namespace does not fulfil", () => {
	// The Label names the requirement the check stopped at. The Help names every
	// one owed, for a reader in a terminal with no Quick Fix.
	it("should name every requirement the conformance owes", () => {
		let source = `implementation {
			protocol Measured {
				size() -> Integer
				name() -> String
			}

			type Box = { side: Integer }

			namespace Boxes for Box is Measured {}

			Terminal.print("ok")
		}`

		expect(firstOf(source, "nonconforming-namespace").helps).toEqual([
			"Write 'size', 'name' as 'Measured' declares them, or drop the 'is Measured'.",
		])

		expect(
			compiles(`implementation {
				protocol Measured {
					size() -> Integer
					name() -> String
				}

				type Box = { side: Integer }

				namespace Boxes for Box is Measured {
					size() -> Integer {
						<- @.side
					}

					name() -> String {
						<- "a box"
					}
				}

				Terminal.print("ok")
			}`),
		).toBe(true)
	})

	// The Method exists and needs correcting, so no stub is named. The Help
	// says where its signature is declared.
	it("should send a mismatched signature to the Protocol", () => {
		let source = `implementation {
			type Point = { x: Integer }

			namespace Points for Point is Printable {
				toString(_ prefix: String) -> String {
					<- prefix
				}
			}

			Terminal.print("ok")
		}`

		expect(firstOf(source, "nonconforming-namespace").helps).toEqual([
			"Write 'toString' with the signature 'Printable' declares for it.",
		])
	})
})

describe("A requirement another conformance provides a body for", () => {
	// `Counted` provides a `describe` that does not fulfil the one
	// `Described` requires. Where a `describe` written as `Described` declares it
	// does not fulfil `Counted`'s either, writing it refuses `is Counted`.
	let conforming = (
		described: string,
		counted: string,
		...namespaces: Array<string>
	) => `implementation {
		protocol Described {
			describe() -> ${described}
		}

		protocol Counted {
			describe() -> ${counted} {
				<- 7
			}
		}

		${namespaces.join("\n\n\t\t")}

		function show<infer Item is Described>(_ item: Item) -> ${described} {
			<- item::describe()
		}

		function count<infer Item is Counted>(_ item: Item) -> ${counted} {
			<- item::describe()
		}

		Terminal.print("ok")
	}`
	let apart = (...namespaces: Array<string>) =>
		conforming("String", "Integer", ...namespaces)
	let accepted = (...namespaces: Array<string>) =>
		conforming("Integer", "Number", ...namespaces)

	it("should send the conformance to a Namespace of its own", () => {
		let refused = firstOf(
			apart(
				"namespace IntegerBoth for Integer is Described, is Counted {}",
			),
			"nonconforming-namespace",
		)

		expect(refused.helps).toEqual([
			"Declare 'is Described' on a Namespace of its own that writes 'describe' as 'Described' declares it, or drop the 'is Described'.",
		])
		expect(refused.data).toBeUndefined()
	})

	it("should not ask for the Method that refuses the other conformance", () => {
		expect(
			firstOf(
				apart(
					'namespace IntegerBoth for Integer is Described, is Counted {\n\t\t\tdescribe() -> String {\n\t\t\t\t<- "three"\n\t\t\t}\n\t\t}',
				),
				"nonconforming-namespace",
			).message,
		).toBe("Namespace 'IntegerBoth' does not conform to 'Counted'")
	})

	it("should compile once the conformance is on a Namespace of its own", () => {
		expect(
			compiles(
				apart(
					"namespace IntegerCounted for Integer is Counted {}",
					'namespace IntegerDescribed for Integer is Described {\n\t\t\tdescribe() -> String {\n\t\t\t\t<- "three"\n\t\t\t}\n\t\t}',
				).replace('Terminal.print("ok")', "Terminal.print(show(3))"),
			),
		).toBe(true)
	})

	it("should compile once the conformance is dropped", () => {
		expect(
			compiles(apart("namespace IntegerBoth for Integer is Counted {}")),
		).toBe(true)
	})

	it("should ask for the Method where the other conformance accepts it", () => {
		let refused = firstOf(
			accepted(
				"namespace IntegerBoth for Integer is Described, is Counted {}",
			),
			"nonconforming-namespace",
		)

		expect(refused.helps).toEqual([
			"Write 'describe' as 'Described' declares it, or drop the 'is Described'.",
		])
		expect(
			compiles(
				accepted(
					"namespace IntegerBoth for Integer is Described, is Counted {\n\t\t\tdescribe() -> Integer {\n\t\t\t\t<- 3\n\t\t\t}\n\t\t}",
				).replace('Terminal.print("ok")', "Terminal.print(show(3))"),
			),
		).toBe(true)
	})
})

describe("A Type in want of a conformance", () => {
	// The Help names the last link of the chain, not the Type the bound was on.
	// A Namespace `for Result<String, Problem>` would leave every other Result
	// unprintable.
	let resultOfAChoice = `implementation {
		choice Problem {
			NotANumber,
		}

		function parse(_ text: String) -> Result<String, Problem> {
			if text::isEmpty() {
				<- Result<String, Problem>#Failure(#NotANumber)
			}

			<- Result<String, Problem>#Value(text)
		}

		Terminal.print(parse("3"))
	}`

	// `Terminal.inspect` comes first because it takes any value and needs no
	// declaration. The declaration comes second because it keeps `print`. The
	// escape is offered wherever a print is refused, whatever the failing Type.
	it("should name the culprit rather than the Type the bound was on", () => {
		expect(
			firstOf(resultOfAChoice, "unsatisfied-conformance-condition").helps,
		).toEqual([
			"Write 'Terminal.inspect(…)' instead — it renders any value structurally and asks for no conformance.",
			"Declare a Namespace 'for Problem is Printable' — its body may be empty, since a Choice whose Cases carry no payload prints as their names.",
		])
	})

	it("should compile with the escape it offers first", () => {
		expect(
			compiles(`implementation {
				choice Problem {
					NotANumber,
				}

				function parse(_ text: String) -> Result<String, Problem> {
					if text::isEmpty() {
						<- Result<String, Problem>#Failure(#NotANumber)
					}

					<- Result<String, Problem>#Value(text)
				}

				Terminal.inspect(parse("3"))
			}`),
		).toBe(true)
	})

	it("should compile with the empty body it promises", () => {
		expect(
			compiles(`implementation {
				choice Problem {
					NotANumber,
				}

				namespace Problems for Problem is Printable {}

				function parse(_ text: String) -> Result<String, Problem> {
					if text::isEmpty() {
						<- Result<String, Problem>#Failure(#NotANumber)
					}

					<- Result<String, Problem>#Value(text)
				}

				Terminal.print(parse("3"))
			}`),
		).toBe(true)
	})

	// A Future is missing a `complete`, not a conformance. Declaring
	// `for Future<String> is Printable` would compile and print a description
	// of the work, so the Help asks for `complete`.
	it("should never send a reader to make Futures Printable", () => {
		let source = `implementation {
			function headline(_ url: String) -> Future<String> {
				<- complete Async.deferred(() { <- url })
			}

			Terminal.print(headline("a"))
		}`

		expect(firstOf(source, "unsatisfied-bound").helps).toEqual([
			"This describes work that has not run — add 'complete'.",
		])

		expect(
			compiles(`implementation {
				function headline(_ url: String) -> Future<String> {
					<- complete Async.deferred(() { <- url })
				}

				Terminal.print(complete headline("a"))
			}`),
		).toBe(true)
	})

	// Where the body cannot wait, `complete` alone is not offered. The Help
	// first asks for a body that can wait.
	it("should ask for the declaration where the body can not wait", () => {
		let source = `implementation {
			function fetched() -> Future<Integer> {
				<- complete Async.deferred(() { <- 1 })
			}

			function show() -> String {
				<- "{fetched()}"
			}

			Terminal.print(show())
		}`

		let diagnostic = firstOf(source, "interpolation-not-printable")

		expect(diagnostic.helps).toEqual([
			"Declare the enclosing Function '-> Future<…>', which is what lets its body wait, and add 'complete' where the value is read.",
		])

		expect(
			compiles(`implementation {
				function fetched() -> Future<Integer> {
					<- complete Async.deferred(() { <- 1 })
				}

				function show() -> Future<String> {
					<- "{complete fetched()}"
				}

				Terminal.print(complete show())
			}`),
		).toBe(true)
	})

	// A `for` clause takes a Function Type as an annotation writes it.
	it("should offer a Namespace for a Function value, and compile with it", () => {
		let source = `implementation {
			function double(_ n: Integer) -> Integer {
				<- n
			}

			Terminal.print(double)
		}`

		expect(firstOf(source, "unsatisfied-bound").helps).toEqual([
			"Write 'Terminal.inspect(…)' instead — it renders any value structurally and asks for no conformance.",
			"Declare a Namespace 'for (_: Integer) -> Integer is Printable'.",
		])

		expect(
			compiles(`implementation {
				function double(_ n: Integer) -> Integer {
					<- n
				}

				namespace Shown for (_: Integer) -> Integer is Printable {
					toString() -> String {
						<- "a function"
					}
				}

				Terminal.print(double)
			}`),
		).toBe(true)
	})

	// No Namespace is a value (`namespace-as-value`), so none is asked for a
	// conformance.
	it("should ask no conformance of a Namespace read as a value", () => {
		expect(
			codesOfSource(`implementation {
				namespace Clock for Integer {
					static noon = 43_200
				}

				Terminal.print(Clock)
			}`),
		).toEqual(["namespace-as-value"])
	})

	// An overloaded Function is refused as a value before any bound is asked
	// of it. So the helper is asked directly, with the Type of `Integer.add`.
	// `snapshot-not-printable` words its Help with the same `unnameableTarget`.
	it("should call an Overload set an overloaded Function", () => {
		let { program } = enrich(
			parse(`implementation { constant adding = Integer.add }`),
		)
		let [statement] = program.implementation.nodes

		if (statement?.nodeType !== "ConstantDeclarationStatement") {
			throw new Error("The Program declares no Constant.")
		}

		expect(unnameableTargetNote(statement.value.type)).toBe(
			"No Namespace can be declared for an overloaded Function — no Type Annotation can spell it, so no 'for' clause can name it.",
		)
	})

	// A Type Parameter of the culprit is not in scope where the Namespace
	// stands, so the Namespace declares it, inferred from the value.
	it("should declare the Type Parameters a Function value's Type mentions", () => {
		let printed = `function pair<infer A, infer B>(_ a: A, _ b: B) -> A {
				<- a
			}

			Terminal.print(pair)`

		expect(
			firstOf(
				`implementation {
				${printed}
			}`,
				"unsatisfied-bound",
			).helps,
		).toContain(
			"Declare a Namespace '<infer A, infer B> for (_: A, _: B) -> A is Printable'.",
		)
		expect(
			compiles(`implementation {
				namespace Shown<infer A, infer B> for (_: A, _: B) -> A is Printable {
					toString() -> String {
						<- "a pair"
					}
				}

				${printed}
			}`),
		).toBe(true)
	})

	it("should declare a Type Parameter of the Function around the culprit", () => {
		let printing = `choice Box<Value> {
				Full { item: Value },
				Empty,
			}

			function show<infer Item>(_ box: Box<Item>) -> String {
				Terminal.print(box)

				<- ""
			}`

		expect(
			firstOf(
				`implementation {
				${printing}
			}`,
				"unsatisfied-bound",
			).helps,
		).toContain(
			"Declare a Namespace '<infer Item> for Box<Item> is Printable'.",
		)
		expect(
			compiles(`implementation {
				namespace Shown<infer Item> for Box<Item> is Printable {
					toString() -> String {
						<- "a box"
					}
				}

				${printing}
			}`),
		).toBe(true)
	})

	// The Choice bounds its Type Parameter, so a Namespace that infers it
	// conforms only where the bound holds.
	it("should carry the bound a Choice demands of a Type Parameter it infers", () => {
		let printing = `choice Ranked<Value is Equatable> {
				Top { value: Value },
				Bottom,
			}

			function show<infer Item is Equatable>(_ ranked: Ranked<Item>) -> Integer {
				Terminal.print(ranked)

				<- 1
			}`

		expect(
			firstOf(
				`implementation {
				${printing}
			}`,
				"unsatisfied-bound",
			).helps,
		).toContain(
			"Declare a Namespace '<infer Item> for Ranked<Item> is Printable where Item is Equatable'.",
		)
		expect(
			compiles(`implementation {
				namespace Shown<infer Item> for Ranked<Item> is Printable where Item is Equatable {
					toString() -> String {
						<- "ranked"
					}
				}

				${printing}
			}`),
		).toBe(true)
	})

	// A Function's Type only mentions the Type Parameter, so no bound applies.
	it("should carry no bound for a Type Parameter a Function only mentions", () => {
		let printing = `function show<infer Item is Printable>(_ x: Item) -> Integer {
				constant same = (_ y: Item) -> Item { <- y }

				Terminal.print(same)

				<- 1
			}`

		expect(
			firstOf(
				`implementation {
				${printing}
			}`,
				"unsatisfied-bound",
			).helps,
		).toContain(
			"Declare a Namespace '<infer Item> for (_: Item) -> Item is Printable'.",
		)
		expect(
			compiles(`implementation {
				namespace Shown<infer Item> for (_: Item) -> Item is Printable {
					toString() -> String {
						<- "a function"
					}
				}

				${printing}
			}`),
		).toBe(true)
	})
})

describe("A Record in want of a conformance", () => {
	let points = `namespace Points for { x: Integer } is Comparable {
				compare(to other: { x: Integer }) -> Ordering {
					<- @.x::compare(to other.x)
				}
			}`

	it("should compile a bound with the Namespace it asks for", () => {
		let largest = (declared: string) => `implementation {
			function largest<infer Item is Comparable>(of items: List<Item>) -> Optional<Item> {
				<- items::sort()::lastItem()
			}

			${declared}

			Terminal.print(largest(of [{ x = 1 }, { x = 2 }]))
		}`

		expect(firstOf(largest(""), "unsatisfied-bound").helps).toEqual([
			"Declare a Namespace 'for { x: Integer } is Comparable'.",
		])
		expect(compiles(largest(points))).toBe(true)
	})

	// The Help names the Record at the end of the chain, so the Namespace is
	// declared for it rather than for the List around it.
	it("should compile a condition with the Namespace it asks for", () => {
		let sorted = (declared: string) => `implementation {
			${declared}

			Terminal.print([[{ x = 1 }], [{ x = 2 }]]::sort())
		}`

		expect(
			firstOf(sorted(""), "unsatisfied-conformance-condition").helps,
		).toEqual(["Declare a Namespace 'for { x: Integer } is Comparable'."])
		expect(compiles(sorted(points))).toBe(true)
	})
})

describe("A bounded Function used as a value", () => {
	// Invoking the Function would throw the value away, so the Help also offers
	// a wrapping Function literal, which keeps it.
	let source = `implementation {
		function largest<infer Item is Comparable>(of items: List<Item>) -> Optional<Item> {
			<- items::sort()::lastItem()
		}

		constant measure = largest

		Terminal.print("{measure(of [1, 2])::value(defaultingTo 0)}")
	}`

	it("should offer the wrap that keeps the value", () => {
		expect(
			firstAnalysed(source, "protocol-bound-function-value").helps,
		).toEqual([
			"Invoke it, or wrap the call in a Function literal written for the Types you mean.",
		])
	})

	it("should compile once the call is wrapped", () => {
		expect(
			compiles(`implementation {
				function largest<infer Item is Comparable>(of items: List<Item>) -> Optional<Item> {
					<- items::sort()::lastItem()
				}

				constant measure = (_ items: List<Integer>) -> Optional<Integer> { <- largest(of items) }

				Terminal.print("{measure([1, 2])::value(defaultingTo 0)}")
			}`),
		).toBe(true)
	})
})

// A Method that already bounds the Namespace's Parameter wants a second
// Protocol. The bound reaches the body through a Scope of its own, which must
// still answer that the Parameter is the Namespace's and is bounded.
describe("A second bound wanted by a Method that carries one", () => {
	let source = `implementation {
		namespace Boxes<infer Item> for { items: List<Item> } {
			described<Item is Printable>() -> String {
				<- "{@.items::sort()::length()}"
			}
		}

		Terminal.print({ items = [1] }::described())
	}`

	it("should not offer the declaration edit a Namespace Parameter refuses", () => {
		let diagnostic = firstOf(source, "unsatisfied-bound")

		expect(diagnostic.helps).toEqual([])
		expect(diagnostic.notes?.[0]).toBe(
			"'Item' is bounded by 'Printable' already, and a Type Parameter carries ONE bound — a second would replace it rather than stand beside it.",
		)
	})

	it("should say what the Parameter IS bounded by", () => {
		expect(firstOf(source, "unsatisfied-bound").labels[0]?.message).toBe(
			"bound here to a Type Parameter bounded by 'Printable'",
		)
	})

	// `data` comes from the same decision as the Helps, so an editor offers no
	// Quick Fix the report withheld.
	it("should carry no Quick Fix", () => {
		expect(firstOf(source, "unsatisfied-bound").data).toBeUndefined()
	})
})

// A Type Parameter carries one bound, so writing two is refused rather than
// letting the second replace the first. Keeping the bound the body needs
// compiles. Keeping the other reports the call that needs the missing one.
describe("Two bounds on one Type Parameter", () => {
	let source = `implementation {
		namespace Boxes<infer Item> for { items: List<Item> } {
			described<Item is Comparable, Item is Printable>() -> String {
				<- "{@.items::sort()::length()}"
			}
		}

		Terminal.print({ items = [1] }::described())
	}`

	it("should name both bounds and ask for one of them", () => {
		expect(firstAnalysed(source, "duplicate-type-parameter").helps).toEqual(
			[
				"Keep the one the body needs: write '<Item is Comparable>' or '<Item is Printable>', not both.",
			],
		)
	})

	it("should compile with the bound the body needs", () => {
		expect(
			compiles(
				source.replace(
					"<Item is Comparable, Item is Printable>",
					"<Item is Comparable>",
				),
			),
		).toBe(true)
	})

	// The Help says to keep the one the body needs, so keeping the other
	// leads to a report that names the Protocol the body needs.
	it("should report the missing bound where the other one is kept", () => {
		expect(
			firstAnalysed(
				source.replace(
					"<Item is Comparable, Item is Printable>",
					"<Item is Printable>",
				),
				"unsatisfied-bound",
			).message,
		).toBe("Type Parameter 'Item' does not conform to 'Comparable'")
	})
})

describe("A Protocol restating a Method it extends", () => {
	let restating = (...restated: Array<string>) => `implementation {
		protocol Labelled {
			tag() -> String
		}

		protocol Coded is Labelled {
			${restated.join("\n\t\t\t")}
		}

		namespace IntegerCoded for Integer is Coded {
			tag() -> String {
				<- "i{@}"
			}
		}

		function label<infer T is Labelled>(_ t: T) -> String {
			<- t::tag()
		}

		Terminal.print(label(3))
	}`

	it("should ask for the signature the extended Protocol declares", () => {
		expect(
			firstOf(restating("tag() -> Integer"), "incompatible-restatement")
				.helps,
		).toEqual([
			"Restate 'tag' with the signature 'Labelled' declares for it, 'tag() -> String', or give this Method a name of its own.",
		])
	})

	it("should compile with the signature it asks for", () => {
		expect(compiles(restating("tag() -> String"))).toBe(true)
	})

	it("should ask an overload block for the one signature and new names", () => {
		expect(
			firstOf(
				restating(
					"overload tag {",
					"\t() -> String",
					"\t(_ n: Integer) -> String",
					"}",
				),
				"incompatible-restatement",
			).helps,
		).toEqual([
			"Restate 'tag' as the one signature 'Labelled' declares for it, 'tag() -> String', and give the other signatures a name of their own.",
		])
	})

	it("should compile with the one signature and a new name", () => {
		expect(
			compiles(
				restating(
					"tag() -> String",
					"taggedWith(_ n: Integer) -> String",
				).replace(
					'<- "i{@}"\n\t\t\t}',
					'<- "i{@}"\n\t\t\t}\n\n\t\t\ttaggedWith(_ n: Integer) -> String {\n\t\t\t\t<- "i{n}"\n\t\t\t}',
				),
			),
		).toBe(true)
	})
})

// A pick runs a body the Protocol provides, and a requirement has none. The
// Namespace that writes it is what the Help names.
describe("A Protocol pick of a requirement", () => {
	let picked = `implementation {
		Terminal.print(5::<Equatable>is(5))
		Terminal.print(5::<Printable>toString())
	}`

	it("should label the pick and say the requirement has no body", () => {
		let reported = firstOf(picked, "picked-requirement")

		expect(reported.message).toBe("'Equatable' has no body for 'is'")
		expect(
			reported.labels.map((label) => [
				label.message,
				label.position.start.column,
			]),
		).toEqual([
			["this picks 'Equatable'", 22],
			["'Equatable' declares this without a body", 32],
		])
		expect(reported.notes).toEqual([
			"A pick through a Protocol calls a body the Protocol provides, and 'Equatable' declares 'is' without one: each conforming Namespace writes its own.",
		])
		expect(reported.helps).toEqual([
			"Drop the pick, or pick the Namespace that writes 'is': '::<Integer>is(…)'.",
		])
	})

	it("should report a pick of the printing requirement the same way", () => {
		let reported = enrich(parse(picked)).diagnostics.map((diagnostic) => [
			diagnostic.code,
			diagnostic.message,
		])

		expect(reported).toEqual([
			["picked-requirement", "'Equatable' has no body for 'is'"],
			["picked-requirement", "'Printable' has no body for 'toString'"],
		])
	})

	it("should compile with the pick dropped or naming the Namespace", () => {
		expect(
			compiles(`implementation {
				Terminal.print(5::is(5))
				Terminal.print(5::<Integer>is(5))
				Terminal.print(5::toString())
				Terminal.print(5::<Integer>toString())
			}`),
		).toBe(true)
	})

	let shelves = (call: string) => `implementation {
		protocol Sized {
			size() -> Integer

			isEmpty() -> Boolean {
				<- @::size()::is(0)
			}
		}

		type Shelf = { books: Integer }

		namespace Shelves for Shelf is Sized {
			size() -> Integer {
				<- @.books
			}
		}

		constant shelf: Shelf = { books = 0 }

		Terminal.print(${call})
	}`

	it("should name the Namespace that writes a Program's requirement", () => {
		expect(
			firstOf(shelves("shelf::<Sized>size()"), "picked-requirement")
				.helps,
		).toEqual([
			"Drop the pick, or pick the Namespace that writes 'size': '::<Shelves>size()'.",
		])
		expect(compiles(shelves("shelf::size()"))).toBe(true)
		expect(compiles(shelves("shelf::<Shelves>size()"))).toBe(true)
	})

	it("should name no Namespace where none writes it for the value", () => {
		expect(
			firstOf(shelves("5::<Sized>size()"), "picked-requirement").helps,
		).toEqual([
			"Drop the pick, and call 'size' on a value whose Namespace writes it.",
		])
	})

	// The control: a provided Method is what a pick reaches.
	it("should keep a pick of a provided Method", () => {
		expect(compiles(shelves("shelf::<Sized>isEmpty()"))).toBe(true)
	})

	// A bound passes the conformance in, and the pick reaches its requirement
	// through it. Without a bound there is nothing to pick from, which the
	// bound's Help answers.
	it("should leave a pick on a Type Parameter to its bound", () => {
		let generic = (bound: string) => `implementation {
			protocol Shape {
				area() -> Integer
			}

			namespace Square for Integer is Shape {
				area() -> Integer {
					<- @::multiply(with @)
				}
			}

			function measured<infer T${bound}>(_ x: T) -> Integer {
				<- x::<Shape>area()
			}

			Terminal.print(measured(5))
		}`

		expect(compiles(generic(" is Shape"))).toBe(true)

		let unbounded = enrich(parse(generic(""))).diagnostics

		expect(unbounded.map((diagnostic) => diagnostic.code)).toContain(
			"no-namespace-for-value",
		)
		expect(
			unbounded.some(
				(diagnostic) => diagnostic.code === "picked-requirement",
			),
		).toBe(false)
	})

	// A Union has no covering Namespace for 'is', but each member answers
	// it, and a Choice's derived conformance does. Each member's 'is' takes
	// its own Type, so dropping the pick from the Union's call does not
	// compile.
	it("should report a pick on a Union or a Choice receiver as a pick", () => {
		let source = `implementation {
			choice Light {
				Red, Green
			}

			function same(_ x: Integer | String) -> Boolean {
				<- x::<Equatable>is(x)
			}

			constant light: Light = #Red

			Terminal.print(light::<Equatable>is(#Red))
		}`
		let reported = enrich(parse(source)).diagnostics

		expect(
			reported.map((diagnostic) => [diagnostic.code, diagnostic.helps]),
		).toEqual([
			[
				"picked-requirement",
				[
					"Match on the value, and call 'is' on '@' in each arm, with Arguments of that arm's Type.",
				],
			],
			["picked-requirement", ["Drop the pick."]],
		])
		expect(
			compiles(`implementation {
				choice Light {
					Red, Green
				}

				function same(_ x: Integer | String) -> Boolean {
					<- match x -> Boolean {
						case Integer { <- @::is(@) }
						case String  { <- @::is(@) }
					}
				}

				constant light: Light = #Red

				Terminal.print(light::is(#Red))
			}`),
		).toBe(true)
	})

	// The probe for the Help enriches the Arguments too, and must leave their
	// own Diagnostics to the call. An Argument that is an Error still fits.
	it("should report an Argument's own mistake beside the pick", () => {
		let reported = enrich(
			parse(`implementation {
				Terminal.print(5::<Equatable>is(nowhere))
				Terminal.print(5::<Equatable>is([1, 2]::map((n) { <- n::add(missing) })::count()))
			}`),
		).diagnostics

		expect(
			reported.map((diagnostic) => [
				diagnostic.code,
				diagnostic.position?.start.line,
			]),
		).toEqual([
			["unknown-name", 2],
			["picked-requirement", 2],
			["unknown-name", 3],
			["no-matching-overload", 3],
			["picked-requirement", 3],
		])
		expect(reported[1]?.helps).toEqual([
			"Drop the pick, or pick the Namespace that writes 'is': '::<Integer>is(…)'.",
		])
	})

	// Dropping the pick would leave `is` refusing the String, so the Help
	// says what the Argument has to be instead.
	it("should offer to drop a pick only where the call then compiles", () => {
		expect(
			firstOf(
				`implementation {
				Terminal.print(5::<Equatable>is("a"))
			}`,
				"picked-requirement",
			).helps,
		).toEqual([
			"Drop the pick, and pass 'is' the Arguments 'Integer::is' takes.",
		])
		expect(
			compiles(`implementation {
				Terminal.print(5::is(5))
			}`),
		).toBe(true)
	})

	// `Other` and `Counting` both provide `trail`, and `Things` writes none,
	// so dropping the pick ties them. `Things`'s conformance to `Requiring`
	// runs `Other`'s body, the first its clauses reach, so that is the pick.
	let trails = (
		call: string,
		clauses: string = "is Requiring, is Other, is Counting",
	) => `implementation {
		protocol Requiring {
			trail(_ n: Integer) -> String
		}

		protocol Counting {
			trail(_ n: Integer) -> String {
				<- "c{n}"
			}
		}

		protocol Other {
			trail(_ n: Integer) -> String {
				<- "o{n}"
			}
		}

		type Thing = { value: Integer }

		namespace Things for Thing ${clauses} {}

		function viaRequiring<infer Item is Requiring>(_ item: Item) -> String {
			<- item::trail(3)
		}

		constant thing: Thing = { value = 1 }

		Terminal.print(viaRequiring(thing))
		Terminal.print(${call})
	}`

	it("should pick the Protocol whose body the conformance runs where two bodies tie", () => {
		expect(
			firstOf(trails("thing::<Requiring>trail(3)"), "picked-requirement")
				.helps,
		).toEqual([
			"Pick the Protocol whose body 'Requiring' runs here: '::<Other>trail(…)'.",
		])
		expect(codesOfSource(trails("thing::trail(3)"))).toEqual([
			"ambiguous-namespace",
		])
		expect(compiles(trails("thing::<Other>trail(3)"))).toBe(true)
	})

	it("should ask for the Arguments the picked body declares", () => {
		expect(
			firstOf(
				trails('thing::<Requiring>trail("x")'),
				"picked-requirement",
			).helps,
		).toEqual([
			"Pick the Protocol whose body 'Requiring' runs here, '::<Other>trail(…)', and pass it the Arguments 'Other' declares.",
		])
		expect(compiles(trails("thing::<Other>trail(3)"))).toBe(true)
	})

	// One body answers, and `Things` writes no `trail` to pick.
	it("should drop the pick where one Protocol's body answers", () => {
		let single = (call: string) => trails(call, "is Requiring, is Other")

		expect(
			firstOf(single("thing::<Requiring>trail(3)"), "picked-requirement")
				.helps,
		).toEqual(["Drop the pick."])
		expect(compiles(single("thing::trail(3)"))).toBe(true)
	})

	it("should name the Protocol that declares an inherited requirement", () => {
		let reported = firstOf(
			`implementation {
				Terminal.print(5::<Orderable>compare(to 3))
			}`,
			"picked-requirement",
		)

		expect(reported.message).toBe("'Orderable' has no body for 'compare'")
		expect(reported.labels[1]?.message).toBe(
			"'Comparable' declares this without a body",
		)
		expect(reported.notes).toEqual([
			"A pick through a Protocol calls a body the Protocol provides, and 'Comparable' declares 'compare' without one: each conforming Namespace writes its own.",
		])
	})
})

// A pick reaches every body its Protocol has, its own and those it inherits.
// A name the Protocol has not got, or a value that does not conform to it, is
// a lookup the pick narrowed to nothing.
describe("A Protocol pick of a name its Protocol inherits", () => {
	it("should compile a pick of a body an ancestor provides", () => {
		expect(
			compiles(`implementation {
				Terminal.print(5::<Orderable>isLessThan(3))
				Terminal.print(5::<Orderable>isGreaterThanOrEqualTo(3))
			}`),
		).toBe(true)
	})

	it("should refuse a name the Protocol has not got, and compile without the pick", () => {
		let reported = firstOf(
			`implementation {
				Terminal.print(5::<Orderable>is(3))
			}`,
			"no-namespace-for-value",
		)

		expect(reported.notes).toEqual([
			"The specifier limits the lookup to 'Orderable', which provides no 'is' for PositiveInteger.",
		])
		expect(reported.helps).toEqual(["Drop the Namespace specifier."])
		expect(
			compiles(`implementation {
				Terminal.print(5::is(3))
			}`),
		).toBe(true)
	})

	// A String answers `isLessThan`, only not through `Orderable`, so the
	// report is about the pick. Dropping it leaves `3` for the String's
	// `isLessThan`, so the Help asks for a `match`.
	it("should report a Union member the pick leaves without the Method", () => {
		let reported = firstOf(
			`implementation {
				constant x: Integer | String = 5

				Terminal.print(x::<Orderable>isLessThan(3))
			}`,
			"no-namespace-for-value",
		)

		expect(reported.notes).toEqual([
			"The specifier limits the lookup to 'Orderable', which provides no 'isLessThan' for String.",
		])
		expect(reported.helps).toEqual([
			"Match on the value, and call 'isLessThan' on '@' in each arm, with Arguments of that arm's Type.",
		])
		expect(
			compiles(`implementation {
				constant x: Integer | String = 5

				Terminal.print(match x -> Boolean {
					case Integer { <- @::<Orderable>isLessThan(3) }
					case String  { <- @::isLessThan("b") }
				})
			}`),
		).toBe(true)
	})

	it("should offer to drop a specifier that leaves a Union member out where the call then compiles", () => {
		expect(
			firstOf(
				`implementation {
				constant x: Integer | Rational = 5

				Terminal.print(x::<Integer>isLessThan(3))
			}`,
				"no-namespace-for-value",
			).helps,
		).toEqual(["Drop the Namespace specifier."])
		expect(
			compiles(`implementation {
				constant x: Integer | Rational = 5

				Terminal.print(x::isLessThan(3))
			}`),
		).toBe(true)
	})

	// Dropping the pick leaves `is` and `isLessThan` refusing the Argument,
	// so the Help names the Method whose Arguments to pass.
	it("should offer to drop a pick of a name it has not got only where the call then compiles", () => {
		let reported = enrich(
			parse(`implementation {
				Terminal.print(5::<Orderable>is("a"))
				Terminal.print("abc"::<Orderable>isLessThan(5))
			}`),
		).diagnostics

		expect(
			reported.map((diagnostic) => [diagnostic.code, diagnostic.helps]),
		).toEqual([
			[
				"no-namespace-for-value",
				[
					"Drop the Namespace specifier, and pass 'is' the Arguments 'Integer::is' takes.",
				],
			],
			[
				"no-namespace-for-value",
				[
					"Drop the Namespace specifier, and pass 'isLessThan' the Arguments 'String::isLessThan' takes.",
				],
			],
		])
		expect(
			compiles(`implementation {
				Terminal.print(5::is(5))
				Terminal.print("abc"::isLessThan("b"))
			}`),
		).toBe(true)
	})

	// `String` is `Comparable` but not `Orderable`, so the body `Orderable`
	// inherits is not offered for it.
	it("should refuse a value that does not conform to the picked Protocol", () => {
		let reported = firstOf(
			`implementation {
				Terminal.print("abc"::<Orderable>isLessThan("b"))
			}`,
			"no-namespace-for-value",
		)

		expect(reported.helps).toEqual(["Drop the Namespace specifier."])
		expect(
			compiles(`implementation {
				Terminal.print("abc"::isLessThan("b"))
			}`),
		).toBe(true)
	})
})
