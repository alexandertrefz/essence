import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { CaseSensitivityType } from "./CaseSensitivity"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { ListType } from "./List"
import { createList, runsOf } from "./List"
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

// A code point as a String Literal spells it, in upper case.
function codePointEscape(code: number): string {
	return `\\u{${code.toString(16).toUpperCase()}}`
}

// The escape set: one mark per code unit of the Basic Multilingual Plane,
// built on first use so the module has no top-level side effect. See "Quoting a
// String" in DEVELOPMENT.md.
const arabicLetterMark = 0x061c
const byteOrderMark = 0xfeff
const firstSurrogate = 0xd800
const highSurrogateEnd = 0xdbff
const lastSurrogate = 0xdfff
const replacementCharacter = 0xfffd

let escapeMarks: Uint8Array | null = null

function markedEscapes(): Uint8Array {
	if (escapeMarks === null) {
		let marks = new Uint8Array(0x10000)

		// The C0 controls, the quote, the backslash, the braces, DEL and the C1
		// controls. Then the invisible characters that change how text reads, the
		// surrogates and the byte order mark. The joiners stay unmarked.
		for (let [first, last] of [
			[0x00, 0x1f],
			[0x22, 0x22],
			[0x5c, 0x5c],
			[0x7b, 0x7b],
			[0x7d, 0x7d],
			[0x7f, 0x9f],
			[arabicLetterMark, arabicLetterMark],
			[0x200e, 0x200f],
			[0x2028, 0x202e],
			[0x2066, 0x2069],
			[firstSurrogate, lastSurrogate],
			[byteOrderMark, byteOrderMark],
		] as Array<[number, number]>) {
			for (let code = first; code <= last; code++) {
				marks[code] = 1
			}
		}

		escapeMarks = marks
	}

	return escapeMarks
}

// How a marked code unit is written, or `null` for half of a whole surrogate
// pair. Braces are escaped, since a bare `{` opens a hole when read back.
function escapeOf(value: string, index: number, code: number): string | null {
	switch (code) {
		case 0x5c:
			return "\\\\"
		case 0x22:
			return '\\"'
		case 0x0a:
			return "\\n"
		case 0x0d:
			return "\\r"
		case 0x09:
			return "\\t"
		case 0x7b:
			return "\\{"
		case 0x7d:
			return "\\}"
	}

	return code >= firstSurrogate && code <= lastSurrogate
		? surrogateEscapeAt(value, index, code)
		: codePointEscape(code)
}

// A lone surrogate, which only a JavaScript host can hand over, is written as
// the replacement character it encodes to. A whole pair passes.
function surrogateEscapeAt(
	value: string,
	index: number,
	code: number,
): string | null {
	if (code <= highSurrogateEnd) {
		let behind = value.charCodeAt(index + 1)

		return behind > highSurrogateEnd && behind <= lastSurrogate
			? null
			: codePointEscape(replacementCharacter)
	}

	let front = index > 0 ? value.charCodeAt(index - 1) : 0

	return front >= firstSurrogate && front <= highSurrogateEnd
		? null
		: codePointEscape(replacementCharacter)
}

// The String as a Literal that reads back to the same value. The scan reads
// one table mark per code unit. See "Quoting a String" in DEVELOPMENT.md.
export function quotedText(value: string): string {
	let marked = markedEscapes()
	let quoted = ""
	let runStart = -1

	for (let index = 0; index < value.length; index++) {
		let code = value.charCodeAt(index)

		if (marked[code] === 0) {
			continue
		}

		let escape = escapeOf(value, index, code)

		if (escape === null) {
			continue
		}

		quoted += value.slice(runStart < 0 ? 0 : runStart, index) + escape
		runStart = index + 1
	}

	return runStart < 0 ? `"${value}"` : `"${quoted}${value.slice(runStart)}"`
}

// A value inside a structure: a String is quoted there, and anything else
// renders through its witness. The tag is read, since `String.toString` is the
// identity.
export function itemText<ItemType extends AnyType>(
	value: ItemType,
	conformance: {
		toString: (value: ItemType) => StringType
	},
): string {
	return value[typeKeySymbol] === "String"
		? quotedText((value as StringType).value)
		: conformance.toString(value).value
}

// The Segmenter behind every character view, built on first use. See
// "String characters" in DEVELOPMENT.md.
let graphemeSegmenter: Intl.Segmenter | null = null

function segmenter(): Intl.Segmenter {
	if (graphemeSegmenter === null) {
		graphemeSegmenter = new Intl.Segmenter(undefined, {
			granularity: "grapheme",
		})
	}

	return graphemeSegmenter
}

// Segments text that is already normalised.
function clustersOf(text: string): Array<string> {
	let result: Array<string> = []

	for (let { segment } of segmenter().segment(text)) {
		result.push(segment)
	}

	return result
}

// What a String remembers about itself, under Symbol keys that no equality or
// printer sees. See "String characters" in DEVELOPMENT.md.
const graphemesKey = Symbol("$graphemes")
const viewStartKey = Symbol("$viewStart")
const viewTextKey = Symbol("$viewText")
const viewOffsetsKey = Symbol("$viewOffsets")
const graphemeCountKey = Symbol("$graphemeCount")
const isAsciiKey = Symbol("$isAscii")
const normalisedKey = Symbol("$normalised")

