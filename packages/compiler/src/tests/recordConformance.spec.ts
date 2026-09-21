import { describe, expect, it, setDefaultTimeout } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: A composite asks its members. A Record's DECLARED members decide its
// `Equatable` and its `Printable`: each one compares and prints through its own
// Namespace's conformance, and a member whose Type has none takes the Record's
// away. Every claim here is about a Program that RUNS — the routing is a witness
// the Compiler synthesises and hands over as hidden Arguments, so type-checking
// alone would say nothing about whether the right `is` was called.
//
// NOTE: `Tag` is the receiver most of this is written against: a Record whose
// Namespace writes a case-INSENSITIVE `is`, so that "News" and "news" are one
// Tag and two Strings. Nothing structural can answer that, which is what makes
// every routed answer visibly different from the unrouted one.
const tag = `type Tag = { text: String }

	namespace Tags for Tag is Equatable {
		is(_ other: Tag) -> Boolean {
			<- @.text::is(other.text, comparing #Insensitive)
		}
	}

	constant news: Tag = { text = "News" }
	constant lower: Tag = { text = "news" }`

// NOTE: And the Choice DECISION 3 is written against — a non-generic one whose
// payload holds a Tag, which is the pair the finding was reported on.
const box = `choice Box {
		Full { tag: Tag },
		Hollow,
	}

	namespace Boxes for Box is Equatable {}`

// NOTE: And the receiver the PRINTING half is written against: a Choice whose
// derived printing answers `Open` where the structural walk writes `Door#Open`,
// and a Record whose Namespace writes `EUR 1999` where the walk writes
// `{ cents = 1999 }`. Two members, two different reasons the walk is wrong.
const money = `choice Door { Open, Shut }

	namespace Doors for Door is Printable {}

	type Money = { cents: Integer }

	namespace Monies for Money is Printable {
		toString() -> String {
			<- "EUR {@.cents}"
		}
	}

	constant price: Money = { cents = 1999 }`

// NOTE: The first enrichment in a process compiles the whole standard library,
// which the five-second default does not always cover on a loaded machine — and
// a test that times out here never restores the `console.log` it patched, so the
// NEXT test reads an empty capture and the file fails twice for one reason. The
// repo's other slow specs set the same generous ceiling; nothing below is timed.
setDefaultTimeout(60_000)

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-record-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return parsed.diagnostics
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		return enriched.diagnostics
	}

	return validate(enriched.program)
}

function codesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.code ?? "")
}

function helpsOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.helps ?? [])
}

function notesOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.notes ?? [])
}

