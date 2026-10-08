import { describe, expect, it } from "bun:test"
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
import { compiles } from "./followedHelps"

// A Record's declared members decide its `Equatable` and `Printable`: each
// compares and prints through its own conformance, and one without takes the
// Record's away. The routing is a synthesised witness, so these specs run.
//
// `Tag`'s `is` ignores case, so "News" and "news" are one Tag but two Strings,
// and a routed answer differs visibly from a structural one.
const tag = `type Tag = { text: String }

	namespace Tags for Tag is Equatable {
		is(_ other: Tag) -> Boolean {
			<- @.text::is(other.text, comparing #Insensitive)
		}
	}

	constant news: Tag = { text = "News" }
	constant lower: Tag = { text = "news" }`

// A Choice whose payload holds a Tag, since a Case payload asks its members as
// a Record does.
const box = `choice Box {
		Full { tag: Tag },
		Hollow,
	}

	namespace Boxes for Box is Equatable {}`

// The printing receivers: a Choice that prints `Open` where the structural walk
// writes `Door#Open`, and a Record that prints `EUR 1999`.
const money = `choice Door { Open, Shut }

	namespace Doors for Door is Printable {}

	type Money = { cents: Integer }

	namespace Monies for Money is Printable {
		toString() -> String {
			<- "EUR {@.cents}"
		}
	}

	constant price: Money = { cents = 1999 }`

// A member whose conformance is ambiguous is reported, as it is for a List or
// a direct call, rather than compared structurally.
const ambiguous = `type Tag = { text: String }

	namespace TagsA for Tag is Equatable {
		is(_ other: Tag) -> Boolean {
			<- @.text::is(other.text, comparing #Insensitive)
		}
	}

	namespace TagsB for Tag is Equatable {
		is(_ other: Tag) -> Boolean {
			<- @.text::is(other.text)
		}
	}

	constant news: Tag = { text = "News" }
	constant lower: Tag = { text = "news" }`

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
	// A Record of Tags compares as a Tag and a List of Tags do.
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

	// `isNot` is its own emitted helper, since a witness's Methods are read
	// out one by one. Both answers are checked.
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

	// Only the members the static Type declares are routed. The same two
	// values compare one way at `{ tag: Tag }` and another at the top `Record`.
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

	// A Record value may carry more members than its Type sees. An extra member
	// on one side makes two Records unequal, checked in both directions, and
	// one on both sides is compared structurally.
	it("still refuses two Records with differing member sets", async () => {
		expect(
			await run(`implementation {
				${tag}

				function narrow(_ value: { tag: Tag }) -> { tag: Tag } {
					<- value
				}

				§ A literal Argument names only declared members, so the extra
				§ ones ride in on values.
				constant newsOne = { tag = news, extra = 1 }
				constant lowerOne = { tag = lower, extra = 1 }
				constant lowerTwo = { tag = lower, extra = 2 }

				Terminal.inspect(narrow(newsOne)::is({ tag = lower }))
				Terminal.inspect(narrow(newsOne)::is(narrow(lowerOne)))
				Terminal.inspect(narrow(newsOne)::is(narrow(lowerTwo)))
				Terminal.inspect(narrow({ tag = news })::is(narrow(lowerOne)))
			}`),
		).toEqual(["false", "true", "false", "false"])
	})

	// A Record literal written in another order is the same Record, so each
	// witness is found by member name.
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

	// The names line up with the witnesses by position, so the members are
	// declared out of alphabetical order. The two witnesses answer differently,
	// so a swap between them shows.
	it("reads its witnesses in the order the members were declared", async () => {
		expect(
			await run(`implementation {
				type Loose = { v: String }
				type Strict = { w: String }

				namespace Looses for Loose is Equatable {
					is(_ other: Loose) -> Boolean {
						<- @.v::is(other.v, comparing #Insensitive)
					}
				}

				namespace Stricts for Strict is Equatable {
					is(_ other: Strict) -> Boolean {
						<- @.w::is(other.w)
					}
				}

				type Pair = { zebra: Loose, apple: Strict }

				constant pair: Pair = { zebra = { v = "News" }, apple = { w = "x" } }
				constant loosely: Pair = { zebra = { v = "NEWS" }, apple = { w = "x" } }
				constant strictly: Pair = { zebra = { v = "News" }, apple = { w = "X" } }

				Terminal.inspect(pair::is(loosely))
				Terminal.inspect(pair::is(strictly))
				Terminal.inspect([pair = 1]::hasKey(loosely))
				Terminal.inspect([pair = 1]::hasKey(strictly))
			}`),
		).toEqual(["true", "false", "true", "false"])
	})

	// A nested Record routes as a whole through its own witness, which checks
	// its own member set.
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

	// Every container routes its items through their witness, so each must be
	// handed the Record's routing witness.
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

	// A bounded call reaches the routing through `solveConformance`, a direct
	// one through its resolved Method. Two levels of forwarding catch a witness
	// dropped at the second hop.
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

	// A Namespace written for the Record Type itself is more specific than the
	// builtin Record Namespace, so its `is` decides.
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

	// An `Optional<Tag>` member routes through the Choice's witness, which
	// routes its payload through Tag's.
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

	// No Namespace makes `Tag | Integer` Equatable, so the member refuses the
	// Record as such an item refuses a List.
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
			"Its member 'either' does not conform to 'Equatable'.",
			"Tag | Integer does not conform to 'Equatable'.",
		])
	})

	// An all-structural Record routes nothing and names `Record.is`. The
	// answer would be the same if it routed, so the emission is read.
	it("emits the plain native for a Record whose members are structural", () => {
		let js = generate(`implementation {
			constant point = { x = 1, y = 2 }

			Terminal.inspect(point::is({ x = 1, y = 2 }))
			Terminal.inspect([{ s = "a" }]::contains({ s = "a" }))
		}`)

		expect(js).not.toContain("boundRecordIs")
		expect(js).toContain("Record.is")
	})

	// A Record that routes names the helper, curried with the member names.
	// This catches a routing that does nothing where the answers would agree.
	it("emits the routing helper curried with the routed members", () => {
		let js = generate(`implementation {
			${tag}

			Terminal.inspect({ tag = news, count = 1 }::is({ tag = lower, count = 1 }))
		}`)

		expect(js).toContain(`boundRecordIs(["tag"])`)
	})
})

