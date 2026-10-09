import { describe, expect, it } from "bun:test"
import * as path from "node:path"

import {
	capitalsOf,
	hasEmDash,
	sentencesOf,
	wordsOf,
} from "@essence-lang/fixtures/prose"
import { readStdlibFiles } from "@essence-lang/standard-library"

import { containsErrors } from "../diagnostics/index"
import { parseWithDiagnostics } from "../parser/index"

// The writing rules of ASD-STE100 that the standard library's prose is held
// to. Its dictionary does not apply, since the language's terms are names.
//
// - No sentence over 25 words, in a `§§` block or a `§` note.
// - No em-dash aside inside a `§§` sentence. A tag's own separator is not one.
// - `can`, never `may`; no `should`.
// - No capitals for emphasis. An acronym is allowed, and a CamelCase name
//   never matches.
//
// Every `choice` and `type` alias also carries a `§§` block, since a `§` note
// reaches only the file's next editor. Every `define` span a block writes must
// parse, so a reader can copy it.
//
// `ESSENCE_PROSE_REPORT=1 bun test stdlibProse` prints each rule's findings
// with their files and lines.

const REPORTING = process.env.ESSENCE_PROSE_REPORT !== undefined

const WORD_LIMIT = 25

// Words meant in capitals. `capitalsOf` needs three capitals, so `O(1)`
// never reaches this list.
const ACRONYMS = new Set([
	"API",
	"ASCII",
	"AST",
	"CLI",
	"CPU",
	"CRLF",
	"HTTP",
	"JSON",
	"LSP",
	"NFC",
	"NFD",
	"NFKC",
	"NFKD",
	"UTF",
	"ZWJ",
])

type Finding = {
	rule:
		| "sentence-length"
		| "em-dash"
		| "may-should"
		| "all-caps"
		| "undocumented-declaration"
		| "unparsable-span"
	file: string
	line: number
	detail: string
}

// A `choice` or a `type` alias. The indentation is not pinned, so a
// declaration at another depth is still found.
const declarationPattern = /^\s*(choice|type)\s+([A-Za-z][A-Za-z0-9]*)/

// One run of Comment lines with the same sigil, and the line it starts on.
type ProseBlock = {
	kind: "§§" | "§"
	file: string
	line: number
	lines: Array<string>
}

const commentPattern = /^\s*(§§|§)(?: ?(.*))?$/

function blocksOf(file: string, sourceText: string): Array<ProseBlock> {
	let blocks: Array<ProseBlock> = []
	let current: ProseBlock | null = null

	for (let [index, text] of sourceText.split("\n").entries()) {
		let match = commentPattern.exec(text)

		if (match === null) {
			current = null

			continue
		}

		let kind = match[1] === "§§" ? ("§§" as const) : ("§" as const)

		if (current === null || current.kind !== kind) {
			current = { kind, file, line: index + 1, lines: [] }
			blocks.push(current)
		}

		current.lines.push(match[2] ?? "")
	}

	return blocks
}

// A `@param` or `@returns` head and its em-dash separator. The separator is
// required, so it is taken off before the em-dash rule reads the line.
const tagPattern = /^@(?:param\s+\S+|returns)\s*(?:—\s*)?/

