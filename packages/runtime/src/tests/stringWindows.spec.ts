import { describe, expect, test } from "bun:test"

import { insensitive, sensitive } from "../CaseSensitivity"
import { createInteger, type IntegerType } from "../Integer"
import { encodeKey } from "../keyEncoding"
import { firstCharacter, lastCharacter } from "../NonEmptyString"
import type { OptionalType } from "../Optional"
import {
	append,
	character__overload$1 as character,
	characters,
	compare__overload$1 as compare,
	count__overload$1 as count,
	createString,
	ends__overload$1 as ends,
	ends__overload$2 as endsFolded,
	firstIndex__overload$1 as firstIndex,
	hasCharacterView,
	lastIndex__overload$1 as lastIndex,
	length,
	reverse,
	slice,
	split__overload$1 as split,
	starts__overload$2 as startsFolded,
	type StringType,
	viewOf,
} from "../String"
import { typeKeySymbol } from "../type"

// NOTE: A String is a WINDOW when its characters live in an Array it shares
// with the String it was cut from — `slice` hands one back wherever the cut is
// at least half of what it cuts, so that consuming a String from the front does
// not copy the rest of it every turn. Nothing in the language can ask whether a
// String is a window, and this file is the proof of that: every observable
// answer is compared with a MODEL that holds the characters as a plain Array
// and knows nothing of sharing.
//
// NOTE: The model is "an Array of clusters", because that is what a String IS
// here — and deliberately NOT "segment the text afresh". A String assembled
// from a known view keeps that view (see `createSegmentedString`), since
// grapheme boundaries are decided by neighbours and three regional indicators
// re-pair however they happen to stand. So the model carries the clusters the
// way the makers do: a RAW String segments its NFC form, and an ASSEMBLED one
// is handed its characters and joins them for its text.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function segment(text: string): Array<string> {
	let found: Array<string> = []

	for (let { segment: cluster } of segmenter.segment(text)) {
		found.push(cluster)
	}

	return found
}

type Model = { value: string; clusters: Array<string> }

function raw(value: string): Model {
	return { value, clusters: segment(value.normalize("NFC")) }
}

function assembled(clusters: Array<string>): Model {
	return { clusters, value: clusters.join("") }
}

// NOTE: The position rules written out a second time, in the model's own terms
// — half-open, a negative position counting back from the end, each end THEN
// clamped. Spelled here rather than imported so that the two are genuinely two.
function resolve(index: number, count: number): number {
	let position = index < 0 ? index + count : index

	return position < 0 ? 0 : position > count ? count : position
}

function sliceModel(model: Model, from: number, to: number): Model {
	let count = model.clusters.length
	let start = resolve(from, count)
	let end = resolve(to, count)

	return assembled(end <= start ? [] : model.clusters.slice(start, end))
}

function foldedModel(model: Model, folding: boolean): Array<string> {
	return folding
		? model.clusters.map((cluster) => cluster.toLowerCase())
		: model.clusters
}

function matchesAtModel(
	haystack: Array<string>,
	needle: Array<string>,
	position: number,
): boolean {
	if (position + needle.length > haystack.length) {
		return false
	}

	return needle.every(
		(cluster, offset) => haystack[position + offset] === cluster,
	)
}

function firstIndexModel(model: Model, part: Model, folding: boolean): number {
	let haystack = foldedModel(model, folding)
	let needle = foldedModel(part, folding)

	for (let position = 0; position <= haystack.length; position++) {
		if (matchesAtModel(haystack, needle, position)) {
			return position
		}
	}

	return -1
}

function lastIndexModel(model: Model, part: Model): number {
	let haystack = model.clusters

	for (
		let position = haystack.length - part.clusters.length;
		position >= 0;
		position--
	) {
		if (matchesAtModel(haystack, part.clusters, position)) {
			return position
		}
	}

	return -1
}

function countModel(model: Model, part: Model): number {
	let found = 0
	let position = 0

	while (position + part.clusters.length <= model.clusters.length) {
		if (matchesAtModel(model.clusters, part.clusters, position)) {
			found++
			position += part.clusters.length
		} else {
			position++
		}
	}

	return found
}

function splitModel(model: Model, part: Model): Array<Array<string>> {
	if (part.clusters.length === 0) {
		return model.clusters.map((cluster) => [cluster])
	}

	let pieces: Array<Array<string>> = []
	let current: Array<string> = []
	let position = 0

	while (position < model.clusters.length) {
		if (matchesAtModel(model.clusters, part.clusters, position)) {
			pieces.push(current)
			current = []
			position += part.clusters.length
		} else {
			current.push(model.clusters[position]!)
			position++
		}
	}

	pieces.push(current)

	return pieces
}

