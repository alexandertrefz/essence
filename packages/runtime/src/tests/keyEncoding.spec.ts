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

// Every fast path in `keyEncoding.ts` rests on one claim: two keys that both
// encode share a text exactly when their equality calls them equal. So pairs
// are drawn at random from the values the language builds, over fixed seeds.

const asValue = (value: unknown) => value as AnyType
const integer = (value: number | bigint): IntegerType =>
	createInteger(BigInt(value))
const text = createString

// The branded witness the Compiler hands a Dictionary whose key Type uses the
// standard library's own `is`.
const equality = {
	is: (first: AnyType, second: AnyType) =>
		createBoolean(anyIs(first, second)),
	structural: true as const,
}

// The same equality unbranded, as a Namespace's own `is` arrives. A Dictionary
// built through it scans.
const scanning = { is: equality.is }

// The witness the Rewriter emits for a `List<T>` key: `List.is` curried
// with the item's witness, branded through `boundConformance`.
const listEquality = (item: unknown) =>
	boundConformance({ is: listIs, structural: true }, [item]) as {
		is: (
			first: AnyType,
			second: AnyType,
		) => ReturnType<typeof createBoolean>
		structural?: true
	}

// A text lives in an index of its own, so a String key spelling `l0:` and the
// empty List are two keys. Encodings compare as the store's indexes do.
const sameEncoding = (first: EncodedKey, second: EncodedKey): boolean =>
	typeof first === "object"
		? typeof second === "object" && first.text === second.text
		: typeof second !== "object" && first === second

// mulberry32, as `dictionaries.spec.ts` uses: no dependency, and the same
// sequence on every engine.
const seededRandom = (seed: number): (() => number) => {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) | 0

		let mixed = Math.imul(state ^ (state >>> 15), 1 | state)

		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
	}
}

// Two spellings of one accented String, built from code points so that no editor
// can normalise them into each other. The astral character is two code units.
const composedAccent = `caf${String.fromCodePoint(0xe9)}`
const decomposedAccent = `cafe${String.fromCodePoint(0x301)}`
const astral = "\u{1D11E}"

// Few leaves, overlapping on purpose: several spellings of one value, and values
// whose texts look alike. Mostly distinct leaves would draw mostly unequal pairs.
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
	// Payload-free Cases are interned per tag, so `Wrap<Integer>#None` and
	// `Wrap<String>#None` are one value and one text.
	asValue(createCase("Wrap#None")),
	asValue(createCase("Pair#Neither")),
]

// A value of the whole grammar, depth-limited. Lists are drawn zero to three
// wide, since the count in a List's head tells `[[1], [2]]` from `[[1, 2]]`.
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

		// Half the Lists are built by prepending, so the encoding meets a front
		// run as often as a flat box.
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
		// `Wrap` and `Pair` are generic Choices, whose equality asks a Type
		// Argument's witness per member. `Pair#Both` has two members, where a
		// text that did not name its members apart would show.
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

	// A Dictionary has no canonical text, so it must be declined, and a Record or
	// a List holding one must decline with it.
	return createDictionary<AnyType, AnyType>(
		[[text("k"), integer(Math.floor(random() * 3))]],
		equality,
	)
}

const seeds = [1, 2, 3, 5, 8, 13, 21, 34]

describe("the encoding agrees with the equality it stands in for", () => {
	// A text shared by two unequal keys merges two slots and loses an entry. Two
	// texts for one key open a second slot for it.
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

	// A `List<T>` key is compared by `List::is` through the item witness, and the
	// encoding stands in for both. So they must agree under a structural witness.
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

	// A generic Choice's derived `is` is `boundChoiceIs`, which routes each member
	// naming a Type Parameter through that Argument's witness. The encoding stands
	// in for it too. The descriptor names every payload member, since
	// `casesEqual` compares only the members it names.
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

	// A value holding a part with no text has none itself, so its slot stays on
	// the scan path. See "Finding a Dictionary key" in
	// packages/runtime/DEVELOPMENT.md.
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

// The same random writes down the encoded path and the scan path must leave the
// same entries in the same order. This catches an encoding that is injective
// but disagrees with `is`.
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

		// The order too, since a slot's place is part of what a Dictionary
		// promises.
		let encodedKeys = materialise(keysOf(encoded))
		let scannedKeys = materialise(keysOf(scanned))

		expect(encodedKeys.length).toBe(scannedKeys.length)

		for (let index = 0; index < encodedKeys.length; index++) {
			expect(anyIs(encodedKeys[index], scannedKeys[index])).toBeTrue()
		}

		expect(materialise(entriesOf(encoded)).length).toBe(
			materialise(entriesOf(scanned)).length,
		)

		// Every key ever written is asked of both, removed ones included. A key
		// the encoded path lost would answer nothing where the scan finds it.
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

// Attacks a generator is unlikely to draw, written down by hand.
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

	// A part keeps the cross-kind rules of the comparison it stands in for. An
	// Integer and the Rational it equals are one item, as are equivalent Strings.
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

	// A List built at the front holds its first items in a reversed run, so the
	// encoding reads the runs rather than the Array.
	test("a prepended List spells what the flat one spells", () => {
		let flat = createList([integer(1), integer(2), integer(3)])
		let built = prepend(
			prepend(createList([integer(3)]), integer(2)),
			integer(1),
		)

		expect(sameEncoding(textOf(flat), textOf(built))).toBeTrue()
	})
})

// A box read again after a newer box was derived from it shares its run Array.
// The encoding must spell the count the box stamped, not the Array's length, or
// a Dictionary would stop finding the key.
describe("a key read again after a newer value was derived from it", () => {
	test("keeps the text it had before the append", () => {
		let key = createList([integer(1), integer(2)])
		let before = encodeKey(key, equality) as EncodedKey

		append(key, integer(3))

		expect(
			sameEncoding(encodeKey(key, equality) as EncodedKey, before),
		).toBeTrue()
	})

	// Never encoded before the append, so no remembered text answers. The box
	// views two items of an Array that now holds three.
	test("spells its own two items, never having been encoded before", () => {
		let key = createList([integer(1), integer(2)])

		append(key, integer(3))

		expect(encodeKey(key, equality)).toEqual({ text: "l2:i1;i2;" })
	})

	// The same for a front run, which `prepend` grows the same way.
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

	// A prepended box shares its front run with the next prepend, and its own
	// count fixes where its view stops.
	test("keeps the text it had before a second prepend", () => {
		let base = prepend(createList([integer(2)]), integer(1))
		let before = encodeKey(base, equality) as EncodedKey

		prepend(base, integer(0))

		expect(
			sameEncoding(encodeKey(base, equality) as EncodedKey, before),
		).toBeTrue()
	})
})

// The Function `removeDuplicates(on:)` calls may append to the List being
// walked. A native fixes its item counts once, so the walk covers the items the
// box viewed when it began.
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

// A conditional conformance is structural only if every condition is. A brand
// from one structural condition would send a key down the encoded path past the
// other condition's written `is`.
describe("a conditional conformance branded across two conditions", () => {
	// Two Methods, since `boundConformance` also curries, whatever the brand:
	// each comes back handed the conditions as trailing Arguments.
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

	// The brand is the Namespace's claim, which the conditions can only take
	// away.
	test("is not branded when the method map never claimed it", () => {
		expect(
			boundConformance({ is: (...args: Array<unknown>) => args }, [
				branded,
				branded,
			]).structural,
		).toBeUndefined()
	})

	// Branded or not, both conditions arrive behind the call's own Arguments, in
	// order.
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
