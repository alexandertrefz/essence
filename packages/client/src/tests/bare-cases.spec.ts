import { describe, expect, it } from "bun:test"

import { bareCaseCollision } from "../bare-cases"
import type { CaseDescriptor, Descriptor } from "../descriptor"

// NOTE: Hand-written Descriptors rather than described Types, because what is
// under test is the RULE and not the describing — every shape below is one a
// Union can be in, and half of them are shapes a fixture would have to be
// contorted into to produce. The Descriptors a Compiler writes are checked
// against the same rule by `descriptor.spec.ts`'s snapshot, which is where a
// disagreement between the two sides would show.

function caseOf(
	choice: string,
	name: string,
	{
		unitChoice = true,
		payload = {},
		module = "./Marshal.es",
	}: {
		unitChoice?: boolean
		payload?: Record<string, Descriptor>
		module?: string
	} = {},
): CaseDescriptor {
	return {
		kind: "case",
		tag: `${module}#${choice}#${name}`,
		choice,
		name,
		optional: false,
		unitChoice,
		payload,
		shown: `${choice}#${name}`,
	}
}

function optionalCase(name: "Empty" | "Value", item?: Descriptor): Descriptor {
	return {
		kind: "case",
		tag: `Optional#${name}`,
		choice: "Optional",
		name,
		optional: true,
		unitChoice: false,
		payload: item === undefined ? {} : { item },
		shown: `Optional#${name}`,
	}
}

function union(...arms: Array<Descriptor>): Descriptor {
	return {
		kind: "union",
		arms,
		shown: arms.map((arm) => arm.shown).join(" | "),
	}
}

const TEXT: Descriptor = { kind: "string", shown: "String" }
const INTEGER: Descriptor = { kind: "integer", shown: "Integer" }

const DIRECTION = [caseOf("Direction", "Up"), caseOf("Direction", "Down")]
const VERTICAL = [caseOf("Vertical", "Up"), caseOf("Vertical", "Down")]
const SIGN = [caseOf("Sign", "Plus"), caseOf("Sign", "Minus")]
const SHAPE = [
	caseOf("Shape", "Circle", {
		unitChoice: false,
		payload: { radius: INTEGER },
	}),
	caseOf("Shape", "Blank", { unitChoice: false }),
]

describe("A Union holding a bare Case", () => {
	// NOTE: The collision the whole rule exists for. `"Up"` is a Direction and
	// `"Up"` is a String, and nothing in the value says which — so a round trip
	// through this position would have to guess, and guessing wrong loses the
	// value it was handed.
	it("collides with a String", () => {
		expect(bareCaseCollision(union(...DIRECTION, TEXT))).toBe(
			'a Direction#Up crosses as the string "Up", which a String is too',
		)
	})

	// NOTE: Either way round. Which arm was written first decides nothing —
	// there is no order in which the position becomes spellable.
	it("collides with a String written before it", () => {
		expect(bareCaseCollision(union(TEXT, ...DIRECTION))).toBe(
			'a Direction#Up crosses as the string "Up", which a String is too',
		)
	})

	// NOTE: And with another unit Choice's Case of the same name, which is the
	// same collision without a String in it.
	it("collides with another Choice's Case of the same name", () => {
		expect(bareCaseCollision(union(...DIRECTION, ...VERTICAL))).toBe(
			'a Direction#Up and a Vertical#Up both cross as the string "Up"',
		)
	})

	// NOTE: Per Case NAME. Two unit Choices in one position are not the
	// problem; two Cases spelled alike are, and Choices that share no name have
	// none.
	it("stands beside a unit Choice sharing no Case name", () => {
		expect(bareCaseCollision(union(...DIRECTION, ...SIGN))).toBeNull()
	})

	// NOTE: And per bare Case. A Choice with payloads crosses as a `$case`
	// object whatever its payload-less Cases are called, and an object is not a
	// string — so `Shape#Blank` beside `Direction#Up` is two spellings, not one.
	it("stands beside a Choice that keeps the object form", () => {
		expect(bareCaseCollision(union(...DIRECTION, ...SHAPE))).toBeNull()
	})

	// NOTE: A Case reached twice through a Union that mentions its Choice twice
	// is one Case, not two — which is why the comparison is by tag.
	it("does not collide with itself", () => {
		expect(
			bareCaseCollision(union(...DIRECTION, caseOf("Direction", "Up"))),
		).toBeNull()
	})

	// NOTE: But two Modules' `choice Direction` are two Choices spelled one
	// way, and their `#Up`s are two Cases spelling one string. `choice` is a
	// display name and can not tell them apart; the tag can — and so the
	// sentence names them by their tags, because "a Direction#Up and a
	// Direction#Up" would leave a reader with nothing to act on.
	it("collides with another Module's Choice of the same name", () => {
		expect(
			bareCaseCollision(
				union(
					...DIRECTION,
					caseOf("Direction", "Up", { module: "./Other.es" }),
				),
			),
		).toBe(
			`'./Marshal.es#Direction#Up' and './Other.es#Direction#Up' both cross as the string "Up"`,
		)
	})

	// NOTE: Anything that is not a String and not a bare Case is decided by its
	// own JavaScript shape and can not be one of these strings.
	it("stands beside every other shape", () => {
		expect(bareCaseCollision(union(...DIRECTION, INTEGER))).toBeNull()
	})
})

