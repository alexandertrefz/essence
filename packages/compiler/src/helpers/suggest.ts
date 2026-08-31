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

// NOTE: A suggestion is only offered when it is close enough to be plausible —
// proposing an unrelated flag is worse than proposing nothing.
export function closestMatch(
	input: string,
	candidates: Array<string>,
): string | null {
	let best: { name: string; distance: number } | null = null

	for (let candidate of candidates) {
		let distance = editDistance(input, candidate)

		if (best === null || distance < best.distance) {
			best = { name: candidate, distance }
		}
	}

	if (best === null) {
		return null
	}

	let threshold = Math.max(2, Math.floor(input.length / 3))

	// NOTE: A candidate must also share more with the input than it differs
	// from it. Without that, every short name is within the threshold of
	// every other short name, and `point.z` gets told it meant `point.x`.
	return best.distance <= threshold && best.distance < input.length
		? best.name
		: null
}
