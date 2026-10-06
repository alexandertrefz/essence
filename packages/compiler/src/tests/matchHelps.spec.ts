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

	// In a Match of its own the Guards go on its Cases, and the empty
	// container gets the Case they leave it to.
	it("should compile the guarded List Cases a Match is asked for", () => {
		expect(
			firstAnalysed(
				`implementation {
					constant items: List<Integer> | List<String> = [1]

					Terminal.print(match items -> String {
						case List<String> { <- "strings" }
						case List<Integer> { <- "integers" }
					})
				}`,
				"empty-list-overlap",
			).helps,
		).toEqual([
			"Guard the Cases with 'where @::hasItems()' and answer for the empty List in a Case of its own.",
		])

		let followed = `implementation {
			constant items: List<Integer> | List<String> = [1]

			Terminal.print(match items -> String {
				case List<String> where @::hasItems() { <- "strings" }
				case List<Integer> where @::hasItems() { <- "integers" }
				case _ { <- "empty" }
			})
		}`

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})

	it("should compile the guarded Dictionary Cases a Match is asked for", () => {
		expect(
			firstAnalysed(
				`implementation {
					constant ages: Dictionary<String, Integer> | Dictionary<Integer, String> = ["a" = 1]

					Terminal.print(match ages -> String {
						case Dictionary<Integer, String> { <- "names" }
						case Dictionary<String, Integer> { <- "ages" }
					})
				}`,
				"empty-dictionary-overlap",
			).helps,
		).toEqual([
			"Guard the Cases with 'where @::hasEntries()' and answer for the empty Dictionary in a Case of its own.",
		])

		let followed = `implementation {
			constant ages: Dictionary<String, Integer> | Dictionary<Integer, String> = ["a" = 1]

			Terminal.print(match ages -> String {
				case Dictionary<Integer, String> where @::hasEntries() { <- "names" }
				case Dictionary<String, Integer> where @::hasEntries() { <- "ages" }
				case _ { <- "empty" }
			})
		}`

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})
})

