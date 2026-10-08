import { describe, expect, it } from "bun:test"

import {
	analysedDiagnosticsFor,
	codesOfSource,
	compiles,
	enrichedDiagnosticsFor,
	firstAnalysed,
	helpsOfCode,
} from "./followedHelps"

// A Help names an edit the reader can make here, and following it reaches a
// Program that compiles or a different mistake. Each Help is written into the
// probe it came from and compiled. A Help withheld in one place is often true
// in another, so the withheld cases are pinned beside the offered ones.

describe("The harness these Helps are compiled by", () => {
	// The harness must run every stage, so a Help followed into a Validator
	// refusal fails. The Enricher accepts this Program and the Validator refuses
	// it.
	let unreturned = `implementation {
		function half(_ number: Integer) -> Integer {
			if number::isGreaterThan(0) {
				<- 1
			}
		}
	}`

	it("refuses what only the Validator refuses", () => {
		expect(enrichedDiagnosticsFor(unreturned)).toEqual([])
		expect(codesOfSource(unreturned)).toEqual(["missing-return"])
		expect(compiles(unreturned)).toBe(false)
	})
})

describe("A member path with no Function around it", () => {
	let source = `implementation {
		constant price = .price
	}`

	// The move comes first because it needs no Type written. The literal comes
	// second, with both of its Types spelled as blanks.
	it("offers the move first and spells both of the literal's Types", () => {
		expect(codesOfSource(source)).toEqual(["path-without-context"])
		expect(helpsOfCode(source, "path-without-context")).toEqual([
			"Pass the path where a Function of one Parameter is expected — '::map(.price)'.",
			"Or write the Function literal, with the Parameter and return Types a path leaves out — '(_ item: <Type>) -> <Type> { <- item.price }', filling each '<Type>' in.",
		])
	})

	// Where the position names a Type the move is withheld, since a `::map`
	// answers a List.
	it("withholds the move where the position names a Type", () => {
		let returned = `implementation {
		function priceOf() -> Integer {
			<- .price
		}
	}`

		expect(
			helpsOfCode(returned, "path-without-context").some((help) =>
				help.startsWith("Pass the path"),
			),
		).toBe(false)
	})

	// A literal outside Argument position takes no Types from around it, so
	// leaving out its `-> Type` would meet `missing-return-type`.
	it("compiles with the blanks filled in", () => {
		expect(
			compiles(`implementation {
		type Product = { price: Integer }

		constant price = (_ item: Product) -> Integer { <- item.price }
	}`),
		).toBe(true)
	})

	// A position naming a Type other than a Function wants a value, which no
	// Function literal fits.
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

	it("compiles with the path passed to '::map'", () => {
		expect(
			compiles(`implementation {
		type Product = { price: Integer }

		constant products: List<Product> = [{ price = 1 }]
		constant prices = products::map(.price)
	}`),
		).toBe(true)
	})

	it("compiles with the members read off a value", () => {
		expect(
			compiles(`implementation {
		type Product = { price: Integer }

		function priceOf(_ product: Product) -> Integer {
			<- product.price
		}
	}`),
		).toBe(true)
	})
})

