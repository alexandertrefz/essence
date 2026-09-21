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
// beside its callers because it is the one answer to one question, and four
// readers ask it: `List.toString`, `Optional.toString`, the structural
// rendering `Terminal.inspect` and `Record.toString` share, and the `quote`
// native at the foot of this file, which hands the same text to a Program.
//
// NOTE: Named apart from that native because the two answer different Types.
// This one takes and answers the JavaScript text, so a reader inside the
// runtime puts it straight into a rendering it is already building.
export function quotedText(value: string): string {
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
		? quotedText((value as StringType).value)
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

// NOTE: Takes the text ALREADY normalised, where it used to normalise the
// String's own text here. `normalisedFormOf` remembers that form, and `is`,
// `compare` and every Dictionary key ask it of the same String — so segmenting
// what it answered is one normalisation between the two questions rather than
// one each.
function clustersOf(text: string): Array<string> {
	let result: Array<string> = []

	for (let { segment } of segmenter().segment(text)) {
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
const viewStartKey = Symbol("$viewStart")
const viewTextKey = Symbol("$viewText")
const viewOffsetsKey = Symbol("$viewOffsets")
const graphemeCountKey = Symbol("$graphemeCount")
const isAsciiKey = Symbol("$isAscii")
const normalisedKey = Symbol("$normalised")

// NOTE: A String's characters live in `graphemesKey`'s Array, and a WINDOW of a
// String shares that Array rather than copying it — `viewStartKey` says where
// its own characters begin in it and `graphemeCountKey` how many are its own.
// Both are ABSENT on a String that is the whole of its Array, so a `split`
// piece, a `reverse` and a copied window carry exactly the two keys they
// carried before there were windows at all.
//
// NOTE: That absence is the design. A record holding the four parts together
// reads far better, and costs an OBJECT PER STRING: a tokenizer holding 250,000
// six-character tokens cut out of a five-megabyte source measured 53.6 MB of
// retained heap that way against 42.1 MB — an AST keeps its tokens for the life
// of the Program, and eleven megabytes of record is what the reading would have
// cost it.
//
// NOTE: The other two keys are what a window needs to cut its TEXT, and they
// are shared references rather than answers of their own. `viewTextKey` is the
// text the clusters partition, carried only where it is not the String's own
// `value`: the clusters are of the NFC form — `is`, `compare` and every
// position Method are — so a String written in another form has its characters
// in a text it does not itself spell. `viewOffsetsKey` is where each cluster
// begins in that text.
//
// NOTE: There was a sixth key, `segmentedKey`, saying the Segmenter had RUN for
// this Array. Nothing in the runtime read it and only the drain guard did — and
// a flag written inside a reached Function can not be shaken out of a bundle,
// so it cost 94 bytes in the floor EVERY Program pays and 220 in one that cuts.
// The guard counts `Intl.Segmenter.prototype.segment` from the spec instead,
// which is the same claim for nothing at all.
type MeasuredString = StringType & {
	[graphemesKey]?: Array<string>
	[viewStartKey]?: number
	[viewTextKey]?: string
	[viewOffsetsKey]?: Int32Array
	[graphemeCountKey]?: number
	[isAsciiKey]?: boolean
	[normalisedKey]?: string
}

// NOTE: The Array this String's characters live in, built at most once. A
// String the ASCII scan accepted is split into its code units instead of being
// segmented, for the reason `isSingleUnitAscii` gives: each unit IS a cluster,
// and the text is its own NFC form. That is the same view the Segmenter
// answers, without the Segmenter. Measured on a 10,800-character ASCII String,
// best of three: 415 µs to segment against 14 µs to split.
function clustersIn(string: StringType): Array<string> {
	let measured = string as MeasuredString
	let clusters = measured[graphemesKey]

	if (clusters === undefined) {
		let unitPerCharacter = isAsciiIn(string)
		let text = normalisedFormOf(string)

		clusters = unitPerCharacter ? text.split("") : clustersOf(text)
		measured[graphemesKey] = clusters
		measured[graphemeCountKey] = clusters.length

		// NOTE: Carried only where the NFC form is not the text the String
		// spells, which is the only case where the two differ — and only off
		// the segmenting arm, because a String the scan accepted IS its own
		// normal form.
		if (!unitPerCharacter && text !== string.value) {
			measured[viewTextKey] = text
		}
	}

	return clusters
}

// NOTE: Where this String's first character stands in its Array — zero for
// everything but a window, which is why the key is absent there.
function startIn(string: StringType): number {
	return (string as MeasuredString)[viewStartKey] ?? 0
}

// NOTE: The text this String's clusters were cut from and PARTITION, so that
// cutting it between two of their offsets answers exactly the characters
// between them joined. It is the String's own text wherever the two agree,
// which is everything but a String written in a form that is not NFC and the
// windows cut from one.
function clusterTextOf(string: StringType): string {
	return (string as MeasuredString)[viewTextKey] ?? string.value
}

// NOTE: The segmented view of a String as a WHOLE Array, for the readers that
// walk all of it — `split`, `reverse`, `separate`. A String that IS the whole
// of its Array hands back the remembered one rather than a copy of it, so every
// caller here only ever READS it: one that needs to change it has to copy
// first.
//
// NOTE: A WINDOW is copied out of its parent's Array HERE, once, and keeps the
// copy as its own — which is both what these readers want (an Array they may
// index from zero and measure with `.length`) and what lets the parent's Array,
// text and offset table go once the window is all that is left of them. The
// readers a drain asks per turn — `length`, `character(at:)`, `slice`, the
// prefix and suffix tests and the searches — read the parent's Array through
// the offset instead and never come here, which is the whole of why a window
// exists.
function graphemesIn(string: StringType): Array<string> {
	let measured = string as MeasuredString
	let clusters = clustersIn(measured)
	let start = measured[viewStartKey] ?? 0
	let count = measured[graphemeCountKey]!

	if (start === 0 && count === clusters.length) {
		return clusters
	}

	let own = clusters.slice(start, start + count)

	// NOTE: The window's own `value` IS these clusters joined — that is what
	// cutting the parent's text between their offsets produced — so what it
	// borrowed is given up here rather than left to say something false about
	// the Array it now has.
	measured[graphemesKey] = own
	measured[viewStartKey] = 0
	measured[viewTextKey] = undefined
	measured[viewOffsetsKey] = undefined

	return own
}

// NOTE: THE ONE VIEW READER, for everything that reads a String's characters
// WHERE THEY STAND: the Array they live in, where this String's own begin in
// it, and how many are its own. A window is searched, tested and read through
// it rather than copied out first, which is what keeps a prefix test at the
// cost of the prefix and a front drain linear.
//
// NOTE: The readers a DRAIN asks per turn — `length`, `character(at:)`,
// `slice` and the prefix and suffix tests — read the three parts directly
// instead, because this allocates a record per call and they do nothing else
// big enough to hide it. A search is asked once per call and walks the receiver
// afterwards, so there the record is nothing beside the walk.
//
// NOTE: Exported for `NonEmptyString.ts`'s two proven ends — the same reason
// `List.ts` exports `viewOf` for `NonEmptyList.ts` — and for the specs that
// assert WORK: which Array a window shares, and how much of it is its own.
// `hasCharacterView` below answers the question this one can not, because this
// one BUILDS the view it reports; and how often the Segmenter RAN is counted
// where it is asked, by the spec, rather than remembered here for the spec's
// sake on every String every Program makes.
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

// NOTE: Whether this String has had its character view BUILT — the one
// question that tells the two paths of a position Method apart from outside.
// An ASCII receiver is searched, split and cut by the JavaScript intrinsics
// and leaves no view behind; every other receiver is segmented and remembers
// the segments. `stringPerformance.spec.ts` asks it, because a claim about
// WORK holds whatever else the machine is doing, where the wall-clock ceiling
// it replaced had to sit several times above the fast figure and below the
// slow one — and for `split` those two are only ten apart.
//
// NOTE: Nothing in the standard library calls it, so no Program's bundle
// carries it: an export nothing reaches is shaken out exactly as an unreached
// native is.
export function hasCharacterView(string: StringType): boolean {
	return (string as MeasuredString)[graphemesKey] !== undefined
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

// NOTE: Where each cluster begins in the text it partitions, counted in code
// units and cumulative, so that the text of ANY window of that Array is one
// engine `slice` between two of them. Built on the FIRST cut and never rebuilt:
// a drain that cuts a String twenty thousand times pays for it once, where the
// cut it replaces joined the remaining clusters every turn — 556 ms of the
// 20,000-character drain's 581, measured as the joins alone.
//
// NOTE: An `Int32Array` rather than an Array of numbers. It is one number per
// character of the String, it never grows, and no unit count can leave the
// range — four bytes an entry against the eight a boxed element costs, and not
// one element for the collector to walk.
//
// NOTE: Remembered on the String that was cut, and handed to every window cut
// from it, so that a window of a window is a read of the same table. Every
// String that shares an Array therefore reaches the table without reaching the
// String it was cut from.
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

		// NOTE: The table is of the WHOLE Array, so a String that is a window
		// of it must say which text it was built over — its own `value` is only
		// the part it names.
		measured[viewOffsetsKey] = offsets
		measured[viewTextKey] = text
	}

	return offsets
}

// NOTE: A WINDOW: the same clusters read from an offset, with its text cut out
// of the text they partition in ONE engine call. This is what makes consuming a
// String from the front linear. The cut it replaces copied n−1 cluster Strings
// into a fresh Array and joined them back into a fresh text, which is O(n) per
// turn and O(n²) over a drain — measured on the gap analysis's own Program at
// 40,000 characters, 2,245 ms that way.
//
// NOTE: The text is the SAME String the joined clusters spelled, byte for byte,
// and that is not an approximation: the clusters PARTITION that text, so the
// text between two of their offsets IS those clusters joined. Everything
// downstream — `is`, `compare`, `normalisedFormOf`, printing, the Dictionary
// key encoding — therefore answers what it answered before, because it is
// handed the same text it was handed before.
//
// NOTE: The offset table arrives rather than being looked up here, because the
// rule below had to read it to decide this cut at all.
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

// NOTE: THE HALF RULE, the same one `List.ts` applies to a shared suffix: a cut
// SHARES its parent's Array only where it is at least half of it, and is copied
// otherwise. What the rule bounds is RETENTION — a window holds the whole Array
// of clusters, the offset table and the whole text they were cut from alive,
// and a six-character token cut out of a five-megabyte source must not pin the
// source for as long as the token is held.
//
// NOTE: IT IS ASKED IN BOTH UNITS, and it has to be. A window pins three things
// and the character count bounds only two of them: the Array and the table hold
// one entry per CHARACTER, and the text holds one entry per CODE UNIT — and
// cluster widths are not uniform, so half the characters of a text can be a
// thousandth of its units. A text of 20,000 one-unit clusters followed by
// 20,000 clusters 301 units wide is 12 MB, and a window over its narrow half is
// exactly half the characters and 20,000 units: under the character rule alone
// each such window held 5.1 MB of resident memory against the 2.2 MB the copy
// it replaced held, and NOTHING CAPPED THE RATIO — it is the mean cluster width
// outside the window over the mean inside it, and a chat log of emoji beside
// ASCII has five to eleven for free. Both questions asked, the same shape holds
// 2.0 MB a window, which is what the copy holds. That is what makes the
// sentence "a window pins at most twice its own characters AND twice its own
// text" true.
//
// NOTE: The CHARACTER question is asked first, and that ordering is the cost
// argument. The unit question needs the offset table, which is O(n) to build on
// an Array nothing has cut yet — and a cut the character rule already refuses
// must not pay for a table to be refused twice. Where the character rule
// passes, the table is what the window being made needs anyway.
//
// NOTE: The rule costs nothing asymptotically, and the HALF is why: a drain
// from either end shares every step down to half, copies ONCE there, shares
// down to half of that, and so on — so the copies over a whole drain add up to
// 2n clusters against the n²/2 of copying at every step. A copy is exactly what
// a cut cost before this, so no cut that was cheap became dear. Two questions
// rather than one do not change that: each copy halves the characters or halves
// the units of what the next window can share, and neither can halve more than
// its own logarithm of times. Measured on a 20,000-character front drain over a
// text of 10,000 clusters 21 units wide followed by 10,000 of one unit: 17
// Arrays where the character rule alone held 14, and 81,000 clusters copied in
// all where it copied 40,000 — four times the characters rather than twice, for
// the same 32 ms of wall clock. Every text whose clusters are of a kind — the
// drains over accents, combining marks, CRLF, joined emoji and flags — copies
// exactly what it copied before, because there the two questions are one.
//
// NOTE: The copy JOINS its clusters rather than cutting the text, and that is
// the other half of the retention story: an engine's sliced String keeps the
// String it was cut from alive, so a small window cut that way would pin the
// whole source text even once its clusters were its own. The join costs what
// the Array copy beside it costs, and both are what the cut cost before.
//
// NOTE: A copied cut carries the two keys a `split` piece carries and NOT ONE
// MORE, which is what keeps a tokenizer's retained heap where it was: 250,000
// six-character tokens out of a five-megabyte source hold 42.1 MB, the figure
// they held before there were windows.
function cutFromView(
	original: StringType,
	clusters: Array<string>,
	start: number,
	count: number,
): StringType {
	if (count * 2 >= clusters.length) {
		let offsets = offsetsIn(original, clusters)

		// NOTE: The table's LAST entry is the whole text's length, because the
		// clusters partition it — so the two numbers the unit question needs
		// are both reads of the table the window would carry anyway.
		if (
			(offsets[start + count]! - offsets[start]!) * 2 >=
			offsets[clusters.length]!
		) {
			return createWindowString(original, clusters, start, count, offsets)
		}
	}

	return createSegmentedString(clusters.slice(start, start + count))
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
// NOTE: Asked through `readsByUnit` by every position Method — which is this
// question with a window's view taken into account — and asked outright of a
// PART, which is short and whose answer is remembered on it for every later
// call.
function isAsciiIn(string: StringType): boolean {
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
function createAsciiString(value: string): StringType {
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
//
// NOTE: A String THAT HAS A VIEW IS NEVER SCANNED HERE, which is the same
// addition `readsByUnit` makes and the reason is the same. This is the Function
// `is`, `compare`, every Dictionary key, `codePoints`, `words` and the four
// `hasOnly` predicates reach, so the scan it used to ask was the one a
// tokenizer comparing its `rest` with a keyword paid per turn — O(window) every
// turn, which is the same n² the copying was. What the window pays instead is
// the JavaScript call, and the engine answers that in constant time for a text
// it can see is already normalised: a front drain over 20,000 characters whose
// one non-ASCII character stands at the END measured 133 ms asking `is` per
// turn and measures 6 ms now. A text outside Latin-1 is normalised for real and
// stays O(window) a turn — 243 ms down to 103 — because there the answer has to
// be computed and the only way not to pay is not to ask.
//
// NOTE: A window that happens to be pure ASCII is normalised rather than
// waved through, and that costs it nothing measurable: its text is ASCII, so
// the engine's own check answers at once. It is the same trade `readsByUnit`
// states — a window declines a fast path it might have passed, and what it
// costs is the route it is already on.
//
// NOTE: The question is SPELLED OUT here, and narrower than `readsByUnit`'s by
// one arm: a String carrying a TRUE mark AND a view is normalised where
// `readsByUnit` would wave it through. That arm is reachable only by a window
// something scanned for another Method, its answer is the same either way, and
// what asking for it costs is the BUNDLE FLOOR. This Function is what a Program
// that merely prints a String reaches, and `readsByUnit` is what one that CUTS
// Strings reaches: calling it from here dragged the second into every bundle
// holding the first and `HelloWorld.es` grew 98 bytes for a branch it can never
// take. Asked this way the floor is 77 bytes BELOW where it was.
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

// NOTE: Whether this String takes the CODE-UNIT route — the JavaScript
// intrinsics — rather than the grapheme view. It is `isAsciiIn` with one thing
// added: a String that already HAS a view is never scanned for the answer.
//
// NOTE: That addition is half of what made a front drain quadratic. The scan is
// O(n), every turn of a drain is a NEW String, and `slice` and `character(at:)`
// asked it before anything else — so a drain scanned the rest of its String
// every turn, which is the same n² the copying was, from the other side. A
// window of a String the scan refused declines a fast path it might have passed;
// what that costs it is the view route, which is the route it is already on, and
// its parent's own answer is what it would have had to scan to find.
//
// NOTE: WHAT THAT TRADE COSTS, measured. The shape it costs anything at all is
// a String whose non-ASCII characters all stand at the FRONT: once a drain has
// consumed them the remainder is pure ASCII, and before this it was rescanned
// every turn and found its way back to the intrinsic from there. One `é`
// followed by pure ASCII, consumed a character at a time: 80,000 characters
// 33 ms against the intrinsic's 32, 320,000 characters 58 against 51 — linear
// either way, about 1.2x. Buying the intrinsic back means a scan per cut, which
// is the O(n²) the window exists to remove, so it is not bought back.
function readsByUnit(string: StringType): boolean {
	let measured = string as MeasuredString
	let answer = measured[isAsciiKey]

	if (answer !== undefined) {
		return answer
	}

	return measured[graphemesKey] === undefined && isAsciiIn(string)
}

// NOTE: How many characters a String holds, counted at most once. A String
// already segmented for some other Method is counted off that view rather than
// scanned again, and a WINDOW was handed its count when it was cut — which is
// what makes `length` on one O(1), and with it the `isEmpty` every drain asks
// per turn.
function graphemeCountIn(string: StringType): number {
	let measured = string as MeasuredString
	let characterCount = measured[graphemeCountKey]

	if (characterCount === undefined) {
		// NOTE: `isAsciiIn` rather than `readsByUnit`, and the two are the SAME
		// question here: a String that has a view was given its count when the
		// view was made, so a String with no count has no view either and there
		// is nothing for the window rule to take into account. Asking the
		// narrower question is also what keeps a Program that only MEASURES
		// Strings from carrying the cutting machinery — `HelloWorld.es` reaches
		// this and nothing else of the view, and its bundle is 29 bytes smaller
		// than it was before there were windows.
		characterCount = isAsciiIn(string)
			? string.value.length
			: clustersIn(string).length

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
	let joined = originalString.value + otherString.value

	// NOTE: Through the same maker every other Method that answers an ASCII
	// String uses, which gives the answer the joined text's own unit count —
	// for two such operands exactly the two counts added, each of them counted
	// by unit for the same reason. It was written out by hand here for 124
	// bytes, back when the Module bundle ceiling had five bytes of room; the
	// ceiling has the room its own rule asks for now, and a test threshold is
	// no reason for one Method to spell what every other one calls.
	if (isAsciiIn(originalString) && isAsciiIn(otherString)) {
		return createAsciiString(joined)
	}

	// NOTE: The answer is marked NOT ASCII, which is the same argument in the
	// other direction: a unit at or above 128, or a carriage return, is in one
	// of the two operands and a join holds every unit of both. So the join is
	// one the scan would refuse, and saying so costs nothing where scanning for
	// it costs the whole String.
	//
	// NOTE: That is what keeps a token built one character at a time linear.
	// An engine joins two Strings into a rope and resolves it the first time
	// anything READS a unit — so the ASCII scan of the growing token flattened
	// the rope every turn, and a Program appending 80,000 non-ASCII characters
	// measured 203 ms against 34 for its ASCII twin, which never scanned
	// because `true` already rode along. With the mark riding along both ways
	// the two measure alike, and the rope is resolved once, by whatever finally
	// reads the text.
	let string = createString(joined) as MeasuredString

	string[isAsciiKey] = false

	return string
}

// NOTE: Whether a run of the part's characters stands at a position of the
// receiver's view — the one comparison every grapheme-view search below makes,
// and `split` makes it once per position. A loop rather than `every` over the
// part, because of the closure allocated per position: the walk over three
// hundred lines of thirty-six characters measured 49 µs with `every` and 22 µs
// with the loop.
//
// NOTE: The receiver is read WHERE IT STANDS — `at` is where the run being
// tested begins in `clusters` and `remaining` is how many of the receiver's own
// characters stand from there — so a window is searched inside its parent's
// Array rather than copied out of it first.
//
// NOTE: The three arrive as plain arguments rather than as the window record
// `viewOf` answers. The record reads better and costs a property load PER
// CHARACTER, because the pushes at the call sites could reach anything as far
// as the engine knows: 200 `replaceEvery` over a 10,800-character String
// measured 19.7 ms that way against 17.6 here, and `split` 37.8 against 33.1.
//
// NOTE: The part arrives folded where the call folds, and the receiver is
// folded ONE CHARACTER AT A TIME here. Folding the whole receiver up front is
// what made a prefix test cost the whole String: 2,000 `starts(with "CAF",
// comparing #Insensitive)` on a 10,800-character String measured 70.6 ms that
// way and 0.1 ms this way, because this way reads three characters.
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

// NOTE: A run of the receiver's own characters, folded — as many as the part
// covers and NO MORE. It is what keeps a prefix or a suffix test at the cost of
// the prefix: folding the whole receiver to compare two characters is what made
// a drain asking `starts(with:, comparing #Insensitive)` per turn quadratic.
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

// NOTE: The receiver's characters as the WALKS read them — its own Array where
// the call folds nothing, and a folded copy of its own window where it does.
// The walks below visit every character of the receiver anyway, so folding it
// once costs what the walk costs; folding inside the comparison instead costs a
// branch per character of every walk that never folds, and `split` measured
// 36.2 ms that way against 33.1 here.
//
// NOTE: A window is folded into a copy of ITS OWN characters, never its
// parent's, which is why the answer carries the offset to read it from.
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
	// grapheme clusters (see `clustersOf`), so the empty separator splits into
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

	// NOTE: Each piece is handed its own characters along with its text — the
	// clusters it was cut into ARE its character view, so `length` on a piece
	// answers off them rather than segmenting the joined text afresh, which
	// could pair the clusters differently (see `createSegmentedString`).
	return createList(pieces.map((piece) => createSegmentedString(piece)))
}

export const split__overload$2 = split__overload$1

// NOTE: The searches, native so that a question about a POSITION never builds
// the pieces `split` builds. An Essence `firstIndex` on `split(on part)` reads
// the first piece's length, so `contains` — written on it — segments and copies
// a whole String to answer a Boolean: measured on a 10,800-character ASCII
// String, one `contains` of an absent part, 504 µs that way against 8 µs here.
// Each search reads the view `split` reads, so an occurrence is a whole run of
// characters on cluster boundaries, matched by canonical equivalence; and each
// takes the intrinsic when both sides pass the ASCII scan, for the reason
// `split` gives.
//
// NOTE: The empty part matches nowhere, except as a position at either end.
// The rule is stated ONCE, above `contains` in `String.es`, and the guards
// below are its answers: 0, the length, 0 and no positions at all.
//
// NOTE: Every entry taking a `CaseSensitivity` reads the SAME walk with the
// two sides folded, so one rule decides where an occurrence stands however the
// call spells it.

// NOTE: `#Insensitive` folds EACH CHARACTER on its own, where `is` and
// `compare` fold the whole String. A position Method answers a position of the
// RECEIVER, and a folding that maps one character onto several code points
// would move every position after it; folding per character keeps a match
// exactly as many characters wide as the part is, so `firstIndex`, `count` and
// the two replacements all cut on the receiver's own boundaries. The two rules
// part company over the Greek final sigma alone: `"ΟΣ"` folds whole to `"ος"`
// and per character to `"οσ"`, so `is` finds `"ος"` equal and `contains` does
// not find it inside.
function isInsensitive(sensitivity: CaseSensitivityType): boolean {
	return sensitivity[typeKeySymbol] === "CaseSensitivity#Insensitive"
}

// NOTE: The ASCII route's text, folded where the call asks for it. Lower-casing
// ASCII maps each unit to one unit, so a position in the folded text IS a
// position in the original — which is what lets the intrinsic keep answering
// for the receiver.
function foldedText(string: StringType, insensitive: boolean): string {
	return insensitive ? string.value.toLowerCase() : string.value
}

// NOTE: The grapheme route's PART, folded per character for the reason above.
// A folding COPIES, because `graphemesIn` hands back the remembered view
// itself and every caller here only ever reads it. Only the part is folded up
// front: it is as long as it is whatever the receiver holds, where the
// receiver's own characters are folded as `partMatchesAt` reaches them.
function foldedPart(string: StringType, insensitive: boolean): Array<string> {
	let characters = graphemesIn(string)

	return insensitive
		? characters.map((character) => character.toLowerCase())
		: characters
}

// NOTE: Whether both sides take the intrinsic route. Folding does not change
// the answer: lower-casing an ASCII String answers an ASCII String.
//
// NOTE: The RECEIVER is asked through `readsByUnit`, so a window is never
// scanned for an answer its view already decides. The part is asked outright:
// it is short, and its answer is remembered on it for every later call.
function bothAscii(originalString: StringType, part: StringType): boolean {
	return readsByUnit(originalString) && isAsciiIn(part)
}

function firstIndexIn(
	originalString: StringType,
	part: StringType,
	insensitive: boolean,
): number {
	if (bothAscii(originalString, part)) {
		return foldedText(originalString, insensitive).indexOf(
			foldedText(part, insensitive),
		)
	}

	let { clusters, start, count } = viewOf(originalString)
	let separator = foldedPart(part, insensitive)
	let walk = foldedWalk(clusters, start, count, insensitive)

	for (let position = 0; position + separator.length <= count; position++) {
		if (
			partMatchesAt(
				walk.characters,
				walk.at + position,
				count - position,
				separator,
			)
		) {
			return position
		}
	}

	return -1
}

// NOTE: The LAST occurrence, which can overlap an earlier one: `"aaa"` holds
// `"aa"` at 0 and at 1, and the answer is 1, as `lastIndexOf` answers. The
// walk runs from the last position the part fits at down to the first, so it
// stops at the first match it meets.
function lastIndexIn(
	originalString: StringType,
	part: StringType,
	insensitive: boolean,
): number {
	if (bothAscii(originalString, part)) {
		return foldedText(originalString, insensitive).lastIndexOf(
			foldedText(part, insensitive),
		)
	}

	let { clusters, start, count } = viewOf(originalString)
	let separator = foldedPart(part, insensitive)
	let walk = foldedWalk(clusters, start, count, insensitive)

	for (let position = count - separator.length; position >= 0; position--) {
		if (
			partMatchesAt(
				walk.characters,
				walk.at + position,
				count - position,
				separator,
			)
		) {
			return position
		}
	}

	return -1
}

// NOTE: The occurrences that do NOT overlap — the ones `split` cuts at — so
// `"aaa"::count(of "aa")` is 1: after a match the walk steps over the whole
// part, exactly as `split` does, and the count is one less than the pieces
// `split` would answer. An Essence body on `firstIndex` and `slice` would cut
// the rest of the String at every occurrence found, which is quadratic in the
// occurrences; this is one walk. Measured on a 10,800-character ASCII String
// with 3,600 occurrences: 537 µs counting the pieces, 33 µs here.
//
// NOTE: `everyIndex` and `count` are this ONE walk, visited two ways, so the
// two can not answer differently about one String. `count` visits without
// collecting: a Program asking how many times a part occurs should not
// allocate a position per occurrence to be told a number.
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

		// NOTE: Only the receiver's FIRST `needle.length` units are folded,
		// where the whole receiver used to be. A prefix test must cost the
		// prefix: a drain asking `starts(with:)` per turn folded the rest of
		// its String every turn otherwise, which is the same n² the copying
		// was. Cutting first and folding after is the same answer because
		// lower-casing ASCII maps each unit to one unit, which is what lets
		// this route answer for the receiver at all.
		return insensitive
			? needle.length <= text.length &&
					text.slice(0, needle.length).toLowerCase() === needle
			: text.startsWith(needle)
	}

	// NOTE: The three parts read directly rather than through `viewOf`, which
	// allocates a record per call — a drain asks this per turn, and the record
	// measured 220 ns against 200 for 2,000 prefix tests of a held String.
	let clusters = clustersIn(originalString)
	let start = startIn(originalString)
	let count = graphemeCountIn(originalString)
	let prefixCharacters = foldedPart(prefix, insensitive)

	if (prefixCharacters.length > count) {
		return false
	}

	// NOTE: Only the receiver's first `prefixCharacters.length` characters are
	// folded, for the reason the ASCII route above gives — a prefix test costs
	// the prefix, whichever route answers it.
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

		// NOTE: The receiver's LAST `needle.length` units, folded, for the
		// reason `starts` gives — a suffix test costs the suffix.
		return insensitive
			? needle.length <= text.length &&
					text.slice(text.length - needle.length).toLowerCase() ===
						needle
			: text.endsWith(needle)
	}

	// NOTE: Read directly, for the reason `starts` gives.
	let clusters = clustersIn(originalString)
	let start = startIn(originalString)
	let count = graphemeCountIn(originalString)
	let suffixCharacters = foldedPart(suffix, insensitive)

	if (suffixCharacters.length > count) {
		return false
	}

	let at = start + count - suffixCharacters.length

	// NOTE: The receiver's LAST `suffixCharacters.length` characters, folded,
	// for the reason `starts` gives.
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

// NOTE: The first of three entries — the second takes a `defaultingTo:`
// fallback and is written in Essence on this one, and the third folds the case.
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

// NOTE: The positions themselves, which a Program scanning a String reads
// where a hand-written walk would call `firstIndex` and `slice` per occurrence
// — one pass here against a cut of the rest of the String per hit.
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

// NOTE: `starts(with:)` itself is Essence — its slice begins at zero and needs
// no length — and this entry is native because a folded prefix and a folded
// receiver have to be compared character by character, which a slice of the
// receiver can not do.
export function starts__overload$2(
	originalString: StringType,
	prefix: StringType,
	sensitivity: CaseSensitivityType,
): BooleanType {
	return createBoolean(
		startsIn(originalString, prefix, isInsensitive(sensitivity)),
	)
}

// NOTE: Native — one grapheme pass, where the Essence body sliced the last
// characters and compared them (four traversals). Both sides are taken as the
// canonical grapheme view, so the suffix matches only on a cluster boundary and
// by canonical equivalence, exactly as `starts(with:)` does through `slice`.
//
// NOTE: Two ASCII Strings are compared by the intrinsic, for the reason
// `split` gives, so the Boolean allocates nothing.
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
	let character = characterIn(originalString, index.value)

	return character === undefined ? createEmpty() : createValue(character)
}

// NOTE: The character at a position, which is a read of ONE cluster and the
// only thing a window ever needs its parent's Array for. A negative position
// counts back from the end, as everywhere else, and `undefined` is what stands
// past either end — which `character(at:)` above reads as its `Optional`, and
// which the two proven ends in `NonEmptyString.ts` can not meet.
//
// NOTE: Exported for those two ends. Reading one of them off `graphemesIn`
// COPIES a window's characters to hand back one of them, which is O(n) per
// call and O(n²) over the drain that asks for the front character every turn;
// this reads the cluster where it stands.
//
// NOTE: WHAT THE ONE READER COSTS, both ends named. It is an O(n) removed and
// a few nanoseconds paid, and the nanoseconds are paid on EVERY read, not only
// on the window that needed them. Measured as 200,000 reads of one HELD String,
// one runtime per process, alternated, the answer consumed — which is the only
// way these came out reproducible; two runtimes in one process measure the
// second one twice its true cost, and an answer nothing consumes is deleted
// outright:
//                                  master    here
//   ascii  firstCharacter (held)    0.565   1.281 ms   (2.3x, +3.6 ns a call)
//   ascii  lastCharacter  (held)    0.564   0.560 ms   (1.0x)
//   ascii  character(at 5000)       0.565   0.554 ms   (1.0x)
//   view   firstCharacter (held)    0.673   1.070 ms   (1.6x, +2.0 ns)
//   view   lastCharacter  (held)    0.675   0.575 ms   (0.9x)
//   window firstCharacter           0.022   0.019 ms   (0.9x)
// Against which the same call over an 80,000-character non-ASCII front drain
// went from 9,602 ms to 49 — and that is `slice` as much as this reader, since
// master's window owned its own Array by the time it was asked.
//
// NOTE: ONE case stayed dearer and it is worth saying which and why: the FIRST
// character of a held ASCII String. Master's specialised body indexed the text
// at a CONSTANT zero, which an engine reads about as cheaply as a field; here
// the position is a `number | bigint` parameter resolved at run time, and no
// amount of hoisting makes a computed index as cheap as a literal one — the
// LAST character, which master computed too, measures the same on both sides.
// Three and a half nanoseconds on a nanosecond-scale read, for one body where
// there were three, and the O(n) it removes from every window.
export function characterIn(
	string: StringType,
	index: number | bigint,
): StringType | undefined {
	// NOTE: An ASCII String is read by unit rather than through the view, for
	// the reason `split` gives — so reading one character of it builds no
	// Array of all of them, and the unit is marked ASCII as a piece of a
	// `split` is. Measured on a 10,800-character ASCII String: 380 µs through
	// the view, 8 µs here, most of which is the scan.
	//
	// NOTE: The two keys are read ONCE, here, rather than through `readsByUnit`
	// and `viewIn` in turn — this is the read `NonEmptyString`'s two proven ends
	// are, and a Program walking a String asks it per character. Reading them
	// twice measured 15.0 ns against 11.8 for 200,000 reads of one held String.
	// The question the two of them answer is `readsByUnit`'s, spelled out: the
	// remembered mark decides where there is one, and a String with a view is
	// never scanned for one.
	// NOTE: The view's own key is read only where the MARK does not already
	// decide, which the `||` sees to — reading a key a value does not carry is
	// a miss, and this is the read `NonEmptyString`'s two proven ends are:
	// 200,000 `firstCharacter` of one held ASCII String measured 11.4 ns
	// apiece with both keys read and 8.6 with one.
	//
	// NOTE: The position is resolved INLINE for a `number`, where it went
	// through `positionFromEnd` — a call whose whole body, for the positions
	// these two ends ask, is one `typeof` on a `number | bigint` and a compare.
	// A bigint index still goes to the Function, because what it answers is a
	// rule (it is past either end of any String) and a rule belongs in one
	// place. 200,000 `firstCharacter` of one held String measured 1.79 ms with
	// the call and 1.16 without, and 200,000 `lastCharacter` 0.81 against 0.66.
	let measured = string as MeasuredString
	let marked = measured[isAsciiKey]

	if (
		marked === true ||
		(marked === undefined &&
			measured[graphemesKey] === undefined &&
			isAsciiIn(string))
	) {
		// NOTE: The bound is COMPARED rather than read off a missing unit, and
		// that was measured rather than assumed. Answering `undefined` by
		// indexing past the end instead is CORRECT here — the text is the
		// String's OWN `value`, so beyond its ends there is nothing to read —
		// and it costs the read its fast path where the engine can not see the
		// position is in range: 200,000 `lastCharacter` of one held ASCII
		// String measured 1.324 ms that way against 0.590 with the compare.
		//
		// NOTE: The view arm below compares its bound for a second reason,
		// which no measurement could have found. There the Array is the one the
		// window BORROWS, so a position past the window's own count reads the
		// character standing NEXT to it rather than nothing at all — a mutant
		// that dropped that compare answered the sixth character of a
		// five-character window and walked through the whole 10,172-test suite.
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

	// NOTE: The remembered Array is read where it stands rather than through
	// `clustersIn`, which would read the same key inside a call to answer what
	// the key already says — a String this far down either HAS a view or is
	// about to be given one, and the one that has it is the drain's case and
	// the held String's. The count beside it is safe to read with `!` for the
	// reason `graphemesIn` gives: every writer of the Array writes the count.
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

// NOTE: The view route of the cut above, in a Function of its own so that the
// ASCII route stays SMALL. An engine inlines a hot callee by its size, and a
// drain cuts once per turn: with both routes in one body, the ASCII drain of
// 5,000 characters measured 9.7 ms against master's 5.0 — the cut itself was
// no slower, and neither was the count beside it, but the pair of them was.
// Split, the same drain measures what it always did.
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

// NOTE: `@::split(on "")` is what a character IS here, so `characters` is that
// call rather than a second segmentation of its own. It is native because its
// answer is a `List<Character>`, and a refinement erases before anything runs:
// an Essence body could only hand back what `split` answers, which is a
// `List<String>`, and no expression can say the pieces of an empty separator
// are one character each. `NonEmptyString::characters` is this same Function
// under that Namespace's name.
//
// NOTE: The separator is built per call rather than held in a const of this
// module. A const would be a top-level `createString` the bundler can not
// prove pure, so it would arrive in EVERY Program that reaches `String.ts`
// at all — 36 bytes measured, in bundles that call none of this. One object
// beside a whole segmentation walk costs nothing worth keeping it for.
export function characters(originalString: StringType): ListType<StringType> {
	return split__overload$1(originalString, createString(""))
}

// NOTE: The one escape to the level BELOW a character, and the reason it is
// worth having: nothing character-level could be computed in Essence at all
// without it — no digit value, no checksum, no base, no escaping. The points
// are read off the NFC form, as every position Method is, so a String and its
// canonically equivalent twin answer the same points. A point above the Basic
// Multilingual Plane occupies two code units, and stepping by that width
// visits each WHOLE point once; a lone surrogate is no whole point and is read
// as the single unit it is.
//
// NOTE: A character is a grapheme cluster and a point is a code point, so the
// two counts differ wherever a cluster is built out of several points: the
// four-person emoji is one character and seven points. That is the level
// difference, and it is what the `§§` block says.
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

// NOTE: The scalar values, which are the points a String can hold: below
// 0x110000 and outside the surrogate range, since a surrogate is half of a
// point rather than one. A proven receiver takes the sign away, and these two
// are what is left of the question.
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

// NOTE: A point below 128 that is no carriage return builds a String the ASCII
// scan would accept, so it is marked rather than scanned for, exactly as a
// piece of a `split` is.
function stringOfPoints(points: Array<number>): StringType {
	let text = String.fromCodePoint(...points)

	return points.every((point) => point < 128 && point !== 13)
		? createAsciiString(text)
		: createString(text)
}

// NOTE: The first of two entries. The receiver's proof says the point is not
// negative and this says the rest: a surrogate and a point past the last plane
// are the two shapes left that name no character.
export function of__overload$1(code: IntegerType): OptionalType<StringType> {
	if (!isScalarValue(code.value)) {
		return createEmpty()
	}

	return createValue(stringOfPoints([Number(code.value)]))
}

// NOTE: All or nothing, which is the answer a caller can act on: a String
// built out of the points it could read and quietly missing the rest is a
// String nobody asked for. The `Optional` is the same shape the single-point
// entry answers, and `Integer.parse` beside it.
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

// NOTE: Character CLASSIFICATION, and the one thing in the library that a host
// property escape answers. This is not a pattern language reaching a Program:
// each of the four asks one fixed question of every character and answers a
// Boolean, and no part of the shape is anything a caller writes. The
// alternative was a table of ranges maintained here, which would answer a
// different question per Unicode version than the host's own `is`, `compare`
// and `normalize` do.
//
// NOTE: Read off the NFC form, as every other question about characters is, so
// that a composed accent and a decomposed one are classified alike. A
// combining mark counts as part of the letter or digit BEFORE it, which is why
// the two letter patterns are written as a base followed by its marks rather
// than as a class holding marks: a mark standing on its own belongs to no
// letter and is not one.
//
// NOTE: All four accept the empty String, for the reason `hasOnlyItems(where:)`
// answers `true` for an empty List: nothing in it breaks the rule.
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

// NOTE: The limited split, where the last piece keeps the separators the walk
// stopped short of. A Program parsing `key=value=with=equals` wants exactly
// that, and the Essence spelling — split the whole String and join the tail
// back — builds every piece to throw most of them away. Both Arguments are
// proven, so the answer always holds a piece: a separator with a character in
// it leaves the piece before it, and a count above zero asks for at least one.
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

// NOTE: The two replacements' folding entries, native for the reason the
// searches are: a folded receiver is not the text to build the answer out of,
// so the walk matches on the folded view and cuts on the ORIGINAL characters.
// Folding per character is what makes the two views the same width, so a match
// found at a position covers exactly the part's characters there.
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

// NOTE: Grouping, the piece a currency or a file size is missing — the counting
// is by character, so it belongs beside the other character walks rather than
// on a number, and both a numeral and a card number reach it. The separator
// goes between the groups and never at either end.
//
// NOTE: `from:` names the end the counting starts at, so `#End` puts the short
// group at the FRONT, which is what "1,234,567" is. `#BothEnds` counts from the
// end as well: grouping has a direction rather than two ends, and the Choice
// `trim` and `pad` already read was taken over a two-Case Choice of its own,
// which would have cost the six registration sites a Choice costs for one
// Method.
export function separate(
	originalString: StringType,
	size: IntegerType,
	separator: StringType,
	side: SideType,
): StringType {
	let width = Number(size.value)
	let characters = isAsciiIn(originalString)
		? originalString.value.split("")
		: graphemesIn(originalString)

	if (characters.length <= width) {
		return originalString
	}

	let groups: Array<string> = []

	if (side[typeKeySymbol] === "Side#Start") {
		for (let index = 0; index < characters.length; index += width) {
			groups.push(characters.slice(index, index + width).join(""))
		}
	} else {
		for (let end = characters.length; end > 0; end -= width) {
			groups.unshift(
				characters
					.slice(end - width < 0 ? 0 : end - width, end)
					.join(""),
			)
		}
	}

	return createString(groups.join(separator.value))
}

// NOTE: The quoted spelling a String already has inside a List, a Record or a
// Case, handed to a Program that is building a message of its own. It is the
// same Function those renderings call, so a value can not read one way in a
// structure and another in a sentence about it.
export function quote(originalString: StringType): StringType {
	return createString(quotedText(originalString.value))
}