describe("A Record asks its declared members how to print", () => {
	// A Record printed for a reader asks its members' Namespaces, as a List and
	// a Dictionary do.
	it("prints each member through its own toString", async () => {
		expect(
			await run(`implementation {
				${money}

				Terminal.inspect({ price = price, door = Door#Open }::toString())
			}`),
		).toEqual(['"\\{ price = EUR 1999, door = Open \\}"'])
	})

	// Inside a composite a String keeps its quotes, and a whole Rational prints
	// its numerator alone. The printing list differs from the equality one.
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

	// `Terminal.inspect` is the structural rendering and asks for no
	// conformance, so the same Record reads two ways on purpose.
	it("leaves the structural rendering alone", async () => {
		expect(
			await run(`implementation {
				${money}

				Terminal.inspect({ price = price, door = Door#Open })
			}`),
		).toEqual(["{ price = { cents = 1999 }, door = Door#Open }"])
	})

	// A String hole renders through the `Printable` conformance a bounded call
	// is handed, so an interpolated Record routes too.
	it("routes through a String hole", async () => {
		expect(
			await run(`implementation {
				${money}

				constant held = { price = price }

				Terminal.inspect("{held}")
			}`),
		).toEqual(['"\\{ price = EUR 1999 \\}"'])
	})

	// The member renderers go into the one walk, so a long routed Record still
	// breaks one member to a line.
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

	// A Record that routes nothing prints through the plain native. The answer
	// is the same either way, so this reads the emission.
	it("emits the plain native where every member is structural", () => {
		let js = generate(`implementation {
			Terminal.print({ x = 1, name = "a" }::toString())
		}`)

		expect(js).not.toContain("boundRecordToString")
		expect(js).toContain("Record.toString")
	})

	// The `inspect` Help is offered only at a `Terminal.print`, where it is an
	// edit that compiles. It follows the call, not the Type, so a List of
	// Records gets it too.
	it("offers the inspect escape wherever a print is refused", () => {
		let printed = `implementation {
			constant run = (_ value: Integer) -> Integer { <- value }

			Terminal.print([{ run = run }])
		}`

		expect(codesOf(printed)).toEqual(["unsatisfied-conformance-condition"])
		expect(helpsOf(printed)[0]).toBe(
			"Write 'Terminal.inspect(…)' instead — it renders any value structurally and asks for no conformance.",
		)
		// The edit itself compiles.
		expect(
			compiles(`implementation {
				constant run = (_ value: Integer) -> Integer { <- value }

				Terminal.inspect([{ run = run }])
			}`),
		).toBe(true)
	})

	it("withholds it where inspect is no edit at all", () => {
		let direct = `implementation {
			constant run = (_ value: Integer) -> Integer { <- value }

			constant text = { run = run }::toString()

			Terminal.inspect(text)
		}`
		let held = `implementation {
			constant run = (_ value: Integer) -> Integer { <- value }

			constant text = [{ run = run }]::toString()

			Terminal.inspect(text)
		}`

		// The member's own conformance is still offered.
		let declare =
			"Declare a Namespace 'for (_: Integer) -> Integer is Printable'."

		expect(codesOf(direct)).toEqual(["unsatisfied-conformance-condition"])
		expect(helpsOf(direct)).toEqual([declare])
		expect(codesOf(held)).toEqual(["unsatisfied-conformance-condition"])
		expect(helpsOf(held)).toEqual([declare])
	})

	// A member whose Choice is not Printable takes the Record's printing away,
	// though the structural walk could print it.
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

	// A bare Case is typed as the Case. Nothing makes `Door` Printable, so
	// annotating at `Door` would not help, and the Help offers the Namespace,
	// which works with no annotation.
	it("offers the one edit a Case-typed member needs", () => {
		let source = `implementation {
			choice Door { Open, Shut }

			Terminal.print({ door = Door#Open })
		}`

		expect(helpsOf(source)).toEqual([
			"Write 'Terminal.inspect(…)' instead — it renders any value structurally and asks for no conformance.",
			"Declare a Namespace 'for Door is Printable' — its body may be empty, since a Choice whose Cases carry no payload prints as their names.",
		])
		expect(
			compiles(`implementation {
				choice Door { Open, Shut }

				namespace Doors for Door is Printable {}

				Terminal.print({ door = Door#Open })
			}`),
		).toBe(true)
	})

	// Where the Choice already conforms, the annotation is the whole edit. A
	// payload-free Choice derives `Enumerable`, which a bare Case does not.
	it("keeps the annotation where the Choice already conforms", () => {
		let source = `implementation {
			choice Colour { Red, Green }

			function countOf<infer T is Enumerable>(_ example: T) -> Integer {
				<- T.cases()::length()
			}

			Terminal.print(countOf(Colour#Red)::toString())
		}`

		expect(helpsOf(source)).toEqual([
			"Annotate the value at 'Colour': a bare Case binds the Case, not the Choice.",
		])
	})
})

