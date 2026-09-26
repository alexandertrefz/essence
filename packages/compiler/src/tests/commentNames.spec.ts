import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"

// NOTE: A comment that names code by a name nothing declares sends its reader
// looking for a Function, a Type or a Method label that is not there. A rename
// leaves such names behind: the code moves on and the note above it keeps the
// old spelling. So every name a comment quotes in backticks is looked for in the
// code of every tracked source file: TypeScript, JavaScript, Astro and Essence.
//
// A quoted name is checked when it is written the way code names are: a word of
// letters with both capitals and lowercase in it, so `describeType` and `List`
// are checked and `slice`, `NFC` and `ok_3f_` are not. A lowercase word reads
// the same as an English one, and a name with a digit, an underscore or a `$`
// in it is a generated one or an example. Such words join with `.`, `::` and
// `#`, and a selector such as `everyItem(where:)` holds each label to the
// labels a Method of that name is declared or called with.
//
// A name counts as present when it is written anywhere outside a comment: in
// code, in a String (the Essence programs the specs compile are Strings), or as
// the name of a tracked file.
//
// A failure names the file and line of each name the code lacks. Correct the
// comment to name what the code has now, or take the name out. A name from
// outside this repository, or one a note writes for what the code does not
// have, belongs in `OUTSIDE_NAMES` or `ABSENT_NAMES` with its reason.

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../..")

// NOTE: This file's own code is left out of what counts as present. Its lists
// and its examples spell every name they allow, which would make each one so.
const THIS_FILE = path.relative(REPOSITORY_ROOT, import.meta.path)

// NOTE: Names from outside this repository, quoted as the platform, a protocol
// or a tool spells them. Each is a name the code has no reason to write.
const OUTSIDE_NAMES = new Map([
	["AsyncLocalStorage", "Node's `node:async_hooks` class"],
	["ReferenceError", "the JavaScript error a missing binding throws"],
	["SyntaxError", "the JavaScript error unparsable code throws"],
	["getSetCookie", "the Fetch standard's `Headers` Method"],
	["hasFocus", "the DOM's `document.hasFocus()`"],
	["relatedTarget", "the DOM focus event's field"],
	["Expires", "the cookie attribute"],
	["FileOperationPatternOptions", "the Language Server Protocol's type"],
	["ignoreCase", "the field of `FileOperationPatternOptions`"],
	["fixAll", "the Language Server Protocol's `source.fixAll` kind"],
	["setBreakpoints", "the Debug Adapter Protocol's request"],
	["configurationDone", "the Debug Adapter Protocol's request"],
	["strictFunctionTypes", "the TypeScript compiler option"],
	["compressHTML", "the Astro configuration option"],
	["MarkdownHeading", "Astro's heading type"],
	["mapError", "Elm's name for the transform on a failure"],
])

// NOTE: Names a comment writes for what the code does NOT have: an alternative
// a design note weighs and turns down, a slip a Diagnostic is shown, a name in
// an example Program. An entry written as a selector allows that one label.
// What the code USED TO have is not one of these. A note says why the code is
// as it is now, so a removed name comes out of it.
const ABSENT_NAMES = new Map([
	["Age", "the refined Type in `makeGeneratable.ts`'s example"],
	["Binary", "a Case of the base Choice `Integer.es` turns down"],
	["Octal", "a Case of the base Choice `Integer.es` turns down"],
	["Hexadecimal", "a Case of the base Choice `Integer.es` turns down"],
	["ChoiceName", "the placeholder in the written form of a Case"],
	["CaseName", "the placeholder in the written form of a Case"],
	["Concurrency", "the mode on `all` that `Future.es` turns down"],
	["DictionaryList", "a name for what `group(on:)` answers, turned down"],
	["NotFound", "the Case of the example Choice on `Optional::toResult`"],
	["Random", "the Namespace `Randomness.es` turns down"],
	["TimedOut", "the Case `Future::within` does without"],
	["boundRecordIsNot", "the helper `internalHelpers.ts` does without"],
	["toInteger", "a second name for `round(toward:)`, turned down"],
	["hasEntries(onlyWhere:)", "the entry `Dictionary.es` turns down"],
	["value(computedBy:)", "the lazy entry `Result.es` turns down"],
	["Oational", "the misspelling `builtins.ts` ranks suggestions for"],
	["Sta", "the half-typed Case in `completion.ts`"],
	["personfirstNamee", "what a fix a column off would write"],
	["spelledWrong", "the misspelled member in `resolvers.ts`"],
	["isHalf", "the example Program's Method in `enrichers.ts`"],
	["quadrupledValue", "the example Program's Method in `rewrite.ts`"],
])

