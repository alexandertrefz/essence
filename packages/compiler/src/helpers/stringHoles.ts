// NOTE: A `{` inside a String Literal opens a HOLE — `"Hello, {name}"` reads
// the value of `name` — so a brace that stands for itself is written `\{`, and
// its partner `\}`.
//
// `"{\"a\": 1}"` is the shape that brings a reader here: JSON, written with the
// quotes escaped the way another language wants them and the braces left alone.
// The `{` opens a hole, the escaped quote inside it opens a String of its own,
// and the Literal runs off the end of the file. The Quick Fix that writes the
// missing `"` then produces a file with the SAME refusal in it, and writes
// another quote, and another — so what this decides is whether there is a fix to
// offer at all, and it is asked by the report and by the fix alike so that the
// two can not answer it differently.

// NOTE: A backslash is the whole of the test. A hole holds an Expression, and
// there is no Expression in this language that a `\` is part of — so a hole with
// one inside it is a hole nobody meant to open, which is exactly the reading
// that makes the missing quote the wrong thing to talk about. A hole holding a
// name is left alone: `"Hello, {name}` really is a String short one quote.
export function holeHoldsAnEscape(text: string): boolean {
	let index = 0

	while (index < text.length) {
		if (text[index] === "\\") {
			index += 2

			continue
		}

		if (text[index] !== "{") {
			index += 1

			continue
		}

		index += 1

		while (index < text.length && text[index] !== "}") {
			if (text[index] === "\\") {
				return true
			}

			index += 1
		}
	}

	return false
}
