import { describe, expect, it } from "bun:test"

import {
	analysedDiagnosticsFor,
	compiles,
	firstAnalysed,
} from "./followedHelps"

// The Helps about a Match's Cases, each followed literally, so that none leads
// to a second spelling of the same mistake.
//
// The Validator reports all of these, so the whole pipeline runs.

describe("A Case an earlier one answers for", () => {
	let twice = `implementation {
		choice Colour {
			Red,
			Green,
		}

		function name(_ colour: Colour) -> String {
			<- match colour -> String {
				case #Red { <- "red" }
				case #Green { <- "green" }
				case #Red { <- "red again" }
			}
		}

		Terminal.print(name(Colour#Red))
	}`

	// Two Matchers asking the same question swallow each other in either
	// order, so a reorder would only move the report.
	it("should not offer a reorder for two Cases that ask one question", () => {
		expect(firstAnalysed(twice, "unreachable-case").helps).toEqual([
			"Remove this Case — the Case above answers for every value it would take, in whichever order the two are written.",
		])
	})

	it("should compile once the duplicate is removed", () => {
		expect(
			compiles(`implementation {
				choice Colour {
					Red,
					Green,
				}

				function name(_ colour: Colour) -> String {
					<- match colour -> String {
						case #Red { <- "red" }
						case #Green { <- "green" }
					}
				}

				Terminal.print(name(Colour#Red))
			}`),
		).toBe(true)
	})

	// A Case covered by a wider one, rather than repeated, is fixed by
	// reordering.
	it("should keep the reorder where the covered Case is narrower", () => {
		let source = `implementation {
			function describe(_ value: Integer | String) -> String {
				<- match value -> String {
					case _ { <- "anything" }
					case Integer { <- "a number" }
				}
			}

			Terminal.print(describe(1))
		}`

		expect(firstAnalysed(source, "unreachable-case").helps).toEqual([
			"Remove this Case, or write it above the one that covers it.",
		])

		expect(
			compiles(`implementation {
				function describe(_ value: Integer | String) -> String {
					<- match value -> String {
						case Integer { <- "a number" }
						case _ { <- "anything" }
					}
				}

				Terminal.print(describe(1))
			}`),
		).toBe(true)
	})
})

describe("Two Cases a Signature can not tell apart", () => {
	// No Guard is offered. On the later Case it changes nothing, and on the
	// earlier one it leads to `missing-case`. Two Matchers asking one erased
	// question admit no exhaustive Match at all.
	let source = `implementation {
		type Handler = { run: (_ value: Integer) -> Integer }
		type Logger = { run: (_ value: String) -> String }

		function show(_ value: Handler | Logger) -> String {
			<- match value -> String {
				case Handler { <- "a handler" }
				case Logger { <- "a logger" }
			}
		}

		Terminal.print(show({ run = (_ value: String) -> String { <- value } }))
	}`

	it("should offer no Guard, in either position", () => {
		expect(firstAnalysed(source, "erased-case-conflict").helps).toEqual([
			"Tell the two Cases apart by a member that survives to runtime — a member whose Type is not a Function.",
		])
	})

	it("should compile once a member tells the two apart", () => {
		expect(
			compiles(`implementation {
				type Handler = { kind: String, run: (_ value: Integer) -> Integer }
				type Logger = { label: String, run: (_ value: String) -> String }

				function show(_ value: Handler | Logger) -> String {
					<- match value -> String {
						case Handler { <- "a handler" }
						case Logger { <- "a logger" }
					}
				}

				Terminal.print(show({ label = "l", run = (_ value: String) -> String { <- value } }))
			}`),
		).toBe(true)
	})

	// A Guard on the Case that decides first leads to `missing-case`, whose
	// Helps lead back here.
	it("should not survive a Guard on the Case that decides first", () => {
		let guarded = `implementation {
			type Handler = { run: (_ value: Integer) -> Integer }
			type Logger = { run: (_ value: String) -> String }

			function show(_ value: Handler | Logger) -> String {
				<- match value -> String {
					case Handler where @::isNot(@) { <- "a handler" }
					case Logger { <- "a logger" }
				}
			}

			Terminal.print(show({ run = (_ value: String) -> String { <- value } }))
		}`

		expect(
			analysedDiagnosticsFor(guarded).map(
				(diagnostic) => diagnostic.code,
			),
		).toContain("missing-case")
	})

	// A dispatch branch is picked the way a Case is, so a Match over the same
	// member Types would report the same conflict.
	it("should not send a dispatch conflict into a Match", () => {
		let dispatched = `implementation {
			type Handler = { run: (_ value: Integer) -> Integer }
			type Logger = { run: (_ value: String) -> String }

			namespace Handlers for Handler {
				describe() -> String {
					<- "a handler"
				}
			}

			namespace Loggers for Logger {
				describe() -> String {
					<- "a logger"
				}
			}

			function show(_ value: Handler | Logger) -> String {
				<- value::describe()
			}

			Terminal.print(show({ run = (_ value: String) -> String { <- value } }))
		}`

		expect(firstAnalysed(dispatched, "erased-case-conflict").helps).toEqual(
			[
				"Tell the two member Types apart by something that survives to runtime — a member whose Type is not a Function.",
			],
		)
	})
})

