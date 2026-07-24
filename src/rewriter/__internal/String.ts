import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { ListType } from "./List"
import { createList } from "./List"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { SideType } from "./Side"
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

export function split(
	originalString: StringType,
	splitterString: StringType,
): ListType<StringType> {
	// NOTE: A non-empty splitter is matched as a substring, which lands on
	// code-point boundaries and so is already correct. Splitting on the empty
	// String means "between every character" — `String.split("")` reads that
	// as every UTF-16 code unit, tearing an astral character into two lone
	// surrogates, so that one case splits by code point instead. This is the
	// ONLY place the runtime decides what a character is: `characters()` is
	// written in Essence as `split("")`, and `length`, `character`,
	// `slice` and `reverse` are written on top of `characters()`, so an
	// astral character stays whole for every one of them.
	let parts =
		splitterString.value === ""
			? Array.from(originalString.value)
			: originalString.value.split(splitterString.value)

	return createList(parts.map((chunk) => createString(chunk)))
}

export function ends(
	originalString: StringType,
	suffix: StringType,
): BooleanType {
	// NOTE: `String.endsWith` is a single pass, where the Essence body sliced
	// the last characters and compared them — four traversals. A well-formed
	// suffix ends on a code-point boundary, so a code-unit `endsWith` can not
	// report a match that splits an astral character.
	return createBoolean(originalString.value.endsWith(suffix.value))
}

export function uppercased(originalString: StringType): StringType {
	return createString(originalString.value.toUpperCase())
}

export function lowercased(originalString: StringType): StringType {
	return createString(originalString.value.toLowerCase())
}

// NOTE: A line break is `\n`, `\r`, or `\r\n`. Splitting keeps empty lines, so
// a trailing break leaves a final empty line and the empty String is one empty
// line — the same shape `split(on:)` gives, over a separator it can not name.
export function lines(originalString: StringType): ListType<StringType> {
	return createList(
		originalString.value
			.split(/\r\n|\r|\n/)
			.map((line) => createString(line)),
	)
}

// NOTE: Words are the runs of non-whitespace, so the whitespace between them —
// and the empty pieces a plain split would leave at the ends and between
// adjacent separators — is dropped. `\s` with the `u` flag is Unicode
// whitespace; a String of only whitespace has no words.
export function words(originalString: StringType): ListType<StringType> {
	let matches = originalString.value.match(/\S+/gu)

	return createList((matches ?? []).map((word) => createString(word)))
}

// NOTE: The one native behind the whole trim family, where there used to be
// two — it reads the `Side` Case and calls the matching JavaScript intrinsic.
// `String::trim()` is written in Essence on top of it, as
// `trim(at Side#BothEnds)`, so it binds to Overload position 2. Whitespace is
// whatever JavaScript calls whitespace, which is the Unicode definition.
export function trim__overload$2(
	originalString: StringType,
	side: SideType,
): StringType {
	switch (side[typeKeySymbol]) {
		case "Side#Start":
			return createString(originalString.value.trimStart())
		case "Side#End":
			return createString(originalString.value.trimEnd())
		default:
			return createString(originalString.value.trim())
	}
}

export function compareTo__overload$1(
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

// NOTE: `length` stays native deliberately. Writing it as
// `@::characters()::length()` is correct but makes counting characters build a
// List of every one of them — turning an O(1) read into an O(n) allocation, and
// pulling `List` and its whole import graph into any Program that so much as
// asks whether a String is empty. `characters`, `slice` and `reverse` are
// still written in Essence on top of `split`.
export function length(originalString: StringType): IntegerType {
	return createInteger(BigInt(Array.from(originalString.value).length))
}