// A window shares its parent's clusters. The window keys are absent on a String
// that is its whole Array. See "String windows" in DEVELOPMENT.md.
type MeasuredString = StringType & {
	[graphemesKey]?: Array<string>
	[viewStartKey]?: number
	[viewTextKey]?: string
	[viewOffsetsKey]?: Int32Array
	[graphemeCountKey]?: number
	[isAsciiKey]?: boolean
	[normalisedKey]?: string
}

// The Array this String's characters live in, built at most once. An ASCII
// String splits into code units rather than being segmented.
function clustersIn(string: StringType): Array<string> {
	let measured = string as MeasuredString
	let clusters = measured[graphemesKey]

	if (clusters === undefined) {
		let unitPerCharacter = isAsciiIn(string)
		let text = normalisedFormOf(string)

		clusters = unitPerCharacter ? text.split("") : clustersOf(text)
		measured[graphemesKey] = clusters
		measured[graphemeCountKey] = clusters.length

		// Only a non-NFC String has clusters of a text it does not spell.
		if (!unitPerCharacter && text !== string.value) {
			measured[viewTextKey] = text
		}
	}

	return clusters
}

// Where this String's first character stands in its Array.
function startIn(string: StringType): number {
	return (string as MeasuredString)[viewStartKey] ?? 0
}

// The text this String's clusters partition. That is its own text, unless
// it was written in a form that is not NFC or is a window of one.
function clusterTextOf(string: StringType): string {
	return (string as MeasuredString)[viewTextKey] ?? string.value
}

// The String's clusters as an Array of its own, for the readers that walk all
// of it. Callers only read it. A window copies its clusters out here, once.
function graphemesIn(string: StringType): Array<string> {
	let measured = string as MeasuredString
	let clusters = clustersIn(measured)
	let start = measured[viewStartKey] ?? 0
	let count = measured[graphemeCountKey]!

	if (start === 0 && count === clusters.length) {
		return clusters
	}

	let own = clusters.slice(start, start + count)

	// The window's text is these clusters joined, so it gives up what it
	// borrowed.
	measured[graphemesKey] = own
	measured[viewStartKey] = 0
	measured[viewTextKey] = undefined
	measured[viewOffsetsKey] = undefined

	return own
}

// A String's characters where they stand: the Array, where its own begin and
// how many. Searches read a window through this rather than copying it.
export type CharacterWindow = {
	clusters: Array<string>
	start: number
	count: number
}

export function viewOf(string: StringType): CharacterWindow {
	let clusters = clustersIn(string)
	let measured = string as MeasuredString

	return {
		clusters,
		start: measured[viewStartKey] ?? 0,
		count: measured[graphemeCountKey]!,
	}
}

// Whether the String's character view has been built. For specs only, so no
// bundle carries it.
export function hasCharacterView(string: StringType): boolean {
	return (string as MeasuredString)[graphemesKey] !== undefined
}

// A String that keeps the clusters it was assembled from, since segmenting
// the join may pair them differently. The caller must not change the Array.
function createSegmentedString(characters: Array<string>): StringType {
	let string = createString(characters.join("")) as MeasuredString

	string[graphemesKey] = characters
	string[graphemeCountKey] = characters.length

	return string
}

// Where each cluster begins in the text, in code units, built on the first cut
// and shared by every window of the Array.
function offsetsIn(string: StringType, clusters: Array<string>): Int32Array {
	let measured = string as MeasuredString
	let offsets = measured[viewOffsetsKey]

	if (offsets === undefined) {
		let text = clusterTextOf(string)
		let offset = 0

		offsets = new Int32Array(clusters.length + 1)

		for (let index = 0; index < clusters.length; index++) {
			offset += clusters[index]!.length
			offsets[index + 1] = offset
		}

		// The table covers the whole Array, so the String names its text too.
		measured[viewOffsetsKey] = offsets
		measured[viewTextKey] = text
	}

	return offsets
}

// A window: the same clusters from an offset, its text cut with one `slice`.
// That text is exactly the clusters joined, since they partition it.
function createWindowString(
	original: StringType,
	clusters: Array<string>,
	start: number,
	count: number,
	offsets: Int32Array,
): StringType {
	let text = clusterTextOf(original)
	let string = createString(
		text.slice(offsets[start]!, offsets[start + count]!),
	) as MeasuredString

	string[graphemesKey] = clusters
	string[viewStartKey] = start
	string[graphemeCountKey] = count
	string[viewOffsetsKey] = offsets
	string[viewTextKey] = text

	return string
}

// Shares the parent's Array where the cut holds at least half of its
// characters and half of its code units, and copies otherwise. See "String
// windows" in DEVELOPMENT.md.
function cutFromView(
	original: StringType,
	clusters: Array<string>,
	start: number,
	count: number,
): StringType {
	if (count * 2 >= clusters.length) {
		let offsets = offsetsIn(original, clusters)

		// The table's last entry is the whole text's length.
		if (
			(offsets[start + count]! - offsets[start]!) * 2 >=
			offsets[clusters.length]!
		) {
			return createWindowString(original, clusters, start, count, offsets)
		}
	}

	return createSegmentedString(clusters.slice(start, start + count))
}

