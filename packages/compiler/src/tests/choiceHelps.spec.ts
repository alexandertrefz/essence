import { describe, expect, it } from "bun:test"

import { analysedDiagnosticsFor, compiles, firstOf } from "./followedHelps"

// NOTE: The Helps about Choices and about asynchrony that named a spelling the
// language does not have, contradicted the message above them, or were printed
// once per arm for one mistake. And the codes in this family that knew the fix
// and printed nothing at all.

describe("A hole holding a Type Parameter", () => {
	// NOTE: The Union Help is UNFOLLOWABLE for one: `Item` is no Union to match
	// apart and no Optional to unwrap, so a reader who followed it had nothing
	// to write a Case for. What it wants is a bound, and whose Parameter it is
	// decides where the bound goes.
	let source = `implementation {
		type Box<Item> = { item: Item }

		namespace Boxes<infer Item> for Box<Item> is Printable {
			toString() -> String {
				<- "a box of {@.item}"
			}
		}

		Terminal.print("{{ item = 1 }}")
	}`

	it("should ask for the bound rather than for a Match", () => {
		expect(firstOf(source, "interpolation-not-printable").helps).toEqual([
			"Add 'where Item is Printable' to 'is Printable' on this Namespace.",
		])
	})

	it("should compile with the condition the Help names", () => {
		expect(
			compiles(`implementation {
				type Box<Item> = { item: Item }

				namespace Boxes<infer Item> for Box<Item> is Printable where Item is Printable {
					toString() -> String {
						<- "a box of {@.item}"
					}
				}

				Terminal.print("{{ item = 1 }}")
			}`),
		).toBe(true)
	})

	// NOTE: A hole that holds neither work nor a Type Parameter keeps the Help
	// it was written for.
	it("should leave an unprintable Union alone", () => {
		let union = `implementation {
			constant value: Integer | String = 1

			Terminal.print("{value}")
		}`

		expect(firstOf(union, "interpolation-not-printable").helps).toEqual([
			"Interpolate only Printable values; match an Optional or a Union apart first and interpolate each Case.",
		])
	})
})

describe("A Match written on a Future", () => {
	let source = `implementation {
		choice Colour {
			Red,
			Green,
			Blue,
		}

		function pick() -> Future<Colour> {
			<- complete Async.deferred(() { <- Colour#Red })
		}

		function name() -> String {
			<- match pick() -> String {
				case #Red { <- "red" }
				case #Green { <- "green" }
				case #Blue { <- "blue" }
			}
		}

		Terminal.print(name())
	}`

	// NOTE: One mistake — the subject — said once per arm, each time about a
	// different Case name. The arms below the first answer with the Error they
	// would have answered with anyway.
	it("should report the subject once, not once per arm", () => {
		expect(
			analysedDiagnosticsFor(source).filter(
				(diagnostic) => diagnostic.code === "unknown-case",
			).length,
		).toBe(1)
	})

	// NOTE: `complete` is refused in a body that answers anything but a Future,
	// so the edit takes two steps and the declaration is the first of them.
	it("should name the declaration where the body can not wait", () => {
		expect(firstOf(source, "unknown-case").helps).toEqual([
			"Declare the enclosing Function '-> Future<…>', which is what lets its body wait, then wait for it first — 'constant answered = complete …' — and match 'answered'.",
		])
	})

	// NOTE: A body only WAITS once it writes the word — that is what the Parser
	// marks a body completing by — so the declaration alone is not enough and
	// the two-step Help above is right for a body that has not written one yet.
	// A Program's top level waits outright, and there the word is the whole edit.
	it("should name one step where the position waits outright", () => {
		let waits = `implementation {
			choice Colour {
				Red,
				Green,
			}

			function pick() -> Future<Colour> {
				<- complete Async.deferred(() { <- Colour#Red })
			}

			constant named = match pick() -> String {
				case #Red { <- "red" }
				case #Green { <- "green" }
			}

			Terminal.print(named)
		}`

		expect(firstOf(waits, "unknown-case").helps).toEqual([
			"Wait for it first — 'constant answered = complete …' — and match 'answered'.",
		])
	})

	it("should compile once both steps are taken", () => {
		expect(
			compiles(`implementation {
				choice Colour {
					Red,
					Green,
				}

				function pick() -> Future<Colour> {
					<- complete Async.deferred(() { <- Colour#Red })
				}

				function name() -> Future<String> {
					constant answered = complete pick()

					<- match answered -> String {
						case #Red { <- "red" }
						case #Green { <- "green" }
					}
				}

				Terminal.print(complete name())
			}`),
		).toBe(true)
	})
})