function position(answer: OptionalType<IntegerType>): number {
	return answer[typeKeySymbol] === "Optional#Empty"
		? -1
		: Number(answer.item.value)
}

function characterAt(value: StringType, index: number): string | null {
	let answer = character(value, createInteger(index))

	return answer[typeKeySymbol] === "Optional#Empty" ? null : answer.item.value
}

// NOTE: Every observable answer, taken off the String and off the model and
// compared. `value` is first because everything else is a question about the
// same text; a window whose text was cut wrongly fails here before anything
// subtler gets a chance to.
//
// NOTE: THE ORDER IS PART OF THE TEST, and it is the one thing about this file
// that must not be tidied. A reader that walks the whole receiver —
// `characters`, `reverse`, `split` — MATERIALISES a window: `graphemesIn`
// copies the window's clusters out, writes a start of zero and gives up the
// borrowed text and table. Everything asked after one of those is a question
// about a COPY, and no copy can be read past an end it no longer has. So the
// readers that read a window WHERE IT STANDS go first — `length`,
// `character(at:)`, the two proven ends, the cuts, the searches and the prefix
// and suffix tests — and the three that materialise go last, in that order.
//
// NOTE: It is written down because the file has already been wrong this way
// twice. `characters` stood third, and with it there a window that read PAST
// ITS OWN END (`characterIn` without its upper bound) passed this file and the
// whole 10,172-test suite; the cuts stood after the `split` inside the parts
// loop, so every cut they compared was a cut of a copy. It is the same disease
// as the ASCII guard further down, which asked the window before anything used
// it — a guard that asks at the wrong moment is not a guard.
function compareWithModel(value: StringType, model: Model, note: string) {
	expect(`${note} value ${value.value}`).toBe(`${note} value ${model.value}`)
	expect(`${note} length ${Number(length(value).value)}`).toBe(
		`${note} length ${model.clusters.length}`,
	)

	// NOTE: The last two positions are the window's OWN end and one past it,
	// wherever that falls — the gap between where a window stops and where the
	// Array it borrows stops is exactly what a fixed list of positions can
	// miss, and it is where a window reading its parent's characters shows.
	for (let index of [
		0,
		1,
		2,
		-1,
		-2,
		7,
		500,
		-500,
		model.clusters.length,
		model.clusters.length + 1,
	]) {
		let expected =
			model.clusters[resolveRead(index, model.clusters.length)] ?? null

		expect(
			`${note} character(at ${index}) ${characterAt(value, index)}`,
		).toBe(`${note} character(at ${index}) ${expected}`)
	}

	if (model.clusters.length > 0) {
		expect(`${note} first ${firstCharacter(value).value}`).toBe(
			`${note} first ${model.clusters[0]}`,
		)
		expect(`${note} last ${lastCharacter(value).value}`).toBe(
			`${note} last ${model.clusters[model.clusters.length - 1]}`,
		)
	}

	// NOTE: The cuts stand HERE, before anything walks the receiver, because
	// cutting a window is the whole of what this change does: the cut resolves
	// its positions against the window's own count and reads the borrowed Array
	// from the window's own offset. Asked after a walk they were nine cuts of a
	// copy, which is the cut that worked before there were windows at all.
	for (let [from, to] of CUTS) {
		let cut = slice(value, createInteger(from), createInteger(to))
		let expected = sliceModel(model, from, to)
		let label = `${note} slice(${from},${to})`

		expect(`${label} ${cut.value}`).toBe(`${label} ${expected.value}`)
		expect(`${label} length ${Number(length(cut).value)}`).toBe(
			`${label} length ${expected.clusters.length}`,
		)
	}

	for (let part of PARTS) {
		let partModel = raw(part)
		let other = createString(part)
		let label = `${note} ${JSON.stringify(part)}`

		expect(`${label} first ${position(firstIndex(value, other))}`).toBe(
			`${label} first ${part === "" ? 0 : firstIndexModel(model, partModel, false)}`,
		)
		expect(`${label} last ${position(lastIndex(value, other))}`).toBe(
			`${label} last ${part === "" ? model.clusters.length : lastIndexModel(model, partModel)}`,
		)
		expect(`${label} count ${Number(count(value, other).value)}`).toBe(
			`${label} count ${part === "" ? 0 : countModel(model, partModel)}`,
		)
		expect(
			`${label} starts ${startsFolded(value, other, sensitive).value}`,
		).toBe(
			`${label} starts ${matchesAtModel(model.clusters, partModel.clusters, 0)}`,
		)
		expect(
			`${label} startsFolded ${startsFolded(value, other, insensitive).value}`,
		).toBe(
			`${label} startsFolded ${matchesAtModel(foldedModel(model, true), foldedModel(partModel, true), 0)}`,
		)
		expect(`${label} ends ${ends(value, other).value}`).toBe(
			`${label} ends ${
				partModel.clusters.length <= model.clusters.length &&
				matchesAtModel(
					model.clusters,
					partModel.clusters,
					model.clusters.length - partModel.clusters.length,
				)
			}`,
		)
		expect(
			`${label} endsFolded ${endsFolded(value, other, insensitive).value}`,
		).toBe(
			`${label} endsFolded ${
				partModel.clusters.length <= model.clusters.length &&
				matchesAtModel(
					foldedModel(model, true),
					foldedModel(partModel, true),
					model.clusters.length - partModel.clusters.length,
				)
			}`,
		)
	}

	// NOTE: The KEY a Dictionary would file this String under, which is its NFC
	// form — the one answer that ties a window to `is` and `compare`, since
	// those are decided over the same form. A window whose text is not the text
	// its characters spell is caught here even where its own `value` reads
	// right.
	expect(
		`${note} key ${String(encodeKey(value, { structural: true } as never))}`,
	).toBe(`${note} key ${model.value.normalize("NFC")}`)

	// NOTE: From here down every reader walks the whole receiver, so the value
	// under test is a copy of its own characters from the first of them on. See
	// the ordering NOTE above: these three go last for that reason and for no
	// other.
	expect(`${note} reverse ${reverse(value).value}`).toBe(
		`${note} reverse ${[...model.clusters].reverse().join("")}`,
	)

	for (let part of PARTS) {
		let label = `${note} ${JSON.stringify(part)}`

		expect(
			`${label} split ${JSON.stringify(split(value, createString(part)).value.map((piece) => piece.value))}`,
		).toBe(
			`${label} split ${JSON.stringify(splitModel(model, raw(part)).map((piece) => piece.join("")))}`,
		)
	}

	expect(
		`${note} characters ${JSON.stringify(characters(value).value.map((one) => one.value))}`,
	).toBe(`${note} characters ${JSON.stringify(model.clusters)}`)
}

