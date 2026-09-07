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
import type { ListType } from "./List"
import {
	createString,
	graphemesIn,
	split__overload$1,
	type StringType,
} from "./String"

export function firstCharacter(string: StringType): StringType {
	return createString(graphemesIn(string)[0]!)
}

export function lastCharacter(string: StringType): StringType {
	let characters = graphemesIn(string)

	return createString(characters[characters.length - 1]!)
}

// NOTE: `@::split(on "")`, which is the Essence body of `String::characters`,
// written here as the one call it is: that body exports nothing to import, and
// the empty separator is the one arm of `split` this reproduces. Splitting is
// what decides what a character is (`graphemesOf` in `String.ts`), so going
// through it is what keeps the two entries answering the same characters.
const noSeparator = createString("")

export function characters(string: StringType): ListType<StringType> {
	return split__overload$1(string, noSeparator)
}

// NOTE: Everything below is `String`'s own Function under this Namespace's
// name. The count is the same walk, and the four transforms are the same
// operations — none of them can empty a String that was not empty, which is
// all the refined answer says. Each is here at all because an Essence body
// could not write it: `@::length()` on a proven receiver is this Method rather
// than `String`'s.
export { length, lowercase, repeat, reverse, uppercase } from "./String"
