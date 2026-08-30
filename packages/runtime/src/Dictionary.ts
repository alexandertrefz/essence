import { reduced } from "./bigRational"
import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { canonical, createInteger } from "./Integer"
import type { ListType } from "./List"
import { createList, runsOf } from "./List"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { RationalType } from "./Rational"
import type { RecordType } from "./Record"
import { registerKind, type RenderPart, singleLineMaxLength } from "./registry"
import type { StringType } from "./String"
import { createString, itemText, normalisedFormOf } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: A Dictionary is a generation-stamped SHARED STORE. The store holds one
// slot per key in insertion order, and each slot holds the versions its value
// has had, each stamped with the write that made it. A box is a VIEW of that
// store at one generation: it sees every version stamped at or below its own,
// and nothing later. So a write is a version pushed onto a shared Array and a
// new box over it — O(1) — and the box that was written FROM still answers
// exactly what it answered before, because the version the write pushed is
// stamped past it.
//
// NOTE: The doctrine is `List.ts`'s, applied to keys rather than to items:
// "None of this is observable. Every Essence value is immutable and the
// language has no way to ask whether two values are the SAME value, so a shared
// structure is indistinguishable from a copied one for as long as every box
// answers exactly the items its view holds." What keeps that promise here is
// that every reader — lookup, iteration, printing, equality, `keys`, `values`,
// `entries`, `map` — reads through `liveValueOf` and through nothing else.
//
// NOTE: One rule bounds the history a store carries, checked on the write that
// would grow it: a store whose dead versions outnumber its slots is REPACKED
// into a fresh store holding one version per live key. A write on a box that is
// not the store's tip repacks as well — the chain has forked, and the two
// branches must not write into one another's future.
//
// NOTE: What a Program pays for a Dictionary that nothing else already carries:
// the 587 bytes of `bigRational`'s `reduced` and the greatest common divisor it
// calls, which a Rational key's encoding asks for. They ride in wherever a
// Dictionary does, whatever its keys are, because the encoding is one function
// with an arm per kind — and a Program holding Rationals at all carries them
// anyway.
//
// NOTE: And one shape costs more than it reads as. A key REMOVED and then
// written again lands at the end, which only dropping its tombstoned slot can
// arrange — so each such round is a repack, O(live entries), rather than the
// two O(1) writes it looks like. A loop that takes a key out and puts it back
// on every turn is quadratic in the entries the Dictionary holds: a thousand
// such rounds measured 25 ms on a Dictionary of a thousand entries and 306 ms
// on one of ten thousand. A loop that overwrites a key is not, and overwriting
// is what a Program usually means.

// NOTE: A removed key's newest version. It is a Symbol rather than a sentinel
// value of the Value Type because there is no value a Program can not store: a
// Dictionary of Optionals holds `#Empty`, and a Dictionary of Dictionaries
// holds the empty one, so any in-band spelling of "removed" would be a value
// some Program means.
export const TOMBSTONE: unique symbol = Symbol("tombstone")

// NOTE: What a key is reduced to for the Map that finds it in one step. Every
// kind that has one is encoded into a JavaScript primitive whose `===` — the
// equality a `Map` decides its keys by — agrees exactly with what that kind's
// own `is` says. A kind with no such encoding answers `null` and is found by
// the scan path instead; see `encodeKey`.
//
// NOTE: A non-whole Rational is the one encoding no primitive spells. Its
// reduced parts as text would be a String key's encoding — every String is a
// possible one — so it is carried in a box of its own, which a store keeps in
// an index of its own, keyed by that text. The box is what says which of the
// two indexes answers for an encoding; it is read with one `typeof`, and a
// String key, which is the hot one, fails that test in a step and goes straight
// to a raw-string `Map.get`.
export type FractionKey = { fraction: string }

export type EncodedKey = string | number | bigint | boolean | FractionKey

// NOTE: One value a key has held, and the generation of the write that gave it
// that value. A slot's versions ascend by generation with the newest last,
// which is what lets `versionAt` walk back from the end and stop at the first
// version a box can see.
type Version<Value> = { value: Value | typeof TOMBSTONE; generation: number }

export type Slot<Key, Value> = {
	// NOTE: The original key box, held so that `keys()` and `entries()` answer
	// the value a Program handed over rather than something rebuilt out of its
	// encoding. Two equal keys can be spelled differently — `3` and `3/1` under
	// a `Number` key Type — and the one that arrived FIRST is the one the slot
	// keeps, exactly as the first insertion keeps the slot's position.
	key: Key
	// NOTE: `null` means the SCAN PATH: this key is compared through the
	// Equatable witness rather than looked up.
	encoded: EncodedKey | null
	versions: Array<Version<Value>>
}

export type Store<Key, Value> = {
	// NOTE: INSERTION ORDER, and the one source of truth for iteration. A slot
	// is never moved and never removed: a key that is overwritten keeps its
	// place because its slot does, and a key that is removed leaves a
	// tombstoned slot standing where it was until a repack drops it.
	slots: Array<Slot<Key, Value>>
	// NOTE: Every slot of this store whose key encodes to a primitive, whether
	// that slot is live at a given box's generation or not. Visibility is
	// decided by the version stamps, never by what the index holds, so the two
	// can not disagree about what a box sees.
	index: Map<string | number | bigint | boolean, Slot<Key, Value>>
	// NOTE: The same, for the keys whose encoding is a fraction's text. They
	// are apart because no one Map can hold both without a String key and a
	// Rational one being able to collide — see `FractionKey`.
	fractions: Map<string, Slot<Key, Value>>
	// NOTE: The newest write the store holds. A box whose generation is this
	// one is the TIP and may write in place.
	generation: number
	// NOTE: Versions that are no longer any live key's newest — superseded
	// values and tombstones — counted so the repack rule below can be asked in
	// O(1). It is a property of the store at its TIP, which is the only view a
	// write is ever made from.
	dead: number
	// NOTE: How many slots stand here with no encoding, so that a lookup which
	// the index does not answer knows whether there is anywhere else to look.
	// A slot has none for one of two reasons: its key is of a kind that does
	// not encode, or the write that opened it compared keys through a witness
	// of its own and left the encoding out (see `encodeKey`). The second is
	// what makes this a count rather than a claim about the key Type — a store
	// written through both kinds of witness holds both kinds of slot, and a
	// later fast-path lookup must still find what the other one wrote.
	unencoded: number
}