describe("The arms a collision is looked for among", () => {
	// NOTE: A nested Union's arms stand in the outer position unchanged, so the
	// rule is asked of the flattened list — a Union of Unions hides nothing.
	it("are flattened through a nested Union", () => {
		expect(bareCaseCollision(union(union(...DIRECTION), union(TEXT)))).toBe(
			'a Direction#Up crosses as the string "Up", which a String is too',
		)
	})

	// NOTE: An `Optional` is spelled by absence, so what it holds stands in the
	// position beside everything else — `Optional<String> | Direction` is a
	// position where `"Up"` is a String or a Direction and `undefined` is
	// neither.
	it("are flattened through an Optional node", () => {
		expect(
			bareCaseCollision(
				union(
					{ kind: "optional", of: TEXT, shown: "Optional<String>" },
					...DIRECTION,
				),
			),
		).toBe(
			'a Direction#Up crosses as the string "Up", which a String is too',
		)
	})

	// NOTE: And through the pair of Cases the same Optional reaches a Union as
	// when there are other arms beside it — three arms or more never collapse
	// into an `optional` node, so this is the shape the refusal above is
	// actually met in.
	it("are flattened through Optional's own Cases", () => {
		expect(
			bareCaseCollision(
				union(
					optionalCase("Value", TEXT),
					optionalCase("Empty"),
					...DIRECTION,
				),
			),
		).toBe(
			'a Direction#Up crosses as the string "Up", which a String is too',
		)
	})

	// NOTE: `#Empty` carries nothing, so it takes nothing into the position —
	// an `Optional<Direction>` is a Direction or it is `undefined`, and those
	// are two spellings.
	it("take nothing from an absence", () => {
		expect(
			bareCaseCollision(union(optionalCase("Empty"), ...DIRECTION)),
		).toBeNull()
	})
})

describe("A shape that is not a Union", () => {
	// NOTE: There is nothing for a lone Case to collide with, and every
	// position that could hold two shapes at once is a Union asked about where
	// it is reached — so asking about the shapes that CONTAIN one would report
	// the same collision at every level above it.
	it("has no collision to report", () => {
		expect(bareCaseCollision(caseOf("Direction", "Up"))).toBeNull()
		expect(bareCaseCollision(TEXT)).toBeNull()
		expect(
			bareCaseCollision({
				kind: "optional",
				of: union(...DIRECTION),
				shown: "Optional<Direction>",
			}),
		).toBeNull()
		expect(
			bareCaseCollision({
				kind: "record",
				members: { direction: union(...DIRECTION) },
				shown: "{ direction: Direction }",
			}),
		).toBeNull()
		expect(
			bareCaseCollision({
				kind: "list",
				of: union(...DIRECTION, TEXT),
				shown: "List<Direction | String>",
			}),
		).toBeNull()
	})
})