describe("A Record asks its declared members", () => {
	// NOTE: The whole finding in four lines. Before this, a Tag was equal to
	// another Tag, a List of Tags to a List of Tags, and a Record of Tags to
	// nothing — every composite in the language routed its members except the
	// one that is made of them.
	it("compares a member through the member's own is", async () => {
		expect(
			await run(`implementation {
				${tag}

				Terminal.inspect(news::is(lower))
				Terminal.inspect([news]::is([lower]))
				Terminal.inspect({ tag = news }::is({ tag = lower }))
				Terminal.inspect({ tag = news }::isNot({ tag = lower }))
			}`),
		).toEqual(["true", "true", "true", "false"])
	})

	// NOTE: `isNot` is its own emitted helper rather than a `!` put on `is` at
	// the call, because a witness's Methods are read out one by one — a
	// requirement fulfilled by an expression is a requirement fulfilled by
	// nothing. The pair is checked on both answers so a helper that forgot to
	// negate, and one that always negates, both show.
	it("keeps is and isNot exact complements", async () => {
		expect(
			await run(`implementation {
				${tag}

				constant other: Tag = { text = "Sport" }

				Terminal.inspect({ tag = news }::is({ tag = lower }))
				Terminal.inspect({ tag = news }::isNot({ tag = lower }))
				Terminal.inspect({ tag = news }::is({ tag = other }))
				Terminal.inspect({ tag = news }::isNot({ tag = other }))
			}`),
		).toEqual(["true", "false", "false", "true"])
	})

	// NOTE: THE WIDTH RULE. Only the members the static Type declares are
	// routed; a member it can not see is compared structurally, as it always
	// was. So the same two values compare one way at `{ tag: Tag }` and another
	// at the top `Record`, which is the price of asking a Type rather than a
	// value — and it is written down in `Record.es` because of this test.
	it("routes only what the static Type declares", async () => {
		expect(
			await run(`implementation {
				${tag}

				function narrow(_ value: { tag: Tag }) -> { tag: Tag } {
					<- value
				}

				function anyRecord(_ a: Record, _ b: Record) -> Boolean {
					<- a::is(b)
				}

				Terminal.inspect(narrow({ tag = news })::is({ tag = lower }))
				Terminal.inspect(anyRecord({ tag = news }, { tag = lower }))
				Terminal.inspect({}::is({}))
			}`),
		).toEqual(["true", "false", "true"])
	})

	// NOTE: The member SETS still have to match, which is the difference
	// between routing a Record and routing a Case payload: a Case's members are
	// fixed by its declaration, a Record's value may carry more than its Type
	// can see. An extra member on either side makes two Records unequal exactly
	// as it did before, and an extra member on BOTH is compared structurally.
	it("still refuses two Records with differing member sets", async () => {
		expect(
			await run(`implementation {
				${tag}

				function narrow(_ value: { tag: Tag }) -> { tag: Tag } {
					<- value
				}

				Terminal.inspect(narrow({ tag = news, extra = 1 })::is({ tag = lower }))
				Terminal.inspect(
					narrow({ tag = news, extra = 1 })::is(
						narrow({ tag = lower, extra = 1 }),
					),
				)
				Terminal.inspect(
					narrow({ tag = news, extra = 1 })::is(
						narrow({ tag = lower, extra = 2 }),
					),
				)
			}`),
		).toEqual(["false", "true", "false"])
	})

	// NOTE: Member ORDER is not a member of the answer. The routing is a list of
	// names and a list of witnesses, lined up by position, and a Record literal
	// written in another order is the same Record — so the walk has to find the
	// witness by NAME rather than by where the key happened to land.
	it("does not care what order the members were written in", async () => {
		expect(
			await run(`implementation {
				${tag}

				function narrow(
					_ value: { first: Tag, second: Tag },
				) -> { first: Tag, second: Tag } {
					<- value
				}

				Terminal.inspect(
					narrow({ first = news, second = lower })::is(
						{ second = news, first = lower },
					),
				)
			}`),
		).toEqual(["true"])
	})

	// NOTE: A nested Record routes AS A WHOLE, through its own — itself
	// conditional — witness, rather than being flattened into the outer one's
	// plan. That is what keeps the plan a flat list of names however deep the
	// Types go, and it is why the outer Record's own member set is checked by
	// the outer walk and the inner one's by the inner walk.
	it("routes a nested Record through its own witness", async () => {
		expect(
			await run(`implementation {
				${tag}

				Terminal.inspect(
					{ inner = { tag = news } }::is({ inner = { tag = lower } }),
				)
				Terminal.inspect(
					{ inner = { tag = news } }::is({ inner = { tag = news, x = 1 } }),
				)
			}`),
		).toEqual(["true", "false"])
	})

	// NOTE: Every composite the language has, holding a Record that routes.
	// Each of these was already routing its own items before this work — a List
	// through the item witness, a Dictionary through the value witness, a
	// generic Choice through its Type Argument's — and each was handed the
	// STRUCTURAL Record witness, which is the one link in the chain that lied.
	it("carries the routing through every container", async () => {
		expect(
			await run(`implementation {
				${tag}

				Terminal.inspect([{ tag = news }]::is([{ tag = lower }]))
				Terminal.inspect([{ tag = news }]::contains({ tag = lower }))
				Terminal.inspect(
					[{ tag = news }]::firstIndex(of { tag = lower })::is(#Value(0)),
				)
				Terminal.inspect(
					[{ tag = news }, { tag = lower }]::removeDuplicates()::length(),
				)
				Terminal.inspect(
					Optional<{ tag: Tag }>#Value({ tag = news })::is(
						Optional<{ tag: Tag }>#Value({ tag = lower }),
					),
				)
				Terminal.inspect(["k" = { tag = news }]::is(["k" = { tag = lower }]))
			}`),
		).toEqual(["true", "true", "true", "1", "true", "true"])
	})

	// NOTE: A bounded call reaches the routing through `solveConformance` and a
	// direct one through the Method it resolved; the two are different rails and
	// they have to answer alike. Two levels of forwarding, because a witness
	// that is right at the first hop and dropped at the second is a bug the one
	// hop can not see.
	it("answers the same through a bounded call and two levels of it", async () => {
		expect(
			await run(`implementation {
				${tag}

				function same<infer Item is Equatable>(_ a: Item, _ b: Item) -> Boolean {
					<- a::is(b)
				}

				function sameAgain<infer Item is Equatable>(
					_ a: Item,
					_ b: Item,
				) -> Boolean {
					<- same(a, b)
				}

				Terminal.inspect(same({ tag = news }, { tag = lower }))
				Terminal.inspect(sameAgain({ tag = news }, { tag = lower }))
				Terminal.inspect(sameAgain([{ tag = news }], [{ tag = lower }]))
			}`),
		).toEqual(["true", "true", "true"])
	})

	// NOTE: A Namespace written for the RECORD TYPE ITSELF still wins, exactly
	// as it did: the routing is what the BUILTIN Record Namespace conforms by,
	// and a Namespace targeting a concrete shape is the more specific candidate.
	// Routing that beat a written `is` would be the worst outcome of this whole
	// change — a Program's own answer silently replaced by the Compiler's.
	it("leaves a written Namespace for the Record Type deciding", async () => {
		expect(
			await run(`implementation {
				${tag}

				namespace Holders for { tag: Tag } is Equatable {
					is(_ other: { tag: Tag }) -> Boolean {
						<- false
					}
				}

				Terminal.inspect({ tag = news }::is({ tag = news }))
			}`),
		).toEqual(["false"])
	})

	// NOTE: A member whose Type is a Choice with a conditional conformance —
	// an `Optional<Tag>` — routes through that Choice's own witness, which
	// routes its payload through Tag's. Two levels of routing, and the answer
	// has to be Tag's `is` at the bottom of them.
	it("routes an Optional member through its payload's own is", async () => {
		expect(
			await run(`implementation {
				${tag}

				function narrow(
					_ value: { maybe: Optional<Tag> },
				) -> { maybe: Optional<Tag> } {
					<- value
				}

				Terminal.inspect(
					narrow({ maybe = Optional<Tag>#Value(news) })::is(
						narrow({ maybe = Optional<Tag>#Value(lower) }),
					),
				)
				Terminal.inspect(
					narrow({ maybe = Optional<Tag>#Empty })::is(
						narrow({ maybe = Optional<Tag>#Empty }),
					),
				)
			}`),
		).toEqual(["true", "true"])
	})

	// NOTE: And a member whose Type is a bare STRUCTURAL Union is refused, for
	// the reason a `List<Tag | Integer>` is refused today: no Namespace makes
	// `Tag | Integer` Equatable, so there is no `is` for the member to be routed
	// through. The Record's story and the List's are the same story, which is
	// the whole point of decision 2 — and this is the case that proves it is,
	// because it is the one a reader is most likely to meet by accident.
	it("refuses a member whose Union has no conformance, as a List is", () => {
		let source = `implementation {
			${tag}

			function narrow(
				_ value: { either: Tag | Integer },
			) -> { either: Tag | Integer } {
				<- value
			}

			Terminal.inspect(narrow({ either = news })::is(narrow({ either = 1 })))
		}`

		expect(codesOf(source)).toEqual(["unsatisfied-conformance-condition"])
		expect(notesOf(source)).toEqual([
			"{ either: Tag | Integer } does not conform to 'Equatable'.",
			"Its member 'either' does not conform to 'Equatable'.",
			"Tag | Integer does not conform to 'Equatable'.",
		])
	})

	// NOTE: The all-structural path, which has to stay EXACTLY where it was:
	// nothing routes, the witness is the plain builtin one, and the emitted
	// JavaScript names `Record.is` rather than a helper. The emission is read
	// rather than the answer, because the answer is the same either way and
	// would not notice a Record that routed its Integers through Integer's own
	// `is` at a cost nobody asked for.
	it("emits the plain native for a Record whose members are structural", () => {
		let js = generate(`implementation {
			constant point = { x = 1, y = 2 }

			Terminal.inspect(point::is({ x = 1, y = 2 }))
			Terminal.inspect([{ s = "a" }]::contains({ s = "a" }))
		}`)

		expect(js).not.toContain("boundRecordIs")
		expect(js).toContain("Record.is")
	})

	// NOTE: And the other side of it — a Record that DOES route names the helper
	// and curries it with the member names. A mutant that routed nothing passes
	// every equality test above by accident where the members happen to agree,
	// and fails this one outright.
	it("emits the routing helper curried with the routed members", () => {
		let js = generate(`implementation {
			${tag}

			Terminal.inspect({ tag = news, count = 1 }::is({ tag = lower, count = 1 }))
		}`)

		expect(js).toContain(`boundRecordIs(["tag"])`)
	})
})

