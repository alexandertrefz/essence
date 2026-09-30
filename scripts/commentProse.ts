import { readFileSync } from "node:fs"
import * as path from "node:path"

import {
	capitalsOf,
	hasEmDash,
	maskCode,
	sentencesOf,
	wordsOf,
} from "@essence-lang/fixtures/prose"
import { spawnAndWait } from "@essence-lang/fixtures/spawn"
import { LanguageVariant, SyntaxKind } from "typescript/unstable/ast"
import { createScanner, getShebang } from "typescript/unstable/ast/scanner"

import { REPOSITORY_ROOT } from "./publishing/packages"

// The rules every comment in the TypeScript and JavaScript sources is held to.
// `scripts/tests/commentProse.spec.ts` compares what they find in each file
// with `scripts/tests/commentProse.baseline.json`.

export const RULES = [
	"no-note-prefix",
	"sentence-length",
	"em-dash",
	"all-caps",
	"history",
	"position",
	"block-length",
	"stacked",
	"counts",
	"citation",
] as const

export type Rule = (typeof RULES)[number]

export type Finding = {
	file: string
	line: number
	rule: Rule
	detail: string
}

export const BASELINE_PATH = path.join(
	REPOSITORY_ROOT,
	"scripts/tests/commentProse.baseline.json",
)

export const UPDATE_COMMAND = "bun run comments:baseline"

const WORD_LIMIT = 25

const LINE_LIMIT = 6

// Written in capitals and meant that way. A word in capitals that its file also
// spells in code or in a String is a name, and needs no listing here.
const ACRONYMS = new Set([
	"ANSI",
	"API",
	"ASCII",
	"AST",
	"BEL",
	"CDP",
	"CJK",
	"CLI",
	"CPU",
	"CRLF",
	"CSS",
	"DAG",
	"DAP",
	"DEL",
	"DOM",
	"ESM",
	"HMR",
	"HTML",
	"HTTP",
	"ICE",
	"IEEE",
	"INVARIANT",
	"JSON",
	"JSONC",
	"JSX",
	"LCOV",
	"LHS",
	"LSP",
	"MDX",
	"MIT",
	"NFC",
	"NFD",
	"NFKC",
	"NFKD",
	"NUL",
	"README",
	"RHS",
	"SCC",
	"SHA",
	"SIGINT",
	"SIGKILL",
	"SIGTERM",
	"SQL",
	"SVG",
	"TOC",
	"TODO",
	"TTY",
	"URI",
	"URL",
	"UTF",
	"WARNING",
	"ZWJ",
])

// Vendored, generated or captured output, none of which is written here.
const excludedPattern =
	/^packages\/escodegen\/|(^|\/)(node_modules|dist|coverage|__snapshots__)\/|\.snap$|^packages\/runtime\/src\/natives\.generated\.ts$/

const scriptPattern = /\.(ts|js|mjs|cjs)$/

export async function trackedScripts(): Promise<Array<string>> {
	let listed = await spawnAndWait(["git", "ls-files", "-z"], {
		cwd: REPOSITORY_ROOT,
	})

	if (listed.code !== 0) {
		throw new Error(`git ls-files failed: ${listed.stderr}`)
	}

	return listed.stdout
		.split("\0")
		.filter(
			(file) => scriptPattern.test(file) && !excludedPattern.test(file),
		)
		.sort()
}

type Comment = {
	pos: number
	end: number
	kind: "line" | "block"
}

type Scanned = {
	comments: Array<Comment>
	names: Array<string>
	// Where the first token that is not part of an `import` stands.
	codeStart: number
}

// After one of these a `/` opens a regular expression; after any other
// keyword it divides.
const regexpAfterKeywords = new Set([
	SyntaxKind.ReturnKeyword,
	SyntaxKind.TypeOfKeyword,
	SyntaxKind.CaseKeyword,
	SyntaxKind.DoKeyword,
	SyntaxKind.ElseKeyword,
	SyntaxKind.InKeyword,
	SyntaxKind.OfKeyword,
	SyntaxKind.NewKeyword,
	SyntaxKind.DeleteKeyword,
	SyntaxKind.VoidKeyword,
	SyntaxKind.ThrowKeyword,
	SyntaxKind.InstanceOfKeyword,
	SyntaxKind.YieldKeyword,
	SyntaxKind.AwaitKeyword,
])