// NOTE: A read is clamped nowhere — a position outside the String answers
// nothing at all, where a CUT clamps to the nearer end.
function resolveRead(index: number, count: number): number {
	return index < 0 ? index + count : index
}

// NOTE: What `String.ts` remembered on a value under one of its private Symbol
// keys, found by the key's description — the same reader, for the same reason,
// that `asciiFastPath.spec.ts` has.
function remembered(value: StringType, description: string): unknown {
	let key = Object.getOwnPropertySymbols(value).find(
		(symbol) => symbol.description === description,
	)

	return key === undefined ? undefined : (value as never)[key as never]
}

const PARTS = ["", "c", "é", "fé", "\r\n", "ab", "🇩🇪", "É"]

const CUTS: Array<[number, number]> = [
	[0, 1],
	[1, 1_000],
	[2, 5],
	[-3, 1_000],
	[0, -1],
	[-1_000, 1_000],
	[5, 2],
	[0, 0],
	[-2, -1],
]

const BASES = [
	"",
	"a",
	"café café café ",
	"café café ",
	"ȩ́xyz ȩ́xyz",
	"ab\r\nce ab\r\nce",
	"\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}abc \u{1F1E9}\u{1F1EA}",
	"\u{1F1E9}\u{1F1EA}\u{1F1E8}\u{1F1ED}\u{1F1E6}\u{1F1F9}",
	"ΟΣΟΣ ΟΣΟΣ",
	"  Straße 0123 Ünïcødé  ",
	"́abćabc",
]

// NOTE: A seeded generator, so the sequences are the same on every machine and
// on every run, and a failure is a seed anyone can replay. Its shape is the
// xorshift `randomness.spec.ts` uses for the same reason.
function generator(seed: number) {
	let state = seed >>> 0 || 1

	return () => {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		state >>>= 0

		return state / 0x1_0000_0000
	}
}