describe("A member path off a Type Parameter", () => {
	let undecided = `implementation {
		function apply<infer T>(_ by: (_ item: T) -> Integer) -> Integer {
			<- 1
		}

		constant applied = apply(.price)
	}`

	it("writes the literal a path the call decides nothing for stands for", () => {
		expect(codesOfSource(undecided)).toEqual(["path-without-context"])
		expect(helpsOfCode(undecided, "path-without-context")).toEqual([
			"Write the Function literal instead, with the Parameter and return Types a path leaves out — '(_ item: <Type>) -> <Type> { <- item.price }', filling each '<Type>' in.",
		])
		expect(
			compiles(
				undecided.replace(
					"apply(.price)",
					"apply((_ item: { price: Integer }) -> Integer { <- item.price })",
				),
			),
		).toBe(true)
	})

	// The literal decides `T` where `5` did not, so what is left is the
	// Argument that bound nothing.
	it("leaves the call's own mismatch once the literal is written", () => {
		let followed = `implementation {
		function free<infer T>(_ items: List<T>, _ by: (_ item: T) -> Integer) -> Integer {
			<- items::length()
		}

		constant freed = free(5, (_ item: { price: Integer }) -> Integer { <- item.price })
	}`

		expect(codesOfSource(followed)).toEqual(["argument-type-mismatch"])
	})

	let written = `implementation {
		function total<infer T is Printable>(_ items: List<T>) -> Integer {
			constant priceOf: (_ item: T) -> Integer = .price
			<- items::length()
		}
	}`

	it("names a Type with the member in place of a declared one", () => {
		expect(codesOfSource(written)).toEqual(["path-step-not-a-record"])
		expect(helpsOfCode(written, "path-step-not-a-record")).toEqual([
			"Name a Type with the member in place of 'T' — '{ price: <Type> }', filling the '<Type>' in.",
		])
		expect(
			compiles(
				written.replace("(_ item: T)", "(_ item: { price: Integer })"),
			),
		).toBe(true)
	})
})

describe("A Method that can not be dispatched", () => {
	let source = `implementation {
		function describe<infer First is Printable, infer Second is Printable>(_ value: First | Second) -> String {
			<- value::toString()
		}
	}`

	// Types erase before a Match runs, so a Match narrows nothing over a Union
	// of Type Parameters. Offering one would lead into `erased-case-conflict`.
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
	// `Answer` belongs to `loop` and is written in the step's answer Type, so
	// it has a place among the Parameters already. The literal's `-> Type` is
	// what is missing.
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

	// `B` appears only in the callee's answer Type, not in the literal's, so
	// the literal's `-> Type` would not bind it.
	it("keeps the general pair for a name the literal does not answer", () => {
		let elsewhere = `implementation {
		function make<infer A, infer B>(_ step: (_ n: Integer) -> A) -> Dictionary<String, B> {
			<- [=]
		}

		constant made = make((n) { <- n })
	}`

		expect(helpsOfCode(elsewhere, "uninferable-type-parameter")).toEqual([
			"Give the Type Parameter a place among the Parameters, so that an Argument binds it.",
			"Or write the value itself, with the Type it answers written out — 'constant value: Dictionary<String, …> = [=]', with the Type you mean in place of each '…'.",
		])
	})

	// A Type Parameter named only in the answer Type cannot be bound by any
	// call, so both general Helps apply.
	it("keeps the general pair for a signature no Argument binds", () => {
		let unbindable = `implementation {
		function blank<infer Item>() -> List<Item> {
			<- []
		}

		constant items = blank()
	}`

		expect(helpsOfCode(unbindable, "uninferable-type-parameter")).toEqual([
			"Give the Type Parameter a place among the Parameters, so that an Argument binds it.",
			"Or write the value itself, with the Type it answers written out — 'constant value: List<…> = []', with the Type you mean in place of each '…'.",
		])
	})

	// The value is spelled from what the call answers. An Optional is told of
	// an Optional, and a bare Type Parameter has no empty Literal to offer.
	it("spells the value from what the call answers", () => {
		let answering = (answer: string, body: string) => `implementation {
		function nothing<infer Item>() -> ${answer} {
			<- ${body}
		}

		constant found = nothing()
	}`

		expect(
			helpsOfCode(
				answering("Optional<Item>", "#Empty"),
				"uninferable-type-parameter",
			),
		).toEqual([
			"Give the Type Parameter a place among the Parameters, so that an Argument binds it.",
			"Or write the value itself, with the Type it answers written out — 'constant value: Optional<…> = #Empty', with the Type you mean in place of each '…'.",
		])
		expect(
			compiles(`implementation {
		constant found: Optional<Integer> = #Empty
	}`),
		).toBe(true)
		expect(
			helpsOfCode(
				answering("Item", "nothing()"),
				"uninferable-type-parameter",
			),
		).toEqual([
			"Give the Type Parameter a place among the Parameters, so that an Argument binds it.",
		])
	})

	it("compiles either way the general pair is followed", () => {
		expect(
			compiles(`implementation {
		function blank<infer Item>(_ sample: List<Item>) -> List<Item> {
			<- []
		}

		constant items = blank([1])
	}`),
		).toBe(true)
		expect(
			compiles(`implementation {
		constant items: List<Integer> = []
	}`),
		).toBe(true)
	})
})

