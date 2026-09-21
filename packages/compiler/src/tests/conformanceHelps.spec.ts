import { describe, expect, it } from "bun:test"

import { compiles, firstAnalysed, firstOf } from "./followedHelps"

// NOTE: The Helps about conformance, each one followed LITERALLY — the audit
// that wrote this spec found four of them leading in circles and one leading
// somewhere worse than nowhere.
//
// Two of the five were a pair: `unsatisfied-bound` sent a reader to write
// `<infer Item is Comparable>` on a Namespace's Type Parameter, which
// `protocol-bound-namespace-generic` refuses, whose own Help sent them back. A
// loop between two reports is not something either of them can be tested out of
// alone, so both ends are written down here.

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

	// NOTE: The Help that always applies, and the only one that needs nothing
	// declared: the bound goes on the Method that needs it. Followed literally
	// — `biggest<Item is Comparable>()` — and the result compiles, which is the
	// whole of what these specs are for.
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

	// NOTE: No `where` alternative here, and that is the point of the Scope
	// carrying the Method's name. A `where` reaches only the Methods that fulfil
	// the conformance — `biggest` fulfils nothing, so adding it changes nothing
	// and the report comes back unchanged. Offered where it WOULD work, which is
	// the spec below this one.
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

	// NOTE: The same Namespace shape, the same Parameter, asked from a Method
	// that DOES fulfil the conformance — and now the `where` is the edit that
	// works, and the only one offered: a fulfilling Method may not carry a bound
	// of its own, because the conformance promised it without one.
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

	// NOTE: Where the condition is already written, the Note says why it does
	// not reach here — `biggest` fulfils nothing — and the Help is the same edit
	// as everywhere else. This used to end in no Help at all, on the reading
	// that a Method fulfilling nothing could not be bounded; it can.
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

	// NOTE: The other end of what used to be a loop. The refusal of a bound on
	// the NAMESPACE now leads with the per-Method edit, which is one that works
	// whatever the Namespace declares.
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
			"Or bound it on a conformance this Namespace declares: 'is Printable where Item is Comparable'.",
		])
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

	// NOTE: A Function's Parameter is a different mistake and keeps the Help it
	// always had — the edit it names is one that exists.
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
	// NOTE: `nonconforming-namespace` asked for a `where` that
	// `conflicting-where-condition` then refused, leaving the original report
	// standing beside a new one. One bound per Type Parameter per conformance,
	// so the second bound is a conformance of its own.
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

	// NOTE: The code that used to print nothing at all, which left a reader
	// holding a refusal and no direction.
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
	// NOTE: The Label names the requirement the check stopped at; the Help names
	// every one the conformance owes, which is what a reader in a terminal —
	// with no Quick Fix to apply — was never told.
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

	// NOTE: A Method to CORRECT rather than one to write, so no stub is named
	// and the Help says where the shape it has to take is written down.
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

describe("A Type in want of a conformance", () => {
	// NOTE: The Type to do something about is the LAST link of the chain, not
	// the one the bound was written on: a Namespace `for Result<String, Problem>`
	// answers this one call and leaves every other Result unprintable.
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

	// NOTE: TWO Helps, and the order is the two questions a reader has. The
	// escape comes first because it always works at a print and costs no
	// declaration — `Terminal.inspect` takes any value — and the declaration
	// comes second because it is what keeps `print`. The escape is offered
	// wherever a print is refused, whatever the failing Type is: a Record whose
	// member can not print, a Result holding a Choice nobody declared Printable,
	// a List of either.
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

	// NOTE: Work is one word short, not a Type in want of a conformance.
	// Declaring `for Future<String> is Printable` COMPILES and prints a
	// description of the work, which is the one outcome nobody wanted — so this
	// says what every other report about a forgotten `complete` says.
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

	// NOTE: And where the body can NOT wait, the word is not offered at all —
	// the same rule `interpolation-not-printable` follows, said in one voice
	// because one helper writes both.
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
})

describe("A bounded Function used as a value", () => {
	// NOTE: "Call it directly" answered by throwing the value away, which is not
	// an edit anybody who reached for a value can make. The wrap keeps it.
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

// NOTE: A Method that has ALREADY bounded the Namespace's Parameter and wants a
// second Protocol. The bound reaches its body through a Scope of its own, and
// that Scope used to answer "no Namespace declares this name" — so the report
// took the FUNCTION branch and told the reader to write
// `<infer Item is Comparable>`, which is the one spelling a Namespace's own
// Parameter refuses. The label said "unbounded" of a Parameter bounded two
// lines up.
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

	// NOTE: And no Quick Fix either — `data` is the same decision the text is
	// made of, so an Editor can not offer what the report withheld.
	it("should carry no Quick Fix", () => {
		expect(firstOf(source, "unsatisfied-bound").data).toBeUndefined()
	})
})

// NOTE: The Help that has to say what the language can NOT do. A Type Parameter
// carries one bound, so the two written here are not a Parameter bounded by
// both — the second silently replaced the first until this was refused, and the
// body was then refused for wanting what the reader had already asked for.
//
// Followed literally, both halves: the one the body needs compiles, and the
// other leaves the body reported at the call that wants it, which is where the
// Protocol it needs is named.
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

	// NOTE: Not a Help that fails — a Help that says "the one the body needs",
	// tested by showing the other one is not it, and that the report a reader
	// meets then is the one that names the Protocol.
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