describe("A Record asks its declared members how to print", () => {
	// NOTE: Decision 4 read from the other side. The structural walk writes a
	// Case as `Door#Open` and a `Money` as `{ cents = 1999 }`; the Namespaces
	// that own them answer `Open` and `EUR 1999`. A Record printed for a READER
	// asks them, which is what `[EUR 1999]` and `["k" = EUR 1999]` have always
	// done for a List and a Dictionary holding the same value.
	it("prints each member through its own toString", async () => {
		expect(
			await run(`implementation {
				${money}

				Terminal.inspect({ price = price, door = Door#Open }::toString())
			}`),
		).toEqual(['"\\{ price = EUR 1999, door = Open \\}"'])
	})

	// NOTE: A String member keeps its quotes, because inside a composite the
	// quoted form is what every reader already gets — `[ "a" ]`, `{ name = "a" }`
	// — and routing a String through its own `toString` would take them away.
	// A whole Rational member still prints its numerator alone. Both are claims
	// about the printing list being different from the equality one.
	it("keeps a String quoted and a whole Rational bare", async () => {
		expect(
			await run(`implementation {
				${money}

				Terminal.inspect(
					{ name = "a", ratio = 1/2::add(1/2), price = price }::toString(),
				)
			}`),
		).toEqual(['"\\{ name = \\"a\\", ratio = 1, price = EUR 1999 \\}"'])
	})

	// NOTE: `Terminal.inspect` is the STRUCTURAL rendering and stays exactly
	// where it was — it asks for no conformance, so it can not ask a member for
	// one. The same Record therefore reads two ways on purpose, and this is the
	// test that holds the two apart.
	it("leaves the structural rendering alone", async () => {
		expect(
			await run(`implementation {
				${money}

				Terminal.inspect({ price = price, door = Door#Open })
			}`),
		).toEqual(["{ price = { cents = 1999 }, door = Door#Open }"])
	})

	// NOTE: A String hole renders its value through the very `Printable`
	// conformance a bounded call is handed, so an interpolated Record routes
	// too — and that is the rail `Terminal.print` itself is written on.
	it("routes through a String hole", async () => {
		expect(
			await run(`implementation {
				${money}

				constant held = { price = price }

				Terminal.inspect("{held}")
			}`),
		).toEqual(['"\\{ price = EUR 1999 \\}"'])
	})

	// NOTE: The layout is not forked — the member renderers go INTO the one
	// walk. So a routed Record past the sixty-character budget still breaks one
	// member to a line, still indents what it nests, and a routed member's own
	// multi-line answer is re-indented where it stands.
	it("keeps the layout rules a long Record has always had", async () => {
		expect(
			await run(`implementation {
				${money}

				Terminal.inspect(
					{
						first = price,
						second = price,
						third = price,
						fourth = price,
					}::toString(),
				)
			}`),
		).toEqual([
			'"\\{\\n    first = EUR 1999,\\n    second = EUR 1999,\\n    third = EUR 1999,\\n    fourth = EUR 1999\\n\\}"',
		])
	})

	// NOTE: And the Record that routes NOTHING prints through the native it
	// always did. Read off the emission, because the answer is the same either
	// way and would not notice the cost.
	it("emits the plain native where every member is structural", () => {
		let js = generate(`implementation {
			Terminal.print({ x = 1, name = "a" }::toString())
		}`)

		expect(js).not.toContain("boundRecordToString")
		expect(js).toContain("Record.toString")
	})

	// NOTE: A member whose Choice nobody declared Printable takes the Record's
	// printing away, which is decision 2 reaching further than a Function does:
	// this is a Record that prints today.
	it("is refused where a member's Choice is not Printable", () => {
		let source = `implementation {
			choice Door { Open, Shut }

			function narrow(_ value: { door: Door }) -> { door: Door } {
				<- value
			}

			Terminal.print(narrow({ door = Door#Open }))
		}`

		expect(codesOf(source)).toEqual(["unsatisfied-conformance-condition"])
		expect(helpsOf(source)[0]).toBe(
			"Write 'Terminal.inspect(…)' instead — it renders any value structurally and asks for no conformance.",
		)
		expect(helpsOf(source)[1]).toBe(
			"Declare a Namespace 'for Door is Printable' — its body may be empty, since a Choice whose Cases carry no payload prints as their names.",
		)
	})
})

