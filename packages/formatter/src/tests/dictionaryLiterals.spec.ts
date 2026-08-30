import { describe, expect, it } from "bun:test"

import { format } from "../index"

// NOTE: The three written forms of a Dictionary — the Literal, the empty one,
// and the update in either of its halves. Every test here is a ROUND TRIP over
// canonically formatted source: what the Printer writes for a form it has never
// seen before is what a reader will have to type, and the safety gate refuses
// output whose re-parse differs, so a form printed back as something else shows
// up as a refusal rather than as a diff.
//
// The comment cases matter more here than anywhere: a Dictionary entry is two
// Expressions and a `=`, so there are twice as many places a `§` can sit as
// there are in a List, and every one of them has to come back where it was
// written.

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

		// NOTE: The brackets are read off the Node rather than guessed at, and
		// this is what says so: `{ record with other }` and `[dictionary with
		// other]` are the same Node shape, and the pair that was written is the
		// only thing that tells them apart.
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

		// NOTE: A List of nothing but Numbers FILLS — as many to a line as fit
		// — and a Dictionary never does, whatever its values are: an entry is
		// two values and a `=`, which nobody reads four to a line.
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

		// NOTE: A Comment anywhere in the entries forces the break, exactly as
		// it does for a List — a one-line Dictionary has nowhere to put one.
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

		// NOTE: A Comment TRAILING the opening bracket is refused rather than
		// moved, and refused for a Dictionary exactly as it is for a List: the
		// Printer has no place to put one and the anchor gate catches it. The
		// two are pinned together here so that a Dictionary can not quietly
		// grow a behaviour a List does not have.
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
		// NOTE: `[=]` is one token to a reader and prints as one. It is the
		// only Dictionary with nothing inside it to lay out, and the `=` is the
		// whole of what tells it from the empty List.
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

		// NOTE: A whole Dictionary merged in brings BRACKETS of its own, and a
		// key list does not — the two hold the same Node on the right of the
		// `with` and differ by a Position the safety gate strips, so the
		// Parser marks which of the two it read and the Printer reads the mark.
		// See `parser.CombinationNode.bare`.
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

	// NOTE: A Dictionary's key is a VALUE, so a key may be written in brackets
	// of its own — a List, a Dictionary, an update. That is the case the two
	// readings of `[base with …]` can not be told apart by looking at the
	// source: a bare key list's Position starts at its FIRST KEY, so the key's
	// own bracket read as "the whole Dictionary brought brackets", and
	// `[d with [3, 4] = "b"]` printed back as `[d with [[3, 4] = "b"]]` — the
	// merge form, which is a different Program. Only the comment-anchor gate
	// caught it, and what it said was that a Comment had moved in a file
	// holding none.
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

		// NOTE: The same key in a LITERAL was always fine — the Literal's own
		// Position starts at its bracket. Pinned so the fix is not made by
		// breaking this.
		it("round-trips a List key in a Literal", () => {
			roundTrips(
				block(
					'\tconstant d: Dictionary<List<Integer>, String> = [[1, 2] = "a", [3] = "b"]',
				),
			)
		})
	})

	// NOTE: The forms a Dictionary shares with the two containers beside it.
	// Each is written as a PAIR with a List or a Record where one exists, so a
	// Dictionary can not quietly grow — or quietly miss — a behaviour its
	// siblings have.
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

		// NOTE: Both refused, and refused for a Record in exactly the same
		// place — a Comment inside an entry has nowhere to go. Pinned as a PAIR
		// so a Dictionary can not grow a behaviour a Record does not have.
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
