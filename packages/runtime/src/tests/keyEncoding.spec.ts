import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import {
	createDictionary,
	entries as entriesOf,
	keys as keysOf,
	length as lengthOf,
	remove__overload$1 as removeAt,
	set as setAt,
	value__overload$1 as valueAt,
} from "../Dictionary"
import type { IntegerType } from "../Integer"
import { createInteger } from "../Integer"
import { anyIs, boundChoiceIs } from "../internalHelpers"
import type { EncodedKey } from "../keyEncoding"
import { encodeKey } from "../keyEncoding"
import type { ListType } from "../List"
import {
	append__overload$1 as append,
	createList,
	is as listIs,
	materialise,
	prepend__overload$1 as prepend,
	removeDuplicates__overload$2 as removeDuplicatesOn,
} from "../List"
import { createRational } from "../Rational"
import { createRecord } from "../Record"
import { createString } from "../String"
import {
	type AnyType,
	boundConformance,
	createCase,
	typeKeySymbol,
} from "../type"

// NOTE: THE DIFFERENTIAL SPEC FOR THE CANONICAL KEY ENCODING. Every fast path
// in `keyEncoding.ts` rests on one claim — two keys that both encode spell one
// text exactly when the equality they are compared by calls them equal — and
// the only way to hold a claim of that shape is to draw values at random from
// the grammar the language can build and check every pair. The seeds are fixed,
// so a failure is reproducible and a green run is the same green run tomorrow.

const asValue = (value: unknown) => value as AnyType
const integer = (value: number | bigint): IntegerType =>
	createInteger(BigInt(value))
const text = createString

// NOTE: The branded structural witness, which is what the Compiler hands a
// Dictionary whose key Type's `is` is the standard library's own. `anyIs` is
// that equality for every kind these tests draw.
const equality = {
	is: (first: AnyType, second: AnyType) =>
		createBoolean(anyIs(first, second)),
	structural: true as const,
}

// NOTE: The same equality with NO brand — the shape a Namespace-written `is`
// arrives in. A Dictionary built through it answers the same things by
// scanning, which is what the differential below holds the encoded path
// against.
const scanning = { is: equality.is }

// NOTE: The witness the Rewriter emits for a `List<T>` key: `List.is` curried
// with the item's witness, branded through `boundConformance`.
const listEquality = (item: unknown) =>
	boundConformance({ is: listIs, structural: true }, [item]) as {
		is: (
			first: AnyType,
			second: AnyType,
		) => ReturnType<typeof createBoolean>
		structural?: true
	}

// NOTE: The rule the STORE routes an encoding by, written out: a text lives in
// an index of its own, so a String key spelling `l0:` and the empty List are
// two keys however alike the two texts read. Anything that compares encodings
// has to compare them the way the two indexes do.
const sameEncoding = (first: EncodedKey, second: EncodedKey): boolean =>
	typeof first === "object"
		? typeof second === "object" && first.text === second.text
		: typeof second !== "object" && first === second

// NOTE: mulberry32 — four lines, no dependency, and the same sequence on every
// engine, which is the whole of what a test needs of a generator. It is the one
// `dictionaries.spec.ts` draws its chains with.
const seededRandom = (seed: number): (() => number) => {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) | 0

		let mixed = Math.imul(state ^ (state >>> 15), 1 | state)

		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
	}
}

// NOTE: The two spellings of one accented String, BUILT from their code points
// rather than written down, and an astral character, which is two code units
// and so two of whatever a length prefix counts.
//
// NOTE: Built rather than written because `oxfmt` rewrites a `é` escape as
// the character it spells — which would leave the composed and the decomposed
// forms standing side by side in the source as two runs of bytes that an
// editor, a diff tool or a later formatter may normalise into each other. A
// pair of constants that quietly became one would take the NFC half of this
// spec with it and leave every test green. `String.fromCodePoint` can not be
// normalised.
const composedAccent = `caf${String.fromCodePoint(0xe9)}`
const decomposedAccent = `cafe${String.fromCodePoint(0x301)}`
const astral = "\u{1D11E}"

