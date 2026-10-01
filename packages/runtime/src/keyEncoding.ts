import { reduced } from "./bigRational"
import type { BooleanType } from "./Boolean"
import type { IntegerType } from "./Integer"
import { canonical } from "./Integer"
import type { ListType } from "./List"
import { runsOf } from "./List"
import type { RationalType } from "./Rational"
import type { StringType } from "./String"
import { normalisedFormOf } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// The canonical key encoding, which Dictionaries and the set-shaped List
// natives find keys by. See "The key encoding" in DEVELOPMENT.md.
//
// A text travels in a box, so it never meets a String key's encoding.
export type TextKey = { text: string }

export type EncodedKey = string | number | bigint | boolean | TextKey

// The conforming Namespace's method map a bounded Method is handed.
// `structural` says its equality is the standard library's own. See "The
// structural brand" in DEVELOPMENT.md.
export type EquatableWitness<Value extends AnyType> = {
	is: (first: Value, second: Value) => BooleanType
	// Unread here, and named so that a whole witness fits the Type.
	isNot?: (first: Value, second: Value) => BooleanType
	structural?: true
}

// INVARIANT: two encodings are `===` exactly when the kind's `is` calls the
// keys equal. A kind that can not keep that answers `null`.
export function canonicalEncoding(key: AnyType): EncodedKey | null {
	// A Function has no tag, so it falls through to the scan path.
	let tag = key[typeKeySymbol]

	if (tag === "String") {
		// The NFC form, the same answer `stringEquals` decides by.
		return normalisedFormOf(key as StringType)
	} else if (tag === "Integer") {
		// One Integer has one representation, so the value itself is the key.
		return (key as IntegerType).value
	} else if (tag === "Rational") {
		let rational = key as RationalType

		// The reduced parts, so `1/2` and `2/4` are one key.
		let parts =
			rational.denominator === 1n
				? rational
				: reduced(rational.numerator, rational.denominator)

		if (parts.denominator === 1n) {
			// The Integer it equals, so `3` and `3/1` are one key.
			return canonical(parts.numerator)
		}

		// The sign is on the numerator, so the text is one per value.
		return { text: `${parts.numerator}/${parts.denominator}` }
	} else if (tag === "Boolean") {
		return (key as BooleanType).value
	}

	// A composite encodes as text when every part of it encodes.
	let text = compositeText(key, tag)

	if (text !== null) {
		return { text }
	}

	// The scan path, which asks the witness of every candidate.
	return null
}

// A payload-free Case's text, remembered on its shared instance. See
// "Composite key texts" in DEVELOPMENT.md.
const unitCaseTextKey: unique symbol = Symbol("unitCaseText")

// The head of a Case's text, `c<length>:<tag>`, remembered per tag for the
// Cases that carry a payload.
const caseHeads = new Map<string, string>()

function compositeText(value: AnyType, tag: unknown): string | null {
	if (tag === "Record") {
		return membersText("R", Object.keys(value), value)
	}

	if (tag === "List") {
		return listText(value as ListType<AnyType>)
	}

	if (typeof tag !== "string" || !tag.includes("#")) {
		return null
	}

	let memo = value as { [unitCaseTextKey]?: string }
	let remembered = memo[unitCaseTextKey]

	if (remembered !== undefined) {
		return remembered
	}

	let head = caseHeads.get(tag)

	if (head === undefined) {
		head = `c${tag.length}:${tag}`
		caseHeads.set(tag, head)
	}

	let names = Object.keys(value)

	if (names.length === 0) {
		let text = `${head}{};`

		memo[unitCaseTextKey] = text

		return text
	}

	return membersText(head, names, value)
}

function membersText(
	head: string,
	names: Array<string>,
	value: AnyType,
): string | null {
	let text = `${head}{`

	names.sort()

	for (let index = 0; index < names.length; index++) {
		let name = names[index]
		let member = partText((value as Record<string, AnyType>)[name])

		if (member === null) {
			return null
		}

		text += `${name.length}:${name}=${member}`
	}

	return `${text}};`
}

// A List's text, its item count and then each item's part, remembered on the
// box. It can not go stale, since a box's items never change. See "Composite
// key texts" in DEVELOPMENT.md.
const listTextKey: unique symbol = Symbol("listText")

function listText(value: ListType<AnyType>): string | null {
	let memo = value as { [listTextKey]?: string }
	let remembered = memo[listTextKey]

	if (remembered !== undefined) {
		return remembered
	}

	let view = runsOf(value)
	let text = `l${view.total}:`

	for (let index = view.frontCount - 1; index >= 0; index--) {
		let item = partText(view.front[index])

		if (item === null) {
			return null
		}

		text += item
	}

	for (let index = 0; index < view.backCount; index++) {
		let item = partText(view.back[index])

		if (item === null) {
			return null
		}

		text += item
	}

	memo[listTextKey] = text

	return text
}