// NOTE: One run of Comment lines: a block, or `//` lines one under another, or
// `§` or `§§` lines one under another. A name in backticks can break across
// two of its lines, so a run is read as one text.
type CommentRun = {
	file: string
	lines: Array<{ line: number; text: string }>
}

type Scanned = {
	runs: Array<CommentRun>
	code: string
}

// NOTE: What a `/` after this token starts. After a value it divides, and
// anywhere else it opens a regular expression, whose text is code.
const regexpAfterWords = new Set([
	"return",
	"typeof",
	"case",
	"do",
	"else",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"instanceof",
	"yield",
	"await",
])

const identifierStart = /[A-Za-z_$]/
const identifierPart = /[\w$]/

export function scanScript(file: string, source: string): Scanned {
	let runs: Array<CommentRun> = []
	let code: Array<string> = []
	let index = 0
	let line = 1
	let codeStart = 0
	// NOTE: The brace depth each open template hole returns to its template at.
	let holes: Array<number> = []
	let depth = 0
	// NOTE: Whether the token before a `/` ends a value, which makes the `/` a
	// division rather than the start of a regular expression.
	let afterValue = false
	let lastRun: { run: CommentRun; line: number } | null = null

	let lineComment = (text: string) => {
		if (lastRun !== null && lastRun.line === line - 1) {
			lastRun.run.lines.push({ line, text })
			lastRun.line = line

			return
		}

		let run: CommentRun = { file, lines: [{ line, text }] }
		runs.push(run)
		lastRun = { run, line }
	}

	let closeCode = (end: number) => {
		code.push(source.slice(codeStart, end), " ")
	}

	// NOTE: An escape skips the character after it, which can be a line break.
	let skipEscape = () => {
		if (source[index + 1] === "\n") {
			line++
		}

		index += 2
	}

	let template = () => {
		while (index < source.length) {
			let character = source[index]!

			if (character === "\\") {
				skipEscape()

				continue
			}

			if (character === "\n") {
				line++
			}

			if (character === "`") {
				index++

				return
			}

			if (character === "$" && source[index + 1] === "{") {
				index += 2
				holes.push(depth)

				return
			}

			index++
		}
	}

	if (source.startsWith("#!")) {
		index = source.indexOf("\n")
	}

	while (index < source.length && index !== -1) {
		let character = source[index]!
		let next = source[index + 1]

		if (character === "\n") {
			line++
			index++

			continue
		}

		if (character === " " || character === "\t" || character === "\r") {
			index++

			continue
		}

		if (character === "/" && next === "/") {
			closeCode(index)

			let end = source.indexOf("\n", index)
			end = end === -1 ? source.length : end
			lineComment(source.slice(index + 2, end))
			index = end
			codeStart = index

			continue
		}

		if (character === "/" && next === "*") {
			closeCode(index)

			let end = source.indexOf("*/", index + 2)
			end = end === -1 ? source.length : end

			let run: CommentRun = { file, lines: [] }

			for (let [offset, text] of source
				.slice(index + 2, end)
				.split("\n")
				.entries()) {
				if (offset > 0) {
					line++
				}

				run.lines.push({ line, text: text.replace(/^\s*\*?/, "") })
			}

			runs.push(run)
			lastRun = null
			index = end + 2
			codeStart = index

			continue
		}

		if (character === '"' || character === "'") {
			index++

			while (
				index < source.length &&
				source[index] !== character &&
				source[index] !== "\n"
			) {
				if (source[index] === "\\") {
					skipEscape()
				} else {
					index++
				}
			}

			index++
			afterValue = true

			continue
		}

		if (character === "`") {
			index++
			template()
			afterValue = true

			continue
		}

		if (character === "}" && holes.at(-1) === depth) {
			holes.pop()
			index++
			template()
			afterValue = true

			continue
		}

		if (character === "/" && !afterValue) {
			let end = index + 1
			let inClass = false

			while (end < source.length && source[end] !== "\n") {
				let inside = source[end]!

				if (inside === "\\") {
					end += 2

					continue
				}

				if (inside === "/" && !inClass) {
					break
				}

				inClass =
					inside === "[" ? true : inside === "]" ? false : inClass
				end++
			}

			// NOTE: A line that never closes it was a division after all.
			if (source[end] === "/") {
				index = end + 1

				while (index < source.length && /[a-z]/.test(source[index]!)) {
					index++
				}

				afterValue = true

				continue
			}
		}

		if (identifierStart.test(character)) {
			let end = index + 1

			while (end < source.length && identifierPart.test(source[end]!)) {
				end++
			}

			afterValue = !regexpAfterWords.has(source.slice(index, end))
			index = end

			continue
		}

		if (/[0-9]/.test(character)) {
			while (index < source.length && /[\w.]/.test(source[index]!)) {
				index++
			}

			afterValue = true

			continue
		}

		if (character === "{") {
			depth++
		} else if (character === "}") {
			depth--
		}

		afterValue = character === ")" || character === "]"
		index++
	}

	closeCode(source.length)

	return { runs, code: code.join("") }
}