export type DictionaryType<Key extends AnyType, Value extends AnyType> = {
	[typeKeySymbol]: "Dictionary"
	store: Store<Key, Value>
	// NOTE: This box sees every version stamped at or below this generation.
	generation: number
	// NOTE: Live entries at that generation, carried rather than counted: a
	// walk of the slots would be O(n) for a question `length()` and `isEmpty()`
	// ask constantly, and every write already knows whether it added a key,
	// took one away, or did neither.
	length: number
}

// NOTE: The entry a Dictionary is written in terms of, and the one shape every
// callback receives — a Record of `key` and `value`, so a caller can take it
// apart with a Pattern. Built as a literal rather than through `createRecord`
// for its Type, exactly as `List.enumerate` and `List.pair` build theirs.
export type EntryRecord<
	Key extends AnyType,
	Value extends AnyType,
> = RecordType & { key: Key; value: Value }

// NOTE: What a bounded Method is handed after its declared Parameters — the
// conforming Namespace's method map. Only the member each native reads is
// named, which is what `List.is` and `List.join` name of theirs.
//
// NOTE: `structural` is the one thing a Dictionary asks of a witness that no
// other native asks: whether the equality it carries is the standard library's
// own for a kind whose keys encode. The Compiler brands it, and it brands
// nothing else — see `encodeKey`.
export type EquatableWitness<Value extends AnyType> = {
	is: (first: Value, second: Value) => BooleanType
	// NOTE: Named so that a witness may be written down whole, as the generated
	// conformance and the property-test generators write theirs. Nothing here
	// reads it: a Dictionary asks whether two keys are one key and never
	// whether they are not.
	isNot?: (first: Value, second: Value) => BooleanType
	structural?: true
}

type PrintableWitness<Value extends AnyType> = {
	toString: (value: Value) => StringType
}

// NOTE: THE CANONICAL KEY ENCODING. The whole of the fast path rests on one
// claim: for two keys that both encode, the encodings are `===` exactly when
// the standard library's `is` for that kind says the keys are equal. Every arm
// below is written to keep that claim, and a kind that can not keep it answers
// `null` rather than weaken it.
function canonicalEncoding(key: AnyType): EncodedKey | null {
	// NOTE: A Function carries no Type key at all — it is emitted as a bare
	// JavaScript function — so reading the tag off one answers `undefined` and
	// falls to the scan path below, which is where a value with no equality of
	// its own belongs.
	let tag = key[typeKeySymbol]

	if (tag === "String") {
		// NOTE: The NFC-normalised text, not the raw one. `String.is` is
		// `compare(to other)::is(#Equal)` in Essence, and `String.compare` is
		// lexicographic by code point over the NFC-normalised String — so an
		// accent written as one code point and the same accent written as a
		// base and a combining mark are one String to the language. Encoding
		// the raw `.value` would put those two in two slots, and a Dictionary
		// would then hold a key twice that its own `hasKey` says it holds once.
		//
		// NOTE: `normalisedFormOf` is asked rather than computed: it remembers
		// the answer on the String value under a Symbol key, and it is the same
		// answer `stringEquals` — the shortcut the Compiler emits for
		// `a::is(b)` on two Strings — is decided by. So the encoding and the
		// equality are literally one function's answer rather than two that
		// have to agree.
		return normalisedFormOf(key as StringType)
	} else if (tag === "Integer") {
		// NOTE: What the Integer holds, untouched. `createInteger`
		// canonicalises — a number inside ±(2⁵³ − 1), a bigint beyond — so one
		// mathematical Integer has exactly one representation and `===` on it
		// is the whole of `Integer.is`. Numbers and bigints are distinct Map
		// key spaces, which is exactly right: two values spelled in different
		// representations have different magnitudes and are not equal.
		return (key as IntegerType).value
	} else if (tag === "Rational") {
		let rational = key as RationalType

		// NOTE: A Rational holds the parts it was built with — `4/2` holds 4
		// and 2 — and its `is` cross-multiplies those raw parts, so the
		// encoding has to be of the reduced form or `1/2` and `2/4` would land
		// in two slots. A denominator that is already `1n` needs no reduction,
		// which is the shape a widened Integer arrives in.
		let parts =
			rational.denominator === 1n
				? rational
				: reduced(rational.numerator, rational.denominator)

		if (parts.denominator === 1n) {
			// NOTE: A whole Rational encodes as the Integer it equals, and that
			// is what makes `3` and `3/1` one key under a covering `Number` key
			// Type: `Number.is` answers by value across the two kinds, so the
			// two spellings have to reach one slot. `canonical` is the same
			// narrowing `createInteger` applies, so the two arms land on the
			// same primitive for the same value.
			return canonical(parts.numerator)
		}

		// NOTE: The reduced parts as text, in the box that sends it to the
		// store's own fraction index. The sign is on the numerator, which
		// `reduced` guarantees, so the text is one per value.
		//
		// NOTE: It was `Symbol.for` — the global Symbol registry answers the
		// same Symbol for the same text, which is exactly the interning a Map
		// key wants. What it never does is forget one: every distinct fraction
		// a Program ever looked a key up by held about 265 bytes for the life
		// of the process, whether a Dictionary still held it or not. A Map on
		// the store is interning of the same shape with the same lifetime as
		// the entries it is about.
		return { fraction: `${parts.numerator}/${parts.denominator}` }
	} else if (tag === "Boolean") {
		return (key as BooleanType).value
	}

	// NOTE: THE SCAN PATH — Records, Cases, Lists, Algebraics,
	// Transcendentals, and anything else. Such a key is found by walking the
	// slots and asking the Equatable witness, which is correct for every key
	// Type the language has and costs O(n) for the Types that take it. It is
	// invisible from Essence: the same Methods answer the same things, only
	// slower.
	//
	// NOTE: A unit Case could plainly be encoded — its tag is its whole value —
	// and it is deliberately not. A Choice's `is` is whatever its covering
	// Namespace writes, and a Namespace may write one that is not tag equality
	// (a Case that counts as equal to another, an `is` that reads a payload the
	// unit Case does not have). Encoding would decide those cases here instead
	// of there. The scan path asks the Namespace, which is the only answer that
	// can not be wrong. If Choices ever gain an `is` the language owns, this is
	// the arm to add.
	return null
}

