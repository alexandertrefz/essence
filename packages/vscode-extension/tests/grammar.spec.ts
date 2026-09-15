import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

import grammar from "../syntaxes/essence.tmLanguage.json"

// NOTE: The grammar and the snippets are data an Editor reads, not code
// anything type-checks — a rule that never matches lights nothing and says so
// nowhere, which is the same silent failure `contribution.spec.ts` pins the
// manifest against.
//
// NOTE: The rules are read here with JavaScript's own RegExp rather than with
// Oniguruma, which is what VS Code runs them through. The two agree on
// everything these patterns use — a line anchor, `\b`, character classes and a
// lookahead — and the alternative is a tokenizer dependency for two regexes.
// Each subject is one LINE, because that is the unit a TextMate rule matches.

let repository = grammar.repository as Record<
	string,
	{ match?: string; patterns?: Array<{ match: string }> }
>

let controlKeyword = new RegExp(repository.controlKeyword!.match!)

// NOTE: Picked out by what it matches rather than by its index, so that a rule
// added beside it does not silently move the test onto another one. The needle
// is a piece of the rule's own pattern, which is the one thing about it that
// can not be shared with a neighbour.
function contextualKeyword(needle: string): RegExp {
	return new RegExp(
		repository
			.contextualKeyword!.patterns!.map((pattern) => pattern.match)
			.find((match) => match.includes(needle))!,
	)
}

// NOTE: `\G` anchors a documentation tag to the head of its line, and it is
// Oniguruma's alone — JavaScript's own RegExp reads it as a literal `G`. So it
// is dropped here, and what is left is read the way every other rule is.
function documentationTag(needle: string): RegExp {
	return new RegExp(
		repository
			.docComment!.patterns!.map((pattern) => pattern.match)
			.find((match) => match.includes(needle))!
			.replace("\\G ?", ""),
	)
}

let armAs = contextualKeyword("^[ \\t]*(as)")

describe("the define grammar", () => {
	it("lights both reserved Keywords on the word alone", () => {
		expect(controlKeyword.test("\t\t<- define {")).toBe(true)
		expect(controlKeyword.test('\t\t\tas "F" otherwise')).toBe(true)
	})

	// NOTE: The existing `as` rule wants an Identifier character immediately in
	// front of the whitespace, which an arm head — a line break and an indent —
	// can never offer. This is the rule that reads an arm as an arm.
	it("lights the as at the head of an arm", () => {
		expect(armAs.test('\t\t\tas "A" if score::isAbove(90)')).toBe(true)
		expect(armAs.test("\t\t\tas #Fail otherwise")).toBe(true)
		expect(armAs.test("\t\tas { total = 0 } if isEmpty")).toBe(true)
		expect(armAs.test("\t\tas -1 otherwise")).toBe(true)
	})

	// NOTE: `as` is an ordinary Identifier where no `define` block is open, and
	// the grammar cannot see blocks — so what keeps a value NAMED `as` unlit is
	// what follows it.
	it("leaves a line that assigns to a name called as unlit", () => {
		expect(armAs.test("as = 3")).toBe(false)
		expect(armAs.test("\tas::length()")).toBe(false)
		expect(armAs.test("\tas.member")).toBe(false)
		expect(armAs.test("\tconstant asset = 3")).toBe(false)
	})

	// NOTE: A binder and a label are still the other rule's business — an arm
	// head is the one `as` that stands at the start of its line.
	it("leaves a Pattern binder to the rule written for it", () => {
		expect(armAs.test("\tconstant { x as y } = point")).toBe(false)
		expect(armAs.test("\tnormalize(as #ComposedCanonical)")).toBe(false)
	})

	// NOTE: An Argument label stands at the head of its line too, whenever the
	// Formatter explodes the Argument list it belongs to — the line below is
	// this repo's own `StdlibExhaustive.es`, written by `esfmt`. What tells it
	// from an arm is the trailing comma the Formatter ends every exploded
	// Argument with, which an arm never carries.
	it("leaves a line-initial Argument label unlit", () => {
		expect(
			armAs.test("\t\tas NormalizationForm#DecomposedCanonical,"),
		).toBe(false)
		expect(armAs.test('\t\tas "a name",')).toBe(false)
		expect(armAs.test("\t\tas #Sensitive,")).toBe(false)
	})

	// NOTE: And the arm shapes the comma test must not turn away with it — a
	// Condition, an `otherwise`, and a value that carries on past the line.
	it("still lights an arm whose line ends in anything else", () => {
		expect(armAs.test("\t\t\tas [1, 2] if flag")).toBe(true)
		expect(armAs.test("\t\t\tas f(a, b) otherwise")).toBe(true)
		expect(armAs.test("\t\t\tas define {")).toBe(true)
	})
})