// NOTE: An Essence source. `§` opens a Comment that runs to the end of its line,
// and a String runs from `"` to `"` with its interpolation holes in between,
// whose code can hold a String of its own.
export function scanEssence(file: string, source: string): Scanned {
	let runs: Array<CommentRun> = []
	let code: Array<string> = []
	let index = 0
	let line = 1
	let codeStart = 0
	let holes: Array<number> = []
	let depth = 0
	let lastRun: { run: CommentRun; line: number; sigil: string } | null = null

	let string = () => {
		while (index < source.length) {
			let character = source[index]!

			if (character === "\\") {
				line += source[index + 1] === "\n" ? 1 : 0
				index += 2

				continue
			}

			if (character === "\n") {
				line++
			}

			index++

			if (character === '"') {
				return
			}

			if (character === "{") {
				holes.push(depth)

				return
			}
		}
	}

	while (index < source.length) {
		let character = source[index]!

		if (character === "\n") {
			line++
			index++

			continue
		}

		if (character === "§") {
			code.push(source.slice(codeStart, index), " ")

			let end = source.indexOf("\n", index)
			end = end === -1 ? source.length : end

			let sigil = source.startsWith("§§", index) ? "§§" : "§"
			let text = source.slice(index + sigil.length, end)

			if (
				lastRun !== null &&
				lastRun.sigil === sigil &&
				lastRun.line === line - 1
			) {
				lastRun.run.lines.push({ line, text })
				lastRun.line = line
			} else {
				let run: CommentRun = { file, lines: [{ line, text }] }
				runs.push(run)
				lastRun = { run, line, sigil }
			}

			index = end
			codeStart = index

			continue
		}

		if (character === '"') {
			index++
			string()

			continue
		}

		if (character === "}" && holes.at(-1) === depth) {
			holes.pop()
			index++
			string()

			continue
		}

		if (character === "{") {
			depth++
		} else if (character === "}") {
			depth--
		}

		index++
	}

	code.push(source.slice(codeStart))

	return { runs, code: code.join("") }
}

