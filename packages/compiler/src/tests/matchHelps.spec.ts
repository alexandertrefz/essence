import { describe, expect, it } from "bun:test"

import {
	analysedDiagnosticsFor,
	compiles,
	firstAnalysed,
} from "./followedHelps"

// NOTE: The Helps about a Match's Cases, each one followed LITERALLY. Every one
// of them named a second spelling of the same mistake: reorder two Cases that
// ask the same question and the report moves to the other one; move a Case that
// names no value to the end of a Match that already ends in one and the Case at
// the end reports instead; guard the Case the report is about and the Case that
// decides first goes on deciding first.
//
// The Validator reports all of these, so the whole pipeline runs — `firstOf`
// over the Enricher alone would find nothing here.

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

	// NOTE: Two Matchers that ask the same question swallow each other in
	// whichever order they are written, so "write it above" moved the report to
	// the other Case and left a reader circling between two spellings of one
	// duplicate.
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

	// NOTE: A Case the one above COVERS rather than repeats is a different
	// mistake, and reordering really is one of its answers — the clause stays
	// where it still leads somewhere.
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
	// NOTE: The Guard clause is GONE, in both positions. On this Case a Guard
	// changes nothing — the earlier one decides first and never reaches it. On
	// the Case above it takes that Case's claim away and leaves no Case to make
	// it, which is `missing-case`, whose own two answers are both covered by the
	// Case that decides first and report this again. Two Matchers asking one
	// erased question admit no exhaustive Match at all.
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

	// NOTE: The Guard on the Case above was the clause a reader followed into
	// `missing-case`, which sent them back here. Pinned so the round trip can
	// not be reintroduced by wording.
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

	// NOTE: A dispatch branch is picked the same way a Case is, so a Match
	// written over the same two member Types reports the very same conflict one
	// line further down — the reader followed the Help and met it again wearing
	// the Match's wording.
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

describe("Two Cases naming Type Parameters", () => {
	// NOTE: The closed loop this report had. Neither Case is narrower than the
	// other — Types erase before a Match runs, so each accepts every value that
	// reaches it — and the clause that said "write this Case above the other
	// one" moved the report to the other Case, whose own Help moved it back. A
	// reader could swap the arms forever.
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

	// NOTE: The same sentence `undispatchable-method` says about the call this
	// Match was written to replace, out of the same builder — the two reports
	// are one mistake met at two stages, and one answer said two ways is how two
	// answers start. A signature taking one Type Parameter has nothing left for
	// a Match to ask about, which is the point: the Match was standing in for
	// the narrowing the Union could never do.
	it("should compile when the signature is written that way", () => {
		expect(
			compiles(`implementation {
		function describe<infer Item is Printable>(_ value: Item) -> String {
			<- value::toString()
		}
	}`),
		).toBe(true)
	})

	// NOTE: And the reorder clause stands where it is TRUE: a Case naming a
	// declared Type really is narrower than the Generic Case that swallowed it,
	// and moving it up is an edit that ends.
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
	// NOTE: A Match narrows nothing here — its Cases are picked by the same
	// erased question the dispatch branches were. What decides an empty
	// container is a GUARD, so the Help spells the whole shape rather than the
	// half that reads like an answer.
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

	// NOTE: `'case 0'` was an example of a value and a dead end on a Match over
	// Strings — a Case naming an Integer there is refused two clauses down. The
	// example is gone rather than translated, because the value this Case is
	// about is the reader's to know.
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

	// NOTE: "Move it to the end" is only an edit where there is no end yet. A
	// Match that already closes with `case _` has this Case moved BELOW it,
	// which makes the `case _` the one that names no value — the report, one
	// Case further down.
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

		// NOTE: Two `literal-match-shape` reports stand here — this Case, and
		// the Match that now has no last Case — so the one under test is picked
		// by what it is about rather than by being first.
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

	// NOTE: Rewriting the body alone leaves the binder standing, and the binder
	// is what is refused — the Quick Fix has always made both edits.
	it("should name both halves of the edit", () => {
		expect(firstAnalysed(source, "redundant-pattern-binder").helps).toEqual(
			["Drop the 'as whole' and write '@' where 'whole' was meant."],
		)
	})

	// NOTE: One mistake, one report. The binder is DROPPED rather than bound, so
	// every read of the name below reported as a name nobody declared — this
	// mistake said again in words about a different one.
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
