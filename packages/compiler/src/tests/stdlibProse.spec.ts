import { describe, expect, it } from "bun:test"
import * as path from "node:path"

import { readStdlibFiles } from "@essence-lang/standard-library"

import { containsErrors } from "../diagnostics/index"
import { parseWithDiagnostics } from "../parser/index"

// NOTE: The writing rules the standard library's prose is held to, read off the
// sources themselves. They are the ASD-STE100 *writing* rules — not its
// dictionary, since the language's own terms are technical names — as agreed in
// `plans/2026-08-18-stdlib-readability.md` (B2):
//
// - No sentence over 25 words, in a `§§` block or a `§` note.
// - No em-dash aside inside a `§§` sentence. A tag's own separator is not one.
// - `can`, never `may`; no `should`.
// - No ALL-CAPS emphasis. An acronym is written in capitals and is allowed;
//   a Type or Namespace name is CamelCase and never matches.
//
// A fifth check is about WHERE the prose stands rather than how it reads: every
// `choice` and every `type` alias here carries a `§§` block, because a `§` note
// above one is read by the next editor of the file and by nobody who uses the
// Type. It is guarded by a count of its own, since a scanner that matched
// nothing would pass it silently.
//
// All four rules are live. The documentation pass (Phase 3 of the plan) took
// every source to zero findings, and a source that breaks one of them again
// fails here.
//
// `ESSENCE_PROSE_REPORT=1 bun test stdlibProse` prints what each rule finds,
// per rule and per file, with the line each finding sits on.

const REPORTING = process.env.ESSENCE_PROSE_REPORT !== undefined

const WORD_LIMIT = 25

// NOTE: Written in capitals and meant that way. Everything else in capitals is
// emphasis, which the rules spend on nothing. `O(1)` and the like never reach
// this list — a single capital is not three.
const ACRONYMS = new Set([
	"API",
	"ASCII",
	"AST",
	"CLI",
	"CPU",
	"CRLF",
	"JSON",
	"LSP",
	"NFC",
	"NFD",
	"NFKC",
	"NFKD",
	"UTF",
	"ZWJ",
])

// NOTE: An abbreviation ends in a period without ending a sentence. There are
// five of them in technical prose, and a sentence that ends in one of them is
// rare enough to be worth the one sentence a run-on makes.
const abbreviationPattern = /\b(?:e\.g|i\.e|etc|vs|cf)\.$/

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

// NOTE: A `choice` or a `type` alias declared in a `declarations` body. Both
// are Types a user's Program writes down, so both are read by somebody who
// never opens this directory, and a `§` note above one reaches nobody but the
// next editor of the file.
//
// NOTE: The indentation is not pinned, though every declaration here stands at
// one tab today. A pattern that reads the indentation would answer nothing for
// a declaration written at another one, and a rule that silently stops looking
// is worse than no rule — which is what the count below guards.
const declarationPattern = /^\s*(choice|type)\s+([A-Za-z][A-Za-z0-9]*)/

// NOTE: One run of Comment lines of the same sigil, with the line each started
// on. A `§§` run is the block above a Declaration; a `§` run is one note.
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

// NOTE: A `@param` or `@returns` head and the em-dash that separates it from
// its text. The separator is the form the rules ask for, so it is taken off
// before the em-dash rule ever sees the line.
const tagPattern = /^@(?:param\s+\S+|returns)\s*(?:—\s*)?/

// NOTE: What is being SHOWN rather than written: a fenced block holds example
// code, and counting its words says nothing about the prose.
const fencePattern = /^\s*(?:```|~~~)/

// NOTE: A `code span` is one term however long it is, and the periods inside it
// end no sentence — `List.of(integersFrom:through:)` is one word. Masked to a
// single lowercase token, which the ALL-CAPS rule also then leaves alone: what
// is written in code is spelled the way the code is.
function maskCode(text: string): string {
	return text.replace(/`[^`]*`/g, "code")
}

// NOTE: One paragraph of a block, kept as the lines it was written on so that
// a finding can name the line it starts at.
type Paragraph = {
	line: number
	parts: Array<string>
}

// NOTE: The paragraphs of one block, each already stripped of its tag head and
// of anything fenced. A blank line separates two paragraphs, and a sentence
// never runs across one.
function paragraphsOf(block: ProseBlock): Array<Paragraph> {
	let paragraphs: Array<Paragraph> = []
	let current: Paragraph | null = null
	let fenced = false

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

		let text = raw.replace(tagPattern, "").trim()

		if (text === "") {
			current = null

			continue
		}

		// NOTE: A tag opens a section of its own, so it opens a paragraph of
		// its own — its text is a sentence about that Parameter, and nothing
		// above it belongs to the same one.
		if (current === null || tagPattern.test(raw)) {
			current = { line, parts: [] }
			paragraphs.push(current)
		}

		current.parts.push(text)
	}

	return paragraphs
}

