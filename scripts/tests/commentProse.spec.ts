import { beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

import {
	BASELINE_PATH,
	type Counts,
	describeDrift,
	driftOf,
	type Finding,
	findingsIn,
	formatBaseline,
	lowerBaseline,
	readBaseline,
	readSource,
	type Source,
	sourceOf,
	trackedScripts,
	UPDATE_COMMAND,
} from "../commentProse"

// Every comment in the TypeScript and JavaScript sources is held to the rules
// in `scripts/commentProse.ts`. The baseline records how often each file breaks
// each rule today. A file can break a rule less often but never more.

let sources: Array<Source> = []
let findings: Array<Finding> = []

beforeAll(async () => {
	sources = (await trackedScripts()).map(readSource)
	findings = sources.flatMap(findingsIn)
})

function rulesIn(text: string): Array<string> {
	return findingsIn(sourceOf("example.ts", text)).map(
		(finding) => finding.rule,
	)
}

function sentenceOf(words: number): string {
	return `${Array.from({ length: words - 1 }, () => "word").join(" ")} end.`
}

describe("Comment Prose", () => {
	describe("reading", () => {
		it("should read what only looks like a comment as code", () => {
			let source = sourceOf(
				"example.ts",
				[
					"let path = /\\/\\/ not a comment/",
					"let text = `/* nor ${path} this */`",
					"let ratio = values[0]! / values[1]! // A comment.",
				].join("\n"),
			)

			expect(
				source.scanned.comments.map((comment) =>
					source.text.slice(comment.pos, comment.end),
				),
			).toEqual(["// A comment."])
		})

		// Every rule passes on a reader that found nothing, so the count is
		// what shows the reading still reaches the whole repository.
		it("should read every tracked script", () => {
			expect(sources.length).toBeGreaterThan(400)
			expect(
				sources.reduce(
					(sum, source) => sum + source.scanned.comments.length,
					0,
				),
			).toBeGreaterThan(10_000)
		})
	})

	describe("rules", () => {
		it("should refuse a comment that opens with NOTE:", () => {
			expect(rulesIn("let a = 1\n// NOTE: The walk stops.\n")).toEqual([
				"no-note-prefix",
			])
			expect(rulesIn("let a = 1\n// WARNING: The walk stops.\n")).toEqual(
				[],
			)
			expect(
				rulesIn("let a = 1\n// INVARIANT: The walk stops.\n"),
			).toEqual([])
		})

		it("should count the words of a sentence", () => {
			expect(rulesIn(`let a = 1\n// ${sentenceOf(26)}\n`)).toEqual([
				"sentence-length",
			])
			expect(rulesIn(`let a = 1\n// ${sentenceOf(25)}\n`)).toEqual([])
		})

		it("should name the line a sentence starts on", () => {
			let text = [
				"let a = 1",
				"// One short sentence. Then",
				`// ${sentenceOf(26)}`,
			].join("\n")

			expect(
				findingsIn(sourceOf("example.ts", text)).map(
					(finding) => finding.line,
				),
			).toEqual([2])
			expect(
				findingsIn(
					sourceOf(
						"example.ts",
						`let a = 1\n//\n// ${sentenceOf(26)}`,
					),
				).map((finding) => finding.line),
			).toEqual([3])
		})

		it("should end a sentence before one that opens with a code span", () => {
			expect(
				rulesIn(
					`let a = 1\n// ${sentenceOf(20)} \`name\` ${sentenceOf(20)}\n`,
				),
			).toEqual([])
			expect(
				rulesIn(
					`let a = 1\n// ${sentenceOf(20)} \`name\` ${sentenceOf(25)}\n`,
				),
			).toEqual(["sentence-length"])
		})

		it("should find an em-dash in prose but not in a code span", () => {
			expect(rulesIn("let a = 1\n// One thing — and another.\n")).toEqual(
				["em-dash"],
			)
			expect(rulesIn("let a = 1\n// Prints `a — b` as it is.\n")).toEqual(
				[],
			)
		})

		it("should find emphasis but allow acronyms and names", () => {
			expect(rulesIn("let a = 1\n// This is NOT allowed.\n")).toEqual([
				"all-caps",
			])
			expect(rulesIn("let a = 1\n// The JSON and the AST.\n")).toEqual([])
			expect(rulesIn("const LIMIT = 1\n// Reads LIMIT first.\n")).toEqual(
				[],
			)
		})

		it("should find the history of the code", () => {
			expect(rulesIn("let a = 1\n// This used to throw.\n")).toEqual([
				"history",
			])
			expect(
				rulesIn("let a = 1\n// It is used to find a key.\n"),
			).toEqual([])
		})

		it("should find a pointer to code by its position", () => {
			expect(
				rulesIn("let a = 1\n// The loop below stops early.\n"),
			).toEqual(["position"])
			expect(rulesIn("let a = 1\n// A point below the plane.\n")).toEqual(
				[],
			)
		})

		it("should count the lines of a block after the first one", () => {
			let block = (lines: number) =>
				Array.from({ length: lines }, () => "// Word.").join("\n")

			expect(rulesIn(`${block(7)}\nlet a = 1\n`)).toEqual([])
			expect(rulesIn(`let a = 1\n${block(7)}\nlet b = 2\n`)).toEqual([
				"block-length",
			])
			expect(rulesIn(`let a = 1\n${block(6)}\nlet b = 2\n`)).toEqual([])
		})

		it("should count only the prose of a block toward its length", () => {
			let indented = [
				"// One.",
				"//",
				"//     let first = 1",
				"//     let second = 2",
				"//     let third = 3",
				"//",
				"// Two.",
			].join("\n")
			let fenced = [
				"// One.",
				"// ```",
				"// let first = 1",
				"// let second = 2",
				"// let third = 3",
				"// ```",
				"// Two.",
			].join("\n")

			expect(rulesIn(`let a = 1\n${indented}\nlet b = 2\n`)).toEqual([])
			expect(rulesIn(`let a = 1\n${fenced}\nlet b = 2\n`)).toEqual([])
		})

		it("should find two blocks with nothing but blank lines between", () => {
			expect(
				rulesIn("let a = 1\n// One.\n\n// Two.\nlet b = 2\n"),
			).toEqual(["stacked"])
			expect(rulesIn("// One.\nlet a = 1\n// Two.\nlet b = 2\n")).toEqual(
				[],
			)
		})

		it("should let a file's header stand above the first comment", () => {
			expect(rulesIn("// Header.\n\n// First.\nlet a = 1\n")).toEqual([])
			expect(
				rulesIn("// Header.\n\n// One.\n\n// Two.\nlet a = 1\n"),
			).toEqual(["stacked"])
		})

		it("should find a count of other code", () => {
			expect(
				rulesIn("let a = 1\n// Shared by the three callers.\n"),
			).toEqual(["counts"])
			expect(
				rulesIn("let a = 1\n// Either of the two branches.\n"),
			).toEqual([])
		})

		it("should skip what is not prose", () => {
			expect(
				rulesIn(
					[
						"let a = 1",
						"// oxlint-disable-next-line no-console",
						"// #region THE WHOLE SECTION",
						"/** @param {string} word The WORD to read. */",
						"// See https://example.com/A/VERY/LONG/PATH.",
					].join("\n"),
				),
			).toEqual([])
		})
	})

	describe("baseline", () => {
		it("should hold every file to its baseline", () => {
			expect(
				driftOf(findings, readBaseline()).map(describeDrift).join("\n"),
			).toBe("")
		})

		it("should keep the baseline in the form the update writes", () => {
			expect(readFileSync(BASELINE_PATH, "utf8")).toBe(
				formatBaseline(readBaseline()),
			)
		})

		it("should say what drifted and what to do about it", () => {
			let first: Finding = {
				file: "a.ts",
				line: 7,
				rule: "em-dash",
				detail: "One — two.",
			}
			let [raised, lowered] = driftOf([first, { ...first, line: 9 }], {
				"a.ts": { "em-dash": 1 },
				"b.ts": { history: 2 },
			}).map(describeDrift)

			expect(raised).toBe(
				`a.ts: 'em-dash' found 2 times where the baseline allows 1, on lines 7, 9. Rewrite the comment, since \`${UPDATE_COMMAND}\` never raises a count.\n    a.ts:7: One — two.`,
			)
			expect(lowered).toBe(
				`b.ts: 'history' found 0 times where the baseline records 2. Run \`${UPDATE_COMMAND}\` to lower the baseline.`,
			)
		})

		it("should lower a count and refuse to raise one", () => {
			let finding = (file: string, rule: Finding["rule"]): Finding => ({
				file,
				line: 1,
				rule,
				detail: "",
			})
			let baseline: Counts = {
				"a.ts": { "em-dash": 3, history: 1 },
				"b.ts": { counts: 1 },
			}
			let { next, lowered, refused } = lowerBaseline(
				baseline,
				driftOf(
					[
						finding("a.ts", "em-dash"),
						finding("a.ts", "history"),
						finding("a.ts", "history"),
						finding("c.ts", "stacked"),
					],
					baseline,
				),
			)

			expect(next).toEqual({ "a.ts": { "em-dash": 1, history: 1 } })
			expect(
				lowered.map((entry) => `${entry.file} ${entry.rule}`),
			).toEqual(["a.ts em-dash", "b.ts counts"])
			expect(
				refused.map((entry) => `${entry.file} ${entry.rule}`),
			).toEqual(["a.ts history", "c.ts stacked"])
		})
	})
})
