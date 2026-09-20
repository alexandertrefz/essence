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

	// NOTE: The condition is what the Function's Help would have sent a reader
	// to write as a bound, so the conformance it belongs on is named — and the
	// one it is named for is one this Namespace already declares, since a
	// conformance it does not owe is a second report rather than a fix.
	it("should name a conformance this Namespace declares", () => {
		expect(firstOf(withoutTheWhere, "unsatisfied-bound").helps).toEqual([
			"Add 'where Item is Comparable' to 'is Printable' on this Namespace.",
		])
	})

	// NOTE: THE language gap this audit found, said in a Note because there is
	// no Help to give: a `where` reaches the Methods that fulfil its conformance
	// and no others, so a Method that fulfils none can not be bounded at all.
	// Anything offered here would be an edit the Compiler goes on to refuse.
	it("should offer nothing where the condition is already written", () => {
		let diagnostic = firstOf(underAWhere, "unsatisfied-bound")

		expect(diagnostic.helps).toEqual([])
		expect(diagnostic.notes[1]).toBe(
			"'is Printable where Item is Comparable' is declared here already, and a 'where' reaches the Methods that fulfil 'Printable' and no others — a Method that fulfils nothing can not be bounded.",
		)
	})

	it("should state the rule where there is no conformance to name", () => {
		let diagnostic = firstOf(noConformanceAtAll, "unsatisfied-bound")

		expect(diagnostic.helps).toEqual([])
		expect(diagnostic.notes[1]).toBe(
			"A Namespace's own Type Parameters take no bounds — a 'where' on one of its conformances carries them, and reaches the Methods that fulfil that Protocol.",
		)
	})

	// NOTE: The other end of the loop. Naming the BOUND Protocol read as an
	// instruction to declare `is Comparable`, which a Namespace with no
	// `compare` does not — so following it reported a missing requirement and
	// sent the reader back to the bound.
	it("should name a declared conformance from the refusal side too", () => {
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
			"Bound it on a conformance this Namespace declares: 'is Printable where Item is Comparable'.",
		])
	})

	it("should write the shape as a schematic where nothing is declared", () => {
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
			"Declare a conformance on this Namespace and bound it there — 'is …' with a Protocol of your own, then 'where Item is Comparable'.",
		])
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

	it("should name the culprit rather than the Type the bound was on", () => {
		expect(
			firstOf(resultOfAChoice, "unsatisfied-conformance-condition").helps,
		).toEqual([
			"Declare a Namespace 'for Problem is Printable' — its body may be empty, since a Choice whose Cases carry no payload prints as their names.",
		])
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