// NOTE: What a call may encode a key by, which is the canonical encoding only
// where the witness the call was handed is the standard library's own equality
// for the key's kind. The Compiler brands such a witness `structural` — the
// conformance resolved to `String`, `Integer`, `Rational`, `Boolean` or the
// covering `Number`, or to a refinement of one of those that inherits its `is`
// — and brands nothing that a Namespace wrote.
//
// NOTE: This is the whole of what keeps a user-written `is` from being ignored.
// A `namespace Loose for NonEmptyString is Equatable` that calls two Strings
// equal when they differ only in case is accepted by the Compiler and handed to
// every Dictionary native as the key witness; encoding by the canonical rule
// would have put "Ada" and "ada" in two slots and answered nothing for a lookup
// the witness says holds. An unbranded witness answers `null` here, which is
// the scan path — every live slot compared through the witness itself — and
// the scan is what a Dictionary is then both written and read by.
//
// NOTE: A `null` witness is what the empty literal `[=]` is built with. It
// holds no key, so it never reaches an arm that would compare one.
export function encodeKey<Key extends AnyType>(
	key: Key,
	conformance: EquatableWitness<Key> | null,
): EncodedKey | null {
	return conformance !== null && conformance.structural === true
		? canonicalEncoding(key)
		: null
}

// NOTE: The slot an encoding stands under, in whichever of the store's two
// indexes answers for it. The `typeof` is the routing: a fraction's encoding is
// the one that is an object, and every other kind's is a primitive.
function slotUnder<Key extends AnyType, Value extends AnyType>(
	store: Store<Key, Value>,
	encoded: EncodedKey,
): Slot<Key, Value> | undefined {
	return typeof encoded === "object"
		? store.fractions.get(encoded.fraction)
		: store.index.get(encoded)
}

// NOTE: A slot filed under its own encoding, or counted as one more the indexes
// can not answer for. Every place that opens a slot goes through here, so the
// two indexes and the count can not drift from the slots they are about.
function fileSlot<Key extends AnyType, Value extends AnyType>(
	store: Store<Key, Value>,
	slot: Slot<Key, Value>,
): void {
	let encoded = slot.encoded

	if (encoded === null) {
		store.unencoded++
	} else if (typeof encoded === "object") {
		store.fractions.set(encoded.fraction, slot)
	} else {
		store.index.set(encoded, slot)
	}
}

// NOTE: The newest version a box at this generation can see — walked back from
// the end, because versions ascend and the newest visible one is the last one
// stamped at or below the box. `undefined` means the slot was opened after this
// box was made, which is what a box sees of a key some later write added.
//
// NOTE: `versions.length` is read fresh rather than fixed, and that is safe for
// the same reason `List`'s runs are: a push only ever extends the Array, and
// anything a reentrant write pushed mid-walk is stamped past this box and
// skipped by the very test below.
function versionAt<Value>(
	slot: Slot<AnyType, Value>,
	generation: number,
): Version<Value> | undefined {
	let versions = slot.versions

	for (let index = versions.length - 1; index >= 0; index--) {
		let version = versions[index]

		if (version.generation <= generation) {
			return version
		}
	}

	return undefined
}

// NOTE: THE LIVE VIEW, and the only rule any reader here is written on: a slot
// is live at a generation when it has a version there and that version is not a
// tombstone. Every walk in this module is the same four lines around it — the
// slots in order, the ones this answers for — which is how a shared store stays
// indistinguishable from the private copy each box could have had.
function liveValueOf<Value extends AnyType>(
	slot: Slot<AnyType, Value>,
	generation: number,
): Value | undefined {
	let version = versionAt(slot, generation)

	if (version === undefined || version.value === TOMBSTONE) {
		return undefined
	}

	return version.value
}

// NOTE: The slot a key stands in, live or tombstoned, or `undefined` when this
// box holds no slot for it at all. Which path is taken is decided by the
// ENCODING the caller was able to make of the key, which is to say by the
// witness it was handed as much as by the key: an encoding means one `Map`
// read, and no encoding means a walk asking the witness about every live slot.
//
// NOTE: The scan asks about EVERY live slot rather than only the ones with no
// encoding of their own, and the difference matters exactly where the two kinds
// of witness meet on one store. A store written under the standard library's
// equality holds slots that are all encoded; a later write through a witness a
// Namespace wrote has no encoding to look them up by, and skipping them would
// have opened a second slot for a key that is standing right there.
//
// NOTE: The other direction is what `store.unencoded` answers. An encoding the
// index does not know may still belong to a slot some witnessed write opened
// with no encoding at all, so a miss falls through to the scan while any such
// slot stands. Where none does — which is every ordinary Dictionary — a miss is
// a miss in one step.
//
// NOTE: The visibility test is what keeps the index honest. It holds every slot
// the store ever opened, including ones opened by writes this box is older
// than, and a box must not find a key it was made before. On the tip that test
// can not fail, which is where every write asks it from.
function slotHolding<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	key: Key,
	encoded: EncodedKey | null,
	conformance: EquatableWitness<Key> | null,
): Slot<Key, Value> | undefined {
	let generation = dictionary.generation
	let store = dictionary.store

	if (encoded !== null) {
		let slot = slotUnder(store, encoded)

		if (slot !== undefined && versionAt(slot, generation) !== undefined) {
			return slot
		}

		if (store.unencoded === 0) {
			return undefined
		}
	}

	// NOTE: With no witness there is no equality to ask, which is the shape the
	// empty literal arrives in — it holds no slot for the walk to reach either.
	if (conformance === null) {
		return undefined
	}

	let slots = store.slots
	let count = slots.length

	for (let index = 0; index < count; index++) {
		let slot = slots[index]

		if (
			(encoded === null || slot.encoded === null) &&
			versionAt(slot, generation) !== undefined &&
			conformance.is(slot.key, key).value
		) {
			return slot
		}
	}

	return undefined
}

