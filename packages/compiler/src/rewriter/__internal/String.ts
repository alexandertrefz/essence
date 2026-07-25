import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { ListType } from "./List"
import { createList } from "./List"
import type { NormalizationFormType } from "./NormalizationForm"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { SideType } from "./Side"
import { typeKeySymbol } from "./type"

export type StringType = { [typeKeySymbol]: "String"; value: string }

export function createString(value: string): StringType {
	return { [typeKeySymbol]: "String", value }
}

// NOTE: The canonical grapheme view every position Method reads through: the
// String normalised to NFC and then segmented into grapheme clusters — what a
// reader calls a "character". `Intl.Segmenter` groups a base and its combining
// marks, a ZWJ emoji sequence and a flag's two regional indicators each into
// ONE element, so `length`, `character(at:)`, `slice` and `reverse` never split
// one. NFC first means canonically equivalent Strings (an accent composed or
// decomposed) have the SAME view, which is what makes `is`/`compareTo` agree.
// The Segmenter is built once — constructing one per call is the expensive part.
const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
})

function graphemesOf(value: string): Array<string> {
	let result: Array<string> = []

	for (let { segment } of graphemeSegmenter.segment(value.normalize("NFC"))) {
		result.push(segment)
	}

	return result
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
	// NOTE: The one place the runtime decides what a character is, and every
	// position Method rests on it: `characters()` is `split("")`, and `length`,
	// `character`, `slice`, `reverse`, `firstIndex`, `contains`, `pad` and the
	// rest are written on top of those. Both sides are taken as grapheme
	// clusters (see `graphemesOf`), so the empty separator splits into
	// characters and a non-empty one matches only as a WHOLE run of characters
	// — a separator can never land inside a cluster and tear it, and the pieces
	// come back on cluster boundaries. NFC on both sides means the match is by
	// canonical equivalence, like `is`.
	let characters = graphemesOf(originalString.value)

	if (splitterString.value === "") {
		return createList(
			characters.map((character) => createString(character)),
		)
	}

	let separator = graphemesOf(splitterString.value)
	let pieces: Array<Array<string>> = []
	let current: Array<string> = []
	let index = 0

	while (index < characters.length) {
		let matches =
			index + separator.length <= characters.length &&
			separator.every(
				(character, offset) => characters[index + offset] === character,
			)

		if (matches) {
			pieces.push(current)
			current = []
			index += separator.length
		} else {
			current.push(characters[index])
			index++
		}
	}

	pieces.push(current)

	return createList(pieces.map((piece) => createString(piece.join(""))))
}

export function ends(
	originalString: StringType,
	suffix: StringType,
): BooleanType {
	// NOTE: Native — one grapheme pass, where the Essence body sliced the last
	// characters and compared them (four traversals). Both sides are taken as
	// the canonical grapheme view, so the suffix matches only on a cluster
	// boundary and by canonical equivalence, exactly as `starts(with:)` does
	// through `slice`. `starts` stays Essence because its slice begins at zero
	// and needs no length.
	let characters = graphemesOf(originalString.value)
	let suffixCharacters = graphemesOf(suffix.value)

	if (suffixCharacters.length > characters.length) {
		return createBoolean(false)
	}

	let offset = characters.length - suffixCharacters.length

	return createBoolean(
		suffixCharacters.every(
			(character, index) => characters[offset + index] === character,
		),
	)
}

export function uppercased(originalString: StringType): StringType {
	return createString(originalString.value.toUpperCase())
}

export function lowercased(originalString: StringType): StringType {
	return createString(originalString.value.toLowerCase())
}

// NOTE: `normalized()` with no Argument is the Composed Canonical (NFC) entry,
// written in Essence on top of this one; this native names the form. The four
// Cases are the four Unicode normalization forms, so the map to `normalize`'s
// argument is direct.
export function normalized__overload$2(
	originalString: StringType,
	form: NormalizationFormType,
): StringType {
	switch (form[typeKeySymbol]) {
		case "NormalizationForm#DecomposedCanonical":
			return createString(originalString.value.normalize("NFD"))
		case "NormalizationForm#ComposedCompatibility":
			return createString(originalString.value.normalize("NFKC"))
		case "NormalizationForm#DecomposedCompatibility":
			return createString(originalString.value.normalize("NFKD"))
		default:
			return createString(originalString.value.normalize("NFC"))
	}
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
	// NOTE: Lexicographic by code point, over the NFC-normalised String — so a
	// canonically equivalent pair (an accent composed or decomposed) compares
	// `Equal`, and the order agrees with the grapheme view the character
	// Methods take rather than JS's UTF-16 `<`. This is also the whole of
	// String equality: `String.is` is `compareTo(other)::is(Ordering#Equal)` in
	// Essence, so equality is canonical equivalence too.
	let first = Array.from(originalString.value.normalize("NFC"))
	let second = Array.from(otherString.value.normalize("NFC"))
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
// List of every one of them — turning the count into an O(n) allocation, and
// pulling `List` and its whole import graph into any Program that so much as
// asks whether a String is empty. It counts grapheme clusters, the same view
// `split`/`characters`/`slice`/`reverse` take, so a base and its combining
// marks — or a ZWJ emoji — count as the one character a reader sees.
export function length(originalString: StringType): IntegerType {
	return createInteger(BigInt(graphemesOf(originalString.value).length))
}