// NOTE: An Astro component is TypeScript between its `---` fences and inside
// its `<script>` elements, and markup everywhere else. The markup's comments are
// the `/* */` blocks its expressions and styles hold; the rest of it is read as
// code, because its expressions name the frontmatter's bindings.
export function scanAstro(file: string, source: string): Scanned {
	let script = source.replace(/[^\n]/g, " ").split("")
	let markup = source.split("")
	let frontmatter = /^---\r?\n([\s\S]*?)\r?\n---$/dm.exec(source)
	let regions = [
		...(frontmatter?.index === 0 ? [frontmatter] : []),
		...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/dg),
	]

	for (let region of regions) {
		let [start, end] = region.indices![1]!

		for (let index = start; index < end; index++) {
			script[index] = source[index]!
			markup[index] = source[index] === "\n" ? "\n" : " "
		}
	}

	let scanned = scanScript(file, script.join(""))
	let markupText = markup.join("")
	let runs = [...scanned.runs]

	for (let block of markupText.matchAll(/\/\*([\s\S]*?)\*\//g)) {
		let first = markupText.slice(0, block.index).split("\n").length

		runs.push({
			file,
			lines: block[1]!.split("\n").map((text, offset) => ({
				line: first + offset,
				text: text.replace(/^\s*\*?/, ""),
			})),
		})
	}

	return {
		runs,
		code: `${scanned.code} ${markupText.replace(/\/\*[\s\S]*?\*\//g, " ")}`,
	}
}

const scannedExtensions = /\.(?:[cm]?[jt]sx?|es|astro)$/

// NOTE: A generated file's comments are written by its generator, whose own
// comments are the ones to hold; its code still counts, since other files'
// comments name what it declares.
const generatedFile = /\.generated\.ts$/

function trackedFiles(): Array<string> {
	let listed = Bun.spawnSync(["git", "ls-files", "-z"], {
		cwd: REPOSITORY_ROOT,
	})

	if (listed.exitCode !== 0) {
		throw new Error(`git ls-files failed: ${listed.stderr.toString()}`)
	}

	return listed.stdout
		.toString()
		.split("\0")
		.filter((file) => file !== "")
}

function scanFile(file: string, source: string): Scanned {
	if (file.endsWith(".es")) {
		return scanEssence(file, source)
	}

	if (file.endsWith(".astro")) {
		return scanAstro(file, source)
	}

	return scanScript(file, source)
}

type Repository = {
	runs: Array<CommentRun>
	codes: Array<string>
	words: Set<string>
	fileCount: number
}

let repository: Repository | null = null

function readRepository(): Repository {
	if (repository !== null) {
		return repository
	}

	let runs: Array<CommentRun> = []
	let codes: Array<string> = []
	let words = new Set<string>()
	let files = trackedFiles()
	let fileCount = 0

	for (let file of files) {
		// NOTE: A file's name is a name too: `bun test stdlibProse` names one.
		words.add(path.basename(file).split(".")[0]!)

		let absolute = path.join(REPOSITORY_ROOT, file)

		if (!scannedExtensions.test(file) || !existsSync(absolute)) {
			continue
		}

		let scanned = scanFile(file, readFileSync(absolute, "utf8"))
		fileCount++

		if (!generatedFile.test(file)) {
			runs.push(...scanned.runs)
		}

		if (file === THIS_FILE) {
			continue
		}

		codes.push(scanned.code)

		for (let word of scanned.code.matchAll(/[A-Za-z_$][\w$]*/g)) {
			words.add(word[0])
		}
	}

	repository = { runs, codes, words, fileCount }

	return repository
}

// NOTE: One name a comment quotes, as it is written and where.
type Quoted = {
	file: string
	line: number
	span: string
	// NOTE: The words the name is joined from, each with the labels a
	// selector gives it. `null` where no selector is written.
	parts: Array<{ word: string; labels: Array<string> | null }>
	// NOTE: `validate…` and `hasOnly*` name a family by its opening, and
	// `*Natives` by its ending. The word is then matched against the start or
	// the end of the names in the code.
	family: "prefix" | "suffix" | null
}

const nameWord = String.raw`[A-Za-z_$][\w$]*`
const nameSelector = String.raw`(?:\((?:[A-Za-z_]\w*:)*\))?`
const namePattern = new RegExp(
	String.raw`^(?:@::|@\.|::|\.|#)?${nameWord}${nameSelector}(?:(?:\.|::|#)${nameWord}${nameSelector})*$`,
)
const partPattern = /([A-Za-z_$][\w$]*)(?:\(((?:[A-Za-z_]\w*:)*)\))?/g