describe("A Record whose member can not compare", () => {
	// NOTE: Decision 2, and it reads like `List<Function>`'s refusal on purpose:
	// the same `unsatisfied-conformance-condition`, the same because-chain shape,
	// with one sentence more that NAMES the member. A reader who has met the one
	// has met the other.
	it("is refused, naming the member", () => {
		let source = `implementation {
			constant run = (_ value: Integer) -> Integer { <- value }

			Terminal.inspect({ run = run, id = 1 }::is({ run = run, id = 1 }))
		}`

		expect(codesOf(source)).toEqual(["unsatisfied-conformance-condition"])
		expect(notesOf(source)).toEqual([
			"{ run: (_: Integer) -> Integer, id: Integer } does not conform to 'Equatable'.",
			"Its member 'run' does not conform to 'Equatable'.",
			"(_: Integer) -> Integer does not conform to 'Equatable'.",
		])
	})

	// NOTE: The DOTTED PATH, which is the whole reason the refusal carries a
	// path rather than a name: a reader given `run` has to open two Types to
	// find which `run` was meant, and a reader given `inner.run` has to open
	// none.
	it("names a nested member by its path", () => {
		let source = `implementation {
			constant run = (_ value: Integer) -> Integer { <- value }

			Terminal.inspect({ inner = { run = run } }::is({ inner = { run = run } }))
		}`

		expect(notesOf(source)).toEqual([
			"{ inner: { run: (_: Integer) -> Integer } } does not conform to 'Equatable'.",
			"Its member 'inner.run' does not conform to 'Equatable'.",
			"(_: Integer) -> Integer does not conform to 'Equatable'.",
		])
	})

	// NOTE: A bounded call is refused by the same rule, through the rail that
	// was already there — the chain becomes the notes of the bound's own
	// Diagnostic, which is how `List<Function>` has always read.
	it("is refused at a bounded call too", () => {
		let source = `implementation {
			constant run = (_ value: Integer) -> Integer { <- value }

			Terminal.inspect([{ run = run }]::contains({ run = run }))
		}`

		expect(codesOf(source)).toEqual(["unsatisfied-conformance-condition"])
	})

	// NOTE: And the one that must NOT be refused: the top `Record` declares no
	// members, so it routes nothing and asks nothing. A Program that puts such a
	// value behind a `Record` Parameter keeps the structural answer it always
	// had, Function member and all.
	it("compares at the top Record Type, Function member and all", async () => {
		expect(
			await run(`implementation {
				constant run = (_ value: Integer) -> Integer { <- value }

				function anyRecord(_ a: Record, _ b: Record) -> Boolean {
					<- a::is(b)
				}

				constant holder = { run = run, id = 1 }

				Terminal.inspect(anyRecord(holder, holder))
				Terminal.inspect(anyRecord(holder, { run = run, id = 2 }))
			}`),
		).toEqual(["true", "false"])
	})

	// NOTE: `Terminal.inspect` stays TOTAL — it asks for no conformance at all,
	// which is what makes it the Help the refusal offers first.
	it("can still be inspected", async () => {
		expect(
			await run(`implementation {
				constant run = (_ value: Integer) -> Integer { <- value }

				Terminal.inspect({ run = run, id = 1 })
			}`),
		).toEqual(["{ run = Function, id = 1 }"])
	})
})