// NOTE: `slotHolding` for the readers, which have no other use for the
// encoding. The writers keep theirs: they may have to open a slot with it, and
// they may have to ask a second time after a repack.
function lookupSlot<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	key: Key,
	conformance: EquatableWitness<Key>,
): Slot<Key, Value> | undefined {
	return slotHolding(
		dictionary,
		key,
		encodeKey(key, conformance),
		conformance,
	)
}

// NOTE: A box's live view copied into a store of its own — one slot per live
// key, one version each at generation zero, the indexes rebuilt, nothing dead.
// Nothing of the old store is touched, so every other box over it still answers
// what it answered.
//
// NOTE: Three writes reach for this. A write on a forked box, which must not
// push into a store whose tip belongs to another branch. A write on a store
// carrying more dead versions than live slots — history that would otherwise
// grow without bound. And a key being RE-ADDED after it was removed, because
// the design says such a key lands at the END and only dropping its tombstoned
// slot can put it there.
//
// NOTE: The box the repack was made FROM is moved onto the fresh store as well,
// and this is worth stating because it is a mutation of a value somebody else
// holds. It is unobservable — the fresh store holds exactly that box's live
// view at generation zero, so the box answers what it answered — and what it
// buys is that the NEXT write from the same box repacks a store the size of
// what that box holds rather than the whole history somebody else built in
// front of it. A stale box is usually written from more than once: it is a base
// somebody is deriving from, and each derivation forks and so repacks, which no
// arrangement of a linear generation can avoid. What the rerooting takes out is
// the history each of those repacks would otherwise walk: measured on a
// 10,000-entry box left behind by 10,000 overwrites of one key, 1,000
// derivations from it fell from 497 ms to 310 ms, and the gap widens with the
// history in front of the box.
function repack<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
): DictionaryType<Key, Value> {
	let generation = dictionary.generation
	let source = dictionary.store.slots
	let count = source.length
	let store = emptyStore<Key, Value>()
	let slots = store.slots

	for (let position = 0; position < count; position++) {
		let slot = source[position]
		let value = liveValueOf(slot, generation)

		if (value === undefined) {
			continue
		}

		let fresh: Slot<Key, Value> = {
			key: slot.key,
			encoded: slot.encoded,
			versions: [{ value, generation: 0 }],
		}

		slots.push(fresh)
		fileSlot(store, fresh)
	}

	dictionary.store = store
	dictionary.generation = 0

	return boxAt(store, 0, slots.length)
}

// NOTE: Whether the store this box sits on is carrying more history than the
// entries it holds. Asked only of a box that is the tip, which is the only view
// `dead` describes.
function isOverloaded(store: Store<AnyType, AnyType>): boolean {
	return store.dead > store.slots.length
}

// NOTE: A fresh box over a store that has just been written. The three fields
// move together — the store, the generation the write stamped, and the count
// that write left — and writing them in one place is what keeps a write from
// answering a box whose `length` disagrees with its own view.
function boxAt<Key extends AnyType, Value extends AnyType>(
	store: Store<Key, Value>,
	generation: number,
	length: number,
): DictionaryType<Key, Value> {
	return { [typeKeySymbol]: "Dictionary", store, generation, length }
}

// NOTE: The builder every construction path shares — `of`, `createDictionary`,
// `map` and `freshStore`, the door the gathering natives come through, each
// fill a store of their own and hand it over, so `groupedBy` and `tallied`
// reach it through that last one. Every slot it opens carries one version at
// generation zero, so the finished store is already in the shape a repack would
// leave it in.
function emptyStore<Key extends AnyType, Value extends AnyType>(): Store<
	Key,
	Value
> {
	return {
		slots: [],
		index: new Map(),
		fractions: new Map(),
		generation: 0,
		dead: 0,
		unencoded: 0,
	}
}

// NOTE: The slot a key already has in a store nobody else holds yet, found the
// three ways `slotHolding` finds one — under its encoding, by asking the
// witness about every slot, or, after an encoding the index cannot answer for,
// by asking it about the slots that carry no encoding of their own. There is no
// generation to test: every version in such a store is stamped zero and every
// slot is live, which is what separates this from the reader that serves the
// boxes.
//
// NOTE: That third way is the one a fresh store looks like it could do without,
// and may not. One witness fills the whole of such a store, but a witness may
// cover kinds that encode and kinds that do not — a branded `Number` one covers
// the Integer and the Rational, which encode, and the Algebraic and the
// Transcendental, which scan — so the slots it opens are MIXED, and an encoded
// key missing from the index may still be the key an unencoded slot holds. That
// no such pair is equal today is a theorem about the standard library's own
// `is` rather than about this file: an Algebraic and a Transcendental are
// provably irrational and so equal no Rational. Leaning on it here would make a
// sixth branded kind that crossed the line open two slots for one key, silently.
// The fallthrough costs one integer compare on the ordinary store, where nothing
// is unencoded at all.
function slotInFreshStore<Key extends AnyType, Value extends AnyType>(
	store: Store<Key, Value>,
	key: Key,
	encoded: EncodedKey | null,
	conformance: EquatableWitness<Key> | null,
): Slot<Key, Value> | undefined {
	if (encoded !== null) {
		let slot = slotUnder(store, encoded)

		if (slot !== undefined) {
			return slot
		}

		if (store.unencoded === 0) {
			return undefined
		}
	}

	if (conformance === null) {
		return undefined
	}

	// NOTE: Every slot for a key with no encoding, and only the unencoded ones
	// for a key that has one — the same two cases, and the same one test,
	// `slotHolding` walks its slots under.
	let slots = store.slots

	for (let index = 0; index < slots.length; index++) {
		let slot = slots[index]

		if (
			(encoded === null || slot.encoded === null) &&
			conformance.is(slot.key, key).value
		) {
			return slot
		}
	}

	return undefined
}

