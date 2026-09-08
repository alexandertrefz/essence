import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { ListType } from "./List"
import { createList } from "./List"
import type { NormalizationFormType } from "./NormalizationForm"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import type { SideType } from "./Side"
import { type AnyType, typeKeySymbol } from "./type"

export type StringType = { [typeKeySymbol]: "String"; value: string }

export function createString(value: string): StringType {
	return { [typeKeySymbol]: "String", value }
}

// NOTE: The escapes are the String Literal's own spellings, so what a quoted
// rendering shows is unambiguous: an embedded quote no longer reads as the
// closing one, a backslash as an escape it never was, and a line break no
// longer splits the one value across two lines of output. The remaining
// control characters have no Essence spelling of their own, so they render as
// their code point.
const stringEscapes: { [character: string]: string } = {
	"\\": "\\\\",
	'"': '\\"',
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
}

// NOTE: A String written the way a Program would write it down — the text in
// quotes, with anything a Literal has to escape escaped. It is here rather than
// beside its callers because it is the one answer to one question, and three
// readers ask it: `List.toString`, `Optional.toString` and the structural
// rendering `Terminal.inspect` and `Record.toString` share.
export function quoted(value: string): string {
	return `"${value.replace(
		// oxlint-disable-next-line no-control-regex -- matching control characters is this function's job
		/[\\"\n\r\t\u0000-\u001F\u007F-\u009F]/g,
		(character) =>
			stringEscapes[character] ??
			`\\u{${character.charCodeAt(0).toString(16).toUpperCase()}}`,
	)}"`
}

// NOTE: THE ONE RULE for a value rendered INSIDE a structure: a String is
// quoted there and bare on its own. `Terminal.print("x")` writes `x` and a hole
// renders `x`, because there the String IS the whole of the text; inside a List
// or a Case it is one piece beside others, and `["a", "", "b"]` has to be told
// from `[a, , b]`. `Record.toString` has quoted its String members all along,
// and this is the same rule where a List and an Optional read their items.
//
// NOTE: The tag is read rather than the conformance, because a `Printable`
// witness says how a value renders and not what kind it is: `String.toString`
// is the identity, so a String item arrives already indistinguishable from the
// text around it.
export function itemText<ItemType extends AnyType>(
	value: ItemType,
	conformance: {
		toString: (value: ItemType) => StringType
	},
): string {
	return value[typeKeySymbol] === "String"
		? quoted((value as StringType).value)
		: conformance.toString(value).value
}

// NOTE: The canonical grapheme view every position Method reads through: the
// String normalised to NFC and then segmented into grapheme clusters — what a
// reader calls a "character". `Intl.Segmenter` groups a base and its combining
// marks, a ZWJ emoji sequence and a flag's two regional indicators each into
// ONE element, so `length`, `character(at:)`, `slice` and `reverse` never split
// one. NFC first means canonically equivalent Strings (an accent composed or
// decomposed) have the SAME view, which is what makes `is`/`compare` agree.
// The Segmenter is built once — constructing one per call is the expensive part.
//
// NOTE: Built on FIRST USE rather than when the module is loaded, and that is
// worth a named variable. Constructing one costs about a millisecond of table
// loading, which every Program used to pay before its first Statement ran —
// including the many that never segment anything, because ASCII counts by code
// unit and the Symbol-keyed views answer the rest. It is remembered in a
// variable rather than rebuilt, so a Program that DOES segment pays that
// millisecond once, exactly as it did before.
//
// NOTE: It also keeps this module free of a top-level side effect, which is why
// a Program can import `normalisedFormOf` — the answer `is` and `compare` are
// decided by — without carrying the segmenter it does not reach.
let graphemeSegmenter: Intl.Segmenter | null = null

function segmenter(): Intl.Segmenter {
	if (graphemeSegmenter === null) {
		graphemeSegmenter = new Intl.Segmenter(undefined, {
			granularity: "grapheme",
		})
	}

	return graphemeSegmenter
}

