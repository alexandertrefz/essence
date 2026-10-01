import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

import grammar from "../syntaxes/essence.tmLanguage.json"

// Nothing type-checks the grammar or the snippets, and a rule that never
// matches fails silently, so their rules are pinned here.
//
// The rules are read with JavaScript's RegExp rather than Oniguruma, which VS
// Code uses. The two agree on what these patterns use: a line anchor, `\b`,
// character classes and a lookahead. Each subject is one line, the unit a
// TextMate rule matches.

let repository = grammar.repository as Record<
	string,
	{ match?: string; patterns?: Array<{ match: string }> }
>

let controlKeyword = new RegExp(repository.controlKeyword!.match!)

// Found by a piece of its own pattern rather than by index, so a rule added
// beside it cannot move the test onto another.
function contextualKeyword(needle: string): RegExp {
	return new RegExp(
		repository
			.contextualKeyword!.patterns!.map((pattern) => pattern.match)
			.find((match) => match.includes(needle))!,
	)
}

// `\G` anchors a documentation tag to the head of its line. JavaScript's
// RegExp reads it as a literal `G`, so it is dropped here.
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

	// The other `as` rule needs an Identifier character before the
	// whitespace, which an arm head at the start of a line never has.
	it("lights the as at the head of an arm", () => {
		expect(armAs.test('\t\t\tas "A" if score::isAbove(90)')).toBe(true)
		expect(armAs.test("\t\t\tas #Fail otherwise")).toBe(true)
		expect(armAs.test("\t\tas { total = 0 } if isEmpty")).toBe(true)
		expect(armAs.test("\t\tas -1 otherwise")).toBe(true)
	})

	// Outside a `define` block `as` is an ordinary Identifier. The grammar
	// cannot see blocks, so what follows a value named `as` keeps it unlit.
	it("leaves a line that assigns to a name called as unlit", () => {
		expect(armAs.test("as = 3")).toBe(false)
		expect(armAs.test("\tas::length()")).toBe(false)
		expect(armAs.test("\tas.member")).toBe(false)
		expect(armAs.test("\tconstant asset = 3")).toBe(false)
	})

	// A binder and a label belong to the other rule; only an arm head stands
	// at the start of its line.
	it("leaves a Pattern binder to the rule written for it", () => {
		expect(armAs.test("\tconstant { x as y } = point")).toBe(false)
		expect(armAs.test("\tnormalize(as #ComposedCanonical)")).toBe(false)
	})

	// An Argument label also starts its line when the formatter explodes an
	// Argument list, as in `StdlibExhaustive.es`. Its trailing comma, which an
	// arm never has, tells the two apart.
	it("leaves a line-initial Argument label unlit", () => {
		expect(
			armAs.test("\t\tas NormalizationForm#DecomposedCanonical,"),
		).toBe(false)
		expect(armAs.test('\t\tas "a name",')).toBe(false)
		expect(armAs.test("\t\tas #Sensitive,")).toBe(false)
	})

	// Arms with a Condition, an `otherwise`, or a value that goes on past the
	// line still light.
	it("still lights an arm whose line ends in anything else", () => {
		expect(armAs.test("\t\t\tas [1, 2] if flag")).toBe(true)
		expect(armAs.test("\t\t\tas f(a, b) otherwise")).toBe(true)
		expect(armAs.test("\t\t\tas define {")).toBe(true)
	})
})

// The words a tests section writes are all valid Identifiers, so each rule is
// scoped by what stands around it. The subjects are lines from `Tests.es`.
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

	// A `focused` carries nothing, so its item's block brace follows it.
	it("lights a focused test on the block behind it", () => {
		expect(
			focused.test('\t\t\ttest "calls a lower score a loss" focused {'),
		).toBe(true)
		expect(focused.test("\tconstant focused = false")).toBe(false)
		expect(focused.test("\t\t<- focused()")).toBe(false)
	})

	// Or nothing, where the formatter put the Modifier on its own line. Then
	// nothing may precede it, since a value read from a Constant also ends a
	// line.
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

	// The pair is the Keyword, and a named snapshot's `from` belongs to it.
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