describe("A Case an empty container crosses into at a member", () => {
	// `@` in a Guard is the Case, and the payload requirement does not
	// narrow `@.items`, so the Guard asks the name the Pattern binds.
	it("should guard a payload requirement through the name it binds", () => {
		let bag = (cases: string) => `implementation {
			choice Bag {
				Items { items: List<Integer> | List<String> },
				Nothing,
			}

			function describe(_ value: Bag) -> String {
				<- match value -> String {
					${cases}
					case _ { <- "other" }
				}
			}
		}`
		let diagnostic = firstAnalysed(
			bag(`case #Items({ items: List<Integer> }) { <- "integers" }
				case #Items({ items: List<String> }) { <- "strings" }`),
			"empty-list-overlap",
		)

		expect(diagnostic.labels[0]?.message).toBe(
			"a Bag#Items with an empty List in 'items' fits the Case above too",
		)
		expect(diagnostic.helps).toEqual([
			"Guard the Cases with 'where items::hasItems()' and answer for the empty List in a Case of its own.",
		])

		let followed =
			bag(`case #Items({ items: List<Integer> }) where items::hasItems() { <- "integers" }
				case #Items({ items: List<String> }) where items::hasItems() { <- "strings" }`)

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})

	it("should guard a nested member through the name it binds", () => {
		let bag = (cases: string) => `implementation {
			choice Bag {
				Items { wrap: { items: List<Integer> } | { items: List<String> } },
				Nothing,
			}

			function describe(_ value: Bag) -> String {
				<- match value -> String {
					${cases}
					case _ { <- "other" }
				}
			}
		}`

		expect(
			firstAnalysed(
				bag(`case #Items({ wrap as { items: List<Integer> } }) { <- "integers" }
					case #Items({ wrap as { items: List<String> } }) { <- "strings" }`),
				"empty-list-overlap",
			).helps,
		).toEqual([
			"Guard the Cases with 'where items::hasItems()' and answer for the empty List in a Case of its own.",
		])

		let followed =
			bag(`case #Items({ wrap as { items: List<Integer> } }) where items::hasItems() { <- "integers" }
				case #Items({ wrap as { items: List<String> } }) where items::hasItems() { <- "strings" }`)

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})

	it("should guard a Record Pattern's member through the name it binds", () => {
		let records = (cases: string) => `implementation {
			function describe(_ value: { items: List<Integer> } | { items: List<String> }) -> String {
				<- match value -> String {
					${cases}
				}
			}
		}`

		expect(
			firstAnalysed(
				records(`case { items: List<Integer> } { <- "integers" }
					case { items: List<String> } { <- "strings" }`),
				"empty-list-overlap",
			).helps,
		).toEqual([
			"Guard the Cases with 'where items::hasItems()' and answer for the empty List in a Case of its own.",
		])

		let followed =
			records(`case { items: List<Integer> } where items::hasItems() { <- "integers" }
				case { items: List<String> } where items::hasItems() { <- "strings" }
				case _ { <- "empty" }`)

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})

	// A Matcher with no Pattern binds nothing, and narrows `@` to its Type.
	it("should guard a member read off '@' where the Case binds no name", () => {
		let named = (cases: string) => `implementation {
			type Numbers = { items: List<Integer> }
			type Words = { items: List<String> }

			function describe(_ value: Numbers | Words) -> String {
				<- match value -> String {
					${cases}
				}
			}
		}`

		expect(
			firstAnalysed(
				named(`case Numbers { <- "integers" }
					case Words { <- "strings" }`),
				"empty-list-overlap",
			).helps,
		).toEqual([
			"Guard the Cases with 'where @.items::hasItems()' and answer for the empty List in a Case of its own.",
		])

		let followed =
			named(`case Numbers where @.items::hasItems() { <- "integers" }
			case Words where @.items::hasItems() { <- "strings" }
			case _ { <- "empty" }`)

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})

	// The Match a dispatch asks for narrows `@` by each Matcher.
	it("should guard a member a dispatch's Match reads off '@'", () => {
		let namespaces = `namespace Numbers for { items: List<Integer> } {
			describe() -> String {
				<- "integers"
			}
		}

		namespace Words for { items: List<String> } {
			describe() -> String {
				<- "strings"
			}
		}`
		let show = (body: string) => `implementation {
			${namespaces}

			function show(_ value: { items: List<Integer> } | { items: List<String> }) -> String {
				${body}
			}
		}`

		expect(
			firstAnalysed(show("<- value::describe()"), "empty-list-overlap")
				.helps,
		).toEqual([
			"Guard the Cases of a Match with 'where @.items::hasItems()', answer for the empty List in a Case of its own, and call the Method inside each arm.",
		])

		let followed = show(`<- match value -> String {
			case { items: List<Integer> } where @.items::hasItems() { <- @::describe() }
			case { items: List<String> } where @.items::hasItems() { <- @::describe() }
			case _ { <- "empty" }
		}`)

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})

	it("should guard a Dictionary member through the name it binds", () => {
		let ledger = (cases: string) => `implementation {
			choice Ledger {
				Entries { ages: Dictionary<String, Integer> | Dictionary<Integer, String> },
				Nothing,
			}

			function describe(_ value: Ledger) -> String {
				<- match value -> String {
					${cases}
					case _ { <- "other" }
				}
			}
		}`
		let diagnostic = firstAnalysed(
			ledger(`case #Entries({ ages: Dictionary<String, Integer> }) { <- "by name" }
				case #Entries({ ages: Dictionary<Integer, String> }) { <- "by number" }`),
			"empty-dictionary-overlap",
		)

		expect(diagnostic.labels[0]?.message).toBe(
			"a Ledger#Entries with an empty Dictionary in 'ages' fits the Case above too",
		)
		expect(diagnostic.helps).toEqual([
			"Guard the Cases with 'where ages::hasEntries()' and answer for the empty Dictionary in a Case of its own.",
		])

		let followed =
			ledger(`case #Entries({ ages: Dictionary<String, Integer> }) where ages::hasEntries() { <- "by name" }
				case #Entries({ ages: Dictionary<Integer, String> }) where ages::hasEntries() { <- "by number" }`)

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})
})