// The tokens a value ends with. A `/` after one divides.
const valueEnds = new Set([
	SyntaxKind.Identifier,
	SyntaxKind.PrivateIdentifier,
	SyntaxKind.NumericLiteral,
	SyntaxKind.BigIntLiteral,
	SyntaxKind.StringLiteral,
	SyntaxKind.NoSubstitutionTemplateLiteral,
	SyntaxKind.TemplateTail,
	SyntaxKind.RegularExpressionLiteral,
	SyntaxKind.CloseParenToken,
	SyntaxKind.CloseBracketToken,
	SyntaxKind.CloseBraceToken,
	SyntaxKind.PlusPlusToken,
	SyntaxKind.MinusMinusToken,
])

const trivia = new Set([
	SyntaxKind.WhitespaceTrivia,
	SyntaxKind.NewLineTrivia,
	SyntaxKind.ConflictMarkerTrivia,
])

const textTokens = new Set([
	SyntaxKind.StringLiteral,
	SyntaxKind.NoSubstitutionTemplateLiteral,
	SyntaxKind.TemplateHead,
	SyntaxKind.TemplateMiddle,
	SyntaxKind.TemplateTail,
])

function endsValue(kind: SyntaxKind): boolean {
	if (kind >= SyntaxKind.FirstKeyword && kind <= SyntaxKind.LastKeyword) {
		return !regexpAfterKeywords.has(kind)
	}

	return valueEnds.has(kind)
}

// The scanner reads tokens without a parser, so it is told what the parser
// would know. A `/` after a value divides and anywhere else opens a regular
// expression. A `}` that closes a template hole resumes the template.
export function scanScript(text: string): Scanned {
	let scanner = createScanner(false, LanguageVariant.Standard, text)

	// A `#!` line is read by the shell, and the scanner starts after it.
	scanner.resetTokenState(getShebang(text)?.length ?? 0)
	let comments: Array<Comment> = []
	let names: Array<string> = []
	let braces: Array<"brace" | "hole"> = []
	let previous: SyntaxKind | null = null
	let codeStart = -1
	let inImport = false

	for (
		let kind = scanner.scan();
		kind !== SyntaxKind.EndOfFile;
		kind = scanner.scan()
	) {
		if (
			kind === SyntaxKind.SingleLineCommentTrivia ||
			kind === SyntaxKind.MultiLineCommentTrivia
		) {
			comments.push({
				pos: scanner.getTokenStart(),
				end: scanner.getTokenEnd(),
				kind:
					kind === SyntaxKind.SingleLineCommentTrivia
						? "line"
						: "block",
			})

			continue
		}

		if (trivia.has(kind)) {
			continue
		}

		if (
			(kind === SyntaxKind.SlashToken ||
				kind === SyntaxKind.SlashEqualsToken) &&
			(previous === null || !endsValue(previous))
		) {
			kind = scanner.reScanSlashToken()
		}

		kind = trackBraces(scanner, kind, braces)

		// A `!` straight after a value asserts that it is not null and ends
		// the value, so a `/` after it divides.
		if (
			kind === SyntaxKind.ExclamationToken &&
			previous !== null &&
			endsValue(previous) &&
			!scanner.hasPrecedingLineBreak()
		) {
			kind = SyntaxKind.CloseParenToken
		}

		if (codeStart === -1) {
			if (kind === SyntaxKind.ImportKeyword && !inImport) {
				inImport = true
			} else if (!inImport && kind !== SyntaxKind.SemicolonToken) {
				codeStart = scanner.getTokenStart()
			} else if (kind === SyntaxKind.StringLiteral) {
				inImport = false
			}
		}

		if (kind === SyntaxKind.Identifier || textTokens.has(kind)) {
			names.push(scanner.getTokenText())
		}

		previous = kind
	}

	return {
		comments,
		names,
		codeStart: codeStart === -1 ? text.length : codeStart,
	}
}

function trackBraces(
	scanner: ReturnType<typeof createScanner>,
	kind: SyntaxKind,
	braces: Array<"brace" | "hole">,
): SyntaxKind {
	if (kind === SyntaxKind.OpenBraceToken) {
		braces.push("brace")
	} else if (kind === SyntaxKind.TemplateHead) {
		braces.push("hole")
	} else if (kind === SyntaxKind.CloseBraceToken && braces.pop() === "hole") {
		let resumed = scanner.reScanTemplateToken(false)

		if (resumed === SyntaxKind.TemplateMiddle) {
			braces.push("hole")
		}

		return resumed
	}

	return kind
}

