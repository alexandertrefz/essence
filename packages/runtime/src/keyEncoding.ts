import { reduced } from "./bigRational"
import type { BooleanType } from "./Boolean"
import type { IntegerType } from "./Integer"
import { canonical } from "./Integer"
import type { RationalType } from "./Rational"
import type { StringType } from "./String"
import { normalisedFormOf } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: THE CANONICAL KEY ENCODING, and the brand that says when a call may
// use it. It is a module of its own because two containers rest on it and only
// one of them is a container: `Dictionary.ts` finds a slot by it, and the
// set-shaped List natives — `removeDuplicates`, `hasDuplicates`,
// `everyItem(alsoIn:)`, `removeEvery(contentsOf:)` and
// `contains(everyItemOf:)` — hold their seen keys in a plain Map keyed by it.
// A List Program that asks one of those questions carries this file and
// nothing else of the second container: no store, no version stamps, no kind
// registry and no written form. Measured on the Program
// `["ada", "bob", "ada", "cy"]::removeDuplicates()::join(with ", ")`, whose
// answer once came back through a Dictionary: 18,607 bytes then, 12,753 now,
// against 5,083 for the same Program without the call.

// NOTE: What a key is reduced to for the Map that finds it in one step. Every
// kind that has one is encoded into a JavaScript primitive whose `===` — the
// equality a `Map` decides its keys by — agrees exactly with what that kind's
// own `is` says. A kind with no such encoding answers `null` and is found by
// the scan path instead; see `encodeKey`.
//
// NOTE: Three kinds encode to a TEXT no primitive spells — a non-whole
// Rational's reduced parts, a Case's tag and payload, a Record's members. Any
// such text would also be a String key's encoding — every String is a possible
// one — so it is carried in a box of its own, which a store keeps in an index of
// its own, keyed by that text. The box is what says which of the two indexes
// answers for an encoding; it is read with one `typeof`, and a String key,
// which is the hot one, fails that test in a step and goes straight to a
// raw-string `Map.get`. Within the text index the three kinds are told apart by
// their first character: a fraction opens with a digit or a sign, a Case with
// `c` and a Record with `R` — see `compositeText`.
export type TextKey = { text: string }

export type EncodedKey = string | number | bigint | boolean | TextKey

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

// NOTE: THE CANONICAL KEY ENCODING. The whole of the fast path rests on one
// claim: for two keys that both encode, the encodings are `===` exactly when
// the standard library's `is` for that kind says the keys are equal. Every arm
// below is written to keep that claim, and a kind that can not keep it answers
// `null` rather than weaken it.
export function canonicalEncoding(key: AnyType): EncodedKey | null {
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
		// store's own text index. The sign is on the numerator, which
		// `reduced` guarantees, so the text is one per value.
		//
		// NOTE: It was `Symbol.for` — the global Symbol registry answers the
		// same Symbol for the same text, which is exactly the interning a Map
		// key wants. What it never does is forget one: every distinct fraction
		// a Program ever looked a key up by held about 265 bytes for the life
		// of the process, whether a Dictionary still held it or not. A Map on
		// the store is interning of the same shape with the same lifetime as
		// the entries it is about.
		return { text: `${parts.numerator}/${parts.denominator}` }
	} else if (tag === "Boolean") {
		return (key as BooleanType).value
	}

	// NOTE: A Case or a Record encodes as the text `compositeText` spells,
	// where every part of it encodes, and takes the scan path where one does
	// not. The rule the whole of this rests on is stated there.
	let text = compositeText(key, tag)

	if (text !== null) {
		return { text }
	}

	// NOTE: THE SCAN PATH — Lists, Dictionaries, Algebraics, Transcendentals,
	// Functions, a Case or a Record holding one of those, and anything else.
	// Such a key is found by walking the slots and asking the Equatable
	// witness, which is correct for every key Type the language has and costs
	// O(n) for the Types that take it. It is invisible from Essence: the same
	// Methods answer the same things, only slower.
	return null
}

// NOTE: The text a Case or a Record encodes to, or `null` for a value that is
// neither or that holds a part with no encoding. It is only ever asked under a
// BRANDED witness, and the two witnesses that can carry the brand for these
// kinds are the ones this text is written to agree with: `Record::is` is the
// universal structural comparison over the members, whatever `is` a member's
// own Namespace writes (see `Record.es`), and a Choice's DERIVED equality is
// the same comparison over the payload after the tag has decided the Case. A
// Choice whose Namespace writes an `is` of its own is never branded, so its
// keys never reach here.
//
// NOTE: The text is INJECTIVE over the values that have one: every part is
// length-prefixed or terminated, so a reader could take it apart again, and two
// values spell the same text exactly when every part of them does. The members
// are written in sorted name order, because `Record::is` is order-insensitive
// and the same two members can arrive in either order. A whole Rational spells
// the Integer it equals, because the structural comparison calls those equal;
// a String spells its NFC form, because that comparison does too.
//
// NOTE: A payload-free Case is one interned instance per tag, so its text is
// remembered on it after the first encoding rather than spelled again on every
// lookup — a Dictionary keyed by such a Choice is the one most Programs hold,
// and its lookups are the ones this saves the work on. Measured over 100,000
// lookups, best of three: on a three-Case Choice the memo answers in 2.93 ms
// and spelling the text afresh takes 7.26 ms, against 2.54 ms for the scan the
// encoding replaces; on a twelve-Case one the memo answers in 2.97 ms, the
// spelling in 6.92 ms and the scan in 8.20 ms. So the encoded path is FLAT in
// how many Cases the Choice has and the scan is not: at three Cases the two
// are a wash, and by twelve the encoding is 2.8× ahead. Spelling the text
// afresh on every lookup costs nearly three times the scan at the narrow
// width, which is what the memo is for.
//
// NOTE: The memo is bounded by how many unit Case tags the Program constructs,
// exactly as the instances themselves are, and it sits under a Symbol so that
// `Object.keys` — which is what the structural comparison and this encoding
// read the members by — never sees it.
const unitCaseTextKey: unique symbol = Symbol("unitCaseText")

