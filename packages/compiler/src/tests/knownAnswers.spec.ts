import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { parse, parseWithDiagnostics } from "../parser/index"

// NOTE: Three reporters that knew the answer and said something else. A Method
// the receiver has not got may be a Method of what it HOLDS, a Case no Choice in
// scope declares was written where a Choice is expected, and a bare name that is
// not declared may be a static of the Namespace it was written inside. Each of
// them used to end in a guess by edit distance.
//
// Every Help printed here is compiled below, in `compiles`. A Help is a promise
// that what it prints works when it is followed, and a report that breaks that
// promise is worse than one that says nothing.
function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrich(parse(source)).diagnostics
}

function firstOf(
	source: string,
	code: common.DiagnosticCode,
): common.Diagnostic {
	let found = diagnosticsFor(source).find(
		(diagnostic) => diagnostic.code === code,
	)

	if (found === undefined) {
		throw new Error(
			`No '${code}' reported; got ${diagnosticsFor(source)
				.map((diagnostic) => diagnostic.code)
				.join(", ")}.`,
		)
	}

	return found
}

// NOTE: What a Help promises, checked by compiling it. Every Program here is the
// probe from the test above it with the Help's own spelling written into it, so
// a Help that stops compiling fails the test that prints it rather than a
// reader's afternoon.
function compiles(source: string): boolean {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return false
	}

	return !containsErrors(enrich(parsed.program).diagnostics)
}

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

		// NOTE: `pad` is what this used to offer, with a Quick Fix behind it.
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

		// NOTE: The proof changes which reading Method answers the item outright
		// — `List::firstItem()` answers an Optional and would trade one refusal
		// for the same one — so the Help is read off the receiver rather than
		// written once for every List.
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

		// NOTE: A List of Lists holds a List, and `add` is a Method of neither.
		// Nothing is claimed where nothing was found.
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
			// NOTE: And no `::map` Help. `Dictionary::map` hands its transform a
			// whole `{ key, value }` entry and never the value on its own, so
			// the Help that would have bound one is not offered here.
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
				"'add' is a Method of Integer, and 'Optional#Value' carries one.",
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
				"'add' is a Method of Integer, and 'Result#Value' carries one.",
			)
		})

		// NOTE: A Choice a Program declares has no reading Method and no `map`,
		// so the `match` is the only Help there — and a Help that stands first
		// does not open on "Or".
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

		// NOTE: A body that answers something other than a Future can not write
		// the word at all, so naming it would be advice that does not compile.
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

	// NOTE: And the same forgotten word met in a String's hole, which said the
	// Future was not Printable and left the reader to work out why something
	// Integer-shaped is not. One voice: the state sentence and the word are the
	// ones every other report about a missing `complete` prints.
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

		// NOTE: The word is only named where it may stand, which is the rule
		// every Help about `complete` is held to.
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
			expect(diagnostic.helps).toEqual([
				"Declare the enclosing Function '-> Future<…>', which is what lets its body wait.",
			])
			expect(diagnostic.data).toBeUndefined()
		})

		// NOTE: A hole that holds neither is answered exactly as it always was.
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

	// NOTE: The evidence is looked up with the lookup a call is decided by, so a
	// Namespace the Program writes itself counts exactly as the standard
	// library's does — and one it has not got counts for neither.
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
	// NOTE: `index` really is one edit from `indx`, and it takes a label this
	// call did not write. A Method that could not have been called this way is
	// not the Method that was meant, and the Quick Fix behind the suggestion
	// would have traded one refusal for another.
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

	// NOTE: And the other half of the rule: a name the call's own shape fits is
	// still offered, which is what `index` was measured against.
	it("should keep a candidate the written Arguments do pair with", () => {
		let diagnostic = firstOf(
			`implementation {
				constant primes = [2, 3, 5]

				Terminal.print(primes::lenght()::toString())
			}`,
			"unknown-method",
		)

		expect(diagnostic.helps).toEqual(["Did you mean 'length'?"])
	})

	// NOTE: A misspelled name with a LABEL behind it lost its suggestion to that
	// rule: nothing fitting `(of …)` is near `lenght`, so the pool that was
	// asked came back with nothing to say. The label is a second mistake, not a
	// reason to go quiet about the first.
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

	// NOTE: And the name this door may not let back in. `indexOf` labels
	// nothing and is two edits from `index(on:)`, so neither the fitting names
	// nor the second pool answers it.
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
	// NOTE: The Validator has said this on `argument-type-mismatch` since
	// asynchrony landed. A call that picked no Overload never reached the
	// Validator at all, so the same sentence is said here.
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
	// NOTE: Every flag in the standard library is a bare Case passed at a
	// Parameter, so this report is how a reader discovers what `round(toward:)`
	// takes. It used to say that no Choice in scope declared the name and stop.
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
	})

	// NOTE: One parse tree enriched over and over, which is what an editor does
	// with the buffer under the cursor. The expectation is recorded against the
	// NAME Node, and that Node outlives every pass — so the recording is
	// deduped where it is written, and the report says the same thing each time
	// rather than growing a Type per pass behind it.
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

	// NOTE: A Case that carries something is spelled with what it carries, so
	// the list is one a reader can write from. `#Value` beside `#Empty` with
	// nothing to tell them apart is a list nobody can act on.
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

	// NOTE: And a payload of SEVERAL members is spelled as the Record it is. The
	// pattern form this printed — '#Rect(width, height)' — is
	// `case-payload-is-one-value` the moment it is copied into the position the
	// list stands in, which is one refusal traded for the next.
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

	// NOTE: An Overload whose candidates take different Choices is the one shape
	// this can not decide, so every Choice is named and none of them is the
	// message's subject.
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

	// NOTE: Nothing decides a Record Literal's member, so nothing here can name
	// a Choice — and the one thing worth saying is how to get a report that can.
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

	// NOTE: And where the scan DID find a near miss, which Choice declares it —
	// the half a reader has nowhere to look up. The Cases themselves are still
	// not listed: the scan reaches the whole prelude.
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

	// NOTE: A `match` written one level out. The subject declares no Case at
	// all, so the list of what it does declare was empty and the report said
	// nothing whatsoever.
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

	// NOTE: This is what was answered with "Did you mean 'loop'?" — a word from
	// the prelude two edits away, with a Quick Fix behind it.
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

	// NOTE: An instance Method is reached through the value it works on, and
	// inside a Method body that value is `@`.
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

	// NOTE: Which of them was meant is not something this can decide, so they
	// are listed and nothing writes one of them into the reader's file.
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

	// NOTE: The standard library's own statics answer the same way, which is
	// what a reader arriving from a language with free functions writes.
	it("should reach the standard library's statics too", () => {
		let diagnostic = firstOf(
			`implementation {
				Terminal.print(Pi::toString())
			}`,
			"unknown-name",
		)

		expect(diagnostic.helps).toEqual(["Write 'Number.Pi'."])
	})

	// NOTE: A Record Literal's shorthand is the member AND its value, so the
	// reach written over the name alone — `{ Clock.noon }` — is refused as
	// `shorthand-on-path-key`, one refusal traded for the next. The member is
	// spelled out instead.
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

	// NOTE: Sixteen plain lowercase names are statics of the prelude — `head`,
	// `write`, `get`, `send` — and a `head` written one line under a Constant
	// called `heads` is a misspelling far more often than it is `Http.head`
	// without its Namespace. The reach took the first Help and the fix, and
	// wrote a Namespace over a name that was one edit from the reader's own.
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

	// NOTE: And the other way where there is nothing to lead with: the reach
	// stands alone and keeps its fix.
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

	// NOTE: The Namespace the name stands INSIDE is evidence from the site
	// rather than a guess, so it keeps the first Help and the fix however close
	// something else in scope is spelled.
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

	// NOTE: The near miss is what the Namespace reach replaces, so a name no
	// Namespace declares still gets one.
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

