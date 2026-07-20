import type { common } from "../interfaces/index"

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

export const documentationPrefix = "§§"

const tagPattern = /^@(param|returns)\b[ \t]*(.*)$/

export function parseDocumentation(
	lines: Array<string>,
	position: common.Position,
): common.Documentation {
	let description: Array<string> = []
	let parameters: Record<string, Array<string>> = {}
	let returns: Array<string> | null = null
	// NOTE: Lines following a tag continue it until the next tag starts, so a
	// Parameter can be described across as many lines as it needs.
	let section = description

	for (let line of lines) {
		let tag = tagPattern.exec(stripPrefix(line))

		if (tag === null) {
			section.push(stripPrefix(line))
			continue
		}

		let [, name, rest] = tag

		if (name === "returns") {
			returns = []
			section = returns
		} else {
			let [parameterName, text] = splitLeadingWord(rest)

			// NOTE: A `@param` naming nothing documents nothing — it is left
			// in the prose rather than silently swallowed.
			if (parameterName === "") {
				section.push(stripPrefix(line))
				continue
			}

			parameters[parameterName] ??= []
			section = parameters[parameterName]
			rest = text
		}

		if (rest !== "") {
			section.push(rest)
		}
	}

	return {
		description: joinSection(description),
		parameters: Object.fromEntries(
			Object.entries(parameters).map(([name, text]) => [
				name,
				joinSection(text),
			]),
		),
		returns: returns === null ? null : joinSection(returns),
		position,
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

function splitLeadingWord(text: string): [string, string] {
	let match = /^([^ \t]*)[ \t]*(.*)$/.exec(text)

	return match === null ? ["", text] : [match[1], match[2]]
}

// NOTE: Blank lines inside a section are meaningful to Markdown, the ones
// around it are not.
function joinSection(lines: Array<string>): string {
	return lines
		.join("\n")
		.replace(/^\s*\n/, "")
		.trimEnd()
}