// NOTE: THE LEAVES. Deliberately FEW and deliberately overlapping: several
// spellings of one value (`3` and `3/1` and `6/2`, the two accents), and
// several values that spell texts looking like one another's (`"a,b"` beside
// `"a"` and `"b"`, a String holding what an encoded List of one Integer reads
// as). A grammar of mostly-distinct leaves would draw mostly-unequal pairs and
// prove nothing.
const leaves: Array<AnyType> = [
	integer(0),
	integer(1),
	integer(2),
	integer(3),
	integer(12),
	integer(23),
	integer(9007199254740993n),
	createRational(1n, 2n),
	createRational(2n, 4n),
	createRational(3n, 1n),
	createRational(6n, 2n),
	createRational(-1n, 2n),
	createRational(1n, -2n),
	createRational(0n, 5n),
	createRational(9007199254740993n, 1n),
	text(""),
	text("a"),
	text("b"),
	text("a,b"),
	text("l1:i1;"),
	text("l0:"),
	text("i1;"),
	text(composedAccent),
	text(decomposedAccent),
	text(astral),
	createBoolean(true),
	createBoolean(false),
	asValue(createCase("Colour#Red")),
	asValue(createCase("Colour#Blue")),
	// NOTE: The payload-free Cases of the two GENERIC Choices below. They are
	// interned per tag, so `Wrap<Integer>#None` and `Wrap<String>#None` are one
	// value and one text — which is why no instantiation can be told from
	// another here, and why none has to be.
	asValue(createCase("Wrap#None")),
	asValue(createCase("Pair#Neither")),
]

// NOTE: A value of the whole grammar, depth-limited. A List is drawn at every
// width the attacks below care about — none, one, two, three — because the
// count in its head is what tells `[[1], [2]]` from `[[1, 2]]`, and a fuzzer
// that never drew two widths of the same items could not meet that pair.
function draw(random: () => number, depth: number): AnyType {
	let roll = random()

	if (depth === 0 || roll < 0.5) {
		return leaves[Math.floor(random() * leaves.length)]
	}

	if (roll < 0.72) {
		let width = Math.floor(random() * 4)
		let items: Array<AnyType> = []

		for (let index = 0; index < width; index++) {
			items.push(draw(random, depth - 1))
		}

		// NOTE: Half of the Lists are built by PREPENDING, so the encoding
		// meets a box carrying a front run as often as it meets a flat one.
		// Two Lists holding the same items are one key whichever way round
		// they are stored, and a reader that walked only the back Array would
		// have spelled the front's items away.
		if (random() < 0.5) {
			let built = createList<AnyType>([])

			for (let index = items.length - 1; index >= 0; index--) {
				built = prepend(built, items[index])
			}

			return built
		}

		return createList(items)
	}

	if (roll < 0.86) {
		let members: Record<string, AnyType> = { a: draw(random, depth - 1) }

		if (random() < 0.5) {
			members.b = draw(random, depth - 1)
		}

		if (random() < 0.3) {
			members.items = draw(random, depth - 1)
		}

		return createRecord(members)
	}

	if (roll < 0.96) {
		// NOTE: Three Cases carrying a payload, and two of the three are the
		// Cases of a GENERIC Choice — one member and two. A generic Choice's
		// derived equality asks a Type Argument's witness at each member naming
		// a Type Parameter, so the encoding has to agree with THAT as well as
		// with `anyIs`, and the two-member Case is where a text that forgot to
		// name its members apart would show.
		let shape = random()

		if (shape < 0.34) {
			return asValue(
				createCase("Box#Full", { item: draw(random, depth - 1) }),
			)
		}

		if (shape < 0.67) {
			return asValue(
				createCase("Wrap#Some", { item: draw(random, depth - 1) }),
			)
		}

		return asValue(
			createCase("Pair#Both", {
				left: draw(random, depth - 1),
				right: draw(random, depth - 1),
			}),
		)
	}

	// NOTE: A Dictionary has no canonical text — its entries are organised by a
	// store of its own and its equality is order-insensitive — so it is here to
	// be DECLINED, and to check that a Record or a List holding one declines
	// with it rather than spelling a text that ignores it.
	return createDictionary<AnyType, AnyType>(
		[[text("k"), integer(Math.floor(random() * 3))]],
		equality,
	)
}

const seeds = [1, 2, 3, 5, 8, 13, 21, 34]

