import { describe, expect, it } from "bun:test"

import { parseDocumentation } from "../parser/documentation"

const position = {
	start: { line: 1, column: 1 },
	end: { line: 1, column: 1 },
}

function parse(lines: Array<string>) {
	return parseDocumentation(lines, position)
}

describe("Documentation", () => {
	it("should join prose lines into a description", () => {
		let documentation = parse([
			"§§ Appends another String to this one.",
			"§§ The receiver is left untouched.",
		])

		expect(documentation.description).toBe(
			"Appends another String to this one.\nThe receiver is left untouched.",
		)
		expect(documentation.parameters).toEqual({})
		expect(documentation.returns).toBeNull()
	})

	it("should keep indentation past the separating space", () => {
		let documentation = parse([
			"§§ Steps:",
			"§§",
			"§§ - first",
			"§§   - nested",
		])

		expect(documentation.description).toBe("Steps:\n\n- first\n  - nested")
	})

	it("should lift Parameter and return tags out of the prose", () => {
		let documentation = parse([
			"§§ Appends another String to this one.",
			"§§",
			"§§ @param other what to append",
			"§§ @returns the joined String",
		])

		expect(documentation.description).toBe(
			"Appends another String to this one.",
		)
		expect(documentation.parameters).toEqual({ other: "what to append" })
		expect(documentation.returns).toBe("the joined String")
	})

	it("should continue a tag across the lines below it", () => {
		let documentation = parse([
			"§§ @param other",
			"§§ what to append —",
			"§§ any String will do",
			"§§ @returns the joined String",
		])

		expect(documentation.parameters).toEqual({
			other: "what to append —\nany String will do",
		})
		expect(documentation.returns).toBe("the joined String")
	})

	it("should leave an unknown tag in the prose", () => {
		let documentation = parse([
			"§§ Sends to an @address, which is not a tag.",
			"§§ @notATag neither is this",
		])

		expect(documentation.description).toBe(
			"Sends to an @address, which is not a tag.\n@notATag neither is this",
		)
		expect(documentation.parameters).toEqual({})
	})

	it("should leave a @param naming nothing in the prose", () => {
		let documentation = parse(["§§ @param"])

		expect(documentation.description).toBe("@param")
		expect(documentation.parameters).toEqual({})
	})

	it("should trim the blank lines around a section but not inside it", () => {
		let documentation = parse(["§§", "§§ First.", "§§", "§§ Second.", "§§"])

		expect(documentation.description).toBe("First.\n\nSecond.")
	})
})
