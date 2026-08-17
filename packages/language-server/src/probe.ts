// NOTE: A "probe" turns an in-progress edit into a syntactically valid
// Program by appending a suffix and enough closing brackets to balance
// whatever was left open — Completion and Signature Help both need to
// resolve Types at a cursor position that, as typed, does not parse on its
// own (`person.`, `greet(`, …).

// NOTE: Blanks out String and Comment content — their contents are not part
// of the Program's structure, so brackets, commas and quotes inside them must
// not be counted. Every character is replaced by a space rather than removed,
// so offsets into the result still line up with the original text. Strings
// may span lines (the Lexer runs to the next `"` regardless of newlines), so
// this scans characters instead of working line by line.
export function stripNoise(text: string): string {
	let stripped = ""
	let inString = false
	let inComment = false

	for (let character of text) {
		if (character === "\n") {
			inComment = false
			stripped += character
			continue
		}

		if (inComment) {
			stripped += " "
			continue
		}

		if (inString) {
			stripped += " "

			if (character === '"') {
				inString = false
			}

			continue
		}

		if (character === '"') {
			inString = true
			stripped += " "
			continue
		}

		if (character === "§") {
			inComment = true
			stripped += " "
			continue
		}

		stripped += character
	}

	return stripped
}

const closers: Record<string, string> = { "{": "}", "(": ")", "[": "]" }

function openBrackets(text: string): Array<string> {
	let stack: Array<string> = []

	for (let character of text) {
		if (character === "{" || character === "(" || character === "[") {
			stack.push(character)
		} else if (
			character === "}" ||
			character === ")" ||
			character === "]"
		) {
			stack.pop()
		}
	}

	return stack
}

// NOTE: `declarationIndex` names the one open `(` to close as a Declaration's
// parameter list rather than as a call's Argument list — see `probeSourcesFor`.
function closingSuffixFor(
	stack: Array<string>,
	declarationIndex: number = -1,
): string {
	let suffix = ""

	for (let index = stack.length - 1; index >= 0; index--) {
		suffix +=
			index === declarationIndex ? ") -> {} {}" : closers[stack[index]!]
	}

	return suffix
}

// NOTE: `suffix` is inserted before the closing brackets — e.g. a synthetic
// member access, or nothing at all when the head alone just needs closing.
export function buildProbeSource(headText: string, suffix = ""): string {
	return `${headText}${suffix}${closingSuffixFor(openBrackets(stripNoise(headText)))}`
}

// NOTE: Closing brackets alone are not enough when one of the open ones is a
// DECLARATION's parameter list, which is where a `= expression` default is
// written: `function greet(_ name: String = person` closed with `)}` is a
// `function` with no return Type and no body, and the Parser drops the whole
// Statement — so a cursor inside a default resolved against nothing at all.
//
// A parameter list can not be told from a call's Argument list by looking at the
// text, so these are offered as FURTHER readings rather than instead of the
// plain one: each is tried in turn and the first that answers wins. `-> {} {}`
// is the shortest complete tail there is — the unit Type, and a body that
// returns it by falling off its end.
//
// The parameter list is the OUTERMOST open `(` whenever a default holds a call,
// so the readings run outward-in; at most `MAXIMUM_DECLARATION_READINGS` of them,
// since each costs a parse and an enrichment of the whole document and a cursor
// four calls deep inside a default is not what this is for.
const MAXIMUM_DECLARATION_READINGS = 2

export function probeSourcesFor(headText: string, suffix = ""): Array<string> {
	let stack = openBrackets(stripNoise(headText))
	let sources = [`${headText}${suffix}${closingSuffixFor(stack)}`]

	let parentheses = stack.flatMap((opener, index) =>
		opener === "(" ? [index] : [],
	)

	for (let index of parentheses.slice(0, MAXIMUM_DECLARATION_READINGS)) {
		sources.push(`${headText}${suffix}${closingSuffixFor(stack, index)}`)
	}

	return sources
}