describe("the encoding agrees with the equality it stands in for", () => {
	// NOTE: THE CLAIM ITSELF, over every pair of a drawn population. Both
	// directions matter and they fail differently: a text two unequal keys
	// share MERGES two slots and loses an entry, and two texts one pair of
	// equal keys is split across opens a second slot for a key the Dictionary
	// already holds.
	test.each(seeds)("no pair is merged or split, seed %i", (seed) => {
		let random = seededRandom(seed)
		let population: Array<AnyType> = []

		for (let index = 0; index < 140; index++) {
			population.push(draw(random, 3))
		}

		let compared = 0

		for (let first = 0; first < population.length; first++) {
			for (let second = first; second < population.length; second++) {
				let left = population[first]
				let right = population[second]
				let encodedLeft = encodeKey(left, equality)
				let encodedRight = encodeKey(right, equality)

				if (encodedLeft === null || encodedRight === null) {
					continue
				}

				compared++

				expect(sameEncoding(encodedLeft, encodedRight)).toBe(
					anyIs(left, right),
				)
			}
		}

		expect(compared).toBeGreaterThan(1000)
	})

	// NOTE: And the witness path beside it. A `List<T>` key is compared by
	// `List::is` through the item witness rather than by `anyIs`, and the
	// encoding stands in for BOTH — so the two have to answer alike wherever
	// the item witness is the structural one.
	test.each(seeds)("List::is answers what anyIs answers, seed %i", (seed) => {
		let random = seededRandom(seed)
		let lists: Array<ListType<AnyType>> = []

		while (lists.length < 60) {
			let drawn = draw(random, 3)

			if (drawn[typeKeySymbol] === "List") {
				lists.push(drawn as ListType<AnyType>)
			}
		}

		for (let first = 0; first < lists.length; first++) {
			for (let second = first; second < lists.length; second++) {
				expect(
					listIs(lists[first], lists[second], equality).value,
				).toBe(anyIs(lists[first], lists[second]))
			}
		}
	})

	// NOTE: AND THE WITNESS A GENERIC CHOICE IS ACTUALLY COMPARED BY. A generic
	// Choice's derived `is` is not `anyIs` — it is `boundChoiceIs` walking a
	// descriptor that routes each member naming a Type Parameter through that
	// Argument's own witness and compares the rest by the universal rule. The
	// encoding stands in for THAT, so the two have to answer alike over every
	// pair, exactly as `List::is` does above.
	//
	// NOTE: The descriptor names EVERY payload member, because a member it does
	// not name is a member `casesEqual` never compares — so a descriptor that
	// forgot one would call two different keys equal, and the encoding, which
	// spells every member, would not. That is the disagreement this draws for.
	const genericChoice = boundChoiceIs({
		"Wrap#Some": { item: { k: "w", i: 0 } },
		"Wrap#None": {},
		"Pair#Both": { left: { k: "w", i: 0 }, right: { k: "w", i: 1 } },
		"Pair#Neither": {},
	})

	test.each(seeds)(
		"a generic Choice's derived is answers what anyIs answers, seed %i",
		(seed) => {
			let random = seededRandom(seed)
			let cases: Array<AnyType> = []

			while (cases.length < 60) {
				let drawn = draw(random, 3)
				let tag = drawn[typeKeySymbol]

				if (typeof tag === "string" && tag.startsWith("Wrap#")) {
					cases.push(drawn)
				} else if (typeof tag === "string" && tag.startsWith("Pair#")) {
					cases.push(drawn)
				}
			}

			let compared = 0

			for (let first = 0; first < cases.length; first++) {
				for (let second = first; second < cases.length; second++) {
					let left = cases[first]!
					let right = cases[second]!

					expect(
						genericChoice(left, right, equality, equality).value,
					).toBe(anyIs(left, right))

					let encodedLeft = encodeKey(left, equality)
					let encodedRight = encodeKey(right, equality)

					if (encodedLeft === null || encodedRight === null) {
						continue
					}

					compared++

					expect(sameEncoding(encodedLeft, encodedRight)).toBe(
						genericChoice(left, right, equality, equality).value,
					)
				}
			}

			expect(compared).toBeGreaterThan(200)
		},
	)

	// NOTE: A value holding a part with no text has no text itself, which is
	// the whole of what keeps a Dictionary correct where one key encodes and
	// another does not: the store keeps both kinds of slot and falls through to
	// the scan for the second.
	test.each(seeds)(
		"a held Dictionary declines all the way up, seed %i",
		(seed) => {
			let random = seededRandom(seed)
			let declined = 0

			for (let index = 0; index < 400; index++) {
				let drawn = draw(random, 3)

				if (holdsADictionary(drawn)) {
					declined++

					expect(encodeKey(drawn, equality)).toBeNull()
				}
			}

			expect(declined).toBeGreaterThan(0)
		},
	)
})

