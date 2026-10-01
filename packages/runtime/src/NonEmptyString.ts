// The `NonEmptyString` Namespace. See "Refined Namespaces" in DEVELOPMENT.md.
import { characterIn, type StringType } from "./String"

// `String::character(at:)` without its Optional. The `!` spends the proof: 0
// and -1 are inside every String that holds a character.
export function firstCharacter(string: StringType): StringType {
	return characterIn(string, 0)!
}

export function lastCharacter(string: StringType): StringType {
	return characterIn(string, -1)!
}

// `String`'s own Functions. None of the transforms can empty a String.
export {
	characters,
	length,
	lowercase,
	repeat,
	reverse,
	uppercase,
} from "./String"