// NOTE: A slot opened at the end of a store nobody else holds yet, carrying one
// version at generation zero — the shape a repack would leave it in.
function openFreshSlot<Key extends AnyType, Value extends AnyType>(
	store: Store<Key, Value>,
	key: Key,
	encoded: EncodedKey | null,
	value: Value,
): void {
	let slot: Slot<Key, Value> = {
		key,
		encoded,
		versions: [{ value, generation: 0 }],
	}

	store.slots.push(slot)
	fileSlot(store, slot)
}

// NOTE: One entry added to a store nobody else holds yet. A key already in it
// wins later and keeps its place: the value is written over the version that is
// there rather than pushed after it, which is both what `Dictionary.of` promises
// about a duplicate key and what leaves the finished store with no dead
// versions at all.
function addToFreshStore<Key extends AnyType, Value extends AnyType>(
	store: Store<Key, Value>,
	key: Key,
	value: Value,
	conformance: EquatableWitness<Key> | null,
): void {
	let encoded = encodeKey(key, conformance)
	let existing = slotInFreshStore(store, key, encoded, conformance)

	if (existing !== undefined) {
		existing.versions[0].value = value

		return
	}

	openFreshSlot(store, key, encoded, value)
}

// NOTE: The door a host or the Compiler's own emitted code comes through, and
// the one the slice-2 Dictionary literal will use. The Array of pairs is read
// and not kept: the store is the box's own from the first entry on, so nothing
// here takes ownership of anything the caller may still hold.
export function createDictionary<Key extends AnyType, Value extends AnyType>(
	entries: Array<[Key, Value]>,
	conformance: EquatableWitness<Key> | null,
): DictionaryType<Key, Value> {
	let store = emptyStore<Key, Value>()

	registerDictionaryKind()

	for (let index = 0; index < entries.length; index++) {
		let entry = entries[index]

		addToFreshStore(store, entry[0], entry[1], conformance)
	}

	return boxAt(store, 0, store.slots.length)
}

// NOTE: The three doors a native that GATHERS a Dictionary comes through, and
// the reason they are here rather than in the module that gathers. A grouping
// walks its source once and folds each item into the entry its key already has,
// which no door above spells: `createDictionary` is handed the entries finished.
// Opening the store, folding into it and sealing it are the whole of what such a
// native needs, and keeping the three here keeps the slots, the two indexes and
// the version stamps in one file — see `GroupedList.ts`, the only caller.
export function freshStore<Key extends AnyType, Value extends AnyType>(): Store<
	Key,
	Value
> {
	registerDictionaryKind()

	return emptyStore()
}

// NOTE: One item folded into the entry its key stands at, or a new entry opened
// at the end for a key that has none. `combine` is handed what the key holds and
// answers what it holds next; `seed` answers what a key opens with. The two are
// apart because a group's first item and its later ones are different questions
// — the first BUILDS the accumulator and the rest add to one.
export function foldIntoFreshStore<Key extends AnyType, Value extends AnyType>(
	store: Store<Key, Value>,
	key: Key,
	conformance: EquatableWitness<Key> | null,
	seed: () => Value,
	combine: (held: Value) => Value,
): void {
	let encoded = encodeKey(key, conformance)
	let existing = slotInFreshStore(store, key, encoded, conformance)

	if (existing !== undefined) {
		// NOTE: Nothing in such a store is a tombstone — `remove` is the only
		// thing that writes one, and it writes on a box rather than here.
		existing.versions[0].value = combine(
			existing.versions[0].value as Value,
		)

		return
	}

	openFreshSlot(store, key, encoded, seed())
}

export function dictionaryOverFreshStore<
	Key extends AnyType,
	Value extends AnyType,
>(store: Store<Key, Value>): DictionaryType<Key, Value> {
	return boxAt(store, 0, store.slots.length)
}

// NOTE: The List of entry Records a Program writes a Dictionary down as. The
// two runs are walked as every List native walks them, with the counts fixed
// before the first entry is read — `runsOf` rather than `viewOf` because
// nothing here is going to visit the items twice and there is no reason to trim
// the caller's List for it.
export function of<Key extends AnyType, Value extends AnyType>(
	entries: ListType<EntryRecord<Key, Value>>,
	conformance: EquatableWitness<Key>,
): DictionaryType<Key, Value> {
	let view = runsOf(entries)
	let store = emptyStore<Key, Value>()

	registerDictionaryKind()

	for (let index = view.frontCount - 1; index >= 0; index--) {
		let entry = view.front[index]

		addToFreshStore(store, entry.key, entry.value, conformance)
	}

	for (let index = 0; index < view.backCount; index++) {
		let entry = view.back[index]

		addToFreshStore(store, entry.key, entry.value, conformance)
	}

	return boxAt(store, 0, store.slots.length)
}