// NOTE: The vocabulary a tests section writes, none of it reserved: every one
// of these words is a valid Identifier, so every rule here is scoped by what
// stands around it. The subjects are lines out of `Tests.es`.
describe("the testing grammar", () => {
	let skipped = contextualKeyword("(skipped)")
	let tagged = contextualKeyword("(tagged)")
	let focused = contextualKeyword("\\b(focused)")
	let focusedAlone = contextualKeyword("^[ \\t]*(focused)")
	let across = contextualKeyword("(across)")
	let snapshot = contextualKeyword("(matches)")
	let forAny = contextualKeyword("(any)")

	it("lights the reason a skipped test carries", () => {
		expect(
			skipped.test('\t\t\tskipped "waiting on the Table redesign"'),
		).toBe(true)
		expect(skipped.test("\tconstant skipped = false")).toBe(false)
		expect(skipped.test("\t\t<- skipped::negate()")).toBe(false)
	})

	it("lights the names a tagged test selects on", () => {
		expect(
			tagged.test(
				'\t\ttest "sorts ten thousand rows" tagged slow, network {',
			),
		).toBe(true)
		expect(tagged.test("\tconstant tagged = false")).toBe(false)
		expect(tagged.test("\t\t<- tagged::length()")).toBe(false)
	})

	// NOTE: A `focused` carries nothing, so the brace of the item's own block is
	// what follows it.
	it("lights a focused test on the block behind it", () => {
		expect(
			focused.test('\t\t\ttest "calls a lower score a loss" focused {'),
		).toBe(true)
		expect(focused.test("\tconstant focused = false")).toBe(false)
		expect(focused.test("\t\t<- focused()")).toBe(false)
	})

	// NOTE: Or nothing at all, where the Formatter stood the Modifier on a line
	// of its own — and there NOTHING may stand in front of it, because ending
	// its line is not on its own a fact about a Modifier. A value read out of a
	// Constant ends a line the same way.
	it("lights a focused written on a line of its own, and nothing else", () => {
		expect(focusedAlone.test("\t\t\tfocused")).toBe(true)
		expect(focusedAlone.test("\t\tfocused\r")).toBe(true)
		expect(focusedAlone.test("\tconstant enabled = focused")).toBe(false)
		expect(focusedAlone.test("\t\t<- focused")).toBe(false)
		expect(focusedAlone.test('\ttest "a" focused')).toBe(false)
	})

	it("lights the across of a table test", () => {
		expect(across.test('\ttest "{scored} scores {points}" across [')).toBe(
			true,
		)
		expect(across.test("\tconstant across = 3")).toBe(false)
		expect(across.test("\t\t<- across(3)")).toBe(false)
	})

	// NOTE: The pair is the Keyword — neither word means anything alone — and
	// the `from` of a named snapshot is part of the same form.
	it("lights matches snapshot as the pair it is", () => {
		expect(
			snapshot.test('\t\t\texpect played.team matches snapshot "Lions"'),
		).toBe(true)
		expect(snapshot.test("\t\t\texpect table matches everything")).toBe(
			false,
		)
		expect(
			snapshot.exec(
				'\t\t\texpect table matches snapshot from "the-table"',
			)?.[3],
		).toBe("from")
	})

	it("lights the any of a property test", () => {
		expect(
			forAny.test(
				'\t\ttest "an outcome is worth what it scores" for any (',
			),
		).toBe(true)
		expect(
			controlKeyword.test('\t\ttest "a team always has a name" for any'),
		).toBe(true)
		expect(forAny.test("\tconstant any = 3")).toBe(false)
	})
})

// NOTE: The two Keywords asynchrony is written with. Both are ordinary
// Identifiers as well — the Parser reads the Keyword only where an Expression
// follows on the line — so the rule is scoped by what comes behind the word,
// exactly as `expect` and `require` are.
describe("the asynchrony grammar", () => {
	let asynchrony = contextualKeyword("(start|complete)")

	it("lights both Keywords in front of what they are written about", () => {
		expect(
			asynchrony.test(
				"\t\tconstant held = complete Async.deferred(() { <- value })",
			),
		).toBe(true)
		expect(
			asynchrony.test("\t\t<- complete headline(url)::retried(times 3)"),
		).toBe(true)
		expect(asynchrony.test("\tconstant running = start doubled(21)")).toBe(
			true,
		)
		expect(asynchrony.test("\tstart upload(file)")).toBe(true)
	})

	// NOTE: Every shape a value NAMED `start` or `complete` is written in — the
	// names the standard library and the fixtures used before the two words
	// became Keywords, which is what the contextual reading exists to keep
	// writable.
	it("leaves a value named after either of them unlit", () => {
		expect(asynchrony.test("\tconstant start = 1")).toBe(false)
		expect(asynchrony.test("\t\tconstant complete = false")).toBe(false)
		expect(asynchrony.test("\t\t<- start::isAbove(0)")).toBe(false)
		expect(asynchrony.test("\t\t<- range.start")).toBe(false)
		expect(asynchrony.test("\t\tf(start, other)")).toBe(false)
		expect(asynchrony.test("\t\t{ start = 1 }")).toBe(false)
		expect(asynchrony.test("\t\t{ start }")).toBe(false)
	})

	// NOTE: `\b` on both ends, so a name that merely opens with one of the words
	// is a name and nothing else.
	it("leaves a longer name that opens with one of them unlit", () => {
		expect(asynchrony.test("\t\tstarting(value)")).toBe(false)
		expect(asynchrony.test("\t\tcompleted::negate()")).toBe(false)
	})
})

