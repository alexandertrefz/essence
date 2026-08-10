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
// decomposed) have the SAME view, which is what makes `is`/`compare` agree.
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

// NOTE: Segmenting is by far the most expensive thing a String Method does —
// measured at some four microseconds for a short String, against nanoseconds
// for everything built on it — and the position Methods ask for the SAME view
// of the SAME String over and over: a loop reading `character(at:)` segments
// once per step, and `length` inside its condition segments again. So the view,
// and the count taken off it, are remembered on the String value itself, under
// Symbol keys.
//
// NOTE: A Symbol key is why this is invisible. `Object.keys`, `Object.entries`
// and `Object.hasOwn` — which is the whole of what Record equality, the printer
// and the runtime Type checks read a value with — do not see one, so a String
// that has been measured is indistinguishable from one that has not. And a
// String is immutable, so a remembered answer can never go stale: the value the
// answer was taken from is the value the wrapper still holds.
const graphemesKey = Symbol("$graphemes")
const graphemeCountKey = Symbol("$graphemeCount")

type MeasuredString = StringType & {
	[graphemesKey]?: Array<string>
	[graphemeCountKey]?: number
}

// NOTE: The segmented view of a String, segmented at most once. The remembered
// array IS what is handed back rather than a copy of it, so every caller here
// only ever READS it — one that needs to change it has to copy first.
function graphemesIn(string: StringType): Array<string> {
	let measured = string as MeasuredString
	let segments = measured[graphemesKey]

	if (segments === undefined) {
		segments = graphemesOf(string.value)
		measured[graphemesKey] = segments
	}

	return segments
}

// NOTE: A String assembled FROM a known character view keeps that view — the
// clusters are remembered under the Symbol keys right away, so every Method
// reading `graphemesIn` sees exactly the characters the assembly meant.
// Segmenting the joined text afresh does not always answer the same view back:
// grapheme boundaries are decided by neighbours, so three regional indicators
// re-pair however they happen to stand. The handed-in array is remembered
// as-is, so a caller building one must not change it afterwards.
function createSegmentedString(characters: Array<string>): StringType {
	let string = createString(characters.join("")) as MeasuredString

	string[graphemesKey] = characters
	string[graphemeCountKey] = characters.length

	return string
}

// NOTE: Whether counting this String's characters can skip the Segmenter
// entirely. ASCII is closed under NFC and carries no combining marks, so each
// of its code units stands alone as a grapheme cluster and the count is simply
// how many units there are. The one exception is a carriage return: Unicode
// joins CR LF into a SINGLE cluster, so a String holding one declines the fast
// path and is segmented properly. A code unit below 128 is also never half of a
// surrogate pair, so "every unit is ASCII" really does mean "every character
// is one unit".
//
// NOTE: Measured on a short String: ~4,200ns to segment, ~44ns to scan,
// ~1ns to read the remembered count.
function isSingleUnitAscii(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		let code = value.charCodeAt(index)

		if (code >= 128 || code === 13) {
			return false
		}
	}

	return true
}

// NOTE: How many characters a String holds, counted at most once. A String
// already segmented for some other Method is counted off that view rather than
// scanned again.
function graphemeCountIn(string: StringType): number {
	let measured = string as MeasuredString
	let count = measured[graphemeCountKey]

	if (count === undefined) {
		let segments = measured[graphemesKey]

		if (segments !== undefined) {
			count = segments.length
		} else if (isSingleUnitAscii(string.value)) {
			count = string.value.length
		} else {
			count = graphemesIn(string).length
		}

		measured[graphemeCountKey] = count
	}

	return count
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
	let characters = graphemesIn(originalString)

	if (splitterString.value === "") {
		return createList(
			characters.map((character) => createString(character)),
		)
	}

	let separator = graphemesIn(splitterString)
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

	// NOTE: Each piece is handed its own characters along with its text — the
	// clusters it was cut into ARE its character view, so `length` on a piece
	// answers off them rather than segmenting the joined text afresh, which
	// could pair the clusters differently (see `createSegmentedString`).
	return createList(pieces.map((piece) => createSegmentedString(piece)))
}

// NOTE: The reversed String REMEMBERS its character view — the original's
// clusters in the opposite order — rather than letting the joined text be
// segmented afresh. Re-segmenting would hand back characters the original
// never had: `"🇦🇧🇨"` holds the characters `🇦🇧` and `🇨`, and its reversal
// spells the very code points a fresh segmentation reads as `🇨🇦` and `🇧`.
// The remembered view is what keeps "the characters in the opposite order"
// true as stated, makes a second `reverse` answer the original String back,
// and is what the `lastIndex` derivation off `reverse` + `firstIndex` in
// `String.es` rests on.
export function reverse(originalString: StringType): StringType {
	return createSegmentedString([...graphemesIn(originalString)].reverse())
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
	let characters = graphemesIn(originalString)
	let suffixCharacters = graphemesIn(suffix)

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

export function uppercase(originalString: StringType): StringType {
	return createString(originalString.value.toUpperCase())
}

export function lowercase(originalString: StringType): StringType {
	return createString(originalString.value.toLowerCase())
}

// NOTE: `normalize()` with no Argument is the Composed Canonical (NFC) entry,
// written in Essence on top of this one; this native names the form. The four
// Cases are the four Unicode normalization forms, so the map to the JavaScript
// `String.prototype.normalize` argument is direct.
export function normalize__overload$2(
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

export function compare__overload$1(
	originalString: StringType,
	otherString: StringType,
): OrderingType {
	// NOTE: Lexicographic by code point, over the NFC-normalised String — so a
	// canonically equivalent pair (an accent composed or decomposed) compares
	// `Equal`, and the order agrees with the grapheme view the character
	// Methods take rather than JS's UTF-16 `<`. This is also the whole of
	// String equality: `String.is` is `compare(other)::is(Ordering#Equal)` in
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
	return createInteger(BigInt(graphemeCountIn(originalString)))
}
