import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import { anyIs } from "./internalHelpers"
import type { EncodedKey, EquatableWitness } from "./keyEncoding"
import { canonicalEncoding, encodeKey } from "./keyEncoding"
import type { ListType } from "./List"
import { createList, sealedRunsOf } from "./List"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { OrderingType } from "./Ordering"
import type { RationalType } from "./Rational"
import type { RecordType } from "./Record"
import { registerKind, type RenderPart, singleLineMaxLength } from "./registry"
import type { SortOrderType } from "./SortOrder"
import type { StringType } from "./String"
import { createString, itemText } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// A Dictionary box is a view of a shared store at one generation. See
// "Dictionaries" in DEVELOPMENT.md.

// A removed key's newest version. A Symbol, since any in-band value could be
// one a Program stores.
export const TOMBSTONE: unique symbol = Symbol("tombstone")

// One value a key has held, stamped with its write's generation. A slot's
// versions ascend, newest last.
type Version<Value> = { value: Value | typeof TOMBSTONE; generation: number }

export type Slot<Key, Value> = {
	// The key box that arrived first, so `keys()` answers what a Program handed
	// over.
	key: Key
	// `null` means the scan path: the key is compared through the witness.
	encoded: EncodedKey | null
	versions: Array<Version<Value>>
}

export type Store<Key, Value> = {
	// Insertion order. A slot is never moved or removed; a repack drops the
	// tombstoned ones.
	slots: Array<Slot<Key, Value>>
	// Every slot ever opened whose key encodes to a primitive. Visibility is
	// decided by the version stamps, not by the index.
	index: Map<string | number | bigint | boolean, Slot<Key, Value>>
	// The same for text encodings, kept apart so a String key can not collide
	// with a Rational, Case or Record key.
	texts: Map<string, Slot<Key, Value>>
	// The newest write. A box at this generation is the tip and writes in place.
	generation: number
	// Versions that are not any live key's newest, as seen from the tip.
	dead: number
	// Slots with no encoding, so a lookup the index misses knows whether to
	// scan. See "Finding a Dictionary key" in DEVELOPMENT.md.
	unencoded: number
}

export type DictionaryType<Key extends AnyType, Value extends AnyType> = {
	[typeKeySymbol]: "Dictionary"
	store: Store<Key, Value>
	// This box sees every version stamped no later than this generation.
	generation: number
	// Live entries at that generation, carried since every write knows it.
	length: number
}

// The `key` and `value` Record every callback receives, so a caller can take
// it apart with a Pattern.
export type EntryRecord<
	Key extends AnyType,
	Value extends AnyType,
> = RecordType & { key: Key; value: Value }

type PrintableWitness<Value extends AnyType> = {
	toString: (value: Value) => StringType
}

// A boxed text is the one encoding that is an object.
function slotUnder<Key extends AnyType, Value extends AnyType>(
	store: Store<Key, Value>,
	encoded: EncodedKey,
): Slot<Key, Value> | undefined {
	return typeof encoded === "object"
		? store.texts.get(encoded.text)
		: store.index.get(encoded)
}

// Files a slot under its encoding, or counts it as unencoded. Every slot is
// opened through here.
function fileSlot<Key extends AnyType, Value extends AnyType>(
	store: Store<Key, Value>,
	slot: Slot<Key, Value>,
): void {
	let encoded = slot.encoded

	if (encoded === null) {
		store.unencoded++
	} else if (typeof encoded === "object") {
		store.texts.set(encoded.text, slot)
	} else {
		store.index.set(encoded, slot)
	}
}

// The newest version a box at this generation can see, or `undefined` for a
// slot opened after the box. A reentrant push lands past the box and is skipped.
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

// The value a slot holds for a box, or `undefined` where it has none or is
// tombstoned. Every reader in this module goes through this.
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

// The slot a key stands in, live or tombstoned, visible to the box. See
// "Finding a Dictionary key" in DEVELOPMENT.md.
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

	// No witness means the empty literal, which holds no slot to scan.
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

// `slotHolding` for readers, which need no encoding of their own.
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

