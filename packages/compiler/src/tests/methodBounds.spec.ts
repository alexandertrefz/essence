import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: A per-Method bound on a Namespace's own Type Parameter, end to end.
//
// NOTE: EVERY Protocol these Programs bound by is written out by hand, with an
// answer no structural derive would give: `is` compares LENGTHS, `compare`
// orders by length, `toString` SHOUTS. A missing witness, a witness for the
// wrong Parameter, or a witness in the wrong slot is silent — the call still
// runs and still answers something — and the only way to see one is to make the
// right answer and the wrong answer different values. Asserting the shape of the
// emitted call is the second half of that, and is done once below.

function compile(source: string): string {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		throw new Error("does not parse")
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		throw new Error(
			`does not enrich: ${enriched.diagnostics
				.map(
					(diagnostic) => `${diagnostic.code}: ${diagnostic.message}`,
				)
				.join(", ")}`,
		)
	}

	if (containsErrors(validate(enriched.program))) {
		throw new Error("does not validate")
	}

	return rewrite(optimise(simplify(enriched.program)))
}

// NOTE: Run in this process with `console.log` captured, the way the golden
// harness runs — these Programs suspend nothing, but the `await import` keeps
// them on the same rail as everything else that runs a compiled Program here.
async function run(source: string): Promise<Array<string>> {
	let directory = mkdtempSync(join(tmpdir(), "essence-method-bounds-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, compile(source))

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

function diagnosticsOf(source: string): Array<string> {
	let parsed = parseWithDiagnostics(source)

	return enrich(parsed.program).diagnostics.map(
		(diagnostic) => diagnostic.code ?? diagnostic.message,
	)
}

// NOTE: A `Word` ordered and compared by the LENGTH of its text, and shouted by
// its `toString`. Length order and alphabetical order disagree on the values
// every Program below uses, so the structural answer and this one are different
// Lists — which is what makes a wrong witness visible.
const words = `	type Word = { text: String }

	namespace Words for Word is Equatable, is Comparable, is Printable {
		compare(to other: Word) -> Ordering {
			<- @.text::length()::compare(to other.text::length())
		}

		is(_ other: Word) -> Boolean {
			<- @.text::length()::is(other.text::length())
		}

		toString() -> String {
			<- @.text::uppercase()
		}
	}
`

describe("A per-Method bound on a Namespace's Type Parameter", () => {
	it("bounds the Parameter for that Method and no other", async () => {
		expect(
			await run(`implementation {
	namespace Pairing<infer Item> for { left: Item, right: Item } {
		differing<Item is Equatable>() -> Boolean {
			<- @.left::isNot(@.right)
		}

		swapped() -> { left: Item, right: Item } {
			<- { left = @.right, right = @.left }
		}
	}

	Terminal.inspect({ left = 1, right = 2 }::differing())
	Terminal.inspect({ left = (_ x: Integer) -> Integer { <- x } , right = (_ x: Integer) -> Integer { <- x } }::swapped().left(1))
}`),
		).toEqual(["true", "1"])
	})

	// NOTE: A Function value is not Equatable, so the unbounded `swapped` above
	// accepts a receiver `differing` refuses. The bound reaches one Method.
	it("refuses the call whose receiver does not conform", () => {
		expect(
			diagnosticsOf(`implementation {
	namespace Pairing<infer Item> for { left: Item, right: Item } {
		differing<Item is Equatable>() -> Boolean {
			<- @.left::isNot(@.right)
		}
	}

	constant same = (_ x: Integer) -> Integer { <- x }

	Terminal.inspect({ left = same, right = same }::differing())
}`),
		).toEqual(["unsatisfied-bound"])
	})

	// NOTE: THE Program the campaign started from — `w_Hang.es`, which never
	// left the Enricher on master. It must answer, and answer 2.
	it("answers through a generic caller spelling its Parameter alike", async () => {
		expect(
			await run(`implementation {
	function distinct<infer Item is Equatable>(_ items: List<Item>) -> Integer {
		<- items::removeDuplicates()::length()
	}

	namespace Pairing<infer Item> for { left: Item, right: Item } {
		differing<Item is Equatable>() -> Integer {
			<- distinct([@.left, @.right])
		}
	}

	function viaNamespaceMethod<infer Item is Equatable>(
		_ pair: { left: List<Item>, right: List<Item> },
	) -> Integer {
		<- pair::differing()
	}

	Terminal.inspect(viaNamespaceMethod({ left = ["a"], right = ["b"] }))
}`),
		).toEqual(["2"])
	})

	it("passes the WRITTEN witness, not a structural one", async () => {
		expect(
			await run(`implementation {
${words}
	namespace Boxes<infer Item> for { items: List<Item> } {
		ordered<Item is Comparable>() -> List<Item> {
			<- @.items::sort()
		}

		shouted<Item is Printable>() -> String {
			<- "{@.items}"
		}

		sameEnds<Item is Equatable>() -> Boolean {
			<- @.items::firstItem()::is(@.items::lastItem())
		}
	}

	constant boxed = { items = [{ text = "zz" }, { text = "aaa" }, { text = "y" }] }

	Terminal.inspect(boxed::ordered()::map((word) { <- word.text }))
	Terminal.inspect(boxed::shouted())
	Terminal.inspect({ items = [{ text = "pq" }, { text = "rs" }] }::sameEnds())
}`),
		).toEqual([
			// NOTE: By LENGTH — alphabetically this is aaa, y, zz.
			'[ "y", "zz", "aaa" ]',
			// NOTE: Shouted, and by the written `toString` of each item.
			'"[ZZ, AAA, Y]"',
			// NOTE: Two different texts of the same length are EQUAL here.
			"true",
		])
	})

	// NOTE: The witness is an Argument, and this is the assertion that says so
	// in the emitted JavaScript rather than only through an answer. The Method
	// takes its receiver and one hidden conformance Argument, and the call site
	// hands over the Namespace that wrote the conformance.
	it("emits the witness as a hidden Argument at the call", () => {
		let javaScript = compile(`implementation {
${words}
	namespace Boxes<infer Item> for { items: List<Item> } {
		ordered<Item is Comparable>() -> List<Item> {
			<- @.items::sort()
		}
	}

	Terminal.inspect({ items = [{ text = "zz" }, { text = "y" }] }::ordered())
}`)

		// NOTE: The Method takes its receiver and ONE hidden conformance
		// Argument, and the call site hands over the conformance value built
		// from the Namespace that wrote `compare` — not a structural derive,
		// and not nothing.
		expect(javaScript).toMatch(/static ordered\(_self, Item__conformance\)/)
		expect(javaScript).toMatch(/Boxes\.ordered\([\s\S]*\$pool_\d+\)/)
		expect(javaScript).toContain("compare: Words.compare")
	})

	it("bounds one Overload entry and leaves its siblings open", async () => {
		expect(
			await run(`implementation {
${words}
	namespace Shelves<infer Item> for List<Item> {
		overload arranged {
			<Item is Comparable>() -> List<Item> {
				<- @::sort()
			}

			(by rank: (_ item: Item) -> Integer) -> List<Item> {
				<- @::sort(by (first, second) {
					<- rank(first)::compare(to rank(second))
				})
			}
		}
	}

	constant unsortable = [{ price = 20 }, { price = 5 }]

	Terminal.inspect([{ text = "zz" }, { text = "aaa" }, { text = "y" }]::arranged()::map((word) { <- word.text }))
	Terminal.inspect(unsortable::arranged(by .price)::map(.price))
}`),
		).toEqual(['[ "y", "zz", "aaa" ]', "[ 5, 20 ]"])
	})

	// NOTE: A static Method has no receiver, so nothing binds the Namespace's
	// Parameter at a call to one — the bound is retained all the same, and the
	// call says the Parameter can not be worked out rather than dropping the
	// requirement in silence.
	it("reports a static Method whose bound nothing can bind", () => {
		expect(
			diagnosticsOf(`implementation {
	namespace Boxes<infer Item> for List<Item> {
		static empty<Item is Comparable>() -> Integer {
			<- 0
		}
	}

	Terminal.inspect(Boxes.empty())
}`),
		).toEqual(["uninferable-type-parameter"])
	})

	// NOTE: A Method calling another of its own Namespace on `@` must carry the
	// bound the callee asks for. The caller's own bound is what satisfies it.
	it("threads the bound through a call on '@'", async () => {
		expect(
			await run(`implementation {
${words}
	namespace Boxes<infer Item> for { items: List<Item> } {
		ordered<Item is Comparable>() -> List<Item> {
			<- @.items::sort()
		}

		smallest<Item is Comparable>() -> Optional<Item> {
			<- @::ordered()::firstItem()
		}
	}

	constant boxed = { items = [{ text = "zz" }, { text = "y" }] }

	Terminal.inspect(boxed::smallest()::value(defaultingTo { text = "none" }).text)
}`),
		).toEqual(['"y"'])
	})

	it("refuses a call on '@' the caller's own bound does not cover", () => {
		expect(
			diagnosticsOf(`implementation {
	namespace Boxes<infer Item> for { items: List<Item> } {
		ordered<Item is Comparable>() -> List<Item> {
			<- @.items::sort()
		}

		anyOrder() -> List<Item> {
			<- @::ordered()
		}
	}

	Terminal.inspect(1)
}`),
		).toEqual(["unsatisfied-bound"])
	})

	it("refuses re-declaring the Parameter with no bound", () => {
		expect(
			diagnosticsOf(`implementation {
	namespace Boxes<infer Item> for List<Item> {
		held<Item>() -> Integer {
			<- 0
		}
	}

	Terminal.inspect(1)
}`),
		).toEqual(["shadowed-type-parameter"])
	})

	it("refuses a bound that restates 'infer'", () => {
		expect(
			diagnosticsOf(`implementation {
	namespace Boxes<infer Item> for List<Item> {
		ordered<infer Item is Comparable>() -> List<Item> {
			<- @::sort()
		}
	}

	Terminal.inspect(1)
}`),
		).toEqual(["restated-inferred-parameter"])
	})

	// NOTE: A Method that fulfils a requirement is promised by the conformance
	// unconditionally, so a bound of its own is a promise the Namespace can not
	// keep — the condition belongs on the conformance, and that is what the
	// report says.
	it("refuses a per-Method bound on a Method that fulfils a requirement", () => {
		expect(
			diagnosticsOf(`implementation {
	namespace Boxes<infer Item> for { items: List<Item> } is Printable {
		toString<Item is Printable>() -> String {
			<- "{@.items}"
		}
	}

	Terminal.inspect(1)
}`),
		).toContain("nonconforming-namespace")
	})

	// NOTE: The conformance's `where` and the Method's own bound name the same
	// Parameter and disagree. The conformance check gets there first and says
	// the Namespace does not conform — `show` fulfils `Shown`, so a bound of its
	// own was already refused for that reason alone, and the conflict never
	// reaches `conflicting-where-condition`. One report, and the one a reader
	// can act on.
	it("refuses a bound that conflicts with a conformance condition", () => {
		expect(
			diagnosticsOf(`implementation {
	protocol Shown {
		show() -> String
	}

	namespace Boxes<infer Item> for { items: List<Item> }
		is Shown where Item is Printable
	{
		show<Item is Comparable>() -> String {
			<- "a box"
		}
	}

	Terminal.inspect(1)
}`),
		).toEqual(["nonconforming-namespace"])
	})
})

// NOTE: Gap analysis A14 — a bounded generic Choice could never be given a
// Namespace, because the `for` line bound the Namespace's unbounded Parameter
// to the Choice's requirement and was refused. Every value of `SortedBox<X>`
// that can exist is already a proof that `X` is Comparable, so the bound is
// read off the target and holds for every Method, with the witness solved from
// the receiver at the call exactly as a written per-Method bound's is.
describe("A Namespace for a bounded generic Choice", () => {
	const sortedBox = `	choice SortedBox<Item is Comparable> {
		Box { items: List<Item> },
	}

	namespace Boxes<infer Item> for SortedBox<Item> {
		sorted() -> List<Item> {
			<- match @ -> List<Item> {
				case #Box(items) { <- items::sort() }
			}
		}
	}
`

	it("takes an unbounded Parameter and needs no restatement", () => {
		expect(
			diagnosticsOf(`implementation {
${sortedBox}
	Terminal.inspect(1)
}`),
		).toEqual([])
	})

	it("sorts through the WRITTEN witness of the receiver's items", async () => {
		expect(
			await run(`implementation {
${words}
${sortedBox}
	constant boxed = SortedBox<Word>#Box({
		items = [{ text = "zz" }, { text = "aaa" }, { text = "y" }],
	})

	Terminal.inspect(boxed::sorted()::map((word) { <- word.text }))
}`),
		).toEqual(['[ "y", "zz", "aaa" ]'])
	})

	// NOTE: The Namespace's Parameters CROSSED against the Choice's, which is
	// the only shape that can tell a bound read off the right position from one
	// read off a mirrored index — `SortedBox<Item is Comparable>` has a single
	// Parameter, so every spec above it is green either way. The bound belongs
	// to the Choice's FIRST Parameter, which this Namespace binds with its
	// SECOND: `orderedFirst` sorts and `orderedSecond` is refused, naming 'X'.
	const crossed = `	choice Pair<A is Comparable, B> {
		Both { a: A, b: B },
	}

	namespace Pairs<infer X, infer Y> for Pair<Y, X> {
		orderedFirst() -> List<Y> {
			<- match @ -> List<Y> {
				case #Both({ a, b }) { <- [a]::sort() }
			}
		}
	}
`

	it("maps a bound onto the Parameter the Choice's position binds", () => {
		expect(
			diagnosticsOf(`implementation {
${crossed}
	Terminal.inspect(1)
}`),
		).toEqual([])
	})

	it("refuses the Method whose Parameter the Choice leaves unbounded", () => {
		let reported = enrich(
			parseWithDiagnostics(`implementation {
	choice Pair<A is Comparable, B> {
		Both { a: A, b: B },
	}

	namespace Pairs<infer X, infer Y> for Pair<Y, X> {
		orderedSecond() -> List<X> {
			<- match @ -> List<X> {
				case #Both({ a, b }) { <- [b]::sort() }
			}
		}
	}

	Terminal.inspect(1)
}`).program,
		).diagnostics

		expect(
			reported.map((diagnostic) => [diagnostic.code, diagnostic.message]),
		).toEqual([
			[
				"unsatisfied-bound",
				"Type Parameter 'X' does not conform to 'Comparable'",
			],
		])
	})

	// NOTE: The Choice's own bound still holds where the Choice is USED — a
	// Namespace over it changes nothing about who may build one.
	it("still refuses a Type Argument the Choice's own bound rejects", () => {
		expect(
			diagnosticsOf(`implementation {
${sortedBox}
	constant boxed = SortedBox<(_ x: Integer) -> Integer>#Box({ items = [] })

	Terminal.inspect(1)
}`),
		).toContain("unsatisfied-bound")
	})
})