function compositeText(value: AnyType, tag: unknown): string | null {
	if (tag === "Record") {
		return membersText("R", Object.keys(value), value)
	}

	if (typeof tag !== "string" || !tag.includes("#")) {
		return null
	}

	let memo = value as { [unitCaseTextKey]?: string }
	let remembered = memo[unitCaseTextKey]

	if (remembered !== undefined) {
		return remembered
	}

	let head = `c${tag.length}:${tag}`
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

// NOTE: One part of a composite key, spelled so that the parts of one text can
// not run into each other. The cross-kind rule is the one `anyIs` keeps: an
// Integer and the whole Rational it equals spell the same text. Collapsing a
// bigint and a number to one text can not merge two Integers the comparison
// calls unequal, because `createInteger` gives one mathematical Integer
// exactly one representation — the same invariant the whole-Integer arm of
// `canonicalEncoding` rests on.
function partText(value: AnyType): string | null {
	// NOTE: A Function carries no Type key — see `canonicalEncoding` — and a
	// Record that holds one is compared by identity, which no text can spell.
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

// NOTE: What a call may encode a key by, which is the canonical encoding only
// where the witness the call was handed is the standard library's own equality
// for the key's kind. The Compiler brands such a witness `structural` — the
// conformance resolved to `String`, `Integer`, `Rational`, `Boolean`, the
// covering `Number` or `Record`, to a refinement of one of those that inherits
// its `is`, or to the equality the language DERIVES for a Choice — and brands
// nothing that a Namespace wrote.
//
// NOTE: This is the whole of what keeps a user-written `is` from being ignored.
// A `namespace Loose for NonEmptyString is Equatable` that calls two Strings
// equal when they differ only in case is accepted by the Compiler and handed to
// every Dictionary native as the key witness; encoding by the canonical rule
// would have put "Ada" and "ada" in two slots and answered nothing for a lookup
// the witness says holds. An unbranded witness answers `null` here, which is
// the scan path — every live slot compared through the witness itself — and
// the scan is what a Dictionary is then both written and read by. A Namespace
// that writes an `is` for a Choice replaces the derived one and is unbranded
// by the same rule, so a Case that counts as equal to a sibling is found the
// way its Namespace says rather than by its tag.
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

// NOTE: A COUNT PER KEY over the same encoding, and the second thing a List
// Method asks of this file: `mode` counts how often each item stands and
// answers the earliest of the items counted highest. It is the set above with
// a tally beside each key rather than only the key — `keys` holds one entry per
// distinct key in the order each was first met, `counts` holds that key's count
// at the same position, and the two indexes answer WHICH position rather than
// whether there is one.
//
// NOTE: No witness, because the Namespaces that count are `NonEmptyIntegerList`,
// `NonEmptyRationalList` and `NonEmptyNumberList` — three concrete Types whose
// equality is the standard library's own, which is the equality the canonical
// encoding is written to agree with. Every one of those kinds encodes, so the
// scan path a `KeySet` keeps for the kinds that do not is a case that can not
// arise: an unencodable key here is a Namespace declaring `mode` over a kind
// this file has no encoding for, which is a mistake in the declaration rather
// than a slower answer.
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

// NOTE: A SET OF KEYS over the encoding above, and the whole of the second
// container the set-shaped List natives need. It holds no versions, no
// insertion order and no values, because none of those questions is asked of
// it: `removeDuplicates` keeps the ORDER in the answer it is building, and the
// rest only ever ask whether a key has been met.
//
// NOTE: The three fields mirror a store's three. `primitives` and `texts` are
// the two indexes an encoding is routed between by one `typeof`, apart for the
// reason `TextKey` gives — a fraction, a Case and a Record spell texts that a
// String key could also spell. `unencoded` holds the keys of the kinds that
// answer no encoding, which are compared through the witness instead.
//
// NOTE: `keys` holds EVERY key, encoded or not, and it is read only by a probe
// that has no encoding of its own. Such a probe can equal an encoded key —
// `Number.is` calls the Integer `3` and an Algebraic that reduces to 3 equal,
// and only one of the two encodes — so a scan that looked at `unencoded` alone
// would answer `false` for a key the witness holds. It is the same rule
// `slotHolding` reads its two arms by.
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

// NOTE: Whether one of the candidates is the key, asked through the witness
// itself. This is THE SCAN PATH, and it costs the same O(n) a hand-rolled
// `hasItems(where …)` costs — which is what a key of a kind with no encoding
// was always going to cost, and is invisible from Essence: the same Methods
// answer the same things, only slower.
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

// NOTE: The key put in, and whether it was NEW — which is the whole of what
// `removeDuplicates` and `hasDuplicates` ask, in one lookup rather than in a
// membership test followed by an insertion.
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
