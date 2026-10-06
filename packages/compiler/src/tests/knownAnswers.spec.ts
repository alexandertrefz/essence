import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { enrich } from "../enricher/index"
import { parse } from "../parser/index"
import { compiles, firstOf } from "./followedHelps"

// Reports that know the answer rather than guessing by edit distance. A Method
// the receiver lacks may be a Method of what it holds. A Case no Choice in scope
// declares may be written where a Choice is expected. An undeclared bare name
// may be a static of the Namespace it is written inside.
//
// Every Help printed here is compiled, in `compiles`, since a Help promises
// that what it prints works when followed. The helpers live in
// `./followedHelps`, which other specs share.

const future = [
	"	function fetched() -> Future<Integer> {",
	"		complete Async.sleep(milliseconds 1)",
	"",
	"		<- 41",
	"	}",
].join("\n")

describe("A Method of what the value holds", () => {
	describe("a List", () => {
		let source = `implementation {
			constant primes = [2, 3, 5]
			constant first = primes

			Terminal.print(first::add(1)::toString())
		}`

		it("should name the item Type rather than a near miss", () => {
			let diagnostic = firstOf(source, "unknown-method")

			expect(diagnostic.notes[0]).toBe(
				"'add' is a Method of Integer, which is what a List<Integer> holds — a Method of its items rather than of the List itself.",
			)
			expect(diagnostic.helps).toEqual([
				"Call '::add(…)' on each item — '::map((item) { <- item::add(…) })'.",
				"Or read one out with '::item(at …, defaultingTo …)' and call '::add(…)' on it.",
			])
		})

		it("should offer no near miss and no Quick Fix payload", () => {
			let diagnostic = firstOf(source, "unknown-method")

			expect(
				diagnostic.helps.some((help) =>
					help.startsWith("Did you mean"),
				),
			).toBe(false)
			expect(diagnostic.data).toBeUndefined()
		})

		it("should print Helps that compile", () => {
			expect(
				compiles(`implementation {
					constant primes = [2, 3, 5]
					constant first = primes

					Terminal.print(first::map((item) { <- item::add(1) })::toString())
					Terminal.print(first::item(at 0, defaultingTo 0)::add(1)::toString())
				}`),
			).toBe(true)
		})

		// The proof changes which Method reads an item outright, since
		// `List::firstItem()` answers an Optional. So the Help is read off the
		// receiver.
		it("should offer the proven List its own reading Method", () => {
			let diagnostic = firstOf(
				`implementation {
					constant proven: NonEmptyList<Integer> = [1, 2]

					Terminal.print(proven::add(1)::toString())
				}`,
				"unknown-method",
			)

			expect(diagnostic.helps[1]).toBe(
				"Or read one out with '::firstItem()' and call '::add(…)' on it.",
			)
		})

		// A List of Lists holds a List, and `add` is a Method of neither.
		it("should say nothing where the item Type has not got the Method", () => {
			let diagnostic = firstOf(
				`implementation {
					constant nested = [[1], [2]]

					Terminal.print(nested::add(1)::toString())
				}`,
				"unknown-method",
			)

			expect(diagnostic.helps).toEqual([])
			expect(diagnostic.notes).toEqual([
				"Searched Namespaces 'List', 'NestedList', 'KeyedNumberList', 'GroupedList'.",
			])
		})
	})

	describe("a Dictionary", () => {
		it("should name the value Type and offer the reading Method", () => {
			let diagnostic = firstOf(
				`implementation {
					constant lookup = ["k" = 1]

					Terminal.print(lookup::add(1)::toString())
				}`,
				"unknown-method",
			)

			expect(diagnostic.notes[0]).toBe(
				"'add' is a Method of Integer, which is what a Dictionary<String, Integer> holds — a Method of its values rather than of the Dictionary itself.",
			)
			// No `::map` Help, since `Dictionary::map` hands its transform a
			// whole `{ key, value }` entry rather than the value.
			expect(diagnostic.helps).toEqual([
				"Read one out with '::value(at …, defaultingTo …)' and call '::add(…)' on it.",
			])
		})

		it("should print a Help that compiles", () => {
			expect(
				compiles(`implementation {
					constant lookup = ["k" = 1]

					Terminal.print(lookup::value(at "k", defaultingTo 0)::add(1)::toString())
				}`),
			).toBe(true)
		})
	})

	describe("a Case's payload", () => {
		let source = `implementation {
			constant numbers = [3, 4]

			Terminal.print(numbers::firstItem()::add(1)::toString())
		}`

		it("should name the Case that carries the value", () => {
			let diagnostic = firstOf(source, "unknown-method")

			expect(diagnostic.notes[0]).toBe(
				"'add' is a Method of Integer, and 'Optional<Integer>#Value' carries one.",
			)
			expect(diagnostic.helps).toEqual([
				"Read the value out with '::value(defaultingTo …)' and call '::add(…)' on it, or reach through it with '::map((value) { <- value::add(…) })'.",
				"Or take it apart with a 'match', and call '::add(…)' on the payload.",
			])
		})

		it("should answer a Result the same way", () => {
			let diagnostic = firstOf(
				`implementation {
					function parsed() -> Result<Integer, String> { <- #Value(1) }

					Terminal.print(parsed()::add(1)::toString())
				}`,
				"unknown-method",
			)

			expect(diagnostic.notes[0]).toBe(
				"'add' is a Method of Integer, and 'Result<Integer, String>#Value' carries one.",
			)
		})

		// A Program's Choice has no reading Method and no `map`, so the `match`
		// Help stands first and does not open on "Or".
		it("should open the match Help on 'Or' only where one precedes it", () => {
			let diagnostic = firstOf(
				`implementation {
					choice Holder {
						Numbered { count: Integer },
						Titled { title: String },
					}

					constant held: Holder = #Numbered(3)

					Terminal.inspect(held::add(1))
				}`,
				"unknown-method",
			)

			expect(diagnostic.helps).toEqual([
				"Take it apart with a 'match', and call '::add(…)' on the payload.",
			])
		})

		it("should print Helps that compile", () => {
			expect(
				compiles(`implementation {
					constant numbers = [3, 4]

					Terminal.print(numbers::firstItem()::value(defaultingTo 0)::add(1)::toString())
					Terminal.print(numbers::firstItem()::map((value) { <- value::add(1) })::toString())

					match numbers::firstItem() -> {} {
						case #Value(item) {
							Terminal.print(item::add(1)::toString())

							<- {}
						}
						case _ { <- {} }
					}
				}`),
			).toBe(true)
		})
	})

	describe("a Union whose members disagree", () => {
		it("should say which members answer the name and which do not", () => {
			let diagnostic = firstOf(
				`implementation {
					function pick(_ flag: Boolean) -> Integer | String {
						if flag { <- 1 } else { <- "one" }
					}

					Terminal.print(pick(true)::uppercase())
				}`,
				"unknown-method",
			)

			expect(diagnostic.notes).toEqual([
				"Every member of the Union must provide 'uppercase' — the receiver's Type is only known at runtime.",
				"'uppercase' answers for String, and not for Integer.",
			])
		})

		// A Namespace for another application answers none of the Cases, as
		// the dispatch reads them.
		it("should not count a Namespace for another application", () => {
			let diagnostic = firstOf(
				`implementation {
					choice Tag<Item> {
						On,
						Off,
					}

					namespace Lists for Tag<List<Integer>> {
						describe() -> String {
							<- "list tag"
						}
					}

					namespace Flags for Boolean {
						describe() -> String {
							<- "flag"
						}
					}

					function show(_ value: Tag<Integer> | Boolean) -> String {
						<- value::describe()
					}
				}`,
				"unknown-method",
			)

			expect(diagnostic.notes).toContain(
				"'describe' answers for Boolean, and not for Tag<Integer>#On and Tag<Integer>#Off.",
			)
		})
	})

	describe("a Future", () => {
		let source = `implementation {
${future}

			Terminal.print(fetched()::add(1)::toString())
		}`

		it("should say the work has not run and where the word goes", () => {
			let diagnostic = firstOf(source, "unknown-method")

			expect(diagnostic.notes.slice(0, 2)).toEqual([
				"'add' is a Method of Integer. This describes work that has not run — the Integer is what a Future<Integer> answers with, once something waits for it.",
				"'complete' takes the whole chain behind it, so a 'complete' written in front of this call would wait for the call rather than for the receiver.",
			])
			expect(diagnostic.helps).toEqual([
				"Wait for it on a line of its own — 'constant answered = complete …' — and call '::add(…)' on 'answered'.",
				"Or reach through it with '::map((value) { <- value::add(…) })', which answers another Future.",
			])
		})

		it("should print Helps that compile", () => {
			expect(
				compiles(`implementation {
${future}

					constant answered = complete fetched()
					constant mapped   = complete fetched()::map((value) { <- value::add(1) })

					Terminal.print(answered::add(1)::toString())
					Terminal.print(mapped::toString())
				}`),
			).toBe(true)
		})

		// Only a body that answers a Future can write `complete`.
		it("should withhold the wait where nothing here can wait", () => {
			let diagnostic = firstOf(
				`implementation {
${future}

					function plain() -> Integer {
						<- fetched()::add(1)
					}

					Terminal.print(plain()::toString())
				}`,
				"unknown-method",
			)

			expect(diagnostic.notes[1]).toBe(
				"'complete' only stands in a body that answers a Future, and this position is not one.",
			)
			expect(diagnostic.helps).toEqual([
				"Reach through it with '::map((value) { <- value::add(…) })', which answers another Future.",
				"Or declare the enclosing Function '-> Future<…>', which is what lets its body wait.",
			])
		})

		it("should say a Started is in flight rather than undescribed", () => {
			let diagnostic = firstOf(
				`implementation {
${future}

					constant run = start fetched()

					Terminal.print(run::add(1)::toString())
				}`,
				"unknown-method",
			)

			expect(diagnostic.notes[0]).toBe(
				"'add' is a Method of Integer. This is still in flight — the Integer is what a Started<Integer> answers with, once something waits for it.",
			)
			expect(diagnostic.helps[1]).toBe(
				"Or reach through it with '::map((value) { <- value::add(…) })', which answers another Started.",
			)
		})
	})

	// A forgotten `complete` in a String's hole gets the sentences every other
	// report about a missing `complete` prints.
	describe("a Future in a String's hole", () => {
		it("should name the word and what the work answers with", () => {
			let diagnostic = firstOf(
				`implementation {
${future}

					Terminal.print("got {fetched()}")
				}`,
				"interpolation-not-printable",
			)

			expect(diagnostic.notes).toEqual([
				"Future<Integer> does not conform to 'Printable'.",
				"Integer is what a Future<Integer> answers with, once something waits for it.",
			])
			expect(diagnostic.helps).toEqual([
				"This describes work that has not run — add 'complete'.",
			])
			expect(diagnostic.data).toEqual({
				kind: "asynchrony-mismatch",
				mismatch: "unstarted",
			})
		})

		it("should say a Started is in flight", () => {
			let diagnostic = firstOf(
				`implementation {
${future}

					constant run = start fetched()

					Terminal.print("got {run}")
				}`,
				"interpolation-not-printable",
			)

			expect(diagnostic.helps).toEqual([
				"This is still in flight — add 'complete' to wait for what it answers with.",
			])
		})

		it("should withhold the word where nothing here can wait", () => {
			let diagnostic = firstOf(
				`implementation {
${future}

					function shown(_ work: Future<Integer>) -> String {
						<- "got {work}"
					}

					Terminal.print(shown(fetched()))
				}`,
				"interpolation-not-printable",
			)

			expect(diagnostic.notes[2]).toBe(
				"'complete' only stands in a body that answers a Future, and this position is not one.",
			)
			// A body declared `-> Future<…>` still holds an uncompleted hole,
			// so the Help names both edits.
			expect(diagnostic.helps).toEqual([
				"Declare the enclosing Function '-> Future<…>', which is what lets its body wait, and add 'complete' where the value is read.",
			])
			expect(diagnostic.data).toBeUndefined()
		})

		it("should leave an unprintable hole that waits for nothing alone", () => {
			let diagnostic = firstOf(
				`implementation {
					constant greet = (subject: String) -> String { <- subject }

					Terminal.print("greeting: {greet}")
				}`,
				"interpolation-not-printable",
			)

			expect(diagnostic.helps).toEqual([
				"Interpolate only Printable values; match an Optional or a Union apart first and interpolate each Case.",
			])
		})

		it("should print Helps that compile", () => {
			expect(
				compiles(`implementation {
${future}

					function shown(_ work: Future<Integer>) -> Future<String> {
						<- "got {complete work}"
					}

					constant run = start fetched()

					Terminal.print("got {complete fetched()}")
					Terminal.print("got {complete run}")
					Terminal.print(complete shown(fetched()))
				}`),
			).toBe(true)
		})
	})

	// The evidence comes from the lookup that decides a call, so a Program's
	// own Namespace counts as the standard library's does.
	describe("a Namespace the Program wrote", () => {
		it("should find a Method a user Namespace declares for the item", () => {
			let diagnostic = firstOf(
				`implementation {
					namespace Doubling for Integer {
						doubled() -> Integer { <- @::multiply(with 2) }
					}

					constant primes = [2, 3, 5]

					Terminal.print(primes::doubled()::toString())
				}`,
				"unknown-method",
			)

			expect(diagnostic.notes[0]).toBe(
				"'doubled' is a Method of Integer, which is what a List<Integer> holds — a Method of its items rather than of the List itself.",
			)
		})
	})
})

