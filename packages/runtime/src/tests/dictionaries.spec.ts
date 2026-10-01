import { describe, expect, test } from "bun:test"

import { createAlgebraic } from "../Algebraic"
import { createBoolean } from "../Boolean"
import type { DictionaryType, EntryRecord, Slot } from "../Dictionary"
import {
	createDictionary,
	createDictionaryFrom,
	entries as entriesOf,
	everyEntry,
	is as dictionaryIs,
	isEmpty,
	keys as keysOf,
	length as lengthOf,
	map as mapEntries,
	of__overload$1 as dictionaryOf,
	remove__overload$1 as removeAt,
	removeEvery,
	set as setAt,
	TOMBSTONE,
	toString as dictionaryToString,
	value__overload$1 as valueAt,
	values as valuesOf,
} from "../Dictionary"
import { type Generator, generate } from "../Generators"
import { group, tally } from "../GroupedList"
import type { IntegerType } from "../Integer"
import { createInteger } from "../Integer"
import { anyIs, boundChoiceIs } from "../internalHelpers"
import { encodeKey } from "../keyEncoding"
import type { ListType } from "../List"
import {
	createList,
	is as listIs,
	materialise,
	prepend__overload$1 as prepend,
} from "../List"
import type { OptionalType } from "../Optional"
import { below, createRandomness, seedOf } from "../Randomness"
import { createRational, formatAsFraction } from "../Rational"
import type { RecordType } from "../Record"
import { createRecord } from "../Record"
import type { StringType } from "../String"
import { createString, itemText } from "../String"
import { getStringRepresentation } from "../Terminal"
import {
	type AnyType,
	boundConformance,
	createCase,
	isValueOfType,
	typeKeySymbol,
} from "../type"

// `CaseInstanceType` stays out of `AnyType`, so a Case value is cast here as the
// runtime helpers cast it.
const asValue = (value: unknown) => value as AnyType

const integer = (value: number): IntegerType => createInteger(BigInt(value))
const text = createString

// Two spellings of one String, written as code points so the file can not
// normalise them. `String.compare` reads the NFC form, so a Dictionary holds
// them under one key.
const composedAccent = "caf\u00E9"
const decomposedAccent = "cafe\u0301"

// `anyIs` decides what the covering Namespace's `is` decides for every kind
// here, including the cross-kind rules a key encoding must agree with. It is
// branded `structural`, as the Compiler brands the standard library's own
// equality and nothing a Namespace wrote, so the runtime may encode its keys.
const equality = {
	is: (first: AnyType, second: AnyType) =>
		createBoolean(anyIs(first, second)),
	structural: true as const,
}

// The same equality unbranded, as a Namespace-written `is` arrives. It holds
// the same entries, but is asked rather than encoded.
const witnessed = {
	is: equality.is,
}

// A witness coarser than the encoding: Strings that differ only in case are one
// key, as a Namespace `for NonEmptyString is Equatable` may decide.
const looseText = {
	is: (first: AnyType, second: AnyType) =>
		createBoolean(
			first[typeKeySymbol] === "String" &&
				second[typeKeySymbol] === "String" &&
				(first as StringType).value.toLowerCase() ===
					(second as StringType).value.toLowerCase(),
		),
}

// The Printable witness `Record.toString` builds, whose fraction formatter
// prints a whole Rational as its numerator. `itemText` quotes a String itself.
const printing = {
	toString: (value: AnyType) =>
		createString(getStringRepresentation(value, 0, formatAsFraction, "")),
}

// A witness coarser than structural equality: Records with matching `id`
// members are one key. So it tests the scan path rather than `anyIs` again.
const byIdentifier = {
	is: (first: AnyType, second: AnyType) =>
		createBoolean(
			anyIs((first as RecordType).id, (second as RecordType).id),
		),
}

const dictionary = (
	...pairs: Array<[AnyType, AnyType]>
): DictionaryType<AnyType, AnyType> => createDictionary(pairs, equality)

const entry = (key: AnyType, value: AnyType): EntryRecord<AnyType, AnyType> =>
	createRecord({ key, value }) as EntryRecord<AnyType, AnyType>

// The Dictionary `createDictionaryFrom` answered with, where the test is
// about what it built rather than about the duplicate key it can answer instead.
const built = (
	answer: DictionaryType<AnyType, AnyType> | number,
): DictionaryType<AnyType, AnyType> => {
	if (typeof answer === "number") {
		throw new Error(`the entry at ${answer} held a duplicate key`)
	}

	return answer
}

// The order tests assert the written form, which shows the live entries and
// their order in one line.
const writtenForm = (dictionaryInstance: DictionaryType<AnyType, AnyType>) =>
	dictionaryToString(dictionaryInstance, printing, printing).value

const heldNumber = (answer: OptionalType<AnyType>): number => {
	if (answer[typeKeySymbol] === "Optional#Empty") {
		throw new Error("the Optional held nothing")
	}

	return Number((answer.item as IntegerType).value)
}

const heldOf = (answer: OptionalType<AnyType>): AnyType | undefined =>
	answer[typeKeySymbol] === "Optional#Empty" ? undefined : answer.item

const textOf = (value: AnyType): string => (value as StringType).value

const numberOf = (value: AnyType): number =>
	Number((value as IntegerType).value)

const slotFor = (
	dictionaryInstance: DictionaryType<AnyType, AnyType>,
	key: AnyType,
): Slot<AnyType, AnyType> => {
	let found = dictionaryInstance.store.slots.find((slot) =>
		anyIs(slot.key, key),
	)

	if (found === undefined) {
		throw new Error("the store holds no slot for that key")
	}

	return found
}

// A String-keyed Dictionary built by a chain of writes, as a Program grows one,
// so the repacking tests see the shape a real chain leaves.
const chainOf = (count: number): DictionaryType<AnyType, AnyType> => {
	let box = dictionary()

	for (let index = 0; index < count; index++) {
		box = setAt(box, text(`k${index}`), integer(index), equality)
	}

	return box
}

describe("key encoding", () => {
	// Two keys encode alike exactly when the kind's own `is` calls them equal.
	test("a String encodes as its NFC-normalised text", () => {
		expect(encodeKey(text("alex"), equality)).toBe("alex")
		expect(encodeKey(text(""), equality)).toBe("")
	})

	test("canonically equivalent Strings encode alike", () => {
		expect(anyIs(text(composedAccent), text(decomposedAccent))).toBeTrue()
		expect(composedAccent).not.toBe(decomposedAccent)
		expect(encodeKey(text(composedAccent), equality)).toBe(composedAccent)
		expect(encodeKey(text(decomposedAccent), equality)).toBe(composedAccent)
	})

	test("an Integer encodes as the value it holds, on both sides of the hybrid boundary", () => {
		expect(encodeKey(integer(3), equality)).toBe(3)
		expect(encodeKey(createInteger(0), equality)).toBe(0)
		expect(encodeKey(createInteger(9007199254740991n), equality)).toBe(
			9007199254740991,
		)
		expect(encodeKey(createInteger(9007199254740992n), equality)).toBe(
			9007199254740992n,
		)
		expect(encodeKey(createInteger(-9007199254740992n), equality)).toBe(
			-9007199254740992n,
		)
	})

	test("a whole Rational encodes as the Integer it equals", () => {
		expect(encodeKey(createRational(3n, 1n), equality)).toBe(3)
		expect(encodeKey(createRational(6n, 2n), equality)).toBe(3)
		expect(encodeKey(createRational(-6n, -2n), equality)).toBe(3)
		expect(encodeKey(createRational(3n, 1n), equality)).toBe(
			encodeKey(integer(3), equality),
		)
		expect(encodeKey(createRational(0n, 5n), equality)).toBe(0)
	})

	test("a whole Rational past the hybrid boundary encodes as the bigint an Integer does", () => {
		expect(encodeKey(createRational(9007199254740992n, 1n), equality)).toBe(
			9007199254740992n,
		)
		expect(
			encodeKey(createRational(18014398509481984n, 2n), equality),
		).toBe(9007199254740992n)
	})

	test("a non-whole Rational encodes as its reduced parts in a box of their own", () => {
		expect(encodeKey(createRational(1n, 2n), equality)).toEqual({
			text: "1/2",
		})
		expect(encodeKey(createRational(2n, 4n), equality)).toEqual({
			text: "1/2",
		})
		expect(encodeKey(createRational(-1n, 2n), equality)).toEqual({
			text: "-1/2",
		})
		expect(encodeKey(createRational(1n, -2n), equality)).toEqual({
			text: "-1/2",
		})
		expect(encodeKey(createRational(2n, -4n), equality)).toEqual(
			encodeKey(createRational(-1n, 2n), equality),
		)
	})

	// A registry Symbol would live as long as the process. Two encodings of one
	// value are two objects, held only by the store's index.
	test("a Rational's encoding is not held by anything process-wide", () => {
		let first = encodeKey(createRational(1n, 3n), equality)
		let second = encodeKey(createRational(2n, 6n), equality)

		expect(typeof first).not.toBe("symbol")
		expect(first).not.toBe(second)
		expect(first).toEqual(second)
	})

	// A String encodes into `index` and a fraction into `texts`, so a String
	// `1/2` and the Rational `1/2` stay apart.
	test("a Rational's encoding can not collide with a String key", () => {
		let held = dictionary(
			[createRational(1n, 2n), text("rational")],
			[text("1/2"), text("string")],
		)

		expect(lengthOf(held).value).toBe(2)
		expect(
			textOf(
				heldOf(
					valueAt(held, createRational(1n, 2n), equality),
				) as AnyType,
			),
		).toBe("rational")
		expect(
			textOf(heldOf(valueAt(held, text("1/2"), equality)) as AnyType),
		).toBe("string")
	})

	test("a Boolean encodes as the primitive it holds", () => {
		expect(encodeKey(createBoolean(true), equality)).toBe(true)
		expect(encodeKey(createBoolean(false), equality)).toBe(false)
	})

	// A Case's text opens with its length-prefixed tag and closes over its
	// members, and a Record's opens with `R`. Every part is length-prefixed or
	// terminated, so each value has one text.
	test("a unit Case encodes as its tag, in a box of its own", () => {
		expect(encodeKey(asValue(createCase("Colour#Red")), equality)).toEqual({
			text: "c10:Colour#Red{};",
		})
		expect(
			encodeKey(asValue(createCase("./Paint.es#Colour#Red")), equality),
		).toEqual({ text: "c21:./Paint.es#Colour#Red{};" })
	})

	test("a Case with a payload encodes its tag and every member", () => {
		expect(
			encodeKey(
				asValue(createCase("Box#Full", { item: integer(1) })),
				equality,
			),
		).toEqual({ text: "c8:Box#Full{4:item=i1;};" })
		expect(
			encodeKey(
				asValue(
					createCase("Shape#Circle", {
						centre: createRecord({ x: integer(0), y: integer(-2) }),
						radius: createRational(1n, 2n),
						label: text("unit"),
						filled: createBoolean(true),
					}),
				),
				equality,
			),
		).toEqual({
			text: "c12:Shape#Circle{6:centre=R{1:x=i0;1:y=i-2;};6:filled=t;5:label=s4:unit6:radius=r1/2;};",
		})
	})

	test("a Record encodes its members in name order", () => {
		expect(encodeKey(createRecord({ x: integer(1) }), equality)).toEqual({
			text: "R{1:x=i1;};",
		})
		expect(
			encodeKey(createRecord({ b: integer(2), a: integer(1) }), equality),
		).toEqual(
			encodeKey(createRecord({ a: integer(1), b: integer(2) }), equality),
		)
	})

	// A part spells what the structural comparison calls it. A whole Rational is
	// its Integer, a String its NFC form, and a nested Case its tag and members.
	test("a part of a composite key spells the cross-kind rules", () => {
		let whole = encodeKey(
			createRecord({ n: createRational(6n, 2n) }),
			equality,
		)
		let accented = encodeKey(
			createRecord({ s: text(decomposedAccent) }),
			equality,
		)

		expect(whole).toEqual(
			encodeKey(createRecord({ n: integer(3) }), equality),
		)
		expect(accented).toEqual(
			encodeKey(createRecord({ s: text(composedAccent) }), equality),
		)
		expect(
			encodeKey(
				createRecord({ inner: asValue(createCase("Colour#Red")) }),
				equality,
			),
		).toEqual({ text: "R{5:inner=c10:Colour#Red{};};" })
	})

	// A List spells its count and then its items. The counts alone tell
	// `[[1], [2]]` from `[[1, 2]]`.
	test("a List encodes its count and then its items", () => {
		expect(
			encodeKey(createList([integer(1), integer(23)]), equality),
		).toEqual({ text: "l2:i1;i23;" })
		expect(encodeKey(createList([]), equality)).toEqual({ text: "l0:" })
		expect(
			encodeKey(
				createList([
					createList([integer(1)]),
					createList([integer(2)]),
				]),
				equality,
			),
		).not.toEqual(
			encodeKey(
				createList([createList([integer(1), integer(2)])]),
				equality,
			),
		)
		expect(encodeKey(createList([createList([])]), equality)).not.toEqual(
			encodeKey(createList([]), equality),
		)
	})

	// A Record or a Case holding a List encodes it through the same text.
	test("a composite holding a List encodes through the same text", () => {
		expect(
			encodeKey(
				createRecord({ items: createList([integer(1)]) }),
				equality,
			),
		).toEqual({ text: "R{5:items=l1:i1;};" })
		expect(
			encodeKey(
				asValue(createCase("Box#Full", { item: createList([]) })),
				equality,
			),
		).toEqual({ text: "c8:Box#Full{4:item=l0:};" })
	})

	// A Function compares by identity and a Dictionary by its entries in any
	// order, rules no text spells, so anything holding one has no encoding.
	test("everything else takes the scan path", () => {
		expect(
			encodeKey(
				createRecord({ handler: asValue((() => integer(1)) as never) }),
				equality,
			),
		).toBeNull()
		expect(encodeKey(dictionary(), equality)).toBeNull()
		expect(encodeKey(createList([dictionary()]), equality)).toBeNull()
		expect(
			encodeKey(
				createRecord({ rows: createList([dictionary()]) }),
				equality,
			),
		).toBeNull()
	})

	// The encoding stands for the standard library's equality, so an unbranded
	// witness, or the empty literal's absent one, takes the scan path.
	test("an unbranded witness encodes nothing at all", () => {
		expect(encodeKey(text("alex"), witnessed)).toBeNull()
		expect(encodeKey(integer(3), witnessed)).toBeNull()
		expect(encodeKey(createRational(1n, 2n), looseText)).toBeNull()
		expect(encodeKey(createBoolean(true), null)).toBeNull()
	})
})

