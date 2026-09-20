import { describe, expect, it } from "bun:test"

import {
	codesOfSource,
	compiles,
	compilesCompletely,
	helpsOfCode,
} from "./helpPromises"

// NOTE: One promise per report: a Help names an edit the reader can make HERE,
// and following it reaches a Program that compiles or a GENUINELY different
// mistake. Every Help below is printed by the Compiler and then written into the
// probe it came from, so a Help that stops being followable fails here rather
// than in a reader's afternoon.
//
// The withheld cases are pinned beside the offered ones. Half of what this audit
// found was a Help that was perfectly true somewhere else — a Match that narrows
// a Union of DECLARED Types, a `complete` in a body that waits — and a condition
// that stops being tested is a condition that quietly stops holding.

describe("A member path with no Function around it", () => {
	let source = `implementation {
		constant price = .price
	}`

	it("spells both of the literal's Types", () => {
		expect(codesOfSource(source)).toEqual(["path-without-context"])
		expect(helpsOfCode(source, "path-without-context")).toEqual([
			"Write the Function literal instead, with the Parameter and return Types a path leaves out — '(_ item: <Type>) -> <Type> { <- item.price }', filling each '<Type>' in.",
		])
	})

	// NOTE: The Help used to write `(_ item: SomeType) { … }`, and BOTH halves of
	// it were dead ends: `SomeType` is a Type no Program declares, and a literal
	// outside Argument position that omits its `-> Type` is refused for that too.
	// A reader who fixed the first met `missing-return-type` for the second.
	it("compiles with the blanks filled in", () => {
		expect(
			compiles(`implementation {
		type Product = { price: Integer }

		constant price = (_ item: Product) -> Integer { <- item.price }
	}`),
		).toBe(true)
	})

	// NOTE: A position naming a Type other than a Function wants a VALUE, and no
	// Function literal fits it however its Types are written.
	it("offers a value where the position names no Function", () => {
		let returned = `implementation {
		function priceOf() -> Integer {
			<- .price
		}
	}`

		expect(helpsOfCode(returned, "path-without-context")).toEqual([
			"This position expects an Integer rather than a Function — read the members off a value instead, writing what this answers with in place of '<value>': '<value>.price'.",
		])
	})
})

describe("A Method that can not be dispatched", () => {
	let source = `implementation {
		function describe<infer First is Printable, infer Second is Printable>(_ value: First | Second) -> String {
			<- value::toString()
		}
	}`

	// NOTE: A Match narrows NOTHING over a Union of Type Parameters — Types erase
	// before one runs — so the Help that offered one sent the reader into
	// `erased-case-conflict`, whose own Help swaps the two arms and produces its
	// own mirror image. A closed loop, and the only report in this family that
	// had one.
	it("names the signature that works instead of a Match", () => {
		expect(helpsOfCode(source, "undispatchable-method")).toEqual([
			"Take one Type Parameter in place of the Union — '<infer Item is Printable>(_ value: Item)' — since Types erase before a Match runs, and a Match is the only thing that narrows.",
		])
	})

	it("compiles when the signature is written that way", () => {
		expect(
			compiles(`implementation {
		function describe<infer Item is Printable>(_ value: Item) -> String {
			<- value::toString()
		}
	}`),
		).toBe(true)
	})
})

describe("A Type Parameter nothing bound", () => {
	// NOTE: `Other` belongs to `Result::andThen`, and it is written in the step's
	// own answer Type — so it HAS a place among the Parameters, and the Help that
	// asked for one was asking the reader to edit the standard library. What is
	// actually missing is the literal's `-> Type`.
	let source = `implementation {
		constant never = loop(startingWith 0,
			step (state) { <- #Continue(state::add(1)) })
	}`

	it("names the literal's own return Type", () => {
		expect(helpsOfCode(source, "uninferable-type-parameter")).toEqual([
			"Write the Function literal's return Type — '-> Type' after its Parameter list — which is what binds 'Answer'.",
		])
	})

	it("compiles once the literal writes it", () => {
		expect(
			compiles(`implementation {
		constant never = loop(startingWith 0,
			step (state) -> Step<Integer, Integer> { <- #Continue(state::add(1)) })
	}`),
		).toBe(true)
	})

	// NOTE: And the pair it used to print stands where it is TRUE — a signature
	// naming a Type Parameter only in its answer Type is unbindable from any
	// call, and there the two ends really are the reader's to hold.
	it("keeps the general pair for a signature no Argument binds", () => {
		let unbindable = `implementation {
		function blank<infer Item>() -> List<Item> {
			<- []
		}

		constant items = blank()
	}`

		expect(helpsOfCode(unbindable, "uninferable-type-parameter")).toEqual([
			"Give the Type Parameter a place among the Parameters, so that an Argument binds it.",
			"Or write the value itself, where what it answers is already known — 'constant items: List<Integer> = []'.",
		])
	})
})