export function quotedNames(run: CommentRun): Array<Quoted> {
	let text = ""
	let starts: Array<number> = []

	for (let { text: lineText } of run.lines) {
		starts.push(text.length)
		text += `${lineText} `
	}

	let quoted: Array<Quoted> = []

	for (let span of text.matchAll(/`([^`]+)`/g)) {
		let written = span[1]!.trim()
		let family: Quoted["family"] = null
		let name = written

		if (/^\*[A-Za-z]+$/.test(name)) {
			family = "suffix"
			name = name.slice(1)
		} else if (/(?:…|\*)$/.test(name)) {
			name = name.slice(0, -1)
			family = /[A-Za-z]$/.test(name) ? "prefix" : null
			name = name.replace(/(?:\.|::|#)$/, "")
		}

		if (!namePattern.test(name)) {
			continue
		}

		let parts = [...name.matchAll(partPattern)].map((part) => ({
			word: part[1]!,
			labels:
				part[2] === undefined
					? null
					: part[2].split(":").filter((label) => label !== ""),
		}))

		let lineIndex = starts.findLastIndex((start) => start <= span.index!)

		quoted.push({
			file: run.file,
			line: run.lines[lineIndex]!.line,
			span: written,
			parts,
			family,
		})
	}

	return quoted
}

// NOTE: Written the way code names are: letters only, with a capital and a
// lowercase letter both in it.
function looksLikeCode(word: string): boolean {
	return /^[A-Za-z]+$/.test(word) && /[a-z]/.test(word) && /[A-Z]/.test(word)
}

// NOTE: The labels each named Method is declared or called with. A label is
// the first word of an Argument followed by the value or Parameter it labels,
// as in `slice(from 0)` or `(from start: Integer)`. A first word followed by a
// comma, a colon or an operator is a value, or a TypeScript Parameter, and says
// nothing. An `overload` block's signatures belong to the name above them.
export function labelsOf(
	names: Set<string>,
	codes: Array<string>,
): Map<string, Set<string>> {
	let labels = new Map<string, Set<string>>()

	if (names.size === 0) {
		return labels
	}

	let alternatives = [...names]
		.map((name) => name.replaceAll("$", "\\$"))
		.join("|")
	let calls = new RegExp(
		String.raw`(?<![\w$])(${alternatives})\s*(?:<[^()\n]*?>)?\(`,
		"g",
	)
	let overloads = new RegExp(
		String.raw`\boverload\s+(${alternatives})\s*\{`,
		"g",
	)
	let labelled = /^\s*([A-Za-z_]\w*)\s+(?:[A-Za-z_"'([{#@0-9`.]|-[0-9])/

	let add = (name: string, argumentTexts: Array<string>) => {
		let known = labels.get(name) ?? new Set()
		labels.set(name, known)

		for (let argument of argumentTexts) {
			let label = labelled.exec(argument)

			if (label !== null) {
				known.add(label[1]!)
			}
		}
	}

	for (let code of codes) {
		for (let call of code.matchAll(calls)) {
			let found = argumentsAt(code, call.index! + call[0].length - 1)

			if (found !== null) {
				add(call[1]!, found.texts)
			}
		}

		for (let block of code.matchAll(overloads)) {
			let index = block.index! + block[0].length
			let depth = 1

			while (index < code.length && depth > 0) {
				let character = code[index]!

				if (character === "{") {
					depth++
				} else if (character === "}") {
					depth--
				} else if (character === "(" && depth === 1) {
					let found = argumentsAt(code, index)

					if (found === null) {
						break
					}

					add(block[1]!, found.texts)
					index = found.end
				}

				index++
			}
		}
	}

	return labels
}

// NOTE: The top-level Arguments of the parenthesised list opening at `open`,
// and where it closes. Brackets nest and Strings are stepped over whole.
function argumentsAt(
	code: string,
	open: number,
): { texts: Array<string>; end: number } | null {
	let texts: Array<string> = []
	let start = open + 1
	let depth = 0

	for (let index = open; index < code.length; index++) {
		let character = code[index]!

		if (character === '"' || character === "'" || character === "`") {
			let close = code.indexOf(character, index + 1)

			if (close === -1) {
				return null
			}

			index = close

			continue
		}

		if (character === "(" || character === "[" || character === "{") {
			depth++
		} else if (
			character === ")" ||
			character === "]" ||
			character === "}"
		) {
			depth--

			if (depth === 0) {
				texts.push(code.slice(start, index))

				return { texts, end: index }
			}
		} else if (character === "," && depth === 1) {
			texts.push(code.slice(start, index))
			start = index + 1
		}
	}

	return null
}

