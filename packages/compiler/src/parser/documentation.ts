import type { common } from "@essence-lang/interfaces"

// NOTE: A Documentation block is a run of `§§` Comments directly above a
// Declaration. Ordinary `§` Comments stay private notes — doubling the sigil
// is what makes a Comment part of the public description of the thing below
// it, the same way `///` differs from `//` elsewhere.
//
// The body is Markdown, handed to the Editor unchanged. Tag lines lift a
// section out of it so that it can be shown where it belongs: `@param other`
// documents one Parameter, `@returns` the result. An `@` line that names no
// known tag is left in the prose, so writing about an `@address` costs
// nothing and a tag added later cannot retroactively break a comment.
//
// The `@param` lines are kept as a LIST, in the order they were written, and
// each line opens an entry of its own. What a line documents is the Parameter
// at its own position, so two lines carrying the same name are two Parameters
// rather than one section written twice — which is also why nothing here has
// to guard against a name like `toString` or `__proto__`.
//
// A tag carrying its text on its own line separates the two with an em-dash —
// `@param other — the String to add` — which is where the reader's eye finds
// the description, and how the Editor renders it back. A tag that leaves its
// text to the lines below it needs no separator. Text written without one is
// still lifted, so that the Hover never degrades while the source is being
// corrected, but it is reported: `parseDocumentation` returns those as
// `problems` rather than reporting them itself, so that the grammar stays a
// pure function of its lines.

export const documentationPrefix = "§§"

const separator = "—"

const tagPattern = /^@(param|returns)\b[ \t]*(.*)$/

const namePattern = /^([^ \t—]*)(.*)$/

// NOTE: The one piece of Markdown the grammar has to know. A fenced block is
// where an `@param` is being SHOWN rather than written, and lifting it out of
// the prose leaves the fence unclosed and invents a Parameter nobody declared.
const fencePattern = /^\s*(?:```|~~~)/

// NOTE: A `§§` Comment paired with the span it occupies, so that a Diagnostic
// about one tag can underline that tag rather than the whole block.
export type DocumentationLine = {
	text: string
	position: common.Position
}

export type DocumentationProblem = {
	kind: "missing-separator"
	tag: "param" | "returns"
	// NOTE: Null for `@returns`, which names nothing.
	name: string | null
	position: common.Position
}

export type ParsedDocumentation = {
	documentation: common.Documentation
	problems: Array<DocumentationProblem>
}

// NOTE: One `@param` while it is being collected — its text arrives line by
// line, and is joined once the block ends.
type ParameterSection = {
	name: string
	text: Array<string>
	position: common.Position
}

export function parseDocumentation(
	lines: Array<DocumentationLine>,
	position: common.Position,
): ParsedDocumentation {
	let description: Array<string> = []
	let parameters: Array<ParameterSection> = []
	let returns: Array<string> | null = null
	let problems: Array<DocumentationProblem> = []
	let fenced = false
	// NOTE: Lines following a tag continue it until the next tag starts, so a
	// Parameter can be described across as many lines as it needs.
	let section = description

	for (let line of lines) {
		let body = stripPrefix(line.text)

		if (fencePattern.test(body)) {
			fenced = !fenced
			section.push(body)
			continue
		}

		let tag = fenced ? null : tagPattern.exec(body)

		if (tag === null) {
			section.push(body)
			continue
		}

		let [, name, rest] = tag
		let parameterName: string | null = null

		if (name === "param") {
			let [tagged, afterName] = splitLeadingName(rest)

			// NOTE: A `@param` naming nothing documents nothing — it is left
			// in the prose rather than silently swallowed.
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
			position,
		},
		problems,
	}
}

// NOTE: One leading space after the sigil is the separator rather than
// content — everything past it is kept, so indentation inside a Markdown list
// or code block survives.
function stripPrefix(line: string): string {
	let body = line.startsWith(documentationPrefix)
		? line.slice(documentationPrefix.length)
		: line

	return body.startsWith(" ") ? body.slice(1) : body
}

// NOTE: The name a `@param` tags, which ends at the separator as readily as at
// a space — `@param other— the String` names `other`, not `other—`.
function splitLeadingName(text: string): [string, string] {
	let match = namePattern.exec(text)

	return match === null ? ["", text] : [match[1], match[2]]
}

// NOTE: What a tag says on its own line, if anything. A tag head alone takes
// its text from the lines below it, so there is nothing here to separate and
// nothing to report.
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

// NOTE: The span of `length` characters at the head of `suffix`, which is what
// lets a Diagnostic underline one tag rather than the whole Comment — the name
// a `@param` writes, or the text an em-dash should have preceded. Every string
// the parse works with is a suffix of the written line, so the column follows
// from the two lengths without threading offsets through the loop.
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

// NOTE: Blank lines inside a section are meaningful to Markdown, the ones
// around it are not.
function joinSection(lines: Array<string>): string {
	return lines
		.join("\n")
		.replace(/^\s*\n/, "")
		.trimEnd()
}
