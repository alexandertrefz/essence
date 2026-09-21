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

// NOTE: A bound Type Parameter is answered by a WITNESS handed in beside the
// Arguments, and a conditional conformance's witness is `boundConformance(<map>,
// [<witnesses>])` — one level per container. So a call binding `Key :=
// List<Item>` owes exactly one level, and a level too many hands `List::is` two
// items as if each were a List.
//
// That is what `nestedDistinct` below used to emit, and only when the CALLER's
// Type Parameter is spelled the same as the callee's: `createFreshenedInference`
// alpha-renames the callee's Generics for the span of one invocation, and
// `unfreshenBindings` puts the declared names back, after which the two `Key`s
// are one name. Substituting the invocation's own bindings into a binding the
// ARGUMENTS produced then rewrote the caller's Parameter along with the
// callee's, wrapping `List<Key>` into `List<List<Key>>`.
//
// The witness is the only thing that knows which `is`, `compare` or `toString`
// to run, so a wrong one is a wrong ANSWER rather than a wrong Type: with the
// standard library's structural `is` two different Lists compared equal, and
// with a written `is` that reads its value the Program died inside the String
// runtime. Every case here therefore asserts what the Program PRINTS, against
// the same question asked with no generics at all — which is the oracle,
// because the shapes this file is about all used to answer wrongly.
//
// NOTE: Two of the guards here are stronger than the rest, and deliberately so.
// A Dictionary reads a List key through the canonical encoding rather than
// through the witness, so a Program using only the standard library's `is`
// answers RIGHT even under a wrong witness — the encoding routes past the
// comparison the extra level breaks. What a wrong witness can not survive is
// the LEVEL COUNT read off the emitted text, and a WRITTEN `is`, `compare` or
// `toString` that the encoding has no shortcut for. Reverting the fix leaves
// the three plain-String cases green and turns those five red.

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