// Whether every code unit is ASCII and none is a carriage return, so each
// unit is a character. CR LF is one cluster.
function isSingleUnitAscii(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		let code = value.charCodeAt(index)

		if (code >= 128 || code === 13) {
			return false
		}
	}

	return true
}

// `isSingleUnitAscii`, remembered on the String. See "The ASCII route" in
// DEVELOPMENT.md.
function isAsciiIn(string: StringType): boolean {
	let measured = string as MeasuredString
	let answer = measured[isAsciiKey]

	if (answer === undefined) {
		answer = isSingleUnitAscii(string.value)
		measured[isAsciiKey] = answer
	}

	return answer
}

// A String its maker knows is ASCII without a carriage return, marked without
// a scan. Each caller says why the claim holds.
function createAsciiString(value: string): StringType {
	let string = createString(value) as MeasuredString

	string[isAsciiKey] = true
	string[graphemeCountKey] = value.length

	return string
}

// The String's NFC form, remembered: what `is` and `compare` decide over. An
// ASCII String is its own form. A String with a view is never scanned here,
// and this does not call `readsByUnit`. See "The ASCII route" in DEVELOPMENT.md.
export function normalisedFormOf(string: StringType): string {
	let measured = string as MeasuredString
	let form = measured[normalisedKey]

	if (form === undefined) {
		form =
			measured[graphemesKey] === undefined && isAsciiIn(string)
				? string.value
				: string.value.normalize("NFC")
		measured[normalisedKey] = form
	}

	return form
}

// Whether the String takes the code-unit route. A String with a view is never
// scanned for the answer. See "The ASCII route" in DEVELOPMENT.md.
function readsByUnit(string: StringType): boolean {
	let measured = string as MeasuredString
	let answer = measured[isAsciiKey]

	if (answer !== undefined) {
		return answer
	}

	return measured[graphemesKey] === undefined && isAsciiIn(string)
}

// How many characters a String holds, counted at most once. A window was
// given its count when it was cut.
function graphemeCountIn(string: StringType): number {
	let measured = string as MeasuredString
	let characterCount = measured[graphemeCountKey]

	if (characterCount === undefined) {
		// A String with no count has no view, so `isAsciiIn` answers the same
		// as `readsByUnit` without pulling the cutting machinery into a bundle.
		characterCount = isAsciiIn(string)
			? string.value.length
			: clustersIn(string).length

		measured[graphemeCountKey] = characterCount
	}

	return characterCount
}

// The join remembers neither operand's clusters, since clusters may join across
// the seam. Two ASCII Strings join into one, marked with the counts added.
export function append(
	originalString: StringType,
	otherString: StringType,
): StringType {
	let joined = originalString.value + otherString.value

	if (isAsciiIn(originalString) && isAsciiIn(otherString)) {
		return createAsciiString(joined)
	}

	// Otherwise one operand holds a unit the scan refuses, so the join is marked
	// not ASCII. Marking rather than scanning keeps the engine's rope unflattened.
	let string = createString(joined) as MeasuredString

	string[isAsciiKey] = false

	return string
}

// Whether the part's characters stand at `at` in `clusters`, with `remaining`
// of the receiver's own characters from there. A window is read in place. The
// caller folds both sides where the call is case-insensitive.
function partMatchesAt(
	clusters: Array<string>,
	at: number,
	remaining: number,
	part: Array<string>,
): boolean {
	if (part.length > remaining) {
		return false
	}

	for (let offset = 0; offset < part.length; offset++) {
		if (clusters[at + offset] !== part[offset]) {
			return false
		}
	}

	return true
}

// `width` of the receiver's characters from `at`, folded, and no more.
function foldedRun(
	clusters: Array<string>,
	at: number,
	width: number,
): Array<string> {
	let run: Array<string> = []

	for (let offset = 0; offset < width; offset++) {
		run.push(clusters[at + offset]!.toLowerCase())
	}

	return run
}

// The receiver's characters for a walk over all of them: its own Array, or a
// folded copy of its own window. See "Searching a String" in DEVELOPMENT.md.
function foldedWalk(
	clusters: Array<string>,
	start: number,
	count: number,
	insensitive: boolean,
): { characters: Array<string>; at: number } {
	return insensitive
		? { characters: foldedRun(clusters, start, count), at: 0 }
		: { characters: clusters, at: start }
}

