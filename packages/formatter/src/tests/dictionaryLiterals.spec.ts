import { describe, expect, it } from "bun:test"

import { format } from "../index"

// The written forms of a Dictionary: the literal, the empty one, and the update
// in either of its forms. Every test is a round trip over formatted source. The
// safety gate refuses output whose re-parse differs, so a form printed back as
// something else shows as a refusal rather than a diff.
//
// An entry is two Expressions and a `=`, so a Dictionary has twice as many
// places for a `§` as a List. Each has to come back where it was written.

function block(...lines: Array<string>): string {
	return ["implementation {", ...lines, "}", ""].join("\n")
}

function roundTrips(source: string): void {
	let once = format(source)
	let twice = format(once.text)

	expect(once.refusal).toBeNull()
	expect(once.text).toBe(source)
	expect(twice.text).toBe(once.text)
}

describe("Dictionary literals", () => {
	describe("the written forms", () => {
		it("round-trips a Literal", () => {
			roundTrips(block('\tconstant ages = ["alex" = 39, "sam" = 25]'))
		})

		it("round-trips the empty Dictionary", () => {
			roundTrips(
				block("\tconstant ages: Dictionary<String, Integer> = [=]"),
			)
		})

		it("round-trips an update that sets entries", () => {
			roundTrips(
				block(
					'\tconstant ages = ["alex" = 39]',
					"",
					'\tconstant older = [ages with "alex" = 40, "kim" = 7]',
				),
			)
		})

		it("round-trips an update that merges a whole Dictionary", () => {
			roundTrips(
				block(
					'\tconstant ages = ["alex" = 39]',
					"",
					'\tconstant more = ["kim" = 7]',
					"",
					"\tconstant both = [ages with more]",
				),
			)
		})

		// `{ record with other }` and `[dictionary with other]` are one node
		// shape, so the brackets come from the node.
		it("keeps a Record's update in braces", () => {
			roundTrips(
				block(
					'\tconstant config = { port = 1, host = "db" }',
					"",
					"\tconstant moved = { config with port = 2 }",
				),
			)
		})
	})

	describe("layout", () => {
		it("breaks one entry to a line, with a trailing comma", () => {
			let source = block(
				"\tconstant ages = [",
				'\t\t"alexander" = 39,',
				'\t\t"samantha" = 25,',
				'\t\t"kimberley" = 7,',
				'\t\t"christopher" = 51,',
				"\t]",
			)

			roundTrips(source)
		})

		// A List of Numbers fills, but a Dictionary never does, since an entry
		// is two values and a `=`.
		it("never fills a Dictionary of Numbers", () => {
			let source = block(
				"\tconstant scores = [",
				"\t\t1 = 10,",
				"\t\t2 = 20,",
				"\t\t3 = 30,",
				"\t\t4 = 40,",
				"\t\t5 = 50,",
				"\t\t6 = 60,",
				"\t\t7 = 70,",
				"\t\t8 = 80,",
				"\t\t9 = 90,",
				"\t]",
			)

			roundTrips(source)
		})

		it("hugs a short update onto one line", () => {
			let result = format(
				block(
					'\tconstant ages = ["alex" = 39]',
					"",
					"\tconstant older = [",
					"\t\tages with",
					'\t\t\t"alex" = 40',
					"\t]",
				),
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				block(
					'\tconstant ages = ["alex" = 39]',
					"",
					'\tconstant older = [ages with "alex" = 40]',
				),
			)
		})

		it("opens an update too wide for its line", () => {
			let source = block(
				'\tconstant ages = ["alexander" = 39]',
				"",
				"\tconstant older = [",
				"\t\tages with",
				'\t\t\t"alexander" = 40,',
				'\t\t\t"christopher" = 51,',
				'\t\t\t"kimberley" = 7,',
				"\t]",
			)

			roundTrips(source)
		})
	})

	describe("comments", () => {
		it("keeps a Comment above an entry", () => {
			roundTrips(
				block(
					"\tconstant ages = [",
					"\t\t§ the eldest",
					'\t\t"alex" = 39,',
					'\t\t"sam" = 25,',
					"\t]",
				),
			)
		})

		it("keeps a Comment trailing an entry", () => {
			roundTrips(
				block(
					"\tconstant ages = [",
					'\t\t"alex" = 39, § the eldest',
					'\t\t"sam" = 25,',
					"\t]",
				),
			)
		})

		it("keeps a Comment below the last entry", () => {
			roundTrips(
				block(
					"\tconstant ages = [",
					'\t\t"alex" = 39,',
					"\t\t§ and nobody else yet",
					"\t]",
				),
			)
		})

		it("keeps a Comment among an update's entries", () => {
			roundTrips(
				block(
					'\tconstant ages = ["alex" = 39]',
					"",
					"\tconstant older = [",
					"\t\tages with",
					"\t\t\t§ a birthday",
					'\t\t\t"alex" = 40,',
					"\t]",
				),
			)
		})

		// A Comment anywhere in the entries forces the break, as in a List.
		it("breaks a Literal a Comment was written into", () => {
			let result = format(
				block(
					"\tconstant ages = [",
					"\t\t§ the eldest",
					'\t\t"alex" = 39]',
				),
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				block(
					"\tconstant ages = [",
					"\t\t§ the eldest",
					'\t\t"alex" = 39,',
					"\t]",
				),
			)
		})

		// A Comment trailing the opening bracket has no place in the Printer,
		// so the gate refuses the file. The List case is pinned beside it.
		it("refuses a Comment trailing the opening bracket, as a List does", () => {
			let dictionary = format(
				block("\tconstant ages = [§ the eldest", '\t\t"alex" = 39]'),
			)
			let list = format(
				block("\tconstant ages = [§ the eldest", "\t\t39]"),
			)

			expect(dictionary.refusal?.kind).toBe("unsafe")
			expect(list.refusal?.kind).toBe("unsafe")
			expect(dictionary.changed).toBe(false)
		})
	})

	describe("what must never be rewritten", () => {
		// `[=]` prints as one token, which the `=` tells from the empty List.
		it("never opens the empty Dictionary", () => {
			let result = format(
				block(
					"\tconstant ages: Dictionary<String, Integer> = [",
					"\t\t=",
					"\t]",
				),
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				block("\tconstant ages: Dictionary<String, Integer> = [=]"),
			)
		})

		it("never turns the empty Dictionary into the empty List", () => {
			let result = format(
				block(
					"\tconstant ages: Dictionary<String, Integer> = [=]",
					"",
					"\tconstant names: List<String> = []",
				),
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain("[=]")
			expect(result.text).toContain("[]")
		})

		// A whole Dictionary merged in brings its own brackets and a key list
		// does not. Only the Parser knows which it read, since a bare key
		// list's Position starts at its first key.
		it("keeps a whole Dictionary merged in inside its own brackets", () => {
			roundTrips(
				block(
					'\tconstant ages = ["alex" = 39]',
					"",
					'\tconstant older = [ages with ["alex" = 40]]',
				),
			)
		})

		it("keeps the empty Dictionary merged in", () => {
			roundTrips(
				block(
					'\tconstant ages = ["alex" = 39]',
					"",
					"\tconstant same = [ages with [=]]",
				),
			)
		})

		it("keeps a whole Record merged in inside its own braces", () => {
			roundTrips(
				block(
					"\tconstant config = { port = 1 }",
					"",
					"\tconstant same = { config with { port = 2 } }",
				),
			)
		})

		it("keeps a key that is an Expression as it was written", () => {
			roundTrips(
				block(
					"\tconstant offset = 1",
					"",
					"\tconstant scores = [offset::add(1) = 10]",
				),
			)
		})
	})

	// A key may be written in brackets of its own. The source then cannot tell
	// `[d with [3, 4] = "b"]` from a merge, since a bare key list's Position
	// starts at its first key.
	describe("a key written in brackets", () => {
		it("keeps a List key in an update out of a second pair of brackets", () => {
			let source = block(
				'\tconstant d: Dictionary<List<Integer>, String> = [[1, 2] = "a"]',
				'\tconstant e = [d with [3, 4] = "b"]',
			)

			expect(format(source, { verify: false }).text).toBe(source)
		})

		it("keeps a Dictionary key in an update out of a second pair of brackets", () => {
			let source = block(
				'\tconstant inner = ["k" = 1]',
				'\tconstant d: Dictionary<Dictionary<String, Integer>, String> = [inner = "a"]',
				'\tconstant e = [d with ["k" = 2] = "b"]',
			)

			expect(format(source, { verify: false }).text).toBe(source)
		})

		it("does not refuse a file over a List key in an update", () => {
			let source = block(
				'\tconstant d: Dictionary<List<Integer>, String> = [[1, 2] = "a"]',
				'\tconstant e = [d with [3] = "b", [4] = "c"]',
			)

			expect(format(source).refusal).toBeNull()
		})

		// In a literal the Position starts at the bracket, so the key is plain.
		it("round-trips a List key in a Literal", () => {
			roundTrips(
				block(
					'\tconstant d: Dictionary<List<Integer>, String> = [[1, 2] = "a", [3] = "b"]',
				),
			)
		})
	})

	// The forms a Dictionary shares with a List or a Record, each tested beside
	// its sibling so that the behaviours cannot drift apart.
	describe("beside a List and a Record", () => {
		it("hugs a Dictionary written as the only Argument", () => {
			let result = format(
				block(
					"\tfunction f(_ d: Dictionary<String, Integer>) -> Integer {",
					"\t\t<- d::length()",
					"\t}",
					"",
					'\tconstant n = f(["alexander" = 39, "samantha" = 25, "kimberley" = 7, "chris" = 5])',
				),
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				block(
					"\tfunction f(_ d: Dictionary<String, Integer>) -> Integer {",
					"\t\t<- d::length()",
					"\t}",
					"",
					"\tconstant n = f([",
					'\t\t"alexander" = 39,',
					'\t\t"samantha" = 25,',
					'\t\t"kimberley" = 7,',
					'\t\t"chris" = 5,',
					"\t])",
				),
			)
		})

		it("keeps a Dictionary nested in a Dictionary, a Record and a List", () => {
			roundTrips(
				block(
					'\tconstant nested   = ["a" = ["b" = 1], "c" = ["d" = 2]]',
					'\tconstant inRecord = { ages = ["a" = 1], n = 2 }',
					'\tconstant inList   = [["a" = 1], ["b" = 2]]',
				),
			)
		})

		it("keeps a Function literal written as a value", () => {
			roundTrips(
				block(
					'\tconstant d = ["a" = (n: Integer) -> Integer { <- n }]',
				),
			)
		})

		it("keeps a nested update", () => {
			roundTrips(
				block(
					'\tconstant ages  = ["a" = 1]',
					'\tconstant twice = [[ages with "b" = 2] with "c" = 3]',
				),
			)
		})

		it("keeps a Dictionary written as a labelled Argument and as an answer", () => {
			roundTrips(
				block(
					'\tconstant ages = ["a" = 1]',
					'\tconstant more = ages::merge(with ["b" = 2])',
					"",
					"\tfunction f() -> Dictionary<String, Integer> {",
					'\t\t<- ["a" = 1, "b" = 2]',
					"\t}",
				),
			)
		})

		// A Comment inside an entry has nowhere to go, in a Dictionary as in a
		// Record, so both are refused.
		it("refuses a Comment inside an entry, as a Record does inside a member", () => {
			let dictionary = format(
				block('\tconstant d = ["a" § k', "\t\t= 1]"),
			)
			let record = format(block("\tconstant r = { a § k", "\t\t= 1 }"))

			expect(dictionary.refusal?.kind).toBe("unsafe")
			expect(record.refusal?.kind).toBe("unsafe")
		})

		it("refuses a Comment inside the empty Dictionary, as an empty List does", () => {
			let dictionary = format(
				block(
					"\tconstant d: Dictionary<String, Integer> = [",
					"\t\t§ nothing yet",
					"\t\t=",
					"\t]",
				),
			)
			let list = format(
				block(
					"\tconstant l: List<Integer> = [",
					"\t\t§ nothing yet",
					"\t]",
				),
			)

			expect(dictionary.refusal?.kind).toBe("unsafe")
			expect(list.refusal?.kind).toBe("unsafe")
		})

		it("drops blank lines between entries, as a List and a Record do", () => {
			expect(
				format(
					block(
						"\tconstant d = [",
						'\t\t"a" = 1,',
						"",
						'\t\t"b" = 2,',
						"\t]",
					),
				).text,
			).toBe(block('\tconstant d = ["a" = 1, "b" = 2]'))
		})
	})
})
