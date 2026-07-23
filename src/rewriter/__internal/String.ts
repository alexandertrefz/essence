import type { ListType } from "./List"
import { createList } from "./List"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import { typeKeySymbol } from "./type"

export type StringType = { [typeKeySymbol]: "String"; value: string }

export function createString(value: string): StringType {
	return { [typeKeySymbol]: "String", value }
}

export function append(
	originalString: StringType,
	otherString: StringType,
): StringType {
	return createString(originalString.value + otherString.value)
}

export function splitOn(
	originalString: StringType,
	splitterString: StringType,
): ListType<StringType> {
	// NOTE: A non-empty splitter is matched as a substring, which lands on
	// code-point boundaries and so is already correct. Splitting on the empty
	// String means "between every character" — `String.split("")` reads that
	// as every UTF-16 code unit, tearing an astral character into two lone
	// surrogates, so that one case splits by code point instead. This is the
	// ONLY place the runtime decides what a character is: `characters()` is
	// written in Essence as `splitOn("")`, and `length`, `characterAt`,
	// `slice` and `reversed` are written on top of `characters()`, so an
	// astral character stays whole for every one of them.
	let parts =
		splitterString.value === ""
			? Array.from(originalString.value)
			: originalString.value.split(splitterString.value)

	return createList(parts.map((chunk) => createString(chunk)))
}

export function uppercased(originalString: StringType): StringType {
	return createString(originalString.value.toUpperCase())
}

export function lowercased(originalString: StringType): StringType {
	return createString(originalString.value.toLowerCase())
}

export function trimmedAtStart(originalString: StringType): StringType {
	return createString(originalString.value.trimStart())
}

export function trimmedAtEnd(originalString: StringType): StringType {
	return createString(originalString.value.trimEnd())
}

// NOTE: The one Method here that still matches by UTF-16 code unit, and the
// reason it can not move into Essence: on the EMPTY part `replaceAll` places
// the replacement at every code-unit boundary — before the first character and
// after the last one included, and between the two halves of an astral
// character. `@::splitOn(part)::joinWith(replacement)` joins code points with
// no outer separators, which is a different String, and Essence has no way to
// name a code unit. It stays native until that case is respecified.
export function replaceEvery(
	originalString: StringType,
	part: StringType,
	replacement: StringType,
): StringType {
	return createString(
		originalString.value.replaceAll(part.value, replacement.value),
	)
}

export function compareTo(
	originalString: StringType,
	otherString: StringType,
): OrderingType {
	// NOTE: Lexicographic by code point, so the order agrees with the
	// code-point view the character Methods take — not JS's UTF-16 `<`. This
	// is also the whole of String equality: `String.is` is written in Essence
	// as `compareTo(other)::is(Ordering#Equal)`.
	let first = Array.from(originalString.value)
	let second = Array.from(otherString.value)
	let shared = Math.min(first.length, second.length)

	for (let index = 0; index < shared; index++) {
		let firstPoint = first[index].codePointAt(0) as number
		let secondPoint = second[index].codePointAt(0) as number

		if (firstPoint < secondPoint) {
			return less
		} else if (firstPoint > secondPoint) {
			return greater
		}
	}

	if (first.length < second.length) {
		return less
	} else if (first.length > second.length) {
		return greater
	} else {
		return equal
	}
}