// Both entries of `split`. The `NonEmptyList` the second promises holds since
// a non-empty separator always leaves the piece before it.
export function split__overload$1(
	originalString: StringType,
	splitterString: StringType,
): ListType<StringType> {
	// Splits on whole runs of characters, so a separator never tears a cluster.
	// Two ASCII Strings use the intrinsic, which gives the same pieces.
	if (isAsciiIn(originalString) && isAsciiIn(splitterString)) {
		// The empty separator reads the remembered view, which is the units.
		// Its one-character pieces go unmarked, since marking costs more than it
		// saves.
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
	let total = characters.length
	let pieces: Array<Array<string>> = []
	let current: Array<string> = []
	let index = 0

	while (index < total) {
		if (partMatchesAt(characters, index, total - index, separator)) {
			pieces.push(current)
			current = []
			index += separator.length
		} else {
			current.push(characters[index]!)
			index++
		}
	}

	pieces.push(current)

	// Each piece keeps its clusters, since segmenting its text may pair them
	// differently.
	return createList(pieces.map((piece) => createSegmentedString(piece)))
}

export const split__overload$2 = split__overload$1

// Searches fold each character on its own. See "Searching a String" in
// DEVELOPMENT.md.
function isInsensitive(sensitivity: CaseSensitivityType): boolean {
	return sensitivity[typeKeySymbol] === "CaseSensitivity#Insensitive"
}

// The ASCII route's text, folded where the call asks. Positions survive, since
// ASCII lower-cases unit for unit.
function foldedText(string: StringType, insensitive: boolean): string {
	return insensitive ? string.value.toLowerCase() : string.value
}

// The smallest chunk a folded first-match search reads, on the ASCII route and
// on the view route. See "Searching a String" in DEVELOPMENT.md.
const FOLD_CHUNK = 1024
const FOLD_RUN = 16

function foldedChunkWidth(partWidth: number, floor: number): number {
	return partWidth * 2 < floor ? floor : partWidth * 2
}

// The first position of the folded part, read in doubling chunks from the
// front. ASCII alone, whose folding maps unit to unit with no context.
function foldedFirstIndexOf(text: string, part: string): number {
	let total = text.length
	let width = foldedChunkWidth(part.length, FOLD_CHUNK)

	if (total <= width * 2) {
		return text.toLowerCase().indexOf(part)
	}

	let from = 0

	for (;;) {
		let to = total - from > width * 2 ? from + width : total
		let found = text.slice(from, to).toLowerCase().indexOf(part)

		if (found >= 0) {
			return from + found
		}

		if (to === total) {
			return -1
		}

		from = to - part.length + 1
		width *= 2
	}
}

// The last position, read in doubling chunks from the back. The next chunk
// ends `part.length - 1` units inside this one.
function foldedLastIndexOf(text: string, part: string): number {
	let width = foldedChunkWidth(part.length, FOLD_CHUNK)

	if (text.length <= width * 2) {
		return text.toLowerCase().lastIndexOf(part)
	}

	let to = text.length

	for (;;) {
		let from = to > width * 2 ? to - width : 0
		let found = text.slice(from, to).toLowerCase().lastIndexOf(part)

		if (found >= 0) {
			return from + found
		}

		if (from === 0) {
			return -1
		}

		to = from + part.length - 1
		width *= 2
	}
}

// The part's characters, folded per character into a copy where asked.
function foldedPart(string: StringType, insensitive: boolean): Array<string> {
	let characters = graphemesIn(string)

	return insensitive
		? characters.map((character) => character.toLowerCase())
		: characters
}

// Whether both sides take the intrinsic route. The receiver is asked through
// `readsByUnit`; the part is short and remembers its answer.
function bothAscii(originalString: StringType, part: StringType): boolean {
	return readsByUnit(originalString) && isAsciiIn(part)
}

function firstIndexIn(
	originalString: StringType,
	part: StringType,
	insensitive: boolean,
): number {
	if (bothAscii(originalString, part)) {
		return insensitive
			? foldedFirstIndexOf(originalString.value, part.value.toLowerCase())
			: originalString.value.indexOf(part.value)
	}

	let { clusters, start, count } = viewOf(originalString)
	let separator = foldedPart(part, insensitive)

	// Written apart, so the case-sensitive walk asks nothing about folding.
	if (!insensitive) {
		for (
			let position = 0;
			position + separator.length <= count;
			position++
		) {
			if (
				partMatchesAt(
					clusters,
					start + position,
					count - position,
					separator,
				)
			) {
				return position
			}
		}

		return -1
	}

	// Folded in doubling chunks, as `foldedFirstIndexOf` does. The next chunk
	// starts `separator.length - 1` characters back inside this one.
	let width = foldedChunkWidth(separator.length, FOLD_RUN)
	let from = 0

	for (;;) {
		let to = count - from > width * 2 ? from + width : count
		let folded = foldedRun(clusters, start + from, to - from)

		for (
			let position = from;
			position + separator.length <= to;
			position++
		) {
			if (
				partMatchesAt(folded, position - from, to - position, separator)
			) {
				return position
			}
		}

		if (to === count) {
			return -1
		}

		from = to - separator.length + 1
		width *= 2
	}
}

// The last occurrence, which may overlap an earlier one: `"aaa"` holds `"aa"`
// at 1.
function lastIndexIn(
	originalString: StringType,
	part: StringType,
	insensitive: boolean,
): number {
	if (bothAscii(originalString, part)) {
		return insensitive
			? foldedLastIndexOf(originalString.value, part.value.toLowerCase())
			: originalString.value.lastIndexOf(part.value)
	}

	let { clusters, start, count } = viewOf(originalString)
	let separator = foldedPart(part, insensitive)

	if (!insensitive) {
		for (
			let position = count - separator.length;
			position >= 0;
			position--
		) {
			if (
				partMatchesAt(
					clusters,
					start + position,
					count - position,
					separator,
				)
			) {
				return position
			}
		}

		return -1
	}

	// Folded in doubling chunks from the back, each folded afresh, since an
	// Array can not grow at its front for free. The next chunk ends
	// `separator.length - 1` characters inside this one.
	let width = foldedChunkWidth(separator.length, FOLD_RUN)
	let to = count

	for (;;) {
		let from = to > width * 2 ? to - width : 0
		let folded = foldedRun(clusters, start + from, to - from)

		for (
			let position = to - separator.length;
			position >= from;
			position--
		) {
			if (
				partMatchesAt(folded, position - from, to - position, separator)
			) {
				return position
			}
		}

		if (from === 0) {
			return -1
		}

		to = from + separator.length - 1
		width *= 2
	}
}

// The occurrences that do not overlap, as `split` cuts them, so
// `"aa"` occurs once in `"aaa"`. `count` and `everyIndex` both walk this.
function eachOccurrence(
	originalString: StringType,
	part: StringType,
	insensitive: boolean,
	visit: (position: number) => void,
): void {
	if (bothAscii(originalString, part)) {
		let text = foldedText(originalString, insensitive)
		let needle = foldedText(part, insensitive)
		let index = text.indexOf(needle)

		while (index >= 0) {
			visit(index)
			index = text.indexOf(needle, index + needle.length)
		}

		return
	}

	let { clusters, start, count } = viewOf(originalString)
	let separator = foldedPart(part, insensitive)
	let walk = foldedWalk(clusters, start, count, insensitive)
	let index = 0

	while (index + separator.length <= count) {
		if (
			partMatchesAt(
				walk.characters,
				walk.at + index,
				count - index,
				separator,
			)
		) {
			visit(index)
			index += separator.length
		} else {
			index++
		}
	}
}

function everyIndexIn(
	originalString: StringType,
	part: StringType,
	insensitive: boolean,
): Array<number> {
	let positions: Array<number> = []

	eachOccurrence(originalString, part, insensitive, (position) => {
		positions.push(position)
	})

	return positions
}

function countIn(
	originalString: StringType,
	part: StringType,
	insensitive: boolean,
): number {
	let occurrences = 0

	eachOccurrence(originalString, part, insensitive, () => {
		occurrences++
	})

	return occurrences
}

function startsIn(
	originalString: StringType,
	prefix: StringType,
	insensitive: boolean,
): boolean {
	if (bothAscii(originalString, prefix)) {
		let text = originalString.value
		let needle = foldedText(prefix, insensitive)

		// Only the first `needle.length` units are folded, so a prefix test costs
		// the prefix. ASCII lower-cases unit for unit.
		return insensitive
			? needle.length <= text.length &&
					text.slice(0, needle.length).toLowerCase() === needle
			: text.startsWith(needle)
	}

	// Read directly rather than through `viewOf`, which allocates per call.
	let clusters = clustersIn(originalString)
	let start = startIn(originalString)
	let count = graphemeCountIn(originalString)
	let prefixCharacters = foldedPart(prefix, insensitive)

	if (prefixCharacters.length > count) {
		return false
	}

	// Only as many characters as the prefix are folded.
	return partMatchesAt(
		insensitive
			? foldedRun(clusters, start, prefixCharacters.length)
			: clusters,
		insensitive ? 0 : start,
		count,
		prefixCharacters,
	)
}

function endsIn(
	originalString: StringType,
	suffix: StringType,
	insensitive: boolean,
): boolean {
	if (bothAscii(originalString, suffix)) {
		let text = originalString.value
		let needle = foldedText(suffix, insensitive)

		// Only the last `needle.length` units are folded.
		return insensitive
			? needle.length <= text.length &&
					text.slice(text.length - needle.length).toLowerCase() ===
						needle
			: text.endsWith(needle)
	}

	// Read directly rather than through `viewOf`, which allocates per call.
	let clusters = clustersIn(originalString)
	let start = startIn(originalString)
	let count = graphemeCountIn(originalString)
	let suffixCharacters = foldedPart(suffix, insensitive)

	if (suffixCharacters.length > count) {
		return false
	}

	let at = start + count - suffixCharacters.length

	// Only as many characters as the suffix are folded.
	return partMatchesAt(
		insensitive
			? foldedRun(clusters, at, suffixCharacters.length)
			: clusters,
		insensitive ? 0 : at,
		suffixCharacters.length,
		suffixCharacters,
	)
}

function positionAnswer(index: number): OptionalType<IntegerType> {
	return index < 0 ? createEmpty() : createValue(createInteger(index))
}

// The second entry, taking `defaultingTo:`, is written in Essence on this one.
export function firstIndex__overload$1(
	originalString: StringType,
	part: StringType,
): OptionalType<IntegerType> {
	if (part.value === "") {
		return createValue(createInteger(0))
	}

	return positionAnswer(firstIndexIn(originalString, part, false))
}

export function firstIndex__overload$3(
	originalString: StringType,
	part: StringType,
	sensitivity: CaseSensitivityType,
): OptionalType<IntegerType> {
	if (part.value === "") {
		return createValue(createInteger(0))
	}

	return positionAnswer(
		firstIndexIn(originalString, part, isInsensitive(sensitivity)),
	)
}

export function lastIndex__overload$1(
	originalString: StringType,
	part: StringType,
): OptionalType<IntegerType> {
	if (part.value === "") {
		return createValue(createInteger(graphemeCountIn(originalString)))
	}

	return positionAnswer(lastIndexIn(originalString, part, false))
}

export function lastIndex__overload$3(
	originalString: StringType,
	part: StringType,
	sensitivity: CaseSensitivityType,
): OptionalType<IntegerType> {
	if (part.value === "") {
		return createValue(createInteger(graphemeCountIn(originalString)))
	}

	return positionAnswer(
		lastIndexIn(originalString, part, isInsensitive(sensitivity)),
	)
}

// Every position in one pass, where a hand-written walk would cut the rest of
// the String per occurrence.
export function everyIndex(
	originalString: StringType,
	part: StringType,
): ListType<IntegerType> {
	if (part.value === "") {
		return createList([])
	}

	return createList(
		everyIndexIn(originalString, part, false).map((position) =>
			createInteger(position),
		),
	)
}

export function count__overload$1(
	originalString: StringType,
	part: StringType,
): IntegerType {
	if (part.value === "") {
		return createInteger(0)
	}

	return createInteger(countIn(originalString, part, false))
}

export function count__overload$2(
	originalString: StringType,
	part: StringType,
	sensitivity: CaseSensitivityType,
): IntegerType {
	if (part.value === "") {
		return createInteger(0)
	}

	return createInteger(
		countIn(originalString, part, isInsensitive(sensitivity)),
	)
}

// The reversal keeps the original's clusters in the opposite order. Segmenting
// it afresh could pair regional indicators differently, so reversing twice
// answers the original.
export function reverse(originalString: StringType): StringType {
	return createSegmentedString([...graphemesIn(originalString)].reverse())
}

// The folded `starts(with:)`. The plain entry is Essence, but a folded prefix
// has to be compared character by character.
export function starts__overload$2(
	originalString: StringType,
	prefix: StringType,
	sensitivity: CaseSensitivityType,
): BooleanType {
	return createBoolean(
		startsIn(originalString, prefix, isInsensitive(sensitivity)),
	)
}

// One pass over the character view, matching on a cluster boundary and by
// canonical equivalence, as `starts(with:)` does.
export function ends__overload$1(
	originalString: StringType,
	suffix: StringType,
): BooleanType {
	return createBoolean(endsIn(originalString, suffix, false))
}

export function ends__overload$2(
	originalString: StringType,
	suffix: StringType,
	sensitivity: CaseSensitivityType,
): BooleanType {
	return createBoolean(
		endsIn(originalString, suffix, isInsensitive(sensitivity)),
	)
}

// A negative position counts back from the end, as `List.positionFromEnd` does.
// Spelled here so a Program slicing Strings carries no List.
function positionFromEnd(index: number | bigint, count: number): number {
	// A bigint index is past either end of any String.
	if (typeof index !== "number") {
		return index < 0n ? -1 : count
	}

	return index < 0 ? index + count : index
}

// One read of the character view, answered as a plain String: a single
// cluster segments to itself. The `defaultingTo:` entry is written in Essence.
export function character__overload$1(
	originalString: StringType,
	index: IntegerType,
): OptionalType<StringType> {
	let character = characterIn(originalString, index.value)

	return character === undefined ? createEmpty() : createValue(character)
}

// The character at a position, or `undefined` past either end. It reads the
// cluster where it stands rather than copying a window. Exported for
// `NonEmptyString.ts`.
export function characterIn(
	string: StringType,
	index: number | bigint,
): StringType | undefined {
	// The `readsByUnit` question, spelled out so each key is read at most once.
	// A number position is resolved inline, since this runs per character.
	let measured = string as MeasuredString
	let marked = measured[isAsciiKey]

	if (
		marked === true ||
		(marked === undefined &&
			measured[graphemesKey] === undefined &&
			isAsciiIn(string))
	) {
		// The bound is compared rather than read off a missing unit, which keeps
		// the engine's fast path. The view arm must compare it, since a window
		// borrows an Array that holds characters past its own end.
		let text = string.value
		let units = text.length
		let position =
			typeof index === "number"
				? index < 0
					? index + units
					: index
				: positionFromEnd(index, units)

		if (position < 0 || position >= units) {
			return undefined
		}

		return createAsciiString(text[position]!)
	}

	// Every writer of the Array writes the count, so the `!` holds.
	let clusters = measured[graphemesKey] ?? clustersIn(string)
	let count = measured[graphemeCountKey]!
	let position =
		typeof index === "number"
			? index < 0
				? index + count
				: index
			: positionFromEnd(index, count)

	if (position < 0 || position >= count) {
		return undefined
	}

	return createString(clusters[(measured[viewStartKey] ?? 0) + position]!)
}

// The characters in [from, to): a negative position counts back from the end,
// then each end is clamped, as in `List.slice`. An ASCII String is cut by the
// intrinsic and stays marked.
export function slice(
	originalString: StringType,
	from: IntegerType,
	to: IntegerType,
): StringType {
	if (readsByUnit(originalString)) {
		let text = originalString.value
		let count = text.length
		let first = positionFromEnd(from.value, count)
		let last = positionFromEnd(to.value, count)
		let start = first < 0 ? 0 : first > count ? count : first
		let end = last < 0 ? 0 : last > count ? count : last

		return createAsciiString(end <= start ? "" : text.slice(start, end))
	}

	return cutThroughView(originalString, from, to)
}

// The view route of `slice`, kept apart so the ASCII route stays small enough
// to inline.
function cutThroughView(
	originalString: StringType,
	from: IntegerType,
	to: IntegerType,
): StringType {
	let clusters = clustersIn(originalString)
	let count = (originalString as MeasuredString)[graphemeCountKey]!
	let first = positionFromEnd(from.value, count)
	let last = positionFromEnd(to.value, count)
	let start = first < 0 ? 0 : first > count ? count : first
	let end = last < 0 ? 0 : last > count ? count : last

	if (end <= start) {
		return createSegmentedString([])
	}

	return cutFromView(
		originalString,
		clusters,
		startIn(originalString) + start,
		end - start,
	)
}

// The String joined to itself `count` times, or the empty String below one.
// Only ASCII copies keep the mark, since clusters may join across a seam.
export function repeat(
	originalString: StringType,
	count: IntegerType,
): StringType {
	// `1` rather than `1n`: an Integer in safe range holds a number.
	if (count.value < 1) {
		return createString("")
	}

	let repeated = originalString.value.repeat(Number(count.value))

	return isAsciiIn(originalString)
		? createAsciiString(repeated)
		: createString(repeated)
}

// An ASCII String maps to one of the same length, so the mark and the count
// carry over. Outside ASCII `ß` upper-cases to two characters.
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

// The `as:` default, `#ComposedCanonical`, is filled in by the Compiler. The
// four Cases map directly to the four normalization forms.
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

// The runs of non-whitespace in the NFC form, by Unicode `\s`. A String of
// only whitespace has none.
export function words(originalString: StringType): ListType<StringType> {
	let matches = normalisedFormOf(originalString).match(/\S+/gu)
	let ascii = isAsciiIn(originalString)

	return createList(
		(matches ?? []).map((word) =>
			ascii ? createAsciiString(word) : createString(word),
		),
	)
}

// Trims the raw text by the `Side` Case, so the ends cost no walk of the
// middle. Normalising never creates or removes whitespace, so this agrees with
// trimming the NFC form. An existing ASCII mark carries over; none is scanned.
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
	// The same units have the same normal form. `sort` and `isLessThan` come
	// here, while the Compiler sends `is` to `stringEquals`.
	if (originalString.value === otherString.value) {
		return equal
	}

	// By code point over the NFC form, so canonically equivalent Strings are
	// equal. Steps over a whole code point; a lone surrogate is one unit.
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

	// On an equal prefix the String with fewer code points comes first.
	if (firstIndex < first.length) {
		return greater
	} else if (secondIndex < second.length) {
		return less
	} else {
		return equal
	}
}