describe("keys that encode alike are one key", () => {
	test("3 and 3/1 land in one slot", () => {
		let first = dictionary([integer(3), text("integer")])
		let second = setAt(
			first,
			createRational(3n, 1n),
			text("rational"),
			equality,
		)

		expect(lengthOf(second).value).toBe(1)
		// The slot keeps the key it was opened with.
		expect(writtenForm(second)).toBe(`[3 = "rational"]`)
	})

	test("1/2 and 2/4 land in one slot", () => {
		let halves = dictionary(
			[createRational(1n, 2n), integer(1)],
			[createRational(2n, 4n), integer(2)],
		)

		expect(lengthOf(halves).value).toBe(1)
		expect(writtenForm(halves)).toBe("[1/2 = 2]")
	})

	test("a String key is found however its accent is spelled", () => {
		let held = dictionary([text(composedAccent), integer(1)])

		expect(
			heldNumber(valueAt(held, text(decomposedAccent), equality)),
		).toBe(1)

		let overwritten = setAt(
			held,
			text(decomposedAccent),
			integer(2),
			equality,
		)

		expect(lengthOf(overwritten).value).toBe(1)
		expect(
			heldNumber(valueAt(overwritten, text(composedAccent), equality)),
		).toBe(2)
	})

	// Every pairing the encoding must agree with `anyIs` about, both ways. One
	// table, so a kind added to the encoding has one place to be answered for.
	const oneSlot = (first: AnyType, second: AnyType): boolean =>
		dictionary([first, integer(1)], [second, integer(2)]).length === 1

	test("every pair the comparison calls equal lands in one slot", () => {
		let pairs: Array<[AnyType, AnyType]> = [
			[text(composedAccent), text(decomposedAccent)],
			[integer(3), createRational(3n, 1n)],
			[createRational(6n, 2n), integer(3)],
			[createRational(1n, 2n), createRational(2n, 4n)],
			[createRational(-1n, 2n), createRational(1n, -2n)],
			[createRational(2n, -4n), createRational(-1n, 2n)],
			[createRational(0n, 5n), integer(0)],
			[integer(-0), integer(0)],
			[
				createInteger(9007199254740993n),
				createRational(9007199254740993n, 1n),
			],
			[
				createRational(18014398509481986n, 2n),
				createInteger(9007199254740993n),
			],
			[createBoolean(true), createBoolean(true)],
			[
				createRecord({ a: integer(1), b: createRational(2n, 4n) }),
				createRecord({
					b: createRational(1n, 2n),
					a: createRational(2n, 2n),
				}),
			],
			[
				asValue(createCase("Colour#Red")),
				asValue(createCase("Colour#Red")),
			],
			[
				asValue(createCase("Box#Full", { item: text(composedAccent) })),
				asValue(
					createCase("Box#Full", { item: text(decomposedAccent) }),
				),
			],
			[
				createRecord({ inner: createRecord({ n: integer(3) }) }),
				createRecord({
					inner: createRecord({ n: createRational(3n, 1n) }),
				}),
			],
		]

		for (let [first, second] of pairs) {
			expect(anyIs(first, second)).toBeTrue()
			expect(oneSlot(first, second)).toBeTrue()
		}
	})

	test("every pair the comparison calls unequal lands in two slots", () => {
		let pairs: Array<[AnyType, AnyType]> = [
			[createRational(1n, 2n), createRational(-1n, 2n)],
			[integer(3), createRational(1n, 3n)],
			[createBoolean(true), createBoolean(false)],
			[text("a"), text("A")],
			[createInteger(9007199254740993n), integer(3)],
			[createRational(1n, 2n), text("1/2")],
			[
				asValue(createCase("Colour#Red")),
				asValue(createCase("Colour#Blue")),
			],
			[
				asValue(createCase("Colour#Red")),
				asValue(createCase("./Paint.es#Colour#Red")),
			],
			[
				asValue(createCase("Box#Full", { item: integer(1) })),
				asValue(createCase("Box#Full", { item: integer(2) })),
			],
			[
				asValue(createCase("Box#Full", { item: integer(1) })),
				asValue(createCase("Box#Empty")),
			],
			[createRecord({ a: integer(1) }), createRecord({ b: integer(1) })],
			[
				createRecord({ a: integer(1) }),
				createRecord({ a: integer(1), b: integer(2) }),
			],
			[createRecord({ a: text("1") }), createRecord({ a: integer(1) })],
			[
				createRecord({ a: text("t;") }),
				createRecord({ a: createBoolean(true) }),
			],
			[
				createRecord({ ab: text("x"), c: text("y") }),
				createRecord({ a: text("x"), bc: text("y") }),
			],
			[asValue(createCase("Colour#Red")), createRecord({})],
		]

		for (let [first, second] of pairs) {
			expect(anyIs(first, second)).toBeFalse()
			expect(oneSlot(first, second)).toBeFalse()
		}
	})
})

// Over drawn values, Cases or Records that `anyIs` calls equal encode to one
// text and unequal ones to two. Values are drawn small over a fixed seed, and
// each is respelled into an equal twin.
describe("the composite encoding agrees with the structural comparison", () => {
	// A few values per leaf, so that distinct draws coincide.
	const oneOf = (name: string, choices: Array<AnyType>): Generator => ({
		kind: "generated",
		name,
		generate: (source) => choices[below(source, choices.length)]!,
		shrink: () => createList([]),
	})
	const integers = oneOf("Integer", [integer(0), integer(1), integer(-2)])
	const rationals = oneOf("Rational", [
		createRational(1n, 2n),
		createRational(2n, 4n),
		createRational(3n, 1n),
		createRational(-1n, 3n),
	])
	const strings = oneOf("String", [
		text("a"),
		text(""),
		text(composedAccent),
		text(decomposedAccent),
	])
	const booleans: Generator = { kind: "boolean" }
	const point: Generator = {
		kind: "record",
		members: [
			{ name: "x", generator: integers },
			{ name: "y", generator: rationals },
		],
	}
	const shade: Generator = {
		kind: "union",
		members: [
			{ kind: "case", tag: "Shade#Light", members: [] },
			{ kind: "case", tag: "Shade#Dark", members: [] },
			{
				kind: "case",
				tag: "Shade#Named",
				members: [{ name: "name", generator: strings }],
			},
		],
	}
	const shapes: Generator = {
		kind: "union",
		members: [
			{ kind: "case", tag: "Shape#Point", members: [] },
			{
				kind: "case",
				tag: "Shape#Circle",
				members: [
					{ name: "centre", generator: point },
					{ name: "radius", generator: rationals },
					{ name: "shade", generator: shade },
				],
			},
			{
				kind: "case",
				tag: "Shape#Square",
				members: [
					{ name: "corner", generator: point },
					{ name: "side", generator: integers },
					{ name: "filled", generator: booleans },
				],
			},
			{
				kind: "record",
				members: [
					{ name: "shade", generator: shade },
					{ name: "at", generator: point },
				],
			},
		],
	}

	const textOfEncoding = (value: AnyType): string =>
		(encodeKey(value, equality) as { text: string }).text

	// An equal value spelled differently: a whole Rational for an Integer, an
	// unreduced Rational, the NFD form of a String, and members reversed.
	const respelled = (value: AnyType): AnyType => {
		let tag = value[typeKeySymbol] as string

		if (tag === "Integer") {
			let held = BigInt((value as IntegerType).value)

			return createRational(held * 2n, 2n)
		}

		if (tag === "Rational") {
			let { numerator, denominator } = value as {
				numerator: bigint
				denominator: bigint
			}

			return createRational(numerator * -3n, denominator * -3n)
		}

		if (tag === "String") {
			return text((value as StringType).value.normalize("NFD"))
		}

		if (tag === "Boolean") {
			return value
		}

		let members: Record<string, AnyType> = {}

		for (let name of Object.keys(value).reverse()) {
			members[name] = respelled((value as Record<string, AnyType>)[name])
		}

		return tag === "Record"
			? createRecord(members)
			: asValue(createCase(tag, members))
	}

	test("equal values encode alike and unequal values apart", () => {
		let source = createRandomness(seedOf("composite"))
		let drawn: Array<AnyType> = []

		for (let index = 0; index < 160; index++) {
			drawn.push(generate(shapes, source, 1))
		}

		let equalPairs = 0

		for (let first of drawn) {
			let twin = respelled(first)

			expect(anyIs(first, twin)).toBeTrue()
			expect(textOfEncoding(twin)).toBe(textOfEncoding(first))

			for (let second of drawn) {
				let same = anyIs(first, second)

				expect(textOfEncoding(first) === textOfEncoding(second)).toBe(
					same,
				)

				if (same && first !== second) {
					equalPairs++
				}
			}
		}

		// Distinct draws must coincide, or the equal half compares only values
		// with themselves.
		expect(equalPairs).toBeGreaterThan(40)
	})
})

