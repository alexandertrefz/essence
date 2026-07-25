import { describe, expect, it } from "bun:test"

import { parseDocumentation } from "../parser/documentation"

const position = {
	start: { line: 1, column: 1 },
	end: { line: 1, column: 1 },
}

// NOTE: One line per source line, numbered from 1 and starting at column 1, so
// that a Position reported against a tag can be read back as the line it was
// written on and the column the offending text starts at.
function positioned(lines: Array<string>) {
	return lines.map((text, index) => ({
		text,
		position: {
			start: { line: index + 1, column: 1 },
			end: { line: index + 1, column: text.length + 1 },
		},
	}))
}

function parse(lines: Array<string>) {
	return parseDocumentation(positioned(lines), position).documentation
}

function problemsOf(lines: Array<string>) {
	return parseDocumentation(positioned(lines), position).problems
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

	// NOTE: The un-separated form, which is reported but still lifted — a
	// Hover must not lose a description while its source is being corrected.
	it("should lift a tag written without a separator all the same", () => {
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

	it("should separate a tag from its text with an em-dash", () => {
		let documentation = parse([
			"§§ @param other — what to append",
			"§§ @returns — the joined String",
		])

		expect(documentation.parameters).toEqual({ other: "what to append" })
		expect(documentation.returns).toBe("the joined String")
	})

	it("should keep only the first em-dash as the separator", () => {
		let documentation = parse(["§§ @param other — a String — any String"])

		expect(documentation.parameters).toEqual({
			other: "a String — any String",
		})
	})

	it("should end a Parameter name at the separator that follows it", () => {
		let documentation = parse([
			"§§ @param other—what to append",
			"§§ @returns—the joined String",
		])

		expect(documentation.parameters).toEqual({ other: "what to append" })
		expect(documentation.returns).toBe("the joined String")
	})

	it("should report a tag whose text is not separated from it", () => {
		let problems = problemsOf([
			"§§ @param other what to append",
			"§§ @returns the joined String",
		])

		expect(problems).toEqual([
			{
				kind: "missing-separator",
				tag: "param",
				name: "other",
				// NOTE: The text alone, which is where the missing em-dash
				// belongs — column 17 is the 'w' of 'what'.
				position: {
					start: { line: 1, column: 17 },
					end: { line: 1, column: 31 },
				},
			},
			{
				kind: "missing-separator",
				tag: "returns",
				name: null,
				position: {
					start: { line: 2, column: 13 },
					end: { line: 2, column: 30 },
				},
			},
		])
	})

	it("should report nothing for a separated or a bare tag", () => {
		expect(
			problemsOf([
				"§§ @param other — what to append",
				"§§ @returns — the joined String",
			]),
		).toEqual([])

		// NOTE: A tag head alone has no text on its line to separate; the lines
		// below it are its text, and are not tags themselves.
		expect(
			problemsOf([
				"§§ @param other",
				"§§ what to append",
				"§§ @returns",
				"§§ the joined String",
			]),
		).toEqual([])
	})

	it("should record where each Parameter tag was written", () => {
		let documentation = parse([
			"§§ Appends another String to this one.",
			"§§ @param other — what to append",
		])

		expect(documentation.parameterTags).toEqual({
			other: {
				position: {
					start: { line: 2, column: 1 },
					end: { line: 2, column: 33 },
				},
			},
		})
	})

	it("should leave the Parameter tags off a block that writes none", () => {
		expect(
			parse(["§§ Appends.", "§§ @returns — a String"]),
		).not.toHaveProperty("parameterTags")
	})

	it("should trim the blank lines around a section but not inside it", () => {
		let documentation = parse(["§§", "§§ First.", "§§", "§§ Second.", "§§"])

		expect(documentation.description).toBe("First.\n\nSecond.")
	})
})