describe("A near miss that could not have been this call", () => {
	// `index` is one edit from `indx` but takes a label this call did not
	// write. So it can not be the Method meant, and its Quick Fix would fail.
	it("should prefer a candidate the written Arguments could pair with", () => {
		let diagnostic = firstOf(
			`implementation {
				constant primes = [2, 3, 5]

				Terminal.print(primes::indx()::toString())
			}`,
			"unknown-method",
		)

		expect(diagnostic.helps).toEqual([])
		expect(diagnostic.data).toBeUndefined()
	})

	// A name the call's own shape fits is still offered.
	it("should keep a candidate the written Arguments do pair with", () => {
		let diagnostic = firstOf(
			`implementation {
				constant primes = [2, 3, 5]

				Terminal.print(primes::lenght()::toString())
			}`,
			"unknown-method",
		)

		expect(diagnostic.helps).toEqual(["Did you mean 'length'?"])
		expect(
			compiles(`implementation {
				constant primes = [2, 3, 5]

				Terminal.print(primes::length()::toString())
			}`),
		).toBe(true)
	})

	// Nothing fitting `(of …)` is near `lenght`. A call that wrote a label
	// then hears of any declared name one edit away.
	it("should name the Method where the label is wrong as well", () => {
		let diagnostic = firstOf(
			`implementation {
				constant primes = [2, 3, 5]

				Terminal.print(primes::lenght(of 1)::toString())
			}`,
			"unknown-method",
		)

		expect(diagnostic.helps).toEqual(["Did you mean 'length'?"])
	})

	it("should answer a String receiver the same way", () => {
		let diagnostic = firstOf(
			`implementation {
				constant word = "abc"

				Terminal.print(word::lenght(of 1)::toString())
			}`,
			"unknown-method",
		)

		expect(diagnostic.helps).toEqual(["Did you mean 'length'?"])
	})

	// `indexOf` writes no label and is two edits from `index(on:)`, so no
	// name answers it.
	it("should stay silent for a name that is two edits from a Method", () => {
		let diagnostic = firstOf(
			`implementation {
				constant primes = [2, 3, 5]

				Terminal.print(primes::indexOf(2)::toString())
			}`,
			"unknown-method",
		)

		expect(diagnostic.helps).toEqual([])
		expect(diagnostic.data).toBeUndefined()
	})
})