// The Keywords of asynchrony, which are also ordinary Identifiers. The Parser
// reads a Keyword only where an Expression follows on the same line, so the
// rule is scoped by what follows the word. Each case matches `opensAsynchrony`.
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

	// Every shape a value named `start` or `complete` is written in, which
	// the contextual reading keeps writable.
	it("leaves a value named after either of them unlit", () => {
		expect(asynchrony.test("\tconstant start = 1")).toBe(false)
		expect(asynchrony.test("\t\tconstant complete = false")).toBe(false)
		expect(asynchrony.test("\t\t<- start::isAbove(0)")).toBe(false)
		expect(asynchrony.test("\t\t<- range.start")).toBe(false)
		expect(asynchrony.test("\t\tf(start, other)")).toBe(false)
		expect(asynchrony.test("\t\t{ start = 1 }")).toBe(false)
		expect(asynchrony.test("\t\t{ start }")).toBe(false)
	})

	// `\b` on both ends, so a name that opens with one of the words is a name.
	it("leaves a longer name that opens with one of them unlit", () => {
		expect(asynchrony.test("\t\tstarting(value)")).toBe(false)
		expect(asynchrony.test("\t\tcompleted::negate()")).toBe(false)
	})

	// Tokens that continue a name rather than open an Expression: `start (1)`
	// calls a Function named `start`, `.price` reads a member, and `§` opens a
	// Comment.
	it("leaves a name the following Token carries on unlit", () => {
		expect(asynchrony.test("\t\tconstant x = start (1)")).toBe(false)
		expect(asynchrony.test("\t\tconstant x = 1::complete (2)")).toBe(false)
		expect(asynchrony.test("\t\tconstant held = complete .price")).toBe(
			false,
		)
		expect(
			asynchrony.test("\t\tconstant held = start § put it in flight"),
		).toBe(false)
	})

	// Tokens that begin an Expression but only stand where one has ended, as
	// `opensAsynchrony` excludes them. The word before them is a name.
	it("leaves a name an ending Token stands behind unlit", () => {
		expect(asynchrony.test("\t\tif start {")).toBe(false)
		expect(asynchrony.test("\t\tmatch start -> Integer {")).toBe(false)
		expect(
			asynchrony.test("\t\tconstant moved = { start with x = 3 }"),
		).toBe(false)
		expect(asynchrony.test("\t\t\tas complete otherwise")).toBe(false)
	})

	// A word that ends its line is a name, as the Parser reads it; the next
	// line is a Statement of its own.
	it("leaves a word that ends its line unlit", () => {
		expect(asynchrony.test("\t\tconstant held = start")).toBe(false)
		expect(asynchrony.test("\t\tconstant held = complete")).toBe(false)
	})
})

// A Guard is `where` after the Matcher it guards. A rule reading what follows
// `where` cannot tell a lowercase Condition from an Argument label, so these
// rules read what precedes it.
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

	// A label follows a `(` or a comma, where a Guard follows its Matcher.
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

	// A line-initial `where` may also be an exploded Argument's label, told
	// apart by its trailing comma, as for the `as` of an arm.
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

	// An `@example` tag stands alone on its line, with the example under it,
	// so it has no separator to light.
	it("lights an @example tag", () => {
		expect(example.test("@example")).toBe(true)
		expect(example.test(" @example")).toBe(true)
		expect(example.test("@examples")).toBe(false)
	})
})

// A line as it reads before anything is typed: each tab stop shows its
// placeholder, which the body's columns align against.
function rendered(line: string): string {
	return line.replace(/\$\{\d+:([^}]*)\}/g, "$1")
}

// Parsed rather than imported, since no bundler knows the `.code-snippets`
// extension.
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

	// As the `match` snippet aligns its case braces, this one aligns `if`
	// and `otherwise`.
	it("stands if and otherwise in one column", () => {
		let [, arm, otherwise] = snippet.body.map(rendered)

		expect(arm!.indexOf(" if ")).toBe(otherwise!.indexOf(" otherwise"))
	})
})

// The String Literal's escape rules, read in order: the Unicode escape, any
// other `\u`, then the short escapes and a catch-all. All begin with a
// backslash, so a subject is also checked against the rule before its own.
function stringPattern(needle: string): RegExp {
	return new RegExp(
		repository
			.string!.patterns!.map((pattern) => pattern.match)
			.find((match) => match !== undefined && match.includes(needle))!,
	)
}

let unicodeEscape = stringPattern("{1,6}")
let malformedUnicodeEscape = stringPattern("[0-9A-Fa-f]*")
let shortEscape = stringPattern('["\\\\nrt{}]')

describe("the string escape grammar", () => {
	it("lights a well-written Unicode escape", () => {
		for (let written of [
			'"\\u{0}"',
			'"\\u{1B}[0m"',
			'"\\u{1f600}"',
			'"\\u{10FFFF}"',
		]) {
			expect([written, unicodeEscape.test(written)]).toEqual([
				written,
				true,
			])
		}
	})

	// Every shape the compiler refuses reaches the invalid rule, because the
	// valid one before it does not match.
	it("marks every other shape of Unicode escape illegal", () => {
		for (let written of [
			'"caf\\u00e9"',
			'"\\u{}"',
			'"\\u{1G}"',
			'"\\u{0000041}"',
			'"\\u{1B"',
		]) {
			expect([written, unicodeEscape.test(written)]).toEqual([
				written,
				false,
			])
			expect([written, malformedUnicodeEscape.test(written)]).toEqual([
				written,
				true,
			])
		}
	})

	// An unclosed escape stops where the Lexer's scan stops: at the closing
	// quote, a backslash, a `{` or a line break. The coloured run is then
	// exactly the text the compiler refuses.
	it("stops an unclosed escape at every character the Lexer stops at", () => {
		for (let [written, lit] of [
			['"\\u{1B" + rest', "\\u{1B"],
			['"\\u{a\\tb"', "\\u{a"],
			['"\\u{a{ n }b"', "\\u{a"],
			['"\\u{1B\r"', "\\u{1B"],
			['"\\u{1B\nrest"', "\\u{1B"],
		] as Array<[string, string]>) {
			expect([written, malformedUnicodeEscape.exec(written)![0]]).toEqual(
				[written, lit],
			)
		}
	})

	it("lights all seven short escapes", () => {
		for (let written of [
			'\\"',
			"\\\\",
			"\\n",
			"\\r",
			"\\t",
			"\\{",
			"\\}",
		]) {
			expect([written, shortEscape.test(written)]).toEqual([
				written,
				true,
			])
		}
	})
})