describe("A return Type nothing could read off the body", () => {
	let source = `implementation {
		constant doubled = [1, 2]::map((number) {
			number::multiply(with 2)
		})
	}`

	// A forgotten `<-` is the usual cause. An annotation of the value's Type
	// would only move the report to `missing-return`, so the second Help names
	// the one annotation such a body fits.
	it("names the missing '<-' first", () => {
		expect(helpsOfCode(source, "uninferable-return-type")).toEqual([
			"Return the value with '<-' — a body whose last line is a value answers with nothing.",
			"Or, where the body is meant to answer nothing, write '-> {}' after its Parameter list.",
		])
	})

	it("compiles once the body is declared to answer nothing", () => {
		expect(
			compiles(source.replace("map((number) {", "map((number) -> {} {")),
		).toBe(true)
		expect(
			codesOfSource(
				source.replace("map((number) {", "map((number) -> Integer {"),
			),
		).toEqual(["missing-return"])
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

	// Where the body already returns, asking for a `<-` would not help.
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

	it("compiles once the literal writes its return Type", () => {
		expect(
			compiles(`implementation {
		function half(_ text: String) -> Result<Integer, String> {
			<- Integer.parse(text)::toResult(failingWith "not a number")::andThen((value) -> Result<Integer, String> {
				<- #Value(value)
			})
		}
	}`),
		).toBe(true)
	})
})

describe("A capture whose Type nothing has decided yet", () => {
	// The annotation keeps the reader's keyword and fills the blank where it
	// stands, with an example Type the Help says is one.
	let captured = (declaration: string, read: string, assigned = "") =>
		`implementation {
		${declaration}

		constant count = () -> Integer {
			<- ${read}
		}
		${assigned}
	}`

	it("annotates a List at its item Type", () => {
		expect(
			helpsOfCode(
				captured("variable items = []", "items::length()"),
				"uninferable-item-type",
			),
		).toEqual([
			"Annotate the declaration — 'variable items: List<Integer>', for instance — so the Function is checked against the Type it will hold.",
		])
		expect(
			compiles(
				captured(
					"variable items: List<Integer> = []",
					"items::length()",
					"items = [1, 2]",
				),
			),
		).toBe(true)
	})

	it("annotates a Dictionary at both of its Types", () => {
		expect(
			helpsOfCode(
				captured("variable ages = [=]", "ages::length()"),
				"uninferable-item-type",
			),
		).toEqual([
			"Annotate the declaration — 'variable ages: Dictionary<String, Integer>', for instance — so the Function is checked against the Types it will hold.",
		])
		expect(
			compiles(
				captured(
					"variable ages: Dictionary<String, Integer> = [=]",
					"ages::length()",
					'ages = ["a" = 1]',
				),
			),
		).toBe(true)
	})

	// The blank sits inside a Future here, so the annotation wraps it there.
	// A value read out of the capture carries the same blank, and the call on
	// it is not reported again.
	it("annotates a blank at the depth it stands", () => {
		let source = `implementation {
		constant work = Async.deferred(() { <- [] })

		constant count = () -> Future<Integer> {
			constant items = complete work

			<- items::length()
		}
	}`

		expect(codesOfSource(source)).toEqual(["uninferable-item-type"])
		expect(helpsOfCode(source, "uninferable-item-type")).toEqual([
			"Annotate the declaration — 'constant work: Future<List<Integer>>', for instance — so the Function is checked against the Type it will hold.",
		])
		expect(
			compiles(
				source.replace(
					"constant work =",
					"constant work: Future<List<Integer>> =",
				),
			),
		).toBe(true)
	})
})

describe("A Function literal outside Argument position", () => {
	// Both Types are asked for in one report, so the literal takes one round
	// trip rather than two.
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

	// A Function refused as a value has no Type to write, so the Help asks for
	// the one meant. Written, the refusal is the one report left.
	it("spells no Type for a body answering with a Function refused as a value", () => {
		let source = `implementation {
		constant pick = () { <- Integer.add }
	}`

		expect(codesOfSource(source)).toEqual([
			"missing-return-type",
			"overloaded-function-value",
		])
		expect(helpsOfCode(source, "missing-return-type")).toEqual([
			"Write the return Type after the Parameter list — '-> <Type>', naming what this body's '<-' answers with.",
		])
		expect(
			codesOfSource(`implementation {
		constant pick = () -> (_: Integer, _: Integer) -> Integer { <- Integer.add }
	}`),
		).toEqual(["overloaded-function-value"])
	})
})

describe("A Namespace specifier that names something else", () => {
	// A refused specifier must not also report that no Namespace targets the
	// value, since the call without the specifier compiles.
	it("reports once and does not deny the receiver its Namespace", () => {
		let source = `implementation {
		constant total = 1

		Terminal.print("hello"::<total>append("!"))
	}`

		expect(codesOfSource(source)).toEqual(["not-a-namespace"])
		expect(
			compiles(`implementation {
		constant total = 1

		Terminal.print("hello"::append("!"))
	}`),
		).toBe(true)
	})
})

describe("A Namespace written as a value", () => {
	function withClock(body: string): string {
		return `implementation {
		namespace Clock for Integer {
			static noon = 43_200

			static now() -> Integer {
				<- 7
			}
		}

		namespace Boxes<infer Item> for List<Item> {
			counted() -> Integer {
				<- @::length()
			}
		}

		${body}
	}`
	}

	// The Help names a static, which reads as a value off the Namespace.
	it("reads a static off a Program's own Namespace", () => {
		let source = withClock("Terminal.inspect(Clock)")

		expect(codesOfSource(source)).toEqual(["namespace-as-value"])
		expect(helpsOfCode(source, "namespace-as-value")).toEqual([
			"Read a member off it, as in 'Clock.noon'.",
		])
		expect(compiles(withClock("Terminal.inspect(Clock.noon)"))).toBe(true)
	})

	// An alias would hold a Namespace under another name, so it is refused
	// where it is declared, and its uses report nothing further.
	it("refuses a Constant that would alias a Namespace", () => {
		let source = withClock(`constant clock = Clock

		Terminal.inspect(clock.now())`)

		expect(codesOfSource(source)).toEqual(["namespace-as-value"])
		expect(
			compiles(
				withClock(`constant clock = Clock.now

		Terminal.inspect(clock())`),
			),
		).toBe(true)
	})

	// A generic Namespace's Method reads as a Function of its receiver.
	it("reads a Method off a generic Namespace", () => {
		let source = withClock("Terminal.inspect(Boxes)")

		expect(helpsOfCode(source, "namespace-as-value")).toEqual([
			"Read a member off it, as in 'Boxes.counted'.",
		])
		expect(compiles(withClock("Terminal.inspect(Boxes.counted)"))).toBe(
			true,
		)
	})

	// A standard library Namespace starts with Overload sets and Protocol-bound
	// Methods. Neither is a value, so the Help passes over them.
	it("reads a member off a builtin that is a value as read", () => {
		let source = withClock(`Terminal.inspect(List)
		Terminal.inspect(Terminal)`)

		expect(
			analysedDiagnosticsFor(source).map(
				(diagnostic) => diagnostic.helps,
			),
		).toEqual([
			["Read a member off it, as in 'List.isEmpty'."],
			["Read a member off it, as in 'Terminal.write'."],
		])
		expect(
			compiles(
				withClock(`Terminal.inspect(List.isEmpty)
		Terminal.inspect(Terminal.write)`),
			),
		).toBe(true)
	})

	it("names no member a Namespace does not declare", () => {
		expect(
			helpsOfCode(
				`implementation {
		namespace Bare for Boolean {
		}

		Terminal.inspect(Bare)
	}`,
				"namespace-as-value",
			),
		).toEqual([
			"Name a value in its place, since 'Bare' declares no member to read.",
		])
	})

	// A Lookup, a call and a Namespace specifier name the Namespace without
	// reading it as a value.
	it("accepts what reads off a Namespace", () => {
		expect(
			compiles(
				withClock(`constant now = Clock.now

		Terminal.inspect(Clock.noon)
		Terminal.inspect(Clock.now())
		Terminal.inspect(now())
		Terminal.inspect([1]::<Boxes>counted())`),
			),
		).toBe(true)
	})
})

describe("A 'where' clause on a base that can not carry one", () => {
	let source = `implementation {
		type Yes = Boolean where @::is(true)
	}`

	// Dropping the clause compiles but changes the Declaration to any Boolean,
	// so the Help says so and names the bases a refinement can stand on.
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
	// A payload that already writes the Record took no shorthand, so the
	// shorthand sentence is withheld.
	it("withholds the shorthand sentence", () => {
		let source = `implementation {
		choice Shape {
			Rectangle { width: Integer, height: Integer },
		}

		constant shape: Shape = Shape#Rectangle({ width = "wide", height = 2 })
	}`

		expect(helpsOfCode(source, "payload-type-mismatch")).toEqual([])
	})

	// A payload that leaves a defaulted member out wrote its Record too, and
	// so does one that carries a member the Case does not declare. That member
	// is what the Help removes.
	it("withholds the shorthand sentence from a partial payload", () => {
		let source = `implementation {
		choice Call {
			Post { server: String, body: String } = { server = "localhost" },
		}

		constant call = Call#Post({ body = "x", draft = true })
	}`

		expect(helpsOfCode(source, "payload-type-mismatch")).toEqual([
			"Remove 'draft'.",
		])
	})

	// A value handed over on its own is the shape the sentence is for.
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

	// `complete` in a body that answers no Future is `complete-outside-future`,
	// so neither the Help nor its Quick Fix offers it there.
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

	// The same rule for a Declaration.
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

	// Reaching through would answer another Future, which no Condition takes,
	// so a Condition is told only the two steps that wait.
	it("names the two steps a Condition in a body that can not wait takes", () => {
		let checked = (answer: string, condition: string) => `implementation {
	function ready() -> Future<Boolean> {
		complete Async.sleep(milliseconds 1)

		<- true
	}

	function shown() -> ${answer} {
		if ${condition} {
			<- 1
		}

		<- 0
	}
}`

		expect(
			helpsOfCode(checked("Integer", "ready()"), "condition-not-boolean"),
		).toEqual([
			"Declare the enclosing Function '-> Future<…>', which is what lets its body wait, then add 'complete'.",
		])
		expect(compiles(checked("Future<Integer>", "complete ready()"))).toBe(
			true,
		)
	})
})

describe("One mistake, one report", () => {
	// A literal whose return Type cannot be read is reported once, not again
	// for the unbound Type Parameter and each Case in its body. The independent
	// warning shows the spec is not about silence.
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

	// A capture refused before its Type is decided also answers for the call
	// on it, so `ItemType` is not reported again.
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

	it("reports a call on a value once", () => {
		expect(
			codesOfSource(`implementation {
		constant total = 1

		Terminal.print(total())
	}`),
		).toEqual(["not-a-function"])
	})

	// A body refused in its own right answers for the literal around it, so the
	// reports about its unreadable Types stand down.
	it("reports a refused body once, not three times", () => {
		expect(
			codesOfSource(`implementation {
		constant words = ["a", "bb"]

		constant lengths = words::map((w) { <- w.length })
	}`),
		).toEqual(["method-called-with-dot"])
	})

	// A bare Case in return position is refused only because no return Type is
	// known yet. That is no refused body, so the return Type is still reported.
	it("still reports a return Type it could not read off a bare Case", () => {
		expect(
			codesOfSource(`implementation {
		function half(_ text: String) -> Result<Integer, String> {
			<- Integer.parse(text)::toResult(failingWith "not a number")::andThen((value) {
				<- #Value(value)
			})
		}
	}`),
		).toEqual(["uninferable-return-type"])
	})
})

describe("Reports that knew the fix and said nothing", () => {
	// Each report knows the edit from the value's Type, the Type's arity or the
	// declared return Type, so its Help names it.
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
			compiles(`implementation {
		constant found: Optional<Integer> = #Value(1)

		if found::hasValue() {
			Terminal.print("yes")
		}
	}`),
		).toBe(true)
	})

	// A Function has no `::is`, so the question is asked of what it answers.
	// One that answers a Boolean is the Condition once called.
	it("names the call a Function in a Condition is missing", () => {
		let checked = (
			declaration: string,
			condition: string,
		) => `implementation {
		${declaration}

		if ${condition} {
			Terminal.print("yes")
		}
	}`
		let ready = "function ready() -> Boolean {\n\t\t\t<- true\n\t\t}"
		let count = "constant count = (_ step: Integer) -> Integer { <- step }"

		expect(
			helpsOfCode(checked(ready, "ready"), "condition-not-boolean"),
		).toEqual(["Call it — 'ready()' answers a Boolean."])
		expect(compiles(checked(ready, "ready()"))).toBe(true)

		expect(
			helpsOfCode(checked(count, "count"), "condition-not-boolean"),
		).toEqual([
			"Call it, and ask a question of what it answers — 'count(…)::isGreaterThan(0)' reads an Integer.",
		])
		expect(compiles(checked(count, "count(1)::isGreaterThan(0)"))).toBe(
			true,
		)
	})

	// A Future answers once waited for. `complete` takes the whole chain
	// behind it, so the value is waited for on a line of its own.
	it("waits for a Future before asking what it answers", () => {
		let checked = (statements: string) => `implementation {
		function fetched() -> Future<Integer> {
			complete Async.sleep(milliseconds 1)

			<- 41
		}

		${statements}
	}`

		expect(
			helpsOfCode(
				checked('if fetched() {\n\t\t\tTerminal.print("yes")\n\t\t}'),
				"condition-not-boolean",
			),
		).toEqual([
			"Wait for it on a line of its own — 'constant answered = complete …' — and ask 'answered::isGreaterThan(0)'.",
		])
		expect(
			compiles(
				checked(
					'constant answered = complete fetched()\n\n\t\tif answered::isGreaterThan(0) {\n\t\t\tTerminal.print("yes")\n\t\t}',
				),
			),
		).toBe(true)
	})

	// An unbounded Type Parameter answers no Method, so no question is
	// offered. Bounded by `Equatable` it answers `::is`.
	it("asks a Type Parameter only what its bound answers", () => {
		let checked = (bound: string, condition: string) => `implementation {
		function counted<infer Item${bound}>(_ item: Item) -> Integer {
			if ${condition} {
				<- 1
			}

			<- 0
		}
	}`

		expect(
			helpsOfCode(checked("", "item"), "condition-not-boolean"),
		).toEqual([])
		expect(
			helpsOfCode(
				checked(" is Equatable", "item"),
				"condition-not-boolean",
			),
		).toEqual([
			"Ask a question that answers a Boolean — '::is(…)' reads an Item.",
		])
		expect(compiles(checked(" is Equatable", "item::is(item)"))).toBe(true)
	})

	// No one question fits every member of a Union of different Types, so
	// each member is asked its own in a Match.
	it("asks each member of a Union its own question", () => {
		let checked = (condition: string) => `implementation {
		constant value: Integer | String = 1

		if ${condition} {
			Terminal.print("yes")
		}
	}`

		expect(helpsOfCode(checked("value"), "condition-not-boolean")).toEqual([
			"Ask each member its own question in a Match that answers a Boolean — 'match value -> Boolean { case Integer { <- @::isGreaterThan(0) } case String { <- @::hasCharacters() } }'.",
		])
		expect(
			compiles(
				checked(
					"match value -> Boolean { case Integer { <- @::isGreaterThan(0) } case String { <- @::hasCharacters() } }",
				),
			),
		).toBe(true)
	})

	// Each answer is asked through one question a value of its Type takes. A
	// Union of different Types takes none, nor does a Record holding a
	// Function, so nothing that would not compile is offered.
	it("offers nothing where no one question fits what is answered", () => {
		let condition = (
			declarations: string,
			value: string,
		) => `implementation {
		${declarations}

		if ${value} {
			Terminal.print("yes")
		}
	}`

		for (let source of [
			condition(
				"function check() -> Integer | String {\n\t\t\t<- 1\n\t\t}",
				"check",
			),
			condition(
				"function fetched() -> Future<Integer | String> {\n\t\t\tcomplete Async.sleep(milliseconds 1)\n\n\t\t\t<- 1\n\t\t}",
				"fetched()",
			),
			condition(
				"constant value: List<Integer> | List<String> = [1]",
				"value",
			),
			condition(
				"function make() -> Integer {\n\t\t\t<- 1\n\t\t}\n\n\t\tconstant value: Integer | { run: () -> Integer } = { run = make }",
				"value",
			),
		]) {
			expect(codesOfSource(source)).toEqual(["condition-not-boolean"])
			expect(helpsOfCode(source, "condition-not-boolean")).toEqual([])
		}
	})

	// A static Method and a member holding a Function are called by the name
	// the Condition wrote.
	it("calls a Function the Condition reads off a Namespace or a Record", () => {
		let condition = (value: string) => `implementation {
		namespace Checks for Integer {
			static ready() -> Boolean {
				<- true
			}
		}

		function yes() -> Boolean {
			<- true
		}

		constant checks = { ready = yes }

		if ${value} {
			Terminal.print("yes")
		}
	}`

		for (let value of ["Checks.ready", "checks.ready"]) {
			expect(
				helpsOfCode(condition(value), "condition-not-boolean"),
			).toEqual([`Call it — '${value}()' answers a Boolean.`])
			expect(compiles(condition(`${value}()`))).toBe(true)
		}
	})

	it("names the question a String answers in a 'define'", () => {
		let arms = (condition: string) => `implementation {
		constant name = "Ada"
		constant label = define {
			as "named" if ${condition}
			as "anonymous" otherwise
		}
	}`

		expect(helpsOfCode(arms("name"), "condition-not-boolean")).toEqual([
			"Ask a question that answers a Boolean — '::hasCharacters()' reads a String.",
		])
		expect(compiles(arms("name::hasCharacters()"))).toBe(true)
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
		expect(
			compiles(`implementation {
		constant total = 1

		Terminal.print(total)
		Terminal.print(total::add(1))
	}`),
		).toBe(true)
	})

	// A Namespace is never called, and without the `()` it is a Namespace read
	// as a value. Each Help builds a value of the Namespace's target instead.
	it("builds the value a call on a Namespace meant", () => {
		let called = (call: string, annotation = "") => `implementation {
		namespace Points for { x: Integer, y: Integer } {
			static atX(_ x: Integer) -> { x: Integer, y: Integer } {
				<- { x = x, y = 0 }
			}

			static count(_ x: Integer) -> Integer {
				<- x
			}
		}

		constant count = 3
		constant built${annotation} = ${call}

		Terminal.inspect(built)
	}`

		// Each row: the call, the Type it is annotated with, the Help, and the
		// Help followed.
		for (let [call, annotation, help, followed] of [
			[
				"String(5)",
				": String",
				"Convert the value with '::toString()', as '5::toString()'.",
				"5::toString()",
			],
			[
				"String(count)",
				"",
				"Convert the value with '::toString()', as 'count::toString()'.",
				"count::toString()",
			],
			[
				"Integer(5)",
				": Integer",
				"Write '5' alone, since it is a value of Type Integer already.",
				"5",
			],
			// A static that answers the target wrapped is offered only where
			// the position takes what it answers.
			[
				'Integer("5")',
				"",
				`Call its static Method with the same Arguments, as 'Integer.parse("5")', which answers an Optional<Integer>.`,
				'Integer.parse("5")',
			],
			[
				'Integer("5")',
				": Integer",
				"Write a value of Type Integer in its place.",
				"5",
			],
			// `count` answers no Point, so only `atX` is offered.
			[
				"Points(1)",
				"",
				"Call its static Method with the same Arguments, as 'Points.atX(1)'.",
				"Points.atX(1)",
			],
			[
				"Rational(1)",
				": Rational",
				"Convert the value with '::toRational()', as '1::toRational()'.",
				"1::toRational()",
			],
			[
				"List(1, 2)",
				": List<Integer>",
				"Write the items in a List Literal, as '[1, 2]'.",
				"[1, 2]",
			],
			[
				"Boolean(1)",
				": Boolean",
				"Write a value of Type Boolean in its place.",
				"true",
			],
			[
				"Terminal(1)",
				"",
				"Read one of its members, as in 'Terminal.…'.",
				"Terminal.inspect(1)",
			],
		]) {
			expect(
				helpsOfCode(called(call, annotation), "not-a-function"),
			).toEqual([help])
			expect(compiles(called(followed, annotation))).toBe(true)
		}
	})

	it("names both readings of a '<-' at the top level", () => {
		let source = `implementation {
		<- 42
	}`

		expect(helpsOfCode(source, "top-level-return")).toEqual([
			"Drop the '<-' and write the value on its own, or as a 'constant'.",
			"Or move the Statement into a Function, which is the only thing a '<-' answers for.",
		])

		for (let followed of [
			"42",
			"constant answer = 42",
			"function answer() -> Integer {\n\t\t\t<- 42\n\t\t}",
		]) {
			expect(compiles(`implementation {\n\t\t${followed}\n\t}`)).toBe(
				true,
			)
		}
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

		// A predicate is one call on '@', so the Help asks a question of '@'
		// rather than chaining onto `@::absolute()`.
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
			compiles(`implementation {
		function sign(of number: Integer) -> String {
			if number::isGreaterThan(0) {
				<- "positive"
			}

			<- "other"
		}
	}`),
		).toBe(true)
	})

	// An unbounded Type Parameter reaches no Namespace. The Help names the
	// Protocol that declares the Method.
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

// Only a Type may not be named `Self`. A Constant, a Function, a Case or a
// member called `Self` compiles, so the Note says the name is reserved for
// Types alone.
describe("The name a Protocol reserves", () => {
	it("says which declarations the name is taken for", () => {
		expect(
			firstAnalysed(
				`implementation {
		type Self = { name: String }
	}`,
				"reserved-type-name",
			).notes,
		).toEqual([
			"'Self' is what a Protocol calls the Type conforming to it, so no Type may be declared under it.",
		])
	})

	it("leaves a value of the name alone", () => {
		expect(
			compiles(`implementation {
		constant Self = 1

		function twice(_ Self: Integer) -> Integer {
			<- Self::multiply(with 2)
		}

		Terminal.inspect(twice(Self)::toString())
	}`),
		).toBe(true)
	})
})