describe("A Case payload asks its members", () => {
	// NOTE: DECISION 3 — one rule for every derived composite. A generic
	// Choice's derived `is` already routed its Type Parameters through the
	// witnesses a call hands in; a NON-generic one compared every payload
	// structurally, so `Box#Full({ tag = a })` and `Box#Full({ tag = b })` were
	// unequal while `Optional<Tag>#Value(a)` and `Optional<Tag>#Value(b)` were
	// equal. Same rule, one level down: the member is routed through its own
	// Type's conformance, through the descriptor machinery that was already
	// there rather than a second one.
	it("compares a non-generic Choice's payload through the member's own is", async () => {
		expect(
			await run(`implementation {
				${tag}
				${box}

				Terminal.inspect(
					Optional<Tag>#Value(news)::is(Optional<Tag>#Value(lower)),
				)
				Terminal.inspect(
					Box#Full({ tag = news })::is(Box#Full({ tag = lower })),
				)
				Terminal.inspect(Box#Full({ tag = news })::is(Box#Hollow))
				Terminal.inspect(
					Box#Full({ tag = news })::isNot(Box#Full({ tag = lower })),
				)
			}`),
		).toEqual(["true", "true", "false", "false"])
	})

	// NOTE: The tag still decides the Case FIRST and nominally — routing a
	// payload must not make two different Cases carrying equal payloads equal.
	it("still decides the Case by its tag", async () => {
		expect(
			await run(`implementation {
				${tag}

				choice Pair {
					Left { tag: Tag },
					Right { tag: Tag },
				}

				namespace Pairs for Pair is Equatable {}

				Terminal.inspect(
					Pair#Left({ tag = news })::is(Pair#Right({ tag = lower })),
				)
				Terminal.inspect(
					Pair#Left({ tag = news })::is(Pair#Left({ tag = lower })),
				)
			}`),
		).toEqual(["false", "true"])
	})

	// NOTE: A payload member that is a composite routes AS A WHOLE, through the
	// conformance of the Type it is — a List through List's own `is` carrying
	// Tag's witness, a Record through the Record routing one level further down.
	it("routes a composite payload member through that composite's witness", async () => {
		expect(
			await run(`implementation {
				${tag}

				choice Bag {
					Some { tags: List<Tag>, held: { tag: Tag } },
					None,
				}

				namespace Bags for Bag is Equatable {}

				Terminal.inspect(
					Bag#Some({ tags = [news], held = { tag = news } })::is(
						Bag#Some({ tags = [lower], held = { tag = lower } }),
					),
				)
			}`),
		).toEqual(["true"])
	})

	// NOTE: Both rails again, and for a Choice they are further apart than for a
	// Record: a direct call carries the witnesses as the fabricated Method's own
	// pinned Generics, a bounded one as the derived conformance's conditions.
	// Same descriptor, same slots, or the Arguments shift.
	it("answers the same through a bounded call", async () => {
		expect(
			await run(`implementation {
				${tag}
				${box}

				function same<infer Item is Equatable>(_ a: Item, _ b: Item) -> Boolean {
					<- a::is(b)
				}

				Terminal.inspect(same(Box#Full({ tag = news }), Box#Full({ tag = lower })))
				Terminal.inspect([Box#Full({ tag = news })]::contains(Box#Full({ tag = lower })))
				Terminal.inspect([Box#Full({ tag = news }) = 1]::hasKey(Box#Full({ tag = lower })))
			}`),
		).toEqual(["true", "true", "true"])
	})

	// NOTE: And a Choice whose payload routes NOTHING keeps the flat helper it
	// always had — the whole reason the descriptor is built only where the
	// router found a slot.
	it("emits the flat helper where no payload member routes", () => {
		// NOTE: Through a Parameter rather than two written Cases, so that the
		// Optimiser's `lower-unit-case-equality` has nothing constant to fold
		// the comparison into and the helper the witness names is still there
		// to read.
		let js = generate(`implementation {
			choice Note {
				Text { body: String },
				Empty,
			}

			namespace Notes for Note is Equatable {}

			function same(_ a: Note, _ b: Note) -> Boolean {
				<- a::is(b)
			}

			Terminal.print(same(Note#Text({ body = "a" }), Note#Empty))
		}`)

		expect(js).not.toContain("boundChoiceIs")
		expect(js).toContain("choiceIs")
	})

	// NOTE: Decision 3's other half. A payload member with no equality means
	// the Choice derives none, so `namespace Handlers for Handler is Equatable
	// {}` is refused where it is WRITTEN — `nonconforming-namespace`, the same
	// Diagnostic a Namespace that declares a conformance and writes none of it
	// has always had. The call is refused after it, because the bound the
	// routing put on the derived Method has nothing to bind either.
	//
	// RESIDUAL: one mistake, two reports. Both sentences are true and they name
	// two different edits, but the second is a cascade of the first and the
	// house rule is one report per mistake. Listed in the report.
	it("refuses a call whose payload member can not compare", () => {
		let source = `implementation {
			choice Handler {
				On { run: (_ value: Integer) -> Integer },
				Off,
			}

			namespace Handlers for Handler is Equatable {}

			function same(_ a: Handler, _ b: Handler) -> Boolean {
				<- a::is(b)
			}

			Terminal.print(same(Handler#Off, Handler#Off))
		}`

		expect(codesOf(source)).toEqual([
			"nonconforming-namespace",
			"unsatisfied-bound",
		])
	})

	// NOTE: And the bounded rail refuses the same Program, through the rail
	// that was already there: the derive is withheld, so nothing makes the
	// Choice Equatable and the bound has nothing to bind.
	it("refuses a bounded call over such a Choice too", () => {
		let source = `implementation {
			choice Handler {
				On { run: (_ value: Integer) -> Integer },
				Off,
			}

			namespace Handlers for Handler is Equatable {}

			Terminal.print([Handler#Off]::contains(Handler#Off))
		}`

		expect(codesOf(source)).toEqual([
			"nonconforming-namespace",
			"nonconforming-namespace",
		])
	})

	// NOTE: RECURSION. The brief expected a self slot here and there is nothing
	// to build one for: this language refuses a Choice that names itself, and a
	// generic one that does, and two that name each other — before any
	// conformance is ever asked about. The router still tells the cycle guard's
	// refusal from a real one, because a Type Argument could close a loop the
	// declaration checker never sees; this test is what says the declaration is
	// refused, so that a reader meeting the NOTE knows why it has no companion.
	it("has no recursive Choice to route, because the language has none", () => {
		expect(
			codesOf(`implementation {
				choice Tree {
					Node { children: List<Tree> },
					Leaf,
				}

				Terminal.print(Tree#Leaf::is(Tree#Leaf))
			}`),
		).toContain("recursive-type-declaration")
	})
})