// One self-delimiting part of a composite text. A whole Rational spells the
// Integer it equals, as `anyIs` compares them.
function partText(value: AnyType): string | null {
	// A Function compares by identity, which no text can spell.
	if (typeof value === "function") {
		return null
	}

	let tag = value[typeKeySymbol]

	if (tag === "String") {
		let form = normalisedFormOf(value as StringType)

		return `s${form.length}:${form}`
	} else if (tag === "Integer") {
		return `i${(value as IntegerType).value};`
	} else if (tag === "Rational") {
		let rational = value as RationalType
		let parts =
			rational.denominator === 1n
				? rational
				: reduced(rational.numerator, rational.denominator)

		return parts.denominator === 1n
			? `i${parts.numerator};`
			: `r${parts.numerator}/${parts.denominator};`
	} else if (tag === "Boolean") {
		return (value as BooleanType).value ? "t;" : "f;"
	}

	return compositeText(value, tag)
}

// The canonical encoding under a branded witness, and `null` otherwise, so a
// written `is` is never bypassed. See "The structural brand" in DEVELOPMENT.md.
export function encodeKey<Key extends AnyType>(
	key: Key,
	conformance: EquatableWitness<Key> | null,
): EncodedKey | null {
	return conformance !== null && conformance.structural === true
		? canonicalEncoding(key)
		: null
}

// A count per key for `mode`, keys in the order first met. It takes no
// witness. See "Key sets and counts" in DEVELOPMENT.md.
export type KeyCount<Key extends AnyType> = {
	primitives: Map<string | number | bigint | boolean, number>
	texts: Map<string, number>
	keys: Array<Key>
	counts: Array<number>
}

export function freshKeyCount<Key extends AnyType>(): KeyCount<Key> {
	return {
		primitives: new Map(),
		texts: new Map(),
		keys: [],
		counts: [],
	}
}

export function countKey<Key extends AnyType>(
	count: KeyCount<Key>,
	key: Key,
): void {
	let encoded = canonicalEncoding(key)

	if (encoded === null) {
		throw new Error(
			"A key of this kind has no canonical encoding to count it by.",
		)
	}

	let index =
		typeof encoded === "object"
			? count.texts.get(encoded.text)
			: count.primitives.get(encoded)

	if (index !== undefined) {
		count.counts[index] += 1

		return
	}

	let fresh = count.keys.length

	count.keys.push(key)
	count.counts.push(1)

	if (typeof encoded === "object") {
		count.texts.set(encoded.text, fresh)
	} else {
		count.primitives.set(encoded, fresh)
	}
}

// The keys a set-shaped List native has met. `keys` holds every key, for a
// probe with no encoding. See "Key sets and counts" in DEVELOPMENT.md.
export type KeySet<Key extends AnyType> = {
	primitives: Set<string | number | bigint | boolean>
	texts: Set<string>
	keys: Array<Key>
	unencoded: Array<Key>
	conformance: EquatableWitness<Key>
}

export function freshKeySet<Key extends AnyType>(
	conformance: EquatableWitness<Key>,
): KeySet<Key> {
	return {
		primitives: new Set(),
		texts: new Set(),
		keys: [],
		unencoded: [],
		conformance,
	}
}

// The scan path: each candidate asked through the witness.
function anyMatches<Key extends AnyType>(
	set: KeySet<Key>,
	candidates: Array<Key>,
	key: Key,
): boolean {
	for (let index = 0; index < candidates.length; index++) {
		if (set.conformance.is(candidates[index], key).value) {
			return true
		}
	}

	return false
}

function holds<Key extends AnyType>(
	set: KeySet<Key>,
	key: Key,
	encoded: EncodedKey | null,
): boolean {
	if (encoded === null) {
		return anyMatches(set, set.keys, key)
	}

	if (
		typeof encoded === "object"
			? set.texts.has(encoded.text)
			: set.primitives.has(encoded)
	) {
		return true
	}

	return set.unencoded.length === 0
		? false
		: anyMatches(set, set.unencoded, key)
}

export function hasKey<Key extends AnyType>(
	set: KeySet<Key>,
	key: Key,
): boolean {
	return holds(set, key, encodeKey(key, set.conformance))
}

// Adds the key and answers whether it was new, in one lookup.
export function addKey<Key extends AnyType>(
	set: KeySet<Key>,
	key: Key,
): boolean {
	let encoded = encodeKey(key, set.conformance)

	if (holds(set, key, encoded)) {
		return false
	}

	set.keys.push(key)

	if (encoded === null) {
		set.unencoded.push(key)
	} else if (typeof encoded === "object") {
		set.texts.add(encoded.text)
	} else {
		set.primitives.add(encoded)
	}

	return true
}