// A Record or a Case whose parts all encode is found without asking the
// witness, which is what the `structural` brand buys.
describe("composite keys", () => {
	// Counting the witness's calls guards the encoded path, since a scan would
	// ask it once per live slot.
	const counting = (): {
		witness: typeof equality
		calls: () => number
	} => {
		let calls = 0

		return {
			witness: {
				is: (first, second) => {
					calls++

					return equality.is(first, second)
				},
				structural: true,
			},
			calls: () => calls,
		}
	}

	test("a Record key is found by its encoding, the witness never asked", () => {
		let { witness, calls } = counting()
		let held = createDictionary<AnyType, AnyType>(
			[
				[
					createRecord({ id: integer(1), note: text("first") }),
					integer(10),
				],
			],
			witness,
		)

		expect(held.store.slots[0].encoded).toEqual({
			text: "R{2:id=i1;4:note=s5:first};",
		})
		expect(held.store.unencoded).toBe(0)
		expect(
			heldNumber(
				valueAt(
					held,
					createRecord({ note: text("first"), id: integer(1) }),
					witness,
				),
			),
		).toBe(10)
		expect(
			valueAt(
				held,
				createRecord({ id: integer(1), note: text("other") }),
				witness,
			)[typeKeySymbol],
		).toBe("Optional#Empty")
		expect(calls()).toBe(0)
	})

	test("a unit Case is found by its encoding, the witness never asked", () => {
		let { witness, calls } = counting()
		let red = asValue(createCase("Colour#Red"))
		let blue = asValue(createCase("Colour#Blue"))
		let held = createDictionary<AnyType, AnyType>(
			[
				[red, integer(1)],
				[blue, integer(2)],
			],
			witness,
		)

		expect(held.store.slots[0].encoded).toEqual({
			text: "c10:Colour#Red{};",
		})
		expect(held.store.unencoded).toBe(0)
		expect(lengthOf(held).value).toBe(2)
		expect(
			heldNumber(
				valueAt(held, asValue(createCase("Colour#Red")), witness),
			),
		).toBe(1)
		expect(
			valueAt(held, asValue(createCase("Colour#Green")), witness)[
				typeKeySymbol
			],
		).toBe("Optional#Empty")
		expect(calls()).toBe(0)
	})

	test("a Case with a payload is one key with any spelling of equal parts", () => {
		let { witness, calls } = counting()
		let held = createDictionary<AnyType, AnyType>(
			[
				[
					asValue(
						createCase("Shape#Circle", {
							radius: createRational(2n, 4n),
							label: text(composedAccent),
						}),
					),
					integer(1),
				],
			],
			witness,
		)

		expect(
			heldNumber(
				valueAt(
					held,
					asValue(
						createCase("Shape#Circle", {
							label: text(decomposedAccent),
							radius: createRational(1n, 2n),
						}),
					),
					witness,
				),
			),
		).toBe(1)
		expect(
			valueAt(
				held,
				asValue(
					createCase("Shape#Square", {
						radius: createRational(1n, 2n),
						label: text(composedAccent),
					}),
				),
				witness,
			)[typeKeySymbol],
		).toBe("Optional#Empty")
		expect(calls()).toBe(0)
	})

	// Held by counting the witness's calls rather than by timing.
	test("a thousand Case keys are all found on the encoded path", () => {
		let { witness, calls } = counting()
		let box = createDictionary<AnyType, AnyType>([], witness)

		for (let index = 0; index < 1000; index++) {
			box = setAt(
				box,
				asValue(createCase("Slot#At", { index: integer(index) })),
				integer(index),
				witness,
			)
		}

		expect(lengthOf(box).value).toBe(1000)
		expect(box.store.unencoded).toBe(0)
		expect(box.store.texts.size).toBe(1000)

		for (let index = 0; index < 1000; index++) {
			expect(
				heldNumber(
					valueAt(
						box,
						asValue(
							createCase("Slot#At", { index: integer(index) }),
						),
						witness,
					),
				),
			).toBe(index)
		}

		expect(calls()).toBe(0)
	})

	// The text is remembered under a Symbol on the interned instance, invisible
	// to `Record::is` and the derived equality.
	test("a unit Case remembers its text on the interned instance", () => {
		let red = asValue(createCase("Colour#Red"))
		let first = encodeKey(red, equality) as { text: string }
		let second = encodeKey(red, equality) as { text: string }

		expect(first.text).toBe(second.text)
		expect(Object.keys(red)).toEqual([])
		expect(anyIs(red, asValue(createCase("Colour#Red")))).toBeTrue()
	})
})

describe("the scan path", () => {
	// A Dictionary part has no text, since its equality is order-insensitive.
	test("a Record holding a Dictionary is found through the witness", () => {
		let held = dictionary([
			createRecord({
				id: integer(1),
				tags: dictionary([text("a"), integer(1)]),
			}),
			integer(10),
		])

		expect(held.store.slots[0].encoded).toBeNull()
		expect(held.store.unencoded).toBe(1)
		expect(
			heldNumber(
				valueAt(
					held,
					createRecord({
						id: integer(1),
						tags: dictionary([text("a"), integer(1)]),
					}),
					equality,
				),
			),
		).toBe(10)
	})

	test("the witness decides, not this Module's own comparison", () => {
		let first = createRecord({ id: integer(1), note: text("first") })
		let other = createRecord({ id: integer(1), note: text("other") })
		let held = createDictionary<AnyType, AnyType>(
			[[first, integer(10)]],
			byIdentifier,
		)

		expect(anyIs(first, other)).toBeFalse()
		expect(heldNumber(valueAt(held, other, byIdentifier))).toBe(10)

		let overwritten = setAt(held, other, integer(20), byIdentifier)

		expect(lengthOf(overwritten).value).toBe(1)
		// An overwrite keeps the slot and the key it was opened with.
		expect(overwritten.store.slots[0].key).toBe(first)
	})

	// A payload member typed `Number` may hold an Integer, which encodes, or an
	// Algebraic, which does not, so one store holds both kinds of slot.
	test("a store mixes encoded and scan-path Cases under one witness", () => {
		let root = createAlgebraic(
			{ numerator: 0n, denominator: 1n },
			{ numerator: 1n, denominator: 1n },
			2n,
		) as AnyType
		let held = dictionary(
			[
				asValue(createCase("Box#Full", { item: integer(3) })),
				text("three"),
			],
			[asValue(createCase("Box#Full", { item: root })), text("root")],
			[
				asValue(
					createCase("Box#Full", { item: createRational(6n, 2n) }),
				),
				text("three again"),
			],
		)

		expect(lengthOf(held).value).toBe(2)
		expect(held.store.unencoded).toBe(1)
		expect(held.store.texts.size).toBe(1)
		expect(
			textOf(
				heldOf(
					valueAt(
						held,
						asValue(createCase("Box#Full", { item: integer(3) })),
						equality,
					),
				) as AnyType,
			),
		).toBe("three again")
		expect(
			textOf(
				heldOf(
					valueAt(
						held,
						asValue(createCase("Box#Full", { item: root })),
						equality,
					),
				) as AnyType,
			),
		).toBe("root")
	})

	// An Algebraic is a Number with no encoding, so one store holds both kinds of
	// slot. See "Finding a Dictionary key" in packages/runtime/DEVELOPMENT.md.
	test("a store mixes encoded and scan-path keys under one witness", () => {
		let root = createAlgebraic(
			{ numerator: 0n, denominator: 1n },
			{ numerator: 1n, denominator: 1n },
			2n,
		) as AnyType
		let held = dictionary(
			[integer(3), text("whole")],
			[root, text("root")],
			[createRational(6n, 2n), text("whole again")],
		)

		expect(lengthOf(held).value).toBe(2)
		expect(held.store.unencoded).toBe(1)
		expect(held.store.index.size).toBe(1)
		expect(
			textOf(heldOf(valueAt(held, integer(3), equality)) as AnyType),
		).toBe("whole again")
		expect(textOf(heldOf(valueAt(held, root, equality)) as AnyType)).toBe(
			"root",
		)
		expect(valueAt(held, integer(4), equality)[typeKeySymbol]).toBe(
			"Optional#Empty",
		)
		expect(lengthOf(removeAt(held, root, equality)).value).toBe(1)
	})

	test("a scan-path key removed and re-added lands at the end", () => {
		let first = createRecord({ id: integer(1) })
		let second = createRecord({ id: integer(2) })
		let held = dictionary([first, integer(1)], [second, integer(2)])
		let without = removeAt(held, first, equality)
		let again = setAt(without, first, integer(9), equality)

		expect(writtenForm(again)).toBe("[{ id = 2 } = 2, { id = 1 } = 9]")
	})
})

// A Namespace may write an `is` for a Type whose keys would encode, such as one
// ignoring case for `NonEmptyString`. The lookup must use that witness, which
// encoding would ignore.
describe("a witness a Namespace wrote", () => {
	test("of collapses two keys the witness calls equal", () => {
		let box = dictionaryOf<AnyType, AnyType>(
			createList([
				entry(text("Ada"), integer(1)),
				entry(text("ada"), integer(2)),
			]),
			looseText,
		)

		expect(looseText.is(text("Ada"), text("ada")).value).toBeTrue()
		expect(lengthOf(box).value).toBe(1)
		expect(writtenForm(box)).toBe(`["Ada" = 2]`)
	})

	test("a lookup finds a key the witness calls equal", () => {
		let box = createDictionary<AnyType, AnyType>(
			[[text("Ada"), integer(1)]],
			looseText,
		)

		expect(heldNumber(valueAt(box, text("ADA"), looseText))).toBe(1)
	})

	test("set overwrites a key the witness calls equal rather than adding one", () => {
		let box = createDictionary<AnyType, AnyType>(
			[[text("Ada"), integer(1)]],
			looseText,
		)
		let written = setAt(box, text("ADA"), integer(2), looseText)

		expect(lengthOf(written).value).toBe(1)
		expect(writtenForm(written)).toBe(`["Ada" = 2]`)
	})

	test("remove takes out a key the witness calls equal", () => {
		let box = createDictionary<AnyType, AnyType>(
			[[text("Ada"), integer(1)]],
			looseText,
		)

		expect(lengthOf(removeAt(box, text("ADA"), looseText)).value).toBe(0)
	})

	// A store written through both kinds of witness stays one Dictionary. The
	// witnessed write scans every live slot, and the fast path falls through to
	// the scan while an unencoded slot stands.
	test("a witnessed write finds a key the fast path wrote", () => {
		let encoded = dictionary([text("Ada"), integer(1)])
		let written = setAt(encoded, text("ada"), integer(2), looseText)

		expect(lengthOf(written).value).toBe(1)
		expect(written.store.slots[0].key).toBe(encoded.store.slots[0].key)
		expect(heldNumber(valueAt(written, text("Ada"), equality))).toBe(2)
	})

	test("the fast path finds a key a witnessed write opened", () => {
		let held = createDictionary<AnyType, AnyType>(
			[[text("Ada"), integer(1)]],
			looseText,
		)

		expect(held.store.unencoded).toBe(1)
		expect(held.store.index.size).toBe(0)
		expect(heldNumber(valueAt(held, text("Ada"), equality))).toBe(1)
		expect(valueAt(held, text("Bob"), equality)[typeKeySymbol]).toBe(
			"Optional#Empty",
		)

		let alsoWritten = setAt(held, text("Bob"), integer(2), equality)

		expect(lengthOf(alsoWritten).value).toBe(2)
		expect(heldNumber(valueAt(alsoWritten, text("Ada"), equality))).toBe(1)
		expect(heldNumber(valueAt(alsoWritten, text("Bob"), equality))).toBe(2)
	})

	test("an unbranded witness holds the same entries as the branded one", () => {
		let scanned = createDictionary<AnyType, AnyType>(
			[
				[text(composedAccent), integer(1)],
				[text(decomposedAccent), integer(2)],
				[integer(3), integer(3)],
				[createRational(3n, 1n), integer(4)],
			],
			witnessed,
		)

		expect(lengthOf(scanned).value).toBe(2)
		expect(scanned.store.unencoded).toBe(2)
		expect(writtenForm(scanned)).toBe(`["${composedAccent}" = 2, 3 = 4]`)
	})
})

