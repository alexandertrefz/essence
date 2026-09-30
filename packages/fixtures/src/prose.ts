// What the prose specs call a sentence and a word, and the checks that read a
// single sentence. The standard library's `§§` blocks and the TypeScript
// comments are held to the same rules, so both specs read them from here.

export function hasEmDash(sentence: string): boolean {
	return sentence.includes("—")
}

// An abbreviation ends in a period without ending a sentence. A sentence that
// ends in one of these is rare enough to be worth the run-on it causes.
const abbreviationPattern = /\b(?:e\.g|i\.e|etc|vs|cf)\.$/

// A `code span` is one term however long it is, and a period inside it ends no
// sentence. It is masked to one lowercase word, which the capitals check then
// leaves alone: code is spelled the way the code is.
export function maskCode(text: string): string {
	return text.replace(/`[^`]*`/g, "code")
}

// A sentence ends at a period, a question mark or an exclamation mark that is
// followed by a space and the start of another one. A colon introduces an
// example that belongs to its sentence. `1.5` has no space after its period.
// A split after an abbreviation is joined again.
export function sentencesOf(text: string): Array<string> {
	let sentences: Array<string> = []

	for (let piece of maskCode(text).split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)) {
		let previous = sentences[sentences.length - 1]

		if (previous !== undefined && abbreviationPattern.test(previous)) {
			sentences[sentences.length - 1] = `${previous} ${piece}`

			continue
		}

		sentences.push(piece)
	}

	return sentences
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence !== "")
}

// A word holds at least one letter or digit, so a lone dash or arrow is none.
export function wordsOf(sentence: string): Array<string> {
	return sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word))
}

// The capitals a word is spelled in, once its punctuation and digits are gone.
// It needs three of them and no lowercase letter, so "O(1)" and "ASTs" answer
// null.
export function capitalsOf(word: string): string | null {
	let capitals = /^[A-Z]{3,}$/.exec(word.replace(/[^A-Za-z]/g, ""))

	return capitals === null ? null : capitals[0]
}