// NOTE: A Guard is `where` written after the Matcher it guards, and the Match
// grammar could not light one whose Condition begins with a lowercase name —
// the rule it was left to reads what FOLLOWS the word, to keep the Argument
// label spelled the same unlit, and a lowercase name says nothing. These two
// read what stands in FRONT of it instead.
describe("the where grammar", () => {
	let whereGuard = contextualKeyword("(?<=[^\\s(,])[ \\t]+(where)")
	let whereLine = contextualKeyword("^[ \\t]*(where)")

	it("lights a Guard whose Condition is an ordinary Expression", () => {
		expect(
			whereGuard.test(
				'\t\tcase { x, y } where x::is(y) { <- "diagonal" }',
			),
		).toBe(true)
		expect(
			whereGuard.test('\t\tcase 0 where count::isNot(1) { <- "zero" }'),
		).toBe(true)
		expect(
			whereGuard.test("\t\tcase Integer where isNegative() { <- 0 }"),
		).toBe(true)
	})

	it("still lights a refinement and a conformance bound", () => {
		expect(
			whereGuard.test(
				"\ttype Digit = Integer where @::isBetween(0, and 9)",
			),
		).toBe(true)
		expect(
			whereGuard.test("\t\tis Comparable where Item is Comparable"),
		).toBe(true)
	})

	// NOTE: A label opens its Argument, so a `(` or a comma precedes it where a
	// Guard has the Matcher it guards.
	it("leaves an Argument label called where unlit", () => {
		expect(
			whereGuard.test(
				"\t\t\t::everyItem(where (item) { <- item::isEven() })",
			),
		).toBe(false)
		expect(whereGuard.test("\t\t<- @::count(of item, where check)")).toBe(
			false,
		)
	})

	it("leaves a value named where unlit", () => {
		expect(whereGuard.test("\tconstant where = 3")).toBe(false)
		expect(whereGuard.test("\t\t<- where::length()")).toBe(false)
		expect(whereGuard.test("\t\t<- where.member")).toBe(false)
	})

	// NOTE: The other line-initial `where` in the corpus is an exploded
	// Argument's label, and the trailing comma the Formatter writes is what
	// tells the two apart — the same test the `as` of an arm is told by.
	it("lights a Guard the Formatter broke onto its own line", () => {
		expect(
			whereLine.test("\t\t\t\t\t\twhere open::and(value::is(tile))"),
		).toBe(true)
	})

	it("leaves a line-initial Argument label unlit", () => {
		expect(
			whereLine.test(
				"\t\t\t\twhere (item) { <- check(item)::negate() },",
			),
		).toBe(false)
		expect(
			whereLine.test("\t\t\t\twhere check: (_: ItemType) -> Boolean,"),
		).toBe(false)
	})
})

describe("the documentation grammar", () => {
	let example = documentationTag("@example")

	// NOTE: An `@example` tag stands alone on its line — the assertions under
	// it are the example — so there is no em-dash separator to light beside it,
	// which is what the two tags above it carry.
	it("lights an @example tag", () => {
		expect(example.test("@example")).toBe(true)
		expect(example.test(" @example")).toBe(true)
		expect(example.test("@examples")).toBe(false)
	})
})

// NOTE: What a tab stop's placeholder stands as before anything is typed —
// which is the text a column in the body is aligned against.
function rendered(line: string): string {
	return line.replace(/\$\{\d+:([^}]*)\}/g, "$1")
}

// NOTE: Read and parsed rather than imported: `.code-snippets` is strict JSON
// under a name no bundler knows, and an import of it lands as nothing at all.
let snippets = JSON.parse(
	readFileSync(
		new URL("../snippets/essence.code-snippets", import.meta.url),
		"utf8",
	),
) as Record<string, { prefix: string; body: Array<string> }>

describe("the define snippet", () => {
	let snippet = snippets.define!

	it("writes a block that ends in an otherwise arm", () => {
		expect(snippet.prefix).toBe("define")
		expect(rendered(snippet.body.join("\n"))).toBe(
			[
				"define {",
				"\tas value if condition",
				"\tas value otherwise",
				"}",
			].join("\n"),
		)
	})

	// NOTE: The `match` snippet pads its second Matcher so that both case
	// braces stand in one column; an arm's two Keywords are the same question,
	// asked of `if` and `otherwise`.
	it("stands if and otherwise in one column", () => {
		let [, arm, otherwise] = snippet.body.map(rendered)

		expect(arm!.indexOf(" if ")).toBe(otherwise!.indexOf(" otherwise"))
	})
})