// A List's conformance is conditional on its items'. The witness solving the
// `where` may be forwarded into a generic Function, unnamed at the Rewriter. So
// the brand travels in the method map and `boundConformance` decides it. This
// is the shape the Rewriter emits for a List key.
describe("the brand a conditional conformance carries", () => {
	const branded = (conditions: Array<unknown>) =>
		boundConformance({ is: listIs, structural: true }, conditions)

	test("a List witness is branded where its item witness is", () => {
		let witness = branded([equality])

		expect(witness.structural).toBe(true)
		expect(typeof witness.is).toBe("function")
	})

	test("a List witness is unbranded where its item witness is not", () => {
		expect(branded([looseText]).structural).toBeUndefined()
		expect(branded([witnessed]).structural).toBeUndefined()
	})

	// Curried like a Method the brand would become a Function, and `encodeKey`
	// reads it with `=== true`.
	test("the brand is never curried as if it were a Method", () => {
		expect(branded([equality]).structural).not.toBeInstanceOf(Function)
	})

	// The brand is the Rewriter's claim about the `is`, and the conditions only
	// say whether it survives.
	test("an unbranded map stays unbranded under branded conditions", () => {
		expect(
			boundConformance({ is: listIs }, [equality]).structural,
		).toBeUndefined()
	})

	// The witness for a List of Lists is built over itself.
	test("a written 'is' at the bottom unbrands every layer above it", () => {
		expect(branded([branded([looseText])]).structural).toBeUndefined()
	})
})

// A List key whose items carry a written `is` is found by the scan. One using
// the standard library's equality is found by its text in one step.
describe("a Dictionary keyed by Lists", () => {
	// `List.is` curried with a Namespace's own `is`, and so unbranded.
	const looseItems = {
		is: (first: AnyType, second: AnyType) =>
			listIs(
				first as ListType<AnyType>,
				second as ListType<AnyType>,
				looseText,
			),
	}

	test("finds a List key in one step under the branded witness", () => {
		let box = dictionary(
			[createList([integer(1), integer(2)]), text("start")],
			[createList([integer(12), integer(3)]), text("corner")],
		)

		expect(box.store.unencoded).toBe(0)
		expect(box.store.slots[0].encoded).toEqual({ text: "l2:i1;i2;" })
		expect(
			textOf(
				heldOf(
					valueAt(
						box,
						createList([integer(12), integer(3)]),
						equality,
					),
				) as AnyType,
			),
		).toBe("corner")
	})

	// The `;` closing each Integer tells `[1, 23]` from `[12, 3]`, and the count
	// in each head tells nested Lists apart.
	test("keeps apart the keys a run-together text would merge", () => {
		let box = dictionary(
			[createList([integer(1), integer(23)]), integer(1)],
			[createList([integer(12), integer(3)]), integer(2)],
			[
				createList([
					createList([integer(1)]),
					createList([integer(2)]),
				]),
				integer(3),
			],
			[createList([createList([integer(1), integer(2)])]), integer(4)],
			[createList([createList([])]), integer(5)],
			[createList([]), integer(6)],
		)

		expect(lengthOf(box).value).toBe(6)
		expect(box.store.unencoded).toBe(0)
	})

	// A String item that looks like an encoded List is length-prefixed, so it
	// can not be read as that List.
	test("keeps a String item apart from the List it imitates", () => {
		let box = dictionary(
			[createList([text("l1:i1;")]), integer(1)],
			[createList([createList([integer(1)])]), integer(2)],
		)

		expect(lengthOf(box).value).toBe(2)
	})

	// The canonical text calls these distinct and the written `is` equal, so the
	// store keeps them unencoded and the scan finds them.
	test("scans for a List key whose items carry a written 'is'", () => {
		let box = createDictionary<AnyType, AnyType>(
			[
				[createList([text("Ada")]), integer(1)],
				[createList([text("ada")]), integer(2)],
			],
			looseItems,
		)

		expect(box.store.unencoded).toBe(1)
		expect(lengthOf(box).value).toBe(1)
		expect(
			heldNumber(valueAt(box, createList([text("ADA")]), looseItems)),
		).toBe(2)
	})
})

describe("insertion order", () => {
	const three = () =>
		dictionary(
			[text("a"), integer(1)],
			[text("b"), integer(2)],
			[text("c"), integer(3)],
		)

	test("entries answer in the order they were added", () => {
		expect(writtenForm(three())).toBe(`["a" = 1, "b" = 2, "c" = 3]`)
	})

	test("overwriting a key keeps its place", () => {
		expect(
			writtenForm(setAt(three(), text("a"), integer(9), equality)),
		).toBe(`["a" = 9, "b" = 2, "c" = 3]`)
	})

	test("a key removed and re-added lands at the END", () => {
		let held = three()
		let without = removeAt(held, text("a"), equality)
		let again = setAt(without, text("a"), integer(9), equality)

		expect(writtenForm(without)).toBe(`["b" = 2, "c" = 3]`)
		expect(writtenForm(again)).toBe(`["b" = 2, "c" = 3, "a" = 9]`)
		// And the boxes it was written from answer exactly what they did.
		expect(writtenForm(held)).toBe(`["a" = 1, "b" = 2, "c" = 3]`)
	})

	// A re-add repacks, so each round starts from a box one generation into a
	// store nobody else holds.
	test("a key removed and re-added across a dozen rounds lands last every time", () => {
		let box = three()
		let seen: Array<string> = []

		for (let round = 0; round < 12; round++) {
			box = removeAt(box, text("a"), equality)
			box = setAt(box, text("a"), integer(round), equality)
			seen.push(writtenForm(box))
		}

		for (let round = 0; round < 12; round++) {
			expect(seen[round]).toBe(`["b" = 2, "c" = 3, "a" = ${round}]`)
		}
	})

	test("a removal leaves a tombstone standing where the key was", () => {
		let held = three()
		let without = removeAt(held, text("a"), equality)
		let slot = slotFor(without, text("a"))

		expect(without.store.slots[0]).toBe(slot)
		expect(slot.versions[slot.versions.length - 1].value).toBe(TOMBSTONE)
	})

	test("keys, values and entries answer the same order", () => {
		let held = setAt(three(), text("a"), integer(9), equality)
		let keys = materialise(keysOf(held))
		let values = materialise(valuesOf(held))
		let entries = materialise(entriesOf(held))

		expect(keys.map(textOf)).toEqual(["a", "b", "c"])
		expect(values.map(numberOf)).toEqual([9, 2, 3])
		expect(entries.map((each) => textOf(each.key))).toEqual(["a", "b", "c"])
		expect(entries.map((each) => numberOf(each.value))).toEqual([9, 2, 3])
	})

	// `createList` takes ownership of its Array, so two answers must never share
	// one.
	test("keys, values and entries answer fresh Arrays", () => {
		let held = three()

		expect(keysOf(held).value).not.toBe(keysOf(held).value)
		expect(valuesOf(held).value).not.toBe(valuesOf(held).value)
		expect(entriesOf(held).value).not.toBe(entriesOf(held).value)
	})
})

describe("generations", () => {
	test("an older box answers its own contents after the tip wrote", () => {
		let first = dictionary([text("a"), integer(1)])
		let second = setAt(first, text("b"), integer(2), equality)
		let third = setAt(second, text("a"), integer(9), equality)
		let fourth = removeAt(third, text("b"), equality)

		expect(writtenForm(first)).toBe(`["a" = 1]`)
		expect(writtenForm(second)).toBe(`["a" = 1, "b" = 2]`)
		expect(writtenForm(third)).toBe(`["a" = 9, "b" = 2]`)
		expect(writtenForm(fourth)).toBe(`["a" = 9]`)

		// All four over one store: a tip write pushes a version and copies
		// nothing.
		expect(second.store).toBe(first.store)
		expect(third.store).toBe(first.store)
		expect(fourth.store).toBe(first.store)
	})

	test("an older box answers nothing for a key added after it", () => {
		let first = dictionary([text("a"), integer(1)])
		let second = setAt(first, text("b"), integer(2), equality)

		expect(valueAt(first, text("b"), equality)[typeKeySymbol]).toBe(
			"Optional#Empty",
		)
		expect(heldNumber(valueAt(second, text("b"), equality))).toBe(2)
		expect(lengthOf(first).value).toBe(1)
		expect(isEmpty(first).value).toBeFalse()
	})

	test("a forked write repacks, and neither branch sees the other", () => {
		let base = dictionary([text("a"), integer(1)])
		let original = base.store
		let left = setAt(base, text("b"), integer(2), equality)
		let right = setAt(base, text("c"), integer(3), equality)

		expect(left.store).toBe(original)
		expect(right.store).not.toBe(original)

		expect(writtenForm(base)).toBe(`["a" = 1]`)
		expect(writtenForm(left)).toBe(`["a" = 1, "b" = 2]`)
		expect(writtenForm(right)).toBe(`["a" = 1, "c" = 3]`)
	})

	test("a forked removal repacks too", () => {
		let base = dictionary([text("a"), integer(1)], [text("b"), integer(2)])
		let original = base.store
		let left = setAt(base, text("c"), integer(3), equality)
		let right = removeAt(base, text("a"), equality)

		expect(right.store).not.toBe(original)
		expect(writtenForm(base)).toBe(`["a" = 1, "b" = 2]`)
		expect(writtenForm(left)).toBe(`["a" = 1, "b" = 2, "c" = 3]`)
		expect(writtenForm(right)).toBe(`["b" = 2]`)
	})

	test("a fork written on both branches keeps three views apart", () => {
		let base = dictionary([text("a"), integer(1)], [text("b"), integer(2)])
		let left = setAt(base, text("a"), integer(10), equality)
		let right = setAt(base, text("a"), integer(20), equality)
		let leftAgain = setAt(left, text("c"), integer(3), equality)
		let rightAgain = removeAt(right, text("b"), equality)

		expect(writtenForm(base)).toBe(`["a" = 1, "b" = 2]`)
		expect(writtenForm(left)).toBe(`["a" = 10, "b" = 2]`)
		expect(writtenForm(right)).toBe(`["a" = 20, "b" = 2]`)
		expect(writtenForm(leftAgain)).toBe(`["a" = 10, "b" = 2, "c" = 3]`)
		expect(writtenForm(rightAgain)).toBe(`["a" = 20]`)

		// Read again in another order, since a shared store could make the order
		// matter.
		expect(writtenForm(base)).toBe(`["a" = 1, "b" = 2]`)
		expect(writtenForm(right)).toBe(`["a" = 20, "b" = 2]`)
		expect(writtenForm(left)).toBe(`["a" = 10, "b" = 2]`)
	})

	test("removing an absent key answers the receiver", () => {
		let held = dictionary([text("a"), integer(1)])

		expect(removeAt(held, text("zzz"), equality)).toBe(held)
		expect(removeAt(held, createRecord({ id: integer(1) }), equality)).toBe(
			held,
		)
	})

	test("removing a key twice answers the same contents", () => {
		let held = dictionary([text("a"), integer(1)], [text("b"), integer(2)])
		let once = removeAt(held, text("a"), equality)
		let twice = removeAt(once, text("a"), equality)

		expect(twice).toBe(once)
		expect(writtenForm(twice)).toBe(`["b" = 2]`)
	})
})