type Finding = {
	file: string
	line: number
	detail: string
}

type Report = {
	findings: Array<Finding>
	quotedCount: number
	checkedCount: number
	selectorCount: number
	// NOTE: The allowed names some comment still quotes and the code still
	// lacks. An entry outside this set has nothing left to allow.
	allowedInUse: Set<string>
}

let report: Report | null = null

export function danglingNames(): Report {
	if (report !== null) {
		return report
	}

	let { runs, codes, words } = readRepository()
	let quoted = runs.flatMap(quotedNames)
	let codeWords = [...words]
	let findings: Array<Finding> = []
	let allowedInUse = new Set<string>()
	let checkedCount = 0
	let selectorCount = 0

	let allowed = (name: string) => {
		if (OUTSIDE_NAMES.has(name) || ABSENT_NAMES.has(name)) {
			allowedInUse.add(name)

			return true
		}

		return false
	}

	let selected = new Set(
		quoted.flatMap(({ parts }) =>
			parts
				.filter(({ labels }) => labels !== null && labels.length > 0)
				.map(({ word }) => word),
		),
	)
	let labels = labelsOf(selected, codes)

	for (let name of quoted) {
		for (let [index, part] of name.parts.entries()) {
			let family = index === name.parts.length - 1 ? name.family : null

			if (looksLikeCode(part.word)) {
				checkedCount++

				let present =
					family === "prefix"
						? codeWords.some((code) => code.startsWith(part.word))
						: family === "suffix"
							? codeWords.some((code) => code.endsWith(part.word))
							: words.has(part.word)

				if (!present && !allowed(part.word)) {
					findings.push({
						file: name.file,
						line: name.line,
						detail: `\`${name.span}\`: no code names \`${part.word}\``,
					})
				}
			}

			if (part.labels === null || part.labels.length === 0) {
				continue
			}

			selectorCount++

			let known = labels.get(part.word) ?? new Set()

			for (let label of part.labels) {
				if (!known.has(label) && !allowed(`${part.word}(${label}:)`)) {
					findings.push({
						file: name.file,
						line: name.line,
						detail: `\`${name.span}\`: no \`${part.word}\` takes \`${label}:\``,
					})
				}
			}
		}
	}

	report = {
		findings,
		quotedCount: quoted.length,
		checkedCount,
		selectorCount,
		allowedInUse,
	}

	return report
}

function reportOf(findings: Array<Finding>): string {
	return findings
		.map((finding) => `${finding.file}:${finding.line} — ${finding.detail}`)
		.join("\n")
}

function commentsOf(scanned: Scanned): Array<string> {
	return scanned.runs.map((run) =>
		run.lines.map(({ text }) => text.trim()).join(" "),
	)
}

