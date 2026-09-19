// NOTE: The Damerau-Levenshtein distance — Levenshtein plus the swap of two
// adjacent characters as ONE edit rather than two, because that is the typo
// people actually make: `slwo` for `slow`, `retrun` for `return`. Exported
// because every "did you mean" in the toolchain has to answer the same way
// about the same pair of words, whether it is asked here or by the Language
// Server about a tag.
export function editDistance(left: string, right: string): number {
	let rows = left.length + 1
	let columns = right.length + 1
	let distances: Array<Array<number>> = []

	for (let row = 0; row < rows; row += 1) {
		distances.push(
			Array.from({ length: columns }, (_, column) =>
				row === 0 ? column : column === 0 ? row : 0,
			),
		)
	}

	for (let row = 1; row < rows; row += 1) {
		for (let column = 1; column < columns; column += 1) {
			let cost = left[row - 1] === right[column - 1] ? 0 : 1
			let best = Math.min(
				distances[row - 1]![column]! + 1,
				distances[row]![column - 1]! + 1,
				distances[row - 1]![column - 1]! + cost,
			)

			if (
				row > 1 &&
				column > 1 &&
				left[row - 1] === right[column - 2] &&
				left[row - 2] === right[column - 1]
			) {
				best = Math.min(best, distances[row - 2]![column - 2]! + cost)
			}

			distances[row]![column] = best
		}
	}

	return distances[rows - 1]![columns - 1]!
}

// NOTE: Whether two names begin with the same letter, which is the one position
// in a word a slip almost never lands on — and the one a reader reads first. Two
// names that open alike look alike; two that do not are two words.
//
// Compared without case, because the shift key is a slip like any other and the
// two spellings of a first letter are the same letter.
function sharesOpeningLetter(left: string, right: string): boolean {
	return (
		left.length > 0 &&
		right.length > 0 &&
		(left[0] as string).toLowerCase() === (right[0] as string).toLowerCase()
	)
}

// NOTE: A suggestion is only offered when it is close enough to be plausible —
// proposing an unrelated flag is worse than proposing nothing.
//
// Two edits on a short name is not a near miss, it is a coincidence. `add` and
// `pad` differ in two letters of three, `noon` and `loop` in two of four, and
// both were offered as "Did you mean" with a Quick Fix behind them that wrote
// the wrong word into the reader's file. So the rule is read off the NAME rather
// than off a fixed threshold: one edit is always a near miss — a single slip,
// a swap of two letters included, is the typo people actually make — and
// anything beyond one has to be small next to the name it is measured against,
// a third of its length at most, and has to open on the same letter.
export function closestMatch(
	input: string,
	candidates: Array<string>,
): string | null {
	let best: {
		name: string
		distance: number
		sharesOpening: boolean
	} | null = null

	for (let candidate of candidates) {
		let distance = editDistance(input, candidate)
		let sharesOpening = sharesOpeningLetter(input, candidate)

		// NOTE: A tie is broken on the FIRST candidate, which several callers
		// order their candidates for — see `builtins`. The one thing that comes
		// before that order is the opening letter: between two names the same
		// distance away, the one that starts as the input does is the one the
		// reader was looking at.
		if (
			best === null ||
			distance < best.distance ||
			(distance === best.distance && sharesOpening && !best.sharesOpening)
		) {
			best = { name: candidate, distance, sharesOpening }
		}
	}

	if (best === null) {
		return null
	}

	// NOTE: A candidate must also share more with the input than it differs
	// from it. Without that, every short name is within the threshold of
	// every other short name, and `point.z` gets told it meant `point.x`.
	if (best.distance >= input.length) {
		return null
	}

	return best.distance <= 1 ||
		(best.distance * 3 <= input.length && best.sharesOpening)
		? best.name
		: null
}