describe("A 'start' on work already in flight", () => {
	// NOTE: The Note explained a value that is NOT work, which is the opposite
	// complaint to the message above it — a reader told both had a
	// contradiction to resolve on their own.
	it("should say what a Started is", () => {
		let source = `implementation {
			function fetched() -> Future<String> {
				<- complete Async.deferred(() { <- "a" })
			}

			constant running = start fetched()
			constant again = start running

			Terminal.print(complete again)
		}`

		expect(firstOf(source, "needless-start").notes).toEqual([
			"A Started is one run of a Future, and it belongs to whoever started it — there is no second run to ask for.",
		])
	})

	it("should keep the other wording for a value that is no Future", () => {
		let source = `implementation {
			constant started = start 1

			Terminal.print("{started}")
		}`

		expect(firstOf(source, "needless-start").notes).toEqual([
			"'start' puts a Future in flight and answers the one run of it — a value that is not a Future describes no work to run.",
		])
	})
})

describe("A payload default a generic Choice can not take", () => {
	// NOTE: "Declare a Choice for the Type this default is a value of" is a
	// Choice of what the MEMBER holds — `1` is an Integer, and a Choice of
	// Integers defaults nothing. What admits the default is a Choice that
	// abstracts over nothing.
	let source = `implementation {
		choice Holder<Item> {
			Full { item: Item, count: Integer } = { count = 1 },
			Bare,
		}

		constant held: Holder<Integer> = Holder<Integer>#Full({ item = 2, count = 4 })

		Terminal.print("ok")
	}`

	it("should name a Choice that takes no Type Parameters", () => {
		expect(firstOf(source, "case-default-on-generic-choice").helps).toEqual(
			[
				"Write the member at each construction, or declare a Choice that takes no Type Parameters — one whose payload Types are written out, where a default has something to be checked against.",
			],
		)
	})

	it("should compile as a Choice with its payload Types written out", () => {
		expect(
			compiles(`implementation {
				choice Holder {
					Full { item: Integer, count: Integer } = { count = 1 },
					Bare,
				}

				constant held: Holder = Holder#Full({ item = 2 })

				Terminal.print("ok")
			}`),
		).toBe(true)
	})
})

describe("A payload default that names a value", () => {
	// NOTE: `'= { … }'` says only "a Record goes here", which the message above
	// it already said. The member names are in hand at the report site; the
	// values are not, and stay the `…` they are.
	let source = `implementation {
		constant defaults = { retries = 3 }

		choice Attempt {
			Get { url: String, retries: Integer } = defaults,
			Post { url: String },
		}

		constant attempt: Attempt = #Get({ url = "https://example.com", retries = 1 })

		Terminal.print("ok")
	}`

	it("should spell the members it is about", () => {
		expect(firstOf(source, "case-default-not-a-literal").helps).toEqual([
			"Write the members out — '= { url = …, retries = … }' names every member of '#Get', and a default may fill in any of them.",
		])
	})

	it("should compile with the members written out", () => {
		expect(
			compiles(`implementation {
				choice Attempt {
					Get { url: String, retries: Integer } = { retries = 3 },
					Post { url: String },
				}

				constant attempt: Attempt = #Get({ url = "https://example.com" })

				Terminal.print("ok")
			}`),
		).toBe(true)
	})
})

describe("The codes that knew the fix and said nothing", () => {
	it("should answer an empty Choice", () => {
		let source = `implementation {
			choice Blank {
			}

			Terminal.print("ok")
		}`

		expect(firstOf(source, "empty-choice").helps).toEqual([
			"Write a Case — 'choice Blank { First }' — or drop the declaration.",
		])

		expect(
			compiles(`implementation {
				choice Blank {
					First,
				}

				Terminal.print("ok")
			}`),
		).toBe(true)
	})

	it("should answer a conformance with no target Type", () => {
		let source = `implementation {
			namespace Tools is Printable {
				static greet() -> String {
					<- "hello"
				}
			}

			Terminal.print(Tools.greet())
		}`

		expect(firstOf(source, "conformance-needs-target-type").helps).toEqual([
			"Give this Namespace a target Type: 'namespace Tools for … is Printable'.",
		])
	})

	it("should answer a Protocol written where a Type goes", () => {
		let source = `implementation {
			function largest(of items: List<Comparable>) -> Integer {
				<- 1
			}

			Terminal.print("{largest(of [1])}")
		}`

		expect(firstOf(source, "protocol-as-type").helps).toEqual([
			"Write a Type Parameter bounded by it — '<infer T is Comparable>' — and name 'T' here.",
		])

		expect(
			compiles(`implementation {
				function largest<infer T is Comparable>(of items: List<T>) -> Integer {
					<- 1
				}

				Terminal.print("{largest(of [1])}")
			}`),
		).toBe(true)
	})
})