describe("A Record whose member can not compare", () => {
	// The refusal reads like `List<Function>`'s, with one Note more that names
	// the member.
	it("is refused, naming the member", () => {
		let source = `implementation {
			constant run = (_ value: Integer) -> Integer { <- value }

			Terminal.inspect({ run = run, id = 1 }::is({ run = run, id = 1 }))
		}`

		expect(codesOf(source)).toEqual(["unsatisfied-conformance-condition"])
		// The chain's head repeats the message, so it is dropped. A `for`
		// clause names a Function Type as an annotation does.
		expect(notesOf(source)).toEqual([
			"Its member 'run' does not conform to 'Equatable'.",
			"(_: Integer) -> Integer does not conform to 'Equatable'.",
		])
		expect(helpsOf(source)).toEqual([
			"Declare a Namespace 'for (_: Integer) -> Integer is Equatable'.",
		])
	})

	it("compiles once the Namespace the Help asks for is declared", () => {
		expect(
			codesOf(`implementation {
				namespace SameRun for (_: Integer) -> Integer is Equatable {
					is(_ other: (_: Integer) -> Integer) -> Boolean {
						<- true
					}
				}

				constant run = (_ value: Integer) -> Integer { <- value }

				Terminal.inspect({ run = run, id = 1 }::is({ run = run, id = 1 }))
			}`),
		).toEqual([])
	})

	// The refusal names the dotted path, so the reader need not open the Types
	// to find which `run` was meant.
	it("names a nested member by its path", () => {
		let source = `implementation {
			constant run = (_ value: Integer) -> Integer { <- value }

			Terminal.inspect({ inner = { run = run } }::is({ inner = { run = run } }))
		}`

		expect(notesOf(source)).toEqual([
			"Its member 'inner.run' does not conform to 'Equatable'.",
			"(_: Integer) -> Integer does not conform to 'Equatable'.",
		])
	})

	// A bounded call is refused by the same rule, with the chain as the bound's
	// Notes.
	it("is refused at a bounded call too", () => {
		let source = `implementation {
			constant run = (_ value: Integer) -> Integer { <- value }

			Terminal.inspect([{ run = run }]::contains({ run = run }))
		}`

		expect(codesOf(source)).toEqual(["unsatisfied-conformance-condition"])
	})

	// The top `Record` declares no members, so it asks nothing and compares
	// structurally, Function member and all.
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

	// A Namespace shadowing `String` inside a Function hides the library's
	// `String`. The member is not Equatable there, so the Record is refused.
	it("is refused in a scope that shadows the member's Namespace", () => {
		let source = `implementation {
			function borrowers() -> Boolean {
				namespace String for NonEmptyString is Equatable {
					is(_ other: NonEmptyString) -> Boolean {
						<- true
					}
				}

				constant one: { name: NonEmptyString } = { name = "Ada" }
				constant two: { name: NonEmptyString } = { name = "ada" }

				<- one::is(two)
			}

			Terminal.inspect(borrowers())
		}`

		expect(codesOf(source)).toEqual(["unsatisfied-conformance-condition"])
		expect(notesOf(source)).toEqual([
			"Its member 'name' does not conform to 'Equatable'.",
			"String does not conform to 'Equatable'.",
		])
	})

	it("says so when a member's conformance can not be chosen", () => {
		let source = `implementation {
			${ambiguous}

			Terminal.inspect({ tag = news }::is({ tag = lower }))
		}`

		expect(codesOf(source)).toEqual(["ambiguous-conformance"])
		// The member's own Diagnostic, plus a Note naming the member that
		// reaches it.
		expect(notesOf(source)).toEqual([
			"'TagsA' conforms to 'Equatable'.",
			"'TagsB' conforms to 'Equatable'.",
			"Its member 'tag' is what asks { tag: Tag } to conform.",
		])
		expect(helpsOf(source)).toEqual([
			"Drop the conformance from one of them, or narrow one target Type so it is the more specific for Tag.",
		])
	})

	// The direct call reaches the member solve through `routedRecordCall`, the
	// bounded one through `solveConformance`.
	it("says so at a bounded call as well", () => {
		let source = `implementation {
			${ambiguous}

			Terminal.inspect([{ tag = news }]::contains({ tag = lower }))
		}`

		expect(codesOf(source)).toEqual(["ambiguous-conformance"])
	})

	// A member that holds the ambiguous Type: the List's own conformance fails,
	// and the Record still reports it.
	it("says so when a member merely holds the ambiguous Type", () => {
		let source = `implementation {
			${ambiguous}

			Terminal.inspect({ tags = [news] }::is({ tags = [lower] }))
		}`

		expect(codesOf(source)).toEqual(["ambiguous-conformance"])
		expect(notesOf(source).at(-1)).toBe(
			"Its member 'tags' is what asks { tags: List<Tag> } to conform.",
		)
	})

	// One Note per level, innermost first, each naming the Type it is about.
	it("names every level of a nested member in turn", () => {
		let source = `implementation {
			${ambiguous}

			Terminal.inspect(
				{ inner = { tag = news } }::is({ inner = { tag = lower } }),
			)
		}`

		expect(codesOf(source)).toEqual(["ambiguous-conformance"])
		expect(notesOf(source).slice(-2)).toEqual([
			"Its member 'tag' is what asks { tag: Tag } to conform.",
			"Its member 'inner' is what asks { inner: { tag: Tag } } to conform.",
		])
	})

	// `Terminal.inspect` asks for no conformance, so it stays total.
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
	// A non-generic Choice's derived `is` routes each payload member through
	// its own Type's conformance, as `Optional<Tag>` does.
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

	// The tag still decides the Case first, so two Cases with equal payloads
	// differ.
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

	// A composite payload member routes as a whole, through its own Type's
	// conformance.
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

	// A direct call carries the witnesses as pinned Generics, a bounded one as
	// the derived conformance's conditions. Both must fill the same slots.
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

	// Type Parameters take the first slots and routed members the next, so
	// `item` reads witness 0 and `tag` witness 1. The third line compares two
	// different Tags, which shows a swap.
	it("keeps a Type Parameter's slot in front of a routed member's", async () => {
		expect(
			await run(`implementation {
				${tag}

				choice Pair<Item> {
					Both { item: Item, tag: Tag },
					Neither,
				}

				Terminal.inspect(
					Pair<Integer>#Both({ item = 1, tag = news })::is(
						Pair<Integer>#Both({ item = 1, tag = lower }),
					),
				)
				Terminal.inspect(
					Pair<Integer>#Both({ item = 1, tag = news })::is(
						Pair<Integer>#Both({ item = 2, tag = news }),
					),
				)
				Terminal.inspect(
					Pair<Integer>#Both({ item = 1, tag = news })::is(
						Pair<Integer>#Both({ item = 1, tag = { text = "Sport" } }),
					),
				)
			}`),
		).toEqual(["true", "false", "false"])
	})

	// A Choice whose payload routes nothing keeps the flat helper. The
	// descriptor is built only where a member routes.
	it("emits the flat helper where no payload member routes", () => {
		// Through a Parameter, so `lower-unit-case-equality` has nothing
		// constant to fold and the helper stays in the emission.
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

	// A payload member with no equality means the Choice derives none, so the
	// Namespace is refused where it is written, and the call after it. The
	// second report is a cascade of the first.
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

	// The derive is withheld, so a bounded call finds the Choice not Equatable.
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

	// A Choice that names itself is refused before any conformance is asked,
	// so routing never meets a recursive payload.
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

	// An ambiguous payload member is reported without a Note naming it, since
	// the router sees only its Type. It is reported at the declaration and at
	// the call, as a member with no conformance is.
	it("says so when a payload member's conformance can not be chosen", () => {
		let source = `implementation {
			${ambiguous}

			choice Box {
				Full { tag: Tag },
				Hollow,
			}

			namespace Boxes for Box is Equatable {}

			Terminal.inspect(Box#Full({ tag = news })::is(Box#Full({ tag = lower })))
		}`

		expect(codesOf(source)).toEqual([
			"ambiguous-conformance",
			"ambiguous-conformance",
		])
		expect(new Set(helpsOf(source))).toEqual(
			new Set([
				"Drop the conformance from one of them, or narrow one target Type so it is the more specific for Tag.",
			]),
		)
	})
})

describe("A routed key and the comparison agree", () => {
	// A routing Record has a condition whose witness is unbranded, so
	// `boundConformance` brands none and `encodeKey` sends the key down the
	// scan path. The Dictionary and the comparison must agree.
	it("finds a routed Record key by the is its member writes", async () => {
		expect(
			await run(`implementation {
				${tag}

				constant held = [{ tag = news } = 1]

				Terminal.inspect(held::hasKey({ tag = lower }))
				Terminal.inspect(
					held::value(at { tag = lower })::is(Optional<Integer>#Value(1)),
				)
				Terminal.inspect([{ tag = news } = 1, { tag = lower } = 2]::length())
			}`),
		).toEqual(["true", "true", "1"])
	})

	// One level of generic forwarding, and two. A witness branded wrongly at
	// the second hop would open a second slot for one key.
	it("keeps the routing through two levels of forwarding", async () => {
		expect(
			await run(`implementation {
				${tag}

				function held<infer Key is Equatable>(_ key: Key, _ other: Key) -> Boolean {
					<- [key = 1]::hasKey(other)
				}

				function heldAgain<infer Key is Equatable>(
					_ key: Key,
					_ other: Key,
				) -> Boolean {
					<- held(key, other)
				}

				Terminal.inspect(held({ tag = news }, { tag = lower }))
				Terminal.inspect(heldAgain({ tag = news }, { tag = lower }))
				Terminal.inspect(heldAgain([{ tag = news }], [{ tag = lower }]))
			}`),
		).toEqual(["true", "true", "true"])
	})

	// Caller and callee name their Type Parameter alike, as in
	// `genericWitnessArity.spec.ts`, with a routed Record's own conditions.
	it("survives caller and callee naming their Parameter alike", async () => {
		expect(
			await run(`implementation {
				${tag}

				function inner<infer Item is Equatable>(_ a: Item, _ b: Item) -> Boolean {
					<- [a = 1]::hasKey(b)
				}

				function outer<infer Item is Equatable>(_ a: Item, _ b: Item) -> Boolean {
					<- inner(a, b)
				}

				Terminal.inspect(outer({ tag = news }, { tag = lower }))
			}`),
		).toEqual(["true"])
	})

	// A routed Case key, reached the same way.
	it("finds a routed Case key the same way", async () => {
		expect(
			await run(`implementation {
				${tag}
				${box}

				Terminal.inspect(
					[Box#Full({ tag = news }) = 1]::hasKey(Box#Full({ tag = lower })),
				)
			}`),
		).toEqual(["true"])
	})

	// An all-structural Record key is still branded and encoded. Both paths
	// answer alike, so this reads the emission.
	it("keeps an all-structural Record key branded and encoded", () => {
		let structural = generate(`implementation {
			Terminal.print([{ x = 1, name = "a" } = 1]::hasKey({ x = 1, name = "a" }))
		}`)

		expect(structural).toContain("structural: true")

		let routed = generate(`implementation {
			${tag}

			Terminal.print([{ tag = news } = 1]::hasKey({ tag = lower }))
		}`)

		expect(routed).not.toContain("structural: true")
	})
})

// Two routed Record Types whose witnesses differ only in the member names the
// helper is curried with. The constant pool must key witnesses by those names,
// or both Types would share one.
describe("Two Record Types routing the same member Type", () => {
	// A shared witness would fall through to `anyIs` for a name the value lacks
	// and answer false. All four rails of both Types are asked.
	it("answers each Type's questions with that Type's own members", async () => {
		expect(
			await run(`implementation {
				${tag}

				function same<infer T is Equatable>(_ x: T, _ y: T) -> Boolean {
					<- x::is(y)
				}

				type Figged = { fig: Tag }
				type Zebraed = { zebra: Tag }

				constant fig: Figged = { fig = news }
				constant figToo: Figged = { fig = lower }
				constant zebra: Zebraed = { zebra = news }
				constant zebraToo: Zebraed = { zebra = lower }

				Terminal.inspect(fig::is(figToo))
				Terminal.inspect(same(fig, figToo))
				Terminal.inspect([fig]::contains(figToo))
				Terminal.inspect([fig = 1]::hasKey(figToo))
				Terminal.inspect(zebra::is(zebraToo))
				Terminal.inspect(same(zebra, zebraToo))
				Terminal.inspect([zebra]::contains(zebraToo))
				Terminal.inspect([zebra = 1]::hasKey(zebraToo))
			}`),
		).toEqual([
			"true",
			"true",
			"true",
			"true",
			"true",
			"true",
			"true",
			"true",
		])
	})

	// Here `fig` is a Money in one Type and an Integer in the other. A shared
	// witness would call Money's `is` on an Integer and throw.
	it("does not hand one Type's witness to the other's member", async () => {
		expect(
			await run(`implementation {
				type Money = { cents: Integer, note: String }

				namespace Monies for Money is Equatable {
					is(_ other: Money) -> Boolean {
						<- @.cents::is(other.cents)
					}
				}

				function same<infer T is Equatable>(_ x: T, _ y: T) -> Boolean {
					<- x::is(y)
				}

				type Priced = { fig: Money, kiwi: String }
				type Counted = { fig: Integer, zebra: Money }

				constant priced: Priced = { fig = { cents = 5, note = "x" }, kiwi = "k" }
				constant pricedToo: Priced = { fig = { cents = 5, note = "y" }, kiwi = "k" }
				constant counted: Counted = { fig = 1, zebra = { cents = 5, note = "x" } }
				constant countedToo: Counted = { fig = 1, zebra = { cents = 5, note = "y" } }

				Terminal.inspect(same(priced, pricedToo))
				Terminal.inspect(counted::is(countedToo))
				Terminal.inspect(same(counted, countedToo))
				Terminal.inspect(counted::isNot(countedToo))
			}`),
		).toEqual(["true", "true", "true", "false"])
	})

	// The answers would also pass with the pool switched off, so the emission
	// is read: one pooled witness per member list.
	it("declares one pooled witness per routed member list", () => {
		let emitted = generate(`implementation {
			${tag}

			function same<infer T is Equatable>(_ x: T, _ y: T) -> Boolean {
				<- x::is(y)
			}

			type Figged = { fig: Tag }
			type Zebraed = { zebra: Tag }

			constant fig: Figged = { fig = news }
			constant zebra: Zebraed = { zebra = news }

			Terminal.print(same(fig, { fig = lower }))
			Terminal.print(same(zebra, { zebra = lower }))
		}`)

		expect(emitted).toContain(`boundRecordIs(["fig"])`)
		expect(emitted).toContain(`boundRecordIs(["zebra"])`)
	})
})