// NOTE: Order-INSENSITIVE, which is what the design says two Dictionaries mean
// by equal: the same keys, each with an equal value, however they were written
// down. Equal lengths decide first and are what makes one direction enough —
// the receiver's keys are pairwise distinct, so an injection into a set of the
// same size is a bijection.
//
// NOTE: The key witness finds the entry and the value witness compares what it
// holds. Both are needed: a Record key is found by asking the Key Namespace,
// and a value is compared with its own equality rather than with a structural
// one this Module would have to choose.
export function is<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	other: DictionaryType<Key, Value>,
	keyConformance: EquatableWitness<Key>,
	valueConformance: EquatableWitness<Value>,
): BooleanType {
	if (dictionary.length !== other.length) {
		return createBoolean(false)
	}

	let generation = dictionary.generation
	let slots = dictionary.store.slots
	let count = slots.length

	for (let index = 0; index < count; index++) {
		let slot = slots[index]
		let value = liveValueOf(slot, generation)

		if (value === undefined) {
			continue
		}

		let match = lookupSlot(other, slot.key, keyConformance)

		if (match === undefined) {
			return createBoolean(false)
		}

		let otherValue = liveValueOf(match, other.generation)

		if (
			otherValue === undefined ||
			!valueConformance.is(value, otherValue).value
		) {
			return createBoolean(false)
		}
	}

	return createBoolean(true)
}

// NOTE: What a reader sees, which is the form a Program writes a Dictionary
// down in: `["alex" = 39, "sam" = 25]`, and `[=]` for the empty one — the `=`
// is what keeps that apart from the empty List's `[]`.
//
// NOTE: `itemText` on both sides, which is the one rule that separates this
// from a join: a String is quoted inside a structure, so `["", "a"]` as a key
// reads as a key rather than as nothing at all, and a value that is a String
// reads as one. Keys and values are Printable through their own Namespaces, so
// each side is rendered with its own witness.
// biome-ignore lint/suspicious/noShadowRestrictedNames: This is a runtime function
export function toString<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	keyConformance: PrintableWitness<Key>,
	valueConformance: PrintableWitness<Value>,
): StringType {
	let generation = dictionary.generation
	let slots = dictionary.store.slots
	let count = slots.length
	let pieces: Array<string> = []

	for (let index = 0; index < count; index++) {
		let slot = slots[index]
		let value = liveValueOf(slot, generation)

		if (value === undefined) {
			continue
		}

		pieces.push(
			`${itemText(slot.key, keyConformance)} = ${itemText(
				value,
				valueConformance,
			)}`,
		)
	}

	if (pieces.length === 0) {
		return createString("[=]")
	}

	return createString(`[${pieces.join(", ")}]`)
}

export function isEmpty(
	dictionary: DictionaryType<AnyType, AnyType>,
): BooleanType {
	return createBoolean(dictionary.length === 0)
}

export function length(
	dictionary: DictionaryType<AnyType, AnyType>,
): IntegerType {
	return createInteger(dictionary.length)
}

export function value__overload$1<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	key: Key,
	conformance: EquatableWitness<Key>,
): OptionalType<Value> {
	let slot = lookupSlot(dictionary, key, conformance)

	if (slot === undefined) {
		return createEmpty()
	}

	let held = liveValueOf(slot, dictionary.generation)

	return held === undefined ? createEmpty() : createValue(held)
}

// NOTE: A fresh Array per answer, which is what `createList` demands of
// everything that hands it one: the List it builds takes the Array over and may
// push onto it, and nothing in this Module may then still be holding it.
export function keys<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
): ListType<Key> {
	let generation = dictionary.generation
	let slots = dictionary.store.slots
	let count = slots.length
	let answer: Array<Key> = []

	for (let index = 0; index < count; index++) {
		let slot = slots[index]

		if (liveValueOf(slot, generation) !== undefined) {
			answer.push(slot.key)
		}
	}

	return createList(answer)
}

export function values<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
): ListType<Value> {
	let generation = dictionary.generation
	let slots = dictionary.store.slots
	let count = slots.length
	let answer: Array<Value> = []

	for (let index = 0; index < count; index++) {
		let value = liveValueOf(slots[index], generation)

		if (value !== undefined) {
			answer.push(value)
		}
	}

	return createList(answer)
}

export function entries<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
): ListType<EntryRecord<Key, Value>> {
	let generation = dictionary.generation
	let slots = dictionary.store.slots
	let count = slots.length
	let answer: Array<EntryRecord<Key, Value>> = []

	for (let index = 0; index < count; index++) {
		let slot = slots[index]
		let value = liveValueOf(slot, generation)

		if (value !== undefined) {
			answer.push({
				[typeKeySymbol]: "Record",
				key: slot.key,
				value,
			})
		}
	}

	return createList(answer)
}