describe("A return Type nothing could read off the body", () => {
	let source = `implementation {
		constant doubled = [1, 2]::map((number) {
			number::multiply(with 2)
		})
	}`

	// NOTE: The annotation alone moved the report to `missing-return` one run
	// later, which is the same mistake in another stage's words — and the docs
	// have said all along that a forgotten `<-` is the usual cause.
	it("names the missing '<-' first", () => {
		expect(helpsOfCode(source, "uninferable-return-type")).toEqual([
			"Return the value with '<-' — a body whose last line is a value answers with nothing.",
			"Or give the Function an explicit '-> Type'.",
		])
	})

	it("compiles once the value is returned", () => {
		expect(
			compiles(`implementation {
		constant doubled = [1, 2]::map((number) {
			<- number::multiply(with 2)
		})
	}`),
		).toBe(true)
	})

	// NOTE: Withheld where the body DOES return and still answers nothing — the
	// `<-` is written, and telling its author to write one is advice about a
	// Program they do not have.
	it("withholds it where the body already returns", () => {
		let returns = `implementation {
		function half(_ text: String) -> Result<Integer, String> {
			<- Integer.parse(text)::toResult(failingWith "not a number")::andThen((value) {
				<- #Value(value)
			})
		}
	}`

		expect(helpsOfCode(returns, "uninferable-return-type")).toEqual([
			"Give the Function an explicit '-> Type'.",
		])
	})
})

describe("A Function literal outside Argument position", () => {
	// NOTE: Two round trips for one under-annotated literal: the Parameter was
	// reported, and only once it carried a Type was the missing `-> Type`
	// reported in turn. Both halves are named where the first of them is raised.
	it("asks for the Parameter Type and the return Type together", () => {
		let source = `implementation {
		constant double = (number) {
			<- number::multiply(with 2)
		}
	}`

		expect(helpsOfCode(source, "uninferable-parameter-type")).toEqual([
			"Write the Parameter's Type and the Function's return Type — a literal outside Argument position takes neither from around it.",
		])
	})

	// NOTE: And the return Type is spelled out where the body says what it is.
	it("spells the return Type the body answers with", () => {
		let source = `implementation {
		type Product = { price: Integer }

		constant price = (_ item: Product) { <- item.price }
	}`

		expect(helpsOfCode(source, "missing-return-type")).toEqual([
			"Write the return Type after the Parameter list — '-> Integer', which is what this body answers with.",
		])
		expect(
			compiles(`implementation {
		type Product = { price: Integer }

		constant price = (_ item: Product) -> Integer { <- item.price }
	}`),
		).toBe(true)
	})
})

describe("A Namespace specifier that names something else", () => {
	// NOTE: One mistake, one report. The empty lookup a refused specifier leaves
	// behind read as "no Namespace targets this value", which is false — the very
	// call without the specifier compiles.
	it("reports once and does not deny the receiver its Namespace", () => {
		let source = `implementation {
		constant total = 1

		Terminal.print("hello"::<total>append("!"))
	}`

		expect(codesOfSource(source)).toEqual(["not-a-namespace"])
		expect(
			compilesCompletely(`implementation {
		constant total = 1

		Terminal.print("hello"::append("!"))
	}`),
		).toBe(true)
	})
})

describe("A 'where' clause on a base that can not carry one", () => {
	let source = `implementation {
		type Yes = Boolean where @::is(true)
	}`

	// NOTE: Dropping the clause compiles, and it answers a DIFFERENT Declaration
	// — "a Boolean that is true" becomes "any Boolean". So the edit says what it
	// costs, and the other half names what the intent survives on.
	it("says what dropping the clause costs", () => {
		expect(helpsOfCode(source, "invalid-refinement-predicate")).toEqual([
			"Drop the 'where' clause from 'Yes', which leaves the Alias naming Boolean and nothing more.",
			"Or write the refinement on a base one can be checked against — an Integer, a Rational, a String, an applied List or an applied Dictionary.",
		])
		expect(
			compiles(`implementation {
		type Yes = Boolean
	}`),
		).toBe(true)
		expect(
			compiles(`implementation {
		type Yes = Integer where @::isGreaterThan(0)
	}`),
		).toBe(true)
	})
})

