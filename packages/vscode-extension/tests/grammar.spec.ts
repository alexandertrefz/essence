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
// added beside it does not silently move the test onto another one.
let armAs = new RegExp(
	repository
		.contextualKeyword!.patterns!.map((pattern) => pattern.match)
		.find((match) => match.startsWith("^"))!,
)

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