// One line of a comment, with its `//`, `/*`, `*` or `*/` taken off. A line
// indented by a tab or by five blanks or more after its opener is code.
type CommentLine = {
	line: number
	text: string
	code: boolean
}

type Block = {
	kind: "line" | "block"
	pos: number
	end: number
	line: number
	ownLine: boolean
	lines: Array<CommentLine>
}

// A comment line that is not prose. It is a directive to a tool, a region
// marker, or a JSDoc tag carrying a Type for the type checker.
const directivePattern =
	/^(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|check|nocheck)\b|#(?:end)?region\b|<reference\s|[@#]__PURE__|@(?:type|typedef|template|import|satisfies|callback|overload)\b|@\w+\s*\{)/

function isProse(line: CommentLine): boolean {
	return /[\p{L}\p{N}]/u.test(line.text) && !directivePattern.test(line.text)
}

function isCode(blanks: string): boolean {
	return blanks.includes("\t") || blanks.length >= 5
}

function lineComment(raw: string, line: number): CommentLine {
	let [, blanks = "", text = ""] = /^\/\/\/?([ \t]*)(.*)$/.exec(raw) ?? []

	return { line, text: text.trimEnd(), code: isCode(blanks) }
}

function blockCommentLines(raw: string, line: number): Array<CommentLine> {
	let body = raw.replace(/^\/\*\*?/, "").replace(/\*\/$/, "")

	return body.split("\n").map((part, index) => {
		let [, blanks = "", text = ""] =
			(index === 0 ? /^([ \t]*)(.*)$/ : /^[ \t]*\*?([ \t]*)(.*)$/).exec(
				part,
			) ?? []

		return {
			line: line + index,
			text: text.trimEnd(),
			code: isCode(blanks),
		}
	})
}

function lineStartsOf(text: string): Array<number> {
	let starts = [0]

	for (let index = text.indexOf("\n"); index !== -1;) {
		starts.push(index + 1)
		index = text.indexOf("\n", index + 1)
	}

	return starts
}

function lineAt(starts: Array<number>, offset: number): number {
	let low = 0
	let high = starts.length - 1

	while (low < high) {
		let middle = (low + high + 1) >> 1

		if (starts[middle]! <= offset) {
			low = middle
		} else {
			high = middle - 1
		}
	}

	return low + 1
}

function standsAlone(text: string, starts: Array<number>, comment: Comment) {
	let before = text.slice(
		starts[lineAt(starts, comment.pos) - 1],
		comment.pos,
	)
	let lineEnd = text.indexOf("\n", comment.end)
	let after = text.slice(comment.end, lineEnd === -1 ? text.length : lineEnd)

	return before.trim() === "" && after.trim() === ""
}

// A run of `//` lines with nothing but their own line breaks between them is
// one block, blank comment lines included. A `/* */` comment is a block of its
// own, and so is a comment that shares its line with code.
function blocksOf(text: string, comments: Array<Comment>): Array<Block> {
	let starts = lineStartsOf(text)
	let blocks: Array<Block> = []

	for (let comment of comments) {
		let line = lineAt(starts, comment.pos)
		let raw = text.slice(comment.pos, comment.end)
		let ownLine = standsAlone(text, starts, comment)
		let last = blocks[blocks.length - 1]

		if (
			comment.kind === "line" &&
			ownLine &&
			last !== undefined &&
			last.kind === "line" &&
			last.ownLine &&
			text.slice(last.end, comment.pos).trim() === "" &&
			lineAt(starts, last.end) === line - 1
		) {
			last.end = comment.end
			last.lines.push(lineComment(raw, line))

			continue
		}

		blocks.push({
			kind: comment.kind,
			pos: comment.pos,
			end: comment.end,
			line,
			ownLine,
			lines:
				comment.kind === "line"
					? [lineComment(raw, line)]
					: blockCommentLines(raw, line),
		})
	}

	return blocks
}

type Paragraph = {
	parts: Array<CommentLine>
}