// NOTE: Setting a key is four decisions and then one push.
//
// The key is found first, on the receiver, because whether it is there and
// whether it is tombstoned is what the rest turns on. Then the store the write
// goes into is settled: the receiver's own if it may be written in place, a
// repacked one otherwise. Then the version is pushed — onto the key's existing
// slot when it is live, which is what makes an overwrite keep its place, and
// onto a slot opened at the end otherwise.
//
// NOTE: A key whose newest visible version is a TOMBSTONE is why the repack is
// not only a bookkeeping measure. The design says a key removed and later
// re-added lands at the end, and its slot is still standing where it first was
// — so the only way to put it last is to drop the dead slot, which is what a
// repack does.
//
// NOTE: `store.dead` is maintained rather than recomputed: an overwrite leaves
// one superseded version behind, and an opened slot leaves none. It is the
// count of versions that are no longer any live key's newest, which is exactly
// what the repack rule wants to compare against the number of slots.
//
// NOTE: And it is the only rule, which is a trade taken deliberately. A cap on
// one slot's versions was tried — eight — and it turned overwriting one key of
// a large Dictionary into a repack of the whole thing every seventh write:
// 10,000 overwrites of one key in a 100,000-entry Dictionary took 7.6 seconds
// across 1,428 repacks, where the same 10,000 writes spread over its keys took
// 5.5 milliseconds. Against `dead > slots.length` alone that loop repacks not
// at all and takes half a millisecond — amortised O(1), with one repack per as
// many writes as there are entries. What it costs is `versionAt`: a box that is
// OLD walks back through the versions written past it, so a reader of an early
// box of a much-overwritten key pays that key's history once per read. A hot
// key is written far more often than an old view of it is read.
export function set<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	key: Key,
	value: Value,
	conformance: EquatableWitness<Key>,
): DictionaryType<Key, Value> {
	let encoded = encodeKey(key, conformance)
	// NOTE: `standing` is the slot the key has in this store at all, tombstoned
	// or not; `live` is the same slot only when the key is still there. The two
	// are apart because they decide different things — a standing slot that is
	// not live is what forces the repack, and a live one is what the version is
	// pushed onto.
	let standing = slotHolding(dictionary, key, encoded, conformance)
	let live =
		standing !== undefined &&
		liveValueOf(standing, dictionary.generation) !== undefined
			? standing
			: undefined
	let target = dictionary

	if (
		dictionary.generation !== dictionary.store.generation ||
		(standing !== undefined && live === undefined) ||
		isOverloaded(dictionary.store)
	) {
		target = repack(dictionary)

		// NOTE: A repack drops every dead slot, so a key that was tombstoned
		// has no slot in the fresh store and is opened at the end below —
		// which is the whole point of having repacked. A key that was live has
		// one, and it is asked for again rather than tracked through the
		// repack: for an encodable key that is one Map read, and for a
		// scan-path key it is a second walk of a store that was just walked
		// once, on a path that is rare by construction.
		live =
			live === undefined
				? undefined
				: slotHolding(target, key, encoded, conformance)
	}

	let store = target.store
	let generation = store.generation + 1

	store.generation = generation

	if (live !== undefined) {
		live.versions.push({ value, generation })
		store.dead++

		return boxAt(store, generation, target.length)
	}

	let fresh: Slot<Key, Value> = {
		key,
		encoded,
		versions: [{ value, generation }],
	}

	store.slots.push(fresh)
	fileSlot(store, fresh)

	return boxAt(store, generation, target.length + 1)
}

// NOTE: A tombstone pushed where the value was, so the key stops being live at
// the new generation while every older box goes on seeing what it saw. The slot
// stays standing: it is dropped by the next repack, and until then it is what
// tells a re-add of the same key that it must go to the end.
//
// NOTE: An absent key answers the receiver. Removing what is not there leaves
// exactly the contents the receiver holds, and nothing in the language can ask
// whether the answer is the same value — so there is no reason to build a box
// to say the same thing, and no reason to stamp a generation nothing changed at.
//
// NOTE: `dead` grows by two: the value that was there is superseded, and the
// tombstone that supersedes it is itself no live key's newest.
export function remove<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	key: Key,
	conformance: EquatableWitness<Key>,
): DictionaryType<Key, Value> {
	let encoded = encodeKey(key, conformance)
	let slot = slotHolding(dictionary, key, encoded, conformance)

	if (
		slot === undefined ||
		liveValueOf(slot, dictionary.generation) === undefined
	) {
		return dictionary
	}

	let target = dictionary

	if (
		dictionary.generation !== dictionary.store.generation ||
		isOverloaded(dictionary.store)
	) {
		target = repack(dictionary)

		// NOTE: The key is live in the view the repack copied, so the fresh
		// store holds exactly one slot for it. The cast says that, rather than
		// making the lines below carry a case that can not happen.
		slot = slotHolding(target, key, encoded, conformance) as Slot<
			Key,
			Value
		>
	}

	let store = target.store
	let generation = store.generation + 1

	store.generation = generation
	slot.versions.push({ value: TOMBSTONE, generation })
	store.dead += 2

	return boxAt(store, generation, target.length - 1)
}

// NOTE: The keys are kept and only the values are transformed, so the answer
// REUSES each slot's encoding rather than encoding the same keys a second time
// — which is why this is a native at all, and why it needs no Equatable
// witness: the receiver's keys are already known to be distinct from one
// another, and nothing here can make two of them collide.
//
// NOTE: The transform receives the entry Record, as every Dictionary callback
// does, so a caller can take it apart with a Pattern.
//
// NOTE: The slot count is fixed before the walk, for the reason `List`'s
// natives fix their item counts: the transform may write to the very Dictionary
// being walked, and a write on the tip appends to the Array this loop is
// reading. What such a write appends is stamped past this box and would be
// skipped anyway; fixing the count says so once instead of leaning on it.
export function map<
	Key extends AnyType,
	Value extends AnyType,
	Result extends AnyType,
>(
	dictionary: DictionaryType<Key, Value>,
	transform: (entry: EntryRecord<Key, Value>) => Result,
): DictionaryType<Key, Result> {
	let generation = dictionary.generation
	let source = dictionary.store.slots
	let count = source.length
	let store = emptyStore<Key, Result>()
	let slots = store.slots

	registerDictionaryKind()

	for (let position = 0; position < count; position++) {
		let slot = source[position]
		let value = liveValueOf(slot, generation)

		if (value === undefined) {
			continue
		}

		let result = transform({
			[typeKeySymbol]: "Record",
			key: slot.key,
			value,
		})

		let fresh: Slot<Key, Result> = {
			key: slot.key,
			encoded: slot.encoded,
			versions: [{ value: result, generation: 0 }],
		}

		slots.push(fresh)
		fileSlot(store, fresh)
	}

	return boxAt(store, 0, slots.length)
}

// NOTE: The live view as pairs, for the two answers below that have to hold one
// side while they search the other, and for the difference a failing test
// writes. It is the same four lines every reader here is, materialised.
function livePairs<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
): Array<[Key, Value]> {
	let generation = dictionary.generation
	let slots = dictionary.store.slots
	let count = slots.length
	let pairs: Array<[Key, Value]> = []

	for (let index = 0; index < count; index++) {
		let slot = slots[index]
		let value = liveValueOf(slot, generation)

		if (value !== undefined) {
			pairs.push([slot.key, value])
		}
	}

	return pairs
}

