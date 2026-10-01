import { describe, expect, it } from "bun:test"

import { bareCaseCollision } from "../bare-cases"
import type { CaseDescriptor, Descriptor, Members } from "../descriptor"

// Hand-written Descriptors, since the rule is under test and not the
// describing. `descriptor.spec.ts` checks what the compiler writes.

function caseOf(
	choice: string,
	name: string,
	{
		unitChoice = true,
		payload = {},
		module = "./Marshal.es",
	}: {
		unitChoice?: boolean
		payload?: Members
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
		payload: item === undefined ? {} : { item: { of: item } },
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
		payload: { radius: { of: INTEGER } },
	}),
	caseOf("Shape", "Blank", { unitChoice: false }),
]

describe("A Union holding a bare Case", () => {
	// `"Up"` could be a Direction or a String, and nothing in the value says
	// which.
	it("collides with a String", () => {
		expect(bareCaseCollision(union(...DIRECTION, TEXT))).toBe(
			'a Direction#Up crosses as the string "Up", which a String is too',
		)
	})

	// Arm order decides nothing.
	it("collides with a String written before it", () => {
		expect(bareCaseCollision(union(TEXT, ...DIRECTION))).toBe(
			'a Direction#Up crosses as the string "Up", which a String is too',
		)
	})

	// Another unit Choice's Case of the same name collides the same way.
	it("collides with another Choice's Case of the same name", () => {
		expect(bareCaseCollision(union(...DIRECTION, ...VERTICAL))).toBe(
			'a Direction#Up and a Vertical#Up both cross as the string "Up"',
		)
	})

	// The rule is per Case name, so Choices sharing no name are fine.
	it("stands beside a unit Choice sharing no Case name", () => {
		expect(bareCaseCollision(union(...DIRECTION, ...SIGN))).toBeNull()
	})

	// A Choice with payloads crosses as `$case` objects, even for a Case
	// without one, and no object is a string.
	it("stands beside a Choice that keeps the object form", () => {
		expect(bareCaseCollision(union(...DIRECTION, ...SHAPE))).toBeNull()
	})

	// One Case reached twice is one Case, since Cases compare by tag.
	it("does not collide with itself", () => {
		expect(
			bareCaseCollision(union(...DIRECTION, caseOf("Direction", "Up"))),
		).toBeNull()
	})

	// Two Modules' `choice Direction` are two Choices, so their `#Up`s collide
	// and the sentence names them by tag.
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

	// Any other shape is told apart by its JavaScript kind.
	it("stands beside every other shape", () => {
		expect(bareCaseCollision(union(...DIRECTION, INTEGER))).toBeNull()
	})
})

describe("The arms a collision is looked for among", () => {
	// A nested Union's arms stand in the outer position.
	it("are flattened through a nested Union", () => {
		expect(bareCaseCollision(union(union(...DIRECTION), union(TEXT)))).toBe(
			'a Direction#Up crosses as the string "Up", which a String is too',
		)
	})

	// An `Optional` is spelled by absence, so its item stands beside the other
	// arms.
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

	// With other arms beside them, `Optional`'s Cases never collapse into an
	// `optional` node, which is the usual shape.
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

	// `#Empty` carries nothing into the position.
	it("take nothing from an absence", () => {
		expect(
			bareCaseCollision(union(optionalCase("Empty"), ...DIRECTION)),
		).toBeNull()
	})
})

describe("A shape that is not a Union", () => {
	// Only a Union is asked, so a collision is reported once, where it is
	// reached, and not at every level containing it.
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
				members: { direction: { of: union(...DIRECTION) } },
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