const fencePattern = /^(?:```|~~~)/

const listItemPattern = /^(?:[-*+•]|\d+[.)])\s/

// A JSDoc tag's head, which opens a section of its own. The text after it is
// prose about that one thing.
const tagPattern =
	/^@(?:param|arg|argument|property|prop)\s+(?:\{[^}]*\}\s*)?\S+\s*(?:-\s*)?|^@(?:returns?|throws|see|example|deprecated|remarks|default|since|internal)\b\s*/

// The paragraphs of a block. A blank line, a list item, a tag and a code sample
// each end a paragraph. Code itself is left out.
function paragraphsOf(block: Block): Array<Paragraph> {
	let paragraphs: Array<Paragraph> = []
	let current: Paragraph | null = null
	let fenced = false
	let example = false

	for (let line of block.lines) {
		if (fencePattern.test(line.text)) {
			fenced = !fenced
			current = null

			continue
		}

		if (tagPattern.test(line.text)) {
			example = /^@example\b/.test(line.text)
		}

		if (fenced || example || line.code || !isProse(line)) {
			current = null

			continue
		}

		let text = line.text.replace(tagPattern, "")

		if (
			current === null ||
			listItemPattern.test(line.text) ||
			tagPattern.test(line.text)
		) {
			current = { parts: [] }
			paragraphs.push(current)
		}

		if (text !== "") {
			current.parts.push({ ...line, text })
		}
	}

	return paragraphs.filter((paragraph) => paragraph.parts.length > 0)
}

type Sentence = {
	text: string
	lineAt: (offset: number) => number
}

// The sentences of a paragraph, each able to say which comment line a
// position inside it stands on. Code spans and URLs are masked first, so the
// offsets are taken in the masked text and mapped back.
function sentencesIn(paragraph: Paragraph): Array<Sentence> {
	let joined = ""
	let lineStarts: Array<{ offset: number; line: number }> = []

	for (let part of paragraph.parts) {
		joined += joined === "" ? "" : " "
		lineStarts.push({ offset: joined.length, line: part.line })
		joined += part.text
			.replace(/\b(?:https?|file):\/\/\S+/g, "url")
			.replace(/\bU\+[0-9A-F]{4,6}\b/g, "U+code")
	}

	let shifts: Array<{ masked: number; shift: number }> = []
	let shift = 0

	for (let match of joined.matchAll(/`[^`]*`/g)) {
		let maskedEnd = match.index - shift + "code".length

		shift += match[0].length - "code".length
		shifts.push({ masked: maskedEnd, shift })
	}

	let masked = maskCode(joined)
	let lineOf = (maskedOffset: number) => {
		let original = maskedOffset

		for (let entry of shifts) {
			if (entry.masked <= maskedOffset) {
				original = maskedOffset + entry.shift
			}
		}

		let line = lineStarts[0]!.line

		for (let start of lineStarts) {
			if (start.offset <= original) {
				line = start.line
			}
		}

		return line
	}

	let cursor = 0

	return sentencesOf(joined).map((text) => {
		let found = masked.indexOf(text, cursor)
		let start = found === -1 ? cursor : found

		cursor = found === -1 ? cursor : found + text.length

		return { text, lineAt: (offset) => lineOf(start + offset) }
	})
}

// A word in capitals is allowed when the file spells it in code too, since it
// is a name there. So is a word with an underscore or a digit in it, and a
// marker such as `WARNING:` that the rules judge as a marker.
function emphasisIn(
	sentence: string,
	names: Set<string>,
): Array<{
	word: string
	offset: number
}> {
	let found: Array<{ word: string; offset: number }> = []

	for (let match of sentence.matchAll(/\S+/g)) {
		let word = match[0]
		let capitals = capitalsOf(word)
		let bare = word.replace(/^[^\w$]+|[^\w$]+$/g, "")

		if (
			capitals === null ||
			ACRONYMS.has(capitals) ||
			names.has(bare) ||
			names.has(capitals) ||
			/[_\d]/.test(bare) ||
			/^(?:NOTE|WARNING|INVARIANT|TODO):$/.test(word)
		) {
			continue
		}

		found.push({ word: capitals, offset: match.index })
	}

	return found
}

// Sentences that tell the story of the code rather than what it does now.
// "No longer" and "anymore" say as often what a value stops being while the
// code runs, so they are left to the reader.
const historyPattern =
	/(?<!\b(?:is|are|was|were|be|been|being|gets?)\s)\bused to\b|^Previously\b|\bmaster\b|\bdecision [A-Z]?\d+\b/g