function holdsADictionary(value: AnyType): boolean {
	if (typeof value === "function") {
		return false
	}

	let tag = value[typeKeySymbol]

	if (tag === "Dictionary") {
		return true
	}

	if (tag === "List") {
		return materialise(value as ListType<AnyType>).some(holdsADictionary)
	}

	if (typeof tag === "string" && (tag === "Record" || tag.includes("#"))) {
		return Object.keys(value).some((name) =>
			holdsADictionary((value as Record<string, AnyType>)[name]),
		)
	}

	return false
}

// NOTE: THE OTHER DIFFERENTIAL — a Dictionary driven by random writes down the
// ENCODED path against the very same writes down the SCAN path. The two
// witnesses decide the same equality and differ only in the brand, so the two
// boxes have to hold the same entries in the same order and answer the same
// thing for every key. This is the test that would catch an encoding that is
// injective and still disagrees with `is`.
describe("the encoded path answers what the scan path answers", () => {
	test.each(seeds)("a random chain of writes agrees, seed %i", (seed) => {
		let random = seededRandom(seed)
		let keys: Array<AnyType> = []

		for (let index = 0; index < 30; index++) {
			keys.push(draw(random, 3))
		}

		let encoded = createDictionary<AnyType, AnyType>([], equality)
		let scanned = createDictionary<AnyType, AnyType>([], scanning)

		for (let step = 0; step < 240; step++) {
			let key = keys[Math.floor(random() * keys.length)]
			let roll = random()

			if (roll < 0.62) {
				let value = integer(step)

				encoded = setAt(encoded, key, value, equality)
				scanned = setAt(scanned, key, value, scanning)
			} else if (roll < 0.8) {
				encoded = removeAt(encoded, key, equality)
				scanned = removeAt(scanned, key, scanning)
			}

			expect(lengthOf(encoded).value).toBe(lengthOf(scanned).value)
			expect(heldOf(valueAt(encoded, key, equality))).toBe(
				heldOf(valueAt(scanned, key, scanning)),
			)
		}

		// NOTE: The ORDER as well as the entries, because a slot's place is
		// part of what a Dictionary promises and the two paths open slots
		// through different code.
		let encodedKeys = materialise(keysOf(encoded))
		let scannedKeys = materialise(keysOf(scanned))

		expect(encodedKeys.length).toBe(scannedKeys.length)

		for (let index = 0; index < encodedKeys.length; index++) {
			expect(anyIs(encodedKeys[index], scannedKeys[index])).toBeTrue()
		}

		expect(materialise(entriesOf(encoded)).length).toBe(
			materialise(entriesOf(scanned)).length,
		)

		// NOTE: And every key ever written asked of both, including the ones
		// that were removed — a key the encoded path lost track of answers
		// nothing where the scan still finds it, and that is the failure this
		// whole file is for.
		for (let key of keys) {
			expect(heldOf(valueAt(encoded, key, equality))).toBe(
				heldOf(valueAt(scanned, key, scanning)),
			)
		}
	})
})

function heldOf(answer: {
	[typeKeySymbol]: string
	item?: AnyType
}): number | undefined {
	return answer[typeKeySymbol] === "Optional#Empty"
		? undefined
		: Number((answer.item as IntegerType).value)
}

