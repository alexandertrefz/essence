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

function closingSuffixFor(text: string): string {
	let closers: Record<string, string> = { "{": "}", "(": ")", "[": "]" }
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
		.reverse()
		.map((opener) => closers[opener])
		.join("")
}

// NOTE: `suffix` is inserted before the closing brackets — e.g. a synthetic
// member access, or nothing at all when the head alone just needs closing.
export function buildProbeSource(headText: string, suffix = ""): string {
	return `${headText}${suffix}${closingSuffixFor(stripNoise(headText))}`
}