describe("a window answers what a copy answered", () => {
	// NOTE: The sequence builds Strings out of Strings — cuts of cuts of cuts,
	// joins of two windows, a piece of a split, a reversal — and every one of
	// them is compared with the model as it is made. A window of a window is
	// what the base offset is for, so the sequences are deliberately deep.
	test.each(BASES)("random sequences over %j", (base) => {
		for (let seed = 1; seed <= 6; seed++) {
			let random = generator(seed * 2_654_435_761)
			let values = [createString(base)]
			let models = [raw(base)]

			for (let turn = 0; turn < 10; turn++) {
				let choice = Math.floor(random() * 7)
				let first = Math.floor(random() * values.length)
				let second = Math.floor(random() * values.length)
				let from = Math.floor(random() * 9) - 3
				let to = Math.floor(random() * 12) - 3

				switch (choice) {
					case 0:
						values.push(
							slice(
								values[first]!,
								createInteger(from),
								createInteger(to),
							),
						)
						models.push(sliceModel(models[first]!, from, to))
						break
					case 1:
						values.push(
							slice(
								values[first]!,
								createInteger(1),
								createInteger(1_000_000),
							),
						)
						models.push(sliceModel(models[first]!, 1, 1_000_000))
						break
					case 2:
						values.push(
							slice(
								values[first]!,
								createInteger(0),
								createInteger(-1),
							),
						)
						models.push(sliceModel(models[first]!, 0, -1))
						break
					case 3:
						values.push(append(values[first]!, values[second]!))
						models.push(
							raw(models[first]!.value + models[second]!.value),
						)
						break
					case 4:
						values.push(reverse(values[first]!))
						models.push(
							assembled([...models[first]!.clusters].reverse()),
						)
						break
					case 5: {
						let part = PARTS[(from + 3) % PARTS.length]!
						let pieces = split(values[first]!, createString(part))
						let modelled = splitModel(models[first]!, raw(part))

						// NOTE: The empty separator over the empty String is
						// the one split that answers no pieces at all, and
						// there is nothing to carry forward from it.
						if (modelled.length === 0) {
							continue
						}

						let index = (to + 3) % modelled.length

						values.push(pieces.value[index]!)
						models.push(assembled(modelled[index]!))
						break
					}
					default: {
						let read = character(
							values[first]!,
							createInteger(from),
						)

						if (read[typeKeySymbol] === "Optional#Empty") {
							continue
						}

						values.push(read.item)
						models.push(raw(read.item.value))
					}
				}

				compareWithModel(
					values[values.length - 1]!,
					models[models.length - 1]!,
					`${base} seed ${seed} turn ${turn}`,
				)
			}

			// NOTE: PERSISTENT use. Every String the sequence made is read
			// AGAIN, after everything derived from it exists — a parent that has
			// since been cut, walked and materialised, and a window whose parent
			// has. Nothing a later String did may change what an earlier one
			// answers, and the remembering under the Symbol keys is the whole
			// reason that has to be asserted rather than assumed.
			for (let index = values.length - 1; index >= 0; index--) {
				compareWithModel(
					values[index]!,
					models[index]!,
					`${base} seed ${seed} again ${index}`,
				)
			}
		}
	})
})