// NOTE: The attacks a generator is unlikely to draw and a reader is likely to
// worry about, written down by hand so they are named rather than hoped for.
describe("the injectivity attacks, by hand", () => {
	const textOf = (value: AnyType): EncodedKey =>
		encodeKey(value, equality) as EncodedKey

	test("digits that run together are kept apart by the terminator", () => {
		expect(
			sameEncoding(
				textOf(createList([integer(1), integer(23)])),
				textOf(createList([integer(12), integer(3)])),
			),
		).toBeFalse()
	})

	test("a String holding a separator is one item, not two", () => {
		expect(
			sameEncoding(
				textOf(createList([text("a,b")])),
				textOf(createList([text("a"), text("b")])),
			),
		).toBeFalse()
	})

	test("nesting is told apart by the count in each head", () => {
		expect(
			sameEncoding(
				textOf(
					createList([
						createList([integer(1)]),
						createList([integer(2)]),
					]),
				),
				textOf(createList([createList([integer(1), integer(2)])])),
			),
		).toBeFalse()
		expect(
			sameEncoding(
				textOf(createList([createList([])])),
				textOf(createList([])),
			),
		).toBeFalse()
		expect(
			sameEncoding(
				textOf(createList([createList([]), createList([])])),
				textOf(createList([createList([createList([])])])),
			),
		).toBeFalse()
	})

	test("a String item can not be read as the List it imitates", () => {
		expect(
			sameEncoding(
				textOf(createList([text("l1:i1;")])),
				textOf(createList([createList([integer(1)])])),
			),
		).toBeFalse()
		expect(
			sameEncoding(textOf(text("l0:")), textOf(createList([]))),
		).toBeFalse()
	})

	test("a Record holding a List is not the List holding the Record", () => {
		expect(
			sameEncoding(
				textOf(createRecord({ a: createList([integer(1)]) })),
				textOf(createList([createRecord({ a: integer(1) })])),
			),
		).toBeFalse()
	})

	test("an empty List of any items is one key", () => {
		expect(
			sameEncoding(textOf(createList([])), textOf(createList([]))),
		).toBeTrue()
		expect(anyIs(createList([]), createList([]))).toBeTrue()
	})

	// NOTE: The cross-kind rules a part inherits from the comparison it stands
	// in for: an Integer and the whole Rational it equals are one item, and two
	// canonically equivalent Strings are one item.
	test("a List spells the cross-kind rules its items are compared by", () => {
		expect(
			sameEncoding(
				textOf(createList([integer(3)])),
				textOf(createList([createRational(6n, 2n)])),
			),
		).toBeTrue()
		expect(
			sameEncoding(
				textOf(createList([text(composedAccent)])),
				textOf(createList([text(decomposedAccent)])),
			),
		).toBeTrue()
	})

	// NOTE: A List built at the front holds its first items in a second run,
	// stored reversed. Two Lists holding the same items are one key whichever
	// way round they are stored, so the encoding has to read the runs rather
	// than the Array.
	test("a prepended List spells what the flat one spells", () => {
		let flat = createList([integer(1), integer(2), integer(3)])
		let built = prepend(
			prepend(createList([integer(3)]), integer(2)),
			integer(1),
		)

		expect(sameEncoding(textOf(flat), textOf(built))).toBeTrue()
	})
})

// NOTE: PERSISTENT USE. A List box is read again after a newer box was derived
// from it, and the two share a run Array: `append` pushes onto the very Array
// the older box views, and what keeps the older box honest is the count it
// stamped rather than the Array's length. An encoding that asked the Array how
// long it was would have started spelling items that were never added to the
// key — and a Dictionary would have stopped finding the key it holds.
describe("a key read again after a newer value was derived from it", () => {
	test("keeps the text it had before the append", () => {
		let key = createList([integer(1), integer(2)])
		let before = encodeKey(key, equality) as EncodedKey

		append(key, integer(3))

		expect(
			sameEncoding(encodeKey(key, equality) as EncodedKey, before),
		).toBeTrue()
	})

	// NOTE: The same claim for a box that was NEVER encoded before the append,
	// which is the half the memo can not answer for: the one above would pass
	// on a remembered text however the walk read the run, and only this one
	// asks what the walk reads. The box views two items of an Array that now
	// holds three.
	test("spells its own two items, never having been encoded before", () => {
		let key = createList([integer(1), integer(2)])

		append(key, integer(3))

		expect(encodeKey(key, equality)).toEqual({ text: "l2:i1;i2;" })
	})

	// NOTE: And the same for a front run, which `prepend` grows the same way.
	test("spells its own front items after a second prepend", () => {
		let base = prepend(createList([integer(2)]), integer(1))

		prepend(base, integer(0))

		expect(encodeKey(base, equality)).toEqual({ text: "l2:i1;i2;" })
	})

	test("keeps finding its entry in a Dictionary after the append", () => {
		let witness = listEquality(equality)
		let key = createList([integer(1), integer(2)])
		let box = setAt(
			createDictionary<AnyType, AnyType>([], witness),
			key,
			integer(10),
			witness,
		)
		let longer = append(key, integer(3))

		expect(heldOf(valueAt(box, key, witness))).toBe(10)
		expect(heldOf(valueAt(box, longer, witness))).toBeUndefined()
		expect(
			heldOf(valueAt(box, createList([integer(1), integer(2)]), witness)),
		).toBe(10)
	})

	// NOTE: The same in the other direction — a box that PREPENDED shares its
	// front run with whatever prepends next, and its own count is what fixes
	// where its view of that run stops.
	test("keeps the text it had before a second prepend", () => {
		let base = prepend(createList([integer(2)]), integer(1))
		let before = encodeKey(base, equality) as EncodedKey

		prepend(base, integer(0))

		expect(
			sameEncoding(encodeKey(base, equality) as EncodedKey, before),
		).toBeTrue()
	})
})

