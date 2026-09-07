import { describe, expect, test } from "bun:test"

import { createAlgebraic } from "../Algebraic"
import { createBoolean } from "../Boolean"
import type { DictionaryType, EntryRecord, Slot } from "../Dictionary"
import {
	createDictionary,
	encodeKey,
	entries as entriesOf,
	everyEntry,
	is as dictionaryIs,
	isEmpty,
	keys as keysOf,
	length as lengthOf,
	map as mapEntries,
	of as dictionaryOf,
	remove as removeAt,
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
import type { ListType } from "../List"
import {
	createList,
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
import { type AnyType, createCase, isValueOfType, typeKeySymbol } from "../type"

// NOTE: `CaseInstanceType` is deliberately kept out of `AnyType` — see the NOTE
// in `type.ts` — so a Case value is cast on the way in here exactly as the
// runtime helpers cast it internally.
const asValue = (value: unknown) => value as AnyType

const integer = (value: number): IntegerType => createInteger(BigInt(value))
const text = createString

// NOTE: The two spellings of one accented String, written as their code points
// so the file itself can not normalise them into each other. They are ONE
// String to the language — `String.is` is `compare(to other)::is(#Equal)` and
// `String.compare` reads the NFC form — so a Dictionary has to hold them under
// one key.
const composedAccent = "caf\u00E9"
const decomposedAccent = "cafe\u0301"

// NOTE: `anyIs` is the runtime's own structural comparison, and for every kind
// these tests use it decides exactly what the covering Namespace's `is` decides
// — including the two cross-kind rules a key encoding has to agree with: an
// Integer equals a whole Rational, and two canonically equivalent Strings are
// one String. So it stands in for the conformance witness the Compiler hands a
// bounded Method.
//
// NOTE: And it is BRANDED `structural`, which is the whole of what tells the
// runtime it may encode a key rather than ask: the Compiler brands the standard
// library's own equality for `String`, `Integer`, `Rational`, `Boolean` and the
// covering `Number`, and brands nothing a Namespace wrote. This witness stands
// for one of those, so it carries the brand.
const equality = {
	is: (first: AnyType, second: AnyType) =>
		createBoolean(anyIs(first, second)),
	structural: true as const,
}

// NOTE: The same equality WITHOUT the brand — what a Namespace-written `is`
// looks like to the runtime, whatever it decides. It answers exactly what the
// branded one does, so a Dictionary built through it holds exactly the same
// entries; what changes is that it is asked rather than encoded, which is what
// the tests below are about.
const witnessed = {
	is: equality.is,
}

// NOTE: A witness deliberately COARSER than the encoding — two Strings are one
// key when they differ only in case. It is the shape the Compiler builds for a
// user Namespace `for NonEmptyString is Equatable`, which the Enricher accepts
// (String's own conformance does not clash with a refinement's), and it is the
// witness every Dictionary native is then handed.
const looseText = {
	is: (first: AnyType, second: AnyType) =>
		createBoolean(
			first[typeKeySymbol] === "String" &&
				second[typeKeySymbol] === "String" &&
				(first as StringType).value.toLowerCase() ===
					(second as StringType).value.toLowerCase(),
		),
}

// NOTE: The Printable witness `Record.toString` builds for itself — the same
// walk with the fraction formatter, so a whole Rational prints its numerator
// alone. What a String does is decided before the witness is reached:
// `itemText` quotes one itself.
const printing = {
	toString: (value: AnyType) =>
		createString(getStringRepresentation(value, 0, formatAsFraction, "")),
}

// NOTE: A witness deliberately COARSER than structural equality — two keys are
// one key when their `id` members match, whatever else they hold. A lookup that
// compared the Records itself rather than asking the Namespace would answer
// differently, which is what makes this a test of the scan path rather than of
// `anyIs` a second time.
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

// NOTE: The written form is what the order tests assert against, because it
// says the two things they are about in one line — which entries are live, and
// in what order — and it is the reader's form the design fixed.
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

// NOTE: A String-keyed Dictionary of the given size, built the way a Program
// builds one it grows — a chain of writes rather than one pass — so that what
// the tests about repacking measure is the shape a real chain leaves behind.
const chainOf = (count: number): DictionaryType<AnyType, AnyType> => {
	let box = dictionary()

	for (let index = 0; index < count; index++) {
		box = setAt(box, text(`k${index}`), integer(index), equality)
	}

	return box
}

describe("key encoding", () => {
	// NOTE: The claim every fast-path lookup rests on, asserted kind by kind:
	// two keys encode to the same primitive exactly when the kind's own `is`
	// calls them equal.
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

	// NOTE: The encoding was a Symbol from the GLOBAL registry, which never
	// forgets one: every distinct fraction a Program ever looked a key up by
	// held about 265 bytes for the life of the process. What says the registry
	// is out of it is that the encoding is not a Symbol and that two encodings
	// of one value are two objects — there is no table anywhere interning them,
	// only the store's own index, which lives exactly as long as the entries.
	test("a Rational's encoding is not held by anything process-wide", () => {
		let first = encodeKey(createRational(1n, 3n), equality)
		let second = encodeKey(createRational(2n, 6n), equality)

		expect(typeof first).not.toBe("symbol")
		expect(first).not.toBe(second)
		expect(first).toEqual(second)
	})

	// NOTE: A fraction's text and a String's are in indexes of their own, which
	// is what keeps a String key spelled `1/2` and the Rational `1/2` apart.
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

	// NOTE: A Case's text opens with its tag, length-prefixed, and closes over
	// its payload members; a Record's opens with `R`. Every part inside is
	// length-prefixed or terminated, which is what makes the text one per
	// value — the tests further down hold it to that over drawn values.
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

	// NOTE: A part spells what the structural comparison calls it: a whole
	// Rational is the Integer it equals, a String is its NFC form, and a nested
	// Case is its tag before its members.
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

	// NOTE: A Case or a Record holding a part with no encoding has none itself,
	// because such a part is compared by a rule no text spells — a List by its
	// items through the universal comparison, a Function by identity.
	test("everything else takes the scan path", () => {
		expect(encodeKey(createList([integer(1)]), equality)).toBeNull()
		expect(
			encodeKey(
				createRecord({ items: createList([integer(1)]) }),
				equality,
			),
		).toBeNull()
		expect(
			encodeKey(
				asValue(createCase("Box#Full", { item: createList([]) })),
				equality,
			),
		).toBeNull()
		expect(
			encodeKey(
				createRecord({ handler: asValue((() => integer(1)) as never) }),
				equality,
			),
		).toBeNull()
		expect(encodeKey(dictionary(), equality)).toBeNull()
	})

	// NOTE: The encoding is a claim about the STANDARD LIBRARY'S equality for a
	// kind, so it may only be made where the witness in hand is that equality.
	// An unbranded witness — every one a Namespace wrote — takes the scan path
	// whatever the key is, and so does the empty literal's absent witness.
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
		// NOTE: The slot keeps the key it was OPENED with, so the answer is
		// still written down with the Integer the Program handed over.
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

	// NOTE: Every pairing the encoding has to agree with the comparison about,
	// in both directions: what `anyIs` calls equal lands in one slot, and what
	// it calls unequal lands in two. A single table so that a kind added to the
	// encoding has one place to be answered for.
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

// NOTE: THE CLAIM THE COMPOSITE ENCODING RESTS ON, held over drawn values
// rather than over a table: two Cases or Records that the structural comparison
// calls equal encode to one text, and two it calls unequal encode to two. The
// values are drawn over a fixed seed, so the sequence is the same in every run,
// and drawn SMALL, so that equal pairs turn up among the unequal ones.
//
// NOTE: Every drawn value is also RESPELLED — its Rationals written unreduced,
// its Strings decomposed, its members reordered — into a second value the
// comparison calls equal, so that the equal side of the claim is exercised on
// every draw and not only where two draws happen to coincide.
describe("the composite encoding agrees with the structural comparison", () => {
	// NOTE: Leaves drawn from a vocabulary of three or four values each, so
	// that distinct draws coincide often enough to exercise the equal half of
	// the claim on composite values, and not only on a value beside itself.
	const oneOf = (name: string, choices: Array<AnyType>): Generator => ({
		kind: "generated",
		name,
		generate: (source) => choices[below(source, choices.length)]!,
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

	// NOTE: An equal value spelled differently everywhere the encoding has a
	// rule to keep: a whole Rational for an Integer and an unreduced pair for
	// a Rational, the NFD form of a String, and the members in reverse order.
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

		// NOTE: The draw is small enough that distinct draws coincide, which is
		// what makes the equal half of the claim about more than one value
		// compared with itself.
		expect(equalPairs).toBeGreaterThan(40)
	})
})

// NOTE: A Record and a Case whose parts all encode are found in one step, the
// witness never asked — which is the whole of what the `structural` brand on
// `Record`'s witness and on a Choice's derived one buys. What decides which
// two are one key is still exactly what the witness would have said.
describe("composite keys", () => {
	// NOTE: Counting the witness's calls is the deterministic guard on the
	// encoded path: a lookup that took the scan path would ask it once per live
	// slot, and one that encoded asks it never.
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

	// NOTE: A thousand Case keys, every one found without the witness — the
	// shape the benchmark file measures, asserted here by instrumentation rather
	// than by a timing.
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

	// NOTE: A payload-free Case is one interned instance per tag, and its text
	// is remembered on that instance — so the second encoding is the same
	// String object as the first, and the memo is invisible to the members
	// `Record::is` and the derived equality read.
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
	test("a Record holding a List is found through the witness", () => {
		let held = dictionary([
			createRecord({ id: integer(1), tags: createList([text("a")]) }),
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
						tags: createList([text("a")]),
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
		// NOTE: An overwrite keeps the slot, and the slot keeps the key it was
		// opened with — so the `note` the second Record carried is not what the
		// Dictionary answers.
		expect(overwritten.store.slots[0].key).toBe(first)
	})

	// NOTE: One Record witness over Records that encode and Records that do
	// not — a `{ id: Integer, tags: List<String> }` beside a `{ id: Integer }`
	// under one `Record` key Type is not a Program the language admits, but
	// a Case whose payload member is a `Number` holds an Integer in one value
	// and an Algebraic in the next, and that is one Choice.
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

	// NOTE: A `Number` key Type is one witness over kinds that encode and a kind
	// that does not — an Algebraic is a Number and has no encoding — so one
	// store holds both kinds of slot under a branded witness. A lookup for an
	// encodable key that the index does not answer falls through to the slots
	// with no encoding, and a lookup for one of those scans from the start.
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

// NOTE: THE WITNESS THE COMPILER HANDS OVER IS THE ONE THE LOOKUP USES. A
// Namespace may write an `is` for a Type whose keys would otherwise encode —
// `namespace Loose for NonEmptyString is Equatable`, which calls two Strings
// equal when they differ only in case — and the Enricher accepts it, so it
// reaches every Dictionary native as the key witness. Encoding such a key by
// the canonical rule would answer what the standard library thinks rather than
// what the Program wrote.
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

	// NOTE: A store written through BOTH kinds of witness — which is what a
	// `Dictionary<NonEmptyString, …>` flowing where a `Dictionary<String, …>`
	// is expected would make — has to stay one Dictionary. The witnessed write
	// scans every live slot, encoded or not, so it finds what the fast path
	// wrote; and the fast path falls through to the scan while any slot stands
	// that the witnessed write left unencoded, so it finds what that wrote.
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
		// NOTE: And the boxes it was written from answer exactly what they did.
		expect(writtenForm(held)).toBe(`["a" = 1, "b" = 2, "c" = 3]`)
	})

	// NOTE: Twelve rounds of it, each on the answer of the last, because a
	// re-add repacks and the round after it is then made from a box that is one
	// generation into a store nobody else holds.
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

	// NOTE: `createList` TAKES OWNERSHIP of the Array it is handed, so two
	// answers may never be one Array — an append onto the first would otherwise
	// show up in the second.
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

		// NOTE: All four over ONE store — a tip write is a version pushed and a
		// box over it, and nothing was copied.
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

		// NOTE: Read again in a different order, which is what a shared store
		// makes possible to get wrong.
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
	// NOTE: `dead` is the count of versions that are no longer any live key's
	// newest: an overwrite leaves one behind, a removal leaves two (the value
	// it replaced and the tombstone replacing it), an opened slot leaves none.
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
		// NOTE: The box the repack was made from answers what it answered — it
		// was moved onto the fresh store, and its view of that store is the one
		// the repack copied.
		expect(writtenForm(box)).toBe(`["a" = 3, "b" = 0]`)
	})

	// NOTE: The rule the version cap used to hide. Overwriting ONE key of a
	// large Dictionary leaves one dead version per write, so the store repacks
	// once every `slots.length` writes and no oftener — where a cap of eight
	// versions per slot repacked every seventh write whatever the Dictionary
	// held, which measured 7.6 seconds over 1,428 repacks against 5.5
	// milliseconds for the same 10,000 writes spread over 100,000 keys.
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

		// NOTE: One repack per 1,001 writes — the store carries 1,000 slots, so
		// the 1,001st dead version is the first to outnumber them. Ten is the
		// arithmetic; a cap of eight versions per slot would have been 1,428.
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

		// NOTE: And now WRITE on the oldest one, which has a store's worth of
		// somebody else's history in front of it.
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

		// NOTE: Removals count TWO dead versions each, so a two-slot store is
		// over its limit after one of them — which is what makes this the
		// dead-versions rule rather than a fork.
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
		// NOTE: A second box over the same store is what makes the write after
		// it a forked one, which repacks whatever the counters say.
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

	// NOTE: A box that is written from more than once is a BASE somebody is
	// deriving from, and every one of those writes forks and so repacks. The
	// repack moves the base onto the store it built, so the second derivation
	// copies what the base holds rather than walking the history it was left
	// behind by — 497 ms to 310 ms for a thousand derivations from a
	// 10,000-entry box with 10,000 versions standing on one of its slots.
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

		// NOTE: The base stands on a store of its own now: its own entries,
		// one version each, plus the one slot the derivation appended — which
		// is the whole of what the next repack from it has to copy, where
		// before it was two thousand versions on one slot.
		expect(base.store).not.toBe(bloated)
		expect(base.generation).toBe(0)
		expect(base.store.slots.length).toBe(201)
		expect(
			base.store.slots.every((slot) => slot.versions.length === 1),
		).toBeTrue()
		expect(lengthOf(base).value).toBe(200)
		expect(heldNumber(valueAt(base, text("k0"), equality))).toBe(0)

		// NOTE: And the thousand derivations after it each answer their own
		// entries, out of a base that never grows a history of somebody else's.
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
		// NOTE: A store built in one pass carries no history at all — the
		// duplicate was written OVER the version standing there rather than
		// pushed after it.
		expect(held.store.dead).toBe(0)
	})

	// NOTE: A List holds its items in two runs, and one built by prepending
	// holds them in the FRONT run, which is read backwards. `of` has to answer
	// the same Dictionary for either representation.
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

	// NOTE: The empty literal `[=]` is built with no witness at all, because it
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
		// NOTE: And the box it was removed from still answers it, which is the
		// whole of what a tombstone is for.
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

	// NOTE: A Dictionary inside a Record is rendered by the walk in
	// `Terminal.ts`, which reaches the Dictionary's own renderer through the
	// kind registry — so the two forms have to be one text.
	test("a nested Dictionary renders the same inside a Record as on its own", () => {
		let inner = dictionary([text("a"), integer(1)])
		let outer = createRecord({ held: inner as AnyType })

		expect(getStringRepresentation(outer, 0, formatAsFraction, "")).toBe(
			'{ held = ["a" = 1] }',
		)
	})

	// NOTE: `Terminal.inspect` breaks a rendering over lines once the single
	// line would be too long, and pads inside the brackets — the same layout it
	// gives a List.
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

	// NOTE: The UNIVERSAL comparison — no witness in hand — is what a Record or
	// a Case holding a Dictionary falls into, and it is answered by the kind
	// registry rather than by a Dictionary arm inside `internalHelpers.ts`.
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

	// NOTE: The comparison a generic Choice reaches — the descriptor names a
	// witness for each half of an entry, and the Dictionary is compared through
	// those rather than through the universal one.
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

		// NOTE: And the reverse — a write on the ORIGINAL must not reach the
		// store `map` built out of its slots.
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

// NOTE: The filter and its complement share `map`'s claim — the kept slots
// carry the receiver's keys and encodings, and the answer is a store of its
// own — and add one of their own: a slot that took the scan path on the
// receiver takes it on the answer, because its `null` encoding is carried over
// and counted, so a later lookup on the answer still falls through to the walk
// that finds it.
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
		let listed = createRecord({ items: createList([integer(1)]) })
		let held = dictionary([listed, integer(2)], [text("a"), integer(1)])
		let even = everyEntry(held, isEven)

		expect(held.store.unencoded).toBe(1)
		expect(lengthOf(even).value).toBe(1)
		expect(even.store.slots[0].encoded).toBeNull()
		expect(even.store.unencoded).toBe(1)
		expect(
			heldNumber(
				valueAt(
					even,
					createRecord({ items: createList([integer(1)]) }),
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

// NOTE: The two natives that GATHER a Dictionary rather than being handed one
// — `GroupedList.group` and `GroupedList.tally`
// (`packages/standard-library/sources/Dictionary.es`). They build through this
// module's own fresh-store doors, so what is asked of them here is what is
// asked of every other construction: which entries are live, in what order, and
// that the answer is a store of its own a write may be made on.
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

	// NOTE: A List built at the FRONT holds its first items in a second run,
	// stored reversed, so a native that read the backing Array would group them
	// backwards. What decides the order here is the logical walk.
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

	// NOTE: A key of a kind that does not encode takes the scan path, exactly
	// as it does for every other Dictionary native — the group is found by
	// asking the witness about the slots standing.
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

	// NOTE: Two items that are ONE item to the language are one entry here, and
	// the one that arrived first is the one the entry keeps — the same rule
	// every other construction follows. `3` and `3/1` are the pair the
	// cross-kind encoding is written for.
	test("counts two spellings of one value as one item", () => {
		let counted = tally(
			listOf(integer(3), createRational(3n, 1n), integer(4)),
			equality,
		)

		expect(writtenForm(counted)).toBe("[3 = 2, 4 = 1]")
	})

	// NOTE: An unbranded witness is the shape a Namespace-written `is` arrives
	// in, and it decides which two items are one item. Two Strings that differ
	// only in case are one key to this one, so the tally counts them together
	// and keeps the spelling that arrived first.
	test("counts through a witness a Namespace wrote", () => {
		let counted = tally(
			listOf(text("Ada"), text("ada"), text("Grace")),
			looseText,
		)

		expect(writtenForm(counted)).toBe(`["Ada" = 2, "Grace" = 1]`)
	})

	// NOTE: What a gathered Dictionary has to be: an ordinary one. It is built
	// at generation zero with one version per slot, which is the shape a repack
	// leaves a store in, so a write on it is a tip write like any other.
	test("answers a store of its own that can be written to", () => {
		let counted = tally(listOf(text("a"), text("b"), text("a")), equality)

		// NOTE: Asked before anything is written, because `dead` is a property
		// of the STORE at its tip and the writes below share this one.
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

// NOTE: THE MODEL-BASED WALK. Nothing above it asks what happens when the three
// writers — `set`, `remove` and `map` — are mixed at random over a chain that
// forks constantly, and that is where a shared store is easiest to get wrong.
//
// NOTE: What it holds the store against is a plain `Map`, whose own key rules
// are exactly the ones the design asks for — a key written again keeps its
// place, and a key deleted and written again goes to the end — so the model is
// the specification rather than a second implementation of it.
//
// NOTE: Every write is made from a box drawn out of everything built so far,
// which is what makes the chain FORK, and every box built along the way is
// asked again at the end. A box that answered one thing and then answered
// another after somebody else wrote is the failure this is looking for.
describe("a random chain of writes against a Map model", () => {
	// NOTE: mulberry32 — four lines, no dependency, and the same sequence on
	// every engine, which is the whole of what a test needs of a generator.
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

	// NOTE: Keys that are EQUAL share an identifier — the composed and the
	// decomposed accent, the Integer and the whole Rationals, the halves and
	// their sign spellings, the two structurally equal Records — so the model
	// collapses them into one entry exactly where the Dictionary has to. That
	// is what makes this a test of the encoding agreeing with `is` rather than
	// of the bookkeeping alone.
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

	// NOTE: Plain String keys with nothing interesting about them, so that the
	// linear chain below has more slots than it has writes to spend on any one
	// of them — which is what lets one slot build a real history before the
	// store's dead count reaches the repack rule. The interesting keys are the
	// pool above; these are ballast, and both chains draw from one list so
	// there is one answer to what a key that comes back is.
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

	// NOTE: The model's entries rebuilt BACKWARDS, so an equality that leant on
	// the order of the slots would answer `false` for two boxes that hold
	// exactly the same entries.
	const rebuiltBackwards = (model: Model): DictionaryType<AnyType, AnyType> =>
		createDictionary<AnyType, AnyType>(
			[...model.values()]
				.reverse()
				.map((held) => [held.key, integer(held.value)]),
			equality,
		)

	// NOTE: The whole of what a box promises, asked of every box in the chain
	// after the chain is finished: how many entries, in what order, what each
	// key it could have been written with answers, what it prints as, what it
	// is equal to, and what Type it answers for.
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

			// NOTE: Identity, not equality — the slot has to answer the very
			// key box that arrived FIRST under this identity, through every
			// overwrite, every repack and every `map`.
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

		// NOTE: The printed form and the one `Terminal.inspect` writes are the
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

		// NOTE: Equality against the same entries written backwards, both
		// through the witnessed `is` and through the universal comparison every
		// Record holding one falls into.
		let mirror = rebuiltBackwards(model)

		expect(dictionaryIs(box, mirror, equality, equality).value).toBeTrue()
		expect(dictionaryIs(mirror, box, equality, equality).value).toBeTrue()
		expect(anyIs(box as AnyType, mirror as AnyType)).toBeTrue()

		// NOTE: The Type test walks the same live view, so a box answers for
		// exactly the entries it holds and nothing a later write added.
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

	// NOTE: And the promises the SHAPE makes, which no reader would notice
	// breaking until a much later write did: ascending stamps, indexes that
	// agree with the slots they point at, one slot per key, and a `dead` count
	// that is the whole history minus what is live at the tip.
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
			// NOTE: Two steps in three write from the NEWEST box and one from
			// somewhere in the history, so the walk both builds long linear
			// runs — which is what gives a slot a history — and forks
			// constantly, which is what drives the repack.
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
				// NOTE: `map` is the third writer, and the one the sharing
				// doctrine is easiest to break with — it copies slots and their
				// ENCODINGS out of a store other boxes are still reading, and
				// the store it builds is then written to.
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

			// NOTE: And the box it was written FROM, immediately — a write that
			// pushed into a shared store has to have left every reader of that
			// store exactly where it was.
			expectAgreement(source.box, source.model, pool)
			expectStoreInvariants(source.box)

			history.push({ box, model })
		}

		// NOTE: The walk has to have REACHED the shapes it claims to test: a
		// real history on a slot, a `map` that shares encodings out of a store
		// others still read, and the repack.
		expect(deepest).toBeGreaterThan(3)
		expect(mapped).toBeGreaterThan(50)
		expect(repacked).toBeGreaterThan(50)

		// NOTE: The point of the whole exercise — every box built along the
		// way, asked again now that seven hundred later writes have gone past.
		for (let { box, model } of history) {
			expectAgreement(box, model, everyKey)
			expectStoreInvariants(box)
		}
	})

	// NOTE: The chain above FORKS at nearly every step, so it repacks
	// constantly and no slot in it builds much history. This one never forks —
	// every write is made from the newest box — and it leans on one key out of
	// forty-nine, which is what lets that key's slot carry a real history while
	// the store's dead count is still under its slot count. Between the two
	// chains both ways into a repack are reached by a walk nobody wrote the
	// steps of.
	test("a linear chain bounds its history and still answers", () => {
		let next = seededRandom(6175)
		let history: Array<{
			box: DictionaryType<AnyType, AnyType>
			model: Model
		}> = [{ box: dictionary(), model: new Map() }]
		let deepest = 0

		for (let step = 0; step < 600; step++) {
			let source = history[history.length - 1]
			// NOTE: Two writes in five go to the same key, which is the lean
			// that builds a history at all.
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

		// NOTE: The chain has to have built a history longer than the cap that
		// used to be here, or it would be passing by doing nothing the unit
		// tests above do not already do. What bounds it is the dead-versions
		// rule alone, and the invariants above are what say it is bounded.
		expect(deepest).toBeGreaterThan(8)

		for (let { box, model } of history) {
			expectAgreement(box, model, everyKey)
			expectStoreInvariants(box)
		}
	})
})