// NOTE: The claims about WORK, which no clock decides. A drain over a String
// segments it ONCE and copies a bounded number of clusters in all; the ASCII
// drain beside it builds no character view whatever. `viewOf` is what makes
// both askable: the Array a String's characters live in is its identity here,
// and `segmented` says the Segmenter ran to make it.
describe("what a drain costs", () => {
	const CHARACTERS = 20_000

	// NOTE: Every drain here is bounded by the turns it is KNOWN to take, and
	// the bound is asserted afterwards rather than trusted. A drain runs until
	// the String is empty, so a change that stops a cut shortening its receiver
	// would not fail this file — it would hang it, and a suite that hangs says
	// nothing at all. The turn count is the assertion, the cap is the seatbelt.
	const TURN_CAP = CHARACTERS + 10

	function drainWork(text: StringType) {
		let arrays = new Set<Array<string>>()
		let segmentations = 0
		let clustersHeld = 0
		let rest = text
		let turns = 0

		while (Number(length(rest).value) > 0 && turns < TURN_CAP) {
			let view = viewOf(rest)

			if (!arrays.has(view.clusters)) {
				arrays.add(view.clusters)
				clustersHeld += view.clusters.length

				if (view.segmented) {
					segmentations++
				}
			}

			rest = slice(rest, createInteger(1), createInteger(1_000_000))
			turns++
		}

		return { arrays: arrays.size, segmentations, clustersHeld, turns }
	}

	test("a front drain segments once and copies twice the characters", () => {
		let work = drainWork(createString("café ".repeat(CHARACTERS / 5)))

		expect(work.turns).toBe(CHARACTERS)
		expect(work.segmentations).toBe(1)

		// NOTE: One Array per halving, and the clusters they hold add up to
		// 2n — the half rule's whole claim. Copying at every turn would be
		// 20,000 Arrays and 200,000,000 clusters; never copying would be one
		// Array, which is the other test below.
		expect(work.arrays).toBeLessThanOrEqual(20)
		expect(work.clustersHeld).toBeLessThan(3 * CHARACTERS)
	})

	test("an ASCII front drain builds no character view at all", () => {
		let rest = createString("cafe ".repeat(CHARACTERS / 5))
		let turns = 0

		while (Number(length(rest).value) > 0 && turns < TURN_CAP) {
			expect(hasCharacterView(rest)).toBeFalse()
			rest = slice(rest, createInteger(1), createInteger(1_000_000))
			turns++
		}

		expect(turns).toBe(CHARACTERS)
	})

	// NOTE: The other side of the half rule, and the reason it exists: a short
	// token cut out of a long String does NOT share, so holding the token for
	// the life of a Program does not hold the String it came from.
	test("a short cut keeps its own characters", () => {
		let text = createString("café ".repeat(CHARACTERS / 5))
		let token = slice(text, createInteger(3), createInteger(9))

		expect(viewOf(token).count).toBe(6)
		expect(viewOf(token).clusters).toHaveLength(6)
		expect(viewOf(token).clusters).not.toBe(viewOf(text).clusters)
	})

	// NOTE: The half rule is asked about the ROOT's Array and not about the
	// window doing the cutting, and THAT is what bounds retention: a cut that is
	// most of a window is still a small part of the Array the window borrows, and
	// sharing it would pin the whole root for as long as the cut is held. The
	// test above cuts from a root, where asking either question answers the same
	// — so it is this one that holds the rule. Six thousand characters are at
	// least half of the ten-thousand-character window and well under half of the
	// twenty-thousand-character Array underneath it.
	test("a cut of a window is measured against the root's Array", () => {
		let text = createString("café ".repeat(CHARACTERS / 5))
		let half = slice(text, createInteger(0), createInteger(CHARACTERS / 2))
		let most = slice(half, createInteger(0), createInteger(6_000))

		expect(viewOf(half).clusters).toBe(viewOf(text).clusters)
		expect(viewOf(most).clusters).not.toBe(viewOf(text).clusters)
		expect(viewOf(most).clusters).toHaveLength(6_000)
		expect(viewOf(most).count).toBe(6_000)
	})

	// NOTE: A window of a window shares the ROOT's Array rather than standing
	// on a chain of windows, so reading a character is one Array read however
	// many cuts deep the String is.
	test("a window of a window shares the root's Array", () => {
		let text = createString("café ".repeat(CHARACTERS / 5))
		let once = slice(text, createInteger(1), createInteger(1_000_000))
		let twice = slice(once, createInteger(1), createInteger(1_000_000))
		let thrice = slice(twice, createInteger(1), createInteger(1_000_000))

		expect(viewOf(thrice).clusters).toBe(viewOf(text).clusters)
		expect(viewOf(thrice).start).toBe(3)
		expect(viewOf(thrice).count).toBe(CHARACTERS - 3)
	})

	// NOTE: Materialising a window — which is what a whole-Array reader like
	// `split` does to one — gives it characters of its own and lets its parent's
	// Array go. It is asserted here because it is what keeps a drain that
	// splits from pinning the String it drains.
	test("a walk over a window gives it characters of its own", () => {
		let text = createString("café ".repeat(CHARACTERS / 5))
		let window = slice(text, createInteger(1), createInteger(1_000_000))

		expect(viewOf(window).clusters).toBe(viewOf(text).clusters)

		split(window, createString(" "))

		expect(viewOf(window).clusters).not.toBe(viewOf(text).clusters)
		expect(viewOf(window).start).toBe(0)
		expect(viewOf(window).count).toBe(CHARACTERS - 1)
	})

	// NOTE: The ASCII scan is O(n) and every turn of a drain is a NEW String,
	// so asking it per turn is the same n² the copying was. A String that has a
	// character view answers the question off the view instead and is never
	// scanned — which shows as the scan's remembered answer never appearing on
	// a window. The Symbol key is found by its description, as
	// `asciiFastPath.spec.ts` finds the same two, because whether a scan
	// HAPPENED is not observable any other way than by timing.
	//
	// NOTE: Asked of the window AFTER everything a turn asks OF it, and that
	// ordering is the test. The scan remembers its answer on the receiver, so a
	// window asked before it is used carries nothing whatever the Methods do —
	// which is what an earlier draft of this guard asserted, and a mutant that
	// scanned every window walked straight through it.
	test("a drain never scans a window for ASCII-ness", () => {
		let rest = slice(
			createString("café ".repeat(CHARACTERS / 5)),
			createInteger(1),
			createInteger(1_000_000),
		)

		let turns = 0

		while (Number(length(rest).value) > 0 && turns < TURN_CAP) {
			let window = rest

			startsFolded(window, createString("ZZ"), insensitive)
			ends(window, createString("zz"))
			character(window, createInteger(0))
			firstCharacter(window)
			firstIndex(window, createString("é"))
			rest = slice(window, createInteger(1), createInteger(1_000_000))
			turns++

			expect(remembered(window, "$isAscii")).toBeUndefined()
			expect(remembered(window, "$normalised")).toBeUndefined()
		}

		expect(turns).toBe(CHARACTERS - 1)
	})

	// NOTE: The REFUSED mark rides through `append` exactly as the accepted one
	// does, and that it does is a claim about WORK no answer can show. A join
	// holds every unit of both sides, so a side the scan refused makes a join it
	// would refuse — and saying so costs a property write where asking costs the
	// whole join. An engine joins two Strings into a ROPE and resolves it the
	// first time anything reads a unit, so without the mark the scan flattened
	// everything built so far, every turn: 80,000 non-ASCII characters appended
	// one at a time measured 203 ms against their ASCII twin's 34.
	//
	// NOTE: Asserted on EVERY turn's answer rather than on the last one, because
	// the mark is what keeps the next turn from scanning — a turn that drops it
	// has already paid for the walk by the time the token is finished. The count
	// at the end is the other half: a mark is only worth carrying while it is
	// true, and the characters of the token are still counted off the view.
	test("a token built by appending is never scanned again", () => {
		let token = createString("é")
		let turns = 0

		while (turns < CHARACTERS) {
			token = append(token, createString("a"))
			turns++

			expect(remembered(token, "$isAscii")).toBeFalse()
		}

		expect(turns).toBe(CHARACTERS)
		expect(Number(length(token).value)).toBe(CHARACTERS + 1)
	})

	// NOTE: A prefix test costs the PREFIX. Folding the whole receiver is not
	// visible as an answer, so it is asserted as work the only way it can be:
	// the receiver of a folded `starts` is not walked into a view of its own,
	// and the count of clusters the whole drain holds stays bounded.
	test("a folded prefix test over a drain stays bounded", () => {
		let rest = createString("café ".repeat(CHARACTERS / 5))
		let arrays = new Set<Array<string>>()
		let clustersHeld = 0
		let turns = 0

		while (Number(length(rest).value) > 0 && turns < TURN_CAP) {
			startsFolded(rest, createString("ZZ"), insensitive)
			turns++

			let view = viewOf(rest)

			if (!arrays.has(view.clusters)) {
				arrays.add(view.clusters)
				clustersHeld += view.clusters.length
			}

			rest = slice(rest, createInteger(1), createInteger(1_000_000))
		}

		expect(turns).toBe(CHARACTERS)
		expect(clustersHeld).toBeLessThan(3 * CHARACTERS)
	})
})

// NOTE: `compare` decides `is`, and both are decided over the NFC form — so a
// window and a String written down with the same characters are the same
// String, whichever way each of them was made.
describe("a window is the String it spells", () => {
	test("a cut equals the text written down", () => {
		let text = createString("café au lait")
		let window = slice(text, createInteger(0), createInteger(4))

		expect(compare(window, createString("café"))[typeKeySymbol]).toBe(
			"Ordering#Equal",
		)
		expect(compare(window, createString("café"))[typeKeySymbol]).toBe(
			"Ordering#Equal",
		)
		expect(window.value).toBe("café".normalize("NFC"))
	})
})