// A fenced block holds example code, which is not prose.
const fencePattern = /^\s*(?:```|~~~)/

// An `@example` holds code too: its indented lines, and the blank lines
// between them, up to the first line written flush again.
const examplePattern = /^@example\s*$/

// One paragraph of a block, kept as its lines so a finding can name the
// line it starts at.
type Paragraph = {
	line: number
	parts: Array<string>
}

// The paragraphs of one block, without tag heads or fenced code. A sentence
// never runs across the blank line between two paragraphs.
function paragraphsOf(block: ProseBlock): Array<Paragraph> {
	let paragraphs: Array<Paragraph> = []
	let current: Paragraph | null = null
	let fenced = false
	let example = false

	for (let [index, raw] of block.lines.entries()) {
		let line = block.line + index

		if (fencePattern.test(raw)) {
			fenced = !fenced
			current = null

			continue
		}

		if (fenced) {
			continue
		}

		if (examplePattern.test(raw)) {
			example = true
			current = null

			continue
		}

		if (example && (raw.trim() === "" || /^\s/.test(raw))) {
			continue
		}

		example = false

		let text = raw.replace(tagPattern, "").trim()

		if (text === "") {
			current = null

			continue
		}

		// A tag opens a paragraph of its own, since its text is about that
		// tag alone.
		if (current === null || tagPattern.test(raw)) {
			current = { line, parts: [] }
			paragraphs.push(current)
		}

		current.parts.push(text)
	}

	return paragraphs
}

export function proseFindings(): Array<Finding> {
	let findings: Array<Finding> = []

	for (let { filePath, sourceText } of readStdlibFiles()) {
		let file = path.basename(filePath)

		for (let block of blocksOf(file, sourceText)) {
			for (let paragraph of paragraphsOf(block)) {
				for (let sentence of sentencesOf(paragraph.parts.join(" "))) {
					let words = wordsOf(sentence)

					if (words.length > WORD_LIMIT) {
						findings.push({
							rule: "sentence-length",
							file,
							line: paragraph.line,
							detail: `${words.length} words: ${sentence}`,
						})
					}

					if (block.kind === "§§" && hasEmDash(sentence)) {
						findings.push({
							rule: "em-dash",
							file,
							line: paragraph.line,
							detail: sentence,
						})
					}

					let modal = /\b(may|should)\b/i.exec(sentence)

					if (modal !== null) {
						findings.push({
							rule: "may-should",
							file,
							line: paragraph.line,
							detail: `'${modal[1]}': ${sentence}`,
						})
					}

					for (let word of words) {
						let capitals = capitalsOf(word)

						if (capitals !== null && !ACRONYMS.has(capitals)) {
							findings.push({
								rule: "all-caps",
								file,
								line: paragraph.line,
								detail: `'${capitals}': ${sentence}`,
							})
						}
					}
				}
			}
		}
	}

	return findings
}

// The Types the sources declare, each with whether a `§§` line stands directly
// above it. The Parser attaches only such a run, so a `§` note or a blank line
// between the block and the Declaration leaves it undocumented.
export function declaredTypes(): Array<{
	file: string
	line: number
	keyword: string
	name: string
	documented: boolean
}> {
	let declarations: Array<{
		file: string
		line: number
		keyword: string
		name: string
		documented: boolean
	}> = []

	for (let { filePath, sourceText } of readStdlibFiles()) {
		let file = path.basename(filePath)
		let lines = sourceText.split("\n")

		for (let [index, text] of lines.entries()) {
			let declaration = declarationPattern.exec(text)

			if (declaration === null) {
				continue
			}

			let documented =
				commentPattern.exec(lines[index - 1] ?? "")?.[1] === "§§"

			declarations.push({
				file,
				line: index + 1,
				keyword: declaration[1]!,
				name: declaration[2]!,
				documented,
			})
		}
	}

	return declarations
}

export function undocumentedDeclarations(): Array<Finding> {
	return declaredTypes()
		.filter((declaration) => !declaration.documented)
		.map((declaration) => ({
			rule: "undocumented-declaration" as const,
			file: declaration.file,
			line: declaration.line,
			detail: `${declaration.keyword} ${declaration.name} has no '§§' block`,
		}))
}

// A `define` is the one construct the prose spells in full for a reader to
// copy. So each such span is parsed as a call site would hold it. Other code
// spans name Types, Methods and signature fragments, which are no Expressions.
const definePattern = /`(define\s*\{[^`]*)`/g

export function unparsableCodeSpans(): Array<Finding> {
	let findings: Array<Finding> = []

	for (let { filePath, sourceText } of readStdlibFiles()) {
		for (let block of blocksOf(path.basename(filePath), sourceText)) {
			// A span can break across two Comment lines, so a block's lines
			// are joined.
			let text = block.lines.join(" ")

			for (let [, span] of text.matchAll(definePattern)) {
				let parsed = parseWithDiagnostics(
					`implementation {
	constant probe = ${span}
}`,
				)

				if (!containsErrors(parsed.diagnostics)) {
					continue
				}

				findings.push({
					rule: "unparsable-span",
					file: block.file,
					line: block.line,
					detail: `\`${span}\` does not parse: ${
						parsed.diagnostics.find(
							(diagnostic) => diagnostic.severity === "error",
						)?.message ?? "unknown"
					}`,
				})
			}
		}
	}

	return findings
}

function findingsFor(rule: Finding["rule"]): Array<Finding> {
	return proseFindings().filter((finding) => finding.rule === rule)
}

function report(findings: Array<Finding>): string {
	return findings
		.map((finding) => `${finding.file}:${finding.line} — ${finding.detail}`)
		.join("\n")
}

describe("Standard Library Prose", () => {
	// Every rule is only as good as the sentence splitter.
	describe("sentences", () => {
		it("should split where one sentence ends and the next begins", () => {
			expect(
				sentencesOf(
					"Answers the first item. An empty List answers nothing.",
				),
			).toEqual([
				"Answers the first item.",
				"An empty List answers nothing.",
			])
		})

		it("should split before a sentence that opens with a code span", () => {
			expect(
				sentencesOf(
					"Answers the first item. `last` answers the other end.",
				),
			).toEqual([
				"Answers the first item.",
				"code answers the other end.",
			])
			expect(
				sentencesOf("Counts from zero. `List.of(n)`. Then it stops."),
			).toEqual(["Counts from zero.", "code.", "Then it stops."])
			expect(sentencesOf("Two ways: `first` and `second`.")).toEqual([
				"Two ways: code and code.",
			])
		})

		it("should keep a code span whole, periods and all", () => {
			// One term, one word, and no sentence end inside it.
			expect(
				sentencesOf("Counts up, as `List.of(integersFrom 1)` does."),
			).toEqual(["Counts up, as code does."])
			expect(wordsOf(sentencesOf("`a.b.c` and `d.e`")[0]!)).toHaveLength(
				3,
			)
		})

		it("should not split at an abbreviation", () => {
			expect(
				sentencesOf(
					"A mode, e.g. `#Start`. The default is `#BothEnds`.",
				),
			).toEqual(["A mode, e.g. code.", "The default is code."])
			expect(sentencesOf("A name, i.e. `count`, is enough.")).toEqual([
				"A name, i.e. code, is enough.",
			])
		})

		it("should not split inside a number", () => {
			expect(sentencesOf("Rounds 1.5 to 2. Ties go up.")).toEqual([
				"Rounds 1.5 to 2.",
				"Ties go up.",
			])
		})

		it("should not split at a colon", () => {
			// A colon introduces an example, which the rules allow, so
			// what follows it is part of the same sentence and counts towards
			// the same limit.
			expect(sentencesOf("Two ways: The first is shorter.")).toEqual([
				"Two ways: The first is shorter.",
			])
		})
	})

	it("should find the Types the sources declare", () => {
		// The rule this scanner feeds passes on an empty list, so a pattern
		// that stopped matching would pass unnoticed.
		expect(declaredTypes().length).toBeGreaterThanOrEqual(20)
	})

	it("should find prose to read", () => {
		// Every rule passes on an empty report, so a collector that read no
		// file or found no Comment would pass unnoticed.
		let files = readStdlibFiles()

		expect(files.length).toBeGreaterThan(10)
		expect(
			files.flatMap(({ filePath, sourceText }) =>
				blocksOf(path.basename(filePath), sourceText),
			).length,
		).toBeGreaterThan(100)
	})

	it.skipIf(!REPORTING)("should print what each rule finds", () => {
		let findings = proseFindings()

		for (let rule of [
			"sentence-length",
			"em-dash",
			"may-should",
			"all-caps",
		] as const) {
			let found = findings.filter((finding) => finding.rule === rule)

			console.log(`\n${rule}: ${found.length}\n${report(found)}`)
		}

		let undocumented = undocumentedDeclarations()

		console.log(
			`\nundocumented-declaration: ${undocumented.length}\n${report(undocumented)}`,
		)

		let unparsable = unparsableCodeSpans()

		console.log(
			`\nunparsable-span: ${unparsable.length}\n${report(unparsable)}`,
		)
	})

	it("should keep every sentence to 25 words", () => {
		expect(report(findingsFor("sentence-length"))).toBe("")
	})

	it("should keep em-dash asides out of a '§§' sentence", () => {
		expect(report(findingsFor("em-dash"))).toBe("")
	})

	it("should write 'can' rather than 'may', and never 'should'", () => {
		expect(report(findingsFor("may-should"))).toBe("")
	})

	it("should spend no ALL-CAPS on emphasis", () => {
		expect(report(findingsFor("all-caps"))).toBe("")
	})

	it("should give every Choice and Type Alias a '§§' block", () => {
		expect(report(undocumentedDeclarations())).toBe("")
	})

	// The count guards the span scanner against matching nothing.
	it("should write a 'define' span a reader can copy", () => {
		expect(
			readStdlibFiles().flatMap(({ filePath, sourceText }) =>
				blocksOf(path.basename(filePath), sourceText).flatMap(
					(block) => [
						...block.lines.join(" ").matchAll(definePattern),
					],
				),
			).length,
		).toBeGreaterThanOrEqual(2)
		expect(report(unparsableCodeSpans())).toBe("")
	})
})