// NOTE: The `@` half of that reach, which is the half that can be wrong about
// the value it names: a Method body binds `@` to the receiver, a Match Handler
// binds it to the value matched, and a reach is only ever true of one of them.
// Every Help here is asked of the Method lookup a `::` call is decided by, so
// what it prints is a call that resolves.
describe("A Method reached through the '@' that is in hand", () => {
	const route = [
		"			choice Route {",
		"				Home,",
		"				Article { slug: String },",
		"			}",
		"",
	].join("\n")

	// NOTE: This is what was answered `Write '@::area()'` — a spelling that
	// resolves nothing at all, because the `@` it wrote is the matched Route.
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

	// NOTE: And the same Handler where the value matched DOES answer the name,
	// which is the case the enclosing Namespace's own table could not tell from
	// the one above.
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

	// NOTE: A Function literal binds no `@` of its own, so the receiver of the
	// Method around it is still the one in hand — and the reach still holds.
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

	// NOTE: A static Method's body has no `@` to write, and a reach that named
	// one would be refused by `at-in-static-method` — so nothing is offered.
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

	// NOTE: A Protocol's PROVIDED Method is reached through the value exactly as
	// a written one is, and the Namespace's own table never held it.
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

	// NOTE: And a Method another Namespace declares for the same Type, which is
	// the same lookup answering from somewhere the enclosing Namespace's table
	// can not see.
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