// Pointers to other comments or code by where they stand in the file. A word
// of position with an object after it describes the text a Program handles,
// and is left alone.
const positionPattern =
	/\b(?:above|below)\b(?!\s+(?:it|them|this|that|these|those|the|a|an|its|their|each|every|any|all|one|zero|\d))|\b(?:earlier|later) in (?:this|the) (?:file|module)\b|\bthe (?:paragraph|note) (?:before|after)\b|\bthe (?:preceding|following) (?:paragraph|note)\b/gi

const manyWords = "three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+"

// What code is counted in. A pair of branches, paths or arms is usually the
// shape of the thing itself, so a pair is only counted in the first group.
// "Places" is left out: it counts the positions the language allows as often.
const scatteredNouns =
	"sites?|callers|call sites|copies|specs|files|packages|helpers|functions|methods|checks"

const countedNouns = `${scatteredNouns}|modules|passes|rules|tests|entries|paths|branches|arms|overloads|steps|phases|stages`

// A count of other code, which goes stale when that code changes.
const countsPattern = new RegExp(
	[
		`\\b(?:the|these|those|all|its|their)\\s+(?:${manyWords})\\s+(?:\\w+\\s+)?(?:${countedNouns})\\b`,
		`\\b(?:the|these|those|both|its|their)\\s+two\\s+(?:\\w+\\s+)?(?:${scatteredNouns})\\b`,
		`\\bthe\\s+(?:third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\\d+(?:rd|th))\\s+(?:pass|site|rule|check|step|phase|stage|helper|spec|test|branch|arm)\\b`,
	].join("|"),
	"gi",
)

// A pointer to a file of development notes names one of its headings. A bare
// file name is the nearest one walking up from the comment's file. A path
// starts at the repository root.
const citationPattern = /\bSee "([^"]+)" in ((?:[\w.@-]+\/)*DEVELOPMENT\.md)\./g

const mentionPattern = /DEVELOPMENT\.md/g

export type Citation = {
	file: string
	line: number
	heading: string
	// The notes the citation names by path, or null for the nearest ones.
	path: string | null
}

type Joined = {
	text: string
	lineAt: (offset: number) => number
}

// A block's lines joined by blanks, so that a quoted heading may wrap.
function joinedOf(block: Block): Joined {
	let text = ""
	let starts: Array<{ offset: number; line: number }> = []

	for (let line of block.lines) {
		if (line.text === "") {
			continue
		}

		text += text === "" ? "" : " "
		starts.push({ offset: text.length, line: line.line })
		text += line.text
	}

	return {
		text,
		lineAt: (offset) =>
			starts.findLast((start) => start.offset <= offset)?.line ??
			block.line,
	}
}

function citationsOf(file: string, joined: Joined): Array<Citation> {
	return [...joined.text.matchAll(citationPattern)].map((match) => ({
		file,
		line: joined.lineAt(match.index),
		heading: match[1]!,
		path: match[2] === "DEVELOPMENT.md" ? null : match[2]!,
	}))
}

// The lines of a block that mention development notes outside a citation.
function uncitedMentionsOf(joined: Joined): Array<number> {
	let cited = [...joined.text.matchAll(citationPattern)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}))

	return [...joined.text.matchAll(mentionPattern)]
		.filter(
			(mention) =>
				!cited.some(
					(range) =>
						range.start <= mention.index &&
						mention.index < range.end,
				),
		)
		.map((mention) => joined.lineAt(mention.index))
}

type Context = {
	file: string
	names: Set<string>
	findings: Array<Finding>
}

function checkSentence(context: Context, sentence: Sentence) {
	let { file, findings, names } = context
	let text = sentence.text
	let words = wordsOf(text)
	let push = (rule: Rule, offset: number, detail: string) => {
		findings.push({ file, line: sentence.lineAt(offset), rule, detail })
	}

	if (words.length > WORD_LIMIT) {
		push("sentence-length", 0, `${words.length} words: ${text}`)
	}

	if (hasEmDash(text)) {
		push("em-dash", text.indexOf("—"), text)
	}

	for (let { word, offset } of emphasisIn(text, names)) {
		push("all-caps", offset, `'${word}': ${text}`)
	}

	for (let [rule, pattern] of [
		["history", historyPattern],
		["position", positionPattern],
		["counts", countsPattern],
	] as const) {
		for (let match of text.matchAll(pattern)) {
			push(rule, match.index, `'${match[0]}': ${text}`)
		}
	}
}

