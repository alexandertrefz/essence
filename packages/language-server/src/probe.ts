// A probe makes an edit in progress, such as `person.` or `greet(`, parse. It
// appends a suffix and enough closing brackets for what was left open. See
// "Probes" in DEVELOPMENT.md.

// Blanks String text and Comments out, one space per UTF-16 unit, so the
// brackets and commas inside them go uncounted and offsets still line up. An
// interpolation hole is code and stays; only its braces are blanked.
export function stripNoise(text: string): string {
	return scanNoise(text).stripped
}

// `openHoles` holds the offset of the `{` of every interpolation hole
// still open at the end of the text, outermost first.
type Noise = {
	stripped: string
	openHoles: Array<number>
}

// `hole` is the offset of the `{` of the hole the scan is in, or -1 in the
// String's text. `depth` counts the braces open inside that hole.
type OpenString = {
	hole: number
	depth: number
}

function scanNoise(text: string): Noise {
	let stripped = ""
	let strings: Array<OpenString> = []
	let inComment = false

	for (let index = 0; index < text.length; index++) {
		let character = text[index]!
		let innermost = strings.at(-1)

		if (character === "\n") {
			inComment = false
			stripped += character
			continue
		}

		if (innermost?.hole === -1) {
			stripped += " "

			if (character === '"') {
				strings.pop()
			} else if (character === "{") {
				innermost.hole = index
			} else if (character === "\\" && index + 1 < text.length) {
				// The brace of a `\u{…}` escape opens no hole.
				let escaped =
					text[index + 1] === "u" && text[index + 2] === "{" ? 2 : 1

				stripped +=
					text[index + 1] === "\n" ? "\n" : " ".repeat(escaped)
				index += escaped
			}

			continue
		}

		// From here on the scan is in code: at the top level, or in the
		// hole of `innermost`. The Lexer ends a Comment in a hole at a `}`.
		if (inComment && !(character === "}" && innermost !== undefined)) {
			stripped += " "
			continue
		}

		inComment = false

		if (character === '"') {
			strings.push({ hole: -1, depth: 0 })
			stripped += " "
		} else if (character === "§") {
			inComment = true
			stripped += " "
		} else if (innermost !== undefined && character === "{") {
			innermost.depth++
			stripped += character
		} else if (innermost !== undefined && character === "}") {
			if (innermost.depth === 0) {
				innermost.hole = -1
				stripped += " "
			} else {
				innermost.depth--
				stripped += character
			}
		} else {
			stripped += character
		}
	}

	return {
		stripped,
		openHoles: strings.flatMap((string) =>
			string.hole === -1 ? [] : [string.hole],
		),
	}
}

// An open interpolation hole is closed by its `}` and then by the `"` of
// the String it stands in.
const closers: Record<string, string> = {
	"{": "}",
	"(": ")",
	"[": "]",
	'"{': '}"',
}

// `opensDefine` marks a `define`'s own block. An arm's tail goes at the end
// of that block, which is the innermost `{` only while no arm opened one.
type OpenBracket = {
	opener: string
	opensDefine: boolean
}

// The Keyword is read as a whole word, off text `stripNoise` blanked. As in
// the Parser, its block is the first `{` at its depth past its return Type.
function openBrackets(
	text: string,
	openHoles: Array<number>,
): Array<OpenBracket> {
	let stack: Array<OpenBracket> = []
	let word = ""
	// The depth of the `define` whose block has not opened yet, or -1.
	let pendingDefine = -1
	// The last two characters read that are not blank.
	let previous = ""
	let holes = new Set(openHoles)

	for (let index = 0; index < text.length; index++) {
		let character = text[index]!
		let before = previous

		if (!/\s/.test(character)) {
			previous = `${previous}${character}`.slice(-2)
		}

		if (/[A-Za-z0-9_]/.test(character)) {
			word += character

			continue
		}

		if (word === "define") {
			pendingDefine = stack.length
		}

		word = ""

		if (holes.has(index)) {
			stack.push({ opener: '"{', opensDefine: false })
		} else if (
			character === "{" ||
			character === "(" ||
			character === "["
		) {
			let opensDefine =
				character === "{" &&
				stack.length === pendingDefine &&
				!expectsType.test(before)

			stack.push({ opener: character, opensDefine })

			if (opensDefine) {
				pendingDefine = -1
			}
		} else if (
			character === "}" ||
			character === ")" ||
			character === "]"
		) {
			stack.pop()

			if (stack.length < pendingDefine) {
				pendingDefine = -1
			}
		}
	}

	return stack
}