describe("Two applications of one Case a dispatch can not tell apart", () => {
	// They differ only in their Type Arguments, so no Function is to blame.
	it("should name the Type Arguments the applications differ in", () => {
		let diagnostic = firstAnalysed(
			`implementation {
				choice Box<Value> { Full { value: Value }, Empty }

				function isEmpty(_ b: Box<Integer> | Box<String>) -> Boolean {
					<- b::is(#Empty)
				}
			}`,
			"erased-case-conflict",
		)

		expect(diagnostic.notes).toContain(
			"Box<Integer>#Empty and Box<String>#Empty differ only in their Type Arguments, which do not survive to runtime.",
		)
		expect(diagnostic.helps).toEqual([
			"Write the receiver's Type as one application of 'Box'.",
		])
		// The Help followed: the receiver written as `Box<Integer>` alone.
		expect(
			compiles(`implementation {
				choice Box<Value> { Full { value: Value }, Empty }

				function isEmpty(_ b: Box<Integer>) -> Boolean {
					<- b::is(#Empty)
				}
			}`),
		).toBe(true)
	})
})

describe("Two Cases naming Type Parameters", () => {
	// Types erase before a Match runs, so each Case accepts every value and
	// neither is narrower. A reorder would only move the report.
	let source = `implementation {
		function describe<infer First is Printable, infer Second is Printable>(_ value: First | Second) -> String {
			<- match value -> String {
				case First { <- "first" }
				case Second { <- "second" }
			}
		}
	}`

	it("should name the signature rather than an order to write them in", () => {
		expect(firstAnalysed(source, "erased-case-conflict").helps).toEqual([
			"Take one Type Parameter in place of the Union — '<infer Item is Printable>(_ value: Item)' — since Types erase before a Match runs, and a Match is the only thing that narrows.",
		])
	})

	// `undispatchable-method` says the same sentence, from the same builder.
	// One Type Parameter leaves nothing for a Match to ask about.
	it("should compile when the signature is written that way", () => {
		expect(
			compiles(`implementation {
		function describe<infer Item is Printable>(_ value: Item) -> String {
			<- value::toString()
		}
	}`),
		).toBe(true)
	})

	// A Case naming a declared Type is narrower than a Generic Case, so here
	// the reorder clause holds.
	it("should keep the reorder clause where this Case is narrower", () => {
		let narrower = `implementation {
		function describe<infer Item is Printable>(_ value: Item | Integer) -> String {
			<- match value -> String {
				case Item { <- "item" }
				case Integer { <- "number" }
			}
		}
	}`

		expect(firstAnalysed(narrower, "erased-case-conflict").helps).toEqual([
			"Write this Case above 'case Item', which can only ever be the last one.",
		])
		expect(
			compiles(`implementation {
		function describe<infer Item is Printable>(_ value: Item | Integer) -> String {
			<- match value -> String {
				case Integer { <- "number" }
				case Item { <- "item" }
			}
		}
	}`),
		).toBe(true)
	})
})

describe("A Case an empty container crosses into", () => {
	// A Match's Cases ask the same erased question as the dispatch branches,
	// so only a Guard decides an empty container. The Help spells it whole.
	let dispatched = `implementation {
		namespace Strings for List<String> {
			describe() -> String {
				<- "strings"
			}
		}

		namespace Integers for List<Integer> {
			describe() -> String {
				<- "integers"
			}
		}

		function show(_ value: List<String> | List<Integer>) -> String {
			<- value::describe()
		}

		Terminal.print(show([1]))
	}`

	it("should ask for the Guard rather than for a Match", () => {
		expect(firstAnalysed(dispatched, "empty-list-overlap").helps).toEqual([
			"Guard the Cases of a Match with 'where @::hasItems()', answer for the empty List in a Case of its own, and call the Method inside each arm.",
		])
	})

	it("should compile with the guarded Match the Help spells", () => {
		expect(
			compiles(`implementation {
				namespace Strings for List<String> {
					describe() -> String {
						<- "strings"
					}
				}

				namespace Integers for List<Integer> {
					describe() -> String {
						<- "integers"
					}
				}

				function show(_ value: List<String> | List<Integer>) -> String {
					<- match value -> String {
						case List<String> where @::hasItems() { <- @::describe() }
						case List<Integer> where @::hasItems() { <- @::describe() }
						case _ { <- "empty" }
					}
				}

				Terminal.print(show([1]))
			}`),
		).toBe(true)
	})
})

