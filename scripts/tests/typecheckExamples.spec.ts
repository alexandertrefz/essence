import { describe, expect, it } from "bun:test"

import { essenceImportsOf } from "../typecheckExamples"

describe("Type-checking the examples", () => {
	describe("reading imports", () => {
		it("should read every relative `.es` file a script imports", () => {
			expect(
				essenceImportsOf(
					[
						'import * as rules from "./Game.es"',
						'import type { Board } from "../board/Board.es"',
						'export { quote } from "./rules/Pricing.es"',
						'import { readFileSync } from "node:fs"',
						'import { helper } from "./helper"',
					].join("\n"),
				),
			).toEqual(["./Game.es", "../board/Board.es", "./rules/Pricing.es"])
		})

		it("should skip what only looks like an import", () => {
			expect(
				essenceImportsOf(
					[
						'// The rules once came from "./Gone.es".',
						'/* import { old } from "./Old.es" */',
						"let source = 'from \"./Quoted.es\"'",
						'let program = `import { a } from "./Template.es"`',
						'let essence = `${source} from "./Hole.es" {`',
						'import { kept } from "./Kept.es"',
					].join("\n"),
				),
			).toEqual(["./Kept.es"])
		})
	})
})