describe("An Argument that describes work", () => {
	// The Validator says this on `argument-type-mismatch`. A call that picked
	// no Overload never reaches the Validator, so it is said here too.
	it("should name the missing word on a refused Overload", () => {
		let diagnostic = firstOf(
			`implementation {
${future}

				namespace Shown for Integer {
					overload show {
						(_ count: Integer) -> {} { <- {} }
						(twice flag: Boolean) -> {} { <- {} }
					}
				}

				1::show(fetched())
			}`,
			"no-matching-overload",
		)

		expect(diagnostic.helps).toEqual([
			"This describes work that has not run — add 'complete'.",
		])
		expect(diagnostic.data).toEqual({
			kind: "asynchrony-mismatch",
			mismatch: "unstarted",
		})
	})
})

describe("A Case the position decides", () => {
	// The standard library's flags are bare Cases passed at a Parameter, so
	// this report is how a reader discovers what `round(toward:)` takes.
	it("should name the Choice the Parameter takes and list its Cases", () => {
		let diagnostic = firstOf(
			`implementation {
				Terminal.print(7/2::round(toward #Floor)::toString())
			}`,
			"unknown-case",
		)

		expect(diagnostic.message).toBe("'Rounding' declares no Case '#Floor'")
		expect(diagnostic.notes).toEqual([
			"This position takes a Rounding: '#Nearest', '#NearestEven', '#Down', '#Up', '#TowardZero'.",
		])
	})

	it("should draw the near miss from that Choice's own Cases", () => {
		let diagnostic = firstOf(
			`implementation {
				Terminal.print(7/2::round(toward #Doun)::toString())
			}`,
			"unknown-case",
		)

		expect(diagnostic.helps).toEqual(["Did you mean '#Down'?"])
		expect(diagnostic.data).toEqual({
			kind: "suggestion",
			suggestion: "Down",
		})
		expect(
			compiles(`implementation {
				Terminal.print(7/2::round(toward #Down)::toString())
			}`),
		).toBe(true)
	})

	// An editor enriches one parse tree over and over. The expectation is
	// recorded on the name Node, which outlives every pass, so the recording
	// is deduplicated and the report does not grow.
	it("should answer the same way on every enrichment of one parse tree", () => {
		let parsed = parse(`implementation {
			Terminal.print(7/2::round(toward #Floor)::toString())
		}`)
		let passes = [0, 1, 2].map(
			() =>
				enrich(parsed).diagnostics.find(
					(diagnostic) => diagnostic.code === "unknown-case",
				)?.notes,
		)

		expect(passes[0]).toEqual([
			"This position takes a Rounding: '#Nearest', '#NearestEven', '#Down', '#Up', '#TowardZero'.",
		])
		expect(passes[1]).toEqual(passes[0] as Array<string>)
		expect(passes[2]).toEqual(passes[0] as Array<string>)
	})

	it("should answer an annotation the same way", () => {
		let diagnostic = firstOf(
			`implementation {
				constant mode: Rounding = #Floor

				Terminal.inspect(mode)
			}`,
			"unknown-case",
		)

		expect(diagnostic.message).toBe("'Rounding' declares no Case '#Floor'")
	})

	it("should answer a return position the same way", () => {
		let diagnostic = firstOf(
			`implementation {
				function chosen() -> Rounding {
					<- #Floor
				}

				Terminal.inspect(chosen())
			}`,
			"unknown-case",
		)

		expect(diagnostic.notes).toEqual([
			"This position takes a Rounding: '#Nearest', '#NearestEven', '#Down', '#Up', '#TowardZero'.",
		])
	})

	// A Case is listed with what it carries, so a reader can write it out.
	it("should spell a Case with the payload it carries", () => {
		let diagnostic = firstOf(
			`implementation {
				constant held: Optional<Integer> = #Sum(1)

				Terminal.inspect(held)
			}`,
			"unknown-case",
		)

		expect(diagnostic.notes).toEqual([
			"This position takes an Optional: '#Value(item)', '#Empty'.",
		])
	})

	// The pattern form '#Rect(width, height)' is refused as
	// `case-payload-is-one-value` when copied into the position, so a payload
	// of several members is listed as a Record.
	it("should spell a payload of several members as a Record", () => {
		let diagnostic = firstOf(
			`implementation {
				choice Shape {
					Circle { radius: Integer },
					Rect { width: Integer, height: Integer },
					Dot,
				}

				constant drawn: Shape = #Bogus

				Terminal.inspect(drawn)
			}`,
			"unknown-case",
		)

		expect(diagnostic.notes).toEqual([
			"This position takes a Shape: '#Circle(radius)', '#Rect({ width, height })', '#Dot'.",
		])
	})

	it("should print a Case list that compiles", () => {
		expect(
			compiles(`implementation {
				choice Shape {
					Circle { radius: Integer },
					Rect { width: Integer, height: Integer },
					Dot,
				}

				constant radius = 5
				constant width = 1
				constant height = 2

				constant round: Shape = #Circle(radius)
				constant boxed: Shape = #Rect({ width, height })
				constant point: Shape = #Dot

				Terminal.inspect([round, boxed, point])
			}`),
		).toBe(true)
	})

	// Overload candidates that take different Choices leave the position
	// undecided, so every Choice is named and none is the message's subject.
	it("should name every Choice where the candidates disagree", () => {
		let diagnostic = firstOf(
			`implementation {
				choice Colour { Red, Green }
				choice Shape { Round, Square }

				namespace Drawn for Integer {
					overload draw {
						(_ colour: Colour) -> Integer { <- @ }
						(_ shape: Shape) -> Integer { <- @ }
					}
				}

				Terminal.inspect(1::draw(#Blue))
			}`,
			"unknown-case",
		)

		expect(diagnostic.message).toBe(
			"No Choice this position accepts declares a Case '#Blue'",
		)
		expect(diagnostic.notes).toEqual([
			"This position takes a Colour: '#Red', '#Green'.",
			"This position takes a Shape: '#Round', '#Square'.",
		])
	})

	// Nothing decides a Record Literal's member, so the Help says how to get
	// a report that can name a Choice.
	it("should say how to get a Choice where the position decides nothing", () => {
		let diagnostic = firstOf(
			`implementation {
				constant options = { rounding = #Floor }

				Terminal.inspect(options)
			}`,
			"unknown-case",
		)

		expect(diagnostic.message).toBe(
			"No Choice in scope declares a Case '#Floor'",
		)
		expect(diagnostic.helps).toEqual([
			"Annotate the value, or pass it where a Choice is expected, so the Case resolves against that Choice's own Cases.",
		])
	})

	// A near miss names the Choice that declares it. The Cases are not
	// listed, since the scan reaches the whole prelude.
	it("should name the Choice that declares the near miss", () => {
		let diagnostic = firstOf(
			`implementation {
				constant options = { division = #Truncated }

				Terminal.inspect(options)
			}`,
			"unknown-case",
		)

		expect(diagnostic.notes).toEqual(["'Division' declares '#Truncating'."])
		expect(diagnostic.helps[0]).toBe("Did you mean '#Truncating'?")
	})

	// A `match` written one level out, on a subject that declares no Case.
	it("should say a matched subject holds the Choice", () => {
		let diagnostic = firstOf(
			`implementation {
				choice Answer { Yes, No }

${future.replace("Future<Integer>", "Future<Answer>").replace("<- 41", "<- #Yes")}

				match fetched() -> {} {
					case #Yes { <- {} }
					case _ { <- {} }
				}
			}`,
			"unknown-case",
		)

		expect(diagnostic.notes).toEqual([
			"'#Yes' is a Case of Answer, which is what a Future<Answer> holds.",
		])
		expect(diagnostic.helps).toEqual([
			"Wait for it first — 'constant answered = complete …' — and match 'answered'.",
		])
		expect(
			compiles(`implementation {
				choice Answer { Yes, No }

${future.replace("Future<Integer>", "Future<Answer>").replace("<- 41", "<- #Yes")}

				constant answered = complete fetched()

				match answered -> {} {
					case #Yes { <- {} }
					case _ { <- {} }
				}
			}`),
		).toBe(true)
	})
})