// Native, so counting needs no List of every character.
export function length(originalString: StringType): IntegerType {
	return createInteger(graphemeCountIn(originalString))
}

// `split("")`, native so that it can answer a `List<Character>`. The separator
// is built per call, since a module-level String would stay in every bundle.
export function characters(originalString: StringType): ListType<StringType> {
	return split__overload$1(originalString, createString(""))
}

// The code points of the NFC form. A cluster may hold several, so the count
// can differ from `length`. A lone surrogate is read as one unit.
export function codePoints(originalString: StringType): ListType<IntegerType> {
	let text = normalisedFormOf(originalString)
	let points: Array<IntegerType> = []
	let index = 0

	while (index < text.length) {
		let point = text.codePointAt(index) as number

		points.push(createInteger(point))
		index += point > 0xffff ? 2 : 1
	}

	return createList(points)
}

// A scalar value: below 0x110000 and outside the surrogate range.
function isScalarValue(point: number | bigint): boolean {
	if (typeof point !== "number") {
		return false
	}

	return (
		Number.isSafeInteger(point) &&
		point >= 0 &&
		point <= 0x10ffff &&
		(point < 0xd800 || point > 0xdfff)
	)
}

// Marked ASCII without a scan where every point is below 128 and not a
// carriage return.
function stringOfPoints(points: Array<number>): StringType {
	let text = String.fromCodePoint(...points)

	return points.every((point) => point < 128 && point !== 13)
		? createAsciiString(text)
		: createString(text)
}