// The lines of a block that count toward its length: prose and blank lines.
// An indented or fenced code example is left out.
function proseLinesOf(block: Block): Array<CommentLine> {
	let counted: Array<CommentLine> = []
	let fenced = false

	for (let line of block.lines) {
		if (fencePattern.test(line.text)) {
			fenced = !fenced

			continue
		}

		if (!fenced && !line.code && (line.text === "" || isProse(line))) {
			counted.push(line)
		}
	}

	return counted
}

function checkBlock(context: Context, block: Block, header: boolean) {
	let prose = block.lines.filter(isProse)
	let first = prose[0]

	for (let line of prose) {
		if (line.text.startsWith("NOTE:")) {
			context.findings.push({
				file: context.file,
				line: line.line,
				rule: "no-note-prefix",
				detail: line.text,
			})
		}
	}

	let counted = proseLinesOf(block)

	// The delimiters of a `/* */` block hold no text of their own.
	while (counted[0]?.text === "") {
		counted.shift()
	}

	while (counted[counted.length - 1]?.text === "") {
		counted.pop()
	}

	if (!header && first !== undefined && counted.length > LINE_LIMIT) {
		context.findings.push({
			file: context.file,
			line: first.line,
			rule: "block-length",
			detail: `${counted.length} lines: ${first.text}`,
		})
	}

	for (let paragraph of paragraphsOf(block)) {
		for (let sentence of sentencesIn(paragraph)) {
			checkSentence(context, sentence)
		}
	}
}

export type Source = {
	file: string
	text: string
	scanned: Scanned
}

export function readSource(file: string): Source {
	return sourceOf(
		file,
		readFileSync(path.join(REPOSITORY_ROOT, file), "utf8"),
	)
}

// Every name a file spells in its code or its Strings, which a word in capitals
// in its comments may repeat.
function namesOf(source: Source): Set<string> {
	let names = new Set<string>()

	for (let name of source.scanned.names) {
		for (let word of name.split(/[^\w$]+/)) {
			if (word !== "") {
				names.add(word)
			}
		}
	}

	return names
}

// A section banner is a one-line title between two comments of punctuation,
// each on its own line. It titles the code under it rather than explaining it.
function isBanner(blocks: Array<Block>, index: number): boolean {
	let rule = (block: Block | undefined) =>
		block !== undefined && !block.lines.some(isProse)
	let block = blocks[index]!
	let above = blocks[index - 1]
	let below = blocks[index + 1]

	return (
		block.lines.length === 1 &&
		rule(above) &&
		rule(below) &&
		above!.line === block.line - 1 &&
		below!.line === block.line + 1
	)
}

export function findingsIn(source: Source): Array<Finding> {
	let context: Context = {
		file: source.file,
		names: namesOf(source),
		findings: [],
	}
	let blocks = blocksOf(source.text, source.scanned.comments).filter(
		(_, index, all) => !isBanner(all, index),
	)
	let prose = blocks.filter((block) => block.lines.some(isProse))
	// A file's leading block introduces the whole file, so it can run long.
	let header =
		prose[0] !== undefined && prose[0].end <= source.scanned.codeStart
			? prose[0]
			: undefined

	for (let block of prose) {
		checkBlock(context, block, block === header)

		for (let line of uncitedMentionsOf(joinedOf(block))) {
			context.findings.push({
				file: source.file,
				line,
				rule: "citation",
				detail: block.lines.find((part) => part.line === line)!.text,
			})
		}
	}

	// The file's header may stand above the comment on its first declaration.
	for (let index = 1; index < blocks.length; index++) {
		let above = blocks[index - 1]!
		let next = blocks[index]!

		if (
			above !== header &&
			above.ownLine &&
			next.ownLine &&
			above.lines.some(isProse) &&
			next.lines.some(isProse) &&
			source.text.slice(above.end, next.pos).trim() === ""
		) {
			context.findings.push({
				file: source.file,
				line: next.line,
				rule: "stacked",
				detail: next.lines.find(isProse)!.text,
			})
		}
	}

	return context.findings.sort((left, right) => left.line - right.line)
}

export function sourceOf(file: string, text: string): Source {
	return { file, text, scanned: scanScript(text) }
}

export function citationsIn(source: Source): Array<Citation> {
	return blocksOf(source.text, source.scanned.comments).flatMap((block) =>
		citationsOf(source.file, joinedOf(block)),
	)
}