describe("A Case of a Match on values", () => {
	let alreadyEnded = `implementation {
		function describe(_ count: Integer) -> String {
			<- match count -> String {
				case 0 { <- "none" }
				case Integer { <- "some" }
				case _ { <- "rest" }
			}
		}

		Terminal.print(describe(1))
	}`

	// An example value such as `'case 0'` would be refused in a Match over
	// Strings, and the value meant is the reader's to know.
	it("should name no literal of its own", () => {
		let overStrings = `implementation {
			function describe(_ word: String) -> String {
				<- match word -> String {
					case "a" { <- "the letter a" }
					case String { <- "some word" }
					case _ { <- "rest" }
				}
			}

			Terminal.print(describe("a"))
		}`

		for (let source of [alreadyEnded, overStrings]) {
			expect(
				firstAnalysed(source, "literal-match-shape").helps.join(""),
			).not.toContain("case 0")
		}
	})

	// Moving this Case after a closing `case _` would leave the `case _` naming
	// no value. So only a Match with no end hears "move it to the end".
	it("should ask for a removal where the Match already ends", () => {
		expect(
			firstAnalysed(alreadyEnded, "literal-match-shape").helps,
		).toEqual([
			"Write the value this Case is about, or remove it — the last Case already answers for every value the Cases above it do not name.",
		])

		expect(
			compiles(`implementation {
				function describe(_ count: Integer) -> String {
					<- match count -> String {
						case 0 { <- "none" }
						case _ { <- "rest" }
					}
				}

				Terminal.print(describe(1))
			}`),
		).toBe(true)
	})

	it("should ask for the move where the Match has no end", () => {
		let noEnd = `implementation {
			function describe(_ count: Integer) -> String {
				<- match count -> String {
					case Integer { <- "some" }
					case 0 { <- "none" }
				}
			}

			Terminal.print(describe(1))
		}`

		// The Match without a last Case reports `literal-match-shape` too, so
		// this report is picked by its message.
		expect(
			analysedDiagnosticsFor(noEnd).find(
				(diagnostic) =>
					diagnostic.message === "This Case does not name a value",
			)?.helps,
		).toEqual([
			"Write the value this Case is about, or move it to the end, where it answers for every value the Cases above it do not name.",
		])

		expect(
			compiles(`implementation {
				function describe(_ count: Integer) -> String {
					<- match count -> String {
						case 0 { <- "none" }
						case Integer { <- "some" }
					}
				}

				Terminal.print(describe(1))
			}`),
		).toBe(true)
	})
})

describe("A Pattern that names the whole value", () => {
	let source = `implementation {
		constant point: { x: Integer, y: Integer } | String = { x = 1, y = 2 }

		Terminal.print(match point -> String {
			case { x, y } as whole { <- "{whole.x} and {y}" }
			case String { <- "a string" }
		})
	}`

	// The binder is what is refused, so rewriting the body alone is not
	// enough. The Quick Fix makes both edits.
	it("should name both halves of the edit", () => {
		expect(firstAnalysed(source, "redundant-pattern-binder").helps).toEqual(
			["Drop the 'as whole' and write '@' where 'whole' was meant."],
		)
	})

	// One mistake, one report: reads of the dropped binder report nothing.
	it("should report nothing about the name it dropped", () => {
		expect(
			analysedDiagnosticsFor(source).map((diagnostic) => diagnostic.code),
		).toEqual(["redundant-pattern-binder"])
	})

	it("should compile once both edits are made", () => {
		expect(
			compiles(`implementation {
				constant point: { x: Integer, y: Integer } | String = { x = 1, y = 2 }

				Terminal.print(match point -> String {
					case { x, y } { <- "{@.x} and {y}" }
					case String { <- "a string" }
				})
			}`),
		).toBe(true)
	})
})

describe("A Match that leaves a member out", () => {
	let colours = (arms: string) => `implementation {
		choice Colour { Red, Green, Blue }

		function name(_ colour: Colour) -> String {
			<- match colour -> String {
				case #Red { <- "red" }
				case #Green { <- "green" }
				${arms}
			}
		}

		Terminal.print(name(#Red))
	}`

	it("should name the Case it leaves out and the catch-all", () => {
		expect(firstAnalysed(colours(""), "missing-case").helps).toEqual([
			"Add 'case Colour#Blue', or a 'case _' that covers the rest.",
		])
	})

	it("should compile with either arm written in", () => {
		expect(compiles(colours('case Colour#Blue { <- "blue" }'))).toBe(true)
		expect(compiles(colours('case _ { <- "other" }'))).toBe(true)
	})

	// A Union of Types is matched by its members' Types, which the Help
	// spells as Matchers.
	it("should spell a Union member's Type as its Matcher", () => {
		let kinds = (arms: string) => `implementation {
			function kind(_ value: Integer | String | Boolean) -> String {
				<- match value -> String {
					case Integer { <- "a number" }
					${arms}
				}
			}

			Terminal.print(kind(1))
		}`

		expect(firstAnalysed(kinds(""), "missing-case").helps).toEqual([
			"Add 'case String', 'case Boolean', or a 'case _' that covers the rest.",
		])
		expect(
			compiles(
				kinds(
					'case String { <- "a string" }\ncase Boolean { <- "a flag" }',
				),
			),
		).toBe(true)
	})
})