describe("repacking", () => {
	// `dead` counts versions that are no live key's newest. An overwrite leaves
	// one, a removal two, and an opened slot none.
	test("dead versions are counted as they are made", () => {
		let held = dictionary([text("a"), integer(0)], [text("b"), integer(0)])

		expect(held.store.dead).toBe(0)

		let overwritten = setAt(held, text("a"), integer(1), equality)

		expect(overwritten.store.dead).toBe(1)

		let added = setAt(overwritten, text("c"), integer(1), equality)

		expect(added.store.dead).toBe(1)

		let removed = removeAt(added, text("c"), equality)

		expect(removed.store.dead).toBe(3)
	})

	test("a store with more dead versions than slots repacks on the next write", () => {
		let held = dictionary([text("a"), integer(0)], [text("b"), integer(0)])
		let box = held

		for (let round = 1; round <= 3; round++) {
			box = setAt(box, text("a"), integer(round), equality)
			expect(box.store).toBe(held.store)
		}

		expect(box.store.dead).toBe(3)
		expect(box.store.slots.length).toBe(2)

		let original = held.store
		let repacked = setAt(box, text("a"), integer(4), equality)

		expect(repacked.store).not.toBe(original)
		expect(repacked.store.dead).toBe(1)
		expect(repacked.store.slots.length).toBe(2)
		expect(writtenForm(repacked)).toBe(`["a" = 4, "b" = 0]`)
		// The box the repack was made from moved onto the fresh store and answers
		// what it did.
		expect(writtenForm(box)).toBe(`["a" = 3, "b" = 0]`)
	})

	// Overwriting one key leaves one dead version per write, so the store repacks
	// once per `slots.length` writes. See "Writing to a Dictionary" in
	// packages/runtime/DEVELOPMENT.md.
	test("overwriting one key repacks once per as many writes as there are entries", () => {
		let box = chainOf(1_000)
		let store = box.store
		let repacks = 0

		for (let round = 0; round < 10_000; round++) {
			box = setAt(box, text("k0"), integer(round), equality)

			if (box.store !== store) {
				repacks++
				store = box.store
			}
		}

		// The 1,001st dead version is the first to outnumber the 1,000 slots.
		expect(repacks).toBeLessThanOrEqual(10)
		expect(repacks).toBeGreaterThan(0)
		expect(heldNumber(valueAt(box, text("k0"), equality))).toBe(9_999)
		expect(lengthOf(box).value).toBe(1_000)
	})

	test("a Dictionary with more entries than the writes it takes never repacks at all", () => {
		let box = chainOf(10_000)
		let store = box.store
		let repacks = 0

		for (let round = 0; round < 10_000; round++) {
			box = setAt(box, text("k0"), integer(round), equality)

			if (box.store !== store) {
				repacks++
				store = box.store
			}
		}

		expect(repacks).toBeLessThanOrEqual(2)
		expect(heldNumber(valueAt(box, text("k0"), equality))).toBe(9_999)
	})

	test("a long history leaves every older box answering what it answered", () => {
		let box = dictionary(
			[text("a"), integer(0)],
			[text("b"), integer(100)],
			[text("c"), integer(200)],
			[text("d"), integer(300)],
			[text("e"), integer(400)],
		)
		let chain = [box]

		for (let round = 1; round <= 25; round++) {
			box = setAt(box, text("a"), integer(round), equality)
			chain.push(box)
		}

		for (let round = 0; round < chain.length; round++) {
			expect(writtenForm(chain[round])).toBe(
				`["a" = ${round}, "b" = 100, "c" = 200, "d" = 300, "e" = 400]`,
			)
		}

		// Then write on the oldest box, with a store's worth of other history in
		// front of it.
		let forked = setAt(chain[0], text("f"), integer(500), equality)

		expect(writtenForm(forked)).toBe(
			`["a" = 0, "b" = 100, "c" = 200, "d" = 300, "e" = 400, "f" = 500]`,
		)
		expect(writtenForm(chain[0])).toBe(
			`["a" = 0, "b" = 100, "c" = 200, "d" = 300, "e" = 400]`,
		)
	})

	test("the dead-versions repack leaves every old box standing", () => {
		let box = dictionary([text("a"), integer(1)], [text("b"), integer(2)])
		let chain = [{ box, text: `["a" = 1, "b" = 2]` }]

		// A removal counts two dead versions, which a two-slot store holds
		// without passing its limit, so each re-add here repacks by the re-add
		// rule.
		let next = removeAt(box, text("a"), equality)

		chain.push({ box: next, text: `["b" = 2]` })

		next = setAt(next, text("a"), integer(3), equality)
		chain.push({ box: next, text: `["b" = 2, "a" = 3]` })

		next = removeAt(next, text("b"), equality)
		chain.push({ box: next, text: `["a" = 3]` })

		next = setAt(next, text("b"), integer(4), equality)
		chain.push({ box: next, text: `["a" = 3, "b" = 4]` })

		for (let step of chain) {
			expect(writtenForm(step.box)).toBe(step.text)
		}
	})

	test("a repack drops the dead slots and rebuilds both indexes", () => {
		let held = dictionary(
			[text("a"), integer(1)],
			[createRational(1n, 2n), integer(2)],
			[text("c"), integer(3)],
		)
		let without = removeAt(held, createRational(2n, 4n), equality)
		// A second box over the store makes the next write a fork, which repacks
		// whatever the counters say.
		let sibling = setAt(without, text("d"), integer(4), equality)
		let original = without.store
		let repacked = setAt(without, text("e"), integer(5), equality)

		expect(repacked.store).not.toBe(original)
		expect(repacked.store.slots.length).toBe(3)
		expect(repacked.store.texts.size).toBe(0)
		expect(repacked.store.index.get("a")).toBe(repacked.store.slots[0])
		expect(writtenForm(repacked)).toBe(`["a" = 1, "c" = 3, "e" = 5]`)
		expect(writtenForm(sibling)).toBe(`["a" = 1, "c" = 3, "d" = 4]`)
	})

	// Every write from a base others derive from forks and repacks. The repack
	// moves the base onto the store it built, so later derivations copy the base
	// rather than walk its old history.
	test("a write from a stale box leaves that box on a store of its own size", () => {
		let base = chainOf(200)
		let bloated = base.store
		let tip = base

		for (let round = 0; round < 2_000; round++) {
			tip = setAt(tip, text("k0"), integer(round), equality)
		}

		expect(base.store).toBe(bloated)
		expect(slotFor(base, text("k0")).versions.length).toBeGreaterThan(8)

		let derived = setAt(base, text("first"), integer(1), equality)

		// The base now stands on its own entries, one version each, plus the slot
		// the derivation appended.
		expect(base.store).not.toBe(bloated)
		expect(base.generation).toBe(0)
		expect(base.store.slots.length).toBe(201)
		expect(
			base.store.slots.every((slot) => slot.versions.length === 1),
		).toBeTrue()
		expect(lengthOf(base).value).toBe(200)
		expect(heldNumber(valueAt(base, text("k0"), equality))).toBe(0)

		// Each later derivation answers its own entries, and the base grows no
		// history.
		for (let round = 0; round < 1_000; round++) {
			let next = setAt(base, text(`x${round}`), integer(round), equality)

			expect(lengthOf(next).value).toBe(201)
			expect(heldNumber(valueAt(next, text(`x${round}`), equality))).toBe(
				round,
			)
			expect(base.store.slots.length).toBe(201)
			expect(
				base.store.slots.every((slot) => slot.versions.length === 1),
			).toBeTrue()
		}

		expect(lengthOf(base).value).toBe(200)
		expect(lengthOf(derived).value).toBe(201)
		expect(heldNumber(valueAt(tip, text("k0"), equality))).toBe(1_999)
	})
})

describe("construction", () => {
	test("of builds from a List of entry Records", () => {
		let held = dictionaryOf(
			createList([
				entry(text("alex"), integer(39)),
				entry(text("sam"), integer(25)),
			]),
			equality,
		)

		expect(writtenForm(held)).toBe(`["alex" = 39, "sam" = 25]`)
		expect(lengthOf(held).value).toBe(2)
	})

	test("of lets a later duplicate win in the first one's place", () => {
		let held = dictionaryOf(
			createList([
				entry(text("a"), integer(1)),
				entry(text("b"), integer(2)),
				entry(text("a"), integer(9)),
			]),
			equality,
		)

		expect(writtenForm(held)).toBe(`["a" = 9, "b" = 2]`)
		expect(lengthOf(held).value).toBe(2)
		// A store built in one pass writes a duplicate over the standing version,
		// so it carries no history.
		expect(held.store.dead).toBe(0)
	})

	// A List built by prepending holds its items in the front run, read
	// backwards, and `of` must answer the same Dictionary.
	test("of reads a List that was built from the front", () => {
		let entries = prepend(
			prepend(
				createList([entry(text("c"), integer(3))]),
				entry(text("b"), integer(2)),
			),
			entry(text("a"), integer(1)),
		)
		let held = dictionaryOf(entries, equality)

		expect(writtenForm(held)).toBe(`["a" = 1, "b" = 2, "c" = 3]`)
	})

	test("of builds the empty Dictionary from the empty List", () => {
		let held = dictionaryOf(createList([]), equality)

		expect(lengthOf(held).value).toBe(0)
		expect(isEmpty(held).value).toBeTrue()
		expect(writtenForm(held)).toBe("[=]")
	})

	// The empty literal `[=]` is built with no witness at all, because it
	// holds no key for one to be asked about.
	test("createDictionary builds the empty Dictionary with no witness", () => {
		let held = createDictionary<AnyType, AnyType>([], null)

		expect(lengthOf(held).value).toBe(0)
		expect(writtenForm(held)).toBe("[=]")
		expect(writtenForm(setAt(held, text("a"), integer(1), equality))).toBe(
			`["a" = 1]`,
		)
	})

	test("createDictionary lets a later duplicate win in the first one's place", () => {
		let held = dictionary(
			[text("a"), integer(1)],
			[text("b"), integer(2)],
			[text("a"), integer(9)],
		)

		expect(writtenForm(held)).toBe(`["a" = 9, "b" = 2]`)
		expect(held.store.dead).toBe(0)
	})

	test("createDictionary deduplicates scan-path keys too", () => {
		let held = createDictionary<AnyType, AnyType>(
			[
				[
					createRecord({ id: integer(1), note: text("first") }),
					integer(1),
				],
				[
					createRecord({ id: integer(1), note: text("second") }),
					integer(2),
				],
			],
			byIdentifier,
		)

		expect(lengthOf(held).value).toBe(1)
		expect(
			heldNumber(
				valueAt(held, createRecord({ id: integer(1) }), byIdentifier),
			),
		).toBe(2)
	})

	// The door from a JavaScript host, so it picks the witness and what a
	// duplicate means. A `Map` tells keys apart by `===`, and two of those may be
	// one key here.
	test("createDictionaryFrom builds with the structural equality", () => {
		let held = built(
			createDictionaryFrom([
				[text("alex"), integer(39)],
				[text("sam"), integer(25)],
			]),
		)

		expect(writtenForm(held)).toBe(`["alex" = 39, "sam" = 25]`)
		// Encoded rather than scanned, as the witness's brand allows.
		expect(held.store.unencoded).toBe(0)
	})

	test("createDictionaryFrom answers the position of a duplicate key", () => {
		expect(
			createDictionaryFrom([
				[text("a"), integer(1)],
				[text("b"), integer(2)],
				[text("a"), integer(9)],
			]),
		).toBe(2)
		// Pairs a `Map` holds apart and a Dictionary does not: an Integer beside
		// the Rational it equals, and two spellings of one String.
		expect(
			createDictionaryFrom([
				[integer(1), text("first")],
				[createRational(1n, 1n), text("second")],
			]),
		).toBe(1)
		expect(
			createDictionaryFrom([
				[text(composedAccent), integer(1)],
				[text(decomposedAccent), integer(2)],
			]),
		).toBe(1)
	})

	// A duplicate List key is caught too.
	test("createDictionaryFrom catches a duplicate the scan path finds", () => {
		expect(
			createDictionaryFrom([
				[createList([integer(1), integer(2)]), text("first")],
				[createList([integer(1), integer(2)]), text("second")],
			]),
		).toBe(1)
	})

	test("createDictionaryFrom builds the empty Dictionary", () => {
		let held = built(createDictionaryFrom([]))

		expect(lengthOf(held).value).toBe(0)
		expect(writtenForm(held)).toBe("[=]")
	})
})