// NOTE: A sentence ends at a period, a question mark or an exclamation mark
// followed by a space and the start of another one. Not at a colon: a colon
// introduces an example, which the rules allow, and the example belongs to the
// sentence that introduced it. Not inside a number either — `1.5` is followed
// by no space — and not after an abbreviation, which is put back together
// below.
function sentencesOf(text: string): Array<string> {
	let sentences: Array<string> = []

	for (let piece of maskCode(text).split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)) {
		let previous = sentences[sentences.length - 1]

		// NOTE: The period that ends an abbreviation ends no sentence, so what
		// it split off is put back on. Nothing is masked to arrange that — a
		// placeholder in the text would have to survive every rule below it.
		if (previous !== undefined && abbreviationPattern.test(previous)) {
			sentences[sentences.length - 1] = `${previous} ${piece}`

			continue
		}

		sentences.push(piece)
	}

	return sentences
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence !== "")
}

function wordsOf(sentence: string): Array<string> {
	return sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word))
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

					if (block.kind === "§§" && sentence.includes("—")) {
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
						let capitals = /^[A-Z]{3,}$/.exec(
							word.replace(/[^A-Za-z]/g, ""),
						)

						if (capitals !== null && !ACRONYMS.has(capitals[0])) {
							findings.push({
								rule: "all-caps",
								file,
								line: paragraph.line,
								detail: `'${capitals[0]}': ${sentence}`,
							})
						}
					}
				}
			}
		}
	}

	return findings
}

// NOTE: The Types the sources declare, each with whether the Comment run
// directly above it holds a `§§` block. The run is walked upwards over every
// Comment line, `§` notes included, because the Parser reads the documentation
// above the Statement whatever else stands between: a note that explains a
// decision does not take the block away.
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

			let documented = false

			for (let above = index - 1; above >= 0; above--) {
				let comment = commentPattern.exec(lines[above] ?? "")

				if (comment === null) {
					break
				}

				if (comment[1] === "§§") {
					documented = true

					break
				}
			}

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

// NOTE: A code span holding a `define` is written out for a reader to COPY —
// it is the one construct the prose spells in full rather than naming — and
// two of them told a reader to write `define { as v if c otherwise d }`, which
// the parser refuses: the form is `as v if c as d otherwise`. Both stood in
// Hover text on `Boolean::and` and `or`. So every such span is parsed here, in
// the body a call site would put it in. Only `define` spans are: the rest of
// the code spans in this library name Types, Methods and signature fragments,
// none of which is an Expression.
const definePattern = /`(define\s*\{[^`]*)`/g

export function unparsableCodeSpans(): Array<Finding> {
	let findings: Array<Finding> = []

	for (let { filePath, sourceText } of readStdlibFiles()) {
		for (let block of blocksOf(path.basename(filePath), sourceText)) {
			// NOTE: The lines of one block are joined, because a span can
			// break across two Comment lines and each half alone parses as
			// nothing.
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
	// NOTE: The splitter decides what a "sentence" is, so every rule above is
	// only as good as it is. These run — they are about the reader here, not
	// about the sources.
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

		it("should keep a code span whole, periods and all", () => {
			// NOTE: One term, one word, and no sentence end inside it.
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
		})

		it("should not split inside a number", () => {
			expect(sentencesOf("Rounds 1.5 to 2. Ties go up.")).toEqual([
				"Rounds 1.5 to 2.",
				"Ties go up.",
			])
		})

		it("should not split at a colon", () => {
			// NOTE: A colon introduces an example, which the rules allow, so
			// what follows it is part of the same sentence and counts towards
			// the same limit.
			expect(sentencesOf("Two ways: The first is shorter.")).toEqual([
				"Two ways: The first is shorter.",
			])
		})
	})

	it("should find the Types the sources declare", () => {
		// NOTE: The same guard as the one below, for the declaration scanner.
		// The rule it feeds passes on an empty list, so a pattern that stopped
		// matching would turn the whole check into a no-op nobody notices.
		// There are twenty Choices and Type Aliases as this is written.
		expect(declaredTypes().length).toBeGreaterThanOrEqual(20)
	})

	it("should find prose to read", () => {
		// NOTE: A guard on the reading above. Every rule below passes on an
		// empty report, so a collector that read no file, or that found no
		// Comment in the files it read, would make the whole file a no-op that
		// nobody notices. The sources hold hundreds of blocks.
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

	// NOTE: A `§§` block is what a reader of the LANGUAGE sees and a `§` note
	// is what the next editor of the file sees, so a Type documented by a note
	// alone is documented for nobody who uses it. Every `choice` and every
	// `type` alias here carries one, and this is what keeps that true: the
	// library's Types are as much of its surface as its Methods are.
	it("should give every Choice and Type Alias a '§§' block", () => {
		expect(report(undocumentedDeclarations())).toBe("")
	})

	// NOTE: The count guards the scanner, as the two above guard theirs: a
	// pattern that stopped matching would make this pass on nothing. There
	// are two `define` spans as this is written, both on `Boolean`.
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