// Copies a box's live view into a fresh store, and moves the box onto it. See
// "Writing to a Dictionary" in DEVELOPMENT.md.
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

// Whether the store holds more dead versions than slots. Asked of the tip only.
function isOverloaded(store: Store<AnyType, AnyType>): boolean {
	return store.dead > store.slots.length
}

// A box over a store, with the generation and count a write left.
function boxAt<Key extends AnyType, Value extends AnyType>(
	store: Store<Key, Value>,
	generation: number,
	length: number,
): DictionaryType<Key, Value> {
	return { [typeKeySymbol]: "Dictionary", store, generation, length }
}

function emptyStore<Key extends AnyType, Value extends AnyType>(): Store<
	Key,
	Value
> {
	return {
		slots: [],
		index: new Map(),
		texts: new Map(),
		generation: 0,
		dead: 0,
		unencoded: 0,
	}
}

// `slotHolding` for a store nobody else holds yet, where every slot is live.
// It falls through to the unencoded slots too, since one witness may cover
// kinds that encode and kinds that scan.
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

// Opens a slot at the end of a fresh store, at generation zero.
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

// Adds an entry to a fresh store. A repeated key overwrites in place and keeps
// its position, as `Dictionary.of` promises.
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

// Builds an emitted Dictionary literal, and a native's finished pairs. The
// pairs are read, not kept.
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

// Builds a Dictionary from a host's values, or answers the index of a
// duplicate key. See "Dictionaries from a host" in DEVELOPMENT.md.
export function createDictionaryFrom(
	entries: Array<[AnyType, AnyType]>,
): DictionaryType<AnyType, AnyType> | number {
	let store = emptyStore<AnyType, AnyType>()

	registerDictionaryKind()

	for (let index = 0; index < entries.length; index++) {
		let entry = entries[index]
		let key = entry[0]
		let encoded = encodeKey(key, boundaryEquatable)

		if (
			slotInFreshStore(store, key, encoded, boundaryEquatable) !==
			undefined
		) {
			return index
		}

		openFreshSlot(store, key, encoded, entry[1])
	}

	return boxAt(store, 0, store.slots.length)
}

// An object literal of arrows, which a bundler may drop where unused.
const boundaryEquatable: EquatableWitness<AnyType> = {
	is: (first, second) => createBoolean(anyIs(first, second)),
	isNot: (first, second) => createBoolean(!anyIs(first, second)),
	structural: true,
}

// Opens a store for `GroupedList.ts`, which folds items into it and then
// boxes it with `dictionaryOverFreshStore`.
export function freshStore<Key extends AnyType, Value extends AnyType>(): Store<
	Key,
	Value
> {
	registerDictionaryKind()

	return emptyStore()
}

// Folds an item into its key's entry, or opens one at the end. `seed` builds a
// key's first value, and `combine` adds to it.
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
		// A fresh store holds no tombstone, since only `remove` writes one.
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

// From a List of entry Records. The run is sealed, since the key witness is
// user code.
export function of__overload$1<Key extends AnyType, Value extends AnyType>(
	entries: ListType<EntryRecord<Key, Value>>,
	conformance: EquatableWitness<Key>,
): DictionaryType<Key, Value> {
	let view = sealedRunsOf(entries)
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

// Order-insensitive. Equal lengths make one direction enough, since the
// receiver's keys are distinct. See "Dictionary equality" in DEVELOPMENT.md.
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

// The written form, `["alex" = 39]`, and `[=]` when empty. `itemText` quotes a
// String key or value.
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

// A fresh Array per answer, since the List `createList` builds takes it over.
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

// The first live entry, or `null`. Exported for `NonEmptyDictionary`.
export function firstLiveEntry<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
): EntryRecord<Key, Value> | null {
	let generation = dictionary.generation
	let slots = dictionary.store.slots
	let count = slots.length

	for (let index = 0; index < count; index++) {
		let slot = slots[index]
		let value = liveValueOf(slot, generation)

		if (value !== undefined) {
			return { [typeKeySymbol]: "Record", key: slot.key, value }
		}
	}

	return null
}