// NOTE: The rendering `Terminal.inspect` and `Record::toString` reach for when
// they meet a Dictionary — the written form, laid out the way the walk around
// it lays a List out, with the entries broken over lines once the single line
// would be too long. It is the same text `toString` above answers for the same
// padding, which is the promise a Dictionary inside a Record makes.
function renderDictionary(
	value: AnyType,
	indentLevel: number,
	rationalForm: (rational: RationalType) => string,
	listPadding: string,
	renderPart: RenderPart,
): string {
	let pairs = livePairs(value as DictionaryType<AnyType, AnyType>)

	if (pairs.length === 0) {
		return "[=]"
	}

	// NOTE: One rendering of an entry, closed over the indent the layout needs,
	// rather than the two the Record and List arms spell out. An entry is two
	// nested calls rather than one, so writing the pair twice measured 295
	// bytes of every bundle that prints anything, for nothing a reader gains.
	let pairsAt =
		(indent: number) =>
		([key, held]: [AnyType, AnyType]): string =>
			`${renderPart(key, indent, rationalForm, listPadding)} = ${renderPart(held, indent, rationalForm, listPadding)}`
	let singleLine = `[${listPadding}${pairs
		.map(pairsAt(0))
		.join(", ")}${listPadding}]`

	if (singleLine.length < singleLineMaxLength) {
		return singleLine
	}

	let contentIndent = " ".repeat(4 * (indentLevel + 1))

	return `[\n${contentIndent}${pairs
		.map(pairsAt(indentLevel + 1))
		.join(`,\n${contentIndent}`)}\n${" ".repeat(4 * indentLevel)}]`
}

// NOTE: Equality with no witness in hand — what the universal comparison falls
// into when it meets two Dictionaries, with `same` its own answer for whatever
// they hold. It is not the `is` native above: there is no key witness and no
// value witness to ask, and the structure two boxes are made of is not what a Dictionary is
// equal by — the store is shared and stamped, so two boxes holding the very
// same entries need not hold the same slots.
//
// NOTE: One side is walked and the other is looked up, which is what makes this
// O(n) where a struck-out double walk was O(n²). The lookup may use the
// canonical encoding whatever witness either store was written through, because
// `same` here IS the standard library's own equality — that is the very claim
// the encoding is written on — and a store holding slots some witnessed write
// left unencoded is what `slotHolding` falls through to the scan for.
function equalsUniversally(
	first: AnyType,
	second: AnyType,
	same: (first: AnyType, second: AnyType) => boolean,
): boolean {
	let mine = first as DictionaryType<AnyType, AnyType>
	let theirs = second as DictionaryType<AnyType, AnyType>

	if (mine.length !== theirs.length) {
		return false
	}

	// NOTE: The witness shape `slotHolding` asks through, built once per
	// comparison rather than per key. `createBoolean` answers one of two
	// interned values, so the wrapping is a call and no allocation.
	let witness = {
		is: (a: AnyType, b: AnyType) => createBoolean(same(a, b)),
	}
	let pairs = livePairs(mine)

	for (let index = 0; index < pairs.length; index++) {
		let [key, value] = pairs[index]
		let match = slotHolding(theirs, key, canonicalEncoding(key), witness)

		if (match === undefined) {
			return false
		}

		let held = liveValueOf(match, theirs.generation)

		if (held === undefined || !same(value, held)) {
			return false
		}
	}

	return true
}

// NOTE: And equality where each half of an entry is compared by a rule the
// descriptor names — a Case holding a `Dictionary<KeyType, ValueType>` reaches
// this, with the two Type Parameters' witnesses standing behind `sameKey` and
// `sameValue`. Nothing handed in is the equality the keys are organised by, so
// there is no index to shortcut through: one side is held while the other is
// searched, and a matched entry is struck out so that one entry answers for
// one.
function equalsByParts(
	first: AnyType,
	second: AnyType,
	sameKey: (first: AnyType, second: AnyType) => boolean,
	sameValue: (first: AnyType, second: AnyType) => boolean,
): boolean {
	let mine = livePairs(first as DictionaryType<AnyType, AnyType>)
	let theirs = livePairs(second as DictionaryType<AnyType, AnyType>)

	if (mine.length !== theirs.length) {
		return false
	}

	let taken = theirs.map(() => false)

	for (let [key, value] of mine) {
		let found = false

		for (let index = 0; index < theirs.length; index++) {
			if (taken[index]) {
				continue
			}

			let [otherKey, otherValue] = theirs[index]

			if (!sameKey(key, otherKey)) {
				continue
			}

			if (!sameValue(value, otherValue)) {
				return false
			}

			taken[index] = true
			found = true

			break
		}

		if (!found) {
			return false
		}
	}

	return true
}

// NOTE: The one registration, and the reason it is a call from the three doors
// a Dictionary is built through rather than a line at the top of this module.
// The head of every emitted Program imports every runtime module and leans on
// esbuild to shake away the ones it does not name — and a top-level call is a
// side effect a bundler must keep, so it would pin the whole of this file into
// every Program there is, Dictionary or not. `String.ts` builds its segmenter
// on first use for the same reason, and says so; this is that stance applied to
// a table rather than to a table loader.
//
// NOTE: A Program that holds a Dictionary at all built it here, so the
// registration is in place before anything can print, compare or diff one.
let registered = false

function registerDictionaryKind(): void {
	if (registered) {
		return
	}

	registered = true

	registerKind("Dictionary", {
		open: "[",
		close: "]",
		render: renderDictionary,
		// NOTE: Each entry under its key as it prints, which is what the reader
		// of a difference reads it by. Two keys of one Dictionary are never
		// equal, so they can only render alike where a `toString` renders two
		// different values the same.
		parts: (value, render) =>
			livePairs(value as DictionaryType<AnyType, AnyType>).map(
				([key, held]) => [render(key), held],
			),
		equals: equalsUniversally,
		equalsBy: equalsByParts,
	})
}