// NOTE: REENTRANT USE. `removeDuplicates(on:)` takes a Function, and a Function
// may append to the very List being walked — `List.ts` states the rule: a
// native fixes its item counts once and never asks a run Array for its length
// again. The keys are encoded inside that walk, so the walk has to cover the
// items the box viewed when it started, exactly as it did when every operation
// copied.
describe("a callback that edits the List being walked", () => {
	test("covers the items the receiver viewed when the walk began", () => {
		let items = createList([integer(1), integer(2), integer(3)])
		let seen: Array<number> = []
		let answer = removeDuplicatesOn(
			items,
			(item) => {
				seen.push(Number((item as IntegerType).value))

				append(items, integer(99))

				return createList([item])
			},
			listEquality(equality),
		)

		expect(seen).toEqual([1, 2, 3])
		expect(materialise(answer).length).toBe(3)
	})
})

// NOTE: The brand on a CONDITIONAL conformance means "structural if the
// conditions are", and `boundConformance` settles that with `every`. `Result`
// and a generic Choice's derived witness can carry two conditions, and a
// two-condition conformance branded because ONE of its conditions is structural
// would send a key down the encoded path while the other condition's written
// `is` is what the Program asked for. So the rule is held here directly, with
// both conditions branded, each one alone, and neither.
describe("a conditional conformance branded across two conditions", () => {
	// NOTE: Two Methods, because the currying is the other half of what
	// `boundConformance` does and it must not change with the brand: whatever
	// the conditions say about `structural`, both entries come back as
	// Functions that were handed the conditions as trailing Arguments.
	const twoConditions = (first: unknown, second: unknown) =>
		boundConformance(
			{
				is: (...args: Array<unknown>) => args,
				isNot: (...args: Array<unknown>) => args,
				structural: true,
			},
			[first, second],
		)

	const branded = { is: equality.is, structural: true as const }
	const written = { is: equality.is }

	test("is branded when both conditions are", () => {
		expect(twoConditions(branded, branded).structural).toBe(true)
	})

	test("is not branded when only the first condition is", () => {
		expect(twoConditions(branded, written).structural).toBeUndefined()
	})

	test("is not branded when only the second condition is", () => {
		expect(twoConditions(written, branded).structural).toBeUndefined()
	})

	test("is not branded when neither condition is", () => {
		expect(twoConditions(written, written).structural).toBeUndefined()
	})

	// NOTE: And a map that never carried the brand does not gain one from its
	// conditions — the brand is the NAMESPACE's claim, which the conditions can
	// only take away.
	test("is not branded when the method map never claimed it", () => {
		expect(
			boundConformance({ is: (...args: Array<unknown>) => args }, [
				branded,
				branded,
			]).structural,
		).toBeUndefined()
	})

	// NOTE: The currying, unchanged in the branded case and the refused one
	// alike. Both conditions arrive behind the call's own Arguments, in order.
	test("curries both conditions onto every Method either way", () => {
		for (let [first, second] of [
			[branded, branded],
			[branded, written],
		]) {
			let witness = twoConditions(first, second)

			for (let name of ["is", "isNot"]) {
				expect(
					(witness[name] as (...args: Array<unknown>) => unknown)(
						"receiver",
					),
				).toEqual(["receiver", first, second])
			}
		}
	})
})