// The proof rules out a negative point. A surrogate or a point past the last
// plane names no character.
export function of__overload$1(code: IntegerType): OptionalType<StringType> {
	if (!isScalarValue(code.value)) {
		return createEmpty()
	}

	return createValue(stringOfPoints([Number(code.value)]))
}

// All or nothing: one point that names no character answers empty.
export function of__overload$2(
	codes: ListType<IntegerType>,
): OptionalType<StringType> {
	let view = runsOf(codes)
	let points: Array<number> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		let code = view.front[index]!

		if (!isScalarValue(code.value)) {
			return createEmpty()
		}

		points.push(Number(code.value))
	}

	for (let index = 0; index < view.backCount; index++) {
		let code = view.back[index]!

		if (!isScalarValue(code.value)) {
			return createEmpty()
		}

		points.push(Number(code.value))
	}

	return createValue(stringOfPoints(points))
}

// Classification by the host's Unicode property escapes, over the NFC form.
// A combining mark counts with the letter before it, and with a digit only in
// `hasOnlyLettersOrDigits`. All four accept the empty String.
const digitsOnly = /^\p{Nd}*$/u
const lettersOnly = /^(?:\p{L}\p{M}*)*$/u
const lettersOrDigitsOnly = /^(?:[\p{L}\p{Nd}]\p{M}*)*$/u
const whitespaceOnly = /^\s*$/u