// Native so that only the first entry Record is built.
export function firstEntry__overload$1<
	Key extends AnyType,
	Value extends AnyType,
>(
	dictionary: DictionaryType<Key, Value>,
): OptionalType<EntryRecord<Key, Value>> {
	let entry = firstLiveEntry(dictionary)

	return entry === null ? createEmpty() : createValue(entry)
}

// Finds the key and repacks where the box may not write in place. Then pushes
// a version onto the live slot, or opens one at the end. See "Writing to a
// Dictionary" in DEVELOPMENT.md.
export function set<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	key: Key,
	value: Value,
	conformance: EquatableWitness<Key>,
): DictionaryType<Key, Value> {
	let encoded = encodeKey(key, conformance)
	// `standing` is the key's slot, tombstoned or not, and forces a repack when
	// it is not `live`. The version is pushed onto `live`.
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

		// The repack dropped a tombstoned slot, so that key opens at the end. A
		// live key is looked up again in the fresh store.
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

// Pushes a tombstone, so older boxes still see the value. The slot stays until
// a repack. An absent key answers the receiver. `dead` grows by two.
export function remove__overload$1<Key extends AnyType, Value extends AnyType>(
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

		// The key is live in the copied view, so the fresh store has its slot.
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

// Keeps the keys, so each slot's encoding carries over and no witness is
// needed. The count is fixed before the walk, since `transform` may write.
export function map<
	Key extends AnyType,
	Value extends AnyType,
	Other extends AnyType,
>(
	dictionary: DictionaryType<Key, Value>,
	transform: (entry: EntryRecord<Key, Value>) => Other,
): DictionaryType<Key, Other> {
	let generation = dictionary.generation
	let source = dictionary.store.slots
	let count = source.length
	let store = emptyStore<Key, Other>()
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

		let fresh: Slot<Key, Other> = {
			key: slot.key,
			encoded: slot.encoded,
			versions: [{ value: result, generation: 0 }],
		}

		slots.push(fresh)
		fileSlot(store, fresh)
	}

	return boxAt(store, 0, slots.length)
}

// Native so each kept slot's encoding carries over, as in `map`. The check
// sees each live entry once, in order.
export function everyEntry<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	check: (entry: EntryRecord<Key, Value>) => BooleanType,
): DictionaryType<Key, Value> {
	return kept(dictionary, check, true)
}

export function removeEvery<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	check: (entry: EntryRecord<Key, Value>) => BooleanType,
): DictionaryType<Key, Value> {
	return kept(dictionary, check, false)
}