describe("A payload that spells the Case's members", () => {
	// NOTE: The shorthand sentence fired for every multi-member mismatch there
	// is, because its guard counted members and looked at nothing else. A payload
	// that already writes the Record took a shortcut with nothing.
	it("withholds the shorthand sentence", () => {
		let source = `implementation {
		choice Shape {
			Rectangle { width: Integer, height: Integer },
		}

		constant shape: Shape = Shape#Rectangle({ width = "wide", height = 2 })
	}`

		expect(helpsOfCode(source, "payload-type-mismatch")).toEqual([])
	})

	// NOTE: And keeps it where a value really was handed over on its own, which
	// is the one shape the sentence was written for.
	it("keeps it where the payload is not the Case's Record", () => {
		let source = `implementation {
		choice Shape {
			Rectangle { width: Integer, height: Integer },
		}

		constant shape: Shape = Shape#Rectangle(2)
	}`

		expect(helpsOfCode(source, "payload-type-mismatch")).toContain(
			"The one-member shorthand '#Case(value)' only applies to single-member Cases.",
		)
	})
})

describe("A Future where its value is wanted", () => {
	const fetched = [
		"	function fetched() -> Future<Integer> {",
		"		complete Async.sleep(milliseconds 1)",
		"",
		"		<- 41",
		"	}",
	].join("\n")

	// NOTE: `complete` in a body that answers no Future is
	// `complete-outside-future`, so the word was offered where writing it is a
	// refusal — and the Quick Fix keyed on the same data wrote it.
	it("withholds 'complete' where the body can not wait", () => {
		let source = `implementation {
${fetched}

	function total() -> Integer {
		<- 1::add(fetched())
	}
}`

		expect(helpsOfCode(source, "no-matching-overload")).toEqual([
			"'complete' only stands in a body that answers a Future, and this one does not — reach through it with '::map((value) { … })', which answers another Future, or declare the enclosing Function '-> Future<…>'.",
		])
	})

	it("offers it where the body does wait", () => {
		let source = `implementation {
${fetched}

	function total() -> Future<Integer> {
		<- 1::add(fetched())
	}
}`

		expect(helpsOfCode(source, "no-matching-overload")).toEqual([
			"This describes work that has not run — add 'complete'.",
		])
	})

	// NOTE: The same rule on the Declaration rail, where the surveyed Quick Fix
	// wrote the word into a body that could not hold it.
	it("withholds it on a Declaration in a body that can not wait", () => {
		let source = `implementation {
${fetched}

	function shown() -> String {
		constant value: Integer = fetched()

		<- value::toString()
	}
}`

		expect(helpsOfCode(source, "assignment-type-mismatch")).toEqual([
			"'complete' only stands in a body that answers a Future, and this one does not — reach through it with '::map((value) { … })', which answers another Future, or declare the enclosing Function '-> Future<…>'.",
		])
	})
})

describe("One mistake, one report", () => {
	// NOTE: The program the survey named. A literal whose return Type could not
	// be read reported four times — the literal itself, the Type Parameter the
	// call could not bind, the `#Failure(…)` measured against an Error and the
	// `#Value(…)` beside it with no Choice to pick from — and only the first of
	// the four named an edit that helps. Plus one warning that really is
	// independent, which is what keeps this from being a test about silence.
	let source = `implementation {
		function half(_ text: String) -> Result<Integer, String> {
			<- Integer.parse(text)::toResult(failingWith "not a number")::andThen((value) {
				if value::isOdd() {
					<- #Failure("odd")
				}

				<- #Value(value::quotient(dividingBy 2, defaultingTo 0))
			})
		}
	}`

	it("reports the literal and the fallback and nothing else", () => {
		expect(codesOfSource(source)).toEqual([
			"uninferable-return-type",
			"fallback-never-used",
		])
	})

	it("leaves the warning alone once the literal is annotated", () => {
		expect(
			codesOfSource(`implementation {
		function half(_ text: String) -> Result<Integer, String> {
			<- Integer.parse(text)::toResult(failingWith "not a number")::andThen((value) -> Result<Integer, String> {
				if value::isOdd() {
					<- #Failure("odd")
				}

				<- #Value(value::quotient(dividingBy 2, defaultingTo 0))
			})
		}
	}`),
		).toEqual(["fallback-never-used"])
	})

	// NOTE: And a capture refused before its Type was decided answers for the
	// call around it too — `items::length()` reported the capture and then
	// reported `ItemType` on top of it.
	it("reports a capture once, not once per Type Parameter", () => {
		expect(
			codesOfSource(`implementation {
		variable items = []

		constant count = () -> Integer {
			<- items::length()
		}
	}`),
		).toEqual(["uninferable-item-type"])
	})

	// NOTE: And a call on a value that is not a Function is one mistake however
	// many stages notice it.
	it("reports a call on a value once", () => {
		expect(
			codesOfSource(`implementation {
		constant total = 1

		Terminal.print(total())
	}`),
		).toEqual(["not-a-function"])
	})
})

