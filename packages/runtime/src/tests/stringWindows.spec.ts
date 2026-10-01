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

// Every observable answer of a String window is compared with a model holding
// its characters as a plain Array of clusters. A raw model segments its NFC
// form, and an assembled one keeps the clusters it was given, since regional
// indicators re-pair however they stand. See "String windows" in
// packages/runtime/DEVELOPMENT.md.

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

// The position rules again, in the model's terms: half-open, a negative
// position counts back, and each end is then clamped. Spelled here rather than
// imported, so the two are independent.
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

// WARNING: the order is part of the test. `characters`, `reverse` and `split`
// materialise a window through `graphemesIn`, so anything asked after them
// asks a copy. The readers that read a window in place go first.
function compareWithModel(value: StringType, model: Model, note: string) {
	expect(`${note} value ${value.value}`).toBe(`${note} value ${model.value}`)
	expect(`${note} length ${Number(length(value).value)}`).toBe(
		`${note} length ${model.clusters.length}`,
	)

	// The last two positions are the window's own end and one past it, where a
	// window reading its parent's characters would show.
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

	// The cuts come before any walk, so they cut the window rather than a copy.
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

	// The Dictionary key is the NFC form `is` and `compare` decide over, so a
	// window whose text differs from its characters fails here.
	expect(
		`${note} key ${String(encodeKey(value, { structural: true } as never))}`,
	).toBe(`${note} key ${model.value.normalize("NFC")}`)

	// These readers walk the whole receiver and materialise it, so they go last.
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

// A read is never clamped: a position outside the String answers nothing,
// where a cut clamps to the nearer end.
function resolveRead(index: number, count: number): number {
	return index < 0 ? index + count : index
}

// Reads what `String.ts` remembered under a private Symbol key, found by its
// description, as `asciiFastPath.spec.ts` does.
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

// A seeded xorshift generator, so a failing seed replays anywhere.
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
	// Builds Strings out of Strings, deep enough for windows of windows, and
	// compares each with the model as it is made.
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

						// The empty separator over the empty String answers no
						// pieces.
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

			// Every String is read again after everything derived from it exists,
			// since values remember answers under Symbol keys.
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

// Counts segmenting by wrapping `Intl.Segmenter.prototype.segment`, which
// `clustersOf` calls to build a view. The wrapper is restored in a `finally`,
// since a wrapped prototype would leak into every spec sharing the process.
function whileCountingSegmentations<Answer>(body: () => Answer): {
	answer: Answer
	runs: number
} {
	let unwrapped = Intl.Segmenter.prototype.segment
	let runs = 0

	Intl.Segmenter.prototype.segment = function (
		this: Intl.Segmenter,
		text: string,
	) {
		runs++

		return unwrapped.call(this, text)
	}

	try {
		return { answer: body(), runs }
	} finally {
		Intl.Segmenter.prototype.segment = unwrapped
	}
}

describe("what a drain costs", () => {
	const CHARACTERS = 20_000

	// A cut that stopped shortening its receiver would hang a drain, so the cap
	// stops it and the turn count is asserted.
	const TURN_CAP = CHARACTERS + 10

	function drainWork(text: StringType) {
		let arrays = new Set<Array<string>>()
		let clustersHeld = 0
		let rest = text
		let turns = 0

		while (Number(length(rest).value) > 0 && turns < TURN_CAP) {
			let view = viewOf(rest)

			if (!arrays.has(view.clusters)) {
				arrays.add(view.clusters)
				clustersHeld += view.clusters.length
			}

			rest = slice(rest, createInteger(1), createInteger(1_000_000))
			turns++
		}

		return { arrays: arrays.size, clustersHeld, turns }
	}

	test("a front drain segments once and copies twice the characters", () => {
		let { answer: work, runs } = whileCountingSegmentations(() =>
			drainWork(createString("café ".repeat(CHARACTERS / 5))),
		)

		expect(work.turns).toBe(CHARACTERS)
		expect(runs).toBe(1)

		// One Array per halving, holding about twice the characters in all.
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

	// A short token cut from a long String does not share, so holding the token
	// does not hold the String.
	test("a short cut keeps its own characters", () => {
		let text = createString("café ".repeat(CHARACTERS / 5))
		let token = slice(text, createInteger(3), createInteger(9))

		expect(viewOf(token).count).toBe(6)
		expect(viewOf(token).clusters).toHaveLength(6)
		expect(viewOf(token).clusters).not.toBe(viewOf(text).clusters)
	})

	// The half rule is asked of the root's Array, so a cut that is most of a
	// window but under half of the root copies. Over skewed clusters the unit
	// question alone would let it share.
	test("a cut of a window is measured against the root's Array", () => {
		let text = createString("café ".repeat(CHARACTERS / 5))
		let half = slice(text, createInteger(0), createInteger(CHARACTERS / 2))
		let most = slice(half, createInteger(0), createInteger(6_000))

		expect(viewOf(half).clusters).toBe(viewOf(text).clusters)
		expect(viewOf(most).clusters).not.toBe(viewOf(text).clusters)
		expect(viewOf(most).clusters).toHaveLength(6_000)
		expect(viewOf(most).count).toBe(6_000)

		let wide = `e${String.fromCodePoint(769).repeat(20)}`
		let skewed = createString(wide.repeat(2_000) + "a".repeat(2_000))
		let heavy = slice(skewed, createInteger(0), createInteger(2_000))
		let inside = slice(heavy, createInteger(0), createInteger(1_500))

		expect(viewOf(heavy).clusters).toBe(viewOf(skewed).clusters)
		expect(viewOf(inside).clusters).not.toBe(viewOf(skewed).clusters)
		expect(viewOf(inside).clusters).toHaveLength(1_500)
		expect(viewOf(inside).count).toBe(1_500)
	})

	// The half rule is asked in characters and in code units. A window over the
	// narrow half is half the characters but a twenty-second of the units, so it
	// must not share. Both bounds are asserted every turn, since a window pins
	// its text from the moment it is made.
	test("a drain over skewed clusters pins no more text than it holds", () => {
		let wide = `e${String.fromCodePoint(769).repeat(20)}`
		let skewed = createString(wide.repeat(2_000) + "a".repeat(2_000))
		let arrays = new Set<Array<string>>()
		let clustersHeld = 0
		let rest = skewed
		let turns = 0

		while (Number(length(rest).value) > 0 && turns < 4_010) {
			let view = viewOf(rest)
			let pinned = remembered(rest, "$viewText")

			if (!arrays.has(view.clusters)) {
				arrays.add(view.clusters)
				clustersHeld += view.clusters.length
			}

			expect(view.clusters.length).toBeLessThanOrEqual(2 * view.count)

			if (typeof pinned === "string") {
				expect(pinned.length).toBeLessThanOrEqual(2 * rest.value.length)
			}

			rest = slice(rest, createInteger(1), createInteger(1_000_000))
			turns++
		}

		expect(turns).toBe(4_000)
		expect(arrays.size).toBeLessThanOrEqual(24)
		expect(clustersHeld).toBeLessThan(5 * 4_000)
	})

	// A character read is one Array read however many cuts deep the String is.
	test("a window of a window shares the root's Array", () => {
		let text = createString("café ".repeat(CHARACTERS / 5))
		let once = slice(text, createInteger(1), createInteger(1_000_000))
		let twice = slice(once, createInteger(1), createInteger(1_000_000))
		let thrice = slice(twice, createInteger(1), createInteger(1_000_000))

		expect(viewOf(thrice).clusters).toBe(viewOf(text).clusters)
		expect(viewOf(thrice).start).toBe(3)
		expect(viewOf(thrice).count).toBe(CHARACTERS - 3)
	})

	// Releasing the parent's Array keeps a drain that splits from pinning the
	// String it drains.
	test("a walk over a window gives it characters of its own", () => {
		let text = createString("café ".repeat(CHARACTERS / 5))
		let window = slice(text, createInteger(1), createInteger(1_000_000))

		expect(viewOf(window).clusters).toBe(viewOf(text).clusters)

		split(window, createString(" "))

		expect(viewOf(window).clusters).not.toBe(viewOf(text).clusters)
		expect(viewOf(window).start).toBe(0)
		expect(viewOf(window).count).toBe(CHARACTERS - 1)
	})

	// Every turn is a new String, so a scan per turn would be quadratic. A String
	// with a view answers off the view. The scan remembers its answer on the
	// receiver, so the window is checked after the turn's questions.
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

	// A tokenizer compares its rest with a keyword every turn. `normalisedFormOf`
	// asks the view-aware question, and may remember the normal form, which is
	// the answer asked for.
	test("a drain comparing its rest never scans a window", () => {
		let rest = slice(
			createString("café ".repeat(CHARACTERS / 5)),
			createInteger(1),
			createInteger(1_000_000),
		)

		let turns = 0

		while (Number(length(rest).value) > 0 && turns < TURN_CAP) {
			let window = rest

			compare(window, createString("zzz"))
			rest = slice(window, createInteger(1), createInteger(1_000_000))
			turns++

			expect(remembered(window, "$isAscii")).toBeUndefined()
		}

		expect(turns).toBe(CHARACTERS - 1)
	})

	// `append` carries a refused mark as it carries an accepted one, since a join
	// holds every unit of both sides. Without it each turn would scan the whole
	// join so far, so the mark is asserted every turn.
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

	// A prefix test costs the prefix, so the clusters the drain holds stay
	// bounded.
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

// `compare` decides `is` over the NFC form, so a window equals a String written
// with the same characters.
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