describe("A Case another application's Case crosses into", () => {
	let box = `choice Box<Item> {
		Full { item: Item },
		Many { items: List<Item> },
		Empty,
	}`

	// A Case Matcher takes its Case in every application, so written first
	// it leaves no Case to cross.
	it("should compile with the Cases of their own the Help spells", () => {
		expect(
			firstAnalysed(
				`implementation {
					${box}

					function describe(_ value: Box<Integer> | Box<String>) -> String {
						<- match value -> String {
							case Box<Integer> { <- "integers" }
							case Box<String> { <- "strings" }
						}
					}
				}`,
				"type-argument-overlap",
			).helps,
		).toEqual([
			"Write 'case Box#Many' and 'case Box#Empty' above the Case that runs first, so one Case answers for each in every application.",
		])

		let followed = `implementation {
			${box}

			function describe(_ value: Box<Integer> | Box<String>) -> String {
				<- match value -> String {
					case Box#Many { <- "many" }
					case Box#Empty { <- "empty" }
					case Box<Integer> { <- "integers" }
					case Box<String> { <- "strings" }
				}
			}
		}`

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})

	// A dispatch has no Case to write, so the Help asks for the Match.
	it("should compile with the Match the dispatch Help spells", () => {
		let namespaces = `namespace Integers for Box<Integer> {
			describe() -> String {
				<- "integers"
			}
		}

		namespace Strings for Box<String> {
			describe() -> String {
				<- "strings"
			}
		}`

		expect(
			firstAnalysed(
				`implementation {
					choice Box<Item> {
						Full { item: Item },
						Many { items: List<Item> },
					}

					${namespaces}

					function show(_ value: Box<Integer> | Box<String>) -> String {
						<- value::describe()
					}
				}`,
				"type-argument-overlap",
			).helps,
		).toEqual([
			"Match the receiver: write 'case Box#Many' first, then a Case for each application that calls the Method.",
		])

		let followed = `implementation {
			choice Box<Item> {
				Full { item: Item },
				Many { items: List<Item> },
			}

			${namespaces}

			function show(_ value: Box<Integer> | Box<String>) -> String {
				<- match value -> String {
					case Box#Many { <- "many" }
					case Box<Integer> { <- @::describe() }
					case Box<String> { <- @::describe() }
				}
			}
		}`

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})
})

describe("A Case another application's Case crosses into at a member", () => {
	let box = `choice Box<Item> {
		Full { item: Item },
		Count { n: Integer },
		Empty,
	}`
	// The Match the Help asks for, binding the member and answering for the
	// crossing Cases before the Cases for each application.
	let split = `<- match box -> String {
		case Box#Count { <- "count" }
		case Box#Empty { <- "empty" }
		case Box<Integer> { <- "integers" }
		case Box<String> { <- "strings" }
	}`

	// A Pattern can not name a Case of every application, so the member is
	// bound once and matched on its own.
	it("should compile with the member bound in one Case of a payload", () => {
		let held = (cases: string) => `implementation {
			${box}

			choice Holder {
				Hold { box: Box<Integer> | Box<String> },
				Nothing,
			}

			function describe(_ value: Holder) -> String {
				<- match value -> String {
					${cases}
					case #Nothing { <- "nothing" }
				}
			}
		}`

		expect(
			firstAnalysed(
				held(`case #Hold({ box: Box<Integer> }) { <- "integers" }
					case #Hold({ box: Box<String> }) { <- "strings" }
					case _ { <- "other" }`),
				"type-argument-overlap",
			).helps,
		).toEqual([
			"Bind 'box' in one 'case Holder#Hold({ box })' in place of these Cases, and match it there with 'case Box#Count' and 'case Box#Empty' first.",
		])

		let followed = held(`case Holder#Hold({ box }) {
			${split}
		}`)

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
	})

	it("should compile with the member bound in one Record Case", () => {
		let records = (cases: string) => `implementation {
			${box}

			function describe(_ value: { box: Box<Integer> } | { box: Box<String> }) -> String {
				<- match value -> String {
					${cases}
				}
			}
		}`

		expect(
			firstAnalysed(
				records(`case { box: Box<Integer> } { <- "integers" }
					case { box: Box<String> } { <- "strings" }`),
				"type-argument-overlap",
			).helps,
		).toEqual([
			"Bind 'box' in one 'case { box }' in place of these Cases, and match it there with 'case Box#Count' and 'case Box#Empty' first.",
		])

		let followed = records(`case { box } {
			${split}
		}`)

		expect(compiles(followed)).toBe(true)
		expect(analysedDiagnosticsFor(followed)).toEqual([])
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