describe("A name the Namespace around it reaches", () => {
	const clock = [
		"			namespace Clock for Integer {",
		"				static noon = 43_200",
		"",
		"				static make(_ seconds: Integer) -> Integer { <- seconds }",
		"",
		"				isAfterNoon() -> Boolean { <- @::isGreaterThan(Clock.noon) }",
		"",
	].join("\n")

	it("should name a static of the enclosing Namespace", () => {
		let diagnostic = firstOf(
			`implementation {
${clock}
				afterNoon() -> Boolean { <- @::isGreaterThan(noon) }
			}

			Terminal.print(50_000::afterNoon()::toString())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write 'Clock.noon'."])
		expect(diagnostic.notes).toEqual([
			"A static is reached through its Namespace, inside the Namespace too.",
		])
		expect(diagnostic.data).toEqual({
			kind: "essence-spelling",
			position: diagnostic.position as common.Position,
			spelling: "Clock.noon",
		})
	})

	it("should name a static Method of the enclosing Namespace", () => {
		let diagnostic = firstOf(
			`implementation {
${clock}
				built() -> Integer { <- make(1) }
			}

			Terminal.print(50_000::built()::toString())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write 'Clock.make'."])
	})

	// Inside a Method body the value an instance Method works on is `@`.
	it("should name an instance Method of the enclosing Namespace", () => {
		let diagnostic = firstOf(
			`implementation {
${clock}
				twice() -> Boolean { <- isAfterNoon() }
			}

			Terminal.print(50_000::twice()::toString())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write '@::isAfterNoon'."])
		expect(diagnostic.data).toEqual({
			kind: "essence-spelling",
			position: diagnostic.position as common.Position,
			spelling: "@::isAfterNoon",
		})
	})

	it("should write the parentheses for a Method that was only named", () => {
		let diagnostic = firstOf(
			`implementation {
${clock}
				twice() -> Boolean { <- isAfterNoon }
			}

			Terminal.print(50_000::twice()::toString())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write '@::isAfterNoon()'."])
	})

	it("should name a member of the receiver's Record Type", () => {
		let diagnostic = firstOf(
			`implementation {
				namespace Sized for { width: Integer } {
					area() -> Integer { <- width }
				}

				Terminal.print({ width = 2 }::area()::toString())
			}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write '@.width'."])
		expect(diagnostic.notes).toEqual([
			"'width' is a member of { width: Integer }, and a member is read off the value rather than named on its own.",
		])
	})

	it("should name the one Namespace in scope that declares the static", () => {
		let diagnostic = firstOf(
			`implementation {
${clock}
			}

			Terminal.print(noon::toString())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write 'Clock.noon'."])
		expect(diagnostic.notes).toEqual([
			"'Clock' declares a static 'noon', and a static is reached through its Namespace.",
		])
	})

	// Which one was meant can not be decided, so no fix writes one in.
	it("should list every Namespace and offer no fix where several declare it", () => {
		let diagnostic = firstOf(
			`implementation {
				namespace Clock for Integer { static noon = 1 }
				namespace Watch for Integer { static noon = 2 }

				Terminal.print(noon::toString())
			}`,
			"unknown-name",
		)

		expect(diagnostic.notes).toEqual([
			"'Clock' declares a static 'noon'.",
			"'Watch' declares a static 'noon'.",
		])
		expect(diagnostic.data).toBeUndefined()
	})

	// A reader who knows free functions writes a standard library static bare.
	it("should reach the standard library's statics too", () => {
		let diagnostic = firstOf(
			`implementation {
				Terminal.print(Pi::toString())
			}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write 'Number.Pi'."])
	})

	// A shorthand is the member and its value, and `{ Clock.noon }` is
	// refused as `shorthand-on-path-key`. So the member is spelled out.
	it("should spell the member out where the name is a shorthand", () => {
		let diagnostic = firstOf(
			`implementation {
${clock}
				wrapped() -> { noon: Integer } { <- { noon } }
			}

			Terminal.inspect(1::wrapped())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write 'noon = Clock.noon'."])
		expect(diagnostic.data).toEqual({
			kind: "essence-spelling",
			position: diagnostic.position as common.Position,
			spelling: "noon = Clock.noon",
		})
	})

	// Plain lowercase names such as `head` and `write` are prelude statics. A
	// `head` under a Constant called `heads` is far more likely a misspelling
	// than `Http.head` without its Namespace.
	it("should let a near miss lead a Namespace that is merely in scope", () => {
		let diagnostic = firstOf(
			`implementation {
				constant heads = [1, 2]

				Terminal.inspect(head)
			}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual([
			"Did you mean 'heads'?",
			"Or write 'Http.head'.",
		])
		expect(diagnostic.data).toEqual({
			kind: "suggestion",
			suggestion: "heads",
		})
	})

	it("should answer a name one edit from a Constant the same way", () => {
		let diagnostic = firstOf(
			`implementation {
				constant writer = "w"

				Terminal.print(write)
			}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual([
			"Did you mean 'writer'?",
			"Or write 'Terminal.write'.",
		])
	})

	// With no near miss to lead, the reach stands alone and keeps its fix.
	it("should keep the reach and its fix where nothing is a near miss", () => {
		let diagnostic = firstOf(
			`implementation {
				Terminal.print(Pi::toString())
			}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write 'Number.Pi'."])
		expect(diagnostic.data).toEqual({
			kind: "essence-spelling",
			position: diagnostic.position as common.Position,
			spelling: "Number.Pi",
		})
	})

	// The Namespace the name stands inside is evidence rather than a guess,
	// so it keeps the first Help and the fix over any near miss.
	it("should keep the enclosing Namespace ahead of a near miss", () => {
		let diagnostic = firstOf(
			`implementation {
${clock}
				total() -> Integer {
					constant nook = 1

					<- noon::add(nook)
				}
			}

			Terminal.print(1::total()::toString())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write 'Clock.noon'."])
		expect(diagnostic.data).toEqual({
			kind: "essence-spelling",
			position: diagnostic.position as common.Position,
			spelling: "Clock.noon",
		})
	})

	it("should spell a Namespace in scope out the same way", () => {
		let diagnostic = firstOf(
			`implementation {
				constant r = { head }

				Terminal.inspect(r)
			}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write 'head = Http.head'."])
	})

	it("should print Helps that compile", () => {
		expect(
			compiles(`implementation {
${clock}
				fixedStatic() -> Boolean { <- @::isGreaterThan(Clock.noon) }
				fixedMake() -> Integer { <- Clock.make(1) }
				fixedMethod() -> Boolean { <- @::isAfterNoon() }
				wrapped() -> { noon: Integer } { <- { noon = Clock.noon } }
			}

			namespace Sized for { width: Integer } {
				area() -> Integer { <- @.width }
			}

			constant reached = { head = Http.head }

			Terminal.print(Number.Pi::toString())
			Terminal.print(Clock.noon::toString())
			Terminal.print(50_000::fixedStatic()::toString())
			Terminal.print(50_000::fixedMake()::toString())
			Terminal.print(50_000::fixedMethod()::toString())
			Terminal.inspect(50_000::wrapped())
			Terminal.inspect(reached)
			Terminal.print({ width = 2 }::area()::toString())
		}`),
		).toBe(true)
	})

	it("should keep the near miss where no Namespace reaches the name", () => {
		let diagnostic = firstOf(
			`implementation {
				constant total = 1

				Terminal.print(totla::toString())
			}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Did you mean 'total'?"])
	})
})

// A Method body binds `@` to the receiver, and a Match Handler binds it to the
// value matched. Every Help here asks the lookup that decides a `::` call, so
// what it prints resolves.
describe("A Method reached through the '@' that is in hand", () => {
	const route = [
		"			choice Route {",
		"				Home,",
		"				Article { slug: String },",
		"			}",
		"",
	].join("\n")

	// The `@` here is the matched Route, so `@::area()` would resolve nothing.
	it("should not offer '@' for a Method the matched value has not got", () => {
		let diagnostic = firstOf(
			`implementation {
${route}
			namespace Sized for { width: Integer } {
				area() -> Integer { <- @.width }

				report(_ route: Route) -> String {
					<- match route -> String {
						case #Home { <- area::toString() }
						case #Article { <- @.slug }
					}
				}
			}

			Terminal.print({ width = 3 }::report(#Home))
		}`,
			"unknown-name",
		)

		expect(diagnostic.notes).toEqual([
			"'area' is a Method of 'Sized', and the '@' here is the value this Handler matched — a Route#Home rather than the value the Method works on.",
		])
		expect(diagnostic.helps).toEqual([
			"Name the receiver above the 'match' — 'constant receiver = @' — and write 'receiver::area()'.",
		])
		expect(diagnostic.data).toBeUndefined()
	})

	// Here the matched value does answer the name, which the enclosing
	// Namespace's own table could not tell apart.
	it("should offer '@' for a Method the matched value has", () => {
		let diagnostic = firstOf(
			`implementation {
			namespace Clock for Integer {
				named(_ hour: Integer) -> String {
					<- match hour -> String {
						case 0 { <- toString() }
						case _ { <- "later" }
					}
				}
			}

			Terminal.print(1::named(0))
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write '@::toString'."])
		expect(diagnostic.data).toEqual({
			kind: "essence-spelling",
			position: diagnostic.position as common.Position,
			spelling: "@::toString",
		})
	})

	// A Function literal binds no `@` of its own, so the reach still holds.
	it("should reach the receiver from inside a Function literal", () => {
		let diagnostic = firstOf(
			`implementation {
			namespace Sized for { width: Integer } {
				area() -> Integer { <- @.width }

				twice() -> Integer {
					constant doubled = () -> Integer { <- area() }

					<- doubled()
				}
			}

			Terminal.print({ width = 3 }::twice()::toString())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write '@::area'."])
	})

	// A static Method's body has no `@`, and writing one is refused as
	// `at-in-static-method`.
	it("should offer nothing in a static Method's body", () => {
		let diagnostic = firstOf(
			`implementation {
			namespace Sized for { width: Integer } {
				area() -> Integer { <- @.width }

				static biggest() -> Integer { <- area() }
			}

			Terminal.print(Sized.biggest()::toString())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual([])
		expect(diagnostic.notes).toEqual([])
	})

	// The Namespace's own table never holds a Protocol's provided Method.
	it("should reach a Protocol's provided Method", () => {
		let diagnostic = firstOf(
			`implementation {
			protocol Greets {
				greeting() -> String

				greetTwice() -> String { <- "{@::greeting()}{@::greeting()}" }
			}

			namespace Person for { name: String } is Greets {
				greeting() -> String { <- @.name }

				shout() -> String { <- greetTwice() }
			}

			Terminal.print({ name = "Ada" }::shout())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write '@::greetTwice'."])
	})

	// The enclosing Namespace's table can not see another Namespace's Method.
	it("should reach a Method another Namespace declares for the Type", () => {
		let diagnostic = firstOf(
			`implementation {
			namespace Clock for Integer {
				isAfterNoon() -> Boolean { <- @::isGreaterThan(43_200) }
			}

			namespace Watch for Integer {
				late() -> Boolean { <- isAfterNoon() }
			}

			Terminal.print(50_000::late()::toString())
		}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write '@::isAfterNoon'."])
	})

	it("should print Helps that compile", () => {
		expect(
			compiles(`implementation {
${route}
			protocol Greets {
				greeting() -> String

				greetTwice() -> String { <- "{@::greeting()}{@::greeting()}" }
			}

			namespace Sized for { width: Integer } is Greets {
				area() -> Integer { <- @.width }

				greeting() -> String { <- "sized" }

				report(_ route: Route) -> String {
					constant receiver = @

					<- match route -> String {
						case #Home { <- receiver::area()::toString() }
						case #Article { <- @.slug }
					}
				}

				twice() -> Integer {
					constant doubled = () -> Integer { <- @::area() }

					<- doubled()
				}

				shout() -> String { <- @::greetTwice() }
			}

			namespace Clock for Integer {
				isAfterNoon() -> Boolean { <- @::isGreaterThan(43_200) }

				named(_ hour: Integer) -> String {
					<- match hour -> String {
						case 0 { <- @::toString() }
						case _ { <- "later" }
					}
				}
			}

			namespace Watch for Integer {
				late() -> Boolean { <- @::isAfterNoon() }
			}

			constant box = { width = 3 }

			Terminal.print(box::report(#Home))
			Terminal.print(box::twice()::toString())
			Terminal.print(box::shout())
			Terminal.print(1::named(0))
			Terminal.print(50_000::late()::toString())
		}`),
		).toBe(true)
	})
})
