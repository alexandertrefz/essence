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
	let stripped = stripNoise(headText)
	let stack = openBrackets(stripped)
	let sources = [`${headText}${suffix}${closingSuffixFor(stack)}`]

	let parentheses = stack.flatMap((opener, index) =>
		opener === "(" ? [index] : [],
	)

	for (let index of parentheses.slice(0, MAXIMUM_DECLARATION_READINGS)) {
		sources.push(`${headText}${suffix}${closingSuffixFor(stack, index)}`)
	}

	let tails = definePattern.test(stripped)
		? [...STATEMENT_TAILS, ...DEFINE_TAILS]
		: STATEMENT_TAILS

	for (let tail of tails) {
		sources.push(`${headText}${suffix}${tailSuffixFor(stack, tail)}`)
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
// Keyword and `stripNoise` has already blanked every String and Comment, so the
// word standing anywhere above the cursor means a `define` was opened there —
// possibly one already closed again, which is why this is a cheap test that can
// never turn away a head that needs the arm readings rather than a reading of
// where the cursor stands. What it buys is that a cursor no reading explains in
// a file with no `define` above it pays what it always paid: the readings are
// tried in turn until one answers, so the ones nothing answers with are exactly
// the ones that parse and enrich the document for nothing.
const definePattern = /\bdefine\b/

// NOTE: Every tail lands in the same place, which is what lets one function
// write all four: immediately before the closer of the innermost open `{`. For
// a Statement waiting for a block that is where its block goes — `if greet(`
// closes to `if greet() {}` and not to `if greet( {})`, and such a head can
// hold no unclosed `{` of its own, since a block is exactly what it is waiting
// for. For a `define` arm it is the end of the `define`'s own block, which is
// that same innermost `{`.
function tailSuffixFor(stack: Array<string>, tail: string): string {
	let suffix = ""
	let opened = false

	for (let index = stack.length - 1; index >= 0; index--) {
		if (!opened && stack[index] === "{") {
			suffix += tail
			opened = true
		}

		suffix += closers[stack[index]!]
	}

	return opened ? suffix : `${suffix}${tail}`
}
