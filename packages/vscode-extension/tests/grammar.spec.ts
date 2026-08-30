import { describe, expect, it } from "bun:test"
import grammar from "../syntaxes/essence.tmLanguage.json"

// NOTE: The grammar is data an Editor reads, not code anything type-checks — a
// rule that never matches lights nothing and says so nowhere, which is the same
// silent failure `contribution.spec.ts` pins the manifest against.
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
})