describe("Reports that knew the fix and said nothing", () => {
	// NOTE: Each of these had the answer in hand — the value's Type, the Type's
	// arity, the declared return Type — and printed a Note about the mistake
	// without naming the edit.
	it("names the question an Optional answers", () => {
		let source = `implementation {
		constant found: Optional<Integer> = #Value(1)

		if found {
			Terminal.print("yes")
		}
	}`

		expect(helpsOfCode(source, "condition-not-boolean")).toEqual([
			"Ask a question that answers a Boolean — '::hasValue()' reads an Optional<Integer>.",
		])
		expect(
			compilesCompletely(`implementation {
		constant found: Optional<Integer> = #Value(1)

		if found::hasValue() {
			Terminal.print("yes")
		}
	}`),
		).toBe(true)
	})

	it("names the brackets to take off a call that is not one", () => {
		let source = `implementation {
		constant total = 1

		Terminal.print(total())
	}`

		expect(helpsOfCode(source, "not-a-function")).toEqual([
			"Remove the '()' — the name already reads the value.",
			"Or call a Method on it with '::', which is how a Method is reached.",
		])
	})

	it("names both readings of a '<-' at the top level", () => {
		let source = `implementation {
		<- 42
	}`

		expect(helpsOfCode(source, "top-level-return")).toEqual([
			"Drop the '<-' and write the value on its own, or as a 'constant'.",
			"Or move the Statement into a Function, which is the only thing a '<-' answers for.",
		])
	})

	it("spells the application a bare generic Type wants", () => {
		let source = `implementation {
		constant found: Optional = #Empty
	}`

		expect(helpsOfCode(source, "wrong-type-argument-count")).toEqual([
			"Write 'Optional<…>', with the Type you mean in place of each '…'.",
		])
		expect(
			compiles(`implementation {
		constant found: Optional<Integer> = #Empty
	}`),
		).toBe(true)
	})

	it("names the Type without its Arguments", () => {
		let source = `implementation {
		constant count: Integer<String> = 1
	}`

		expect(helpsOfCode(source, "type-not-generic")).toEqual([
			"Remove the Type Arguments — 'Integer' stands on its own.",
		])
		expect(
			compiles(`implementation {
		constant count: Integer = 1
	}`),
		).toBe(true)
	})

	it("names a question the predicate's answer can be asked", () => {
		let source = `implementation {
		type Small = Integer where @::absolute()
	}`

		// NOTE: Of '@' and not of what the clause answers — a predicate is ONE
		// call on '@', so a comparison chained onto `@::absolute()` is refused
		// by the rail beside this one.
		expect(helpsOfCode(source, "predicate-not-boolean")).toEqual([
			"Call a Method on '@' that answers a Boolean — '@::isGreaterThan(0)', for instance.",
		])
		expect(
			compiles(`implementation {
		type Small = Integer where @::isGreaterThan(0)
	}`),
		).toBe(true)
	})

	it("names the value a falling-through path has to answer with", () => {
		let source = `implementation {
		function sign(of number: Integer) -> String {
			if number::isGreaterThan(0) {
				<- "positive"
			}
		}
	}`

		expect(helpsOfCode(source, "missing-return")).toEqual([
			"Write a '<-' answering a String at the end of the body.",
			"Or give every branch one — an 'if' with no 'else' leaves the path around it falling through.",
		])
		expect(
			compilesCompletely(`implementation {
		function sign(of number: Integer) -> String {
			if number::isGreaterThan(0) {
				<- "positive"
			}

			<- "other"
		}
	}`),
		).toBe(true)
	})

	// NOTE: An unbounded Type Parameter reaches no Namespace at all — that is
	// what being unbounded means — and the Protocol that answers the call is
	// looked up rather than guessed at.
	it("names a Protocol that would give the Parameter a Namespace", () => {
		let source = `implementation {
		function show<infer Item>(_ item: Item) -> String {
			<- item::toString()
		}
	}`

		expect(helpsOfCode(source, "no-namespace-for-value")).toEqual([
			"Bound the Type Parameter by a Protocol that declares 'toString' — '<infer Item is Printable>' at the Declaration that introduces it.",
		])
		expect(
			compiles(`implementation {
		function show<infer Item is Printable>(_ item: Item) -> String {
			<- item::toString()
		}
	}`),
		).toBe(true)
	})
})
