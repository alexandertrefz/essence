// A `{` inside a String Literal opens a hole, so a brace that stands for itself
// is written `\{`. In `"{\"a\": 1}"` the escaped quote inside the hole opens a
// String of its own, and the Literal runs to the end of the file. Writing the
// missing `"` repeats the refusal, so the Parser's report and the Quick Fix both
// ask here whether a quote is the fix.

// A backslash is the whole test: no Expression holds a `\`, so a hole holding
// one was never meant as a hole. `"Hello, {name}` really is short one quote.
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