// A Type is still expected after an arrow, a Union's `|`, or the `<` or
// `,` of a Type Argument list.
const expectsType = /(->|[|<,])$/

// `declarationIndex` names the open `(` to close as a parameter list; see
// `probeSourcesFor`.
function closingSuffixFor(
	stack: Array<OpenBracket>,
	declarationIndex: number = -1,
): string {
	let suffix = ""

	for (let index = stack.length - 1; index >= 0; index--) {
		suffix +=
			index === declarationIndex
				? ") -> {} {}"
				: closers[stack[index]!.opener]
	}

	return suffix
}

// Readings that close an open `(` as a Declaration's parameter list, with the
// tail `-> {} {}`, so a cursor in a default resolves. Tried after the plain
// reading, outermost first, at most `MAXIMUM_DECLARATION_READINGS` of them.
const MAXIMUM_DECLARATION_READINGS = 2

export function probeSourcesFor(headText: string, suffix = ""): Array<string> {
	let { stripped, openHoles } = scanNoise(headText)
	let stack = openBrackets(stripped, openHoles)
	let sources = [`${headText}${suffix}${closingSuffixFor(stack)}`]

	let parentheses = stack.flatMap((bracket, index) =>
		bracket.opener === "(" ? [index] : [],
	)

	for (let index of parentheses.slice(0, MAXIMUM_DECLARATION_READINGS)) {
		sources.push(`${headText}${suffix}${closingSuffixFor(stack, index)}`)
	}

	for (let tail of STATEMENT_TAILS) {
		sources.push(`${headText}${suffix}${tailSuffixFor(stack, tail)}`)
	}

	if (definePattern.test(stripped)) {
		for (let tail of DEFINE_TAILS) {
			sources.push(
				`${headText}${suffix}${tailSuffixFor(stack, tail, true)}`,
			)
		}
	}

	// Two readings may spell the same source, and each costs an enrichment.
	return [...new Set(sources)]
}

// The tails a Statement head may wait for: a block for an `if`, and for a
// `match` its return Type and a block.
const STATEMENT_TAILS = [" {}", " -> {} {}"]

// The tails that finish the `define` a head stands inside: `otherwise` after a
// value, `as {} otherwise` after a Condition. A `define` without an `otherwise`
// arm is refused, and the Parser would drop the Statement.
const DEFINE_TAILS = [" otherwise", " as {} otherwise"]

// Whether the arm readings are worth building: `define` is reserved, so the
// word anywhere before the cursor means one was opened.
const definePattern = /\bdefine\b/

// A tail goes before the closer of the `{` it finishes: for a Statement head,
// the innermost open one. For a `define` arm, the `define`'s own block, else
// the innermost `{`.
function tailSuffixFor(
	stack: Array<OpenBracket>,
	tail: string,
	targetsDefine = false,
): string {
	let target = innermostIndex(
		stack,
		(bracket) => bracket.opener === "{" && bracket.opensDefine,
	)

	if (target === -1 || !targetsDefine) {
		target = innermostIndex(stack, (bracket) => bracket.opener === "{")
	}

	let suffix = ""

	for (let index = stack.length - 1; index >= 0; index--) {
		if (index === target) {
			suffix += tail
		} else if (
			targetsDefine &&
			index < target &&
			stack[index]!.opensDefine
		) {
			// An enclosing `define` is one word short too: its arm's value is the
			// `define` just finished, so it wants `otherwise`.
			suffix += ENCLOSING_DEFINE_TAIL
		}

		suffix += closers[stack[index]!.opener]
	}

	return target === -1 ? `${suffix}${tail}` : suffix
}

const ENCLOSING_DEFINE_TAIL = " otherwise"

function innermostIndex(
	stack: Array<OpenBracket>,
	matches: (bracket: OpenBracket) => boolean,
): number {
	for (let index = stack.length - 1; index >= 0; index--) {
		if (matches(stack[index]!)) {
			return index
		}
	}

	return -1
}
