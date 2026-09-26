// NOTE: A "probe" turns an in-progress edit into a syntactically valid
// Program by appending a suffix and enough closing brackets to balance
// whatever was left open — Completion and Signature Help both need to
// resolve Types at a cursor position that, as typed, does not parse on its
// own (`person.`, `greet(`, …).

// NOTE: Blanks String text and Comments out, one space per UTF-16 unit, so the
// brackets and commas inside them go uncounted and offsets still line up. An
// interpolation hole is code and stays; only its braces are blanked.
export function stripNoise(text: string): string {
	return scanNoise(text).stripped
}

// NOTE: `openHoles` holds the offset of the `{` of every interpolation hole
// still open at the end of the text, outermost first.
type Noise = {
	stripped: string
	openHoles: Array<number>
}

// NOTE: `hole` is the offset of the `{` of the hole the scan is in, or -1 while
// it is in the String's text; `depth` counts the braces open inside that hole.
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
				// NOTE: The brace of a `\u{…}` escape opens no hole.
				let escaped =
					text[index + 1] === "u" && text[index + 2] === "{" ? 2 : 1

				stripped +=
					text[index + 1] === "\n" ? "\n" : " ".repeat(escaped)
				index += escaped
			}

			continue
		}

		// NOTE: From here on the scan is in code: at the top level, or in the
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

// NOTE: An open interpolation hole is closed by its `}` and then by the `"` of
// the String it stands in.
const closers: Record<string, string> = {
	"{": "}",
	"(": ")",
	"[": "]",
	'"{': '}"',
}

// NOTE: `opensDefine` says this `{` is a `define`'s own block rather than any
// other kind — a Record Literal, a Function body, a block an arm's VALUE opened.
// The arm tails belong at the end of that block and nowhere else, and the
// innermost `{` is only the same brace while an arm holds none of its own.
type OpenBracket = {
	opener: string
	opensDefine: boolean
}

// NOTE: The Keyword is read as a whole word, so `redefine` opens no `define`,
// off text `stripNoise` has blanked String text and Comments out of. As in the
// Parser, its block is the first `{` at its own depth past its return Type: a
// `{` where that Type still expects a Type opens a Record Type instead.
function openBrackets(
	text: string,
	openHoles: Array<number>,
): Array<OpenBracket> {
	let stack: Array<OpenBracket> = []
	let word = ""
	// NOTE: The depth of the `define` whose block has not opened yet, or -1.
	let pendingDefine = -1
	// NOTE: The last two characters read that are not blank.
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

// NOTE: A Type is still expected after an arrow, a Union's `|`, or the `<` or
// `,` of a Type Argument list.
const expectsType = /(->|[|<,])$/

// NOTE: `declarationIndex` names the one open `(` to close as a Declaration's
// parameter list rather than as a call's Argument list — see `probeSourcesFor`.
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

	// NOTE: Two readings can spell the same source — a declaration reading of
	// the outermost `(` and the `match` reading of a head that opened one —
	// and a reading costs a parse and an enrichment; the same one twice is
	// the same answer twice.
	return [...new Set(sources)]
}

// NOTE: The tails a Statement's HEAD can be waiting for: an `if` wants a block,
// a `match` wants its return Type and then one — `-> {} {}`, the shortest
// complete tail there is.
const STATEMENT_TAILS = [" {}", " -> {} {}"]

// NOTE: The tails that finish the `define` a head stands INSIDE. An arm is
// written `as VALUE if CONDITION` and the block has to end in an `otherwise`
// arm, so a cursor in a value is one word short of an arm that closes the
// block, and a cursor in a Condition is one whole arm short of it — `as {}
// otherwise`, the shortest arm there is. Neither is optional the way a `match`
// return Type is: a `define` with no `otherwise` arm is REFUSED, so without
// these readings the Parser drops the whole Statement the cursor is in, and
// with it the member access being written.
const DEFINE_TAILS = [" otherwise", " as {} otherwise"]

// NOTE: What says the arm readings are worth building. `define` is a reserved
// Keyword and `stripNoise` has blanked String text and Comments, so the word
// anywhere before the cursor means a `define` was opened, perhaps closed again.
const definePattern = /\bdefine\b/

// NOTE: A tail is written immediately before the closer of the `{` whose block
// it finishes. For a Statement waiting for a block that is the innermost open
// one — `if greet(` closes to `if greet() {}` and not to `if greet( {})`, and
// such a head can hold no unclosed `{` of its own, since a block is exactly what
// it is waiting for.
//
// A `define` arm's tail belongs at the end of the `define`'s OWN block, which is
// the innermost `{` only while no half-written arm opened one of its own. `as {
// name = team.` stands two braces in, and an arm written inside the Record
// Literal closes nothing — so a cursor there was answered by no reading at all,
// where the same Record Literal outside a `define` answered. Falls back to the
// innermost `{` where no open brace is a `define`'s: `definePattern` passes on
// the Keyword standing anywhere above the cursor, including inside a `define`
// that has been closed again.
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
			// NOTE: A `define` the target one is written INSIDE is one word
			// short of closing too — its own arm's value is the `define` below
			// it, which has just been finished, so `otherwise` is all it wants.
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