describe("lookup", () => {
	test("a held key answers its value and an absent one answers nothing", () => {
		let held = dictionary([text("a"), integer(1)])

		expect(heldNumber(valueAt(held, text("a"), equality))).toBe(1)
		expect(valueAt(held, text("b"), equality)[typeKeySymbol]).toBe(
			"Optional#Empty",
		)
	})

	test("a removed key answers nothing", () => {
		let held = dictionary([text("a"), integer(1)], [text("b"), integer(2)])
		let without = removeAt(held, text("a"), equality)

		expect(valueAt(without, text("a"), equality)[typeKeySymbol]).toBe(
			"Optional#Empty",
		)
		// The box it was removed from still answers it, which is what a
		// tombstone is for.
		expect(heldNumber(valueAt(held, text("a"), equality))).toBe(1)
	})
})

describe("printing", () => {
	test("the empty Dictionary prints [=]", () => {
		expect(writtenForm(dictionary())).toBe("[=]")
	})

	test("a Dictionary emptied by removal prints [=]", () => {
		let held = dictionary([text("a"), integer(1)])
		let without = removeAt(held, text("a"), equality)

		expect(writtenForm(without)).toBe("[=]")
		expect(getStringRepresentation(without, 0, formatAsFraction, "")).toBe(
			"[=]",
		)
	})

	test("Strings keep their quotes on both sides", () => {
		let held = dictionary([text("alex"), text("hello")])

		expect(writtenForm(held)).toBe(`["alex" = "hello"]`)
	})

	test("a String carrying quotes, newlines and backslashes is escaped on both sides", () => {
		let held = dictionary([
			text('say "hi"\n\tor\\not'),
			text('a "value"\r\n'),
		])

		expect(writtenForm(held)).toBe(
			'["say \\"hi\\"\\n\\tor\\\\not" = "a \\"value\\"\\r\\n"]',
		)
		expect(getStringRepresentation(held, 0, formatAsFraction, "")).toBe(
			writtenForm(held),
		)
	})

	test("a control character in a key is escaped rather than written raw", () => {
		expect(writtenForm(dictionary([text("a\u0000b"), integer(1)]))).toBe(
			'["a\\u{0}b" = 1]',
		)
	})

	test("non-String keys and values print bare", () => {
		let held = dictionary(
			[integer(3), createRational(1n, 2n)],
			[createBoolean(true), asValue(createCase("Colour#Red"))],
		)

		expect(writtenForm(held)).toBe("[3 = 1/2, true = Colour#Red]")
	})

	// The Record walk in `Terminal.ts` reaches the Dictionary's renderer through
	// the kind registry, so both forms are one text.
	test("a nested Dictionary renders the same inside a Record as on its own", () => {
		let inner = dictionary([text("a"), integer(1)])
		let outer = createRecord({ held: inner as AnyType })

		expect(getStringRepresentation(outer, 0, formatAsFraction, "")).toBe(
			'{ held = ["a" = 1] }',
		)
	})

	// `Terminal.inspect` breaks a long rendering over lines and pads inside the
	// brackets, as for a List.
	test("a long Dictionary is inspected over lines", () => {
		let held = dictionary(
			[text("alexander"), integer(39)],
			[text("bartholomew"), integer(25)],
			[text("christopher"), integer(51)],
		)

		expect(getStringRepresentation(held)).toBe(
			'[\n    "alexander" = 39,\n    "bartholomew" = 25,\n    "christopher" = 51\n]',
		)
		expect(
			getStringRepresentation(dictionary([text("a"), integer(1)])),
		).toBe('[ "a" = 1 ]')
	})
})

describe("equality", () => {
	test("two Dictionaries are equal whatever order they were written in", () => {
		let first = dictionary([text("a"), integer(1)], [text("b"), integer(2)])
		let second = dictionary(
			[text("b"), integer(2)],
			[text("a"), integer(1)],
		)

		expect(dictionaryIs(first, second, equality, equality).value).toBeTrue()
		expect(dictionaryIs(second, first, equality, equality).value).toBeTrue()
	})

	test("differing lengths are unequal", () => {
		let first = dictionary([text("a"), integer(1)])
		let second = dictionary(
			[text("a"), integer(1)],
			[text("b"), integer(2)],
		)

		expect(
			dictionaryIs(first, second, equality, equality).value,
		).toBeFalse()
		expect(
			dictionaryIs(second, first, equality, equality).value,
		).toBeFalse()
	})

	test("a differing key at the same length is unequal", () => {
		let first = dictionary([text("a"), integer(1)])
		let second = dictionary([text("b"), integer(1)])

		expect(
			dictionaryIs(first, second, equality, equality).value,
		).toBeFalse()
	})

	test("a differing value at the same key is unequal", () => {
		let first = dictionary([text("a"), integer(1)])
		let second = dictionary([text("a"), integer(2)])

		expect(
			dictionaryIs(first, second, equality, equality).value,
		).toBeFalse()
	})

	test("the empty Dictionary equals one emptied by removal", () => {
		let emptied = removeAt(
			dictionary([text("a"), integer(1)]),
			text("a"),
			equality,
		)

		expect(
			dictionaryIs(dictionary(), emptied, equality, equality).value,
		).toBeTrue()
		expect(
			dictionaryIs(emptied, dictionary(), equality, equality).value,
		).toBeTrue()
	})

	test("a removed key does not count towards equality", () => {
		let held = dictionary([text("a"), integer(1)], [text("b"), integer(2)])
		let without = removeAt(held, text("b"), equality)
		let never = dictionary([text("a"), integer(1)])

		expect(
			dictionaryIs(without, never, equality, equality).value,
		).toBeTrue()
		expect(
			dictionaryIs(never, without, equality, equality).value,
		).toBeTrue()
		expect(dictionaryIs(held, never, equality, equality).value).toBeFalse()
	})

	test("equality reaches scan-path keys through the key witness", () => {
		let first = createDictionary<AnyType, AnyType>(
			[
				[
					createRecord({ id: integer(1), note: text("first") }),
					integer(1),
				],
			],
			byIdentifier,
		)
		let second = createDictionary<AnyType, AnyType>(
			[
				[
					createRecord({ id: integer(1), note: text("other") }),
					integer(1),
				],
			],
			byIdentifier,
		)

		expect(
			dictionaryIs(first, second, byIdentifier, equality).value,
		).toBeTrue()
		expect(
			dictionaryIs(first, second, equality, equality).value,
		).toBeFalse()
	})

	test("a key spelled two ways is one key on both sides", () => {
		let first = dictionary([integer(3), integer(1)])
		let second = dictionary([createRational(6n, 2n), integer(1)])

		expect(dictionaryIs(first, second, equality, equality).value).toBeTrue()
	})

	// A Record or a Case holding a Dictionary falls into the universal
	// comparison, which the kind registry answers. See "Dictionary equality" in
	// packages/runtime/DEVELOPMENT.md.
	test("the universal comparison answers order-insensitively too", () => {
		let first = dictionary([text("a"), integer(1)], [text("b"), integer(2)])
		let second = dictionary(
			[text("b"), integer(2)],
			[text("a"), integer(1)],
		)

		expect(anyIs(first as AnyType, second as AnyType)).toBeTrue()
		expect(anyIs(first as AnyType, first as AnyType)).toBeTrue()
		expect(
			anyIs(
				createRecord({ held: first as AnyType }),
				createRecord({ held: second as AnyType }),
			),
		).toBeTrue()
		expect(
			anyIs(
				first as AnyType,
				setAt(second, text("a"), integer(9), equality) as AnyType,
			),
		).toBeFalse()
		expect(
			anyIs(
				first as AnyType,
				removeAt(second, text("a"), equality) as AnyType,
			),
		).toBeFalse()
	})

	test("the universal comparison reaches scan-path keys as well", () => {
		let first = dictionary(
			[createRecord({ x: integer(1) }), integer(1)],
			[createRecord({ x: integer(2) }), integer(2)],
		)
		let second = dictionary(
			[createRecord({ x: integer(2) }), integer(2)],
			[createRecord({ x: integer(1) }), integer(1)],
		)

		expect(anyIs(first as AnyType, second as AnyType)).toBeTrue()
	})

	// A generic Choice's descriptor names a witness for each half of an entry,
	// and the Dictionary is compared through those.
	describe("the descriptor-driven equality", () => {
		const descriptor = {
			"Box#Full": {
				held: {
					k: "dictionary" as const,
					key: { k: "w" as const, i: 0 },
					value: { k: "w" as const, i: 0 },
				},
			},
		}

		const boxed = (held: AnyType): AnyType =>
			asValue({ [typeKeySymbol]: "Box#Full", held })

		test("two Cases holding the same entries in different orders are equal", () => {
			let first = dictionary(
				[text("a"), integer(1)],
				[text("b"), integer(2)],
			)
			let second = dictionary(
				[text("b"), integer(2)],
				[text("a"), integer(1)],
			)

			expect(
				boundChoiceIs(descriptor)(
					boxed(first as AnyType),
					boxed(second as AnyType),
					equality,
				).value,
			).toBeTrue()
		})

		test("a removed key is not counted by the descriptor equality either", () => {
			let first = removeAt(
				dictionary([text("a"), integer(1)], [text("b"), integer(2)]),
				text("b"),
				equality,
			)
			let second = dictionary([text("a"), integer(1)])

			expect(
				boundChoiceIs(descriptor)(
					boxed(first as AnyType),
					boxed(second as AnyType),
					equality,
				).value,
			).toBeTrue()
		})

		test("a differing value is caught by the descriptor equality", () => {
			let first = dictionary([text("a"), integer(1)])
			let second = dictionary([text("a"), integer(2)])

			expect(
				boundChoiceIs(descriptor)(
					boxed(first as AnyType),
					boxed(second as AnyType),
					equality,
				).value,
			).toBeFalse()
		})
	})
})