// Keeps a slot where the check answers `accepted`. A fresh store, so the
// answer shares nothing with the receiver and its next write need not repack.
function kept<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	check: (entry: EntryRecord<Key, Value>) => BooleanType,
	accepted: boolean,
): DictionaryType<Key, Value> {
	let generation = dictionary.generation
	let source = dictionary.store.slots
	let count = source.length
	let store = emptyStore<Key, Value>()
	let slots = store.slots

	registerDictionaryKind()

	for (let position = 0; position < count; position++) {
		let slot = source[position]
		let value = liveValueOf(slot, generation)

		if (value === undefined) {
			continue
		}

		let entry: EntryRecord<Key, Value> = {
			[typeKeySymbol]: "Record",
			key: slot.key,
			value,
		}

		if (check(entry).value !== accepted) {
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

	return boxAt(store, 0, slots.length)
}

// Sorts the live slots into a fresh store, carrying each encoding over. Each
// key is read once and positions are sorted, as `List.sort__overload$3` does.
// Stable both ways: descending swaps the comparison rather than reversing.
function reordered<
	Key extends AnyType,
	Value extends AnyType,
	Read extends AnyType,
>(
	dictionary: DictionaryType<Key, Value>,
	readKey: (slot: Slot<Key, Value>, value: Value) => Read,
	order: SortOrderType,
	conformance: { compare: (self: Read, other: Read) => OrderingType },
): DictionaryType<Key, Value> {
	let generation = dictionary.generation
	let source = dictionary.store.slots
	let count = source.length
	let live: Array<Slot<Key, Value>> = []
	let held: Array<Value> = []
	let keys: Array<Read> = []
	let positions: Array<number> = []

	registerDictionaryKind()

	for (let position = 0; position < count; position++) {
		let slot = source[position]
		let value = liveValueOf(slot, generation)

		if (value === undefined) {
			continue
		}

		positions.push(live.length)
		live.push(slot)
		held.push(value)
		keys.push(readKey(slot, value))
	}

	if (order[typeKeySymbol] === "SortOrder#Descending") {
		positions.sort((first, second) =>
			orderingSign(conformance.compare(keys[second], keys[first])),
		)
	} else {
		positions.sort((first, second) =>
			orderingSign(conformance.compare(keys[first], keys[second])),
		)
	}

	let store = emptyStore<Key, Value>()
	let slots = store.slots

	for (let index = 0; index < positions.length; index++) {
		let position = positions[index]
		let slot = live[position]
		let fresh: Slot<Key, Value> = {
			key: slot.key,
			encoded: slot.encoded,
			versions: [{ value: held[position], generation: 0 }],
		}

		slots.push(fresh)
		fileSlot(store, fresh)
	}

	return boxAt(store, 0, slots.length)
}

// Spelled again rather than imported from `List.ts`, so a Program holding a
// Dictionary need not hold a List.
function orderingSign(ordering: OrderingType): number {
	if (ordering[typeKeySymbol] === "Ordering#Less") {
		return -1
	} else if (ordering[typeKeySymbol] === "Ordering#Greater") {
		return 1
	} else {
		return 0
	}
}

export function sort__overload$1<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
	order: SortOrderType,
	conformance: { compare: (self: Key, other: Key) => OrderingType },
): DictionaryType<Key, Value> {
	return reordered(dictionary, (slot) => slot.key, order, conformance)
}

export function sort__overload$2<
	Key extends AnyType,
	Value extends AnyType,
	Read extends AnyType,
>(
	dictionary: DictionaryType<Key, Value>,
	key: (entry: EntryRecord<Key, Value>) => Read,
	order: SortOrderType,
	conformance: { compare: (self: Read, other: Read) => OrderingType },
): DictionaryType<Key, Value> {
	return reordered(
		dictionary,
		(slot, value) =>
			key({ [typeKeySymbol]: "Record", key: slot.key, value }),
		order,
		conformance,
	)
}

// The live entries as pairs, for rendering, equality and the test difference.
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

// The registered rendering, laid out as the printer lays out a List.
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

	// Each entry is rendered once at indent zero and re-indented, as the
	// printer does.
	let entries = pairs.map(
		([key, held]) =>
			`${renderPart(key, 0, rationalForm, listPadding)} = ${renderPart(held, 0, rationalForm, listPadding)}`,
	)
	let singleLine = `[${listPadding}${entries.join(", ")}${listPadding}]`

	if (singleLine.length < singleLineMaxLength) {
		return singleLine
	}

	let contentIndent = " ".repeat(4 * (indentLevel + 1))

	return `[\n${contentIndent}${entries
		.map((entry) => entry.replaceAll("\n", `\n${contentIndent}`))
		.join(`,\n${contentIndent}`)}\n${" ".repeat(4 * indentLevel)}]`
}

// The registry's `equals`: walks one side and looks each key up in the other
// by its canonical encoding. See "Dictionary equality" in DEVELOPMENT.md.
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

	// Built once per comparison. `createBoolean` allocates nothing.
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

// The registry's `equalsBy`: no index applies, so one side is searched and
// each match struck out.
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

// Called by every constructor rather than at load, so the module can be
// shaken out. See "Registering the Dictionary kind" in DEVELOPMENT.md.
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
		// Each entry under its key as it prints.
		parts: (value, render) =>
			livePairs(value as DictionaryType<AnyType, AnyType>).map(
				([key, held]) => [render(key), held],
			),
		equals: equalsUniversally,
		equalsBy: equalsByParts,
	})
}