export function hasOnlyDigits(originalString: StringType): BooleanType {
	return createBoolean(digitsOnly.test(normalisedFormOf(originalString)))
}

export function hasOnlyLetters(originalString: StringType): BooleanType {
	return createBoolean(lettersOnly.test(normalisedFormOf(originalString)))
}

export function hasOnlyLettersOrDigits(
	originalString: StringType,
): BooleanType {
	return createBoolean(
		lettersOrDigitsOnly.test(normalisedFormOf(originalString)),
	)
}

export function hasOnlyWhitespace(originalString: StringType): BooleanType {
	return createBoolean(whitespaceOnly.test(normalisedFormOf(originalString)))
}

// Splits into at most `count` pieces; the last keeps the separators the walk
// stopped short of.
export function split__overload$5(
	originalString: StringType,
	splitterString: StringType,
	count: IntegerType,
): ListType<StringType> {
	let limit = Number(count.value)

	if (limit <= 1) {
		return createList([originalString])
	}

	if (bothAscii(originalString, splitterString)) {
		let text = originalString.value
		let separator = splitterString.value
		let pieces: Array<StringType> = []
		let index = 0

		while (pieces.length < limit - 1) {
			let found = text.indexOf(separator, index)

			if (found < 0) {
				break
			}

			pieces.push(createAsciiString(text.slice(index, found)))
			index = found + separator.length
		}

		pieces.push(createAsciiString(text.slice(index)))

		return createList(pieces)
	}

	let characters = graphemesIn(originalString)
	let separator = graphemesIn(splitterString)
	let total = characters.length
	let pieces: Array<Array<string>> = []
	let current: Array<string> = []
	let index = 0

	while (index < total) {
		if (
			pieces.length < limit - 1 &&
			partMatchesAt(characters, index, total - index, separator)
		) {
			pieces.push(current)
			current = []
			index += separator.length
		} else {
			current.push(characters[index]!)
			index++
		}
	}

	pieces.push(current)

	return createList(pieces.map((piece) => createSegmentedString(piece)))
}