// NOTE: The emitted module is written to a throwaway file and imported, as in
// `hybridIntegers.spec.ts` — what is asserted is what the Program PRINTS.
async function outputOf(source: string): Promise<Array<string>> {
	let directory = mkdtempSync(join(tmpdir(), "essence-witness-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, generate(source))

	let written = ""
	let originalLog = console.log
	let originalOut = process.stdout.write

	console.log = (...args: Array<unknown>) => {
		written += `${args.map((argument) => String(argument)).join(" ")}\n`
	}

	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	try {
		await import(file)
	} finally {
		console.log = originalLog
		process.stdout.write = originalOut
		rmSync(directory, { recursive: true, force: true })
	}

	return written === "" ? [] : written.replace(/\n$/, "").split("\n")
}

// NOTE: One emitted Function, from its `function <name>(` line to the `}` that
// closes it in column one — the witness Expression is written across several
// lines, so counting on a single line would miss the second level exactly where
// it matters.
function bodyOf(generated: string, name: string): string {
	let lines = generated.split("\n")
	let start = lines.findIndex((line) => line.startsWith(`function ${name}(`))

	expect(start).toBeGreaterThanOrEqual(0)

	let end = lines.findIndex((line, index) => index > start && line === "}")

	expect(end).toBeGreaterThan(start)

	return lines.slice(start, end + 1).join("\n")
}

function levelsIn(body: string): number {
	return body.split("boundConformance").length - 1
}

// NOTE: A written `is` that READS its value, so a witness handed the wrong kind
// of value does not quietly answer `true` — it dies in the String runtime, which
// is what master does with the `nestedDistinct` shape.
const byLength = [
	"		namespace ByLength for NonEmptyString is Equatable {",
	"			is(_ other: NonEmptyString) -> Boolean {",
	"				<- @::length()::is(other::length())",
	"			}",
	"		}",
	"",
	'		constant ab: NonEmptyString = "ab"',
	'		constant cd: NonEmptyString = "cd"',
	'		constant c: NonEmptyString = "c"',
].join("\n")

const distinct = [
	"	function distinct<infer Item is Equatable>(",
	"		_ items: List<Item>,",
	"	) -> Integer {",
	"		<- items::removeDuplicates()::length()",
	"	}",
].join("\n")

function program(body: string): string {
	return `implementation {\n${body}\n}`
}

// NOTE: The Namespace, the three values and the calls all live inside a
// Function, because a Namespace written for a refinement has to be declared
// where it is used.
function inRun(body: string): string {
	return `	function run() -> {} {\n${byLength}\n\n${body}\n	}\n\n	run()`
}

describe("the witness a bound Type Parameter is handed", () => {
	describe("a Type Parameter bound to a List", () => {
		let source = program(
			[
				distinct,
				"	function nestedDistinct<infer Item is Equatable>(",
				"		_ items: List<List<Item>>,",
				"	) -> Integer {",
				"		<- distinct(items)",
				"	}",
				"",
				'	Terminal.inspect(nestedDistinct([["a"], ["b"]]))',
			].join("\n"),
		)

		// NOTE: `distinct`'s item Type is `List<Item>`, so the witness owed is
		// `boundConformance(List, [Item__conformance])` — ONE level. Read off
		// the emitted text rather than off the answer, because the answer can
		// be right for the wrong reason: a branded witness routes a List key
		// past the comparison the extra level would have broken.
		it("should carry one boundConformance level per container", () => {
			expect(levelsIn(bodyOf(generate(source), "nestedDistinct"))).toBe(1)
		})

		it("should count two different Lists as two", async () => {
			expect(await outputOf(source)).toEqual(["2"])
		})
	})

	// NOTE: The whole bug in two lines. `sameName` and `otherName` are the same
	// Function under two spellings of one Type Parameter, and only the spelling
	// that collides with the callee's used to answer wrongly.
	describe("a caller whose Type Parameter is spelled like the callee's", () => {
		it("should answer what the same Function under another name answers", async () => {
			expect(
				await outputOf(
					program(
						[
							distinct,
							"	function sameName<infer Item is Equatable>(",
							"		_ items: List<List<Item>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function otherName<infer Key is Equatable>(",
							"		_ items: List<List<Key>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							'	Terminal.inspect(sameName([["a"], ["b"]]))',
							'	Terminal.inspect(otherName([["a"], ["b"]]))',
						].join("\n"),
					),
				),
			).toEqual(["2", "2"])
		})
	})

	describe("the depth the Type Parameter stands at", () => {
		// NOTE: One, two and three containers between the Parameter and the
		// item — each level is a `boundConformance` the call has to curry, and
		// the fault multiplied them rather than counting them.
		it("should answer alike one, two and three deep", async () => {
			expect(
				await outputOf(
					program(
						[
							distinct,
							"	function one<infer Item is Equatable>(",
							"		_ items: List<List<Item>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function two<infer Item is Equatable>(",
							"		_ items: List<List<List<Item>>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function three<infer Item is Equatable>(",
							"		_ items: List<List<List<List<Item>>>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							'	Terminal.inspect(one([["a"], ["b"]]))',
							'	Terminal.inspect(two([[["a"]], [["b"]]]))',
							'	Terminal.inspect(three([[[["a"]]], [[["b"]]]]))',
						].join("\n"),
					),
				),
			).toEqual(["2", "2", "2"])
		})
	})

	describe("a witness forwarded before it is used", () => {
		// NOTE: Through one more Function, through two, and captured in a
		// closure — each hop re-solves the bound, so a hop that wrapped the
		// witness once would wrap it again.
		it("should answer alike through one hop, two hops and a closure", async () => {
			expect(
				await outputOf(
					program(
						[
							distinct,
							"	function hop<infer Item is Equatable>(",
							"		_ items: List<Item>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function twoHops<infer Item is Equatable>(",
							"		_ items: List<Item>,",
							"	) -> Integer {",
							"		<- hop(items)",
							"	}",
							"",
							"	function throughOne<infer Item is Equatable>(",
							"		_ items: List<List<Item>>,",
							"	) -> Integer {",
							"		<- hop(items)",
							"	}",
							"",
							"	function throughTwo<infer Item is Equatable>(",
							"		_ items: List<List<Item>>,",
							"	) -> Integer {",
							"		<- twoHops(items)",
							"	}",
							"",
							"	function viaClosure<infer Item is Equatable>(",
							"		_ items: List<List<Item>>,",
							"	) -> Integer {",
							"		constant ask = () -> Integer {",
							"			<- distinct(items)",
							"		}",
							"",
							"		<- ask()",
							"	}",
							"",
							inRun(
								[
									"		Terminal.inspect(throughOne([[ab], [cd]]))",
									"		Terminal.inspect(throughOne([[ab], [c]]))",
									"		Terminal.inspect(throughTwo([[ab], [cd]]))",
									"		Terminal.inspect(throughTwo([[ab], [c]]))",
									"		Terminal.inspect(viaClosure([[ab], [cd]]))",
									"		Terminal.inspect(viaClosure([[ab], [c]]))",
									"		Terminal.inspect([[ab], [cd]]::removeDuplicates()::length())",
									"		Terminal.inspect([[ab], [c]]::removeDuplicates()::length())",
								].join("\n"),
							),
						].join("\n"),
					),
				),
			).toEqual(["1", "2", "1", "2", "1", "2", "1", "2"])
		})
	})

	describe("a written witness whose answer differs from the structural one", () => {
		// NOTE: `ByLength` says "ab" is "cd" and is not "c". A witness one
		// level too deep hands it a List where it expects a String and dies
		// reading the String's characters — on master this Program does not
		// finish. The last pair is the same question with no generics, which is
		// what the six before it have to agree with.
		it("should run the written is at every depth", async () => {
			expect(
				await outputOf(
					program(
						[
							distinct,
							"	function nested<infer Item is Equatable>(",
							"		_ items: List<List<Item>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function deeper<infer Item is Equatable>(",
							"		_ items: List<List<List<Item>>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							inRun(
								[
									"		Terminal.inspect(nested([[ab], [cd]]))",
									"		Terminal.inspect(nested([[ab], [c]]))",
									"		Terminal.inspect(deeper([[[ab]], [[cd]]]))",
									"		Terminal.inspect(deeper([[[ab]], [[c]]]))",
									"		Terminal.inspect([[ab], [cd]]::removeDuplicates()::length())",
									"		Terminal.inspect([[ab], [c]]::removeDuplicates()::length())",
								].join("\n"),
							),
						].join("\n"),
					),
				),
			).toEqual(["1", "2", "1", "2", "1", "2"])
		})
	})

	describe("the container the Type Parameter is bound to", () => {
		// NOTE: Every generic shape the language has, each holding the
		// `ByLength` String so a wrong witness shows as a wrong count rather
		// than as two values that happen to compare equal. The last pair is the
		// oracle: the same two values, no generics anywhere.
		it("should answer alike for every one of them", async () => {
			expect(
				await outputOf(
					program(
						[
							"	choice Holder<ItemType> {",
							"		Full { value: ItemType },",
							"		Bare,",
							"	}",
							"",
							"	namespace Boxes<infer Item> for { value: Item }",
							"		is Equatable where Item is Equatable",
							"	{",
							"		is(_ other: { value: Item }) -> Boolean {",
							"			<- @.value::is(other.value)",
							"		}",
							"	}",
							"",
							distinct,
							"	function viaList<infer Item is Equatable>(",
							"		_ items: List<List<Item>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function viaNonEmptyList<infer Item is Equatable>(",
							"		_ items: List<NonEmptyList<Item>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function viaOptional<infer Item is Equatable>(",
							"		_ items: List<Optional<Item>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function viaResult<infer Item is Equatable>(",
							"		_ items: List<Result<Item, String>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function viaHolder<infer Item is Equatable>(",
							"		_ items: List<Holder<Item>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function viaBox<infer Item is Equatable>(",
							"		_ items: List<{ value: Item }>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function viaDictionaryValue<infer Item is Equatable>(",
							"		_ items: List<Dictionary<String, Item>>,",
							"	) -> Integer {",
							"		<- distinct(items)",
							"	}",
							"",
							"	function tabulate<infer Item is Equatable>(",
							"		_ keys: List<List<Item>>,",
							"	) -> Integer {",
							"		constant empty: Dictionary<List<Item>, Integer> = [=]",
							"",
							"		<- keys::reduce(startingWith empty, (memo, key) {",
							"			<- memo::set(key, to 1)",
							"		})::length()",
							"	}",
							"",
							inRun(
								[
									"		constant sameOptionals: List<Optional<NonEmptyString>> = [",
									"			Optional#Value(ab),",
									"			Optional#Value(cd),",
									"		]",
									"		constant differingOptionals: List<Optional<NonEmptyString>> = [",
									"			Optional#Value(ab),",
									"			Optional#Value(c),",
									"		]",
									"		constant sameResults: List<Result<NonEmptyString, String>> = [",
									"			Result#Value(ab),",
									"			Result#Value(cd),",
									"		]",
									"		constant differingResults: List<Result<NonEmptyString, String>> = [",
									"			Result#Value(ab),",
									"			Result#Value(c),",
									"		]",
									"		constant sameHolders: List<Holder<NonEmptyString>> = [",
									"			Holder#Full(ab),",
									"			Holder#Full(cd),",
									"		]",
									"		constant differingHolders: List<Holder<NonEmptyString>> = [",
									"			Holder#Full(ab),",
									"			Holder#Full(c),",
									"		]",
									"",
									"		Terminal.inspect(viaList([[ab], [cd]]))",
									"		Terminal.inspect(viaList([[ab], [c]]))",
									"		Terminal.inspect(viaNonEmptyList([[ab], [cd]]))",
									"		Terminal.inspect(viaNonEmptyList([[ab], [c]]))",
									"		Terminal.inspect(viaOptional(sameOptionals))",
									"		Terminal.inspect(viaOptional(differingOptionals))",
									"		Terminal.inspect(viaResult(sameResults))",
									"		Terminal.inspect(viaResult(differingResults))",
									"		Terminal.inspect(viaHolder(sameHolders))",
									"		Terminal.inspect(viaHolder(differingHolders))",
									"		Terminal.inspect(viaBox([{ value = ab }, { value = cd }]))",
									"		Terminal.inspect(viaBox([{ value = ab }, { value = c }]))",
									'		Terminal.inspect(viaDictionaryValue([["k" = ab], ["k" = cd]]))',
									'		Terminal.inspect(viaDictionaryValue([["k" = ab], ["k" = c]]))',
									"		Terminal.inspect(tabulate([[ab], [cd]]))",
									"		Terminal.inspect(tabulate([[ab], [c]]))",
									"		Terminal.inspect([[ab], [cd]]::removeDuplicates()::length())",
									"		Terminal.inspect([[ab], [c]]::removeDuplicates()::length())",
								].join("\n"),
							),
						].join("\n"),
					),
				),
			).toEqual([
				"1",
				"2",
				"1",
				"2",
				"1",
				"2",
				"1",
				"2",
				"1",
				"2",
				"1",
				"2",
				"1",
				"2",
				"1",
				"2",
				"1",
				"2",
			])
		})
	})

	describe("the Protocol the bound names", () => {
		// NOTE: Equatable is not the only conditional conformance a container
		// carries. `Backwards` orders "a" above "b" and `Shout` renders a
		// String as its own uppercase, so `sort`, `highestItem`, `join` and an
		// interpolation each answer something the structural witness never
		// would — and each of them reaches the witness through the same
		// forwarding. Every nested answer is asserted beside the direct one.
		it("should carry Comparable and Printable the same way", async () => {
			expect(
				await outputOf(
					program(
						[
							"	function rankOf(_ s: NonEmptyString) -> Integer {",
							'		if s::is("a") {',
							"			<- 2",
							"		} else {",
							"			<- 1",
							"		}",
							"	}",
							"",
							"	function ordered<infer Item is Comparable>(",
							"		_ items: List<Item>,",
							"	) -> List<Item> {",
							"		<- items::sort()",
							"	}",
							"",
							"	function highest<infer Item is Comparable>(",
							"		_ items: List<Item>,",
							"		defaultingTo fallback: Item,",
							"	) -> Item {",
							"		<- items::highestItem()::value(defaultingTo fallback)",
							"	}",
							"",
							"	function spelled<infer Item is Printable>(",
							"		_ items: List<Item>,",
							"	) -> String {",
							'		<- items::join(with "|")',
							"	}",
							"",
							"	function interpolated<infer Item is Printable>(",
							"		_ item: Item,",
							"	) -> String {",
							'		<- "[{item}]"',
							"	}",
							"",
							"	function orderedNested<infer Item is Comparable>(",
							"		_ items: List<List<Item>>,",
							"	) -> List<List<Item>> {",
							"		<- ordered(items)",
							"	}",
							"",
							"	function highestNested<infer Item is Comparable>(",
							"		_ items: List<List<Item>>,",
							"		defaultingTo fallback: List<Item>,",
							"	) -> List<Item> {",
							"		<- highest(items, defaultingTo fallback)",
							"	}",
							"",
							"	function spelledNested<infer Item is Printable>(",
							"		_ items: List<List<Item>>,",
							"	) -> String {",
							"		<- spelled(items)",
							"	}",
							"",
							"	function interpolatedNested<infer Item is Printable>(",
							"		_ item: List<Item>,",
							"	) -> String {",
							"		<- interpolated(item)",
							"	}",
							"",
							"	function run() -> {} {",
							"		namespace Backwards for NonEmptyString is Comparable {",
							"			compare(to other: NonEmptyString) -> Ordering {",
							"				<- rankOf(@)::compare(to rankOf(other))",
							"			}",
							"		}",
							"",
							"		namespace Shout for NonEmptyString is Printable {",
							"			toString() -> String {",
							"				<- @::uppercase()",
							"			}",
							"		}",
							"",
							'		constant a: NonEmptyString = "a"',
							'		constant b: NonEmptyString = "b"',
							"",
							'		Terminal.print(orderedNested([[a], [b]])::join(with ","))',
							'		Terminal.print(ordered([[a], [b]])::join(with ","))',
							"		Terminal.print(",
							'			highestNested([[a], [b]], defaultingTo [a])::join(with ","),',
							"		)",
							"		Terminal.print(",
							'			highest([[a], [b]], defaultingTo [a])::join(with ","),',
							"		)",
							"		Terminal.print(spelledNested([[a], [b]]))",
							"		Terminal.print(spelled([[a], [b]]))",
							"		Terminal.print(interpolatedNested([a, b]))",
							"		Terminal.print(interpolated([a, b]))",
							'		Terminal.print([[a], [b]]::sort()::join(with ","))',
							'		Terminal.print([[a], [b]]::join(with "|"))',
							"	}",
							"",
							"	run()",
						].join("\n"),
					),
				),
			).toEqual([
				'["b"],["a"]',
				'["b"],["a"]',
				"A",
				"A",
				'["a"]|["b"]',
				'["a"]|["b"]',
				'[["a", "b"]]',
				'[["a", "b"]]',
				'["b"],["a"]',
				'["a"]|["b"]',
			])
		})
	})
})