describe("map", () => {
	test("the keys and their encodings are kept", () => {
		let held = dictionary(
			[text("a"), integer(1)],
			[createRational(1n, 2n), integer(2)],
		)
		let doubled = mapEntries(held, (each) =>
			integer(numberOf(each.value) * 2),
		)

		expect(writtenForm(doubled)).toBe(`["a" = 2, 1/2 = 4]`)
		expect(doubled.store.slots[0].key).toBe(held.store.slots[0].key)
		expect(doubled.store.slots[0].encoded).toBe(held.store.slots[0].encoded)
		expect(doubled.store.index.get("a")).toBe(doubled.store.slots[0])
		expect(doubled.store.texts.get("1/2")).toBe(doubled.store.slots[1])
	})

	test("the transform is called once per live entry, in order, with the entry Record", () => {
		let held = dictionary(
			[text("a"), integer(1)],
			[text("b"), integer(2)],
			[text("c"), integer(3)],
		)
		let without = removeAt(held, text("b"), equality)
		let seen: Array<string> = []

		mapEntries(without, (each) => {
			seen.push(`${textOf(each.key)}=${numberOf(each.value)}`)

			return each.value
		})

		expect(seen).toEqual(["a=1", "c=3"])
	})

	test("the answer is a store of its own that can be written to", () => {
		let held = dictionary([text("a"), integer(1)], [text("b"), integer(2)])
		let doubled = mapEntries(held, (each) =>
			integer(numberOf(each.value) * 2),
		)
		let written = setAt(doubled, text("a"), integer(99), equality)
		let alsoWritten = setAt(doubled, text("c"), integer(7), equality)

		expect(doubled.store).not.toBe(held.store)
		expect(writtenForm(held)).toBe(`["a" = 1, "b" = 2]`)
		expect(writtenForm(doubled)).toBe(`["a" = 2, "b" = 4]`)
		expect(writtenForm(written)).toBe(`["a" = 99, "b" = 4]`)
		expect(writtenForm(alsoWritten)).toBe(`["a" = 2, "b" = 4, "c" = 7]`)

		// A write on the original must not reach the store `map` built from its
		// slots.
		let afterBase = setAt(held, text("b"), integer(50), equality)

		expect(writtenForm(afterBase)).toBe(`["a" = 1, "b" = 50]`)
		expect(writtenForm(doubled)).toBe(`["a" = 2, "b" = 4]`)
	})

	test("the empty Dictionary maps to the empty Dictionary", () => {
		let mapped = mapEntries(dictionary(), (each) => each.value)

		expect(lengthOf(mapped).value).toBe(0)
		expect(writtenForm(mapped)).toBe("[=]")
	})
})

// The filters share `map`'s claim: kept slots carry the receiver's keys and
// encodings into a store of their own. A scan-path slot stays one, since its
// `null` encoding is carried and counted.
describe("everyEntry and removeEvery", () => {
	const isEven = (each: { value: AnyType }) =>
		createBoolean(numberOf(each.value) % 2 === 0)

	test("the kept keys and their encodings are the receiver's own", () => {
		let held = dictionary(
			[text("a"), integer(1)],
			[createRational(1n, 2n), integer(2)],
			[text("c"), integer(3)],
			[asValue(createCase("Colour#Red")), integer(4)],
		)
		let even = everyEntry(held, isEven)
		let odd = removeEvery(held, isEven)

		expect(writtenForm(even)).toBe(`[1/2 = 2, Colour#Red = 4]`)
		expect(writtenForm(odd)).toBe(`["a" = 1, "c" = 3]`)
		expect(even.store.slots[0].key).toBe(held.store.slots[1].key)
		expect(even.store.slots[0].encoded).toBe(held.store.slots[1].encoded)
		expect(even.store.texts.get("1/2")).toBe(even.store.slots[0])
		expect(even.store.texts.get("c10:Colour#Red{};")).toBe(
			even.store.slots[1],
		)
		expect(odd.store.index.get("a")).toBe(odd.store.slots[0])
		expect(odd.store.index.get("c")).toBe(odd.store.slots[1])
		expect(even.store.unencoded).toBe(0)
		expect(odd.store.unencoded).toBe(0)
	})

	test("the check is called once per live entry, in order, with the entry Record", () => {
		let held = dictionary(
			[text("a"), integer(1)],
			[text("b"), integer(2)],
			[text("c"), integer(3)],
		)
		let without = removeAt(held, text("b"), equality)
		let seen: Array<string> = []

		removeEvery(without, (each) => {
			seen.push(`${textOf(each.key)}=${numberOf(each.value)}`)

			return createBoolean(false)
		})

		expect(seen).toEqual(["a=1", "c=3"])
	})

	test("a scan-path key stays a scan-path key in the answer", () => {
		let nested = createRecord({ rows: dictionary([text("x"), integer(1)]) })
		let held = dictionary([nested, integer(2)], [text("a"), integer(1)])
		let even = everyEntry(held, isEven)

		expect(held.store.unencoded).toBe(1)
		expect(lengthOf(even).value).toBe(1)
		expect(even.store.slots[0].encoded).toBeNull()
		expect(even.store.unencoded).toBe(1)
		expect(
			heldNumber(
				valueAt(
					even,
					createRecord({ rows: dictionary([text("x"), integer(1)]) }),
					equality,
				),
			),
		).toBe(2)
	})

	test("the answer is a store of its own that can be written to", () => {
		let held = dictionary([text("a"), integer(1)], [text("b"), integer(2)])
		let even = everyEntry(held, isEven)
		let written = setAt(even, text("a"), integer(9), equality)
		let afterBase = setAt(held, text("b"), integer(50), equality)

		expect(even.store).not.toBe(held.store)
		expect(writtenForm(even)).toBe(`["b" = 2]`)
		expect(writtenForm(written)).toBe(`["b" = 2, "a" = 9]`)
		expect(writtenForm(afterBase)).toBe(`["a" = 1, "b" = 50]`)
		expect(writtenForm(even)).toBe(`["b" = 2]`)
	})

	test("a check that keeps nothing answers the empty Dictionary", () => {
		let held = dictionary([text("a"), integer(1)])
		let none = everyEntry(held, () => createBoolean(false))
		let all = removeEvery(held, () => createBoolean(true))

		expect(writtenForm(none)).toBe("[=]")
		expect(writtenForm(all)).toBe("[=]")
		expect(lengthOf(everyEntry(dictionary(), isEven)).value).toBe(0)
	})
})

// `GroupedList.group` and `GroupedList.tally` build through this module's
// fresh-store doors. So they are asked what every construction is: the live
// entries, their order, and a store of their own.
describe("grouping a List", () => {
	const listOf = (...items: Array<AnyType>) => createList([...items])

	const groupText = (item: AnyType) => text(textOf(item).slice(0, 1))

	test("opens a group where its key is first met and appends to it after", () => {
		let grouped = group(
			listOf(text("apple"), text("banana"), text("avocado")),
			groupText,
			equality,
		)

		expect(keysOf(grouped).value.map(textOf)).toEqual(["a", "b"])
		expect(
			valuesOf(grouped).value.map((group) =>
				materialise(group as ListType<AnyType>).map(textOf),
			),
		).toEqual([["apple", "avocado"], ["banana"]])
	})

	// A List built at the front holds its first items in a reversed run, so the
	// logical walk decides the order.
	test("walks a List built at both ends in its logical order", () => {
		let grouped = group(
			prepend(listOf(text("banana"), text("avocado")), text("apple")),
			groupText,
			equality,
		)

		expect(keysOf(grouped).value.map(textOf)).toEqual(["a", "b"])
		expect(
			materialise(valuesOf(grouped).value[0] as ListType<AnyType>).map(
				textOf,
			),
		).toEqual(["apple", "avocado"])
	})

	test("the empty List groups into the empty Dictionary", () => {
		let grouped = group(createList([]), groupText, equality)

		expect(lengthOf(grouped).value).toBe(0)
		expect(writtenForm(grouped)).toBe("[=]")
	})

	// An unbranded witness sends every key down the scan path, so the group is
	// found by asking the witness.
	test("groups under a key that is found by asking the witness", () => {
		let grouped = group(
			listOf(integer(1), integer(2), integer(3), integer(4)),
			(item) =>
				createRecord({
					id: createBoolean(numberOf(item) % 2 === 0),
				}),
			byIdentifier,
		)

		expect(lengthOf(grouped).value).toBe(2)
		expect(
			valuesOf(grouped).value.map((group) =>
				materialise(group as ListType<AnyType>).map(numberOf),
			),
		).toEqual([
			[1, 3],
			[2, 4],
		])
	})

	test("counts each item, in the order the items are first met", () => {
		let counted = tally(
			listOf(text("a"), text("b"), text("a"), text("c"), text("a")),
			equality,
		)

		expect(writtenForm(counted)).toBe(`["a" = 3, "b" = 1, "c" = 1]`)
		expect(lengthOf(tally(createList([]), equality)).value).toBe(0)
	})

	// Two spellings of one value are one entry, which keeps the one that arrived
	// first.
	test("counts two spellings of one value as one item", () => {
		let counted = tally(
			listOf(integer(3), createRational(3n, 1n), integer(4)),
			equality,
		)

		expect(writtenForm(counted)).toBe("[3 = 2, 4 = 1]")
	})

	// A Namespace's own `is` decides which items are one, here Strings that
	// differ only in case.
	test("counts through a witness a Namespace wrote", () => {
		let counted = tally(
			listOf(text("Ada"), text("ada"), text("Grace")),
			looseText,
		)

		expect(writtenForm(counted)).toBe(`["Ada" = 2, "Grace" = 1]`)
	})

	// A gathered Dictionary is built at generation zero with one version per
	// slot, so a write on it is an ordinary tip write.
	test("answers a store of its own that can be written to", () => {
		let counted = tally(listOf(text("a"), text("b"), text("a")), equality)

		// Asked before writing, since `dead` belongs to the store the writes
		// share.
		expect(counted.generation).toBe(0)
		expect(counted.store.generation).toBe(0)
		expect(counted.store.dead).toBe(0)

		let written = setAt(counted, text("a"), integer(9), equality)
		let removed = removeAt(counted, text("a"), equality)

		expect(writtenForm(counted)).toBe(`["a" = 2, "b" = 1]`)
		expect(writtenForm(written)).toBe(`["a" = 9, "b" = 1]`)
		expect(writtenForm(removed)).toBe(`["b" = 1]`)
	})
})

