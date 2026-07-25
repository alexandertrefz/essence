import type { common } from "@essence/interfaces"

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

export function parseDocumentation(
	lines: Array<DocumentationLine>,
	position: common.Position,
): ParsedDocumentation {
	let description: Array<string> = []
	let parameters: Record<string, Array<string>> = {}
	let parameterTags: Record<string, { position: common.Position }> = {}
	let returns: Array<string> | null = null
	let problems: Array<DocumentationProblem> = []
	// NOTE: Lines following a tag continue it until the next tag starts, so a
	// Parameter can be described across as many lines as it needs.
	let section = description

	for (let line of lines) {
		let body = stripPrefix(line.text)
		let tag = tagPattern.exec(body)

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
			rest = afterName
			parameters[parameterName] ??= []
			parameterTags[parameterName] ??= { position: line.position }
			section = parameters[parameterName]
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
				position: textPosition(line, body, text.content),
			})
		}

		section.push(text.content)
	}

	return {
		documentation: {
			description: joinSection(description),
			parameters: Object.fromEntries(
				Object.entries(parameters).map(([name, text]) => [
					name,
					joinSection(text),
				]),
			),
			returns: returns === null ? null : joinSection(returns),
			position,
			// NOTE: Left off entirely when the block writes no `@param`, so
			// that the overwhelming majority of Documentation carries no empty
			// Record around with it.
			...(Object.keys(parameterTags).length === 0
				? {}
				: { parameterTags }),
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

// NOTE: The span of the text that should have been separated, rather than of
// the whole Comment — the Diagnostic is about where the em-dash is missing,
// which is exactly where this text begins. `content` is a suffix of `body`
// whenever it was not separated, and `body` a suffix of the written line, so
// the column follows from the two lengths without tracking offsets through
// the parse.
function textPosition(
	line: DocumentationLine,
	body: string,
	content: string,
): common.Position {
	return {
		start: {
			line: line.position.start.line,
			column:
				line.position.start.column + line.text.length - content.length,
		},
		end: line.position.end,
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
