// NOTE: The runtime module of the `NonEmptyString` Namespace — the Strings a
// Program has proven have a character in them. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is the whole of it.
//
// NOTE: A refinement erases before anything runs, so what arrives is an
// ordinary `StringType` and the evidence the Type carried was spent while
// compiling. Read off a String nothing proved anything about, the first
// character of an empty view is `undefined` — and that this can not happen is
// exactly what the Namespace's target bought. The proof is spent HERE, which is
// why neither of the two ends could be written in Essence: the language has no
// way to be told that it holds.
import {
	createAsciiString,
	createString,
	graphemesIn,
	isAsciiIn,
	type StringType,
} from "./String"

// NOTE: Both ends take the two-branch shape `String::character(at:)` takes: an
// ASCII String is read by UNIT, and every other one comes through the view.
// Reading one end off the view builds the whole Array of characters to hand
// back one of them, which made the PROVEN Method several times slower than the
// unproven one whose Optional it was meant to spare a Program — 200 reads of a
// 117,003-character ASCII String measured 120,758 µs through the view against
// 16,121 µs for `character(at 0)`, and the gap widened with the length because
// only one of the two is O(1). Both now measure 16,174 µs, which is the
// receiver's own scan and nothing else. The unit is marked ASCII, as a piece
// of a `split` is, so a Method asked about the answer does not rescan it, and
// that mark is what `asciiFastPath.spec.ts` reads to say which branch ran.
export function firstCharacter(string: StringType): StringType {
	if (isAsciiIn(string)) {
		return createAsciiString(string.value[0]!)
	}

	return createString(graphemesIn(string)[0]!)
}

export function lastCharacter(string: StringType): StringType {
	if (isAsciiIn(string)) {
		return createAsciiString(string.value[string.value.length - 1]!)
	}

	let characters = graphemesIn(string)

	return createString(characters[characters.length - 1]!)
}

// NOTE: Everything below is `String`'s own Function under this Namespace's
// name. The characters are the same segmentation and the count is the same
// walk, and the four transforms are the same operations — none of them can
// empty a String that was not empty, which is all the refined answer says.
// Each is here at all because an Essence body could not write it:
// `@::length()` on a proven receiver is this Method rather than `String`'s.
export {
	characters,
	length,
	lowercase,
	repeat,
	reverse,
	uppercase,
} from "./String"