// The folded replacements match on the folded characters and cut the original
// ones. Folding per character keeps both the same width.
export function replaceEvery__overload$2(
	originalString: StringType,
	part: StringType,
	replacement: StringType,
	sensitivity: CaseSensitivityType,
): StringType {
	if (part.value === "") {
		return originalString
	}

	let insensitive = isInsensitive(sensitivity)

	if (bothAscii(originalString, part)) {
		let text = originalString.value
		let folded = foldedText(originalString, insensitive)
		let needle = foldedText(part, insensitive)
		let pieces: Array<string> = []
		let index = 0
		let found = folded.indexOf(needle)

		while (found >= 0) {
			pieces.push(text.slice(index, found))
			index = found + needle.length
			found = folded.indexOf(needle, index)
		}

		pieces.push(text.slice(index))

		return createString(pieces.join(replacement.value))
	}

	let { clusters, start, count } = viewOf(originalString)
	let separator = foldedPart(part, insensitive)
	let walk = foldedWalk(clusters, start, count, insensitive)
	let pieces: Array<string> = []
	let current: Array<string> = []
	let index = 0

	while (index < count) {
		if (
			partMatchesAt(
				walk.characters,
				walk.at + index,
				count - index,
				separator,
			)
		) {
			pieces.push(current.join(""))
			current = []
			index += separator.length
		} else {
			current.push(clusters[start + index]!)
			index++
		}
	}

	pieces.push(current.join(""))

	return createString(pieces.join(replacement.value))
}

export function replaceFirst__overload$2(
	originalString: StringType,
	part: StringType,
	replacement: StringType,
	sensitivity: CaseSensitivityType,
): StringType {
	if (part.value === "") {
		return originalString
	}

	let insensitive = isInsensitive(sensitivity)
	let position = firstIndexIn(originalString, part, insensitive)

	if (position < 0) {
		return originalString
	}

	if (bothAscii(originalString, part)) {
		let text = originalString.value

		return createString(
			text.slice(0, position) +
				replacement.value +
				text.slice(position + part.value.length),
		)
	}

	let view = viewOf(originalString)
	let width = graphemesIn(part).length
	let start = view.start

	return createString(
		view.clusters.slice(start, start + position).join("") +
			replacement.value +
			view.clusters
				.slice(start + position + width, start + view.count)
				.join(""),
	)
}

// Groups the characters in `size`, with the separator between groups. `#End`
// and `#BothEnds` put the short group at the front, as in "1,234,567". The
// groups are always cut forward, and an ASCII String is cut by unit.
export function separate(
	originalString: StringType,
	size: IntegerType,
	separator: StringType,
	side: SideType,
): StringType {
	let width = Number(size.value)
	let characters = isAsciiIn(originalString)
		? null
		: graphemesIn(originalString)
	let count =
		characters === null ? originalString.value.length : characters.length

	if (count <= width) {
		return originalString
	}

	let text = originalString.value
	let groups: Array<string> = []
	let at = 0
	let end =
		side[typeKeySymbol] === "Side#Start" ? width : ((count - 1) % width) + 1

	while (at < count) {
		groups.push(
			characters === null
				? text.slice(at, end)
				: characters.slice(at, end).join(""),
		)

		at = end
		end = end + width < count ? end + width : count
	}

	return createString(groups.join(separator.value))
}

// `quotedText` for a Program, so a value reads the same in a sentence as in a
// structure.
export function quote(originalString: StringType): StringType {
	return createString(quotedText(originalString.value))
}