describe("Names Comments Quote", () => {
	// NOTE: The scanners decide what is a comment and what is code, so every
	// other check here is only as good as they are.
	describe("scanners", () => {
		it("should read a comment marker inside a String as code", () => {
			let scanned = scanScript(
				"a.ts",
				"let url = \"https://example.com\" // the `siteUrl`\nlet glob = '/*'",
			)

			expect(commentsOf(scanned)).toEqual(["the `siteUrl`"])
			expect(scanned.code).toContain("https://example.com")
			expect(scanned.code).toContain("'/*'")
		})

		it("should read a template's holes as code, Strings and all", () => {
			let scanned = scanScript(
				"a.ts",
				'let text = `a ${f("}")} b ${`c ${d}`} // e`\n// `note`',
			)

			expect(commentsOf(scanned)).toEqual(["`note`"])
			expect(scanned.code).toContain("// e")
		})

		it("should read a regular expression as code", () => {
			let scanned = scanScript(
				"a.ts",
				"let pattern = /\\/\\/[/*]/g // the `pattern`\nlet half = a / b / c",
			)

			expect(commentsOf(scanned)).toEqual(["the `pattern`"])
		})

		it("should join the lines of a run and part two runs", () => {
			let scanned = scanScript(
				"a.ts",
				"// one\n// two\nlet a = 1\n// three\n/** four\n * five */",
			)

			expect(commentsOf(scanned)).toEqual([
				"one two",
				"three",
				"four five",
			])
		})

		it("should read a '§' inside an Essence String as code", () => {
			let scanned = scanEssence(
				"a.es",
				'constant a = "§ {f("§")} §" § the `note`\n§§ a `doc`\n§ a `note`',
			)

			expect(commentsOf(scanned)).toEqual([
				"the `note`",
				"a `doc`",
				"a `note`",
			])
		})

		it("should read an Astro component's script and its markup's blocks", () => {
			let scanned = scanAstro(
				"a.astro",
				"---\n// the `props`\nconst title = 'x'\n---\n<p>it's {/* the `title` */ title}</p>\n<script>\n// the `handler`\n</script>",
			)

			expect(commentsOf(scanned)).toEqual([
				"the `props`",
				"the `handler`",
				"the `title`",
			])
			expect(scanned.code).toContain("title")
		})
	})

	it("should read the labels a Method is declared and called with", () => {
		let labels = labelsOf(new Set(["slice", "everyItem"]), [
			"list::slice(from 0, to -1)",
			"overload everyItem {\n\t(where check: Check) -> List\n\t<Item is Equatable>(alsoIn other: List) -> List\n}",
			"items.slice(start, end)",
			"function slice(start: number)",
		])

		expect(labels).toEqual(
			new Map([
				["slice", new Set(["from", "to"])],
				["everyItem", new Set(["where", "alsoIn"])],
			]),
		)
	})

	describe("quoted names", () => {
		let namesIn = (text: string) =>
			quotedNames({ file: "a.ts", lines: [{ line: 1, text }] }).map(
				({ parts, family }) => ({
					parts: parts.map(({ word, labels }) =>
						labels === null ? word : `${word}(${labels.join(":")})`,
					),
					family,
				}),
			)

		it("should read a name, a path and a selector", () => {
			expect(
				namesIn(
					"`describeType`, `List.slice`, `@::everyItem(where:)::firstItem()` and `Ordering#Equal`",
				),
			).toEqual([
				{ parts: ["describeType"], family: null },
				{ parts: ["List", "slice"], family: null },
				{
					parts: ["everyItem(where)", "firstItem()"],
					family: null,
				},
				{ parts: ["Ordering", "Equal"], family: null },
			])
		})

		it("should read a family by its opening or its ending", () => {
			expect(namesIn("`doesNot…`, `*Natives` and `Rational::…`")).toEqual(
				[
					{ parts: ["doesNot"], family: "prefix" },
					{ parts: ["Natives"], family: "suffix" },
					{ parts: ["Rational"], family: null },
				],
			)
		})

		it("should leave code that is not a name alone", () => {
			expect(
				namesIn("`slice(from n)`, `List<Integer>` and `bun test`"),
			).toEqual([])
		})
	})

	it("should find names to check", () => {
		// NOTE: A guard on the scanners. The checks that follow pass on an
		// empty report, so a scanner that read no file, or that found no
		// comment in the files it read, would make this whole file a no-op
		// that nobody notices.
		let { fileCount } = readRepository()
		let { quotedCount, checkedCount, selectorCount } = danglingNames()

		expect(fileCount).toBeGreaterThan(500)
		expect(quotedCount).toBeGreaterThan(10_000)
		expect(checkedCount).toBeGreaterThan(5_000)
		expect(selectorCount).toBeGreaterThan(100)
	})

	it("should find every name a comment quotes in the code", () => {
		expect(reportOf(danglingNames().findings)).toBe("")
	})

	// NOTE: An allowed name no comment quotes any more, or one the code now
	// writes, allows nothing, and it would allow the next stale reference
	// that happened to spell it.
	it("should allow only names a comment quotes and the code lacks", () => {
		let { allowedInUse } = danglingNames()

		expect(
			[...OUTSIDE_NAMES.keys(), ...ABSENT_NAMES.keys()].filter(
				(name) => !allowedInUse.has(name),
			),
		).toEqual([])
	})
})
