// The Damerau-Levenshtein distance, where a swap of two adjacent characters is
// one edit, as in `retrun` for `return`. Exported so every "did you mean" in the
// toolchain answers alike.
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

// Whether two names begin with the same letter, ignoring case. A slip rarely
// lands on the first letter, and a reader reads it first.
function sharesOpeningLetter(left: string, right: string): boolean {
	return (
		left.length > 0 &&
		right.length > 0 &&
		(left[0] as string).toLowerCase() === (right[0] as string).toLowerCase()
	)
}

// The candidate close enough to be a plausible slip, or null. One edit always
// is, a swap included. More edits must be at most a third of the input's length
// and open on the same letter, so `add` is never offered for `pad`.
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

		// A tie goes to the earlier candidate, which callers may order for,
		// unless only the later one shares the opening letter.
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

	// A candidate must share more with the input than it differs from it,
	// so `point.z` is not told it meant `point.x`.
	if (best.distance >= input.length) {
		return null
	}

	return best.distance <= 1 ||
		(best.distance * 3 <= input.length && best.sharesOpening)
		? best.name
		: null
}
