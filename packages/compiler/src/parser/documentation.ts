import type { common } from "@essence-lang/interfaces"

// A Documentation block is a run of `§§` Comments directly above a
// Declaration. It is Markdown, with `@param`, `@returns` and `@example` tag
// lines lifted out of it.
// See "Documentation comments" in DEVELOPMENT.md.

export const documentationPrefix = "§§"

const separator = "—"

const tagPattern = /^@(param|returns|example)\b[ \t]*(.*)$/

const namePattern = /^([^ \t—]*)(.*)$/

// Inside a fenced block a tag is shown rather than written, so no line there
// is read as a tag.
const fencePattern = /^\s*(?:```|~~~)/

// A `§§` Comment paired with its span, so a Diagnostic can underline one tag
// and an `@example` compiles at the lines it was written on.
export type DocumentationLine = common.DocumentationLine

export type DocumentationProblem = {
	kind: "missing-separator"
	tag: "param" | "returns"
	// Null for `@returns`, which names nothing.
	name: string | null
	position: common.Position
}

type ParsedDocumentation = {
	documentation: common.Documentation
	problems: Array<DocumentationProblem>
}

// One `@param` while it is being collected. Its text arrives line by line
// and is joined once the block ends.
type ParameterSection = {
	name: string
	text: Array<string>
	position: common.Position
}

// One `@example` while it is being collected. It keeps the lines rather than
// their text, so the Essence under the tag compiles at its written Positions.
type ExampleSection = {
	lines: Array<common.DocumentationLine>
	position: common.Position
	tag: common.Position
}

export function parseDocumentation(
	lines: Array<DocumentationLine>,
	position: common.Position,
): ParsedDocumentation {
	let description: Array<string> = []
	let parameters: Array<ParameterSection> = []
	let examples: Array<ExampleSection> = []
	let returns: Array<string> | null = null
	let problems: Array<DocumentationProblem> = []
	let fenced = false
	// Lines following a tag continue it until the next tag starts.
	let section = description
	// The `@example` being collected, if any. It collects lines rather than
	// text, and its lines leave the description.
	let example: ExampleSection | null = null

	for (let line of lines) {
		let body = stripPrefix(line.text)

		if (fencePattern.test(body)) {
			fenced = !fenced

			if (example === null) {
				section.push(body)
			} else {
				example.lines.push(line)
			}

			continue
		}

		let tag = fenced ? null : tagPattern.exec(body)

		if (tag === null) {
			if (example === null) {
				section.push(body)
			} else {
				example.lines.push(line)
				example.position = {
					start: example.position.start,
					end: line.position.end,
				}
			}

			continue
		}

		let [, name, rest] = tag
		let parameterName: string | null = null

		example = null

		if (name === "example") {
			// The lines after the tag are what it holds. An example of no
			// lines is dropped when the block ends.
			example = {
				lines: [],
				position: line.position,
				tag: line.position,
			}

			examples.push(example)
			section = description

			continue
		}

		if (name === "param") {
			let [tagged, afterName] = splitLeadingName(rest)

			// A `@param` naming nothing documents nothing, so it stays in
			// the prose.
			if (tagged === "") {
				section.push(body)
				continue
			}

			parameterName = tagged

			let entry: ParameterSection = {
				name: parameterName,
				text: [],
				position: spanIn(line, rest, tagged.length),
			}

			parameters.push(entry)

			section = entry.text
			rest = afterName
		} else {
			returns = []
			section = returns
		}

		let text = splitTagText(rest)

		if (text === null) {
			continue
		}

		if (text.separated === false) {
			problems.push({
				kind: "missing-separator",
				tag: parameterName === null ? "returns" : "param",
				name: parameterName,
				position: spanIn(line, text.content, text.content.length),
			})
		}

		section.push(text.content)
	}

	return {
		documentation: {
			description: joinSection(description),
			parameters: parameters.map((parameter) => ({
				name: parameter.name,
				text: joinSection(parameter.text),
				tag: { position: parameter.position },
			})),
			returns: returns === null ? null : joinSection(returns),
			// An example with no code is dropped: a test that runs no
			// Statement always passes.
			examples: examples
				.filter((entry) => entry.lines.some(holdsCode))
				.map((entry) => ({
					lines: entry.lines,
					position: entry.position,
					tag: { position: entry.tag },
				})),
			position,
		},
		problems,
	}
}

// Whether a line of an example says anything. A blank line is kept in the
// example, but a block of nothing but blanks holds no example.
function holdsCode(line: common.DocumentationLine): boolean {
	return stripPrefix(line.text).trim() !== ""
}

// One leading space after the sigil is the separator rather than content.
// Everything past it is kept, so indentation inside Markdown survives.
function stripPrefix(line: string): string {
	let body = line.startsWith(documentationPrefix)
		? line.slice(documentationPrefix.length)
		: line

	return body.startsWith(" ") ? body.slice(1) : body
}

// The name a `@param` tags, which ends at the separator as readily as at
// a space: `@param other— the String` names `other`.
function splitLeadingName(text: string): [string, string] {
	let match = namePattern.exec(text)

	return match === null ? ["", text] : [match[1], match[2]]
}

// What a tag says on its own line, if anything. A tag alone on its line takes
// its text from the following lines, so there is nothing to separate.
function splitTagText(
	rest: string,
): { content: string; separated: boolean } | null {
	let text = rest.replace(/^[ \t]+/, "")

	if (text === "") {
		return null
	}

	return text.startsWith(separator)
		? {
				content: text.slice(separator.length).replace(/^[ \t]+/, ""),
				separated: true,
			}
		: { content: text, separated: false }
}

// The span of `length` characters at the head of `suffix`. Every string the
// parse works with is a suffix of the written line, so the column follows
// from the two lengths.
function spanIn(
	line: DocumentationLine,
	suffix: string,
	length: number,
): common.Position {
	let column = line.position.start.column + line.text.length - suffix.length

	return {
		start: { line: line.position.start.line, column },
		end: { line: line.position.start.line, column: column + length },
	}
}

// Blank lines inside a section are meaningful to Markdown, the ones around
// it are not.
function joinSection(lines: Array<string>): string {
	return lines
		.join("\n")
		.replace(/^\s*\n/, "")
		.trimEnd()
}