// Random `set`, `remove` and `map` writes over a forking chain, against a plain
// `Map`. Its key rules are the design's: a rewritten key keeps its place, and a
// key deleted and rewritten goes to the end. Every box is asked again at the
// end, since no box may change its answer.
describe("a random chain of writes against a Map model", () => {
	// mulberry32: no dependency, and the same sequence on every engine.
	const seededRandom = (seed: number): (() => number) => {
		let state = seed >>> 0

		return () => {
			state = (state + 0x6d2b79f5) | 0

			let mixed = Math.imul(state ^ (state >>> 15), 1 | state)

			mixed =
				(mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

			return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
		}
	}

	type Candidate = { key: AnyType; identifier: string }
	type Entry = { key: AnyType; value: number }
	type Model = Map<string, Entry>

	// Equal keys share an identifier, so the model collapses them exactly where
	// the Dictionary must. That holds the encoding to `is`, not only the
	// bookkeeping.
	const pool: Array<Candidate> = [
		{ key: text("a"), identifier: "a" },
		{ key: text("b"), identifier: "b" },
		{ key: text(composedAccent), identifier: "accent" },
		{ key: text(decomposedAccent), identifier: "accent" },
		{ key: text(""), identifier: "empty" },
		{ key: text('he said "hi"\n\tand left\\'), identifier: "quoted" },
		{ key: integer(3), identifier: "3" },
		{ key: createRational(3n, 1n), identifier: "3" },
		{ key: createRational(6n, 2n), identifier: "3" },
		{ key: createRational(1n, 2n), identifier: "1/2" },
		{ key: createRational(2n, 4n), identifier: "1/2" },
		{ key: createRational(-1n, 2n), identifier: "-1/2" },
		{ key: createRational(1n, -2n), identifier: "-1/2" },
		{ key: createRational(0n, 5n), identifier: "0" },
		{ key: integer(0), identifier: "0" },
		{ key: createInteger(9007199254740993n), identifier: "big" },
		{ key: createRational(9007199254740993n, 1n), identifier: "big" },
		{ key: createBoolean(true), identifier: "true" },
		{ key: createBoolean(false), identifier: "false" },
		{ key: createRecord({ x: integer(1) }), identifier: "{x=1}" },
		{ key: createRecord({ x: integer(1) }), identifier: "{x=1}" },
		{ key: createRecord({ x: integer(2) }), identifier: "{x=2}" },
		{ key: asValue(createCase("Colour#Red")), identifier: "red" },
		{ key: asValue(createCase("Colour#Blue")), identifier: "blue" },
		{ key: createList([integer(1), integer(2)]), identifier: "[1,2]" },
	]

	// Plain String keys, so the linear chain has more slots than writes for any
	// one. One slot can then build a history before the repack rule fires.
	const ballast: Array<Candidate> = []

	for (let index = 0; index < 24; index++) {
		ballast.push({
			key: text(`filler${index}`),
			identifier: `filler${index}`,
		})
	}

	const everyKey = [...pool, ...ballast]

	const modelSet = (
		model: Model,
		candidate: Candidate,
		value: number,
	): Model => {
		let next = new Map(model)
		let standing = next.get(candidate.identifier)

		next.set(candidate.identifier, {
			key: standing === undefined ? candidate.key : standing.key,
			value,
		})

		return next
	}

	const modelRemove = (model: Model, candidate: Candidate): Model => {
		let next = new Map(model)

		next.delete(candidate.identifier)

		return next
	}

	const modelMap = (model: Model, move: (value: number) => number): Model =>
		new Map(
			[...model.entries()].map(([identifier, held]) => [
				identifier,
				{ key: held.key, value: move(held.value) },
			]),
		)

	const expectedPieces = (model: Model): Array<string> =>
		[...model.values()].map(
			(held) =>
				`${itemText(held.key, printing)} = ${itemText(
					integer(held.value),
					printing,
				)}`,
		)

	const expectedText = (model: Model): string =>
		model.size === 0 ? "[=]" : `[${expectedPieces(model).join(", ")}]`

	// The entries rebuilt backwards, so an equality that leant on slot order
	// would fail.
	const rebuiltBackwards = (model: Model): DictionaryType<AnyType, AnyType> =>
		createDictionary<AnyType, AnyType>(
			[...model.values()]
				.reverse()
				.map((held) => [held.key, integer(held.value)]),
			equality,
		)

	// Everything a box promises, asked of every box once the chain is finished.
	const expectAgreement = (
		box: DictionaryType<AnyType, AnyType>,
		model: Model,
		candidates: Array<Candidate>,
	) => {
		expect(lengthOf(box).value).toBe(model.size)
		expect(isEmpty(box).value).toBe(model.size === 0)

		let expected = [...model.values()]
		let answered = materialise(entriesOf(box))
		let keys = materialise(keysOf(box))
		let values = materialise(valuesOf(box))

		expect(answered.length).toBe(expected.length)
		expect(keys.length).toBe(expected.length)
		expect(values.length).toBe(expected.length)

		for (let index = 0; index < expected.length; index++) {
			let held = expected[index]

			// Identity: the slot answers the key box that arrived first, through
			// every overwrite, repack and `map`.
			expect(keys[index]).toBe(held.key)
			expect(answered[index].key).toBe(held.key)
			expect(numberOf(values[index])).toBe(held.value)
			expect(numberOf(answered[index].value)).toBe(held.value)
		}

		for (let candidate of candidates) {
			let standing = model.get(candidate.identifier)
			let answer = heldOf(valueAt(box, candidate.key, equality))

			if (standing === undefined) {
				expect(answer).toBeUndefined()
			} else {
				expect(answer).toBeDefined()
				expect(numberOf(answer as AnyType)).toBe(standing.value)
			}
		}

		// The printed form and the one `Terminal.inspect` writes are the
		// same text, which is the promise the registered renderer makes.
		let written = expectedText(model)

		expect(writtenForm(box)).toBe(written)

		let inspected = getStringRepresentation(box, 0, formatAsFraction, "")

		if (written.length < 60) {
			expect(inspected).toBe(written)
		} else {
			expect(inspected).toBe(
				`[\n    ${expectedPieces(model).join(",\n    ")}\n]`,
			)
		}

		// Equality against the same entries written backwards, through the
		// witnessed `is` and through the universal comparison.
		let mirror = rebuiltBackwards(model)

		expect(dictionaryIs(box, mirror, equality, equality).value).toBeTrue()
		expect(dictionaryIs(mirror, box, equality, equality).value).toBeTrue()
		expect(anyIs(box as AnyType, mirror as AnyType)).toBeTrue()

		// The Type test walks the same live view, so it sees only this box's
		// entries.
		expect(
			isValueOfType(
				box as AnyType,
				{ type: "GenericDictionary" } as never,
			),
		).toBeTrue()
		expect(
			isValueOfType(
				box as AnyType,
				{
					type: "Dictionary",
					keyType: { type: "Unknown" },
					valueType: { type: "Integer" },
				} as never,
			),
		).toBeTrue()
		expect(
			isValueOfType(
				box as AnyType,
				{
					type: "Dictionary",
					keyType: { type: "Unknown" },
					valueType: { type: "String" },
				} as never,
			),
		).toBe(model.size === 0)
		expect(
			isValueOfType(
				box as AnyType,
				{
					type: "Dictionary",
					keyType: { type: "String" },
					valueType: { type: "Integer" },
				} as never,
			),
		).toBe(
			[...model.values()].every(
				(held) => held.key[typeKeySymbol] === "String",
			),
		)
	}

	// The shape's promises: ascending stamps, indexes that agree with their
	// slots, and one slot per key. `dead` counts every version not live at the
	// tip.
	const expectStoreInvariants = (box: DictionaryType<AnyType, AnyType>) => {
		let store = box.store
		let totalVersions = 0
		let liveAtTip = 0
		let liveHere = 0
		let seen: Array<AnyType> = []

		expect(box.generation).toBeLessThanOrEqual(store.generation)

		for (let slot of store.slots) {
			expect(slot.versions.length).toBeGreaterThan(0)

			for (let index = 1; index < slot.versions.length; index++) {
				expect(slot.versions[index].generation).toBeGreaterThan(
					slot.versions[index - 1].generation,
				)
			}

			expect(slot.encoded).toEqual(encodeKey(slot.key, equality))

			if (slot.encoded !== null && typeof slot.encoded === "object") {
				expect(store.texts.get(slot.encoded.text)).toBe(slot)
			} else if (slot.encoded !== null) {
				expect(store.index.get(slot.encoded)).toBe(slot)
			}

			for (let other of seen) {
				expect(anyIs(other, slot.key)).toBeFalse()
			}

			seen.push(slot.key)
			totalVersions += slot.versions.length

			if (slot.versions[slot.versions.length - 1].value !== TOMBSTONE) {
				liveAtTip++
			}

			for (let index = slot.versions.length - 1; index >= 0; index--) {
				if (slot.versions[index].generation <= box.generation) {
					if (slot.versions[index].value !== TOMBSTONE) {
						liveHere++
					}

					break
				}
			}
		}

		expect(box.length).toBe(liveHere)
		expect(store.dead).toBe(totalVersions - liveAtTip)
		expect(store.index.size + store.texts.size).toBe(
			store.slots.filter((slot) => slot.encoded !== null).length,
		)
		expect(store.unencoded).toBe(
			store.slots.filter((slot) => slot.encoded === null).length,
		)
	}

	test("every box in the chain still answers what it answered", () => {
		let next = seededRandom(0x0dd1c7)
		let history: Array<{
			box: DictionaryType<AnyType, AnyType>
			model: Model
		}> = [{ box: dictionary(), model: new Map() }]
		let deepest = 0
		let mapped = 0
		let repacked = 0

		for (let step = 0; step < 700; step++) {
			// Two steps in three write from the newest box, building the linear
			// runs that give a slot a history. The rest fork, which drives the
			// repack.
			let source =
				next() < 0.66
					? history[history.length - 1]
					: history[Math.floor(next() * history.length)]
			let candidate =
				next() < 0.35
					? everyKey[0]
					: everyKey[Math.floor(next() * everyKey.length)]
			let draw = next()
			let box: DictionaryType<AnyType, AnyType>
			let model: Model

			if (draw < 0.62) {
				let amount = Math.floor(next() * 100)

				box = setAt(
					source.box,
					candidate.key,
					integer(amount),
					equality,
				)
				model = modelSet(source.model, candidate, amount)
			} else if (draw < 0.82) {
				box = removeAt(source.box, candidate.key, equality)
				model = modelRemove(source.model, candidate)
			} else {
				// `map` copies slots and their encodings out of a store others
				// still read, and its own store is then written to.
				box = mapEntries(source.box, (each) =>
					integer(numberOf(each.value) * 2 + 1),
				)
				model = modelMap(source.model, (value) => value * 2 + 1)
				mapped++
			}

			if (box.store !== source.box.store && box.store.generation <= 1) {
				repacked++
			}

			for (let slot of box.store.slots) {
				deepest = Math.max(deepest, slot.versions.length)
			}

			expectAgreement(box, model, pool)
			expectStoreInvariants(box)

			// The source box at once: a write into a shared store must leave
			// every reader where it was.
			expectAgreement(source.box, source.model, pool)
			expectStoreInvariants(source.box)

			history.push({ box, model })
		}

		// The walk must have reached a slot history, a sharing `map` and the
		// repack.
		expect(deepest).toBeGreaterThan(3)
		expect(mapped).toBeGreaterThan(50)
		expect(repacked).toBeGreaterThan(50)

		// Every box built is asked again after all the later writes.
		for (let { box, model } of history) {
			expectAgreement(box, model, everyKey)
			expectStoreInvariants(box)
		}
	})

	// This chain never forks and leans on one key, so that key's slot builds a
	// history while the dead count stays under the slot count. Together the
	// chains reach both ways into a repack.
	test("a linear chain bounds its history and still answers", () => {
		let next = seededRandom(6175)
		let history: Array<{
			box: DictionaryType<AnyType, AnyType>
			model: Model
		}> = [{ box: dictionary(), model: new Map() }]
		let deepest = 0

		for (let step = 0; step < 600; step++) {
			let source = history[history.length - 1]
			// Two writes in five go to one key, which builds the history.
			let candidate =
				next() < 0.4
					? everyKey[0]
					: everyKey[Math.floor(next() * everyKey.length)]
			let box: DictionaryType<AnyType, AnyType>
			let model: Model

			if (next() < 0.85) {
				let amount = Math.floor(next() * 100)

				box = setAt(
					source.box,
					candidate.key,
					integer(amount),
					equality,
				)
				model = modelSet(source.model, candidate, amount)
			} else {
				box = removeAt(source.box, candidate.key, equality)
				model = modelRemove(source.model, candidate)
			}

			for (let slot of box.store.slots) {
				deepest = Math.max(deepest, slot.versions.length)
			}

			expectAgreement(box, model, everyKey)
			expectStoreInvariants(box)
			history.push({ box, model })
		}

		// The history must grow past eight versions, bounded by the dead-versions
		// rule alone.
		expect(deepest).toBeGreaterThan(8)

		for (let { box, model } of history) {
			expectAgreement(box, model, everyKey)
			expectStoreInvariants(box)
		}
	})
})