function graphemesOf(value: string): Array<string> {
	let result: Array<string> = []

	for (let { segment } of segmenter().segment(value.normalize("NFC"))) {
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
// NOTE: The same remembering serves `is` and `compare`, which ask a different
// question of the same String: what its NFC form is. Normalising allocates a
// String per call and both sides of every comparison paid it, so sorting a
// thousand names normalised twenty thousand times — for a thousand distinct
// answers. `isAscii` is remembered beside it because it is what decides whether
// there is anything to normalise at all.
const graphemesKey = Symbol("$graphemes")
const graphemeCountKey = Symbol("$graphemeCount")
const isAsciiKey = Symbol("$isAscii")
const normalisedKey = Symbol("$normalised")

type MeasuredString = StringType & {
	[graphemesKey]?: Array<string>
	[graphemeCountKey]?: number
	[isAsciiKey]?: boolean
	[normalisedKey]?: string
}

// NOTE: The segmented view of a String, segmented at most once. The remembered
// array IS what is handed back rather than a copy of it, so every caller here
// only ever READS it — one that needs to change it has to copy first.
//
// NOTE: A String the ASCII scan accepted is split into its code units instead
// of being segmented, for the reason `isSingleUnitAscii` gives: each unit IS a
// cluster, and the text is its own NFC form. That is the same view the
// Segmenter answers, without the Segmenter. Measured on a 10,800-character
// ASCII String, best of three: 415 µs to segment against 14 µs to split, and
// `reverse` reads through here — `slice`, `character(at:)` and `ends` read
// the units directly for such a String and come here for every other.
//
// NOTE: Exported for `NonEmptyString.ts`, which reads the two ends of the view
// off it — the same reason `List.ts` exports `viewOf` for `NonEmptyList.ts`. A
// refined Namespace answers a character where this one answers an Optional, and
// the view is what either answer is read from.
export function graphemesIn(string: StringType): Array<string> {
	let measured = string as MeasuredString
	let segments = measured[graphemesKey]

	if (segments === undefined) {
		segments = isAsciiIn(string)
			? string.value.split("")
			: graphemesOf(string.value)
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

// NOTE: The scan above, remembered — it is asked by the count, by `append` and
// by every comparison, and its answer can not change any more than the String
// can. A remembered `true` is also what `append` PROPAGATES: joining two
// carriage-return-free ASCII Strings can produce neither a non-ASCII unit nor a
// carriage return, so the answer is known without scanning the join.
//
// NOTE: Exported for `NonEmptyString.ts` beside `graphemesIn`, which reads the
// two ends off the view — the fast path there is this question and the maker
// below, exactly as `character(at:)` asks them here.
export function isAsciiIn(string: StringType): boolean {
	let measured = string as MeasuredString
	let answer = measured[isAsciiKey]

	if (answer === undefined) {
		answer = isSingleUnitAscii(string.value)
		measured[isAsciiKey] = answer
	}

	return answer
}

// NOTE: A String its maker KNOWS the scan would accept, marked so without the
// scan and given the count that follows from the mark: its characters are its
// units. Every Method that maps ASCII to ASCII answers through here — `repeat`,
// the case mappings, `trim`, `slice`, `character(at:)`, and the pieces of a
// `split` or a `words` taken off an ASCII receiver — so that a loop measuring
// what it built does not rescan it. `append` alone writes the two keys itself,
// for the reason it gives. The caller is answerable for the claim, and the
// note at each call says why it holds.
export function createAsciiString(value: string): StringType {
	let string = createString(value) as MeasuredString

	string[isAsciiKey] = true
	string[graphemeCountKey] = value.length

	return string
}

// NOTE: The String's NFC form, normalised at most once — what `is` and
// `compare` decide over, so that an accent written as one code point and the
// same accent written as two are one String. It is the whole of the comparison
// for equality (two NFC Strings hold the same characters exactly when their
// code points match) and the text `compare` walks.
//
// NOTE: ASCII is already NFC — it carries no combining marks and no
// decomposable character — so a String the scan above accepted IS its own
// normal form and the JavaScript call is skipped outright. That is the common
// case, and the one that used to allocate two Strings per unequal comparison.
export function normalisedFormOf(string: StringType): string {
	let measured = string as MeasuredString
	let form = measured[normalisedKey]

	if (form === undefined) {
		form = isAsciiIn(string) ? string.value : string.value.normalize("NFC")
		measured[normalisedKey] = form
	}

	return form
}

// NOTE: How many characters a String holds, counted at most once. A String
// already segmented for some other Method is counted off that view rather than
// scanned again.
function graphemeCountIn(string: StringType): number {
	let measured = string as MeasuredString
	let characterCount = measured[graphemeCountKey]

	if (characterCount === undefined) {
		let segments = measured[graphemesKey]

		if (segments !== undefined) {
			characterCount = segments.length
		} else if (isAsciiIn(string)) {
			characterCount = string.value.length
		} else {
			characterCount = graphemesIn(string).length
		}

		measured[graphemeCountKey] = characterCount
	}

	return characterCount
}

// NOTE: The joined String is a NEW String and remembers nothing of either
// operand's character view — grapheme boundaries are decided by NEIGHBOURS, so
// the last cluster of one and the first of the other may join across the seam
// (a base and a following combining mark, two regional indicators, a carriage
// return and a line feed) and neither operand's clusters survive the join
// intact.
//
// NOTE: With ONE exception, which is the whole point: the join of two Strings
// the ASCII scan accepted is itself such a String, and its characters are its
// code units. Both facts follow from what the scan excludes — a unit at or
// above 128 (so no combining mark, no surrogate, nothing decomposable) and a
// carriage return (so the CR LF cluster can not form at the seam either). So
// the answer is marked ASCII and given the two counts added, and a loop that
// builds a String by appending and reads its length per turn stops re-scanning
// everything it has built so far.
export function append(
	originalString: StringType,
	otherString: StringType,
): StringType {
	let joined = createString(
		originalString.value + otherString.value,
	) as MeasuredString

	// NOTE: The count is the joined text's own unit count, which for two such
	// operands is exactly the two counts added — each of them counts by unit
	// for the same reason. Written this way rather than as the sum so that
	// joining does not reach the counting Method at all, and a Program that
	// only joins Strings carries no segmenter.
	//
	// NOTE: The two keys are written here rather than through
	// `createAsciiString`, which every other maker uses: a Program that only
	// interpolates reaches `append`, `isAsciiIn` and `createString` out of
	// this whole module, and `bundleSize.spec.ts` holds such a Program to the
	// byte. Routing `append` through the helper pulls the helper in and
	// measured 124 bytes more, where that ceiling has five bytes of room.
	if (isAsciiIn(originalString) && isAsciiIn(otherString)) {
		joined[isAsciiKey] = true
		joined[graphemeCountKey] = joined.value.length
	}

	return joined
}

// NOTE: Whether a run of the separator's characters stands at a position of
// the view — the one comparison every grapheme-view search below makes, and
// `split` makes it once per position. A loop rather than `every` over the
// separator, because of the closure allocated per position: the walk over
// three hundred lines of thirty-six characters measured 49 µs with `every`
// and 22 µs with the loop.
function separatorMatchesAt(
	characters: Array<string>,
	separator: Array<string>,
	index: number,
): boolean {
	if (index + separator.length > characters.length) {
		return false
	}

	for (let offset = 0; offset < separator.length; offset++) {
		if (characters[index + offset] !== separator[offset]) {
			return false
		}
	}

	return true
}

// NOTE: The first of two entries, and the two are the same Function. The
// second declares a `NonEmptyString` separator and answers a `NonEmptyList` —
// a promise the Types make and erase, so there is nothing here to do
// differently. What makes it true is the unconditional `pieces.push(current)`
// below: a separator with a character in it leaves the piece before it,
// whether or not it matched, so only the empty separator can answer no pieces.
export function split__overload$1(
	originalString: StringType,
	splitterString: StringType,
): ListType<StringType> {
	// NOTE: The one place the runtime decides what a character is, and every
	// position Method rests on it: `characters()` is `split("")`, and `length`,
	// `character`, `slice`, `reverse`, `pad` and the rest are written on top
	// of those, while the searches beside it — `firstIndex`, `lastIndex`,
	// `count` — read the same view the same way. Both sides are taken as
	// grapheme clusters (see `graphemesOf`), so the empty separator splits into
	// characters and a non-empty one matches only as a WHOLE run of characters
	// — a separator can never land inside a cluster and tear it, and the pieces
	// come back on cluster boundaries. NFC on both sides means the match is by
	// canonical equivalence, like `is`.
	//
	// NOTE: Two Strings the ASCII scan accepted are split by the JavaScript
	// intrinsic instead, and that IS the grapheme answer: each unit is a
	// cluster and neither side has anything to normalise, so a run of the
	// separator's units is a run of its characters, and `split` finds the
	// same non-overlapping runs left to right that the walk below finds. A
	// piece of such a String is such a String, so each is marked ASCII with
	// its unit count rather than handed a view. Measured per split, best of
	// three: a 10,800-character ASCII String into 300 lines, 574 µs through
	// the walk and 14 µs through the intrinsic; a twelve-character one at a
	// comma, 2.1 µs against 0.05.
	if (isAsciiIn(originalString) && isAsciiIn(splitterString)) {
		// NOTE: The EMPTY separator is the one arm that goes through the
		// view rather than the intrinsic, because for such a receiver the
		// view IS `value.split("")` — and `graphemesIn` REMEMBERS it, where
		// the intrinsic splits the whole String again per call. This arm is
		// `characters()`, which a Program reading a held String asks over and
		// over: 200 splits of one 11,703-character ASCII String measured
		// 17,209 µs through the intrinsic and 8,756 µs off the remembered
		// view, best of ten.
		//
		// NOTE: The pieces are NOT marked, which the other arm's are. A
		// piece here is ONE character, so the scan that would answer the mark
		// is a single unit and the mark saves nothing worth having — where
		// writing it costs two Symbol keys on every character of the
		// receiver, and that measured 14,528 µs against the 8,756 above. A
		// piece of a non-empty split is as long as the receiver and is marked
		// for that reason.
		if (splitterString.value === "") {
			return createList(
				graphemesIn(originalString).map((character) =>
					createString(character),
				),
			)
		}

		return createList(
			originalString.value
				.split(splitterString.value)
				.map((piece) => createAsciiString(piece)),
		)
	}

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
		if (separatorMatchesAt(characters, separator, index)) {
			pieces.push(current)
			current = []
			index += separator.length
		} else {
			current.push(characters[index]!)
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

export const split__overload$2 = split__overload$1

// NOTE: The three searches, native so that a question about a POSITION never
// builds the pieces `split` builds. An Essence `firstIndex` on `split(on
// part)` reads the first piece's length, so `contains` — written on it —
// segments and copies a whole String to answer a Boolean: measured on a
// 10,800-character ASCII String, one `contains` of an absent part, 504 µs
// that way against 8 µs here.
// Each search reads the view `split` reads, so an occurrence is a whole run
// of characters on cluster boundaries, matched by canonical equivalence; and
// each takes the intrinsic when both sides pass the ASCII scan, for the
// reason `split` gives.
//
// NOTE: The empty part matches nowhere, except as a position at either end.
// The rule is stated ONCE, above `contains` in `String.es`, and the three
// guards below are its answers: 0, the length, and 0.
//
// NOTE: The first of two entries — the second takes a `defaultingTo:`
// fallback and is written in Essence on this one.
export function firstIndex__overload$1(
	originalString: StringType,
	part: StringType,
): OptionalType<IntegerType> {
	if (part.value === "") {
		return createValue(createInteger(0))
	}

	let index: number

	if (isAsciiIn(originalString) && isAsciiIn(part)) {
		index = originalString.value.indexOf(part.value)
	} else {
		let characters = graphemesIn(originalString)
		let separator = graphemesIn(part)

		index = -1

		for (
			let position = 0;
			position + separator.length <= characters.length;
			position++
		) {
			if (separatorMatchesAt(characters, separator, position)) {
				index = position
				break
			}
		}
	}

	return index < 0 ? createEmpty() : createValue(createInteger(index))
}

// NOTE: The LAST occurrence, which can overlap an earlier one: `"aaa"` holds
// `"aa"` at 0 and at 1, and the answer is 1, as `lastIndexOf` answers. The
// walk runs from the last position the part fits at down to the first, so it
// stops at the first match it meets. The first of two entries, as above.
export function lastIndex__overload$1(
	originalString: StringType,
	part: StringType,
): OptionalType<IntegerType> {
	if (part.value === "") {
		return createValue(createInteger(graphemeCountIn(originalString)))
	}

	let index: number

	if (isAsciiIn(originalString) && isAsciiIn(part)) {
		index = originalString.value.lastIndexOf(part.value)
	} else {
		let characters = graphemesIn(originalString)
		let separator = graphemesIn(part)

		index = -1

		for (
			let position = characters.length - separator.length;
			position >= 0;
			position--
		) {
			if (separatorMatchesAt(characters, separator, position)) {
				index = position
				break
			}
		}
	}

	return index < 0 ? createEmpty() : createValue(createInteger(index))
}

// NOTE: The occurrences that do NOT overlap — the ones `split` cuts at — so
// `"aaa"::count(of "aa")` is 1: after a match the walk steps over the whole
// part, exactly as `split` does, and the count is one less than the pieces
// `split` would answer. An Essence body on `firstIndex` and `slice` would
// cut the rest of the String at every occurrence found, which is quadratic
// in the occurrences; this is one walk. Measured on a 10,800-character ASCII
// String with 3,600 occurrences: 537 µs counting the pieces, 33 µs here.
export function count(
	originalString: StringType,
	part: StringType,
): IntegerType {
	if (part.value === "") {
		return createInteger(0)
	}

	let occurrences = 0

	if (isAsciiIn(originalString) && isAsciiIn(part)) {
		let text = originalString.value
		let width = part.value.length
		let index = text.indexOf(part.value)

		while (index >= 0) {
			occurrences++
			index = text.indexOf(part.value, index + width)
		}
	} else {
		let characters = graphemesIn(originalString)
		let separator = graphemesIn(part)
		let index = 0

		while (index + separator.length <= characters.length) {
			if (separatorMatchesAt(characters, separator, index)) {
				occurrences++
				index += separator.length
			} else {
				index++
			}
		}
	}

	return createInteger(occurrences)
}

// NOTE: The reversed String REMEMBERS its character view — the original's
// clusters in the opposite order — rather than letting the joined text be
// segmented afresh. Re-segmenting would hand back characters the original
// never had: `"🇦🇧🇨"` holds the characters `🇦🇧` and `🇨`, and its reversal
// spells the very code points a fresh segmentation reads as `🇨🇦` and `🇧`.
// The remembered view is what keeps "the characters in the opposite order"
// true as stated, and makes a second `reverse` answer the original String
// back.
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
	//
	// NOTE: Two ASCII Strings are compared by the intrinsic, for the reason
	// `split` gives, so the Boolean allocates nothing.
	if (isAsciiIn(originalString) && isAsciiIn(suffix)) {
		return createBoolean(originalString.value.endsWith(suffix.value))
	}

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

// NOTE: A position as the grapheme view sees it — a negative one counts back
// from the end, so -1 is the last character and -length the first. This is
// exactly what `List.positionFromEnd` does for a List, which is what these
// Methods used to reach through, and it is spelled here rather than imported so
// that a Program slicing Strings carries no List.
function positionFromEnd(index: number | bigint, count: number): number {
	// NOTE: A bigint index is past either end of any String, for the reason
	// `List.positionFromEnd` states.
	if (typeof index !== "number") {
		return index < 0n ? -1 : count
	}

	return index < 0 ? index + count : index
}

// NOTE: Native — one read out of the grapheme view, where the Essence body
// (`@::characters()::item(at index)`) built a String for every character of the
// receiver and a List to hold them, to hand back one of them. Reading a
// character of a ten thousand character String allocated ten thousand and one
// values.
//
// NOTE: The answer is a plain String rather than a segmented one: a single
// cluster taken out of the view segments to itself, so there is nothing for
// remembering to protect. `split` hands its pieces their clusters because a
// piece is SEVERAL of them and re-segmenting could pair them differently.
//
// NOTE: The first of two entries — the second takes a `defaultingTo:` fallback
// and is written in Essence on this one, so this export carries the Overload
// suffix its position gives it.
export function character__overload$1(
	originalString: StringType,
	index: IntegerType,
): OptionalType<StringType> {
	// NOTE: An ASCII String is read by unit rather than through the view, for
	// the reason `split` gives — so reading one character of it builds no
	// Array of all of them, and the unit is marked ASCII as a piece of a
	// `split` is. Measured on a 10,800-character ASCII String: 380 µs through
	// the view, 8 µs here, most of which is the scan.
	if (isAsciiIn(originalString)) {
		let text = originalString.value
		let position = positionFromEnd(index.value, text.length)

		if (position < 0 || position >= text.length) {
			return createEmpty()
		}

		return createValue(createAsciiString(text[position]!))
	}

	let characters = graphemesIn(originalString)
	let position = positionFromEnd(index.value, characters.length)

	if (position < 0 || position >= characters.length) {
		return createEmpty()
	}

	return createValue(createString(characters[position]!))
}

// NOTE: Native — the characters between two positions, where the Essence body
// went through `characters()` and `List.slice` and `join`: a String per
// character of the receiver, a List of them, a second List for the window and a
// join to put the text back together. Half-open [from, to), a negative position
// counting back from the end, each end THEN clamped — the same resolution
// `List.slice` performs, and the reason it is written out is that this is now
// the only place that needs it.
//
// NOTE: The answer carries the clusters it was cut into, exactly as a piece of
// a `split` does — a window of a view is several clusters, and segmenting the
// joined text afresh does not always read the same ones back.
//
// NOTE: An ASCII String is cut by the intrinsic instead, for the reason
// `split` gives, and the window is marked ASCII: a window of such a String
// is such a String. Measured on a 10,800-character ASCII String, one slice
// of 4,990 characters: 394 µs through the view, 8 µs here.
export function slice(
	originalString: StringType,
	from: IntegerType,
	to: IntegerType,
): StringType {
	let ascii = isAsciiIn(originalString)
	let characters = ascii ? null : graphemesIn(originalString)
	let characterCount = ascii
		? originalString.value.length
		: characters!.length
	let first = positionFromEnd(from.value, characterCount)
	let last = positionFromEnd(to.value, characterCount)
	let start = first < 0 ? 0 : first > characterCount ? characterCount : first
	let end = last < 0 ? 0 : last > characterCount ? characterCount : last

	if (ascii) {
		return createAsciiString(
			end <= start ? "" : originalString.value.slice(start, end),
		)
	}

	if (end <= start) {
		return createSegmentedString([])
	}

	return createSegmentedString(characters!.slice(start, end))
}

// NOTE: Native — the String joined to itself, where the Essence body built a
// List of `count` copies of it and joined them. A count below one repeats into
// nothing, which is the empty String.
//
// NOTE: The ASCII marker rides along, and only then: joining ASCII copies of an
// ASCII String gives an ASCII String, for the reason `append` gives — no unit
// at or above 128 and no carriage return, so nothing can pair across a seam and
// the characters are the units. Everything else is a plain String, because a
// copy's last cluster and the next copy's first may join.
export function repeat(
	originalString: StringType,
	count: IntegerType,
): StringType {
	// NOTE: `1` rather than `1n`, for the reason `List.split` gives.
	if (count.value < 1) {
		return createString("")
	}

	let repeated = originalString.value.repeat(Number(count.value))

	return isAsciiIn(originalString)
		? createAsciiString(repeated)
		: createString(repeated)
}

// NOTE: The ASCII marker rides through both case mappings, and so does the
// count: every ASCII letter maps to one ASCII letter, so a String the scan
// accepted maps to one it would accept, of the same length. Anything else is
// a plain String — `ß` upper-cases to two characters, so neither the mark nor
// the count survives a mapping outside ASCII. A loop that upper-cases and
// then measures rescans every answer otherwise: a Program making 20,000
// `uppercase()::length()` of a 10,800-character String measured 193 ms
// without the marker and 41 ms with it, 12 ms of each being its startup.
export function uppercase(originalString: StringType): StringType {
	let mapped = originalString.value.toUpperCase()

	return isAsciiIn(originalString)
		? createAsciiString(mapped)
		: createString(mapped)
}

export function lowercase(originalString: StringType): StringType {
	let mapped = originalString.value.toLowerCase()

	return isAsciiIn(originalString)
		? createAsciiString(mapped)
		: createString(mapped)
}

// NOTE: One native, and the `as:` Parameter is DEFAULTED in `String.es` to
// `#ComposedCanonical` — so `normalize()` with no Argument reaches this same
// export through the frame the Compiler synthesizes for the default, and this
// module never learns that a default exists. The four Cases are the four
// Unicode normalization forms, so the map to the JavaScript
// `String.prototype.normalize` argument is direct.
export function normalize(
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
//
// NOTE: Read off the NFC form, as every position Method is, so that the words
// of a String and the pieces of its `split` are the same text in the same
// bytes. A word of an ASCII receiver is a run of its units, so each is marked
// ASCII as a piece of a `split` is.
export function words(originalString: StringType): ListType<StringType> {
	let matches = normalisedFormOf(originalString).match(/\S+/gu)
	let ascii = isAsciiIn(originalString)

	return createList(
		(matches ?? []).map((word) =>
			ascii ? createAsciiString(word) : createString(word),
		),
	)
}

// NOTE: The one native behind the whole trim family, where there used to be
// two — it reads the `Side` Case and calls the matching JavaScript intrinsic.
// `String::trim()` with no Argument reaches it through the frame the Compiler
// synthesizes for the `at:` Parameter's default, which is `#BothEnds`; nothing
// here has to know that. Whitespace is whatever JavaScript calls whitespace,
// which is the Unicode definition.
//
// NOTE: Read off the RAW text, and neither of the two answers a String
// remembers is FORCED to trim it — because both are answers about the WHOLE
// String, and taking whitespace off the two ends should not cost a walk of
// everything between them. Asking `normalisedFormOf` scanned for the ASCII
// mark and, failing it, normalised and copied the whole String first: 200
// trims of a FRESH 100,004-character ASCII String measured 68.9 µs per call
// that way against 0.016 µs here, best of fifteen, and the cost grew by ten
// for every ten times the length where this one does not move.
//
// NOTE: What makes the raw text the same answer is that trimming COMMUTES
// with normalising. No canonical decomposition or composition creates or
// destroys a whitespace character — the space that a `<compat>` or `<noBreak>`
// mapping would produce is not one NFC performs, and a space composes with
// nothing that follows it — so the whitespace at either end is the same
// whitespace in both forms, and NFC of the trimmed text is the trim of the
// NFC form. So the answer's own lazy normal form, and with it every
// comparison, every position Method and every Dictionary key it becomes, is
// what it was.
//
// NOTE: The ASCII mark is PROPAGATED where the receiver already carries one
// and never taken by scanning for it: taking units off either end of such a
// String leaves such a String, so a Program that trims what it built keeps the
// mark all the way down — 20,000 `trim()::length()` of one 11,000-character
// String built by `repeat` measured 0.4 ms in process, where the answer being
// unmarked costs a scan of it per turn. A receiver nothing has measured
// answers an unmarked String, which is the state it was in itself, and the
// first Method that needs the mark takes it once.
export function trim(originalString: StringType, side: SideType): StringType {
	let text = originalString.value
	let trimmed: string

	switch (side[typeKeySymbol]) {
		case "Side#Start":
			trimmed = text.trimStart()
			break
		case "Side#End":
			trimmed = text.trimEnd()
			break
		default:
			trimmed = text.trim()
	}

	return (originalString as MeasuredString)[isAsciiKey] === true
		? createAsciiString(trimmed)
		: createString(trimmed)
}

export function compare__overload$1(
	originalString: StringType,
	otherString: StringType,
): OrderingType {
	// NOTE: Identical text is identical text, whatever it holds — normalisation
	// is a function of the String, so two Strings spelling the same units have
	// the same normal form and nothing after this could answer anything but
	// `Equal`. It is asked first because it is the case a sort spends most of
	// its comparisons on the far side of: `a::is(b)` routes to `stringEquals`,
	// but `sort` and `isLessThan` come through here.
	if (originalString.value === otherString.value) {
		return equal
	}

	// NOTE: Lexicographic by code point, over the NFC-normalised String — so a
	// canonically equivalent pair (an accent composed or decomposed) compares
	// `Equal`, and the order agrees with the grapheme view the character
	// Methods take rather than JS's UTF-16 `<`. This is also the whole of
	// String equality: `String.is` is `compare(other)::is(Ordering#Equal)` in
	// Essence, so equality is canonical equivalence too.
	//
	// NOTE: Walked in place rather than through two Arrays of one-character
	// Strings. `codePointAt` reads the whole code point at a position and a
	// point above the Basic Multilingual Plane occupies two units, so stepping
	// by that width visits exactly the elements `Array.from` used to build —
	// and a lone surrogate, which is no whole point, is read and stepped over
	// as the single unit it is, exactly as the iterator yielded it.
	let first = normalisedFormOf(originalString)
	let second = normalisedFormOf(otherString)
	let firstIndex = 0
	let secondIndex = 0

	while (firstIndex < first.length && secondIndex < second.length) {
		let firstPoint = first.codePointAt(firstIndex) as number
		let secondPoint = second.codePointAt(secondIndex) as number

		if (firstPoint < secondPoint) {
			return less
		} else if (firstPoint > secondPoint) {
			return greater
		}

		firstIndex += firstPoint > 0xffff ? 2 : 1
		secondIndex += secondPoint > 0xffff ? 2 : 1
	}

	// NOTE: On an equal prefix the shorter String comes first, counted in code
	// POINTS — which is what is left over here: every step above advanced both
	// sides by one point, so whichever still has units has more points.
	if (firstIndex < first.length) {
		return greater
	} else if (secondIndex < second.length) {
		return less
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
	return createInteger(graphemeCountIn(originalString))
}