export async function repositoryFindings(): Promise<Array<Finding>> {
	return (await trackedScripts()).flatMap((file) =>
		findingsIn(readSource(file)),
	)
}

export type Counts = Record<string, Partial<Record<Rule, number>>>

export function countsOf(findings: Array<Finding>): Counts {
	let counts: Counts = {}

	for (let { file, rule } of findings) {
		let perFile = (counts[file] ??= {})

		perFile[rule] = (perFile[rule] ?? 0) + 1
	}

	return sortedCounts(counts)
}

function sortedCounts(counts: Counts): Counts {
	let sorted: Counts = {}

	for (let file of Object.keys(counts).sort()) {
		let perFile: Partial<Record<Rule, number>> = {}

		for (let rule of RULES) {
			let count = counts[file]![rule]

			if (count !== undefined && count > 0) {
				perFile[rule] = count
			}
		}

		if (Object.keys(perFile).length > 0) {
			sorted[file] = perFile
		}
	}

	return sorted
}

export function readBaseline(): Counts {
	return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Counts
}

// One line per file, so a change to one file's counts is a one-line diff.
export function formatBaseline(counts: Counts): string {
	let lines = Object.entries(sortedCounts(counts)).map(
		([file, perFile]) =>
			`\t${JSON.stringify(file)}: ${JSON.stringify(perFile).replace(/,"/g, ', "').replace(/":/g, '": ')}`,
	)

	return lines.length === 0 ? "{}\n" : `{\n${lines.join(",\n")}\n}\n`
}

// A file and rule whose count of findings differs from the baseline's.
export type Drift = {
	file: string
	rule: Rule
	baseline: number
	found: number
	// The findings behind `found`, in line order.
	findings: Array<Finding>
}

export function driftOf(
	findings: Array<Finding>,
	baseline: Counts,
): Array<Drift> {
	let counts = countsOf(findings)
	let files = [
		...new Set([...Object.keys(counts), ...Object.keys(baseline)]),
	].sort()
	let drift: Array<Drift> = []

	for (let file of files) {
		for (let rule of RULES) {
			let found = counts[file]?.[rule] ?? 0
			let allowed = baseline[file]?.[rule] ?? 0

			if (found !== allowed) {
				drift.push({
					file,
					rule,
					baseline: allowed,
					found,
					findings: findings.filter(
						(finding) =>
							finding.file === file && finding.rule === rule,
					),
				})
			}
		}
	}

	return drift
}

// Where the findings behind a count stand, as "line 4" or "lines 4, 17".
export function linesOf(drift: Drift): string {
	let lines = drift.findings.map((finding) => finding.line)

	return `${lines.length === 1 ? "line" : "lines"} ${lines.join(", ")}`
}

function timesOf(count: number): string {
	return count === 1 ? "once" : `${count} times`
}

// A count that rose names every line, since the baseline can not say which
// finding is the new one. The first finding is quoted under it.
export function describeDrift(drift: Drift): string {
	let first = drift.findings[0]
	let quoted =
		first === undefined
			? ""
			: `\n    ${drift.file}:${first.line}: ${first.detail}`

	if (drift.found > drift.baseline) {
		return `${drift.file}: '${drift.rule}' found ${timesOf(drift.found)} where the baseline allows ${drift.baseline}, on ${linesOf(drift)}. Rewrite the comment, since \`${UPDATE_COMMAND}\` never raises a count.${quoted}`
	}

	return `${drift.file}: '${drift.rule}' found ${timesOf(drift.found)} where the baseline records ${drift.baseline}. Run \`${UPDATE_COMMAND}\` to lower the baseline.${quoted}`
}

// The baseline with every count that fell lowered to what is found now. A count
// that rose is refused and kept, and so is a file the baseline does not list.
// Raising a count is a hand edit that shows in the diff.
export function lowerBaseline(
	baseline: Counts,
	drift: Array<Drift>,
): { next: Counts; lowered: Array<Drift>; refused: Array<Drift> } {
	let next = structuredClone(baseline)
	let lowered: Array<Drift> = []
	let refused: Array<Drift> = []

	for (let entry of drift) {
		if (entry.found < entry.baseline) {
			let perFile = (next[entry.file] ??= {})

			perFile[entry.rule] = entry.found
			lowered.push(entry)
		} else {
			refused.push(entry)
		}
	}

	return { next: sortedCounts(next), lowered, refused }
}
